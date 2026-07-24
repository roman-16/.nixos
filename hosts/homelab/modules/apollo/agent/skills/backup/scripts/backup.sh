#!/usr/bin/env bash
# Canonical workspace backup: commit everything and push. The "backup" skill
# runs this on demand and apollo-backup.service runs it every 3h (both as the
# apollo user). git, ssh and coreutils come from the unit PATH; HOME and
# APOLLO_WORKSPACE from the unit environment. A clean workspace is a no-op that
# prints "Nothing to back up."; otherwise everything is committed with a
# timestamp message and pushed.
set -euo pipefail

export GIT_AUTHOR_NAME=Roman GIT_COMMITTER_NAME=Roman
export GIT_AUTHOR_EMAIL=roman@lerchster.dev GIT_COMMITTER_EMAIL=roman@lerchster.dev
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0='*'
export GIT_SSH_COMMAND="ssh -i $HOME/.ssh/id_apollo -o IdentitiesOnly=yes -o UserKnownHostsFile=$HOME/.ssh/known_hosts -o StrictHostKeyChecking=yes"

cd "$APOLLO_WORKSPACE"
git add -A
if git diff --cached --quiet; then
  echo "Nothing to back up."
  exit 0
fi
git commit -q -m "$(date '+%Y-%m-%d %H:%M:%S')"
git push -q -u origin main
echo "Backed up and pushed (commit $(git rev-parse --short HEAD))."
