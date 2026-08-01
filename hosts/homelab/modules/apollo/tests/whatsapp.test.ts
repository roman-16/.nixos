import { describe, expect, it } from "bun:test";

import { reconnectDelay } from "../src/whatsapp";

describe("reconnectDelay", () => {
  it("starts at two seconds for the first attempt", () => {
    expect(reconnectDelay(0)).toBe(2000);
  });

  it("doubles with each consecutive failure", () => {
    expect(reconnectDelay(1)).toBe(4000);
    expect(reconnectDelay(2)).toBe(8000);
    expect(reconnectDelay(3)).toBe(16000);
  });

  it("caps at a minute so a long outage keeps re-dialing at a sane rate", () => {
    expect(reconnectDelay(5)).toBe(60000);
    expect(reconnectDelay(100)).toBe(60000);
  });
});
