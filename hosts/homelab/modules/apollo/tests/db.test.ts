import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";

import { migrate, openDatabase } from "../src/db";

function tableNames(db: Database): string[] {
  return (
    db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
  )
    .map((row) => row.name)
    .sort();
}

function userVersion(db: Database): number {
  return (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
}

describe("migrate", () => {
  it("brings a fresh database up to the latest schema version", () => {
    const db = new Database(":memory:");
    migrate(db);
    expect(userVersion(db)).toBeGreaterThan(0);
    expect(tableNames(db)).toContain("logs");
  });

  it("is idempotent", () => {
    const db = new Database(":memory:");
    migrate(db);
    const version = userVersion(db);
    migrate(db);
    expect(userVersion(db)).toBe(version);
    expect(tableNames(db)).toContain("logs");
  });
});

describe("openDatabase", () => {
  it("opens a database with the schema applied", () => {
    const db = openDatabase(":memory:");
    expect(tableNames(db)).toContain("logs");
    expect(userVersion(db)).toBeGreaterThan(0);
  });
});
