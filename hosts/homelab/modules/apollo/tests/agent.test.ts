import { describe, expect, it } from "bun:test";

import { terminalErrorMessage } from "../src/agent";

/** Build an agent_end event with sensible defaults. */
function agentEnd(over: Record<string, unknown> = {}): any {
  return { messages: [], type: "agent_end", willRetry: false, ...over };
}

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
