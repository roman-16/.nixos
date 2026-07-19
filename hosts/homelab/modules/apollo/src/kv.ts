import type { Database } from "bun:sqlite";

/**
 * Tiny key-value accessor over the shared `kv` table, for durable scalar app state that
 * doesn't warrant its own table (e.g. the hash of the profile picture already applied to
 * WhatsApp, so reconnects don't re-upload it).
 */
export interface Kv {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}

export function createKv(db: Database): Kv {
  const select = db.query("SELECT value FROM kv WHERE key = ?");
  const upsert = db.query(
    "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  return {
    get(key) {
      const row = select.get(key) as { value: string } | null;
      return row ? row.value : undefined;
    },
    set(key, value) {
      upsert.run(key, value);
    },
  };
}
