/** Escape HTML-significant characters for safe interpolation into markup. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
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
