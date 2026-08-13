import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type PeerState, type PresenceRecord, STALE_AFTER_MS } from "./protocol.ts";

export interface PeerView {
	key: string;
	presence: PresenceRecord;
	self: boolean;
	stale: boolean;
}

const STATE_RANK: Record<PeerState, number> = { working: 0, queued: 1, idle: 2 };

export function registryDir(): string {
	const dir = join(getAgentDir(), "peers");
	mkdirSync(dir, { mode: 0o700, recursive: true });
	return dir;
}

export function socketDir(): string {
	const runtime = process.env.XDG_RUNTIME_DIR;
	const dir = runtime ? join(runtime, "pi-peers") : join(tmpdir(), `pi-peers-${process.getuid?.() ?? 0}`);
	mkdirSync(dir, { mode: 0o700, recursive: true });
	return dir;
}

export function presenceKey(sessionId: string, pid: number): string {
	return `${sessionId}.${pid}`;
}

export function presencePath(key: string): string {
	return join(registryDir(), `${key}.json`);
}

export function socketPath(key: string): string {
	return join(socketDir(), `${key}.sock`);
}

export function processStartTicks(pid: number): number | null {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		const ticks = Number(fields[19]);
		return Number.isFinite(ticks) ? ticks : null;
	} catch {
		return null;
	}
}

export function processAlive(record: PresenceRecord): boolean {
	try {
		process.kill(record.pid, 0);
	} catch {
		return false;
	}
	if (record.startTicks === null) return true;
	const current = processStartTicks(record.pid);
	return current === null || current === record.startTicks;
}

export function writePresence(record: PresenceRecord): void {
	const path = presencePath(presenceKey(record.sessionId, record.pid));
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, JSON.stringify(record), { mode: 0o600 });
	renameSync(temp, path);
}

export function removePresence(key: string): void {
	for (const path of [presencePath(key), socketPath(key)]) {
		try {
			unlinkSync(path);
		} catch {}
	}
}

export function readPeers(selfKey?: string): PeerView[] {
	const now = Date.now();
	const views: PeerView[] = [];
	let names: string[];
	try {
		names = readdirSync(registryDir());
	} catch {
		return views;
	}

	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const key = name.slice(0, -5);
		let presence: PresenceRecord;
		try {
			presence = JSON.parse(readFileSync(join(registryDir(), name), "utf8")) as PresenceRecord;
		} catch {
			continue;
		}
		if (!presence?.sessionId || !presence.pid) continue;
		if (key !== selfKey && !processAlive(presence)) {
			removePresence(key);
			continue;
		}
		views.push({
			key,
			presence,
			self: key === selfKey,
			stale: now - presence.updatedAt > STALE_AFTER_MS,
		});
	}

	return views.sort(
		(left, right) =>
			STATE_RANK[left.presence.state] - STATE_RANK[right.presence.state] ||
			right.presence.updatedAt - left.presence.updatedAt,
	);
}

export function duplicateSessionFiles(peers: PeerView[]): Set<string> {
	const counts = new Map<string, number>();
	for (const peer of peers) {
		const file = peer.presence.sessionFile;
		if (file) counts.set(file, (counts.get(file) ?? 0) + 1);
	}
	return new Set([...counts].filter(([, count]) => count > 1).map(([file]) => file));
}

