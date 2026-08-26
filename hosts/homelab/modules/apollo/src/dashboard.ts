import type { ContextUsage } from "@earendil-works/pi-coding-agent";
import QRCode from "qrcode";

import type { CredentialStatus } from "./credentials";
import { barColor, escapeHtml, humanTokens, truncate } from "./format";
import type { LogRecord } from "./logs";
import { RANGE_LABELS } from "./tokens";
import { renderUsage, type CreditUsage } from "./usage";
import type { WhatsAppState } from "./whatsapp";

const SURFACE = "rounded-2xl border border-white/10 bg-neutral-900/60 shadow-xl";
const HEADING = "text-[0.72rem] font-semibold uppercase tracking-[0.09em] text-neutral-400";
const GHOST_BUTTON =
  "rounded-lg border border-white/10 px-3 py-1.5 text-xs font-medium text-neutral-300 transition hover:bg-white/5 disabled:opacity-50";
const PRIMARY_BUTTON =
  "inline-block rounded-xl bg-indigo-500 px-5 py-2 text-sm font-medium text-white transition hover:bg-indigo-400";

/** How close to the oldest row the reader gets before the next page of history is fetched. */
const HISTORY_TRIGGER_PX = 300;

function headingRow(title: string, right = ""): string {
  return `<div class="mt-8 mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
    <h3 class="${HEADING}">${title}</h3>${right}
  </div>`;
}

function statusRow(dotClass: string, label: string): string {
  return `<div class="flex items-center gap-2">
    <span class="h-2 w-2 rounded-full ${dotClass}"></span>
    <span class="text-sm font-medium text-neutral-200">${label}</span>
  </div>`;
}

function filterChip(name: string, value: string, label: string, checked = false): string {
  return `<label class="cursor-pointer rounded-full px-3 py-1 text-neutral-500 transition hover:text-neutral-300 has-[:checked]:bg-indigo-500/20 has-[:checked]:text-indigo-200">
    <input type="radio" name="${name}" value="${value}"${checked ? " checked" : ""} class="sr-only" />${label}
  </label>`;
}

