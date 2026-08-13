export const ASK_PROGRESS_INTERVAL_MS = 5_000;
export const ASK_TIMEOUT_MS = 300_000;
export const CLAIM_TTL_MS = 30 * 60_000;
export const HANDSHAKE_TIMEOUT_MS = 500;
export const HEARTBEAT_INTERVAL_MS = 15_000;
export const INBOX_MODE: InboxMode = "open";
export const MAX_HOPS = 2;
export const MAX_TEXT_BYTES = 32 * 1024;
export const MESSAGE_RATE = { count: 20, windowMs: 60_000 };
export const PRESENCE_DEBOUNCE_MS = 1_000;
export const PROTOCOL_VERSION = 1;
export const REQUEST_TIMEOUT_MS = 15_000;
export const STALE_AFTER_MS = 45_000;
export const WAKE_RATE = { count: 3, windowMs: 60_000 };

export type DeliveryMode = "followUp" | "nextTurn" | "steer";
export type InboxMode = "confirm" | "off" | "open" | "queue";
export type PeerState = "idle" | "queued" | "working";
export type TouchKind = "modified" | "read";
export type TranscriptMode = "full" | "search" | "tail";

export interface FileTouch {
	at: number;
	path: string;
	turn: number;
}

export interface PeerClaim {
	expiresAt: number;
	intent: string;
	paths: string[];
}

export interface PeerLocation {
	term?: string;
	zellijPane?: string;
	zellijSession?: string;
}

export interface PeerIdentity {
	cwd: string;
	name?: string;
	pid: number;
	sessionId: string;
}

export interface PresenceRecord {
	claims: PeerClaim[];
	context?: { tokens: number; window: number };
	cwd: string;
	files: { modified: FileTouch[]; read: FileTouch[] };
	inbox: { accepted: number; lastFrom?: string; mode: InboxMode; rejected: number };
	lastAssistantAt?: number;
	lastUserAt?: number;
	location: PeerLocation;
	model?: string;
	name?: string;
	pid: number;
	protocol: number;
	sessionFile: string | null;
	sessionId: string;
	socket: string;
	startTicks: number | null;
	startedAt: number;
	state: PeerState;
	thinking?: string;
	turn: number;
	updatedAt: number;
}

interface Envelope {
	at: number;
	from: PeerIdentity;
	hops: number;
	id: string;
	protocol: number;
}

export type Request = Envelope &
	(
		| { type: "hello" }
		| { type: "state" }
		| { deliver: DeliveryMode; text: string; type: "inject"; wake: boolean }
		| { text: string; timeoutMs: number; type: "ask" }
		| { mode: TranscriptMode; query?: string; turns?: number; type: "read" }
		| { intent: string; paths: string[]; ttlMs: number; type: "claim" }
		| { paths: string[]; type: "release" }
	);

export interface Response {
	claims?: PeerClaim[];
	deferred?: boolean;
	error?: string;
	id: string;
	identity?: PeerIdentity;
	ok: boolean;
	presence?: PresenceRecord;
	queuedAs?: DeliveryMode;
	reply?: string;
	retryAfterMs?: number;
	settledAt?: number;
	state?: PeerState;
	timedOut?: boolean;
	transcript?: string;
	truncated?: boolean;
	type: "progress" | "result";
	userInterjected?: boolean;
}

export function newRequestId(): string {
	return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function clampText(text: string): { text: string; truncated: boolean } {
	const buffer = Buffer.from(text, "utf8");
	if (buffer.byteLength <= MAX_TEXT_BYTES) return { text, truncated: false };
	return { text: buffer.subarray(0, MAX_TEXT_BYTES).toString("utf8"), truncated: true };
}
