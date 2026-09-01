import { describe, expect, it } from "bun:test";

import {
  buildCompactionPrompt,
  condenseToolResults,
  continuesBlock,
  deliveredLedger,
  keptMessages,
  readSummary,
} from "../src/compaction";

describe("readSummary", () => {
  it("takes the text of a finished reply", () => {
    expect(
      readSummary({
        content: [{ text: "They asked about the bike.", type: "text" }],
        stopReason: "stop",
      }),
    ).toBe("They asked about the bike.");
  });

  it("leaves out thinking", () => {
    expect(
      readSummary({
        content: [
          { thinking: "weighing what matters", thinkingSignature: "", type: "thinking" },
          { text: "They asked about the bike.", type: "text" },
        ],
        stopReason: "stop",
      }),
    ).toBe("They asked about the bike.");
  });

  it("drops a summary the provider never finished sending", () => {
    expect(
      readSummary({
        content: [{ text: "They asked about the bi", type: "text" }],
        stopReason: "aborted",
      }),
    ).toBe("");
  });

  it("drops a summary that ran into the token ceiling", () => {
    expect(
      readSummary({
        content: [{ text: "They asked about the bike.", type: "text" }],
        stopReason: "length",
      }),
    ).toBe("");
  });
});

describe("buildCompactionPrompt", () => {
  it("places instructions before the wrapped conversation", () => {
    const prompt = buildCompactionPrompt({
      conversation: "[User]: hi",
      instructions: "Summarize.",
    });
    expect(prompt).toBe("Summarize.\n\n<conversation>\n[User]: hi\n</conversation>");
  });

  it("includes the previous summary, before the conversation, only when present", () => {
    const withPrevious = buildCompactionPrompt({
      conversation: "c",
      instructions: "i",
      previousSummary: "earlier",
    });
    expect(withPrevious).toContain("<previous-summary>\nearlier\n</previous-summary>");
    expect(withPrevious.indexOf("<previous-summary>")).toBeLessThan(
      withPrevious.indexOf("<conversation>"),
    );

    expect(buildCompactionPrompt({ conversation: "c", instructions: "i" })).not.toContain(
      "previous-summary",
    );
  });

  it("trims instructions and the previous summary", () => {
    const prompt = buildCompactionPrompt({
      conversation: "c",
      instructions: "  i  ",
      previousSummary: "  p  ",
    });
    expect(prompt.startsWith("i\n\n<previous-summary>\np\n</previous-summary>")).toBe(true);
  });

  it("places what the skills delivered before the conversation", () => {
    const prompt = buildCompactionPrompt({
      conversation: "c",
      delivered: "<delivered>\n[19:10] via macros: day complete\n</delivered>",
      instructions: "i",
    });
    expect(prompt.indexOf("<delivered>")).toBeLessThan(prompt.indexOf("<conversation>"));
  });

  it("omits the delivered block when nothing was sent", () => {
    expect(
      buildCompactionPrompt({ conversation: "c", delivered: "", instructions: "i" }),
    ).not.toContain("delivered");
  });

  it("puts what continues after the conversation, where it happened", () => {
    const prompt = buildCompactionPrompt({
      continues: "<continues>\n[Assistant]: answered it\n</continues>",
      conversation: "c",
      instructions: "i",
    });
    expect(prompt.indexOf("<conversation>")).toBeLessThan(prompt.indexOf("<continues>"));
  });
});

describe("keptMessages", () => {
  const entry = (id: string, text: string) => ({
    id,
    message: { content: [{ text, type: "text" }], role: "user", timestamp: 1 },
    type: "message",
  });

  it("takes everything from the cut point onwards", () => {
    const entries = [entry("a", "old"), entry("b", "cut"), entry("c", "newer")] as never[];
    const kept = keptMessages(entries, "b") as { content: { text: string }[] }[];
    expect(kept.map((m) => m.content[0]!.text)).toEqual(["cut", "newer"]);
  });

  it("skips entries that are not messages", () => {
    const entries = [
      entry("a", "kept"),
      { id: "b", summary: "s", type: "compaction" },
      entry("c", "also kept"),
    ] as never[];
    expect(keptMessages(entries, "a")).toHaveLength(2);
  });

  it("returns nothing when the cut point is not on this branch", () => {
    expect(keptMessages([entry("a", "x")] as never[], "missing")).toEqual([]);
  });
});

