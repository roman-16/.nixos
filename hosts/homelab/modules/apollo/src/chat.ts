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
  | { kind: "assistant"; text: string }
  | { kind: "bash"; command: string; exitCode: number | undefined; output: string }
  | { kind: "compaction"; summary: string; tokensBefore: number | undefined }
  | { kind: "divider"; label: string }
  | { kind: "thinking"; text: string }
  | {
      kind: "tool";
      args: Record<string, unknown>;
      hasResult: boolean;
      images: number;
      isError: boolean;
      name: string;
      output: string;
    }
  | { kind: "user"; images: ChatImage[]; text: string };

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

function assistantItems(message: Record<string, any>, results: Map<string, ToolResult>): LogItem[] {
  const items: LogItem[] = [];
  const content = Array.isArray(message.content) ? message.content : [];
  for (const block of content) {
    if (block?.type === "text" && block.text?.trim()) {
      items.push({ kind: "assistant", text: block.text });
    } else if (block?.type === "thinking" && block.thinking?.trim()) {
      items.push({ kind: "thinking", text: block.thinking });
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
    if (entry.type === "compaction") {
      items.push({
        kind: "compaction",
        summary: typeof entry.summary === "string" ? entry.summary : "",
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
        items.push(...assistantItems(message, results));
        break;
      case "bashExecution":
        items.push({
          command: message.command ?? "",
          exitCode: message.exitCode,
          kind: "bash",
          output: message.output ?? "",
        });
        break;
      case "user": {
        const { images, text } = splitContent(message.content);
        if (text || images.length > 0) items.push({ images, kind: "user", text });
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

function bubble(side: "left" | "right", tone: string, body: string): string {
  const align = side === "right" ? "items-end" : "items-start";
  return `<div class="flex flex-col ${align}">
    <div class="max-w-[85%] rounded-2xl px-3 py-2 text-sm ${tone}">${body}</div>
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
          class="max-h-40 rounded-lg" />`,
    )
    .join("");
  return `<div class="mt-1 flex flex-wrap gap-2">${tags}</div>`;
}

function toolBadge(item: Extract<LogItem, { kind: "tool" }>): string {
  if (!item.hasResult) return `<span class="text-amber-400">running…</span>`;
  return item.isError
    ? `<span class="text-red-400">error</span>`
    : `<span class="text-emerald-400">ok</span>`;
}

function disclosure(summary: string, detail: string): string {
  return `<details class="group rounded-xl border border-neutral-800 bg-neutral-950/60">
    <summary class="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs text-neutral-300">
      ${summary}
    </summary>
    <div class="border-t border-neutral-800 px-3 py-2 text-xs">${detail}</div>
  </details>`;
}

function pre(text: string): string {
  return `<pre class="overflow-x-auto whitespace-pre-wrap break-words text-neutral-400">${escapeHtml(
    truncate(text, MAX_OUTPUT_CHARS),
  )}</pre>`;
}

function renderItem(item: LogItem): string {
  switch (item.kind) {
    case "assistant":
      return bubble("left", "bg-neutral-800 text-neutral-100", textBlock(item.text));
    case "bash": {
      const summary = `<span class="font-mono text-neutral-100">$ ${escapeHtml(
        truncate(item.command, PREVIEW_CHARS),
      )}</span><span class="ml-auto text-neutral-500">exit ${item.exitCode ?? "?"}</span>`;
      return disclosure(summary, pre(item.output));
    }
    case "compaction": {
      const meta =
        item.tokensBefore == undefined ? "" : ` · ~${humanTokens(item.tokensBefore)} tokens`;
      const detail = item.summary
        ? `<div class="mt-2 rounded-xl border border-neutral-800 bg-neutral-950/60 px-3 py-2 text-xs">${pre(
            item.summary,
          )}</div>`
        : "";
      return `<details class="group py-1">
        <summary class="flex cursor-pointer list-none items-center gap-3 text-[11px] uppercase tracking-wide text-neutral-600 transition hover:text-neutral-400">
          <span class="h-px flex-1 bg-neutral-800"></span>
          <span class="flex items-center gap-1">Context compacted${meta}<span class="transition group-open:rotate-180">▾</span></span>
          <span class="h-px flex-1 bg-neutral-800"></span>
        </summary>
        ${detail}
      </details>`;
    }
    case "divider":
      return `<div class="flex items-center gap-3 py-1 text-[11px] uppercase tracking-wide text-neutral-600">
        <span class="h-px flex-1 bg-neutral-800"></span>${escapeHtml(item.label)}<span class="h-px flex-1 bg-neutral-800"></span>
      </div>`;
    case "thinking":
      return disclosure(
        `<span class="italic text-neutral-500">thinking</span>`,
        `<p class="whitespace-pre-wrap break-words italic text-neutral-500">${escapeHtml(
          truncate(item.text, MAX_OUTPUT_CHARS),
        )}</p>`,
      );
    case "tool": {
      const preview = escapeHtml(truncate(argPreview(item.args), PREVIEW_CHARS));
      const summary = `<span class="font-mono text-indigo-300">${escapeHtml(item.name)}</span>
        <span class="truncate text-neutral-500">${preview}</span>
        <span class="ml-auto shrink-0">${toolBadge(item)}</span>`;
      const output = item.output ? pre(item.output) : "";
      const note =
        item.images > 0 ? `<p class="text-neutral-500">[${item.images} image(s)]</p>` : "";
      const detail = `<pre class="mb-2 overflow-x-auto whitespace-pre-wrap break-words text-neutral-500">${escapeHtml(
        JSON.stringify(item.args, null, 2),
      )}</pre>${output}${note}`;
      return disclosure(summary, detail);
    }
    case "user":
      return bubble(
        "right",
        "bg-indigo-500/90 text-white",
        `${item.text ? textBlock(item.text) : ""}${images(item.images)}`,
      );
  }
}

/** Render the chat-log fragment (the inner rows for the polling #chat container). */
export function renderChat(items: LogItem[]): string {
  if (items.length === 0) {
    return `<p class="grid h-full place-items-center text-sm text-neutral-600">No messages yet.</p>`;
  }
  return items.map(renderItem).join("");
}
