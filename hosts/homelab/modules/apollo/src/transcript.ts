import { open, stat } from "node:fs/promises";

import { tailLines } from "./chat";

const TAIL_CHUNK = 64 * 1024;

/**
 * The tail of a JSONL transcript: the last `count` complete lines, read by
 * seeking backward in chunks so cost is bounded by the window, never by the
 * full append-only session file. A partial leading line (from cutting mid-file)
 * is dropped by tailLines, which keeps only the last `count` non-empty lines.
 */
export async function readTail(file: string, count: number): Promise<string> {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    let pos = size;
    let newlines = 0;
    const parts: Buffer[] = [];
    while (pos > 0 && newlines <= count) {
      const from = Math.max(0, pos - TAIL_CHUNK);
      const buf = Buffer.alloc(pos - from);
      await handle.read(buf, 0, buf.length, from);
      for (const byte of buf) if (byte === 0x0a) newlines += 1;
      parts.unshift(buf);
      pos = from;
    }
    return tailLines(Buffer.concat(parts).toString("utf8"), count);
  } finally {
    await handle.close();
  }
}

export interface ImageBytes {
  bytes: Buffer;
  mimeType: string;
}

/** The Nth image block of a transcript JSONL line as raw bytes, or undefined. */
export function imageFromLine(line: string, index: number): ImageBytes | undefined {
  let content: unknown;
  try {
    content = (JSON.parse(line) as { message?: { content?: unknown } }).message?.content;
  } catch {
    return undefined;
  }
  if (!Array.isArray(content)) return undefined;
  let seen = 0;
  for (const block of content) {
    if (block?.type === "image" && typeof block.data === "string") {
      if (seen === index) {
        return {
          bytes: Buffer.from(block.data, "base64"),
          mimeType: typeof block.mimeType === "string" ? block.mimeType : "image/jpeg",
        };
      }
      seen += 1;
    }
  }
  return undefined;
}

interface LineRange {
  end: number;
  start: number;
}

interface TranscriptIndex {
  file: string;
  indexed: number;
  ranges: Map<string, LineRange>;
}

export interface MediaReader {
  readImage(file: string, id: string, index: number): Promise<ImageBytes | undefined>;
}

function recordLine(index: TranscriptIndex, buf: Buffer, start: number, end: number, base: number) {
  if (end <= start) return;
  let id: unknown;
  try {
    id = (JSON.parse(buf.subarray(start, end).toString("utf8")) as { id?: unknown }).id;
  } catch {
    return; // the session header or a half-written trailing line
  }
  if (typeof id === "string" && id) index.ranges.set(id, { end: base + end, start: base + start });
}

/**
 * Serves transcript images out-of-band. Maintains an incremental byte-offset
 * index (entry id -> line range) so a request reads only that one line, never
 * the whole file; the index appends as the append-only file grows and rebuilds
 * if the file changes or shrinks (a new session).
 */
export function createMediaReader(): MediaReader {
  let index: TranscriptIndex | undefined;

  async function ensureIndex(file: string): Promise<TranscriptIndex> {
    const { size } = await stat(file);
    if (!index || index.file !== file || size < index.indexed) {
      index = { file, indexed: 0, ranges: new Map() };
    }
    if (size <= index.indexed) return index;

    const handle = await open(file, "r");
    try {
      const from = index.indexed;
      const buf = Buffer.alloc(size - from);
      await handle.read(buf, 0, buf.length, from);
      let lineStart = 0;
      let lastNewline = -1;
      for (let i = 0; i < buf.length; i += 1) {
        if (buf[i] === 0x0a) {
          recordLine(index, buf, lineStart, i, from);
          lineStart = i + 1;
          lastNewline = i;
        }
      }
      // Index a trailing line that has no newline yet (the freshest entry) so its
      // image is servable immediately, but don't advance past it: it is re-read
      // and re-recorded once its newline lands.
      if (lineStart < buf.length) recordLine(index, buf, lineStart, buf.length, from);
      index.indexed = from + lastNewline + 1;
    } finally {
      await handle.close();
    }
    return index;
  }

  return {
    async readImage(file, id, imageIndex) {
      const idx = await ensureIndex(file);
      const range = idx.ranges.get(id);
      if (!range) return undefined;
      const handle = await open(file, "r");
      try {
        const buf = Buffer.alloc(range.end - range.start);
        await handle.read(buf, 0, buf.length, range.start);
        return imageFromLine(buf.toString("utf8"), imageIndex);
      } finally {
        await handle.close();
      }
    },
  };
}
