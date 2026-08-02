import { randomUUID } from "node:crypto";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Database } from "bun:sqlite";

import { type ImageBytes, imageFromLine } from "./chat";

/**
 * SQLite mirror of the pi session's entry stream - the dashboard's single source of
 * truth for the chat. Each entry is stored verbatim (the exact JSON pi writes to its
 * session file) as it is appended, so the existing transcript parser and renderer
 * consume it unchanged and nothing in the app reads pi's JSONL. The mirror is
 * append-only: it keeps every entry even after pi compacts them out of live context.
 */

export interface ChatTail {
  /** The window's entries, oldest-first, each a stored JSONL line. */
  entries: string[];
  /** Whether older entries exist before the window, so the chat can load more. */
  more: boolean;
  /** Cheap change tag (count + newest row id) for render dedup. */
  version: string;
}

export interface SkillMessage {
  at: number;
  source: string;
  text: string;
}

export interface ChatStore {
  /** Record an out-of-band skill message (a fired reminder, a macros reply) as a chat entry. */
  appendSkillMessage(sessionId: string, source: string, text: string): void;
  image(sessionId: string, entryId: string, index: number): ImageBytes | undefined;
  /** Skill messages delivered in a time span: what the user saw that the session never recorded. */
  skillMessagesBetween(sessionId: string, fromMs: number, toMs: number): SkillMessage[];
  sync(sessionId: string, entries: SessionEntry[]): void;
  tail(sessionId: string, count: number): ChatTail;
}

export function createChatStore(db: Database): ChatStore {
  const insert = db.query(
    "INSERT OR IGNORE INTO chat (session_id, entry_id, type, time, data) VALUES (?, ?, ?, ?, ?)",
  );
  const selectTail = db.query(
    "SELECT id, data FROM chat WHERE session_id = ? ORDER BY id DESC LIMIT ?",
  );
  const olderExists = db.query("SELECT 1 FROM chat WHERE session_id = ? AND id < ? LIMIT 1");
  const selectData = db.query("SELECT data FROM chat WHERE session_id = ? AND entry_id = ?");
  const selectSkillMessages = db.query(
    "SELECT time, data FROM chat WHERE session_id = ? AND type = 'custom' AND time >= ? AND time <= ? ORDER BY id",
  );

  // How many entries have already been mirrored per session, so a sync only walks the
  // growing tail. INSERT OR IGNORE on (session_id, entry_id) keeps it correct even when
  // the cursor is stale (e.g. the first sync after a restart re-walks the whole list).
  const cursors = new Map<string, number>();

  return {
    appendSkillMessage(sessionId, source, text) {
      const timestamp = new Date().toISOString();
      const id = `skill-${randomUUID()}`;
      const entry = {
        customType: "skill_message",
        data: { source, text },
        id,
        parentId: null,
        timestamp,
        type: "custom",
      };
      insert.run(sessionId, id, "custom", Date.parse(timestamp), JSON.stringify(entry));
    },
    image(sessionId, entryId, index) {
      const row = selectData.get(sessionId, entryId) as { data: string } | null;
      return row ? imageFromLine(row.data, index) : undefined;
    },
    skillMessagesBetween(sessionId, fromMs, toMs) {
      const rows = selectSkillMessages.all(sessionId, fromMs, toMs) as {
        data: string;
        time: number;
      }[];
      const out: SkillMessage[] = [];
      for (const row of rows) {
        try {
          const entry = JSON.parse(row.data) as {
            customType?: string;
            data?: { source?: string; text?: string };
          };
          if (entry.customType !== "skill_message") continue;
          out.push({
            at: row.time,
            source: entry.data?.source ?? "skill",
            text: entry.data?.text ?? "",
          });
        } catch {
          // a corrupt row is not worth failing a compaction over
        }
      }
      return out;
    },
    sync(sessionId, entries) {
      const from = cursors.get(sessionId) ?? 0;
      if (entries.length > from) {
        db.transaction(() => {
          for (let i = from; i < entries.length; i += 1) {
            const entry = entries[i]!;
            const time = Date.parse(entry.timestamp);
            insert.run(
              sessionId,
              entry.id,
              entry.type,
              Number.isNaN(time) ? null : time,
              JSON.stringify(entry),
            );
          }
        })();
      }
      cursors.set(sessionId, entries.length);
    },
    tail(sessionId, count) {
      const rows = selectTail.all(sessionId, count) as { data: string; id: number }[];
      const oldest = rows[rows.length - 1];
      const more =
        rows.length === count && oldest != undefined
          ? olderExists.get(sessionId, oldest.id) != null
          : false;
      return {
        entries: rows.map((row) => row.data).reverse(),
        more,
        version: `${count}:${rows[0]?.id ?? 0}`,
      };
    },
  };
}
