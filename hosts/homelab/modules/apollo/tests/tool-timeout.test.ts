import { describe, expect, it } from "bun:test";

import { cappedTimeout, TOOL_TIMEOUT_SECONDS } from "../src/tool-timeout";

describe("cappedTimeout", () => {
  it("defaults an unset timeout to the hard cap", () => {
    expect(cappedTimeout(undefined)).toBe(TOOL_TIMEOUT_SECONDS);
  });

  it("caps a larger request to the hard cap", () => {
    expect(cappedTimeout(3600)).toBe(TOOL_TIMEOUT_SECONDS);
  });

  it("leaves a smaller request unchanged", () => {
    expect(cappedTimeout(10)).toBe(10);
  });

  it("keeps a request equal to the cap", () => {
    expect(cappedTimeout(TOOL_TIMEOUT_SECONDS)).toBe(TOOL_TIMEOUT_SECONDS);
  });
});
