import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type SessionEntry } from "@earendil-works/pi-coding-agent";

export const SUMMARY_MODEL = "Tools/summaries";

export interface UsageRow {
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	date: string;
	firstTs: number;
	input: number;
	lastTs: number;
	messages: number;
	model: string;
	output: number;
}

export interface SessionUsage {
	firstMessage?: string;
	id: string;
	name?: string;
	path: string;
	project: string;
	rows: UsageRow[];
}

export interface LiveSession {
	cwd: string;
	entries: SessionEntry[];
	id: string;
	name?: string;
	path: string | null;
}

interface Usage {
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number };
	input?: number;
	output?: number;
}

interface SessionRecord {
	cwd?: string;
	id?: string;
	message?: {
		content?: string | Array<{ text?: string; type?: string }>;
		model?: string;
		provider?: string;
		responseModel?: string;
		role?: string;
		timestamp?: number;
		usage?: Usage;
	};
	name?: string;
	timestamp?: string;
	type?: string;
	usage?: Usage;
}

interface Accumulator {
	firstMessage?: string;
	id: string;
	name?: string;
	project: string;
	rows: Map<string, UsageRow>;
}

interface CacheEntry {
	firstMessage?: string;
	id: string;
	mtimeMs: number;
	name?: string;
	project: string;
	rows: UsageRow[];
	size: number;
}

interface CacheFile {
	entryShape: string;
	files: { [path: string]: CacheEntry };
}

type Cache = Map<string, CacheEntry>;

const CACHE_ENTRY_SHAPE = "firstMessage,id,mtimeMs,name,project,rows,size";

const FIRST_MESSAGE_LIMIT = 90;

const cachePath = () => join(getAgentDir(), "usage-stats-cache.json");

const sessionsDir = () => join(getAgentDir(), "sessions");

