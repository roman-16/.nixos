import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";

import { CLEARED_IMAGE, clearedOutput } from "./tool-output";

/**
 * Drops the bulk out of conversations Apollo has already moved on from. Tool output and photographs
 * are what fill the context, and both can be produced again - the command re-run, the image found
 * with recall - while the conversation around them cannot. So once a burst is over, what is left of
 * it is the record that a command ran, not its output.
 *
 * Only what is sent to the model changes. The session, the dashboard and the archive keep
 * everything, so this is a narrower view of the record, never a smaller record.
 *
 * The boundary is a gap in the conversation rather than a count, for a specific reason: rewriting
 * anything invalidates the prompt cache from that point on, and a gap long enough to end a burst is
 * also long enough to have expired the cache. Moving the boundary then costs nothing, and it holds
 * still for the whole of the next burst, which is when caching pays.
 */

export interface ClearingPolicy {
  /** Silence that ends a burst. Keep at or above the cache TTL so the view changes only when cold. */
  gapMs: number;
  /** Output shorter than this is not worth clearing. */
  minChars: number;
}

/** Index of the first message of the current burst: everything after the last long silence. */
export function burstStart(timestamps: number[], gapMs: number): number {
  for (let i = timestamps.length - 1; i > 0; i -= 1) {
    if (timestamps[i]! - timestamps[i - 1]! >= gapMs) return i;
  }
  return 0;
}

type Block = { data?: string; text?: string; type?: string };

/** Replace an old message's bulk in place, reporting whether anything was cleared. */
function clearMessage(message: Record<string, any>, policy: ClearingPolicy): boolean {
  const content = message.content;
  if (!Array.isArray(content)) return false;
  let cleared = false;
  for (const [i, block] of (content as Block[]).entries()) {
    if (block?.type === "image") {
      content[i] = { text: CLEARED_IMAGE, type: "text" };
      cleared = true;
    } else if (
      block?.type === "text" &&
      message.role === "toolResult" &&
      (block.text?.length ?? 0) > policy.minChars
    ) {
      content[i] = {
        text: clearedOutput(String(message.toolName ?? "tool"), block.text!.length),
        type: "text",
      };
      cleared = true;
    }
  }
  return cleared;
}

/**
 * Narrow the view of everything before the current burst. `messages` is pi's deep copy, so the
 * rewrite happens in place; the same input always yields the same output, which is what keeps the
 * cached prefix stable between the gaps.
 */
export function clearBeforeBurst(
  messages: Record<string, any>[],
  policy: ClearingPolicy,
): { cleared: number; messages: Record<string, any>[] } {
  const boundary = burstStart(
    messages.map((m) => (typeof m.timestamp === "number" ? m.timestamp : 0)),
    policy.gapMs,
  );
  let cleared = 0;
  for (let i = 0; i < boundary; i += 1) {
    if (clearMessage(messages[i]!, policy)) cleared += 1;
  }
  return { cleared, messages };
}

export function createContextClearingExtension(policy: ClearingPolicy): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.on("context", (event) => ({
      messages: clearBeforeBurst(event.messages as unknown as Record<string, any>[], policy)
        .messages as unknown as typeof event.messages,
    }));
  };
}
