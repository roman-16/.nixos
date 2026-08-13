import { closeSync, openSync, readSync, statSync } from "node:fs";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail } from "@earendil-works/pi-coding-agent";
import { displayPath } from "./files.ts";
import type { TranscriptMode } from "./protocol.ts";

const ASSISTANT_TEXT_LIMIT = 600;
const TOOL_TARGET_LIMIT = 44;
const USER_TEXT_LIMIT = 400;
const WINDOW_STEPS = [512 * 1024, 4 * 1024 * 1024, 32 * 1024 * 1024];

interface ContentBlock {
	arguments?: Record<string, unknown>;
	id?: string;
	name?: string;
	text?: string;
	type: string;
}

interface JournalMessage {
	content?: string | ContentBlock[];
	customType?: string;
	details?: { from?: { name?: string; sessionId?: string } };
	role?: string;
	timestamp?: number;
}

interface JournalEntry {
	message?: JournalMessage;
	summary?: string;
	timestamp?: string;
	tokensBefore?: number;
	type?: string;
}

export interface Transcript {
	text: string;
	truncated: boolean;
}

function readWindow(file: string, bytes: number): { atStart: boolean; text: string } {
	const { size } = statSync(file);
	const start = Math.max(0, size - bytes);
	const length = size - start;
	const descriptor = openSync(file, "r");
	try {
		const buffer = Buffer.allocUnsafe(length);
		let read = 0;
		while (read < length) {
			const chunk = readSync(descriptor, buffer, read, length - read, start + read);
			if (chunk === 0) break;
			read += chunk;
		}
		const text = buffer.subarray(0, read).toString("utf8");
		if (start === 0) return { atStart: true, text };
		const newline = text.indexOf("\n");
		return { atStart: false, text: newline < 0 ? "" : text.slice(newline + 1) };
	} finally {
		closeSync(descriptor);
	}
}

function flatten(text: string, limit: number): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	return collapsed.length > limit ? `${collapsed.slice(0, limit)}…` : collapsed;
}

function textOf(content: string | ContentBlock[] | undefined): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text ?? "")
		.join(" ");
}

function stamp(entry: JournalEntry): number {
	return Date.parse(entry.timestamp ?? "") || entry.message?.timestamp || 0;
}

function clock(at: number): string {
	if (!at) return "     ";
	const date = new Date(at);
	const time = `${`${date.getHours()}`.padStart(2, "0")}:${`${date.getMinutes()}`.padStart(2, "0")}`;
	const today = new Date();
	const sameDay =
		date.getDate() === today.getDate() && date.getMonth() === today.getMonth() && date.getFullYear() === today.getFullYear();
	return sameDay ? time : `${`${date.getDate()}`.padStart(2, "0")}.${`${date.getMonth() + 1}`.padStart(2, "0")}. ${time}`;
}

function toolSummary(block: ContentBlock, cwd: string, failed: Set<string>): string {
	const args = block.arguments ?? {};
	const raw =
		(typeof args.path === "string" && args.path) ||
		(typeof args.command === "string" && args.command) ||
		(typeof args.pattern === "string" && args.pattern) ||
		(typeof args.query === "string" && args.query) ||
		(typeof args.url === "string" && args.url) ||
		"";
	const target = typeof args.path === "string" && args.path ? displayPath(args.path, cwd) : raw;
	const status = block.id && failed.has(block.id) ? " ✗" : "";
	return `${block.name ?? "tool"}${target ? ` ${flatten(target, TOOL_TARGET_LIMIT)}` : ""}${status}`;
}

function renderEntry(entry: JournalEntry, cwd: string, failed: Set<string>): string[] {
	const at = clock(stamp(entry));
	const lines: string[] = [];

	if (entry.type === "compaction") {
		lines.push(`⋯     ${at}  compacted${entry.tokensBefore ? ` ${entry.tokensBefore.toLocaleString("en-US")} tokens` : ""}`);
		return lines;
	}
	if (entry.type === "branch_summary") {
		lines.push(`⋯     ${at}  branch summary`);
		return lines;
	}

	const message = entry.message;
	if (!message) return lines;

	if (message.role === "user") {
		const text = flatten(textOf(message.content), USER_TEXT_LIMIT);
		if (text) lines.push(`user  ${at}  ${text}`);
		return lines;
	}

	if (message.role === "custom") {
		const from = message.details?.from?.name ?? message.customType ?? "extension";
		const text = flatten(textOf(message.content), USER_TEXT_LIMIT);
		if (text) lines.push(`peer  ${at}  [${from}] ${text}`);
		return lines;
	}

	if (message.role === "assistant") {
		const blocks = Array.isArray(message.content) ? message.content : [];
		const text = flatten(textOf(message.content), ASSISTANT_TEXT_LIMIT);
		if (text) lines.push(`asst  ${at}  ${text}`);
		const tools = blocks.filter((block) => block.type === "toolCall").map((block) => toolSummary(block, cwd, failed));
		if (tools.length > 0) lines.push(`      tools  ${tools.join(" · ")}`);
	}

	return lines;
}

