import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import {
	estimateTokens,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const LONG_CACHE_WRITE_MULTIPLIER = 2;
const PLANNING_MODEL = { id: "claude-fable-5-1", provider: "anthropic" };
const PRUNED = "[pruned]";
const STATE = "plan";
const WARN_ABOVE_TOKENS = 25_000;

interface ModelRef {
	id: string;
	provider: string;
}

interface PrunedRange {
	from: number;
	to: number;
}

interface State {
	implementationModel?: ModelRef;
	planningSince?: number;
	pruned: PrunedRange[];
}

function prunedContent(): TextContent[] {
	return [{ text: PRUNED, type: "text" }];
}

function withinPruned(timestamp: number, ranges: PrunedRange[]): boolean {
	return ranges.some((range) => timestamp >= range.from && timestamp <= range.to);
}

function prune(message: AgentMessage, ranges: PrunedRange[]): AgentMessage {
	if (!withinPruned(message.timestamp, ranges)) return message;

	if (message.role === "toolResult") {
		return { ...message, content: prunedContent() };
	}

	if (message.role !== "assistant") return message;

	const content = message.content.filter((block) => block.type !== "thinking");
	if (content.length === message.content.length) return message;

	return { ...message, content: content.length > 0 ? content : prunedContent() };
}

function prunedTokens(ctx: ExtensionContext, range: PrunedRange): number {
	const ranges = [range];
	let saved = 0;

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const pruned = prune(entry.message, ranges);
		if (pruned !== entry.message) saved += estimateTokens(entry.message) - estimateTokens(pruned);
	}

	return Math.max(0, saved);
}

function kickoff(notes: string): string {
	return [
		"Implement the plan.",
		notes,
		"Tool output from the planning phase is no longer in your context. Re-read whatever you need before changing it.",
	]
		.filter((part) => part.length > 0)
		.join("\n\n");
}

export default function (pi: ExtensionAPI) {
	let state: State = { pruned: [] };

	const persist = () => pi.appendEntry(STATE, state);

	const showStatus = (ctx: ExtensionContext) =>
		ctx.ui.setStatus(
			STATE,
			state.planningSince === undefined ? undefined : ctx.ui.theme.fg("warning", "✎ plan"),
		);

	pi.on("session_start", (_event, ctx) => {
		state = { pruned: [] };
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === STATE) state = entry.data as State;
		}
		showStatus(ctx);
	});

	pi.on("context", (event) => {
		if (state.pruned.length === 0) return;
		return { messages: event.messages.map((message) => prune(message, state.pruned)) };
	});

	pi.registerCommand("plan", {
		description: "Research and plan a change on Fable, then hand it to /go",
		handler: async (args, ctx) => {
			const task = args.trim();
			if (!task) {
				ctx.ui.notify("Usage: /plan <task>", "error");
				return;
			}

			const model = ctx.modelRegistry.find(PLANNING_MODEL.provider, PLANNING_MODEL.id);
			if (!model) {
				ctx.ui.notify(`${PLANNING_MODEL.provider}/${PLANNING_MODEL.id} is not available`, "error");
				return;
			}

			const tokens = ctx.getContextUsage()?.tokens ?? 0;
			if (ctx.hasUI && tokens > WARN_ABOVE_TOKENS) {
				const rewrite = (tokens * model.cost.input * LONG_CACHE_WRITE_MULTIPLIER) / 1_000_000;
				const proceed = await ctx.ui.confirm(
					`Switch to ${model.name}?`,
					`This session holds ~${tokens.toLocaleString()} tokens. Switching re-reads all of it (~$${rewrite.toFixed(2)}).`,
				);
				if (!proceed) return;
			}

			const implementationModel = ctx.model;
			if (!(await pi.setModel(model))) {
				ctx.ui.notify(`No authentication configured for ${model.name}`, "error");
				return;
			}

			state.implementationModel = implementationModel && {
				id: implementationModel.id,
				provider: implementationModel.provider,
			};
			state.planningSince ??= Date.now();
			persist();
			showStatus(ctx);

			pi.sendUserMessage(`/skill:plan ${task}`, { expandPromptTemplates: true });
		},
	});

	pi.registerCommand("go", {
		description: "Implement the plan, dropping the planning research from context",
		handler: async (args, ctx) => {
			if (state.planningSince === undefined) {
				ctx.ui.notify("Nothing to implement. Start with /plan <task>.", "warning");
				return;
			}

			await ctx.waitForIdle();

			const range = { from: state.planningSince, to: Date.now() };
			const saved = prunedTokens(ctx, range);

			state.planningSince = undefined;
			state.pruned = [...state.pruned, range];

			const model =
				state.implementationModel &&
				ctx.modelRegistry.find(state.implementationModel.provider, state.implementationModel.id);
			if (model) await pi.setModel(model);

			persist();
			showStatus(ctx);

			if (saved > 0) {
				ctx.ui.notify(`Dropped ~${saved.toLocaleString()} tokens of planning research`, "info");
			}

			pi.sendUserMessage(kickoff(args.trim()));
		},
	});
}
