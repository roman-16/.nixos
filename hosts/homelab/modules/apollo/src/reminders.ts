import { mkdirSync, readdirSync, readFileSync, watch } from "node:fs";
import { rm } from "node:fs/promises";
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
 * reminders are all handled. A fired reminder's file is deleted; a failed delivery is
 * retried.
 */
export function createReminderWatcher(options: ReminderWatcherOptions): ReminderWatcher {
  const { dir, logger, onFire } = options;
  const timers = new Map<string, { at: number; timer: ReturnType<typeof setTimeout> }>();
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
      await rm(join(dir, `${reminder.id}.json`), { force: true });
      timers.delete(reminder.id);
      logger.info({ id: reminder.id }, "reminder fired");
    } catch (error) {
      logger.error({ err: error, id: reminder.id }, "reminder delivery failed; retrying");
      cancel(reminder.id);
      timers.set(reminder.id, {
        at: reminder.at,
        timer: setTimeout(() => void fire(reminder), RETRY_MS),
      });
    }
  }

  function reconcile(): void {
    const current = readAll();
    for (const [id, armed] of timers) {
      const reminder = current.get(id);
      if (!reminder || reminder.at !== armed.at) cancel(id);
    }
    for (const reminder of current.values()) {
      if (!timers.has(reminder.id)) arm(reminder);
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
