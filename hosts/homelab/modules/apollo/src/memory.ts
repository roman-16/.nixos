import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionFactory,
  ModelRuntime,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { Logger } from "pino";

import { splitInternal, splitUserContext } from "./messages";
import type { FoldReason } from "./memory-schedule";
import { shortStamp } from "./temporal";
import { condense } from "./tool-output";

/**
 * Apollo's durable memory: MEMORY.md at the root of the working directory, read fresh at the start
 * of every run and appended to the system prompt, and folded forward whenever the conversation goes
 * quiet.
 *
 * What the user is like does not belong in a compaction summary. A summary is lossy compression
 * applied over and over to its own output: every pass re-copies what came before, so a fact written
 * once decays through paraphrase while the evidence that could correct it is long gone. A file is
 * the opposite. It is rewritten deliberately, it can be corrected by hand, it is versioned with the
 * rest of the working directory, and it says the same thing on the hundredth read as on the first.
 *
 * Keeping it current is a separate job from summarizing, and a far cheaper one: what the two of them
 * actually said is a low single-digit percentage of the conversation by volume, the rest being tool
 * output, thinking and images. So the fold reads the WhatsApp-visible transcript alone, which is why
 * it can afford its own call, its own prompt and its own failure mode rather than riding along with
 * the summarizer and compromising both.
 */

/** Longest memory file that is injected whole. A valve against a pathological file, not a budget. */
const MAX_MEMORY_CHARS = 12000;

/** How much of one message the fold reads. Long enough for a paragraph, both ends of a wall of text. */
const MESSAGE_HEAD_CHARS = 1500;
const MESSAGE_TAIL_CHARS = 500;

/**
 * Ceiling on the fold's own reply. The reply is the whole file, so this has to clear the largest
 * portrait worth keeping with room to spare - a ceiling is not an allocation, and the cost of
 * setting it high is nothing, while the cost of hitting it is a truncated file.
 */
const MAX_FOLD_TOKENS = 16384;

/** A fold must not hang the maintenance tick, however unresponsive the provider is. */
const FOLD_TIMEOUT_MS = 60_000;

/** The block appended to the system prompt, in the same element vocabulary as the rest. */
export function memoryBlock(path: string, content: string): string {
  const body = content.trim();
  if (!body) return "";
  const kept = body.length > MAX_MEMORY_CHARS ? `${body.slice(0, MAX_MEMORY_CHARS)}\n…` : body;
  return `<memory path="${path}">\n${kept}\n</memory>`;
}

function read(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  } catch {
    return "";
  }
}

/** Inject MEMORY.md into every run, so editing the file is all it takes to change what Apollo knows. */
export function createMemoryExtension(path: string): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.on("before_agent_start", (event) => {
      const block = memoryBlock(path, read(path));
      return block ? { systemPrompt: `${event.systemPrompt}\n\n${block}` } : undefined;
    });
  };
}

export interface Evidence {
  /** How many visible messages made it in. */
  messages: number;
  /** Newest message time seen, whether or not it fitted; the cursor lands here. */
  newestMs: number;
  /** Whether older messages were left out because the window was full. */
  skippedOlder: boolean;
  text: string;
}

/** The plain text of a message's content: a bare string, or its text blocks joined. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return (content as { text?: string; type?: string }[])
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text!)
    .join("\n")
    .trim();
}

/**
 * The conversation as WhatsApp saw it, newer than `sinceMs`, oldest line last-written first.
 *
 * Only what was actually said is evidence about the user: thinking, tool calls, tool results and
 * images are machinery, and the messages the skills delivered are live data that is a command away.
 * When there is more than the window allows, the newest is kept, because a profile has to be current
 * and the archive still holds everything that was skipped.
 */
export function renderEvidence(
  entries: SessionEntry[],
  sinceMs: number,
  maxChars: number,
): Evidence {
  const lines: string[] = [];
  let used = 0;
  let newestMs = sinceMs;
  let skippedOlder = false;

  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]!;
    if (entry.type !== "message") continue;
    const at = Date.parse(entry.timestamp);
    if (Number.isNaN(at) || at <= sinceMs) continue;
    const message = entry.message as { content?: unknown; role?: string };
    let who: string;
    let said: string;
    if (message.role === "user") {
      who = "You";
      said = splitUserContext(textOf(message.content)).message.trim();
    } else if (message.role === "assistant") {
      who = "Apollo";
      said = splitInternal(textOf(message.content)).delivered;
    } else {
      continue;
    }
    if (at > newestMs) newestMs = at;
    if (!said) continue;
    const line = `[${shortStamp(new Date(at))}] ${who}: ${condense(said, MESSAGE_HEAD_CHARS, MESSAGE_TAIL_CHARS)}`;
    if (used + line.length > maxChars) {
      skippedOlder = true;
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }

  lines.reverse();
  return { messages: lines.length, newestMs, skippedOlder, text: lines.join("\n") };
}

/** Assemble the fold prompt: the doctrine with its size reading, the file, then what was said. */
export function buildFoldPrompt(args: {
  current: string;
  evidence: string;
  instructions: string;
  path: string;
}): string {
  const current = args.current.trim();
  const file = current
    ? `<memory path="${args.path}">\n${current}\n</memory>`
    : `<memory path="${args.path}" state="empty" />`;
  return `${args.instructions.trim()}\n\n${file}\n\n<conversation>\n${args.evidence.trim()}\n</conversation>`;
}

