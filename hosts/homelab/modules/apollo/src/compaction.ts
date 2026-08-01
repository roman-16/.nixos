import type { Api, Model } from "@earendil-works/pi-ai";
import {
  convertToLlm,
  type ExtensionAPI,
  type ExtensionFactory,
  type ModelRuntime,
  serializeConversation,
} from "@earendil-works/pi-coding-agent";
import type { Logger } from "pino";

const MAX_SUMMARY_TOKENS = 8192;

export interface CompactionExtensionOptions {
  instructions: string;
  logger: Logger;
  model: Model<Api>;
  modelRuntime: ModelRuntime;
}

/** Assemble the summarization prompt: instructions, the previous summary (if any), then the conversation. */
export function buildCompactionPrompt(args: {
  conversation: string;
  instructions: string;
  previousSummary?: string;
}): string {
  const previous = args.previousSummary?.trim()
    ? `\n\n<previous-summary>\n${args.previousSummary.trim()}\n</previous-summary>`
    : "";
  return `${args.instructions.trim()}${previous}\n\n<conversation>\n${args.conversation}\n</conversation>`;
}

/**
 * Extension that summarizes both auto- and manual compaction with Apollo's own prompt
 * (COMPACTION_PROMPT.md), applied via the session_before_compact hook. Any failure returns
 * undefined, so pi falls back to its built-in compaction and the session is never left
 * uncompacted.
 */
export function createCompactionExtension(options: CompactionExtensionOptions): ExtensionFactory {
  const { instructions, logger, model, modelRuntime } = options;
  return (pi: ExtensionAPI) => {
    pi.on("session_before_compact", async (event) => {
      const { preparation, signal } = event;
      const messages = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
      if (messages.length === 0) return undefined;

      try {
        const prompt = buildCompactionPrompt({
          conversation: serializeConversation(convertToLlm(messages)),
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
