import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Logger } from "pino";

import { type AnthropicLogin, createAnthropicLogin } from "./anthropic-login";
import { assetsVersion, htmlHeaders, serveAsset } from "./assets";
import { parseTranscript, renderChat } from "./chat";
import type { ChatStore } from "./chat-store";
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
import { deliveredMarker, failedMarker } from "./messages";
import type { Pipeline } from "./pipeline";
import { parseRange, renderTokens, renderTokensDaily, type TokenStore } from "./tokens";
import { fetchUsage, type UsageData } from "./usage";

const BACKUP_ALERT =
  "⚠️ Apollo: nightly SQLite backup FAILED - check `journalctl -u apollo-db-backup` on the VM.";

/** The Anthropic usage endpoint rate-limits hard, so fetch it at most this often. */
const USAGE_TTL_MS = 5 * 60 * 1000;

/** Default transcript lines the chat renders; the dashboard's "Load older" grows this. */
const DEFAULT_CHAT_LINES = 60;
const MAX_CHAT_LINES = 5000;

/** Long-lived cache for immutable transcript media (an entry's image never changes). */
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";

/** Zero-height marker at the oldest end; its presence tells the chat more history remains. */
const CHAT_MORE_MARKER = `<div id="chat-more" hidden></div>`;

/** Textual content types worth gzipping; binary (images) is left untouched. */
const GZIPPABLE = /^(?:text\/|application\/(?:json|javascript)|image\/svg)/;
const GZIP_MIN_BYTES = 1024;

type Handler = (req: Request, url: URL) => Response | Promise<Response>;

/** Coerce the chat window's `count` query into a sane, bounded line count. */
function chatLines(value: string | null): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1
    ? Math.min(Math.floor(n), MAX_CHAT_LINES)
    : DEFAULT_CHAT_LINES;
}

/** Whether a socket address is loopback - the guard for localhost-only /internal endpoints. */
export function isLoopback(address: string): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/** Gzip a textual response when the client accepts it and it clears a size floor. */
async function maybeGzip(req: Request, res: Response): Promise<Response> {
  if (res.status === 204 || res.headers.has("content-encoding")) return res;
  if (!(req.headers.get("accept-encoding") ?? "").includes("gzip")) return res;
  if (!GZIPPABLE.test(res.headers.get("content-type") ?? "")) return res;
  const body = new Uint8Array(await res.arrayBuffer());
  const headers = new Headers(res.headers);
  if (body.byteLength < GZIP_MIN_BYTES) return new Response(body, { headers, status: res.status });
  headers.set("content-encoding", "gzip");
  headers.set("vary", "accept-encoding");
  return new Response(Bun.gzipSync(body), { headers, status: res.status });
}

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
  chatStore: ChatStore;
  config: Config;
  logStore: LogStore;
  logger: Logger;
  modelRuntime: ModelRuntime;
  pipeline: Pipeline;
  runBackup: () => Promise<string>;
  session: AgentSession;
  tokenStore: TokenStore;
}

