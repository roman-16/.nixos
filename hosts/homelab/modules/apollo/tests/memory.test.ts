import { describe, expect, it } from "bun:test";

import { buildFoldPrompt, memoryBlock, readFoldOutput, renderEvidence } from "../src/memory";

const PATH = "/var/lib/apollo/workspace/MEMORY.md";

describe("memoryBlock", () => {
  it("wraps the file in an element naming where it lives", () => {
    expect(memoryBlock(PATH, "## User\n- Lives in Austria")).toBe(
      `<memory path="${PATH}">\n## User\n- Lives in Austria\n</memory>`,
    );
  });

  it("injects nothing when there is nothing to remember yet", () => {
    expect(memoryBlock(PATH, "")).toBe("");
    expect(memoryBlock(PATH, "   \n\n")).toBe("");
  });

  it("trims the file's surrounding whitespace", () => {
    expect(memoryBlock(PATH, "\n\nremember this\n\n")).toContain(">\nremember this\n<");
  });

  it("caps a pathological file, since it costs context every turn", () => {
    const block = memoryBlock(PATH, "x".repeat(20000));
    expect(block.length).toBeLessThan(13000);
    expect(block).toContain("…");
  });
});

/** A session entry as pi stores it: an ISO timestamp on the entry, content blocks on the message. */
function entry(role: string, text: string, iso: string, extra: unknown[] = []): any {
  return {
    id: `e-${iso}`,
    message: { content: [{ text, type: "text" }, ...extra], role },
    parentId: null,
    timestamp: iso,
    type: "message",
  };
}

const T = {
  eight: "2026-07-29T08:12:00.000Z",
  nine: "2026-07-29T09:30:00.000Z",
  ten: "2026-07-29T10:00:00.000Z",
};

const before = Date.parse("2026-07-29T00:00:00.000Z");

describe("renderEvidence", () => {
  it("renders what each side said, oldest first, stamped with when", () => {
    const evidence = renderEvidence(
      [entry("user", "I ride a Ducati", T.eight), entry("assistant", "noted", T.nine)],
      before,
      10_000,
    );
    expect(evidence.messages).toBe(2);
    expect(evidence.text).toMatch(/^\[\w{3} \d{2}\.\d{2} \d{2}:\d{2}\] You: I ride a Ducati$/m);
    expect(evidence.text).toContain("Apollo: noted");
    expect(evidence.text.indexOf("Ducati")).toBeLessThan(evidence.text.indexOf("noted"));
  });

  it("reads only what was said: no thinking, tool calls, tool results or images", () => {
    const entries = [
      entry("user", "look at this", T.eight, [
        { data: "AAAA", mimeType: "image/png", type: "image" },
      ]),
      {
        id: "a",
        message: {
          content: [
            { thinking: "the user seems to ride a Ducati", type: "thinking" },
            { arguments: { command: "ls" }, id: "t1", name: "bash", type: "toolCall" },
            { text: "it is a Monster", type: "text" },
          ],
          role: "assistant",
        },
        parentId: null,
        timestamp: T.nine,
        type: "message",
      },
      {
        id: "b",
        message: {
          content: [{ text: "total 4", type: "text" }],
          role: "toolResult",
          toolCallId: "t1",
        },
        parentId: null,
        timestamp: T.ten,
        type: "message",
      },
    ] as any[];
    const { text } = renderEvidence(entries, before, 10_000);
    expect(text).toContain("look at this");
    expect(text).toContain("it is a Monster");
    expect(text).not.toContain("seems to ride");
    expect(text).not.toContain("ls");
    expect(text).not.toContain("total 4");
    expect(text).not.toContain("AAAA");
  });

  it("reads a message as WhatsApp saw it, without the app's context or Apollo's own notes", () => {
    const entries = [
      entry(
        "user",
        '<context source="time" info="Sent Sunday 02.08.2026 14:47." />\n\nlog 100g',
        T.eight,
      ),
      entry("assistant", "Done \u2705<internal>macros already sent it</internal>", T.nine),
    ];
    const { text } = renderEvidence(entries, before, 10_000);
    expect(text).toContain("You: log 100g");
    expect(text).not.toContain("<context");
    expect(text).toContain("Apollo: Done");
    expect(text).not.toContain("already sent it");
  });

  it("skips a message with nothing left to read", () => {
    const entries = [
      entry("assistant", "<internal>nothing to add</internal>", T.eight),
      entry("user", "hi", T.nine),
    ];
    expect(renderEvidence(entries, before, 10_000).messages).toBe(1);
  });

  it("reads only what is newer than the cursor", () => {
    const entries = [entry("user", "old news", T.eight), entry("user", "fresh news", T.ten)];
    const { text } = renderEvidence(entries, Date.parse(T.nine), 10_000);
    expect(text).toContain("fresh news");
    expect(text).not.toContain("old news");
  });

  it("reports the newest message time, so the cursor lands past everything it saw", () => {
    const entries = [entry("user", "a", T.eight), entry("user", "b", T.ten)];
    expect(renderEvidence(entries, before, 10_000).newestMs).toBe(Date.parse(T.ten));
  });

  it("counts a message it skipped as seen, so an empty span still moves the cursor", () => {
    const entries = [entry("assistant", "<internal>quiet</internal>", T.ten)];
    const evidence = renderEvidence(entries, before, 10_000);
    expect(evidence.messages).toBe(0);
    expect(evidence.newestMs).toBe(Date.parse(T.ten));
  });

  it("keeps the newest when the window is full, and says older was left out", () => {
    const entries = [
      entry("user", `old ${"x".repeat(400)}`, T.eight),
      entry("user", `new ${"y".repeat(400)}`, T.ten),
    ];
    const evidence = renderEvidence(entries, before, 500);
    expect(evidence.text).toContain("new");
    expect(evidence.text).not.toContain("old");
    expect(evidence.skippedOlder).toBe(true);
  });

  it("keeps both ends of a very long message", () => {
    const long = `start ${"m".repeat(5000)} finish`;
    const { text } = renderEvidence([entry("user", long, T.eight)], before, 100_000);
    expect(text).toContain("start");
    expect(text).toContain("finish");
    expect(text).toContain("characters omitted");
  });

  it("has nothing to say about an empty session", () => {
    expect(renderEvidence([], before, 10_000)).toMatchObject({ messages: 0, text: "" });
  });

  it("ignores entries that are not messages", () => {
    const entries = [
      { id: "c", summary: "recap", timestamp: T.eight, tokensBefore: 1, type: "compaction" },
      entry("user", "hi", T.nine),
    ] as any[];
    expect(renderEvidence(entries, before, 10_000).messages).toBe(1);
  });
});

