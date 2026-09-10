import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Key, matchesKey, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	allResponses,
	cacheHit,
	medianWait,
	type ModelTotals,
	modelRows,
	overview,
	type Overview,
	type PeriodRow,
	periodRows,
	type ProjectRow,
	projectRows,
	type SessionRow,
	sessionRows,
	sumTotals,
	thinkRate,
	tokenRate,
	type Totals,
} from "./aggregate.ts";
import { chartLines, type Metric, ZOOMS } from "./chart.ts";
import type { LiveSnapshot } from "./live.ts";
import { shortModel, type StatsSession } from "./records.ts";
import {
	clockTime,
	type ColumnSpec,
	formatCost,
	formatCount,
	formatDate,
	formatDuration,
	formatRate,
	formatShare,
	formatTokens,
	formatWait,
	joinModels,
	modelName,
	renderTable,
	shortProject,
	type TableRow,
} from "./table.ts";

const CHART_HEIGHT = 6;
const CHROME_LINES = 5;
const EMPTY = "Nothing recorded.";
const HOUR_SPAN = 3 * 86_400_000;
const LIVE_INTERVAL_MS = 1_000;
const REFRESH_INTERVAL_MS = 60_000;

interface SortDescriptor<T> {
	header: string;
	numeric: boolean;
	value: (row: T) => number | string;
}

interface SortOption<T> extends SortDescriptor<T> {
	column: number;
}

interface TableTab<T extends Totals & { breakdown: ModelTotals[] }> {
	cells: (row: T) => string[];
	columns: ColumnSpec[];
	defaultSort: string;
	name: string;
	rows: (sessions: StatsSession[]) => T[];
	sorts: SortOption<T>[];
	subCells: (model: ModelTotals) => string[];
	total: (rows: T[]) => string[];
}

const STATS_COLUMNS: ColumnSpec[] = [
	{ align: "right", header: "Responses", priority: 5 },
	{ align: "right", header: "Input", priority: 7 },
	{ align: "right", header: "Output", priority: 6 },
	{ align: "right", header: "Cache W", priority: 12 },
	{ align: "right", header: "Cache R", priority: 11 },
	{ align: "right", header: "Tokens", priority: 1 },
	{ align: "right", header: "Cost", priority: 0 },
	{ align: "right", header: "Work", priority: 4 },
	{ align: "right", header: "Tok/s", priority: 0 },
	{ align: "right", header: "Think", priority: 10 },
	{ align: "right", header: "Wait", priority: 9 },
];

function statsCells(totals: Totals): string[] {
	return [
		formatCount(totals.responses),
		formatTokens(totals.input),
		formatTokens(totals.output),
		formatTokens(totals.cacheWrite),
		formatTokens(totals.cacheRead),
		formatTokens(totals.tokens),
		formatCost(totals.cost),
		formatDuration(totals.workMs),
		formatRate(tokenRate(totals)),
		formatRate(thinkRate(totals)),
		formatWait(medianWait(totals)),
	];
}

function numberSort<T>(header: string, value: (row: T) => number): SortDescriptor<T> {
	return { header, numeric: true, value };
}

function textSort<T>(header: string, value: (row: T) => string): SortDescriptor<T> {
	return { header, numeric: false, value };
}

function sortOptions<T>(columns: ColumnSpec[], descriptors: Array<SortDescriptor<T>>): SortOption<T>[] {
	return descriptors.map((descriptor) => ({
		...descriptor,
		column: columns.findIndex((column) => column.header === descriptor.header),
	}));
}

function statsSorts<T extends Totals>(): Array<SortDescriptor<T>> {
	return [
		numberSort<T>("Responses", (row) => row.responses),
		numberSort<T>("Input", (row) => row.input),
		numberSort<T>("Output", (row) => row.output),
		numberSort<T>("Cache W", (row) => row.cacheWrite),
		numberSort<T>("Cache R", (row) => row.cacheRead),
		numberSort<T>("Tokens", (row) => row.tokens),
		numberSort<T>("Cost", (row) => row.cost),
		numberSort<T>("Work", (row) => row.workMs),
		numberSort<T>("Tok/s", (row) => tokenRate(row) ?? 0),
		numberSort<T>("Think", (row) => thinkRate(row) ?? 0),
		numberSort<T>("Wait", (row) => medianWait(row) ?? 0),
	];
}

