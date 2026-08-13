import { connect } from "node:net";
import {
	HANDSHAKE_TIMEOUT_MS,
	newRequestId,
	type PeerIdentity,
	PROTOCOL_VERSION,
	REQUEST_TIMEOUT_MS,
	type Request,
	type Response,
} from "./protocol.ts";
import type { PeerView } from "./registry.ts";

type RequestBody = Omit<Request, "at" | "from" | "hops" | "id" | "protocol">;

export interface RequestOptions {
	hops?: number;
	onProgress?: (response: Response) => void;
	signal?: AbortSignal;
	timeoutMs?: number;
}

export function resolveTargets(query: string, peers: PeerView[]): PeerView[] {
	const candidates = peers.filter((peer) => !peer.self);
	const needle = query.trim().toLowerCase();
	if (needle.length === 0) return candidates;

	const matchers: ((peer: PeerView) => boolean)[] = [
		(peer) => peer.presence.sessionId === needle || `${peer.presence.pid}` === needle,
		(peer) => peer.presence.sessionId.startsWith(needle),
		(peer) => (peer.presence.name ?? "").toLowerCase().includes(needle),
		(peer) => peer.presence.cwd.toLowerCase().includes(needle),
	];

	for (const matcher of matchers) {
		const matches = candidates.filter(matcher);
		if (matches.length > 0) return matches;
	}

	return [];
}

export function describePeer(peer: PeerView): string {
	const name = peer.presence.name ?? peer.presence.sessionId.slice(0, 8);
	return `${name} (${peer.presence.sessionId.slice(0, 8)}, pid ${peer.presence.pid})`;
}

function sendRequest(socketPath: string, payload: Request, options: RequestOptions): Promise<Response> {
	const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

	return new Promise((resolve) => {
		const socket = connect(socketPath);
		let buffer = "";
		let settled = false;

		const finish = (response: Response) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			resolve(response);
		};

		const fail = (error: string) => finish({ error, id: payload.id, ok: false, type: "result" });
		const timer = setTimeout(() => fail(`timed out after ${Math.round(timeoutMs / 1000)}s`), timeoutMs);

		options.signal?.addEventListener("abort", () => fail("aborted"), { once: true });

		socket.on("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
		socket.on("error", (error: NodeJS.ErrnoException) => fail(error.code ?? error.message));
		socket.on("close", () => fail("connection closed by peer"));
		socket.on("data", (chunk) => {
			buffer += chunk.toString();
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) break;
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (line.length === 0) continue;
				try {
					const response = JSON.parse(line) as Response;
					if (response.type === "progress") options.onProgress?.(response);
					else finish(response);
				} catch {}
			}
		});
	});
}

export function peerRequest(
	peer: PeerView,
	identity: PeerIdentity,
	body: RequestBody,
	options: RequestOptions = {},
): Promise<Response> {
	const payload = {
		...body,
		at: Date.now(),
		from: identity,
		hops: options.hops ?? 1,
		id: newRequestId(),
		protocol: PROTOCOL_VERSION,
	} as Request;
	return sendRequest(peer.presence.socket, payload, options);
}

export async function handshake(peer: PeerView, identity: PeerIdentity): Promise<{ latencyMs: number; ok: boolean; error?: string }> {
	const started = Date.now();
	const response = await peerRequest(peer, identity, { type: "hello" }, { timeoutMs: HANDSHAKE_TIMEOUT_MS });
	return { error: response.error, latencyMs: Date.now() - started, ok: response.ok };
}