function localDate(ms: number): string {
	const date = new Date(ms);
	const month = `${date.getMonth() + 1}`.padStart(2, "0");
	const day = `${date.getDate()}`.padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

function createAccumulator(rows: UsageRow[] = []): Accumulator {
	const map = new Map<string, UsageRow>();
	for (const row of rows) map.set(`${row.date}\u0000${row.model}`, { ...row });
	return { id: "", project: "", rows: map };
}

function promptText(content: string | Array<{ text?: string; type?: string }> | undefined): string {
	const raw =
		typeof content === "string"
			? content
			: Array.isArray(content)
				? content
						.filter((block) => block.type === "text")
						.map((block) => block.text ?? "")
						.join(" ")
				: "";
	const skillEnd = raw.lastIndexOf("</skill>");
	const afterSkill = skillEnd < 0 ? raw : raw.slice(skillEnd + "</skill>".length);
	const collapsed = afterSkill.replace(/\s+/g, " ").trim();
	return collapsed.length > FIRST_MESSAGE_LIMIT ? `${collapsed.slice(0, FIRST_MESSAGE_LIMIT)}…` : collapsed;
}

function addUsage(accumulator: Accumulator, model: string, usage: Usage, timestamp: number): void {
	const date = localDate(timestamp);
	const key = `${date}\u0000${model}`;
	const row = accumulator.rows.get(key) ?? {
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		date,
		firstTs: timestamp,
		input: 0,
		lastTs: timestamp,
		messages: 0,
		model,
		output: 0,
	};
	row.cacheRead += usage.cacheRead ?? 0;
	row.cacheWrite += usage.cacheWrite ?? 0;
	row.cost += usage.cost?.total ?? 0;
	row.firstTs = Math.min(row.firstTs, timestamp);
	row.input += usage.input ?? 0;
	row.lastTs = Math.max(row.lastTs, timestamp);
	row.messages += 1;
	row.output += usage.output ?? 0;
	accumulator.rows.set(key, row);
}

function fold(record: SessionRecord, accumulator: Accumulator): void {
	if (record.type === "session") {
		accumulator.id = record.id ?? accumulator.id;
		accumulator.project = record.cwd ?? accumulator.project;
		return;
	}
	if (record.type === "session_info") {
		accumulator.name = record.name;
		return;
	}

	const message = record.message;

	if (message?.role === "user" && accumulator.firstMessage === undefined) {
		const text = promptText(message.content);
		if (text) accumulator.firstMessage = text;
	}

	const timestamp = Date.parse(record.timestamp ?? "") || message?.timestamp || 0;
	if (!timestamp) return;

	if (message?.role === "assistant" && message.usage) {
		addUsage(
			accumulator,
			`${message.provider}/${message.responseModel ?? message.model}`,
			message.usage,
			timestamp,
		);
		return;
	}
	if (message?.role === "toolResult" && message.usage) {
		addUsage(accumulator, SUMMARY_MODEL, message.usage, timestamp);
		return;
	}
	if ((record.type === "branch_summary" || record.type === "compaction") && record.usage) {
		addUsage(accumulator, SUMMARY_MODEL, record.usage, timestamp);
	}
}

function carriesUsageOrMetadata(line: string, wantsPrompt: boolean): boolean {
	return (
		line.includes('"usage"') ||
		line.includes('"type":"session') ||
		(wantsPrompt && line.includes('"role":"user"'))
	);
}

function foldText(text: string, accumulator: Accumulator): void {
	for (const line of text.split("\n")) {
		if (!carriesUsageOrMetadata(line, accumulator.firstMessage === undefined)) continue;
		try {
			fold(JSON.parse(line) as SessionRecord, accumulator);
		} catch {}
	}
}

function readChunk(path: string, offset: number, length: number): { consumed: number; text: string } {
	if (length <= 0) return { consumed: 0, text: "" };
	const descriptor = openSync(path, "r");
	try {
		const buffer = Buffer.allocUnsafe(length);
		let read = 0;
		while (read < length) {
			const bytes = readSync(descriptor, buffer, read, length - read, offset + read);
			if (bytes === 0) break;
			read += bytes;
		}
		const filled = buffer.subarray(0, read);
		const lastNewline = filled.lastIndexOf(0x0a);
		if (lastNewline < 0) return { consumed: 0, text: "" };
		return { consumed: lastNewline + 1, text: filled.subarray(0, lastNewline + 1).toString("utf8") };
	} finally {
		closeSync(descriptor);
	}
}

function toEntry(accumulator: Accumulator, mtimeMs: number, size: number): CacheEntry {
	return {
		firstMessage: accumulator.firstMessage,
		id: accumulator.id,
		mtimeMs,
		name: accumulator.name,
		project: accumulator.project,
		rows: Array.from(accumulator.rows.values()),
		size,
	};
}

function parseFile(path: string, mtimeMs: number, size: number): CacheEntry {
	const accumulator = createAccumulator();
	const { consumed, text } = readChunk(path, 0, size);
	foldText(text, accumulator);
	return toEntry(accumulator, mtimeMs, consumed);
}

function extendFile(path: string, cached: CacheEntry, mtimeMs: number, size: number): CacheEntry {
	const accumulator = createAccumulator(cached.rows);
	accumulator.firstMessage = cached.firstMessage;
	accumulator.id = cached.id;
	accumulator.name = cached.name;
	accumulator.project = cached.project;
	const { consumed, text } = readChunk(path, cached.size, size - cached.size);
	foldText(text, accumulator);
	return toEntry(accumulator, mtimeMs, cached.size + consumed);
}

function loadCache(): Cache {
	try {
		const parsed = JSON.parse(readFileSync(cachePath(), "utf8")) as CacheFile;
		if (parsed.entryShape !== CACHE_ENTRY_SHAPE) return new Map();
		return new Map(Object.entries(parsed.files));
	} catch {
		return new Map();
	}
}

function saveCache(cache: Cache): void {
	const content: CacheFile = { entryShape: CACHE_ENTRY_SHAPE, files: Object.fromEntries(cache) };
	try {
		writeFileSync(cachePath(), JSON.stringify(content));
	} catch {}
}

function sessionFiles(): string[] {
	const root = sessionsDir();
	const files: string[] = [];
	let projects: string[];
	try {
		projects = readdirSync(root);
	} catch {
		return files;
	}
	for (const project of projects) {
		const directory = join(root, project);
		try {
			if (!statSync(directory).isDirectory()) continue;
			for (const file of readdirSync(directory)) {
				if (file.endsWith(".jsonl")) files.push(join(directory, file));
			}
		} catch {}
	}
	return files;
}

function fromEntries(live: LiveSession): SessionUsage {
	const accumulator = createAccumulator();
	for (const entry of live.entries) fold(entry as unknown as SessionRecord, accumulator);
	return {
		firstMessage: accumulator.firstMessage,
		id: live.id,
		name: live.name,
		path: live.path ?? live.id,
		project: live.cwd,
		rows: Array.from(accumulator.rows.values()),
	};
}

export function collectSessions(live?: LiveSession): SessionUsage[] {
	const cache = loadCache();
	const next: Cache = new Map();
	const sessions: SessionUsage[] = [];

	for (const path of sessionFiles()) {
		let mtimeMs: number;
		let size: number;
		try {
			const stats = statSync(path);
			mtimeMs = stats.mtimeMs;
			size = stats.size;
		} catch {
			continue;
		}

		const cached = cache.get(path);
		const entry =
			cached && cached.mtimeMs === mtimeMs && cached.size === size
				? cached
				: cached && size > cached.size
					? extendFile(path, cached, mtimeMs, size)
					: parseFile(path, mtimeMs, size);

		next.set(path, entry);
		sessions.push({
			firstMessage: entry.firstMessage,
			id: entry.id,
			name: entry.name,
			path,
			project: entry.project,
			rows: entry.rows,
		});
	}

	saveCache(next);

	if (live) {
		const usage = fromEntries(live);
		const index = sessions.findIndex((session) => session.path === usage.path);
		if (index >= 0) {
			sessions[index] = {
				...usage,
				firstMessage: usage.firstMessage ?? sessions[index].firstMessage,
				name: usage.name ?? sessions[index].name,
			};
		} else {
			sessions.push(usage);
		}
	}

	return sessions;
}
