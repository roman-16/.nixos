import { describe, expect, it } from "bun:test";

import { buildCompactionPrompt } from "../src/compaction";

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
});