describe("continuesBlock", () => {
  const msg = (role: string, text: string) => ({
    content: [{ text, type: "text" }],
    role,
    timestamp: 1,
  });

  it("shows the messages right after the cut, which close the seam", () => {
    // The failure this exists for: the summarized half ended on a question whose answer is the
    // very next message - kept, and until now invisible to the summarizer.
    const block = continuesBlock([msg("assistant", "The Austrian School is...")]);
    expect(block).toContain("<continues>");
    expect(block).toContain("The Austrian School is...");
  });

  it("shows both ends and says how much it left out", () => {
    const kept = Array.from({ length: 30 }, (_, i) => msg("user", `m${i}`));
    const block = continuesBlock(kept, 2, 2);
    expect(block).toContain("m0");
    expect(block).toContain("m29");
    expect(block).toContain("26 more messages");
    expect(block).not.toContain("m14");
  });

  it("does not repeat itself when the two ends meet", () => {
    const block = continuesBlock([msg("user", "only")], 6, 4);
    expect(block.match(/only/g)).toHaveLength(1);
    expect(block).not.toContain("more messages");
  });

  it("is empty when nothing is kept", () => {
    expect(continuesBlock([])).toBe("");
  });

  it("condenses kept tool output like everything else", () => {
    const kept = [
      { content: [{ text: "x".repeat(5000), type: "text" }], role: "toolResult", timestamp: 1 },
    ];
    expect(continuesBlock(kept).length).toBeLessThan(2500);
  });
});

describe("condenseToolResults", () => {
  const result = (text: string) => ({
    content: [{ text, type: "text" }],
    role: "toolResult",
  });

  it("keeps the end of a long result, where the outcome is", () => {
    const text = `first entry${"filler ".repeat(500)}day complete`;
    const [out] = condenseToolResults([result(text)]);
    const kept = (out!.content as { text: string }[])[0]!.text;
    expect(kept).toContain("first entry");
    expect(kept).toContain("day complete");
    expect(kept.length).toBeLessThan(2000); // under pi's own truncation, so it never cuts again
  });

  it("leaves short results and other roles alone", () => {
    const short = result("ok");
    expect((condenseToolResults([short])[0]!.content as { text: string }[])[0]!.text).toBe("ok");
    const assistant = { content: [{ text: "x".repeat(5000), type: "text" }], role: "assistant" };
    expect(
      (condenseToolResults([assistant])[0]!.content as { text: string }[])[0]!.text.length,
    ).toBe(5000);
  });

  it("does not mutate the messages it was given", () => {
    const original = result("z".repeat(5000));
    condenseToolResults([original]);
    expect((original.content as { text: string }[])[0]!.text.length).toBe(5000);
  });
});

describe("deliveredLedger", () => {
  const at = new Date(2026, 7, 1, 19, 10).getTime();

  it("lists what the user actually received, with its source and time", () => {
    const ledger = deliveredLedger([{ at, source: "macros", text: "30.07: day complete" }]);
    expect(ledger).toContain("<delivered>");
    expect(ledger).toContain("19:10");
    expect(ledger).toContain("via macros");
    expect(ledger).toContain("day complete");
  });

  it("is empty when the skills sent nothing", () => {
    expect(deliveredLedger([])).toBe("");
  });

  it("keeps each line short - it is an index, not a second copy", () => {
    const ledger = deliveredLedger([{ at, source: "macros", text: "x".repeat(4000) }]);
    expect(ledger.length).toBeLessThan(400);
  });

  it("records a picture that went out with no words as a delivery all the same", () => {
    expect(deliveredLedger([{ at, source: "diagram", text: "" }])).toContain(
      "via diagram: (image)",
    );
  });

  it("flattens newlines so one delivery stays one line", () => {
    expect(deliveredLedger([{ at, source: "reminders", text: "a\n\nb" }])).toContain(
      "via reminders: a b",
    );
  });
});
