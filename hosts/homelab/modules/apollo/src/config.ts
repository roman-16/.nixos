import { homedir } from "node:os";
import { join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { type LogLevel, parseLevel } from "./logs";

export type ThinkingLevel = "high" | "low" | "max" | "medium" | "minimal" | "off" | "xhigh";

export interface Config {
  agentDir: string;
  allowFrom: string[];
  backlogMax: number;
  baileysLogLevel: string;
  clearGapMs: number;
  clearMinChars: number;
  compactAtTokens: number;
  compactIdleMs: number;
  compactNightlyTokens: number;
  compactionPromptFile: string;
  dayStartHour: number;
  dbPath: string;
  inboxRetentionDays: number;
  keepRecentTokens: number;
  linkGraceMs: number;
  logLevel: string;
  logRetentionDays: number;
  maxMessageChars: number;
  memoryFile: string;
  mistralApiKey: string;
  model: string;
  notifyLevel: LogLevel;
  notifyThrottleMs: number;
  port: number;
  profilePicturePath: string;
  remindersDir: string;
  sessionDir: string;
  staleMs: number;
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
    // How many owed messages one catch-up turn carries; the rest follow in the next turn.
    backlogMax: Number(env.APOLLO_BACKLOG_MAX ?? 60),
    baileysLogLevel: env.APOLLO_BAILEYS_LOG_LEVEL ?? "silent",
    // Silence that ends a burst, after which its tool output and images are cleared from the view
    // sent to the model. At or above the prompt cache's TTL, so the view only changes once the
    // cache it would invalidate has expired anyway.
    clearGapMs: Number(env.APOLLO_CLEAR_GAP_MS ?? 60 * 60_000),
    clearMinChars: Number(env.APOLLO_CLEAR_MIN_CHARS ?? 500),
    // Context size that is no longer worth carrying into the next burst.
    compactAtTokens: Number(env.APOLLO_COMPACT_AT_TOKENS ?? 256_000),
    // Quiet before compacting, so it never lands mid-conversation.
    compactIdleMs: Number(env.APOLLO_COMPACT_IDLE_MS ?? 8 * 60_000),
    // Floor below which starting a new day isn't worth a summarization call.
    compactNightlyTokens: Number(env.APOLLO_COMPACT_NIGHTLY_TOKENS ?? 64_000),
    compactionPromptFile: join(agentDir, "COMPACTION_PROMPT.md"),
    dayStartHour: Number(env.APOLLO_DAY_START_HOUR ?? 4),
    dbPath: env.APOLLO_DB_PATH ?? join(home, "apollo.sqlite"),
    inboxRetentionDays: Number(env.APOLLO_INBOX_RETENTION_DAYS ?? 30),
    // The tail compaction leaves verbatim. Everything older is what the summary has to carry, so
    // this is the line between what Apollo still has in its own words and what it has as a note.
    keepRecentTokens: Number(env.APOLLO_KEEP_RECENT_TOKENS ?? 16_000),
    // How long the WhatsApp link may be down before /health reports the service unhealthy (so the
    // status page goes red) and the user is told about the gap on reconnect.
    linkGraceMs: Number(env.APOLLO_LINK_GRACE_MS ?? 10 * 60_000),
    logLevel: env.APOLLO_LOG_LEVEL ?? "info",
    logRetentionDays: Number(env.APOLLO_LOG_RETENTION_DAYS ?? 30),
    maxMessageChars: Number(env.APOLLO_MAX_MESSAGE_CHARS ?? 4000),
    memoryFile: env.APOLLO_MEMORY_FILE ?? join(workspace, "MEMORY.md"),
    mistralApiKey: env.MISTRAL_API_KEY ?? "",
    model: env.APOLLO_MODEL ?? "anthropic/claude-sonnet-5",
    notifyLevel: parseLevel(env.APOLLO_NOTIFY_LEVEL ?? "warn"),
    notifyThrottleMs: Number(env.APOLLO_NOTIFY_THROTTLE_MS ?? 60_000),
    port: Number(env.PORT ?? 8080),
    profilePicturePath: env.APOLLO_PROFILE_PICTURE ?? "",
    remindersDir: env.APOLLO_REMINDERS_DIR ?? join(workspace, "reminders"),
    sessionDir: join(agentDir, "sessions"),
    // Delay past which a message counts as late rather than live, and its turn says so.
    staleMs: Number(env.APOLLO_STALE_MS ?? 2 * 60_000),
    systemPromptFile: join(agentDir, "SYSTEM_PROMPT.md"),
    thinkingLevel: (env.APOLLO_THINKING ?? "medium") as ThinkingLevel,
    transcribeModel: env.APOLLO_TRANSCRIBE_MODEL ?? "voxtral-mini-latest",
    whatsappDir: env.APOLLO_WHATSAPP_DIR ?? join(home, "whatsapp"),
    workspace,
  };
}
