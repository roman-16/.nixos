import type { Timing } from "./records.ts";

export type Kind = "thinking" | "visible";

export interface LiveSnapshot {
	rate?: number;
	running: boolean;
	text?: string;
}

interface Calibration {
	chars: number;
	tokens: number;
}

interface Flight {
	firstDeltaAt?: number;
	model?: string;
	requestedAt: number;
	thinkingChars: number;
	thinkingMs: number;
	thinkingStartedAt?: number;
	visibleChars: number;
}

export interface Run {
	byKind: Map<string, Calibration>;
	byModelKind: Map<string, Calibration>;
	flight?: Flight;
	running: boolean;
	tokens: number;
	workMs: number;
}

const FALLBACK_CHARS_PER_TOKEN = 4;

export function createRun(): Run {
	return { byKind: new Map(), byModelKind: new Map(), running: false, tokens: 0, workMs: 0 };
}

export function startRun(run: Run): void {
	if (run.running) return;
	run.running = true;
	run.tokens = 0;
	run.workMs = 0;
}

export function stopRun(run: Run): void {
	run.flight = undefined;
	run.running = false;
}

export function startFlight(run: Run, at: number): void {
	run.flight = { requestedAt: at, thinkingChars: 0, thinkingMs: 0, visibleChars: 0 };
}

export function dropFlight(run: Run): void {
	run.flight = undefined;
}

export function noteRequest(run: Run, model: string, requestedAt: number): void {
	if (!run.flight) return;
	run.flight.model = model;
	run.flight.requestedAt = requestedAt;
}

export function noteDelta(run: Run, kind: Kind, chars: number, at: number): void {
	const flight = run.flight;
	if (!flight) return;

	flight.firstDeltaAt ??= at;
	if (kind === "thinking") flight.thinkingChars += chars;
	else flight.visibleChars += chars;
}

export function startThinking(run: Run, at: number): void {
	if (run.flight) run.flight.thinkingStartedAt = at;
}

export function stopThinking(run: Run, at: number): void {
	const flight = run.flight;
	if (!flight || flight.thinkingStartedAt === undefined) return;

	flight.thinkingMs += at - flight.thinkingStartedAt;
	flight.thinkingStartedAt = undefined;
}

function bump(calibrations: Map<string, Calibration>, key: string, chars: number, tokens: number): void {
	const calibration = calibrations.get(key) ?? { chars: 0, tokens: 0 };
	calibration.chars += chars;
	calibration.tokens += tokens;
	calibrations.set(key, calibration);
}

function learn(run: Run, model: string, kind: Kind, chars: number, tokens: number): void {
	if (chars <= 0 || tokens <= 0) return;
	bump(run.byKind, kind, chars, tokens);
	bump(run.byModelKind, `${model}\u0000${kind}`, chars, tokens);
}

function charsPerToken(run: Run, model: string | undefined, kind: Kind): number {
	const ratio = (calibration: Calibration | undefined) =>
		calibration && calibration.chars > 0 && calibration.tokens > 0
			? calibration.chars / calibration.tokens
			: undefined;

	return (
		ratio(run.byModelKind.get(`${model ?? ""}\u0000${kind}`)) ??
		ratio(run.byKind.get(kind)) ??
		FALLBACK_CHARS_PER_TOKEN
	);
}

function estimatedTokens(run: Run, flight: Flight): number {
	return (
		flight.thinkingChars / charsPerToken(run, flight.model, "thinking") +
		flight.visibleChars / charsPerToken(run, flight.model, "visible")
	);
}

export function finishFlight(
	run: Run,
	response: { output: number; reasoning: number },
	at: number,
): Timing | undefined {
	const flight = run.flight;
	run.flight = undefined;
	if (!flight) return undefined;

	const durationMs = at - flight.requestedAt;
	if (response.output > 0 && durationMs > 0) {
		run.tokens += response.output;
		run.workMs += durationMs;
		learn(run, flight.model ?? "", "thinking", flight.thinkingChars, response.reasoning);
		learn(run, flight.model ?? "", "visible", flight.visibleChars, response.output - response.reasoning);
	}

	if (flight.firstDeltaAt === undefined) return undefined;

	const thinkingMs =
		flight.thinkingMs + (flight.thinkingStartedAt === undefined ? 0 : at - flight.thinkingStartedAt);

	return {
		firstTokenMs: flight.firstDeltaAt - flight.requestedAt,
		requestedAt: flight.requestedAt,
		thinkingMs,
	};
}

function liveRate(run: Run, now: number): number | undefined {
	const flight = run.flight;
	const tokens = run.tokens + (flight ? estimatedTokens(run, flight) : 0);
	const ms = run.workMs + (flight ? Math.max(0, now - flight.requestedAt) : 0);

	return ms > 0 && tokens > 0 ? (tokens * 1000) / ms : undefined;
}

function seconds(ms: number): string {
	return `${Math.max(0, Math.floor(ms / 1000))}s`;
}

export function snapshot(run: Run, now: number): LiveSnapshot {
	const flight = run.flight;
	const rate = liveRate(run, now);
	const paced = rate === undefined ? undefined : `${Math.round(rate)} tok/s`;

	if (flight?.thinkingStartedAt !== undefined) {
		const thinking = `thinking ${seconds(now - flight.thinkingStartedAt)}`;
		return { rate, running: true, text: paced === undefined ? thinking : `${thinking} · ${paced}` };
	}
	if (flight && flight.firstDeltaAt === undefined) {
		return { rate, running: true, text: `waiting ${seconds(now - flight.requestedAt)}` };
	}

	return { rate, running: run.running, text: paced };
}
