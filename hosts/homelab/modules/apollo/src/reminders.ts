import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  watch,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

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

/** Where a pending reminder lives. The filename is its identity. */
function reminderPath(dir: string, id: string): string {
  return join(dir, `${id}.json`);
}

/**
 * The reminder a file holds, or undefined when it does not hold one: missing, malformed, or caught
 * half-written. Every writer replaces the file atomically, so a partial read resolves itself by the
 * next time anyone looks.
 */
function readReminder(path: string): Reminder | undefined {
  try {
    return parseReminder(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return undefined;
  }
}

/**
 * Keep a reminder that has been delivered. A reminder that never fired can simply be removed, but
 * one that fired happened: when it was set, when it was due and when it actually went out are the
 * record of it, and only the last of those is recoverable from anywhere else.
 *
 * It leaves the queue and enters the archive in one `rename`, so there is no instant where it is in
 * neither place and none where it is in both - a leftover spool file would be armed again and
 * delivered twice. The moved file is then stamped with the time it went out, which is the only step
 * that can be lost, and losing it costs a timestamp on a record nobody has read yet.
 *
 * The record is the file's, never the caller's: the reminder is named by id and read where it now
 * lies, so a caller holding an older copy of it cannot write that copy over the real one.
 *
 * Returns false when the spool file has already gone, which is what a reminder removed during a
 * delivery retry looks like: nothing left to archive, and nothing left to fire.
 */
export function archiveFired(dir: string, id: string, firedAt: number): boolean {
  mkdirSync(archiveDir(dir), { recursive: true });
  const target = join(archiveDir(dir), `${id}.json`);
  try {
    renameSync(reminderPath(dir, id), target);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return false;
    throw error;
  }
  const reminder = readReminder(target);
  if (reminder) {
    const archived: ArchivedReminder = { ...reminder, firedAt };
    writeFileSync(target, JSON.stringify(archived));
  }
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
 * Event-driven reminder firing: watch the spool directory and arm one timer per pending reminder so
 * each fires exactly at its time - no polling. Reconciles on every filesystem event and at startup,
 * so added, rescheduled, removed, and overdue reminders are all handled.
 *
 * The file is the reminder; a timer is only a wake-up call. So the one thing held in memory is when
 * to wake up (an id and its time), and what to deliver is read from the file at the moment of
 * delivery. That is what makes an edit landing after a reminder was armed still go out, and it is
 * the only arrangement that stays right as a reminder gains fields: a schedule depends on `at`
 * alone, so `at` is the only thing a staleness check can ever cover.
 *
 * A delivered reminder is archived out of the queue; a failed delivery is retried through that same
 * read, so a retry is never staler than a first attempt.
 */
export function createReminderWatcher(options: ReminderWatcherOptions): ReminderWatcher {
  const { dir, logger, onFire } = options;
  const timers = new Map<string, { at: number; timer: ReturnType<typeof setTimeout> }>();
  // Reminders already delivered whose spool file could not be filed away. Their file is still in the
  // queue, so without this a reconcile would arm it again and the user would be told twice.
  const delivered = new Set<string>();
  let watcher: ReturnType<typeof watch> | undefined;
  let debounce: ReturnType<typeof setTimeout> | undefined;

  /** The pending reminder of this id. A file whose own id disagrees with its name is not one. */
  function read(id: string): Reminder | undefined {
    const reminder = readReminder(reminderPath(dir, id));
    return reminder?.id === id ? reminder : undefined;
  }

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
      const reminder = read(basename(name, ".json"));
      if (reminder) found.set(reminder.id, reminder);
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

  function arm(id: string, at: number): void {
    cancel(id);
    const timer = setTimeout(
      () => {
        if (Date.now() >= at) void fire(id);
        else arm(id, at); // a capped chunk elapsed; re-arm for the remainder
      },
      clampDelay(at, Date.now()),
    );
    timers.set(id, { at, timer });
  }

  async function fire(id: string): Promise<void> {
    const reminder = read(id);
    if (!reminder) {
      timers.delete(id);
      // Removed while it waited, which is ordinary and silent. A file that is there but cannot be
      // read is not: the user is waiting for something that will now never arrive, so it warns.
      if (existsSync(reminderPath(dir, id))) {
        logger.warn({ id }, "reminder is unreadable and was not delivered");
      }
      return;
    }
    // Rescheduled since this timer was armed, before a reconcile saw it: the file decides when.
    if (reminder.at > Date.now()) {
      arm(id, reminder.at);
      return;
    }
    try {
      await onFire(reminder);
    } catch (error) {
      logger.error({ err: error, id }, "reminder delivery failed; retrying");
      cancel(id);
      timers.set(id, { at: reminder.at, timer: setTimeout(() => void fire(id), RETRY_MS) });
      return;
    }
    // It has been said. Bookkeeping from here on can fail, but it must never cost a second delivery,
    // which is why archiving is not inside the retry above.
    timers.delete(id);
    try {
      archiveFired(dir, id, Date.now());
      logger.info({ id }, "reminder fired");
    } catch (error) {
      delivered.add(id);
      logger.warn({ err: error, id }, "reminder fired but could not be archived");
    }
  }

  function reconcile(): void {
    const current = readAll();
    // The fire time is the whole of what an armed timer encodes, so it is the whole of what can make
    // one wrong. An entry whose time still matches may be a retry mid-backoff, and cancelling that
    // would re-fire it at once.
    for (const [id, armed] of timers) {
      const reminder = current.get(id);
      if (!reminder || reminder.at !== armed.at) cancel(id);
    }
    for (const reminder of current.values()) {
      if (!timers.has(reminder.id) && !delivered.has(reminder.id)) arm(reminder.id, reminder.at);
    }
  }

  /**
   * Watch the spool, and keep watching it. Files here are created, renamed away by archiving and
   * deleted by the CLI all the time, and any of that can make the watch itself fail: unhandled, that
   * is an error event nobody is listening for, and a watch that has stopped is the module's worst
   * failure - reconciles stop, so nothing is ever armed again, and no reminder fires ever after.
   */
  function observe(): void {
    mkdirSync(dir, { recursive: true });
    const active = watch(dir, () => {
      clearTimeout(debounce);
      debounce = setTimeout(reconcile, DEBOUNCE_MS);
    });
    active.on("error", (error) => {
      if (watcher !== active) return; // already replaced, or stopped
      active.close();
      watcher = undefined;
      logger.warn({ err: error }, "reminder watch failed; re-establishing it");
      try {
        observe();
      } catch (failure) {
        logger.error({ err: failure }, "reminder watch is gone; reminders will not fire");
        return;
      }
      reconcile();
    });
    watcher = active;
  }

  return {
    start() {
      observe();
      reconcile();
    },
    stop() {
      clearTimeout(debounce);
      watcher?.close();
      watcher = undefined;
      for (const { timer } of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}
