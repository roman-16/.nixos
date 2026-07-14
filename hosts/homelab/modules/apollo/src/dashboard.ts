import type { ContextUsage } from "@earendil-works/pi-coding-agent";
import QRCode from "qrcode";

import { escapeHtml, humanTokens, truncate } from "./format";
import type { LogRecord } from "./logs";
import { extraUsageValue, resetLabel, type UsageData } from "./usage";
import type { WhatsAppState } from "./whatsapp";

const SURFACE = "rounded-2xl border border-white/10 bg-neutral-900/60 shadow-xl";
const HEADING = "text-[0.72rem] font-semibold uppercase tracking-[0.09em] text-neutral-400";
const GHOST_BUTTON =
  "rounded-lg border border-white/10 px-3 py-1.5 text-xs font-medium text-neutral-300 transition hover:bg-white/5 disabled:opacity-50";
const PRIMARY_BUTTON =
  "inline-block rounded-xl bg-indigo-500 px-5 py-2 text-sm font-medium text-white transition hover:bg-indigo-400";

function headingRow(title: string, right = ""): string {
  return `<div class="mt-8 mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
    <h3 class="${HEADING}">${title}</h3>${right}
  </div>`;
}

function filterChip(value: string, label: string, checked = false): string {
  return `<label class="cursor-pointer rounded-full px-3 py-1 text-neutral-500 transition hover:text-neutral-300 has-[:checked]:bg-indigo-500/20 has-[:checked]:text-indigo-200">
    <input type="radio" name="level" value="${value}"${checked ? " checked" : ""} class="sr-only" />${label}
  </label>`;
}

/**
 * Full page shell: sticky glass header, the stat bar (#summary, which also carries the
 * WhatsApp/Claude setup flows while they need attention), the conversation, and the
 * logs - one flowing column that scrolls as a page. Each region polls its fragment
 * endpoint and swaps its own contents.
 */
export function renderPage(version: string): string {
  return `<!doctype html>
<html lang="en" class="scroll-smooth">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="theme-color" content="#0a0a0a" />
    <title>Apollo</title>
    <link rel="icon" type="image/svg+xml" href="/favicon.svg?v=${version}" />
    <link rel="stylesheet" href="/app.css?v=${version}" />
    <script src="/htmx.min.js?v=${version}"></script>
  </head>
  <body class="mx-auto min-h-dvh w-full max-w-5xl bg-neutral-950 px-4 pb-16 text-neutral-100 antialiased sm:px-6">
    <header class="sticky top-0 z-20 -mx-4 flex items-center gap-2.5 border-b border-white/5 bg-neutral-950/80 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
      <img src="/favicon.svg?v=${version}" alt="" class="h-6 w-6 shrink-0" />
      <span class="text-[1.05rem] font-semibold tracking-tight">Apollo</span>
    </header>
    <main>
      <div id="summary" class="mt-5" hx-get="/summary" hx-trigger="load, every 2s" hx-swap="innerHTML">
        <div class="${SURFACE} px-5 py-4 text-sm text-neutral-500">Loading…</div>
      </div>
      ${headingRow(
        "conversation",
        `<span id="session-status" class="text-xs"></span>
        <div class="ml-auto flex items-center gap-2">
          <button hx-post="/compact" hx-target="#session-status" hx-swap="innerHTML" hx-disabled-elt="this"
            class="${GHOST_BUTTON}">Compact</button>
          <button hx-post="/reload" hx-target="#session-status" hx-swap="innerHTML" hx-disabled-elt="this"
            class="${GHOST_BUTTON}">Reload</button>
        </div>`,
      )}
      <div id="chat" class="${SURFACE} h-[70dvh] space-y-3 overflow-y-auto overscroll-contain p-4 sm:p-5 lg:h-[75dvh]"
        hx-get="/chat" hx-trigger="load, every 2s" hx-swap="innerHTML"
        hx-on::before-swap="this.dataset.stick = this.scrollHeight - this.scrollTop - this.clientHeight < 160 ? '1' : ''"
        hx-on::after-settle="if (this.dataset.stick) this.scrollTop = this.scrollHeight">
        <p class="text-sm text-neutral-500">Loading…</p>
      </div>
      ${headingRow(
        "logs",
        `<form id="logs-filter" class="ml-auto flex gap-0.5 rounded-full border border-white/10 bg-neutral-950/60 p-[3px] text-xs">
          ${filterChip("all", "All", true)}
          ${filterChip("info", "Info+")}
          ${filterChip("warn", "Warn+")}
          ${filterChip("error", "Error")}
        </form>`,
      )}
      <div id="log-list" class="${SURFACE} max-h-[32rem] overflow-y-auto overscroll-contain"
        hx-get="/logs" hx-include="#logs-filter" hx-trigger="load, every 2s, change from:#logs-filter" hx-swap="innerHTML">
        <p class="px-4 py-6 text-center text-sm text-neutral-600">Loading…</p>
      </div>
    </main>
    <dialog id="lightbox" class="m-auto bg-transparent p-0 backdrop:bg-black/80" onclick="this.close()">
      <img src="" alt="" class="max-h-[92dvh] max-w-[92vw] rounded-xl" />
    </dialog>
  </body>
</html>`;
}

