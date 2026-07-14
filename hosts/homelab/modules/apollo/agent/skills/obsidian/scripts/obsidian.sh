#!/usr/bin/env bash
# Sync Roman's Obsidian vault, a nested git repo at $APOLLO_WORKSPACE/obsidian
# (excluded from the workspace backup). `pull` clones it on first use then
# fast-forwards; `save` stages everything, commits with a timestamp, and pushes.
# Mirrors the backup skill: git/ssh/coreutils come from the caller's PATH,
# HOME/APOLLO_WORKSPACE/OBSIDIAN_REMOTE from the apollo unit environment.
# Authenticates with the obsidian-only deploy key.
set -euo pipefail

export GIT_AUTHOR_NAME=Roman GIT_COMMITTER_NAME=Roman
export GIT_AUTHOR_EMAIL=roman@lerchster.dev GIT_COMMITTER_EMAIL=roman@lerchster.dev
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0='*'
export GIT_SSH_COMMAND="ssh -i $HOME/.ssh/id_obsidian -o IdentitiesOnly=yes -o UserKnownHostsFile=$HOME/.ssh/known_hosts -o StrictHostKeyChecking=yes"

vault="$APOLLO_WORKSPACE/obsidian"

case "${1:-}" in
  pull)
    if [ -e "$vault/.git" ]; then
      git -C "$vault" pull -q --ff-only
    else
      git clone -q "$OBSIDIAN_REMOTE" "$vault"
    fi
    echo "Vault synced."
    ;;
  save)
    [ -e "$vault/.git" ] || {
      echo "Vault not cloned yet - run 'obsidian.sh pull' first." >&2
      exit 1
    }
    git -C "$vault" add -A
    if git -C "$vault" diff --cached --quiet; then
      echo "Nothing to save."
      exit 0
    fi
    git -C "$vault" commit -q -m "$(date '+%Y-%m-%d %H:%M:%S')"
    git -C "$vault" push -q
    echo "Saved and pushed (commit $(git -C "$vault" rev-parse --short HEAD))."
    ;;
  *)
    echo "usage: obsidian.sh {pull|save}" >&2
    exit 1
    ;;
esac
