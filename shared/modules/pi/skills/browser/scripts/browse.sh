#!/usr/bin/env bash
# Thin wrapper for Browserbase's `browse` CLI, always the latest release.
# Runs via Node.js (npx) or Bun (bunx), whichever is on PATH. Prefers npx and
# falls back to Bun; force a runner with BROWSE_RUNNER=npx|bunx|bun.
set -euo pipefail

export BROWSE_DISABLE_UPDATE_CHECK=1
export BROWSE_LOAD_DOTENV="${BROWSE_LOAD_DOTENV:-0}"

runner="${BROWSE_RUNNER:-}"
if [ -z "$runner" ]; then
  if command -v npx >/dev/null 2>&1; then
    runner="npx"
  elif command -v bunx >/dev/null 2>&1; then
    runner="bunx"
  elif command -v bun >/dev/null 2>&1; then
    runner="bun"
  else
    echo "browse.sh: no JavaScript runner found; install Node.js (npx) or Bun (bunx), or set BROWSE_RUNNER" >&2
    exit 127
  fi
fi

case "$runner" in
  npx) exec npx --yes browse@latest "$@" ;;
  bunx) exec bunx --bun browse@latest "$@" ;;
  bun) exec bun x --bun browse@latest "$@" ;;
  *)
    echo "browse.sh: unknown BROWSE_RUNNER '$runner' (expected npx, bunx, or bun)" >&2
    exit 2
    ;;
esac
