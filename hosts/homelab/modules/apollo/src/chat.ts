/**
 * Renders the persistent pi session (its JSONL file) as a chat log for the
 * dashboard. The file is the source of truth: unlike the in-memory context it
 * survives compaction and restarts, so it holds everything ever said, including
 * tool use. Apollo never branches, so the tree is treated as a linear sequence.
 */

import { escapeHtml, humanTokens, truncate } from "./format";

const MAX_OUTPUT_CHARS = 10000;
const PREVIEW_CHARS = 100;

/** Argument keys, in priority order, worth showing in a tool's one-line summary. */
const PREVIEW_KEYS = ["command", "file_path", "path", "pattern", "query", "url"];

export interface ChatImage {
  data: string;
  mimeType: string;
}

export type LogItem =
  | { kind: "assistant"; text: string; time?: string }
  | {
      command: string;
      exitCode: number | undefined;
      kind: "bash";
      output: string;
      time?: string;
    }
  | { kind: "compaction"; summary: string; time?: string; tokensBefore: number | undefined }
  | { kind: "divider"; label: string; time?: string }
  | { kind: "thinking"; text: string; time?: string }
  | {
      args: Record<string, unknown>;
      hasResult: boolean;
      images: number;
      isError: boolean;
      kind: "tool";
      name: string;
      output: string;
      time?: string;
    }
  | { images: ChatImage[]; kind: "user"; text: string; time?: string };

interface ToolResult {
  images: number;
  isError: boolean;
  output: string;
}

/** Split a message `content` (string or block array) into plain text and images. */
function splitContent(content: unknown): { images: ChatImage[]; text: string } {
  if (typeof content === "string") return { images: [], text: content };
  if (!Array.isArray(content)) return { images: [], text: "" };

  const images: ChatImage[] = [];
  const texts: string[] = [];
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") texts.push(block.text);
    else if (block?.type === "image" && typeof block.data === "string") {
      images.push({ data: block.data, mimeType: block.mimeType ?? "image/jpeg" });
    }
  }
  return { images, text: texts.join("\n").trim() };
}

function toolResult(message: Record<string, any>): ToolResult {
  const { images, text } = splitContent(message.content);
  return { images: images.length, isError: Boolean(message.isError), output: text };
}

/** An entry's timestamp, kept only when it parses as a real date. */
function isoTime(value: unknown): string | undefined {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : undefined;
}

function assistantItems(
  message: Record<string, any>,
  results: Map<string, ToolResult>,
  time: string | undefined,
): LogItem[] {
  const items: LogItem[] = [];
  const content = Array.isArray(message.content) ? message.content : [];
  for (const block of content) {
    if (block?.type === "text" && block.text?.trim()) {
      items.push({ kind: "assistant", text: block.text, time });
    } else if (block?.type === "thinking" && block.thinking?.trim()) {
      items.push({ kind: "thinking", text: block.thinking, time });
    } else if (block?.type === "toolCall") {
      const result = results.get(block.id);
      items.push({
        args: block.arguments ?? {},
        hasResult: result != undefined,
        images: result?.images ?? 0,
        isError: result?.isError ?? false,
        kind: "tool",
        name: block.name ?? "tool",
        output: result?.output ?? "",
        time,
      });
    }
  }
  return items;
}

