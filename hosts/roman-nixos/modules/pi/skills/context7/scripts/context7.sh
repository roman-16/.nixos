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

  # Parse JSON with node — available on NixOS, no extra deps
  echo "$response" | node -e "
    let d = '';
    process.stdin.on('data', c => d += c);
    process.stdin.on('end', () => {
      const { results = [] } = JSON.parse(d);
      results.slice(0, 10).forEach(r => {
        let out = '[' + r.id + '] ' + r.title;
        if (r.description) out += '\n  ' + r.description;
        if (r.totalSnippets) out += '\n  Snippets: ' + r.totalSnippets;
        if (r.trustScore != null) out += '  Trust: ' + r.trustScore;
        if (r.versions?.length) out += '\n  Versions: ' + r.versions.join(', ');
        console.log(out + '\n');
      });
    });
  "
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