/** Start the dashboard + health HTTP server: htmx polls each fragment endpoint and swaps its region. */
export function startServer(deps: ServerDeps): ReturnType<typeof Bun.serve> {
  const {
    chatStore,
    config,
    logStore,
    logger,
    modelRuntime,
    pipeline,
    runBackup,
    session,
    tokenStore,
  } = deps;

  const caches = {
    chat: fragmentCache(),
    logs: fragmentCache(),
    skills: fragmentCache(),
    // /stop-button (poll) and /stop (action) share one dedup slot, as they render the same button.
    stop: fragmentCache(),
    // /summary (poll), /link and /connect (actions) share one, as they render the same section.
    summary: fragmentCache(),
  };

  const anthropicLogin: AnthropicLogin = createAnthropicLogin(modelRuntime);
  let linking = false;

  let chatCache: { body: string; key: string } | undefined;
  let usage: { data: UsageData | null; fetchedAt: number } | undefined;

  /** Render the chat window from SQLite (the source of truth), memoized by a cheap version tag. */
  function renderChatBody(count: number): string {
    const { entries, more, version } = chatStore.tail(session.sessionId, count);
    const live = session.isStreaming;
    const key = `${version}:${live}`;
    if (!chatCache || chatCache.key !== key) {
      chatCache = {
        body:
          renderChat(parseTranscript(entries.join("\n")), new Date(), live) +
          (more ? CHAT_MORE_MARKER : ""),
        key,
      };
    }
    return chatCache.body;
  }

  /** Serve one chat image (`/media/<entryId>/<n>`) from SQLite with a long immutable cache. */
  function serveMedia(pathname: string): Response {
    const match = /^\/media\/([^/]+)\/(\d+)$/.exec(pathname);
    if (!match) return new Response("Not found", { status: 404 });
    const image = chatStore.image(
      session.sessionId,
      decodeURIComponent(match[1]!),
      Number(match[2]!),
    );
    if (!image) return new Response("Not found", { status: 404 });
    return new Response(image.bytes, {
      headers: { "cache-control": IMMUTABLE_CACHE, "content-type": image.mimeType },
    });
  }

  /** The current Anthropic access token, refreshed by the runtime when it is close to expiring. */
  async function anthropicToken(): Promise<string | undefined> {
    return (await modelRuntime.getAuth("anthropic"))?.auth.apiKey;
  }

  /**
   * Build the #summary fragment from live state. Anthropic connection status is whether a credential
   * exists (no refresh, no network), so a usage-endpoint blip never shows "not connected". The usage
   * endpoint rate-limits aggressively: fetch at most once per TTL (stamp the time before awaiting so
   * concurrent polls dedupe), and keep the last good value across failures so a transient 429 never
   * blanks the numbers. While disconnected, the sign-in is started so its authorization URL can be
   * offered right in the section; it parks until a code is posted to /connect.
   */
  async function summaryBody(connectError?: string): Promise<string> {
    const state = pipeline.state();
    if (state.status === "connected") linking = false;
    const connected = modelRuntime.hasConfiguredAuth("anthropic");
    if (connected && (!usage || Date.now() - usage.fetchedAt >= USAGE_TTL_MS)) {
      usage = { data: usage?.data ?? null, fetchedAt: Date.now() };
      const token = await anthropicToken();
      const fresh = token ? await fetchUsage(token) : null;
      if (fresh) usage = { data: fresh, fetchedAt: usage.fetchedAt };
    }
    let authUrl = "";
    let error = connectError;
    if (!connected) {
      try {
        authUrl = await anthropicLogin.url();
      } catch (failure) {
        logger.warn({ error: failure }, "anthropic login could not be started");
        error ??= "Couldn't start the Anthropic sign-in. Reload the page to try again.";
      }
    }
    return renderSummary({
      anthropicConnected: connected,
      authUrl,
      connectError: error,
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
      (_req, url) => {
        const body = renderChatBody(chatLines(url.searchParams.get("count")));
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
        const code = new URLSearchParams(await req.text()).get("code") ?? "";
        let error: string | undefined;
        try {
          await anthropicLogin.submit(code);
          logger.info("anthropic connected via dashboard");
          const token = await anthropicToken();
          usage = { data: token ? await fetchUsage(token) : null, fetchedAt: Date.now() };
        } catch (failure) {
          logger.warn({ error: failure }, "anthropic login failed");
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
    // Localhost-only hook the backup skill curls to run the workspace backup. The git capability
    // (deploy key + push) lives in the privileged root apollo-backup.service, not the agent's
    // reach; this only triggers it and returns the outcome it recorded, for the skill to deliver.
    [
      "POST /internal/backup",
      async () =>
        new Response(await runBackup(), {
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
    ],
    // Localhost-only hook skills curl to push a message straight to the user (macros, reminders,
    // backup). Delivers it, then returns the marker for the skill to echo - one source of truth for
    // the wording. The reminder watcher uses the same pipeline method in-process. Loopback-guarded.
    [
      "POST /internal/skill-message",
      async (req, url) => {
        const source = url.searchParams.get("source") ?? "skill";
        const text = (await req.text()).trim();
        if (!text) return new Response(null, { status: 204 });
        const headers = { "content-type": "text/plain; charset=utf-8" };
        try {
          await pipeline.emitSkillMessage(text, source);
          return new Response(deliveredMarker(source), { headers, status: 200 });
        } catch {
          return new Response(failedMarker(source), { headers, status: 503 });
        }
      },
    ],
  ]);

  return Bun.serve({
    fetch: async (req, server) => {
      const url = new URL(req.url);
      // /internal/* sends WhatsApp messages and injects agent context - a prompt-injection vector,
      // so restrict it to same-host callers (LAN/tunnel traffic arrives from a non-loopback source).
      if (
        url.pathname.startsWith("/internal/") &&
        !isLoopback(server.requestIP(req)?.address ?? "")
      ) {
        return new Response("Not found", { status: 404 });
      }
      const asset = serveAsset(url.pathname);
      if (asset) return maybeGzip(req, asset);
      if (req.method === "GET" && url.pathname.startsWith("/media/"))
        return serveMedia(url.pathname);
      const handler = routes.get(`${req.method} ${url.pathname}`);
      const res = handler ? await handler(req, url) : new Response("Not found", { status: 404 });
      return maybeGzip(req, res);
    },
    port: config.port,
  });
}