function periodTab(
	name: string,
	header: string,
	period: "day" | "hour" | "month" | "week",
	span?: number,
): TableTab<PeriodRow> {
	const columns: ColumnSpec[] = [
		{ align: "left", header, priority: 0 },
		{ align: "left", header: "Models", maxWidth: 26, priority: 8 },
		...STATS_COLUMNS,
	];

	return {
		cells: (row) => [row.label, joinModels(row.breakdown.map((model) => model.model)), ...statsCells(row)],
		columns,
		defaultSort: header,
		name,
		rows: (sessions) => periodRows(sessions, period, span),
		sorts: sortOptions<PeriodRow>(columns, [
			numberSort<PeriodRow>(header, (row) => row.start),
			...statsSorts<PeriodRow>(),
		]),
		subCells: (model) => [`  └─ ${modelName(model.model)}`, "", ...statsCells(model)],
		total: (rows) => ["Total", "", ...statsCells(sumTotals(rows))],
	};
}

function modelTab(): TableTab<ModelTotals & { breakdown: ModelTotals[] }> {
	const columns: ColumnSpec[] = [
		{ align: "left", header: "Model", maxWidth: 34, priority: 0 },
		...STATS_COLUMNS,
		{ align: "left", header: "Last", priority: 3 },
	];

	return {
		cells: (row) => [shortModel(row.model), ...statsCells(row), formatDate(row.lastTs)],
		columns,
		defaultSort: "Cost",
		name: "Models",
		rows: (sessions) => modelRows(sessions).map((row) => ({ ...row, breakdown: [] })),
		sorts: sortOptions(columns, [
			textSort<ModelTotals>("Model", (row) => row.model),
			...statsSorts<ModelTotals>(),
			numberSort<ModelTotals>("Last", (row) => row.lastTs),
		]),
		subCells: () => [],
		total: (rows) => ["Total", ...statsCells(sumTotals(rows)), ""],
	};
}

function sessionTab(): TableTab<SessionRow> {
	const columns: ColumnSpec[] = [
		{ align: "left", header: "Session", maxWidth: 38, priority: 0 },
		{ align: "left", header: "Project", maxWidth: 26, priority: 2 },
		{ align: "left", header: "Models", maxWidth: 20, priority: 8 },
		...STATS_COLUMNS,
		{ align: "left", header: "Last", priority: 3 },
	];

	return {
		cells: (row) => [
			row.label,
			shortProject(row.project),
			joinModels(row.breakdown.map((model) => model.model)),
			...statsCells(row),
			formatDate(row.lastTs),
		],
		columns,
		defaultSort: "Last",
		name: "Sessions",
		rows: sessionRows,
		sorts: sortOptions<SessionRow>(columns, [
			textSort<SessionRow>("Session", (row) => row.label.toLowerCase()),
			textSort<SessionRow>("Project", (row) => row.project),
			...statsSorts<SessionRow>(),
			numberSort<SessionRow>("Last", (row) => row.lastTs),
		]),
		subCells: (model) => [`  └─ ${modelName(model.model)}`, "", "", ...statsCells(model), ""],
		total: (rows) => ["Total", "", "", ...statsCells(sumTotals(rows)), ""],
	};
}

