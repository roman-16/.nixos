/**
 * The app's own pino log records, persisted to the shared SQLite database so they
 * survive restarts and show up in the dashboard log viewer afterwards. The store's
 * `stream` is handed to pino as its destination: every record is forwarded to
 * stdout (so journald still captures it) and inserted into the `logs` table.
 */

import type { Database } from "bun:sqlite";

const DEFAULT_QUERY_LIMIT = 1000;

export type LogLevel = "all" | "error" | "info" | "warn";

export type LogRecord = Record<string, unknown> & {
  level?: number;
  msg?: string;
  time?: number;
};

const THRESHOLDS: Record<LogLevel, number> = { all: 0, error: 50, info: 30, warn: 40 };

/** The record fields promoted to their own columns; everything else is serialized into `data`. */
const COLUMN_KEYS = new Set(["level", "msg", "time"]);

/** Coerce a query value to a known filter level, defaulting to "all". */
export function parseLevel(value: string | null | undefined): LogLevel {
  return value === "info" || value === "warn" || value === "error" ? value : "all";
}

/**
 * Whether a log record clears the notify threshold (its level is the alert-worthiness).
 * Baileys logging is silenced by default (baileysLogLevel); if it's raised for debugging, its
 * tagged records are pure transport noise, so they still never forward to WhatsApp.
 */
export function shouldNotify(record: LogRecord, minLevel: LogLevel): boolean {
  if (record.src === "baileys") return false;
  return typeof record.level === "number" && record.level >= THRESHOLDS[minLevel];
}

/** A per-key rate limiter: returns true at most once per `windowMs` for a given key. */
export function createThrottle(
  windowMs: number,
  now: () => number = () => Date.now(),
): (key: string) => boolean {
  const last = new Map<string, number>();
  return (key) => {
    const at = now();
    const previous = last.get(key);
    if (previous !== undefined && at - previous < windowMs) return false;
    last.set(key, at);
    return true;
  };
}

interface LogRow {
  data: string;
  level: number;
  msg: string;
  time: number;
}

export interface LogStore {
  onRecord?: (record: LogRecord) => void;
  prune(beforeMs: number): void;
  query(level: LogLevel, limit?: number): LogRecord[];
  readonly seq: number;
  stream: { write(line: string): void };
}

/** Create a SQLite-backed log store plus the pino destination stream that feeds it. */
export function createLogStore(db: Database): LogStore {
  const insert = db.query("INSERT INTO logs (time, level, msg, data) VALUES (?, ?, ?, ?)");
  const selectByLevel = db.query(
    "SELECT time, level, msg, data FROM logs WHERE level >= ? ORDER BY id DESC LIMIT ?",
  );
  const deleteOld = db.query("DELETE FROM logs WHERE time < ?");
  let onRecord: ((record: LogRecord) => void) | undefined;
  let seq = 0;

  function record(line: string): void {
    let parsed: LogRecord;
    try {
      parsed = JSON.parse(line) as LogRecord;
    } catch {
      return; // non-JSON line (shouldn't happen with pino); already forwarded to stdout
    }
    const time = typeof parsed.time === "number" ? parsed.time : Date.now();
    const level = typeof parsed.level === "number" ? parsed.level : 30;
    const msg = typeof parsed.msg === "string" ? parsed.msg : "";
    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!COLUMN_KEYS.has(key)) data[key] = value;
    }
    insert.run(time, level, msg, JSON.stringify(data));
    seq += 1;
    if (onRecord) {
      try {
        onRecord({ ...parsed, level, msg, time });
      } catch {
        // a forwarder fault must never break logging
      }
    }
  }

  return {
    get onRecord() {
      return onRecord;
    },
    set onRecord(fn) {
      onRecord = fn;
    },
    prune(beforeMs) {
      deleteOld.run(beforeMs);
    },
    query(level, limit = DEFAULT_QUERY_LIMIT) {
      const rows = selectByLevel.all(THRESHOLDS[level], limit) as LogRow[];
      return rows.map((row) => {
        let extras: Record<string, unknown> = {};
        try {
          extras = JSON.parse(row.data) as Record<string, unknown>;
        } catch {
          // corrupt data column; fall back to the promoted columns alone
        }
        return { ...extras, level: row.level, msg: row.msg, time: row.time };
      });
    },
    get seq() {
      return seq;
    },
    stream: {
      write(line: string) {
        process.stdout.write(line);
        for (const part of line.split("\n")) {
          const trimmed = part.trim();
          if (trimmed) record(trimmed);
        }
      },
    },
  };
}
