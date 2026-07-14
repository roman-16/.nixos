import type { ContextUsage } from "@earendil-works/pi-coding-agent";
import QRCode from "qrcode";

import { humanTokens } from "./format";
import { renderUsage, type UsageData } from "./usage";
import type { WhatsAppState } from "./whatsapp";

/** Full page shell. The #app region polls /status and swaps its own contents. */
export function renderPage(version: string): string {
  return `<!doctype html>
<html lang="en" class="h-full">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Apollo</title>
    <link rel="icon" type="image/svg+xml" href="/favicon.svg?v=${version}" />
    <link rel="stylesheet" href="/app.css?v=${version}" />
    <script src="/htmx.min.js?v=${version}"></script>
  </head>
  <body class="h-full bg-neutral-950 text-neutral-100 antialiased">
    <main class="mx-auto flex h-full w-full max-w-6xl flex-col gap-6 p-6 lg:flex-row">
      <aside class="w-full shrink-0 rounded-2xl border border-neutral-800 bg-neutral-900 p-8 shadow-2xl lg:w-96">
        <div class="mb-6 flex items-center gap-3">
          <div class="grid h-9 w-9 place-items-center rounded-xl bg-indigo-500/20 font-bold text-indigo-300">A</div>
          <div>
            <h1 class="text-lg font-semibold leading-none">Apollo</h1>
            <p class="mt-1 text-xs text-neutral-400">WhatsApp assistant</p>
          </div>
        </div>
        <div id="app" hx-get="/status" hx-trigger="load, every 2s" hx-swap="innerHTML">
          ${statusRow("bg-neutral-500", "Loading…")}
        </div>
        <div class="mt-6 border-t border-neutral-800 pt-5">
          <div id="anthropic" hx-get="/anthropic" hx-trigger="load, every 300s" hx-swap="innerHTML">
            <p class="text-xs text-neutral-500">Loading…</p>
          </div>
        </div>
      </aside>
      <section class="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-900 shadow-2xl">
        <header class="flex items-center gap-3 border-b border-neutral-800 px-5 py-3">
          <span class="text-sm font-semibold text-neutral-200">Chat log</span>
          <span id="session-status" class="text-xs"></span>
          <div class="ml-auto flex items-center gap-2">
            <span class="text-xs text-neutral-500">Session:</span>
            <button hx-post="/compact" hx-target="#session-status" hx-swap="innerHTML" hx-disabled-elt="this"
              class="rounded-lg border border-neutral-700 px-3 py-1 text-xs text-neutral-300 transition hover:bg-neutral-800 disabled:opacity-50">
              Compact
            </button>
            <button hx-post="/reload" hx-target="#session-status" hx-swap="innerHTML" hx-disabled-elt="this"
              class="rounded-lg border border-neutral-700 px-3 py-1 text-xs text-neutral-300 transition hover:bg-neutral-800 disabled:opacity-50">
              Reload
            </button>
          </div>
        </header>
        <div id="chat" class="min-h-0 flex-1 space-y-3 overflow-y-auto p-4"
          hx-get="/chat" hx-trigger="load, every 2s" hx-swap="innerHTML"
          hx-on::after-settle="this.scrollTop = this.scrollHeight">
          <p class="text-xs text-neutral-500">Loading…</p>
        </div>
        <footer class="border-t border-neutral-800 px-4 py-2.5">
          <div id="context" hx-get="/context" hx-trigger="load, every 5s" hx-swap="innerHTML">
            <p class="text-xs text-neutral-500">Loading…</p>
          </div>
        </footer>
      </section>
    </main>
  </body>
</html>`;
}

