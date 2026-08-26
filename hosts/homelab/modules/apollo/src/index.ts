import type { Usage } from "@earendil-works/pi-ai";
import { pino } from "pino";

import { createApolloSession, createModelRuntime } from "./agent";
import { createCredentials } from "./credentials";
import { runWorkspaceBackup } from "./backup";
import { createChatStore } from "./chat-store";
import { loadConfig } from "./config";
import { openDatabase } from "./db";
import { createFileStore } from "./files";
import { createInbox } from "./inbox";
import { createKv } from "./kv";
import { createLogStore } from "./logs";
import { createMemoryFolder } from "./memory";
import { createPipeline } from "./pipeline";
import { createReminderWatcher, formatReminder } from "./reminders";
import { startServer } from "./server";
import { createTokenStore } from "./tokens";
import { startWhatsApp } from "./whatsapp";

const HOUR_MS = 60 * 60 * 1000;

/** How far the memory fold has read the conversation, in message time. */
const MEMORY_CURSOR_KEY = "memoryFoldedUpTo";

/** Wire the whole app together: config, storage, the pi session, the WhatsApp pipeline, and the dashboard. */
export async function main(): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  const chatStore = createChatStore(db);
  const logStore = createLogStore(db);
  const tokenStore = createTokenStore(db);
  const kv = createKv(db);
  const logger = pino({ level: config.logLevel }, logStore.stream);

  const logRetentionMs = config.logRetentionDays * 24 * HOUR_MS;
  const inboxRetentionMs = config.inboxRetentionDays * 24 * HOUR_MS;
  const fileRetentionMs = config.fileRetentionDays * 24 * HOUR_MS;
  // The inbox remembers message ids exactly as long as it keeps their rows, so one window governs
  // both what it prunes and how old a message may be and still count as unseen.
  const inbox = createInbox(db, inboxRetentionMs);
  const fileStore = createFileStore(config.fileDir);

  const prune = () => {
    logStore.prune(Date.now() - logRetentionMs);
    inbox.prune(Date.now() - inboxRetentionMs);
    const files = fileStore.prune(Date.now() - fileRetentionMs);
    if (files > 0) logger.info({ files }, "pruned received files past their retention");
  };
  prune();
  setInterval(prune, HOUR_MS);

  if (config.allowFrom.length === 0) {
    logger.warn("APOLLO_ALLOW_FROM is empty; every inbound message will be ignored");
  }

  // Every call the app makes is booked here: the turns, and the maintenance work (summarizing and
  // memory folding) that would otherwise be spent without ever showing up on the dashboard.
  const recordUsage = (usage: Usage, model: string) => {
    try {
      tokenStore.record(usage, model, Date.now());
    } catch (error) {
      logger.error({ error }, "token usage record failed");
    }
  };

  const modelRuntime = await createModelRuntime(config);
  const credentials = createCredentials(modelRuntime, kv);
  // Prove the credential at startup rather than inheriting the assumption that it still works: a
  // credential that died while Apollo was down would otherwise read as connected until the first
  // message spent itself discovering otherwise. Not awaited, so a slow provider cannot keep the
  // assistant off WhatsApp.
  void credentials.token();

  const session = await createApolloSession(config, logger, modelRuntime, {
    delivered: (fromMs, toMs) => chatStore.skillMessagesBetween(session.sessionId, fromMs, toMs),
    observe: credentials.observe,
    recordUsage,
  });
  logger.info({ model: config.model, workspace: config.workspace }, "pi session ready");

  const memory = createMemoryFolder({
    entries: () => session.sessionManager.getBranch(),
    evidenceMaxChars: config.memoryEvidenceMaxChars,
    logger,
    model: () => session.model,
    modelRuntime,
    observe: credentials.observe,
    path: config.memoryFile,
    promptFile: config.memoryPromptFile,
    readCursor: () => Number(kv.get(MEMORY_CURSOR_KEY) ?? 0),
    recordUsage,
    writeCursor: (at) => kv.set(MEMORY_CURSOR_KEY, String(at)),
  });

  const pipeline = createPipeline({
    credentials,
    chatStore,
    config,
    inbox,
    kv,
    logStore,
    logger,
    memory,
    session,
  });

  // Mirror the pi session's entries into SQLite - the dashboard's source of truth. Seed from
  // the resumed session, then keep it current by diffing getEntries() after pi persists.
  // Listeners fire before persistence, so a short debounce lets the just-appended entry land
  // first (and coalesces streaming bursts); the 2s dashboard poll is far slower, so nothing
  // perceptible lags.
  const mirror = () => {
    try {
      chatStore.sync(session.sessionId, session.sessionManager.getEntries());
    } catch (error) {
      logger.error({ error }, "chat mirror failed");
    }
  };
  mirror();
  let mirrorTimer: ReturnType<typeof setTimeout> | undefined;

  session.subscribe((event) => {
    mirrorTimer ??= setTimeout(() => {
      mirrorTimer = undefined;
      mirror();
    }, 150);
    // Record every assistant turn's token usage for the dashboard's token accounting.
    if (event.type === "turn_end" && event.message.role === "assistant") {
      recordUsage(event.message.usage, event.message.model);
    }
  });

  const whatsapp = await startWhatsApp({
    baileysLogLevel: config.baileysLogLevel,
    fileStore,
    logger,
    maxChars: config.maxMessageChars,
    maxFileBytes: config.maxFileBytes,
    onConnect: () => pipeline.handleConnect(),
    onMessages: (messages) => pipeline.handleInbound(messages),
    whatsappDir: config.whatsappDir,
  });
  pipeline.attach(whatsapp);

  // Fire reminders exactly at their time; a failed delivery rejects so the watcher retries.
  createReminderWatcher({
    dir: config.remindersDir,
    logger,
    onFire: (reminder) => pipeline.emitSkillMessage(formatReminder(reminder.text), "reminders"),
  }).start();

  startServer({
    credentials,
    chatStore,
    config,
    logStore,
    logger,
    pipeline,
    runBackup: runWorkspaceBackup,
    session,
    tokenStore,
  });
  logger.info({ port: config.port }, "dashboard + health listening");
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
