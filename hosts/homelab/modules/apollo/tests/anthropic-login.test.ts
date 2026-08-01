import { describe, expect, it } from "bun:test";

import { createAnthropicLogin, type LoginRuntime } from "../src/anthropic-login";

const AUTH_URL = "https://claude.ai/oauth/authorize?code=true";

interface Recorder {
  calls: number;
  /** Codes handed to the parked prompt, in order. */
  codes: string[];
  runtime: LoginRuntime;
}

/**
 * A runtime whose login publishes an authorization URL, then parks on the code prompt exactly like
 * pi's flow. `outcome` decides what the login does with the pasted code.
 */
function recorder(outcome: (code: string) => Promise<unknown> = async () => "ok"): Recorder {
  const rec: Recorder = {
    calls: 0,
    codes: [],
    runtime: {
      login: async (_provider: string, _type: string, interaction: any) => {
        rec.calls += 1;
        interaction.notify({ type: "auth_url", url: `${AUTH_URL}&n=${rec.calls}` });
        const code = await interaction.prompt({ message: "code?", type: "manual_code" });
        rec.codes.push(code);
        return (await outcome(code)) as never;
      },
    } as unknown as LoginRuntime,
  };
  return rec;
}

/** A runtime whose login fails before it ever publishes a URL (e.g. the callback port is taken). */
function failingRuntime(message: string): LoginRuntime {
  return {
    login: async () => {
      throw new Error(message);
    },
  } as unknown as LoginRuntime;
}

describe("createAnthropicLogin", () => {
  it("starts the flow and resolves the published authorize url", async () => {
    const login = createAnthropicLogin(recorder().runtime);
    expect(await login.url()).toContain("claude.ai/oauth/authorize");
  });

  it("keeps one flow across repeated url() calls", async () => {
    const rec = recorder();
    const login = createAnthropicLogin(rec.runtime);
    const [first, second] = await Promise.all([login.url(), login.url()]);
    expect(first).toBe(second);
    expect(rec.calls).toBe(1);
  });

  it("hands the pasted code to the parked prompt", async () => {
    const rec = recorder();
    const login = createAnthropicLogin(rec.runtime);
    await login.url();
    await login.submit("code#state");
    expect(rec.codes).toEqual(["code#state"]);
  });

  it("starts the flow on submit even if no url was requested", async () => {
    const rec = recorder();
    await createAnthropicLogin(rec.runtime).submit("abc");
    expect(rec.calls).toBe(1);
    expect(rec.codes).toEqual(["abc"]);
  });

  it("rejects submit when the code is refused, and authorizes afresh next time", async () => {
    const rec = recorder(async () => {
      throw new Error("invalid code");
    });
    const login = createAnthropicLogin(rec.runtime);
    const first = await login.url();
    expect(login.submit("wrong")).rejects.toThrow("invalid code");
    await login.submit("wrong").catch(() => {});
    expect(await login.url()).not.toBe(first);
    expect(rec.calls).toBeGreaterThan(1);
  });

  it("starts a new flow for the next code once one succeeded", async () => {
    const rec = recorder();
    const login = createAnthropicLogin(rec.runtime);
    await login.submit("one");
    await login.submit("two");
    expect(rec.codes).toEqual(["one", "two"]);
    expect(rec.calls).toBe(2);
  });

  it("surfaces a login that fails before publishing a url instead of hanging", async () => {
    const login = createAnthropicLogin(failingRuntime("port busy"));
    expect(login.url()).rejects.toThrow("port busy");
  });

  it("retries after such a failure", async () => {
    let attempts = 0;
    const runtime = {
      login: async (_provider: string, _type: string, interaction: any) => {
        attempts += 1;
        if (attempts === 1) throw new Error("port busy");
        interaction.notify({ type: "auth_url", url: AUTH_URL });
        return new Promise(() => {});
      },
    } as unknown as LoginRuntime;
    const login = createAnthropicLogin(runtime);
    await login.url().catch(() => {});
    expect(await login.url()).toBe(AUTH_URL);
  });
});
