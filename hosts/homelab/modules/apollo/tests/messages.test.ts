import { describe, expect, it } from "bun:test";

import {
  claudeErrorNotice,
  compactionNotice,
  formatLogNotice,
  isAllowed,
  jidForNumber,
  numberFromJid,
  skillContextNote,
  splitMessage,
  voiceText,
} from "../src/messages";

describe("numberFromJid", () => {
  it("strips domain and device suffix", () => {
    expect(numberFromJid("4369912345678@s.whatsapp.net")).toBe("4369912345678");
    expect(numberFromJid("4369912345678:12@s.whatsapp.net")).toBe("4369912345678");
  });
});

describe("jidForNumber", () => {
  it("builds an individual-chat JID and round-trips with numberFromJid", () => {
    expect(jidForNumber("4369912345678")).toBe("4369912345678@s.whatsapp.net");
    expect(numberFromJid(jidForNumber("+43 699 1234 5678"))).toBe("4369912345678");
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

describe("voiceText", () => {
  it("prefixes a transcript with the voice marker", () => {
    expect(voiceText("turn on the lights")).toBe("🎤 turn on the lights");
  });

  it("trims surrounding whitespace", () => {
    expect(voiceText("  hello  ")).toBe("🎤 hello");
  });

  it("marks an empty transcript", () => {
    expect(voiceText("   ")).toBe("🎤 (empty voice message)");
  });
});

describe("compactionNotice", () => {
  it("includes a humanized token count when known", () => {
    expect(compactionNotice(123456)).toBe(
      "🗜️ Context compacted (~123K tokens). Full summary on the dashboard.",
    );
  });

  it("omits the token clause when unknown or zero", () => {
    const expected = "🗜️ Context compacted. Full summary on the dashboard.";
    expect(compactionNotice()).toBe(expected);
    expect(compactionNotice(0)).toBe(expected);
  });
});

describe("claudeErrorNotice", () => {
  it("includes the detail and the retry hint", () => {
    const notice = claudeErrorNotice("Overloaded");
    expect(notice).toContain("Overloaded");
    expect(notice).toContain("try again");
  });

  it("omits the detail clause when empty", () => {
    expect(claudeErrorNotice("   ")).toBe(
      "⚠️ I couldn't reach Claude just now. Your message didn't go through - try again in a bit.",
    );
  });

  it("truncates a very long detail", () => {
    expect(claudeErrorNotice("x".repeat(500))).toContain("more chars");
  });
});

describe("formatLogNotice", () => {
  it("formats the level label and message", () => {
    expect(formatLogNotice({ level: 50, msg: "send failed" })).toBe("⚠️ ERROR: send failed");
    expect(formatLogNotice({ level: 40, msg: "heads up" })).toBe("⚠️ WARN: heads up");
  });

  it("appends a concise detail from err/error/detail", () => {
    expect(formatLogNotice({ detail: "the reason", level: 50, msg: "boom" })).toContain(
      "the reason",
    );
    expect(formatLogNotice({ err: { message: "nested" }, level: 50, msg: "boom" })).toContain(
      "nested",
    );
  });
});

describe("skillContextNote", () => {
  it("names the source and includes the delivered text", () => {
    const note = skillContextNote("reminders", "⏰ get my food");
    expect(note).toContain("reminders");
    expect(note).toContain("⏰ get my food");
    expect(note).toContain("don't resend");
  });

  it("keeps a long (under-cap) message intact", () => {
    const text = "x".repeat(1000);
    const note = skillContextNote("reminders", text);
    expect(note).toContain(text);
    expect(note).not.toContain("more chars");
  });

  it("truncates only a very long message", () => {
    expect(skillContextNote("macros", "x".repeat(5000))).toContain("more chars");
  });
});
