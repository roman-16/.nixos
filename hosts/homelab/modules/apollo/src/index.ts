import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { pino } from "pino";

import { createApolloSession, deliver, onAssistantText } from "./agent";
import { parseTranscript, renderChat } from "./chat";
import { loadConfig } from "./config";
import {
  renderContext,
  renderLogs,
  renderPage,
  renderStop,
  renderSummary,
  sessionStatus,
} from "./dashboard";
import { openDatabase } from "./db";
import { createLogStore, parseLevel } from "./logs";
import { compactionNotice, isAllowed, jidForNumber, voiceText } from "./messages";
import { authorizeUrl, createVerifier, exchangeCode, parseCode } from "./oauth";
import { createReminderWatcher, formatReminder } from "./reminders";
import { transcribeAudio } from "./transcribe";
import { fetchUsage, type UsageData } from "./usage";
import { startWhatsApp, type WhatsApp } from "./whatsapp";

const publicDir = join(import.meta.dir, "../dist/public");
const htmlHeaders = { "content-type": "text/html; charset=utf-8" };
/** The Anthropic usage endpoint rate-limits hard, so fetch it at most this often. */
const usageTtlMs = 5 * 60 * 1000;

/** Content hash of the built assets, used to cache-bust the CSS/JS/favicon URLs. */
const assetsVersion = ((): string => {
  try {
    const hash = createHash("sha256");
    for (const name of ["app.css", "htmx.min.js", "favicon.svg"])
      hash.update(readFileSync(join(publicDir, name)));
    return hash.digest("hex").slice(0, 12);
  } catch {
    return "dev";
  }
})();

function asset(name: string, type: string): Response {
  return new Response(Bun.file(join(publicDir, name)), {
    headers: { "cache-control": "public, max-age=31536000, immutable", "content-type": type },
  });
}

