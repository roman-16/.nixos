import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";

import {
  type CategoryMap,
  createTokenStore,
  parseRange,
  renderTokens,
  type TokenTotals,
  type TokenUsageInput,
} from "../src/tokens";

const DAY = 24 * 60 * 60 * 1000;

/** A fresh in-memory DB with just the `tokens` table (schema v3) the store expects. */
function freshDb(): Database {
  const db = new Database(":memory:");
  db.run(
    `CREATE TABLE tokens (
       id               INTEGER PRIMARY KEY AUTOINCREMENT,
       time             INTEGER NOT NULL,
       model            TEXT    NOT NULL DEFAULT '',
       input            INTEGER NOT NULL DEFAULT 0,
       output           INTEGER NOT NULL DEFAULT 0,
       cache_read       INTEGER NOT NULL DEFAULT 0,
       cache_write      INTEGER NOT NULL DEFAULT 0,
       cost_input       REAL    NOT NULL DEFAULT 0,
       cost_output      REAL    NOT NULL DEFAULT 0,
       cost_cache_read  REAL    NOT NULL DEFAULT 0,
       cost_cache_write REAL    NOT NULL DEFAULT 0
     )`,
  );
  return db;
}

function map(over: Partial<CategoryMap> = {}): CategoryMap {
  return { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, ...over };
}

function usage(
  tokens: Partial<CategoryMap> = {},
  cost: Partial<CategoryMap> = {},
): TokenUsageInput {
  return { ...map(tokens), cost: map(cost) };
}

function totals(tokens: Partial<CategoryMap> = {}, cost: Partial<CategoryMap> = {}): TokenTotals {
  return { cost: map(cost), tokens: map(tokens) };
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
    expect(createTokenStore(freshDb()).totals("all")).toEqual(totals());
  });

  it("sums tokens and cost per category across recorded turns", () => {
    const store = createTokenStore(freshDb());
    store.record(
      usage(
        { cacheRead: 100, cacheWrite: 50, input: 200, output: 30 },
        { cacheRead: 0.1, cacheWrite: 0.5, input: 0.2, output: 0.9 },
      ),
      "m",
      Date.now(),
    );
    store.record(
      usage(
        { cacheRead: 400, cacheWrite: 10, input: 300, output: 20 },
        { cacheRead: 0.4, cacheWrite: 0.1, input: 0.3, output: 0.6 },
      ),
      "m",
      Date.now(),
    );
    const result = store.totals("all");
    expect(result.tokens).toEqual({ cacheRead: 500, cacheWrite: 60, input: 500, output: 50 });
    expect(result.cost.cacheRead).toBeCloseTo(0.5);
    expect(result.cost.cacheWrite).toBeCloseTo(0.6);
    expect(result.cost.input).toBeCloseTo(0.5);
    expect(result.cost.output).toBeCloseTo(1.5);
  });

  it("only sums rows inside the range window", () => {
    const store = createTokenStore(freshDb());
    const now = Date.now();
    store.record(usage({ input: 10 }, { input: 0.1 }), "m", now);
    store.record(usage({ input: 1000 }, { input: 5 }), "m", now - 10 * DAY);
    expect(store.totals("7d").tokens.input).toBe(10);
    expect(store.totals("7d").cost.input).toBeCloseTo(0.1);
    expect(store.totals("1m").tokens.input).toBe(1010);
    expect(store.totals("all").cost.input).toBeCloseTo(5.1);
  });
});

describe("renderTokens", () => {
  it("shows a placeholder when nothing is recorded", () => {
    expect(renderTokens(totals())).toContain("No token usage");
  });

  it("renders a legend row for every category with humanized totals and cost", () => {
    const html = renderTokens(
      totals(
        { cacheRead: 850000, cacheWrite: 50000, input: 80000, output: 20000 },
        { cacheRead: 1.2, cacheWrite: 0.3, input: 0.1, output: 0.7 },
      ),
    );
    expect(html).toContain("Cache read");
    expect(html).toContain("Read");
    expect(html).toContain("Cache write");
    expect(html).toContain("Write");
    expect(html).toContain("850K");
    expect(html).toContain("$1.20");
    expect(html).toContain("Total: 1.0M tokens · $2.30");
  });

  it("sizes bar segments proportionally, omits empty ones, and shows tokens + cost on hover", () => {
    const html = renderTokens(
      totals({ cacheRead: 750, input: 250 }, { cacheRead: 0.9, input: 0.3 }),
    );
    expect(html).toContain("flex-grow:750");
    expect(html).toContain("flex-grow:250");
    expect(html).not.toContain("flex-grow:0");
    expect(html).toContain("Cache read: 750 tokens (75.0%) · $0.90");
    expect(html).toContain("Read: 250 tokens (25.0%) · $0.30");
  });

  it("escapes a sub-cent cost as &lt;$0.01", () => {
    const html = renderTokens(totals({ input: 100 }, { input: 0.004 }));
    expect(html).toContain("&lt;$0.01");
    expect(html).not.toContain("<$0.01");
  });
});
