import type { Database } from "bun:sqlite";

/**
 * Thin persistent store for the timestamp of the last inbound message, used to decide which
 * day boundaries to announce when the user next writes (see newday.ts). Backed by the shared
 * `kv` table so it survives restarts and deploys.
 */

const LAST_INBOUND_KEY = "lastInboundAt";

export interface DayState {
  getLast(): Date | undefined;
  setLast(atMs: number): void;
}

export function createDayState(db: Database): DayState {
  const select = db.query("SELECT value FROM kv WHERE key = ?");
  const upsert = db.query(
    "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  return {
    getLast() {
      const row = select.get(LAST_INBOUND_KEY) as { value: string } | null;
      if (!row) return undefined;
      const ms = Number(row.value);
      return Number.isFinite(ms) ? new Date(ms) : undefined;
    },
    setLast(atMs) {
      upsert.run(LAST_INBOUND_KEY, String(atMs));
    },
  };
}
