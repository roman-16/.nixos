import { describe, expect, it } from "bun:test";

import {
  type CompactionPolicy,
  compactionReason,
  type CompactionState,
} from "../src/compaction-schedule";

const MINUTE = 60_000;

const policy: CompactionPolicy = {
  atTokens: 128_000,
  dayStartHour: 4,
  idleMs: 30 * MINUTE,
  nightlyFloorTokens: 32_000,
};

/** Local-time constructor (month is 1-based here for readability). */
function at(year: number, month: number, day: number, hour: number, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute).getTime();
}

function state(over: Partial<CompactionState> = {}): CompactionState {
  return {
    contextTokens: 10_000,
    idleMs: 60 * MINUTE,
    lastCompactedAt: at(2026, 8, 2, 10),
    now: at(2026, 8, 2, 20),
    ...over,
  };
}

describe("compactionReason", () => {
  it("compacts a context that has grown past what is worth carrying", () => {
    expect(compactionReason(state({ contextTokens: 128_000 }), policy)).toBe("size");
  });

  it("leaves a small context alone", () => {
    expect(compactionReason(state({ contextTokens: 40_000 }), policy)).toBeUndefined();
  });

  it("never interrupts a live conversation, however big the context", () => {
    expect(
      compactionReason(state({ contextTokens: 900_000, idleMs: 5 * MINUTE }), policy),
    ).toBeUndefined();
  });

  it("waits out the full idle window", () => {
    expect(
      compactionReason(state({ contextTokens: 900_000, idleMs: 29 * MINUTE }), policy),
    ).toBeUndefined();
    expect(compactionReason(state({ contextTokens: 900_000, idleMs: 30 * MINUTE }), policy)).toBe(
      "size",
    );
  });

  it("holds off when the context size is not yet known", () => {
    expect(compactionReason(state({ contextTokens: null }), policy)).toBeUndefined();
    expect(compactionReason(state({ contextTokens: undefined }), policy)).toBeUndefined();
  });

  it("starts a new day on a clean context", () => {
    const overnight = state({
      contextTokens: 60_000,
      lastCompactedAt: at(2026, 8, 1, 21),
      now: at(2026, 8, 2, 5),
    });
    expect(compactionReason(overnight, policy)).toBe("nightly");
  });

  it("treats the small hours as still yesterday, like the rest of Apollo", () => {
    // 02:00 is before the 04:00 rollover, so no new day has begun yet.
    const smallHours = state({
      contextTokens: 60_000,
      lastCompactedAt: at(2026, 8, 1, 21),
      now: at(2026, 8, 2, 2),
    });
    expect(compactionReason(smallHours, policy)).toBeUndefined();
  });

  it("does not spend a summarization call on an already-small day", () => {
    const tiny = state({
      contextTokens: 20_000,
      lastCompactedAt: at(2026, 8, 1, 21),
      now: at(2026, 8, 2, 5),
    });
    expect(compactionReason(tiny, policy)).toBeUndefined();
  });

  it("compacts once per day, not once per minute", () => {
    const alreadyDone = state({
      contextTokens: 60_000,
      lastCompactedAt: at(2026, 8, 2, 5),
      now: at(2026, 8, 2, 9),
    });
    expect(compactionReason(alreadyDone, policy)).toBeUndefined();
  });

  it("treats a session that has never compacted as owing a nightly one", () => {
    expect(
      compactionReason(state({ contextTokens: 60_000, lastCompactedAt: undefined }), policy),
    ).toBe("nightly");
  });

  it("prefers size over nightly when both apply", () => {
    const both = state({
      contextTokens: 200_000,
      lastCompactedAt: at(2026, 8, 1, 21),
      now: at(2026, 8, 2, 5),
    });
    expect(compactionReason(both, policy)).toBe("size");
  });
});