function statusRow(dotClass: string, label: string): string {
  return `<div class="flex items-center gap-2">
    <span class="h-2.5 w-2.5 rounded-full ${dotClass}"></span>
    <span class="text-sm text-neutral-300">${label}</span>
  </div>`;
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

const LINK_BUTTON = `<button hx-post="/link" hx-target="#app" hx-swap="innerHTML"
  class="w-full rounded-xl bg-indigo-500 py-2.5 text-sm font-medium text-white transition hover:bg-indigo-400">
  Link device
</button>`;

function linked(user: string | undefined): string {
  return `<div class="space-y-5">
    ${statusRow("bg-emerald-400", "Linked")}
    <div class="rounded-xl border border-neutral-800 bg-neutral-950 p-4">
      <p class="text-xs text-neutral-500">Connected as</p>
      <p class="mt-0.5 text-sm font-medium text-neutral-100">${user ? `+${user}` : "WhatsApp"}</p>
    </div>
    <p class="text-sm text-neutral-400">Apollo is online and listening on WhatsApp.</p>
  </div>`;
}

function idle(status: WhatsAppState["status"]): string {
  const label =
    status === "connecting" ? "Connecting…" : status === "loggedOut" ? "Logged out" : "Not linked";
  const dot = status === "connecting" ? "bg-amber-400 animate-pulse" : "bg-neutral-500";
  return `<div class="space-y-5">
    ${statusRow(dot, label)}
    <p class="text-sm text-neutral-400">Link your WhatsApp account to start chatting with Apollo.</p>
    ${LINK_BUTTON}
  </div>`;
}

async function scanning(state: WhatsAppState): Promise<string> {
  const code = state.qr
    ? `<div class="grid place-items-center rounded-xl bg-white p-4">${await QRCode.toString(
        state.qr,
        {
          margin: 1,
          type: "svg",
          width: 240,
        },
      )}</div>`
    : `<div class="rounded-xl border border-dashed border-neutral-700 p-10 text-center text-sm text-neutral-500">Generating QR…</div>`;

  return `<div class="space-y-5">
    ${statusRow("bg-amber-400 animate-pulse", "Waiting for scan…")}
    ${code}
    <p class="text-center text-xs text-neutral-400">WhatsApp → Linked devices → Link a device</p>
    <button hx-post="/link" hx-target="#app" hx-swap="innerHTML"
      class="w-full rounded-xl border border-neutral-700 py-2 text-xs text-neutral-300 transition hover:bg-neutral-800">
      Refresh QR
    </button>
  </div>`;
}

/** Render the #app fragment for the current link state. */
export async function renderState(state: WhatsAppState, linking: boolean): Promise<string> {
  if (state.status === "connected") return linked(state.user);
  if (linking) return scanning(state);
  return idle(state.status);
}

/** Render the #anthropic fragment: connection status (a credential exists) plus best-effort usage bars, else a login form. */
export function renderAnthropic(
  connected: boolean,
  data: UsageData | null,
  authUrl: string,
  error?: string,
): string {
  if (connected) {
    return `<div class="space-y-3">
      ${statusRow("bg-emerald-400", "Connected to Anthropic")}
      ${data ? renderUsage(data) : `<p class="text-xs text-neutral-500">Usage data unavailable right now.</p>`}
    </div>`;
  }
  return `<div class="space-y-4">
    ${statusRow("bg-neutral-500", "Not connected to Anthropic")}
    <p class="text-sm text-neutral-400">Authorize with your Claude account. You'll be redirected to a localhost page that won't load - that's expected: copy that URL (or the code in it) and paste it below.</p>
    <a href="${authUrl}" target="_blank" rel="noreferrer"
      class="block w-full rounded-xl bg-indigo-500 py-2.5 text-center text-sm font-medium text-white transition hover:bg-indigo-400">
      Authorize with Anthropic
    </a>
    <form hx-post="/connect" hx-target="#anthropic" hx-swap="innerHTML" class="flex gap-2">
      <input name="code" placeholder="Paste code or redirect URL" autocomplete="off" spellcheck="false"
        class="min-w-0 flex-1 rounded-xl border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600" />
      <button class="rounded-xl border border-neutral-700 px-4 py-2 text-sm text-neutral-200 transition hover:bg-neutral-800">Connect</button>
    </form>
    ${error ? `<p class="text-xs text-red-400">${error}</p>` : ""}
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
  const color = pct >= 90 ? "bg-red-500" : pct >= 70 ? "bg-amber-500" : "bg-emerald-500";
  return `<div>
    <div class="mb-1 flex justify-between text-xs text-neutral-400">
      <span>Context</span><span>${pct.toFixed(1)}% / ${window}</span>
    </div>
    <div class="h-2 overflow-hidden rounded-full bg-neutral-800">
      <div class="h-full rounded-full ${color}" style="width:${pct}%"></div>
    </div>
  </div>`;
}
