import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { type ExtensionAPI, estimateTokens } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

interface LoadContextDetails {
  paths: string[];
  files: string[];
  fileCount: number;
  tokens: number;
}

const BINARY_SCAN_BYTES = 8192;

// A NUL byte in the first few KB is git's own heuristic for "binary".
function isBinary(buf: Buffer): boolean {
  const end = Math.min(buf.length, BINARY_SCAN_BYTES);
  for (let i = 0; i < end; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

// Shell-like split: whitespace separates paths, but "double" and 'single'
// quotes group spaces, so @"tests 1/" stays a single path.
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      started = true;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (ch === " " || ch === "\t") {
      if (started) {
        tokens.push(cur);
        cur = "";
        started = false;
      }
    } else {
      cur += ch;
      started = true;
    }
  }
  if (started) tokens.push(cur);
  return tokens.filter((t) => t.length > 0);
}

function expandPath(raw: string, cwd: string): string {
  let p = raw.replace(/^@/, "");
  if (p === "~" || p.startsWith("~/")) p = join(homedir(), p.slice(1));
  return isAbsolute(p) ? p : resolve(cwd, p);
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
}

// Enumerate non-ignored files in a directory via git so .gitignore (including
// nested ignores, negations, and global excludes) is honored for free. Falls
// back to a plain walk when the path is not inside a git repository.
async function listFiles(pi: ExtensionAPI, dir: string): Promise<string[]> {
  const result = await pi.exec(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "."],
    { cwd: dir },
  );

  if (result.code === 0) {
    return result.stdout
      .split("\0")
      .filter(Boolean)
      .map((rel) => resolve(dir, rel))
      .filter((abs) => existsSync(abs));
  }

  const out: string[] = [];
  walk(dir, out);
  return out;
}

export default function (pi: ExtensionAPI) {
  pi.registerMessageRenderer<LoadContextDetails>("load-context", (message, { expanded }, theme) => {
    const details = message.details;
    if (!details) return new Text(message.content as string, 0, 0);

    let text =
      theme.fg("accent", "📎 ") +
      theme.fg("toolTitle", theme.bold("load-context ")) +
      theme.fg("muted", `${details.fileCount} file(s) · ~${details.tokens.toLocaleString()} tokens`) +
      theme.fg("dim", ` from ${details.paths.join(", ")}`);

    if (expanded && details.files.length > 0) {
      text += "\n" + details.files.map((f) => theme.fg("dim", `  ${f}`)).join("\n");
    }

    return new Text(text, 0, 0);
  });

  pi.registerCommand("load-context", {
    description: "Recursively load a path's files into context (gitignore-aware, with confirmation)",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("load-context requires interactive mode", "error");
        return;
      }

      const rawPaths = tokenize(args);
      if (rawPaths.length === 0) {
        ctx.ui.notify("Usage: /load-context <path> [path...]", "warning");
        return;
      }

      const resolvedPaths: string[] = [];
      for (const rp of rawPaths) {
        const abs = expandPath(rp, ctx.cwd);
        if (existsSync(abs)) resolvedPaths.push(abs);
        else ctx.ui.notify(`Path not found: ${rp}`, "error");
      }
      if (resolvedPaths.length === 0) return;

      const seen = new Set<string>();
      const files: string[] = [];
      for (const p of resolvedPaths) {
        const candidates = statSync(p).isDirectory() ? await listFiles(pi, p) : [p];
        for (const f of candidates) {
          if (seen.has(f)) continue;
          seen.add(f);
          files.push(f);
        }
      }

      const entries: { rel: string; content: string }[] = [];
      for (const file of files) {
        try {
          const buf = readFileSync(file);
          if (isBinary(buf)) continue;
          entries.push({ rel: relative(ctx.cwd, file) || file, content: buf.toString("utf8") });
        } catch {
          // skip unreadable
        }
      }

      if (entries.length === 0) {
        ctx.ui.notify("No readable (non-binary, non-ignored) files found", "warning");
        return;
      }

      const displayPaths = resolvedPaths.map((p) => relative(ctx.cwd, p) || p);
      const body = entries.map((e) => `===== ${e.rel} =====\n${e.content}`).join("\n\n");
      const content = `Loaded ${entries.length} file(s) into context from ${displayPaths.join(", ")} at the user's request:\n\n${body}`;

      const tokens = estimateTokens({
        role: "user",
        content: [{ type: "text", text: content }],
        timestamp: Date.now(),
      } as Parameters<typeof estimateTokens>[0]);

      const contextWindow = ctx.getContextUsage()?.contextWindow ?? ctx.model?.contextWindow;
      const pctStr = contextWindow ? ` (~${Math.round((tokens / contextWindow) * 100)}% of context)` : "";

      const ok = await ctx.ui.confirm(
        "Load into context?",
        `${entries.length} file(s) · ~${tokens.toLocaleString()} tokens${pctStr}\n${displayPaths.join("\n")}`,
      );
      if (!ok) {
        ctx.ui.notify("Cancelled", "info");
        return;
      }

      await pi.sendMessage<LoadContextDetails>(
        {
          customType: "load-context",
          content,
          display: true,
          details: { paths: displayPaths, files: entries.map((e) => e.rel), fileCount: entries.length, tokens },
        },
        { deliverAs: "nextTurn" },
      );

      ctx.ui.notify(`Loaded ${entries.length} file(s) (~${tokens.toLocaleString()} tokens)`, "info");
    },
  });
}
