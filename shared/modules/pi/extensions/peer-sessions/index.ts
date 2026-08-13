import { type FSWatcher, watch } from "node:fs";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	truncateTail,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { describePeer, handshake, peerRequest, resolveTargets } from "./client.ts";
import {
	activeClaims,
	type Conflict,
	conflictKey,
	conflicts as computeConflicts,
	displayPath,
	FileTracker,
	toolPath,
} from "./files.ts";
import { renderJournal, renderLiveEntries } from "./journal.ts";
import {
	CLAIM_TTL_MS,
	type DeliveryMode,
	HEARTBEAT_INTERVAL_MS,
	INBOX_MODE,
	MAX_TEXT_BYTES,
	type PeerClaim,
	type PeerIdentity,
	type PeerState,
	PRESENCE_DEBOUNCE_MS,
	type PresenceRecord,
	PROTOCOL_VERSION,
	type TranscriptMode,
} from "./protocol.ts";
import {
	duplicateSessionFiles,
	type PeerView,
	presenceKey,
	processStartTicks,
	readPeers,
	registryDir,
	removePresence,
	socketPath,
	writePresence,
} from "./registry.ts";
import { type InboxLogEntry, type ServerHandle, startServer } from "./server.ts";
import { createPeersView, type PeersViewDeps, type PeersViewOutcome } from "./view.ts";
import { currentLocation, focus, refreshFocus } from "./zellij.ts";

const INBOX_LOG_LIMIT = 200;
const TRANSCRIPT_TURNS = 8;
const WATCH_DEBOUNCE_MS = 150;

