import { homedir } from "node:os";
import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const ATTENTION_SLACK_MS = 1_000;

const ATTENTION_TTL_MS = 120_000;

const INTERACTIVE_TOOLS = new Set(["questionnaire"]);

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

export default function (pi: ExtensionAPI) {
	let generation = 0;
	let keypressListener: (() => void) | undefined;
	let lastKeypressAt = 0;
	let notificationId = 0;

	const bus = (args: string[]) => pi.exec("busctl", ["--user", "call", ...args], { timeout: 2_000 });

	const systemIdleMs = async (): Promise<number | undefined> => {
		try {
			const result = await bus([
				"org.gnome.Mutter.IdleMonitor",
				"/org/gnome/Mutter/IdleMonitor/Core",
				"org.gnome.Mutter.IdleMonitor",
				"GetIdletime",
			]);
			const idle = Number(result.stdout.trim().replace(/^t\s+/, ""));
			return result.code === 0 && Number.isFinite(idle) ? idle : undefined;
		} catch {
			return undefined;
		}
	};

	const userIsHere = async (): Promise<boolean> => {
		const sinceKeypress = Date.now() - lastKeypressAt;
		if (sinceKeypress > ATTENTION_TTL_MS) return false;

		const idle = await systemIdleMs();
		return idle !== undefined && sinceKeypress <= idle + ATTENTION_SLACK_MS;
	};

	const close = (id: number) => {
		void bus([
			"org.freedesktop.Notifications",
			"/org/freedesktop/Notifications",
			"org.freedesktop.Notifications",
			"CloseNotification",
			"u",
			`${id}`,
		]).catch(() => {});
	};

	const withdraw = () => {
		generation++;
		if (!notificationId) return;

		close(notificationId);
		notificationId = 0;
	};

	const send = async (title: string, body: string, urgency: string): Promise<number | undefined> => {
		try {
			const result = await pi.exec(
				"notify-send",
				[
					"--app-name",
					"π",
					"--icon",
					"utilities-terminal",
					"--print-id",
					"--replace-id",
					`${notificationId}`,
					"--urgency",
					urgency,
					title,
					body,
				],
				{ timeout: 2_000 },
			);
			const id = Number(result.stdout.trim());
			return Number.isFinite(id) && id > 0 ? id : undefined;
		} catch {
			return undefined;
		}
	};

	const notify = async (ctx: ExtensionContext, status: string) => {
		if (!notifiable(ctx)) return;

		const epoch = ++generation;
		const urgency = (await userIsHere()) ? "low" : "normal";
		if (epoch !== generation) return;

		const id = await send(
			`π · ${pi.getSessionName() ?? basename(ctx.cwd)}`,
			escapeBodyMarkup(`${homeRelative(ctx.cwd)} · ${status}`),
			urgency,
		);
		if (id === undefined) return;

		if (epoch === generation) notificationId = id;
		else close(id);
	};

	const forgetKeypresses = () => {
		if (!keypressListener) return;

		process.stdin.removeListener("data", keypressListener);
		keypressListener = undefined;
	};

	const watchKeypresses = () => {
		forgetKeypresses();
		lastKeypressAt = Date.now();
		keypressListener = () => {
			lastKeypressAt = Date.now();
			withdraw();
		};
		process.stdin.on("data", keypressListener);
	};

	pi.on("session_start", (_event, ctx) => {
		if (notifiable(ctx)) watchKeypresses();
		else forgetKeypresses();
	});

	pi.on("agent_settled", (_event, ctx) => {
		void notify(ctx, "ready for input");
	});

	pi.on("tool_execution_start", (event, ctx) => {
		if (INTERACTIVE_TOOLS.has(event.toolName)) void notify(ctx, "waiting for your answer");
	});

	pi.on("tool_execution_end", (event) => {
		if (INTERACTIVE_TOOLS.has(event.toolName)) withdraw();
	});

	pi.on("agent_start", withdraw);

	pi.on("session_shutdown", () => {
		forgetKeypresses();
		withdraw();
	});
}
