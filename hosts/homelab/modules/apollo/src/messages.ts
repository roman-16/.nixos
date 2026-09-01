import type { ReceivedFile } from "./files";
import { humanBytes, truncate } from "./format";

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

// One `<context ...>` element at the start of a user turn: its source + info attributes and an
// optional body (self-closing when there is none).
const CONTEXT_ELEMENT =
  /^<context source="([^"]*)" info="([^"]*)"(?:\s*\/>|>([\s\S]*?)<\/context>)/;

/**
 * The plain text of a message's content: a bare string, or its text blocks joined. Thinking, tool
 * calls and images are machinery rather than words, so none of them appear here.
 */
export function messageText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return (content as { text?: string; type?: string }[])
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text!)
    .join("\n")
    .trim();
}

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

export interface SplitContext {
  /** The notes the app injected, in the order they were prepended. */
  contexts: ContextNote[];
  /** What the user actually sent. */
  message: string;
}

function unescapeAttribute(value: string): string {
  return value.replaceAll("&quot;", '"');
}

/**
 * Split a user turn into the leading `<context>` notes the app injected and the user's own message -
 * the exact inverse of `withContext`. Text that doesn't open with a `<context>` element is returned
 * untouched as the message. This is the other half of `splitInternal`: between them they recover the
 * conversation as WhatsApp saw it from the conversation as the model saw it.
 */
export function splitUserContext(text: string): SplitContext {
  if (!text.startsWith("<context ")) return { contexts: [], message: text };
  const contexts: ContextNote[] = [];
  let rest = text;
  for (;;) {
    const match = CONTEXT_ELEMENT.exec(rest);
    if (!match) break;
    contexts.push({
      body: match[3] ?? "",
      info: unescapeAttribute(match[2] ?? ""),
      source: unescapeAttribute(match[1] ?? ""),
    });
    rest = rest.slice(match[0].length);
    if (rest.startsWith("\n")) rest = rest.slice(1);
  }
  return { contexts, message: rest.startsWith("\n") ? rest.slice(1) : rest };
}

/**
 * A window in which Apollo was off WhatsApp, as a note for its next turn.
 *
 * Nothing is sent about it. WhatsApp replays what it queued, so anything the user wrote arrives as
 * its own late turn that already says so - and a gap that queued nothing looks exactly like a gap
 * nobody wrote into, which makes "forward anything that's missing" a guess priced at an interruption
 * on every restart. Handed to the next turn instead, where it can account for the silence if the
 * silence ever comes up.
 */
export function linkGapNote(from: number, to: number): ContextNote {
  return {
    body:
      "Anything the user sent in that window may never have reached me. Don't raise it unprompted: " +
      "it only matters if something from around then turns out to be missing, or if they ask why I " +
      "went quiet.",
    info: `My WhatsApp link was down for ${describeDelay(to - from)}, from ${stamp(new Date(from))} until ${stamp(new Date(to))}.`,
    source: "link",
  };
}

/** Stand-in for a voice note that could not be transcribed, so the message still reaches the agent. */
export function voiceFailure(): string {
  return "🎤 (voice note - I couldn't transcribe it; ask the user what they said)";
}

/**
 * How a file reads in the transcript. What appeared on the phone was a document bubble showing the
 * name, so that is what the message says - which also puts the name where the recall skill can find
 * it, the way a voice note's transcript is put where its words can be found.
 */
export function fileMark(name: string): string {
  return `📎 ${name}`;
}

/**
 * The file context: where it landed and what to do with it, or why it never landed.
 *
 * The path is the whole point. Apollo cannot see a file the way it sees a photo, so what it is
 * given is somewhere to point its own tools at - and a reminder that this place empties, since the
 * only thing standing between a file worth keeping and its deletion is Apollo moving it.
 */
export function fileContextNote(file: ReceivedFile, retentionDays: number): ContextNote {
  const size = humanBytes(file.size);
  if (!file.path) {
    return {
      body:
        "It is not on this machine, so say so plainly rather than trying to open it. Suggest what " +
        "would work instead - something smaller, split up, or put somewhere I can fetch it from.",
      info: `The user sent ${file.name} (${size}), but I could not take it: ${file.problem ?? "it did not arrive"}.`,
      source: "file",
    };
  }
  return {
    body:
      "It is a file on this machine, not something I can see - open it with my own tools. Files " +
      `the user sends are deleted after ${retentionDays} days, so anything worth keeping has to be ` +
      "moved into the working directory or the vault; the files skill covers that, and sending one back.",
    info: `The user sent ${file.name} (${size}, ${file.mimeType}). It is at ${file.path}.`,
    source: "file",
  };
}

/**
 * WhatsApp notice when a Claude/agent run fails terminally (any provider error). Only the first line
 * of the reason is worth sending: a provider's detail carries a stack trace behind it, and a wall of
 * source paths tells the user nothing they can act on.
 */
export function claudeErrorNotice(detail: string): string {
  const [first = ""] = detail.trim().split("\n");
  const reason = first.trim();
  return `⚠️ I couldn't reach Claude just now${
    reason ? `: ${truncate(reason, 300)}` : ""
  }. Your message didn't go through - try again in a bit.`;
}

/**
 * WhatsApp notice for a Claude sign-in that has expired. Retrying cannot fix it and only the user
 * can, so this names the one action that will, and says their messages are being kept rather than
 * lost while they get to it.
 */
export function claudeAuthNotice(dashboardUrl: string): string {
  const where = dashboardUrl ? `the dashboard (${dashboardUrl})` : "the dashboard";
  return (
    `⚠️ My Claude sign-in expired, so I can't answer until it's renewed: open ${where}, ` +
    `then Claude -> Authorize. I'll keep whatever you send me and catch up once it's back.`
  );
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
 * Context note telling the agent a skill delivered something to the user out of band: a coherent
 * description in `info`, and what was delivered in `body` - the message itself, or the caption an
 * image or a file went out with. An attachment is named for what it was, so the agent knows the
 * picture has landed or the file has been sent, and does not describe it back.
 */
export function skillContextNote(
  source: string,
  text: string,
  attached?: "file" | "image",
): ContextNote {
  const what = attached ? (attached === "file" ? "a file" : "an image") : "a message";
  return {
    body: truncate(text, SKILL_NOTE_MAX_CHARS),
    info: `The ${source} skill sent the user ${what} directly.`,
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