/**
 * Full page shell: sticky glass header, the WhatsApp and model status sections
 * (#summary, side by side on desktop), the conversation with its context footer, and
 * the logs - one flowing column that scrolls as a page. Each region polls its fragment
 * endpoint and swaps its own contents.
 *
 * The conversation splits those two jobs across two elements. #chat is only the scroll
 * viewport: reversing it puts the scroll origin at the newest end, so the view is
 * bottom-anchored and stays put both when a message arrives and when older ones load, with
 * no scroll bookkeeping. Its single child #chat-log holds the transcript in reading order,
 * so selection, copy and screen readers follow the conversation as it appears.
 *
 * #chat-log carries one region per end of the transcript, because the two ends move independently.
 * #chat-tail is the live end: the newest entries, re-rendered whenever anything changes. #chat-history
 * is everything before it, prepended a page at a time and then never touched again - an insertion
 * above the viewport, which is precisely the case bottom-anchoring keeps still for free. That is why
 * nothing here saves or restores a scroll position: the rows the reader is looking at are never
 * rebuilt, so there is no position to lose.
 *
 * #tokens-daily is the same arrangement turned on its side: the scroller is reversed so a range
 * too wide to fit opens on the most recent day, while its single child keeps the days in
 * chronological order, oldest to newest, left to right.
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
  <body class="mx-auto min-h-dvh w-full max-w-[1440px] bg-neutral-950 px-4 pb-16 text-neutral-100 antialiased sm:px-6">
    <header class="sticky top-0 z-20 -mx-4 flex items-center gap-2.5 border-b border-white/5 bg-neutral-950/80 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
      <img src="/favicon.svg?v=${version}" alt="" class="h-6 w-6 shrink-0" />
      <span class="text-[1.05rem] font-semibold tracking-tight">Apollo</span>
    </header>
    <main>
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
      <div class="${SURFACE} flex flex-col overflow-hidden">
        <div id="chat" class="flex h-[70dvh] flex-col-reverse [&>*]:shrink-0 overflow-y-auto overscroll-contain p-4 sm:p-5 lg:h-[75dvh]">
          <div id="chat-log" class="flex min-h-full flex-col justify-end gap-3 [&>*]:shrink-0">
            <div id="chat-history" class="flex flex-col gap-3 [&>*]:shrink-0 empty:hidden"
              hx-get="/chat/older" hx-vals="js:{before: chatOldest()}" hx-trigger="chatOlder" hx-swap="afterbegin"></div>
            <div id="chat-tail" class="flex grow flex-col justify-end gap-3 [&>*]:shrink-0"
              hx-get="/chat" hx-vals="js:{above: chatDayAbove()}" hx-include="#chat-version"
              hx-trigger="load, every 2s" hx-swap="innerHTML">
              <p class="m-auto text-sm text-neutral-500">Loading…</p>
            </div>
          </div>
        </div>
        <footer class="flex items-center gap-3 border-t border-white/5 px-4 py-3 sm:px-5">
          <div id="context" class="min-w-0 flex-1" hx-get="/context" hx-trigger="load, every 5s" hx-swap="innerHTML">
            <p class="text-xs text-neutral-500">Loading…</p>
          </div>
          <div id="stop" hx-get="/stop-button" hx-trigger="load, every 2s" hx-swap="innerHTML"></div>
        </footer>
      </div>
      ${headingRow(
        "tokens",
        `<form id="tokens-range" class="ml-auto flex gap-0.5 rounded-full border border-white/10 bg-neutral-950/60 p-[3px] text-xs">
          ${RANGE_LABELS.map(([value, label]) => filterChip("range", value, label, value === "all")).join("\n          ")}
        </form>`,
      )}
      <div class="${SURFACE} space-y-4 p-5">
        <div id="tokens"
          hx-get="/tokens" hx-include="#tokens-range" hx-trigger="load, change from:#tokens-range, every 15s" hx-swap="innerHTML">
          <p class="text-sm text-neutral-500">Loading…</p>
        </div>
        <details class="group border-t border-white/10 pt-3">
          <summary class="flex cursor-pointer list-none items-center gap-2 text-xs font-medium text-neutral-400 transition hover:text-neutral-200">
            <span class="text-[10px] text-neutral-500 transition group-open:rotate-90">▶</span>
            Daily breakdown
          </summary>
          <div id="tokens-daily" class="mt-3 flex flex-row-reverse overflow-x-auto"
            hx-get="/tokens/daily" hx-include="#tokens-range" hx-trigger="load, change from:#tokens-range, every 15s" hx-swap="innerHTML">
            <p class="text-sm text-neutral-500">Loading…</p>
          </div>
        </details>
      </div>
      ${headingRow("skills")}
      <div id="skills" class="${SURFACE} p-5"
        hx-get="/skills" hx-trigger="load, every 30s" hx-swap="innerHTML">
        <p class="text-sm text-neutral-500">Loading…</p>
      </div>
      <div id="summary" hx-get="/summary" hx-trigger="load, every 2s" hx-swap="innerHTML">
        <div class="${SURFACE} mt-8 px-5 py-4 text-sm text-neutral-500">Loading…</div>
      </div>
      ${headingRow(
        "logs",
        `<form id="logs-filter" class="ml-auto flex gap-0.5 rounded-full border border-white/10 bg-neutral-950/60 p-[3px] text-xs">
          ${filterChip("level", "all", "All", true)}
          ${filterChip("level", "info", "Info+")}
          ${filterChip("level", "warn", "Warn+")}
          ${filterChip("level", "error", "Error")}
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
    <script>
      (function () {
        function chatRows() {
          var log = document.getElementById("chat-log");
          return log ? log.querySelectorAll("[data-copy]") : [];
        }
        function transcript(rows) {
          return Array.prototype.slice
            .call(rows)
            .map(function (row) {
              return row.getAttribute("data-copy");
            })
            .join("\\n");
        }
        function selectedRows() {
          var sel = window.getSelection();
          if (!sel || sel.isCollapsed) return [];
          var hit = [];
          var rows = chatRows();
          for (var i = 0; i < rows.length; i++) {
            if (sel.containsNode(rows[i], true)) hit.push(rows[i]);
          }
          return hit;
        }
        // Two or more messages selected -> clean transcript; a single one -> native (partial) copy.
        document.addEventListener("copy", function (e) {
          var rows = selectedRows();
          if (rows.length < 2) return;
          e.clipboardData.setData("text/plain", transcript(rows));
          e.preventDefault();
        });
        // Keep the 2s poll from wiping an in-progress selection. The dropped render is not lost:
        // the version input still on the page tells the next poll to send it again. A page of history
        // is never dropped this way - it is inserted above, where it cannot disturb a selection.
        document.body.addEventListener("htmx:beforeSwap", function (e) {
          if (e.target && e.target.id === "chat-tail" && selectedRows().length > 0) {
            e.detail.shouldSwap = false;
          }
        });
      })();
      // What the two chat requests need to know, read off the DOM at request time rather than tracked:
      // the oldest row on the page names where history continues, and the last day already drawn in
      // history tells the tail which divider it must not draw again.
      function chatOldest() {
        var row = document.querySelector("#chat-log [data-entry]");
        return row ? row.dataset.entry : "";
      }
      function chatDayAbove() {
        var days = document.querySelectorAll("#chat-history [data-day]");
        var last = days[days.length - 1];
        return last ? last.dataset.day : "";
      }
      // Infinite scroll upward: ask for the page before the oldest row whenever the reader gets near
      // it. The response is inserted above them, so there is no scroll position to preserve and
      // nothing they are reading gets rebuilt - a fling can never be clamped mid-gesture.
      //
      // Reaching the beginning of the conversation needs no flag from the server: a page that adds
      // nothing leaves the oldest row where it was, and that is the signal to stop asking.
      (function () {
        var chat = document.getElementById("chat");
        var history = document.getElementById("chat-history");
        var tail = document.getElementById("chat-tail");
        if (!chat || !history || !tail) return;
        var asking = "";
        var atOldest = false;
        // #chat is reversed, so |scrollTop| is the distance from the newest end in every browser,
        // and (scrollable span - that) is the distance left to the oldest end.
        function nearOldest() {
          return chat.scrollHeight - chat.clientHeight - Math.abs(chat.scrollTop) <= ${HISTORY_TRIGGER_PX};
        }
        function ask() {
          if (asking || atOldest || !nearOldest()) return;
          var before = chatOldest();
          if (!before) return;
          asking = before;
          htmx.trigger(history, "chatOlder");
        }
        chat.addEventListener("scroll", ask, { passive: true });
        // A tail that does not fill the viewport leaves the reader already at the oldest row, with no
        // scrolling to be done and so no scroll event to act on.
        tail.addEventListener("htmx:afterSwap", ask);
        history.addEventListener("htmx:afterRequest", function () {
          if (chatOldest() === asking) atOldest = true;
          asking = "";
          ask(); // still near the oldest row after a short page: keep going
        });
      })();
    </script>
  </body>
</html>`;
}

export interface SummaryArgs {
  /** When the credential was retired (ISO), shown with the `invalid` status. */
  invalidAt?: string;
  status: CredentialStatus;
  authUrl: string;
  connectError?: string;
  linking: boolean;
  usage: CreditUsage | null;
  whatsapp: WhatsAppState;
}

