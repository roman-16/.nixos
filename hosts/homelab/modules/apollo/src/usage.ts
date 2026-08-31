import { barColor, escapeHtml } from "./format";

/**
 * What the Claude subscription has left, as the plan itself reports it.
 *
 * Anthropic describes the plan as a list of limits rather than a fixed set of fields: each one names
 * itself, carries its own percentage and reset, and a scoped one names the model it applies to. So
 * the list is read as a list. Reaching for known keys instead would show whatever was true when the
 * code was written and quietly miss the limit that is actually binding today.
 */

const ENDPOINT = "https://api.anthropic.com/api/oauth/usage";

/** An amount in the currency the plan is billed in, not in cents and not assumed to be dollars. */
export interface Money {
  amount: number;
  currency: string;
}

export interface PlanLimit {
  label: string;
  percent: number;
  resetsAt: string | null;
}

/** Per-token spend beyond the plan, which the account may not have turned on at all. */
export interface PlanSpend {
  enabled: boolean;
  limit: Money | null;
  used: Money;
}

export interface PlanUsage {
  limits: PlanLimit[];
  spend: PlanSpend | null;
}

interface RawMoney {
  amount_minor?: number;
  currency?: string;
  exponent?: number;
}

interface RawLimit {
  kind?: string;
  percent?: number;
  resets_at?: string | null;
  scope?: { model?: { display_name?: string | null } | null } | null;
}

interface RawUsage {
  limits?: RawLimit[];
  spend?: {
    enabled?: boolean;
    limit?: RawMoney | null;
    used?: RawMoney | null;
  } | null;
}

function parseMoney(raw: RawMoney | null | undefined): Money | null {
  if (!raw || typeof raw.amount_minor !== "number") return null;
  // A currency that is not a currency code cannot be formatted as money, and rendering the dashboard
  // matters more than rendering this one number.
  if (typeof raw.currency !== "string" || !/^[A-Z]{3}$/.test(raw.currency)) return null;
  return { amount: raw.amount_minor / 10 ** (raw.exponent ?? 2), currency: raw.currency };
}

/** The plan's own name for a limit, in the words the user reads on their Claude account. */
function limitLabel(raw: RawLimit): string {
  const scoped = raw.scope?.model?.display_name;
  switch (raw.kind) {
    case "session":
      return "Session";
    case "weekly_all":
      return "Weekly (all models)";
    case "weekly_scoped":
      return `Weekly (${scoped ?? "scoped"})`;
    default:
      return (raw.kind ?? "Limit").replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());
  }
}

/** Read the plan's report of itself, keeping only what it actually stated. */
export function parseUsage(body: unknown): PlanUsage {
  const raw = (body ?? {}) as RawUsage;
  const used = parseMoney(raw.spend?.used);
  return {
    limits: (raw.limits ?? [])
      .filter((limit) => typeof limit.percent === "number")
      .map((limit) => ({
        label: limitLabel(limit),
        percent: limit.percent as number,
        resetsAt: limit.resets_at ?? null,
      })),
    spend: used
      ? { enabled: raw.spend?.enabled === true, limit: parseMoney(raw.spend?.limit), used }
      : null,
  };
}

/** Fetch Claude subscription usage with the OAuth token (the endpoint pi's own /usage uses). */
export async function fetchUsage(token: string): Promise<PlanUsage | null> {
  try {
    const res = await fetch(ENDPOINT, {
      headers: {
        "anthropic-beta": "oauth-2025-04-20",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
    });
    if (!res.ok) return null;
    return parseUsage(await res.json());
  } catch {
    return null;
  }
}

/** Human "resets in ..." label for a limit's reset timestamp. */
export function resetLabel(resetsAt: string | null): string {
  if (!resetsAt) return "";
  const ms = new Date(resetsAt).getTime() - Date.now();
  if (Number.isNaN(ms)) return "";
  if (ms <= 0) return "resets now";
  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `resets in ${days}d ${hours % 24}h`;
  if (hours > 0) return `resets in ${hours}h ${minutes % 60}m`;
  return `resets in ${minutes}m`;
}

function money(value: Money): string {
  return new Intl.NumberFormat("en-US", { currency: value.currency, style: "currency" }).format(
    value.amount,
  );
}

/** A labelled progress bar for one of the plan's limits. */
function bar(limit: PlanLimit): string {
  const pct = Math.min(100, Math.max(0, Math.round(limit.percent)));
  const reset = resetLabel(limit.resetsAt);
  return `<div>
    <div class="mb-1.5 flex items-baseline justify-between gap-2 text-xs">
      <span class="text-neutral-400">${escapeHtml(limit.label)}</span><span class="text-neutral-500">${pct}%${reset ? ` · ${reset}` : ""}</span>
    </div>
    <div class="h-1.5 overflow-hidden rounded-full bg-white/5">
      <div class="h-full rounded-full ${barColor(pct)}" style="width:${pct}%"></div>
    </div>
  </div>`;
}

function spendRow(spend: PlanSpend): string {
  const value = !spend.enabled
    ? "not enabled"
    : spend.limit
      ? `${money(spend.used)} / ${money(spend.limit)}`
      : `${money(spend.used)} · no limit`;
  return `<div class="flex justify-between text-xs text-neutral-400"><span>Extra usage</span><span>${value}</span></div>`;
}

/** Render the dashboard's usage section: a bar per plan limit, plus what extra usage has cost. */
export function renderUsage(usage: PlanUsage | null): string {
  if (!usage) return `<p class="text-xs text-neutral-500">Usage data unavailable right now.</p>`;

  const rows = [...usage.limits.map(bar), usage.spend ? spendRow(usage.spend) : ""].filter(Boolean);

  if (rows.length === 0) return `<p class="text-xs text-neutral-500">No usage limits reported.</p>`;
  return `<div class="space-y-3">${rows.join("")}</div>`;
}
