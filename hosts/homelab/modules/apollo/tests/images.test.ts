import { describe, expect, it } from "bun:test";

import { droppedImageNote, fitImages, type Resizer } from "../src/images";

const image = (data: string, mimeType = "image/jpeg") => ({
  data,
  mimeType,
  type: "image" as const,
});

/** A resizer that reports every image as already fitting. */
const passthrough: Resizer = async (bytes, mimeType) => ({
  data: Buffer.from(bytes).toString("base64"),
  mimeType,
  wasResized: false,
});

describe("fitImages", () => {
  it("passes an image that already fits through untouched", async () => {
    const result = await fitImages([image("aGVsbG8=")], passthrough);
    expect(result.images).toEqual([image("aGVsbG8=")]);
    expect(result).toMatchObject({ dropped: 0, resized: 0 });
  });

  it("takes the resized data and mime type when an image had to shrink", async () => {
    const shrink: Resizer = async () => ({
      data: "c21hbGw=",
      mimeType: "image/png",
      wasResized: true,
    });
    const result = await fitImages([image("Ymln")], shrink);
    expect(result.images).toEqual([image("c21hbGw=", "image/png")]);
    expect(result).toMatchObject({ dropped: 0, resized: 1 });
  });

  it("drops an image that cannot be fitted, rather than poisoning every later turn", async () => {
    const result = await fitImages([image("YmFk")], async () => null);
    expect(result.images).toEqual([]);
    expect(result.dropped).toBe(1);
  });

  it("drops a sticker the resizer cannot read, rather than sending the model something it isn't", async () => {
    const result = await fitImages([image("bm9wZQ==", "image/webp")], async () => null);
    expect(result).toMatchObject({ dropped: 1, images: [] });
  });

  it("drops an image whose resize throws", async () => {
    const result = await fitImages([image("YmFk")], async () => {
      throw new Error("photon unavailable");
    });
    expect(result).toMatchObject({ dropped: 1, images: [] });
  });

  it("keeps the good images when only some fail, preserving their order", async () => {
    const flaky: Resizer = async (bytes) => {
      const data = Buffer.from(bytes).toString("base64");
      return data === "YmFk" ? null : { data, mimeType: "image/jpeg", wasResized: false };
    };
    const result = await fitImages([image("b25l"), image("YmFk"), image("dHdv")], flaky);
    expect(result.images.map((entry) => entry.data)).toEqual(["b25l", "dHdv"]);
    expect(result.dropped).toBe(1);
  });

  it("handles a message with no images", async () => {
    expect(await fitImages([], passthrough)).toEqual({ dropped: 0, images: [], resized: 0 });
  });
});

describe("droppedImageNote", () => {
  it("says nothing when every image made it", () => {
    expect(droppedImageNote(0)).toBe("");
  });

  it("names how many were lost, in the right number", () => {
    expect(droppedImageNote(1)).toBe("(1 image couldn't be included)");
    expect(droppedImageNote(3)).toBe("(3 images couldn't be included)");
  });
});