/** Parse a session JSONL transcript into an ordered list of displayable items. */
export function parseTranscript(jsonl: string): LogItem[] {
  const entries: Record<string, any>[] = [];
  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // Skip the header-less garbage or a half-written trailing line (concurrent append).
    }
  }

  // Tool results are matched back onto their calls, so they never render standalone.
  const results = new Map<string, ToolResult>();
  for (const entry of entries) {
    const message = entry.message;
    if (entry.type === "message" && message?.role === "toolResult" && message.toolCallId) {
      results.set(message.toolCallId, toolResult(message));
    }
  }

  const items: LogItem[] = [];
  for (const entry of entries) {
    const time = isoTime(entry.timestamp);
    if (entry.type === "compaction") {
      items.push({
        kind: "compaction",
        summary: typeof entry.summary === "string" ? entry.summary : "",
        time,
        tokensBefore: typeof entry.tokensBefore === "number" ? entry.tokensBefore : undefined,
      });
      continue;
    }
    if (entry.type === "branch_summary") {
      items.push({ kind: "divider", label: "Branch summary" });
      continue;
    }
    if (entry.type === "custom" && entry.customType === "apollo_reload") {
      items.push({ kind: "divider", label: "Reloaded" });
      continue;
    }
    if (entry.type !== "message") continue;

    const message = entry.message;
    if (!message || typeof message !== "object") continue;
    switch (message.role) {
      case "assistant":
        items.push(...assistantItems(message, results, time));
        break;
      case "bashExecution":
        items.push({
          command: message.command ?? "",
          exitCode: message.exitCode,
          kind: "bash",
          output: message.output ?? "",
          time,
        });
        break;
      case "user": {
        const { images, text } = splitContent(message.content);
        if (text || images.length > 0) items.push({ images, kind: "user", text, time });
        break;
      }
      default:
        break;
    }
  }
  return items;
}

function argPreview(args: Record<string, unknown>): string {
  for (const key of PREVIEW_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value) return value;
  }
  try {
    return JSON.stringify(args);
  } catch {
    return "";
  }
}

function two(n: number): string {
  return String(n).padStart(2, "0");
}

