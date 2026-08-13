import { homedir } from "node:os";
import { relative, resolve } from "node:path";
import type { FileTouch, PresenceRecord, TouchKind } from "./protocol.ts";

const MAX_TOUCHES = 200;

export interface FileSnapshot {
	modified: FileTouch[];
	read: FileTouch[];
}

export interface Conflict {
	mineAt: number;
	mineKind: TouchKind;
	path: string;
	peer: PresenceRecord;
	peerAt: number;
}

function newest(touches: Map<string, FileTouch>): FileTouch[] {
	return [...touches.values()].sort((left, right) => right.at - left.at).slice(0, MAX_TOUCHES);
}

export class FileTracker {
	private modified = new Map<string, FileTouch>();
	private read = new Map<string, FileTouch>();

	record(kind: TouchKind, path: string, turn: number): boolean {
		const touches = kind === "modified" ? this.modified : this.read;
		if (kind === "read" && touches.has(path)) return false;
		touches.set(path, { at: Date.now(), path, turn });
		return true;
	}

	reset(): void {
		this.modified.clear();
		this.read.clear();
	}

	snapshot(): FileSnapshot {
		return { modified: newest(this.modified), read: newest(this.read) };
	}
}

export function toolPath(cwd: string, raw: unknown): string | undefined {
	if (typeof raw !== "string" || raw.length === 0) return undefined;
	return resolve(cwd, raw.replace(/^@/, ""));
}

export function displayPath(path: string, cwd: string): string {
	const inside = relative(cwd, path);
	if (inside && !inside.startsWith("..")) return inside;
	const home = homedir();
	return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

export function conflicts(mine: FileSnapshot, peers: PresenceRecord[]): Conflict[] {
	const own = new Map<string, { at: number; kind: TouchKind }>();
	for (const touch of mine.read) own.set(touch.path, { at: touch.at, kind: "read" });
	for (const touch of mine.modified) own.set(touch.path, { at: touch.at, kind: "modified" });

	const found: Conflict[] = [];
	for (const peer of peers) {
		for (const touch of peer.files?.modified ?? []) {
			const mineTouch = own.get(touch.path);
			if (!mineTouch || touch.at <= mineTouch.at) continue;
			found.push({
				mineAt: mineTouch.at,
				mineKind: mineTouch.kind,
				path: touch.path,
				peer,
				peerAt: touch.at,
			});
		}
	}

	return found.sort((left, right) => right.peerAt - left.peerAt);
}

export function activeClaims(peers: PresenceRecord[]): { claim: PresenceRecord["claims"][number]; peer: PresenceRecord }[] {
	const now = Date.now();
	return peers.flatMap((peer) =>
		(peer.claims ?? []).filter((claim) => claim.expiresAt > now).map((claim) => ({ claim, peer })),
	);
}

export function conflictKey(conflict: Conflict): string {
	return `${conflict.peer.sessionId}:${conflict.path}`;
}
