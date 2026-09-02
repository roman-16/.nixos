import { Glob } from "bun";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
  convertToPng,
  detectSupportedImageMimeTypeFromFile,
  estimateTokens,
  type ExtensionAPI,
  formatDimensionNote,
  resizeImage,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

type ExclusionReason = "binary" | "generated" | "image" | "oversized" | "secret" | "unsupported";

type ContentBlock = ImageContent | TextContent;

type LoadedFile = LoadedImage | LoadedText;

interface ExcludedFile {
  reason: ExclusionReason;
  rel: string;
  tokens?: number;
}

interface Exclusion {
  display: string;
  matches: (path: string) => boolean;
}

interface LoadContextDetails {
  excluded: ExcludedFile[];
  excludedPaths: string[];
  fileCount: number;
  files: string[];
  imageCount: number;
  paths: string[];
  tokens: number;
}

interface LoadedImage {
  data: string;
  kind: "image";
  mimeType: string;
  note?: string;
  rel: string;
}

interface LoadedText {
  kind: "text";
  rel: string;
  text: string;
}

interface Source {
  display: string;
  files: string[];
  walked: boolean;
}

const BINARY_SCAN_BYTES = 8192;

const BULKY_FORMATS = ["*.csv", "*.geojson", "*.ipynb", "*.snap", "*.sql", "*.svg", "*.tsv"];

const BULKY_FORMAT_TOKEN_LIMIT = 2000;

const BYPASSABLE_REASONS = new Set<ExclusionReason>(["generated", "image", "oversized", "secret"]);

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

const GLOB_MAGIC = /[*?[\]{}]/;

const PRIVATE_KEY_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/;

const PROVIDER_IMAGE_MIME_TYPES = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);

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

const SKIPPED_REASON_LIMIT = 10;

function nameMatcher(patterns: string[]): (name: string) => boolean {
  const globs = patterns.map((pattern) => new Glob(pattern));
  return (name) => globs.some((glob) => glob.match(name));
}

const isBulkyFormat = nameMatcher(BULKY_FORMATS);
const isGenerated = nameMatcher(GENERATED_FILES);
const isSecret = nameMatcher(SECRET_FILES);

function estimateFileTokens(path: string): number {
  return Math.ceil(statSync(path).size / ESTIMATED_CHARS_PER_TOKEN);
}

function nameExclusionFor(path: string): Omit<ExcludedFile, "rel"> | null {
  const name = basename(path);
  if (isSecret(name)) return { reason: "secret" };
  if (isGenerated(name)) return { reason: "generated" };
  if (isBulkyFormat(name)) {
    const tokens = estimateFileTokens(path);
    if (tokens > BULKY_FORMAT_TOKEN_LIMIT) return { reason: "oversized", tokens };
  }
  return null;
}

function containsPrivateKey(buf: Buffer): boolean {
  return PRIVATE_KEY_RE.test(buf.toString("utf8", 0, BINARY_SCAN_BYTES));
}

function isBinary(buf: Buffer): boolean {
  const end = Math.min(buf.length, BINARY_SCAN_BYTES);
  for (let i = 0; i < end; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

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
  return tokens.filter((token) => token.length > 0);
}

function estimateContentTokens(content: ContentBlock[]): number {
  return estimateTokens({
    role: "user",
    content,
    timestamp: Date.now(),
  } as Parameters<typeof estimateTokens>[0]);
}

function expandPath(raw: string, cwd: string): string {
  let path = raw.replace(/^@/, "");
  if (path === "~" || path.startsWith("~/")) path = join(homedir(), path.slice(1));
  return isAbsolute(path) ? path : resolve(cwd, path);
}

function displayPath(cwd: string, path: string): string {
  const rel = relative(cwd, path);
  return !rel || rel.startsWith("..") ? path : rel;
}

function hasGlobMagic(token: string): boolean {
  return GLOB_MAGIC.test(token);
}

function splitPattern(pattern: string): { pattern: string; root: string } {
  const segments = pattern.split("/");
  const rootSegments: string[] = [];
  while (segments.length > 1 && !hasGlobMagic(segments[0] as string)) {
    rootSegments.push(segments.shift() as string);
  }
  return { pattern: segments.join("/"), root: rootSegments.join("/") || "/" };
}

async function listFiles(pi: ExtensionAPI, root: string, pattern?: string): Promise<string[]> {
  const result = await pi.exec(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "."],
    { cwd: root },
  );

  if (result.code === 0) {
    const glob = pattern ? new Glob(pattern) : undefined;
    return result.stdout
      .split("\0")
      .filter((rel) => rel && (!glob || glob.match(rel)))
      .map((rel) => resolve(root, rel))
      .filter((path) => existsSync(path));
  }

  return [
    ...new Glob(pattern ?? "**/*").scanSync({
      absolute: true,
      cwd: root,
      dot: true,
      followSymlinks: true,
      onlyFiles: true,
    }),
  ].filter((path) => !path.split("/").includes(".git"));
}

