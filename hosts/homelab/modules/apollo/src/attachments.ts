import { statSync } from "node:fs";
import { basename } from "node:path";

import type { ImageContent } from "@earendil-works/pi-ai";

import { humanBytes } from "./format";

/**
 * Preparing something on disk to ride out on a WhatsApp message.
 *
 * Two things can: a picture, which arrives in the bubble and is looked at, and a file, which
 * arrives as something to keep and open elsewhere. They are the same act from here - put this in
 * front of the user - and different messages on the wire, so they are one type with two shapes.
 *
 * A picture is read into memory, because WhatsApp wants three things besides the bytes: what kind
 * of image it is, how large it is, and a small preview for the bubble to show while the full image
 * downloads. Baileys can work the last two out itself, but only through an image library this
 * machine deliberately does not carry, so they are worked out here with ImageMagick - which the
 * agent already has - and handed over ready-made.
 *
 * A file stays a path. Nothing here needs to look inside it, and a hundred megabytes read into
 * memory to be handed straight back out would be a hundred megabytes wasted, so only its name, size
 * and type are read and the bytes are streamed off disk when the message is sent.
 *
 * Either way, something that cannot be sent is refused here, before an upload is spent on it,
 * because the sender is the one who can fix it.
 */

/** Above this WhatsApp refuses a photo, so there is no point spending an upload. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** How wide the preview is. It rides inside the message itself, so it stays a few kilobytes. */
const THUMBNAIL_WIDTH = 72;

/** What a file claims to be when nothing on this machine can tell. */
const UNKNOWN_MIME = "application/octet-stream";

// What an answer has to look like to be a media type at all. `file` reports what it cannot read on
// stdout and still exits 0, and "cannot open `x' (No such file or directory)" holds a slash too.
const MIME = /^[\w.+-]+\/[\w.+-]+$/;

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

export interface ImageAttachment {
  bytes: Buffer;
  height: number;
  kind: "image";
  mimeType: string;
  /** Base64 JPEG preview, or undefined when one could not be made (the image still sends). */
  thumbnail?: string;
  width: number;
}

export interface FileAttachment {
  kind: "file";
  mimeType: string;
  name: string;
  path: string;
  size: number;
}

export type Attachment = FileAttachment | ImageAttachment;

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
export function imageProblem(size: number, identity: Identity | undefined): string | undefined {
  if (size === 0) return "the file is empty";
  if (size > MAX_IMAGE_BYTES) {
    return `the file is ${humanBytes(size)}, and WhatsApp takes photos up to ${humanBytes(
      MAX_IMAGE_BYTES,
    )}`;
  }
  if (!identity) return "that file is not an image";
  if (!mimeForFormat(identity.format)) {
    return `${identity.format} is not a format WhatsApp shows as a photo (use PNG, JPEG, WEBP or GIF)`;
  }
  return undefined;
}

/** Why this file cannot be sent at all, or undefined. */
export function fileProblem(size: number, maxBytes: number): string | undefined {
  if (size === 0) return "the file is empty";
  if (size > maxBytes) {
    return `the file is ${humanBytes(size)}, and I only send files up to ${humanBytes(maxBytes)}`;
  }
  return undefined;
}

/** How a picture is kept in the chat archive: the same block shape an inbound image uses. */
export function imageBlock(attachment: ImageAttachment): ImageContent {
  return {
    data: attachment.bytes.toString("base64"),
    mimeType: attachment.mimeType,
    type: "image",
  };
}

/** Run a command, returning its stdout, or undefined when it could not do the job. */
async function capture(args: string[]): Promise<Buffer | undefined> {
  try {
    const proc = Bun.spawn(args, { stderr: "pipe", stdout: "pipe" });
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

/** What a file actually is, whatever it is named. Unknown is a fine answer - WhatsApp needs one. */
export async function sniffMime(path: string): Promise<string> {
  const out = (await capture(["file", "--brief", "--mime-type", path]))?.toString().trim();
  return out && MIME.test(out) ? out : UNKNOWN_MIME;
}

/** Read an image and everything WhatsApp needs to display it. Throws with the reason it cannot. */
export async function loadImage(path: string): Promise<ImageAttachment> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`there is no file at ${path}`);
  const bytes = Buffer.from(await file.arrayBuffer());
  // The first frame only, so an animation identifies as one image rather than as a list of them.
  const frame = `${path}[0]`;
  const identity = readIdentity(
    (await capture(["magick", "identify", "-format", "%m %w %h", frame]))?.toString() ?? "",
  );
  const problem = imageProblem(bytes.length, identity);
  if (problem) throw new Error(problem);
  // A missing preview costs a grey bubble until the image downloads, which is not worth failing a
  // send over.
  const thumbnail = await capture([
    "magick",
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
    kind: "image",
    mimeType: mimeForFormat(identity!.format)!,
    thumbnail: thumbnail?.toString("base64"),
    width: identity!.width,
  };
}

/** Read what WhatsApp needs to send a file, without reading the file. Throws its reason. */
export async function loadFile(path: string, maxBytes: number): Promise<FileAttachment> {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    throw new Error(`there is no file at ${path}`);
  }
  if (stat.isDirectory()) throw new Error(`${path} is a directory - send a file, or zip it first`);
  const problem = fileProblem(stat.size, maxBytes);
  if (problem) throw new Error(problem);
  return {
    kind: "file",
    mimeType: await sniffMime(path),
    name: basename(path),
    path,
    size: stat.size,
  };
}
