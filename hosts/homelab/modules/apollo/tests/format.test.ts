import { describe, expect, it } from "bun:test";

import { barColor, escapeHtml, humanBytes, humanTokens, truncate } from "../src/format";

describe("barColor", () => {
  it("grades a percentage green, amber, then red", () => {
    expect(barColor(0)).toBe("bg-emerald-500");
    expect(barColor(69)).toBe("bg-emerald-500");
    expect(barColor(70)).toBe("bg-amber-500");
    expect(barColor(89)).toBe("bg-amber-500");
    expect(barColor(90)).toBe("bg-red-500");
    expect(barColor(100)).toBe("bg-red-500");
  });
});

describe("escapeHtml", () => {
  it("escapes HTML-significant characters", () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
  });
});

describe("truncate", () => {
  it("returns short strings unchanged", () => {
    expect(truncate("hi", 10)).toBe("hi");
  });

  it("caps long strings with a dropped-count note", () => {
    expect(truncate("abcdef", 3)).toBe("abc\n… (3 more chars)");
  });
});

describe("humanBytes", () => {
  it("reads bytes as bytes", () => {
    expect(humanBytes(0)).toBe("0 B");
    expect(humanBytes(512)).toBe("512 B");
  });

  it("rounds kilobytes, which nobody reads to a decimal", () => {
    expect(humanBytes(1024)).toBe("1 KB");
    expect(humanBytes(151_552)).toBe("148 KB");
  });

  it("keeps one decimal from megabytes up, where it matters", () => {
    expect(humanBytes(2_306_867)).toBe("2.2 MB");
    expect(humanBytes(100 * 1024 * 1024)).toBe("100.0 MB");
    expect(humanBytes(3 * 1024 ** 3)).toBe("3.0 GB");
  });
});

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
