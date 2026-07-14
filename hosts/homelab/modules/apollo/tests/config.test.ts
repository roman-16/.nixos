import { describe, expect, it } from "bun:test";

import { loadConfig } from "../src/config";

describe("loadConfig", () => {
  it("parses the allowlist into bare digits and drops empties", () => {
    const config = loadConfig({ APOLLO_ALLOW_FROM: "+43 699 1234 5678, , 004312345" });
    expect(config.allowFrom).toEqual(["4369912345678", "004312345"]);
  });

  it("applies defaults", () => {
    const config = loadConfig({ HOME: "/tmp/apollo" });
    expect(config.allowFrom).toEqual([]);
    expect(config.model).toBe("anthropic/claude-sonnet-5");
    expect(config.thinkingLevel).toBe("medium");
    expect(config.port).toBe(8080);
    expect(config.workspace).toBe("/tmp/apollo/workspace");
    expect(config.whatsappDir).toBe("/tmp/apollo/whatsapp");
    expect(config.remindersDir).toBe("/tmp/apollo/workspace/reminders");
    expect(config.systemPromptFile.endsWith("SYSTEM_PROMPT.md")).toBe(true);
    expect(config.compactionPromptFile.endsWith("COMPACTION_PROMPT.md")).toBe(true);
    expect(config.sessionDir.endsWith("sessions")).toBe(true);
  });

  it("reads overrides from the environment", () => {
    const config = loadConfig({
      APOLLO_MODEL: "anthropic/claude-opus-4-8",
      APOLLO_THINKING: "high",
      PORT: "9090",
    });
    expect(config.model).toBe("anthropic/claude-opus-4-8");
    expect(config.thinkingLevel).toBe("high");
    expect(config.port).toBe(9090);
  });
});
