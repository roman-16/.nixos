import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";
import type { Logger } from "pino";

import {
  archiveDir,
  archiveFired,
  clampDelay,
  createReminderWatcher,
  formatReminder,
  type Reminder,
  type ReminderWatcher,
  parseReminder,
} from "../src/reminders";

describe("parseReminder", () => {
  it("accepts a well-formed reminder", () => {
    expect(parseReminder({ at: 100, createdAt: 50, id: "a1", text: "hi" })).toEqual({
      at: 100,
      createdAt: 50,
      id: "a1",
      text: "hi",
    });
  });

  it("defaults createdAt to at when missing", () => {
    expect(parseReminder({ at: 100, id: "a1", text: "hi" })?.createdAt).toBe(100);
  });

  it("rejects malformed records", () => {
    expect(parseReminder(null)).toBeUndefined();
    expect(parseReminder({ at: 1, id: "a", text: "" })).toBeUndefined();
    expect(parseReminder({ at: 1, id: "", text: "x" })).toBeUndefined();
    expect(parseReminder({ at: "soon", id: "a", text: "x" })).toBeUndefined();
    expect(parseReminder({ id: "a", text: "x" })).toBeUndefined();
  });
});

describe("formatReminder", () => {
  it("prefixes the alarm marker", () => {
    expect(formatReminder("get food")).toBe("⏰ get food");
  });
});

function spool(): string {
  return mkdtempSync(join(tmpdir(), "apollo-reminders-"));
}

function pending(dir: string, over: Partial<Reminder> = {}): Reminder {
  const reminder: Reminder = {
    at: 1000,
    createdAt: 500,
    id: "a1b2c3",
    text: "get my food",
    ...over,
  };
  writeFileSync(join(dir, `${reminder.id}.json`), JSON.stringify(reminder));
  return reminder;
}

describe("archiveDir", () => {
  it("sits outside the queue, so what is watched is only live work", () => {
    expect(archiveDir("/w/reminders")).toBe("/w/reminders/archive");
  });
});

