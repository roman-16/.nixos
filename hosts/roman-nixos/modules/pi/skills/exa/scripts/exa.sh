#!/usr/bin/env bash
# Exa search via the free hosted MCP endpoint — no API key required
set -euo pipefail

MCP_URL="https://mcp.exa.ai/mcp?tools=web_search_exa,web_search_advanced_exa,get_code_context_exa,crawling_exa"

mcp_call() {
  local tool="$1" args="$2"
  local response
  response=$(curl -s -X POST "$MCP_URL" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "$(node -e "
      console.log(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: process.argv[1], arguments: JSON.parse(process.argv[2]) }
      }))
    " "$tool" "$args")")

  # Parse SSE response: extract data line, then result content text
  echo "$response" | sed -n 's/^data: //p' | node -e "
    let d = '';
    process.stdin.on('data', c => d += c);
    process.stdin.on('end', () => {
      try {
        const r = JSON.parse(d);
        if (r.error) { console.error(JSON.stringify(r.error)); process.exit(1); }
        const texts = (r.result?.content || []).filter(c => c.type === 'text').map(c => c.text);
        console.log(texts.join('\n'));
      } catch(e) { console.error('Parse error:', e.message); process.exit(1); }
    });
  "
}

cmd_search() {
  local query="$1" num="${2:-8}"
  mcp_call "web_search_exa" "$(node -e "
    console.log(JSON.stringify({ query: process.argv[1], numResults: Number(process.argv[2]) }))
  " "$query" "$num")"
}

cmd_search_advanced() {
  # Takes a JSON string with all parameters, passed directly to web_search_advanced_exa
  mcp_call "web_search_advanced_exa" "$1"
}

cmd_code_context() {
  local query="$1" num="${2:-8}"
  mcp_call "get_code_context_exa" "$(node -e "
    console.log(JSON.stringify({ query: process.argv[1], numResults: Number(process.argv[2]) }))
  " "$query" "$num")"
}

cmd_crawl() {
  local urls_json="$1" max_chars="${2:-3000}"
  mcp_call "crawling_exa" "$(node -e "
    console.log(JSON.stringify({ urls: JSON.parse(process.argv[1]), maxCharacters: Number(process.argv[2]) }))
  " "$urls_json" "$max_chars")"
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
