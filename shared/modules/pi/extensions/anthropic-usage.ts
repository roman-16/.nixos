/**
 * Anthropic plan usage: the footer segment and the /usage panel.
 *
 * The plan reports itself as a list of limits, each naming itself and carrying its own percentage
 * and reset, so the list is drawn as it comes - including a limit scoped to a single model - plus
 * whatever extra usage has cost.
 *
 * Percentages come from the API, while the countdown to a reset is arithmetic on a timestamp
 * already in hand: the clock ticks every minute, the request runs every five. The numbers belong to
 * the account rather than to a process, so they live in one snapshot on disk that every open
 * session reads and any session may refresh - one request per machine instead of one per session,
 * against an endpoint that rate-limits hard.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

const REFRESH_INTERVAL = 5 * 60 * 1000;
const SNAPSHOT_FILE = "anthropic-usage.json";
const STALE_AFTER = 15 * 60 * 1000;
const TICK_INTERVAL = 60 * 1000;

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

/**
 * What one machine knows about the plan: the endpoint's own answer, when it was obtained, and when
 * a session last set out to obtain it. The body is kept raw so a change to the parser can never be
 * fed an old shape - the file is a response cache, not a serialized model.
 */
interface Snapshot {
	attemptedAt: number;
	body: unknown;
	fetchedAt: number;
}

type Refresh = "failed" | "no-auth" | "ok" | "rate-limited";

type FetchResult = { body: unknown } | { retry: boolean };

const snapshotPath = () => join(getAgentDir(), SNAPSHOT_FILE);

function readSnapshot(): Snapshot | undefined {
	try {
		const parsed = JSON.parse(readFileSync(snapshotPath(), "utf8")) as Snapshot;
		return typeof parsed.attemptedAt === "number" && typeof parsed.fetchedAt === "number"
			? parsed
			: undefined;
	} catch {
		return undefined;
	}
}

function writeSnapshot(snapshot: Snapshot): void {
	const path = snapshotPath();
	const pending = `${path}.${process.pid}`;
	try {
		writeFileSync(pending, JSON.stringify(snapshot));
		renameSync(pending, path);
	} catch {}
}

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

async function fetchUsage(token: string): Promise<FetchResult> {
	try {
		const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
				"anthropic-beta": "oauth-2025-04-20",
			},
		});
		if (res.status === 429) return { retry: true };
		if (!res.ok) return { retry: false };
		return { body: await res.json() };
	} catch {
		return { retry: false };
	}
}

function timeUntil(resetsAt: string | null): string {
	if (!resetsAt) return "";
	const ms = Date.parse(resetsAt) - Date.now();
	if (Number.isNaN(ms)) return "";
	if (ms <= 0) return "now";

	const minutes = Math.floor(ms / 60000);
	const hours = Math.floor(minutes / 60);
	const days = Math.floor(hours / 24);

	if (days > 0) return `${days}d ${hours % 24}h`;
	if (hours > 0) return `${hours}h ${minutes % 60}m`;
	return `${minutes}m`;
}

function resetLabel(resetsAt: string | null): string {
	const until = timeUntil(resetsAt);
	if (!until) return "";
	return until === "now" ? "resets now" : `resets in ${until}`;
}

function clockTime(timestamp: number): string {
	const date = new Date(timestamp);
	return `${`${date.getHours()}`.padStart(2, "0")}:${`${date.getMinutes()}`.padStart(2, "0")}`;
}

function money(value: Money): string {
	return new Intl.NumberFormat("en-US", { style: "currency", currency: value.currency }).format(value.amount);
}

function renderBar(percent: number, width: number, theme: Theme, stale = false): string {
	const ratio = Math.max(0, Math.min(1, percent / 100));
	const filled = Math.round(ratio * width);
	const color = stale ? "dim" : ratio >= 0.9 ? "error" : ratio >= 0.7 ? "warning" : "success";

	return theme.fg(color, "█".repeat(filled)) + theme.fg("dim", "░".repeat(width - filled));
}

/** Whether the plan is out of room right now, which is what makes extra usage worth looking at. */
function anyLimitFull(usage: PlanUsage): boolean {
	return usage.limits.some((limit) => limit.percent >= 100);
}

/** The footer segment. Stale numbers keep their shape but lose their colour, so a live countdown
 * beside a frozen percentage never reads as current. */
function formatStatusBar(usage: PlanUsage, theme: Theme, stale: boolean): string {
	const parts = usage.limits.map((limit) => {
		const pct = Math.floor(limit.percent);
		const until = timeUntil(limit.resetsAt);
		return [
			theme.fg("dim", limit.short),
			renderBar(pct, 10, theme, stale),
			theme.fg(stale ? "dim" : "text", `${pct}%`),
			...(until ? [theme.fg("dim", until)] : []),
		].join(" ");
	});

	if (usage.spend?.enabled) {
		const color = stale
			? "dim"
			: anyLimitFull(usage)
				? "warning"
				: usage.spend.used.amount > 0
					? "text"
					: "dim";
		parts.push(theme.fg(color, money(usage.spend.used)));
	}

	return parts.join(theme.fg("dim", "  │  "));
}

