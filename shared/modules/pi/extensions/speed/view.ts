import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Key, matchesKey, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	clockTime,
	type ColumnSpec,
	formatCount,
	formatDate,
	formatTokens,
	joinModels,
	modelName,
	renderTable,
	shortProject,
	type TableRow,
} from "../_shared/table.ts";
import {
	median,
	type ModelRate,
	type Overview,
	overview,
	type Period,
	type PeriodRate,
	periodRows,
	type ProjectRate,
	projectRows,
	type Rate,
	type SessionRate,
	sessionRows,
	modelRows,
	sumRates,
	thinkRate,
	tokenRate,
} from "./aggregate.ts";
import { chartLines, ZOOMS } from "./chart.ts";
import { DAY, type Sample } from "./samples.ts";

const CHART_HEIGHT = 6;
const CHROME_LINES = 5;
const HOUR_SPAN = 3 * DAY;
const REFRESH_INTERVAL_MS = 60_000;

interface SortDescriptor<T> {
	header: string;
	numeric: boolean;
	value: (row: T) => number | string;
}

interface SortOption<T> extends SortDescriptor<T> {
	column: number;
}

interface TableTab<T extends Rate & { breakdown: ModelRate[] }> {
	cells: (row: T) => string[];
	columns: ColumnSpec[];
	defaultSort: string;
	name: string;
	rows: (samples: Sample[]) => T[];
	sorts: SortOption<T>[];
	subCells: (model: ModelRate) => string[];
	total: (rows: T[]) => string[];
}

