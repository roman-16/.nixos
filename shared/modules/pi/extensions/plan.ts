import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TextContent, UserMessage } from "@earendil-works/pi-ai";
import {
	estimateTokens,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

const FALLBACK_MODEL = { id: "claude-opus-5", provider: "anthropic" };
const HANDOFF = "/skill:handoff --inline";
const NO_PRUNE = "--no-prune";
const NO_PRUNE_PATTERN = new RegExp(`^${NO_PRUNE}(?=\\s|$)|\\s${NO_PRUNE}$`, "g");
const PLANNING_MODEL = { id: "claude-fable-5-1", provider: "anthropic" };
const PRUNED = "[pruned]";
const SKILL_BLOCK = /<skill\b[^>]*>[\s\S]*?<\/skill>/g;
const STATE = "plan";
const WARN_ABOVE_TOKENS = 25_000;

interface Invocation {
	prunes: boolean;
	text: string;
}

interface ModelRef {
	id: string;
	provider: string;
}

interface Settings {
	defaultModel?: string;
	defaultProvider?: string;
}

interface State {
	planning: boolean;
	prunedBefore: number;
}

function prunedContent(): TextContent[] {
	return [{ text: PRUNED, type: "text" }];
}

function withoutSkills(text: string): string {
	return text.replace(SKILL_BLOCK, "").trim();
}

function pruneUser(content: UserMessage["content"]): UserMessage["content"] {
	if (typeof content === "string") return withoutSkills(content) || PRUNED;

	const blocks = content
		.map((block) => (block.type === "text" ? { ...block, text: withoutSkills(block.text) } : block))
		.filter((block) => block.type !== "text" || block.text.length > 0);

	return blocks.length > 0 ? blocks : prunedContent();
}

function prune(message: AgentMessage, prunedBefore: number): AgentMessage {
	if (message.timestamp > prunedBefore) return message;

	if (message.role === "toolResult") return { ...message, content: prunedContent() };
	if (message.role === "user") return { ...message, content: pruneUser(message.content) };
	if (message.role !== "assistant") return message;

	const content = message.content.filter((block) => block.type !== "thinking");

	return { ...message, content: content.length > 0 ? content : prunedContent() };
}

function prunableTokens(ctx: ExtensionContext, from: number, to: number): number {
	let prunable = 0;

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const { timestamp } = entry.message;
		if (timestamp <= from || timestamp > to) continue;

		prunable += estimateTokens(entry.message) - estimateTokens(prune(entry.message, to));
	}

	return Math.max(0, prunable);
}

function sameModel(a: ModelRef | undefined, b: ModelRef | undefined): boolean {
	return a?.id === b?.id && a?.provider === b?.provider;
}

function readSettings(file: string): Settings {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return {};
	}
}

function configuredModel(ctx: ExtensionContext): ModelRef {
	const files = [
		join(homedir(), ".pi", "agent", "settings.json"),
		join(ctx.cwd, ".pi", "settings.json"),
	];

	return files.reduce((model, file) => {
		const { defaultModel, defaultProvider } = readSettings(file);
		return defaultModel && defaultProvider ? { id: defaultModel, provider: defaultProvider } : model;
	}, FALLBACK_MODEL);
}

function parseArgs(args: string): Invocation {
	const text = args.trim();
	const stripped = text.replace(NO_PRUNE_PATTERN, "").trim();

	return { prunes: stripped === text, text: stripped };
}

function pruneCompletions(prefix: string): AutocompleteItem[] | null {
	if (!parseArgs(prefix).prunes) return null;

	const typed = prefix.match(/\S*$/)?.[0] ?? "";
	const before = prefix.slice(0, prefix.length - typed.length);
	const offered = typed === "" ? before.trim() === "" : NO_PRUNE.startsWith(typed);

	return offered
		? [{ description: "Keep the current context", label: NO_PRUNE, value: `${before}${NO_PRUNE}` }]
		: null;
}

function kickoff(notes: string, pruned: boolean): string {
	return [
		"Implement the plan.",
		notes,
		pruned
			? "Tool output from the planning phase is no longer in your context. Re-read whatever you need before changing it."
			: "",
	]
		.filter((part) => part.length > 0)
		.join("\n\n");
}

