import { execFile } from "node:child_process";
import type { PeerLocation } from "./protocol.ts";

const CACHE_MS = 5_000;
const COMMAND_TIMEOUT_MS = 1_500;

let cache: { at: number; panes: Map<string, Set<string>> } | undefined;

function run(args: string[]): Promise<string> {
	return new Promise((resolve) => {
		execFile("zellij", args, { timeout: COMMAND_TIMEOUT_MS }, (error, stdout) => resolve(error ? "" : stdout));
	});
}

function paneId(value: string): string {
	return value.replace(/^terminal_/, "");
}

export function currentLocation(): PeerLocation {
	return {
		term: process.env.TERM_PROGRAM,
		zellijPane: process.env.ZELLIJ_PANE_ID,
		zellijSession: process.env.ZELLIJ === undefined ? undefined : process.env.ZELLIJ_SESSION_NAME,
	};
}

export function cachedFocus(): Map<string, Set<string>> {
	return cache?.panes ?? new Map();
}

export async function refreshFocus(sessions: string[]): Promise<Map<string, Set<string>>> {
	if (cache && Date.now() - cache.at < CACHE_MS) return cache.panes;

	const panes = new Map<string, Set<string>>();
	await Promise.all(
		sessions.map(async (session) => {
			const output = await run(["--session", session, "action", "list-clients"]);
			const ids = new Set<string>();
			for (const line of output.split("\n").slice(1)) {
				const columns = line.trim().split(/\s+/);
				if (columns.length >= 2) ids.add(paneId(columns[1]));
			}
			if (ids.size > 0) panes.set(session, ids);
		}),
	);

	cache = { at: Date.now(), panes };
	return panes;
}

export function isFocused(location: PeerLocation): boolean {
	if (!location.zellijSession || location.zellijPane === undefined) return false;
	return cachedFocus().get(location.zellijSession)?.has(paneId(location.zellijPane)) ?? false;
}

export async function focus(location: PeerLocation): Promise<string> {
	if (!location.zellijSession || location.zellijPane === undefined) return "no zellij pane recorded";
	const target = /^\d+$/.test(location.zellijPane) ? `terminal_${location.zellijPane}` : location.zellijPane;
	await run(["--session", location.zellijSession, "action", "focus-pane-id", target]);
	cache = undefined;
	return `focused ${location.zellijSession}:${location.zellijPane}`;
}
