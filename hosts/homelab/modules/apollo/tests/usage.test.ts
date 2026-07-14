import { describe, expect, it } from "bun:test";

import { extraUsageValue, resetLabel } from "../src/usage";

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
