import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import {
  fileProblem,
  type ImageAttachment,
  imageBlock,
  imageProblem,
  loadFile,
  MAX_IMAGE_BYTES,
  mimeForFormat,
  readIdentity,
  sniffMime,
} from "../src/attachments";

const PNG = { format: "PNG", height: 618, width: 1000 };

const MAX_FILE_BYTES = 100 * 1024 * 1024;

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "apollo-attachments-"));
}

describe("readIdentity", () => {
  it("reads what ImageMagick reports", () => {
    expect(readIdentity("PNG 1000 618")).toEqual(PNG);
  });

  it("tolerates surrounding whitespace and repeated spaces", () => {
    expect(readIdentity("  PNG   1000   618 \n")).toEqual(PNG);
  });

  it("normalizes the format to upper case", () => {
    expect(readIdentity("png 10 10")?.format).toBe("PNG");
  });

  it("rejects output that is not an identification", () => {
    expect(readIdentity("")).toBeUndefined();
    expect(readIdentity("PNG")).toBeUndefined();
    expect(readIdentity("PNG 1000")).toBeUndefined();
    expect(readIdentity("PNG wide tall")).toBeUndefined();
  });

  it("rejects impossible dimensions", () => {
    expect(readIdentity("PNG 0 618")).toBeUndefined();
    expect(readIdentity("PNG -5 618")).toBeUndefined();
    expect(readIdentity("PNG 10.5 618")).toBeUndefined();
  });
});

describe("mimeForFormat", () => {
  it("maps the formats WhatsApp shows as a photo", () => {
    expect(mimeForFormat("PNG")).toBe("image/png");
    expect(mimeForFormat("jpeg")).toBe("image/jpeg");
    expect(mimeForFormat("WEBP")).toBe("image/webp");
    expect(mimeForFormat("GIF")).toBe("image/gif");
  });

  it("does not map anything else", () => {
    expect(mimeForFormat("PDF")).toBeUndefined();
    expect(mimeForFormat("SVG")).toBeUndefined();
    expect(mimeForFormat("constructor")).toBeUndefined();
  });
});

describe("imageProblem", () => {
  it("accepts an ordinary image", () => {
    expect(imageProblem(200_000, PNG)).toBeUndefined();
  });

  it("refuses an empty file", () => {
    expect(imageProblem(0, PNG)).toContain("empty");
  });

  it("refuses one WhatsApp would reject, naming both sizes", () => {
    const problem = imageProblem(MAX_IMAGE_BYTES + 1, PNG);
    expect(problem).toContain("5.0 MB");
    expect(problem).toContain("photos up to");
  });

  it("allows a file exactly at the limit", () => {
    expect(imageProblem(MAX_IMAGE_BYTES, PNG)).toBeUndefined();
  });

  it("refuses something that is not an image at all", () => {
    expect(imageProblem(1000, undefined)).toContain("not an image");
  });

  it("refuses an image format that would not display, and says which to use", () => {
    const problem = imageProblem(1000, { format: "PDF", height: 800, width: 600 });
    expect(problem).toContain("PDF");
    expect(problem).toContain("PNG");
  });

  it("checks the size before the format, since an unreadable giant is a size problem", () => {
    expect(imageProblem(MAX_IMAGE_BYTES + 1, undefined)).toContain("MB");
  });
});

describe("fileProblem", () => {
  it("accepts an ordinary file", () => {
    expect(fileProblem(2_200_000, MAX_FILE_BYTES)).toBeUndefined();
  });

  it("accepts one far larger than a photo may be", () => {
    expect(fileProblem(40 * 1024 * 1024, MAX_FILE_BYTES)).toBeUndefined();
  });

  it("refuses an empty file", () => {
    expect(fileProblem(0, MAX_FILE_BYTES)).toContain("empty");
  });

  it("refuses one over the cap, naming both sizes", () => {
    const problem = fileProblem(642 * 1024 * 1024, MAX_FILE_BYTES);
    expect(problem).toContain("642.0 MB");
    expect(problem).toContain("100.0 MB");
  });

  it("allows a file exactly at the cap", () => {
    expect(fileProblem(MAX_FILE_BYTES, MAX_FILE_BYTES)).toBeUndefined();
  });
});

describe("imageBlock", () => {
  it("stores a picture in the same shape an inbound image uses", () => {
    const attachment: ImageAttachment = {
      bytes: Buffer.from("hello"),
      height: 618,
      kind: "image",
      mimeType: "image/png",
      width: 1000,
    };
    expect(imageBlock(attachment)).toEqual({
      data: Buffer.from("hello").toString("base64"),
      mimeType: "image/png",
      type: "image",
    });
  });
});

describe("sniffMime", () => {
  it("reads what a file actually is, whatever it is named", async () => {
    const path = join(scratch(), "notes.pdf");
    await Bun.write(path, "just text, despite the name");
    expect(await sniffMime(path)).toBe("text/plain");
  });

  it("answers something WhatsApp can use when nothing can tell", async () => {
    const path = join(scratch(), "gone.bin");
    expect(await sniffMime(path)).toBe("application/octet-stream");
  });
});

describe("loadFile", () => {
  it("reads what WhatsApp needs, and keeps the file a path", async () => {
    const path = join(scratch(), "bike notes.zip");
    await Bun.write(path, "PK\u0003\u0004 pretend archive");
    const attachment = await loadFile(path, MAX_FILE_BYTES);
    expect(attachment.kind).toBe("file");
    expect(attachment.name).toBe("bike notes.zip");
    expect(attachment.path).toBe(path);
    expect(attachment.size).toBeGreaterThan(0);
    expect(attachment.mimeType).toContain("/");
  });

  it("refuses a file that is not there", async () => {
    expect(loadFile(join(scratch(), "nope.zip"), MAX_FILE_BYTES)).rejects.toThrow("no file at");
  });

  it("refuses a directory, and says what to do instead", async () => {
    expect(loadFile(scratch(), MAX_FILE_BYTES)).rejects.toThrow("zip it first");
  });

  it("refuses one over the cap before an upload is spent on it", async () => {
    const path = join(scratch(), "big.bin");
    await Bun.write(path, "x".repeat(2048));
    expect(loadFile(path, 1024)).rejects.toThrow("only send files up to");
  });

  it("refuses an empty file", async () => {
    const path = join(scratch(), "empty.txt");
    await Bun.write(path, "");
    expect(loadFile(path, MAX_FILE_BYTES)).rejects.toThrow("empty");
  });
});