export default function usage(pi: ExtensionAPI) {
	const listeners = new Set<() => void>();
	let clock: ReturnType<typeof setInterval> | undefined;
	let inFlight: Promise<Refresh> | undefined;
	let plan: PlanUsage | undefined;
	let snapshot: Snapshot | undefined;
	let statusText: string | undefined;

	function adopt(next: Snapshot | undefined): void {
		if (!next) return;
		snapshot = next;
		if (next.body !== null && next.body !== undefined) plan = parseUsage(next.body);
	}

	function stale(now: number): boolean {
		return !snapshot || now - snapshot.fetchedAt >= STALE_AFTER;
	}

	/** A reset that happened after the snapshot was taken makes its percentages wrong by definition. */
	function resetPassed(now: number): boolean {
		const taken = snapshot?.fetchedAt;
		if (taken === undefined || !plan) return false;
		return plan.limits.some((limit) => {
			const at = limit.resetsAt ? Date.parse(limit.resetsAt) : Number.NaN;
			return !Number.isNaN(at) && at <= now && at > taken;
		});
	}

	function dueForFetch(now: number): boolean {
		if (!snapshot) return true;
		return now - snapshot.attemptedAt >= (resetPassed(now) ? TICK_INTERVAL : REFRESH_INTERVAL);
	}

	async function fetchInto(ctx: ExtensionContext): Promise<Refresh> {
		const token = await ctx.modelRegistry.getApiKeyForProvider("anthropic");
		if (!token || !token.includes("sk-ant-oat")) return "no-auth";

		// Claimed before the request, so a session waking meanwhile leaves this one to it.
		const claim: Snapshot = {
			attemptedAt: Date.now(),
			body: snapshot?.body ?? null,
			fetchedAt: snapshot?.fetchedAt ?? 0,
		};
		adopt(claim);
		writeSnapshot(claim);

		const result = await fetchUsage(token);
		if (!("body" in result)) return result.retry ? "rate-limited" : "failed";

		const fetched: Snapshot = {
			attemptedAt: claim.attemptedAt,
			body: result.body,
			fetchedAt: Date.now(),
		};
		adopt(fetched);
		writeSnapshot(fetched);
		return "ok";
	}

	function refresh(ctx: ExtensionContext): Promise<Refresh> {
		inFlight ??= fetchInto(ctx).finally(() => {
			inFlight = undefined;
		});
		return inFlight;
	}

	function showStatus(ctx: ExtensionContext): void {
		if (plan) {
			const text = formatStatusBar(plan, ctx.ui.theme, stale(Date.now()));
			if (text !== statusText) {
				statusText = text;
				ctx.ui.setStatus("usage", text);
			}
		}
		for (const listener of listeners) listener();
	}

	function tick(ctx: ExtensionContext): void {
		adopt(readSnapshot());
		showStatus(ctx);
		if (dueForFetch(Date.now())) {
			void refresh(ctx)
				.then(() => showStatus(ctx))
				.catch(() => {});
		}
	}

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		if (clock) clearInterval(clock);
		statusText = undefined;
		tick(ctx);
		clock = setInterval(() => tick(ctx), TICK_INTERVAL);
		clock.unref?.();
	});

	pi.on("session_shutdown", () => {
		if (clock) clearInterval(clock);
		clock = undefined;
	});

	pi.registerCommand("usage", {
		description: "Show Anthropic plan usage limits",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/usage needs an interactive terminal", "warning");
				return;
			}

			adopt(readSnapshot());
			if (!plan) {
				const outcome = await refresh(ctx);
				if (outcome === "no-auth") {
					ctx.ui.notify("Requires OAuth login (subscription plan)", "warning");
					return;
				}
				if (outcome === "rate-limited") {
					ctx.ui.notify("Anthropic is rate-limiting usage checks, try again shortly", "warning");
					return;
				}
				if (outcome === "failed") {
					ctx.ui.notify("Failed to fetch usage data", "error");
					return;
				}
			} else if (dueForFetch(Date.now())) {
				void refresh(ctx)
					.then(() => showStatus(ctx))
					.catch(() => {});
			}

			showStatus(ctx);

			await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
				let cachedLines: string[] | undefined;

				const listener = () => {
					cachedLines = undefined;
					tui.requestRender();
				};
				listeners.add(listener);

				function close(): void {
					listeners.delete(listener);
					done(undefined);
				}

				function render(width: number): string[] {
					if (cachedLines) return cachedLines;

					const data = plan;
					const lines: string[] = [];
					const add = (s: string) => lines.push(truncateToWidth(s, width));
					const barWidth = Math.min(40, width - 30);

					add(theme.fg("accent", "─".repeat(width)));
					add(theme.fg("accent", theme.bold(" Usage")));
					lines.push("");

					if (!data || data.limits.length === 0) {
						add(theme.fg("muted", " No usage limits found (subscription plans only)"));
					} else {
						for (const limit of data.limits) {
							const pct = Math.floor(limit.percent);
							const reset = resetLabel(limit.resetsAt);

							add(` ${theme.bold(limit.label)}`);
							add(
								` ${renderBar(pct, barWidth, theme)} ${theme.fg("text", `${pct}%`)}${reset ? ` ${theme.fg("dim", `· ${reset}`)}` : ""}`,
							);
							lines.push("");
						}
					}

					if (data?.spend) {
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

					const taken = snapshot?.fetchedAt;
					add(theme.fg("dim", ` Esc to close${taken ? ` · updated ${clockTime(taken)}` : ""}`));
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
						if (matchesKey(input, "escape") || matchesKey(input, "enter")) close();
					},
				};
			});
		},
	});
}
