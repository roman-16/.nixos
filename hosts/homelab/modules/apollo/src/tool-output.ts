/**
 * Tool output is the bulk of what Apollo carries: it is 71-79% of the conversation by volume,
 * against 2-4% for the user's own words. It is also the most disposable part, because every line
 * of it can be produced again by running the command again, while nothing can reproduce what the
 * user said. These helpers are the two ways that surplus is given up: keeping both ends of a long
 * result instead of its head, and dropping a result entirely once its moment has passed.
 */

/** How a dropped middle is announced, so the model knows it is reading two ends and not one text. */
function omitted(chars: number): string {
  return `\n\u2026 [${chars} characters omitted] \u2026\n`;
}

/**
 * Keep the beginning and the end of a long text, dropping the middle. A tool result's last lines
 * are usually its conclusion - the day as it now stands, the final state after a batch of commands -
 * so a head-only cut is the one cut that reliably removes the answer.
 */
export function condense(text: string, head: number, tail: number): string {
  if (text.length <= head + tail) return text;
  return text.slice(0, head) + omitted(text.length - head - tail) + text.slice(text.length - tail);
}

/** What an old tool result leaves behind: that it ran, and how to see it again. */
export function clearedOutput(toolName: string, chars: number): string {
  return `[${toolName} output cleared after the conversation moved on (${chars} characters). Run it again if you need it.]`;
}

/** What an old image leaves behind. The picture itself is still in the archive. */
export const CLEARED_IMAGE = "[image cleared - it is still findable with the recall skill]";
