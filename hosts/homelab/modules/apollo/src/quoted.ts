import type { ImageContent } from "@earendil-works/pi-ai";
import { getContentType, type WAMessageContent } from "@whiskeysockets/baileys";

import { truncate } from "./format";

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

function quote(value: string, max: number): string {
  return `"${truncate(value, max)}"`;
}

/** Describe the quoted content for the [context] line: its media kind and any text/transcript. */
function contentClause(note: QuotedNote): string {
  const { attached, kind, text } = note;
  switch (kind) {
    case "text":
      return text ? `: ${quote(text, 300)}` : "";
    case "image":
      return attached
        ? ` - an image (attached to this message)${text ? `, captioned ${quote(text, 200)}` : ""}`
        : ` - an image${text ? ` captioned ${quote(text, 200)}` : ""}`;
    case "voice":
      return text ? ` - a voice message that said ${quote(text, 300)}` : " - a voice message";
    case "video":
      return ` - a video${text ? ` captioned ${quote(text, 200)}` : ""}`;
    case "gif":
      return " - a GIF";
    case "document":
      return ` - a document${text ? ` (${truncate(text, 120)})` : ""}`;
    case "sticker":
      return " - a sticker";
    default:
      return "";
  }
}

/** The `[context]`-worthy sentence naming which earlier message the user is replying to. */
export function quotedContextNote(note: QuotedNote): string {
  const who =
    note.sender === "apollo"
      ? "a message you sent earlier"
      : note.sender === "user"
        ? "an earlier message they sent"
        : "an earlier message";
  return `The user is replying to ${who}${contentClause(note)}.`;
}
