import { describe, expect, it } from "bun:test";

import {
  renderAnthropic,
  renderContext,
  renderLogs,
  renderPage,
  renderPills,
  renderState,
  sessionStatus,
} from "../src/dashboard";
import type { WhatsAppState } from "../src/whatsapp";

const state = (over: Partial<WhatsAppState>): WhatsAppState => ({
  qr: undefined,
  status: "qr",
  user: undefined,
  ...over,
});

describe("renderPage", () => {
  it("includes every polling region and version-busted assets", () => {
    const html = renderPage("abc123");
    expect(html).toContain(`id="pills"`);
    expect(html).toContain(`hx-get="/pills"`);
    expect(html).toContain(`id="whatsapp"`);
    expect(html).toContain(`hx-get="/status"`);
    expect(html).toContain(`id="anthropic"`);
    expect(html).toContain(`hx-get="/anthropic"`);
    expect(html).toContain(`id="chat"`);
    expect(html).toContain(`hx-get="/chat"`);
    expect(html).toContain(`id="context"`);
    expect(html).toContain(`hx-get="/context"`);
    expect(html).toContain("/app.css?v=abc123");
    expect(html).toContain("/htmx.min.js?v=abc123");
    expect(html).toContain(`hx-post="/compact"`);
    expect(html).toContain(`hx-post="/reload"`);
    expect(html).toContain(`id="session-status"`);
    expect(html).toContain("Compact");
    expect(html).toContain("Reload");
    expect(html).toContain(`id="log-list"`);
    expect(html).toContain(`hx-get="/logs"`);
    expect(html).toContain(`id="logs-filter"`);
  });

  it("sticks the chat to the bottom only when already near it", () => {
    const html = renderPage("v");
    expect(html).toContain("hx-on::before-swap");
    expect(html).toContain("hx-on::after-settle");
    expect(html).toContain("dataset.stick");
  });
});

describe("renderPills", () => {
  it("shows all three pills with card anchors when everything is healthy", () => {
    const html = renderPills("connected", true, {
      contextWindow: 1000000,
      percent: 42,
      tokens: 420000,
    });
    expect(html).toContain(`href="#whatsapp-card"`);
    expect(html).toContain(`href="#anthropic-card"`);
    expect(html).toContain(`href="#chat-card"`);
    expect(html).toContain("WhatsApp");
    expect(html).toContain("Claude");
    expect(html).toContain("Ctx 42%");
    expect(html.match(/bg-emerald-400/g)?.length).toBe(3);
  });

  it("colors degraded states and omits the context pill without usage", () => {
    const html = renderPills("loggedOut", false, undefined);
    expect(html).toContain("bg-red-400");
    expect(html).toContain("bg-neutral-600");
    expect(html).not.toContain("Ctx");
  });

  it("pulses while connecting and skips the context pill when percent is unknown", () => {
    const html = renderPills("connecting", true, {
      contextWindow: 1000000,
      percent: null,
      tokens: null,
    });
    expect(html).toContain("animate-pulse");
    expect(html).not.toContain("Ctx");
  });

  it("colors high context usage red", () => {
    const html = renderPills("connected", true, {
      contextWindow: 1000000,
      percent: 95,
      tokens: 950000,
    });
    expect(html).toContain("Ctx 95%");
    expect(html).toContain("bg-red-400");
  });
});

describe("renderLogs", () => {
  it("shows a placeholder when empty", () => {
    expect(renderLogs([])).toContain("No logs");
  });

  it("renders the level label and message, escaping content and showing extras", () => {
    const html = renderLogs([
      { err: { message: "boom" }, level: 50, msg: "<oops>", time: 1_700_000_000_000 },
    ]);
    expect(html).toContain("ERROR");
    expect(html).toContain("&lt;oops&gt;");
    expect(html).not.toContain("<oops>");
    expect(html).toContain("err");
  });
});

describe("sessionStatus", () => {
  it("labels reload success, busy, and error variants", () => {
    expect(sessionStatus("reload", "ok")).toContain("Reloaded");
    expect(sessionStatus("reload", "busy")).toContain("Busy");
    expect(sessionStatus("reload", "error")).toContain("Reload failed");
  });

  it("labels compact success, busy, and error variants", () => {
    expect(sessionStatus("compact", "ok")).toContain("Compacted");
    expect(sessionStatus("compact", "busy")).toContain("Busy");
    expect(sessionStatus("compact", "error")).toContain("Compact failed");
  });
});

describe("renderState", () => {
  it("shows the linked user when connected", async () => {
    const html = await renderState(state({ status: "connected", user: "4369912345678" }), false);
    expect(html).toContain("Linked");
    expect(html).toContain("+4369912345678");
    expect(html).not.toContain('hx-post="/link"');
  });

  it("shows a link button when not linked and not linking", async () => {
    const html = await renderState(state({ status: "qr" }), false);
    expect(html).toContain('hx-post="/link"');
    expect(html).toContain("Not linked");
  });

  it("renders a QR while linking", async () => {
    const html = await renderState(state({ qr: "2@abc,def", status: "qr" }), true);
    expect(html).toContain("<svg");
    expect(html).toContain("Waiting for scan");
  });

  it("shows a placeholder while linking without a QR yet", async () => {
    const html = await renderState(state({ status: "connecting" }), true);
    expect(html).toContain("Generating QR");
    expect(html).not.toContain("<svg");
  });
});

describe("renderAnthropic", () => {
  it("shows connected + usage bars when connected with usage data", () => {
    const html = renderAnthropic(true, { five_hour: { resets_at: null, utilization: 30 } }, "");
    expect(html).toContain("Connected to Anthropic");
    expect(html).toContain("Session (5h)");
    expect(html).not.toContain('hx-post="/connect"');
  });

  it("stays connected even when usage data is unavailable", () => {
    const html = renderAnthropic(true, null, "");
    expect(html).toContain("Connected to Anthropic");
    expect(html).toContain("unavailable");
    expect(html).not.toContain('hx-post="/connect"');
  });

  it("shows a login form with the auth URL when not connected", () => {
    const html = renderAnthropic(false, null, "https://claude.ai/oauth/authorize?x=1");
    expect(html).toContain("Not connected to Anthropic");
    expect(html).toContain("https://claude.ai/oauth/authorize?x=1");
    expect(html).toContain('hx-post="/connect"');
    expect(html).toContain('name="code"');
  });

  it("surfaces an error message when provided", () => {
    expect(renderAnthropic(false, null, "url", "nope")).toContain("nope");
  });
});

describe("renderContext", () => {
  it("shows percent and humanized window with a bar", () => {
    const html = renderContext({ contextWindow: 1000000, percent: 54.7, tokens: 547000 });
    expect(html).toContain("54.7% / 1.0M");
    expect(html).toContain("width:54.7%");
  });

  it("colors high usage red", () => {
    expect(renderContext({ contextWindow: 1000000, percent: 95, tokens: 950000 })).toContain(
      "bg-red-500",
    );
  });

  it("shows the window but no bar when tokens are unknown (post-compaction)", () => {
    const html = renderContext({ contextWindow: 1000000, percent: null, tokens: null });
    expect(html).toContain("1.0M");
    expect(html).not.toContain("width:");
  });

  it("reports unavailable when usage is undefined", () => {
    expect(renderContext(undefined)).toContain("unavailable");
  });
});
