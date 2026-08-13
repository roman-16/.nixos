import { rawKeyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, CURSOR_MARKER, Key, matchesKey, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type Conflict, displayPath, type FileSnapshot } from "./files.ts";
import type { DeliveryMode, PresenceRecord } from "./protocol.ts";
import { duplicateSessionFiles, type PeerView } from "./registry.ts";
import type { InboxLogEntry } from "./server.ts";
import { type ColumnSpec, formatAge, formatClock, renderTable, shortenPath, type TableRow } from "./table.ts";

const DELIVERY_CYCLE: DeliveryMode[] = ["followUp", "steer", "nextTurn"];
const FOCUS_REFRESH_MS = 5_000;
const TABS = ["Sessions", "Files", "Conflicts", "Claims", "Inbox"];
const TICK_MS = 2_000;

export interface PeersViewDeps {
	ask(peer: PeerView, text: string): Promise<string>;
	claims(): { claim: PresenceRecord["claims"][number]; peer: PresenceRecord }[];
	conflicts(): Conflict[];
	cwd: string;
	focus(peer: PeerView): Promise<string>;
	inbox(): InboxLogEntry[];
	load(): PeerView[];
	mine(): FileSnapshot;
	probe(peer: PeerView): Promise<string>;
	prune(keys: string[]): number;
	read(peer: PeerView, turns: number): Promise<string>;
	refreshFocus(peers: PeerView[]): Promise<Set<string>>;
	release(peer: PeerView): Promise<string>;
	send(peer: PeerView, text: string, deliver: DeliveryMode, wake: boolean): Promise<string>;
	watch(onChange: () => void): () => void;
}

export type PeersViewOutcome = { compose: PeerView } | undefined;

interface Composer {
	deliver: DeliveryMode;
	cursor: number;
	mode: "ask" | "send";
	target: PeerView;
	text: string;
	wake: boolean;
}

interface Pager {
	lines: string[];
	scroll: number;
	title: string;
}

function stateIcon(peer: PeerView): string {
	if (peer.stale) return "✗";
	if (peer.presence.state === "working") return "⚡";
	return peer.presence.state === "queued" ? "⇢" : "◦";
}

function stateLabel(peer: PeerView): string {
	if (peer.self) return "◈ this session";
	const age = formatAge(Date.now() - peer.presence.updatedAt);
	if (peer.stale) return `${stateIcon(peer)} stale ${age}`;
	if (peer.presence.state === "working") return `${stateIcon(peer)} working`;
	if (peer.presence.state === "queued") return `${stateIcon(peer)} queued`;
	return `${stateIcon(peer)} idle ${formatAge(Date.now() - (peer.presence.lastAssistantAt ?? peer.presence.updatedAt))}`;
}

function modelLabel(presence: PresenceRecord): string {
	const model = presence.model ?? "";
	const id = model.slice(model.indexOf("/") + 1);
	return id.startsWith("claude-") ? id.slice("claude-".length) : id;
}

function contextLabel(presence: PresenceRecord): string {
	if (!presence.context?.window) return "-";
	return `${Math.round((presence.context.tokens / presence.context.window) * 100)}%`;
}

function whereLabel(peer: PeerView, focused: boolean): string {
	const { location } = peer.presence;
	if (!location?.zellijSession) return location?.term ?? "-";
	return `${location.zellijSession.slice(0, 8)}:${location.zellijPane ?? "?"}${focused ? " ◉" : ""}`;
}

function printable(data: string): string {
	if (data.length === 0 || data.startsWith("\x1b")) return "";
	let text = "";
	for (const char of data) {
		const code = char.codePointAt(0) ?? 0;
		if (code >= 0x20 && code !== 0x7f) text += char;
	}
	return text;
}

