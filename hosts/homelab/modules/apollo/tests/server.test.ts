import { afterEach, describe, expect, it } from "bun:test";

import type { Anthropic } from "../src/anthropic";
import type { Config } from "../src/config";
import type { Pipeline } from "../src/pipeline";
import { fragmentCache, isLoopback, type ServerDeps, startServer } from "../src/server";

type Server = ReturnType<typeof startServer>;

const AUTH_URL = "https://claude.ai/oauth/authorize?code=true";

/** The smallest real PNG there is, so the image hook can be exercised against actual bytes. */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe("fragmentCache", () => {
  it("serves a body on the first key and 204s on a repeat", () => {
    const cache = fragmentCache();
    const first = cache.serve("k", () => "body");
    expect(first.status).toBe(200);
    expect(cache.serve("k", () => "body").status).toBe(204);
  });

  it("re-serves when the key changes, even if the rendered body would match", () => {
    const cache = fragmentCache();
    cache.serve("v1", () => "same");
    expect(cache.serve("v2", () => "same").status).toBe(200);
  });

  it("renders lazily, skipping the render function on a dedup hit", () => {
    const cache = fragmentCache();
    let renders = 0;
    const render = () => {
      renders += 1;
      return "x";
    };
    cache.serve("k", render);
    cache.serve("k", render);
    expect(renders).toBe(1);
  });

  it("prime force-returns a body and seeds the key so the next matching serve 204s", () => {
    const cache = fragmentCache();
    const primed = cache.prime("body");
    expect(primed.status).toBe(200);
    expect(cache.serve("body", () => "body").status).toBe(204);
  });

  it("reset clears the dedup so the next serve is a fresh 200", () => {
    const cache = fragmentCache();
    cache.serve("k", () => "x");
    cache.reset();
    expect(cache.serve("k", () => "x").status).toBe(200);
  });
});

describe("isLoopback", () => {
  it("accepts loopback addresses", () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("::1")).toBe(true);
    expect(isLoopback("::ffff:127.0.0.1")).toBe(true);
  });

  it("rejects non-loopback and empty addresses", () => {
    expect(isLoopback("192.168.70.70")).toBe(false);
    expect(isLoopback("")).toBe(false);
  });
});

/** A Claude sign-in in whatever state a test needs; connected unless it says otherwise. */
function stubAnthropic(over: Partial<Anthropic> = {}): Anthropic {
  return {
    expiredAt: () => undefined,
    observe: () => {},
    status: () => "connected",
    submit: async () => {},
    token: async () => "sk-live",
    url: async () => AUTH_URL,
    ...over,
  };
}

/** Minimal deps exercising the read-only routes; action routes and their session calls are unused here. */
function stubDeps(over: Partial<ServerDeps> = {}): ServerDeps {
  const noop = () => {};
  return {
    anthropic: stubAnthropic(),
    chatStore: {
      image: () => undefined,
      sync: () => {},
      tail: () => ({ entries: [], more: false, version: "0:0" }),
    } as unknown as ServerDeps["chatStore"],
    config: { linkGraceMs: 600_000, port: 0 } as unknown as Config,
    logStore: { query: () => [], seq: 0 } as unknown as ServerDeps["logStore"],
    logger: { debug: noop, error: noop, info: noop, warn: noop } as unknown as ServerDeps["logger"],
    pipeline: {
      emitSkillMessage: async () => {},
      notify: async () => {},
      state: () => ({ downSince: undefined, qr: undefined, status: "connected", user: "43" }),
    } as unknown as Pipeline,
    runBackup: async () => "Backed up.",
    session: {
      getContextUsage: () => undefined,
      isStreaming: false,
      resourceLoader: { getSkills: () => ({ skills: [] }) },
      sessionId: "s1",
    } as unknown as ServerDeps["session"],
    tokenStore: {
      daily: () => [],
      totals: () => ({
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
        tokens: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
      }),
    } as unknown as ServerDeps["tokenStore"],
    ...over,
  };
}

