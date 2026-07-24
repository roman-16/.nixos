#!/usr/bin/env bash
# Canonical workspace backup: commit everything and push. The "backup" skill runs this on
# demand and apollo-backup.service runs it every 3h (both as the apollo user). git, ssh and
# coreutils come from the unit PATH; HOME and APOLLO_WORKSPACE from the unit environment. A
# clean workspace is a no-op that reports "Nothing to back up."; otherwise everything is
# committed with a timestamp message and pushed.
#
# It then posts its result straight to the user on WhatsApp through the app's localhost
# skill-message hook (the same channel macros and reminders use) and prints a delivered/failed
# marker, so the agent never relays it. The scheduled timer passes --quiet to skip that: a
# background backup shouldn't ping the user, and the timer's PATH has no curl.
set -euo pipefail

export GIT_AUTHOR_NAME=Roman GIT_COMMITTER_NAME=Roman
export GIT_AUTHOR_EMAIL=roman@lerchster.dev GIT_COMMITTER_EMAIL=roman@lerchster.dev
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0='*'
export GIT_SSH_COMMAND="ssh -i $HOME/.ssh/id_apollo -o IdentitiesOnly=yes -o UserKnownHostsFile=$HOME/.ssh/known_hosts -o StrictHostKeyChecking=yes"

quiet=""
if [ "${1:-}" = "--quiet" ]; then
  quiet=1
fi

cd "$APOLLO_WORKSPACE"
git add -A
if git diff --cached --quiet; then
  reply="Nothing to back up."
else
  git commit -q -m "$(date '+%Y-%m-%d %H:%M:%S')"
  git push -q -u origin main
  reply="Backed up and pushed (commit $(git rev-parse --short HEAD))."
fi
echo "$reply"

if [ -n "$quiet" ]; then
  exit 0
fi

port="${PORT:-8080}"
if curl --silent --fail --max-time 8 \
  --request POST \
  --header "Content-Type: text/plain; charset=utf-8" \
  --data-binary "$reply" \
  "http://127.0.0.1:${port}/internal/skill-message?source=backup" >/dev/null 2>&1; then
  printf '\n[backup: delivered to the user ✓ - do not relay]\n'
else
  printf '\n[backup: delivery FAILED - relay the output above to the user yourself]\n'
fi
