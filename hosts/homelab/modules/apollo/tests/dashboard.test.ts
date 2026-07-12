import { describe, expect, it } from "bun:test";

import { renderPage, renderState } from "../src/dashboard";
import type { WhatsAppState } from "../src/whatsapp";

const state = (over: Partial<WhatsAppState>): WhatsAppState => ({
  qr: undefined,
  status: "qr",
  user: undefined,
  ...over,
});

describe("renderPage", () => {
  it("includes the polling app region and assets", () => {
    const html = renderPage();
    expect(html).toContain(`id="app"`);
    expect(html).toContain(`hx-get="/status"`);
    expect(html).toContain("/app.css");
    expect(html).toContain("/htmx.min.js");
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
