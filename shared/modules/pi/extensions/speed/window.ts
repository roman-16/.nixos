import type { Theme } from "@earendil-works/pi-coding-agent";
import { calibrate, type Kind, type Sample, tokensPerSecond } from "./samples.ts";

export const WINDOW = 60_000;

export interface Chunk {
	ms: number;
	tokens: number;
}

export interface Flight {
	chunks: Chunk[];
	estimatedTokens: number;
	firstDeltaAt?: number;
	generationAt?: number;
	lastDeltaAt?: number;
	markedAt: number;
	model?: string;
	pending: Record<Kind, number>;
	requestAt: number;
	thinkingChars: number;
	thinkingEndAt?: number;
	thinkingStartedAt?: number;
	visibleChars: number;
}

export function createFlight(at: number): Flight {
	return {
		chunks: [],
		estimatedTokens: 0,
		markedAt: at,
		pending: { thinking: 0, visible: 0 },
		requestAt: at,
		thinkingChars: 0,
		visibleChars: 0,
	};
}

function trimWork(work: Chunk[]): void {
	let total = work.reduce((sum, chunk) => sum + chunk.ms, 0);

	while (work.length > 0 && total - work[0].ms >= WINDOW) {
		total -= work[0].ms;
		work.shift();
	}

	const excess = total - WINDOW;
	const oldest = work[0];
	if (excess <= 0 || oldest === undefined) return;

	oldest.tokens *= (oldest.ms - excess) / oldest.ms;
	oldest.ms -= excess;
}

export function seedWork(samples: Sample[], now: number): Chunk[] {
	const work = samples
		.filter((sample) => sample.at >= now - WINDOW)
		.sort((left, right) => left.at - right.at)
		.map((sample) => ({ ms: sample.totalMs, tokens: sample.outputTokens }));

	trimWork(work);
	return work;
}

export function markFlight(flight: Flight, work: Chunk[], samples: Sample[], now: number): void {
	const ms = now - flight.markedAt;
	if (ms <= 0) return;

	const tokens =
		flight.pending.thinking / calibrate(samples, flight.model, "thinking") +
		flight.pending.visible / calibrate(samples, flight.model, "visible");
	const chunk: Chunk = { ms, tokens };

	flight.chunks.push(chunk);
	flight.estimatedTokens += tokens;
	flight.markedAt = now;
	flight.pending = { thinking: 0, visible: 0 };
	work.push(chunk);
	trimWork(work);
}

export function scaleFlight(flight: Flight, tokens: number): void {
	if (tokens <= 0) return;

	if (flight.estimatedTokens > 0) {
		const scale = tokens / flight.estimatedTokens;
		for (const chunk of flight.chunks) chunk.tokens *= scale;
		return;
	}

	const ms = flight.chunks.reduce((sum, chunk) => sum + chunk.ms, 0);
	if (ms <= 0) return;

	for (const chunk of flight.chunks) chunk.tokens = (tokens * chunk.ms) / ms;
}

export function dropFlight(flight: Flight, work: Chunk[]): void {
	const dropped = new Set(flight.chunks);

	for (let index = work.length - 1; index >= 0; index -= 1) {
		if (dropped.has(work[index])) work.splice(index, 1);
	}
}

export function workRate(work: Chunk[]): number | undefined {
	let ms = 0;
	let tokens = 0;

	for (const chunk of work) {
		ms += chunk.ms;
		tokens += chunk.tokens;
	}

	return ms > 0 && tokens > 0 ? tokensPerSecond(tokens, ms) : undefined;
}

function elapsed(ms: number): string {
	return `${Math.floor(ms / 1000)}s`;
}

export function statusText(
	work: Chunk[],
	flight: Flight | undefined,
	theme: Theme,
	now: number,
): string | undefined {
	const rate = workRate(work);
	if (rate !== undefined) {
		const text = `${Math.round(rate)} tok/s`;
		return flight ? theme.fg("text", text) : theme.fg("dim", text);
	}

	if (!flight) return undefined;

	return flight.thinkingStartedAt !== undefined
		? theme.fg("dim", `thinking ${elapsed(now - flight.thinkingStartedAt)}`)
		: theme.fg("dim", `waiting ${elapsed(now - (flight.lastDeltaAt ?? flight.requestAt))}`);
}
