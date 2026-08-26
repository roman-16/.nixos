import { describe, expect, it } from "bun:test";

import {
  type Credentials,
  type CredentialRuntime,
  createCredentials,
  deadGrant,
} from "../src/credentials";
import type { Kv } from "../src/kv";

const AUTH_URL = "https://openrouter.ai/auth?code=true";

/** The refusal Apollo actually got: an API key OpenRouter rejects. */
const DEAD =
  'OpenRouter request failed. status=401; url=https://openrouter.ai/api/v1/chat/completions; body={"error": {"message": "Invalid API key"}}\n    at postJson (/nix/store/x/openrouter.js:155:19)';

const TRANSIENT = "OpenRouter request failed. details=Error: connect ETIMEDOUT";

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
  credentials: Credentials;
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
    getAuth: async () => (over.resolve ?? (async () => ({ auth: { apiKey: "sk-live" } })))(),
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
  } as unknown as CredentialRuntime;
  return { credentials: createCredentials(runtime, memoryKv()), state };
}

/** Let the background retirement land. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("deadGrant", () => {
  it("recognizes the refusal that ends a credential", () => {
    expect(deadGrant(DEAD)).toBe(true);
  });

  it("reads the auth failure wherever it sits in the message", () => {
    expect(deadGrant('body={"error":"Invalid API key"}')).toBe(true);
    expect(deadGrant("INVALID API KEY")).toBe(true);
    expect(deadGrant("Unauthorized")).toBe(true);
    expect(deadGrant('body={"error":"invalid_grant"}')).toBe(true);
    expect(deadGrant("no auth credentials found")).toBe(true);
  });

  it("leaves a transient failure alone, since a retry may well fix it", () => {
    expect(deadGrant(TRANSIENT)).toBe(false);
    expect(deadGrant("Overloaded")).toBe(false);
    expect(deadGrant("HTTP request failed. status=500")).toBe(false);
    expect(deadGrant("HTTP request failed. status=429")).toBe(false);
    expect(deadGrant("")).toBe(false);
  });
});

describe("status", () => {
  it("is connected while a credential is stored", () => {
    expect(harness().credentials.status()).toBe("connected");
  });

  it("is missing when there has never been one", () => {
    expect(harness({ stored: false }).credentials.status()).toBe("missing");
  });

  it("is invalid once a refusal has retired one", async () => {
    const { credentials } = harness();
    credentials.observe(DEAD);
    await settle();
    expect(credentials.status()).toBe("invalid");
  });

  it("is invalid in the same tick the refusal was seen, before the delete lands", () => {
    const { credentials } = harness();
    credentials.observe(DEAD);
    expect(credentials.status()).toBe("invalid");
  });

  it("survives a restart, since the retirement is recorded", async () => {
    const kv = memoryKv();
    let stored = true;
    const runtime = {
      hasConfiguredAuth: () => stored,
      logout: async () => {
        stored = false;
      },
    } as unknown as CredentialRuntime;
    createCredentials(runtime, kv).observe(DEAD);
    await settle();
    // A fresh instance over the same store: no credential, but the invalidation is remembered.
    expect(createCredentials(runtime, kv).status()).toBe("invalid");
  });
});

describe("observe", () => {
  it("deletes a credential a refusal has proven dead", async () => {
    const { credentials, state } = harness();
    credentials.observe(DEAD);
    await settle();
    expect(state.logouts).toBe(1);
    expect(state.stored).toBe(false);
  });

  it("records when the credential was retired", async () => {
    const { credentials } = harness();
    credentials.observe(DEAD);
    await settle();
    expect(Date.parse(credentials.invalidAt()!)).toBeGreaterThan(0);
  });

  it("never spends a working credential on a transient failure", async () => {
    const { credentials, state } = harness();
    credentials.observe(TRANSIENT);
    await settle();
    expect(state.logouts).toBe(0);
    expect(credentials.status()).toBe("connected");
  });

  it("has nothing to retire when nothing is stored", async () => {
    const { credentials, state } = harness({ stored: false });
    credentials.observe(DEAD);
    await settle();
    expect(state.logouts).toBe(0);
    expect(credentials.status()).toBe("missing");
  });

  it("retires once, however many failures follow", async () => {
    const { credentials, state } = harness();
    credentials.observe(DEAD);
    credentials.observe(DEAD);
    await settle();
    credentials.observe(DEAD);
    await settle();
    expect(state.logouts).toBe(1);
  });

  it("goes back to connected when the credential could not be deleted", async () => {
    // Better to keep answering with a credential that may work than to go mute over a file that
    // would not unlink.
    const { credentials } = harness({ logoutFails: true });
    credentials.observe(DEAD);
    await settle();
    expect(credentials.status()).toBe("connected");
    expect(credentials.invalidAt()).toBeUndefined();
  });
});

describe("token", () => {
  it("resolves the access token", async () => {
    expect(await harness().credentials.token()).toBe("sk-live");
  });

  it("retires the credential when resolving it is refused for good", async () => {
    const { credentials, state } = harness({
      resolve: async () => {
        throw new Error(DEAD);
      },
    });
    expect(await credentials.token()).toBeUndefined();
    expect(credentials.status()).toBe("invalid");
    await settle();
    expect(state.logouts).toBe(1);
  });

  it("keeps the credential when resolving it merely failed", async () => {
    const { credentials } = harness({
      resolve: async () => {
        throw new Error(TRANSIENT);
      },
    });
    expect(await credentials.token()).toBeUndefined();
    expect(credentials.status()).toBe("connected");
  });

  it("never throws, so a poll can lean on it", async () => {
    const { credentials } = harness({
      resolve: async () => {
        throw "not even an error";
      },
    });
    expect(await credentials.token()).toBeUndefined();
  });

  it("reports nothing when the provider is unconfigured", async () => {
    expect(await harness({ resolve: async () => undefined }).credentials.token()).toBeUndefined();
  });
});

describe("login", () => {
  it("starts the flow and resolves the published authorize url", async () => {
    expect(await harness().credentials.url()).toContain("openrouter.ai/auth");
  });

  it("keeps one flow across repeated url() calls", async () => {
    const { credentials, state } = harness();
    const [first, second] = await Promise.all([credentials.url(), credentials.url()]);
    expect(first).toBe(second);
    expect(state.logins).toBe(1);
  });

  it("hands the pasted code to the parked prompt", async () => {
    const { credentials, state } = harness();
    await credentials.url();
    await credentials.submit("code#state");
    expect(state.codes).toEqual(["code#state"]);
  });

  it("starts the flow on submit even if no url was requested", async () => {
    const { credentials, state } = harness();
    await credentials.submit("abc");
    expect(state.logins).toBe(1);
    expect(state.codes).toEqual(["abc"]);
  });

  it("brings an invalid credential back, invalidation record and all", async () => {
    const { credentials } = harness();
    credentials.observe(DEAD);
    await settle();
    await credentials.submit("fresh-code");
    expect(credentials.status()).toBe("connected");
    expect(credentials.invalidAt()).toBeUndefined();
  });

  it("rejects submit when the code is refused, and authorizes afresh next time", async () => {
    const runtime = {
      hasConfiguredAuth: () => false,
      login: async (_provider: string, _type: string, interaction: any) => {
        interaction.notify({ type: "auth_url", url: AUTH_URL });
        await interaction.prompt({ message: "code?", type: "manual_code" });
        throw new Error("invalid code");
      },
    } as unknown as CredentialRuntime;
    const credentials = createCredentials(runtime, memoryKv());
    const first = await credentials.url();
    expect(credentials.submit("wrong")).rejects.toThrow("invalid code");
    await credentials.submit("wrong").catch(() => {});
    expect(await credentials.url()).toBe(first);
  });

  it("starts a new flow for the next code once one succeeded", async () => {
    const { credentials, state } = harness();
    await credentials.submit("one");
    await credentials.submit("two");
    expect(state.codes).toEqual(["one", "two"]);
    expect(state.logins).toBe(2);
  });

  it("surfaces a login that fails before publishing a url instead of hanging", async () => {
    const runtime = {
      hasConfiguredAuth: () => false,
      login: async () => {
        throw new Error("port busy");
      },
    } as unknown as CredentialRuntime;
    expect(createCredentials(runtime, memoryKv()).url()).rejects.toThrow("port busy");
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
    } as unknown as CredentialRuntime;
    const credentials = createCredentials(runtime, memoryKv());
    await credentials.url().catch(() => {});
    expect(await credentials.url()).toBe(AUTH_URL);
  });
});
