import type { SessionUsage, UsageRow } from "./collect.ts";

export interface Totals {
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	input: number;
	messages: number;
	output: number;
	tokens: number;
}

export interface ModelTotals extends Totals {
	model: string;
}

export interface PeriodRow extends Totals {
	breakdown: ModelTotals[];
	period: string;
}

export interface SessionRow extends Totals {
	breakdown: ModelTotals[];
	label: string;
	lastTs: number;
	project: string;
}

export interface ProjectRow extends Totals {
	breakdown: ModelTotals[];
	firstTs: number;
	lastTs: number;
	project: string;
	sessions: number;
}

export interface Overview {
	activeDays: number;
	byModel: ModelTotals[];
	byProject: ProjectRow[];
	calendarDays: number;
	firstTs: number;
	lastTs: number;
	sessionCount: number;
	topSessions: SessionRow[];
	totals: Totals;
}

interface Aggregate {
	firstTs: number;
	lastTs: number;
	models: Map<string, ModelTotals>;
	sessions: Set<string>;
	totals: Totals;
}

export function emptyTotals(): Totals {
	return { cacheRead: 0, cacheWrite: 0, cost: 0, input: 0, messages: 0, output: 0, tokens: 0 };
}

function addRow(totals: Totals, row: UsageRow): void {
	totals.cacheRead += row.cacheRead;
	totals.cacheWrite += row.cacheWrite;
	totals.cost += row.cost;
	totals.input += row.input;
	totals.messages += row.messages;
	totals.output += row.output;
	totals.tokens += row.cacheRead + row.cacheWrite + row.input + row.output;
}

export function sumTotals(items: Totals[]): Totals {
	const totals = emptyTotals();
	for (const item of items) {
		totals.cacheRead += item.cacheRead;
		totals.cacheWrite += item.cacheWrite;
		totals.cost += item.cost;
		totals.input += item.input;
		totals.messages += item.messages;
		totals.output += item.output;
		totals.tokens += item.tokens;
	}
	return totals;
}

function createAggregate(): Aggregate {
	return {
		firstTs: Number.POSITIVE_INFINITY,
		lastTs: 0,
		models: new Map(),
		sessions: new Set(),
		totals: emptyTotals(),
	};
}

function absorb(aggregate: Aggregate, row: UsageRow, session: string): void {
	addRow(aggregate.totals, row);
	aggregate.firstTs = Math.min(aggregate.firstTs, row.firstTs);
	aggregate.lastTs = Math.max(aggregate.lastTs, row.lastTs);
	aggregate.sessions.add(session);

	const model = aggregate.models.get(row.model) ?? { ...emptyTotals(), model: row.model };
	addRow(model, row);
	aggregate.models.set(row.model, model);
}

function breakdownOf(aggregate: Aggregate): ModelTotals[] {
	return Array.from(aggregate.models.values())
		.filter((model) => model.cost > 0 || model.tokens > 0)
		.sort((left, right) => right.cost - left.cost);
}

function group(sessions: SessionUsage[], keyOf: (row: UsageRow, session: SessionUsage) => string): Map<string, Aggregate> {
	const groups = new Map<string, Aggregate>();
	for (const session of sessions) {
		for (const row of session.rows) {
			const key = keyOf(row, session);
			const aggregate = groups.get(key) ?? createAggregate();
			absorb(aggregate, row, session.path);
			groups.set(key, aggregate);
		}
	}
	return groups;
}

export function weekStart(date: string): string {
	const [year, month, day] = date.split("-").map(Number);
	const start = new Date(year, month - 1, day);
	start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
	const startMonth = `${start.getMonth() + 1}`.padStart(2, "0");
	const startDay = `${start.getDate()}`.padStart(2, "0");
	return `${start.getFullYear()}-${startMonth}-${startDay}`;
}

function periodRows(sessions: SessionUsage[], periodOf: (date: string) => string): PeriodRow[] {
	const groups = group(sessions, (row) => periodOf(row.date));
	return Array.from(groups, ([period, aggregate]) => ({
		...aggregate.totals,
		breakdown: breakdownOf(aggregate),
		period,
	})).sort((left, right) => right.period.localeCompare(left.period));
}

export function dailyRows(sessions: SessionUsage[]): PeriodRow[] {
	return periodRows(sessions, (date) => date);
}

export function weeklyRows(sessions: SessionUsage[]): PeriodRow[] {
	return periodRows(sessions, weekStart);
}

export function monthlyRows(sessions: SessionUsage[]): PeriodRow[] {
	return periodRows(sessions, (date) => date.slice(0, 7));
}

export function sessionRows(sessions: SessionUsage[]): SessionRow[] {
	return sessions
		.map((session) => {
			const aggregate = createAggregate();
			for (const row of session.rows) absorb(aggregate, row, session.path);
			return {
				...aggregate.totals,
				breakdown: breakdownOf(aggregate),
				label: session.name ?? session.firstMessage ?? session.id.slice(0, 8),
				lastTs: aggregate.lastTs,
				project: session.project,
			};
		})
		.filter((row) => row.tokens > 0)
		.sort((left, right) => right.cost - left.cost);
}

export function projectRows(sessions: SessionUsage[]): ProjectRow[] {
	const groups = group(sessions, (_row, session) => session.project);
	return Array.from(groups, ([project, aggregate]) => ({
		...aggregate.totals,
		breakdown: breakdownOf(aggregate),
		firstTs: aggregate.firstTs,
		lastTs: aggregate.lastTs,
		project,
		sessions: aggregate.sessions.size,
	})).sort((left, right) => right.cost - left.cost);
}

export function overview(sessions: SessionUsage[]): Overview {
	const aggregate = createAggregate();
	const dates = new Set<string>();
	for (const session of sessions) {
		for (const row of session.rows) {
			absorb(aggregate, row, session.path);
			dates.add(row.date);
		}
	}

	const days = Array.from(dates).sort();
	const spanStart = days.length > 0 ? new Date(days[0]).getTime() : 0;
	const spanEnd = days.length > 0 ? new Date(days[days.length - 1]).getTime() : 0;

	return {
		activeDays: dates.size,
		byModel: breakdownOf(aggregate),
		byProject: projectRows(sessions),
		calendarDays: days.length > 0 ? Math.round((spanEnd - spanStart) / 86_400_000) + 1 : 0,
		firstTs: aggregate.firstTs,
		lastTs: aggregate.lastTs,
		sessionCount: sessions.filter((session) => session.rows.length > 0).length,
		topSessions: sessionRows(sessions).slice(0, 10),
		totals: aggregate.totals,
	};
}
