import { describe, expect, it } from "bun:test";

import { humanTokens } from "../src/format";

describe("humanTokens", () => {
  it("passes through counts below a thousand", () => {
    expect(humanTokens(0)).toBe("0");
    expect(humanTokens(999)).toBe("999");
  });

  it("abbreviates thousands", () => {
    expect(humanTokens(1000)).toBe("1K");
    expect(humanTokens(123456)).toBe("123K");
  });

  it("abbreviates millions with one decimal", () => {
    expect(humanTokens(1000000)).toBe("1.0M");
    expect(humanTokens(1200000)).toBe("1.2M");
  });
});
