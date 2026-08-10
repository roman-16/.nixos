import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Logger } from "pino";

import { compactionSettings } from "./agent";
import type { Anthropic } from "./anthropic";
import { assetsVersion, htmlHeaders, serveAsset } from "./assets";
import { type Attachment, loadAttachment } from "./attachments";
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
import { escapeHtml } from "./format";
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

/** The version of the rendered window, echoed back by the next poll as `have`. */
function chatVersionInput(version: string): string {
  return `<input id="chat-version" type="hidden" name="have" value="${escapeHtml(version)}" />`;
}

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
  anthropic: Anthropic;
  chatStore: ChatStore;
  config: Config;
  logStore: LogStore;
  logger: Logger;
  pipeline: Pipeline;
  runBackup: () => Promise<string>;
  session: AgentSession;
  tokenStore: TokenStore;
}

/** Start the dashboard + health HTTP server: htmx polls each fragment endpoint and swaps its region. */
export function startServer(deps: ServerDeps): ReturnType<typeof Bun.serve> {
  const {
    anthropic,
    chatStore,
    config,
    logStore,
    logger,
    pipeline,
    runBackup,
    session,
    tokenStore,
  } = deps;

  const caches = {
    logs: fragmentCache(),
    skills: fragmentCache(),
    // /stop-button (poll) and /stop (action) share one dedup slot, as they render the same button.
    stop: fragmentCache(),
    // /summary (poll), /link and /connect (actions) share one, as they render the same section.
    summary: fragmentCache(),
  };

  let linking = false;

  let chatCache: { body: string; version: string } | undefined;
  let usage: { data: UsageData | null; fetchedAt: number } | undefined;

  /**
   * Render the chat window from SQLite (the source of truth), memoized by a cheap version tag.
   * The fragment carries that tag, so the next poll can say what it is already showing.
   */
  function renderChatBody(count: number): { body: string; version: string } {
    const { entries, more, version } = chatStore.tail(session.sessionId, count);
    const live = session.isStreaming;
    const tag = `${version}:${live}`;
    if (!chatCache || chatCache.version !== tag) {
      chatCache = {
        body:
          (more ? CHAT_MORE_MARKER : "") +
          chatVersionInput(tag) +
          renderChat(parseTranscript(entries.join("\n")), new Date(), live),
        version: tag,
      };
    }
    return chatCache;
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

  /**
   * Build the #summary fragment from live state.
   *
   * The usage poll doubles as the standing proof that Claude is still reachable: resolving a token is
   * the only way to learn that a credential has died, so a sign-in that expired overnight surfaces
   * here rather than in the user's next message. The endpoint rate-limits aggressively, so it is
   * fetched at most once per TTL (the time is stamped before awaiting so concurrent polls dedupe) and
   * the last good value is kept across failures, so a transient 429 never blanks the numbers.
   *
   * While there is no sign-in the login is started so its authorization URL can be offered right in
   * the section; it parks until a code is posted to /connect.
   */
  async function summaryBody(connectError?: string): Promise<string> {
    const state = pipeline.state();
    if (state.status === "connected") linking = false;
    if (
      anthropic.status() === "connected" &&
      (!usage || Date.now() - usage.fetchedAt >= USAGE_TTL_MS)
    ) {
      usage = { data: usage?.data ?? null, fetchedAt: Date.now() };
      const token = await anthropic.token();
      const fresh = token ? await fetchUsage(token) : null;
      if (fresh) usage = { data: fresh, fetchedAt: usage.fetchedAt };
    }
    // Read after the probe, which may just have retired the credential.
    const status = anthropic.status();
    let authUrl = "";
    let error = connectError;
    if (status !== "connected") {
      try {
        authUrl = await anthropic.url();
      } catch (failure) {
        logger.warn({ error: failure }, "anthropic login could not be started");
        error ??= "Couldn't start the Anthropic sign-in. Reload the page to try again.";
      }
    }
    return renderSummary({
      anthropicExpiredAt: anthropic.expiredAt(),
      anthropicStatus: status,
      authUrl,
      connectError: error,
      linking,
      usage: usage?.data ?? null,
      whatsapp: state,
    });
  }

  const routes = new Map<string, Handler>([
    // Health is the whole service, not just the HTTP server: an Apollo that cannot receive a message,
    // or cannot answer one, is down however happily it serves pages. Reporting that is what turns the
    // status page red - and for a sign-in only the user can renew it is the one alarm Apollo can
    // raise without needing Claude to raise it.
    [
      "GET /health",
      () => {
        const { downSince } = pipeline.state();
        const downFor = downSince === undefined ? 0 : Date.now() - downSince;
        if (downFor > config.linkGraceMs) {
          return new Response(`whatsapp link down for ${Math.round(downFor / 60_000)}m`, {
            status: 503,
          });
        }
        const status = anthropic.status();
        if (status !== "connected") {
          return new Response(`claude sign-in ${status}`, { status: 503 });
        }
        return new Response("ok");
      },
    ],
    [
      "GET /",
      () => {
        for (const cache of Object.values(caches)) cache.reset();
        return new Response(renderPage(assetsVersion), { headers: htmlHeaders });
      },
    ],
    // Dedup belongs to the side that knows what it displays: the fragment carries its version, the
    // poll echoes it back as `have`, and an unchanged window is a 204. A render the page drops (it
    // cancels a swap to protect a selection) leaves the old version in the DOM, so the next poll
    // asks for it again instead of going stale.
    [
      "GET /chat",
      (_req, url) => {
        const { body, version } = renderChatBody(chatLines(url.searchParams.get("count")));
        if (url.searchParams.get("have") === version) return new Response(null, { status: 204 });
        return new Response(body, { headers: htmlHeaders });
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
          { headers: htmlHeaders },
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
          // compaction policy the startup applies (it is read live, on the next compaction).
          session.settingsManager.applyOverrides({ compaction: compactionSettings(config) });
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
          await anthropic.submit(code);
          // Whatever piled up while Apollo had no sign-in is still owed; the pipeline's own sweep
          // delivers it as a catch-up turn within the minute.
          logger.info("anthropic connected via dashboard");
          const token = await anthropic.token();
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
    // Localhost-only hook for putting an image in front of the user, shaped exactly like
    // /internal/skill-image's text sibling below: what the user reads is the body, everything about
    // the delivery is the query. The picture stays a path, because whatever drew it wrote it to this
    // same machine and there is nothing to gain by encoding it over a loopback hop.
    [
      "POST /internal/skill-image",
      async (req, url) => {
        const source = url.searchParams.get("source") ?? "image";
        const path = url.searchParams.get("path") ?? "";
        const headers = { "content-type": "text/plain; charset=utf-8" };
        if (!path) {
          return new Response("name the image with ?path=/tmp/x.png; the caption is the body\n", {
            headers,
            status: 400,
          });
        }
        // An empty caption is a picture sent without words, which is a thing people do.
        const caption = (await req.text()).trim();
        // A file that cannot be sent is the caller's to fix, not a delivery that failed, so it is
        // reported as itself rather than as something to relay to the user.
        let attachment: Attachment;
        try {
          attachment = await loadAttachment(path);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          return new Response(`cannot send ${path}: ${reason}\n`, { headers, status: 400 });
        }
        try {
          await pipeline.emitSkillMessage(caption, source, attachment);
          return new Response(deliveredMarker(source), { headers, status: 200 });
        } catch {
          return new Response(failedMarker(source), { headers, status: 503 });
        }
      },
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
