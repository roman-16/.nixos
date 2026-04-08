# User Guidelines

## Tools

- **GitHub**: ALWAYS use the `gh` CLI for GitHub operations (repos, issues, PRs, searches, API calls). NEVER use raw git commands for GitHub-specific actions or scrape the web interface.
- **Git**: NEVER run ANY git command (commit, push, pull, rebase, merge, checkout, add, stash, reset, tag, etc.) without explicit user approval. This applies to EVERY individual git command — even if the user just approved a different git command. Approval is single-use and revoked immediately after the approved command completes. Always ask before each git operation, no exceptions. If the user says "commit and push", that is approval for both. If the user says "commit", that is NOT approval to also push. The same rules apply to mutating `gh` commands (e.g. `gh pr merge`, `gh pr close`, `gh issue close`). Read-only `gh` commands (`gh pr view`, `gh issue view`, `gh api` GET) are allowed.
- **Idempotent changes**: Never apply fixes via one-time local commands (shell exports, manual config, runtime tweaks). Every change must be declarative and self-contained in source files so it works on any machine without manual steps. If that's not possible, come back to the user.
- **poppler-utils**: Available on the system (pdftotext, pdfinfo, pdfimages, pdftoppm, etc.). Use for PDF text extraction and manipulation.
