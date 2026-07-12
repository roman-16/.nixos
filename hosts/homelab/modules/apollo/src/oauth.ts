import { createHash, randomBytes } from "node:crypto";

// pi's Claude Pro/Max OAuth client. The scopes include user:profile, so the
// resulting token can read the usage endpoint (a setup token cannot).
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const REDIRECT_URI = "http://localhost:53692/callback";
const SCOPES =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

export interface OAuthCredential {
  access: string;
  expires: number;
  refresh: string;
}

/** A fresh PKCE verifier. pi (and this flow) reuse it as the OAuth `state`. */
export function createVerifier(): string {
  return randomBytes(32).toString("base64url");
}

/** Authorization URL to open in the browser; `code=true` makes Anthropic show a pastable code. */
export function authorizeUrl(verifier: string): string {
  const challenge = createHash("sha256").update(verifier).digest().toString("base64url");
  return `${AUTHORIZE_URL}?${new URLSearchParams({
    client_id: CLIENT_ID,
    code: "true",
    code_challenge: challenge,
    code_challenge_method: "S256",
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPES,
    state: verifier,
  })}`;
}

/** Extract the authorization code from a pasted `code#state`, redirect URL, or bare code. */
export function parseCode(input: string): string {
  const value = input.trim();
  try {
    return new URL(value).searchParams.get("code") ?? "";
  } catch {
    // not a URL
  }
  if (value.includes("#")) return value.split("#", 1)[0] ?? "";
  if (value.includes("code=")) return new URLSearchParams(value).get("code") ?? "";
  return value;
}

/** Exchange an authorization code for OAuth tokens. Returns undefined on failure. */
export async function exchangeCode(
  code: string,
  verifier: string,
): Promise<OAuthCredential | undefined> {
  try {
    const res = await fetch(TOKEN_URL, {
      body: JSON.stringify({
        client_id: CLIENT_ID,
        code,
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: REDIRECT_URI,
        state: verifier,
      }),
      headers: { accept: "application/json", "content-type": "application/json" },
      method: "POST",
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as {
      access_token: string;
      expires_in: number;
      refresh_token: string;
    };
    return {
      access: data.access_token,
      expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
      refresh: data.refresh_token,
    };
  } catch {
    return undefined;
  }
}