export interface SummaryArgs {
  anthropicConnected: boolean;
  authUrl: string;
  connectError?: string;
  contextUsage: ContextUsage | undefined;
  linking: boolean;
  usage: UsageData | null;
  whatsapp: WhatsAppState;
}

function cell(key: string, value: string, tooltip: string): string {
  return `<div class="cursor-help" title="${escapeHtml(tooltip)}">
    <div class="text-[0.7rem] font-medium uppercase tracking-[0.05em] text-neutral-500 underline decoration-dotted decoration-neutral-700 underline-offset-[3px]">${key}</div>
    <div class="mt-0.5 truncate text-lg font-semibold tracking-tight tabular-nums">${value}</div>
  </div>`;
}

function pctValue(utilization: number, decimals = 0): string {
  const pct = Math.min(100, Math.max(0, utilization));
  const color = pct >= 90 ? "text-red-400" : pct >= 70 ? "text-amber-400" : "";
  return `<span class="${color}">${pct.toFixed(decimals)}%</span>`;
}

function suffix(label: string): string {
  return label ? ` · ${label}` : "";
}

function whatsappValue(state: WhatsAppState, linking: boolean): string {
  if (state.status === "connected") return `<span class="text-emerald-400">linked</span>`;
  if (linking) return `<span class="text-amber-400">scan QR</span>`;
  if (state.status === "connecting") return `<span class="text-neutral-400">connecting…</span>`;
  if (state.status === "loggedOut") return `<span class="text-red-400">logged out</span>`;
  return `<span class="text-amber-400">not linked</span>`;
}

function bar(args: SummaryArgs): string {
  const cells = [
    cell("whatsapp", whatsappValue(args.whatsapp, args.linking), "WhatsApp link state"),
  ];
  if (args.whatsapp.status === "connected" && args.whatsapp.user) {
    cells.push(cell("number", `+${args.whatsapp.user}`, "The linked WhatsApp account"));
  }
  cells.push(
    cell(
      "claude",
      args.anthropicConnected
        ? `<span class="text-emerald-400">connected</span>`
        : `<span class="text-amber-400">not connected</span>`,
      "Anthropic account credential",
    ),
  );
  const usage = args.usage;
  if (args.anthropicConnected && usage) {
    if (usage.five_hour) {
      cells.push(
        cell(
          "session (5h)",
          pctValue(usage.five_hour.utilization),
          `5-hour session limit${suffix(resetLabel(usage.five_hour.resets_at))}`,
        ),
      );
    }
    if (usage.seven_day) {
      cells.push(
        cell(
          "weekly",
          pctValue(usage.seven_day.utilization),
          `Weekly limit, all models${suffix(resetLabel(usage.seven_day.resets_at))}`,
        ),
      );
    }
    if (usage.seven_day_sonnet) {
      cells.push(
        cell(
          "sonnet",
          pctValue(usage.seven_day_sonnet.utilization),
          `Weekly limit, Sonnet${suffix(resetLabel(usage.seven_day_sonnet.resets_at))}`,
        ),
      );
    }
    if (usage.extra_usage) {
      cells.push(
        cell("extra", extraUsageValue(usage.extra_usage), "Extra usage beyond the plan limits"),
      );
    }
  }
  const ctx = args.contextUsage;
  if (ctx && ctx.contextWindow > 0) {
    const value = ctx.percent == null ? "…" : pctValue(ctx.percent, 1);
    const tokens =
      ctx.tokens == null
        ? `context window ${humanTokens(ctx.contextWindow)} tokens`
        : `${humanTokens(ctx.tokens)} of ${humanTokens(ctx.contextWindow)} tokens`;
    cells.push(cell("context", value, `Session context: ${tokens}`));
  }
  return `<div class="${SURFACE} grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-x-6 gap-y-3 px-5 py-4">${cells.join("")}</div>`;
}

function linkIdle(): string {
  return `<p class="text-sm text-neutral-400">Link your WhatsApp account to start chatting with Apollo.</p>
    <button hx-post="/link" hx-target="#summary" hx-swap="innerHTML" class="${PRIMARY_BUTTON}">Link device</button>`;
}

async function linkScanning(state: WhatsAppState): Promise<string> {
  const code = state.qr
    ? `<div class="w-fit rounded-xl bg-white p-3">${await QRCode.toString(state.qr, {
        margin: 1,
        type: "svg",
        width: 208,
      })}</div>`
    : `<div class="grid h-56 w-56 place-items-center rounded-xl border border-dashed border-neutral-700 text-sm text-neutral-500">Generating QR…</div>`;
  return `<p class="text-sm text-neutral-400">WhatsApp → Linked devices → Link a device, then scan:</p>
    ${code}
    <button hx-post="/link" hx-target="#summary" hx-swap="innerHTML" class="${GHOST_BUTTON}">Refresh QR</button>`;
}