function formatDuration(ms: number): string {
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;

	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;

	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function formatRate(rate: number | undefined): string {
	return rate === undefined ? "-" : `${Math.round(rate)}`;
}

function formatWait(ms: number | undefined): string {
	if (ms === undefined) return "-";
	return ms >= 10_000 ? `${Math.round(ms / 1000)} s` : `${(ms / 1000).toFixed(1)} s`;
}

function rateCells(rate: Rate): string[] {
	return [
		formatCount(rate.responses),
		formatTokens(rate.tokens),
		formatDuration(rate.workMs),
		formatRate(tokenRate(rate)),
		formatRate(thinkRate(rate)),
		formatWait(median(rate.waits)),
	];
}

function rateColumns(offset: number): ColumnSpec[] {
	return [
		{ align: "right", header: "Responses", priority: offset + 4 },
		{ align: "right", header: "Tokens", priority: 1 },
		{ align: "right", header: "Work", priority: offset + 2 },
		{ align: "right", header: "Tok/s", priority: 0 },
		{ align: "right", header: "Think", priority: offset + 7 },
		{ align: "right", header: "Wait", priority: offset + 6 },
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

function rateSorts<T extends Rate>(): Array<SortDescriptor<T>> {
	return [
		numberSort<T>("Responses", (row) => row.responses),
		numberSort<T>("Tokens", (row) => row.tokens),
		numberSort<T>("Work", (row) => row.workMs),
		numberSort<T>("Tok/s", (row) => tokenRate(row) ?? 0),
		numberSort<T>("Think", (row) => thinkRate(row) ?? 0),
		numberSort<T>("Wait", (row) => median(row.waits) ?? 0),
	];
}

function periodTab(name: string, header: string, period: Period, span?: number): TableTab<PeriodRate> {
	const columns: ColumnSpec[] = [
		{ align: "left", header, priority: 0 },
		{ align: "left", header: "Models", maxWidth: 24, priority: 5 },
		...rateColumns(0),
	];

	return {
		cells: (row) => [row.label, joinModels(row.breakdown.map((model) => model.model)), ...rateCells(row)],
		columns,
		defaultSort: header,
		name,
		rows: (samples) =>
			periodRows(
				span === undefined ? samples : samples.filter((sample) => sample.at >= Date.now() - span),
				period,
			),
		sorts: sortOptions<PeriodRate>(columns, [
			textSort<PeriodRate>(header, (row) => row.label),
			...rateSorts<PeriodRate>(),
		]),
		subCells: (model) => [`  └─ ${modelName(model.model)}`, "", ...rateCells(model)],
		total: (rows) => ["Total", "", ...rateCells(sumRates(rows))],
	};
}

function modelTab(): TableTab<ModelRate & { breakdown: ModelRate[] }> {
	const columns: ColumnSpec[] = [
		{ align: "left", header: "Model", maxWidth: 34, priority: 0 },
		...rateColumns(0),
		{ align: "left", header: "Last", priority: 5 },
	];

	return {
		cells: (row) => [modelName(row.model), ...rateCells(row), formatDate(row.lastTs)],
		columns,
		defaultSort: "Tokens",
		name: "Models",
		rows: (samples) => modelRows(samples).map((row) => ({ ...row, breakdown: [] })),
		sorts: sortOptions(columns, [
			textSort<ModelRate>("Model", (row) => row.model),
			...rateSorts<ModelRate>(),
			numberSort<ModelRate>("Last", (row) => row.lastTs),
		]),
		subCells: () => [],
		total: (rows) => ["Total", ...rateCells(sumRates(rows)), ""],
	};
}

function sessionTab(): TableTab<SessionRate> {
	const columns: ColumnSpec[] = [
		{ align: "left", header: "Session", maxWidth: 38, priority: 0 },
		{ align: "left", header: "Project", maxWidth: 26, priority: 4 },
		{ align: "left", header: "Models", maxWidth: 20, priority: 8 },
		...rateColumns(2),
		{ align: "left", header: "Last", priority: 3 },
	];

	return {
		cells: (row) => [
			row.label,
			shortProject(row.project),
			joinModels(row.breakdown.map((model) => model.model)),
			...rateCells(row),
			clockTime(row.lastTs),
		],
		columns,
		defaultSort: "Last",
		name: "Sessions",
		rows: sessionRows,
		sorts: sortOptions<SessionRate>(columns, [
			textSort<SessionRate>("Session", (row) => row.label.toLowerCase()),
			textSort<SessionRate>("Project", (row) => row.project),
			...rateSorts<SessionRate>(),
			numberSort<SessionRate>("Last", (row) => row.lastTs),
		]),
		subCells: (model) => [`  └─ ${modelName(model.model)}`, "", "", ...rateCells(model), ""],
		total: (rows) => ["Total", "", "", ...rateCells(sumRates(rows)), ""],
	};
}

function projectTab(): TableTab<ProjectRate> {
	const columns: ColumnSpec[] = [
		{ align: "left", header: "Project", maxWidth: 40, priority: 0 },
		{ align: "right", header: "Sessions", priority: 4 },
		{ align: "left", header: "Models", maxWidth: 20, priority: 8 },
		...rateColumns(2),
		{ align: "left", header: "Last", priority: 3 },
	];

	return {
		cells: (row) => [
			shortProject(row.project),
			formatCount(row.sessions),
			joinModels(row.breakdown.map((model) => model.model)),
			...rateCells(row),
			formatDate(row.lastTs),
		],
		columns,
		defaultSort: "Tokens",
		name: "Projects",
		rows: projectRows,
		sorts: sortOptions<ProjectRate>(columns, [
			textSort<ProjectRate>("Project", (row) => row.project),
			numberSort<ProjectRate>("Sessions", (row) => row.sessions),
			...rateSorts<ProjectRate>(),
			numberSort<ProjectRate>("Last", (row) => row.lastTs),
		]),
		subCells: (model) => [`  └─ ${modelName(model.model)}`, "", "", ...rateCells(model), ""],
		total: (rows) => [
			"Total",
			formatCount(rows.reduce((sum, row) => sum + row.sessions, 0)),
			"",
			...rateCells(sumRates(rows)),
			"",
		],
	};
}

const TABLE_TABS = [
	periodTab("Hourly", "Hour", "hour", HOUR_SPAN),
	periodTab("Daily", "Date", "day"),
	periodTab("Weekly", "Week", "week"),
	modelTab(),
	sessionTab(),
	projectTab(),
] as unknown as Array<TableTab<Rate & { breakdown: ModelRate[] }>>;

const TABS = ["All", ...TABLE_TABS.map((table) => table.name)];

const OVERVIEW_MODEL_COLUMNS: ColumnSpec[] = [
	{ align: "left", header: "Model", maxWidth: 34, priority: 0 },
	{ align: "right", header: "Responses", priority: 3 },
	{ align: "right", header: "Tokens", priority: 1 },
	{ align: "right", header: "Tok/s", priority: 0 },
	{ align: "right", header: "Wait", priority: 4 },
	{ align: "right", header: "Share", priority: 2 },
];

const OVERVIEW_SESSION_COLUMNS: ColumnSpec[] = [
	{ align: "left", header: "Session", maxWidth: 44, priority: 0 },
	{ align: "left", header: "Project", maxWidth: 28, priority: 2 },
	{ align: "right", header: "Tokens", priority: 1 },
	{ align: "right", header: "Tok/s", priority: 0 },
	{ align: "left", header: "Last", priority: 3 },
];

export interface SpeedViewOptions {
	done: () => void;
	load: () => Sample[];
	rate: () => number | undefined;
	subscribe: (listener: (sample: Sample) => void) => () => void;
	theme: Theme;
	tui: TUI;
}

function compare(left: number | string, right: number | string): number {
	return typeof left === "number" && typeof right === "number"
		? left - right
		: String(left).localeCompare(String(right));
}

function shareCell(tokens: number, total: number): string {
	return total > 0 ? `${((tokens / total) * 100).toFixed(1)}%` : "";
}

function plural(count: number, noun: string): string {
	return `${formatCount(count)} ${noun}${count === 1 ? "" : "s"}`;
}

function rateSummary(rate: Rate): string {
	return `${formatRate(tokenRate(rate))} tok/s · ${plural(rate.responses, "response")} · ${formatTokens(rate.tokens)} tokens · ${formatDuration(rate.workMs)} of work`;
}

function summaryLines(report: Overview, live: number | undefined, theme: Theme): string[] {
	const { totals } = report;
	const thinking =
		totals.thinkingResponses > 0
			? `${formatCount(totals.thinkingResponses)} of ${plural(totals.responses, "response")} · ${formatRate(thinkRate(totals))} tok/s`
			: "none recorded";
	const entries: Array<[string, string]> = [
		["Now", live === undefined ? "idle" : `${Math.round(live)} tok/s over the last minute of work`],
		["Today", rateSummary(report.today)],
		["All time", rateSummary(totals)],
		["Median wait", `${formatWait(median(totals.waits))} to first token`],
		["Thinking", thinking],
		[
			"Peak minute",
			report.peak
				? `${formatRate(tokenRate(report.peak))} tok/s at ${clockTime(report.peak.start)} on ${formatDate(report.peak.start)}`
				: "-",
		],
		["Scope", `${plural(report.sessions, "session")} across ${plural(report.projects, "project")}`],
		["Range", `${formatDate(report.firstTs)} → ${formatDate(totals.lastTs)}`],
	];
	const label = Math.max(...entries.map(([name]) => name.length));

	return entries.map(([name, value]) => `${theme.fg("muted", name.padEnd(label))}  ${value}`);
}

function section(title: string, theme: Theme): string[] {
	return ["", theme.fg("accent", theme.bold(title)), ""];
}

function overviewBody(
	report: Overview,
	samples: Sample[],
	live: number | undefined,
	zoom: number,
	theme: Theme,
	width: number,
): string[] {
	const total = report.totals.tokens;

	const models: TableRow[] = report.byModel.map((model) => ({
		cells: [
			modelName(model.model),
			formatCount(model.responses),
			formatTokens(model.tokens),
			formatRate(tokenRate(model)),
			formatWait(median(model.waits)),
			shareCell(model.tokens, total),
		],
		kind: "data",
	}));

	const sessions: TableRow[] = report.recentSessions.map((session) => ({
		cells: [
			session.label,
			shortProject(session.project),
			formatTokens(session.tokens),
			formatRate(tokenRate(session)),
			clockTime(session.lastTs),
		],
		kind: "data",
	}));

	return [
		...summaryLines(report, live, theme),
		...section("Throughput", theme),
		...chartLines(samples, ZOOMS[zoom], theme, width, CHART_HEIGHT),
		...section("By model", theme),
		...renderTable(OVERVIEW_MODEL_COLUMNS, models, theme, width, undefined, "No responses recorded.").lines,
		...section("Recent sessions", theme),
		...renderTable(OVERVIEW_SESSION_COLUMNS, sessions, theme, width, undefined, "No responses recorded.")
			.lines,
	];
}

export function createSpeedView(options: SpeedViewOptions): Component {
	const { done, load, rate, subscribe, theme, tui } = options;

	let samples = load();
	let report = overview(samples);
	let updatedAt = Date.now();
	let tab = 0;
	let zoom = 0;
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
		samples = load();
		report = overview(samples);
		updatedAt = Date.now();
		refresh();
	}

	const unsubscribe = subscribe((sample) => {
		samples = [...samples, sample];
		report = overview(samples);
		updatedAt = Date.now();
		refresh();
	});

	const timer = setInterval(reload, REFRESH_INTERVAL_MS);
	timer.unref();

	function close(): void {
		clearInterval(timer);
		unsubscribe();
		done();
	}

	function tableBody(index: number, width: number): string[] {
		const table = TABLE_TABS[index];
		const state = sort[index];
		const option = table.sorts[state.index];
		const rows = table
			.rows(samples)
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
			"No responses recorded.",
		);
		visibleColumns[index] = rendered.kept;
		return rendered.lines;
	}

	function bodyLines(width: number): string[] {
		const state = tab > 0 ? sort[tab - 1] : undefined;
		const key = `${tab}:${zoom}:${breakdown}:${state?.index}:${state?.descending}:${width}:${updatedAt}`;
		if (cache?.key === key) return cache.lines;

		const lines =
			tab === 0
				? overviewBody(report, samples, rate(), zoom, theme, width)
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
		const live = rate();
		const parts = [
			theme.fg("accent", theme.bold("π speed")),
			live === undefined ? "idle" : `${Math.round(live)} tok/s now`,
			`${formatRate(tokenRate(report.today))} tok/s today`,
			plural(report.totals.responses, "response"),
			`${formatTokens(report.totals.tokens)} tokens`,
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
			...(tab === 0 ? [ZOOMS.map((option) => option.key).join("/") + " zoom"] : ["s/S sort", "b breakdown"]),
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
