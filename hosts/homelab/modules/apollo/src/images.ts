import type { ImageContent } from "@earendil-works/pi-ai";

/**
 * WhatsApp hands over photos at full phone resolution, and a vision model rejects a request carrying
 * many images if any one of them exceeds the size it accepts. That failure is not local to the
 * offending message: once such an image sits in the conversation, every later turn that still
 * carries it is rejected too, so a single oversized photo can silently take the assistant down until
 * the context is compacted away.
 *
 * So images are fitted once, on the way in, before they are stored - what the inbox holds is exactly
 * what the model will accept. An image that cannot be made acceptable is dropped rather than kept,
 * because keeping it would cost every future turn, while dropping it costs only its own.
 */

export interface FittedImage {
  data: string;
  mimeType: string;
  /** Whether the image had to be re-encoded; an image already within limits passes through as-is. */
  wasResized: boolean;
}

/** Fits an image within the model's limits, or returns null when it cannot. */
export type Resizer = (bytes: Uint8Array, mimeType: string) => Promise<FittedImage | null>;

export interface FitResult {
  dropped: number;
  images: ImageContent[];
  resized: number;
}

export async function fitImages(images: ImageContent[], resize: Resizer): Promise<FitResult> {
  const fitted: ImageContent[] = [];
  let dropped = 0;
  let resized = 0;
  for (const image of images) {
    let result: FittedImage | null = null;
    try {
      result = await resize(Buffer.from(image.data, "base64"), image.mimeType);
    } catch {
      result = null;
    }
    if (!result) {
      dropped += 1;
      continue;
    }
    if (result.wasResized) resized += 1;
    fitted.push({ data: result.data, mimeType: result.mimeType, type: "image" });
  }
  return { dropped, images: fitted, resized };
}

/** How a message says that some of its images could not be carried, so the agent can ask about them. */
export function droppedImageNote(dropped: number): string {
  return dropped > 0 ? `(${dropped} image${dropped === 1 ? "" : "s"} couldn't be included)` : "";
}
