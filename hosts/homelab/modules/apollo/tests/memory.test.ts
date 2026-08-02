import { describe, expect, it } from "bun:test";

import { memoryBlock } from "../src/memory";

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

  it("caps a file that has grown into a diary, since it costs context every turn", () => {
    const block = memoryBlock(PATH, "x".repeat(20000));
    expect(block.length).toBeLessThan(13000);
    expect(block).toContain("…");
  });
});
