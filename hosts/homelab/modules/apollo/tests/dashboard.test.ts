import { describe, expect, it } from "bun:test";

import {
  renderContext,
  renderLogs,
  renderPage,
  renderSkills,
  renderStop,
  renderSummary,
  sessionStatus,
  type SkillInfo,
  type SummaryArgs,
} from "../src/dashboard";

const summary = (over: Partial<SummaryArgs>): SummaryArgs => ({
  anthropicConnected: true,
  authUrl: "",
  linking: false,
  usage: null,
  whatsapp: { downSince: undefined, qr: undefined, status: "connected", user: "4369912345678" },
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
    expect(html).toContain(`id="tokens-daily"`);
    expect(html).toContain(`hx-get="/tokens/daily"`);
    expect(html).toContain("Daily breakdown");
    expect(html).toContain("/app.css?v=abc123");
    expect(html).toContain("/htmx.min.js?v=abc123");
    expect(html).toContain(`hx-post="/compact"`);
    expect(html).toContain(`hx-post="/reload"`);
    expect(html).toContain(`id="session-status"`);
    expect(html).toContain("Compact");
    expect(html).toContain("Reload");
    expect(html).toContain(`id="skills"`);
    expect(html).toContain(`hx-get="/skills"`);
    expect(html).toContain(`id="log-list"`);
    expect(html).toContain(`hx-get="/logs"`);
    expect(html).toContain(`id="logs-filter"`);
    expect(html).toContain(`id="lightbox"`);
  });

  it("auto-loads older messages on scroll instead of a button", () => {
    const html = renderPage("v");
    expect(html).toContain(`id="chat-window"`);
    expect(html).toContain(`name="count"`);
    expect(html).toContain(`hx-include="#chat-window, #chat-version"`);
    expect(html).toContain("chatReload");
    expect(html).toContain("chat-more"); // server-rendered "more history" marker the script watches
    expect(html).toContain("distanceToOldest"); // the near-top scroll handler
    expect(html).not.toContain("Load older"); // loading is scroll-driven, not a manual button
  });

  it("holds the view still across a swap and never loads off its own completion", () => {
    const html = renderPage("v");
    // The distance from the newest end is captured before a swap and restored after it, so
    // prepended history lands above the viewport instead of re-pinning to the oldest edge.
    expect(html).toContain(`chat.addEventListener("htmx:beforeSwap"`);
    expect(html).toContain(`chat.addEventListener("htmx:afterSwap"`);
    expect(html).toContain("keep = chat.scrollTop");
    expect(html).toContain("chat.scrollTop = keep");
    // A load that triggers the next load is a loop; growth follows a scroll gesture only.
    expect(html).not.toContain(`chat.addEventListener("htmx:afterSettle"`);
  });

  it("wires up WhatsApp-style chat copy", () => {
    const html = renderPage("v");
    expect(html).toContain('addEventListener("copy"');
    expect(html).toContain("shouldSwap");
  });

  it("splits the chat into a reversed viewport and a transcript in reading order", () => {
    const html = renderPage("v");
    // #chat is reversed for bottom-anchoring; its single child holds the rows in DOM order, so
    // selection and copy follow what is on screen.
    expect(html).toContain("flex-col-reverse");
    expect(html).toContain(`id="chat-log"`);
    // Rows must not flex-shrink, or overflow-hidden disclosures collapse to their border.
    expect(html).toContain("[&>*]:shrink-0");
    // Bottom-anchoring is the container's job, not hand-rolled scroll-to-bottom on each swap.
    expect(html).not.toContain("hx-on::before-swap");
    expect(html).not.toContain("hx-on::after-settle");
    expect(html).not.toContain("dataset.stick");
  });

  it("orders sections conversation, tokens, skills, WhatsApp/Claude, then logs", () => {
    const html = renderPage("v");
    const order = ['id="chat"', 'id="tokens"', 'id="skills"', 'id="summary"', 'id="log-list"'].map(
      (marker) => html.indexOf(marker),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
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
      summary({ whatsapp: { downSince: 0, qr: undefined, status: "qr", user: undefined } }),
    );
    expect(html).toContain("Not linked");
    expect(html).toContain(`hx-post="/link"`);
  });

  it("renders a QR while linking", async () => {
    const html = await renderSummary(
      summary({
        linking: true,
        whatsapp: { downSince: 0, qr: "2@abc,def", status: "qr", user: undefined },
      }),
    );
    expect(html).toContain("<svg");
    expect(html).toContain("Waiting for scan");
    expect(html).toContain("Refresh QR");
  });

  it("shows a placeholder while linking without a QR yet", async () => {
    const html = await renderSummary(
      summary({
        linking: true,
        whatsapp: { downSince: 0, qr: undefined, status: "connecting", user: undefined },
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

  it("stamps each row with a DD.MM date and HH:MM:SS time", () => {
    const html = renderLogs([{ level: 30, msg: "hi", time: 1_700_000_000_000 }]);
    expect(html).toMatch(/\d{2}\.\d{2} \d{2}:\d{2}:\d{2}/);
  });
});

describe("renderStop", () => {
  it("is enabled and posts to /stop when a run is active", () => {
    const html = renderStop(true);
    expect(html).toContain(`hx-post="/stop"`);
    expect(html).not.toContain("<button disabled");
  });

  it("is disabled when idle", () => {
    expect(renderStop(false)).toContain("<button disabled");
  });
});

describe("renderSkills", () => {
  const skill = (over: Partial<SkillInfo> = {}): SkillInfo => ({
    description: "does a thing",
    disabled: false,
    name: "macros",
    ...over,
  });

  it("shows a placeholder when no skills are loaded", () => {
    expect(renderSkills([])).toContain("No skills loaded");
  });

  it("renders a card with the skill name and description", () => {
    const html = renderSkills([skill({ description: "track nutrition", name: "macros" })]);
    expect(html).toContain("macros");
    expect(html).toContain("track nutrition");
  });

  it("escapes the name and description", () => {
    const html = renderSkills([
      skill({ description: "<b>desc</b>", name: "<script>alert(1)</script>" }),
    ]);
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;b&gt;desc&lt;/b&gt;");
    expect(html).not.toContain("<script>");
  });

  it("tags a skill hidden from the model as manual", () => {
    expect(renderSkills([skill({ disabled: true })])).toContain("manual");
    expect(renderSkills([skill({ disabled: false })])).not.toContain("manual");
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
