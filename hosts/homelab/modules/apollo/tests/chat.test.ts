import { describe, expect, it } from "bun:test";

import { copyText, imageFromLine, type LogItem, parseTranscript, renderChat } from "../src/chat";

import type { ContextNote } from "../src/temporal";

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
      { contexts: [], images: [], kind: "user", text: "hello" },
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
      contexts: [],
      images: [{ id: "a", index: 0, mimeType: "image/png" }],
      kind: "user",
      text: "look",
    });
  });

  it("emits a compaction item, thinking blocks, and a branch-summary divider", () => {
    const jsonl = [
      JSON.stringify({ id: "c", summary: "recap", tokensBefore: 123456, type: "compaction" }),
      message("a", { content: [{ thinking: "hmm", type: "thinking" }], role: "assistant" }),
      JSON.stringify({ fromId: "a", id: "d", summary: "y", type: "branch_summary" }),
    ].join("\n");

    expect(parseTranscript(jsonl)).toEqual([
      { kind: "compaction", summary: "recap", tokensBefore: 123456 },
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
      { contexts: [], images: [], kind: "user", text: "hi" },
    ]);
  });

  it("renders a skill_message custom entry as a skill item", () => {
    const jsonl = JSON.stringify({
      customType: "skill_message",
      data: { source: "reminders", text: "⏰ get my food" },
      id: "sk",
      parentId: null,
      timestamp: "t",
      type: "custom",
    });
    expect(parseTranscript(jsonl)).toEqual([
      { kind: "skill", source: "reminders", text: "⏰ get my food" },
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
    expect(parseTranscript(jsonl)).toEqual([
      { contexts: [], images: [], kind: "user", text: "ok" },
    ]);
  });

  it("drops empty user messages", () => {
    expect(parseTranscript(message("a", { content: "", role: "user" }))).toEqual([]);
  });

  it("attaches the entry timestamp when it is a valid date", () => {
    const jsonl = JSON.stringify({
      id: "a",
      message: { content: "hi", role: "user" },
      parentId: null,
      timestamp: "2026-07-14T10:00:00.000Z",
      type: "message",
    });
    expect(parseTranscript(jsonl)[0]).toMatchObject({
      kind: "user",
      time: "2026-07-14T10:00:00.000Z",
    });
  });

  it("leaves time unset when the timestamp is not a date", () => {
    const item = parseTranscript(message("a", { content: "hi", role: "user" }))[0] as {
      time?: string;
    };
    expect(item.time).toBeUndefined();
  });
});

describe("parseTranscript context", () => {
  const userItem = (jsonl: string) =>
    parseTranscript(jsonl)[0] as Extract<LogItem, { kind: "user" }>;

  it("splits leading <context> elements from the user's message", () => {
    const content =
      '<context source="reply" info="The user is replying to an earlier message they sent.">ty</context>\n\nyo';
    expect(parseTranscript(message("a", { content, role: "user" }))).toEqual([
      {
        contexts: [
          {
            body: "ty",
            info: "The user is replying to an earlier message they sent.",
            source: "reply",
          },
        ],
        images: [],
        kind: "user",
        text: "yo",
      },
    ]);
  });

  it("reads a self-closing note as an empty body and splits several notes", () => {
    const content =
      '<context source="day" info="A new calendar day has started." />\n<context source="macros" info="The macros skill sent the user a message directly.">Today: 400 kcal</context>\n\nthanks';
    const item = userItem(message("a", { content, role: "user" }));
    expect(item.contexts).toEqual([
      { body: "", info: "A new calendar day has started.", source: "day" },
      {
        body: "Today: 400 kcal",
        info: "The macros skill sent the user a message directly.",
        source: "macros",
      },
    ]);
    expect(item.text).toBe("thanks");
  });

  it("preserves a multi-line context body", () => {
    const content = '<context source="macros" info="summary">line1\n\nline2</context>\n\nhi';
    const item = userItem(message("a", { content, role: "user" }));
    expect(item.contexts?.[0]?.body).toBe("line1\n\nline2");
    expect(item.text).toBe("hi");
  });

  it("unescapes a quoted attribute value", () => {
    const content = '<context source="day" info="say &quot;hi&quot;" />\n\nyo';
    expect(userItem(message("a", { content, role: "user" })).contexts?.[0]?.info).toBe('say "hi"');
  });

  it("leaves an ordinary message untouched", () => {
    const item = userItem(message("a", { content: "just a message", role: "user" }));
    expect(item.contexts).toEqual([]);
    expect(item.text).toBe("just a message");
  });

  it("treats the older [context] line format as plain message text", () => {
    const content = "[context] old style\n\nhey";
    const item = userItem(message("a", { content, role: "user" }));
    expect(item.contexts).toEqual([]);
    expect(item.text).toBe(content);
  });
});