function projectTab(): TableTab<ProjectRow> {
	const columns: ColumnSpec[] = [
		{ align: "left", header: "Project", maxWidth: 40, priority: 0 },
		{ align: "right", header: "Sessions", priority: 2 },
		{ align: "left", header: "Models", maxWidth: 20, priority: 8 },
		...STATS_COLUMNS,
		{ align: "left", header: "Last", priority: 3 },
	];

	return {
		cells: (row) => [
			shortProject(row.project),
			formatCount(row.sessions),
			joinModels(row.breakdown.map((model) => model.model)),
			...statsCells(row),
			formatDate(row.lastTs),
		],
		columns,
		defaultSort: "Cost",
		name: "Projects",
		rows: projectRows,
		sorts: sortOptions<ProjectRow>(columns, [
			textSort<ProjectRow>("Project", (row) => row.project),
			numberSort<ProjectRow>("Sessions", (row) => row.sessions),
			...statsSorts<ProjectRow>(),
			numberSort<ProjectRow>("Last", (row) => row.lastTs),
		]),
		subCells: (model) => [`  └─ ${modelName(model.model)}`, "", "", ...statsCells(model), ""],
		total: (rows) => [
			"Total",
			formatCount(rows.reduce((sum, row) => sum + row.sessions, 0)),
			"",
			...statsCells(sumTotals(rows)),
			"",
		],
	};
}

const TABLE_TABS = [
	periodTab("Hourly", "Hour", "hour", HOUR_SPAN),
	periodTab("Daily", "Date", "day"),
	periodTab("Weekly", "Week", "week"),
	periodTab("Monthly", "Month", "month"),
	modelTab(),
	sessionTab(),
	projectTab(),
] as unknown as Array<TableTab<Totals & { breakdown: ModelTotals[] }>>;

const TABS = ["All", ...TABLE_TABS.map((table) => table.name)];

const OVERVIEW_MODEL_COLUMNS: ColumnSpec[] = [
	{ align: "left", header: "Model", maxWidth: 34, priority: 0 },
	{ align: "right", header: "Responses", priority: 4 },
	{ align: "right", header: "Tokens", priority: 1 },
	{ align: "right", header: "Cost", priority: 0 },
	{ align: "right", header: "Share", priority: 2 },
	{ align: "right", header: "Tok/s", priority: 0 },
	{ align: "right", header: "Wait", priority: 5 },
];

const OVERVIEW_PROJECT_COLUMNS: ColumnSpec[] = [
	{ align: "left", header: "Project", maxWidth: 44, priority: 0 },
	{ align: "right", header: "Sessions", priority: 4 },
	{ align: "right", header: "Tokens", priority: 1 },
	{ align: "right", header: "Cost", priority: 0 },
	{ align: "right", header: "Share", priority: 2 },
	{ align: "right", header: "Tok/s", priority: 0 },
];

const OVERVIEW_SESSION_COLUMNS: ColumnSpec[] = [
	{ align: "left", header: "Session", maxWidth: 44, priority: 0 },
	{ align: "left", header: "Project", maxWidth: 28, priority: 2 },
	{ align: "right", header: "Tokens", priority: 1 },
	{ align: "right", header: "Cost", priority: 0 },
	{ align: "right", header: "Tok/s", priority: 0 },
	{ align: "left", header: "Last", priority: 3 },
];

export interface StatsViewOptions {
	done: () => void;
	live: () => LiveSnapshot;
	load: () => StatsSession[];
	subscribe: (listener: () => void) => () => void;
	theme: Theme;
	tui: TUI;
}

function compare(left: number | string, right: number | string): number {
	return typeof left === "number" && typeof right === "number"
		? left - right
		: String(left).localeCompare(String(right));
}

function plural(count: number, noun: string): string {
	return `${formatCount(count)} ${noun}${count === 1 ? "" : "s"}`;
}

function percent(value: number | undefined): string {
	return value === undefined ? "-" : `${(value * 100).toFixed(1)}%`;
}

function spendLine(report: Overview): string {
	const { totals } = report;
	const perDay = report.activeDays > 0 ? totals.cost / report.activeDays : 0;
	const perResponse = totals.responses > 0 ? totals.cost / totals.responses : 0;
	const perSession = report.sessionCount > 0 ? totals.cost / report.sessionCount : 0;

	return `${formatCost(totals.cost)} · ${formatCost(perDay)} per active day · ${formatCost(perSession)} per session · $${perResponse.toFixed(4)} per response`;
}

function tokenLine(totals: Totals): string {
	return `${formatTokens(totals.tokens)} · in ${formatTokens(totals.input)} · out ${formatTokens(totals.output)} · cache write ${formatTokens(totals.cacheWrite)} · cache read ${formatTokens(totals.cacheRead)} · cache hit ${percent(cacheHit(totals))}`;
}

