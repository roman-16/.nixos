/**
 * Lazy "a new day has begun" notices, computed when the user next writes rather than pushed
 * on a schedule. Two boundaries are tracked independently: the calendar day (midnight) and
 * the user's practical day, which rolls over at `dayStartHour` (04:00) so the small hours still
 * belong to the previous day. Each boundary crossed since the last inbound message adds one
 * `<context>` element prepended to the prompt.
 */

export interface ContextNote {
  body: string;
  info: string;
  source: string;
}

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
export function dayBoundaryNotes(
  last: Date | undefined,
  now: Date,
  dayStartHour = 4,
): ContextNote[] {
  if (!last) return [];
  const notes: ContextNote[] = [];
  if (ymd(now) !== ymd(last)) {
    const weekday = now.toLocaleDateString("en-US", { weekday: "long" });
    notes.push({
      body: "",
      info: `A new calendar day has started - it is now ${weekday}, ${ymd(now)}.`,
      source: "day",
    });
  }
  if (macroDay(now, dayStartHour) !== macroDay(last, dayStartHour)) {
    notes.push({
      body: "",
      info: `It's past ${pad(dayStartHour)}:00, so a new day has practically begun; 'today' for daily tracking (macros, etc.) now rolls over to ${macroDay(now, dayStartHour)}.`,
      source: "day",
    });
  }
  return notes;
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
