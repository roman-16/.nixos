import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import {
  archiveDir,
  archiveFired,
  clampDelay,
  formatReminder,
  type Reminder,
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
    expect(archiveFired(dir, reminder, 1234)).toBe(true);
    expect(existsSync(join(dir, "a1b2c3.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(archiveDir(dir), "a1b2c3.json"), "utf8"))).toEqual({
      at: 1000,
      createdAt: 500,
      firedAt: 1234,
      id: "a1b2c3",
      text: "get my food",
    });
  });

  it("leaves nothing behind that could be armed and delivered a second time", () => {
    const dir = spool();
    const reminder = pending(dir);
    archiveFired(dir, reminder, 1234);
    // The queue is what the watcher reads, so a reminder that has fired must not be in it.
    expect(existsSync(join(dir, `${reminder.id}.json`))).toBe(false);
  });

  it("creates the archive on the first reminder that ends", () => {
    const dir = spool();
    expect(existsSync(archiveDir(dir))).toBe(false);
    archiveFired(dir, pending(dir), 1);
    expect(existsSync(archiveDir(dir))).toBe(true);
  });

  it("says so when the reminder has already left the queue, rather than throwing", () => {
    // What a reminder removed during a delivery retry looks like: nothing to archive, nothing to fire.
    const dir = spool();
    expect(archiveFired(dir, { at: 1, createdAt: 1, id: "gone", text: "x" }, 2)).toBe(false);
  });

  it("keeps each fired reminder under its own id", () => {
    const dir = spool();
    archiveFired(dir, pending(dir, { id: "aaa111", text: "first" }), 10);
    archiveFired(dir, pending(dir, { id: "bbb222", text: "second" }), 20);
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
