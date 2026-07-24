/**
 * Run the workspace backup on demand. The git work lives in a server-side script
 * (APOLLO_BACKUP_SCRIPT, the same one the 3h timer runs); the agent only triggers this over
 * /internal/backup and relays the one-line outcome. Returns that outcome, or a failure line.
 */
export async function runWorkspaceBackup(): Promise<string> {
  const script = process.env.APOLLO_BACKUP_SCRIPT;
  if (!script) return "⚠️ Backup is not configured.";
  try {
    const proc = Bun.spawn([script], { stderr: "pipe", stdout: "pipe" });
    const [out, err, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode === 0) return out.trim() || "Backup ran.";
    return `⚠️ Backup failed: ${(err.trim() || out.trim() || "unknown error").slice(0, 300)}`;
  } catch (error) {
    return `⚠️ Backup could not be started: ${error instanceof Error ? error.message : String(error)}`;
  }
}