export type FoldOutput =
  | { content: string; kind: "content" }
  | { kind: "invalid"; reason: string }
  | { kind: "unchanged" };

const FENCE = /^```[^\n]*\n([\s\S]*?)\n?```$/;

/**
 * Read the fold's reply. Anything that isn't a file is refused rather than written: an empty answer
 * or a prose apology would otherwise wipe a profile that took months to learn. Shrinking is not
 * refused - a pass that halves the file is the mechanism working, and git keeps every version.
 */
export function readFoldOutput(raw: string): FoldOutput {
  let text = raw.trim();
  const fenced = FENCE.exec(text);
  if (fenced) text = fenced[1]!.trim();
  if (!text) return { kind: "invalid", reason: "empty reply" };
  if (/^unchanged[.!]?$/i.test(text)) return { kind: "unchanged" };
  const hasLine = text.split("\n").some((line) => /^\s*(#{1,6}\s|[-*]\s)/.test(line));
  if (!hasLine) return { kind: "invalid", reason: "no heading or bullet in the reply" };
  return { content: `${text}\n`, kind: "content" };
}

export interface MemoryFolderOptions {
  /** The session branch, newest last. */
  entries: () => SessionEntry[];
  evidenceMaxChars: number;
  logger: Logger;
  /** The live model, so a model switch carries over. */
  model: () => Model<Api> | undefined;
  modelRuntime: ModelRuntime;
  /** MEMORY.md. */
  path: string;
  /** MEMORY_PROMPT.md, read per fold so a reload picks up a new doctrine. */
  promptFile: string;
  /** How far memory has already been folded, in epoch ms. */
  readCursor: () => number;
  recordUsage?: (usage: Usage, model: string) => void;
  writeCursor: (at: number) => void;
}

export interface MemoryFolder {
  /** Fold everything said since the cursor into MEMORY.md. False means back off and retry later. */
  fold: (reason: FoldReason) => Promise<boolean>;
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

export function createMemoryFolder(options: MemoryFolderOptions): MemoryFolder {
  const { entries, evidenceMaxChars, logger, modelRuntime, path, promptFile } = options;

  return {
    async fold(reason) {
      const instructions = read(promptFile).trim();
      if (!instructions) {
        logger.debug({ promptFile }, "no memory prompt; not folding");
        return true;
      }
      const model = options.model();
      if (!model) return true;

      const cursor = options.readCursor();
      const evidence = renderEvidence(entries(), cursor, evidenceMaxChars);
      if (evidence.messages === 0) {
        // Nothing was said, so there is nothing to learn; move on rather than re-reading this span.
        options.writeCursor(Math.max(evidence.newestMs, cursor));
        return true;
      }

      const current = read(path);
      const prompt = buildFoldPrompt({
        current,
        evidence: evidence.text,
        instructions,
        path,
      });

      let reply;
      try {
        reply = await modelRuntime.complete(
          model,
          { messages: [{ content: prompt, role: "user", timestamp: Date.now() }] },
          { maxTokens: MAX_FOLD_TOKENS, signal: AbortSignal.timeout(FOLD_TIMEOUT_MS) },
        );
      } catch (error) {
        logger.warn({ error, reason }, "memory fold failed");
        return false;
      }
      if (reply.usage) options.recordUsage?.(reply.usage, model.id);
      // Every provider funnels a failed stream into a message with stopReason "error" rather than
      // throwing, so this is the only place a refused call shows up.
      if (reply.stopReason === "error") {
        logger.warn({ detail: reply.errorMessage, reason }, "memory fold failed");
        return false;
      }
      // The reply is the entire file, so one cut short is half a file - and writing half a file
      // would destroy the other half. Refuse it rather than trusting that it looks well-formed.
      if (reply.stopReason === "length") {
        logger.warn(
          { reason },
          "memory fold hit the reply ceiling; refusing to write a partial file",
        );
        return false;
      }

      const output = readFoldOutput(
        reply.content
          .filter((block): block is { text: string; type: "text" } => block.type === "text")
          .map((block) => block.text)
          .join("\n"),
      );
      if (output.kind === "invalid") {
        logger.warn({ reason, refused: output.reason }, "memory fold refused");
        return false;
      }
      if (output.kind === "unchanged" || output.content === current) {
        options.writeCursor(evidence.newestMs);
        // Declining to engage and engaging to conclude nothing moved look identical in the file and
        // mean opposite things about the doctrine, so the verdict says which one this was.
        logger.info(
          {
            chars: current.length,
            messages: evidence.messages,
            reason,
            verdict: output.kind === "unchanged" ? "declined" : "identical",
          },
          "memory unchanged",
        );
        return true;
      }
      // The cursor moves only once the new file is on disk, so a failed write leaves the evidence
      // owed rather than read and dropped.
      try {
        write(path, output.content);
      } catch (error) {
        logger.warn({ error, reason }, "memory write failed");
        return false;
      }
      options.writeCursor(evidence.newestMs);
      logger.info(
        {
          chars: output.content.length,
          from: current.length,
          messages: evidence.messages,
          reason,
          skippedOlder: evidence.skippedOlder,
        },
        "memory folded",
      );
      return true;
    },
  };
}
