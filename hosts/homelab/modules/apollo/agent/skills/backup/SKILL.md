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

It prints `Backed up and pushed (commit <sha>).`. Nothing else is needed - it handles the commit (always made, empty when nothing changed), the timestamp message, the push, and the credentials itself.

`{baseDir}` = this skill's directory. Always resolve to the absolute path before executing.
