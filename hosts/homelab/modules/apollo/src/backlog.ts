import { type ContextNote, shortStamp, stamp } from "./temporal";

/**
 * A catch-up turn. When several messages are owed at once - the queue WhatsApp held during an
 * outage, or anything that piled up while the agent was busy - they are handed over as a single
 * timestamped transcript rather than as a race of separate turns: one coherent answer covering the
 * whole backlog, with every line anchored to when it was actually sent.
 */

export interface BacklogEntry {
  /** How many images this message contributes, in order, to the turn's attachments. */
  images: number;
  sentAt: number;
  text: string;
}

export interface BacklogTurn {
  note: ContextNote;
  text: string;
}

/** Render `entries` (non-empty, in send order) as one catch-up turn. */
export function buildBacklog(entries: BacklogEntry[], now: number): BacklogTurn {
  const first = entries[0]!;
  const last = entries[entries.length - 1]!;
  const span =
    entries.length === 1
      ? shortStamp(new Date(first.sentAt))
      : `${shortStamp(new Date(first.sentAt))} - ${shortStamp(new Date(last.sentAt))}`;

  let seen = 0;
  const lines = entries.map((entry) => {
    const marks: string[] = [];
    for (let i = 0; i < entry.images; i += 1) marks.push(`image ${(seen += 1)}`);
    const attached = marks.length > 0 ? ` (${marks.join(", ")})` : "";
    return `[${shortStamp(new Date(entry.sentAt))}]${attached} ${entry.text}`.trimEnd();
  });

  return {
    note: {
      body:
        "Act on each message as of the time it was sent: anything dated (macros, weight) belongs " +
        "to that day and needs an explicit date, and a time-relative request from back then may no " +
        "longer make sense - judge it or ask. Answer the whole catch-up once, not message by message.",
      info: `${entries.length} message${entries.length === 1 ? "" : "s"} reached me late (${span}). It is now ${stamp(new Date(now))}.`,
      source: "backlog",
    },
    text: lines.join("\n"),
  };
}
