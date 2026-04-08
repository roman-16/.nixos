/**
 * Sanitizes "pi" product references in system prompt for Anthropic OAuth billing.
 * Preserves full paths containing pi-coding-agent from being corrupted.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

function sanitize(s: string): string {
	const paths: string[] = [];
	const safe = s.replace(/\S*lib\/node_modules\/@mariozechner\/pi-coding-agent\S*/g, (m) => {
		paths.push(m);
		return `<<PATH_${paths.length - 1}>>`;
	});
	return safe
		.replace(/pi-coding-agent/g, "π-coding-agent").replace(/pi coding agent/gi, "π coding agent")
		.replace(/pi-mono/g, "π-mono").replace(/\bPi\b/g, "π").replace(/\bpi\b/g, "π")
		.replace(/<<PATH_(\d+)>>/g, (_, i) => paths[parseInt(i)]);
}

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => ({
		systemPrompt: sanitize(event.systemPrompt),
	}));
}
