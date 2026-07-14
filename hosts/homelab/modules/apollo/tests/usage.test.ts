import { describe, expect, it } from "bun:test";

import { extraUsageValue, renderUsage, resetLabel } from "../src/usage";

describe("resetLabel", () => {
  it("is empty without a timestamp", () => {
    expect(resetLabel(null)).toBe("");
  });

  it("says now for past times", () => {
    expect(resetLabel(new Date(Date.now() - 1000).toISOString())).toBe("resets now");
  });

  it("formats bare minutes", () => {
    const at = new Date(Date.now() + 5 * 60 * 1000 + 30 * 1000).toISOString();
    expect(resetLabel(at)).toBe("resets in 5m");
  });

  it("formats hours and minutes", () => {
    const at = new Date(Date.now() + (2 * 60 + 30) * 60 * 1000 + 30 * 1000).toISOString();
    expect(resetLabel(at)).toBe("resets in 2h 30m");
  });

  it("formats days and hours", () => {
    const at = new Date(Date.now() + 26 * 60 * 60 * 1000 + 90 * 1000).toISOString();
    expect(resetLabel(at)).toBe("resets in 1d 2h");
  });
});

describe("extraUsageValue", () => {
  it("reports disabled", () => {
    expect(
      extraUsageValue({
        is_enabled: false,
        monthly_limit: null,
        used_credits: 0,
        utilization: null,
      }),
    ).toBe("not enabled");
  });

  it("shows spend against a monthly cap", () => {
    expect(
      extraUsageValue({
        is_enabled: true,
        monthly_limit: 1000,
        used_credits: 250,
        utilization: 25,
      }),
    ).toBe("$2.50 / $10.00");
  });

  it("shows spend with no cap", () => {
    expect(
      extraUsageValue({
        is_enabled: true,
        monthly_limit: null,
        used_credits: 500,
        utilization: null,
      }),
    ).toBe("$5.00 · no limit");
  });
});

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

  it("shows the extra-usage row", () => {
    const html = renderUsage({
      extra_usage: { is_enabled: true, monthly_limit: 1000, used_credits: 250, utilization: 25 },
    });
    expect(html).toContain("Extra usage");
    expect(html).toContain("$2.50 / $10.00");
  });

  it("hides extra usage when absent from the response", () => {
    expect(renderUsage({ five_hour: { resets_at: null, utilization: 10 } })).not.toContain(
      "Extra usage",
    );
  });

  it("reports when no limits are present", () => {
    expect(renderUsage({})).toContain("No usage limits");
  });
});