async function whatsappSetup(state: WhatsAppState, linking: boolean): Promise<string> {
  return `${headingRow("whatsapp")}
  <div class="${SURFACE} space-y-4 p-5">${linking ? await linkScanning(state) : linkIdle()}</div>`;
}

function claudeSetup(authUrl: string, error?: string): string {
  return `${headingRow("claude")}
  <div class="${SURFACE} space-y-4 p-5">
    <p class="text-sm text-neutral-400">Authorize with your Claude account. You'll be redirected to a localhost page that won't load - that's expected: copy that URL (or the code in it) and paste it below.</p>
    <a href="${authUrl}" target="_blank" rel="noreferrer" class="${PRIMARY_BUTTON}">Authorize with Anthropic</a>
    <form hx-post="/connect" hx-target="#summary" hx-swap="innerHTML" class="flex max-w-xl gap-2">
      <input name="code" placeholder="Paste code or redirect URL" autocomplete="off" spellcheck="false"
        class="min-w-0 flex-1 rounded-xl border border-white/10 bg-neutral-950/60 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-indigo-400 focus:outline-none" />
      <button class="${GHOST_BUTTON}">Connect</button>
    </form>
    ${error ? `<p class="text-xs text-red-400">${error}</p>` : ""}
  </div>`;
}

/**
 * Render the #summary fragment: the stat bar (link state, Claude usage, session
 * context), followed by the WhatsApp link flow and/or the Claude connect flow as
 * their own sections whenever they still need attention.
 */
export async function renderSummary(args: SummaryArgs): Promise<string> {
  const parts = [bar(args)];
  if (args.whatsapp.status !== "connected") {
    parts.push(await whatsappSetup(args.whatsapp, args.linking));
  }
  if (!args.anthropicConnected) parts.push(claudeSetup(args.authUrl, args.connectError));
  return parts.join("");
}

/** Inline #session-status fragment shown after a dashboard Compact/Reload button is pressed. */
export function sessionStatus(action: "compact" | "reload", kind: "busy" | "error" | "ok"): string {
  const done = action === "compact" ? "Compacted ✓" : "Reloaded ✓";
  const failed = action === "compact" ? "Compact failed" : "Reload failed";
  const { color, label } =
    kind === "ok"
      ? { color: "text-emerald-400", label: done }
      : kind === "busy"
        ? { color: "text-amber-400", label: "Busy, try again" }
        : { color: "text-red-400", label: failed };
  return `<span class="${color}">${label}</span>`;
}

const LOG_META_KEYS = new Set(["hostname", "level", "msg", "pid", "time", "v"]);

function logLevel(level: number): { color: string; text: string } {
  if (level >= 60) return { color: "text-red-500", text: "FATAL" };
  if (level >= 50) return { color: "text-red-400", text: "ERROR" };
  if (level >= 40) return { color: "text-amber-400", text: "WARN" };
  if (level >= 30) return { color: "text-emerald-400", text: "INFO" };
  if (level >= 20) return { color: "text-neutral-400", text: "DEBUG" };
  return { color: "text-neutral-500", text: "TRACE" };
}

function logTime(time: unknown): string {
  const ms = typeof time === "number" ? time : Number(time);
  return Number.isFinite(ms) ? new Date(ms).toLocaleTimeString("en-GB", { hour12: false }) : "";
}

function logExtras(record: LogRecord): string {
  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!LOG_META_KEYS.has(key)) extras[key] = value;
  }
  if (Object.keys(extras).length === 0) return "";
  let json: string;
  try {
    json = JSON.stringify(extras, null, 2);
  } catch {
    return "";
  }
  return `<pre class="mt-0.5 overflow-x-auto whitespace-pre-wrap break-words text-[11px] text-neutral-500">${escapeHtml(
    truncate(json, 4000),
  )}</pre>`;
}

/** Render the #log-list fragment: one row per record, already filtered and newest first. */
export function renderLogs(records: LogRecord[]): string {
  if (records.length === 0) {
    return `<p class="px-4 py-6 text-center text-sm text-neutral-600">No logs.</p>`;
  }
  return records
    .map((record) => {
      const { color, text } = logLevel(typeof record.level === "number" ? record.level : 30);
      const msg = typeof record.msg === "string" ? record.msg : "";
      return `<div class="border-b border-white/5 px-4 py-1.5 font-mono text-xs leading-relaxed transition last:border-b-0 hover:bg-white/5 sm:px-5">
      <div class="flex gap-2">
        <span class="shrink-0 text-neutral-600">${logTime(record.time)}</span>
        <span class="w-12 shrink-0 font-bold ${color}">${text}</span>
        <span class="min-w-0 break-words text-neutral-300">${escapeHtml(msg)}</span>
      </div>
      ${logExtras(record)}
    </div>`;
    })
    .join("");
}
