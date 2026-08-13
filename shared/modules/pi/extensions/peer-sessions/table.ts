import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type RowTone = "danger" | "muted" | "normal";

export interface ColumnSpec {
	align: "left" | "right";
	header: string;
	maxWidth?: number;
	priority: number;
}

export interface TableRow {
	cells: string[];
	selected?: boolean;
	tone?: RowTone;
}

const GAP = 2;
const MARKER_WIDTH = 2;
const MIN_LABEL_WIDTH = 8;

function pad(text: string, width: number, align: "left" | "right"): string {
	const size = visibleWidth(text);
	if (size > width) return truncateToWidth(text, width);
	const filler = " ".repeat(width - size);
	return align === "right" ? `${filler}${text}` : `${text}${filler}`;
}

function measure(columns: ColumnSpec[], rows: TableRow[], kept: number[]): number[] {
	return kept.map((index) => {
		let width = visibleWidth(columns[index].header);
		for (const row of rows) width = Math.max(width, visibleWidth(row.cells[index] ?? ""));
		return Math.min(width, columns[index].maxWidth ?? Number.POSITIVE_INFINITY);
	});
}

function fit(columns: ColumnSpec[], rows: TableRow[], width: number): { kept: number[]; widths: number[] } {
	let kept = columns.map((_column, index) => index);
	let widths = measure(columns, rows, kept);

	const used = () => widths.reduce((sum, value) => sum + value, 0) + GAP * (widths.length - 1) + MARKER_WIDTH;

	while (used() > width && kept.length > 1) {
		let victim = -1;
		for (const [position, index] of kept.entries()) {
			if (columns[index].priority === 0) continue;
			if (victim < 0 || columns[index].priority > columns[kept[victim]].priority) victim = position;
		}
		if (victim < 0) break;
		kept = kept.filter((_index, position) => position !== victim);
		widths = measure(columns, rows, kept);
	}

	const overflow = used() - width;
	if (overflow > 0) {
		const label = kept.findIndex((index) => columns[index].align === "left");
		if (label >= 0) widths[label] = Math.max(MIN_LABEL_WIDTH, widths[label] - overflow);
	}

	return { kept, widths };
}

export function renderTable(columns: ColumnSpec[], rows: TableRow[], theme: Theme, width: number): string[] {
	if (rows.length === 0) return [theme.fg("muted", "  nothing here")];

	const { kept, widths } = fit(columns, rows, width);
	const compose = (cells: string[]) =>
		kept.map((index, position) => pad(cells[index] ?? "", widths[position], columns[index].align)).join(" ".repeat(GAP));

	const lines = [theme.fg("accent", theme.bold(`  ${compose(columns.map((column) => column.header))}`))];

	for (const row of rows) {
		const body = `${row.selected ? "▸ " : "  "}${compose(row.cells)}`.trimEnd();
		if (row.selected) lines.push(theme.bg("selectedBg", theme.fg("accent", body)));
		else if (row.tone === "danger") lines.push(theme.fg("warning", body));
		else if (row.tone === "muted") lines.push(theme.fg("dim", body));
		else lines.push(body);
	}

	return lines.map((line) => truncateToWidth(line, width));
}

export function formatAge(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "-";
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h${minutes % 60 > 0 ? `${minutes % 60}m` : ""}`;
	return `${Math.floor(hours / 24)}d`;
}

export function formatClock(at: number | undefined): string {
	if (!at) return "-";
	const date = new Date(at);
	return `${`${date.getHours()}`.padStart(2, "0")}:${`${date.getMinutes()}`.padStart(2, "0")}`;
}

export function shortenPath(path: string, limit: number): string {
	if (path.length <= limit) return path;
	return `…${path.slice(path.length - limit + 1)}`;
}