function waitLine(report: Overview): string {
	const { totals } = report;
	if (totals.waits.length === 0) return "not recorded yet";

	return `median ${formatWait(medianWait(totals))} to first token · ${plural(totals.waits.length, "timed response")} since ${formatDate(report.waitSince)}`;
}

function thinkingLine(totals: Totals): string {
	if (totals.thinkingResponses === 0) return "none recorded";

	return `${formatCount(totals.thinkingResponses)} of ${plural(totals.responses, "response")} · ${formatRate(thinkRate(totals))} tok/s · ${percent(totals.output > 0 ? totals.reasoning / totals.output : undefined)} of output tokens`;
}

function summaryLines(report: Overview, live: LiveSnapshot, theme: Theme): string[] {
	const { totals } = report;
	const entries: Array<[string, string]> = [
		["Spend", spendLine(report)],
		["Tokens", tokenLine(totals)],
		[
			"Responses",
			`${formatCount(totals.responses)} in ${plural(report.sessionCount, "session")} across ${plural(report.projects, "project")}`,
		],
		[
			"Active days",
			`${formatCount(report.activeDays)} of ${formatCount(report.calendarDays)} calendar days · ${formatDate(report.totals.firstTs)} → ${formatDate(totals.lastTs)}`,
		],
		[
			"Speed",
			`now ${live.text ?? "idle"} · today ${formatRate(tokenRate(report.today))} tok/s · all time ${formatRate(tokenRate(totals))} tok/s`,
		],
		["Work", `${formatDuration(report.today.workMs)} today · ${formatDuration(totals.workMs)} all time`],
		["Wait", waitLine(report)],
		["Thinking", thinkingLine(totals)],
		[
			"Peak minute",
			report.peak
				? `${formatRate(tokenRate(report.peak))} tok/s at ${clockTime(report.peak.start)} on ${formatDate(report.peak.start)}`
				: "-",
		],
	];
	const label = Math.max(...entries.map(([name]) => name.length));

	return entries.map(([name, value]) => `${theme.fg("muted", name.padEnd(label))}  ${value}`);
}

function section(title: string, theme: Theme): string[] {
	return ["", theme.fg("accent", theme.bold(title)), ""];
}

function overviewBody(
	report: Overview,
	sessions: StatsSession[],
	live: LiveSnapshot,
	zoom: number,
	metric: Metric,
	theme: Theme,
	width: number,
): string[] {
	const spend = report.totals.cost;

	const models: TableRow[] = report.byModel.map((model) => ({
		cells: [
			shortModel(model.model),
			formatCount(model.responses),
			formatTokens(model.tokens),
			formatCost(model.cost),
			formatShare(model.cost, spend),
			formatRate(tokenRate(model)),
			formatWait(medianWait(model)),
		],
		kind: "data",
	}));

	const projects: TableRow[] = report.byProject.slice(0, 10).map((project) => ({
		cells: [
			shortProject(project.project),
			formatCount(project.sessions),
			formatTokens(project.tokens),
			formatCost(project.cost),
			formatShare(project.cost, spend),
			formatRate(tokenRate(project)),
		],
		kind: "data",
	}));

	const top: TableRow[] = report.topSessions.map((session) => ({
		cells: [
			session.label,
			shortProject(session.project),
			formatTokens(session.tokens),
			formatCost(session.cost),
			formatRate(tokenRate(session)),
			formatDate(session.lastTs),
		],
		kind: "data",
	}));

	return [
		...summaryLines(report, live, theme),
		...section("Throughput", theme),
		...chartLines(allResponses(sessions), ZOOMS[zoom], metric, theme, width, CHART_HEIGHT),
		...section("By model", theme),
		...renderTable(OVERVIEW_MODEL_COLUMNS, models, theme, width, undefined, EMPTY).lines,
		...section("By project", theme),
		...renderTable(OVERVIEW_PROJECT_COLUMNS, projects, theme, width, undefined, EMPTY).lines,
		...section("Most expensive sessions", theme),
		...renderTable(OVERVIEW_SESSION_COLUMNS, top, theme, width, undefined, EMPTY).lines,
	];
}

