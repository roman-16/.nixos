import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";

import { createTokenStore, parseRange, renderTokens, type TokenTotals } from "../src/tokens";

const DAY = 24 * 60 * 60 * 1000;

/** A fresh in-memory DB with just the `tokens` table the store expects. */
function freshDb(): Database {
  const db = new Database(":memory:");
  db.run(
    `CREATE TABLE tokens (
       id          INTEGER PRIMARY KEY AUTOINCREMENT,
       time        INTEGER NOT NULL,
       model       TEXT    NOT NULL DEFAULT '',
       input       INTEGER NOT NULL DEFAULT 0,
       output      INTEGER NOT NULL DEFAULT 0,
       cache_read  INTEGER NOT NULL DEFAULT 0,
       cache_write INTEGER NOT NULL DEFAULT 0
     )`,
  );
  return db;
}

function tt(over: Partial<TokenTotals> = {}): TokenTotals {
  return { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, ...over };
}

describe("parseRange", () => {
  it("accepts every known range", () => {
    for (const range of ["7d", "1m", "3m", "6m", "1y", "3y", "all"] as const) {
      expect(parseRange(range)).toBe(range);
    }
  });

  it("defaults to all for unknown, missing, or inherited keys", () => {
    expect(parseRange(null)).toBe("all");
    expect(parseRange(undefined)).toBe("all");
    expect(parseRange("bogus")).toBe("all");
    expect(parseRange("toString")).toBe("all");
  });
});

describe("createTokenStore", () => {
  it("totals are zero with nothing recorded", () => {
    expect(createTokenStore(freshDb()).totals("all")).toEqual(tt());
  });

  it("sums every category across recorded turns", () => {
    const store = createTokenStore(freshDb());
    store.record(tt({ cacheRead: 100, cacheWrite: 50, input: 200, output: 30 }), "m", Date.now());
    store.record(tt({ cacheRead: 400, cacheWrite: 10, input: 300, output: 20 }), "m", Date.now());
    expect(store.totals("all")).toEqual({ cacheRead: 500, cacheWrite: 60, input: 500, output: 50 });
  });

  it("only sums rows inside the range window", () => {
    const store = createTokenStore(freshDb());
    const now = Date.now();
    store.record(tt({ input: 10 }), "m", now);
    store.record(tt({ input: 1000 }), "m", now - 10 * DAY);
    expect(store.totals("7d").input).toBe(10);
    expect(store.totals("1m").input).toBe(1010);
    expect(store.totals("all").input).toBe(1010);
  });
});

describe("renderTokens", () => {
  it("shows a placeholder when nothing is recorded", () => {
    expect(renderTokens(tt())).toContain("No token usage");
  });

  it("renders a legend row for every category with humanized totals", () => {
    const html = renderTokens(
      tt({ cacheRead: 850000, cacheWrite: 50000, input: 80000, output: 20000 }),
    );
    expect(html).toContain("Cache read");
    expect(html).toContain("Read");
    expect(html).toContain("Cache write");
    expect(html).toContain("Write");
    expect(html).toContain("850K");
    expect(html).toContain("Total: 1.0M tokens");
  });

  it("sizes bar segments proportionally, omits empty ones, and exposes exact counts on hover", () => {
    const html = renderTokens(tt({ cacheRead: 750, input: 250 }));
    expect(html).toContain("flex-grow:750");
    expect(html).toContain("flex-grow:250");
    expect(html).not.toContain("flex-grow:0");
    expect(html).toContain("Cache read: 750 tokens (75.0%)");
    expect(html).toContain("Read: 250 tokens (25.0%)");
  });
});
