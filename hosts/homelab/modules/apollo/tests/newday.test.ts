import { describe, expect, it } from "bun:test";

import { type ContextNote, dayBoundaryNotes, withContext } from "../src/newday";

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
    expect(notes[0]?.info).toContain("calendar day");
    expect(notes[1]?.info).toContain("practically");
    expect(notes[0]?.info).toContain("2026-07-19");
    expect(notes[1]?.info).toContain("2026-07-19");
  });

  it("tags day notes with source 'day' and no body", () => {
    const [calendar] = dayBoundaryNotes(at(2026, 7, 18, 22), at(2026, 7, 19, 2));
    expect(calendar?.source).toBe("day");
    expect(calendar?.body).toBe("");
  });

  it("fires only the technical note between midnight and 04:00", () => {
    const notes = dayBoundaryNotes(at(2026, 7, 18, 22), at(2026, 7, 19, 2));
    expect(notes).toHaveLength(1);
    expect(notes[0]?.info).toContain("calendar day");
  });

  it("fires only the practical note when 04:00 is crossed within one calendar day", () => {
    const notes = dayBoundaryNotes(at(2026, 7, 19, 2), at(2026, 7, 19, 6));
    expect(notes).toHaveLength(1);
    expect(notes[0]?.info).toContain("practically");
  });

  it("fires only the practical note for 03:00 then 05:00", () => {
    const notes = dayBoundaryNotes(at(2026, 7, 19, 3), at(2026, 7, 19, 5));
    expect(notes).toHaveLength(1);
    expect(notes[0]?.info).toContain("practically");
  });

  it("stays silent within the same practical day", () => {
    expect(dayBoundaryNotes(at(2026, 7, 19, 10), at(2026, 7, 19, 15))).toEqual([]);
  });

  it("fires both after a multi-day gap", () => {
    expect(dayBoundaryNotes(at(2026, 7, 16, 9), at(2026, 7, 19, 9))).toHaveLength(2);
  });
});

describe("withContext", () => {
  const note = (over: Partial<ContextNote> = {}): ContextNote => ({
    body: "",
    info: "a note",
    source: "day",
    ...over,
  });

  it("returns the prompt unchanged when there are no notes", () => {
    expect(withContext([], "hello")).toBe("hello");
  });

  it("wraps a body-less note as a self-closing element before the prompt", () => {
    expect(withContext([note({ info: "new day", source: "day" })], "hello")).toBe(
      '<context source="day" info="new day" />\n\nhello',
    );
  });

  it("wraps a note that has a body as an open/close element", () => {
    expect(
      withContext(
        [note({ body: "the summary", info: "macros sent this", source: "macros" })],
        "hi",
      ),
    ).toBe('<context source="macros" info="macros sent this">the summary</context>\n\nhi');
  });

  it("joins multiple notes with a newline, blank line before the prompt", () => {
    expect(
      withContext(
        [
          note({ info: "day note", source: "day" }),
          note({ body: "sent", info: "macros", source: "macros" }),
        ],
        "hey",
      ),
    ).toBe(
      '<context source="day" info="day note" />\n<context source="macros" info="macros">sent</context>\n\nhey',
    );
  });

  it("escapes a double quote in an attribute and neutralizes a closing tag in a body", () => {
    expect(
      withContext([note({ body: "a </context> b", info: 'say "hi"', source: "reply" })], "x"),
    ).toBe('<context source="reply" info="say &quot;hi&quot;">a </ context> b</context>\n\nx');
  });
});
