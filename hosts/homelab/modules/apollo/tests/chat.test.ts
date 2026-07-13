import { describe, expect, it } from "bun:test";

import { parseTranscript, renderChat } from "../src/chat";

const header = JSON.stringify({ cwd: "/w", id: "s", timestamp: "t", type: "session", version: 3 });

function message(id: string, message: unknown): string {
  return JSON.stringify({ id, message, parentId: null, timestamp: "t", type: "message" });
}

describe("parseTranscript", () => {
  it("maps user and assistant text messages", () => {
    const jsonl = [
      header,
      message("a", { content: "hello", role: "user" }),
      message("b", { content: [{ text: "hi there", type: "text" }], role: "assistant" }),
    ].join("\n");

    expect(parseTranscript(jsonl)).toEqual([
      { images: [], kind: "user", text: "hello" },
      { kind: "assistant", text: "hi there" },
    ]);
  });

  it("joins a tool call with its result and consumes the standalone result", () => {
    const jsonl = [
      message("a", {
        content: [{ arguments: { command: "ls" }, id: "t1", name: "bash", type: "toolCall" }],
        role: "assistant",
      }),
      message("b", {
        content: [{ text: "file.txt", type: "text" }],
        isError: false,
        role: "toolResult",
        toolCallId: "t1",
      }),
    ].join("\n");

    expect(parseTranscript(jsonl)).toEqual([
      {
        args: { command: "ls" },
        hasResult: true,
        images: 0,
        isError: false,
        kind: "tool",
        name: "bash",
        output: "file.txt",
      },
    ]);
  });

  it("marks error results and tool calls that have no result yet", () => {
    const withError = parseTranscript(
      [
        message("a", {
          content: [{ arguments: {}, id: "t1", name: "bash", type: "toolCall" }],
          role: "assistant",
        }),
        message("b", {
          content: [{ text: "boom", type: "text" }],
          isError: true,
          role: "toolResult",
          toolCallId: "t1",
        }),
      ].join("\n"),
    );
    expect(withError[0]).toMatchObject({ isError: true, kind: "tool", output: "boom" });

    const pending = parseTranscript(
      message("a", {
        content: [{ arguments: {}, id: "t9", name: "read", type: "toolCall" }],
        role: "assistant",
      }),
    );
    expect(pending[0]).toMatchObject({ hasResult: false, kind: "tool" });
  });

  it("separates text and images in a user message and counts result images", () => {
    const items = parseTranscript(
      message("a", {
        content: [
          { text: "look", type: "text" },
          { data: "AAAA", mimeType: "image/png", type: "image" },
        ],
        role: "user",
      }),
    );
    expect(items[0]).toEqual({
      images: [{ data: "AAAA", mimeType: "image/png" }],
      kind: "user",
      text: "look",
    });
  });

  it("emits thinking blocks and dividers for compaction and branch summaries", () => {
    const jsonl = [
      JSON.stringify({ id: "c", summary: "x", type: "compaction" }),
      message("a", { content: [{ thinking: "hmm", type: "thinking" }], role: "assistant" }),
      JSON.stringify({ fromId: "a", id: "d", summary: "y", type: "branch_summary" }),
    ].join("\n");

    expect(parseTranscript(jsonl)).toEqual([
      { kind: "divider", label: "Context compacted" },
      { kind: "thinking", text: "hmm" },
      { kind: "divider", label: "Branch summary" },
    ]);
  });

  it("renders a reload marker as a divider", () => {
    const jsonl = [
      JSON.stringify({
        customType: "apollo_reload",
        data: {},
        id: "r",
        parentId: null,
        timestamp: "t",
        type: "custom",
      }),
      message("a", { content: "hi", role: "user" }),
    ].join("\n");

    expect(parseTranscript(jsonl)).toEqual([
      { kind: "divider", label: "Reloaded" },
      { images: [], kind: "user", text: "hi" },
    ]);
  });

  it("ignores custom entries of other types", () => {
    const jsonl = JSON.stringify({
      customType: "something_else",
      id: "x",
      parentId: null,
      timestamp: "t",
      type: "custom",
    });
    expect(parseTranscript(jsonl)).toEqual([]);
  });

  it("renders bash-execution messages with command and exit code", () => {
    const items = parseTranscript(
      message("a", { command: "echo hi", exitCode: 0, output: "hi", role: "bashExecution" }),
    );
    expect(items[0]).toEqual({ command: "echo hi", exitCode: 0, kind: "bash", output: "hi" });
  });

  it("tolerates the header, blank lines, and a half-written trailing line", () => {
    const jsonl = [header, "", message("a", { content: "ok", role: "user" }), '{"type":"mess'].join(
      "\n",
    );
    expect(parseTranscript(jsonl)).toEqual([{ images: [], kind: "user", text: "ok" }]);
  });

  it("drops empty user messages", () => {
    expect(parseTranscript(message("a", { content: "", role: "user" }))).toEqual([]);
  });
});

describe("renderChat", () => {
  it("shows a placeholder when there is nothing to show", () => {
    expect(renderChat([])).toContain("No messages yet");
  });

  it("escapes user text to prevent HTML injection", () => {
    const html = renderChat([{ images: [], kind: "user", text: "<script>alert(1)</script>" }]);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("renders a tool row with an expandable disclosure and status badge", () => {
    const html = renderChat([
      {
        args: { command: "ls -la" },
        hasResult: true,
        images: 0,
        isError: false,
        kind: "tool",
        name: "bash",
        output: "out",
      },
    ]);
    expect(html).toContain("<details");
    expect(html).toContain("bash");
    expect(html).toContain("ls -la");
    expect(html).toContain(">ok<");
  });

  it("truncates very long tool output", () => {
    const html = renderChat([
      {
        args: {},
        hasResult: true,
        images: 0,
        isError: false,
        kind: "tool",
        name: "bash",
        output: "x".repeat(20000),
      },
    ]);
    expect(html).toContain("more chars");
  });

  it("embeds user images as data URIs", () => {
    const html = renderChat([
      { images: [{ data: "AAAA", mimeType: "image/png" }], kind: "user", text: "" },
    ]);
    expect(html).toContain("data:image/png;base64,AAAA");
  });
});
