#!/usr/bin/env bash
# Thin wrapper for Browserbase's `browse` CLI, always the latest release via npx.
# Requires Node.js (npx) on PATH.
set -euo pipefail

export BROWSE_DISABLE_UPDATE_CHECK=1
export BROWSE_LOAD_DOTENV="${BROWSE_LOAD_DOTENV:-0}"

exec npx --yes browse@latest "$@"