export function createPeersView(options: {
	deps: PeersViewDeps;
	done: (outcome: PeersViewOutcome) => void;
	initialTarget?: string;
	theme: Theme;
	tui: TUI;
}): Component {
	const { deps, done, theme, tui } = options;

	let peers = deps.load();
	let conflicts = deps.conflicts();
	let composer: Composer | undefined;
	let filter = "";
	let lastWidth = 80;
	let filtering = false;
	let focusedPanes = new Set<string>();
	let message: string | undefined;
	let pager: Pager | undefined;
	let selected = 0;
	let sortRecent = false;
	let tab = 0;
	let updatedAt = Date.now();
	const busy = new Map<string, string>();
	const scroll = TABS.map(() => 0);

	if (options.initialTarget) {
		const index = peers.findIndex(
			(peer) =>
				peer.presence.sessionId.startsWith(options.initialTarget ?? "") ||
				(peer.presence.name ?? "").toLowerCase().includes((options.initialTarget ?? "").toLowerCase()),
		);
		if (index >= 0) selected = index;
	}

	const rows = (): PeerView[] => {
		const needle = filter.trim().toLowerCase();
		const visible = peers.filter(
			(peer) =>
				needle.length === 0 ||
				`${peer.presence.name ?? ""} ${peer.presence.cwd} ${peer.presence.state}`.toLowerCase().includes(needle),
		);
		return sortRecent ? [...visible].sort((left, right) => right.presence.updatedAt - left.presence.updatedAt) : visible;
	};

	const current = (): PeerView | undefined => rows()[Math.min(selected, Math.max(0, rows().length - 1))];

	const isFocused = (peer: PeerView): boolean => {
		const { location } = peer.presence;
		if (!location?.zellijSession || location.zellijPane === undefined) return false;
		return focusedPanes.has(`${location.zellijSession}:${location.zellijPane}`);
	};

	const reload = () => {
		peers = deps.load();
		conflicts = deps.conflicts();
		updatedAt = Date.now();
		tui.requestRender();
	};

	const refreshFocus = async () => {
		focusedPanes = await deps.refreshFocus(peers);
		tui.requestRender();
	};

	const unwatch = deps.watch(reload);
	const ticker = setInterval(() => tui.requestRender(), TICK_MS);
	const focusTicker = setInterval(() => void refreshFocus().catch(() => {}), FOCUS_REFRESH_MS);
	ticker.unref?.();
	focusTicker.unref?.();

	const close = (outcome: PeersViewOutcome) => {
		clearInterval(ticker);
		clearInterval(focusTicker);
		unwatch();
		done(outcome);
	};

	const run = (peer: PeerView, label: string, action: () => Promise<string>) => {
		busy.set(peer.key, label);
		tui.requestRender();
		void action()
			.then((result) => {
				message = result;
			})
			.catch((error: Error) => {
				message = error.message;
			})
			.finally(() => {
				busy.delete(peer.key);
				reload();
			});
	};

	const openPager = (title: string, text: string) => {
		pager = { lines: text.split("\n"), scroll: 0, title };
		tui.requestRender();
	};

	const act = (key: string, peer: PeerView) => {
		if (peer.self) {
			message = "that is this session";
			return;
		}

		if (key === "s" || key === "a") {
			composer = { cursor: 0, deliver: "followUp", mode: key === "a" ? "ask" : "send", target: peer, text: "", wake: key === "a" };
			return;
		}
		if (key === "r") {
			run(peer, "reading", async () => {
				const transcript = await deps.read(peer, 8);
				openPager(`transcript · ${peer.presence.name ?? peer.presence.sessionId.slice(0, 8)}`, transcript);
				return "transcript loaded";
			});
			return;
		}
		if (key === "f") {
			run(peer, "focusing", () => deps.focus(peer));
			return;
		}
		if (key === "c") {
			run(peer, "releasing", () => deps.release(peer));
			return;
		}
		if (key === "p") {
			run(peer, "probing", () => deps.probe(peer));
		}
	};

	const submitComposer = () => {
		if (!composer) return;
		const { deliver, mode, target, text, wake } = composer;
		composer = undefined;
		if (text.trim().length === 0) {
			message = "nothing sent";
			return;
		}
		if (mode === "send") {
			run(target, "sending", () => deps.send(target, text, deliver, wake));
			return;
		}
		run(target, "asking", async () => {
			const reply = await deps.ask(target, text);
			openPager(`reply · ${target.presence.name ?? target.presence.sessionId.slice(0, 8)}`, reply);
			return "reply received";
		});
	};

	const sessionRows = (): TableRow[] => {
		const shared = duplicateSessionFiles(peers);
		const conflictPaths = new Map<string, number>();
		for (const conflict of conflicts) conflictPaths.set(conflict.peer.sessionId, (conflictPaths.get(conflict.peer.sessionId) ?? 0) + 1);

		return rows().map((peer, index) => {
			const warnings = conflictPaths.get(peer.presence.sessionId) ?? 0;
			const status = busy.get(peer.key);
			return {
				cells: [
					status ? `… ${status}` : stateLabel(peer),
					`${peer.presence.name ?? peer.presence.sessionId.slice(0, 8)}${peer.presence.sessionFile && shared.has(peer.presence.sessionFile) ? " ⧉" : ""}`,
					shortenPath(displayPath(peer.presence.cwd, deps.cwd), 26),
					modelLabel(peer.presence),
					contextLabel(peer.presence),
					`${peer.presence.turn}`,
					`${peer.presence.files?.modified?.length ?? 0}${warnings > 0 ? ` ⚠${warnings}` : ""}`,
					whereLabel(peer, isFocused(peer)),
				],
				selected: index === selected,
				tone: peer.stale ? "muted" : warnings > 0 ? "danger" : "normal",
			};
		});
	};

	const fileRows = (): TableRow[] => {
		const mine = deps.mine();
		const mineByPath = new Map(mine.modified.concat(mine.read).map((touch) => [touch.path, touch.at]));
		return peers
			.filter((peer) => !peer.self)
			.flatMap((peer) =>
				(peer.presence.files?.modified ?? []).map((touch) => ({
					cells: [
						formatClock(touch.at),
						peer.presence.name ?? peer.presence.sessionId.slice(0, 8),
						shortenPath(displayPath(touch.path, deps.cwd), 48),
						"modified",
						mineByPath.has(touch.path) ? `yours ${formatClock(mineByPath.get(touch.path))}` : "",
					],
					tone: mineByPath.has(touch.path) ? ("danger" as const) : ("normal" as const),
					at: touch.at,
				})),
			)
			.sort((left, right) => right.at - left.at)
			.map(({ cells, tone }) => ({ cells, tone }));
	};

	const conflictRows = (): TableRow[] =>
		conflicts.map((conflict) => ({
			cells: [
				formatClock(conflict.peerAt),
				conflict.peer.name ?? conflict.peer.sessionId.slice(0, 8),
				shortenPath(displayPath(conflict.path, deps.cwd), 48),
				`you ${conflict.mineKind} ${formatClock(conflict.mineAt)}`,
			],
			tone: "danger",
		}));

	const claimRows = (): TableRow[] =>
		deps.claims().map(({ claim, peer }) => ({
			cells: [
				`${formatAge(claim.expiresAt - Date.now())} left`,
				peer.name ?? peer.sessionId.slice(0, 8),
				claim.intent,
				claim.paths.map((path) => displayPath(path, deps.cwd)).join(", "),
			],
			tone: "normal",
		}));

	const inboxRows = (): TableRow[] =>
		deps
			.inbox()
			.slice()
			.reverse()
			.map((entry) => ({
				cells: [formatClock(entry.at), entry.direction === "in" ? "◀ in" : "▶ out", entry.peer, entry.kind, entry.detail],
				tone: entry.ok ? "normal" : "danger",
			}));

	const TABLES: { columns: ColumnSpec[]; rows: () => TableRow[] }[] = [
		{
			columns: [
				{ align: "left", header: "STATE", priority: 0 },
				{ align: "left", header: "SESSION", maxWidth: 28, priority: 0 },
				{ align: "left", header: "CWD", maxWidth: 24, priority: 3 },
				{ align: "left", header: "MODEL", maxWidth: 14, priority: 6 },
				{ align: "right", header: "CTX", priority: 5 },
				{ align: "right", header: "TURN", priority: 7 },
				{ align: "left", header: "FILES", priority: 2 },
				{ align: "left", header: "WHERE", maxWidth: 16, priority: 4 },
			],
			rows: sessionRows,
		},
		{
			columns: [
				{ align: "left", header: "WHEN", priority: 0 },
				{ align: "left", header: "SESSION", maxWidth: 24, priority: 2 },
				{ align: "left", header: "FILE", maxWidth: 48, priority: 0 },
				{ align: "left", header: "KIND", priority: 3 },
				{ align: "left", header: "OVERLAP", maxWidth: 18, priority: 1 },
			],
			rows: fileRows,
		},
		{
			columns: [
				{ align: "left", header: "WHEN", priority: 0 },
				{ align: "left", header: "SESSION", maxWidth: 24, priority: 1 },
				{ align: "left", header: "FILE", maxWidth: 48, priority: 0 },
				{ align: "left", header: "YOUR TOUCH", maxWidth: 24, priority: 0 },
			],
			rows: conflictRows,
		},
		{
			columns: [
				{ align: "left", header: "EXPIRES", priority: 0 },
				{ align: "left", header: "SESSION", maxWidth: 24, priority: 1 },
				{ align: "left", header: "INTENT", maxWidth: 30, priority: 2 },
				{ align: "left", header: "PATHS", maxWidth: 50, priority: 0 },
			],
			rows: claimRows,
		},
		{
			columns: [
				{ align: "left", header: "WHEN", priority: 0 },
				{ align: "left", header: "DIR", priority: 0 },
				{ align: "left", header: "SESSION", maxWidth: 24, priority: 2 },
				{ align: "left", header: "KIND", priority: 1 },
				{ align: "left", header: "DETAIL", maxWidth: 46, priority: 0 },
			],
			rows: inboxRows,
		},
	];

	const viewportHeight = (): number => Math.max(6, Math.floor(tui.terminal.rows / 2) - 9);

	const detailLines = (width: number): string[] => {
		const peer = current();
		if (!peer) return [theme.fg("muted", " no live sessions found")];

		const { presence } = peer;
		const mine = deps.mine();
		const mineByPath = new Map(mine.modified.concat(mine.read).map((touch) => [touch.path, touch]));
		const status = busy.get(peer.key);

		const head = [
			presence.name ?? presence.sessionId.slice(0, 8),
			presence.sessionId.slice(0, 8),
			`pid ${presence.pid}`,
			`up ${formatAge(Date.now() - presence.startedAt)}`,
			`inbox ${presence.inbox?.mode ?? "?"}`,
			status ? `${status}…` : `heartbeat ${formatAge(Date.now() - presence.updatedAt)} ago`,
		].join(theme.fg("dim", " · "));

		const activity = [
			`last user ${formatClock(presence.lastUserAt)}`,
			`settled ${formatClock(presence.lastAssistantAt)}`,
			`turn ${presence.turn}`,
			`thinking ${presence.thinking ?? "-"}`,
			`ctx ${contextLabel(presence)}`,
		].join(theme.fg("dim", " · "));

		const modified = (presence.files?.modified ?? []).slice(0, 4).map((touch) => {
			const own = mineByPath.get(touch.path);
			const mark = own && touch.at > own.at ? theme.fg("warning", ` ⚠ you ${formatClock(own.at)}`) : "";
			return `${displayPath(touch.path, deps.cwd)} ${formatClock(touch.at)}${mark}`;
		});

		const claims = (presence.claims ?? [])
			.filter((claim) => claim.expiresAt > Date.now())
			.map((claim) => `${claim.paths.map((path) => displayPath(path, deps.cwd)).join(", ")} (${formatAge(claim.expiresAt - Date.now())})`);

		return [
			` ${head}`,
			` ${theme.fg("muted", activity)}`,
			` ${theme.fg("muted", "modified ")}${modified.length > 0 ? modified.join(theme.fg("dim", " · ")) : theme.fg("dim", "none")}`,
			` ${theme.fg("muted", "claims   ")}${claims.length > 0 ? claims.join(theme.fg("dim", " · ")) : theme.fg("dim", "none")}`,
		].map((line) => truncateToWidth(line, width));
	};

	const composerLines = (width: number): string[] => {
		if (!composer) return [];
		const { cursor, deliver, mode, target, text, wake } = composer;
		const header = [
			`${mode === "ask" ? "ask" : "send to"} ${target.presence.name ?? target.presence.sessionId.slice(0, 8)}`,
			`deliver ${deliver}`,
			`wake ${wake ? "yes" : "no"}`,
		].join(theme.fg("dim", " · "));

		const before = text.slice(0, cursor);
		const at = text.slice(cursor, cursor + 1) || " ";
		const after = text.slice(cursor + 1);

		return [
			truncateToWidth(` ${theme.fg("accent", header)}`, width),
			truncateToWidth(` ${theme.fg("accent", "> ")}${before}${CURSOR_MARKER}\u001b[7m${at}\u001b[27m${after}`, width),
			truncateToWidth(
				` ${theme.fg("dim", [rawKeyHint("tab", "delivery"), rawKeyHint("ctrl+w", "wake"), rawKeyHint("enter", "send"), rawKeyHint("esc", "cancel")].join(" · "))}`,
				width,
			),
		];
	};

	const titleLine = (width: number): string => {
		const live = peers.filter((peer) => !peer.stale && !peer.self).length;
		const working = peers.filter((peer) => !peer.self && peer.presence.state === "working").length;
		const parts = [
			theme.fg("accent", theme.bold("π peers")),
			`${live} live`,
			`${working} working`,
			`${conflicts.length} conflicts`,
		];
		return truncateToWidth(
			`${parts.join(theme.fg("dim", " · "))}${theme.fg("dim", `   updated ${formatClock(updatedAt)}`)}`,
			width,
		);
	};

	const tabBar = (width: number): string =>
		truncateToWidth(
			TABS.map((name, index) => {
				const label = ` ${index + 1} ${name} `;
				return index === tab ? theme.bg("selectedBg", theme.fg("accent", theme.bold(label))) : theme.fg("muted", label);
			}).join(theme.fg("dim", "│")),
			width,
		);

	const hintLine = (width: number): string => {
		const last = pager ? rawKeyHint("esc", "back") : filtering ? rawKeyHint("esc", "clear") : rawKeyHint("esc", "close");
		const keys = pager
			? [rawKeyHint("↑↓", "scroll"), rawKeyHint("pgup/pgdn", "page")]
			: filtering
				? [rawKeyHint("enter", "apply")]
				: [
						rawKeyHint("↑↓", "select"),
						rawKeyHint("tab", "views"),
						rawKeyHint("s", "send"),
						rawKeyHint("a", "ask"),
						rawKeyHint("r", "read"),
						rawKeyHint("e", "editor"),
						rawKeyHint("f", "focus"),
						rawKeyHint("/", "filter"),
						rawKeyHint("c", "release"),
						rawKeyHint("p", "probe"),
						rawKeyHint("x", "prune"),
						rawKeyHint("S", "sort"),
						rawKeyHint("R", "refresh"),
					];
		const trailer = message ? ` · ${message}` : filter ? ` · filter "${filter}"` : "";
		const budget = width - visibleWidth(trailer) - visibleWidth(last) - 4;

		const shown: string[] = [];
		for (const key of keys) {
			if (visibleWidth([...shown, key].join(" · ")) > budget) break;
			shown.push(key);
		}

		return truncateToWidth(
			`${theme.fg("dim", [...shown, last].join(" · "))}${message ? theme.fg("accent", trailer) : theme.fg("muted", trailer)}`,
			width,
		);
	};

	const bodyLines = (width: number): string[] => {
		if (pager) return pager.lines.map((line) => truncateToWidth(line, width));
		const table = TABLES[tab];
		return renderTable(table.columns, table.rows(), theme, width);
	};

	const scrollBy = (amount: number, total: number) => {
		const limit = Math.max(0, total - viewportHeight());
		if (pager) {
			pager.scroll = Math.min(limit, Math.max(0, pager.scroll + amount));
		} else {
			scroll[tab] = Math.min(limit, Math.max(0, scroll[tab] + amount));
		}
		tui.requestRender();
	};

	const moveSelection = (delta: number) => {
		const total = rows().length;
		if (total === 0) return;
		selected = (selected + delta + total) % total;
		const height = viewportHeight();
		if (selected < scroll[0]) scroll[0] = selected;
		if (selected >= scroll[0] + height - 1) scroll[0] = selected - height + 2;
		tui.requestRender();
	};

	void refreshFocus().catch(() => {});

	return {
		handleInput(data: string): void {
			message = undefined;
			const total = bodyLines(lastWidth).length;

			if (pager) {
				if (matchesKey(data, Key.escape) || data === "q") {
					pager = undefined;
					tui.requestRender();
				} else if (matchesKey(data, Key.up)) scrollBy(-1, total);
				else if (matchesKey(data, Key.down)) scrollBy(1, total);
				else if (matchesKey(data, Key.pageUp)) scrollBy(-viewportHeight(), total);
				else if (matchesKey(data, Key.pageDown)) scrollBy(viewportHeight(), total);
				return;
			}

			if (composer) {
				if (matchesKey(data, Key.escape)) {
					composer = undefined;
					tui.requestRender();
					return;
				}
				if (matchesKey(data, "enter")) {
					submitComposer();
					tui.requestRender();
					return;
				}
				if (matchesKey(data, Key.tab)) {
					composer.deliver = DELIVERY_CYCLE[(DELIVERY_CYCLE.indexOf(composer.deliver) + 1) % DELIVERY_CYCLE.length];
					tui.requestRender();
					return;
				}
				if (matchesKey(data, "ctrl+w")) {
					composer.wake = !composer.wake;
					tui.requestRender();
					return;
				}
				if (matchesKey(data, Key.left)) {
					composer.cursor = Math.max(0, composer.cursor - 1);
					tui.requestRender();
					return;
				}
				if (matchesKey(data, Key.right)) {
					composer.cursor = Math.min(composer.text.length, composer.cursor + 1);
					tui.requestRender();
					return;
				}
				if (data === "\x7f" || data === "\b") {
					if (composer.cursor > 0) {
						composer.text = composer.text.slice(0, composer.cursor - 1) + composer.text.slice(composer.cursor);
						composer.cursor--;
					}
					tui.requestRender();
					return;
				}
				const typed = printable(data);
				if (typed) {
					composer.text = composer.text.slice(0, composer.cursor) + typed + composer.text.slice(composer.cursor);
					composer.cursor += typed.length;
					tui.requestRender();
				}
				return;
			}

			if (filtering) {
				if (matchesKey(data, Key.escape)) {
					filter = "";
					filtering = false;
				} else if (matchesKey(data, "enter")) {
					filtering = false;
				} else if (data === "\x7f" || data === "\b") {
					filter = filter.slice(0, -1);
				} else {
					filter += printable(data);
				}
				selected = 0;
				tui.requestRender();
				return;
			}

			if (matchesKey(data, Key.escape) || data === "q") {
				close(undefined);
				return;
			}
			if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
				tab = (tab + 1) % TABS.length;
				tui.requestRender();
				return;
			}
			if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
				tab = (tab - 1 + TABS.length) % TABS.length;
				tui.requestRender();
				return;
			}
			if (data >= "1" && data <= `${TABS.length}`) {
				tab = Number(data) - 1;
				tui.requestRender();
				return;
			}
			if (matchesKey(data, Key.up)) {
				if (tab === 0) moveSelection(-1);
				else scrollBy(-1, total);
				return;
			}
			if (matchesKey(data, Key.down)) {
				if (tab === 0) moveSelection(1);
				else scrollBy(1, total);
				return;
			}
			if (matchesKey(data, Key.pageUp)) {
				scrollBy(-viewportHeight(), total);
				return;
			}
			if (matchesKey(data, Key.pageDown)) {
				scrollBy(viewportHeight(), total);
				return;
			}
			if (data === "/") {
				filtering = true;
				tui.requestRender();
				return;
			}
			if (data === "S") {
				sortRecent = !sortRecent;
				message = sortRecent ? "sorted by activity" : "sorted by state";
				tui.requestRender();
				return;
			}
			if (data === "R") {
				reload();
				void refreshFocus().catch(() => {});
				return;
			}
			if (data === "x") {
				const removed = deps.prune(peers.filter((peer) => peer.stale && !peer.self).map((peer) => peer.key));
				message = removed > 0 ? `pruned ${removed} stale session(s)` : "nothing stale";
				reload();
				return;
			}

			const peer = current();
			if (!peer) return;

			if (data === "e") {
				close({ compose: peer });
				return;
			}
			if ("acfprs".includes(data) && data.length === 1) {
				act(data, peer);
				tui.requestRender();
			}
		},

		invalidate(): void {},

		render(width: number): string[] {
			lastWidth = width;
			const body = bodyLines(width);
			const height = viewportHeight();
			const offset = pager ? pager.scroll : scroll[tab];
			const limit = Math.max(0, body.length - height);
			const start = Math.min(offset, limit);
			if (pager) pager.scroll = start;
			else scroll[tab] = start;

			const visible = body.slice(start, start + height);
			while (visible.length < height) visible.push("");

			const rule = theme.fg("dim", "─".repeat(width));
			const heading = pager ? [theme.fg("accent", ` ${pager.title}`)] : [];

			return [
				titleLine(width),
				tabBar(width),
				rule,
				...heading,
				...visible,
				rule,
				...(pager ? [] : [...detailLines(width), ...(composer ? [rule, ...composerLines(width)] : []), rule]),
				hintLine(width),
			].map((line) => truncateToWidth(line, width));
		},
	};
}
