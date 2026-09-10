import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { addResponse, emptyTotals, type Period, periodStart, previousPeriod, tokenRate } from "./aggregate.ts";
import type { Response } from "./records.ts";
import { formatCost } from "./table.ts";

export type Metric = "cost" | "rate";

export interface Zoom {
	buckets: number;
	key: string;
	period: Period;
	unit: string;
}

interface Bucket {
	start: number;
	value?: number;
}

const BAR_MAX_WIDTH = 6;
const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

export const ZOOMS: Zoom[] = [
	{ buckets: 60, key: "m", period: "minute", unit: "minute" },
	{ buckets: 24, key: "h", period: "hour", unit: "hour" },
	{ buckets: 30, key: "d", period: "day", unit: "day" },
	{ buckets: 12, key: "w", period: "week", unit: "week" },
];

function formatValue(metric: Metric, value: number): string {
	return metric === "cost" ? formatCost(value) : `${Math.round(value)}`;
}

function buckets(responses: Response[], zoom: Zoom, metric: Metric, now: number): Bucket[] {
	const starts = [periodStart(zoom.period, now)];
	while (starts.length < zoom.buckets) starts.unshift(previousPeriod(zoom.period, starts[0]));

	const oldest = starts[0];
	const grouped = new Map<number, ReturnType<typeof emptyTotals>>();
	for (const response of responses) {
		if (response.endedAt < oldest) continue;
		const start = periodStart(zoom.period, response.endedAt);
		const totals = grouped.get(start) ?? emptyTotals();
		addResponse(totals, response);
		grouped.set(start, totals);
	}

	return starts.map((start) => {
		const totals = grouped.get(start);
		if (!totals) return { start };
		if (metric === "rate") return { start, value: tokenRate(totals) };
		return { start, value: totals.cost > 0 ? totals.cost : undefined };
	});
}

function spanText(zoom: Zoom, count: number): string {
	if (zoom.period === "hour") return `last ${count} h`;
	if (zoom.period === "minute") return `last ${count} min`;
	return `last ${count} ${zoom.unit}s`;
}

function axisLabels(zoom: Zoom, count: number): string[] {
	const suffix = zoom.period === "week" ? "w" : zoom.period.slice(0, 1);
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

export function chartLines(
	responses: Response[],
	zoom: Zoom,
	metric: Metric,
	theme: Theme,
	width: number,
	height: number,
): string[] {
	const all = buckets(responses, zoom, metric, Date.now());
	const labelWidth = Math.max(
		...all.map((bucket) => (bucket.value === undefined ? 1 : formatValue(metric, bucket.value).length)),
	);
	const gutter = labelWidth + 3;
	const plotWidth = Math.max(1, width - gutter);
	const cell = Math.max(1, Math.min(BAR_MAX_WIDTH, Math.floor(plotWidth / zoom.buckets)));
	const bar = cell > 1 ? cell - 1 : 1;
	const count = Math.min(zoom.buckets, Math.floor(plotWidth / cell));
	const shown = all.slice(all.length - count);
	const values = shown.flatMap((bucket) => (bucket.value === undefined ? [] : [bucket.value]));
	const peak = values.length > 0 ? Math.max(...values) : undefined;
	const base = values.length > 0 ? Math.min(...values) : undefined;

	const level = (bucket: Bucket) => {
		if (bucket.value === undefined || peak === undefined || base === undefined) return 0;
		const ratio = peak > base ? (bucket.value - base) / (peak - base) : 0.5;
		return Math.max(1, Math.round(ratio * height * BLOCKS.length));
	};

	const row = (index: number) =>
		shown
			.map((bucket) => {
				const filled = Math.min(BLOCKS.length, level(bucket) - index * BLOCKS.length);
				const character = filled <= 0 ? " " : BLOCKS[filled - 1];
				return `${character.repeat(bar)}${" ".repeat(cell - bar)}`;
			})
			.join("")
			.trimEnd();

	const yLabel = (index: number) => {
		if (peak === undefined || base === undefined || peak === base) return "";
		if (index === height - 1) return formatValue(metric, peak);
		if (index === Math.floor((height - 1) / 2)) return formatValue(metric, (peak + base) / 2);
		return "";
	};

	const caption = ` ${metric === "cost" ? "spend" : "tok/s"} per ${zoom.unit} · ${spanText(zoom, count)}`;
	const note = peak === undefined ? "nothing in range" : `peak ${formatValue(metric, peak)}`;
	const pad = width - visibleWidth(caption) - visibleWidth(note);

	return [
		pad >= 2
			? theme.fg("muted", caption) + " ".repeat(pad) + theme.fg("dim", note)
			: theme.fg("muted", caption),
		...Array.from({ length: height }, (_line, offset) => {
			const index = height - 1 - offset;
			return theme.fg("dim", ` ${yLabel(index).padStart(labelWidth)} ┤`) + theme.fg("accent", row(index));
		}),
		theme.fg(
			"dim",
			` ${(base === undefined ? "-" : formatValue(metric, base)).padStart(labelWidth)} ┼${"─".repeat(count * cell)}`,
		),
		theme.fg("dim", axisRow(axisLabels(zoom, count), gutter, count * cell)),
	];
}
