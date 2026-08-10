import type { ImageContent } from "@earendil-works/pi-ai";
import type { Database } from "bun:sqlite";

import type { ContextNote } from "./temporal";

/**
 * The durable seam between WhatsApp and the agent. Every inbound message is normalized (voice
 * transcribed, media downloaded, reply resolved) and written here *before* the agent sees it, so a
 * crash or a restart re-delivers it instead of dropping it, and a burst can be handed over as one
 * catch-up turn instead of racing through the session.
 *
 * Identity is WhatsApp's own message id, so admission is idempotent: the same message may be offered
 * by the live socket, by the server's offline queue after an outage, or by a history sync, and is
 * still processed exactly once. Age is the only other question asked, and only because memory is
 * finite: a message older than the horizon can no longer be proven unseen, so it is treated as
 * history rather than answered years late. Everything inside the horizon is settled by identity, so
 * a late or out-of-order delivery is a message like any other.
 *
 * Admission and delivery are deliberately separate gates. Admission judges what WhatsApp offers;
 * delivery just owes whatever is pending, whatever its age. That is what lets a message be placed
 * here by other means (a one-off recovery) and still reach the agent with its original timestamp.
 */

export interface InboxEntry {
  /** Notes belonging to this message alone, e.g. the reply it quotes. */
  contexts: ContextNote[];
  images: ImageContent[];
  sentAt: number;
  text: string;
  waId: string;
}

/**
 * What became of a message offered to the inbox. The two refusals mean opposite things - a duplicate
 * was already answered, an expired one never will be - so they are never reported as one.
 */
export type Admission = "admitted" | "duplicate" | "expired";

export interface Inbox {
  /** Take a message in, unless it was already seen or is older than the memory horizon. */
  admit(entry: InboxEntry): Admission;
  /** Mark messages as delivered to the agent, dropping their stored payload. */
  markHandled(waIds: string[]): void;
  /** The oldest undelivered messages, in send order. */
  pending(limit: number): InboxEntry[];
  /** Forget handled messages older than `before`; pending ones are owed until delivered. */
  prune(before: number): void;
}

interface PendingRow {
  payload: string;
  sent_at: number;
  wa_id: string;
}

/**
 * `horizonMs` is how far back the inbox remembers message ids, and therefore how old a message may
 * be and still be taken seriously. Keep it equal to the pruning window, so admission never trusts
 * what the table can no longer remember.
 */
export function createInbox(db: Database, horizonMs: number): Inbox {
  const insert = db.query(
    "INSERT OR IGNORE INTO inbound (wa_id, sent_at, received_at, payload) VALUES (?, ?, ?, ?)",
  );
  const selectPending = db.query(
    "SELECT wa_id, sent_at, payload FROM inbound WHERE handled_at IS NULL ORDER BY sent_at, id LIMIT ?",
  );
  const handle = db.query("UPDATE inbound SET handled_at = ?, payload = '' WHERE wa_id = ?");
  const deleteOld = db.query("DELETE FROM inbound WHERE handled_at IS NOT NULL AND sent_at < ?");

  return {
    admit(entry) {
      if (entry.sentAt < Date.now() - horizonMs) return "expired";
      const payload = JSON.stringify({
        contexts: entry.contexts,
        images: entry.images,
        text: entry.text,
      });
      // The unique message id is the whole of the dedup: a redelivery, a reconnect, or a sync
      // offering the same message again changes nothing.
      const { changes } = insert.run(entry.waId, entry.sentAt, Date.now(), payload);
      return changes > 0 ? "admitted" : "duplicate";
    },
    markHandled(waIds) {
      const at = Date.now();
      db.transaction(() => {
        for (const waId of waIds) handle.run(at, waId);
      })();
    },
    pending(limit) {
      return (selectPending.all(limit) as PendingRow[]).map((row) => {
        const payload = JSON.parse(row.payload) as {
          contexts?: ContextNote[];
          images?: ImageContent[];
          text?: string;
        };
        return {
          contexts: payload.contexts ?? [],
          images: payload.images ?? [],
          sentAt: row.sent_at,
          text: payload.text ?? "",
          waId: row.wa_id,
        };
      });
    },
    prune(before) {
      deleteOld.run(before);
    },
  };
}
