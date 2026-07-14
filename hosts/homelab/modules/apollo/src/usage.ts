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

/** Human "resets in ..." label for a limit's reset timestamp. */
export function resetLabel(resetsAt: string | null): string {
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

/** Extra usage (per-token overage) spend as a short value string. */
export function extraUsageValue(extra: ExtraUsage): string {
  if (!extra.is_enabled) return "not enabled";
  const spent = `$${(extra.used_credits / 100).toFixed(2)}`;
  return extra.monthly_limit == null
    ? `${spent} · no limit`
    : `${spent} / $${(extra.monthly_limit / 100).toFixed(2)}`;
}
