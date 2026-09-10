import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createRun,
	dropFlight,
	finishFlight,
	noteDelta,
	noteRequest,
	snapshot,
	startFlight,
	startRun,
	startThinking,
	stopRun,
	stopThinking,
} from "./live.ts";
import { collectSessions, type LiveSession, type Timing, TIMING_TYPE } from "./records.ts";
import { createStatsView } from "./view.ts";

const STATUS_KEY = "stats";
const TICK_INTERVAL = 1_000;

export default function stats(pi: ExtensionAPI) {
	const listeners = new Set<() => void>();
	let clock: ReturnType<typeof setInterval> | undefined;
	let pending: Timing | undefined;
	let run = createRun();
	let status: string | undefined;

	function show(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;

		const live = snapshot(run, Date.now());
		const text = live.text === undefined ? undefined : ctx.ui.theme.fg(live.running ? "text" : "dim", live.text);
		if (text === status) return;

		status = text;
		ctx.ui.setStatus(STATUS_KEY, text);
	}

	function stopClock(): void {
		if (clock) clearInterval(clock);
		clock = undefined;
	}

	function startClock(ctx: ExtensionContext): void {
		stopClock();
		clock = setInterval(() => show(ctx), TICK_INTERVAL);
		clock.unref?.();
	}

	pi.on("session_start", (_event, ctx) => {
		stopClock();
		pending = undefined;
		run = createRun();
		status = undefined;
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
		setTimeout(() => collectSessions(), 0);
	});

	pi.on("agent_start", (_event, ctx) => {
		startRun(run);
		show(ctx);
		startClock(ctx);
	});

	pi.on("turn_start", (event, ctx) => {
		startFlight(run, event.timestamp);
		show(ctx);
	});

	pi.on("message_start", (event, ctx) => {
		if (event.message.role !== "assistant") return;

		noteRequest(run, `${event.message.provider}/${event.message.model}`, event.message.timestamp);
		show(ctx);
	});

	pi.on("message_update", (event) => {
		const update = event.assistantMessageEvent;
		const now = Date.now();

		if (update.type === "thinking_start") {
			startThinking(run, now);
			return;
		}
		if (update.type === "thinking_end") {
			stopThinking(run, now);
			return;
		}
		if (update.type === "thinking_delta") {
			noteDelta(run, "thinking", update.delta.length, now);
			return;
		}
		if (update.type === "text_delta" || update.type === "toolcall_delta") {
			noteDelta(run, "visible", update.delta.length, now);
		}
	});

	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant") return;

		pending = finishFlight(
			run,
			{ output: message.usage.output, reasoning: message.usage.reasoning ?? 0 },
			Date.now(),
		);
		show(ctx);
	});

	pi.on("turn_end", (event) => {
		const timing = pending;
		pending = undefined;

		if (timing && event.message.role === "assistant" && event.message.timestamp === timing.requestedAt) {
			pi.appendEntry<Timing>(TIMING_TYPE, timing);
		}
		for (const listener of listeners) listener();
	});

	pi.on("agent_end", (_event, ctx) => {
		dropFlight(run);
		show(ctx);
	});

	pi.on("agent_settled", (_event, ctx) => {
		stopClock();
		stopRun(run);
		show(ctx);
	});

	pi.on("session_shutdown", stopClock);

	pi.registerCommand("stats", {
		description: "Browse spend, tokens and speed across all sessions",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/stats needs an interactive terminal", "warning");
				return;
			}

			const live = (): LiveSession => ({
				cwd: ctx.cwd,
				entries: ctx.sessionManager.getEntries(),
				id: ctx.sessionManager.getSessionId(),
				name: pi.getSessionName(),
			});

			ctx.ui.setStatus(STATUS_KEY, "Reading sessions…");
			const load = () => collectSessions(live());
			load();
			ctx.ui.setStatus(STATUS_KEY, undefined);
			status = undefined;
			show(ctx);

			await ctx.ui.custom<void>((tui, theme, _keybindings, done) =>
				createStatsView({
					done: () => done(undefined),
					live: () => snapshot(run, Date.now()),
					load,
					subscribe: (listener) => {
						listeners.add(listener);
						return () => listeners.delete(listener);
					},
					theme,
					tui,
				}),
			);
		},
	});
}