export function createStatsView(options: StatsViewOptions): Component {
	const { done, live, load, subscribe, theme, tui } = options;

	let sessions = load();
	let report = overview(sessions);
	let snapshot = live();
	let updatedAt = Date.now();
	let tab = 0;
	let zoom = 0;
	let metric: Metric = "rate";
	let breakdown = false;
	let cache: { key: string; lines: string[] } | undefined;

	const scroll = TABS.map(() => 0);
	const visibleColumns = TABLE_TABS.map(() => [] as number[]);
	const sort = TABLE_TABS.map((table) => ({
		descending: true,
		index: table.sorts.findIndex((option) => option.header === table.defaultSort),
	}));

	function refresh(): void {
		cache = undefined;
		tui.requestRender();
	}

	function reload(): void {
		sessions = load();
		report = overview(sessions);
		snapshot = live();
		updatedAt = Date.now();
		refresh();
	}

	const unsubscribe = subscribe(reload);

	const timer = setInterval(reload, REFRESH_INTERVAL_MS);
	timer.unref();

	const ticker = setInterval(() => {
		const next = live();
		if (next.text === snapshot.text) return;
		snapshot = next;
		if (tab === 0) refresh();
		else tui.requestRender();
	}, LIVE_INTERVAL_MS);
	ticker.unref();

	function close(): void {
		clearInterval(ticker);
		clearInterval(timer);
		unsubscribe();
		done();
	}

	function tableBody(index: number, width: number): string[] {
		const table = TABLE_TABS[index];
		const state = sort[index];
		const option = table.sorts[state.index];
		const rows = table
			.rows(sessions)
			.sort((left, right) => compare(option.value(left), option.value(right)) * (state.descending ? -1 : 1));

		const lines: TableRow[] = [];
		for (const row of rows) {
			lines.push({ cells: table.cells(row), kind: "data" });
			if (breakdown && row.breakdown.length > 1) {
				lines.push(...row.breakdown.map((model) => ({ cells: table.subCells(model), kind: "sub" as const })));
			}
		}
		if (rows.length > 0) lines.push({ cells: table.total(rows), kind: "total" });

		const rendered = renderTable(
			table.columns,
			lines,
			theme,
			width,
			{ ascending: !state.descending, column: option.column },
			EMPTY,
		);
		visibleColumns[index] = rendered.kept;
		return rendered.lines;
	}

	function bodyLines(width: number): string[] {
		const state = tab > 0 ? sort[tab - 1] : undefined;
		const key = `${tab}:${zoom}:${metric}:${breakdown}:${state?.index}:${state?.descending}:${width}:${updatedAt}:${snapshot.text}`;
		if (cache?.key === key) return cache.lines;

		const lines =
			tab === 0
				? overviewBody(report, sessions, snapshot, zoom, metric, theme, width)
				: tableBody(tab - 1, width);
		cache = { key, lines };
		return lines;
	}

	function viewportHeight(): number {
		return Math.max(5, Math.floor(tui.terminal.rows / 2) - CHROME_LINES);
	}

	function cycleSort(step: number): void {
		if (tab === 0) return;
		const table = TABLE_TABS[tab - 1];
		const state = sort[tab - 1];
		const kept = visibleColumns[tab - 1];
		const usable = table.sorts.filter((option) => kept.includes(option.column));
		const options = usable.length > 0 ? usable : table.sorts;

		const current = options.indexOf(table.sorts[state.index]);
		const next =
			current < 0
				? options[step > 0 ? 0 : options.length - 1]
				: options[(current + step + options.length) % options.length];

		state.index = table.sorts.indexOf(next);
		state.descending = next.numeric;
		scroll[tab] = 0;
		refresh();
	}

	function flipSort(): void {
		if (tab === 0) return;
		sort[tab - 1].descending = !sort[tab - 1].descending;
		scroll[tab] = 0;
		refresh();
	}

	function scrollBy(amount: number, lines: number): void {
		const limit = Math.max(0, lines - viewportHeight());
		scroll[tab] = Math.min(limit, Math.max(0, scroll[tab] + amount));
		tui.requestRender();
	}

	function title(width: number): string {
		const parts = [
			theme.fg("accent", theme.bold("π stats")),
			formatCost(report.totals.cost),
			plural(report.sessionCount, "session"),
			`${formatTokens(report.totals.tokens)} tokens`,
			...(snapshot.rate === undefined ? [] : [`${Math.round(snapshot.rate)} tok/s now`]),
		];
		return truncateToWidth(parts.join(theme.fg("dim", "  ·  ")), width);
	}

	function tabBar(width: number): string {
		const rendered = TABS.map((name, index) => {
			const label = ` ${index + 1} ${name} `;
			return index === tab
				? theme.bg("selectedBg", theme.fg("accent", theme.bold(label)))
				: theme.fg("muted", label);
		});
		return truncateToWidth(rendered.join(theme.fg("dim", "│")), width);
	}

	function hint(lines: number, width: number): string {
		const position =
			lines > viewportHeight()
				? `${scroll[tab] + 1}-${Math.min(lines, scroll[tab] + viewportHeight())}/${lines}`
				: `${lines} rows`;
		const status = `${position} · updated ${clockTime(updatedAt)}`;
		const available = width - visibleWidth(status) - 3;

		const keys = [
			"Tab/←→ tabs",
			`1-${TABS.length} jump`,
			"↑↓ PgUp/PgDn scroll",
			...(tab === 0
				? [`${ZOOMS.map((option) => option.key).join("/")} zoom`, "c spend/speed"]
				: ["s/S sort", "b breakdown"]),
			"r rescan",
			"Esc close",
		];

		const shown: string[] = [];
		for (const key of keys) {
			if (visibleWidth([...shown, key].join(" · ")) > available) break;
			shown.push(key);
		}

		const text = shown.length > 0 ? `${shown.join(" · ")} · ${status}` : status;
		return truncateToWidth(theme.fg("dim", text), width);
	}

	return {
		handleInput(data: string): void {
			const lines = cache?.lines.length ?? 0;

			if (matchesKey(data, Key.escape) || data === "q") {
				close();
				return;
			}
			if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
				tab = (tab + 1) % TABS.length;
				refresh();
				return;
			}
			if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
				tab = (tab - 1 + TABS.length) % TABS.length;
				refresh();
				return;
			}
			if (data >= "1" && data <= `${TABS.length}`) {
				tab = Number(data) - 1;
				refresh();
				return;
			}

			const picked = ZOOMS.findIndex((option) => option.key === data);
			if (tab === 0 && picked >= 0) {
				zoom = picked;
				refresh();
				return;
			}
			if (tab === 0 && data === "c") {
				metric = metric === "cost" ? "rate" : "cost";
				refresh();
				return;
			}

			if (data === "s") {
				cycleSort(1);
				return;
			}
			if (data === "S") {
				flipSort();
				return;
			}
			if (data === "b") {
				breakdown = !breakdown;
				refresh();
				return;
			}
			if (data === "r") {
				reload();
				return;
			}
			if (matchesKey(data, Key.up)) scrollBy(-1, lines);
			else if (matchesKey(data, Key.down)) scrollBy(1, lines);
			else if (matchesKey(data, Key.pageUp)) scrollBy(-viewportHeight(), lines);
			else if (matchesKey(data, Key.pageDown)) scrollBy(viewportHeight(), lines);
			else if (matchesKey(data, Key.home)) scrollBy(-lines, lines);
			else if (matchesKey(data, Key.end)) scrollBy(lines, lines);
		},

		invalidate(): void {
			cache = undefined;
		},

		render(width: number): string[] {
			const lines = bodyLines(width);
			const height = viewportHeight();
			const limit = Math.max(0, lines.length - height);
			scroll[tab] = Math.min(scroll[tab], limit);
			const visible = lines.slice(scroll[tab], scroll[tab] + height);
			while (visible.length < height) visible.push("");
			return [title(width), tabBar(width), "", ...visible, "", hint(lines.length, width)].map((line) =>
				truncateToWidth(line, width),
			);
		},
	};
}