function collect(file: string, turns: number): { entries: JournalEntry[]; failed: Set<string>; complete: boolean } {
	const failed = new Set<string>();
	let entries: JournalEntry[] = [];
	let complete = false;

	for (const bytes of WINDOW_STEPS) {
		const { atStart, text } = readWindow(file, bytes);
		entries = [];
		failed.clear();
		let users = 0;

		const lines = text.split("\n");
		for (let index = lines.length - 1; index >= 0; index--) {
			const line = lines[index];
			if (line.length === 0) continue;

			if (line.includes('"role":"toolResult"')) {
				if (line.includes('"isError":true')) {
					const match = /"toolCallId":"([^"]+)"/.exec(line);
					if (match) failed.add(match[1]);
				}
				continue;
			}

			let entry: JournalEntry;
			try {
				entry = JSON.parse(line) as JournalEntry;
			} catch {
				continue;
			}
			if (entry.type === "session" || entry.type === "custom" || entry.type === "label") continue;

			entries.push(entry);
			if (entry.message?.role === "user") {
				users++;
				if (users > turns) {
					complete = true;
					break;
				}
			}
		}

		if (complete || atStart) {
			complete = true;
			break;
		}
	}

	return { complete, entries: entries.reverse(), failed };
}

function search(file: string, query: string, limit: number): { entries: JournalEntry[]; failed: Set<string> } {
	const needle = query.toLowerCase();
	const { text } = readWindow(file, WINDOW_STEPS[WINDOW_STEPS.length - 1]);
	const entries: JournalEntry[] = [];

	for (const line of text.split("\n")) {
		if (line.length === 0 || line.includes('"role":"toolResult"')) continue;
		if (!line.toLowerCase().includes(needle)) continue;
		try {
			const entry = JSON.parse(line) as JournalEntry;
			if (entry.message?.role === "assistant" || entry.message?.role === "user") entries.push(entry);
		} catch {}
		if (entries.length >= limit) break;
	}

	return { entries, failed: new Set() };
}

export function renderLiveEntries(options: { cwd: string; entries: unknown[]; header: string; turns: number }): Transcript {
	const { cwd, entries, header, turns } = options;
	const journal = entries as JournalEntry[];
	let users = 0;
	let start = journal.length;

	for (let index = journal.length - 1; index >= 0; index--) {
		start = index;
		if (journal[index].message?.role === "user") {
			users++;
			if (users > turns) break;
		}
	}

	const failed = new Set<string>();
	const body = journal.slice(start).flatMap((entry) => renderEntry(entry, cwd, failed));
	if (body.length === 0) return { text: `${header}\nlive session\n\nnothing to show`, truncated: false };

	const truncation = truncateTail(body.join("\n"), { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
	return { text: `${header}\nlive session · ${Math.min(users, turns)} turn(s)\n\n${truncation.content}`, truncated: truncation.truncated };
}

export function renderJournal(options: {
	cwd: string;
	file: string;
	header: string;
	mode: TranscriptMode;
	query?: string;
	turns: number;
}): Transcript {
	const { cwd, file, header, mode, query, turns } = options;

	let entries: JournalEntry[];
	let failed: Set<string>;
	let note = "";

	if (mode === "search") {
		if (!query) return { text: `${header}\n\nsearch needs a query`, truncated: false };
		const found = search(file, query, 40);
		entries = found.entries;
		failed = found.failed;
		note = `search "${query}" · ${entries.length} match(es)`;
	} else {
		const wanted = mode === "full" ? Number.MAX_SAFE_INTEGER : turns;
		const collected = collect(file, wanted);
		entries = collected.entries;
		failed = collected.failed;
		const users = entries.filter((entry) => entry.message?.role === "user").length;
		note = collected.complete ? `${users} turn(s)` : `${users} turn(s), older history omitted`;
	}

	const body = entries.flatMap((entry) => renderEntry(entry, cwd, failed));
	if (body.length === 0) return { text: `${header}\n${note}\n\nnothing to show`, truncated: false };

	const truncation = truncateTail(body.join("\n"), { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
	return {
		text: `${header}\n${note}\n\n${truncation.content}`,
		truncated: truncation.truncated,
	};
}
