import { describe, expect, it } from "bun:test";

import { renderUsage } from "../src/usage";

describe("renderUsage", () => {
  it("shows the remaining credits and the bar when a limit is set", () => {
    const html = renderUsage({ used: 25.5, limit: 100, remaining: 74.5, reset: null });
    expect(html).toContain("$74.50");
    expect(html).toContain("Credits");
    expect(html).toContain('style="width:26%"');
  });

  it("shows only the used amount when there is no limit", () => {
    const html = renderUsage({ used: 25.5, limit: null, remaining: null, reset: null });
    expect(html).toContain("Credits used");
    expect(html).toContain("$25.50");
    expect(html).not.toContain("width:");
  });

  it("derives remaining from the limit when OpenRouter omits it", () => {
    const html = renderUsage({ used: 25.5, limit: 100, remaining: null, reset: null });
    expect(html).toContain("$74.50");
  });

  it("says the balance is unavailable when there is no data", () => {
    expect(renderUsage(null)).toContain("unavailable");
  });
});
