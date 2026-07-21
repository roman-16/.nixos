import { describe, expect, it } from "bun:test";

import { describeQuotedMessage, quotedContextNote, type QuotedNote } from "../src/quoted";

describe("describeQuotedMessage", () => {
  it("reads plain and extended text", () => {
    expect(describeQuotedMessage({ conversation: "hello" })).toEqual({
      kind: "text",
      text: "hello",
    });
    expect(describeQuotedMessage({ extendedTextMessage: { text: "hi there" } })).toEqual({
      kind: "text",
      text: "hi there",
    });
  });

  it("reads an image with and without a caption", () => {
    expect(describeQuotedMessage({ imageMessage: { caption: "my lunch" } })).toEqual({
      kind: "image",
      text: "my lunch",
    });
    expect(describeQuotedMessage({ imageMessage: {} })).toEqual({ kind: "image", text: "" });
  });

  it("distinguishes video from GIF", () => {
    expect(describeQuotedMessage({ videoMessage: { caption: "clip" } })).toEqual({
      kind: "video",
      text: "clip",
    });
    expect(describeQuotedMessage({ videoMessage: { gifPlayback: true } })).toEqual({
      kind: "gif",
      text: "",
    });
  });

  it("labels a voice note with no inline text", () => {
    expect(describeQuotedMessage({ audioMessage: { seconds: 3 } })).toEqual({
      kind: "voice",
      text: "",
    });
  });

  it("reads a document's caption then filename", () => {
    expect(
      describeQuotedMessage({ documentMessage: { caption: "Q3", fileName: "q3.pdf" } }),
    ).toEqual({ kind: "document", text: "Q3" });
    expect(describeQuotedMessage({ documentMessage: { fileName: "q3.pdf" } })).toEqual({
      kind: "document",
      text: "q3.pdf",
    });
  });

  it("labels a sticker and falls back to other", () => {
    expect(describeQuotedMessage({ stickerMessage: {} })).toEqual({ kind: "sticker", text: "" });
    expect(describeQuotedMessage({ pollCreationMessage: {} } as never)).toEqual({
      kind: "other",
      text: "",
    });
  });

  it("unwraps ephemeral and view-once envelopes", () => {
    expect(
      describeQuotedMessage({ ephemeralMessage: { message: { conversation: "secret" } } }),
    ).toEqual({ kind: "text", text: "secret" });
    expect(
      describeQuotedMessage({ viewOnceMessage: { message: { imageMessage: { caption: "x" } } } }),
    ).toEqual({ kind: "image", text: "x" });
  });
});

describe("quotedContextNote", () => {
  const note = (over: Partial<QuotedNote>): QuotedNote => ({
    attached: false,
    kind: "text",
    sender: "unknown",
    text: "",
    ...over,
  });

  it("names the sender: Apollo, the user, or neither", () => {
    expect(quotedContextNote(note({ sender: "apollo", text: "on it" }))).toBe(
      'The user is replying to a message you sent earlier: "on it".',
    );
    expect(quotedContextNote(note({ sender: "user", text: "remind me" }))).toBe(
      'The user is replying to an earlier message they sent: "remind me".',
    );
    expect(quotedContextNote(note({ sender: "unknown", text: "hi" }))).toBe(
      'The user is replying to an earlier message: "hi".',
    );
  });

  it("omits the quote when a text message has no body", () => {
    expect(quotedContextNote(note({ kind: "text", text: "" }))).toBe(
      "The user is replying to an earlier message.",
    );
  });

  it("notes an attached image and its caption", () => {
    expect(quotedContextNote(note({ attached: true, kind: "image", sender: "user" }))).toBe(
      "The user is replying to an earlier message they sent - an image (attached to this message).",
    );
    expect(
      quotedContextNote(note({ attached: true, kind: "image", sender: "user", text: "this one" })),
    ).toBe(
      'The user is replying to an earlier message they sent - an image (attached to this message), captioned "this one".',
    );
  });

  it("describes an image that could not be attached", () => {
    expect(quotedContextNote(note({ attached: false, kind: "image" }))).toBe(
      "The user is replying to an earlier message - an image.",
    );
  });

  it("includes a voice transcript, or a bare label without one", () => {
    expect(quotedContextNote(note({ kind: "voice", sender: "user", text: "buy milk" }))).toBe(
      'The user is replying to an earlier message they sent - a voice message that said "buy milk".',
    );
    expect(quotedContextNote(note({ kind: "voice", sender: "user" }))).toBe(
      "The user is replying to an earlier message they sent - a voice message.",
    );
  });

  it("labels video, GIF, document, and sticker", () => {
    expect(quotedContextNote(note({ kind: "video", text: "clip" }))).toContain(
      'a video captioned "clip"',
    );
    expect(quotedContextNote(note({ kind: "gif" }))).toContain("a GIF");
    expect(quotedContextNote(note({ kind: "document", text: "q3.pdf" }))).toContain(
      "a document (q3.pdf)",
    );
    expect(quotedContextNote(note({ kind: "sticker" }))).toContain("a sticker");
  });

  it("keeps a normal-length message in full", () => {
    const body = "a".repeat(400);
    expect(quotedContextNote(note({ kind: "text", text: body }))).toContain(body);
  });

  it("clips an over-long body with a trailing ellipsis and no meta noise", () => {
    const long = "x".repeat(2500);
    const clipped = quotedContextNote(note({ kind: "text", text: long }));
    expect(clipped).toContain("\u2026");
    expect(clipped).not.toContain("more chars");
    expect(clipped.length).toBeLessThan(long.length);
  });
});
