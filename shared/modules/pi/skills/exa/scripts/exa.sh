#!/usr/bin/env bash
set -euo pipefail

: "${EXA_API_KEY:?}"

MCP_URL="https://mcp.exa.ai/mcp?tools=agent_run,web_fetch_exa,web_search_advanced_exa,web_search_exa"
REQUEST_ID=1

SEARCH_TIMEOUT=60
SEARCH_RETRIES=3
AGENT_TIMEOUT=800
AGENT_RETRIES=0

mcp_request() {
  local tool="$1" args="$2" timeout="$3" retries="$4"

  local payload
  payload=$(jq --null-input --compact-output \
    --arg tool "$tool" --argjson args "$args" --argjson id "$REQUEST_ID" \
    '{jsonrpc: "2.0", id: $id, method: "tools/call", params: {name: $tool, arguments: $args}}')

  local response status=0
  response=$(curl \
    --data "$payload" \
    --fail-with-body \
    --header "Accept: application/json, text/event-stream" \
    --header "Content-Type: application/json" \
    --header "x-api-key: $EXA_API_KEY" \
    --max-time "$timeout" \
    --request POST \
    --retry "$retries" \
    --retry-connrefused \
    --show-error \
    --silent \
    "$MCP_URL") || status=$?

  if [ "$status" -ne 0 ]; then
    printf '%s\n' "$response" >&2
    return 1
  fi

  local message
  message=$(printf '%s\n' "$response" \
    | sed --quiet 's/^data: //p' \
    | jq --slurp --compact-output --argjson id "$REQUEST_ID" 'map(select(.id == $id)) | last')

  if [ "$message" = "null" ]; then
    printf 'No JSON-RPC response from %s:\n%s\n' "$tool" "$response" >&2
    return 1
  fi

  if jq --exit-status '.error != null' <<< "$message" > /dev/null; then
    jq --raw-output '.error.message // (.error | tojson)' <<< "$message" >&2
    return 1
  fi

  local text
  text=$(jq --raw-output '[.result.content[]? | select(.type == "text") | .text] | join("\n")' <<< "$message")

  if jq --exit-status '.result.isError == true' <<< "$message" > /dev/null; then
    printf '%s\n' "$text" >&2
    return 1
  fi

  printf '%s\n' "$text"
}

cmd_search() {
  local query="$1" num="${2:-10}"
  mcp_request web_search_exa \
    "$(jq --null-input --arg query "$query" --argjson num "$num" '{query: $query, numResults: $num}')" \
    "$SEARCH_TIMEOUT" "$SEARCH_RETRIES"
}

cmd_search_advanced() {
  mcp_request web_search_advanced_exa "$1" "$SEARCH_TIMEOUT" "$SEARCH_RETRIES"
}

cmd_fetch() {
  local urls="$1" max_chars="${2:-3000}"
  mcp_request web_fetch_exa \
    "$(jq --null-input --argjson urls "$urls" --argjson chars "$max_chars" '{urls: $urls, maxCharacters: $chars}')" \
    "$SEARCH_TIMEOUT" "$SEARCH_RETRIES"
}

cmd_agent() {
  local query="$1" effort="${2:-low}"
  mcp_request agent_run \
    "$(jq --null-input --arg query "$query" --arg effort "$effort" '{query: $query, effort: $effort}')" \
    "$AGENT_TIMEOUT" "$AGENT_RETRIES"
}

cmd_agent_advanced() {
  mcp_request agent_run "$1" "$AGENT_TIMEOUT" "$AGENT_RETRIES"
}

case "${1:-}" in
  search)          shift; cmd_search "$@" ;;
  search-advanced) shift; cmd_search_advanced "$@" ;;
  fetch)           shift; cmd_fetch "$@" ;;
  agent)           shift; cmd_agent "$@" ;;
  agent-advanced)  shift; cmd_agent_advanced "$@" ;;
  *)
    {
      echo "Usage: exa.sh <command> [args]"
      echo ""
      echo "Commands:"
      echo "  search <query> [numResults]"
      echo "  search-advanced '<json params>'"
      echo "  fetch '<[\"url1\",\"url2\"]>' [maxCharacters]"
      echo "  agent <query> [minimal|low|medium|high|xhigh|auto]"
      echo "  agent-advanced '<json params>'"
    } >&2
    exit 1
    ;;
esac
