import { afterEach, describe, expect, it } from "bun:test";

import type { Config } from "../src/config";
import type { Pipeline } from "../src/pipeline";
import { fragmentCache, isLoopback, type ServerDeps, startServer } from "../src/server";

type Server = ReturnType<typeof startServer>;

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

/** Minimal deps exercising the read-only routes; action routes and their session calls are unused here. */
function stubDeps(over: Partial<ServerDeps> = {}): ServerDeps {
  const noop = () => {};
  return {
    authStorage: { hasAuth: () => false } as unknown as ServerDeps["authStorage"],
    chatStore: {
      image: () => undefined,
      sync: () => {},
      tail: () => ({ entries: [], more: false, version: "0:0" }),
    } as unknown as ServerDeps["chatStore"],
    config: { port: 0 } as unknown as Config,
    logStore: { query: () => [], seq: 0 } as unknown as ServerDeps["logStore"],
    logger: { debug: noop, error: noop, info: noop, warn: noop } as unknown as ServerDeps["logger"],
    pipeline: {
      emitSkillMessage: async () => {},
      notify: async () => {},
      state: () => ({ qr: undefined, status: "connecting", user: undefined }),
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

  it("answers the health check", async () => {
    const res = await get(boot(), "/health");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
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

  it("runs the backup via the loopback hook and returns the outcome", async () => {
    const base = boot({ runBackup: async () => "Backed up and pushed (commit abc1234)." });
    const res = await fetch(`${base}/internal/backup`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("Backed up and pushed (commit abc1234).");
  });
});