function linked(user: string | undefined): string {
  return `<div class="space-y-4">
    ${statusRow("bg-emerald-400", "Linked")}
    <div class="rounded-xl border border-white/10 bg-neutral-950/60 px-4 py-3">
      <p class="text-[11px] uppercase tracking-wide text-neutral-500">Connected as</p>
      <p class="mt-1 text-sm font-medium text-neutral-100">${user ? `+${user}` : "WhatsApp"}</p>
    </div>
    <p class="text-xs leading-relaxed text-neutral-400">Apollo is online and listening on WhatsApp.</p>
  </div>`;
}

function linkIdle(status: WhatsAppState["status"]): string {
  const label =
    status === "connecting" ? "Connecting…" : status === "loggedOut" ? "Logged out" : "Not linked";
  const dot = status === "connecting" ? "animate-pulse bg-amber-400" : "bg-neutral-600";
  return `<div class="space-y-4">
    ${statusRow(dot, label)}
    <p class="text-xs leading-relaxed text-neutral-400">Link your WhatsApp account to start chatting with Apollo.</p>
    <button hx-post="/link" hx-target="#summary" hx-swap="innerHTML" class="${PRIMARY_BUTTON}">Link device</button>
  </div>`;
}

async function linkScanning(state: WhatsAppState): Promise<string> {
  const code = state.qr
    ? `<div class="mx-auto w-fit rounded-xl bg-white p-3">${await QRCode.toString(state.qr, {
        margin: 1,
        type: "svg",
        width: 208,
      })}</div>`
    : `<div class="mx-auto grid h-52 w-52 place-items-center rounded-xl border border-dashed border-neutral-700 text-sm text-neutral-500">Generating QR…</div>`;
  return `<div class="space-y-4">
    ${statusRow("animate-pulse bg-amber-400", "Waiting for scan…")}
    ${code}
    <p class="text-center text-xs text-neutral-400">WhatsApp → Linked devices → Link a device</p>
    <button hx-post="/link" hx-target="#summary" hx-swap="innerHTML"
      class="w-full rounded-xl border border-white/10 py-2 text-xs font-medium text-neutral-300 transition hover:bg-white/5">
      Refresh QR
    </button>
  </div>`;
}

