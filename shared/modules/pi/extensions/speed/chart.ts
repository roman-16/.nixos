import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { type Period, periodStart, previousPeriod, rateOf, tokenRate } from "./aggregate.ts";
import type { Sample } from "./samples.ts";

const BAR_MAX_WIDTH = 6;
const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

export interface Zoom {
	buckets: number;
	key: string;
	period: Period;
	unit: string;
}

interface Bucket {
	rate?: number;
	start: number;
}

export const ZOOMS: Zoom[] = [
	{ buckets: 60, key: "m", period: "minute", unit: "minute" },
	{ buckets: 24, key: "h", period: "hour", unit: "hour" },
	{ buckets: 30, key: "d", period: "day", unit: "day" },
	{ buckets: 12, key: "w", period: "week", unit: "week" },
];

function buckets(samples: Sample[], zoom: Zoom, now: number): Bucket[] {
	const starts = [periodStart(zoom.period, now)];
	while (starts.length < zoom.buckets) starts.unshift(previousPeriod(zoom.period, starts[0]));

	const grouped = new Map<number, Sample[]>();
	for (const sample of samples) {
		const start = periodStart(zoom.period, sample.at);
		const group = grouped.get(start);
		if (group) group.push(sample);
		else grouped.set(start, [sample]);
	}

	return starts.map((start) => ({ rate: tokenRate(rateOf(grouped.get(start) ?? [])), start }));
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
	samples: Sample[],
	zoom: Zoom,
	theme: Theme,
	width: number,
	height: number,
): string[] {
	const all = buckets(samples, zoom, Date.now());
	const labelWidth = `${Math.round(Math.max(...all.map((bucket) => bucket.rate ?? 0)))}`.length;
	const gutter = labelWidth + 3;
	const plotWidth = Math.max(1, width - gutter);
	const cell = Math.max(1, Math.min(BAR_MAX_WIDTH, Math.floor(plotWidth / zoom.buckets)));
	const bar = cell > 1 ? cell - 1 : 1;
	const count = Math.min(zoom.buckets, Math.floor(plotWidth / cell));
	const shown = all.slice(all.length - count);
	const rates = shown.flatMap((bucket) => (bucket.rate === undefined ? [] : [bucket.rate]));
	const peak = rates.length > 0 ? Math.max(...rates) : undefined;
	const base = rates.length > 0 ? Math.min(...rates) : undefined;

	const level = (bucket: Bucket) => {
		if (bucket.rate === undefined || peak === undefined || base === undefined) return 0;
		const ratio = peak > base ? (bucket.rate - base) / (peak - base) : 0.5;
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
		if (index === height - 1) return `${Math.round(peak)}`;
		if (index === Math.floor((height - 1) / 2)) return `${Math.round((peak + base) / 2)}`;
		return "";
	};

	const caption = ` tok/s per ${zoom.unit} · ${spanText(zoom, count)}`;
	const note = peak === undefined ? "no responses in range" : `peak ${Math.round(peak)}`;
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
			` ${(base === undefined ? "-" : `${Math.round(base)}`).padStart(labelWidth)} ┼${"─".repeat(count * cell)}`,
		),
		theme.fg("dim", axisRow(axisLabels(zoom, count), gutter, count * cell)),
	];
}
