/**
 * The time context a delivered turn carries: when the user sent it, how late it reached the agent,
 * and whether a new day began since the previous message. WhatsApp stamps every message with its
 * send time, so processing time is never silently substituted for it - a message that arrives three
 * days late is still a message about that day.
 *
 * Two notions of "day" live here: the calendar day, and the user's practical day, which rolls over
 * at `dayStartHour` so the small hours still belong to the previous date.
 */

export interface ContextNote {
  body: string;
  info: string;
  source: string;
}

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Local `YYYY-MM-DD` (the process runs in Europe/Vienna). */
function ymd(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The practical-day key: the calendar date `dayStartHour` hours earlier. */
function macroDay(date: Date, dayStartHour: number): string {
  return ymd(new Date(date.getTime() - dayStartHour * HOUR_MS));
}

/** Full stamp for a single message: `Wednesday 29.07.2026 08:12`. */
export function stamp(date: Date): string {
  const weekday = date.toLocaleDateString("en-US", { weekday: "long" });
  return `${weekday} ${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Compact stamp for a transcript line: `Wed 29.07 08:12`. */
export function shortStamp(date: Date): string {
  const weekday = date.toLocaleDateString("en-US", { weekday: "short" });
  return `${weekday} ${pad(date.getDate())}.${pad(date.getMonth() + 1)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** A rounded, human delay: `3 days`, `4 hours`, `12 minutes`, `just now`. */
export function describeDelay(ms: number): string {
  if (ms < MINUTE_MS) return "just now";
  for (const [unit, size] of [
    ["day", 24 * HOUR_MS],
    ["hour", HOUR_MS],
    ["minute", MINUTE_MS],
  ] as const) {
    const n = Math.floor(ms / size);
    if (n >= 1) return `${n} ${unit}${n === 1 ? "" : "s"}`;
  }
  return "just now";
}

export interface TimeContextArgs {
  dayStartHour: number;
  now: number;
  /** Send time of the previous message, for detecting a day rollover. */
  previous?: number;
  sentAt: number;
  /** Delay past which a message counts as late rather than live. */
  staleMs: number;
}

/** The `time` note for one message: when it was sent, how late it is, and any day rollover. */
export function timeContext(args: TimeContextArgs): ContextNote {
  const { dayStartHour, now, previous, sentAt, staleMs } = args;
  const sent = new Date(sentAt);
  const late = now - sentAt;
  const lines: string[] = [];
  if (late > staleMs) {
    lines.push(
      "This reached me late, so act on it as of when it was sent, not as of now: anything dated " +
        "(macros, weight) belongs to that day and needs an explicit date, and a time-relative " +
        "request may no longer make sense.",
    );
  }
  if (previous !== undefined) {
    const before = new Date(previous);
    if (ymd(sent) !== ymd(before)) {
      lines.push(
        `A new calendar day started since the previous message; that day is ${ymd(sent)}.`,
      );
    }
    if (macroDay(sent, dayStartHour) !== macroDay(before, dayStartHour)) {
      lines.push(
        `It is past ${pad(dayStartHour)}:00, so a new day had practically begun; "today" for daily ` +
          `tracking (macros, etc.) is ${macroDay(sent, dayStartHour)}.`,
      );
    }
  }
  const info =
    late > staleMs
      ? `Sent ${stamp(sent)} - ${describeDelay(late)} ago; it is now ${stamp(new Date(now))}.`
      : `Sent ${stamp(sent)}.`;
  return { body: lines.join("\n"), info, source: "time" };
}

/** Escape a double quote so a value stays inside its `"`-delimited attribute. */
function escapeAttribute(value: string): string {
  return value.replaceAll('"', "&quot;");
}

/**
 * Space out a literal `</context>` in a note body so it can't close the wrapper early - only
 * reachable if a quoted message or a skill's own output literally contained the closing tag.
 */
function sanitizeBody(value: string): string {
  return value.replaceAll("</context>", "</ context>");
}

/**
 * Wrap each note as a `<context source="..." info="...">body</context>` element (self-closing when it
 * has no body), join them, and prepend the block to the real prompt (kept to one turn). The element
 * form splits back apart unambiguously for the dashboard and reads as clean metadata to the model.
 */
export function withContext(notes: ContextNote[], prompt: string): string {
  if (notes.length === 0) return prompt;
  const block = notes
    .map(({ body, info, source }) => {
      const open = `<context source="${escapeAttribute(source)}" info="${escapeAttribute(info)}"`;
      return body ? `${open}>${sanitizeBody(body)}</context>` : `${open} />`;
    })
    .join("\n");
  return `${block}\n\n${prompt}`;
}
