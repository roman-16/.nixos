import { describe, expect, it } from "bun:test";

import { conversationTokens, terminalErrorMessage } from "../src/agent";

/** Build an agent_end event with sensible defaults. */
function agentEnd(over: Record<string, unknown> = {}): any {
  return { messages: [], type: "agent_end", willRetry: false, ...over };
}

/** A session whose context path is exactly `entries`. */
function sessionWith(entries: unknown[]): any {
  return { sessionManager: { buildContextEntries: () => entries } };
}

function userEntry(text: string): unknown {
  return {
    id: `e-${text.length}`,
    message: { content: [{ text, type: "text" }], role: "user" },
    parentId: null,
    timestamp: "2026-07-29T08:12:00.000Z",
    type: "message",
  };
}

describe("conversationTokens", () => {
  it("is zero for an empty conversation, whatever the prompt around it costs", () => {
    expect(conversationTokens(sessionWith([]))).toBe(0);
  });

  it("grows with the conversation", () => {
    const small = conversationTokens(sessionWith([userEntry("x".repeat(400))]));
    const large = conversationTokens(sessionWith([userEntry("x".repeat(4000))]));
    expect(small).toBeGreaterThan(0);
    expect(large).toBeGreaterThan(small * 5);
  });

  it("counts every message on the path", () => {
    const one = conversationTokens(sessionWith([userEntry("y".repeat(1000))]));
    const two = conversationTokens(
      sessionWith([userEntry("y".repeat(1000)), userEntry("z".repeat(1000))]),
    );
    expect(two).toBeGreaterThan(one);
  });

  it("measures only the entries that are actually sent", () => {
    // buildContextEntries() already drops everything before the last compaction's kept boundary,
    // so the count follows what the model sees rather than the whole session history.
    const full = [userEntry("a".repeat(2000)), userEntry("b".repeat(2000))];
    expect(conversationTokens(sessionWith(full.slice(1)))).toBeLessThan(
      conversationTokens(sessionWith(full)),
    );
  });
});

describe("terminalErrorMessage", () => {
  it("returns the errorMessage of a terminal errored run", () => {
    const event = agentEnd({
      messages: [{ errorMessage: "Overloaded", role: "assistant", stopReason: "error" }],
    });
    expect(terminalErrorMessage(event)).toBe("Overloaded");
  });

  it("falls back to a generic message when errorMessage is missing", () => {
    const event = agentEnd({ messages: [{ role: "assistant", stopReason: "error" }] });
    expect(terminalErrorMessage(event)).toBe("unknown error");
  });

  it("stays quiet while a retry is still pending", () => {
    const event = agentEnd({
      messages: [{ errorMessage: "x", role: "assistant", stopReason: "error" }],
      willRetry: true,
    });
    expect(terminalErrorMessage(event)).toBeUndefined();
  });

  it("ignores aborted and successful runs", () => {
    expect(
      terminalErrorMessage(agentEnd({ messages: [{ role: "assistant", stopReason: "aborted" }] })),
    ).toBeUndefined();
    expect(
      terminalErrorMessage(agentEnd({ messages: [{ role: "assistant", stopReason: "stop" }] })),
    ).toBeUndefined();
  });

  it("uses the last assistant message in the run", () => {
    const event = agentEnd({
      messages: [
        { role: "assistant", stopReason: "stop" },
        { role: "toolResult" },
        { errorMessage: "boom", role: "assistant", stopReason: "error" },
      ],
    });
    expect(terminalErrorMessage(event)).toBe("boom");
  });

  it("ignores non-agent_end events", () => {
    expect(terminalErrorMessage({ type: "turn_end" } as any)).toBeUndefined();
  });
});
