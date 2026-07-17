/**
 * Per-turn token accounting, persisted to the shared SQLite database. Every
 * assistant turn's `usage` is appended as one row (see the `turn_end` hook in
 * index.ts); the dashboard sums a time window into a horizontal 100% stacked bar
 * broken down by the four mutually exclusive categories that make up a request's
 * total: cache read, read (input), cache write, and write (output). Each row also
 * stores the per-category USD cost pi computed for it, summed alongside the tokens.
 */

import type { Database } from "bun:sqlite";

import { escapeHtml, humanTokens } from "./format";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type TokenRange = "1d" | "1m" | "1y" | "3m" | "3y" | "6m" | "7d" | "all";

/** Lookback window in days for each range; `all` (the default) is unbounded. */
const RANGE_DAYS: Record<TokenRange, number | null> = {
  "1d": 1,
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
  ["1d", "1d"],
  ["7d", "7d"],
  ["1m", "1m"],
  ["3m", "3m"],
  ["6m", "6m"],
  ["1y", "1y"],
  ["3y", "3y"],
  ["all", "All"],
];

/** The four mutually exclusive categories that make up a request's total. */
export type Category = "cacheRead" | "cacheWrite" | "input" | "output";

/** A per-category value (token counts or USD cost). */
export type CategoryMap = Record<Category, number>;

/** Windowed totals: token counts and USD cost, each broken down by category. */
export interface TokenTotals {
  cost: CategoryMap;
  tokens: CategoryMap;
}

/** The subset of a pi `Usage` this feature records (structurally compatible with it). */
export interface TokenUsageInput {
  cacheRead: number;
  cacheWrite: number;
  cost: CategoryMap;
  input: number;
  output: number;
}

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
  cost_cache_read: number;
  cost_cache_write: number;
  cost_input: number;
  cost_output: number;
  input: number;
  output: number;
}

/** Create a SQLite-backed store for per-turn token usage and cost. */
export function createTokenStore(db: Database): TokenStore {
  const insert = db.query(
    `INSERT INTO tokens
       (time, model, input, output, cache_read, cache_write,
        cost_input, cost_output, cost_cache_read, cost_cache_write)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const select = db.query(
    `SELECT COALESCE(SUM(input), 0)            AS input,
            COALESCE(SUM(output), 0)           AS output,
            COALESCE(SUM(cache_read), 0)       AS cache_read,
            COALESCE(SUM(cache_write), 0)      AS cache_write,
            COALESCE(SUM(cost_input), 0)       AS cost_input,
            COALESCE(SUM(cost_output), 0)      AS cost_output,
            COALESCE(SUM(cost_cache_read), 0)  AS cost_cache_read,
            COALESCE(SUM(cost_cache_write), 0) AS cost_cache_write
       FROM tokens
      WHERE time >= ?`,
  );
  return {
    record(usage, model, time) {
      insert.run(
        time,
        model,
        usage.input,
        usage.output,
        usage.cacheRead,
        usage.cacheWrite,
        usage.cost.input,
        usage.cost.output,
        usage.cost.cacheRead,
        usage.cost.cacheWrite,
      );
    },
    totals(range) {
      const days = RANGE_DAYS[range];
      const since = days == null ? 0 : Date.now() - days * MS_PER_DAY;
      const row = select.get(since) as TotalsRow;
      return {
        cost: {
          cacheRead: Number(row.cost_cache_read),
          cacheWrite: Number(row.cost_cache_write),
          input: Number(row.cost_input),
          output: Number(row.cost_output),
        },
        tokens: {
          cacheRead: Number(row.cache_read),
          cacheWrite: Number(row.cache_write),
          input: Number(row.input),
          output: Number(row.output),
        },
      };
    },
  };
}

/** Bar segments / legend rows, left-to-right: cache read, read, cache write, write. */
const CATEGORIES: { color: string; key: Category; label: string }[] = [
  { color: "bg-indigo-500", key: "cacheRead", label: "Cache read" },
  { color: "bg-sky-400", key: "input", label: "Read" },
  { color: "bg-amber-500", key: "cacheWrite", label: "Cache write" },
  { color: "bg-emerald-500", key: "output", label: "Write" },
];

function percent(value: number, total: number): number {
  return total > 0 ? (value / total) * 100 : 0;
}

function sum(map: CategoryMap): number {
  return map.cacheRead + map.cacheWrite + map.input + map.output;
}

/** Format a USD amount: `$0.00`, `<$0.01` for a sub-cent nonzero, else `$X.XX`. */
function formatUsd(value: number): string {
  if (value <= 0) return "$0.00";
  if (value < 0.01) return "<$0.01";
  return `$${value.toFixed(2)}`;
}

/** Render the #tokens fragment: a horizontal 100% stacked bar (hover a segment for its exact tokens + cost) plus a legend, with per-category and total USD cost. */
export function renderTokens(totals: TokenTotals): string {
  const totalTokens = sum(totals.tokens);
  if (totalTokens <= 0) {
    return `<p class="text-sm text-neutral-500">No token usage recorded for this range yet.</p>`;
  }
  const totalCost = sum(totals.cost);

  // flex-grow proportional to the count auto-normalizes the segment widths to 100%;
  // a small min-width keeps a tiny slice (e.g. Read when Cache read dominates) hoverable.
  const segments = CATEGORIES.filter((cat) => totals.tokens[cat.key] > 0)
    .map((cat) => {
      const tokens = totals.tokens[cat.key];
      const title = `${cat.label}: ${tokens.toLocaleString("en-US")} tokens (${percent(tokens, totalTokens).toFixed(1)}%) · ${formatUsd(totals.cost[cat.key])}`;
      return `<div class="h-full min-w-[2px] ${cat.color}" style="flex-grow:${tokens}" title="${escapeHtml(title)}"></div>`;
    })
    .join("");

  const legend = CATEGORIES.map((cat) => {
    const tokens = totals.tokens[cat.key];
    return `<div class="flex items-center gap-2">
      <span class="h-2.5 w-2.5 shrink-0 rounded-sm ${cat.color}"></span>
      <span class="text-neutral-300">${cat.label}</span>
      <span class="ml-auto tabular-nums text-neutral-500">${humanTokens(tokens)} · ${percent(tokens, totalTokens).toFixed(1)}% · ${escapeHtml(formatUsd(totals.cost[cat.key]))}</span>
    </div>`;
  }).join("");

  return `<div class="space-y-3">
    <div class="flex h-3 w-full overflow-hidden rounded-full bg-white/5">${segments}</div>
    <div class="grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2">${legend}</div>
    <p class="text-right text-[11px] text-neutral-500">Total: ${humanTokens(totalTokens)} tokens · ${escapeHtml(formatUsd(totalCost))}</p>
  </div>`;
}
