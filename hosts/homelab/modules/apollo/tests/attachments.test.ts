import { describe, expect, it } from "bun:test";

import {
  attachmentProblem,
  type Attachment,
  imageBlock,
  MAX_ATTACHMENT_BYTES,
  mimeForFormat,
  readIdentity,
} from "../src/attachments";

const PNG = { format: "PNG", height: 618, width: 1000 };

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

describe("attachmentProblem", () => {
  it("accepts an ordinary image", () => {
    expect(attachmentProblem(200_000, PNG)).toBeUndefined();
  });

  it("refuses an empty file", () => {
    expect(attachmentProblem(0, PNG)).toContain("empty");
  });

  it("refuses one WhatsApp would reject, naming both sizes", () => {
    const problem = attachmentProblem(MAX_ATTACHMENT_BYTES + 1, PNG);
    expect(problem).toContain("5.0 MB");
    expect(problem).toContain("at most 5 MB");
  });

  it("allows a file exactly at the limit", () => {
    expect(attachmentProblem(MAX_ATTACHMENT_BYTES, PNG)).toBeUndefined();
  });

  it("refuses something that is not an image at all", () => {
    expect(attachmentProblem(1000, undefined)).toContain("not an image");
  });

  it("refuses an image format that would not display, and says which to use", () => {
    const problem = attachmentProblem(1000, { format: "PDF", height: 800, width: 600 });
    expect(problem).toContain("PDF");
    expect(problem).toContain("PNG");
  });

  it("checks the size before the format, since an unreadable giant is a size problem", () => {
    expect(attachmentProblem(MAX_ATTACHMENT_BYTES + 1, undefined)).toContain("MB");
  });
});

describe("imageBlock", () => {
  it("stores an attachment in the same shape an inbound image uses", () => {
    const attachment: Attachment = {
      bytes: Buffer.from("hello"),
      height: 618,
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
