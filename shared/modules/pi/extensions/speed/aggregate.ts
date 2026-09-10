import { type Sample, tokensPerSecond } from "./samples.ts";

export type Period = "day" | "hour" | "minute" | "week";

export interface Rate {
	lastTs: number;
	responses: number;
	thinkingMs: number;
	thinkingResponses: number;
	thinkingTokens: number;
	tokens: number;
	waits: number[];
	workMs: number;
}

export interface ModelRate extends Rate {
	model: string;
}

export interface PeriodRate extends Rate {
	breakdown: ModelRate[];
	label: string;
	start: number;
}

export interface SessionRate extends Rate {
	breakdown: ModelRate[];
	label: string;
	project: string;
}

export interface ProjectRate extends Rate {
	breakdown: ModelRate[];
	project: string;
	sessions: number;
}

export interface Overview {
	byModel: ModelRate[];
	byProject: ProjectRate[];
	firstTs: number;
	peak?: PeriodRate;
	projects: number;
	recentSessions: SessionRate[];
	sessions: number;
	today: Rate;
	totals: Rate;
}

export function emptyRate(): Rate {
	return {
		lastTs: 0,
		responses: 0,
		thinkingMs: 0,
		thinkingResponses: 0,
		thinkingTokens: 0,
		tokens: 0,
		waits: [],
		workMs: 0,
	};
}

export function rateOf(samples: Sample[]): Rate {
	const rate = emptyRate();

	for (const sample of samples) {
		const reasoning = sample.reasoningTokens ?? 0;
		rate.lastTs = Math.max(rate.lastTs, sample.at);
		rate.responses += 1;
		rate.tokens += sample.outputTokens;
		rate.waits.push(sample.firstTokenMs);
		rate.workMs += sample.totalMs;

		if (reasoning <= 0) continue;
		rate.thinkingResponses += 1;
		if (sample.thinkingMs > 0) {
			rate.thinkingMs += sample.thinkingMs;
			rate.thinkingTokens += reasoning;
		}
	}

	return rate;
}

export function sumRates(rates: Rate[]): Rate {
	const total = emptyRate();

	for (const rate of rates) {
		total.lastTs = Math.max(total.lastTs, rate.lastTs);
		total.responses += rate.responses;
		total.thinkingMs += rate.thinkingMs;
		total.thinkingResponses += rate.thinkingResponses;
		total.thinkingTokens += rate.thinkingTokens;
		total.tokens += rate.tokens;
		total.waits.push(...rate.waits);
		total.workMs += rate.workMs;
	}

	return total;
}

export function tokenRate(rate: Rate): number | undefined {
	return rate.workMs > 0 && rate.tokens > 0 ? tokensPerSecond(rate.tokens, rate.workMs) : undefined;
}

export function thinkRate(rate: Rate): number | undefined {
	return rate.thinkingMs > 0 ? tokensPerSecond(rate.thinkingTokens, rate.thinkingMs) : undefined;
}

export function median(values: number[]): number | undefined {
	if (values.length === 0) return undefined;

	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);

	return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function groupBy(samples: Sample[], keyOf: (sample: Sample) => string): Map<string, Sample[]> {
	const groups = new Map<string, Sample[]>();

	for (const sample of samples) {
		const key = keyOf(sample);
		const group = groups.get(key);
		if (group) group.push(sample);
		else groups.set(key, [sample]);
	}

	return groups;
}

export function periodStart(period: Period, ms: number): number {
	const date = new Date(ms);

	if (period === "minute") {
		return new Date(
			date.getFullYear(),
			date.getMonth(),
			date.getDate(),
			date.getHours(),
			date.getMinutes(),
		).getTime();
	}
	if (period === "hour") {
		return new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours()).getTime();
	}

	const midnight = new Date(date.getFullYear(), date.getMonth(), date.getDate());
	if (period === "week") midnight.setDate(midnight.getDate() - ((midnight.getDay() + 6) % 7));

	return midnight.getTime();
}

export function previousPeriod(period: Period, start: number): number {
	const date = new Date(start);

	if (period === "minute") date.setMinutes(date.getMinutes() - 1);
	else if (period === "hour") date.setHours(date.getHours() - 1);
	else if (period === "day") date.setDate(date.getDate() - 1);
	else date.setDate(date.getDate() - 7);

	return date.getTime();
}

export function periodLabel(period: Period, start: number): string {
	const date = new Date(start);
	const day = `${date.getDate()}`.padStart(2, "0");
	const hours = `${date.getHours()}`.padStart(2, "0");
	const minutes = `${date.getMinutes()}`.padStart(2, "0");
	const month = `${date.getMonth() + 1}`.padStart(2, "0");

	if (period === "minute") return `${hours}:${minutes}`;
	if (period === "hour") return `${month}-${day} ${hours}:00`;
	return `${date.getFullYear()}-${month}-${day}`;
}

export function modelRows(samples: Sample[]): ModelRate[] {
	return Array.from(groupBy(samples, (sample) => sample.model), ([model, group]) => ({
		...rateOf(group),
		model,
	})).sort((left, right) => right.tokens - left.tokens);
}

export function periodRows(samples: Sample[], period: Period): PeriodRate[] {
	return Array.from(
		groupBy(samples, (sample) => `${periodStart(period, sample.at)}`),
		([start, group]) => ({
			...rateOf(group),
			breakdown: modelRows(group),
			label: periodLabel(period, Number(start)),
			start: Number(start),
		}),
	).sort((left, right) => right.start - left.start);
}

const UNATTRIBUTED = "";

function sessionKey(sample: Sample): string {
	return sample.session || UNATTRIBUTED;
}

function projectKey(sample: Sample): string {
	return sample.project || UNATTRIBUTED;
}

function sessionLabel(session: string, group: Sample[]): string {
	const newest = group.filter((sample) => sample.sessionName).sort((left, right) => right.at - left.at)[0];
	if (newest?.sessionName) return newest.sessionName;

	return session === UNATTRIBUTED ? "(unknown)" : session.slice(0, 8);
}

export function sessionRows(samples: Sample[]): SessionRate[] {
	return Array.from(groupBy(samples, sessionKey), ([session, group]) => ({
		...rateOf(group),
		breakdown: modelRows(group),
		label: sessionLabel(session, group),
		project: projectKey(group[group.length - 1]),
	})).sort((left, right) => right.lastTs - left.lastTs);
}

export function projectRows(samples: Sample[]): ProjectRate[] {
	return Array.from(groupBy(samples, projectKey), ([project, group]) => ({
		...rateOf(group),
		breakdown: modelRows(group),
		project,
		sessions: new Set(group.map(sessionKey)).size,
	})).sort((left, right) => right.tokens - left.tokens);
}

export function overview(samples: Sample[]): Overview {
	const minutes = periodRows(samples, "minute").filter((minute) => minute.tokens > 0);
	const today = samples.filter((sample) => sample.at >= periodStart("day", Date.now()));

	return {
		byModel: modelRows(samples),
		byProject: projectRows(samples),
		firstTs: samples.reduce((first, sample) => Math.min(first, sample.at), Number.POSITIVE_INFINITY),
		peak: minutes.sort((left, right) => (tokenRate(right) ?? 0) - (tokenRate(left) ?? 0))[0],
		projects: new Set(samples.map(projectKey)).size,
		recentSessions: sessionRows(samples).slice(0, 10),
		sessions: new Set(samples.map(sessionKey)).size,
		today: rateOf(today),
		totals: rateOf(samples),
	};
}