/** `DD.MM HH:MM` for an ISO timestamp, or "" when it isn't one. */
function shortStamp(iso: string | undefined): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return `${two(at.getDate())}.${two(at.getMonth() + 1)} ${two(at.getHours())}:${two(at.getMinutes())}`;
}

/** The authorize link and paste-code form: the one way back, whichever way the sign-in is absent. */
function connect(args: SummaryArgs): string {
  return `<a href="${args.authUrl}" target="_blank" rel="noreferrer" class="${PRIMARY_BUTTON}">Sign in with OpenRouter</a>
    <form hx-post="/connect" hx-target="#summary" hx-swap="innerHTML" class="flex gap-2">
      <input name="code" placeholder="Paste code or redirect URL" autocomplete="off" spellcheck="false"
        class="min-w-0 flex-1 rounded-xl border border-white/10 bg-neutral-950/60 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-indigo-400 focus:outline-none" />
      <button class="${GHOST_BUTTON}">Connect</button>
    </form>
    ${args.connectError ? `<p class="text-xs text-red-400">${args.connectError}</p>` : ""}`;
}

function modelBody(args: SummaryArgs): string {
  if (args.status === "connected") {
    return `<div class="space-y-4">
      ${statusRow("bg-emerald-400", "Connected to OpenRouter")}
      ${args.usage ? renderUsage(args.usage) : `<p class="text-xs text-neutral-500">Usage data unavailable right now.</p>`}
    </div>`;
  }
  // An invalid credential reads as broken rather than as never set up: it stopped Apollo answering
  // at a knowable moment, and what is waiting on the other side of renewing it is a whole conversation.
  if (args.status === "invalid") {
    const at = shortStamp(args.invalidAt);
    return `<div class="space-y-4">
      ${statusRow("bg-red-500", `Credentials invalid${at ? ` · ${at}` : ""}`)}
      <p class="text-xs leading-relaxed text-neutral-400">Apollo can't reach the model until you sign in again, and is holding every message you send until then. Your conversation is untouched.</p>
      ${connect(args)}
    </div>`;
  }
  return `<div class="space-y-4">
    ${statusRow("bg-neutral-600", "Not connected to OpenRouter")}
    <p class="text-xs leading-relaxed text-neutral-400">Sign in with your OpenRouter account. You'll be redirected to a localhost page that won't load - that's expected: copy that URL (or the code in it) and paste it below.</p>
    ${connect(args)}
  </div>`;
}

/**
 * Render the #summary fragment: the WhatsApp section (link state, or the link/QR flow)
 * and the model section (credit usage, or the authorize + paste-code flow), side by side
 * on desktop and stacked on mobile.
 */
