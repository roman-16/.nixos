import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import type { Kv } from "./kv";

/**
 * Apollo's access to the model: whether it has any, how it is regained, and the one thing about it
 * that cannot be derived.
 *
 * A credential that can no longer be used is not a credential. Keeping one is what lets a dashboard
 * report a green "Connected to OpenRouter" while every message fails, because `hasConfiguredAuth`
 * only asks whether something is stored. So a credential a refusal has proven dead is deleted: the
 * store's own answer becomes true again, and the authorize-and-paste flow that was always there
 * comes back on screen with no second state to keep in step.
 *
 * pi offers no side-effect-free validity check - `checkAuth` reports a credential's type, not
 * whether it works - so the truth is only ever learned by resolving it: at startup, on the
 * dashboard's poll, and wherever a model call fails.
 *
 * Renewing fixes a running Apollo. pi's login writes straight over whatever is stored and auth is
 * re-read on every call, so nothing here needs a restart.
 */

const PROVIDER = "openrouter";

/** Where the fact that there used to be a working sign-in lives, since deleting it erases that. */
const INVALID_AT_KEY = "credentialsInvalidAt";

/** Everything that means the credential itself is dead, not the network being unkind. */
const DEAD_AUTH = /invalid_grant|\b401\b|unauthorized|invalid api key|no auth credentials/i;

export type CredentialStatus = "connected" | "invalid" | "missing";

/**
 * Whether a failure means the credential itself is finished, rather than the network being unkind.
 * pi flattens the provider's response into the message, so the auth code is read out of it: every
 * other failure (a timeout, a 500, a 429, DNS) is transient and must not cost a credential that
 * still works.
 */
export function deadGrant(detail: string): boolean {
  return DEAD_AUTH.test(detail);
}

export interface Credentials {
  /** When the credential was retired (ISO), or undefined when it has not been. */
  invalidAt(): string | undefined;
  /** Judge a failure, condemning the credential when the credential itself is finished. */
  observe(detail: string): void;
  status(): CredentialStatus;
  /** Hand pi the pasted code (or redirect URL); resolves once the credential is stored. */
  submit(input: string): Promise<void>;
  /** An access token, or undefined. Proves the credential resolves and retires it when it cannot. */
  token(): Promise<string | undefined>;
  /** The URL to authorize at, starting the flow on first use. */
  url(): Promise<string>;
}

interface Flow {
  done: Promise<unknown>;
  submit: (input: string) => void;
  url: Promise<string>;
}

/** The runtime surface this needs: the credential's whole lifecycle, and nothing else. */
export type CredentialRuntime = Pick<
  ModelRuntime,
  "getAuth" | "hasConfiguredAuth" | "login" | "logout"
>;

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createCredentials(runtime: CredentialRuntime, kv: Kv): Credentials {
  /**
   * Set the moment a refusal proves the credential dead, so every reader sees it in the tick the
   * failure was seen rather than once the delete has landed - which is what lets a turn that died
   * with the credential be told apart from one that merely failed. Reconciled by retire().
   */
  let condemned = false;
  let flow: Flow | undefined;

  async function retire(): Promise<void> {
    try {
      await runtime.logout(PROVIDER);
    } catch {
      // A store that will not be written is its own problem; going mute over a credential that is
      // still there would be a worse one, so the condemnation is withdrawn and the next failure
      // tries again.
      condemned = false;
      return;
    }
    kv.set(INVALID_AT_KEY, new Date().toISOString());
  }

  function observe(detail: string): void {
    if (condemned || !deadGrant(detail) || !runtime.hasConfiguredAuth(PROVIDER)) return;
    condemned = true;
    void retire();
  }

  function status(): CredentialStatus {
    if (condemned) return "invalid";
    if (runtime.hasConfiguredAuth(PROVIDER)) return "connected";
    return kv.get(INVALID_AT_KEY) ? "invalid" : "missing";
  }

  /**
   * pi owns the OAuth flow itself (PKCE, the authorization URL, the code exchange, and persisting
   * the credential), and exposes it as one long `login()` call that parks on a prompt for the
   * authorization code. The dashboard, being HTTP, needs that call to span two requests - render the
   * URL, then post the pasted code - so the parked login is held here and driven by url()/submit().
   */
  function start(): Flow {
    let submit!: (input: string) => void;
    const input = new Promise<string>((resolve) => {
      submit = resolve;
    });
    let publish!: (url: string) => void;
    const url = new Promise<string>((resolve) => {
      publish = resolve;
    });
    const done = runtime.login(PROVIDER, "oauth", {
      notify: (event) => {
        if (event.type === "auth_url") publish(event.url);
      },
      prompt: () => input,
    });
    // A parked flow settles long after the request that started it, so its rejection is observed
    // here; url() and submit() attach their own handlers to report it.
    done.catch(() => {});
    return { done, submit, url };
  }

  function clear(current: Flow): void {
    if (flow === current) flow = undefined;
  }

  return {
    invalidAt() {
      return kv.get(INVALID_AT_KEY);
    },
    observe,
    status,
    async submit(input) {
      const current = (flow ??= start());
      // Each authorization code belongs to one flow, so a retry always authorizes afresh.
      clear(current);
      current.submit(input);
      await current.done;
      // A stored credential is the whole of being connected, so the record of the last expiry goes
      // with the one it replaces.
      condemned = false;
      kv.remove(INVALID_AT_KEY);
    },
    async token() {
      try {
        return (await runtime.getAuth(PROVIDER))?.auth.apiKey;
      } catch (error) {
        observe(reason(error));
        return undefined;
      }
    },
    url() {
      const current = (flow ??= start());
      return Promise.race([
        current.url,
        // A login that fails before publishing a URL would leave url() hanging forever.
        current.done.then(
          () => current.url,
          (error: unknown) => {
            clear(current);
            throw error;
          },
        ),
      ]);
    },
  };
}
