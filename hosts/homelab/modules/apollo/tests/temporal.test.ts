import { describe, expect, it } from "bun:test";

import {
  type ContextNote,
  describeDelay,
  shortStamp,
  stamp,
  timeContext,
  withContext,
} from "../src/temporal";

/** Local-time constructor (month is 1-based here for readability). */
function at(year: number, month: number, day: number, hour: number, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute).getTime();
}

const STALE_MS = 120_000;

function note(over: Partial<Parameters<typeof timeContext>[0]> = {}): ContextNote {
  return timeContext({
    dayStartHour: 4,
    now: at(2026, 7, 19, 15),
    sentAt: at(2026, 7, 19, 15),
    staleMs: STALE_MS,
    ...over,
  });
}

describe("stamp", () => {
  it("names the weekday, date and time", () => {
    expect(stamp(new Date(at(2026, 7, 19, 9, 5)))).toBe("Sunday 19.07.2026 09:05");
  });
});

describe("shortStamp", () => {
  it("drops the year for transcript lines", () => {
    expect(shortStamp(new Date(at(2026, 7, 19, 9, 5)))).toBe("Sun 19.07 09:05");
  });
});

describe("describeDelay", () => {
  it("picks the largest whole unit", () => {
    expect(describeDelay(3 * 86_400_000)).toBe("3 days");
    expect(describeDelay(4 * 3_600_000)).toBe("4 hours");
    expect(describeDelay(12 * 60_000)).toBe("12 minutes");
  });

  it("uses the singular for one", () => {
    expect(describeDelay(86_400_000)).toBe("1 day");
    expect(describeDelay(60_000)).toBe("1 minute");
  });

  it("calls anything under a minute just now", () => {
    expect(describeDelay(5000)).toBe("just now");
  });
});

describe("timeContext", () => {
  it("stamps a live message with its send time and nothing else", () => {
    const live = note();
    expect(live.source).toBe("time");
    expect(live.info).toBe("Sent Sunday 19.07.2026 15:00.");
    expect(live.body).toBe("");
  });

  it("reports how late a queued message is, and the time now", () => {
    const late = note({ now: at(2026, 8, 1, 19, 8), sentAt: at(2026, 7, 29, 8, 12) });
    expect(late.info).toContain("Sent Wednesday 29.07.2026 08:12");
    expect(late.info).toContain("3 days ago");
    expect(late.info).toContain("it is now Saturday 01.08.2026 19:08");
  });

  it("tells the agent to act as of the send time when late", () => {
    expect(note({ now: at(2026, 8, 1, 19, 8), sentAt: at(2026, 7, 29, 8, 12) }).body).toContain(
      "as of when it was sent",
    );
  });

  it("keeps a message within the stale window live", () => {
    const fresh = note({ now: at(2026, 7, 19, 15, 1), sentAt: at(2026, 7, 19, 15) });
    expect(fresh.info).not.toContain("ago");
    expect(fresh.body).toBe("");
  });

  it("notes a calendar day change since the previous message", () => {
    const rolled = note({ previous: at(2026, 7, 18, 22), sentAt: at(2026, 7, 19, 2) });
    expect(rolled.body).toContain("new calendar day");
    expect(rolled.body).toContain("2026-07-19");
  });

  it("notes the practical day rolling over at 04:00", () => {
    const rolled = note({ previous: at(2026, 7, 19, 2), sentAt: at(2026, 7, 19, 6) });
    expect(rolled.body).toContain("practically begun");
    expect(rolled.body).toContain("2026-07-19");
    expect(rolled.body).not.toContain("new calendar day");
  });

  it("notes both after an evening-to-morning gap", () => {
    const rolled = note({ previous: at(2026, 7, 18, 22), sentAt: at(2026, 7, 19, 6) });
    expect(rolled.body).toContain("new calendar day");
    expect(rolled.body).toContain("practically begun");
  });

  it("stays quiet within the same practical day", () => {
    expect(note({ previous: at(2026, 7, 19, 10), sentAt: at(2026, 7, 19, 15) }).body).toBe("");
  });

  it("has nothing to compare against for the first message", () => {
    expect(note({ sentAt: at(2026, 7, 19, 15) }).body).toBe("");
  });

  it("measures the rollover against the send time, not the delivery time", () => {
    // Sent late on the 18th, delivered on the 19th: no new day had begun when it was written.
    const late = note({
      now: at(2026, 7, 19, 12),
      previous: at(2026, 7, 18, 20),
      sentAt: at(2026, 7, 18, 22),
    });
    expect(late.body).not.toContain("new calendar day");
  });
});

describe("withContext", () => {
  const plain = (over: Partial<ContextNote> = {}): ContextNote => ({
    body: "",
    info: "a note",
    source: "time",
    ...over,
  });

  it("returns the prompt unchanged when there are no notes", () => {
    expect(withContext([], "hello")).toBe("hello");
  });

  it("wraps a body-less note as a self-closing element before the prompt", () => {
    expect(withContext([plain({ info: "Sent now." })], "hello")).toBe(
      '<context source="time" info="Sent now." />\n\nhello',
    );
  });

  it("wraps a note that has a body as an open/close element", () => {
    expect(
      withContext(
        [plain({ body: "the summary", info: "macros sent this", source: "macros" })],
        "hi",
      ),
    ).toBe('<context source="macros" info="macros sent this">the summary</context>\n\nhi');
  });

  it("joins multiple notes with a newline, blank line before the prompt", () => {
    expect(
      withContext(
        [plain({ info: "time note" }), plain({ body: "sent", info: "macros", source: "macros" })],
        "hey",
      ),
    ).toBe(
      '<context source="time" info="time note" />\n<context source="macros" info="macros">sent</context>\n\nhey',
    );
  });

  it("escapes a double quote in an attribute and neutralizes a closing tag in a body", () => {
    expect(
      withContext([plain({ body: "a </context> b", info: 'say "hi"', source: "reply" })], "x"),
    ).toBe('<context source="reply" info="say &quot;hi&quot;">a </ context> b</context>\n\nx');
  });
});