describe("imageFromLine", () => {
  const b64 = (text: string) => Buffer.from(text).toString("base64");

  it("extracts the Nth image block as bytes with its mime type", () => {
    const line = message("a", {
      content: [
        { text: "hi", type: "text" },
        { data: b64("one"), mimeType: "image/png", type: "image" },
        { data: b64("two"), mimeType: "image/webp", type: "image" },
      ],
      role: "user",
    });
    expect(imageFromLine(line, 0)).toEqual({ bytes: Buffer.from("one"), mimeType: "image/png" });
    expect(imageFromLine(line, 1)).toEqual({ bytes: Buffer.from("two"), mimeType: "image/webp" });
  });

  it("defaults a missing mime type to image/jpeg", () => {
    const line = message("a", { content: [{ data: b64("x"), type: "image" }], role: "user" });
    expect(imageFromLine(line, 0)?.mimeType).toBe("image/jpeg");
  });

  it("returns undefined for an out-of-range index, no images, or bad JSON", () => {
    const line = message("a", {
      content: [{ data: b64("x"), mimeType: "image/png", type: "image" }],
      role: "user",
    });
    expect(imageFromLine(line, 5)).toBeUndefined();
    expect(imageFromLine(message("b", { content: "hi", role: "user" }), 0)).toBeUndefined();
    expect(imageFromLine("{not json", 0)).toBeUndefined();
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

  it("marks an orphaned resultless tool call (one the conversation moved past) as interrupted", () => {
    const html = renderChat([
      {
        args: {},
        hasResult: false,
        images: 0,
        isError: false,
        kind: "tool",
        name: "bash",
        output: "",
      },
      { kind: "assistant", text: "moved on" },
    ]);
    expect(html).toContain("interrupted");
    expect(html).not.toContain("running");
  });

  it("shows a trailing resultless tool as running only while a run is live", () => {
    const tool = {
      args: {},
      hasResult: false,
      images: 0,
      isError: false,
      kind: "tool" as const,
      name: "bash",
      output: "",
    };
    expect(renderChat([tool], new Date(), true)).toContain("running");
    expect(renderChat([tool], new Date(), false)).toContain("interrupted");
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

  it("references user images out-of-band with lazy loading and opens the lightbox", () => {
    const html = renderChat([
      { images: [{ id: "a", index: 0, mimeType: "image/png" }], kind: "user", text: "" },
    ]);
    expect(html).toContain('src="/media/a/0"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain("cursor-zoom-in");
    expect(html).toContain("lightbox");
    expect(html).not.toContain("base64");
  });

  it("renders a compaction entry as an expandable summary with token count", () => {
    const html = renderChat([
      { kind: "compaction", summary: "what happened", tokensBefore: 123456 },
    ]);
    expect(html).toContain("<details");
    expect(html).toContain("Context compacted");
    expect(html).toContain("123K");
    expect(html).toContain("what happened");
  });

  it("escapes the compaction summary", () => {
    const html = renderChat([
      { kind: "compaction", summary: "<script>alert(1)</script>", tokensBefore: undefined },
    ]);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("stamps timed bubbles with a clock", () => {
    const html = renderChat(
      [{ images: [], kind: "user", text: "hi", time: "2026-07-14T10:00:00.000Z" }],
      new Date("2026-07-14T12:00:00.000Z"),
    );
    expect(html).toMatch(/>\d{2}:\d{2}</);
  });

  it("inserts one day divider per day", () => {
    const html = renderChat(
      [
        { images: [], kind: "user", text: "a", time: "2026-07-14T09:00:00.000Z" },
        { kind: "assistant", text: "b", time: "2026-07-14T10:00:00.000Z" },
      ],
      new Date("2026-07-14T12:00:00.000Z"),
    );
    expect(html.match(/Today/g)?.length).toBe(1);
  });

  it("labels day dividers as Today, Yesterday, or DD.MM.YYYY", () => {
    const html = renderChat(
      [
        { images: [], kind: "user", text: "a", time: "2026-07-10T12:00:00.000Z" },
        { kind: "assistant", text: "b", time: "2026-07-13T12:00:00.000Z" },
        { kind: "assistant", text: "c", time: "2026-07-14T12:00:00.000Z" },
      ],
      new Date("2026-07-14T12:00:00.000Z"),
    );
    expect(html).toContain("10.07.2026");
    expect(html).toContain("Yesterday");
    expect(html).toContain("Today");
  });

  it("adds no day divider for untimed items", () => {
    expect(renderChat([{ kind: "assistant", text: "x" }])).not.toContain("Today");
  });

  it("renders a skill message as a badged left bubble, escaping content", () => {
    const html = renderChat([{ kind: "skill", source: "reminders", text: "⏰ get my food" }]);
    expect(html).toContain("via reminders");
    expect(html).toContain("get my food");

    const unsafe = renderChat([
      { kind: "skill", source: "<x>", text: "<script>alert(1)</script>" },
    ]);
    expect(unsafe).toContain("&lt;x&gt;");
    expect(unsafe).toContain("&lt;script&gt;");
    expect(unsafe).not.toContain("<script>");
  });

  it("emits newest-first so the column-reverse container shows the latest at the bottom", () => {
    const html = renderChat(
      [
        { images: [], kind: "user", text: "older", time: "2026-07-14T09:00:00.000Z" },
        { kind: "assistant", text: "newer", time: "2026-07-14T10:00:00.000Z" },
      ],
      new Date("2026-07-14T12:00:00.000Z"),
    );
    expect(html.indexOf("newer")).toBeLessThan(html.indexOf("older"));
  });
});

describe("copyText", () => {
  it("formats a user message WhatsApp-style with an ISO date stamp", () => {
    const text = copyText({ images: [], kind: "user", text: "hi", time: "2026-07-19T09:01:00Z" });
    expect(text).toMatch(/^\[\d{2}:\d{2}, \d{4}-\d{2}-\d{2}\] User: hi$/);
  });

  it("omits the stamp when there is no time", () => {
    expect(copyText({ kind: "assistant", text: "yo" })).toBe("Apollo: yo");
  });

  it("notes images on a user message", () => {
    expect(
      copyText({ images: [{ id: "a", index: 0, mimeType: "image/png" }], kind: "user", text: "" }),
    ).toBe("User: [1 image]");
    expect(
      copyText({
        images: [
          { id: "a", index: 0, mimeType: "image/png" },
          { id: "a", index: 1, mimeType: "image/png" },
        ],
        kind: "user",
        text: "look",
      }),
    ).toBe("User: look [2 images]");
  });

  it("renders a tool call with args preview, status, and output", () => {
    expect(
      copyText({
        args: { command: "ls" },
        hasResult: true,
        images: 0,
        isError: false,
        kind: "tool",
        name: "bash",
        output: "file.txt",
      }),
    ).toBe("Apollo → bash(ls) [ok]\nfile.txt");
  });

  it("marks tool errors and missing results", () => {
    expect(
      copyText({
        args: {},
        hasResult: true,
        images: 0,
        isError: true,
        kind: "tool",
        name: "bash",
        output: "boom",
      }),
    ).toContain("[error]");
    expect(
      copyText({
        args: {},
        hasResult: false,
        images: 0,
        isError: false,
        kind: "tool",
        name: "read",
        output: "",
      }),
    ).toContain("[no result]");
  });

  it("renders a bash execution with command, output, and exit", () => {
    expect(copyText({ command: "echo hi", exitCode: 0, kind: "bash", output: "hi" })).toBe(
      "Apollo → bash: echo hi\nhi\n(exit 0)",
    );
  });

  it("renders thinking, compaction, and dividers", () => {
    expect(copyText({ kind: "thinking", text: "hmm" })).toBe("Apollo (thinking): hmm");
    expect(copyText({ kind: "compaction", summary: "recap", tokensBefore: 123456 })).toBe(
      "Context compacted (~123K tokens)\nrecap",
    );
    expect(copyText({ kind: "divider", label: "Reloaded" })).toBe("Reloaded");
  });

  it("formats a skill message with its source", () => {
    expect(copyText({ kind: "skill", source: "macros", text: "Today: 400 kcal" })).toBe(
      "Apollo (via macros): Today: 400 kcal",
    );
  });

  it("keeps the injected context (as a <context> element) in the copied user message", () => {
    expect(
      copyText({
        contexts: [{ body: "b", info: "i", source: "reply" }],
        images: [],
        kind: "user",
        text: "yo",
      }),
    ).toBe('User: <context source="reply" info="i">b</context>\n\nyo');
  });

  it("copies a body-less context note as a self-closing element", () => {
    expect(
      copyText({
        contexts: [{ body: "", info: "A new day.", source: "day" }],
        images: [],
        kind: "user",
        text: "morning",
      }),
    ).toBe('User: <context source="day" info="A new day." />\n\nmorning');
  });

  it("truncates long tool output", () => {
    const text = copyText({
      args: {},
      hasResult: true,
      images: 0,
      isError: false,
      kind: "tool",
      name: "bash",
      output: "x".repeat(20000),
    });
    expect(text).toContain("more chars");
  });
});

describe("renderChat data-copy", () => {
  it("embeds a data-copy attribute on message rows", () => {
    expect(renderChat([{ kind: "assistant", text: "hi" }])).toContain('data-copy="Apollo: hi"');
  });

  it("does not embed data-copy on day dividers", () => {
    const html = renderChat(
      [{ images: [], kind: "user", text: "a", time: "2026-07-19T09:00:00.000Z" }],
      new Date("2026-07-19T12:00:00.000Z"),
    );
    // Only the user row carries data-copy; the inserted day divider must not.
    expect((html.match(/data-copy=/g) ?? []).length).toBe(1);
  });
});

describe("renderChat context notes", () => {
  const userItem = (contexts: ContextNote[], text = "hi"): LogItem => ({
    contexts,
    images: [],
    kind: "user",
    text,
  });

  it("renders a note with a body as an expandable dropdown (source tag + info + body)", () => {
    const html = renderChat([
      userItem([
        {
          body: "Today: 400 kcal",
          info: "The macros skill sent the user a message directly.",
          source: "macros",
        },
      ]),
    ]);
    expect(html).toContain("<details");
    expect(html).toContain("macros");
    expect(html).toContain("The macros skill sent the user a message directly.");
    expect(html).toContain("Today: 400 kcal");
  });

  it("renders a body-less note as a static chip, not a dropdown", () => {
    const html = renderChat([
      userItem([{ body: "", info: "A new calendar day has started.", source: "day" }]),
    ]);
    expect(html).toContain("A new calendar day has started.");
    expect(html).not.toContain("<details");
  });

  it("still renders the user's message alongside the context", () => {
    expect(
      renderChat([userItem([{ body: "b", info: "i", source: "reply" }], "my message")]),
    ).toContain("my message");
  });

  it("escapes source, info, and body", () => {
    const html = renderChat([
      userItem([{ body: "<b>x</b>", info: "<i>y</i>", source: "<s>" }], "ok"),
    ]);
    expect(html).toContain("&lt;s&gt;");
    expect(html).toContain("&lt;i&gt;y&lt;/i&gt;");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toContain("<b>x</b>");
  });
});