export default function (pi: ExtensionAPI) {
	const inbox: InboxLogEntry[] = [];
	const reported = new Set<string>();
	const tracker = new FileTracker();

	let accepted = 0;
	let claims: PeerClaim[] = [];
	let context: { tokens: number; window: number } | undefined;
	let cwd = process.cwd();
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	let inboundHops = 0;
	let key = "";
	let lastAssistantAt: number | undefined;
	let lastFrom: string | undefined;
	let lastUserAt: number | undefined;
	let lastWrite = 0;
	let model: string | undefined;
	let name: string | undefined;
	let rejected = 0;
	let scheduled: ReturnType<typeof setTimeout> | undefined;
	let server: ServerHandle | undefined;
	let session: ExtensionContext | undefined;
	let sessionFile: string | null = null;
	let sessionId = "";
	let startTicks: number | null = null;
	let startedAt = Date.now();
	let state: PeerState = "idle";
	let thinking: string | undefined;
	let turn = 0;
	let watcher: FSWatcher | undefined;
	let watchTimer: ReturnType<typeof setTimeout> | undefined;

	const identity = (): PeerIdentity => ({ cwd, name, pid: process.pid, sessionId });

	const liveClaims = (): PeerClaim[] => claims.filter((claim) => claim.expiresAt > Date.now());

	const presence = (): PresenceRecord => ({
		claims: liveClaims(),
		context,
		cwd,
		files: tracker.snapshot(),
		inbox: { accepted, lastFrom, mode: INBOX_MODE, rejected },
		lastAssistantAt,
		lastUserAt,
		location: currentLocation(),
		model,
		name,
		pid: process.pid,
		protocol: PROTOCOL_VERSION,
		sessionFile,
		sessionId,
		socket: socketPath(key),
		startTicks,
		startedAt,
		state,
		thinking,
		turn,
		updatedAt: Date.now(),
	});

	const publish = (immediate = false) => {
		if (!key) return;
		const wait = immediate ? 0 : Math.max(0, PRESENCE_DEBOUNCE_MS - (Date.now() - lastWrite));
		if (wait === 0) {
			lastWrite = Date.now();
			try {
				writePresence(presence());
			} catch {}
			return;
		}
		if (scheduled) return;
		scheduled = setTimeout(() => {
			scheduled = undefined;
			publish();
		}, wait);
		scheduled.unref?.();
	};

	const peers = (): PeerView[] => readPeers(key);
	const others = (): PresenceRecord[] => peers().filter((peer) => !peer.self).map((peer) => peer.presence);
	const currentConflicts = (): Conflict[] => computeConflicts(tracker.snapshot(), others());

	const conflictReport = (list: Conflict[]): string => {
		const lines = list.map((conflict) => {
			const label = conflict.peer.name ?? conflict.peer.sessionId.slice(0, 8);
			return `  ${displayPath(conflict.path, cwd)}   you ${conflict.mineKind} ${clock(conflict.mineAt)}, ${label} wrote ${clock(conflict.peerAt)}`;
		});
		const sessions = [...new Set(list.map((conflict) => conflict.peer.name ?? conflict.peer.sessionId.slice(0, 8)))];
		return [
			"[peer file conflict]",
			"",
			`${sessions.join(", ")} modified ${list.length} file(s) you have in context:`,
			"",
			...lines,
			"",
			`Re-read before editing. peer_read ${list[0].peer.sessionId.slice(0, 8)} shows what they are doing.`,
		].join("\n");
	};

	const updateChrome = (views: PeerView[], list: Conflict[]) => {
		if (!session?.hasUI) return;
		const live = views.filter((peer) => !peer.self && !peer.stale).length;
		const working = views.filter((peer) => !peer.self && peer.presence.state === "working").length;
		session.ui.setStatus(
			"peers",
			live === 0 && list.length === 0
				? undefined
				: `${session.ui.theme.fg("dim", "peers")} ${live}${working > 0 ? ` ⚡${working}` : ""}${list.length > 0 ? ` ${session.ui.theme.fg("warning", `⚠${list.length}`)}` : ""}`,
		);
		session.ui.setWidget(
			"peer-conflict",
			list.length === 0
				? undefined
				: [
						session.ui.theme.fg(
							"warning",
							`⚠ ${list.length} file(s) also modified by ${[...new Set(list.map((conflict) => conflict.peer.name ?? conflict.peer.sessionId.slice(0, 8)))].join(", ")}: ${list
								.slice(0, 3)
								.map((conflict) => displayPath(conflict.path, cwd))
								.join(", ")}`,
						),
					],
		);
	};

	const syncPeers = () => {
		const views = peers();
		const list = computeConflicts(tracker.snapshot(), views.filter((peer) => !peer.self).map((peer) => peer.presence));
		updateChrome(views, list);

		const fresh = list.filter((conflict) => !reported.has(conflictKey(conflict)));
		if (fresh.length === 0) return;
		for (const conflict of fresh) reported.add(conflictKey(conflict));

		pi.sendMessage(
			{
				content: conflictReport(fresh),
				customType: "peer-conflict",
				details: { conflicts: fresh.map((conflict) => ({ path: conflict.path, peer: conflict.peer.sessionId })) },
				display: true,
			},
			{ deliverAs: "nextTurn" },
		);
		session?.ui.notify(`peer modified ${fresh.length} file(s) you touched`, "warning");
	};

	const log = (entry: InboxLogEntry) => {
		inbox.push(entry);
		if (inbox.length > INBOX_LOG_LIMIT) inbox.shift();
	};

	const localTranscript = (mode: TranscriptMode, turns: number, query?: string) => {
		const header = `peer ${sessionId.slice(0, 8)} · ${name ?? "unnamed"} · ${cwd}`;
		if (sessionFile) return renderJournal({ cwd, file: sessionFile, header, mode, query, turns });
		return renderLiveEntries({ cwd, entries: session?.sessionManager.getBranch() ?? [], header, turns });
	};

	const collectReply = (markerTs: number) => {
		const texts: string[] = [];
		let settledAt = 0;
		let userInterjected = false;

		for (const entry of session?.sessionManager.getBranch() ?? []) {
			if (entry.type !== "message") continue;
			const message = entry.message as { content?: unknown; role?: string; timestamp?: number };
			const at = message.timestamp ?? Date.parse((entry as { timestamp?: string }).timestamp ?? "") ?? 0;
			if (!at || at <= markerTs) continue;
			if (message.role === "user") userInterjected = true;
			if (message.role !== "assistant") continue;
			const blocks = Array.isArray(message.content) ? (message.content as { text?: string; type: string }[]) : [];
			const text = blocks
				.filter((block) => block.type === "text")
				.map((block) => block.text ?? "")
				.join("\n")
				.trim();
			if (text) {
				texts.push(text);
				settledAt = at;
			}
		}

		const truncation = truncateTail(texts.join("\n\n"), { maxBytes: MAX_TEXT_BYTES, maxLines: 400 });
		return { reply: truncation.content, settledAt: settledAt || Date.now(), userInterjected };
	};

	const startPresence = (ctx: ExtensionContext) => {
		session = ctx;
		cwd = ctx.cwd;
		sessionId = ctx.sessionManager.getSessionId();
		sessionFile = ctx.sessionManager.getSessionFile() ?? null;
		key = presenceKey(sessionId, process.pid);
		startedAt = Date.now();
		startTicks = processStartTicks(process.pid);
		name = pi.getSessionName();
		model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
		thinking = ctx.thinkingLevel;
		state = "idle";
		turn = 0;
		claims = [];
		accepted = 0;
		rejected = 0;
		lastFrom = undefined;
		lastUserAt = undefined;
		lastAssistantAt = undefined;
		tracker.reset();
		reported.clear();
		inbox.length = 0;

		lastWrite = 0;
		publish();

		server = startServer(socketPath(key), {
			claim: (paths, intent, ttlMs) => {
				claims = [...liveClaims(), { expiresAt: Date.now() + ttlMs, intent, paths }];
				publish();
				return liveClaims();
			},
			collectReply,
			confirm: async (from, text) =>
				session?.hasUI
					? await session.ui.confirm(`Message from ${from.name ?? from.sessionId.slice(0, 8)}`, text)
					: false,
			identity,
			inboxMode: () => INBOX_MODE,
			inject: ({ deliver, from, hops, text, wake }) => {
				const label = from.name ?? from.sessionId.slice(0, 8);
				pi.sendMessage(
					{
						content: `[peer session · ${label} · ${from.cwd}]\n\n${text}\n\nReply with peer_send to session ${from.sessionId.slice(0, 8)} if the peer needs an answer.`,
						customType: "peer-message",
						details: { from, hops },
						display: true,
					},
					{ deliverAs: deliver, triggerTurn: wake },
				);
				accepted++;
				lastFrom = from.sessionId;
				inboundHops = Math.max(inboundHops, hops);
				publish(true);
				session?.ui.notify(`peer message from ${label}`, "info");
				return deliver;
			},
			log: (entry) => {
				if (!entry.ok) rejected++;
				log(entry);
			},
			presence,
			release: (paths) => {
				claims = liveClaims().filter((claim) => !claim.paths.some((path) => paths.includes(path)));
				publish();
				return liveClaims();
			},
			state: () => state,
			transcript: localTranscript,
		});

		heartbeat = setInterval(() => {
			publish();
			syncPeers();
		}, HEARTBEAT_INTERVAL_MS);
		heartbeat.unref?.();

		try {
			watcher = watch(registryDir(), () => {
				if (watchTimer) return;
				watchTimer = setTimeout(() => {
					watchTimer = undefined;
					syncPeers();
				}, WATCH_DEBOUNCE_MS);
				watchTimer.unref?.();
			});
		} catch {}

		syncPeers();
	};

	const stopPresence = () => {
		server?.close();
		server = undefined;
		if (heartbeat) clearInterval(heartbeat);
		heartbeat = undefined;
		if (scheduled) clearTimeout(scheduled);
		scheduled = undefined;
		watcher?.close();
		watcher = undefined;
		if (key) removePresence(key);
		if (session?.hasUI) {
			session.ui.setStatus("peers", undefined);
			session.ui.setWidget("peer-conflict", undefined);
		}
		session = undefined;
		key = "";
	};

	const target = (query: string): { error?: string; peer?: PeerView } => {
		const views = peers();
		const matches = resolveTargets(query, views);
		if (matches.length === 1) return { peer: matches[0] };
		if (matches.length === 0) {
			const live = views.filter((peer) => !peer.self);
			return {
				error:
					live.length === 0
						? "no other live pi sessions"
						: `no session matches "${query}". live: ${live.map(describePeer).join(", ")}`,
			};
		}
		return { error: `"${query}" is ambiguous: ${matches.map(describePeer).join(", ")}` };
	};

	const sendTo = async (peer: PeerView, text: string, deliver: DeliveryMode, wake: boolean): Promise<string> => {
		const response = await peerRequest(peer, identity(), { deliver, text, type: "inject", wake }, { hops: inboundHops + 1 });
		const label = peer.presence.name ?? peer.presence.sessionId.slice(0, 8);
		log({
			at: Date.now(),
			detail: response.ok ? `delivered as ${response.queuedAs}` : (response.error ?? "failed"),
			direction: "out",
			kind: "inject",
			ok: response.ok,
			peer: label,
			text,
		});
		if (!response.ok) return `not delivered to ${label}: ${response.error}`;
		return `delivered to ${label} as ${response.queuedAs}${response.truncated ? " (text truncated)" : ""}`;
	};

	const askPeer = async (
		peer: PeerView,
		text: string,
		options: { onProgress?: (seconds: number) => void; signal?: AbortSignal; timeoutMs: number },
	): Promise<string> => {
		const started = Date.now();
		const response = await peerRequest(
			peer,
			identity(),
			{ text, timeoutMs: options.timeoutMs, type: "ask" },
			{
				hops: inboundHops + 1,
				onProgress: () => options.onProgress?.(Math.round((Date.now() - started) / 1000)),
				signal: options.signal,
				timeoutMs: options.timeoutMs + 5_000,
			},
		);
		const label = peer.presence.name ?? peer.presence.sessionId.slice(0, 8);
		log({
			at: Date.now(),
			detail: response.ok ? (response.deferred ? "queued, no reply" : "replied") : (response.error ?? "failed"),
			direction: "out",
			kind: "ask",
			ok: response.ok,
			peer: label,
			text,
		});

		if (!response.ok) return `ask failed for ${label}: ${response.error}`;
		if (response.deferred) return `${label} queued the question (inbox mode ${peer.presence.inbox?.mode}), no reply yet`;
		const notes = [
			response.timedOut ? "timed out, partial reply" : undefined,
			response.userInterjected ? "a human typed in that session during the answer" : undefined,
		].filter(Boolean);
		return `${label} replied${notes.length > 0 ? ` (${notes.join("; ")})` : ""}:\n\n${response.reply || "(no text)"}`;
	};

	const readPeer = async (peer: PeerView, mode: TranscriptMode, turns: number, query?: string): Promise<string> => {
		const header = `peer ${peer.presence.sessionId.slice(0, 8)} · ${peer.presence.name ?? "unnamed"} · ${displayPath(peer.presence.cwd, cwd)} · ${peer.presence.state}`;
		if (peer.presence.sessionFile) {
			return renderJournal({ cwd, file: peer.presence.sessionFile, header, mode, query, turns }).text;
		}
		const response = await peerRequest(peer, identity(), { mode, query, turns, type: "read" });
		return response.ok ? (response.transcript ?? "") : `could not read ${describePeer(peer)}: ${response.error}`;
	};

	const listPeers = (includeStale: boolean): string => {
		const all = peers();
		const views = all.filter((peer) => !peer.self && (includeStale || !peer.stale));
		if (views.length === 0) return "no other live pi sessions";
		const shared = duplicateSessionFiles(all);

		const lines = views.map((peer) => {
			const { presence: record } = peer;
			const parts = [
				peer.stale ? `stale ${age(Date.now() - record.updatedAt)}` : record.state,
				record.name ?? record.sessionId.slice(0, 8),
				record.sessionId.slice(0, 8),
				displayPath(record.cwd, cwd),
				record.model ?? "-",
				record.context?.window ? `ctx ${Math.round((record.context.tokens / record.context.window) * 100)}%` : "ctx -",
				`turn ${record.turn}`,
				`${record.files?.modified?.length ?? 0} modified`,
				record.location?.zellijSession ? `${record.location.zellijSession}:${record.location.zellijPane}` : "-",
				record.sessionFile && shared.has(record.sessionFile) ? "shares its session file with another live session" : undefined,
			].filter((part): part is string => typeof part === "string");
			return `- ${parts.join(" · ")}`;
		});

		const conflicts = currentConflicts();
		return [
			`${views.length} peer session(s):`,
			...lines,
			conflicts.length > 0
				? `\n${conflicts.length} file conflict(s) with this session, see peer_files`
				: "\nno file conflicts with this session",
		].join("\n");
	};

	const viewDeps = (): PeersViewDeps => ({
		ask: (peer, text) => askPeer(peer, text, { timeoutMs: 300_000 }),
		claims: () => activeClaims(others()),
		conflicts: currentConflicts,
		cwd,
		focus: (peer) => focus(peer.presence.location),
		inbox: () => inbox,
		load: peers,
		mine: () => tracker.snapshot(),
		probe: async (peer) => {
			const result = await handshake(peer, identity());
			return result.ok ? `socket ok ${result.latencyMs}ms` : `unresponsive: ${result.error}`;
		},
		prune: (keys) => {
			for (const stale of keys) removePresence(stale);
			return keys.length;
		},
		read: (peer, turns) => readPeer(peer, "tail", turns),
		refreshFocus: async (views) => {
			const sessions = [
				...new Set(
					views
						.map((peer) => peer.presence.location?.zellijSession)
						.filter((value): value is string => typeof value === "string"),
				),
			];
			const panes = await refreshFocus(sessions);
			const focused = new Set<string>();
			for (const [zellijSession, ids] of panes) for (const id of ids) focused.add(`${zellijSession}:${id}`);
			return focused;
		},
		release: async () => {
			const count = liveClaims().length;
			claims = [];
			publish();
			return count > 0 ? `released ${count} claim(s) held by this session` : "this session holds no claims";
		},
		send: sendTo,
		watch: (onChange) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			let handle: FSWatcher | undefined;
			try {
				handle = watch(registryDir(), () => {
					if (timer) return;
					timer = setTimeout(() => {
						timer = undefined;
						onChange();
					}, WATCH_DEBOUNCE_MS);
					timer.unref?.();
				});
			} catch {}
			return () => {
				if (timer) clearTimeout(timer);
				handle?.close();
			};
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		stopPresence();
		startPresence(ctx);
	});

	pi.on("session_shutdown", async () => {
		stopPresence();
	});

	pi.on("agent_start", async () => {
		state = "working";
		publish();
	});

	pi.on("agent_settled", async (_event, ctx) => {
		state = ctx.hasPendingMessages() ? "queued" : "idle";
		context = usage(ctx);
		publish();
		server?.notifySettled();
	});

	pi.on("turn_end", async (_event, ctx) => {
		turn++;
		context = usage(ctx);
		publish();
	});

	pi.on("message_end", async (event) => {
		const role = (event.message as { role?: string }).role;
		if (role === "user") {
			lastUserAt = Date.now();
			inboundHops = 0;
		}
		if (role === "assistant") lastAssistantAt = Date.now();
		publish();
	});

	pi.on("model_select", async (event) => {
		model = `${event.model.provider}/${event.model.id}`;
		publish();
	});

	pi.on("thinking_level_select", async (event) => {
		thinking = event.level;
		publish();
	});

	pi.on("session_info_changed", async (event) => {
		name = event.name;
		publish();
	});

	pi.on("tool_result", async (event) => {
		if (event.isError) return;
		const kind =
			event.toolName === "read" ? "read" : event.toolName === "edit" || event.toolName === "write" ? "modified" : undefined;
		if (!kind) return;
		const path = toolPath(cwd, (event as { input?: { path?: unknown } }).input?.path);
		if (!path) return;
		if (!tracker.record(kind, path, turn)) return;
		publish(kind === "modified");
		if (kind === "modified") syncPeers();
	});

	pi.registerMessageRenderer("peer-message", (message, { expanded, outputPad }, theme) => {
		const details = message.details as { from?: PeerIdentity; hops?: number } | undefined;
		const label = details?.from?.name ?? details?.from?.sessionId?.slice(0, 8) ?? "peer";
		const body = typeof message.content === "string" ? message.content : "";
		const text = expanded ? body : body.split("\n").slice(0, 6).join("\n");
		return new Text(
			`${theme.fg("accent", "⇄ ")}${theme.fg("toolTitle", theme.bold(`peer ${label} `))}${theme.fg("dim", details?.from?.cwd ?? "")}\n${text}`,
			outputPad,
			0,
		);
	});

	pi.registerMessageRenderer("peer-conflict", (message, { outputPad }, theme) => {
		const body = typeof message.content === "string" ? message.content : "";
		return new Text(theme.fg("warning", body), outputPad, 0);
	});

	pi.registerTool({
		description: "List live pi sessions on this machine with state, model, context use, files modified and terminal location.",
		label: "Peer List",
		name: "peer_list",
		parameters: Type.Object({
			includeStale: Type.Optional(Type.Boolean({ description: "Include sessions whose heartbeat is stale" })),
		}),
		promptGuidelines: [
			"Use peer_list when work may overlap with another pi session, before editing shared files, or when the user mentions another session.",
		],
		promptSnippet: "List other live pi sessions and their state",
		async execute(_toolCallId, params) {
			return { content: [{ type: "text", text: listPeers(params.includeStale === true) }], details: {} };
		},
	});

	pi.registerTool({
		description:
			"Read another live pi session's conversation. Renders user and assistant text with one-line tool summaries, never raw tool output.",
		label: "Peer Read",
		name: "peer_read",
		parameters: Type.Object({
			mode: Type.Optional(StringEnum(["full", "search", "tail"] as const)),
			query: Type.Optional(Type.String({ description: "Search text, required for mode search" })),
			target: Type.String({ description: "Session id prefix, name or working directory of the peer" }),
			turns: Type.Optional(Type.Integer({ description: "Turns to include for tail mode", maximum: 50, minimum: 1 })),
		}),
		promptGuidelines: ["Use peer_read to learn what another pi session is doing before coordinating with peer_send."],
		promptSnippet: "Read another live pi session's conversation",
		async execute(_toolCallId, params) {
			const found = target(params.target);
			if (!found.peer) return { content: [{ type: "text", text: found.error ?? "" }], details: {} };
			const text = await readPeer(found.peer, params.mode ?? "tail", params.turns ?? TRANSCRIPT_TURNS, params.query);
			return { content: [{ type: "text", text }], details: {} };
		},
	});

	pi.registerTool({
		description:
			"Send text into another live pi session. deliver nextTurn waits for that user's next prompt, followUp lands after its current run, steer interrupts after the current tool batch. wake starts a turn in an idle session.",
		label: "Peer Send",
		name: "peer_send",
		parameters: Type.Object({
			deliver: Type.Optional(StringEnum(["followUp", "nextTurn", "steer"] as const)),
			target: Type.String({ description: "Session id prefix, name or working directory of the peer" }),
			text: Type.String({ description: "Message for the other session" }),
			wake: Type.Optional(Type.Boolean({ description: "Start a turn in the peer if it is idle" })),
		}),
		promptGuidelines: [
			"Use peer_send to tell another pi session something it must know, for example that you are editing a file it also touches.",
		],
		promptSnippet: "Send a message into another live pi session",
		async execute(_toolCallId, params) {
			const found = target(params.target);
			if (!found.peer) return { content: [{ type: "text", text: found.error ?? "" }], details: {} };
			const text = await sendTo(found.peer, params.text, params.deliver ?? "followUp", params.wake === true);
			return { content: [{ type: "text", text }], details: {} };
		},
	});

	pi.registerTool({
		description:
			"Ask another live pi session a question and wait for its next reply. Returns the peer's assistant text, or a partial answer on timeout.",
		label: "Peer Ask",
		name: "peer_ask",
		parameters: Type.Object({
			target: Type.String({ description: "Session id prefix, name or working directory of the peer" }),
			text: Type.String({ description: "Question for the other session" }),
			timeoutSeconds: Type.Optional(Type.Integer({ maximum: 300, minimum: 5 })),
		}),
		promptGuidelines: ["Use peer_ask when another pi session holds knowledge you need before continuing."],
		promptSnippet: "Ask another live pi session a question and wait for the reply",
		async execute(_toolCallId, params, signal, onUpdate) {
			const found = target(params.target);
			if (!found.peer) return { content: [{ type: "text", text: found.error ?? "" }], details: {} };
			const text = await askPeer(found.peer, params.text, {
				onProgress: (seconds) => onUpdate?.({ content: [{ type: "text", text: `peer working, ${seconds}s` }] }),
				signal,
				timeoutMs: (params.timeoutSeconds ?? 120) * 1000,
			});
			return { content: [{ type: "text", text }], details: {} };
		},
	});

	pi.registerTool({
		description:
			"Show files other live pi sessions have modified, and where that collides with files this session has read or written.",
		label: "Peer Files",
		name: "peer_files",
		parameters: Type.Object({
			conflictsOnly: Type.Optional(Type.Boolean()),
			target: Type.Optional(Type.String({ description: "Limit to one peer" })),
		}),
		promptGuidelines: [
			"Use peer_files before editing a file that another session may own, and after a peer file conflict message.",
		],
		promptSnippet: "Show files other pi sessions modified and any conflicts",
		async execute(_toolCallId, params) {
			const conflicts = currentConflicts();
			const scoped = params.target
				? (() => {
						const found = target(params.target);
						return found.peer ? [found.peer.presence] : [];
					})()
				: others();

			const conflictLines = conflicts
				.filter((conflict) => scoped.some((peer) => peer.sessionId === conflict.peer.sessionId))
				.map(
					(conflict) =>
						`- ${displayPath(conflict.path, cwd)} · you ${conflict.mineKind} ${clock(conflict.mineAt)} · ${conflict.peer.name ?? conflict.peer.sessionId.slice(0, 8)} wrote ${clock(conflict.peerAt)}`,
				);

			if (params.conflictsOnly === true) {
				return {
					content: [{ type: "text", text: conflictLines.length > 0 ? `conflicts:\n${conflictLines.join("\n")}` : "no conflicts" }],
					details: {},
				};
			}

			const peerLines = scoped.flatMap((peer) => {
				const label = peer.name ?? peer.sessionId.slice(0, 8);
				const modified = (peer.files?.modified ?? []).slice(0, 20);
				if (modified.length === 0) return [`- ${label}: no files modified`];
				return [
					`- ${label} (${displayPath(peer.cwd, cwd)}):`,
					...modified.map((touch) => `    ${displayPath(touch.path, cwd)} ${clock(touch.at)}`),
				];
			});

			const claimLines = activeClaims(scoped).map(
				({ claim, peer }) =>
					`- ${peer.name ?? peer.sessionId.slice(0, 8)} claims ${claim.paths.map((path) => displayPath(path, cwd)).join(", ")} (${claim.intent}, ${age(claim.expiresAt - Date.now())} left)`,
			);

			return {
				content: [
					{
						type: "text",
						text: [
							peerLines.length > 0 ? `peer files:\n${peerLines.join("\n")}` : "no peer files recorded",
							conflictLines.length > 0 ? `\nconflicts:\n${conflictLines.join("\n")}` : "\nno conflicts",
							claimLines.length > 0 ? `\nclaims:\n${claimLines.join("\n")}` : "",
						].join("\n"),
					},
				],
				details: {},
			};
		},
	});

	pi.registerTool({
		description:
			"Declare that this session is working on specific files so other pi sessions can see it, or release previous declarations.",
		label: "Peer Claim",
		name: "peer_claim",
		parameters: Type.Object({
			intent: Type.Optional(Type.String({ description: "What this session is doing with the files" })),
			minutes: Type.Optional(Type.Integer({ maximum: 240, minimum: 1 })),
			paths: Type.Array(Type.String(), { description: "Files this session is working on" }),
			release: Type.Optional(Type.Boolean({ description: "Release the listed paths instead of claiming them" })),
		}),
		promptGuidelines: ["Use peer_claim before a long multi-file edit while other pi sessions are live."],
		promptSnippet: "Claim or release files so other pi sessions know what you are editing",
		async execute(_toolCallId, params) {
			const paths = params.paths.map((path) => toolPath(cwd, path)).filter((path): path is string => typeof path === "string");
			if (paths.length === 0) return { content: [{ type: "text", text: "no valid paths" }], details: {} };

			if (params.release === true) {
				claims = liveClaims().filter((claim) => !claim.paths.some((path) => paths.includes(path)));
				publish();
				return { content: [{ type: "text", text: `released ${paths.length} path(s)` }], details: {} };
			}

			claims = [
				...liveClaims(),
				{
					expiresAt: Date.now() + (params.minutes ? params.minutes * 60_000 : CLAIM_TTL_MS),
					intent: params.intent ?? "working",
					paths,
				},
			];
			publish();

			const rival = activeClaims(others()).filter(({ claim }) => claim.paths.some((path) => paths.includes(path)));
			const warning =
				rival.length > 0
					? `\nalready claimed by ${rival.map(({ claim, peer }) => `${peer.name ?? peer.sessionId.slice(0, 8)} (${claim.intent})`).join(", ")}`
					: "";
			return {
				content: [{ type: "text", text: `claimed ${paths.map((path) => displayPath(path, cwd)).join(", ")}${warning}` }],
				details: {},
			};
		},
	});

	pi.registerCommand("peers", {
		description: "Live status of other pi sessions: state, files, conflicts, claims and cross-talk",
		getArgumentCompletions: (prefix) => {
			const items = peers()
				.filter((peer) => !peer.self)
				.map((peer) => ({
					description: `${peer.presence.state} · ${displayPath(peer.presence.cwd, cwd)}`,
					label: peer.presence.name ?? peer.presence.sessionId.slice(0, 8),
					value: peer.presence.name ?? peer.presence.sessionId.slice(0, 8),
				}))
				.filter((item) => item.value.toLowerCase().startsWith(prefix.toLowerCase()));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify(listPeers(false), "info");
				return;
			}

			let initialTarget = args.trim() || undefined;
			for (;;) {
				const outcome = await ctx.ui.custom<PeersViewOutcome>((tui, theme, _keybindings, done) =>
					createPeersView({ deps: viewDeps(), done, initialTarget, theme, tui }),
				);
				if (!outcome?.compose) return;

				const peer = outcome.compose;
				const text = await ctx.ui.editor(`Message to ${describePeer(peer)}`, "");
				if (text?.trim()) ctx.ui.notify(await sendTo(peer, text, "followUp", false), "info");
				initialTarget = peer.presence.sessionId;
			}
		},
	});
}

function age(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "-";
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

function clock(at: number | undefined): string {
	if (!at) return "-";
	const date = new Date(at);
	return `${`${date.getHours()}`.padStart(2, "0")}:${`${date.getMinutes()}`.padStart(2, "0")}`;
}

function usage(ctx: ExtensionContext): { tokens: number; window: number } | undefined {
	const current = ctx.getContextUsage();
	if (!current) return undefined;
	const window = current.contextWindow ?? ctx.model?.contextWindow;
	return window ? { tokens: current.tokens, window } : undefined;
}
