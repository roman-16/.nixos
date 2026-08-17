import { describe, expect, it } from "bun:test";

import {
  copyText,
  imageFromLine,
  type LogItem,
  parseTranscript,
  renderChat,
  renderOlder,
} from "../src/chat";

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
      { contexts: [], entry: "a", images: [], kind: "user", text: "hello" },
      { entry: "b", kind: "assistant", text: "hi there" },
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
        entry: "a",
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
      entry: "a",
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
      { entry: "c", kind: "compaction", summary: "recap", tokensBefore: 123456 },
      { entry: "a", kind: "thinking", text: "hmm" },
      { entry: "d", kind: "divider", label: "Branch summary" },
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
      { entry: "r", kind: "divider", label: "Reloaded" },
      { contexts: [], entry: "a", images: [], kind: "user", text: "hi" },
    ]);
  });

  it("splits an assistant block into what was sent and the notes that were not", () => {
    const jsonl = message("a", {
      content: [{ text: "Done \u2705\n<internal>macros already sent it</internal>", type: "text" }],
      role: "assistant",
    });
    expect(parseTranscript(jsonl)).toEqual([
      { entry: "a", kind: "assistant", text: "Done \u2705" },
      { entry: "a", kind: "internal", text: "macros already sent it" },
    ]);
  });

  it("renders a silent turn as an internal item alone", () => {
    const jsonl = message("a", {
      content: [{ text: "<internal>nothing to add</internal>", type: "text" }],
      role: "assistant",
    });
    expect(parseTranscript(jsonl)).toEqual([
      { entry: "a", kind: "internal", text: "nothing to add" },
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
      {
        entry: "sk",
        files: [],
        images: [],
        kind: "skill",
        source: "reminders",
        text: "⏰ get my food",
      },
    ]);
  });

  it("reads the image a skill message delivered", () => {
    const jsonl = JSON.stringify({
      customType: "skill_message",
      data: {
        images: [{ data: "AAAA", mimeType: "image/png", type: "image" }],
        source: "diagram",
        text: "how a message reaches you",
      },
      id: "sk",
      parentId: null,
      timestamp: "t",
      type: "custom",
    });
    expect(parseTranscript(jsonl)).toEqual([
      {
        entry: "sk",
        files: [],
        images: [{ id: "sk", index: 0, mimeType: "image/png" }],
        kind: "skill",
        source: "diagram",
        text: "how a message reaches you",
      },
    ]);
  });

  it("reads the file a skill message delivered", () => {
    const jsonl = JSON.stringify({
      customType: "skill_message",
      data: {
        files: [{ mimeType: "application/zip", name: "bike-notes.zip", size: 148_000 }],
        source: "files",
        text: "12 notes from your vault",
      },
      id: "sk",
      parentId: null,
      timestamp: "t",
      type: "custom",
    });
    expect(parseTranscript(jsonl)).toEqual([
      {
        entry: "sk",
        files: [{ mimeType: "application/zip", name: "bike-notes.zip", size: 148_000 }],
        images: [],
        kind: "skill",
        source: "files",
        text: "12 notes from your vault",
      },
    ]);
  });

  it("ignores a recorded file that is not one", () => {
    const jsonl = JSON.stringify({
      customType: "skill_message",
      data: { files: ["bike-notes.zip", { size: 10 }], source: "files", text: "" },
      id: "sk",
      parentId: null,
      timestamp: "t",
      type: "custom",
    });
    expect((parseTranscript(jsonl)[0] as { files: unknown[] }).files).toEqual([]);
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
    expect(items[0]).toEqual({
      command: "echo hi",
      entry: "a",
      exitCode: 0,
      kind: "bash",
      output: "hi",
    });
  });

  it("tolerates the header, blank lines, and a half-written trailing line", () => {
    const jsonl = [header, "", message("a", { content: "ok", role: "user" }), '{"type":"mess'].join(
      "\n",
    );
    expect(parseTranscript(jsonl)).toEqual([
      { contexts: [], entry: "a", images: [], kind: "user", text: "ok" },
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
        entry: "a",
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

  it("extracts an image a skill message delivered", () => {
    const line = JSON.stringify({
      customType: "skill_message",
      data: {
        images: [{ data: b64("diagram"), mimeType: "image/png", type: "image" }],
        source: "diagram",
        text: "",
      },
      id: "sk",
      type: "custom",
    });
    expect(imageFromLine(line, 0)).toEqual({
      bytes: Buffer.from("diagram"),
      mimeType: "image/png",
    });
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
    expect(renderChat([tool], { live: true })).toContain("running");
    expect(renderChat([tool], { live: false })).toContain("interrupted");
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

  it("gives an image a height before it loads, so it cannot shift the text around it", () => {
    // An unsized <img> is nothing until the bytes arrive and 160px afterwards, which moves whatever
    // the reader is looking at. A definite height makes vertical layout independent of loading.
    const html = renderChat([
      { images: [{ id: "a", index: 0, mimeType: "image/png" }], kind: "user", text: "" },
    ]);
    expect(html).toContain("h-40");
    expect(html).toContain("object-contain");
    expect(html).not.toContain("max-h-40");
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
      { now: new Date("2026-07-14T12:00:00.000Z") },
    );
    expect(html).toMatch(/>\d{2}:\d{2}</);
  });

  it("inserts one day divider per day", () => {
    const html = renderChat(
      [
        { images: [], kind: "user", text: "a", time: "2026-07-14T09:00:00.000Z" },
        { kind: "assistant", text: "b", time: "2026-07-14T10:00:00.000Z" },
      ],
      { now: new Date("2026-07-14T12:00:00.000Z") },
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
      { now: new Date("2026-07-14T12:00:00.000Z") },
    );
    expect(html).toContain("10.07.2026");
    expect(html).toContain("Yesterday");
    expect(html).toContain("Today");
  });

  it("adds no day divider for untimed items", () => {
    expect(renderChat([{ kind: "assistant", text: "x" }])).not.toContain("Today");
  });

  it("identifies each day divider by its day, so a page of history can take it over", () => {
    const html = renderChat([
      { images: [], kind: "user", text: "a", time: "2026-07-14T09:00:00.000Z" },
    ]);
    expect(html).toContain('id="day-2026-07-14"');
    expect(html).toContain('data-day="2026-07-14"');
  });

  it("leaves a day's divider to the rows above when they already drew it", () => {
    // The live tail sits under loaded history; redrawing a divider history owns would strand it.
    const html = renderChat(
      [{ images: [], kind: "user", text: "a", time: "2026-07-14T09:00:00.000Z" }],
      { dayAbove: "2026-07-14" },
    );
    expect(html).not.toContain('id="day-2026-07-14"');
  });

  it("still opens a day the rows above do not reach", () => {
    const html = renderChat(
      [{ images: [], kind: "user", text: "a", time: "2026-07-14T09:00:00.000Z" }],
      { dayAbove: "2026-07-13" },
    );
    expect(html).toContain('id="day-2026-07-14"');
  });

  it("tags each row with the entry it came from, and dividers with none", () => {
    // This is how the client names the oldest row it holds when it asks for the page before it.
    const html = renderChat([
      { entry: "e7", images: [], kind: "user", text: "a", time: "2026-07-14T09:00:00.000Z" },
    ]);
    expect(html).toContain('data-entry="e7"');
    expect((html.match(/data-entry=/g) ?? []).length).toBe(1);
  });

  it("marks an internal note as not sent and escapes it", () => {
    const html = renderChat([{ kind: "internal", text: "<b>nothing to add</b>" }]);
    expect(html).toContain("not sent");
    expect(html).toContain("&lt;b&gt;");
    expect(html).not.toContain("<b>nothing");
  });

  it("renders a skill message as a badged left bubble, escaping content", () => {
    const html = renderChat([
      { files: [], images: [], kind: "skill", source: "reminders", text: "⏰ get my food" },
    ]);
    expect(html).toContain("via reminders");
    expect(html).toContain("get my food");

    const unsafe = renderChat([
      { files: [], images: [], kind: "skill", source: "<x>", text: "<script>alert(1)</script>" },
    ]);
    expect(unsafe).toContain("&lt;x&gt;");
    expect(unsafe).toContain("&lt;script&gt;");
    expect(unsafe).not.toContain("<script>");
  });

  it("shows a skill message's image, and no empty paragraph when it has no caption", () => {
    const html = renderChat([
      {
        files: [],
        images: [{ id: "sk", index: 0, mimeType: "image/png" }],
        kind: "skill",
        source: "diagram",
        text: "",
      },
    ]);
    expect(html).toContain('src="/media/sk/0"');
    expect(html).toContain("via diagram");
    expect(html).not.toContain('<p class="whitespace-pre-wrap break-words"></p>');
  });

  it("names a file the chat exchanged, with its size, and escapes the name", () => {
    const html = renderChat([
      {
        files: [{ mimeType: "application/zip", name: "bike <notes>.zip", size: 151_552 }],
        images: [],
        kind: "skill",
        source: "files",
        text: "12 notes",
      },
    ]);
    expect(html).toContain("bike &lt;notes&gt;.zip");
    expect(html).toContain("148 KB");
    expect(html).not.toContain("<notes>");
  });

  it("does not offer a file for download - it is on the phone, not on this page", () => {
    const html = renderChat([
      {
        files: [{ mimeType: "application/zip", name: "bike-notes.zip", size: 10 }],
        images: [],
        kind: "skill",
        source: "files",
        text: "",
      },
    ]);
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("href");
  });

  it("emits rows in reading order, so DOM order matches what is on screen", () => {
    const html = renderChat(
      [
        { images: [], kind: "user", text: "older", time: "2026-07-14T09:00:00.000Z" },
        { kind: "assistant", text: "newer", time: "2026-07-14T10:00:00.000Z" },
      ],
      { now: new Date("2026-07-14T12:00:00.000Z") },
    );
    expect(html.indexOf("older")).toBeLessThan(html.indexOf("newer"));
  });

  it("puts a day divider before the day it labels", () => {
    const html = renderChat(
      [{ images: [], kind: "user", text: "morning", time: "2026-07-14T09:00:00.000Z" }],
      { now: new Date("2026-07-14T12:00:00.000Z") },
    );
    expect(html.indexOf("Today")).toBeLessThan(html.indexOf("morning"));
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
    expect(
      copyText({
        files: [],
        images: [],
        kind: "skill",
        source: "macros",
        text: "Today: 400 kcal",
      }),
    ).toBe("Apollo (via macros): Today: 400 kcal");
  });

  it("notes an image a skill message delivered, captioned or not", () => {
    const image = { id: "sk", index: 0, mimeType: "image/png" };
    expect(
      copyText({ files: [], images: [image], kind: "skill", source: "diagram", text: "the flow" }),
    ).toBe("Apollo (via diagram): the flow [1 image]");
    expect(
      copyText({ files: [], images: [image], kind: "skill", source: "diagram", text: "" }),
    ).toBe("Apollo (via diagram): [1 image]");
  });

  it("names a file a skill message delivered, captioned or not", () => {
    const file = { mimeType: "application/zip", name: "bike-notes.zip", size: 148_000 };
    expect(
      copyText({ files: [file], images: [], kind: "skill", source: "files", text: "12 notes" }),
    ).toBe("Apollo (via files): 12 notes [file: bike-notes.zip]");
    expect(copyText({ files: [file], images: [], kind: "skill", source: "files", text: "" })).toBe(
      "Apollo (via files): [file: bike-notes.zip]",
    );
  });

  it("marks a copied internal note as never delivered", () => {
    expect(copyText({ kind: "internal", text: "nothing to add" })).toBe(
      "Apollo (internal, not sent): nothing to add",
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
      { now: new Date("2026-07-19T12:00:00.000Z") },
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

describe("renderOlder", () => {
  const at = (day: string, hour: string) => `2026-07-${day}T${hour}:00:00.000Z`;
  const row = (day: string, hour: string, text: string): LogItem => ({
    entry: `e-${day}-${hour}`,
    images: [],
    kind: "user",
    text,
    time: at(day, hour),
  });

  it("renders a page of older rows with their own day dividers", () => {
    const html = renderOlder([row("12", "09", "older")], { now: new Date(at("14", "12")) });
    expect(html).toContain("older");
    expect(html).toContain('id="day-2026-07-12"');
  });

  it("retires the divider below it when it continues that same day upward", () => {
    // The page's rows belong to the day the existing rows open with, so that divider is now stranded
    // in the middle of the day: the page draws it where it belongs and deletes the old one.
    const html = renderOlder([row("14", "08", "earlier that day")], {
      dayBelow: "2026-07-14",
      now: new Date(at("14", "12")),
    });
    expect(html).toContain('id="day-2026-07-14" hx-swap-oob="delete"');
    expect(html.indexOf('id="day-2026-07-14"')).toBeLessThan(html.indexOf("hx-swap-oob"));
  });

  it("leaves the divider below alone when the page ends on an earlier day", () => {
    const html = renderOlder([row("12", "09", "another day")], {
      dayBelow: "2026-07-14",
      now: new Date(at("14", "12")),
    });
    expect(html).not.toContain("hx-swap-oob");
  });

  it("never reports a page as running, however it ends", () => {
    const html = renderOlder([
      {
        args: {},
        entry: "e1",
        hasResult: false,
        images: 0,
        isError: false,
        kind: "tool",
        name: "bash",
        output: "",
      },
    ]);
    expect(html).toContain("interrupted");
    expect(html).not.toContain("running");
  });

  it("renders nothing at the beginning of the conversation", () => {
    expect(renderOlder([])).toBe("");
    expect(renderOlder([])).not.toContain("No messages yet");
  });
});
