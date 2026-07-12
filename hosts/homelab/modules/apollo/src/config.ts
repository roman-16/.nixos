import { homedir } from "node:os";
import { join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type ThinkingLevel = "high" | "low" | "max" | "medium" | "minimal" | "off" | "xhigh";

export interface Config {
  agentDir: string;
  allowFrom: string[];
  logLevel: string;
  maxMessageChars: number;
  model: string;
  port: number;
  sessionDir: string;
  systemPromptFile: string;
  thinkingLevel: ThinkingLevel;
  whatsappDir: string;
  workspace: string;
}

function digits(value: string): string {
  return value.replace(/\D/g, "");
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const home = env.HOME ?? homedir();
  const agentDir = getAgentDir();

  return {
    agentDir,
    allowFrom: (env.APOLLO_ALLOW_FROM ?? "").split(",").map(digits).filter(Boolean),
    logLevel: env.APOLLO_LOG_LEVEL ?? "info",
    maxMessageChars: Number(env.APOLLO_MAX_MESSAGE_CHARS ?? 4000),
    model: env.APOLLO_MODEL ?? "anthropic/claude-sonnet-5",
    port: Number(env.PORT ?? 8080),
    sessionDir: join(agentDir, "sessions"),
    systemPromptFile: join(agentDir, "SYSTEM_PROMPT.md"),
    thinkingLevel: (env.APOLLO_THINKING ?? "medium") as ThinkingLevel,
    whatsappDir: env.APOLLO_WHATSAPP_DIR ?? join(home, "whatsapp"),
    workspace: env.APOLLO_WORKSPACE ?? join(home, "workspace"),
  };
}
