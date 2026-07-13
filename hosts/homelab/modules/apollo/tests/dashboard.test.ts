import { describe, expect, it } from "bun:test";

import { renderAnthropic, renderContext, renderPage, renderState } from "../src/dashboard";
import type { WhatsAppState } from "../src/whatsapp";

const state = (over: Partial<WhatsAppState>): WhatsAppState => ({
  qr: undefined,
  status: "qr",
  user: undefined,
  ...over,
});

describe("renderPage", () => {
  it("includes the polling app region and version-busted assets", () => {
    const html = renderPage("abc123");
    expect(html).toContain(`id="app"`);
    expect(html).toContain(`hx-get="/status"`);
    expect(html).toContain(`id="chat"`);
    expect(html).toContain(`hx-get="/chat"`);
    expect(html).toContain("/app.css?v=abc123");
    expect(html).toContain("/htmx.min.js?v=abc123");
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
  it("shows connected + usage bars when data is present", () => {
    const html = renderAnthropic({ five_hour: { resets_at: null, utilization: 30 } }, "");
    expect(html).toContain("Connected to Anthropic");
    expect(html).toContain("Session (5h)");
    expect(html).not.toContain('hx-post="/connect"');
  });

  it("shows a login form with the auth URL when not connected", () => {
    const html = renderAnthropic(null, "https://claude.ai/oauth/authorize?x=1");
    expect(html).toContain("Not connected to Anthropic");
    expect(html).toContain("https://claude.ai/oauth/authorize?x=1");
    expect(html).toContain('hx-post="/connect"');
    expect(html).toContain('name="code"');
  });

  it("surfaces an error message when provided", () => {
    expect(renderAnthropic(null, "url", "nope")).toContain("nope");
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
