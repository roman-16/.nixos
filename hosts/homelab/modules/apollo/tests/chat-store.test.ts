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
    expect(ids(store.tail("s1", 10).entries)).toEqual(["a", "b"]);
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

  it("keeps only the last N at the live end", () => {
    const store = createChatStore(openDatabase(":memory:"));
    store.sync(
      "s1",
      ["a", "b", "c", "d"].map((id) => entry({ id })),
    );
    expect(ids(store.tail("s1", 2).entries)).toEqual(["c", "d"]);
  });

  it("scopes entries by session", () => {
    const store = createChatStore(openDatabase(":memory:"));
    store.sync("s1", [entry({ id: "a" })]);
    store.sync("s2", [entry({ id: "b" })]);
    expect(ids(store.tail("s1", 10).entries)).toEqual(["a"]);
    expect(ids(store.tail("s2", 10).entries)).toEqual(["b"]);
  });

  it("bumps the change tag when a new entry lands", () => {
    const store = createChatStore(openDatabase(":memory:"));
    store.sync("s1", [entry({ id: "a" })]);
    const before = store.tail("s1", 10).newest;
    store.sync("s1", [entry({ id: "a" }), entry({ id: "b" })]);
    expect(store.tail("s1", 10).newest).toBeGreaterThan(before);
  });

  describe("older", () => {
    const four = (store: ReturnType<typeof createChatStore>) =>
      store.sync(
        "s1",
        ["a", "b", "c", "d"].map((id) => entry({ id })),
      );

    it("returns the entries just before the cursor, oldest-first", () => {
      const store = createChatStore(openDatabase(":memory:"));
      four(store);
      expect(ids(store.older("s1", "d", 2).entries)).toEqual(["b", "c"]);
    });

    it("never includes the cursor itself, so a page cannot repeat a row", () => {
      const store = createChatStore(openDatabase(":memory:"));
      four(store);
      expect(ids(store.older("s1", "c", 10).entries)).toEqual(["a", "b"]);
    });

    it("is empty at the beginning of the conversation", () => {
      const store = createChatStore(openDatabase(":memory:"));
      four(store);
      expect(store.older("s1", "a", 10).entries).toEqual([]);
    });

    it("answers an unknown cursor the same way, rather than throwing", () => {
      const store = createChatStore(openDatabase(":memory:"));
      four(store);
      expect(store.older("s1", "nope", 10).entries).toEqual([]);
    });

    it("reports when the cursor entry was recorded, for the day it butts against", () => {
      const store = createChatStore(openDatabase(":memory:"));
      four(store);
      expect(store.older("s1", "d", 2).boundaryTime).toBe(Date.parse("2026-07-19T10:00:00.000Z"));
    });

    it("asks twice for the same page and gets the same page", () => {
      const store = createChatStore(openDatabase(":memory:"));
      four(store);
      expect(ids(store.older("s1", "d", 2).entries)).toEqual(
        ids(store.older("s1", "d", 2).entries),
      );
    });

    it("scopes pages by session", () => {
      const store = createChatStore(openDatabase(":memory:"));
      four(store);
      store.sync("s2", [entry({ id: "x" }), entry({ id: "y" })]);
      expect(ids(store.older("s2", "y", 10).entries)).toEqual(["x"]);
    });
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

  it("records the image a skill message delivered, and serves it back", () => {
    const store = createChatStore(openDatabase(":memory:"));
    store.appendSkillMessage("s1", "diagram", "how it flows", [
      { data: b64("png-bytes"), mimeType: "image/png", type: "image" },
    ]);
    const stored = JSON.parse(store.tail("s1", 10).entries[0]!);
    expect(stored.data.images).toHaveLength(1);
    expect(store.image("s1", stored.id, 0)).toEqual({
      bytes: Buffer.from("png-bytes"),
      mimeType: "image/png",
    });
  });

  it("leaves the images key off a skill message that delivered none", () => {
    const store = createChatStore(openDatabase(":memory:"));
    store.appendSkillMessage("s1", "macros", "summary");
    expect(JSON.parse(store.tail("s1", 10).entries[0]!).data).toEqual({
      source: "macros",
      text: "summary",
    });
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
    expect(store.tail("nope", 10)).toEqual({ entries: [], newest: 0 });
  });
});
