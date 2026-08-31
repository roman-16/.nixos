/**
 * Usage Command - Show Anthropic subscription plan usage limits
 *
 * Uses pi's OAuth credentials to fetch usage data from the Anthropic API.
 * The plan reports itself as a list of limits, each naming itself and carrying its
 * own percentage and reset, so the list is drawn as it comes - including a limit
 * scoped to a single model - plus whatever extra usage has cost.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

interface Money {
	amount: number;
	currency: string;
}

interface PlanLimit {
	label: string;
	percent: number;
	resetsAt: string | null;
	short: string;
}

interface PlanSpend {
	enabled: boolean;
	limit: Money | null;
	used: Money;
}

interface PlanUsage {
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
	spend?: { enabled?: boolean; limit?: RawMoney | null; used?: RawMoney | null } | null;
}

const REFRESH_INTERVAL = 5 * 60 * 1000;

function parseMoney(raw: RawMoney | null | undefined): Money | null {
	if (!raw || typeof raw.amount_minor !== "number") return null;
	if (typeof raw.currency !== "string" || !/^[A-Z]{3}$/.test(raw.currency)) return null;
	return { amount: raw.amount_minor / 10 ** (raw.exponent ?? 2), currency: raw.currency };
}

function labels(raw: RawLimit): { label: string; short: string } {
	const scoped = raw.scope?.model?.display_name;
	switch (raw.kind) {
		case "session":
			return { label: "Session", short: "session" };
		case "weekly_all":
			return { label: "Weekly (all models)", short: "weekly" };
		case "weekly_scoped":
			return { label: `Weekly (${scoped ?? "scoped"})`, short: scoped ?? "scoped" };
		default: {
			const words = (raw.kind ?? "limit").replace(/_/g, " ");
			return { label: words.replace(/^./, (c) => c.toUpperCase()), short: words };
		}
	}
}

function parseUsage(body: unknown): PlanUsage {
	const raw = (body ?? {}) as RawUsage;
	const used = parseMoney(raw.spend?.used);
	return {
		limits: (raw.limits ?? [])
			.filter((limit) => typeof limit.percent === "number")
			.map((limit) => ({
				...labels(limit),
				percent: limit.percent as number,
				resetsAt: limit.resets_at ?? null,
			})),
		spend: used
			? { enabled: raw.spend?.enabled === true, limit: parseMoney(raw.spend?.limit), used }
			: null,
	};
}

async function fetchUsage(token: string): Promise<PlanUsage | null> {
	try {
		const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
				"anthropic-beta": "oauth-2025-04-20",
			},
		});
		if (!res.ok) return null;
		return parseUsage(await res.json());
	} catch {
		return null;
	}
}

function formatTimeUntil(resetsAt: string | null): string {
	if (!resetsAt) return "—";
	const ms = new Date(resetsAt).getTime() - Date.now();
	if (Number.isNaN(ms)) return "—";
	if (ms <= 0) return "now";

	const minutes = Math.floor(ms / 60000);
	const hours = Math.floor(minutes / 60);
	const days = Math.floor(hours / 24);

	if (days > 0) return `${days}d ${hours % 24}h`;
	if (hours > 0) return `${hours}h ${minutes % 60}m`;
	return `${minutes}m`;
}

function money(value: Money): string {
	return new Intl.NumberFormat("en-US", { style: "currency", currency: value.currency }).format(value.amount);
}

function renderBar(percent: number, width: number, theme: any): string {
	const ratio = Math.max(0, Math.min(1, percent / 100));
	const filled = Math.round(ratio * width);
	const empty = width - filled;
	const color = ratio >= 0.9 ? "error" : ratio >= 0.7 ? "warning" : "success";

	return theme.fg(color, "█".repeat(filled)) + theme.fg("dim", "░".repeat(empty));
}

/** Whether the plan is out of room right now, which is what makes extra usage worth looking at. */
function anyLimitFull(usage: PlanUsage): boolean {
	return usage.limits.some((limit) => limit.percent >= 100);
}