function clock(iso: string): string {
  const date = new Date(iso);
  return `${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** WhatsApp-style `[HH:MM, YYYY-MM-DD]` prefix for copied text; empty when the time is unknown. */
function copyStamp(time: string | undefined): string {
  if (!time) return "";
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) return "";
  return `[${two(date.getHours())}:${two(date.getMinutes())}, ${date.getFullYear()}-${two(
    date.getMonth() + 1,
  )}-${two(date.getDate())}]`;
}

function stamp(time: string | undefined): string {
  return time
    ? `<span class="mt-1 block select-none text-right text-[10px] leading-none opacity-50">${clock(time)}</span>`
    : "";
}

function dayLabel(date: Date, now: Date): string {
  if (date.toDateString() === now.toDateString()) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return `${two(date.getDate())}.${two(date.getMonth() + 1)}.${date.getFullYear()}`;
}

/** A `data-copy` attribute carrying an item's canonical plain text, or nothing. */
function copyAttr(text: string | undefined): string {
  return text == undefined ? "" : ` data-copy="${escapeHtml(text)}"`;
}

function chipDivider(label: string, dataCopy?: string): string {
  return `<div class="flex justify-center py-1"${copyAttr(dataCopy)}>
    <span class="rounded-full border border-white/10 bg-neutral-900/90 px-3 py-1 text-[11px] font-medium text-neutral-400">${escapeHtml(label)}</span>
  </div>`;
}

function bubble(
  side: "left" | "right",
  tone: string,
  body: string,
  time?: string,
  dataCopy?: string,
): string {
  const align = side === "right" ? "items-end" : "items-start";
  return `<div class="flex flex-col ${align}"${copyAttr(dataCopy)}>
    <div class="max-w-[85%] px-3.5 py-2 text-sm shadow-sm sm:max-w-[75%] ${tone}">${body}${stamp(time)}</div>
  </div>`;
}

function textBlock(text: string): string {
  return `<p class="whitespace-pre-wrap break-words">${escapeHtml(text)}</p>`;
}

function images(list: ChatImage[]): string {
  if (list.length === 0) return "";
  const tags = list
    .map(
      (image) =>
        `<img src="data:${escapeHtml(image.mimeType)};base64,${image.data}" alt="image"
          class="max-h-40 cursor-zoom-in rounded-xl"
          onclick="const box = document.getElementById('lightbox'); box.querySelector('img').src = this.src; box.showModal()" />`,
    )
    .join("");
  return `<div class="mt-1 flex flex-wrap gap-2">${tags}</div>`;
}

function toolBadge(item: Extract<LogItem, { kind: "tool" }>, running: boolean): string {
  if (item.hasResult) {
    return item.isError
      ? `<span class="text-red-400">error</span>`
      : `<span class="text-emerald-400">ok</span>`;
  }
  // A resultless call is genuinely running only when it's the live, most-recent one.
  // Otherwise the run it belonged to ended (e.g. the server restarted mid-execution)
  // and its result will never arrive, so it's shown as interrupted rather than stuck.
  return running
    ? `<span class="text-amber-400">running…</span>`
    : `<span class="text-neutral-500">interrupted</span>`;
}

function disclosure(summary: string, detail: string, dataCopy?: string): string {
  return `<details class="group overflow-hidden rounded-xl border border-white/10 bg-neutral-950/40 transition hover:border-white/20"${copyAttr(dataCopy)}>
    <summary class="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs text-neutral-300 transition hover:bg-white/5">
      <span class="shrink-0 text-[10px] text-neutral-400 transition group-open:rotate-90">▶</span>
      ${summary}
    </summary>
    <div class="border-t border-white/10 px-3 py-2 text-xs">${detail}</div>
  </details>`;
}

/** A small uppercase chip that labels a disclosure row by kind (thinking, bash, a tool name). */
function tag(label: string): string {
  return `<span class="shrink-0 rounded bg-white/10 px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wide text-neutral-200">${label}</span>`;
}

function pre(text: string): string {
  return `<pre class="overflow-x-auto whitespace-pre-wrap break-words text-neutral-400">${escapeHtml(
    truncate(text, MAX_OUTPUT_CHARS),
  )}</pre>`;
}

/** Canonical WhatsApp-style plain text for an item, embedded as `data-copy` for clean copy/paste. */
export function copyText(item: LogItem): string {
  const at = copyStamp(item.time);
  const lead = at ? `${at} ` : "";
  switch (item.kind) {
    case "assistant":
      return `${lead}Apollo: ${item.text}`;
    case "bash": {
      const body = item.output ? `\n${truncate(item.output, MAX_OUTPUT_CHARS)}` : "";
      return `${lead}Apollo → bash: ${item.command}${body}\n(exit ${item.exitCode ?? "?"})`;
    }
    case "compaction": {
      const tokens = item.tokensBefore ? ` (~${humanTokens(item.tokensBefore)} tokens)` : "";
      const summary = item.summary ? `\n${truncate(item.summary, MAX_OUTPUT_CHARS)}` : "";
      return `${lead}Context compacted${tokens}${summary}`;
    }
    case "divider":
      return `${lead}${item.label}`;
    case "thinking":
      return `${lead}Apollo (thinking): ${truncate(item.text, MAX_OUTPUT_CHARS)}`;
    case "tool": {
      const status = item.isError ? "error" : item.hasResult ? "ok" : "no result";
      const body = item.output ? `\n${truncate(item.output, MAX_OUTPUT_CHARS)}` : "";
      const note = item.images > 0 ? `\n[${item.images} image(s)]` : "";
      return `${lead}Apollo → ${item.name}(${truncate(argPreview(item.args), MAX_OUTPUT_CHARS)}) [${status}]${body}${note}`;
    }
    case "user": {
      const note =
        item.images.length > 0
          ? `${item.text ? " " : ""}[${item.images.length} image${item.images.length > 1 ? "s" : ""}]`
          : "";
      return `${lead}Roman: ${item.text}${note}`;
    }
  }
}

function renderItem(item: LogItem, running = false): string {
  const copy = copyText(item);
  switch (item.kind) {
    case "assistant":
      return bubble(
        "left",
        "rounded-2xl rounded-bl-sm border border-white/5 bg-neutral-800/80 text-neutral-100",
        textBlock(item.text),
        item.time,
        copy,
      );
    case "bash": {
      const summary = `${tag("bash")}<span class="min-w-0 truncate font-mono text-neutral-200">$ ${escapeHtml(
        truncate(item.command, PREVIEW_CHARS),
      )}</span><span class="ml-auto shrink-0 text-neutral-500">exit ${item.exitCode ?? "?"}</span>`;
      return disclosure(summary, pre(item.output), copy);
    }
    case "compaction": {
      const meta =
        item.tokensBefore == undefined ? "" : ` · ~${humanTokens(item.tokensBefore)} tokens`;
      const detail = item.summary
        ? `<div class="mt-2 rounded-xl border border-white/5 bg-neutral-950/60 px-3 py-2 text-left text-xs">${pre(
            item.summary,
          )}</div>`
        : "";
      return `<details class="group py-1 text-center"${copyAttr(copy)}>
        <summary class="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-full border border-white/10 bg-neutral-900/90 px-3 py-1 text-[11px] font-medium text-neutral-400 transition hover:text-neutral-200">
          Context compacted${meta}<span class="transition group-open:rotate-180">▾</span>
        </summary>
        ${detail}
      </details>`;
    }
    case "divider":
      return chipDivider(item.label, copy);
    case "thinking": {
      const preview = escapeHtml(truncate(item.text.replace(/\s+/g, " ").trim(), PREVIEW_CHARS));
      const summary = `${tag("thinking")}<span class="min-w-0 truncate italic text-neutral-400">${preview}</span>`;
      return disclosure(
        summary,
        `<p class="whitespace-pre-wrap break-words italic text-neutral-500">${escapeHtml(
          truncate(item.text, MAX_OUTPUT_CHARS),
        )}</p>`,
        copy,
      );
    }
    case "tool": {
      const preview = escapeHtml(truncate(argPreview(item.args), PREVIEW_CHARS));
      const summary = `${tag(escapeHtml(item.name))}<span class="min-w-0 truncate text-neutral-400">${preview}</span><span class="ml-auto shrink-0">${toolBadge(item, running)}</span>`;
      const output = item.output ? pre(item.output) : "";
      const note =
        item.images > 0 ? `<p class="text-neutral-500">[${item.images} image(s)]</p>` : "";
      const detail = `<pre class="mb-2 overflow-x-auto whitespace-pre-wrap break-words text-neutral-500">${escapeHtml(
        JSON.stringify(item.args, null, 2),
      )}</pre>${output}${note}`;
      return disclosure(summary, detail, copy);
    }
    case "user":
      return bubble(
        "right",
        "rounded-2xl rounded-br-sm bg-indigo-500 text-white",
        `${item.text ? textBlock(item.text) : ""}${images(item.images)}`,
        item.time,
        copy,
      );
  }
}

/** Render the chat-log fragment (the inner rows for the polling #chat container), inserting a day divider whenever the calendar day of timed items changes. */
export function renderChat(items: LogItem[], now: Date = new Date(), live = false): string {
  if (items.length === 0) {
    return `<p class="m-auto text-sm text-neutral-600">No messages yet.</p>`;
  }
  // Only the most recent tool call can still be running, and only while a run is
  // active; every earlier resultless call was orphaned when its run ended.
  const last = items[items.length - 1];
  const runningIndex = live && last?.kind === "tool" && !last.hasResult ? items.length - 1 : -1;
  const parts: string[] = [];
  let lastDay: string | undefined;
  for (const [index, item] of items.entries()) {
    if (item.time) {
      const date = new Date(item.time);
      const day = date.toDateString();
      if (day !== lastDay) {
        parts.push(chipDivider(dayLabel(date, now)));
        lastDay = day;
      }
    }
    parts.push(renderItem(item, index === runningIndex));
  }
  // Emit newest-first; the #chat container is flex-col-reverse, which flips this back to
  // chronological order visually and keeps the view anchored to the bottom.
  return parts.reverse().join("");
}
