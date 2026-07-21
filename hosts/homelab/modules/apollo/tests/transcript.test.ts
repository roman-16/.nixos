import { describe, expect, it } from "bun:test";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMediaReader, imageFromLine, readTail } from "../src/transcript";

function tmpFile(content: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "apollo-transcript-")), "session.jsonl");
  writeFileSync(path, content);
  return path;
}

function b64(text: string): string {
  return Buffer.from(text).toString("base64");
}

function imageLine(id: string, data: string, mimeType = "image/png"): string {
  return JSON.stringify({
    id,
    message: { content: [{ data, mimeType, type: "image" }], role: "user" },
    type: "message",
  });
}

describe("imageFromLine", () => {
  it("extracts the Nth image block as bytes with its mime type", () => {
    const line = JSON.stringify({
      message: {
        content: [
          { text: "hi", type: "text" },
          { data: b64("one"), mimeType: "image/png", type: "image" },
          { data: b64("two"), mimeType: "image/webp", type: "image" },
        ],
        role: "user",
      },
    });
    expect(imageFromLine(line, 0)).toEqual({ bytes: Buffer.from("one"), mimeType: "image/png" });
    expect(imageFromLine(line, 1)).toEqual({ bytes: Buffer.from("two"), mimeType: "image/webp" });
  });

  it("defaults a missing mime type to image/jpeg", () => {
    const line = JSON.stringify({ message: { content: [{ data: b64("x"), type: "image" }] } });
    expect(imageFromLine(line, 0)?.mimeType).toBe("image/jpeg");
  });

  it("returns undefined for an out-of-range index, no images, or bad JSON", () => {
    expect(imageFromLine(imageLine("a", b64("x")), 5)).toBeUndefined();
    expect(imageFromLine(JSON.stringify({ message: { content: "hi" } }), 0)).toBeUndefined();
    expect(imageFromLine("{not json", 0)).toBeUndefined();
  });
});

describe("readTail", () => {
  it("returns the last N complete lines and flags more history", async () => {
    const path = tmpFile(`${["one", "two", "three", "four"].join("\n")}\n`);
    expect(await readTail(path, 2)).toEqual({ more: true, text: "three\nfour" });
  });

  it("returns everything with more=false when N covers the file", async () => {
    expect(await readTail(tmpFile("a\nb\n"), 10)).toEqual({ more: false, text: "a\nb" });
  });

  it("flags more history when a whole small file exceeds the window", async () => {
    expect(await readTail(tmpFile("a\nb\nc\n"), 2)).toEqual({ more: true, text: "b\nc" });
  });

  it("reads a tail that spans many backward chunks", async () => {
    const lines = Array.from({ length: 4000 }, (_, i) => `line-${i}-${"x".repeat(40)}`);
    const path = tmpFile(`${lines.join("\n")}\n`);
    const tail = await readTail(path, 2);
    expect(tail.text).toBe(`${lines[3998]}\n${lines[3999]}`);
    expect(tail.more).toBe(true);
  });

  it("is empty with more=false for an empty file", async () => {
    expect(await readTail(tmpFile(""), 5)).toEqual({ more: false, text: "" });
  });
});

describe("createMediaReader", () => {
  it("serves an image by entry id and index", async () => {
    const path = tmpFile(
      `${[JSON.stringify({ id: "s", type: "session" }), imageLine("m1", b64("hello"))].join("\n")}\n`,
    );
    const image = await createMediaReader().readImage(path, "m1", 0);
    expect(image?.bytes.toString()).toBe("hello");
    expect(image?.mimeType).toBe("image/png");
  });

  it("returns undefined for an unknown id", async () => {
    const path = tmpFile(`${imageLine("m1", b64("x"))}\n`);
    expect(await createMediaReader().readImage(path, "nope", 0)).toBeUndefined();
  });

  it("indexes entries appended after the first read", async () => {
    const path = tmpFile(`${imageLine("m1", b64("one"))}\n`);
    const reader = createMediaReader();
    expect((await reader.readImage(path, "m1", 0))?.bytes.toString()).toBe("one");
    appendFileSync(path, `${imageLine("m2", b64("two"))}\n`);
    expect((await reader.readImage(path, "m2", 0))?.bytes.toString()).toBe("two");
  });

  it("serves the freshest entry even before its trailing newline lands", async () => {
    const path = tmpFile(imageLine("m1", b64("fresh")));
    expect((await createMediaReader().readImage(path, "m1", 0))?.bytes.toString()).toBe("fresh");
  });
});
