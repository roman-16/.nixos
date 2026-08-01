import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

/**
 * The dashboard's Anthropic sign-in. pi owns the OAuth flow itself (PKCE, the authorization URL,
 * the code exchange, and persisting the credential), and exposes it as one long `login()` call that
 * parks on a prompt for the authorization code. The dashboard, being HTTP, needs that call to span
 * two requests - render the URL, then post the pasted code - so the parked login is held here and
 * driven by `url()` and `submit()`.
 */
export interface AnthropicLogin {
  /** Hand pi the pasted code (or redirect URL); resolves once the credential is stored. */
  submit(input: string): Promise<void>;
  /** The URL to authorize at, starting the flow on first use. */
  url(): Promise<string>;
}

interface Flow {
  done: Promise<unknown>;
  submit: (input: string) => void;
  url: Promise<string>;
}

/** Runtime surface used here: only the login call. */
export type LoginRuntime = Pick<ModelRuntime, "login">;

export function createAnthropicLogin(runtime: LoginRuntime): AnthropicLogin {
  let flow: Flow | undefined;

  function start(): Flow {
    let submit!: (input: string) => void;
    const input = new Promise<string>((resolve) => {
      submit = resolve;
    });
    let publish!: (url: string) => void;
    const url = new Promise<string>((resolve) => {
      publish = resolve;
    });
    const done = runtime.login("anthropic", "oauth", {
      notify: (event) => {
        if (event.type === "auth_url") publish(event.url);
      },
      prompt: () => input,
    });
    // A parked flow settles long after the request that started it, so its rejection is observed
    // here; `url()` and `submit()` attach their own handlers to report it.
    done.catch(() => {});
    return { done, submit, url };
  }

  function clear(current: Flow): void {
    if (flow === current) flow = undefined;
  }

  return {
    async submit(input) {
      const current = (flow ??= start());
      // Each authorization code belongs to one flow, so a retry always authorizes afresh.
      clear(current);
      current.submit(input);
      await current.done;
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
