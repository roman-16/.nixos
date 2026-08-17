/** Tailwind fill class for a 0-100 percentage: green below 70, amber below 90, red at or above. */
export function barColor(pct: number): string {
  return pct >= 90 ? "bg-red-500" : pct >= 70 ? "bg-amber-500" : "bg-emerald-500";
}

/** Escape HTML-significant characters for safe interpolation into markup. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** A byte count as a person reads it: `2.1 MB`, `148 KB`, `12 B`. */
export function humanBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.max(0, Math.round(bytes))} B`;
}

/** Abbreviate a token count to a short human label (e.g. 123456 -> "123K", 1.2e6 -> "1.2M"). */
export function humanTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
  return String(n);
}

/** Cap a string at `max` chars, appending a note about how many were dropped. */
export function truncate(value: string, max: number): string {
  return value.length > max
    ? `${value.slice(0, max)}\n… (${value.length - max} more chars)`
    : value;
}
