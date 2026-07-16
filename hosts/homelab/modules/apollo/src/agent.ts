import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  type AgentSession,
  type AgentSessionEvent,
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  resolveCliModel,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { Logger } from "pino";

import { createCompactionExtension } from "./compaction";
import type { Config } from "./config";
import { createToolTimeoutExtension } from "./tool-timeout";

/** Read a prompt-override file if it exists (used for the system prompt and the compaction prompt). */
function readTextIfExists(file: string): string | undefined {
  return existsSync(file) ? readFileSync(file, "utf8") : undefined;
}

export interface ApolloSession {
  /** Credential store for reading/setting the Anthropic OAuth token. */
  authStorage: AuthStorage;
  session: AgentSession;
}

/** Build the single, persistent, auto-compacting pi session Apollo talks to. */
export async function createApolloSession(config: Config, logger: Logger): Promise<ApolloSession> {
  const authStorage = AuthStorage.create(join(config.agentDir, "auth.json"));
  const modelRegistry = ModelRegistry.create(authStorage, join(config.agentDir, "models.json"));

  const resolved = resolveCliModel({
    cliModel: config.model,
    cliThinking: config.thinkingLevel,
    modelRegistry,
  });
  if (resolved.error) throw new Error(`model "${config.model}": ${resolved.error}`);
  if (resolved.warning) console.warn(resolved.warning);

  const settingsManager = SettingsManager.create(config.workspace, config.agentDir);
  settingsManager.applyOverrides({ compaction: { enabled: true } });

  const compactionInstructions = readTextIfExists(config.compactionPromptFile);
  const extensionFactories = [
    { factory: createToolTimeoutExtension(), name: "apollo-tool-timeout" },
    ...(compactionInstructions && resolved.model
      ? [
          {
            factory: createCompactionExtension({
              instructions: compactionInstructions,
              logger,
              model: resolved.model,
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
    authStorage,
    cwd: config.workspace,
    model: resolved.model,
    modelRegistry,
    resourceLoader,
    sessionManager: SessionManager.continueRecent(config.workspace, config.sessionDir),
    settingsManager,
    thinkingLevel: resolved.thinkingLevel ?? config.thinkingLevel,
  });
  return { authStorage, session };
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
