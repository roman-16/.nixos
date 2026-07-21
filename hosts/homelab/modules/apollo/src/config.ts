import { homedir } from "node:os";
import { join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { type LogLevel, parseLevel } from "./logs";

export type ThinkingLevel = "high" | "low" | "max" | "medium" | "minimal" | "off" | "xhigh";

export interface Config {
  agentDir: string;
  allowFrom: string[];
  baileysLogLevel: string;
  compactionPromptFile: string;
  dayStartHour: number;
  dbPath: string;
  logLevel: string;
  logRetentionDays: number;
  maxMessageChars: number;
  mistralApiKey: string;
  model: string;
  notifyLevel: LogLevel;
  notifyThrottleMs: number;
  port: number;
  profilePicturePath: string;
  remindersDir: string;
  sessionDir: string;
  systemPromptFile: string;
  thinkingLevel: ThinkingLevel;
  transcribeModel: string;
  whatsappDir: string;
  workspace: string;
}

function digits(value: string): string {
  return value.replace(/\D/g, "");
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const home = env.HOME ?? homedir();
  const agentDir = getAgentDir();
  const workspace = env.APOLLO_WORKSPACE ?? join(home, "workspace");

  return {
    agentDir,
    allowFrom: (env.APOLLO_ALLOW_FROM ?? "").split(",").map(digits).filter(Boolean),
    baileysLogLevel: env.APOLLO_BAILEYS_LOG_LEVEL ?? "silent",
    compactionPromptFile: join(agentDir, "COMPACTION_PROMPT.md"),
    dayStartHour: Number(env.APOLLO_DAY_START_HOUR ?? 4),
    dbPath: env.APOLLO_DB_PATH ?? join(home, "apollo.sqlite"),
    logLevel: env.APOLLO_LOG_LEVEL ?? "info",
    logRetentionDays: Number(env.APOLLO_LOG_RETENTION_DAYS ?? 30),
    maxMessageChars: Number(env.APOLLO_MAX_MESSAGE_CHARS ?? 4000),
    mistralApiKey: env.MISTRAL_API_KEY ?? "",
    model: env.APOLLO_MODEL ?? "anthropic/claude-sonnet-5",
    notifyLevel: parseLevel(env.APOLLO_NOTIFY_LEVEL ?? "warn"),
    notifyThrottleMs: Number(env.APOLLO_NOTIFY_THROTTLE_MS ?? 60_000),
    port: Number(env.PORT ?? 8080),
    profilePicturePath: env.APOLLO_PROFILE_PICTURE ?? "",
    remindersDir: env.APOLLO_REMINDERS_DIR ?? join(workspace, "reminders"),
    sessionDir: join(agentDir, "sessions"),
    systemPromptFile: join(agentDir, "SYSTEM_PROMPT.md"),
    thinkingLevel: (env.APOLLO_THINKING ?? "medium") as ThinkingLevel,
    transcribeModel: env.APOLLO_TRANSCRIBE_MODEL ?? "voxtral-mini-latest",
    whatsappDir: env.APOLLO_WHATSAPP_DIR ?? join(home, "whatsapp"),
    workspace,
  };
}
