/**
 * Names each session after its first user message, using Claude Haiku 4.5.
 * The generated title shows in the session selector instead of the raw prompt.
 */

import { complete, getModel } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_PROMPT_CHARS = 4000;

const INSTRUCTIONS = [
	"Generate a concise title for a coding assistant session based on the user's first message.",
	"Rules:",
	"- 3 to 8 words.",
	"- Title Case.",
	"- Plain text only: no markdown, no backticks, asterisks, underscores, brackets or other formatting.",
	'- No surrounding quotes, no trailing punctuation, no leading label such as "Title:".',
	"- Capture the concrete task or topic.",
	"Respond with ONLY the title.",
].join("\n");

function stripMarkdown(text: string): string {
	let result = text
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/^\s*(?:#{1,6}|>+|[-*+])\s+/, "");

	for (;;) {
		const unwrapped = result.replace(/(\*{1,3}|_{1,3}|~{2}|`+)(\S(?:[\s\S]*?\S)?)\1/g, "$2");
		if (unwrapped === result) break;
		result = unwrapped;
	}

	return result.replace(/[*`~]/g, "");
}

function cleanName(raw: string): string {
	const firstLine = raw.trim().split(/\r?\n/)[0] ?? "";
	return stripMarkdown(firstLine)
		.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
		.replace(/^\s*title\s*[:-]\s*/i, "")
		.replace(/\.+$/, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 60)
		.trim();
}

export default function (pi: ExtensionAPI) {
	let shouldName = false;

	pi.on("session_start", (_event, ctx) => {
		const hasName = Boolean(pi.getSessionName());
		const hasUserMessage = ctx.sessionManager
			.getEntries()
			.some((entry) => entry.type === "message" && entry.message.role === "user");
		shouldName = !hasName && !hasUserMessage;
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (!shouldName || !ctx.hasUI) return;
		const prompt = event.prompt?.trim();
		if (!prompt) return;
		shouldName = false;

		void (async () => {
			const model = getModel("anthropic", "claude-haiku-4-5");
			if (!model) return;

			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth?.ok || !auth.apiKey) return;

			const response = await complete(
				model,
				{
					messages: [
						{
							role: "user",
							content: [
								{
									type: "text",
									text: `${INSTRUCTIONS}\n\n<message>\n${prompt.slice(0, MAX_PROMPT_CHARS)}\n</message>`,
								},
							],
							timestamp: Date.now(),
						},
					],
				},
				{ apiKey: auth.apiKey, env: auth.env, headers: auth.headers, maxTokens: 64 },
			);

			const name = cleanName(
				response.content
					.filter((block): block is { type: "text"; text: string } => block.type === "text")
					.map((block) => block.text)
					.join(" "),
			);
			if (name) pi.setSessionName(name);
		})().catch(() => {});
	});
}
