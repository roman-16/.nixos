import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";

import { createLogStore, parseLevel } from "../src/logs";

/** A fresh in-memory DB with just the `logs` table the store expects. */
function freshDb(): Database {
  const db = new Database(":memory:");
  db.run(
    `CREATE TABLE logs (
       id    INTEGER PRIMARY KEY AUTOINCREMENT,
       time  INTEGER NOT NULL,
       level INTEGER NOT NULL,
       msg   TEXT    NOT NULL DEFAULT '',
       data  TEXT    NOT NULL DEFAULT '{}'
     )`,
  );
  return db;
}

function line(record: Record<string, unknown>): string {
  return `${JSON.stringify(record)}\n`;
}

describe("parseLevel", () => {
  it("accepts known levels and defaults to all", () => {
    expect(parseLevel("info")).toBe("info");
    expect(parseLevel("warn")).toBe("warn");
    expect(parseLevel("error")).toBe("error");
    expect(parseLevel("all")).toBe("all");
    expect(parseLevel(null)).toBe("all");
    expect(parseLevel("bogus")).toBe("all");
  });
});

describe("createLogStore", () => {
  it("captures JSON lines written to the stream and increments seq", () => {
    const store = createLogStore(freshDb());
    expect(store.seq).toBe(0);
    store.stream.write(line({ level: 30, msg: "hi", time: 1 }));
    expect(store.seq).toBe(1);
    expect(store.query("all")).toEqual([{ level: 30, msg: "hi", time: 1 }]);
  });

  it("ignores non-JSON lines", () => {
    const store = createLogStore(freshDb());
    store.stream.write("not json\n");
    expect(store.query("all")).toEqual([]);
    expect(store.seq).toBe(0);
  });

  it("keeps extra fields in the record but out of the promoted columns", () => {
    const store = createLogStore(freshDb());
    store.stream.write(line({ err: { message: "boom" }, level: 50, msg: "x", time: 2 }));
    expect(store.query("all")[0]).toEqual({
      err: { message: "boom" },
      level: 50,
      msg: "x",
      time: 2,
    });
  });

  it("returns records newest first", () => {
    const store = createLogStore(freshDb());
    for (const n of [1, 2, 3]) store.stream.write(line({ level: 30, msg: String(n), time: n }));
    expect(store.query("all").map((record) => record.msg)).toEqual(["3", "2", "1"]);
  });

  it("applies the level threshold", () => {
    const store = createLogStore(freshDb());
    for (const [level, msg] of [
      [20, "d"],
      [30, "i"],
      [40, "w"],
      [50, "e"],
    ] as const) {
      store.stream.write(line({ level, msg, time: level }));
    }
    expect(store.query("all").map((record) => record.msg)).toEqual(["e", "w", "i", "d"]);
    expect(store.query("info").map((record) => record.msg)).toEqual(["e", "w", "i"]);
    expect(store.query("warn").map((record) => record.msg)).toEqual(["e", "w"]);
    expect(store.query("error").map((record) => record.msg)).toEqual(["e"]);
  });

  it("caps the number of returned rows to the given limit", () => {
    const store = createLogStore(freshDb());
    for (let i = 0; i < 5; i += 1) store.stream.write(line({ level: 30, msg: String(i), time: i }));
    expect(store.query("all", 2).map((record) => record.msg)).toEqual(["4", "3"]);
  });

  it("prunes records older than the cutoff", () => {
    const store = createLogStore(freshDb());
    store.stream.write(line({ level: 30, msg: "old", time: 100 }));
    store.stream.write(line({ level: 30, msg: "new", time: 200 }));
    store.prune(150);
    expect(store.query("all").map((record) => record.msg)).toEqual(["new"]);
  });
});
