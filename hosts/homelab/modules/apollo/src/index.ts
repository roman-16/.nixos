import { pino } from "pino";

import { createApolloSession, deliver, onAssistantText } from "./agent.ts";
import { loadConfig } from "./config.ts";
import { healthHandler } from "./health.ts";
import { isAllowed } from "./messages.ts";
import { startWhatsApp, type WhatsApp } from "./whatsapp.ts";

export async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino({ level: config.logLevel });

  if (config.allowFrom.length === 0) {
    logger.warn("APOLLO_ALLOW_FROM is empty; every inbound message will be ignored");
  }

  const session = await createApolloSession(config);
  logger.info({ model: config.model, workspace: config.workspace }, "pi session ready");

  let wa: WhatsApp | undefined;
  let target: string | undefined;

  // Each completed assistant text block goes straight back to the last allowed chat.
  onAssistantText(session, (text) => {
    if (!wa || !target) return;
    void wa.send(target, text).catch((error) => logger.error({ error }, "send failed"));
  });

  wa = await startWhatsApp({
    logger,
    maxChars: config.maxMessageChars,
    onMessage: async (message) => {
      if (!isAllowed(message.number, config.allowFrom)) {
        logger.warn({ from: message.number }, "ignored message from non-allowlisted number");
        return;
      }
      target = message.from;
      const text = message.text || "(image)";
      logger.info(
        { chars: text.length, from: message.number, images: message.images.length },
        "prompt",
      );
      try {
        await deliver(session, text, message.images);
      } catch (error) {
        logger.error({ error }, "prompt failed");
        void wa?.send(message.from, `⚠️ ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    pairingNumber: config.pairingNumber,
    whatsappDir: config.whatsappDir,
  });

  Bun.serve({ fetch: healthHandler, port: config.port });
  logger.info({ port: config.port }, "health endpoint listening");
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
