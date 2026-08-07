import type { ImageContent } from "@earendil-works/pi-ai";

/**
 * Preparing a file on disk to be sent as a WhatsApp photo.
 *
 * WhatsApp wants three things besides the bytes: what kind of image it is, how large it is, and a
 * small preview to show in the bubble before the full image has downloaded. Baileys can work the
 * last two out itself, but only through an image library this machine deliberately does not carry,
 * so they are worked out here with ImageMagick - which the agent already has - and handed over
 * ready-made. A message that arrives with its preview and its dimensions lays out correctly the
 * instant it appears, rather than as a grey box that resizes once the download finishes.
 *
 * A file that cannot be sent is rejected here, before anything is uploaded, because the sender is
 * the one who can fix it.
 */

/** Above this WhatsApp refuses the upload, so there is no point spending one. */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/** How wide the preview is. It rides inside the message itself, so it stays a few kilobytes. */
const THUMBNAIL_WIDTH = 72;

const MIME_BY_FORMAT: Record<string, string> = {
  GIF: "image/gif",
  JPEG: "image/jpeg",
  PNG: "image/png",
  WEBP: "image/webp",
};

export interface Identity {
  format: string;
  height: number;
  width: number;
}

export interface Attachment {
  bytes: Buffer;
  height: number;
  mimeType: string;
  /** Base64 JPEG preview, or undefined when one could not be made (the image still sends). */
  thumbnail?: string;
  width: number;
}

/** What ImageMagick says a file is, from `%m %w %h`: `PNG 1000 618`. */
export function readIdentity(output: string): Identity | undefined {
  const [format, width, height] = output.trim().split(/\s+/);
  if (!format || !width || !height) return undefined;
  const w = Number(width);
  const h = Number(height);
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) return undefined;
  return { format: format.toUpperCase(), height: h, width: w };
}

export function mimeForFormat(format: string): string | undefined {
  return MIME_BY_FORMAT[format.toUpperCase()];
}

/** Why this file cannot be sent as a photo, in words the sender can act on, or undefined. */
export function attachmentProblem(
  size: number,
  identity: Identity | undefined,
): string | undefined {
  if (size === 0) return "the file is empty";
  if (size > MAX_ATTACHMENT_BYTES) {
    return `the file is ${(size / 1024 / 1024).toFixed(1)} MB, and WhatsApp takes at most ${
      MAX_ATTACHMENT_BYTES / 1024 / 1024
    } MB`;
  }
  if (!identity) return "that file is not an image";
  if (!mimeForFormat(identity.format)) {
    return `${identity.format} is not a format WhatsApp shows as a photo (use PNG, JPEG, WEBP or GIF)`;
  }
  return undefined;
}

/** How an attachment is kept in the chat archive: the same block shape an inbound image uses. */
export function imageBlock(attachment: Attachment): ImageContent {
  return {
    data: attachment.bytes.toString("base64"),
    mimeType: attachment.mimeType,
    type: "image",
  };
}

/** Run ImageMagick, returning its stdout, or undefined when it could not do the job. */
async function magick(args: string[]): Promise<Buffer | undefined> {
  try {
    const proc = Bun.spawn(["magick", ...args], { stderr: "pipe", stdout: "pipe" });
    const [out, , exitCode] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return exitCode === 0 ? Buffer.from(out) : undefined;
  } catch {
    return undefined;
  }
}

/** Read an image and everything WhatsApp needs to display it. Throws with the reason it cannot. */
export async function loadAttachment(path: string): Promise<Attachment> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`there is no file at ${path}`);
  const bytes = Buffer.from(await file.arrayBuffer());
  // The first frame only, so an animation identifies as one image rather than as a list of them.
  const frame = `${path}[0]`;
  const identity = readIdentity(
    (await magick(["identify", "-format", "%m %w %h", frame]))?.toString() ?? "",
  );
  const problem = attachmentProblem(bytes.length, identity);
  if (problem) throw new Error(problem);
  // A missing preview costs a grey bubble until the image downloads, which is not worth failing a
  // send over.
  const thumbnail = await magick([
    frame,
    "-resize",
    `${THUMBNAIL_WIDTH}x`,
    "-quality",
    "50",
    "jpeg:-",
  ]);
  return {
    bytes,
    height: identity!.height,
    mimeType: mimeForFormat(identity!.format)!,
    thumbnail: thumbnail?.toString("base64"),
    width: identity!.width,
  };
}