export default function (pi: ExtensionAPI) {
	let state: State = { planning: false, prunedBefore: 0 };

	const persist = () => pi.appendEntry(STATE, state);

	const showStatus = (ctx: ExtensionContext) =>
		ctx.ui.setStatus(STATE, state.planning ? ctx.ui.theme.fg("warning", "✎ plan") : undefined);

	pi.on("session_start", (_event, ctx) => {
		state = { planning: false, prunedBefore: 0 };
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === STATE) state = entry.data as State;
		}
		showStatus(ctx);
	});

	pi.on("context", (event) => {
		if (state.prunedBefore === 0) return;
		return { messages: event.messages.map((message) => prune(message, state.prunedBefore)) };
	});

	let settle: (() => void) | undefined;

	pi.on("agent_settled", () => {
		settle?.();
		settle = undefined;
	});

	const brief = () =>
		new Promise<void>((resolve) => {
			settle = resolve;
			pi.sendUserMessage(HANDOFF, { expandPromptTemplates: true });
		});

	pi.registerCommand("plan", {
		description: "Research and plan a change on Fable, then hand it to /go",
		getArgumentCompletions: pruneCompletions,
		handler: async (args, ctx) => {
			const invocation = parseArgs(args);
			if (!invocation.text) {
				ctx.ui.notify(`Usage: /plan [${NO_PRUNE}] <task>`, "error");
				return;
			}

			const model = ctx.modelRegistry.find(PLANNING_MODEL.provider, PLANNING_MODEL.id);
			if (!model) {
				ctx.ui.notify(`${PLANNING_MODEL.provider}/${PLANNING_MODEL.id} is not available`, "error");
				return;
			}

			await ctx.waitForIdle();

			const switchesModel = !sameModel(ctx.model, model);
			const prunes = invocation.prunes && switchesModel;
			const cut = Date.now();
			const prunable = switchesModel ? prunableTokens(ctx, state.prunedBefore, cut) : 0;

			if (ctx.hasUI && prunes && prunable > WARN_ABOVE_TOKENS) {
				const proceed = await ctx.ui.confirm(
					`Prune ${prunable.toLocaleString()} tokens of prior context?`,
					"Tool output, reasoning and skill instructions from this session stop being sent to the model. Your messages and file paths stay.",
				);
				if (!proceed) return;
			}

			if (!(await pi.setModel(model))) {
				ctx.ui.notify(`No authentication configured for ${model.name}`, "error");
				return;
			}

			state = { planning: true, prunedBefore: prunes ? cut : state.prunedBefore };
			persist();
			showStatus(ctx);

			if (prunable > 0) {
				const verb = prunes ? "Dropped" : "Kept";
				ctx.ui.notify(`${verb} ~${prunable.toLocaleString()} tokens of prior context`, "info");
			}

			pi.sendUserMessage(`/skill:plan ${invocation.text}`, { expandPromptTemplates: true });
		},
	});

	pi.registerCommand("go", {
		description: "Implement the plan on the model configured in settings",
		getArgumentCompletions: pruneCompletions,
		handler: async (args, ctx) => {
			if (!state.planning) {
				ctx.ui.notify("Nothing to implement. Start with /plan <task>.", "warning");
				return;
			}

			const invocation = parseArgs(args);
			const configured = configuredModel(ctx);
			const model = ctx.modelRegistry.find(configured.provider, configured.id);
			if (!model) {
				ctx.ui.notify(`${configured.provider}/${configured.id} is not available`, "error");
				return;
			}

			await ctx.waitForIdle();

			const switchesModel = !sameModel(ctx.model, model);
			const prunes = invocation.prunes && switchesModel;

			if (prunes) await brief();

			const cut = Date.now();
			const prunable = switchesModel ? prunableTokens(ctx, state.prunedBefore, cut) : 0;

			if (!(await pi.setModel(model))) {
				ctx.ui.notify(`No authentication configured for ${model.name}`, "error");
				return;
			}

			state = { planning: false, prunedBefore: prunes ? cut : state.prunedBefore };
			persist();
			showStatus(ctx);

			if (prunable > 0) {
				const verb = prunes ? "Dropped" : "Kept";
				ctx.ui.notify(`${verb} ~${prunable.toLocaleString()} tokens of planning research`, "info");
			}

			pi.sendUserMessage(kickoff(invocation.text, prunes));
		},
	});
}