describe("archiveFired", () => {
  it("takes the reminder out of the queue and keeps it, with the time it went out", () => {
    const dir = spool();
    const reminder = pending(dir);
    expect(archiveFired(dir, reminder.id, 1234)).toBe(true);
    expect(existsSync(join(dir, "a1b2c3.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(archiveDir(dir), "a1b2c3.json"), "utf8"))).toEqual({
      at: 1000,
      createdAt: 500,
      firedAt: 1234,
      id: "a1b2c3",
      text: "get my food",
    });
  });

  it("records what the file says, not what anyone remembers it saying", () => {
    const dir = spool();
    pending(dir, { text: "Make a changelog skill" });
    pending(dir, { text: "Make a changelog skill. Also: update the AUR package." });
    archiveFired(dir, "a1b2c3", 1234);
    const archived = JSON.parse(readFileSync(join(archiveDir(dir), "a1b2c3.json"), "utf8"));
    expect(archived.text).toContain("AUR");
  });

  it("leaves nothing behind that could be armed and delivered a second time", () => {
    const dir = spool();
    const reminder = pending(dir);
    archiveFired(dir, reminder.id, 1234);
    // The queue is what the watcher reads, so a reminder that has fired must not be in it.
    expect(existsSync(join(dir, `${reminder.id}.json`))).toBe(false);
  });

  it("creates the archive on the first reminder that ends", () => {
    const dir = spool();
    expect(existsSync(archiveDir(dir))).toBe(false);
    archiveFired(dir, pending(dir).id, 1);
    expect(existsSync(archiveDir(dir))).toBe(true);
  });

  it("says so when the reminder has already left the queue, rather than throwing", () => {
    // What a reminder removed during a delivery retry looks like: nothing to archive, nothing to fire.
    const dir = spool();
    expect(archiveFired(dir, "gone", 2)).toBe(false);
  });

  it("still files away a reminder it cannot read, leaving it unstamped", () => {
    // A delivered reminder is kept whatever state its file is in; the Python side reads an unstamped
    // record as having gone out when it was due.
    const dir = spool();
    writeFileSync(join(dir, "a1b2c3.json"), "{half-writ");
    expect(archiveFired(dir, "a1b2c3", 1234)).toBe(true);
    expect(existsSync(join(dir, "a1b2c3.json"))).toBe(false);
    expect(readFileSync(join(archiveDir(dir), "a1b2c3.json"), "utf8")).toBe("{half-writ");
  });

  it("keeps each fired reminder under its own id", () => {
    const dir = spool();
    archiveFired(dir, pending(dir, { id: "aaa111", text: "first" }).id, 10);
    archiveFired(dir, pending(dir, { id: "bbb222", text: "second" }).id, 20);
    expect(existsSync(join(archiveDir(dir), "aaa111.json"))).toBe(true);
    expect(existsSync(join(archiveDir(dir), "bbb222.json"))).toBe(true);
  });
});

describe("clampDelay", () => {
  it("is the remaining time when within range", () => {
    expect(clampDelay(1000, 400)).toBe(600);
  });

  it("is zero for past times", () => {
    expect(clampDelay(400, 1000)).toBe(0);
  });

  it("caps far-future delays at the setTimeout max", () => {
    expect(clampDelay(Number.MAX_SAFE_INTEGER, 0)).toBe(2 ** 31 - 1);
  });
});

const logger = { debug() {}, error() {}, info() {}, warn() {} } as unknown as Logger;

const live: ReminderWatcher[] = [];

afterEach(() => {
  for (const watcher of live.splice(0)) watcher.stop();
});

function startWatcher(dir: string, onFire: (reminder: Reminder) => Promise<void>): void {
  const watcher = createReminderWatcher({ dir, logger, onFire });
  live.push(watcher);
  watcher.start();
}

/** What was delivered, and optionally a delivery that fails the way an offline WhatsApp does. */
function collector(over: { fail?: boolean } = {}) {
  const delivered: Reminder[] = [];
  return {
    delivered,
    onFire: async (reminder: Reminder) => {
      delivered.push(reminder);
      if (over.fail) throw new Error("whatsapp not connected");
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(what: string, ready: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

describe("createReminderWatcher", () => {
  it("delivers what the file says, not what it said when the timer was armed", async () => {
    // The text is edited with the time left alone, so nothing about the schedule changes and the
    // armed timer is left in place: only reading the file at delivery gets this right.
    const dir = spool();
    const at = Date.now() + 120;
    pending(dir, { at, text: "Make a changelog skill" });
    const calls = collector();
    startWatcher(dir, calls.onFire);
    pending(dir, { at, text: "Make a changelog skill. Also: update the AUR package." });
    await until("the reminder to fire", () => calls.delivered.length === 1);
    expect(calls.delivered[0]!.text).toContain("AUR");
  });

  it("archives the text it delivered, with the time it went out", async () => {
    const dir = spool();
    const at = Date.now() + 120;
    pending(dir, { at, text: "Make a changelog skill" });
    const calls = collector();
    startWatcher(dir, calls.onFire);
    pending(dir, { at, text: "Make a changelog skill. Also: update the AUR package." });
    await until("the reminder to be archived", () =>
      existsSync(join(archiveDir(dir), "a1b2c3.json")),
    );
    const archived = JSON.parse(readFileSync(join(archiveDir(dir), "a1b2c3.json"), "utf8"));
    expect(archived.text).toContain("AUR");
    expect(archived.firedAt).toBeGreaterThanOrEqual(at);
    expect(existsSync(join(dir, "a1b2c3.json"))).toBe(false);
  });

  it("fires a reminder that came due while nothing was watching", async () => {
    const dir = spool();
    pending(dir, { at: Date.now() - 60_000, text: "get my food" });
    const calls = collector();
    startWatcher(dir, calls.onFire);
    await until("the overdue reminder to fire", () => calls.delivered.length === 1);
    expect(calls.delivered[0]!.text).toBe("get my food");
  });

  it("follows a reschedule rather than the time it was armed for", async () => {
    const dir = spool();
    const at = Date.now() + 80;
    pending(dir, { at });
    const calls = collector();
    startWatcher(dir, calls.onFire);
    pending(dir, { at: at + 400 });
    await sleep(250);
    expect(calls.delivered).toEqual([]);
    await until("the rescheduled reminder to fire", () => calls.delivered.length === 1);
  });

  it("never delivers a reminder removed before its time", async () => {
    const dir = spool();
    pending(dir, { at: Date.now() + 120 });
    const calls = collector();
    startWatcher(dir, calls.onFire);
    rmSync(join(dir, "a1b2c3.json"));
    await sleep(300);
    expect(calls.delivered).toEqual([]);
  });

  it("keeps a reminder that could not be delivered in the queue", async () => {
    const dir = spool();
    pending(dir, { at: Date.now() - 1000 });
    const calls = collector({ fail: true });
    startWatcher(dir, calls.onFire);
    await until("the failing delivery to be attempted", () => calls.delivered.length === 1);
    await sleep(50);
    expect(existsSync(join(dir, "a1b2c3.json"))).toBe(true);
    expect(existsSync(archiveDir(dir))).toBe(false);
  });

  it("ignores a file whose name and id disagree", async () => {
    const dir = spool();
    writeFileSync(
      join(dir, "aaa111.json"),
      JSON.stringify({ at: Date.now() - 1000, createdAt: 0, id: "bbb222", text: "x" }),
    );
    const calls = collector();
    startWatcher(dir, calls.onFire);
    await sleep(200);
    expect(calls.delivered).toEqual([]);
  });
});
