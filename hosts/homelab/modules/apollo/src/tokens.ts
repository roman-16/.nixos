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

export type TokenRange = "1d" | "1m" | "1y" | "3m" | "3y" | "6m" | "7d" | "all";

/** Calendar days each range spans, counting today; `all` (the default) is unbounded. */
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

/** One calendar day's token counts and USD cost, each broken down by category. */
export interface DayTokens {
  cost: CategoryMap;
  day: string;
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
  daily(range: TokenRange): DayTokens[];
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

interface DailyRow extends TotalsRow {
  day: string;
}

/** Map a summed SQL row into the token + cost category maps. */
function rowMaps(row: TotalsRow): TokenTotals {
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
}

/**
 * Local-midnight start of a range's first calendar day (today counts as one); 0 for the
 * unbounded `all`. `1d` is today since 00:00, `7d` is today plus the 6 prior whole days, and
 * so on - a calendar window aligned to the local day, not a rolling N*24h span. Local date
 * setters normalize across DST, so the boundary lands exactly on local midnight even around a
 * time change, matching the daily buckets' `localtime` grouping.
 */
function sinceFor(range: TokenRange): number {
  const days = RANGE_DAYS[range];
  if (days == null) return 0;
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  return start.getTime();
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
  const selectDaily = db.query(
    `SELECT date(time / 1000, 'unixepoch', 'localtime') AS day,
            COALESCE(SUM(input), 0)            AS input,
            COALESCE(SUM(output), 0)           AS output,
            COALESCE(SUM(cache_read), 0)       AS cache_read,
            COALESCE(SUM(cache_write), 0)      AS cache_write,
            COALESCE(SUM(cost_input), 0)       AS cost_input,
            COALESCE(SUM(cost_output), 0)      AS cost_output,
            COALESCE(SUM(cost_cache_read), 0)  AS cost_cache_read,
            COALESCE(SUM(cost_cache_write), 0) AS cost_cache_write
       FROM tokens
      WHERE time >= ?
      GROUP BY day
      ORDER BY day`,
  );
  return {
    daily(range) {
      const rows = selectDaily.all(sinceFor(range)) as DailyRow[];
      return rows.map((row) => ({ ...rowMaps(row), day: row.day }));
    },
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
      return rowMaps(select.get(sinceFor(range)) as TotalsRow);
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

/** Native-`title` text for one stacked-bar segment: category, tokens, share, cost. */
function segmentTitle(label: string, tokens: number, pct: number, cost: number): string {
  return `${label}: ${tokens.toLocaleString("en-US")} tokens (${pct.toFixed(1)}%) · ${formatUsd(cost)}`;
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
      const title = segmentTitle(
        cat.label,
        tokens,
        percent(tokens, totalTokens),
        totals.cost[cat.key],
      );
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

/** A short `DD.MM` label from an ISO `YYYY-MM-DD` day key. */
function dayLabel(iso: string): string {
  const [, month, day] = iso.split("-");
  return `${day}.${month}`;
}

/**
 * Render the #tokens-daily fragment: one vertical stacked bar per active day in the range
 * (hover a segment for its tokens + cost, exactly like the summary bar), each labelled with
 * the day's total tokens (hover for the day's cost). Colors match the legend above, so no
 * separate legend is needed.
 *
 * Heights are relative to the busiest day currently shown, so every range is drawn on its own
 * terms and a quiet week still fills the box instead of arriving as a row of slivers. The price
 * is that a height means nothing from one range to the next; the label under each bar is what
 * carries the actual size.
 *
 * Fixed-width bars spread across the full width (flush to both edges, even space between; a lone
 * bar is centered) and grow past it once a range holds more days than fit, which is what makes
 * the row scroll - and what lets the reversed scroller around it open on the newest day.
 */
export function renderTokensDaily(days: DayTokens[]): string {
  if (days.length === 0) {
    return `<p class="text-sm text-neutral-500">No daily token usage for this range yet.</p>`;
  }
  const maxTotal = Math.max(...days.map((d) => sum(d.tokens)));
  const columns = days
    .map((d) => {
      const dayTokens = sum(d.tokens);
      const fillPct = maxTotal > 0 ? (dayTokens / maxTotal) * 100 : 0;
      const segments = CATEGORIES.filter((cat) => d.tokens[cat.key] > 0)
        .map((cat) => {
          const tokens = d.tokens[cat.key];
          const title = segmentTitle(
            cat.label,
            tokens,
            percent(tokens, dayTokens),
            d.cost[cat.key],
          );
          return `<div class="w-full min-h-[2px] ${cat.color}" style="flex-grow:${tokens}" title="${escapeHtml(title)}"></div>`;
        })
        .join("");
      return `<div class="flex w-16 shrink-0 flex-col items-center gap-1">
      <div class="flex h-32 w-full items-end">
        <div class="flex w-full flex-col-reverse overflow-hidden rounded-sm" style="height:${fillPct.toFixed(1)}%">${segments}</div>
      </div>
      <span class="tabular-nums text-[10px] text-neutral-300" title="${escapeHtml(formatUsd(sum(d.cost)))}">${humanTokens(dayTokens)}</span>
      <span class="tabular-nums text-[10px] text-neutral-600">${dayLabel(d.day)}</span>
    </div>`;
    })
    .join("");
  const justify = days.length === 1 ? "justify-center" : "justify-between";
  return `<div class="flex w-max min-w-full shrink-0 ${justify} gap-2 pb-1">${columns}</div>`;
}
