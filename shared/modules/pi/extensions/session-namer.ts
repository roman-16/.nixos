import { complete, getModel } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

const AUTHORSHIP_ENTRY = "session-namer";
const MAX_MESSAGES = 64;
const REFRESH_INTERVAL_MS = 10 * 60 * 1000;

const INSTRUCTIONS = [
	"Generate a concise title for a coding assistant session based on the user's latest messages, given in chronological order.",
	"Rules:",
	"- 3 to 8 words.",
	"- Title Case.",
	"- Plain text only: no markdown, no backticks, asterisks, underscores, brackets or other formatting.",
	'- No surrounding quotes, no trailing punctuation, no leading label such as "Title:".',
	"- Capture the overall task or topic, favouring the main thread of work over side questions.",
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

function authoredName(entries: SessionEntry[]): string | undefined {
	let name: string | undefined;
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === AUTHORSHIP_ENTRY) {
			name = (entry.data as { name?: string } | undefined)?.name;
		}
	}
	return name;
}

function userTexts(ctx: ExtensionContext, pendingPrompt?: string): string[] {
	const texts = ctx.sessionManager
		.getBranch()
		.flatMap((entry) => {
			if (entry.type !== "message" || entry.message.role !== "user") return [];
			const { content } = entry.message;
			if (typeof content === "string") return [content];
			return [
				content
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join("\n"),
			];
		})
		.map((text) => text.trim())
		.filter((text) => text.length > 0);

	const prompt = pendingPrompt?.trim();
	if (prompt && texts.at(-1) !== prompt) texts.push(prompt);

	return texts;
}

function buildPrompt(texts: string[]): string {
	return texts
		.slice(-MAX_MESSAGES)
		.map((text) => `<message>\n${text}\n</message>`)
		.join("\n");
}

async function generateName(ctx: ExtensionContext, prompt: string): Promise<string> {
	const model = getModel("anthropic", "claude-haiku-4-5");
	if (!model) return "";

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth?.ok || !auth.apiKey) return "";

	const response = await complete(
		model,
		{
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: `${INSTRUCTIONS}\n\n${prompt}` }],
					timestamp: Date.now(),
				},
			],
		},
		{ apiKey: auth.apiKey, env: auth.env, headers: auth.headers, maxTokens: 64 },
	);

	return cleanName(
		response.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join(" "),
	);
}

export default function (pi: ExtensionAPI) {
	let ownName: string | undefined;
	let namedPrompt: string | undefined;
	let naming = false;
	let refreshTimer: ReturnType<typeof setInterval> | undefined;

	const refresh = async (ctx: ExtensionContext, pendingPrompt?: string) => {
		if (naming || !ctx.hasUI) return;

		const currentName = pi.getSessionName();
		if (currentName && currentName !== ownName) return;

		const prompt = buildPrompt(userTexts(ctx, pendingPrompt));
		if (!prompt || prompt === namedPrompt) return;

		naming = true;
		try {
			const name = await generateName(ctx, prompt);
			namedPrompt = prompt;
			if (!name || name === currentName) return;
			ownName = name;
			pi.setSessionName(name);
			pi.appendEntry(AUTHORSHIP_ENTRY, { name });
		} finally {
			naming = false;
		}
	};

	pi.on("session_start", (_event, ctx) => {
		ownName = authoredName(ctx.sessionManager.getEntries());
		namedPrompt = undefined;
		clearInterval(refreshTimer);
		refreshTimer = setInterval(() => {
			void refresh(ctx).catch(() => {});
		}, REFRESH_INTERVAL_MS);
		refreshTimer.unref?.();
	});

	pi.on("session_shutdown", () => {
		clearInterval(refreshTimer);
		refreshTimer = undefined;
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (pi.getSessionName()) return;
		void refresh(ctx, event.prompt).catch(() => {});
	});
}
