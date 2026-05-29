import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const checkedDirs = new Set<string>();
  const loaded = new Set<string>();
  let projectRoot = "";

  pi.on("session_start", async (_event, ctx) => {
    projectRoot = ctx.cwd;
    checkedDirs.clear();
    loaded.clear();
  });

  pi.on("tool_result", async (event, ctx) => {
    if (
      event.toolName !== "read" &&
      event.toolName !== "write" &&
      event.toolName !== "edit"
    ) {
      return;
    }

    const filePath = (event as any).input?.path;
    if (!filePath) return;

    const absolutePath = resolve(projectRoot, filePath);
    let dir = dirname(absolutePath);
    const rules: { content: string; path: string }[] = [];

    while (dir.startsWith(projectRoot) && dir !== projectRoot) {
      if (checkedDirs.has(dir)) break;
      checkedDirs.add(dir);

      const agentsPath = join(dir, "AGENTS.md");

      if (!loaded.has(agentsPath) && existsSync(agentsPath)) {
        try {
          const content = readFileSync(agentsPath, "utf8").trim();
          if (content) {
            loaded.add(agentsPath);
            const relativePath = agentsPath.slice(projectRoot.length + 1);
            rules.push({ content, path: relativePath });
          }
        } catch {
          // skip unreadable
        }
      }

      dir = dirname(dir);
    }

    if (rules.length === 0) return;

    // Show in chat
    for (const rule of rules) {
      ctx.ui.notify(`Loaded AGENTS.md: ${rule.path}`, "info");
    }

    // Append to tool result
    const rulesText = rules
      .map((r) => `\n\n[Rules from ${r.path}]\n${r.content}`)
      .join("");

    return {
      content: [
        ...(event.content ?? []),
        { type: "text" as const, text: rulesText },
      ],
    };
  });
}
