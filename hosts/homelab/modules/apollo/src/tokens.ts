/**
 * Per-turn token accounting, persisted to the shared SQLite database. Every
 * assistant turn's `usage` is appended as one row (see the `turn_end` hook in
 * index.ts); the dashboard sums a time window into a horizontal 100% stacked bar
 * broken down by the four mutually exclusive categories that make up a request's
 * total: cache read, read (input), cache write, and write (output).
 */

import type { Database } from "bun:sqlite";

import { escapeHtml, humanTokens } from "./format";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type TokenRange = "1m" | "1y" | "3m" | "3y" | "6m" | "7d" | "all";

/** Lookback window in days for each range; `all` (the default) is unbounded. */
const RANGE_DAYS: Record<TokenRange, number | null> = {
  "7d": 7,
  "1m": 30,
  "3m": 90,
  "6m": 180,
  "1y": 365,
  "3y": 1095,
  all: null,
};

/** Range keys with their pill labels, in ascending-window order (drives the dashboard toggle). */
export const RANGE_LABELS: [TokenRange, string][] = [
  ["7d", "7d"],
  ["1m", "1m"],
  ["3m", "3m"],
  ["6m", "6m"],
  ["1y", "1y"],
  ["3y", "3y"],
  ["all", "All"],
];

/** The four mutually exclusive token categories that sum to a request's total. */
export interface TokenTotals {
  cacheRead: number;
  cacheWrite: number;
  input: number;
  output: number;
}

/** The subset of a pi `Usage` this feature records (structurally compatible with it). */
export type TokenUsageInput = TokenTotals;

export interface TokenStore {
  record(usage: TokenUsageInput, model: string, time: number): void;
  totals(range: TokenRange): TokenTotals;
}

/** Coerce a query value to a known range, defaulting to `all`. */
export function parseRange(value: string | null | undefined): TokenRange {
  return value != null && Object.hasOwn(RANGE_DAYS, value) ? (value as TokenRange) : "all";
}

interface TotalsRow {
  cache_read: number;
  cache_write: number;
  input: number;
  output: number;
}

/** Create a SQLite-backed store for per-turn token usage. */
export function createTokenStore(db: Database): TokenStore {
  const insert = db.query(
    "INSERT INTO tokens (time, model, input, output, cache_read, cache_write) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const select = db.query(
    `SELECT COALESCE(SUM(input), 0)       AS input,
            COALESCE(SUM(output), 0)      AS output,
            COALESCE(SUM(cache_read), 0)  AS cache_read,
            COALESCE(SUM(cache_write), 0) AS cache_write
       FROM tokens
      WHERE time >= ?`,
  );
  return {
    record(usage, model, time) {
      insert.run(time, model, usage.input, usage.output, usage.cacheRead, usage.cacheWrite);
    },
    totals(range) {
      const days = RANGE_DAYS[range];
      const since = days == null ? 0 : Date.now() - days * MS_PER_DAY;
      const row = select.get(since) as TotalsRow;
      return {
        cacheRead: Number(row.cache_read),
        cacheWrite: Number(row.cache_write),
        input: Number(row.input),
        output: Number(row.output),
      };
    },
  };
}

/** Bar segments / legend rows, left-to-right: cache read, read, cache write, write. */
const CATEGORIES: { color: string; key: keyof TokenTotals; label: string }[] = [
  { color: "bg-indigo-500", key: "cacheRead", label: "Cache read" },
  { color: "bg-sky-400", key: "input", label: "Read" },
  { color: "bg-amber-500", key: "cacheWrite", label: "Cache write" },
  { color: "bg-emerald-500", key: "output", label: "Write" },
];

function percent(value: number, total: number): number {
  return total > 0 ? (value / total) * 100 : 0;
}

/** Render the #tokens fragment: a horizontal 100% stacked bar (hover a segment for the exact count) plus a legend. */
export function renderTokens(totals: TokenTotals): string {
  const total = totals.cacheRead + totals.input + totals.cacheWrite + totals.output;
  if (total <= 0) {
    return `<p class="text-sm text-neutral-500">No token usage recorded for this range yet.</p>`;
  }

  // flex-grow proportional to the count auto-normalizes the segment widths to 100%;
  // a small min-width keeps a tiny slice (e.g. Read when Cache read dominates) hoverable.
  const segments = CATEGORIES.filter((cat) => totals[cat.key] > 0)
    .map((cat) => {
      const value = totals[cat.key];
      const title = `${cat.label}: ${value.toLocaleString("en-US")} tokens (${percent(value, total).toFixed(1)}%)`;
      return `<div class="h-full min-w-[2px] ${cat.color}" style="flex-grow:${value}" title="${escapeHtml(title)}"></div>`;
    })
    .join("");

  const legend = CATEGORIES.map((cat) => {
    const value = totals[cat.key];
    return `<div class="flex items-center gap-2">
      <span class="h-2.5 w-2.5 shrink-0 rounded-sm ${cat.color}"></span>
      <span class="text-neutral-300">${cat.label}</span>
      <span class="ml-auto tabular-nums text-neutral-500">${humanTokens(value)} · ${percent(value, total).toFixed(1)}%</span>
    </div>`;
  }).join("");

  return `<div class="space-y-3">
    <div class="flex h-3 w-full overflow-hidden rounded-full bg-white/5">${segments}</div>
    <div class="grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2">${legend}</div>
    <p class="text-right text-[11px] text-neutral-500">Total: ${humanTokens(total)} tokens</p>
  </div>`;
}
