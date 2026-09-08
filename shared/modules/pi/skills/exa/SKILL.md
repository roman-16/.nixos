---
name: exa
description: Web research via Exa - web search, filtered search, page fetch, and multi-step agent runs that research, build lists or enrich data with citations. Use when researching topics, finding documentation, looking up code examples, or extracting webpage content.
---

# Exa

Web research via the Exa MCP endpoint. All commands go through `{baseDir}/scripts/exa.sh`, which authenticates with `EXA_API_KEY` from the environment.

Every call is billed to the account: $7 per 1k searches, $1 per 1k fetched pages, and per-run pricing for `agent` (see below).

## Commands

### Search

General web search for any topic.

```bash
{baseDir}/scripts/exa.sh search "NixOS flake best practices 2025"
{baseDir}/scripts/exa.sh search "home-manager modules" 15
```

- Describe the ideal page instead of listing keywords: `"blog post comparing React and Vue performance"`, not `"React vs Vue"`.
- For code, name the language or framework: `"Nix language: builtins.readDir example filtering entries by file type"`.
- Prefix `category:people` or `category:company` to search LinkedIn profiles or companies: `"category:people John Doe software engineer"`.
- `numResults` defaults to 10.

### Advanced Search

Full filter control: categories, date ranges, domains, highlights, summaries.

```bash
{baseDir}/scripts/exa.sh search-advanced '{"query": "transformer attention efficiency", "category": "publication", "startPublishedDate": "2024-01-01", "numResults": 15}'
```

**Parameters:**
- `query` (required) - question, statement or keywords
- `numResults` - 1-100 (default: 10)
- `type` - `auto` (default, works with all filters), `fast`, `instant`
- `category` - `company`, `publication`, `news`, `pdf`, `github`, `personal site`, `people`, `financial report`
- `includeDomains` / `excludeDomains` - domain filters
- `startPublishedDate` / `endPublishedDate` - ISO 8601 date filters
- `startCrawlDate` / `endCrawlDate` - crawl date filters
- `includeText` - results containing ALL of these strings (**single-item arrays only**)
- `excludeText` - results containing ANY of these strings (**single-item arrays only**)
- `userLocation` - ISO country code for geo-targeted results, e.g. `AT`, `DE`, `US`
- `moderation` - filter out unsafe content
- `additionalQueries` - query variations for broader coverage
- `enableSummary` / `summaryQuery` - generate summaries
- `enableHighlights` / `highlightsQuery` / `highlightsMaxCharacters` - highlight extraction
- `subpages` / `subpageTarget` - crawl subpages (1-10)
- `textMaxCharacters` / `contextMaxCharacters`
- `maxAgeHours` - max age of cached content (`0` always fetches fresh) / `livecrawlTimeout` - ms budget for that fresh fetch

**Category filter restrictions:**
- `company`: no domain or date filters
- `people`: no date/text/excludeDomains filters, only LinkedIn for includeDomains

**More examples:**

```bash
# News with domain filter
{baseDir}/scripts/exa.sh search-advanced '{"query": "NixOS release", "category": "news", "includeDomains": ["nixos.org"], "numResults": 10}'

# GitHub repos
{baseDir}/scripts/exa.sh search-advanced '{"query": "home-manager flake modules", "category": "github", "numResults": 10}'

# With summaries and highlights
{baseDir}/scripts/exa.sh search-advanced '{"query": "Rust async runtime", "category": "personal site", "enableSummary": true, "enableHighlights": true, "numResults": 10}'
```

### Fetch

Extract full page content from known URLs. Batch multiple URLs into one call.

```bash
{baseDir}/scripts/exa.sh fetch '["https://nixos.wiki/wiki/Flakes"]'
{baseDir}/scripts/exa.sh fetch '["https://example.com", "https://example.org"]' 5000
```

### Agent

A single objective the Exa Agent researches on its own across many searches and fetches, returning an answer with citations, or structured records for list-building and data enrichment. Output is JSON: `id`, `status`, `output.text`, `output.grounding` (citations), `output.structured`, `usage` and `costDollars`.

```bash
{baseDir}/scripts/exa.sh agent "Which Austrian ISPs offer symmetric gigabit fiber, with monthly price?" medium
{baseDir}/scripts/exa.sh agent-advanced '{"query": "...", "effort": "medium", "outputSchema": {"type": "object", "properties": {"isps": {"type": "array", "items": {"type": "object", "properties": {"name": {"type": "string"}, "monthlyEur": {"type": "number"}, "source": {"type": "string"}}}}}}}'
```

Use it only when one search cannot answer the question: it costs per run and takes minutes.

| Effort | Cost |
| --- | --- |
| `minimal` | $0.012 |
| `low` (default) | $0.025 |
| `medium` | $0.10 |
| `high` | $0.50 |
| `xhigh` | $1.00 |
| `auto` | metered, up to $5 |

Leave effort at `low`; go above `medium` only when the user asked for that depth.

**Set the bash timeout to 900 seconds** on `agent` calls. A run that outlives the call window comes back as `"status": "running"` with its `id` - resume it, never start a duplicate:

```bash
{baseDir}/scripts/exa.sh agent-advanced '{"runId": "agent_run_..."}'
```

Killing the call does not cancel the run, and the run is billed either way.

**`agent-advanced` parameters:** `query` or `runId` (never both), `effort`, `systemPrompt`, `outputSchema`, `input`, `dataSources`, `previousRunId` (a completed run to use as context for a new one).

## Research Workflow

1. Start with `search` or `search-advanced` for discovery
2. Follow up with `fetch` on promising URLs for full content
3. Use `additionalQueries` or multiple searches with varied phrasing for coverage
4. Reach for `agent` when the question needs many steps chained together, or a structured list built from the whole web

`{baseDir}` = this skill's directory. Always resolve to the absolute path before executing.
