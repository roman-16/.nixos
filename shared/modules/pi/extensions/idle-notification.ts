import { type ChildProcess, spawn } from "node:child_process";
import { homedir } from "node:os";
import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const INTERACTIVE_TOOLS = new Set(["questionnaire"]);

const TERMINAL_DESKTOP_IDS: Record<string, string> = {
	WezTerm: "org.wezfurlong.wezterm",
	vscode: "code",
};

function escapeBodyMarkup(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function homeRelative(path: string): string {
	const home = homedir();
	if (path === home) return "~";
	return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function notifiable(ctx: ExtensionContext): boolean {
	return ctx.mode === "tui" && !!process.env.DBUS_SESSION_BUS_ADDRESS && !process.env.SSH_CONNECTION;
}

function notifySendArgs(title: string, body: string): string[] {
	const desktopId = TERMINAL_DESKTOP_IDS[process.env.TERM_PROGRAM ?? ""];

	return [
		"--wait",
		"--app-name",
		"π",
		"--icon",
		"utilities-terminal",
		"--hint=boolean:resident:true",
		...(desktopId ? [`--hint=string:desktop-entry:${desktopId}`] : []),
		title,
		escapeBodyMarkup(body),
	];
}

export default function (pi: ExtensionAPI) {
	let pending: ChildProcess | undefined;

	const withdraw = () => {
		pending?.kill();
		pending = undefined;
	};

	const notify = (ctx: ExtensionContext, status: string) => {
		if (!notifiable(ctx)) return;

		withdraw();

		const title = `π · ${pi.getSessionName() ?? basename(ctx.cwd)}`;
		const child = spawn("notify-send", notifySendArgs(title, `${homeRelative(ctx.cwd)} · ${status}`), {
			stdio: "ignore",
		});
		const forget = () => {
			if (pending === child) pending = undefined;
		};

		child.on("error", forget);
		child.on("exit", forget);
		child.unref();

		pending = child;
	};

	pi.on("agent_settled", (_event, ctx) => {
		notify(ctx, "ready for input");
	});

	pi.on("tool_execution_start", (event, ctx) => {
		if (INTERACTIVE_TOOLS.has(event.toolName)) notify(ctx, "waiting for your answer");
	});

	pi.on("tool_execution_end", (event) => {
		if (INTERACTIVE_TOOLS.has(event.toolName)) withdraw();
	});

	pi.on("agent_start", withdraw);
	pi.on("input", withdraw);
	pi.on("session_shutdown", withdraw);
}