describe("buildFoldPrompt", () => {
  const instructions = "Maintain it.";

  it("hands over the doctrine, the file, then what was said", () => {
    const prompt = buildFoldPrompt({
      current: "## Who\n- Rides a Ducati",
      evidence: "[Wed 29.07 08:12] You: sold the Ducati",
      instructions,
      path: PATH,
    });
    expect(prompt.indexOf("Maintain it")).toBeLessThan(prompt.indexOf("<memory"));
    expect(prompt.indexOf("<memory")).toBeLessThan(prompt.indexOf("<conversation>"));
    expect(prompt).toContain(`<memory path="${PATH}">\n## Who\n- Rides a Ducati\n</memory>`);
    expect(prompt).toContain("sold the Ducati");
  });

  it("hands the doctrine over verbatim, with no size or budget attached to it", () => {
    const prompt = buildFoldPrompt({ current: "abcde", evidence: "x", instructions, path: PATH });
    expect(prompt.startsWith("Maintain it.\n\n")).toBe(true);
    expect(prompt).not.toMatch(/\d+ characters/);
  });

  it("says so plainly when there is no file yet", () => {
    const prompt = buildFoldPrompt({ current: "", evidence: "x", instructions, path: PATH });
    expect(prompt).toContain(`<memory path="${PATH}" state="empty" />`);
  });
});

describe("readFoldOutput", () => {
  it("takes a file as the new memory", () => {
    expect(readFoldOutput("## Who\n- Lives in Austria")).toEqual({
      content: "## Who\n- Lives in Austria\n",
      kind: "content",
    });
  });

  it("accepts a title-only heading level and bullet stars", () => {
    expect(readFoldOutput("# Memory\n* a fact").kind).toBe("content");
  });

  it("unwraps a code fence the model added", () => {
    expect(readFoldOutput("```markdown\n## Who\n- a fact\n```")).toEqual({
      content: "## Who\n- a fact\n",
      kind: "content",
    });
  });

  it("reads the no-op sentinel", () => {
    expect(readFoldOutput("UNCHANGED").kind).toBe("unchanged");
    expect(readFoldOutput(" unchanged. \n").kind).toBe("unchanged");
  });

  it("refuses an empty reply rather than wiping months of profile", () => {
    expect(readFoldOutput("   ").kind).toBe("invalid");
  });

  it("refuses prose that is not a file", () => {
    expect(readFoldOutput("I could not find anything worth remembering.").kind).toBe("invalid");
  });

  it("allows a pass to shrink the file, which is the mechanism working", () => {
    expect(readFoldOutput("## Who\n- one line left").kind).toBe("content");
  });

  it("ends the file with a newline", () => {
    const output = readFoldOutput("## Who\n- a fact");
    expect(output.kind === "content" && output.content.endsWith("\n")).toBe(true);
  });
});
