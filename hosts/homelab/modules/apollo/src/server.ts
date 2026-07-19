import { readFile, stat } from "node:fs/promises";

import type { AgentSession, AuthStorage } from "@earendil-works/pi-coding-agent";
import type { Logger } from "pino";

import { assetsVersion, htmlHeaders, serveAsset } from "./assets";
import { parseTranscript, renderChat } from "./chat";
import type { Config } from "./config";
import {
  renderContext,
  renderLogs,
  renderPage,
  renderSkills,
  renderStop,
  renderSummary,
  sessionStatus,
} from "./dashboard";
import { type LogStore, parseLevel } from "./logs";
import { authorizeUrl, createVerifier, exchangeCode, parseCode } from "./oauth";
import type { Pipeline } from "./pipeline";
import { parseRange, renderTokens, renderTokensDaily, type TokenStore } from "./tokens";
import { fetchUsage, type UsageData } from "./usage";

const BACKUP_ALERT =
  "⚠️ Apollo: nightly SQLite backup FAILED - check `journalctl -u apollo-db-backup` on the VM.";

/** The Anthropic usage endpoint rate-limits hard, so fetch it at most this often. */
const USAGE_TTL_MS = 5 * 60 * 1000;

type Handler = (req: Request, url: URL) => Response | Promise<Response>;

/**
 * A polled dashboard fragment with `204`-when-unchanged dedup: `serve` compares a caller-supplied
 * key (usually the body itself, a cheap version tag for /logs) and renders lazily on a miss; `prime`
 * force-returns a body and seeds the key so the next poll dedups; `reset` clears it (a full page load).
 */
export interface FragmentCache {
  prime(body: string): Response;
  reset(): void;
  serve(key: string, render: () => string): Response;
}

export function fragmentCache(): FragmentCache {
  let last: string | undefined;
  return {
    prime(body) {
      last = body;
      return new Response(body, { headers: htmlHeaders });
    },
    reset() {
      last = undefined;
    },
    serve(key, render) {
      if (key === last) return new Response(null, { status: 204 });
      last = key;
      return new Response(render(), { headers: htmlHeaders });
    },
  };
}

export interface ServerDeps {
  authStorage: AuthStorage;
  config: Config;
  logStore: LogStore;
  logger: Logger;
  pipeline: Pipeline;
  session: AgentSession;
  tokenStore: TokenStore;
}

/** Start the dashboard + health HTTP server: htmx polls each fragment endpoint and swaps its region. */
export function startServer(deps: ServerDeps): ReturnType<typeof Bun.serve> {
  const { authStorage, config, logStore, logger, pipeline, session, tokenStore } = deps;

  const caches = {
    chat: fragmentCache(),
    logs: fragmentCache(),
    skills: fragmentCache(),
    // /stop-button (poll) and /stop (action) share one dedup slot, as they render the same button.
    stop: fragmentCache(),
    // /summary (poll), /link and /connect (actions) share one, as they render the same section.
    summary: fragmentCache(),
  };

  // Anthropic OAuth login state for the dashboard: one PKCE verifier held until it's used.
  let pendingVerifier: string | undefined;
  const loginUrl = () => authorizeUrl((pendingVerifier ??= createVerifier()));
  let linking = false;

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

  /**
   * Build the #summary fragment from live state. Anthropic connection status is whether a credential
   * exists (no refresh, no network), so a usage-endpoint blip never shows "not connected". The usage
   * endpoint rate-limits aggressively: fetch at most once per TTL (stamp the time before awaiting so
   * concurrent polls dedupe), and keep the last good value across failures so a transient 429 never
   * blanks the numbers.
   */
  async function summaryBody(connectError?: string): Promise<string> {
    const state = pipeline.state();
    if (state.status === "connected") linking = false;
    const connected = authStorage.hasAuth("anthropic");
    if (connected && (!usage || Date.now() - usage.fetchedAt >= USAGE_TTL_MS)) {
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

  const routes = new Map<string, Handler>([
    ["GET /health", () => new Response("ok")],
    [
      "GET /",
      () => {
        for (const cache of Object.values(caches)) cache.reset();
        return new Response(renderPage(assetsVersion), { headers: htmlHeaders });
      },
    ],
    [
      "GET /chat",
      async () => {
        const body = await renderChatBody();
        return caches.chat.serve(body, () => body);
      },
    ],
    [
      "GET /logs",
      (_req, url) => {
        const level = parseLevel(url.searchParams.get("level"));
        // Sliding windows never apply here; the (level, seq) tag changes only on a new record.
        return caches.logs.serve(`${level}:${logStore.seq}`, () =>
          renderLogs(logStore.query(level)),
        );
      },
    ],
    // Sliding windows (e.g. 7d) change as rows age out even without a new insert, so /tokens* is
    // recomputed each poll rather than dedup-cached.
    [
      "GET /tokens",
      (_req, url) =>
        new Response(renderTokens(tokenStore.totals(parseRange(url.searchParams.get("range")))), {
          headers: htmlHeaders,
        }),
    ],
    [
      "GET /tokens/daily",
      (_req, url) =>
        new Response(
          renderTokensDaily(tokenStore.daily(parseRange(url.searchParams.get("range")))),
          {
            headers: htmlHeaders,
          },
        ),
    ],
    [
      "GET /skills",
      () => {
        const { skills } = session.resourceLoader.getSkills();
        const body = renderSkills(
          skills
            .map((skill) => ({
              description: skill.description,
              disabled: skill.disableModelInvocation,
              name: skill.name,
            }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        );
        return caches.skills.serve(body, () => body);
      },
    ],
    [
      "GET /summary",
      async () => {
        const body = await summaryBody();
        return caches.summary.serve(body, () => body);
      },
    ],
    [
      "POST /link",
      async () => {
        linking = true;
        pipeline.relink();
        return caches.summary.prime(await summaryBody());
      },
    ],
    [
      "POST /reload",
      async () => {
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
      },
    ],
    [
      "POST /compact",
      async () => {
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
      },
    ],
    [
      "GET /context",
      () => new Response(renderContext(session.getContextUsage()), { headers: htmlHeaders }),
    ],
    [
      "GET /stop-button",
      () => {
        const body = renderStop(session.isStreaming);
        return caches.stop.serve(body, () => body);
      },
    ],
    [
      "POST /stop",
      async () => {
        if (session.isStreaming) {
          await session.abort();
          logger.info("aborted via dashboard");
        }
        return caches.stop.prime(renderStop(false));
      },
    ],
    [
      "POST /connect",
      async (req) => {
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
        return caches.summary.prime(await summaryBody(error));
      },
    ],
    // Localhost-only hook the apollo-db-backup unit curls when the nightly SQLite backup fails.
    [
      "POST /internal/backup-alert",
      () => {
        void pipeline.notify(BACKUP_ALERT);
        return new Response(null, { status: 204 });
      },
    ],
  ]);

  return Bun.serve({
    fetch: (req) => {
      const url = new URL(req.url);
      const asset = serveAsset(url.pathname);
      if (asset) return asset;
      const handler = routes.get(`${req.method} ${url.pathname}`);
      return handler ? handler(req, url) : new Response("Not found", { status: 404 });
    },
    port: config.port,
  });
}