describe("startServer routing", () => {
  let server: Server | undefined;
  const boot = (over: Partial<ServerDeps> = {}) => {
    server = startServer(stubDeps(over));
    return `http://localhost:${server.port}`;
  };
  const get = (base: string, path: string) => fetch(`${base}${path}`);

  afterEach(async () => {
    await server?.stop(true);
    server = undefined;
  });

  it("answers the health check while the whatsapp link is up", async () => {
    const res = await get(boot(), "/health");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("stays healthy through a short reconnect", async () => {
    const base = boot({
      config: { linkGraceMs: 600_000, port: 0 } as unknown as Config,
      pipeline: {
        notify: async () => {},
        state: () => ({ downSince: Date.now() - 30_000, qr: undefined, status: "connecting" }),
      } as unknown as Pipeline,
    });
    expect((await get(base, "/health")).status).toBe(200);
  });

  it("reports unhealthy while the claude sign-in is expired, however happily it serves pages", async () => {
    const base = boot({ anthropic: stubAnthropic({ status: () => "expired" }) });
    const res = await get(base, "/health");
    expect(res.status).toBe(503);
    expect(await res.text()).toBe("claude sign-in expired");
  });

  it("reports unhealthy when there has never been a claude sign-in", async () => {
    const base = boot({ anthropic: stubAnthropic({ status: () => "missing" }) });
    expect((await get(base, "/health")).status).toBe(503);
  });

  it("reports unhealthy once the link has been down past the grace period", async () => {
    const base = boot({
      config: { linkGraceMs: 600_000, port: 0 } as unknown as Config,
      pipeline: {
        notify: async () => {},
        state: () => ({ downSince: Date.now() - 3_600_000, qr: undefined, status: "connecting" }),
      } as unknown as Pipeline,
    });
    const res = await get(base, "/health");
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("whatsapp link down");
  });

  it("404s an unknown path", async () => {
    expect((await get(boot(), "/nope")).status).toBe(404);
  });

  it("405-equivalent: a known path with the wrong method is not found", async () => {
    // /summary is GET-only; a POST has no route and falls through to 404.
    const res = await fetch(`${boot()}/summary`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("renders the full page at /", async () => {
    const res = await get(boot(), "/");
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("<!doctype html>");
  });

  it("serves fragment endpoints", async () => {
    const base = boot();
    for (const path of [
      "/chat",
      "/logs",
      "/tokens",
      "/tokens/daily",
      "/skills",
      "/summary",
      "/context",
      "/stop-button",
    ]) {
      expect((await get(base, path)).status).toBe(200);
    }
  });

  it("dedups an unchanged fragment with a 204 on the second poll", async () => {
    const base = boot();
    expect((await get(base, "/stop-button")).status).toBe(200);
    expect((await get(base, "/stop-button")).status).toBe(204);
  });

  it("re-primes fragment caches after a full page load so the next poll re-sends", async () => {
    const base = boot();
    await get(base, "/stop-button"); // 200, primes
    await get(base, "/stop-button"); // 204
    await get(base, "/"); // resets caches
    expect((await get(base, "/stop-button")).status).toBe(200);
  });

  it("404s a media request for an unknown image", async () => {
    expect((await get(boot(), "/media/whatever/0")).status).toBe(404);
  });

  it("offers pi's authorize url while Anthropic is not connected", async () => {
    const base = boot({ anthropic: stubAnthropic({ status: () => "missing" }) });
    expect(await (await get(base, "/summary")).text()).toContain(AUTH_URL);
  });

  it("renders the section rather than failing when the sign-in has expired", async () => {
    // It used to resolve the token inline, so a dead credential threw and the poll 500d: htmx kept
    // the stale green section, and the one screen that could fix it never appeared.
    const base = boot({
      anthropic: stubAnthropic({
        expiredAt: () => new Date(2026, 7, 10, 10, 38).toISOString(),
        status: () => "expired",
        token: async () => undefined,
      }),
    });
    const res = await get(base, "/summary");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Sign-in expired");
    expect(html).toContain(AUTH_URL);
  });

  it("hands a pasted code to the parked sign-in and reports a rejected one", async () => {
    let pasted: string | undefined;
    const base = boot({
      anthropic: stubAnthropic({
        status: () => "missing",
        submit: async (code: string) => {
          pasted = code;
          throw new Error("bad code");
        },
      }),
    });
    const res = await fetch(`${base}/connect`, {
      body: "code=abc123",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    expect(pasted).toBe("abc123");
    expect(await res.text()).toContain("That code didn't work");
  });

  it("serves a chat image from the store with an immutable cache", async () => {
    const base = boot({
      chatStore: {
        image: (_session: string, id: string, index: number) =>
          id === "m1" && index === 0
            ? { bytes: Buffer.from("hello"), mimeType: "image/png" }
            : undefined,
        sync: () => {},
        tail: () => ({ entries: [], more: false, version: "0:0" }),
      } as unknown as ServerDeps["chatStore"],
    });
    const res = await get(base, "/media/m1/0");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(await res.text()).toBe("hello");
  });

  it("marks older history with #chat-more only when the window doesn't cover it", async () => {
    const row = (id: string) =>
      JSON.stringify({ id, message: { content: id, role: "user" }, type: "message" });
    const base = boot({
      chatStore: {
        image: () => undefined,
        sync: () => {},
        tail: (_session: string, count: number) =>
          count < 5
            ? { entries: ["m3", "m4"].map(row), more: true, version: `${count}:5` }
            : {
                entries: ["m0", "m1", "m2", "m3", "m4"].map(row),
                more: false,
                version: `${count}:5`,
              },
      } as unknown as ServerDeps["chatStore"],
    });
    expect(await (await get(base, "/chat?count=2")).text()).toContain('id="chat-more"');
    expect(await (await get(base, "/chat?count=50")).text()).not.toContain('id="chat-more"');
  });

  it("204s a chat poll that already shows the rendered version, and re-sends a stale one", async () => {
    const base = boot();
    const html = await (await get(base, "/chat")).text();
    const version = /id="chat-version"[^>]*value="([^"]*)"/.exec(html)?.[1] ?? "";
    expect(version).not.toBe("");
    expect((await get(base, `/chat?have=${encodeURIComponent(version)}`)).status).toBe(204);
    // A render the page dropped (a swap cancelled to protect a selection) is asked for again.
    expect((await get(base, "/chat?have=stale")).status).toBe(200);
  });

  it("notifies on the backup-alert hook and returns 204", async () => {
    let notified: string | undefined;
    const base = boot({
      pipeline: {
        notify: async (text: string) => {
          notified = text;
        },
        state: () => ({ qr: undefined, status: "connecting", user: undefined }),
      } as unknown as Pipeline,
    });
    const res = await fetch(`${base}/internal/backup-alert`, { method: "POST" });
    expect(res.status).toBe(204);
    expect(notified).toContain("backup FAILED");
  });

  it("delivers a skill message via the loopback hook and returns the marker", async () => {
    let got: { source: string; text: string } | undefined;
    const base = boot({
      pipeline: {
        emitSkillMessage: async (text: string, source: string) => {
          got = { source, text };
        },
        notify: async () => {},
        state: () => ({ qr: undefined, status: "connecting", user: undefined }),
      } as unknown as Pipeline,
    });
    const res = await fetch(`${base}/internal/skill-message?source=macros`, {
      method: "POST",
      body: "hi there",
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("[macros: delivered to the user");
    expect(got).toEqual({ source: "macros", text: "hi there" });
  });

  it("returns the failed marker when delivery throws", async () => {
    const base = boot({
      pipeline: {
        emitSkillMessage: async () => {
          throw new Error("whatsapp down");
        },
        notify: async () => {},
        state: () => ({ qr: undefined, status: "connecting", user: undefined }),
      } as unknown as Pipeline,
    });
    const res = await fetch(`${base}/internal/skill-message?source=reminders`, {
      method: "POST",
      body: "x",
    });
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("[reminders: delivery FAILED");
  });

  it("delivers an image via the loopback hook and returns the marker", async () => {
    let got: { attachment?: unknown; source: string; text: string } | undefined;
    const file = `/tmp/apollo-test-${Bun.hash(String(Math.random()))}.png`;
    await Bun.write(file, PNG_1X1);
    const base = boot({
      pipeline: {
        emitSkillMessage: async (text: string, source: string, attachment: unknown) => {
          got = { attachment, source, text };
        },
        notify: async () => {},
        state: () => ({ qr: undefined, status: "connected", user: undefined }),
      } as unknown as Pipeline,
    });
    const res = await fetch(
      `${base}/internal/skill-image?source=diagram&path=${encodeURIComponent(file)}`,
      { body: "how it flows", method: "POST" },
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("[diagram: delivered to the user");
    expect(got?.text).toBe("how it flows");
    expect(got?.source).toBe("diagram");
    const attachment = got?.attachment as { height?: number; mimeType?: string } | undefined;
    expect(attachment?.mimeType).toBe("image/png");
    expect(attachment?.height).toBe(1);
  });

  it("sends a picture with no words when the body is empty", async () => {
    let got: { text: string } | undefined;
    const file = `/tmp/apollo-test-${Bun.hash(String(Math.random()))}.png`;
    await Bun.write(file, PNG_1X1);
    const base = boot({
      pipeline: {
        emitSkillMessage: async (text: string) => {
          got = { text };
        },
        notify: async () => {},
        state: () => ({ qr: undefined, status: "connected", user: undefined }),
      } as unknown as Pipeline,
    });
    const res = await fetch(`${base}/internal/skill-image?path=${encodeURIComponent(file)}`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(got?.text).toBe("");
  });

  it("refuses a file it cannot send as the caller's mistake, not a failed delivery", async () => {
    const base = boot();
    const res = await fetch(`${base}/internal/skill-image?source=diagram&path=/tmp/nope.png`, {
      method: "POST",
    });
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("cannot send");
    expect(body).not.toContain("relay");
  });

  it("asks for a path when none is named", async () => {
    const base = boot();
    const res = await fetch(`${base}/internal/skill-image?source=diagram`, { method: "POST" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("path");
  });

  it("returns the failed marker when the image cannot be delivered", async () => {
    const file = `/tmp/apollo-test-${Bun.hash(String(Math.random()))}.png`;
    await Bun.write(file, PNG_1X1);
    const base = boot({
      pipeline: {
        emitSkillMessage: async () => {
          throw new Error("whatsapp down");
        },
        notify: async () => {},
        state: () => ({ qr: undefined, status: "connecting", user: undefined }),
      } as unknown as Pipeline,
    });
    const res = await fetch(
      `${base}/internal/skill-image?source=diagram&path=${encodeURIComponent(file)}`,
      { method: "POST" },
    );
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("[diagram: delivery FAILED");
  });

  it("runs the backup via the loopback hook and returns the outcome", async () => {
    const base = boot({ runBackup: async () => "Backed up and pushed." });
    const res = await fetch(`${base}/internal/backup`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("Backed up and pushed.");
  });
});
