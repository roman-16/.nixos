import { practicalDay } from "./temporal";

/**
 * When Apollo compacts itself.
 *
 * The window filling up is the worst possible moment to compact: the expensive context has already
 * been paid for on every turn leading up to it, recall is at its worst, and the cut lands in the
 * middle of whatever is being done. So size is not the trigger on its own - the end of a burst is.
 * Nobody is waiting during a gap, and the prompt cache is expiring anyway, so the work is free and
 * the next burst starts small.
 *
 * Two things ask for it: a context that has grown past what is worth carrying, and a new day
 * starting on top of yesterday's conversation.
 */

export interface CompactionPolicy {
  /** Context size that is no longer worth carrying into the next burst. */
  atTokens: number;
  /** Hour the user's day rolls over, so "a new day" means theirs, not the calendar's. */
  dayStartHour: number;
  /** Quiet needed before compacting, so it never lands mid-conversation. */
  idleMs: number;
  /** Below this a fresh day is not worth an extra summarization call. */
  nightlyFloorTokens: number;
}

export interface CompactionState {
  /** Estimated size of the carried conversation, prefix excluded. */
  conversationTokens: number;
  idleMs: number;
  lastCompactedAt: number | undefined;
  now: number;
}

export type CompactionReason = "nightly" | "size";

/** Whether a new practical day has begun since the last compaction. */
function dayTurned(
  lastCompactedAt: number | undefined,
  now: number,
  dayStartHour: number,
): boolean {
  if (lastCompactedAt === undefined) return true;
  return (
    practicalDay(new Date(lastCompactedAt), dayStartHour) !==
    practicalDay(new Date(now), dayStartHour)
  );
}

/** Why Apollo should compact right now, or undefined to leave the session alone. */
export function compactionReason(
  state: CompactionState,
  policy: CompactionPolicy,
): CompactionReason | undefined {
  const { conversationTokens, idleMs, lastCompactedAt, now } = state;
  if (idleMs < policy.idleMs) return undefined;
  if (conversationTokens >= policy.atTokens) return "size";
  if (
    conversationTokens >= policy.nightlyFloorTokens &&
    dayTurned(lastCompactedAt, now, policy.dayStartHour)
  ) {
    return "nightly";
  }
  return undefined;
}
