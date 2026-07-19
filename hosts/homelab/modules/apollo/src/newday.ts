/**
 * Lazy "a new day has begun" notices, computed when the user next writes rather than pushed
 * on a schedule. Two boundaries are tracked independently: the calendar day (midnight) and
 * the user's practical day, which rolls over at `dayStartHour` (04:00) so the small hours still
 * belong to the previous day. Each boundary crossed since the last inbound message adds one
 * `[context]` line prepended to the prompt.
 */

const HOUR_MS = 3_600_000;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Local `YYYY-MM-DD` for a timestamp (the process runs in Europe/Vienna). */
function ymd(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function shiftHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * HOUR_MS);
}

/** The practical-day key: the calendar date `dayStartHour` hours earlier. */
function macroDay(date: Date, dayStartHour: number): string {
  return ymd(shiftHours(date, -dayStartHour));
}

/**
 * The day-boundary notices to inject given the previous inbound time and now. Empty when
 * there is no prior message or nothing was crossed; a technical (midnight) line when the
 * calendar date changed, then a practical (`dayStartHour`) line when the practical day
 * changed - so the first message after 04:00 following an evening message yields both.
 */
export function dayBoundaryNotes(last: Date | undefined, now: Date, dayStartHour = 4): string[] {
  if (!last) return [];
  const notes: string[] = [];
  if (ymd(now) !== ymd(last)) {
    const weekday = now.toLocaleDateString("en-US", { weekday: "long" });
    notes.push(`A new calendar day has started - it is now ${weekday}, ${ymd(now)}.`);
  }
  if (macroDay(now, dayStartHour) !== macroDay(last, dayStartHour)) {
    notes.push(
      `It's past ${pad(dayStartHour)}:00, so a new day has practically begun; "today" for daily tracking (macros, etc.) now rolls over to ${macroDay(now, dayStartHour)}.`,
    );
  }
  return notes;
}

/** Prepend each note as its own `[context]` line, then the real prompt (kept to one turn). */
export function withDayContext(notes: string[], prompt: string): string {
  if (notes.length === 0) return prompt;
  const block = notes.map((note) => `[context] ${note}`).join("\n");
  return `${block}\n\n${prompt}`;
}
