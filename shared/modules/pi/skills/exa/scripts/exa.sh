#!/usr/bin/env bash
# Exa search via the free hosted MCP endpoint — no API key required
set -euo pipefail

MCP_URL="https://mcp.exa.ai/mcp?tools=web_search_exa,web_search_advanced_exa,get_code_context_exa,crawling_exa"
LOCK_DIR="/tmp/exa-rate-limit"
MAX_RETRIES=3
RETRY_DELAY=3

# Serialize concurrent calls — only one request hits the API at a time
acquire_lock() {
  mkdir -p "$LOCK_DIR"
  local lock_file="$LOCK_DIR/lock"
  local wait_time=0
  while ! (set -C; echo $$ > "$lock_file") 2>/dev/null; do
    sleep 0.5
    wait_time=$((wait_time + 1))
    if [ $wait_time -ge 120 ]; then
      echo "Timed out waiting for rate-limit lock" >&2
      rm -f "$lock_file"
      return 1
    fi
  done
}

release_lock() {
  rm -f "$LOCK_DIR/lock"
}

# Ensure lock is released on exit/error
cleanup() { release_lock; }
trap cleanup EXIT

mcp_call() {
  local tool="$1" args="$2"
  local attempt=0

  while [ $attempt -lt $MAX_RETRIES ]; do
    acquire_lock

    local response
    response=$(curl -s -w '\n__HTTP_CODE__%{http_code}' -X POST "$MCP_URL" \
      -H "Content-Type: application/json" \
      -H "Accept: application/json, text/event-stream" \
      --max-time 30 \
      -d "$(jq -n --arg tool "$tool" --argjson args "$args" \
        '{jsonrpc: "2.0", id: 1, method: "tools/call", params: {name: $tool, arguments: $args}}')")

    release_lock

    local http_code
    http_code=$(echo "$response" | grep '__HTTP_CODE__' | sed 's/.*__HTTP_CODE__//')
    response=$(echo "$response" | grep -v '__HTTP_CODE__')

    # Retry on rate limit (429) or server errors (5xx)
    if [[ "$http_code" =~ ^(429|5[0-9][0-9])$ ]]; then
      attempt=$((attempt + 1))
      if [ $attempt -lt $MAX_RETRIES ]; then
        local delay=$((RETRY_DELAY * attempt))
        echo "Rate limited (HTTP $http_code), retrying in ${delay}s (attempt $((attempt+1))/$MAX_RETRIES)..." >&2
        sleep $delay
        continue
      else
        echo "Failed after $MAX_RETRIES attempts (HTTP $http_code)" >&2
        return 1
      fi
    fi

    # Parse SSE response: extract data line, then result content text
    local parsed
    parsed=$(echo "$response" | sed -n 's/^data: //p')

    if echo "$parsed" | jq -e 'has("error") and .error != null' > /dev/null 2>&1; then
      echo "$parsed" | jq -r '.error' >&2
      return 1
    fi

    echo "$parsed" | jq -r '[.result.content[]? | select(.type == "text") | .text] | join("\n")'
    return $?
  done
}

cmd_search() {
  local query="$1" num="${2:-8}"
  mcp_call "web_search_exa" "$(jq -n --arg q "$query" --argjson n "$num" '{query: $q, numResults: $n}')"
}

cmd_search_advanced() {
  mcp_call "web_search_advanced_exa" "$1"
}

cmd_code_context() {
  local query="$1" num="${2:-8}"
  mcp_call "get_code_context_exa" "$(jq -n --arg q "$query" --argjson n "$num" '{query: $q, numResults: $n}')"
}

cmd_crawl() {
  local urls_json="$1" max_chars="${2:-3000}"
  mcp_call "crawling_exa" "$(jq -n --argjson urls "$urls_json" --argjson chars "$max_chars" '{urls: $urls, maxCharacters: $chars}')"
}

case "${1:-}" in
  search)          shift; cmd_search "$@" ;;
  search-advanced) shift; cmd_search_advanced "$@" ;;
  code-context)    shift; cmd_code_context "$@" ;;
  crawl)           shift; cmd_crawl "$@" ;;
  *)
    echo "Usage: exa.sh <command> [args]"
    echo ""
    echo "Commands:"
    echo "  search <query> [numResults]"
    echo "  search-advanced '<json params>'"
    echo "  code-context <query> [numResults]"
    echo "  crawl '<[\"url1\",\"url2\"]>' [maxCharacters]"
    exit 1
    ;;
esac