function formatStatusBar(usage: PlanUsage, theme: any): string {
	const parts = usage.limits.map((limit) => {
		const pct = Math.floor(limit.percent);
		return `${theme.fg("dim", limit.short)} ${renderBar(pct, 10, theme)} ${theme.fg("text", `${pct}%`)} ${theme.fg("dim", formatTimeUntil(limit.resetsAt))}`;
	});

	if (usage.spend?.enabled) {
		const color = anyLimitFull(usage) ? "warning" : usage.spend.used.amount > 0 ? "text" : "dim";
		parts.push(theme.fg(color, money(usage.spend.used)));
	}

	return parts.join(theme.fg("dim", "  │  "));
}

export default function usage(pi: ExtensionAPI) {
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let generation = 0;

	async function refreshStatus(ctx: { modelRegistry: any; ui: any }, epoch = generation) {
		const token = await ctx.modelRegistry.getApiKeyForProvider("anthropic");
		if (epoch !== generation || !token || !token.includes("sk-ant-oat")) return;

		const data = await fetchUsage(token);
		if (epoch !== generation || !data) return;

		ctx.ui.setStatus("usage", formatStatusBar(data, ctx.ui.theme));
	}

	function startRefreshLoop(ctx: { modelRegistry: any; ui: any }) {
		if (refreshTimer) clearInterval(refreshTimer);
		generation++;
		const epoch = generation;
		void refreshStatus(ctx, epoch).catch(() => {});
		refreshTimer = setInterval(() => void refreshStatus(ctx, epoch).catch(() => {}), REFRESH_INTERVAL);
		refreshTimer.unref?.();
	}

	pi.on("session_start", async (_event, ctx) => {
		startRefreshLoop(ctx);
	});

	pi.on("session_shutdown", async () => {
		generation++;
		if (refreshTimer) clearInterval(refreshTimer);
		refreshTimer = undefined;
	});

	pi.registerCommand("usage", {
		description: "Show Anthropic plan usage limits",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("Usage requires interactive mode", "error");
				return;
			}

			const token = await ctx.modelRegistry.getApiKeyForProvider("anthropic");
			if (!token || !token.includes("sk-ant-oat")) {
				ctx.ui.notify("Requires OAuth login (subscription plan)", "warning");
				return;
			}

			const data = await fetchUsage(token);
			if (!data) {
				ctx.ui.notify("Failed to fetch usage data", "error");
				return;
			}

			ctx.ui.setStatus("usage", formatStatusBar(data, ctx.ui.theme));

			await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
				let cachedLines: string[] | undefined;

				function render(width: number): string[] {
					if (cachedLines) return cachedLines;

					const lines: string[] = [];
					const add = (s: string) => lines.push(truncateToWidth(s, width));
					const barWidth = Math.min(40, width - 30);

					add(theme.fg("accent", "─".repeat(width)));
					add(theme.fg("accent", theme.bold(" Usage")));
					lines.push("");

					if (data.limits.length === 0) {
						add(theme.fg("muted", " No usage limits found (subscription plans only)"));
					} else {
						for (const limit of data.limits) {
							const pct = Math.floor(limit.percent);
							const bar = renderBar(pct, barWidth, theme);

							add(` ${theme.bold(limit.label)}`);
							add(` ${bar} ${theme.fg("text", `${pct}%`)} ${theme.fg("dim", `· resets in ${formatTimeUntil(limit.resetsAt)}`)}`);
							lines.push("");
						}
					}

					if (data.spend) {
						const spend = data.spend;
						const spentColor = anyLimitFull(data) ? "warning" : spend.used.amount > 0 ? "text" : "dim";
						add(` ${theme.bold("Extra Usage")}`);

						if (!spend.enabled) {
							add(theme.fg("muted", "   Not enabled"));
						} else if (!spend.limit) {
							add(theme.fg(spentColor, `   ${money(spend.used)} spent · `) + theme.fg("success", "no limit"));
						} else {
							const ratio = spend.limit.amount > 0 ? (spend.used.amount / spend.limit.amount) * 100 : 0;
							add(` ${renderBar(ratio, barWidth, theme)} ${theme.fg(spentColor, `${money(spend.used)} / ${money(spend.limit)}`)}`);
						}
						lines.push("");
					}

					add(theme.fg("dim", " Esc to close"));
					add(theme.fg("accent", "─".repeat(width)));

					cachedLines = lines;
					return lines;
				}

				return {
					render,
					invalidate: () => {
						cachedLines = undefined;
					},
					handleInput: (input: string) => {
						if (matchesKey(input, "escape") || matchesKey(input, "enter")) {
							done(undefined);
						}
					},
				};
			});
		},
	});
}
