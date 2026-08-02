import { describe, expect, it } from "bun:test";

import { CLEARED_IMAGE, clearedOutput, condense } from "../src/tool-output";

describe("condense", () => {
  it("leaves a short result alone", () => {
    expect(condense("all done", 10, 10)).toBe("all done");
  });

  it("keeps both ends of a long result", () => {
    const text = `${"a".repeat(50)}${"m".repeat(200)}${"z".repeat(50)}`;
    const out = condense(text, 50, 50);
    expect(out.startsWith("a".repeat(50))).toBe(true);
    expect(out.endsWith("z".repeat(50))).toBe(true);
    expect(out).not.toContain("mmm");
  });

  it("says how much it dropped", () => {
    expect(condense("x".repeat(300), 100, 100)).toContain("[100 characters omitted]");
  });

  it("keeps the outcome, which a head-only cut would lose", () => {
    // The failure this exists for: a macros block prints the whole day after every entry, so the
    // answer to "was it all logged" is only in the final render.
    const render = (n: number, total: string) => `${"entry ".repeat(40)}\nTotal: ${total}`;
    const text = [render(1, "545 kcal"), render(2, "1076 kcal"), render(3, "2386 kcal")].join(
      "\n===\n",
    );
    const out = condense(text, 60, 80);
    expect(out).toContain("Total: 2386 kcal");
    expect(out).not.toContain("Total: 1076 kcal");
  });

  it("is deterministic, so a cached prefix stays byte-identical", () => {
    const text = "y".repeat(5000);
    expect(condense(text, 700, 1100)).toBe(condense(text, 700, 1100));
  });
});

describe("clearedOutput", () => {
  it("records that the call happened and how to see it again", () => {
    const note = clearedOutput("bash", 2997);
    expect(note).toContain("bash");
    expect(note).toContain("2997");
    expect(note).toContain("again");
  });
});

describe("CLEARED_IMAGE", () => {
  it("points at the archive rather than pretending the image never existed", () => {
    expect(CLEARED_IMAGE).toContain("recall");
  });
});
