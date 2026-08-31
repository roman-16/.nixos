import { describe, expect, it } from "bun:test";

import {
  type Anthropic,
  type AnthropicRuntime,
  createAnthropic,
  deadGrant,
} from "../src/anthropic";
import type { Kv } from "../src/kv";

const AUTH_URL = "https://claude.ai/oauth/authorize?code=true";

/** The refusal Apollo actually gets: the token endpoint turning down a refresh token that is gone. */
const DEAD =
  'Anthropic token refresh request failed. url=https://platform.claude.com/v1/oauth/token; details=Error: HTTP request failed. status=400; body={"error":"invalid_grant"}\n    at postJson (/nix/store/x/anthropic.js:155:19)';

const TRANSIENT = "Anthropic token refresh request failed. details=Error: connect ETIMEDOUT";

function memoryKv(): Kv {
  const store = new Map<string, string>();
  return {
    get: (key) => store.get(key),
    remove: (key) => {
      store.delete(key);
    },
    set: (key, value) => {
      store.set(key, value);
    },
  };
}

interface Harness {
  anthropic: Anthropic;
  state: {
    codes: string[];
    logins: number;
    logouts: number;
    stored: boolean;
  };
}

/**
 * A credential store that behaves like pi's: login writes over whatever is there, logout deletes it,
 * and resolving it either yields a token or refuses.
 */
function harness(
  over: { logoutFails?: boolean; resolve?: () => Promise<unknown>; stored?: boolean } = {},
): Harness {
  const state = { codes: [] as string[], logins: 0, logouts: 0, stored: over.stored ?? true };
  const runtime = {
    getAuth: async () =>
      (over.resolve ?? (async () => ({ auth: { apiKey: "sk-ant-oat-live" } })))(),
    hasConfiguredAuth: () => state.stored,
    login: async (_provider: string, _type: string, interaction: any) => {
      state.logins += 1;
      interaction.notify({ type: "auth_url", url: `${AUTH_URL}&n=${state.logins}` });
      state.codes.push(await interaction.prompt({ message: "code?", type: "manual_code" }));
      state.stored = true;
      return {};
    },
    logout: async () => {
      if (over.logoutFails) throw new Error("credential store delete failed");
      state.logouts += 1;
      state.stored = false;
    },
  } as unknown as AnthropicRuntime;
  return { anthropic: createAnthropic(runtime, memoryKv()), state };
}

