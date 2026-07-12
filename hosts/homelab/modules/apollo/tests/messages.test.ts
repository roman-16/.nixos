import { describe, expect, it } from "bun:test";

import { isAllowed, numberFromJid, splitMessage } from "../src/messages.ts";

describe("numberFromJid", () => {
  it("strips domain and device suffix", () => {
    expect(numberFromJid("4369912345678@s.whatsapp.net")).toBe("4369912345678");
    expect(numberFromJid("4369912345678:12@s.whatsapp.net")).toBe("4369912345678");
  });
});

describe("isAllowed", () => {
  const allow = ["4369912345678"];

  it("matches regardless of formatting", () => {
    expect(isAllowed("4369912345678", allow)).toBe(true);
    expect(isAllowed("+43 699 1234 5678", allow)).toBe(true);
  });

  it("rejects unknown or empty numbers", () => {
    expect(isAllowed("4300000000000", allow)).toBe(false);
    expect(isAllowed("", allow)).toBe(false);
    expect(isAllowed("4369912345678", [])).toBe(false);
  });
});

describe("splitMessage", () => {
  it("keeps short text as a single chunk", () => {
    expect(splitMessage("hello")).toEqual(["hello"]);
  });

  it("returns nothing for empty input", () => {
    expect(splitMessage("   ")).toEqual([]);
  });

  it("splits long text into chunks within the limit", () => {
    const line = "word ".repeat(50).trim();
    const text = `${line}\n`.repeat(40).trim();
    const chunks = splitMessage(text, 200);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(200);
    expect(chunks.join(" ").replace(/\s+/g, " ")).toBe(text.replace(/\s+/g, " "));
  });

  it("hard-splits a single run with no boundaries", () => {
    const chunks = splitMessage("x".repeat(500), 100);
    expect(chunks.length).toBe(5);
    for (const chunk of chunks) expect(chunk.length).toBe(100);
  });
});
