/**
 * In-memory ring buffer of the app's own pino log records, for the dashboard log
 * viewer. The buffer's `stream` is handed to pino as its destination: every record
 * is forwarded to stdout (so journald still captures it) and parsed into the buffer.
 */

const LOG_CAPACITY = 1000;

export type LogLevel = "all" | "error" | "info" | "warn";

export type LogRecord = Record<string, unknown> & {
  level?: number;
  msg?: string;
  time?: number;
};

const THRESHOLDS: Record<LogLevel, number> = { all: 0, error: 50, info: 30, warn: 40 };

/** Coerce a query value to a known filter level, defaulting to "all". */
export function parseLevel(value: string | null | undefined): LogLevel {
  return value === "info" || value === "warn" || value === "error" ? value : "all";
}

/** Records at or above the level threshold, newest first. */
export function filterLogs(records: LogRecord[], level: LogLevel): LogRecord[] {
  const min = THRESHOLDS[level];
  const out: LogRecord[] = [];
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i];
    if (record && typeof record.level === "number" && record.level >= min) out.push(record);
  }
  return out;
}

export interface LogBuffer {
  push(record: LogRecord): void;
  records(): LogRecord[];
  readonly seq: number;
  stream: { write(line: string): void };
}

/** Create a capped log buffer plus the pino destination stream that feeds it. */
export function createLogBuffer(capacity = LOG_CAPACITY): LogBuffer {
  const items: LogRecord[] = [];
  let seq = 0;

  function push(record: LogRecord): void {
    items.push(record);
    if (items.length > capacity) items.shift();
    seq += 1;
  }

  return {
    push,
    records: () => items,
    get seq() {
      return seq;
    },
    stream: {
      write(line: string) {
        process.stdout.write(line);
        for (const part of line.split("\n")) {
          const trimmed = part.trim();
          if (!trimmed) continue;
          try {
            push(JSON.parse(trimmed) as LogRecord);
          } catch {
            // Non-JSON line (shouldn't happen with pino); already forwarded to stdout.
          }
        }
      },
    },
  };
}