/** Let the background retirement land. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("deadGrant", () => {
  it("recognizes the refusal that ends a sign-in", () => {
    expect(deadGrant(DEAD)).toBe(true);
  });

  it("reads the OAuth code wherever it sits in the message", () => {
    expect(deadGrant('body={"error":"invalid_grant"}')).toBe(true);
    expect(deadGrant("INVALID_GRANT")).toBe(true);
  });

  it("leaves a transient failure alone, since a retry may well fix it", () => {
    expect(deadGrant(TRANSIENT)).toBe(false);
    expect(deadGrant("Overloaded")).toBe(false);
    expect(deadGrant("HTTP request failed. status=500")).toBe(false);
    expect(deadGrant("HTTP request failed. status=429")).toBe(false);
    expect(deadGrant("")).toBe(false);
  });

  it("leaves a refused call alone, because pi renews the token behind it", () => {
    // A 401 says the access token is stale, which pi fixes by itself; only the grant behind it
    // dying is worth a credential.
    expect(deadGrant("HTTP request failed. status=401; body={}")).toBe(false);
    expect(deadGrant("Unauthorized")).toBe(false);
  });
});

describe("status", () => {
  it("is connected while a credential is stored", () => {
    expect(harness().anthropic.status()).toBe("connected");
  });

  it("is missing when there has never been one", () => {
    expect(harness({ stored: false }).anthropic.status()).toBe("missing");
  });

  it("is expired once a refusal has retired one", async () => {
    const { anthropic } = harness();
    anthropic.observe(DEAD);
    await settle();
    expect(anthropic.status()).toBe("expired");
  });

  it("is expired in the same tick the refusal was seen, before the delete lands", () => {
    const { anthropic } = harness();
    anthropic.observe(DEAD);
    expect(anthropic.status()).toBe("expired");
  });

  it("survives a restart, since the expiry is recorded", async () => {
    const kv = memoryKv();
    let stored = true;
    const runtime = {
      hasConfiguredAuth: () => stored,
      logout: async () => {
        stored = false;
      },
    } as unknown as AnthropicRuntime;
    createAnthropic(runtime, kv).observe(DEAD);
    await settle();
    // A fresh instance over the same store: no credential, but the expiry is remembered.
    expect(createAnthropic(runtime, kv).status()).toBe("expired");
  });
});

describe("observe", () => {
  it("deletes a credential a refusal has proven dead", async () => {
    const { anthropic, state } = harness();
    anthropic.observe(DEAD);
    await settle();
    expect(state.logouts).toBe(1);
    expect(state.stored).toBe(false);
  });

  it("records when the sign-in expired", async () => {
    const { anthropic } = harness();
    anthropic.observe(DEAD);
    await settle();
    expect(Date.parse(anthropic.expiredAt()!)).toBeGreaterThan(0);
  });

  it("never spends a working credential on a transient failure", async () => {
    const { anthropic, state } = harness();
    anthropic.observe(TRANSIENT);
    await settle();
    expect(state.logouts).toBe(0);
    expect(anthropic.status()).toBe("connected");
  });

  it("has nothing to retire when nothing is stored", async () => {
    const { anthropic, state } = harness({ stored: false });
    anthropic.observe(DEAD);
    await settle();
    expect(state.logouts).toBe(0);
    expect(anthropic.status()).toBe("missing");
  });

  it("retires once, however many failures follow", async () => {
    const { anthropic, state } = harness();
    anthropic.observe(DEAD);
    anthropic.observe(DEAD);
    await settle();
    anthropic.observe(DEAD);
    await settle();
    expect(state.logouts).toBe(1);
  });

  it("goes back to connected when the credential could not be deleted", async () => {
    // Better to keep answering with a credential that may work than to go mute over a file that
    // would not unlink.
    const { anthropic } = harness({ logoutFails: true });
    anthropic.observe(DEAD);
    await settle();
    expect(anthropic.status()).toBe("connected");
    expect(anthropic.expiredAt()).toBeUndefined();
  });
});

describe("token", () => {
  it("resolves the access token", async () => {
    expect(await harness().anthropic.token()).toBe("sk-ant-oat-live");
  });

  it("retires the credential when resolving it is refused for good", async () => {
    const { anthropic, state } = harness({
      resolve: async () => {
        throw new Error(DEAD);
      },
    });
    expect(await anthropic.token()).toBeUndefined();
    expect(anthropic.status()).toBe("expired");
    await settle();
    expect(state.logouts).toBe(1);
  });

  it("keeps the credential when resolving it merely failed", async () => {
    const { anthropic } = harness({
      resolve: async () => {
        throw new Error(TRANSIENT);
      },
    });
    expect(await anthropic.token()).toBeUndefined();
    expect(anthropic.status()).toBe("connected");
  });

  it("never throws, so a poll can lean on it", async () => {
    const { anthropic } = harness({
      resolve: async () => {
        throw "not even an error";
      },
    });
    expect(await anthropic.token()).toBeUndefined();
  });

  it("reports nothing when the provider is unconfigured", async () => {
    expect(await harness({ resolve: async () => undefined }).anthropic.token()).toBeUndefined();
  });
});

describe("login", () => {
  it("starts the flow and resolves the published authorize url", async () => {
    expect(await harness().anthropic.url()).toContain("claude.ai/oauth/authorize");
  });

  it("keeps one flow across repeated url() calls", async () => {
    const { anthropic, state } = harness();
    const [first, second] = await Promise.all([anthropic.url(), anthropic.url()]);
    expect(first).toBe(second);
    expect(state.logins).toBe(1);
  });

  it("hands the pasted code to the parked prompt", async () => {
    const { anthropic, state } = harness();
    await anthropic.url();
    await anthropic.submit("code#state");
    expect(state.codes).toEqual(["code#state"]);
  });

  it("starts the flow on submit even if no url was requested", async () => {
    const { anthropic, state } = harness();
    await anthropic.submit("abc");
    expect(state.logins).toBe(1);
    expect(state.codes).toEqual(["abc"]);
  });

  it("brings an expired sign-in back, expiry record and all", async () => {
    const { anthropic } = harness();
    anthropic.observe(DEAD);
    await settle();
    await anthropic.submit("fresh-code");
    expect(anthropic.status()).toBe("connected");
    expect(anthropic.expiredAt()).toBeUndefined();
  });

  it("rejects submit when the code is refused, and authorizes afresh next time", async () => {
    const runtime = {
      hasConfiguredAuth: () => false,
      login: async (_provider: string, _type: string, interaction: any) => {
        interaction.notify({ type: "auth_url", url: AUTH_URL });
        await interaction.prompt({ message: "code?", type: "manual_code" });
        throw new Error("invalid code");
      },
    } as unknown as AnthropicRuntime;
    const anthropic = createAnthropic(runtime, memoryKv());
    const first = await anthropic.url();
    expect(anthropic.submit("wrong")).rejects.toThrow("invalid code");
    await anthropic.submit("wrong").catch(() => {});
    expect(await anthropic.url()).toBe(first);
  });

  it("starts a new flow for the next code once one succeeded", async () => {
    const { anthropic, state } = harness();
    await anthropic.submit("one");
    await anthropic.submit("two");
    expect(state.codes).toEqual(["one", "two"]);
    expect(state.logins).toBe(2);
  });

  it("surfaces a login that fails before publishing a url instead of hanging", async () => {
    const runtime = {
      hasConfiguredAuth: () => false,
      login: async () => {
        throw new Error("port busy");
      },
    } as unknown as AnthropicRuntime;
    expect(createAnthropic(runtime, memoryKv()).url()).rejects.toThrow("port busy");
  });

  it("retries after such a failure", async () => {
    let attempts = 0;
    const runtime = {
      hasConfiguredAuth: () => false,
      login: async (_provider: string, _type: string, interaction: any) => {
        attempts += 1;
        if (attempts === 1) throw new Error("port busy");
        interaction.notify({ type: "auth_url", url: AUTH_URL });
        return new Promise(() => {});
      },
    } as unknown as AnthropicRuntime;
    const anthropic = createAnthropic(runtime, memoryKv());
    await anthropic.url().catch(() => {});
    expect(await anthropic.url()).toBe(AUTH_URL);
  });
});
