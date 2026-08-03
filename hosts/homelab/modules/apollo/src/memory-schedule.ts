import { practicalDay } from "./temporal";

/**
 * When Apollo folds what was said into its memory.
 *
 * Two things ask for it. A compaction, because that is the moment the raw conversation stops being
 * visible and the summary is forbidden to carry the profile, so anything durable in it has to be in
 * the file by then. And a new day, because a profile that is only maintained when the conversation
 * grows large enough to compact would never be maintained at all in a quiet week.
 *
 * Both are safe to fire on: the fold reads from a cursor over what it has already read, so it is
 * idempotent and a missed one only makes the next span longer. Like compaction, it waits for quiet -
 * nobody is kept waiting for maintenance.
 *
 * The schedule is kept in wall-clock time and the evidence cursor in message time, because they
 * answer different questions. A compaction runs after the conversation has gone quiet, so it is
 * always later than the newest message: judging "has a compaction happened since the last fold"
 * against a message timestamp would be permanently true.
 */

export interface FoldPolicy {
  /** Hour the user's day rolls over, so "a new day" means theirs, not the calendar's. */
  dayStartHour: number;
  /** Quiet needed before folding, so it never lands mid-conversation. */
  idleMs: number;
}

export interface FoldState {
  /** When memory was last brought up to date; undefined before the first fold. */
  foldedAt: number | undefined;
  idleMs: number;
  lastCompactedAt: number | undefined;
  now: number;
}

export type FoldReason = "compaction" | "nightly";

/** Why Apollo should fold memory right now, or undefined to leave the file alone. */
export function foldReason(state: FoldState, policy: FoldPolicy): FoldReason | undefined {
  const { foldedAt, idleMs, lastCompactedAt, now } = state;
  if (idleMs < policy.idleMs) return undefined;
  if (foldedAt === undefined) return "nightly";
  if (lastCompactedAt !== undefined && lastCompactedAt > foldedAt) return "compaction";
  const turned =
    practicalDay(new Date(foldedAt), policy.dayStartHour) !==
    practicalDay(new Date(now), policy.dayStartHour);
  return turned ? "nightly" : undefined;
}
