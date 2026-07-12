import { describe, expect, it } from "bun:test";

import { authorizeUrl, parseCode } from "../src/oauth";

describe("authorizeUrl", () => {
  it("builds a claude.ai authorize URL with PKCE and the user:profile scope", () => {
    const url = new URL(authorizeUrl("test-verifier"));
    expect(url.origin + url.pathname).toBe("https://claude.ai/oauth/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("test-verifier");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("scope")).toContain("user:profile");
  });
});

describe("parseCode", () => {
  it("splits code#state", () => {
    expect(parseCode("ABC123#STATE456")).toBe("ABC123");
  });

  it("extracts the code from a redirect URL", () => {
    expect(parseCode("http://localhost:53692/callback?code=ABC123&state=STATE456")).toBe("ABC123");
  });

  it("extracts the code from a bare query string", () => {
    expect(parseCode("code=ABC123&state=STATE456")).toBe("ABC123");
  });

  it("returns a bare code trimmed", () => {
    expect(parseCode("  ABC123  ")).toBe("ABC123");
  });
});
