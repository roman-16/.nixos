import {
	closeSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, join } from "node:path";
import { getAgentDir, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { modelName } from "./table.ts";

export const SUMMARY_MODEL = "Tools/summaries";

export const TIMING_TYPE = "stats";

export interface Timing {
	firstTokenMs: number;
	requestedAt: number;
	thinkingMs: number;
}

export interface Response {
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	durationMs: number;
	endedAt: number;
	firstTokenMs?: number;
	input: number;
	model: string;
	output: number;
	reasoning: number;
	startedAt: number;
	thinkingMs?: number;
}

export interface StatsSession {
	firstMessage?: string;
	host: string;
	id: string;
	name?: string;
	project: string;
	responses: Response[];
}

export interface LiveSession {
	cwd: string;
	entries: SessionEntry[];
	id: string;
	name?: string;
}

interface Usage {
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number };
	input?: number;
	output?: number;
	reasoning?: number;
}

interface SessionRecord {
	customType?: string;
	cwd?: string;
	data?: Partial<Timing>;
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
	responses: Response[];
	timings: Timing[];
}

interface Source {
	mtimeMs: number;
	path: string;
	size: number;
}

interface StoredSession {
	firstMessage?: string;
	host: string;
	name?: string;
	project: string;
	responses: Response[];
	source?: Source;
}

interface StoreFile {
	sessions: { [id: string]: StoredSession };
	version: number;
}

type Store = Map<string, StoredSession>;

const FIRST_MESSAGE_LIMIT = 90;

const HOST = hostname();

const STORE_VERSION = 1;

let failure: string | undefined;

let store: Store | undefined;

let writable = true;

const sessionsDir = () => join(getAgentDir(), "sessions");

const storePath = () => join(getAgentDir(), "stats.json");

export function storeFailure(): string | undefined {
	return failure;
}

export function shortModel(model: string): string {
	if (model === SUMMARY_MODEL) return "summaries";
	return `${model.slice(0, model.indexOf("/"))}/${modelName(model)}`;
}

