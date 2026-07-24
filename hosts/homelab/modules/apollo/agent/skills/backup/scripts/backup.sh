#!/usr/bin/env bash
# The backup skill only *triggers* the workspace backup and relays the outcome. The git capability
# (deploy key, commit, push) lives in the privileged root apollo-backup.service, out of the agent's
# reach - this script never runs git. Deterministic: fetch the outcome from the app's /internal/backup
# hook, then hand it to /internal/skill-message, which delivers it and returns the marker to print.
set -euo pipefail

port="${PORT:-8080}"
outcome=$(curl --silent --show-error --max-time 300 --request POST "http://127.0.0.1:${port}/internal/backup")
printf '%s\n' "$outcome"
curl --silent --show-error --max-time 8 --request POST \
  --header "Content-Type: text/plain; charset=utf-8" \
  --data-binary "$outcome" \
  "http://127.0.0.1:${port}/internal/skill-message?source=backup"
