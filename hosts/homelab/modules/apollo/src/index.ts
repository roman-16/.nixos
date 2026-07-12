import { join } from "node:path";

import { pino } from "pino";

import { createApolloSession, deliver, onAssistantText } from "./agent";
import { loadConfig } from "./config";
import { renderPage, renderState } from "./dashboard";
import { isAllowed } from "./messages";
import { startWhatsApp, type WhatsApp } from "./whatsapp";

const publicDir = join(import.meta.dir, "../dist/public");
const htmlHeaders = { "content-type": "text/html; charset=utf-8" };

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
  let linking = false;
  let lastStatusBody: string | undefined;

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
    whatsappDir: config.whatsappDir,
  });

  const whatsapp = wa;

  Bun.serve({
    fetch: async (req) => {
      const { pathname } = new URL(req.url);

      if (pathname === "/health") return new Response("ok");
      if (pathname === "/app.css") return new Response(Bun.file(join(publicDir, "app.css")));
      if (pathname === "/htmx.min.js")
        return new Response(Bun.file(join(publicDir, "htmx.min.js")));
      if (pathname === "/favicon.svg")
        return new Response(Bun.file(join(publicDir, "favicon.svg")));
      if (pathname === "/") {
        lastStatusBody = undefined;
        return new Response(renderPage(), { headers: htmlHeaders });
      }

      if (pathname === "/link" && req.method === "POST") {
        linking = true;
        whatsapp.relink();
        lastStatusBody = await renderState(whatsapp.getState(), linking);
        return new Response(lastStatusBody, { headers: htmlHeaders });
      }

      if (pathname === "/status") {
        const state = whatsapp.getState();
        if (state.status === "connected") linking = false;
        const body = await renderState(state, linking);
        if (body === lastStatusBody) return new Response(null, { status: 204 });
        lastStatusBody = body;
        return new Response(body, { headers: htmlHeaders });
      }

      return new Response("Not found", { status: 404 });
    },
    port: config.port,
  });

  logger.info({ port: config.port }, "dashboard + health listening");
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
