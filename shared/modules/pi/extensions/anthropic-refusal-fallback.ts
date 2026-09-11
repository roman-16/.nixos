import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const CONTINUATION = "Continue from where the conversation stands. The previous attempt returned no output.";
const FALLBACK_MODEL = { id: "claude-opus-5", provider: "anthropic" };
const MID_OUTPUT_FALLBACK = "unsupported mid-output model fallback";
const NOTICE = "refusal-fallback";

interface ModelRef {
	id: string;
	provider: string;
}

interface Notice {
	declined: string;
	served: string;
}

function declined(message: AssistantMessage): boolean {
	if (message.stopReason !== "error") return false;

	return message.rawStopReason === "refusal" || (message.errorMessage ?? "").includes(MID_OUTPUT_FALLBACK);
}

function sameModel(a: ModelRef | undefined, b: ModelRef): boolean {
	return a?.id === b.id && a?.provider === b.provider;
}

export default function (pi: ExtensionAPI) {
	let declinedBy: string | undefined;

	pi.registerMessageRenderer<Notice>(NOTICE, (message, _options, theme) => {
		const details = message.details;
		if (!details) return undefined;

		return new Text(
			theme.fg("warning", "⤺ ") +
				theme.fg("toolTitle", theme.bold(`${NOTICE} `)) +
				theme.fg("muted", `${details.declined} declined · continuing on ${details.served}`),
			0,
			0,
		);
	});

	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		declinedBy = declined(event.message) ? event.message.model : undefined;
	});

	pi.on("agent_settled", async (_event, ctx: ExtensionContext) => {
		const from = declinedBy;
		declinedBy = undefined;
		if (!from || sameModel(ctx.model, FALLBACK_MODEL)) return;

		const model = ctx.modelRegistry.find(FALLBACK_MODEL.provider, FALLBACK_MODEL.id);
		if (!model) {
			ctx.ui.notify(`${FALLBACK_MODEL.provider}/${FALLBACK_MODEL.id} is not available`, "error");
			return;
		}

		if (!(await pi.setModel(model))) {
			ctx.ui.notify(`No authentication configured for ${model.name}`, "error");
			return;
		}

		ctx.ui.notify(`${from} declined the request, continuing on ${model.id}`, "warning");

		await pi.sendMessage<Notice>(
			{
				content: CONTINUATION,
				customType: NOTICE,
				details: { declined: from, served: model.id },
				display: true,
			},
			{ triggerTurn: true },
		);
	});
}
