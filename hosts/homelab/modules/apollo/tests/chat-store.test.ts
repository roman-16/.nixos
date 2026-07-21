import { describe, expect, it } from "bun:test";

import { createChatStore } from "../src/chat-store";
import { openDatabase } from "../src/db";

/** A minimal SessionEntry-shaped object; only id/type/timestamp/message are read by the store. */
function entry(over: Record<string, unknown> = {}): any {
  return {
    id: "e1",
    message: { content: "hi", role: "user" },
    parentId: null,
    timestamp: "2026-07-19T10:00:00.000Z",
    type: "message",
    ...over,
  };
}

function ids(entries: string[]): string[] {
  return entries.map((line) => JSON.parse(line).id as string);
}

function b64(text: string): string {
  return Buffer.from(text).toString("base64");
}

describe("createChatStore", () => {
  it("mirrors entries and returns them oldest-first", () => {
    const store = createChatStore(openDatabase(":memory:"));
    store.sync("s1", [entry({ id: "a" }), entry({ id: "b" })]);
    const tail = store.tail("s1", 10);
    expect(ids(tail.entries)).toEqual(["a", "b"]);
    expect(tail.more).toBe(false);
  });

  it("stores each entry verbatim", () => {
    const store = createChatStore(openDatabase(":memory:"));
    const e = entry({ id: "a" });
    store.sync("s1", [e]);
    expect(store.tail("s1", 10).entries[0]).toBe(JSON.stringify(e));
  });

  it("appends only the growing tail and is idempotent", () => {
    const store = createChatStore(openDatabase(":memory:"));
    store.sync("s1", [entry({ id: "a" })]);
    store.sync("s1", [entry({ id: "a" }), entry({ id: "b" })]);
    expect(ids(store.tail("s1", 10).entries)).toEqual(["a", "b"]);
  });

  it("dedups by entry id even from a fresh store (restart re-walks all)", () => {
    const db = openDatabase(":memory:");
    createChatStore(db).sync("s1", [entry({ id: "a" }), entry({ id: "b" })]);
    // A new store has no cursor, so it re-walks every entry; INSERT OR IGNORE prevents dupes.
    createChatStore(db).sync("s1", [entry({ id: "a" }), entry({ id: "b" }), entry({ id: "c" })]);
    expect(ids(createChatStore(db).tail("s1", 10).entries)).toEqual(["a", "b", "c"]);
  });

  it("windows to the last N and flags older history", () => {
    const store = createChatStore(openDatabase(":memory:"));
    store.sync(
      "s1",
      ["a", "b", "c", "d"].map((id) => entry({ id })),
    );
    const tail = store.tail("s1", 2);
    expect(ids(tail.entries)).toEqual(["c", "d"]);
    expect(tail.more).toBe(true);
    expect(store.tail("s1", 10).more).toBe(false);
  });

  it("scopes entries by session", () => {
    const store = createChatStore(openDatabase(":memory:"));
    store.sync("s1", [entry({ id: "a" })]);
    store.sync("s2", [entry({ id: "b" })]);
    expect(ids(store.tail("s1", 10).entries)).toEqual(["a"]);
    expect(ids(store.tail("s2", 10).entries)).toEqual(["b"]);
  });

  it("bumps the version tag when a new entry lands", () => {
    const store = createChatStore(openDatabase(":memory:"));
    store.sync("s1", [entry({ id: "a" })]);
    const before = store.tail("s1", 10).version;
    store.sync("s1", [entry({ id: "a" }), entry({ id: "b" })]);
    expect(store.tail("s1", 10).version).not.toBe(before);
  });

  it("serves an image by entry id and index", () => {
    const store = createChatStore(openDatabase(":memory:"));
    store.sync("s1", [
      entry({
        id: "a",
        message: {
          content: [{ data: b64("hello"), mimeType: "image/png", type: "image" }],
          role: "user",
        },
      }),
    ]);
    expect(store.image("s1", "a", 0)?.bytes.toString()).toBe("hello");
    expect(store.image("s1", "a", 0)?.mimeType).toBe("image/png");
    expect(store.image("s1", "a", 5)).toBeUndefined();
    expect(store.image("s1", "missing", 0)).toBeUndefined();
  });

  it("records an out-of-band skill message as a rendered chat entry", () => {
    const store = createChatStore(openDatabase(":memory:"));
    store.appendSkillMessage("s1", "reminders", "⏰ get my food");
    const tail = store.tail("s1", 10);
    expect(tail.entries).toHaveLength(1);
    const stored = JSON.parse(tail.entries[0]!);
    expect(stored.type).toBe("custom");
    expect(stored.customType).toBe("skill_message");
    expect(stored.data).toEqual({ source: "reminders", text: "⏰ get my food" });
  });

  it("interleaves skill messages with mirrored entries in insertion order", () => {
    const store = createChatStore(openDatabase(":memory:"));
    store.sync("s1", [entry({ id: "a" })]);
    store.appendSkillMessage("s1", "macros", "summary");
    store.sync("s1", [entry({ id: "a" }), entry({ id: "b" })]);
    const order = store.tail("s1", 10).entries.map((line) => {
      const e = JSON.parse(line);
      return e.customType ?? e.id;
    });
    expect(order).toEqual(["a", "skill_message", "b"]);
  });

  it("returns an empty tail for an unknown session", () => {
    const store = createChatStore(openDatabase(":memory:"));
    expect(store.tail("nope", 10)).toEqual({ entries: [], more: false, version: "10:0" });
  });
});
