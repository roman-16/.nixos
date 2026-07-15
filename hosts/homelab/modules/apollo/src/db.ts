import { Database } from "bun:sqlite";

/**
 * Apollo's general-purpose SQLite database: a single file opened once at startup
 * and shared by every feature that needs durable storage (logging is the first).
 * Schema changes are additive migrations keyed on PRAGMA user_version - append a
 * version's statements to MIGRATIONS and they run once, in a transaction, on the
 * next open.
 */

/** Ordered schema versions; each is the list of statements that bring the DB to version (index + 1). */
const MIGRATIONS: string[][] = [
  [
    `CREATE TABLE logs (
       id    INTEGER PRIMARY KEY AUTOINCREMENT,
       time  INTEGER NOT NULL,
       level INTEGER NOT NULL,
       msg   TEXT    NOT NULL DEFAULT '',
       data  TEXT    NOT NULL DEFAULT '{}'
     )`,
    `CREATE INDEX logs_level_id ON logs (level, id)`,
  ],
  [
    `CREATE TABLE tokens (
       id          INTEGER PRIMARY KEY AUTOINCREMENT,
       time        INTEGER NOT NULL,
       model       TEXT    NOT NULL DEFAULT '',
       input       INTEGER NOT NULL DEFAULT 0,
       output      INTEGER NOT NULL DEFAULT 0,
       cache_read  INTEGER NOT NULL DEFAULT 0,
       cache_write INTEGER NOT NULL DEFAULT 0
     )`,
    `CREATE INDEX tokens_time ON tokens (time)`,
  ],
  [
    `ALTER TABLE tokens ADD COLUMN cost_input       REAL NOT NULL DEFAULT 0`,
    `ALTER TABLE tokens ADD COLUMN cost_output      REAL NOT NULL DEFAULT 0`,
    `ALTER TABLE tokens ADD COLUMN cost_cache_read  REAL NOT NULL DEFAULT 0`,
    `ALTER TABLE tokens ADD COLUMN cost_cache_write REAL NOT NULL DEFAULT 0`,
  ],
];

/** Apply every migration newer than the DB's user_version, each in its own transaction. */
export function migrate(db: Database): void {
  const { user_version: current } = db.query("PRAGMA user_version").get() as {
    user_version: number;
  };
  for (let version = current; version < MIGRATIONS.length; version += 1) {
    db.transaction(() => {
      for (const statement of MIGRATIONS[version]!) db.run(statement);
      db.run(`PRAGMA user_version = ${version + 1}`);
    })();
  }
}

/** Open (creating if absent) the SQLite database in WAL mode and bring its schema up to date. */
export function openDatabase(path: string): Database {
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 5000");
  db.run("PRAGMA synchronous = NORMAL");
  migrate(db);
  return db;
}
