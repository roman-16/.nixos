import { homedir } from "node:os";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { SUMMARY_MODEL } from "./collect.ts";

export interface ColumnSpec {
	align: "left" | "right";
	header: string;
	maxWidth?: number;
	priority: number;
}

export interface TableRow {
	cells: string[];
	kind: "data" | "sub" | "total";
}

export interface SortMarker {
	ascending: boolean;
	column: number;
}

export interface TableRender {
	kept: number[];
	lines: string[];
}

const GAP = 2;
const MIN_LABEL_WIDTH = 10;

export function formatCost(value: number): string {
	return `$${value.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
}

export function formatCount(value: number): string {
	return value.toLocaleString("en-US");
}

export function formatTokens(value: number): string {
	if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
	return `${value}`;
}

export function formatDate(timestamp: number): string {
	if (!timestamp || !Number.isFinite(timestamp)) return "";
	const date = new Date(timestamp);
	const month = `${date.getMonth() + 1}`.padStart(2, "0");
	const day = `${date.getDate()}`.padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

export function modelName(model: string): string {
	const name = model.slice(model.indexOf("/") + 1);
	return name.startsWith("claude-") ? name.slice("claude-".length) : name;
}

export function shortModel(model: string): string {
	if (model === SUMMARY_MODEL) return "summaries";
	return `${model.slice(0, model.indexOf("/"))}/${modelName(model)}`;
}

export function shortProject(project: string): string {
	if (!project) return "(unknown)";
	const home = homedir();
	return project.startsWith(home) ? `~${project.slice(home.length)}` : project;
}

export function joinModels(models: string[]): string {
	return Array.from(new Set(models.map(modelName))).join(", ");
}

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

	const used = () => widths.reduce((sum, value) => sum + value, 0) + GAP * (widths.length - 1);

	while (used() > width) {
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

export function renderTable(
	columns: ColumnSpec[],
	rows: TableRow[],
	theme: Theme,
	width: number,
	sort?: SortMarker,
): TableRender {
	if (rows.length === 0) return { kept: [], lines: [theme.fg("muted", "No usage recorded.")] };

	const headed = columns.map((column, index) =>
		index === sort?.column ? { ...column, header: `${column.header} ${sort.ascending ? "▲" : "▼"}` } : column,
	);
	const { kept, widths } = fit(headed, rows, width);
	const line = (cells: string[]) =>
		kept.map((index, position) => pad(cells[index] ?? "", widths[position], headed[index].align)).join(" ".repeat(GAP));
	const ruleWidth = Math.min(width, widths.reduce((sum, value) => sum + value, 0) + GAP * (widths.length - 1));

	const output: string[] = [
		theme.fg("accent", theme.bold(line(headed.map((column) => column.header)))),
		theme.fg("dim", "─".repeat(ruleWidth)),
	];

	for (const row of rows) {
		if (row.kind === "total") output.push(theme.fg("dim", "─".repeat(ruleWidth)));
		const text = line(row.cells).trimEnd();
		output.push(row.kind === "sub" ? theme.fg("dim", text) : row.kind === "total" ? theme.bold(text) : text);
	}

	return { kept, lines: output.map((text) => truncateToWidth(text, width)) };
}
