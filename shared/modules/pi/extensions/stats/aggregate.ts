import type { Response, StatsSession } from "./records.ts";

export type Period = "day" | "hour" | "minute" | "month" | "week";

export interface Totals {
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	firstTs: number;
	input: number;
	lastTs: number;
	output: number;
	reasoning: number;
	responses: number;
	thinkingMs: number;
	thinkingResponses: number;
	thinkingTokens: number;
	timedOutput: number;
	timedResponses: number;
	tokens: number;
	waits: number[];
	workMs: number;
}

export interface ModelTotals extends Totals {
	model: string;
}

export interface PeriodRow extends Totals {
	breakdown: ModelTotals[];
	label: string;
	start: number;
}

export interface SessionRow extends Totals {
	breakdown: ModelTotals[];
	host: string;
	label: string;
	project: string;
}

export interface HostRow extends Totals {
	breakdown: ModelTotals[];
	host: string;
	sessions: number;
}

export interface ProjectRow extends Totals {
	breakdown: ModelTotals[];
	project: string;
	sessions: number;
}

export interface Overview {
	activeDays: number;
	byHost: HostRow[];
	byModel: ModelTotals[];
	byProject: ProjectRow[];
	calendarDays: number;
	peak?: PeriodRow;
	projects: number;
	sessionCount: number;
	today: Totals;
	topSessions: SessionRow[];
	totals: Totals;
	waitSince: number;
}

interface Group {
	models: Map<string, ModelTotals>;
	sessions: Set<string>;
	totals: Totals;
}

const DAY_MS = 86_400_000;

export function emptyTotals(): Totals {
	return {
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		firstTs: Number.POSITIVE_INFINITY,
		input: 0,
		lastTs: 0,
		output: 0,
		reasoning: 0,
		responses: 0,
		thinkingMs: 0,
		thinkingResponses: 0,
		thinkingTokens: 0,
		timedOutput: 0,
		timedResponses: 0,
		tokens: 0,
		waits: [],
		workMs: 0,
	};
}

export function addResponse(totals: Totals, response: Response): void {
	totals.cacheRead += response.cacheRead;
	totals.cacheWrite += response.cacheWrite;
	totals.cost += response.cost;
	totals.firstTs = Math.min(totals.firstTs, response.endedAt);
	totals.input += response.input;
	totals.lastTs = Math.max(totals.lastTs, response.endedAt);
	totals.output += response.output;
	totals.reasoning += response.reasoning;
	totals.responses += 1;
	totals.tokens += response.cacheRead + response.cacheWrite + response.input + response.output;

	if (response.firstTokenMs !== undefined) totals.waits.push(response.firstTokenMs);
	if (response.reasoning > 0) {
		totals.thinkingResponses += 1;
		if (response.thinkingMs !== undefined && response.thinkingMs > 0) {
			totals.thinkingMs += response.thinkingMs;
			totals.thinkingTokens += response.reasoning;
		}
	}
	if (response.durationMs > 0 && response.output > 0) {
		totals.timedOutput += response.output;
		totals.timedResponses += 1;
		totals.workMs += response.durationMs;
	}
}

export function totalsOf(responses: Response[]): Totals {
	const totals = emptyTotals();
	for (const response of responses) addResponse(totals, response);
	return totals;
}

export function sumTotals(items: Totals[]): Totals {
	const totals = emptyTotals();
	for (const item of items) {
		totals.cacheRead += item.cacheRead;
		totals.cacheWrite += item.cacheWrite;
		totals.cost += item.cost;
		totals.firstTs = Math.min(totals.firstTs, item.firstTs);
		totals.input += item.input;
		totals.lastTs = Math.max(totals.lastTs, item.lastTs);
		totals.output += item.output;
		totals.reasoning += item.reasoning;
		totals.responses += item.responses;
		totals.thinkingMs += item.thinkingMs;
		totals.thinkingResponses += item.thinkingResponses;
		totals.thinkingTokens += item.thinkingTokens;
		totals.timedOutput += item.timedOutput;
		totals.timedResponses += item.timedResponses;
		totals.tokens += item.tokens;
		totals.waits.push(...item.waits);
		totals.workMs += item.workMs;
	}
	return totals;
}

export function tokenRate(totals: Totals): number | undefined {
	return totals.workMs > 0 && totals.timedOutput > 0 ? (totals.timedOutput * 1000) / totals.workMs : undefined;
}

export function thinkRate(totals: Totals): number | undefined {
	return totals.thinkingMs > 0 ? (totals.thinkingTokens * 1000) / totals.thinkingMs : undefined;
}

export function median(values: number[]): number | undefined {
	if (values.length === 0) return undefined;

	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);

	return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

export function medianWait(totals: Totals): number | undefined {
	return median(totals.waits);
}

export function cacheHit(totals: Totals): number | undefined {
	const reads = totals.cacheRead + totals.cacheWrite + totals.input;
	return reads > 0 ? totals.cacheRead / reads : undefined;
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
	if (period === "month") return new Date(date.getFullYear(), date.getMonth(), 1).getTime();

	const midnight = new Date(date.getFullYear(), date.getMonth(), date.getDate());
	if (period === "week") midnight.setDate(midnight.getDate() - ((midnight.getDay() + 6) % 7));

	return midnight.getTime();
}

