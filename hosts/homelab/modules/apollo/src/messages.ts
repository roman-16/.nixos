import { humanTokens } from "./format";

const DEFAULT_MAX_CHARS = 4000;

/** Build the brief WhatsApp notice sent when the session context is compacted. */
export function compactionNotice(tokensBefore?: number): string {
  const count = tokensBefore && tokensBefore > 0 ? ` (~${humanTokens(tokensBefore)} tokens)` : "";
  return `🗜️ Context compacted${count}. Full summary on the dashboard.`;
}

/** Strip a WhatsApp JID to its bare number (drops the device suffix and domain). */
export function numberFromJid(jid: string): string {
  const user = jid.split("@")[0] ?? "";
  return (user.split(":")[0] ?? "").replace(/\D/g, "");
}

/** Mark a transcribed voice note so it reads as spoken in the chat log and to the agent. */
export function voiceText(transcript: string): string {
  const trimmed = transcript.trim();
  return trimmed ? `🎤 ${trimmed}` : "🎤 (empty voice message)";
}

/** True when the sender's number is on the allowlist (both sides normalized to digits). */
export function isAllowed(number: string, allowFrom: string[]): boolean {
  const normalized = number.replace(/\D/g, "");
  if (!normalized) return false;
  return allowFrom.some((entry) => entry.replace(/\D/g, "") === normalized);
}

/**
 * Split text into WhatsApp-sized chunks, preferring line then word boundaries and
 * hard-cutting only when a single run exceeds the limit. Empty input yields no messages.
 */
export function splitMessage(text: string, max: number = DEFAULT_MAX_CHARS): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed ? [trimmed] : [];

  const chunks: string[] = [];
  let rest = trimmed;
  while (rest.length > max) {
    const floor = Math.floor(max * 0.5);
    let cut = rest.lastIndexOf("\n", max);
    if (cut < floor) cut = rest.lastIndexOf(" ", max);
    if (cut < floor) cut = max;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks.filter(Boolean);
}
