import { chmodSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import type { Transcript } from "./journal.ts";
import {
	ASK_PROGRESS_INTERVAL_MS,
	ASK_TIMEOUT_MS,
	clampText,
	type DeliveryMode,
	type InboxMode,
	MAX_HOPS,
	MESSAGE_RATE,
	type PeerClaim,
	type PeerIdentity,
	type PeerState,
	type PresenceRecord,
	PROTOCOL_VERSION,
	type Request,
	type Response,
	type TranscriptMode,
	WAKE_RATE,
} from "./protocol.ts";

export interface AskReply {
	reply: string;
	settledAt: number;
	userInterjected: boolean;
}

export interface InboxLogEntry {
	at: number;
	detail: string;
	direction: "in" | "out";
	kind: string;
	ok: boolean;
	peer: string;
	text?: string;
}

export interface ServerDeps {
	claim(paths: string[], intent: string, ttlMs: number): PeerClaim[];
	collectReply(markerTs: number): AskReply;
	confirm(from: PeerIdentity, text: string): Promise<boolean>;
	identity(): PeerIdentity;
	inboxMode(): InboxMode;
	inject(options: { deliver: DeliveryMode; from: PeerIdentity; hops: number; text: string; wake: boolean }): DeliveryMode;
	log(entry: InboxLogEntry): void;
	presence(): PresenceRecord;
	release(paths: string[]): PeerClaim[];
	state(): PeerState;
	transcript(mode: TranscriptMode, turns: number, query?: string): Transcript;
}

export interface ServerHandle {
	close(): void;
	notifySettled(): void;
	pendingAsks(): number;
}

interface Waiter {
	id: string;
	markerTs: number;
	progress: ReturnType<typeof setInterval>;
	socket: Socket;
	timer: ReturnType<typeof setTimeout>;
}

interface Bucket {
	messages: number[];
	wakes: number[];
}

function within(times: number[], windowMs: number): number[] {
	const cutoff = Date.now() - windowMs;
	return times.filter((time) => time > cutoff);
}

export function startServer(socketPath: string, deps: ServerDeps): ServerHandle {
	const buckets = new Map<string, Bucket>();
	const waiters = new Set<Waiter>();
	let server: Server | undefined;

	const write = (socket: Socket, response: Response) => {
		if (socket.destroyed) return;
		socket.write(`${JSON.stringify(response)}\n`);
	};

	const bucketFor = (sessionId: string): Bucket => {
		const bucket = buckets.get(sessionId) ?? { messages: [], wakes: [] };
		buckets.set(sessionId, bucket);
		return bucket;
	};

	const rateLimit = (sessionId: string, wake: boolean): { error: string; retryAfterMs: number } | undefined => {
		const bucket = bucketFor(sessionId);
		bucket.messages = within(bucket.messages, MESSAGE_RATE.windowMs);
		bucket.wakes = within(bucket.wakes, WAKE_RATE.windowMs);

		if (bucket.messages.length >= MESSAGE_RATE.count) {
			return {
				error: `rate limited: ${MESSAGE_RATE.count} messages per minute`,
				retryAfterMs: MESSAGE_RATE.windowMs - (Date.now() - bucket.messages[0]),
			};
		}
		if (wake && bucket.wakes.length >= WAKE_RATE.count) {
			return {
				error: `rate limited: ${WAKE_RATE.count} wakes per minute`,
				retryAfterMs: WAKE_RATE.windowMs - (Date.now() - bucket.wakes[0]),
			};
		}

		bucket.messages.push(Date.now());
		if (wake) bucket.wakes.push(Date.now());
		return undefined;
	};

	const settleWaiter = (waiter: Waiter, timedOut: boolean) => {
		if (!waiters.delete(waiter)) return;
		clearInterval(waiter.progress);
		clearTimeout(waiter.timer);
		const collected = deps.collectReply(waiter.markerTs);
		write(waiter.socket, {
			id: waiter.id,
			ok: true,
			reply: collected.reply,
			settledAt: collected.settledAt,
			timedOut,
			type: "result",
			userInterjected: collected.userInterjected,
		});
	};

	const admit = async (
		request: Request & { type: "ask" | "inject" },
		socket: Socket,
	): Promise<{ deliver: DeliveryMode; text: string; truncated: boolean; wake: boolean } | undefined> => {
		const mode = deps.inboxMode();
		const requestedWake = request.type === "ask" ? true : request.wake;

		if (mode === "off") {
			write(socket, { error: "peer inbox is closed", id: request.id, ok: false, type: "result" });
			deps.log({ at: Date.now(), detail: "rejected: inbox off", direction: "in", kind: request.type, ok: false, peer: request.from.name ?? request.from.sessionId });
			return undefined;
		}

		const limited = rateLimit(request.from.sessionId, requestedWake);
		if (limited) {
			write(socket, { error: limited.error, id: request.id, ok: false, retryAfterMs: limited.retryAfterMs, type: "result" });
			deps.log({ at: Date.now(), detail: limited.error, direction: "in", kind: request.type, ok: false, peer: request.from.name ?? request.from.sessionId });
			return undefined;
		}

		if (mode === "confirm" && !(await deps.confirm(request.from, request.text))) {
			write(socket, { error: "declined by the receiving session", id: request.id, ok: false, type: "result" });
			deps.log({ at: Date.now(), detail: "declined", direction: "in", kind: request.type, ok: false, peer: request.from.name ?? request.from.sessionId });
			return undefined;
		}

		const clamped = clampText(request.text);
		const queued = mode === "queue";
		return {
			deliver: queued ? "nextTurn" : request.type === "ask" ? "followUp" : request.deliver,
			text: clamped.text,
			truncated: clamped.truncated,
			wake: queued ? false : requestedWake,
		};
	};

	const handle = async (request: Request, socket: Socket) => {
		if (request.protocol !== PROTOCOL_VERSION) {
			write(socket, { error: `protocol mismatch: peer speaks ${PROTOCOL_VERSION}`, id: request.id, ok: false, type: "result" });
			return;
		}
		if (request.hops > MAX_HOPS) {
			write(socket, { error: `rejected: hop limit ${MAX_HOPS}`, id: request.id, ok: false, type: "result" });
			return;
		}

		const peerLabel = request.from.name ?? request.from.sessionId.slice(0, 8);

		switch (request.type) {
			case "hello": {
				write(socket, { id: request.id, identity: deps.identity(), ok: true, state: deps.state(), type: "result" });
				return;
			}

			case "state": {
				write(socket, { id: request.id, ok: true, presence: deps.presence(), state: deps.state(), type: "result" });
				return;
			}

			case "read": {
				const transcript = deps.transcript(request.mode, request.turns ?? 6, request.query);
				write(socket, { id: request.id, ok: true, transcript: transcript.text, truncated: transcript.truncated, type: "result" });
				return;
			}

			case "claim": {
				const claims = deps.claim(request.paths, request.intent, request.ttlMs);
				write(socket, { claims, id: request.id, ok: true, type: "result" });
				return;
			}

			case "release": {
				const claims = deps.release(request.paths);
				write(socket, { claims, id: request.id, ok: true, type: "result" });
				return;
			}

			case "inject": {
				const admitted = await admit(request, socket);
				if (!admitted) return;
				const queuedAs = deps.inject({
					deliver: admitted.deliver,
					from: request.from,
					hops: request.hops,
					text: admitted.text,
					wake: admitted.wake,
				});
				write(socket, { id: request.id, ok: true, queuedAs, state: deps.state(), truncated: admitted.truncated, type: "result" });
				deps.log({ at: Date.now(), detail: `delivered as ${queuedAs}`, direction: "in", kind: "inject", ok: true, peer: peerLabel, text: admitted.text });
				return;
			}

			case "ask": {
				const admitted = await admit(request, socket);
				if (!admitted) return;
				const markerTs = Date.now();
				const queuedAs = deps.inject({
					deliver: admitted.deliver,
					from: request.from,
					hops: request.hops,
					text: admitted.text,
					wake: admitted.wake,
				});
				deps.log({ at: Date.now(), detail: `ask delivered as ${queuedAs}`, direction: "in", kind: "ask", ok: true, peer: peerLabel, text: admitted.text });

				if (!admitted.wake) {
					write(socket, { deferred: true, id: request.id, ok: true, queuedAs, state: deps.state(), type: "result" });
					return;
				}

				const timeoutMs = Math.min(request.timeoutMs || ASK_TIMEOUT_MS, ASK_TIMEOUT_MS);
				const waiter: Waiter = {
					id: request.id,
					markerTs,
					progress: setInterval(() => write(socket, { id: request.id, ok: true, state: deps.state(), type: "progress" }), ASK_PROGRESS_INTERVAL_MS),
					socket,
					timer: setTimeout(() => settleWaiter(waiter, true), timeoutMs),
				};
				waiter.progress.unref?.();
				waiter.timer.unref?.();
				waiters.add(waiter);

				socket.on("close", () => {
					if (!waiters.delete(waiter)) return;
					clearInterval(waiter.progress);
					clearTimeout(waiter.timer);
				});
				return;
			}
		}
	};

	const onConnection = (socket: Socket) => {
		let buffer = "";
		socket.on("error", () => socket.destroy());
		socket.on("data", (chunk) => {
			buffer += chunk.toString();
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) break;
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (line.length === 0) continue;
				try {
					void handle(JSON.parse(line) as Request, socket);
				} catch {
					write(socket, { error: "malformed request", id: "unknown", ok: false, type: "result" });
				}
			}
		});
	};

	const listen = () => {
		try {
			unlinkSync(socketPath);
		} catch {}
		server = createServer(onConnection);
		server.on("error", () => {});
		server.listen(socketPath, () => {
			try {
				chmodSync(socketPath, 0o600);
			} catch {}
		});
	};

	listen();

	return {
		close: () => {
			for (const waiter of [...waiters]) {
				clearInterval(waiter.progress);
				clearTimeout(waiter.timer);
				waiter.socket.destroy();
			}
			waiters.clear();
			server?.close();
			server = undefined;
			try {
				unlinkSync(socketPath);
			} catch {}
		},
		notifySettled: () => {
			for (const waiter of [...waiters]) settleWaiter(waiter, false);
		},
		pendingAsks: () => waiters.size,
	};
}
