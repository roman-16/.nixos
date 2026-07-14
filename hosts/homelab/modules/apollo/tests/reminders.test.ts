import { describe, expect, it } from "bun:test";

import { clampDelay, formatReminder, parseReminder } from "../src/reminders";

describe("parseReminder", () => {
  it("accepts a well-formed reminder", () => {
    expect(parseReminder({ at: 100, createdAt: 50, id: "a1", text: "hi" })).toEqual({
      at: 100,
      createdAt: 50,
      id: "a1",
      text: "hi",
    });
  });

  it("defaults createdAt to at when missing", () => {
    expect(parseReminder({ at: 100, id: "a1", text: "hi" })?.createdAt).toBe(100);
  });

  it("rejects malformed records", () => {
    expect(parseReminder(null)).toBeUndefined();
    expect(parseReminder({ at: 1, id: "a", text: "" })).toBeUndefined();
    expect(parseReminder({ at: 1, id: "", text: "x" })).toBeUndefined();
    expect(parseReminder({ at: "soon", id: "a", text: "x" })).toBeUndefined();
    expect(parseReminder({ id: "a", text: "x" })).toBeUndefined();
  });
});

describe("formatReminder", () => {
  it("prefixes the alarm marker", () => {
    expect(formatReminder("get food")).toBe("⏰ get food");
  });
});

describe("clampDelay", () => {
  it("is the remaining time when within range", () => {
    expect(clampDelay(1000, 400)).toBe(600);
  });

  it("is zero for past times", () => {
    expect(clampDelay(400, 1000)).toBe(0);
  });

  it("caps far-future delays at the setTimeout max", () => {
    expect(clampDelay(Number.MAX_SAFE_INTEGER, 0)).toBe(2 ** 31 - 1);
  });
});