export async function main(): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  const logStore = createLogStore(db);
  const logger = pino({ level: config.logLevel }, logStore.stream);
  const logRetentionMs = config.logRetentionDays * 24 * 60 * 60 * 1000;
  logStore.prune(Date.now() - logRetentionMs);
  setInterval(() => logStore.prune(Date.now() - logRetentionMs), 60 * 60 * 1000);

  if (config.allowFrom.length === 0) {
    logger.warn("APOLLO_ALLOW_FROM is empty; every inbound message will be ignored");
  }

  const { authStorage, session } = await createApolloSession(config, logger);
  logger.info({ model: config.model, workspace: config.workspace }, "pi session ready");

  // Anthropic OAuth login state for the dashboard: one verifier held until it's used.
  let pendingVerifier: string | undefined;
  const loginUrl = () => authorizeUrl((pendingVerifier ??= createVerifier()));

  let wa: WhatsApp | undefined;
  let target: string | undefined;
  let linking = false;
  // Proactive notices (e.g. compaction) can fire before any inbound sets `target` -
  // a dashboard compaction right after a restart, say - so fall back to the primary
  // allowlisted number.
  const fallbackTarget = config.allowFrom[0] ? jidForNumber(config.allowFrom[0]) : undefined;
  let lastSummaryBody: string | undefined;
  let lastChatBody: string | undefined;
  let lastLogKey: string | undefined;
  let lastStopBody: string | undefined;
  let chatCache: { body: string; live: boolean; mtimeMs: number } | undefined;
  let usage: { data: UsageData | null; fetchedAt: number } | undefined;

  async function renderChatBody(): Promise<string> {
    const file = session.sessionFile;
    if (!file) return renderChat([]);
    try {
      const { mtimeMs } = await stat(file);
      const live = session.isStreaming;
      if (!chatCache || chatCache.mtimeMs !== mtimeMs || chatCache.live !== live) {
        chatCache = {
          body: renderChat(parseTranscript(await readFile(file, "utf8")), new Date(), live),
          live,
          mtimeMs,
        };
      }
      return chatCache.body;
    } catch {
      return renderChat([]);
    }
  }

  // Keep WhatsApp's "typing…" indicator up continuously from when a message
  // arrives until the agent fully settles. WhatsApp drops it whenever we send a
  // message and auto-expires it after a few seconds, so we re-assert "composing"
  // right after every outbound message (below) and on a short refresh loop.
  const typingRefreshMs = 4000;
  const typingMaxTicks = 120; // ~8 min safety cap (typingRefreshMs * typingMaxTicks)
  let typingTimer: ReturnType<typeof setInterval> | undefined;

  function sendComposing() {
    if (wa && target) void wa.presence(target, "composing");
  }

  function stopTyping() {
    if (typingTimer) {
      clearInterval(typingTimer);
      typingTimer = undefined;
    }
    if (wa && target) void wa.presence(target, "paused");
  }

  function startTyping() {
    stopTyping();
    if (!wa || !target) return;
    sendComposing();
    let ticks = 0;
    typingTimer = setInterval(() => {
      if (!wa || !target || (ticks += 1) > typingMaxTicks) {
        stopTyping();
        return;
      }
      sendComposing();
    }, typingRefreshMs);
  }

  onAssistantText(session, (text) => {
    if (!wa || !target) return;
    void wa
      .send(target, text)
      .then(() => {
        // Sending clears the indicator on the recipient's side; re-assert it while
        // the agent is still working. Once it settles, stopTyping has cleared the
        // timer, so this guard stays quiet and never leaves "typing…" stuck on.
        if (typingTimer) sendComposing();
      })
      .catch((error) => logger.error({ error }, "send failed"));
  });

  session.subscribe((event) => {
    if (event.type === "agent_settled") stopTyping();
    if (event.type === "compaction_end" && event.result && !event.aborted) {
      const to = target ?? fallbackTarget;
      if (wa && to) {
        void wa
          .send(to, compactionNotice(event.result.tokensBefore))
          .catch((error) => logger.error({ error }, "compaction notice failed"));
      }
    }
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
      void wa?.read(message.key); // blue checkmarks so the user knows it arrived
      startTyping();

      let text = message.text;
      if (message.audio) {
        try {
          text = voiceText(
            await transcribeAudio(message.audio.data, {
              apiKey: config.mistralApiKey,
              model: config.transcribeModel,
            }),
          );
        } catch (error) {
          logger.error({ error }, "transcription failed");
          stopTyping();
          void wa?.send(
            message.from,
            `🎤 Couldn't transcribe that voice note: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return;
        }
      }

      const prompt = text || "(image)";
      logger.info(
        {
          chars: prompt.length,
          from: message.number,
          images: message.images.length,
          voice: Boolean(message.audio),
        },
        "prompt",
      );
      try {
        await deliver(session, prompt, message.images);
      } catch (error) {
        logger.error({ error }, "prompt failed");
        stopTyping();
        void wa?.send(message.from, `⚠️ ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    whatsappDir: config.whatsappDir,
  });

  const whatsapp = wa;

  /**
   * Build the #summary fragment from live state. Anthropic connection status is whether
   * a credential exists (no refresh, no network), so a usage-endpoint blip or brief
   * token-refresh window never shows "not connected". The usage endpoint rate-limits
   * aggressively: fetch at most once per TTL (stamp the time before awaiting so
   * concurrent polls dedupe), and keep the last good value across failures so the
   * numbers never blank out on a transient 429.
   */
  async function summaryBody(connectError?: string): Promise<string> {
    const state = whatsapp.getState();
    if (state.status === "connected") linking = false;
    const connected = authStorage.hasAuth("anthropic");
    if (connected && (!usage || Date.now() - usage.fetchedAt >= usageTtlMs)) {
      usage = { data: usage?.data ?? null, fetchedAt: Date.now() };
      const token = await authStorage.getApiKey("anthropic");
      const fresh = token ? await fetchUsage(token) : null;
      if (fresh) usage = { data: fresh, fetchedAt: usage.fetchedAt };
    }
    return renderSummary({
      anthropicConnected: connected,
      authUrl: connected ? "" : loginUrl(),
      connectError,
      linking,
      usage: usage?.data ?? null,
      whatsapp: state,
    });
  }

  // Fire reminders exactly at their time via fs.watch + per-reminder timers (no polling).
  createReminderWatcher({
    dir: config.remindersDir,
    logger,
    onFire: async (reminder) => {
      const to = target ?? fallbackTarget;
      if (!wa || !to || wa.getState().status !== "connected") {
        throw new Error("whatsapp not connected");
      }
      await wa.send(to, formatReminder(reminder.text));
    },
  }).start();

  Bun.serve({
    fetch: async (req) => {
      const url = new URL(req.url);
      const { pathname } = url;

      if (pathname === "/health") return new Response("ok");
      if (pathname === "/app.css") return asset("app.css", "text/css");
      if (pathname === "/htmx.min.js") return asset("htmx.min.js", "text/javascript");
      if (pathname === "/favicon.svg") return asset("favicon.svg", "image/svg+xml");
      if (pathname === "/") {
        lastSummaryBody = undefined;
        lastChatBody = undefined;
        lastLogKey = undefined;
        lastStopBody = undefined;
        return new Response(renderPage(assetsVersion), { headers: htmlHeaders });
      }

      if (pathname === "/chat") {
        const body = await renderChatBody();
        if (body === lastChatBody) return new Response(null, { status: 204 });
        lastChatBody = body;
        return new Response(body, { headers: htmlHeaders });
      }

      if (pathname === "/logs") {
        const level = parseLevel(url.searchParams.get("level"));
        const key = `${level}:${logStore.seq}`;
        if (key === lastLogKey) return new Response(null, { status: 204 });
        lastLogKey = key;
        return new Response(renderLogs(logStore.query(level)), { headers: htmlHeaders });
      }

      if (pathname === "/link" && req.method === "POST") {
        linking = true;
        whatsapp.relink();
        lastSummaryBody = await summaryBody();
        return new Response(lastSummaryBody, { headers: htmlHeaders });
      }

      if (pathname === "/summary") {
        const body = await summaryBody();
        if (body === lastSummaryBody) return new Response(null, { status: 204 });
        lastSummaryBody = body;
        return new Response(body, { headers: htmlHeaders });
      }

      if (pathname === "/reload" && req.method === "POST") {
        if (!session.isIdle || session.isCompacting) {
          return new Response(sessionStatus("reload", "busy"), { headers: htmlHeaders });
        }
        try {
          await session.reload();
          // reload() rebuilds settings from disk, dropping in-memory overrides; re-assert the
          // auto-compaction override the startup applies (getCompactionEnabled reads it live).
          session.settingsManager.applyOverrides({ compaction: { enabled: true } });
          session.sessionManager.appendCustomEntry("apollo_reload", {
            at: new Date().toISOString(),
          });
          logger.info("reloaded via dashboard");
          return new Response(sessionStatus("reload", "ok"), { headers: htmlHeaders });
        } catch (error) {
          logger.error({ error }, "reload failed");
          return new Response(sessionStatus("reload", "error"), { headers: htmlHeaders });
        }
      }

      if (pathname === "/compact" && req.method === "POST") {
        if (!session.isIdle || session.isCompacting) {
          return new Response(sessionStatus("compact", "busy"), { headers: htmlHeaders });
        }
        try {
          await session.compact();
          logger.info("compacted via dashboard");
          return new Response(sessionStatus("compact", "ok"), { headers: htmlHeaders });
        } catch (error) {
          logger.error({ err: error }, "compact failed");
          return new Response(sessionStatus("compact", "error"), { headers: htmlHeaders });
        }
      }

      if (pathname === "/context") {
        return new Response(renderContext(session.getContextUsage()), { headers: htmlHeaders });
      }

      if (pathname === "/stop-button") {
        const body = renderStop(session.isStreaming);
        if (body === lastStopBody) return new Response(null, { status: 204 });
        lastStopBody = body;
        return new Response(body, { headers: htmlHeaders });
      }

      if (pathname === "/stop" && req.method === "POST") {
        if (session.isStreaming) {
          await session.abort();
          logger.info("aborted via dashboard");
        }
        lastStopBody = renderStop(false);
        return new Response(lastStopBody, { headers: htmlHeaders });
      }

      if (pathname === "/connect" && req.method === "POST") {
        const code = parseCode(new URLSearchParams(await req.text()).get("code") ?? "");
        const cred =
          code && pendingVerifier ? await exchangeCode(code, pendingVerifier) : undefined;
        let error: string | undefined;
        if (cred) {
          authStorage.set("anthropic", { type: "oauth", ...cred });
          pendingVerifier = undefined;
          logger.info("anthropic connected via dashboard");
          usage = { data: await fetchUsage(cred.access), fetchedAt: Date.now() };
        } else {
          error = "That code didn't work. Authorize again and paste the new code.";
        }
        lastSummaryBody = await summaryBody(error);
        return new Response(lastSummaryBody, { headers: htmlHeaders });
      }

      // Localhost-only hook the apollo-db-backup unit curls when the nightly SQLite
      // backup fails; the fixed notice goes to the primary allowlisted number.
      if (pathname === "/internal/backup-alert" && req.method === "POST") {
        const to = target ?? fallbackTarget;
        if (to && whatsapp.getState().status === "connected") {
          void whatsapp
            .send(
              to,
              "⚠️ Apollo: nightly SQLite backup FAILED - check `journalctl -u apollo-db-backup` on the VM.",
            )
            .catch((error) => logger.error({ error }, "backup alert failed"));
        }
        return new Response(null, { status: 204 });
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
