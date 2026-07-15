---
name: backup
description: Commit and push the working directory to its private git backup repo right now. Use when the user asks to back up, save, commit, or push the workspace, or after important changes worth persisting before the next scheduled backup.
---

# Backup

Commits everything in the working directory and pushes it to the private backup repo - the same action that runs automatically every 6 hours, available on demand.

Run it and relay the output:

```bash
{baseDir}/scripts/backup.sh
```

When the workspace changed it prints `Backed up and pushed (commit <sha>).`; when there is nothing to back up it prints `Nothing to back up.` and stops. Either way nothing else is needed - it handles staging, the commit (only when something changed) with a timestamp message, the push, and the credentials itself.

`{baseDir}` = this skill's directory. Always resolve to the absolute path before executing.
