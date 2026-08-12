import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Key, matchesKey, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	dailyRows,
	monthlyRows,
	type ModelTotals,
	overview,
	type Overview,
	type PeriodRow,
	type ProjectRow,
	projectRows,
	type SessionRow,
	sessionRows,
	sumTotals,
	type Totals,
	weeklyRows,
} from "./aggregate.ts";
import type { SessionUsage } from "./collect.ts";
import {
	type ColumnSpec,
	formatCost,
	formatCount,
	formatDate,
	formatTokens,
	joinModels,
	modelName,
	renderTable,
	shortModel,
	shortProject,
	type TableRow,
} from "./table.ts";

const CHROME_LINES = 5;

const REFRESH_INTERVAL_MS = 300_000;

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
	rows: (sessions: SessionUsage[]) => T[];
	sorts: SortOption<T>[];
	subCells: (model: ModelTotals) => string[];
	total: (rows: T[]) => string[];
}

function tokenCells(totals: Totals): string[] {
	return [
		formatTokens(totals.input),
		formatTokens(totals.output),
		formatTokens(totals.cacheWrite),
		formatTokens(totals.cacheRead),
		formatTokens(totals.tokens),
		formatCost(totals.cost),
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

function tokenSorts<T extends Totals>(): Array<SortDescriptor<T>> {
	return [
		numberSort<T>("Input", (row) => row.input),
		numberSort<T>("Output", (row) => row.output),
		numberSort<T>("Cache W", (row) => row.cacheWrite),
		numberSort<T>("Cache R", (row) => row.cacheRead),
		numberSort<T>("Tokens", (row) => row.tokens),
		numberSort<T>("Cost", (row) => row.cost),
	];
}

function periodTab(name: string, header: string, rows: (sessions: SessionUsage[]) => PeriodRow[]): TableTab<PeriodRow> {
	const columns: ColumnSpec[] = [
		{ align: "left", header, priority: 0 },
		{ align: "left", header: "Models", maxWidth: 30, priority: 2 },
		{ align: "right", header: "Input", priority: 4 },
		{ align: "right", header: "Output", priority: 3 },
		{ align: "right", header: "Cache W", priority: 6 },
		{ align: "right", header: "Cache R", priority: 5 },
		{ align: "right", header: "Tokens", priority: 1 },
		{ align: "right", header: "Cost", priority: 0 },
	];

	return {
		cells: (row) => [row.period, joinModels(row.breakdown.map((model) => model.model)), ...tokenCells(row)],
		columns,
		defaultSort: header,
		name,
		rows,
		sorts: sortOptions<PeriodRow>(columns, [
			textSort<PeriodRow>(header, (row) => row.period),
			...tokenSorts<PeriodRow>(),
		]),
		subCells: (model) => [`  └─ ${modelName(model.model)}`, "", ...tokenCells(model)],
		total: (rows) => ["Total", "", ...tokenCells(sumTotals(rows))],
	};
}

function sessionTab(): TableTab<SessionRow> {
	const columns: ColumnSpec[] = [
		{ align: "left", header: "Session", maxWidth: 38, priority: 0 },
		{ align: "left", header: "Project", maxWidth: 28, priority: 4 },
		{ align: "left", header: "Models", maxWidth: 22, priority: 6 },
		{ align: "right", header: "Input", priority: 8 },
		{ align: "right", header: "Output", priority: 7 },
		{ align: "right", header: "Cache W", priority: 10 },
		{ align: "right", header: "Cache R", priority: 9 },
		{ align: "right", header: "Tokens", priority: 1 },
		{ align: "right", header: "Cost", priority: 0 },
		{ align: "left", header: "Last", priority: 5 },
	];

	return {
		cells: (row) => [
			row.label,
			shortProject(row.project),
			joinModels(row.breakdown.map((model) => model.model)),
			...tokenCells(row),
			formatDate(row.lastTs),
		],
		columns,
		defaultSort: "Cost",
		name: "Session",
		rows: sessionRows,
		sorts: sortOptions<SessionRow>(columns, [
			textSort<SessionRow>("Session", (row) => row.label.toLowerCase()),
			textSort<SessionRow>("Project", (row) => row.project),
			...tokenSorts<SessionRow>(),
			numberSort<SessionRow>("Last", (row) => row.lastTs),
		]),
		subCells: (model) => [`  └─ ${modelName(model.model)}`, "", "", ...tokenCells(model), ""],
		total: (rows) => ["Total", "", "", ...tokenCells(sumTotals(rows)), ""],
	};
}

function projectTab(): TableTab<ProjectRow> {
	const columns: ColumnSpec[] = [
		{ align: "left", header: "Project", maxWidth: 40, priority: 0 },
		{ align: "right", header: "Sessions", priority: 3 },
		{ align: "left", header: "Models", maxWidth: 26, priority: 6 },
		{ align: "right", header: "Input", priority: 8 },
		{ align: "right", header: "Output", priority: 7 },
		{ align: "right", header: "Cache W", priority: 10 },
		{ align: "right", header: "Cache R", priority: 9 },
		{ align: "right", header: "Tokens", priority: 1 },
		{ align: "right", header: "Cost", priority: 0 },
		{ align: "left", header: "Last", priority: 4 },
	];

	return {
		cells: (row) => [
			shortProject(row.project),
			formatCount(row.sessions),
			joinModels(row.breakdown.map((model) => model.model)),
			...tokenCells(row),
			formatDate(row.lastTs),
		],
		columns,
		defaultSort: "Cost",
		name: "Projects",
		rows: projectRows,
		sorts: sortOptions<ProjectRow>(columns, [
			textSort<ProjectRow>("Project", (row) => row.project),
			numberSort<ProjectRow>("Sessions", (row) => row.sessions),
			...tokenSorts<ProjectRow>(),
			numberSort<ProjectRow>("Last", (row) => row.lastTs),
		]),
		subCells: (model) => [`  └─ ${modelName(model.model)}`, "", "", ...tokenCells(model), ""],
		total: (rows) => [
			"Total",
			formatCount(rows.reduce((sum, row) => sum + row.sessions, 0)),
			"",
			...tokenCells(sumTotals(rows)),
			"",
		],
	};
}

const TABLE_TABS = [
	periodTab("Daily", "Date", dailyRows),
	periodTab("Weekly", "Week", weeklyRows),
	periodTab("Monthly", "Month", monthlyRows),
	sessionTab(),
	projectTab(),
] as unknown as Array<TableTab<Totals & { breakdown: ModelTotals[] }>>;

const TABS = ["All", ...TABLE_TABS.map((table) => table.name)];

const MODEL_COLUMNS: ColumnSpec[] = [
	{ align: "left", header: "Model", maxWidth: 34, priority: 0 },
	{ align: "right", header: "Messages", priority: 3 },
	{ align: "right", header: "Tokens", priority: 1 },
	{ align: "right", header: "Cost", priority: 0 },
	{ align: "right", header: "Share", priority: 2 },
];

const TOP_PROJECT_COLUMNS: ColumnSpec[] = [
	{ align: "left", header: "Project", maxWidth: 44, priority: 0 },
	{ align: "right", header: "Sessions", priority: 3 },
	{ align: "right", header: "Tokens", priority: 1 },
	{ align: "right", header: "Cost", priority: 0 },
	{ align: "right", header: "Share", priority: 2 },
];

const TOP_SESSION_COLUMNS: ColumnSpec[] = [
	{ align: "left", header: "Session", maxWidth: 44, priority: 0 },
	{ align: "left", header: "Project", maxWidth: 30, priority: 2 },
	{ align: "right", header: "Tokens", priority: 1 },
	{ align: "right", header: "Cost", priority: 0 },
	{ align: "left", header: "Last", priority: 3 },
];

export interface UsageViewOptions {
	done: () => void;
	load: () => SessionUsage[];
	theme: Theme;
	tui: TUI;
}

function clockTime(timestamp: number): string {
	const date = new Date(timestamp);
	const hours = `${date.getHours()}`.padStart(2, "0");
	const minutes = `${date.getMinutes()}`.padStart(2, "0");
	return `${hours}:${minutes}`;
}

function compare(left: number | string, right: number | string): number {
	return typeof left === "number" && typeof right === "number"
		? left - right
		: String(left).localeCompare(String(right));
}

function summaryLines(report: Overview, theme: Theme): string[] {
	const { totals } = report;
	const perDay = report.activeDays > 0 ? totals.cost / report.activeDays : 0;
	const perSession = report.sessionCount > 0 ? totals.cost / report.sessionCount : 0;
	const perMessage = totals.messages > 0 ? totals.cost / totals.messages : 0;
	const entries: Array<[string, string]> = [
		["Total spend", formatCost(totals.cost)],
		["Tokens", formatTokens(totals.tokens)],
		[
			"Split",
			`in ${formatTokens(totals.input)} · out ${formatTokens(totals.output)} · cache write ${formatTokens(totals.cacheWrite)} · cache read ${formatTokens(totals.cacheRead)}`,
		],
		["Sessions", `${formatCount(report.sessionCount)} · ${formatCount(totals.messages)} messages`],
		["Active days", `${formatCount(report.activeDays)} of ${formatCount(report.calendarDays)} calendar days`],
		["Range", `${formatDate(report.firstTs)} → ${formatDate(report.lastTs)}`],
		["Per active day", formatCost(perDay)],
		["Per session", formatCost(perSession)],
		["Per message", `$${perMessage.toFixed(4)}`],
	];
	const label = Math.max(...entries.map(([name]) => name.length));
	return entries.map(([name, value]) => `${theme.fg("muted", name.padEnd(label))}  ${value}`);
}

function section(title: string, theme: Theme): string[] {
	return ["", theme.fg("accent", theme.bold(title)), ""];
}

function shareCell(cost: number, total: number): string {
	return total > 0 ? `${((cost / total) * 100).toFixed(1)}%` : "";
}

function allBody(report: Overview, theme: Theme, width: number): string[] {
	const total = report.totals.cost;

	const models: TableRow[] = report.byModel.map((model) => ({
		cells: [
			shortModel(model.model),
			formatCount(model.messages),
			formatTokens(model.tokens),
			formatCost(model.cost),
			shareCell(model.cost, total),
		],
		kind: "data",
	}));

	const projects: TableRow[] = report.byProject.slice(0, 10).map((project) => ({
		cells: [
			shortProject(project.project),
			formatCount(project.sessions),
			formatTokens(project.tokens),
			formatCost(project.cost),
			shareCell(project.cost, total),
		],
		kind: "data",
	}));

	const top: TableRow[] = report.topSessions.map((session) => ({
		cells: [
			session.label,
			shortProject(session.project),
			formatTokens(session.tokens),
			formatCost(session.cost),
			formatDate(session.lastTs),
		],
		kind: "data",
	}));

	return [
		...summaryLines(report, theme),
		...section("By model", theme),
		...renderTable(MODEL_COLUMNS, models, theme, width).lines,
		...section("By project", theme),
		...renderTable(TOP_PROJECT_COLUMNS, projects, theme, width).lines,
		...section("Most expensive sessions", theme),
		...renderTable(TOP_SESSION_COLUMNS, top, theme, width).lines,
	];
}

export function createUsageView(options: UsageViewOptions): Component {
	const { done, load, theme, tui } = options;

	let sessions = load();
	let report = overview(sessions);
	let updatedAt = Date.now();
	let tab = 0;
	let breakdown = false;
	let cache: { key: string; lines: string[] } | undefined;

	const scroll = TABS.map(() => 0);
	const visibleColumns = TABLE_TABS.map(() => [] as number[]);
	const sort = TABLE_TABS.map((table) => ({
		descending: true,
		index: table.sorts.findIndex((option) => option.header === table.defaultSort),
	}));

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

		const rendered = renderTable(table.columns, lines, theme, width, {
			ascending: !state.descending,
			column: option.column,
		});
		visibleColumns[index] = rendered.kept;
		return rendered.lines;
	}

	function bodyLines(width: number): string[] {
		const state = tab > 0 ? sort[tab - 1] : undefined;
		const key = `${tab}:${breakdown}:${state?.index}:${state?.descending}:${width}`;
		if (cache?.key === key) return cache.lines;
		const lines = tab === 0 ? allBody(report, theme, width) : tableBody(tab - 1, width);
		cache = { key, lines };
		return lines;
	}

	function viewportHeight(): number {
		return Math.max(5, Math.floor(tui.terminal.rows / 2) - CHROME_LINES);
	}

	function refresh(): void {
		cache = undefined;
		tui.requestRender();
	}

	function reload(): void {
		sessions = load();
		report = overview(sessions);
		updatedAt = Date.now();
		refresh();
	}

	const timer = setInterval(reload, REFRESH_INTERVAL_MS);
	timer.unref();

	function close(): void {
		clearInterval(timer);
		done();
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
			theme.fg("accent", theme.bold("π usage")),
			formatCost(report.totals.cost),
			`${formatCount(report.sessionCount)} sessions`,
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
			...(tab === 0 ? [] : ["s/S sort", "b breakdown"]),
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
