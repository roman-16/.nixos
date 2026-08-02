import { truncate } from "./format";

import type { LogRecord } from "./logs";
import { type ContextNote, describeDelay, stamp } from "./temporal";

const DEFAULT_MAX_CHARS = 4000;

// The context breadcrumb for an out-of-band skill send is the agent's only record of what it sent
// once the original send is compacted out, so it keeps the message nearly whole (a full WhatsApp
// message's worth) rather than clipping it to a stub.
const SKILL_NOTE_MAX_CHARS = 4000;

// A span Apollo addresses to itself rather than to the user. Unterminated spans run to the end of
// the block, so a forgotten closing tag stays silent instead of leaking markup into WhatsApp.
const INTERNAL_SPAN = /<internal>[\s\S]*?(?:<\/internal>|$)/g;
const INTERNAL_BODY = /^<internal>([\s\S]*?)(?:<\/internal>|$)$/;

export interface SplitText {
  /** What reaches the user: the block with every internal span removed. */
  delivered: string;
  /** The notes that stay behind, in the order they were written. */
  internal: string[];
}

/**
 * Split one assistant text block into what is delivered and what is not. Every text block is a
 * WhatsApp message, so an `<internal>` span is how Apollo writes something down - a note to itself,
 * or the reason it has nothing to send - without messaging the user. Spans are stripped wherever
 * they sit in the block, and a block left empty by that is never sent at all, which is how Apollo
 * ends a turn in silence rather than announcing that it has nothing to say.
 */
export function splitInternal(text: string): SplitText {
  const internal: string[] = [];
  const delivered = text
    .replace(INTERNAL_SPAN, (span) => {
      const note = (INTERNAL_BODY.exec(span)?.[1] ?? "").trim();
      if (note) internal.push(note);
      return "";
    })
    .trim();
  return { delivered, internal };
}

/**
 * What the user is told after the WhatsApp link was gone long enough to have missed something.
 * WhatsApp replays what it queued, but a long enough gap outlives that queue, and only the user
 * knows what they sent - so the gap is stated plainly rather than hidden.
 */
export function outageNotice(from: number, to: number): string {
  return (
    `⚠️ I was offline for ${describeDelay(to - from)}, from ${stamp(new Date(from))} until ${stamp(new Date(to))}. ` +
    `I'll catch up on whatever WhatsApp kept for me - forward anything that's missing.`
  );
}

/** Stand-in for a voice note that could not be transcribed, so the message still reaches the agent. */
export function voiceFailure(): string {
  return "🎤 (voice note - I couldn't transcribe it; ask the user what they said)";
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

/**
 * Context note telling the agent a skill delivered a message to the user out of band: a coherent
 * description in `info`, the delivered message itself in `body`.
 */
export function skillContextNote(source: string, text: string): ContextNote {
  return {
    body: truncate(text, SKILL_NOTE_MAX_CHARS),
    info: `The ${source} skill sent the user a message directly.`,
    source,
  };
}

// The single source of truth for the trailing marker a skill script prints after handing its
// output to /internal/skill-message. The endpoint returns one of these as its response body and
// every skill just echoes it, so the wording lives in one place and stays identical everywhere.
export function deliveredMarker(source: string): string {
  return (
    `\n[${source}: delivered to the user \u2713 - do not relay; ` +
    `end your turn with <internal>\u2026</internal> if you have nothing to add]\n`
  );
}

export function failedMarker(source: string): string {
  return `\n[${source}: delivery FAILED - relay the output above to the user yourself]\n`;
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
