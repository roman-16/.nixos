import { mkdirSync, readdirSync, readFileSync, renameSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Logger } from "pino";

/** setTimeout caps at ~24.8 days; longer waits are armed in chunks. */
const MAX_TIMEOUT = 2 ** 31 - 1;
const RETRY_MS = 30_000;
const DEBOUNCE_MS = 100;

export interface Reminder {
  at: number;
  createdAt: number;
  id: string;
  text: string;
}

export interface ArchivedReminder extends Reminder {
  firedAt: number;
}

/** Validate a parsed reminder file, returning undefined when malformed. */
export function parseReminder(value: unknown): Reminder | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { at, createdAt, id, text } = value as Record<string, unknown>;
  if (typeof id !== "string" || !id) return undefined;
  if (typeof text !== "string" || !text) return undefined;
  if (typeof at !== "number" || !Number.isFinite(at)) return undefined;
  return { at, createdAt: typeof createdAt === "number" ? createdAt : at, id, text };
}

/** The WhatsApp text a fired reminder is delivered as. */
export function formatReminder(text: string): string {
  return `⏰ ${text}`;
}

/** Delay until `at`, clamped to [0, MAX_TIMEOUT] so far-future reminders re-arm in chunks. */
export function clampDelay(at: number, now: number): number {
  return Math.min(Math.max(at - now, 0), MAX_TIMEOUT);
}

/** Where a reminder goes once it has fired. Outside the spool, so the queue holds only live work. */
export function archiveDir(dir: string): string {
  return join(dir, "archive");
}

/**
 * Keep a reminder that has been delivered. A reminder that never fired can simply be removed, but
 * one that fired happened: when it was set, when it was due and when it actually went out are the
 * record of it, and only the last of those is recoverable from anywhere else.
 *
 * It leaves the queue and enters the archive in one `rename`, so there is no instant where it is in
 * neither place and none where it is in both - a leftover spool file would be armed again and
 * delivered twice. The record is then completed in place, which is the only step that can be lost,
 * and losing it costs a timestamp on a record nobody has read yet.
 *
 * Returns false when the spool file has already gone, which is what a reminder removed during a
 * delivery retry looks like: nothing left to archive, and nothing left to fire.
 */
export function archiveFired(dir: string, reminder: Reminder, firedAt: number): boolean {
  mkdirSync(archiveDir(dir), { recursive: true });
  const target = join(archiveDir(dir), `${reminder.id}.json`);
  try {
    renameSync(join(dir, `${reminder.id}.json`), target);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return false;
    throw error;
  }
  const archived: ArchivedReminder = { ...reminder, firedAt };
  writeFileSync(target, JSON.stringify(archived));
  return true;
}

export interface ReminderWatcherOptions {
  dir: string;
  logger: Logger;
  onFire: (reminder: Reminder) => Promise<void>;
}

export interface ReminderWatcher {
  start(): void;
  stop(): void;
}

/**
 * Event-driven reminder firing: watch the spool directory and arm one timer per
 * pending reminder so each fires exactly at its time - no polling. Reconciles on
 * every filesystem event and at startup, so added, rescheduled, removed, and overdue
 * reminders are all handled. A delivered reminder is archived out of the queue; a failed
 * delivery is retried.
 */
export function createReminderWatcher(options: ReminderWatcherOptions): ReminderWatcher {
  const { dir, logger, onFire } = options;
  const timers = new Map<string, { at: number; timer: ReturnType<typeof setTimeout> }>();
  // Reminders already delivered whose spool file could not be filed away. Their file is still in the
  // queue, so without this a reconcile would arm it again and the user would be told twice.
  const delivered = new Set<string>();
  let watcher: ReturnType<typeof watch> | undefined;
  let debounce: ReturnType<typeof setTimeout> | undefined;

  function readAll(): Map<string, Reminder> {
    const found = new Map<string, Reminder>();
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return found;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const reminder = parseReminder(JSON.parse(readFileSync(join(dir, name), "utf8")));
        if (reminder) found.set(reminder.id, reminder);
      } catch {
        // Partial or malformed file; a concurrent atomic write resolves it on the next event.
      }
    }
    return found;
  }

  function cancel(id: string): void {
    const armed = timers.get(id);
    if (armed) {
      clearTimeout(armed.timer);
      timers.delete(id);
    }
  }

  function arm(reminder: Reminder): void {
    cancel(reminder.id);
    const timer = setTimeout(
      () => {
        if (Date.now() >= reminder.at) void fire(reminder);
        else arm(reminder); // a capped chunk elapsed; re-arm for the remainder
      },
      clampDelay(reminder.at, Date.now()),
    );
    timers.set(reminder.id, { at: reminder.at, timer });
  }

  async function fire(reminder: Reminder): Promise<void> {
    try {
      await onFire(reminder);
    } catch (error) {
      logger.error({ err: error, id: reminder.id }, "reminder delivery failed; retrying");
      cancel(reminder.id);
      timers.set(reminder.id, {
        at: reminder.at,
        timer: setTimeout(() => void fire(reminder), RETRY_MS),
      });
      return;
    }
    // It has been said. Bookkeeping from here on can fail, but it must never cost a second delivery,
    // which is why archiving is not inside the retry above.
    timers.delete(reminder.id);
    try {
      archiveFired(dir, reminder, Date.now());
      logger.info({ id: reminder.id }, "reminder fired");
    } catch (error) {
      delivered.add(reminder.id);
      logger.warn({ err: error, id: reminder.id }, "reminder fired but could not be archived");
    }
  }

  function reconcile(): void {
    const current = readAll();
    for (const [id, armed] of timers) {
      const reminder = current.get(id);
      if (!reminder || reminder.at !== armed.at) cancel(id);
    }
    for (const reminder of current.values()) {
      if (!timers.has(reminder.id) && !delivered.has(reminder.id)) arm(reminder);
    }
  }

  return {
    start() {
      mkdirSync(dir, { recursive: true });
      reconcile();
      watcher = watch(dir, () => {
        clearTimeout(debounce);
        debounce = setTimeout(reconcile, DEBOUNCE_MS);
      });
    },
    stop() {
      clearTimeout(debounce);
      watcher?.close();
      for (const { timer } of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}