export function previousPeriod(period: Period, start: number): number {
	const date = new Date(start);

	if (period === "minute") date.setMinutes(date.getMinutes() - 1);
	else if (period === "hour") date.setHours(date.getHours() - 1);
	else if (period === "day") date.setDate(date.getDate() - 1);
	else if (period === "month") date.setMonth(date.getMonth() - 1);
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
	if (period === "hour") return `${day}.${month}. ${hours}:00`;
	if (period === "month") return `${month}.${date.getFullYear()}`;
	return `${day}.${month}.${date.getFullYear()}`;
}

export function allResponses(sessions: StatsSession[]): Response[] {
	return sessions.flatMap((session) => session.responses);
}

function createGroup(): Group {
	return { models: new Map(), sessions: new Set(), totals: emptyTotals() };
}

function absorb(group: Group, response: Response, session: string): void {
	addResponse(group.totals, response);
	group.sessions.add(session);

	const model = group.models.get(response.model) ?? { ...emptyTotals(), model: response.model };
	addResponse(model, response);
	group.models.set(response.model, model);
}

function breakdownOf(group: Group): ModelTotals[] {
	return Array.from(group.models.values()).sort((left, right) => right.tokens - left.tokens);
}

function groupBy(
	sessions: StatsSession[],
	keyOf: (response: Response, session: StatsSession) => number | string,
): Map<number | string, Group> {
	const groups = new Map<number | string, Group>();
	for (const session of sessions) {
		for (const response of session.responses) {
			const key = keyOf(response, session);
			const group = groups.get(key) ?? createGroup();
			absorb(group, response, session.id);
			groups.set(key, group);
		}
	}
	return groups;
}

export function modelRows(sessions: StatsSession[]): ModelTotals[] {
	const groups = groupBy(sessions, (response) => response.model);
	return Array.from(groups, ([model, group]) => ({ ...group.totals, model: `${model}` })).sort(
		(left, right) => right.cost - left.cost || right.tokens - left.tokens,
	);
}

export function periodRows(sessions: StatsSession[], period: Period, span?: number): PeriodRow[] {
	const cutoff = span === undefined ? 0 : Date.now() - span;
	const groups = groupBy(sessions, (response) =>
		response.endedAt >= cutoff ? periodStart(period, response.endedAt) : -1,
	);
	groups.delete(-1);

	return Array.from(groups, ([start, group]) => ({
		...group.totals,
		breakdown: breakdownOf(group),
		label: periodLabel(period, Number(start)),
		start: Number(start),
	})).sort((left, right) => right.start - left.start);
}

export function sessionRows(sessions: StatsSession[]): SessionRow[] {
	return sessions
		.filter((session) => session.responses.length > 0)
		.map((session) => {
			const group = createGroup();
			for (const response of session.responses) absorb(group, response, session.id);
			return {
				...group.totals,
				breakdown: breakdownOf(group),
				host: session.host,
				label: session.name ?? session.firstMessage ?? session.id.slice(0, 8),
				project: session.project,
			};
		})
		.sort((left, right) => right.cost - left.cost);
}

export function hostRows(sessions: StatsSession[]): HostRow[] {
	const groups = groupBy(sessions, (_response, session) => session.host);
	return Array.from(groups, ([host, group]) => ({
		...group.totals,
		breakdown: breakdownOf(group),
		host: `${host}`,
		sessions: group.sessions.size,
	})).sort((left, right) => right.cost - left.cost);
}

export function projectRows(sessions: StatsSession[]): ProjectRow[] {
	const groups = groupBy(sessions, (_response, session) => session.project);
	return Array.from(groups, ([project, group]) => ({
		...group.totals,
		breakdown: breakdownOf(group),
		project: `${project}`,
		sessions: group.sessions.size,
	})).sort((left, right) => right.cost - left.cost);
}

function peakMinute(responses: Response[]): PeriodRow | undefined {
	const minutes = new Map<number, Totals>();
	for (const response of responses) {
		if (response.durationMs <= 0 || response.output <= 0) continue;
		const start = periodStart("minute", response.endedAt);
		const totals = minutes.get(start) ?? emptyTotals();
		addResponse(totals, response);
		minutes.set(start, totals);
	}

	let best: PeriodRow | undefined;
	for (const [start, totals] of minutes) {
		if (best !== undefined && (tokenRate(totals) ?? 0) <= (tokenRate(best) ?? 0)) continue;
		best = { ...totals, breakdown: [], label: periodLabel("minute", start), start };
	}
	return best;
}

export function overview(sessions: StatsSession[]): Overview {
	const responses = allResponses(sessions);
	const midnight = periodStart("day", Date.now());
	const days = new Set<number>();
	const projects = new Set<string>();
	let waitSince = Number.POSITIVE_INFINITY;

	for (const response of responses) {
		days.add(periodStart("day", response.endedAt));
		if (response.firstTokenMs !== undefined) waitSince = Math.min(waitSince, response.endedAt);
	}
	for (const session of sessions) {
		if (session.responses.length > 0) projects.add(session.project);
	}

	const sorted = Array.from(days).sort((left, right) => left - right);
	const span = sorted.length > 0 ? sorted[sorted.length - 1] - sorted[0] : 0;

	return {
		activeDays: days.size,
		byHost: hostRows(sessions),
		byModel: modelRows(sessions),
		byProject: projectRows(sessions),
		calendarDays: sorted.length > 0 ? Math.round(span / DAY_MS) + 1 : 0,
		peak: peakMinute(responses),
		projects: projects.size,
		sessionCount: sessions.filter((session) => session.responses.length > 0).length,
		today: totalsOf(responses.filter((response) => response.endedAt >= midnight)),
		topSessions: sessionRows(sessions).slice(0, 10),
		totals: totalsOf(responses),
		waitSince,
	};
}
