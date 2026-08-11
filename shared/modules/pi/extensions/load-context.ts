import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { type ExtensionAPI, estimateTokens } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

type ExclusionReason = "generated" | "oversized" | "secret";

interface ExcludedFile {
  reason: ExclusionReason;
  rel: string;
  tokens?: number;
}

interface LoadContextDetails {
  excluded: ExcludedFile[];
  excludedPaths: string[];
  fileCount: number;
  files: string[];
  paths: string[];
  tokens: number;
}

const BINARY_SCAN_BYTES = 8192;

const BULKY_FORMATS = ["*.csv", "*.geojson", "*.ipynb", "*.snap", "*.sql", "*.svg", "*.tsv"];

const BULKY_FORMAT_TOKEN_LIMIT = 2000;

const ESTIMATED_CHARS_PER_TOKEN = 4;

const GENERATED_FILES = [
  "*.lock",
  "*.lockfile",
  "*.map",
  "*.min.css",
  "*.min.js",
  "*.min.mjs",
  "*.pb.go",
  "*.tsbuildinfo",
  "bun.lockb",
  "bun.nix",
  "go.sum",
  "go.work.sum",
  "lock.dsc.yaml",
  "npm-shrinkwrap.json",
  "package-lock.json",
  "packages.lock.json",
  "pnpm-lock.yaml",
];

const SECRET_FILES = [
  "*.jks",
  "*.key",
  "*.keystore",
  "*.p12",
  "*.pem",
  "*.pfx",
  "*.ppk",
  ".env",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa",
  "secrets.json",
];

