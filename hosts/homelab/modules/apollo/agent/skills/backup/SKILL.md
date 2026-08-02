---
name: backup
description: Commit and push the working directory to its private git backup repo right now. Use when the user asks to back up, save, commit, or push the workspace, or after important changes worth persisting before the next scheduled backup.
---

# Backup

Backs up the working directory to its private git backup repo - the same action that runs automatically every 3 hours, available on demand. The backup itself (commit, push) runs server-side; this skill only triggers it over HTTP and relays the outcome.

```bash
{baseDir}/scripts/backup.sh
```

It reports `Backed up and pushed (commit <sha>).`, `Nothing to back up.`, or a failure line - nothing else is needed.

## Replying

**The script delivers its result to the user itself - do not relay it.** It triggers the backup and posts the outcome straight to the user on WhatsApp (as a "via backup" message), then prints `[backup: delivered to the user ✓ ...]`. When you see that line, **stay silent**: don't repeat, summarize, or rephrase it - the user already got it verbatim, and restating it double-sends. Silence is written, not implied: close the turn with `<internal>…</internal>`, never with a line about staying quiet.

If the script prints `[backup: delivery FAILED ...]` instead, the send didn't happen: relay that output yourself, just this once (the backup still ran - don't re-run it).

`{baseDir}` = this skill's directory. Always resolve to the absolute path before executing.
