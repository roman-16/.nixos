import type { ImageContent } from "@earendil-works/pi-ai";
import { getContentType, type WAMessageContent } from "@whiskeysockets/baileys";

import type { ContextNote } from "./newday";

export type QuotedKind =
  | "document"
  | "gif"
  | "image"
  | "other"
  | "sticker"
  | "text"
  | "video"
  | "voice";

export type QuotedSender = "apollo" | "unknown" | "user";

/**
 * The reply/quote a message carries: which earlier message it points at, that
 * message's display kind and inline text, and any of its media we downloaded to
 * hand to the agent (the image itself, or voice bytes to transcribe).
 */
export interface QuotedContext {
  audio?: { data: Buffer; mimeType: string };
  images: ImageContent[];
  kind: QuotedKind;
  sender: QuotedSender;
  text: string;
}

/** Unwrap the common Baileys envelopes so the quoted content's real type is visible. */
function unwrapQuoted(content: WAMessageContent): WAMessageContent {
  return (
    content.ephemeralMessage?.message ??
    content.viewOnceMessage?.message ??
    content.viewOnceMessageV2?.message ??
    content.documentWithCaptionMessage?.message ??
    content
  );
}

/**
 * Classify a quoted message into a display kind plus any inline text (a body or
 * caption); media carries no inline text (a voice note is transcribed elsewhere).
 */
export function describeQuotedMessage(quoted: WAMessageContent): {
  kind: QuotedKind;
  text: string;
} {
  const content = unwrapQuoted(quoted);
  switch (getContentType(content)) {
    case "conversation":
      return { kind: "text", text: content.conversation ?? "" };
    case "extendedTextMessage":
      return { kind: "text", text: content.extendedTextMessage?.text ?? "" };
    case "imageMessage":
      return { kind: "image", text: content.imageMessage?.caption ?? "" };
    case "videoMessage":
      return {
        kind: content.videoMessage?.gifPlayback ? "gif" : "video",
        text: content.videoMessage?.caption ?? "",
      };
    case "audioMessage":
      return { kind: "voice", text: "" };
    case "documentMessage":
      return {
        kind: "document",
        text: content.documentMessage?.caption ?? content.documentMessage?.fileName ?? "",
      };
    case "stickerMessage":
      return { kind: "sticker", text: "" };
    default:
      return { kind: "other", text: "" };
  }
}

export interface QuotedNote {
  /** Whether the quoted image was downloaded and attached to this turn. */
  attached: boolean;
  kind: QuotedKind;
  sender: QuotedSender;
  /** The quoted message's words: its body/caption, or a transcribed voice note. */
  text: string;
}

/** Longest quoted body/caption/transcript kept in the context line before a trailing ellipsis. */
const QUOTE_MAX = 2000;

/** Clip to `max` characters with a clean trailing ellipsis - no "(N more chars)" meta, no newline. */
function clip(value: string, max: number = QUOTE_MAX): string {
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max).trimEnd()}\u2026` : trimmed;
}

/** The media-kind suffix for the reply's `info` sentence; the quoted words themselves go in the body. */
function mediaClause(note: QuotedNote): string {
  switch (note.kind) {
    case "image":
      return note.attached ? " - an image (attached to this message)" : " - an image";
    case "voice":
      return " - a voice message";
    case "video":
      return " - a video";
    case "gif":
      return " - a GIF";
    case "document":
      return " - a document";
    case "sticker":
      return " - a sticker";
    default:
      return "";
  }
}

/**
 * The reply context: `info` names which earlier message the user is replying to (who + media kind),
 * `body` carries its words - the quoted text, a caption, or a transcribed voice note.
 */
export function quotedContextNote(note: QuotedNote): ContextNote {
  const who =
    note.sender === "apollo"
      ? "a message you sent earlier"
      : note.sender === "user"
        ? "an earlier message they sent"
        : "an earlier message";
  return {
    body: clip(note.text),
    info: `The user is replying to ${who}${mediaClause(note)}.`,
    source: "reply",
  };
}
