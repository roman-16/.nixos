import { describe, expect, it } from "bun:test";

import {
  renderContext,
  renderLogs,
  renderPage,
  renderSummary,
  sessionStatus,
  type SummaryArgs,
} from "../src/dashboard";

const summary = (over: Partial<SummaryArgs>): SummaryArgs => ({
  anthropicConnected: true,
  authUrl: "",
  linking: false,
  usage: null,
  whatsapp: { qr: undefined, status: "connected", user: "4369912345678" },
  ...over,
});

describe("renderPage", () => {
  it("includes every polling region and version-busted assets", () => {
    const html = renderPage("abc123");
    expect(html).toContain(`id="summary"`);
    expect(html).toContain(`hx-get="/summary"`);
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
    expect(html).toContain(`id="lightbox"`);
  });

  it("sticks the chat to the bottom only when already near it", () => {
    const html = renderPage("v");
    expect(html).toContain("hx-on::before-swap");
    expect(html).toContain("hx-on::after-settle");
    expect(html).toContain("dataset.stick");
  });
});

describe("renderSummary", () => {
  it("shows the linked account and usage bars when everything is connected", async () => {
    const html = await renderSummary(
      summary({
        usage: {
          extra_usage: {
            is_enabled: true,
            monthly_limit: 1000,
            used_credits: 250,
            utilization: 25,
          },
          five_hour: { resets_at: null, utilization: 63 },
          seven_day: { resets_at: null, utilization: 43 },
        },
      }),
    );
    expect(html).toContain("Linked");
    expect(html).toContain("+4369912345678");
    expect(html).toContain("Connected to Anthropic");
    expect(html).toContain("Session (5h)");
    expect(html).toContain("63%");
    expect(html).toContain("Weekly (all models)");
    expect(html).toContain("43%");
    expect(html).toContain("$2.50 / $10.00");
    expect(html).not.toContain(`hx-post="/link"`);
    expect(html).not.toContain(`hx-post="/connect"`);
  });

  it("stays connected even when usage data is unavailable", async () => {
    const html = await renderSummary(summary({ usage: null }));
    expect(html).toContain("Connected to Anthropic");
    expect(html).toContain("unavailable");
  });

  it("offers the link flow when whatsapp is not connected", async () => {
    const html = await renderSummary(
      summary({ whatsapp: { qr: undefined, status: "qr", user: undefined } }),
    );
    expect(html).toContain("Not linked");
    expect(html).toContain(`hx-post="/link"`);
  });

  it("renders a QR while linking", async () => {
    const html = await renderSummary(
      summary({ linking: true, whatsapp: { qr: "2@abc,def", status: "qr", user: undefined } }),
    );
    expect(html).toContain("<svg");
    expect(html).toContain("Waiting for scan");
    expect(html).toContain("Refresh QR");
  });

  it("shows a placeholder while linking without a QR yet", async () => {
    const html = await renderSummary(
      summary({
        linking: true,
        whatsapp: { qr: undefined, status: "connecting", user: undefined },
      }),
    );
    expect(html).toContain("Generating QR");
    expect(html).not.toContain("<svg");
  });

  it("offers the claude connect flow when disconnected", async () => {
    const html = await renderSummary(
      summary({ anthropicConnected: false, authUrl: "https://claude.ai/oauth/authorize?x=1" }),
    );
    expect(html).toContain("Not connected to Anthropic");
    expect(html).toContain("https://claude.ai/oauth/authorize?x=1");
    expect(html).toContain(`hx-post="/connect"`);
    expect(html).toContain(`name="code"`);
  });

  it("surfaces a connect error", async () => {
    const html = await renderSummary(
      summary({ anthropicConnected: false, authUrl: "u", connectError: "nope" }),
    );
    expect(html).toContain("nope");
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