async function toPng(bytes: Buffer, mimeType: string): Promise<{ bytes: Buffer; mimeType: string } | null> {
  const png = await convertToPng(bytes.toString("base64"), mimeType);
  return png && { bytes: Buffer.from(png.data, "base64"), mimeType: png.mimeType };
}

async function imageContent(path: string, mimeType: string): Promise<Omit<LoadedImage, "kind" | "rel"> | null> {
  const bytes = readFileSync(path);
  const normalized = PROVIDER_IMAGE_MIME_TYPES.has(mimeType)
    ? { bytes, mimeType }
    : await toPng(bytes, mimeType);
  if (!normalized) return null;

  const resized = await resizeImage(normalized.bytes, normalized.mimeType);
  if (!resized) return null;

  return { data: resized.data, mimeType: resized.mimeType, note: formatDimensionNote(resized) };
}

function fileLabel(file: LoadedFile): string {
  const label = `===== ${file.rel} =====`;
  return file.kind === "image" && file.note ? `${label}\n${file.note}` : label;
}

function textSection(file: LoadedText): string {
  return `${fileLabel(file)}\n${file.text}`;
}

function blocksFor(file: LoadedFile): ContentBlock[] {
  return file.kind === "text"
    ? [{ text: textSection(file), type: "text" }]
    : [
        { text: fileLabel(file), type: "text" },
        { data: file.data, mimeType: file.mimeType, type: "image" },
      ];
}

function groupByReason(excluded: ExcludedFile[]): Map<ExclusionReason, ExcludedFile[]> {
  const groups = new Map<ExclusionReason, ExcludedFile[]>();
  for (const file of excluded) {
    const group = groups.get(file.reason);
    if (group) group.push(file);
    else groups.set(file.reason, [file]);
  }
  return groups;
}

function formatImageCount(count: number): string {
  return count > 0 ? ` · ${count} image${count === 1 ? "" : "s"}` : "";
}

function formatSkipped(excluded: ExcludedFile[]): string {
  const width = Math.max(...excluded.map((file) => file.reason.length));
  const lines: string[] = [];
  for (const [reason, group] of groupByReason(excluded)) {
    for (const file of group.slice(0, SKIPPED_REASON_LIMIT)) {
      const tokens = file.tokens ? ` (~${file.tokens.toLocaleString()} tokens)` : "";
      lines.push(`  ${reason.padEnd(width)}  ${file.rel}${tokens}`);
    }
    const hidden = group.length - SKIPPED_REASON_LIMIT;
    if (hidden > 0) lines.push(`  ${" ".repeat(width)}  ... and ${hidden} more`);
  }
  const hint = excluded.some((file) => BYPASSABLE_REASONS.has(file.reason)) ? " (use --all to include)" : "";
  return `\n\nskipped ${excluded.length} file(s)${hint}:\n${lines.join("\n")}`;
}

function summarizeReasons(excluded: ExcludedFile[]): string {
  return [...groupByReason(excluded)].map(([reason, group]) => `${group.length} ${reason}`).join(", ");
}

