import { humanTokens, truncate } from "./format";

import type { LogRecord } from "./logs";

const DEFAULT_MAX_CHARS = 4000;

/** Build the brief WhatsApp notice sent when the session context is compacted. */
export function compactionNotice(tokensBefore?: number): string {
  const count = tokensBefore && tokensBefore > 0 ? ` (~${humanTokens(tokensBefore)} tokens)` : "";
  return `🗜️ Context compacted${count}. Full summary on the dashboard.`;
}

/** Friendly WhatsApp notice when a Claude/agent run fails terminally (any provider error). */
export function claudeErrorNotice(detail: string): string {
  const trimmed = detail.trim();
  return `⚠️ I couldn't reach Claude just now${
    trimmed ? `: ${truncate(trimmed, 300)}` : ""
  }. Your message didn't go through - try again in a bit.`;
}

function logLevelLabel(level: number): string {
  if (level >= 60) return "FATAL";
  if (level >= 50) return "ERROR";
  if (level >= 40) return "WARN";
  return "INFO";
}

/** A concise reason pulled from a log record's common error fields, if any. */
function logDetail(record: LogRecord): string {
  const source = record.err ?? record.error ?? record.detail;
  if (typeof source === "string") return source;
  if (source && typeof source === "object" && "message" in source) {
    const { message } = source as { message?: unknown };
    if (typeof message === "string") return message;
  }
  return "";
}

/** Generic WhatsApp text for a forwarded warn+ log record that carries no bespoke notifyText. */
export function formatLogNotice(record: LogRecord): string {
  const level = typeof record.level === "number" ? record.level : 30;
  const msg = typeof record.msg === "string" ? record.msg : "";
  const detail = logDetail(record);
  return `⚠️ ${logLevelLabel(level)}: ${msg}${detail ? ` - ${truncate(detail, 300)}` : ""}`;
}

/** Strip a WhatsApp JID to its bare number (drops the device suffix and domain). */
export function numberFromJid(jid: string): string {
  const user = jid.split("@")[0] ?? "";
  return (user.split(":")[0] ?? "").replace(/\D/g, "");
}

/** Build the individual-chat JID for a bare phone number (inverse of numberFromJid). */
export function jidForNumber(number: string): string {
  return `${number.replace(/\D/g, "")}@s.whatsapp.net`;
}

/** Mark a transcribed voice note so it reads as spoken in the chat log and to the agent. */
export function voiceText(transcript: string): string {
  const trimmed = transcript.trim();
  return trimmed ? `🎤 ${trimmed}` : "🎤 (empty voice message)";
}

/** True when the sender's number is on the allowlist (both sides normalized to digits). */
export function isAllowed(number: string, allowFrom: string[]): boolean {
  const normalized = number.replace(/\D/g, "");
  if (!normalized) return false;
  return allowFrom.some((entry) => entry.replace(/\D/g, "") === normalized);
}

/**
 * Split text into WhatsApp-sized chunks, preferring line then word boundaries and
 * hard-cutting only when a single run exceeds the limit. Empty input yields no messages.
 */
export function splitMessage(text: string, max: number = DEFAULT_MAX_CHARS): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed ? [trimmed] : [];

  const chunks: string[] = [];
  let rest = trimmed;
  while (rest.length > max) {
    const floor = Math.floor(max * 0.5);
    let cut = rest.lastIndexOf("\n", max);
    if (cut < floor) cut = rest.lastIndexOf(" ", max);
    if (cut < floor) cut = max;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks.filter(Boolean);
}
