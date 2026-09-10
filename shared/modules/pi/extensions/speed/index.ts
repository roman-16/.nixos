import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	CALIBRATION_DAYS,
	DAY,
	pruneSamples,
	readSamples,
	RETENTION_DAYS,
	type Sample,
	writeSample,
} from "./samples.ts";
import { createSpeedView } from "./view.ts";
import {
	type Chunk,
	createFlight,
	dropFlight,
	type Flight,
	markFlight,
	scaleFlight,
	seedWork,
	statusText,
	workRate,
} from "./window.ts";

const STATUS_KEY = "speed";
const TICK_INTERVAL = 1_000;

export default function speed(pi: ExtensionAPI) {
	const listeners = new Set<(sample: Sample) => void>();
	let clock: ReturnType<typeof setInterval> | undefined;
	let flight: Flight | undefined;
	let history: Sample[] = [];
	let status: string | undefined;
	let work: Chunk[] = [];

	function show(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;

		const text = statusText(work, flight, ctx.ui.theme, Date.now());
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
		clock = setInterval(() => {
			if (flight) markFlight(flight, work, history, Date.now());
			show(ctx);
		}, TICK_INTERVAL);
		clock.unref?.();
	}

	pi.on("session_start", (_event, ctx) => {
		stopClock();
		flight = undefined;
		status = undefined;
		pruneSamples();
		history = readSamples(Date.now() - CALIBRATION_DAYS * DAY);
		work = seedWork(history, Date.now());
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
		show(ctx);
	});

	pi.on("turn_start", (event, ctx) => {
		flight = createFlight(event.timestamp);
		show(ctx);
		startClock(ctx);
	});

	pi.on("message_start", (event, ctx) => {
		if (event.message.role !== "assistant" || !flight) return;

		flight.generationAt = Date.now();
		flight.model = `${event.message.provider}/${event.message.model}`;
		flight.requestAt = event.message.timestamp;
		show(ctx);
	});

	pi.on("message_update", (event) => {
		if (!flight) return;

		const update = event.assistantMessageEvent;
		const now = Date.now();

		if (update.type === "thinking_start") {
			flight.thinkingStartedAt = now;
			return;
		}
		if (update.type === "thinking_end") {
			flight.thinkingEndAt = now;
			flight.thinkingStartedAt = undefined;
			return;
		}
		if (update.type !== "text_delta" && update.type !== "thinking_delta" && update.type !== "toolcall_delta") {
			return;
		}

		flight.firstDeltaAt ??= now;
		flight.lastDeltaAt = now;

		if (update.type === "thinking_delta") {
			flight.pending.thinking += update.delta.length;
			flight.thinkingChars += update.delta.length;
			return;
		}

		flight.pending.visible += update.delta.length;
		flight.visibleChars += update.delta.length;
	});

	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant" || !flight) return;

		stopClock();

		const at = Date.now();
		markFlight(flight, work, history, at);

		const thinkingDoneAt = flight.thinkingStartedAt === undefined ? flight.thinkingEndAt : at;
		const sample: Sample = {
			at,
			firstTokenMs: (flight.firstDeltaAt ?? at) - flight.requestAt,
			model: `${message.provider}/${message.model}`,
			outputTokens: message.usage.output,
			project: ctx.sessionManager.getCwd(),
			reasoningTokens: message.usage.reasoning ?? null,
			session: ctx.sessionManager.getSessionId(),
			sessionName: pi.getSessionName() ?? null,
			thinkingChars: flight.thinkingChars,
			thinkingMs: thinkingDoneAt === undefined ? 0 : thinkingDoneAt - (flight.generationAt ?? flight.requestAt),
			totalMs: at - flight.requestAt,
			visibleChars: flight.visibleChars,
		};

		if (sample.outputTokens > 0 && message.stopReason !== "aborted" && message.stopReason !== "error") {
			scaleFlight(flight, sample.outputTokens);
			history.push(sample);
			writeSample(sample);
			for (const listener of listeners) listener(sample);
		} else {
			dropFlight(flight, work);
		}

		flight = undefined;
		show(ctx);
	});

	pi.on("agent_end", (_event, ctx) => {
		stopClock();
		if (flight) dropFlight(flight, work);
		flight = undefined;
		show(ctx);
	});

	pi.on("session_shutdown", stopClock);

	pi.registerCommand("speed", {
		description: "Browse token throughput by minute, hour, day, model, session and project",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/speed needs an interactive terminal", "warning");
				return;
			}

			await ctx.ui.custom<void>((tui, theme, _keybindings, done) =>
				createSpeedView({
					done: () => done(undefined),
					load: () => readSamples(Date.now() - RETENTION_DAYS * DAY),
					rate: () => workRate(work),
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