export default function (pi: ExtensionAPI) {
  pi.registerMessageRenderer<LoadContextDetails>("load-context", (message, { expanded }, theme) => {
    const details = message.details;
    if (!details) return undefined;

    let text =
      theme.fg("accent", "📎 ") +
      theme.fg("toolTitle", theme.bold("load-context ")) +
      theme.fg(
        "muted",
        `${details.fileCount} file(s)${formatImageCount(details.imageCount)} · ~${details.tokens.toLocaleString()} tokens`,
      ) +
      (details.excluded.length ? theme.fg("muted", ` · ${details.excluded.length} skipped`) : "") +
      theme.fg("dim", ` from ${details.paths.join(", ")}`) +
      (details.excludedPaths.length ? theme.fg("dim", ` excluding ${details.excludedPaths.join(", ")}`) : "");

    if (expanded && details.files.length > 0) {
      text += "\n" + details.files.map((file) => theme.fg("dim", `  ${file}`)).join("\n");
    }
    if (expanded && details.excluded.length > 0) {
      text += "\n" + details.excluded.map((file) => theme.fg("dim", `  - ${file.rel} (${file.reason})`)).join("\n");
    }

    return new Text(text, 0, 0);
  });

  pi.registerCommand("load-context", {
    description:
      "Load paths, globs and images into context (gitignore-aware, skips secrets/generated/oversized/binary files, !glob to exclude, with confirmation)",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("load-context requires interactive mode", "error");
        return;
      }

      const argTokens = tokenize(args);
      const includeAll = argTokens.some((token) => token === "--all" || token === "--no-exclude");
      const showTop = argTokens.some((token) => token === "--top");
      const pathTokens = argTokens.filter((token) => !["--all", "--no-exclude", "--top"].includes(token));
      const excludeTokens = pathTokens.filter((token) => token.startsWith("!")).map((token) => token.slice(1));
      const includeTokens = pathTokens.filter((token) => !token.startsWith("!"));
      if (includeTokens.length === 0) includeTokens.push(".");

      const sources: Source[] = [];
      for (const token of includeTokens) {
        const expanded = expandPath(token, ctx.cwd);
        if (existsSync(expanded)) {
          const walked = statSync(expanded).isDirectory();
          sources.push({
            display: displayPath(ctx.cwd, expanded),
            files: walked ? await listFiles(pi, expanded) : [expanded],
            walked,
          });
          continue;
        }
        if (!hasGlobMagic(token)) {
          ctx.ui.notify(`Path not found: ${token}`, "error");
          continue;
        }
        const { pattern, root } = splitPattern(expanded);
        const files = existsSync(root) ? await listFiles(pi, root, pattern) : [];
        if (files.length === 0) {
          ctx.ui.notify(`No files matched: ${token}`, "error");
          continue;
        }
        sources.push({ display: token, files, walked: false });
      }
      if (sources.length === 0) return;

      const exclusions: Exclusion[] = excludeTokens.map((token) => {
        const expanded = expandPath(token, ctx.cwd);
        if (hasGlobMagic(token)) {
          const glob = new Glob(expanded);
          return { display: token, matches: (path: string) => glob.match(path) };
        }
        if (!existsSync(expanded)) ctx.ui.notify(`Exclude path not found: ${token}`, "warning");
        return {
          display: token,
          matches: (path: string) => path === expanded || path.startsWith(`${expanded}/`),
        };
      });

      const modelReadsImages = ctx.model?.input.includes("image") ?? false;
      const seen = new Set<string>();
      const excluded: ExcludedFile[] = [];
      const loaded: LoadedFile[] = [];
      let userExcludedCount = 0;

      for (const source of sources) {
        for (const path of source.files) {
          if (seen.has(path)) continue;
          seen.add(path);
          if (exclusions.some((exclusion) => exclusion.matches(path))) {
            userExcludedCount++;
            continue;
          }

          const rel = displayPath(ctx.cwd, path);
          const filtered = source.walked && !includeAll;
          const nameExclusion = filtered ? nameExclusionFor(path) : null;
          if (nameExclusion) {
            excluded.push({ ...nameExclusion, rel });
            continue;
          }

          const mimeType = await detectSupportedImageMimeTypeFromFile(path).catch(() => null);
          if (mimeType) {
            if (filtered) {
              excluded.push({ reason: "image", rel });
              continue;
            }
            const image = modelReadsImages ? await imageContent(path, mimeType) : null;
            if (!image) {
              excluded.push({ reason: "unsupported", rel });
              continue;
            }
            loaded.push({ ...image, kind: "image", rel });
            continue;
          }

          let buf: Buffer;
          try {
            buf = readFileSync(path);
          } catch {
            continue;
          }
          if (isBinary(buf)) {
            excluded.push({ reason: "binary", rel });
            continue;
          }
          if (!includeAll && containsPrivateKey(buf)) {
            excluded.push({ reason: "secret", rel });
            continue;
          }
          loaded.push({ kind: "text", rel, text: buf.toString("utf8") });
        }
      }
      excluded.sort((a, b) => a.reason.localeCompare(b.reason) || a.rel.localeCompare(b.rel));

      if (loaded.length === 0) {
        const reasons = excluded.length > 0 ? ` (${summarizeReasons(excluded)})` : "";
        ctx.ui.notify(`No loadable files found${reasons}`, "warning");
        return;
      }

      const displayPaths = sources.map((source) => source.display);
      const displayExcludes = exclusions.map((exclusion) => exclusion.display);
      const excludeSuffix = displayExcludes.length > 0 ? ` (excluding ${displayExcludes.join(", ")})` : "";
      const textFiles = loaded.filter((file): file is LoadedText => file.kind === "text");
      const imageFiles = loaded.filter((file): file is LoadedImage => file.kind === "image");
      const header = `Loaded ${loaded.length} file(s) into context from ${displayPaths.join(", ")}${excludeSuffix} at the user's request:`;
      const content: ContentBlock[] = [
        { text: [header, ...textFiles.map(textSection)].join("\n\n"), type: "text" },
        ...imageFiles.flatMap(blocksFor),
      ];

      const estimated = estimateContentTokens(content);

      const contextWindow = ctx.getContextUsage()?.contextWindow ?? ctx.model?.contextWindow;
      const pctStr = contextWindow ? ` (~${Math.round((estimated / contextWindow) * 100)}% of context)` : "";
      const skippedNote = excluded.length > 0 ? formatSkipped(excluded) : "";

      let topNote = "";
      if (showTop) {
        const largest = loaded
          .map((file) => ({ rel: file.rel, tokens: estimateContentTokens(blocksFor(file)) }))
          .sort((a, b) => b.tokens - a.tokens)
          .slice(0, 10);
        const width = Math.max(...largest.map((file) => file.tokens.toLocaleString().length)) + 1;
        topNote = `\n\nlargest ${largest.length} file(s) by tokens:\n${largest
          .map((file) => `  ${`~${file.tokens.toLocaleString()}`.padStart(width)} ${file.rel}`)
          .join("\n")}`;
      }

      const excludeNote =
        exclusions.length > 0
          ? `\n\nexcluded ${userExcludedCount} file(s) via ${displayExcludes.map((path) => `!${path}`).join(", ")}`
          : "";

      const ok = await ctx.ui.confirm(
        "Load into context?",
        `${loaded.length} file(s)${formatImageCount(imageFiles.length)} · ~${estimated.toLocaleString()} tokens${pctStr}\n${displayPaths.join("\n")}${excludeNote}${topNote}${skippedNote}`,
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
            fileCount: loaded.length,
            files: loaded.map((file) => file.rel),
            imageCount: imageFiles.length,
            paths: displayPaths,
            tokens: estimated,
          },
        },
        { deliverAs: "nextTurn" },
      );

      const skippedSuffix = excluded.length > 0 ? `, skipped ${excluded.length}` : "";
      ctx.ui.notify(`Loaded ${loaded.length} file(s) (~${estimated.toLocaleString()} tokens${skippedSuffix})`, "info");
    },
  });
}
