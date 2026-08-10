import { describe, expect, it } from "bun:test";

import { openDatabase } from "../src/db";
import { createInbox, type InboxEntry } from "../src/inbox";

const HORIZON_MS = 30 * 24 * 60 * 60 * 1000;

function freshInbox(horizonMs = HORIZON_MS) {
  const db = openDatabase(":memory:");
  return { db, inbox: createInbox(db, horizonMs) };
}

function entry(over: Partial<InboxEntry> = {}): InboxEntry {
  return {
    contexts: [],
    images: [],
    sentAt: Date.now(),
    text: "hello",
    waId: "A1",
    ...over,
  };
}

describe("createInbox", () => {
  it("admits a message and holds it as pending", () => {
    const { inbox } = freshInbox();
    // One message, built once: entry() stamps Date.now(), so building it twice compares two
    // different milliseconds whenever the clock ticks between the calls.
    const message = entry();
    expect(inbox.admit(message)).toBe("admitted");
    expect(inbox.pending(10)).toEqual([message]);
  });

  it("round-trips images and per-message context notes", () => {
    const { inbox } = freshInbox();
    const rich = entry({
      contexts: [{ body: "quoted text", info: "replying to you", source: "reply" }],
      images: [{ data: "AAAA", mimeType: "image/png", type: "image" }],
    });
    inbox.admit(rich);
    expect(inbox.pending(10)[0]).toEqual(rich);
  });

  it("ignores a message it has already seen, whatever offered it", () => {
    const { inbox } = freshInbox();
    expect(inbox.admit(entry())).toBe("admitted");
    expect(inbox.admit(entry())).toBe("duplicate");
    expect(inbox.pending(10)).toHaveLength(1);
  });

  it("rejects a message from beyond the horizon, where it can't prove it hasn't seen it", () => {
    const { inbox } = freshInbox();
    expect(inbox.admit(entry({ sentAt: Date.now() - HORIZON_MS - 1000, waId: "ancient" }))).toBe(
      "expired",
    );
    expect(inbox.pending(10)).toEqual([]);
  });

  it("tells a message it has answered apart from one it never will", () => {
    // Both are refusals and neither is pending, but one was dealt with and the other is lost.
    const { inbox } = freshInbox();
    inbox.admit(entry({ waId: "seen" }));
    expect(inbox.admit(entry({ waId: "seen" }))).toBe("duplicate");
    expect(inbox.admit(entry({ sentAt: 0, waId: "ancient" }))).toBe("expired");
  });

  it("admits a days-late message that arrives after newer ones", () => {
    const { inbox } = freshInbox();
    inbox.admit(entry({ sentAt: Date.now(), waId: "live" }));
    // The offline queue can hand over a message from days ago long after newer ones were answered.
    expect(inbox.admit(entry({ sentAt: Date.now() - 3 * 86_400_000, waId: "queued" }))).toBe(
      "admitted",
    );
  });

  it("serves pending messages oldest first, however they arrived", () => {
    const { inbox } = freshInbox();
    const now = Date.now();
    inbox.admit(entry({ sentAt: now - 1000, waId: "c" }));
    inbox.admit(entry({ sentAt: now - 3000, waId: "a" }));
    inbox.admit(entry({ sentAt: now - 2000, waId: "b" }));
    expect(inbox.pending(10).map((row) => row.waId)).toEqual(["a", "b", "c"]);
  });

  it("caps a batch at the requested size, leaving the rest owed", () => {
    const { inbox } = freshInbox();
    const now = Date.now();
    for (const n of [1, 2, 3])
      inbox.admit(entry({ sentAt: now - 10_000 + n * 1000, waId: `m${n}` }));
    expect(inbox.pending(2).map((row) => row.waId)).toEqual(["m1", "m2"]);
    inbox.markHandled(["m1", "m2"]);
    expect(inbox.pending(2).map((row) => row.waId)).toEqual(["m3"]);
  });

  it("keeps a message pending until it is marked handled - a crash re-delivers it", () => {
    const { db, inbox } = freshInbox();
    inbox.admit(entry());
    expect(createInbox(db, HORIZON_MS).pending(10)).toHaveLength(1);
    inbox.markHandled(["A1"]);
    expect(createInbox(db, HORIZON_MS).pending(10)).toEqual([]);
  });

  it("never re-admits a handled message", () => {
    const { inbox } = freshInbox();
    inbox.admit(entry());
    inbox.markHandled(["A1"]);
    expect(inbox.admit(entry())).toBe("duplicate");
  });

  it("drops the stored payload once handled", () => {
    const { db, inbox } = freshInbox();
    inbox.admit(entry({ images: [{ data: "AAAA", mimeType: "image/png", type: "image" }] }));
    inbox.markHandled(["A1"]);
    const row = db.query("SELECT payload FROM inbound WHERE wa_id = 'A1'").get() as {
      payload: string;
    };
    expect(row.payload).toBe("");
  });

  it("prunes handled messages past the retention window, but never pending ones", () => {
    const { db, inbox } = freshInbox();
    const now = Date.now();
    inbox.admit(entry({ sentAt: now - 5000, waId: "old" }));
    inbox.admit(entry({ sentAt: now - 1000, waId: "owed" }));
    inbox.markHandled(["old"]);
    inbox.prune(now - 2000);
    const rows = db.query("SELECT wa_id FROM inbound").all() as { wa_id: string }[];
    expect(rows.map((row) => row.wa_id)).toEqual(["owed"]);
    expect(inbox.pending(10).map((row) => row.waId)).toEqual(["owed"]);
  });

  it("delivers whatever is pending regardless of age, so a message can be placed out of band", () => {
    const { db, inbox } = freshInbox();
    // A one-off recovery writes straight to the table: days old, never offered by WhatsApp, still owed.
    const sentAt = Date.now() - 3 * 86_400_000;
    db.query("INSERT INTO inbound (wa_id, sent_at, received_at, payload) VALUES (?, ?, ?, ?)").run(
      "recovered",
      sentAt,
      Date.now(),
      JSON.stringify({ contexts: [], images: [], text: "eggs" }),
    );
    expect(inbox.pending(10)).toEqual([
      { contexts: [], images: [], sentAt, text: "eggs", waId: "recovered" },
    ]);
  });
});
