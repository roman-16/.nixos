import type { Api, Model } from "@earendil-works/pi-ai";
import {
  convertToLlm,
  type ExtensionAPI,
  type ExtensionFactory,
  type ModelRuntime,
  serializeConversation,
} from "@earendil-works/pi-coding-agent";
import type { Logger } from "pino";

import { condense } from "./tool-output";

const MAX_SUMMARY_TOKENS = 8192;

// pi truncates every tool result to 2000 characters when it serializes a conversation, keeping the
// head. For Apollo that is the wrong half: a macros command prints the whole day after every entry,
// so the head shows the day part-built and the tail shows how it ended. Reading only the head is
// what produced a summary claiming a day still needed logging ten minutes after it was logged.
// Condensing to just under pi's limit keeps both ends and leaves its truncation nothing to do.
const TOOL_HEAD_CHARS = 700;
const TOOL_TAIL_CHARS = 1100;

/** A message Apollo's skills delivered to the user themselves, outside the model's own turns. */
export interface DeliveredMessage {
  at: number;
  source: string;
  text: string;
}

export interface CompactionExtensionOptions {
  /** What the skills sent the user during a span; the model's turns alone do not show it. */
  delivered?: (fromMs: number, toMs: number) => DeliveredMessage[];
  instructions: string;
  logger: Logger;
  model: Model<Api>;
  modelRuntime: ModelRuntime;
}

function clock(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** Keep both ends of every tool result, so the outcome of a command survives into the summary. */
export function condenseToolResults<T extends { content?: unknown; role?: string }>(
  messages: T[],
): T[] {
  return messages.map((message) => {
    if (message.role !== "toolResult" || !Array.isArray(message.content)) return message;
    return {
      ...message,
      content: (message.content as { text?: string; type?: string }[]).map((block) =>
        block?.type === "text" && typeof block.text === "string"
          ? { ...block, text: condense(block.text, TOOL_HEAD_CHARS, TOOL_TAIL_CHARS) }
          : block,
      ),
    };
  });
}

/**
 * The skill messages of a span, as a ledger of what actually reached the user. It is an index, not
 * a second copy: each line is clipped hard, because its job is to establish that something was
 * delivered and roughly what - the detail is in the tool results, and for a fired reminder there is
 * no tool result at all, which is exactly the blind spot this closes.
 */
export function deliveredLedger(delivered: DeliveredMessage[]): string {
  if (delivered.length === 0) return "";
  const lines = delivered.map(
    ({ at, source, text }) =>
      `[${clock(at)}] via ${source}: ${condense(text.replace(/\s+/g, " ").trim(), 90, 40)}`,
  );
  return `<delivered>\n${lines.join("\n")}\n</delivered>`;
}

/** Assemble the summarization prompt: instructions, the previous summary, what was delivered, then the conversation. */
export function buildCompactionPrompt(args: {
  conversation: string;
  delivered?: string;
  instructions: string;
  previousSummary?: string;
}): string {
  const previous = args.previousSummary?.trim()
    ? `\n\n<previous-summary>\n${args.previousSummary.trim()}\n</previous-summary>`
    : "";
  const delivered = args.delivered?.trim() ? `\n\n${args.delivered.trim()}` : "";
  return `${args.instructions.trim()}${previous}${delivered}\n\n<conversation>\n${args.conversation}\n</conversation>`;
}

/** The span the messages cover, for looking up what was delivered alongside them. */
function span(messages: { timestamp?: number }[]): { from: number; to: number } {
  const stamps = messages
    .map((m) => m.timestamp)
    .filter((t): t is number => typeof t === "number" && t > 0);
  return { from: Math.min(...stamps, Infinity), to: Math.max(...stamps, 0) };
}

/**
 * Extension that summarizes both auto- and manual compaction with Apollo's own prompt
 * (COMPACTION_PROMPT.md), applied via the session_before_compact hook. Any failure returns
 * undefined, so pi falls back to its built-in compaction and the session is never left
 * uncompacted.
 */
export function createCompactionExtension(options: CompactionExtensionOptions): ExtensionFactory {
  const { delivered, instructions, logger, model, modelRuntime } = options;
  return (pi: ExtensionAPI) => {
    pi.on("session_before_compact", async (event) => {
      const { preparation, signal } = event;
      const messages = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
      if (messages.length === 0) return undefined;

      try {
        const { from, to } = span(messages);
        const prompt = buildCompactionPrompt({
          conversation: serializeConversation(condenseToolResults(convertToLlm(messages))),
          delivered:
            delivered && Number.isFinite(from) ? deliveredLedger(delivered(from, to)) : undefined,
          instructions,
          previousSummary: preparation.previousSummary,
        });
        // The runtime resolves (and refreshes) the model's auth itself, so a credential problem
        // surfaces as a throw and lands in the fallback below like any other failure.
        const response = await modelRuntime.complete(
          model,
          { messages: [{ content: prompt, role: "user", timestamp: Date.now() }] },
          { maxTokens: MAX_SUMMARY_TOKENS, signal },
        );
        const summary = response.content
          .filter((block): block is { text: string; type: "text" } => block.type === "text")
          .map((block) => block.text)
          .join("\n")
          .trim();
        if (!summary) return undefined;
        return {
          compaction: {
            firstKeptEntryId: preparation.firstKeptEntryId,
            summary,
            tokensBefore: preparation.tokensBefore,
          },
        };
      } catch (error) {
        if (!signal.aborted) {
          logger.error({ err: error }, "custom compaction failed; using default compaction");
        }
        return undefined;
      }
    });
  };
}
