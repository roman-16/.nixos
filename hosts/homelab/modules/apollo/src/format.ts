/** Abbreviate a token count to a short human label (e.g. 123456 -> "123K", 1.2e6 -> "1.2M"). */
export function humanTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
  return String(n);
}
