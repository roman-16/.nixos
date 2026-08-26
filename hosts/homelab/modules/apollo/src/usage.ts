import { barColor } from "./format";

export interface CreditUsage {
  used: number;
  limit: number | null;
  remaining: number | null;
  reset: string | null;
}

const ENDPOINT = "https://openrouter.ai/api/v1/auth/key";

function numberAt(data: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    if (typeof data[key] === "number") return data[key] as number;
  }
  return undefined;
}

function stringAt(data: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof data[key] === "string") return data[key] as string;
  }
  return undefined;
}

/** Fetch the OpenRouter key's credit usage with the API key (GET /auth/key). */
export async function fetchUsage(token: string): Promise<CreditUsage | null> {
  try {
    const res = await fetch(ENDPOINT, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: Record<string, unknown> };
    const data = body.data;
    if (!data) return null;

    const used = numberAt(data, ["usage"]) ?? 0;
    const limit = numberAt(data, ["limit", "usage_limit"]) ?? null;
    const remaining =
      numberAt(data, ["limit_remaining", "limitRemaining", "usage_remaining"]) ??
      (typeof limit === "number" ? Math.max(0, limit - used) : null);
    const reset = stringAt(data, ["limit_reset", "limitReset"]) ?? null;

    return { used, limit, remaining, reset };
  } catch {
    return null;
  }
}

function money(value: number): string {
  return `$${value.toFixed(2)}`;
}

function resetLabel(resetAt: string | null): string {
  if (!resetAt) return "";
  const ms = new Date(resetAt).getTime() - Date.now();
  if (Number.isNaN(ms) || ms <= 0) return "resets now";
  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `resets in ${days}d ${hours % 24}h`;
  if (hours > 0) return `resets in ${hours}h ${minutes % 60}m`;
  return `resets in ${minutes}m`;
}

/** The credit balance bar: a used-vs-limit bar and the amount left, plus when it resets. */
function creditBar(usage: CreditUsage): string {
  const { limit } = usage;
  if (limit == null || limit <= 0) {
    return `<div class="flex justify-between text-xs text-neutral-400">
      <span>Credits used</span><span>${money(usage.used)}</span>
    </div>`;
  }
  const pct = Math.min(100, Math.max(0, Math.round((usage.used / limit) * 100)));
  const remaining =
    usage.remaining == null ? money(Math.max(0, limit - usage.used)) : money(usage.remaining);
  const reset = resetLabel(usage.reset);
  return `<div>
    <div class="mb-1.5 flex items-baseline justify-between gap-2 text-xs">
      <span class="text-neutral-400">Credits</span><span class="text-neutral-500">${remaining}${reset ? ` · ${reset}` : ""}</span>
    </div>
    <div class="h-1.5 overflow-hidden rounded-full bg-white/5">
      <div class="h-full rounded-full ${barColor(pct)}" style="width:${pct}%"></div>
    </div>
  </div>`;
}

/** Render the dashboard's model usage section: the OpenRouter credit balance bar. */
export function renderUsage(data: CreditUsage | null): string {
  if (!data) return `<p class="text-xs text-neutral-500">Usage data unavailable right now.</p>`;
  return `<div class="space-y-3">${creditBar(data)}</div>`;
}
