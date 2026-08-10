# Guidelines

## Context

- **GitHub username**: `roman-16`.
- **Location**: The user is from Austria. Assume the Central European context for locale, timezone (CET/CEST), currency (EUR), metric units, and date formatting (DD.MM.YYYY) unless stated otherwise.

## Rules

- **Git**: NEVER run ANY git command (commit, push, pull, rebase, merge, checkout, add, stash, reset, tag, etc.) without explicit user approval. This applies to EVERY individual git command, even if the user just approved a different git command. Approval is single-use and revoked immediately after the approved command completes. Always ask before each git operation, no exceptions. If the user says "commit and push", that is approval for both. If the user says "commit", that is NOT approval to also push. No skill, workflow, or prior approval pattern grants standing permission - even if the user previously said "commit and push" for a similar change, each new git operation requires fresh explicit approval. The commit skill's "Commit and push" option grants approval for exactly that one commit and one push, not for any subsequent git operations. The same rules apply to mutating `gh` commands (e.g. `gh pr merge`, `gh pr close`, `gh issue close`). Read-only `gh` commands (`gh pr view`, `gh issue view`, `gh api` GET) are allowed.
- **GitHub**: ALWAYS use the `gh` CLI for GitHub operations (repos, issues, PRs, searches, API calls). NEVER use raw git commands for GitHub-specific actions or scrape the web interface.
- **Idempotent changes**: Never apply fixes via one-time local commands (shell exports, manual config, runtime tweaks). Every change must be declarative and self-contained in source files so it works on any machine without manual steps. If that's not possible, come back to the user.
- **Artifacts**: Write scratch and throwaway artifacts (temporary scripts, intermediate outputs, downloads, generated test files) to `/tmp/`, never the working directory or repo.

## Environment

Available on the system:

| Tool | Use |
| --- | --- |
| `bun` | Run JavaScript/TypeScript; manage packages with `bun`. |
| `file` | Identify a file's type and format from its content, independent of its extension. |
| `freeze` | Render code files or terminal output (`--execute "cmd"`) as SVG/PNG/WebP images, with syntax themes, window chrome, and line numbers. |
| `jq` | JSON parsing, filtering, and transformation. |
| `magick` | ImageMagick: image conversion, resizing, cropping, format changes, compositing. |
| `poppler-utils` | PDF text extraction and manipulation (`pdftotext`, `pdfinfo`, `pdfimages`, `pdftoppm`, etc.). |
| `proton-cli` | Unofficial CLI for Proton services (Mail, Drive, Calendar, Pass, Contacts); SRP auth + E2E encryption, acting as the profile signed in with `proton-cli account login`. |
| `python3` | Scripting, data processing, and quick computations. |
| `tesseract` | OCR (extracting text from images and scanned PDFs). |
| `zellij` | Terminal multiplexer; every terminal runs inside a session. Use the CLI to list, attach, or interact with other sessions/panes. |

## Conventions

### Code

- **Ahistorical**: Write code as if it had no history, as if you were writing it for the first time - design the target state as if building it fresh today, and never contort a change to preserve a flawed existing structure. Never reference, explain, or hint at prior states or the fact that something changed. This applies to code, comments, and everything surrounding it: express what *is*, never what *changed* or *used to be*.
- **Comments**: Write NO comments. Not "few" - none. If something needs explaining, rename it, split it, or restructure it until it explains itself; wanting a comment is a signal the code is wrong. Admissible only in the vanishingly rare case where the *why* cannot live in the code at all (an external bug worked around, a constraint imposed from outside the codebase). By default, write nothing.
- **Migrations**: The shipped code assumes the current design only - no compatibility shims, no "old shape" branches, no in-app migration or legacy-tolerance logic. A fresh install starts in the current shape and needs no migration. When data or state that already exists must move to the new shape, do it out-of-band: a one-off transform run once against the affected data (throwaway script in `/tmp/`, idempotent, not committed), or, where such changes recur, a dedicated versioned migration system (ordered migration files). This is the intended exception to Idempotent changes - a one-time transform of existing mutable state is not a reproducible config fix, so it lives outside the source rather than as a permanent runtime shim.
- **Ordering**: When the order of fields, list items, keys, arguments, imports, or similar has no functional or semantic significance, order them alphabetically.

### Shell

- **CLI flags**: ALWAYS use full-length flag names (`--force`, `--recursive`, `--verbose`) instead of short flags (`-f`, `-r`, `-v`) for readability.

### Prose

- **Dashes**: NEVER use em-dashes (—) or en-dashes (–). Use only hyphens (-) when a dash is genuinely needed.
- **Line breaks**: NEVER insert manual line breaks to align text to a hypothetical maximum line width. Let lines flow and wrap naturally; only break where a break is semantically meaningful (new paragraph, list item, etc.).

## Interaction

- **Questionnaire**: PREFER the `questionnaire` tool over a plain-text question whenever the answer is a choice among predefined options (including yes/no): clarifying requirements, settling design trade-offs, or confirming a decision.
