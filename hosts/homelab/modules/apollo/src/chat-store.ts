import { randomUUID } from "node:crypto";

import type { ImageContent } from "@earendil-works/pi-ai";
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
  /** The newest entries, oldest-first, each a stored JSONL line. */
  entries: string[];
  /** Row id of the newest entry, as a cheap change tag for render dedup. */
  newest: number;
}

/**
 * A page of history: the entries immediately older than a cursor, oldest-first.
 *
 * The cursor is an entry id rather than an offset, so a page names a fixed stretch of the log
 * whatever arrives in the meantime, and asking twice returns the same thing.
 */
export interface ChatPage {
  entries: string[];
  /** When the cursor entry was recorded: the day this page's oldest dividers butt against. */
  boundaryTime: number | undefined;
}

export interface SkillMessage {
  at: number;
  source: string;
  text: string;
}

export interface ChatStore {
  /** Record an out-of-band skill message (a fired reminder, a macros reply, a rendered diagram) as a chat entry, with any image it delivered. */
  appendSkillMessage(
    sessionId: string,
    source: string,
    text: string,
    images?: ImageContent[],
  ): void;
  image(sessionId: string, entryId: string, index: number): ImageBytes | undefined;
  /** The `count` entries just older than `beforeEntryId`; empty at the start of the conversation. */
  older(sessionId: string, beforeEntryId: string, count: number): ChatPage;
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
  const selectCursor = db.query("SELECT id, time FROM chat WHERE session_id = ? AND entry_id = ?");
  const selectOlder = db.query(
    "SELECT data FROM chat WHERE session_id = ? AND id < ? ORDER BY id DESC LIMIT ?",
  );
  const selectData = db.query("SELECT data FROM chat WHERE session_id = ? AND entry_id = ?");
  const selectSkillMessages = db.query(
    "SELECT time, data FROM chat WHERE session_id = ? AND type = 'custom' AND time >= ? AND time <= ? ORDER BY id",
  );

  // How many entries have already been mirrored per session, so a sync only walks the
  // growing tail. INSERT OR IGNORE on (session_id, entry_id) keeps it correct even when
  // the cursor is stale (e.g. the first sync after a restart re-walks the whole list).
  const cursors = new Map<string, number>();

  return {
    appendSkillMessage(sessionId, source, text, images = []) {
      const timestamp = new Date().toISOString();
      const id = `skill-${randomUUID()}`;
      const entry = {
        customType: "skill_message",
        data: images.length > 0 ? { images, source, text } : { source, text },
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
    older(sessionId, beforeEntryId, count) {
      const cursor = selectCursor.get(sessionId, beforeEntryId) as {
        id: number;
        time: number | null;
      } | null;
      // An unknown cursor is the same answer as the start of the conversation: nothing older.
      if (!cursor) return { boundaryTime: undefined, entries: [] };
      const rows = selectOlder.all(sessionId, cursor.id, count) as { data: string }[];
      return {
        boundaryTime: cursor.time ?? undefined,
        entries: rows.map((row) => row.data).reverse(),
      };
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
      return { entries: rows.map((row) => row.data).reverse(), newest: rows[0]?.id ?? 0 };
    },
  };
}
