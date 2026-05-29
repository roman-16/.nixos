#!/usr/bin/env bash
# Context7 — up-to-date library docs via REST API. No API key required.
set -euo pipefail

BASE_URL="https://context7.com"

cmd_search() {
  local name="$1" query="${2:-}"
  local args=(-sf -G "${BASE_URL}/api/v2/libs/search" --data-urlencode "libraryName=${name}")
  [[ -n "$query" ]] && args+=(--data-urlencode "query=${query}")

  local response
  response=$(curl "${args[@]}")

  echo "$response" | jq -r '
    (.results // [])[:10][] |
    "[" + .id + "] " + .title
    + (if .description then "\n  " + .description else "" end)
    + (if .totalSnippets then "\n  Snippets: " + (.totalSnippets | tostring) else "" end)
    + (if .trustScore != null then "  Trust: " + (.trustScore | tostring) else "" end)
    + (if (.versions // [] | length) > 0 then "\n  Versions: " + (.versions | join(", ")) else "" end)
    + "\n"
  '
}

cmd_docs() {
  local library_id="$1" query="$2"
  curl -sf -G "${BASE_URL}/api/v2/context" \
    --data-urlencode "libraryId=${library_id}" \
    --data-urlencode "query=${query}" \
    --data-urlencode "type=txt"
}

case "${1:-}" in
  search) shift; cmd_search "$@" ;;
  docs)   shift; cmd_docs "$@" ;;
  *)
    echo "Usage: context7.sh <command> [args]"
    echo ""
    echo "Commands:"
    echo "  search <library-name> [query]    Search for libraries by name"
    echo "  docs <library-id> <query>        Get documentation for a library"
    exit 1
    ;;
esac
