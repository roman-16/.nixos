import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { collectSessions, type LiveSession } from "./collect.ts";
import { createUsageView } from "./view.ts";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("usage-stats", {
		description: "Browse token usage and spend across all sessions",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/usage-stats needs an interactive terminal", "warning");
				return;
			}

			const live = (): LiveSession => ({
				cwd: ctx.cwd,
				entries: ctx.sessionManager.getEntries(),
				id: ctx.sessionManager.getSessionId(),
				name: pi.getSessionName(),
				path: ctx.sessionManager.getSessionFile(),
			});

			ctx.ui.setStatus("usage-stats", "Reading sessions…");
			const load = () => collectSessions(live());
			load();
			ctx.ui.setStatus("usage-stats", undefined);

			await ctx.ui.custom<void>((tui, theme, _keybindings, done) =>
				createUsageView({ done: () => done(undefined), load, theme, tui }),
			);
		},
	});
}
