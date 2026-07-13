#!/usr/bin/env bash
# Canonical workspace backup: commit everything and push. The "backup" skill
# runs this on demand and apollo-backup.service runs it every 6h (both as the
# apollo user). git, ssh and coreutils come from the unit PATH; HOME and
# APOLLO_WORKSPACE from the unit environment. The commit message is a timestamp
# so the history reads as uniform backups regardless of what triggered them.
set -euo pipefail

export GIT_AUTHOR_NAME=Roman GIT_COMMITTER_NAME=Roman
export GIT_AUTHOR_EMAIL=roman@lerchster.dev GIT_COMMITTER_EMAIL=roman@lerchster.dev
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0='*'
export GIT_SSH_COMMAND="ssh -i $HOME/.ssh/id_apollo -o IdentitiesOnly=yes -o UserKnownHostsFile=$HOME/.ssh/known_hosts -o StrictHostKeyChecking=yes"

cd "$APOLLO_WORKSPACE"
git add -A
if git diff --cached --quiet; then
  committed=""
else
  git commit -q -m "$(date '+%Y-%m-%d %H:%M:%S')"
  committed="$(git rev-parse --short HEAD)"
fi
if git rev-parse --verify --quiet HEAD >/dev/null; then
  git push -q -u origin main
fi
if [ -n "$committed" ]; then
  echo "Backed up and pushed (commit $committed)."
else
  echo "Nothing new to back up."
fi
