/**
 * Usage Command - Show Anthropic subscription plan usage limits
 *
 * Uses pi's OAuth credentials to fetch usage data from the Anthropic API.
 * Displays progress bars for session (5h), weekly (7d), and Sonnet limits,
 * plus extra usage credits if applicable.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@mariozechner/pi-tui";

interface UsageLimit {
	utilization: number;
	resets_at: string | null;
}

interface ExtraUsage {
	is_enabled: boolean;
	monthly_limit: number | null;
	used_credits: number;
	utilization: number | null;
}

interface UsageData {
	five_hour?: UsageLimit;
	seven_day?: UsageLimit;
	seven_day_sonnet?: UsageLimit;
	extra_usage?: ExtraUsage;
}

function formatTimeUntil(resetsAt: string | null): string {
	if (!resetsAt) return "—";
	const ms = new Date(resetsAt).getTime() - Date.now();
	if (ms <= 0) return "now";

	const minutes = Math.floor(ms / 60000);
	const hours = Math.floor(minutes / 60);
	const days = Math.floor(hours / 24);

	if (days > 0) return `${days}d ${hours % 24}h`;
	if (hours > 0) return `${hours}h ${minutes % 60}m`;
	return `${minutes}m`;
}

function renderBar(ratio: number, width: number, theme: any): string {
	const clamped = Math.max(0, Math.min(1, ratio));
	const filled = Math.round(clamped * width);
	const empty = width - filled;
	const color = clamped >= 0.9 ? "error" : clamped >= 0.7 ? "warning" : "success";

	return theme.fg(color, "█".repeat(filled)) + theme.fg("dim", "░".repeat(empty));
}

const REFRESH_INTERVAL = 5 * 60 * 1000;

async function fetchUsage(token: string): Promise<UsageData | null> {
	try {
		const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
				"anthropic-beta": "oauth-2025-04-20",
			},
		});
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	}
}

function miniBar(pct: number, width: number, theme: any): string {
	const ratio = Math.max(0, Math.min(1, pct / 100));
	const filled = Math.round(ratio * width);
	const empty = width - filled;
	const color = ratio >= 0.9 ? "error" : ratio >= 0.7 ? "warning" : "success";

	return theme.fg(color, "█".repeat(filled)) + theme.fg("dim", "░".repeat(empty));
}

function formatStatusBar(data: UsageData, theme: any): string {
	const parts: string[] = [];
	const barWidth = 20;

	if (data.five_hour) {
		const pct = Math.floor(data.five_hour.utilization);
		const resets = formatTimeUntil(data.five_hour.resets_at);
		parts.push(`${theme.fg("dim", "5h")} ${miniBar(pct, barWidth, theme)} ${theme.fg("text", `${pct}%`)} ${theme.fg("dim", resets)}`);
	}

	if (data.seven_day) {
		const pct = Math.floor(data.seven_day.utilization);
		const resets = formatTimeUntil(data.seven_day.resets_at);
		parts.push(`${theme.fg("dim", "7d")} ${miniBar(pct, barWidth, theme)} ${theme.fg("text", `${pct}%`)} ${theme.fg("dim", resets)}`);
	}

	if (data.extra_usage?.is_enabled) {
		const spent = (data.extra_usage.used_credits / 100).toFixed(2);
		const fiveHourFull = data.five_hour && data.five_hour.utilization >= 100;
		const color = fiveHourFull ? "warning" : data.extra_usage.used_credits > 0 ? "text" : "dim";
		parts.push(theme.fg(color, `$${spent}`));
	}

	return parts.join(theme.fg("dim", "  │  "));
}

export default function usage(pi: ExtensionAPI) {
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let cachedData: UsageData | null = null;

	async function refreshStatus(ctx: { modelRegistry: any; ui: any }) {
		const credential = ctx.modelRegistry.authStorage.get("anthropic");
		if (!credential || credential.type !== "oauth") return;

		const token = await ctx.modelRegistry.getApiKeyForProvider("anthropic");
		if (!token) return;

		cachedData = await fetchUsage(token);
		if (cachedData) {
			ctx.ui.setStatus("usage", formatStatusBar(cachedData, ctx.ui.theme));
		}
	}

	function startRefreshLoop(ctx: { modelRegistry: any; ui: any }) {
		if (refreshTimer) clearInterval(refreshTimer);
		refreshStatus(ctx);
		refreshTimer = setInterval(() => refreshStatus(ctx), REFRESH_INTERVAL);
	}

	pi.on("session_start", async (_event, ctx) => {
		startRefreshLoop(ctx);
	});

	pi.on("session_shutdown", async () => {
		if (refreshTimer) clearInterval(refreshTimer);
	});

	pi.registerCommand("usage", {
		description: "Show Anthropic plan usage limits",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("Usage requires interactive mode", "error");
				return;
			}

			const credential = ctx.modelRegistry.authStorage.get("anthropic");
			if (!credential || credential.type !== "oauth") {
				ctx.ui.notify("Requires OAuth login (subscription plan)", "warning");
				return;
			}

			const token = await ctx.modelRegistry.getApiKeyForProvider("anthropic");
			if (!token) {
				ctx.ui.notify("Failed to get OAuth token", "error");
				return;
			}

			const data = await fetchUsage(token);
			if (!data) {
				ctx.ui.notify("Failed to fetch usage data", "error");
				return;
			}

			// Update cached data and status bar
			cachedData = data;
			ctx.ui.setStatus("usage", formatStatusBar(data, ctx.ui.theme));

			const limits: { title: string; limit?: UsageLimit }[] = [
				{ title: "Session (5h)", limit: data.five_hour },
				{ title: "Weekly (all models)", limit: data.seven_day },
				{ title: "Weekly (Sonnet)", limit: data.seven_day_sonnet },
			];

			const hasLimits = limits.some((l) => l.limit);

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

					if (!hasLimits) {
						add(theme.fg("muted", " No usage limits found (subscription plans only)"));
					} else {
						for (const { title, limit } of limits) {
							if (!limit) continue;

							const pct = Math.floor(limit.utilization);
							const resets = formatTimeUntil(limit.resets_at);
							const bar = renderBar(pct / 100, barWidth, theme);

							add(` ${theme.bold(title)}`);
							add(` ${bar} ${theme.fg("text", `${pct}%`)} ${theme.fg("dim", `· resets in ${resets}`)}`);
							lines.push("");
						}
					}

					if (data.extra_usage) {
						const extra = data.extra_usage;
						add(` ${theme.bold("Extra Usage")}`);

						if (!extra.is_enabled) {
							add(theme.fg("muted", "   Not enabled"));
						} else if (extra.monthly_limit === null) {
							const spent = (extra.used_credits / 100).toFixed(2);
							const fiveHourFull = data.five_hour && data.five_hour.utilization >= 100;
							const spentColor = fiveHourFull ? "warning" : extra.used_credits > 0 ? "text" : "dim";
							add(theme.fg(spentColor, `   $${spent} spent · `) + theme.fg("success", "no limit"));
						} else {
							const spent = (extra.used_credits / 100).toFixed(2);
							const total = (extra.monthly_limit / 100).toFixed(2);
							const ratio = extra.utilization ?? extra.used_credits / extra.monthly_limit;
							const bar = renderBar(ratio, barWidth, theme);
							const fiveHourFull = data.five_hour && data.five_hour.utilization >= 100;
							const spentColor = fiveHourFull ? "warning" : extra.used_credits > 0 ? "text" : "dim";

							add(` ${bar} ${theme.fg(spentColor, `$${spent} / $${total}`)}`);
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
