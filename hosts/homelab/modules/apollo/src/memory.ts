import { existsSync, readFileSync } from "node:fs";

import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";

/**
 * Apollo's durable memory: MEMORY.md at the root of the working directory, read fresh at the start
 * of every run and appended to the system prompt.
 *
 * What the user is like does not belong in a compaction summary. A summary is lossy compression
 * applied over and over to its own output: every pass re-copies what came before, so a fact written
 * once decays through paraphrase while the evidence that could correct it is long gone. A file is
 * the opposite. It is rewritten deliberately, it can be corrected by hand, it is versioned with the
 * rest of the working directory, and it says the same thing on the hundredth read as on the first.
 */

/** Longest memory file that is injected whole; beyond this the file needs pruning, not truncating. */
const MAX_MEMORY_CHARS = 12000;

/** The block appended to the system prompt, in the same element vocabulary as the rest. */
export function memoryBlock(path: string, content: string): string {
  const body = content.trim();
  if (!body) return "";
  const kept = body.length > MAX_MEMORY_CHARS ? `${body.slice(0, MAX_MEMORY_CHARS)}\n…` : body;
  return `<memory path="${path}">\n${kept}\n</memory>`;
}

function read(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  } catch {
    return "";
  }
}

/** Inject MEMORY.md into every run, so editing the file is all it takes to change what Apollo knows. */
export function createMemoryExtension(path: string): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.on("before_agent_start", (event) => {
      const block = memoryBlock(path, read(path));
      return block ? { systemPrompt: `${event.systemPrompt}\n\n${block}` } : undefined;
    });
  };
}
