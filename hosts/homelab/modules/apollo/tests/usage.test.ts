import { describe, expect, it } from "bun:test";

import { renderUsage } from "../src/usage";

describe("renderUsage", () => {
  it("reports when data is unavailable", () => {
    expect(renderUsage(null)).toContain("unavailable");
  });

  it("renders a bar per present limit with its utilization", () => {
    const html = renderUsage({
      five_hour: { resets_at: null, utilization: 42 },
      seven_day: { resets_at: null, utilization: 80 },
    });
    expect(html).toContain("Session (5h)");
    expect(html).toContain("42%");
    expect(html).toContain("Weekly (all models)");
    expect(html).toContain("80%");
    expect(html).not.toContain("Weekly (Sonnet)");
  });

  it("colors utilization by severity", () => {
    expect(renderUsage({ five_hour: { resets_at: null, utilization: 95 } })).toContain(
      "bg-red-500",
    );
    expect(renderUsage({ five_hour: { resets_at: null, utilization: 75 } })).toContain(
      "bg-amber-500",
    );
    expect(renderUsage({ five_hour: { resets_at: null, utilization: 10 } })).toContain(
      "bg-emerald-500",
    );
  });

  it("shows extra usage spend against a monthly cap", () => {
    const html = renderUsage({
      extra_usage: { is_enabled: true, monthly_limit: 1000, used_credits: 250, utilization: 25 },
    });
    expect(html).toContain("Extra usage");
    expect(html).toContain("$2.50 / $10.00");
  });

  it("shows extra usage with no cap", () => {
    const html = renderUsage({
      extra_usage: { is_enabled: true, monthly_limit: null, used_credits: 500, utilization: null },
    });
    expect(html).toContain("$5.00");
    expect(html).toContain("no limit");
  });

  it("shows Not enabled when extra usage is disabled", () => {
    const html = renderUsage({
      extra_usage: { is_enabled: false, monthly_limit: null, used_credits: 0, utilization: null },
    });
    expect(html).toContain("Extra usage");
    expect(html).toContain("Not enabled");
  });

  it("hides extra usage when absent from the response", () => {
    const html = renderUsage({ five_hour: { resets_at: null, utilization: 10 } });
    expect(html).not.toContain("Extra usage");
  });

  it("reports when no limits are present", () => {
    expect(renderUsage({})).toContain("No usage limits");
  });
});
