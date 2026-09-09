import { appendFileSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const BAR_MAX_WIDTH = 6;
const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
const CALIBRATION_DAYS = 3;
const CHART_HEIGHT = 6;
const CHART_HEIGHT_COMPACT = 4;
const CHROME_LINES = 10;
const COLUMN_GAP = 3;
const DAY = 24 * 60 * 60 * 1000;
const FALLBACK_CHARS_PER_TOKEN = 4;
const FILE_SUFFIX = ".jsonl";
const RETENTION_DAYS = 90;
const STATUS_KEY = "speed";
const STORAGE_DIR = "speed";
const TICK_INTERVAL = 1_000;
const WINDOW = 3_000;

type Kind = "thinking" | "visible";

type ZoomId = "day" | "hour" | "minute" | "week";

interface Bucket {
	rate?: number;
	start: number;
}

interface Column {
	header: string;
	priority: number;
}

interface Delta {
	at: number;
	chars: number;
}

interface Flight {
	deltas: Delta[];
	firstDeltaAt?: number;
	firstVisibleAt?: number;
	generationAt?: number;
	lastDeltaAt?: number;
	model?: string;
	requestAt: number;
	thinkingChars: number;
	thinkingEndAt?: number;
	thinkingStartedAt?: number;
	visibleChars: number;
}

interface PanelRow {
	cells: string[];
	sub: boolean;
}

interface Sample {
	at: number;
	firstTokenMs: number;
	model: string;
	outputTokens: number;
	reasoningTokens: number | null;
	thinkingChars: number;
	thinkingMs: number;
	totalMs: number;
	visibleChars: number;
}

interface Summary {
	responses: number;
	thinkingRate?: number;
	tokenRate?: number;
	tokens: number;
	waitMs?: number;
}

interface Window {
	label: string;
	span: number;
}

interface Zoom {
	buckets: number;
	id: ZoomId;
	key: string;
	unit: string;
}

const COLUMNS: Column[] = [
	{ header: "", priority: 0 },
	{ header: "tok/s", priority: 0 },
	{ header: "thinking", priority: 4 },
	{ header: "first token", priority: 2 },
	{ header: "responses", priority: 3 },
	{ header: "tokens", priority: 1 },
];

const WINDOWS: Window[] = [
	{ label: "Last 10 min", span: 10 * 60_000 },
	{ label: "Last hour", span: 60 * 60_000 },
	{ label: "Last 24 h", span: DAY },
	{ label: "Last 7 days", span: 7 * DAY },
];

const ZOOMS: Zoom[] = [
	{ buckets: 60, id: "minute", key: "m", unit: "minute" },
	{ buckets: 24, id: "hour", key: "h", unit: "hour" },
	{ buckets: 30, id: "day", key: "d", unit: "day" },
	{ buckets: 12, id: "week", key: "w", unit: "week" },
];

function localDate(ms: number): string {
	const date = new Date(ms);
	const month = `${date.getMonth() + 1}`.padStart(2, "0");
	const day = `${date.getDate()}`.padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

const storageDir = () => join(getAgentDir(), STORAGE_DIR);

function dayFiles(): string[] {
	try {
		return readdirSync(storageDir()).filter((file) => file.endsWith(FILE_SUFFIX));
	} catch {
		return [];
	}
}

function readSamples(cutoff: number): Sample[] {
	const oldest = localDate(cutoff);
	const samples: Sample[] = [];

	for (const file of dayFiles()) {
		if (file.slice(0, -FILE_SUFFIX.length) < oldest) continue;

		let text: string;
		try {
			text = readFileSync(join(storageDir(), file), "utf8");
		} catch {
			continue;
		}

		for (const line of text.split("\n")) {
			if (!line) continue;
			try {
				const sample = JSON.parse(line) as Sample;
				if (typeof sample.at === "number" && typeof sample.outputTokens === "number" && sample.at >= cutoff) {
					samples.push(sample);
				}
			} catch {}
		}
	}

	return samples;
}

function writeSample(sample: Sample): void {
	try {
		mkdirSync(storageDir(), { recursive: true });
		appendFileSync(join(storageDir(), `${localDate(sample.at)}${FILE_SUFFIX}`), `${JSON.stringify(sample)}\n`);
	} catch {}
}

function pruneSamples(): void {
	const oldest = localDate(Date.now() - RETENTION_DAYS * DAY);

	for (const file of dayFiles()) {
		if (file.slice(0, -FILE_SUFFIX.length) >= oldest) continue;
		try {
			unlinkSync(join(storageDir(), file));
		} catch {}
	}
}

function measured(sample: Sample, kind: Kind): { chars: number; tokens: number } {
	const reasoning = sample.reasoningTokens ?? 0;
	return kind === "thinking"
		? { chars: sample.thinkingChars, tokens: reasoning }
		: { chars: sample.visibleChars, tokens: sample.outputTokens - reasoning };
}

function charsPerToken(samples: Sample[], kind: Kind): number | undefined {
	let chars = 0;
	let tokens = 0;

	for (const sample of samples) {
		const sampled = measured(sample, kind);
		if (sampled.chars <= 0 || sampled.tokens <= 0) continue;
		chars += sampled.chars;
		tokens += sampled.tokens;
	}

	return chars > 0 && tokens > 0 ? chars / tokens : undefined;
}

function calibrate(samples: Sample[], model: string | undefined, kind: Kind): number {
	const forModel = model
		? charsPerToken(
				samples.filter((sample) => sample.model === model),
				kind,
			)
		: undefined;

	return forModel ?? charsPerToken(samples, kind) ?? FALLBACK_CHARS_PER_TOKEN;
}

function tokensPerSecond(tokens: number, ms: number): number {
	return ms > 0 ? (tokens * 1000) / ms : 0;
}

function elapsed(ms: number): string {
	return `${Math.floor(ms / 1000)}s`;
}

function dropStale(flight: Flight, now: number): void {
	while (flight.deltas.length > 0 && now - flight.deltas[0].at > WINDOW) flight.deltas.shift();
}

function liveStatus(flight: Flight, samples: Sample[], theme: Theme, now: number): string {
	const estimate = (tokens: number, ms: number) =>
		theme.fg("text", `~${Math.round(tokensPerSecond(tokens, Math.max(TICK_INTERVAL, ms)))} tok/s`);

	const thinkingStartedAt = flight.thinkingStartedAt;
	if (thinkingStartedAt !== undefined) {
		return flight.thinkingChars === 0
			? theme.fg("dim", `thinking ${elapsed(now - thinkingStartedAt)}`)
			: estimate(
					flight.thinkingChars / calibrate(samples, flight.model, "thinking"),
					now - (flight.generationAt ?? flight.requestAt),
				);
	}

	if (flight.firstDeltaAt === undefined) {
		return theme.fg("dim", `waiting ${elapsed(now - flight.requestAt)}`);
	}

	const chars = flight.deltas.reduce((sum, delta) => sum + delta.chars, 0);
	if (chars === 0) {
		return theme.fg("dim", `waiting ${elapsed(now - (flight.lastDeltaAt ?? flight.requestAt))}`);
	}

	return estimate(
		chars / calibrate(samples, flight.model, "visible"),
		Math.min(WINDOW, now - (flight.firstVisibleAt ?? now)),
	);
}

function settledStatus(sample: Sample, theme: Theme): string {
	return theme.fg("dim", `${Math.round(tokensPerSecond(sample.outputTokens, sample.totalMs))} tok/s`);
}

function median(values: number[]): number | undefined {
	if (values.length === 0) return undefined;

	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);

	return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function summarize(samples: Sample[]): Summary {
	const waits: number[] = [];
	let thinkingMs = 0;
	let thinkingTokens = 0;
	let tokens = 0;
	let totalMs = 0;

	for (const sample of samples) {
		const reasoning = sample.reasoningTokens ?? 0;
		tokens += sample.outputTokens;
		totalMs += sample.totalMs;
		waits.push(sample.firstTokenMs);
		if (sample.thinkingMs > 0 && reasoning > 0) {
			thinkingMs += sample.thinkingMs;
			thinkingTokens += reasoning;
		}
	}

	return {
		responses: samples.length,
		thinkingRate: thinkingMs > 0 ? tokensPerSecond(thinkingTokens, thinkingMs) : undefined,
		tokenRate: totalMs > 0 ? tokensPerSecond(tokens, totalMs) : undefined,
		tokens,
		waitMs: median(waits),
	};
}

function groupByModel(samples: Sample[]): Map<string, Sample[]> {
	const groups = new Map<string, Sample[]>();

	for (const sample of samples) {
		const group = groups.get(sample.model);
		if (group) group.push(sample);
		else groups.set(sample.model, [sample]);
	}

	return groups;
}

function modelName(model: string): string {
	return model.slice(model.indexOf("/") + 1);
}

function formatCount(value: number): string {
	return value.toLocaleString("en-US");
}

function formatRate(rate: number | undefined): string {
	return rate === undefined ? "-" : `${Math.round(rate)}`;
}

function formatTokens(value: number): string {
	if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
	return `${value}`;
}

function formatWait(ms: number | undefined): string {
	if (ms === undefined) return "-";
	return ms >= 10_000 ? `${Math.round(ms / 1000)} s` : `${(ms / 1000).toFixed(1)} s`;
}

function summaryCells(label: string, summary: Summary): string[] {
	return [
		label,
		formatRate(summary.tokenRate),
		formatRate(summary.thinkingRate),
		formatWait(summary.waitMs),
		formatCount(summary.responses),
		summary.responses > 0 ? formatTokens(summary.tokens) : "-",
	];
}

function windowRows(samples: Sample[], now: number): PanelRow[] {
	const rows: PanelRow[] = [];

	for (const window of WINDOWS) {
		const within = samples.filter((sample) => sample.at >= now - window.span);
		rows.push({ cells: summaryCells(window.label, summarize(within)), sub: false });

		const models = groupByModel(within);
		if (models.size < 2) continue;

		const summaries = Array.from(models, ([model, group]) => ({ model, summary: summarize(group) })).sort(
			(left, right) => right.summary.tokens - left.summary.tokens,
		);
		for (const entry of summaries) {
			rows.push({ cells: summaryCells(`  ${modelName(entry.model)}`, entry.summary), sub: true });
		}
	}

	return rows;
}

function columnWidths(rows: PanelRow[], kept: number[]): number[] {
	return kept.map((column) =>
		Math.max(visibleWidth(COLUMNS[column].header), ...rows.map((row) => visibleWidth(row.cells[column]))),
	);
}

function fitColumns(rows: PanelRow[], width: number): number[] {
	let kept = COLUMNS.map((_column, index) => index);

	for (;;) {
		const used =
			columnWidths(rows, kept).reduce((sum, value) => sum + value, 0) + COLUMN_GAP * (kept.length - 1) + 1;
		const victim = kept.reduce(
			(worst, column) => (COLUMNS[column].priority > COLUMNS[worst].priority ? column : worst),
			kept[0],
		);
		if (used <= width || COLUMNS[victim].priority === 0) return kept;
		kept = kept.filter((column) => column !== victim);
	}
}

function renderRows(rows: PanelRow[], theme: Theme, width: number): string[] {
	const kept = fitColumns(rows, width);
	const widths = columnWidths(rows, kept);
	const line = (cells: string[]) =>
		` ${kept
			.map((column, index) =>
				column === 0 ? cells[column].padEnd(widths[index]) : cells[column].padStart(widths[index]),
			)
			.join(" ".repeat(COLUMN_GAP))}`.trimEnd();

	return [
		theme.fg("dim", line(COLUMNS.map((column) => column.header))),
		...rows.map((row) => (row.sub ? theme.fg("dim", line(row.cells)) : line(row.cells))),
	];
}

function bucketStart(zoom: ZoomId, ms: number): number {
	const date = new Date(ms);

	if (zoom === "minute") {
		return new Date(
			date.getFullYear(),
			date.getMonth(),
			date.getDate(),
			date.getHours(),
			date.getMinutes(),
		).getTime();
	}
	if (zoom === "hour") {
		return new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours()).getTime();
	}

	const midnight = new Date(date.getFullYear(), date.getMonth(), date.getDate());
	if (zoom === "week") midnight.setDate(midnight.getDate() - ((midnight.getDay() + 6) % 7));

	return midnight.getTime();
}

function previousBucket(zoom: ZoomId, start: number): number {
	const date = new Date(start);

	if (zoom === "minute") date.setMinutes(date.getMinutes() - 1);
	else if (zoom === "hour") date.setHours(date.getHours() - 1);
	else if (zoom === "day") date.setDate(date.getDate() - 1);
	else date.setDate(date.getDate() - 7);

	return date.getTime();
}

function chartBuckets(samples: Sample[], zoom: Zoom, now: number): Bucket[] {
	const starts = [bucketStart(zoom.id, now)];
	while (starts.length < zoom.buckets) starts.unshift(previousBucket(zoom.id, starts[0]));

	const grouped = new Map<number, Sample[]>();
	for (const sample of samples) {
		const start = bucketStart(zoom.id, sample.at);
		const group = grouped.get(start);
		if (group) group.push(sample);
		else grouped.set(start, [sample]);
	}

	return starts.map((start) => ({ rate: summarize(grouped.get(start) ?? []).tokenRate, start }));
}

function spanText(zoom: Zoom, count: number): string {
	if (zoom.id === "hour") return `last ${count} h`;
	if (zoom.id === "minute") return `last ${count} min`;
	return `last ${count} ${zoom.unit}s`;
}

function axisLabels(zoom: Zoom, count: number): string[] {
	const suffix = zoom.id === "week" ? "w" : zoom.id.slice(0, 1);
	return [`-${count}${suffix}`, `-${Math.round(count / 2)}${suffix}`, "now"];
}

function axisRow(labels: string[], gutter: number, plotWidth: number): string {
	const columns = Array.from({ length: plotWidth }, () => " ");
	const place = (text: string, at: number) => {
		const start = Math.max(0, Math.min(plotWidth - text.length, at));
		for (const [offset, character] of [...text].entries()) columns[start + offset] = character;
	};
	const total = labels.reduce((sum, label) => sum + label.length, 0);

	place(labels[2], plotWidth - labels[2].length);
	if (plotWidth >= total) place(labels[0], 0);
	if (plotWidth >= total + 4) place(labels[1], Math.floor((plotWidth - labels[1].length) / 2));

	return `${" ".repeat(gutter)}${columns.join("")}`;
}

function chartLines(samples: Sample[], zoom: Zoom, theme: Theme, width: number, height: number): string[] {
	const all = chartBuckets(samples, zoom, Date.now());
	const labelWidth = `${Math.round(Math.max(...all.map((bucket) => bucket.rate ?? 0)))}`.length;
	const gutter = labelWidth + 3;
	const plotWidth = Math.max(1, width - gutter);
	const cell = Math.max(1, Math.min(BAR_MAX_WIDTH, Math.floor(plotWidth / zoom.buckets)));
	const bar = cell > 1 ? cell - 1 : 1;
	const count = Math.min(zoom.buckets, Math.floor(plotWidth / cell));
	const buckets = all.slice(all.length - count);
	const rates = buckets.flatMap((bucket) => (bucket.rate === undefined ? [] : [bucket.rate]));
	const peak = rates.length > 0 ? Math.max(...rates) : undefined;
	const base = rates.length > 0 ? Math.min(...rates) : undefined;

	const level = (bucket: Bucket) => {
		if (bucket.rate === undefined || peak === undefined || base === undefined) return 0;
		const ratio = peak > base ? (bucket.rate - base) / (peak - base) : 0.5;
		return Math.max(1, Math.round(ratio * height * BLOCKS.length));
	};

	const row = (index: number) =>
		buckets
			.map((bucket) => {
				const filled = Math.min(BLOCKS.length, level(bucket) - index * BLOCKS.length);
				const character = filled <= 0 ? " " : BLOCKS[filled - 1];
				return `${character.repeat(bar)}${" ".repeat(cell - bar)}`;
			})
			.join("")
			.trimEnd();

	const yLabel = (index: number) => {
		if (peak === undefined || base === undefined || peak === base) return "";
		if (index === height - 1) return `${Math.round(peak)}`;
		if (index === Math.floor((height - 1) / 2)) return `${Math.round((peak + base) / 2)}`;
		return "";
	};

	const title = ` tok/s per ${zoom.unit} · ${spanText(zoom, count)}`;
	const note = peak === undefined ? "no responses in range" : `peak ${Math.round(peak)}`;
	const pad = width - visibleWidth(title) - visibleWidth(note);

	return [
		pad >= 2 ? theme.fg("muted", title) + " ".repeat(pad) + theme.fg("dim", note) : theme.fg("muted", title),
		...Array.from({ length: height }, (_line, offset) => {
			const index = height - 1 - offset;
			return theme.fg("dim", ` ${yLabel(index).padStart(labelWidth)} ┤`) + theme.fg("accent", row(index));
		}),
		theme.fg("dim", ` ${(base === undefined ? "-" : `${Math.round(base)}`).padStart(labelWidth)} ┼${"─".repeat(count * cell)}`),
		theme.fg("dim", axisRow(axisLabels(zoom, count), gutter, count * cell)),
	];
}

function chartHeight(terminalRows: number, tableLines: number): number {
	const room = terminalRows - tableLines - CHROME_LINES;
	return room >= CHART_HEIGHT ? CHART_HEIGHT : Math.max(1, Math.min(CHART_HEIGHT_COMPACT, room));
}

function hintLine(active: Zoom, theme: Theme): string {
	const keys = ZOOMS.map((zoom) =>
		theme.fg(zoom.id === active.id ? "accent" : "dim", `${zoom.key} ${zoom.unit}`),
	);
	return ` ${[...keys, theme.fg("dim", "Esc to close")].join(theme.fg("dim", " · "))}`;
}

function panelLines(samples: Sample[], zoom: Zoom, theme: Theme, width: number, terminalRows: number): string[] {
	const table = renderRows(windowRows(samples, Date.now()), theme, width);

	return [
		theme.fg("accent", "─".repeat(width)),
		theme.fg("accent", theme.bold(" Speed")),
		"",
		...table,
		"",
		...chartLines(samples, zoom, theme, width, chartHeight(terminalRows, table.length)),
		"",
		hintLine(zoom, theme),
		theme.fg("accent", "─".repeat(width)),
	].map((line) => truncateToWidth(line, width));
}

export default function speed(pi: ExtensionAPI) {
	const listeners = new Set<() => void>();
	let clock: ReturnType<typeof setInterval> | undefined;
	let flight: Flight | undefined;
	let history: Sample[] = [];
	let settled: Sample | undefined;
	let status: string | undefined;
	let zoom = ZOOMS[0];

	function show(ctx: ExtensionContext): void {
		const now = Date.now();
		if (flight) dropStale(flight, now);
		if (!ctx.hasUI) return;

		const text = flight
			? liveStatus(flight, history, ctx.ui.theme, now)
			: settled
				? settledStatus(settled, ctx.ui.theme)
				: undefined;

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
		flight = undefined;
		settled = undefined;
		status = undefined;
		pruneSamples();
		history = readSamples(Date.now() - CALIBRATION_DAYS * DAY);
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.on("turn_start", (event, ctx) => {
		flight = {
			deltas: [],
			requestAt: event.timestamp,
			thinkingChars: 0,
			visibleChars: 0,
		};
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
			flight.thinkingChars += update.delta.length;
			return;
		}

		flight.deltas.push({ at: now, chars: update.delta.length });
		flight.firstVisibleAt ??= now;
		flight.visibleChars += update.delta.length;
	});

	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant" || !flight) return;

		stopClock();

		const at = Date.now();
		const thinkingDoneAt = flight.thinkingStartedAt === undefined ? flight.thinkingEndAt : at;
		const sample: Sample = {
			at,
			firstTokenMs: (flight.firstDeltaAt ?? at) - flight.requestAt,
			model: `${message.provider}/${message.model}`,
			outputTokens: message.usage.output,
			reasoningTokens: message.usage.reasoning ?? null,
			thinkingChars: flight.thinkingChars,
			thinkingMs:
				thinkingDoneAt === undefined ? 0 : thinkingDoneAt - (flight.generationAt ?? flight.requestAt),
			totalMs: at - flight.requestAt,
			visibleChars: flight.visibleChars,
		};
		flight = undefined;

		if (sample.outputTokens > 0 && message.stopReason !== "aborted" && message.stopReason !== "error") {
			settled = sample;
			history.push(sample);
			writeSample(sample);
			for (const listener of listeners) listener();
		}

		show(ctx);
	});

	pi.on("agent_end", (_event, ctx) => {
		stopClock();
		flight = undefined;
		show(ctx);
	});

	pi.on("session_shutdown", stopClock);

	pi.registerCommand("speed", {
		description: "Show token throughput now and over the last minutes, hours and days",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/speed needs an interactive terminal", "warning");
				return;
			}

			history = readSamples(Date.now() - RETENTION_DAYS * DAY);

			await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
				let cachedLines: string[] | undefined;

				const invalidate = () => {
					cachedLines = undefined;
				};
				const listener = () => {
					invalidate();
					tui.requestRender();
				};
				listeners.add(listener);

				return {
					invalidate,

					handleInput: (input: string) => {
						const picked = ZOOMS.find((option) => option.key === input);
						if (picked) {
							zoom = picked;
							listener();
							return;
						}
						if (matchesKey(input, "escape") || matchesKey(input, "enter")) {
							listeners.delete(listener);
							done(undefined);
						}
					},

					render: (width: number) => {
						cachedLines ??= panelLines(history, zoom, theme, width, tui.terminal.rows);
						return cachedLines;
					},
				};
			});
		},
	});
}
