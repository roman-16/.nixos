import { describe, expect, it } from "bun:test";

import { dayBoundaryNotes, withContext } from "../src/newday";

/** Local-time constructor (month is 1-based here for readability). */
function at(year: number, month: number, day: number, hour: number, minute = 0): Date {
  return new Date(year, month - 1, day, hour, minute);
}

describe("dayBoundaryNotes", () => {
  it("returns nothing without a previous message", () => {
    expect(dayBoundaryNotes(undefined, at(2026, 7, 19, 6))).toEqual([]);
  });

  it("fires both notes on the first message after 04:00 when the last was yesterday evening", () => {
    const notes = dayBoundaryNotes(at(2026, 7, 18, 22), at(2026, 7, 19, 6));
    expect(notes).toHaveLength(2);
    expect(notes[0]).toContain("calendar day");
    expect(notes[1]).toContain("practically");
    expect(notes[0]).toContain("2026-07-19");
    expect(notes[1]).toContain("2026-07-19");
  });

  it("fires only the technical note between midnight and 04:00", () => {
    const notes = dayBoundaryNotes(at(2026, 7, 18, 22), at(2026, 7, 19, 2));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("calendar day");
  });

  it("fires only the practical note when 04:00 is crossed within one calendar day", () => {
    const notes = dayBoundaryNotes(at(2026, 7, 19, 2), at(2026, 7, 19, 6));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("practically");
  });

  it("fires only the practical note for 03:00 then 05:00", () => {
    const notes = dayBoundaryNotes(at(2026, 7, 19, 3), at(2026, 7, 19, 5));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("practically");
  });

  it("stays silent within the same practical day", () => {
    expect(dayBoundaryNotes(at(2026, 7, 19, 10), at(2026, 7, 19, 15))).toEqual([]);
  });

  it("fires both after a multi-day gap", () => {
    expect(dayBoundaryNotes(at(2026, 7, 16, 9), at(2026, 7, 19, 9))).toHaveLength(2);
  });
});

describe("withContext", () => {
  it("returns the prompt unchanged when there are no notes", () => {
    expect(withContext([], "hello")).toBe("hello");
  });

  it("prepends each note as a [context] line before the prompt", () => {
    expect(withContext(["a", "b"], "hello")).toBe("[context] a\n[context] b\n\nhello");
  });
});
