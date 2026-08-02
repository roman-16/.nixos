import { describe, expect, it } from "bun:test";

import { burstStart, clearBeforeBurst, type ClearingPolicy } from "../src/context-clearing";

const MINUTE = 60_000;
const policy: ClearingPolicy = { gapMs: 60 * MINUTE, minChars: 500 };

const t = (minutes: number) => 1_700_000_000_000 + minutes * MINUTE;

function toolResult(at: number, text: string, toolName = "bash"): Record<string, any> {
  return {
    content: [{ text, type: "text" }],
    role: "toolResult",
    timestamp: at,
    toolName,
  };
}

function user(at: number, text: string, images = 0): Record<string, any> {
  return {
    content: [
      { text, type: "text" },
      ...Array.from({ length: images }, () => ({
        data: "AAAA",
        mimeType: "image/jpeg",
        type: "image",
      })),
    ],
    role: "user",
    timestamp: at,
  };
}

describe("burstStart", () => {
  it("is the start of the list when nothing interrupted it", () => {
    expect(burstStart([t(0), t(1), t(2)], 60 * MINUTE)).toBe(0);
  });

  it("is the first message after the last long silence", () => {
    expect(burstStart([t(0), t(1), t(200), t(201)], 60 * MINUTE)).toBe(2);
  });

  it("ignores gaps shorter than the threshold", () => {
    expect(burstStart([t(0), t(30), t(59)], 60 * MINUTE)).toBe(0);
  });

  it("takes the most recent silence when there were several", () => {
    expect(burstStart([t(0), t(200), t(400), t(401)], 60 * MINUTE)).toBe(2);
  });

  it("handles an empty conversation", () => {
    expect(burstStart([], 60 * MINUTE)).toBe(0);
  });
});

describe("clearBeforeBurst", () => {
  it("keeps everything when there has been no gap", () => {
    const messages = [toolResult(t(0), "x".repeat(2000)), user(t(1), "thanks")];
    const { cleared } = clearBeforeBurst(messages, policy);
    expect(cleared).toBe(0);
    expect(messages[0]!.content[0].text.length).toBe(2000);
  });

  it("clears a long tool result from a previous burst", () => {
    const messages = [toolResult(t(0), "y".repeat(2000)), user(t(200), "hi")];
    const { cleared } = clearBeforeBurst(messages, policy);
    expect(cleared).toBe(1);
    expect(messages[0]!.content[0].text).toContain("bash output cleared");
    expect(messages[0]!.content[0].text).toContain("2000");
  });

  it("leaves the current burst untouched", () => {
    const messages = [
      toolResult(t(0), "y".repeat(2000)),
      user(t(200), "hi"),
      toolResult(t(201), "z".repeat(2000)),
    ];
    clearBeforeBurst(messages, policy);
    expect(messages[2]!.content[0].text.length).toBe(2000);
  });

  it("keeps short output, which costs nothing to carry", () => {
    const messages = [toolResult(t(0), "ok"), user(t(200), "hi")];
    expect(clearBeforeBurst(messages, policy).cleared).toBe(0);
    expect(messages[0]!.content[0].text).toBe("ok");
  });

  it("clears old images but keeps the words around them", () => {
    const messages = [user(t(0), "log 250g", 1), user(t(200), "hi")];
    clearBeforeBurst(messages, policy);
    expect(messages[0]!.content[0].text).toBe("log 250g");
    expect(messages[0]!.content[1].type).toBe("text");
    expect(messages[0]!.content[1].text).toContain("recall");
  });

  it("never touches what Apollo or the user actually said", () => {
    const messages = [
      { content: [{ text: "a".repeat(3000), type: "text" }], role: "assistant", timestamp: t(0) },
      user(t(1), "b".repeat(3000)),
      user(t(200), "hi"),
    ];
    clearBeforeBurst(messages, policy);
    expect(messages[0]!.content[0].text.length).toBe(3000);
    expect(messages[1]!.content[0].text.length).toBe(3000);
  });

  it("is stable within a burst, so the cached prefix does not churn", () => {
    const build = () => [toolResult(t(0), "y".repeat(2000)), user(t(200), "hi")];
    const first = clearBeforeBurst(build(), policy).messages;
    const second = clearBeforeBurst(build(), policy).messages;
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("tolerates messages with plain string content", () => {
    const messages = [{ content: "hello", role: "user", timestamp: t(0) }, user(t(200), "hi")];
    expect(() => clearBeforeBurst(messages, policy)).not.toThrow();
    expect(messages[0]!.content).toBe("hello");
  });
});