function globMatcher(globs: string[]): (name: string) => boolean {
  const patterns = globs.map(
    (g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`),
  );
  return (name) => patterns.some((re) => re.test(name));
}

const isBulkyFormat = globMatcher(BULKY_FORMATS);
const isGenerated = globMatcher(GENERATED_FILES);
const isSecret = globMatcher(SECRET_FILES);

function estimateFileTokens(path: string): number {
  return Math.ceil(statSync(path).size / ESTIMATED_CHARS_PER_TOKEN);
}

function exclusionFor(path: string): Omit<ExcludedFile, "rel"> | null {
  const name = basename(path);
  if (isSecret(name)) return { reason: "secret" };
  if (isGenerated(name)) return { reason: "generated" };
  if (isBulkyFormat(name)) {
    const tokens = estimateFileTokens(path);
    if (tokens > BULKY_FORMAT_TOKEN_LIMIT) return { reason: "oversized", tokens };
  }
  return null;
}

const PRIVATE_KEY_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/;

// A PEM / OpenSSH / PGP private-key block must never reach the transcript,
// whatever the file is named. Detected by content (not extension) so an
// arbitrarily named key (deploy_key, id_ed25519, notes.txt, ...) is caught too.
// Unlike the name excludes this also blocks an explicitly named file; --all
// still bypasses it.
function containsPrivateKey(buf: Buffer): boolean {
  return PRIVATE_KEY_RE.test(buf.toString("utf8", 0, BINARY_SCAN_BYTES));
}

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

function estimateTextTokens(text: string): number {
  return estimateTokens({
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  } as Parameters<typeof estimateTokens>[0]);
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

function formatSkipped(excluded: ExcludedFile[]): string {
  const width = Math.max(...excluded.map((e) => e.reason.length));
  const lines = excluded.map(
    (e) =>
      `  ${e.reason.padEnd(width)}  ${e.rel}${e.tokens ? ` (~${e.tokens.toLocaleString()} tokens)` : ""}`,
  );
  return `\n\nskipped ${excluded.length} file(s) (use --all to include):\n${lines.join("\n")}`;
}

export default function (pi: ExtensionAPI) {
  pi.registerMessageRenderer<LoadContextDetails>("load-context", (message, { expanded }, theme) => {
    const details = message.details;
    if (!details) return new Text(message.content as string, 0, 0);

    let text =
      theme.fg("accent", "📎 ") +
      theme.fg("toolTitle", theme.bold("load-context ")) +
      theme.fg("muted", `${details.fileCount} file(s) · ~${details.tokens.toLocaleString()} tokens`) +
      (details.excluded?.length ? theme.fg("muted", ` · ${details.excluded.length} skipped`) : "") +
      theme.fg("dim", ` from ${details.paths.join(", ")}`) +
      (details.excludedPaths?.length ? theme.fg("dim", ` excluding ${details.excludedPaths.join(", ")}`) : "");

    if (expanded && details.files.length > 0) {
      text += "\n" + details.files.map((f) => theme.fg("dim", `  ${f}`)).join("\n");
    }
    if (expanded && details.excluded?.length) {
      text += "\n" + details.excluded.map((e) => theme.fg("dim", `  - ${e.rel} (${e.reason})`)).join("\n");
    }

    return new Text(text, 0, 0);
  });

  pi.registerCommand("load-context", {
    description:
      "Recursively load a path's files into context (gitignore-aware, skips secrets/generated/oversized files, !path to exclude, with confirmation)",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("load-context requires interactive mode", "error");
        return;
      }

      const argTokens = tokenize(args);
      const includeAll = argTokens.some((t) => t === "--all" || t === "--no-exclude");
      const showTop = argTokens.some((t) => t === "--top");
      const rawTokens = argTokens.filter((t) => !["--all", "--no-exclude", "--top"].includes(t));
      const rawExcludes = rawTokens.filter((t) => t.startsWith("!")).map((t) => t.slice(1));
      const rawPaths = rawTokens.filter((t) => !t.startsWith("!"));
      if (rawPaths.length === 0) rawPaths.push(".");

      const resolvedPaths: string[] = [];
      for (const rp of rawPaths) {
        const abs = expandPath(rp, ctx.cwd);
        if (existsSync(abs)) resolvedPaths.push(abs);
        else ctx.ui.notify(`Path not found: ${rp}`, "error");
      }
      if (resolvedPaths.length === 0) return;

      const excludePaths: string[] = [];
      for (const rp of rawExcludes) {
        const abs = expandPath(rp, ctx.cwd);
        if (!existsSync(abs)) ctx.ui.notify(`Exclude path not found: ${rp}`, "warning");
        excludePaths.push(abs);
      }
      const isUserExcluded = (f: string) => excludePaths.some((p) => f === p || f.startsWith(`${p}/`));

      const seen = new Set<string>();
      const files: string[] = [];
      const excluded: ExcludedFile[] = [];
      let userExcludedCount = 0;
      for (const p of resolvedPaths) {
        const isDir = statSync(p).isDirectory();
        const candidates = isDir ? await listFiles(pi, p) : [p];
        for (const f of candidates) {
          if (seen.has(f)) continue;
          seen.add(f);
          if (isUserExcluded(f)) {
            userExcludedCount++;
            continue;
          }
          const exclusion = isDir && !includeAll ? exclusionFor(f) : null;
          if (exclusion) {
            excluded.push({ ...exclusion, rel: relative(ctx.cwd, f) || f });
            continue;
          }
          files.push(f);
        }
      }

      const entries: { rel: string; content: string }[] = [];
      for (const file of files) {
        try {
          const buf = readFileSync(file);
          if (isBinary(buf)) continue;
          const rel = relative(ctx.cwd, file) || file;
          if (!includeAll && containsPrivateKey(buf)) {
            excluded.push({ reason: "secret", rel });
            continue;
          }
          entries.push({ rel, content: buf.toString("utf8") });
        } catch {
          // skip unreadable
        }
      }
      excluded.sort((a, b) => a.reason.localeCompare(b.reason) || a.rel.localeCompare(b.rel));

      if (entries.length === 0) {
        ctx.ui.notify("No readable (non-binary, non-ignored) files found", "warning");
        return;
      }

      const displayPaths = resolvedPaths.map((p) => relative(ctx.cwd, p) || p);
      const displayExcludes = excludePaths.map((p) => relative(ctx.cwd, p) || p);
      const excludeSuffix = displayExcludes.length > 0 ? ` (excluding ${displayExcludes.join(", ")})` : "";
      const body = entries.map((e) => `===== ${e.rel} =====\n${e.content}`).join("\n\n");
      const content = `Loaded ${entries.length} file(s) into context from ${displayPaths.join(", ")}${excludeSuffix} at the user's request:\n\n${body}`;

      const estimated = estimateTextTokens(content);

      const contextWindow = ctx.getContextUsage()?.contextWindow ?? ctx.model?.contextWindow;
      const pctStr = contextWindow ? ` (~${Math.round((estimated / contextWindow) * 100)}% of context)` : "";
      const skippedNote = excluded.length > 0 ? formatSkipped(excluded) : "";

      let topNote = "";
      if (showTop) {
        const largest = entries
          .map((e) => ({ rel: e.rel, tokens: estimateTextTokens(e.content) }))
          .sort((a, b) => b.tokens - a.tokens)
          .slice(0, 10);
        const width = Math.max(...largest.map((e) => e.tokens.toLocaleString().length)) + 1;
        topNote = `\n\nlargest ${largest.length} file(s) by tokens:\n${largest
          .map((e) => `  ${`~${e.tokens.toLocaleString()}`.padStart(width)} ${e.rel}`)
          .join("\n")}`;
      }

      const excludeNote =
        excludePaths.length > 0
          ? `\n\nexcluded ${userExcludedCount} file(s) via ${displayExcludes.map((p) => `!${p}`).join(", ")}`
          : "";

      const ok = await ctx.ui.confirm(
        "Load into context?",
        `${entries.length} file(s) · ~${estimated.toLocaleString()} tokens${pctStr}\n${displayPaths.join("\n")}${excludeNote}${topNote}${skippedNote}`,
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
          details: {
            excluded,
            excludedPaths: displayExcludes,
            fileCount: entries.length,
            files: entries.map((e) => e.rel),
            paths: displayPaths,
            tokens: estimated,
          },
        },
        { deliverAs: "nextTurn" },
      );

      const skippedSuffix = excluded.length > 0 ? `, skipped ${excluded.length}` : "";
      ctx.ui.notify(`Loaded ${entries.length} file(s) (~${estimated.toLocaleString()} tokens${skippedSuffix})`, "info");
    },
  });
}
