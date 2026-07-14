export interface UsageLimit {
  resets_at: string | null;
  utilization: number;
}

export interface ExtraUsage {
  is_enabled: boolean;
  monthly_limit: number | null;
  used_credits: number;
  utilization: number | null;
}

export interface UsageData {
  extra_usage?: ExtraUsage;
  five_hour?: UsageLimit;
  seven_day?: UsageLimit;
  seven_day_sonnet?: UsageLimit;
}

/** Fetch Anthropic subscription usage with the OAuth token (same endpoint pi uses). */
export async function fetchUsage(token: string): Promise<UsageData | null> {
  try {
    const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        "anthropic-beta": "oauth-2025-04-20",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
    });
    if (!res.ok) return null;
    return (await res.json()) as UsageData;
  } catch {
    return null;
  }
}

function resetLabel(resetsAt: string | null): string {
  if (!resetsAt) return "";
  const ms = new Date(resetsAt).getTime() - Date.now();
  if (ms <= 0) return "resets now";
  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `resets in ${days}d ${hours % 24}h`;
  if (hours > 0) return `resets in ${hours}h ${minutes % 60}m`;
  return `resets in ${minutes}m`;
}

function barColor(pct: number): string {
  return pct >= 90 ? "bg-red-500" : pct >= 70 ? "bg-amber-500" : "bg-emerald-500";
}

/** A labelled progress bar for a resettable limit (session / weekly). */
function bar(title: string, limit: UsageLimit | undefined): string {
  if (!limit) return "";
  const pct = Math.min(100, Math.max(0, Math.round(limit.utilization)));
  const reset = resetLabel(limit.resets_at);
  return `<div>
    <div class="mb-1.5 flex items-baseline justify-between gap-2 text-xs">
      <span class="text-neutral-400">${title}</span><span class="text-neutral-500">${pct}%${reset ? ` \u00b7 ${reset}` : ""}</span>
    </div>
    <div class="h-1.5 overflow-hidden rounded-full bg-white/5">
      <div class="h-full rounded-full ${barColor(pct)}" style="width:${pct}%"></div>
    </div>
  </div>`;
}

/** Extra usage (per-token overage) as a plain dollar value, like pi's usage extension. */
function extraUsage(extra: ExtraUsage | undefined): string {
  if (!extra) return "";
  const spent = (extra.used_credits / 100).toFixed(2);
  const value = !extra.is_enabled
    ? "Not enabled"
    : extra.monthly_limit == null
      ? `$${spent} \u00b7 no limit`
      : `$${spent} / $${(extra.monthly_limit / 100).toFixed(2)}`;
  return `<div class="flex justify-between text-xs text-neutral-400"><span>Extra usage</span><span>${value}</span></div>`;
}

/** Render the usage fragment for the dashboard: limit bars plus the extra-usage value. */
export function renderUsage(data: UsageData | null): string {
  if (!data) return `<p class="text-xs text-neutral-500">Usage data unavailable.</p>`;

  const rows = [
    bar("Session (5h)", data.five_hour),
    bar("Weekly (all models)", data.seven_day),
    bar("Weekly (Sonnet)", data.seven_day_sonnet),
    extraUsage(data.extra_usage),
  ].filter(Boolean);

  if (rows.length === 0) return `<p class="text-xs text-neutral-500">No usage limits reported.</p>`;
  return `<div class="space-y-3">${rows.join("")}</div>`;
}
