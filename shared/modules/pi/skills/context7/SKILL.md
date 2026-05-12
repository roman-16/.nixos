---
name: context7
description: Fetch up-to-date library documentation and code examples via Context7 API. Use when you need current docs for any library/framework, to verify APIs exist, or to get version-specific code examples. No API key required.
---

# Context7

Fetch up-to-date, version-specific library documentation via the Context7 REST API. All commands go through `{baseDir}/scripts/context7.sh`. No API key required.

## Commands

### Search

Find libraries by name. Returns Context7 library IDs needed for `docs`.

```bash
{baseDir}/scripts/context7.sh search "react"
{baseDir}/scripts/context7.sh search "nextjs" "app router middleware"
```

The optional query parameter ranks results by relevance to your task.

### Docs

Retrieve documentation for a specific library. Requires a Context7 library ID from `search`.

```bash
{baseDir}/scripts/context7.sh docs "/reactjs/react.dev" "useState hook"
{baseDir}/scripts/context7.sh docs "/vercel/next.js" "how to implement middleware"
{baseDir}/scripts/context7.sh docs "/nixos/nixpkgs" "mkDerivation"
```

## Workflow

1. **Search** for the library: `{baseDir}/scripts/context7.sh search "library-name" "your question"`
2. Pick the best matching library ID from results (e.g., `/facebook/react`)
3. **Fetch docs**: `{baseDir}/scripts/context7.sh docs "/facebook/react" "your specific question"`

If you already know the library ID (slash format like `/owner/repo`), skip straight to step 3.

## Tips

- Be specific with queries — "how to implement authentication with middleware" beats "auth"
- Include version in query if needed — "Next.js 14 app router" will match the right version
- Library IDs use slash format: `/owner/repo` (e.g., `/vercel/next.js`, `/facebook/react`)

`{baseDir}` = this skill's directory. Always resolve to the absolute path before executing.
