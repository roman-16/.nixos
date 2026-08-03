import { describe, expect, it } from "bun:test";

import { type FoldPolicy, foldReason, type FoldState } from "../src/memory-schedule";

const MINUTE = 60_000;

const policy: FoldPolicy = { dayStartHour: 4, idleMs: 8 * MINUTE };

/** Local-time constructor (month is 1-based here for readability). */
function at(year: number, month: number, day: number, hour: number, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute).getTime();
}

function state(over: Partial<FoldState> = {}): FoldState {
  return {
    foldedAt: at(2026, 8, 2, 10),
    idleMs: 30 * MINUTE,
    lastCompactedAt: at(2026, 8, 2, 9),
    now: at(2026, 8, 2, 20),
    ...over,
  };
}

describe("foldReason", () => {
  it("folds after a compaction, which is when the raw conversation stops being visible", () => {
    expect(foldReason(state({ lastCompactedAt: at(2026, 8, 2, 19) }), policy)).toBe("compaction");
  });

  it("leaves memory alone when nothing has happened since the last fold", () => {
    expect(foldReason(state(), policy)).toBeUndefined();
  });

  it("never interrupts a live conversation", () => {
    expect(
      foldReason(state({ idleMs: 2 * MINUTE, lastCompactedAt: at(2026, 8, 2, 19) }), policy),
    ).toBeUndefined();
  });

  it("waits out the full idle window", () => {
    const busy = { lastCompactedAt: at(2026, 8, 2, 19) };
    expect(foldReason(state({ ...busy, idleMs: 7 * MINUTE }), policy)).toBeUndefined();
    expect(foldReason(state({ ...busy, idleMs: 8 * MINUTE }), policy)).toBe("compaction");
  });

  it("folds once a day even when the conversation never grew enough to compact", () => {
    const quietWeek = state({
      foldedAt: at(2026, 8, 1, 21),
      lastCompactedAt: at(2026, 7, 20, 12),
      now: at(2026, 8, 2, 9),
    });
    expect(foldReason(quietWeek, policy)).toBe("nightly");
  });

  it("treats the small hours as still yesterday, like the rest of Apollo", () => {
    const smallHours = state({
      foldedAt: at(2026, 8, 1, 21),
      lastCompactedAt: undefined,
      now: at(2026, 8, 2, 2),
    });
    expect(foldReason(smallHours, policy)).toBeUndefined();
  });

  it("folds only once per day", () => {
    const alreadyFolded = state({
      foldedAt: at(2026, 8, 2, 5),
      lastCompactedAt: undefined,
      now: at(2026, 8, 2, 23),
    });
    expect(foldReason(alreadyFolded, policy)).toBeUndefined();
  });

  it("folds a session that has never folded", () => {
    expect(foldReason(state({ foldedAt: undefined, lastCompactedAt: undefined }), policy)).toBe(
      "nightly",
    );
  });

  it("does not re-fold for a compaction that predates the last fold", () => {
    expect(
      foldReason(
        state({ foldedAt: at(2026, 8, 2, 12), lastCompactedAt: at(2026, 8, 2, 11) }),
        policy,
      ),
    ).toBeUndefined();
  });

  it("compares the compaction against the fold time, not against the newest message", () => {
    // A compaction runs once the conversation has gone quiet, so it is always later than the last
    // message. Comparing it with a message-time cursor would make this permanently true.
    const foldedAfterCompaction = state({
      foldedAt: at(2026, 8, 2, 19, 10),
      lastCompactedAt: at(2026, 8, 2, 19, 8),
      now: at(2026, 8, 2, 19, 30),
    });
    expect(foldReason(foldedAfterCompaction, policy)).toBeUndefined();
  });
});
