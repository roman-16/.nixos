---
name: backup
description: Commit and push the working directory to its private git backup repo right now. Use when the user asks to back up, save, commit, or push the workspace, or after important changes worth persisting before the next scheduled backup.
---

# Backup

Commits everything in the working directory and pushes it to the private backup repo - the same action that runs automatically every 3 hours, available on demand.

```bash
{baseDir}/scripts/backup.sh
```

When the workspace changed it reports `Backed up and pushed (commit <sha>).`; when there is nothing to back up it reports `Nothing to back up.` It handles staging, the commit (only when something changed) with a timestamp message, the push, and the credentials itself - nothing else is needed.

## Replying

**The script sends its output to the user itself - do not relay it.** It posts its printed output straight to the user on WhatsApp (as a "via backup" message), then prints `[backup: delivered to the user ✓ - do not relay]`. When you see that line, **stay silent**: don't repeat, summarize, or rephrase it - the user already got it verbatim, and restating it double-sends.

If the script prints `[backup: delivery FAILED ...]` instead, the send didn't happen: relay that output yourself, just this once (the backup still ran - don't re-run it).

`{baseDir}` = this skill's directory. Always resolve to the absolute path before executing.
