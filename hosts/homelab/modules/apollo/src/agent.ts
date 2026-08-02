import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { Logger } from "pino";

import { createCompactionExtension, type DeliveredMessage } from "./compaction";
import type { Config } from "./config";
import { createContextClearingExtension } from "./context-clearing";
import { createMemoryExtension } from "./memory";
import { createToolTimeoutExtension } from "./tool-timeout";

/** Read a prompt-override file if it exists (used for the system prompt and the compaction prompt). */
function readTextIfExists(file: string): string | undefined {
  return existsSync(file) ? readFileSync(file, "utf8") : undefined;
}

export interface ApolloSession {
  /** Models plus their resolved auth: the dashboard's Anthropic sign-in and status run through it. */
  modelRuntime: ModelRuntime;
  session: AgentSession;
}

/**
 * How Apollo compacts, asserted over whatever is on disk. It has to be re-applied after a reload,
 * which rebuilds settings from disk and drops in-memory overrides, so it lives here rather than at
 * either call site: two copies of a policy are one drift away from disagreeing.
 */
export function compactionSettings(config: Config): { enabled: boolean; keepRecentTokens: number } {
  return { enabled: true, keepRecentTokens: config.keepRecentTokens };
}

export interface ApolloSessionOptions {
  /** What the skills delivered to the user in a span, for the summarizer's evidence. */
  delivered?: (fromMs: number, toMs: number) => DeliveredMessage[];
}

/** Build the single, persistent, auto-compacting pi session Apollo talks to. */
export async function createApolloSession(
  config: Config,
  logger: Logger,
  options: ApolloSessionOptions = {},
): Promise<ApolloSession> {
  const modelRuntime = await ModelRuntime.create({
    authPath: join(config.agentDir, "auth.json"),
    modelsPath: join(config.agentDir, "models.json"),
  });

  const resolved = resolveCliModel({
    cliModel: config.model,
    cliThinking: config.thinkingLevel,
    modelRuntime,
  });
  if (resolved.error) throw new Error(`model "${config.model}": ${resolved.error}`);
  if (resolved.warning) console.warn(resolved.warning);

  const settingsManager = SettingsManager.create(config.workspace, config.agentDir);
  settingsManager.applyOverrides({ compaction: compactionSettings(config) });

  const compactionInstructions = readTextIfExists(config.compactionPromptFile);
  const extensionFactories = [
    { factory: createToolTimeoutExtension(), name: "apollo-tool-timeout" },
    { factory: createMemoryExtension(config.memoryFile), name: "apollo-memory" },
    {
      factory: createContextClearingExtension({
        gapMs: config.clearGapMs,
        minChars: config.clearMinChars,
      }),
      name: "apollo-context-clearing",
    },
    ...(compactionInstructions && resolved.model
      ? [
          {
            factory: createCompactionExtension({
              delivered: options.delivered,
              instructions: compactionInstructions,
              logger,
              model: resolved.model,
              modelRuntime,
            }),
            name: "apollo-compaction",
          },
        ]
      : []),
  ];
  const resourceLoader = new DefaultResourceLoader({
    agentDir: config.agentDir,
    cwd: config.workspace,
    extensionFactories,
    settingsManager,
    systemPromptOverride: () => readTextIfExists(config.systemPromptFile),
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    agentDir: config.agentDir,
    cwd: config.workspace,
    model: resolved.model,
    modelRuntime,
    resourceLoader,
    sessionManager: SessionManager.continueRecent(config.workspace, config.sessionDir),
    settingsManager,
    thinkingLevel: resolved.thinkingLevel ?? config.thinkingLevel,
  });
  return { modelRuntime, session };
}

/** Fire `onText` the instant a normal assistant text block completes (skips thinking/tool output). */
export function onAssistantText(session: AgentSession, onText: (text: string) => void): () => void {
  return session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_end") {
      const content = event.assistantMessageEvent.content.trim();
      if (content) onText(content);
    }
  });
}

/**
 * The errorMessage of a run that ended in a terminal LLM error, else undefined. Every pi
 * provider funnels a failed stream to a final assistant message with stopReason "error"
 * (never a thrown rejection), so this is how any Claude/transport error surfaces. Filters
 * to the terminal `agent_end` (willRetry false, after pi's built-in retries) and skips
 * "aborted" (an intentional stop), so it fires once per genuinely failed turn.
 */
export function terminalErrorMessage(event: AgentSessionEvent): string | undefined {
  if (event.type !== "agent_end" || event.willRetry) return undefined;
  for (let i = event.messages.length - 1; i >= 0; i -= 1) {
    const message = event.messages[i];
    if (message?.role === "assistant") {
      return message.stopReason === "error" ? (message.errorMessage ?? "unknown error") : undefined;
    }
  }
  return undefined;
}

/** Fire `onError` when a run ends in a terminal LLM error (after pi's retries are exhausted). */
export function onRunError(session: AgentSession, onError: (detail: string) => void): () => void {
  return session.subscribe((event) => {
    const detail = terminalErrorMessage(event);
    if (detail) onError(detail);
  });
}

/** Send a user message into the session, queueing as a follow-up if a run is already streaming. */
export async function deliver(
  session: AgentSession,
  text: string,
  images: ImageContent[],
): Promise<void> {
  const base = images.length > 0 ? { images } : {};
  await (session.isStreaming
    ? session.prompt(text, { ...base, streamingBehavior: "followUp" })
    : session.prompt(text, base));
}