function reason(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function createAccumulator(): Accumulator {
	return { id: "", project: "", responses: [], timings: [] };
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

function addResponse(
	accumulator: Accumulator,
	model: string,
	usage: Usage,
	startedAt: number,
	endedAt: number,
): void {
	accumulator.responses.push({
		cacheRead: usage.cacheRead ?? 0,
		cacheWrite: usage.cacheWrite ?? 0,
		cost: usage.cost?.total ?? 0,
		durationMs: endedAt > startedAt ? endedAt - startedAt : 0,
		endedAt,
		input: usage.input ?? 0,
		model,
		output: usage.output ?? 0,
		reasoning: usage.reasoning ?? 0,
		startedAt,
	});
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
	if (record.type === "custom" && record.customType === TIMING_TYPE) {
		const timing = record.data;
		if (typeof timing?.requestedAt === "number" && typeof timing.firstTokenMs === "number") {
			accumulator.timings.push({
				firstTokenMs: timing.firstTokenMs,
				requestedAt: timing.requestedAt,
				thinkingMs: timing.thinkingMs ?? 0,
			});
		}
		return;
	}

	const message = record.message;

	if (message?.role === "user" && accumulator.firstMessage === undefined) {
		const text = promptText(message.content);
		if (text) accumulator.firstMessage = text;
	}

	const endedAt = Date.parse(record.timestamp ?? "") || message?.timestamp || 0;
	if (!endedAt) return;

	if (message?.role === "assistant" && message.usage) {
		addResponse(
			accumulator,
			`${message.provider}/${message.responseModel ?? message.model}`,
			message.usage,
			message.timestamp ?? endedAt,
			endedAt,
		);
		return;
	}
	if (message?.role === "toolResult" && message.usage) {
		addResponse(accumulator, SUMMARY_MODEL, message.usage, endedAt, endedAt);
		return;
	}
	if ((record.type === "branch_summary" || record.type === "compaction") && record.usage) {
		addResponse(accumulator, SUMMARY_MODEL, record.usage, endedAt, endedAt);
	}
}

function applyTimings(accumulator: Accumulator): Response[] {
	if (accumulator.timings.length > 0) {
		const byStart = new Map(accumulator.responses.map((response) => [response.startedAt, response]));
		for (const timing of accumulator.timings) {
			const response = byStart.get(timing.requestedAt);
			if (!response) continue;
			response.firstTokenMs = timing.firstTokenMs;
			response.thinkingMs = timing.thinkingMs;
		}
	}
	return accumulator.responses;
}

function carriesRecord(line: string, wantsPrompt: boolean): boolean {
	return (
		line.includes('"usage"') ||
		line.includes('"type":"session') ||
		line.includes(`"customType":"${TIMING_TYPE}"`) ||
		(wantsPrompt && line.includes('"role":"user"'))
	);
}

function foldText(text: string, accumulator: Accumulator): void {
	for (const line of text.split("\n")) {
		if (!carriesRecord(line, accumulator.firstMessage === undefined)) continue;
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

function foldChunk(accumulator: Accumulator, path: string, offset: number, length: number): number {
	const { consumed, text } = readChunk(path, offset, length);
	foldText(text, accumulator);
	return offset + consumed;
}

function seedFrom(id: string, stored: StoredSession): Accumulator {
	return {
		firstMessage: stored.firstMessage,
		id,
		name: stored.name,
		project: stored.project,
		responses: stored.responses,
		timings: [],
	};
}

function toStored(accumulator: Accumulator, source: Source): StoredSession {
	return {
		firstMessage: accumulator.firstMessage,
		host: HOST,
		name: accumulator.name,
		project: accumulator.project,
		responses: applyTimings(accumulator),
		source,
	};
}

function loadStore(): Store {
	let text: string;
	try {
		text = readFileSync(storePath(), "utf8");
	} catch {
		return new Map();
	}

	try {
		const parsed = JSON.parse(text) as StoreFile;
		if (parsed.version !== STORE_VERSION) {
			writable = false;
			failure = `stats.json is version ${parsed.version}, this build reads ${STORE_VERSION}`;
			return new Map();
		}
		return new Map(Object.entries(parsed.sessions));
	} catch (error) {
		writable = false;
		failure = `stats.json unreadable (${reason(error)})`;
		return new Map();
	}
}

function saveStore(sessions: Store): void {
	if (!writable) return;

	const path = storePath();
	const temporary = `${path}.${process.pid}`;
	const content: StoreFile = { sessions: Object.fromEntries(sessions), version: STORE_VERSION };

	try {
		writeFileSync(temporary, JSON.stringify(content));
		renameSync(temporary, path);
		failure = undefined;
	} catch (error) {
		failure = reason(error);
		try {
			unlinkSync(temporary);
		} catch {}
	}
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
	return files.sort(
		(left, right) => basename(left).localeCompare(basename(right)) || left.localeCompare(right),
	);
}

function localSessions(sessions: Store): Map<string, { id: string; stored: StoredSession }> {
	const local = new Map<string, { id: string; stored: StoredSession }>();
	for (const [id, stored] of sessions) {
		if (stored.host === HOST && stored.source) local.set(stored.source.path, { id, stored });
	}
	return local;
}

function fromEntries(live: LiveSession): StatsSession {
	const accumulator = createAccumulator();
	for (const entry of live.entries) fold(entry as unknown as SessionRecord, accumulator);
	return {
		firstMessage: accumulator.firstMessage,
		host: HOST,
		id: live.id,
		name: live.name,
		project: live.cwd,
		responses: applyTimings(accumulator),
	};
}

function withoutForkedCopies(sessions: StatsSession[]): StatsSession[] {
	const seen = new Set<string>();
	return sessions.map((session) => ({
		...session,
		responses: session.responses.filter((response) => {
			const key = `${response.startedAt}\u0000${response.endedAt}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		}),
	}));
}

export function collectSessions(live?: LiveSession): StatsSession[] {
	const previous = (store ??= loadStore());
	const local = localSessions(previous);
	const next: Store = new Map();
	let changed = false;

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

		const cached = local.get(path);
		const source = cached?.stored.source;
		if (cached && source && source.mtimeMs === mtimeMs && source.size === size) {
			next.set(cached.id, cached.stored);
			continue;
		}

		const grown = cached && source && size > source.size;
		const accumulator = grown ? seedFrom(cached.id, cached.stored) : createAccumulator();
		const consumed = grown
			? foldChunk(accumulator, path, source.size, size - source.size)
			: foldChunk(accumulator, path, 0, size);

		next.set(accumulator.id || path, toStored(accumulator, { mtimeMs, path, size: consumed }));
		changed = true;
	}

	for (const [id, stored] of previous) {
		if (!next.has(id)) next.set(id, stored);
	}

	store = next;
	if (changed) saveStore(next);

	const sessions: StatsSession[] = Array.from(next, ([id, stored]) => ({
		firstMessage: stored.firstMessage,
		host: stored.host,
		id,
		name: stored.name,
		project: stored.project,
		responses: stored.responses,
	})).sort((left, right) => left.id.localeCompare(right.id));

	if (live) {
		const session = fromEntries(live);
		const index = sessions.findIndex((existing) => existing.id === session.id);
		if (index >= 0) {
			sessions[index] = {
				...session,
				firstMessage: session.firstMessage ?? sessions[index].firstMessage,
				name: session.name ?? sessions[index].name,
			};
		} else {
			sessions.push(session);
		}
	}

	return withoutForkedCopies(sessions);
}
