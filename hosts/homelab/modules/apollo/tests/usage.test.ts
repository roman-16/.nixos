import { describe, expect, it } from "bun:test";

import { parseUsage, type PlanUsage, renderUsage, resetLabel } from "../src/usage";

const usage = (over: Partial<PlanUsage> = {}): PlanUsage => ({
  limits: [],
  spend: null,
  ...over,
});

const eur = (amount: number) => ({ amount, currency: "EUR" });

describe("parseUsage", () => {
  it("names each limit the way the account does", () => {
    const parsed = parseUsage({
      limits: [
        { kind: "session", percent: 25, resets_at: "2026-08-31T17:40:00Z", scope: null },
        { kind: "weekly_all", percent: 29, resets_at: "2026-09-01T17:00:00Z", scope: null },
        {
          kind: "weekly_scoped",
          percent: 0,
          resets_at: null,
          scope: { model: { display_name: "Fable" } },
        },
      ],
    });
    expect(parsed.limits).toEqual([
      { label: "Session", percent: 25, resetsAt: "2026-08-31T17:40:00Z" },
      { label: "Weekly (all models)", percent: 29, resetsAt: "2026-09-01T17:00:00Z" },
      { label: "Weekly (Fable)", percent: 0, resetsAt: null },
    ]);
  });

  it("shows a limit the account invents rather than dropping it", () => {
    expect(parseUsage({ limits: [{ kind: "monthly_agents", percent: 5 }] }).limits).toEqual([
      { label: "Monthly agents", percent: 5, resetsAt: null },
    ]);
  });

  it("names a scoped limit even when the model behind it is not named", () => {
    expect(parseUsage({ limits: [{ kind: "weekly_scoped", percent: 3 }] }).limits[0]?.label).toBe(
      "Weekly (scoped)",
    );
  });

  it("skips a limit with no percentage, since there is no bar to draw", () => {
    expect(parseUsage({ limits: [{ kind: "session", percent: null }] }).limits).toEqual([]);
  });

  it("reads spend in its own currency, out of minor units", () => {
    expect(
      parseUsage({
        spend: {
          enabled: true,
          limit: { amount_minor: 5000, currency: "EUR", exponent: 2 },
          used: { amount_minor: 250, currency: "EUR", exponent: 2 },
        },
      }).spend,
    ).toEqual({
      enabled: true,
      limit: { amount: 50, currency: "EUR" },
      used: { amount: 2.5, currency: "EUR" },
    });
  });

  it("treats an uncapped spend as uncapped rather than as zero", () => {
    expect(
      parseUsage({
        spend: { enabled: false, limit: null, used: { amount_minor: 0, currency: "EUR" } },
      }).spend,
    ).toEqual({ enabled: false, limit: null, used: { amount: 0, currency: "EUR" } });
  });

  it("drops spend that names no currency, since it cannot be shown as money", () => {
    expect(parseUsage({ spend: { enabled: true, used: { amount_minor: 250 } } }).spend).toBeNull();
  });

  it("survives a response that says nothing at all", () => {
    expect(parseUsage({})).toEqual({ limits: [], spend: null });
  });
});

describe("resetLabel", () => {
  it("is empty without a timestamp", () => {
    expect(resetLabel(null)).toBe("");
  });

  it("is empty when the timestamp is not one", () => {
    expect(resetLabel("whenever")).toBe("");
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

describe("renderUsage", () => {
  it("reports when data is unavailable", () => {
    expect(renderUsage(null)).toContain("unavailable");
  });

  it("reports when the plan named no limits", () => {
    expect(renderUsage(usage())).toContain("No usage limits");
  });

  it("draws a bar per limit, labelled as the plan named it", () => {
    const html = renderUsage(
      usage({
        limits: [
          { label: "Session", percent: 25, resetsAt: null },
          { label: "Weekly (all models)", percent: 29, resetsAt: null },
          { label: "Weekly (Fable)", percent: 0, resetsAt: null },
        ],
      }),
    );
    expect(html).toContain("Session");
    expect(html).toContain("25%");
    expect(html).toContain("Weekly (all models)");
    expect(html).toContain("29%");
    expect(html).toContain("Weekly (Fable)");
    expect(html).toContain('style="width:0%"');
  });

  it("says when each limit comes back", () => {
    const at = new Date(Date.now() + 2 * 60 * 60 * 1000 + 60 * 1000).toISOString();
    expect(
      renderUsage(usage({ limits: [{ label: "Session", percent: 40, resetsAt: at }] })),
    ).toContain("resets in 2h 1m");
  });

  it("colors a limit by how close it is to spent", () => {
    const at = (percent: number) =>
      renderUsage(usage({ limits: [{ label: "S", percent, resetsAt: null }] }));
    expect(at(95)).toContain("bg-red-500");
    expect(at(75)).toContain("bg-amber-500");
    expect(at(10)).toContain("bg-emerald-500");
  });

  it("keeps the bar inside its track however the plan reports the number", () => {
    expect(
      renderUsage(usage({ limits: [{ label: "S", percent: 140, resetsAt: null }] })),
    ).toContain('style="width:100%"');
    expect(renderUsage(usage({ limits: [{ label: "S", percent: -5, resetsAt: null }] }))).toContain(
      'style="width:0%"',
    );
  });

  it("escapes a label the plan chose, since Apollo did not write it", () => {
    const html = renderUsage(
      usage({ limits: [{ label: "<b>x</b>", percent: 1, resetsAt: null }] }),
    );
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toContain("<b>x</b>");
  });

  it("says extra usage is off rather than showing a spend of nothing", () => {
    const html = renderUsage(usage({ spend: { enabled: false, limit: null, used: eur(0) } }));
    expect(html).toContain("Extra usage");
    expect(html).toContain("not enabled");
    expect(html).not.toContain("€0.00");
  });

  it("shows spend against a cap", () => {
    const html = renderUsage(usage({ spend: { enabled: true, limit: eur(10), used: eur(2.5) } }));
    expect(html).toContain("€2.50 / €10.00");
  });

  it("shows spend with no cap", () => {
    const html = renderUsage(usage({ spend: { enabled: true, limit: null, used: eur(5) } }));
    expect(html).toContain("€5.00 · no limit");
  });

  it("bills in the currency the plan states, not in dollars", () => {
    const html = renderUsage(
      usage({ spend: { enabled: true, limit: null, used: { amount: 5, currency: "USD" } } }),
    );
    expect(html).toContain("$5.00");
  });

  it("hides extra usage when the plan reports none", () => {
    expect(
      renderUsage(usage({ limits: [{ label: "Session", percent: 10, resetsAt: null }] })),
    ).not.toContain("Extra usage");
  });
});
