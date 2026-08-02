import { describe, expect, it } from "bun:test";

import { buildCompactionPrompt, condenseToolResults, deliveredLedger } from "../src/compaction";

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

  it("flattens newlines so one delivery stays one line", () => {
    expect(deliveredLedger([{ at, source: "reminders", text: "a\n\nb" }])).toContain(
      "via reminders: a b",
    );
  });
});
