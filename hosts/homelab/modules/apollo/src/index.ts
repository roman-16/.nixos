import { pino } from "pino";

import { createApolloSession } from "./agent";
import { createChatStore } from "./chat-store";
import { loadConfig } from "./config";
import { openDatabase } from "./db";
import { createKv } from "./kv";
import { createLogStore } from "./logs";
import { createPipeline } from "./pipeline";
import { createReminderWatcher, formatReminder } from "./reminders";
import { startServer } from "./server";
import { createTokenStore } from "./tokens";
import { startWhatsApp } from "./whatsapp";

const HOUR_MS = 60 * 60 * 1000;

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
  logStore.prune(Date.now() - logRetentionMs);
  setInterval(() => logStore.prune(Date.now() - logRetentionMs), HOUR_MS);

  if (config.allowFrom.length === 0) {
    logger.warn("APOLLO_ALLOW_FROM is empty; every inbound message will be ignored");
  }

  const { authStorage, session } = await createApolloSession(config, logger);
  logger.info({ model: config.model, workspace: config.workspace }, "pi session ready");

  const pipeline = createPipeline({ config, kv, logStore, logger, session });

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
      try {
        tokenStore.record(event.message.usage, event.message.model, event.message.timestamp);
      } catch (error) {
        logger.error({ error }, "token usage record failed");
      }
    }
  });

  const whatsapp = await startWhatsApp({
    baileysLogLevel: config.baileysLogLevel,
    logger,
    maxChars: config.maxMessageChars,
    onConnect: () => pipeline.handleConnect(),
    onMessage: (message) => pipeline.handleInbound(message),
    whatsappDir: config.whatsappDir,
  });
  pipeline.attach(whatsapp);

  // Fire reminders exactly at their time; a failed delivery rejects so the watcher retries.
  createReminderWatcher({
    dir: config.remindersDir,
    logger,
    onFire: (reminder) => pipeline.sendToUser(formatReminder(reminder.text)),
  }).start();

  startServer({ authStorage, chatStore, config, logStore, logger, pipeline, session, tokenStore });
  logger.info({ port: config.port }, "dashboard + health listening");
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
