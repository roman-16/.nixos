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

  it("tags the note as a reply and names the sender in info", () => {
    expect(quotedContextNote(note({ sender: "apollo", text: "on it" }))).toEqual({
      body: "on it",
      info: "The user is replying to a message you sent earlier.",
      source: "reply",
    });
    expect(quotedContextNote(note({ sender: "user", text: "remind me" })).info).toBe(
      "The user is replying to an earlier message they sent.",
    );
    expect(quotedContextNote(note({ sender: "unknown", text: "hi" })).info).toBe(
      "The user is replying to an earlier message.",
    );
  });

  it("puts the quoted words in the body", () => {
    expect(quotedContextNote(note({ sender: "user", text: "remind me" })).body).toBe("remind me");
    expect(quotedContextNote(note({ kind: "text", text: "" })).body).toBe("");
  });

  it("notes an attached image in info and its caption in the body", () => {
    expect(quotedContextNote(note({ attached: true, kind: "image", sender: "user" })).info).toBe(
      "The user is replying to an earlier message they sent - an image (attached to this message).",
    );
    expect(
      quotedContextNote(note({ attached: true, kind: "image", sender: "user", text: "this one" }))
        .body,
    ).toBe("this one");
  });

  it("describes an image that could not be attached", () => {
    expect(quotedContextNote(note({ attached: false, kind: "image" })).info).toBe(
      "The user is replying to an earlier message - an image.",
    );
  });

  it("puts a voice transcript in the body under a voice-message info", () => {
    const voiced = quotedContextNote(note({ kind: "voice", sender: "user", text: "buy milk" }));
    expect(voiced.info).toBe(
      "The user is replying to an earlier message they sent - a voice message.",
    );
    expect(voiced.body).toBe("buy milk");
    expect(quotedContextNote(note({ kind: "voice", sender: "user" })).body).toBe("");
  });

  it("labels video, GIF, document, and sticker in info", () => {
    expect(quotedContextNote(note({ kind: "video", text: "clip" })).info).toContain("a video");
    expect(quotedContextNote(note({ kind: "video", text: "clip" })).body).toBe("clip");
    expect(quotedContextNote(note({ kind: "gif" })).info).toContain("a GIF");
    expect(quotedContextNote(note({ kind: "document", text: "q3.pdf" })).info).toContain(
      "a document",
    );
    expect(quotedContextNote(note({ kind: "document", text: "q3.pdf" })).body).toBe("q3.pdf");
    expect(quotedContextNote(note({ kind: "sticker" })).info).toContain("a sticker");
  });

  it("keeps a normal-length body in full", () => {
    const body = "a".repeat(400);
    expect(quotedContextNote(note({ kind: "text", text: body })).body).toBe(body);
  });

  it("clips an over-long body with a trailing ellipsis and no meta noise", () => {
    const long = "x".repeat(2500);
    const { body } = quotedContextNote(note({ kind: "text", text: long }));
    expect(body).toContain("\u2026");
    expect(body).not.toContain("more chars");
    expect(body.length).toBeLessThan(long.length);
  });
});
