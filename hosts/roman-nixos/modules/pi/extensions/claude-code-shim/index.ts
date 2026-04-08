/**
 * Claude API Provider — presents as Claude Code to use Pro/Max subscription.
 * Overrides the built-in anthropic provider's streamSimple with identity headers.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { ContentBlockParam, MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/messages.js";
import {
	type AssistantMessage, type AssistantMessageEventStream, type Context,
	type ImageContent, type Model, type Message, type SimpleStreamOptions,
	type TextContent, type ThinkingContent, type ToolCall, type ToolResultMessage,
	calculateCost, createAssistantMessageEventStream, parseStreamingJson,
} from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const sanitizePrompt = (s: string) => s
	.replace(/pi-coding-agent/g, "π-coding-agent").replace(/pi coding agent/gi, "π coding agent")
	.replace(/pi-mono/g, "π-mono").replace(/\bPi\b/g, "π").replace(/\bpi\b/g, "π");

function convertMessages(msgs: Message[]): any[] {
	const out: any[] = [];
	for (let i = 0; i < msgs.length; i++) {
		const m = msgs[i];
		if (m.role === "user") {
			if (typeof m.content === "string") { if (m.content.trim()) out.push({ role: "user", content: m.content }); }
			else out.push({ role: "user", content: m.content.map((b): ContentBlockParam => b.type === "text" ? { type: "text", text: b.text } : { type: "image", source: { type: "base64", media_type: (b as ImageContent).mimeType as any, data: (b as ImageContent).data } }) });
		} else if (m.role === "assistant") {
			const blocks: ContentBlockParam[] = [];
			for (const b of m.content) {
				if (b.type === "text" && b.text.trim()) blocks.push({ type: "text", text: b.text });
				else if (b.type === "thinking" && (b as any).redacted) blocks.push({ type: "redacted_thinking" as any, data: (b as ThinkingContent).thinkingSignature });
				else if (b.type === "thinking" && (b as ThinkingContent).thinkingSignature?.trim()) blocks.push({ type: "thinking" as any, thinking: (b as ThinkingContent).thinking, signature: (b as ThinkingContent).thinkingSignature! });
				else if (b.type === "thinking" && (b as ThinkingContent).thinking.trim()) blocks.push({ type: "text", text: (b as ThinkingContent).thinking });
				else if (b.type === "toolCall") blocks.push({ type: "tool_use", id: (b as ToolCall).id, name: (b as ToolCall).name, input: (b as ToolCall).arguments ?? {} });
			}
			if (blocks.length) out.push({ role: "assistant", content: blocks });
		} else if (m.role === "toolResult") {
			const results: any[] = [];
			while (i < msgs.length && msgs[i].role === "toolResult") {
				const tr = msgs[i] as ToolResultMessage;
				results.push({ type: "tool_result", tool_use_id: tr.toolCallId, content: tr.content.map((c: any) => c.type === "text" ? { type: "text", text: c.text } : { type: "image", source: { type: "base64", media_type: c.mimeType, data: c.data } }), is_error: tr.isError });
				i++;
			}
			i--;
			out.push({ role: "user", content: results });
		}
	}
	// Mark last user message for caching
	const last = out[out.length - 1];
	if (last?.role === "user") {
		if (Array.isArray(last.content)) {
			const lb = last.content[last.content.length - 1];
			if (lb) lb.cache_control = { type: "ephemeral" };
		} else if (typeof last.content === "string") {
			last.content = [{ type: "text", text: last.content, cache_control: { type: "ephemeral" } }];
		}
	}
	return out;
}

function streamClaudeApi(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	(async () => {
		const output: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
		try {
			const apiKey = options?.apiKey ?? "";
			const oauth = apiKey.includes("sk-ant-oat");
			const clientOpts: any = { baseURL: model.baseUrl, dangerouslyAllowBrowser: true };

			if (oauth) {
				clientOpts.apiKey = null;
				clientOpts.authToken = apiKey;
				clientOpts.defaultHeaders = {
					"anthropic-dangerous-direct-browser-access": "true",
					"anthropic-beta": "claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14,interleaved-thinking-2025-05-14",
					"user-agent": "claude-cli/2.1.94", "x-app": "cli",
				};
			} else {
				clientOpts.apiKey = apiKey;
				clientOpts.defaultHeaders = { "anthropic-dangerous-direct-browser-access": "true", "anthropic-beta": "fine-grained-tool-streaming-2025-05-14,interleaved-thinking-2025-05-14" };
			}

			const params: MessageCreateParamsStreaming = { model: model.id, messages: convertMessages(context.messages), max_tokens: options?.maxTokens || Math.floor(model.maxTokens / 3), stream: true };

			// Magic identity as SEPARATE first system entry (required for OAuth)
			if (oauth) {
				params.system = [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude.", cache_control: { type: "ephemeral" } }];
				if (context.systemPrompt) params.system.push({ type: "text", text: sanitizePrompt(context.systemPrompt), cache_control: { type: "ephemeral" } });
			} else if (context.systemPrompt) {
				params.system = [{ type: "text", text: context.systemPrompt, cache_control: { type: "ephemeral" } }];
			}

			if (context.tools) params.tools = context.tools.map((t) => ({ name: t.name, description: t.description, input_schema: { type: "object", properties: (t.parameters as any).properties || {}, required: (t.parameters as any).required || [] } }));

			// Thinking: adaptive for 4.6 models, budget-based for older
			if (model.reasoning) {
				const isAdaptive = model.id.includes("opus-4-6") || model.id.includes("sonnet-4-6");
				if (options?.reasoning && isAdaptive) {
					const effortMap: Record<string, string> = { minimal: "low", low: "low", medium: "medium", high: "high", xhigh: model.id.includes("opus") ? "max" : "high" };
					(params as any).thinking = { type: "adaptive" };
					(params as any).output_config = { effort: effortMap[options.reasoning] ?? "high" };
				} else if (options?.reasoning) {
					const budgets: Record<string, number> = { minimal: 1024, low: 4096, medium: 10240, high: 20480 };
					params.thinking = { type: "enabled", budget_tokens: options.thinkingBudgets?.[options.reasoning as any] ?? budgets[options.reasoning] ?? 10240 };
				} else if (options?.reasoning === undefined) {
					// Not specified — let model decide
				} else {
					params.thinking = { type: "disabled" };
				}
			}

			const s = new Anthropic(clientOpts).messages.stream({ ...params }, { signal: options?.signal });
			stream.push({ type: "start", partial: output });
			type Block = any & { index: number };
			const blocks = output.content as Block[];

			for await (const ev of s) {
				if (ev.type === "message_start") {
					(output as any).responseId = ev.message.id;
					const u = ev.message.usage as any;
					output.usage = { input: u.input_tokens || 0, output: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0, totalTokens: 0, cost: output.usage.cost };
					output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
					calculateCost(model, output.usage);
				} else if (ev.type === "content_block_start") {
					const b = ev.content_block;
					if (b.type === "text") { output.content.push({ type: "text", text: "", index: ev.index } as any); stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output }); }
					else if (b.type === "thinking") { output.content.push({ type: "thinking", thinking: "", thinkingSignature: "", index: ev.index } as any); stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output }); }
					else if (b.type === "redacted_thinking") { output.content.push({ type: "thinking", thinking: "[Reasoning redacted]", thinkingSignature: (b as any).data, redacted: true, index: ev.index } as any); stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output }); }
					else if (b.type === "tool_use") { output.content.push({ type: "toolCall", id: b.id, name: b.name, arguments: {}, partialJson: "", index: ev.index } as any); stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output }); }
				} else if (ev.type === "content_block_delta") {
					const idx = blocks.findIndex((b: Block) => b.index === ev.index); const block = blocks[idx]; if (!block) continue;
					if (ev.delta.type === "text_delta" && block.type === "text") { block.text += ev.delta.text; stream.push({ type: "text_delta", contentIndex: idx, delta: ev.delta.text, partial: output }); }
					else if (ev.delta.type === "thinking_delta" && block.type === "thinking") { block.thinking += ev.delta.thinking; stream.push({ type: "thinking_delta", contentIndex: idx, delta: ev.delta.thinking, partial: output }); }
					else if (ev.delta.type === "input_json_delta" && block.type === "toolCall") { block.partialJson += ev.delta.partial_json; block.arguments = parseStreamingJson(block.partialJson); stream.push({ type: "toolcall_delta", contentIndex: idx, delta: ev.delta.partial_json, partial: output }); }
					else if (ev.delta.type === "signature_delta" && block.type === "thinking") { block.thinkingSignature = (block.thinkingSignature || "") + (ev.delta as any).signature; }
				} else if (ev.type === "content_block_stop") {
					const idx = blocks.findIndex((b: Block) => b.index === ev.index); const block = blocks[idx]; if (!block) continue;
					delete block.index;
					if (block.type === "text") stream.push({ type: "text_end", contentIndex: idx, content: block.text, partial: output });
					else if (block.type === "thinking") stream.push({ type: "thinking_end", contentIndex: idx, content: block.thinking, partial: output });
					else if (block.type === "toolCall") { block.arguments = parseStreamingJson(block.partialJson); delete block.partialJson; stream.push({ type: "toolcall_end", contentIndex: idx, toolCall: block as ToolCall, partial: output }); }
				} else if (ev.type === "message_delta") {
					const d = ev.delta as any;
					if (d.stop_reason === "end_turn" || d.stop_reason === "stop_sequence" || d.stop_reason === "pause_turn") output.stopReason = "stop";
					else if (d.stop_reason === "max_tokens") output.stopReason = "length";
					else if (d.stop_reason === "tool_use") output.stopReason = "toolUse";
					else if (d.stop_reason === "refusal" || d.stop_reason === "sensitive") output.stopReason = "error";
					const u = ev.usage as any;
					if (u.input_tokens != null) output.usage.input = u.input_tokens;
					if (u.output_tokens != null) output.usage.output = u.output_tokens;
					if (u.cache_read_input_tokens != null) output.usage.cacheRead = u.cache_read_input_tokens;
					if (u.cache_creation_input_tokens != null) output.usage.cacheWrite = u.cache_creation_input_tokens;
					output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
					calculateCost(model, output.usage);
				}
			}
			if (options?.signal?.aborted) throw new Error("Aborted");
			stream.push({ type: "done", reason: output.stopReason as any, message: output }); stream.end();
		} catch (e) {
			for (const b of output.content) delete (b as any).index;
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = e instanceof Error ? e.message : String(e);
			stream.push({ type: "error", reason: output.stopReason, error: output }); stream.end();
		}
	})();
	return stream;
}

export default function (pi: ExtensionAPI) {
	pi.registerProvider("anthropic", { baseUrl: "https://api.anthropic.com", api: "anthropic-messages", streamSimple: streamClaudeApi });
}
