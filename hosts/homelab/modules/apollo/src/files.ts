import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { extname, join } from "node:path";

/**
 * Where a file the user sends lands, and how long it stays there.
 *
 * A photograph is something Apollo can look at, so it rides in the conversation. A file is not: a
 * 40 MB archive has nothing to look at, and putting one anywhere near the context window would cost
 * every later turn. So a file goes to disk and the conversation carries its path, which is all the
 * agent needs - it has a shell.
 *
 * That disk cannot be any of the obvious places. `/tmp` is private to the unit and wiped on
 * restart, so yesterday's PDF would be gone. The working directory is a git repo pushed to a
 * private remote every three hours, where a binary blob stays for good. The database is snapshotted
 * to Drive every night, several copies deep. What is left is a directory of its own beside them,
 * inside the state directory that already survives restarts and deploys and is backed up by
 * nothing.
 *
 * Being backed up by nothing is what makes it a landing zone rather than an archive: files here
 * expire, and anything worth keeping is moved into the working directory or the vault - which is
 * the one rule the agent is told about a file every time it is handed one.
 *
 * A file is kept in a directory of its own, named after the message that brought it, holding the
 * file under the name the user gave it. Two scans called the same thing cannot collide, the name
 * survives intact for when it is sent back, and a message WhatsApp delivers twice writes to the
 * same place instead of leaving a second copy behind.
 */

/** A file that arrived with a message. `path` is unset when it never made it to disk. */
export interface ReceivedFile {
  mimeType: string;
  name: string;
  path?: string;
  /** Why it is not on this machine, when it is not. */
  problem?: string;
  size: number;
}

export interface FileStore {
  /** Forget everything received before this moment. Returns how many files went. */
  prune(before: number): number;
  /** Where this message's file belongs, with its directory made. */
  slot(waId: string, name: string): string;
}

const ID_CHARS = 12;

// Long enough for any name a person types, short enough to stay clear of the filesystem's own limit
// once the extension is added back.
const MAX_NAME_CHARS = 120;

// Path separators and control characters: everything that would let a name outside its directory,
// or make one that cannot be typed back.
const UNSAFE = /[\p{Cc}/\\]/gu;

/** The directory a message's file lives in: its message id, which is what makes this idempotent. */
export function fileId(waId: string): string {
  return createHash("sha256").update(waId).digest("hex").slice(0, ID_CHARS);
}

/** A name that is only a name: no directories to climb into, nothing unprintable, never empty. */
export function safeName(name: string, fallback = "file"): string {
  const cleaned = (name.split(/[/\\]/).pop() ?? "").replace(UNSAFE, "").replace(/^\.+/, "").trim();
  if (!cleaned) return fallback;
  if (cleaned.length <= MAX_NAME_CHARS) return cleaned;
  const extension = extname(cleaned).slice(0, 16);
  return cleaned.slice(0, MAX_NAME_CHARS - extension.length) + extension;
}

export function createFileStore(dir: string): FileStore {
  return {
    prune(before) {
      if (!existsSync(dir)) return 0;
      let removed = 0;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const holder = join(dir, entry.name);
        try {
          if (statSync(holder).mtimeMs >= before) continue;
          rmSync(holder, { force: true, recursive: true });
          removed += 1;
        } catch {
          // gone already, or being written to right now; the next sweep settles it
        }
      }
      return removed;
    },
    slot(waId, name) {
      const holder = join(dir, fileId(waId));
      mkdirSync(holder, { recursive: true });
      return join(holder, safeName(name));
    },
  };
}
