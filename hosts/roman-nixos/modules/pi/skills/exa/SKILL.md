---
name: exa
description: Web research using Exa search via scripts. Provides web search, advanced filtered search, code context lookup, and URL content extraction. Use when researching topics, finding documentation, looking up code examples, or extracting webpage content. No API key required.
---

# Exa

Web research via the free Exa MCP endpoint. All commands go through `scripts/exa.sh`. No API key required.

**Concurrency**: Multiple parallel calls are safe — the script serializes them automatically via a file lock so only one request hits the API at a time. Others queue up and execute in order. **Set timeout to 60 seconds** on all exa bash calls since queued requests may wait for earlier ones to finish.

## Commands

### Search

General web search for any topic.

```bash
./scripts/exa.sh search "NixOS flake best practices 2025"
./scripts/exa.sh search "home-manager modules" 15
```

### Advanced Search

Full filter control: categories, date ranges, domains, highlights, summaries.

```bash
./scripts/exa.sh search-advanced '{"query": "transformer attention efficiency", "category": "research paper", "startPublishedDate": "2024-01-01", "numResults": 15}'
```

**Parameters:**
- `query` (required) — search query
- `numResults` — 1-100 (default: 10)
- `type` — `auto` (default), `fast`, `neural`
- `category` — `company`, `research paper`, `news`, `pdf`, `github`, `personal site`, `people`, `financial report`
- `includeDomains` / `excludeDomains` — domain filters
- `startPublishedDate` / `endPublishedDate` — ISO 8601 date filters
- `startCrawlDate` / `endCrawlDate` — crawl date filters
- `includeText` / `excludeText` — text filters (**single-item arrays only**)
- `additionalQueries` — query variations for broader coverage
- `enableSummary` / `summaryQuery` — generate summaries
- `enableHighlights` / `highlightsQuery` / `highlightsNumSentences` / `highlightsPerUrl`
- `subpages` / `subpageTarget` — crawl subpages (1-10)
- `textMaxCharacters` / `contextMaxCharacters`

**Category filter restrictions:**
- `company`: no domain or date filters
- `people`: no date/text/excludeDomains filters, only LinkedIn for includeDomains

**More examples:**

```bash
# News with domain filter
./scripts/exa.sh search-advanced '{"query": "NixOS release", "category": "news", "includeDomains": ["nixos.org"], "numResults": 10}'

# GitHub repos
./scripts/exa.sh search-advanced '{"query": "home-manager flake modules", "category": "github", "numResults": 10}'

# With summaries and highlights
./scripts/exa.sh search-advanced '{"query": "Rust async runtime", "category": "personal site", "enableSummary": true, "enableHighlights": true, "numResults": 10}'
```

### Code Context

Find code examples, API docs, library usage from GitHub, Stack Overflow, and docs.

```bash
./scripts/exa.sh code-context "Nix builtins.readDir filter by file type"
./scripts/exa.sh code-context "React useState hook examples" 12
```

Query tips: include the programming language/framework and be specific.

### Crawl

Extract full page content from known URLs. Supports batching.

```bash
./scripts/exa.sh crawl '["https://nixos.wiki/wiki/Flakes"]'
./scripts/exa.sh crawl '["https://example.com", "https://example.org"]' 5000
```

## Research Workflow

1. Start with `search` or `search-advanced` for discovery
2. Use `code-context` for programming-specific queries
3. Follow up with `crawl` on promising URLs for full content
4. Use `additionalQueries` or multiple searches with varied phrasing for coverage