export async function renderSummary(args: SummaryArgs): Promise<string> {
  const whatsappBody =
    args.whatsapp.status === "connected"
      ? linked(args.whatsapp.user)
      : args.linking
        ? await linkScanning(args.whatsapp)
        : linkIdle(args.whatsapp.status);
  return `<div class="grid items-start gap-x-6 md:grid-cols-2">
    <section>
      ${headingRow("whatsapp")}
      <div class="${SURFACE} p-5">${whatsappBody}</div>
    </section>
    <section>
      ${headingRow("model")}
      <div class="${SURFACE} p-5">${modelBody(args)}</div>
    </section>
  </div>`;
}

/** Render the #context fragment: how much of the model's context window the session is using. */
export function renderContext(usage: ContextUsage | undefined): string {
  if (!usage || usage.contextWindow <= 0) {
    return `<p class="text-xs text-neutral-500">Context usage unavailable.</p>`;
  }
  const window = humanTokens(usage.contextWindow);
  if (usage.tokens == null || usage.percent == null) {
    return `<div class="flex justify-between text-xs text-neutral-400">
      <span>Context</span><span>… / ${window}</span>
    </div>`;
  }
  const pct = Math.min(100, Math.max(0, usage.percent));
  const color = barColor(pct);
  return `<div>
    <div class="mb-1.5 flex justify-between text-xs">
      <span class="text-neutral-400">Context</span><span class="text-neutral-500">${pct.toFixed(1)}% / ${window}</span>
    </div>
    <div class="h-1.5 overflow-hidden rounded-full bg-white/5">
      <div class="h-full rounded-full ${color}" style="width:${pct}%"></div>
    </div>
  </div>`;
}

/** Render the #stop fragment: a square stop button, pressable only while a run is active. */
export function renderStop(running: boolean): string {
  const disabledAttr = running ? "" : " disabled";
  const tone = running
    ? "border-red-500/40 text-red-400 hover:bg-red-500/10"
    : "border-white/10 text-neutral-600";
  return `<button${disabledAttr} hx-post="/stop" hx-target="#stop" hx-swap="innerHTML" hx-disabled-elt="this" title="Stop the current run" aria-label="Stop the current run" class="grid h-8 w-8 shrink-0 place-items-center rounded-lg border transition ${tone} disabled:cursor-not-allowed disabled:opacity-50"><svg viewBox="0 0 16 16" class="h-3.5 w-3.5" fill="currentColor" aria-hidden="true"><rect x="3" y="3" width="10" height="10" rx="1.5" /></svg></button>`;
}

export interface SkillInfo {
  description: string;
  disabled: boolean;
  name: string;
}

/** Render the #skills fragment: one card per loaded skill (name + description); the caller sorts them. */
export function renderSkills(skills: SkillInfo[]): string {
  if (skills.length === 0) {
    return `<p class="text-sm text-neutral-500">No skills loaded.</p>`;
  }
  const cards = skills
    .map((skill) => {
      const manual = skill.disabled
        ? `<span class="shrink-0 rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-neutral-400">manual</span>`
        : "";
      return `<div class="rounded-xl border border-white/10 bg-neutral-950/40 px-4 py-3">
      <div class="flex items-center gap-2">
        <span class="font-mono text-sm font-medium text-neutral-100">${escapeHtml(skill.name)}</span>${manual}
      </div>
      <p class="mt-1 text-xs leading-relaxed text-neutral-400">${escapeHtml(skill.description)}</p>
    </div>`;
    })
    .join("");
  return `<div class="grid gap-3 sm:grid-cols-2">${cards}</div>`;
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

function two(n: number): string {
  return String(n).padStart(2, "0");
}

/** Local `DD.MM HH:MM:SS` stamp for a log record's epoch-ms time; empty when unparseable. */
function logTime(time: unknown): string {
  const ms = typeof time === "number" ? time : Number(time);
  if (!Number.isFinite(ms)) return "";
  const at = new Date(ms);
  return `${two(at.getDate())}.${two(at.getMonth() + 1)} ${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}`;
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
