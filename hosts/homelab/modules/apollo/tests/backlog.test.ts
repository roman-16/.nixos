import { describe, expect, it } from "bun:test";

import { type BacklogEntry, buildBacklog } from "../src/backlog";

/** Local-time constructor (month is 1-based here for readability). */
function at(year: number, month: number, day: number, hour: number, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute).getTime();
}

const NOW = at(2026, 8, 1, 19, 12);

function entry(over: Partial<BacklogEntry> = {}): BacklogEntry {
  return { images: 0, sentAt: at(2026, 7, 29, 8, 12), text: "3 eggs and toast", ...over };
}

describe("buildBacklog", () => {
  it("renders one timestamped line per message, in order", () => {
    const { text } = buildBacklog(
      [entry(), entry({ sentAt: at(2026, 7, 30, 13, 40), text: "chicken salad, maybe 500 kcal" })],
      NOW,
    );
    expect(text).toBe(
      "[Wed 29.07 08:12] 3 eggs and toast\n[Thu 30.07 13:40] chicken salad, maybe 500 kcal",
    );
  });

  it("counts the messages and spans their range", () => {
    const { note } = buildBacklog([entry(), entry({ sentAt: at(2026, 7, 30, 13, 40) })], NOW);
    expect(note.source).toBe("backlog");
    expect(note.info).toContain("2 messages");
    expect(note.info).toContain("Wed 29.07 08:12 - Thu 30.07 13:40");
  });

  it("states the current time, so the agent can see how late the batch is", () => {
    expect(buildBacklog([entry()], NOW).note.info).toContain("It is now Saturday 01.08.2026 19:12");
  });

  it("uses the singular and a single stamp for a lone message", () => {
    const { note } = buildBacklog([entry()], NOW);
    expect(note.info).toContain("1 message reached me late (Wed 29.07 08:12)");
  });

  it("tells the agent to date each message and answer once", () => {
    const { note } = buildBacklog([entry()], NOW);
    expect(note.body).toContain("as of the time it was sent");
    expect(note.body).toContain("explicit date");
    expect(note.body).toContain("Answer the whole catch-up once");
  });

  it("numbers attached images across the batch, in the order they are attached", () => {
    const { text } = buildBacklog(
      [
        entry({ images: 1, text: "label, log 235g" }),
        entry({ sentAt: at(2026, 7, 30, 9, 30), text: "no picture" }),
        entry({ images: 2, sentAt: at(2026, 7, 30, 12, 0), text: "two shots" }),
      ],
      NOW,
    );
    expect(text).toContain("(image 1) label, log 235g");
    expect(text).toContain("] no picture");
    expect(text).toContain("(image 2, image 3) two shots");
  });

  it("leaves no trailing space when a message has no text of its own", () => {
    const { text } = buildBacklog([entry({ images: 1, text: "" })], NOW);
    expect(text).toBe("[Wed 29.07 08:12] (image 1)");
  });
});
