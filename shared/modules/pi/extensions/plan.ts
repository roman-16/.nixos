import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import {
	estimateTokens,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const PLANNING_MODEL = { id: "claude-fable-5-1", provider: "anthropic" };
const PRUNED = "[pruned]";
const STATE = "plan";
const WARN_ABOVE_TOKENS = 25_000;

interface ModelRef {
	id: string;
	provider: string;
}

interface State {
	implementationModel?: ModelRef;
	planning: boolean;
	prunedBefore: number;
}

function prunedContent(): TextContent[] {
	return [{ text: PRUNED, type: "text" }];
}

function prune(message: AgentMessage, prunedBefore: number): AgentMessage {
	if (message.timestamp > prunedBefore) return message;

	if (message.role === "toolResult") return { ...message, content: prunedContent() };
	if (message.role !== "assistant") return message;

	const content = message.content.filter((block) => block.type !== "thinking");
	if (content.length === message.content.length) return message;

	return { ...message, content: content.length > 0 ? content : prunedContent() };
}

function prunableTokens(ctx: ExtensionContext, from: number, to: number): number {
	let prunable = 0;

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const { timestamp } = entry.message;
		if (timestamp <= from || timestamp > to) continue;

		const pruned = prune(entry.message, to);
		if (pruned !== entry.message) prunable += estimateTokens(entry.message) - estimateTokens(pruned);
	}

	return Math.max(0, prunable);
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

			await ctx.waitForIdle();

			const cut = Date.now();
			const prunable = prunableTokens(ctx, state.prunedBefore, cut);

			if (ctx.hasUI && prunable > WARN_ABOVE_TOKENS) {
				const proceed = await ctx.ui.confirm(
					`Prune ${prunable.toLocaleString()} tokens of prior context?`,
					"Tool output and reasoning from this session stop being sent to the model. Text and file paths stay.",
				);
				if (!proceed) return;
			}

			const implementationModel = ctx.model;
			if (!(await pi.setModel(model))) {
				ctx.ui.notify(`No authentication configured for ${model.name}`, "error");
				return;
			}

			state = {
				implementationModel: implementationModel && {
					id: implementationModel.id,
					provider: implementationModel.provider,
				},
				planning: true,
				prunedBefore: cut,
			};
			persist();
			showStatus(ctx);

			if (prunable > 0) {
				ctx.ui.notify(`Dropped ~${prunable.toLocaleString()} tokens of prior context`, "info");
			}

			pi.sendUserMessage(`/skill:plan ${task}`, { expandPromptTemplates: true });
		},
	});

	pi.registerCommand("go", {
		description: "Implement the plan, dropping the planning research from context",
		handler: async (args, ctx) => {
			if (!state.planning) {
				ctx.ui.notify("Nothing to implement. Start with /plan <task>.", "warning");
				return;
			}

			await ctx.waitForIdle();

			const cut = Date.now();
			const prunable = prunableTokens(ctx, state.prunedBefore, cut);

			state = { ...state, planning: false, prunedBefore: cut };

			const model =
				state.implementationModel &&
				ctx.modelRegistry.find(state.implementationModel.provider, state.implementationModel.id);
			if (model) await pi.setModel(model);

			persist();
			showStatus(ctx);

			if (prunable > 0) {
				ctx.ui.notify(`Dropped ~${prunable.toLocaleString()} tokens of planning research`, "info");
			}

			pi.sendUserMessage(kickoff(args.trim()));
		},
	});
}
