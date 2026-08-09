import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";

import {
  type CategoryMap,
  createTokenStore,
  type DayTokens,
  parseRange,
  renderTokens,
  renderTokensDaily,
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
    for (const range of ["1d", "7d", "1m", "3m", "6m", "1y", "3y", "all"] as const) {
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

describe("daily", () => {
  // Midday timestamps so the bucket date is the same in any runner timezone.
  const noon = (iso: string) => new Date(`${iso}T12:00:00`).getTime();

  it("returns nothing when no tokens are recorded", () => {
    expect(createTokenStore(freshDb()).daily("all")).toEqual([]);
  });

  it("groups rows by calendar day and sums each category", () => {
    const store = createTokenStore(freshDb());
    store.record(
      usage({ input: 10, output: 5 }, { input: 0.1, output: 0.2 }),
      "m",
      noon("2026-07-10"),
    );
    store.record(usage({ input: 20 }, { input: 0.3 }), "m", noon("2026-07-10"));
    store.record(usage({ cacheRead: 100 }, { cacheRead: 0.5 }), "m", noon("2026-07-11"));
    const days = store.daily("all");
    expect(days.map((d) => d.day)).toEqual(["2026-07-10", "2026-07-11"]);
    expect(days[0]!.tokens).toEqual({ cacheRead: 0, cacheWrite: 0, input: 30, output: 5 });
    expect(days[0]!.cost.input).toBeCloseTo(0.4);
    expect(days[1]!.tokens.cacheRead).toBe(100);
  });

  it("only includes days inside the range window", () => {
    const store = createTokenStore(freshDb());
    const now = Date.now();
    store.record(usage({ input: 10 }), "m", now);
    store.record(usage({ input: 99 }), "m", now - 10 * DAY);
    expect(store.daily("7d").map((d) => d.tokens.input)).toEqual([10]);
    expect(store.daily("1m")).toHaveLength(2);
  });
});

describe("calendar-aligned ranges", () => {
  const midnightToday = () => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };

  it("1d is the current calendar day, not a rolling 24h window", () => {
    const store = createTokenStore(freshDb());
    const midnight = midnightToday();
    // Just after midnight (today) vs. just before it (yesterday, but < 24h old early in the day).
    store.record(usage({ input: 5 }), "m", midnight + 60_000);
    store.record(usage({ input: 50 }), "m", midnight - 60_000);
    expect(store.totals("1d").tokens.input).toBe(5);
    expect(store.daily("1d").map((d) => d.tokens.input)).toEqual([5]);
  });

  it("7d spans today plus the 6 prior whole days", () => {
    const store = createTokenStore(freshDb());
    // Midday offsets keep every row clear of the midnight boundary (DST-robust).
    const noon = midnightToday() + 12 * 60 * 60 * 1000;
    store.record(usage({ input: 1 }), "m", noon); // today
    store.record(usage({ input: 2 }), "m", noon - 6 * DAY); // 6 days ago, earliest in window
    store.record(usage({ input: 4 }), "m", noon - 7 * DAY); // 7 days ago, just outside
    expect(store.totals("7d").tokens.input).toBe(3);
    expect(store.daily("7d").map((d) => d.tokens.input)).toEqual([2, 1]);
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

describe("renderTokensDaily", () => {
  const day = (over: Partial<DayTokens> = {}): DayTokens => ({
    cost: map(),
    day: "2026-07-14",
    tokens: map(),
    ...over,
  });

  it("shows a placeholder when there are no days", () => {
    expect(renderTokensDaily([])).toContain("No daily token usage");
  });

  it("renders a column per day with the date, total tokens, and per-segment tooltip", () => {
    const html = renderTokensDaily([
      day({
        cost: map({ input: 0.2, output: 0.9 }),
        day: "2026-07-14",
        tokens: map({ input: 300, output: 100 }),
      }),
    ]);
    expect(html).toContain("14.07");
    expect(html).toContain(">400<");
    expect(html).toContain('title="$1.10"');
    expect(html).toContain("Read: 300 tokens (75.0%) · $0.20");
  });

  it("gives every column the same full height, whatever the day's size", () => {
    const html = renderTokensDaily([
      day({ day: "2026-07-13", tokens: map({ input: 1000 }) }),
      day({ day: "2026-07-14", tokens: map({ input: 250 }) }),
    ]);
    expect(html.match(/h-32/g)).toHaveLength(2);
    expect(html).not.toContain("height:");
  });

  it("stacks the segments in proportion to their share of that day", () => {
    const html = renderTokensDaily([
      day({ tokens: map({ cacheRead: 750, input: 250 }) }),
      day({ day: "2026-07-15", tokens: map({ cacheRead: 3, input: 1 }) }),
    ]);
    expect(html).toContain("flex-grow:750");
    expect(html).toContain("flex-grow:250");
    // The same mix a thousandth the size reads the same, which is the point of the shape.
    expect(html).toContain("Cache read: 750 tokens (75.0%)");
    expect(html).toContain("Cache read: 3 tokens (75.0%)");
  });

  it("omits categories with no tokens for the day", () => {
    const html = renderTokensDaily([day({ tokens: map({ input: 5 }) })]);
    expect(html).toContain("Read: 5 tokens");
    expect(html).not.toContain("Cache read:");
  });

  it("spreads multiple days across the full width, flush to the edges", () => {
    const html = renderTokensDaily([
      day({ day: "2026-07-14", tokens: map({ input: 5 }) }),
      day({ day: "2026-07-15", tokens: map({ input: 3 }) }),
    ]);
    expect(html).toContain("justify-between");
    expect(html).toContain("min-w-full");
  });

  it("grows past that width when a range holds more days than fit, so the row scrolls", () => {
    expect(renderTokensDaily([day({ tokens: map({ input: 5 }) })])).toContain("w-max");
  });

  it("centers a lone column instead of stranding it at the left edge", () => {
    expect(renderTokensDaily([day({ tokens: map({ input: 5 }) })])).toContain("justify-center");
  });
});
