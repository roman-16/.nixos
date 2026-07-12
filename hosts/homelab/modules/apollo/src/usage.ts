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

function bar(title: string, limit: UsageLimit | undefined): string {
  if (!limit) return "";
  const pct = Math.min(100, Math.max(0, Math.round(limit.utilization)));
  const reset = resetLabel(limit.resets_at);
  return `<div>
    <div class="mb-1 flex justify-between text-xs text-neutral-400">
      <span>${title}</span><span>${pct}%${reset ? ` \u00b7 ${reset}` : ""}</span>
    </div>
    <div class="h-2 overflow-hidden rounded-full bg-neutral-800">
      <div class="h-full rounded-full ${barColor(pct)}" style="width:${pct}%"></div>
    </div>
  </div>`;
}

/** Render the usage fragment (progress bars) for the dashboard. */
export function renderUsage(data: UsageData | null): string {
  if (!data) return `<p class="text-xs text-neutral-500">Usage data unavailable.</p>`;

  const bars = [
    bar("Session (5h)", data.five_hour),
    bar("Weekly (all models)", data.seven_day),
    bar("Weekly (Sonnet)", data.seven_day_sonnet),
  ].filter(Boolean);

  let extra = "";
  if (data.extra_usage?.is_enabled) {
    const spent = (data.extra_usage.used_credits / 100).toFixed(2);
    const cap =
      data.extra_usage.monthly_limit == null
        ? ""
        : ` / $${(data.extra_usage.monthly_limit / 100).toFixed(2)}`;
    extra = `<div class="flex justify-between text-xs text-neutral-400"><span>Extra usage</span><span>$${spent}${cap}</span></div>`;
  }

  if (bars.length === 0 && !extra)
    return `<p class="text-xs text-neutral-500">No usage limits reported.</p>`;
  return `<div class="space-y-3">${bars.join("")}${extra}</div>`;
}
