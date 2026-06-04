# User Guidelines

## Tools

- **GitHub**: ALWAYS use the `gh` CLI for GitHub operations (repos, issues, PRs, searches, API calls). NEVER use raw git commands for GitHub-specific actions or scrape the web interface.
- **Git**: NEVER run ANY git command (commit, push, pull, rebase, merge, checkout, add, stash, reset, tag, etc.) without explicit user approval. This applies to EVERY individual git command — even if the user just approved a different git command. Approval is single-use and revoked immediately after the approved command completes. Always ask before each git operation, no exceptions. If the user says "commit and push", that is approval for both. If the user says "commit", that is NOT approval to also push. No skill, workflow, or prior approval pattern grants standing permission — even if the user previously said "commit and push" for a similar change, each new git operation requires fresh explicit approval. The commit skill's "Commit and push" option grants approval for exactly that one commit and one push, not for any subsequent git operations. The same rules apply to mutating `gh` commands (e.g. `gh pr merge`, `gh pr close`, `gh issue close`). Read-only `gh` commands (`gh pr view`, `gh issue view`, `gh api` GET) are allowed.
- **Idempotent changes**: Never apply fixes via one-time local commands (shell exports, manual config, runtime tweaks). Every change must be declarative and self-contained in source files so it works on any machine without manual steps. If that's not possible, come back to the user.
- **poppler-utils**: Available on the system (pdftotext, pdfinfo, pdfimages, pdftoppm, etc.). Use for PDF text extraction and manipulation.
- **tesseract**: Available on the system. Use for OCR (extracting text from images and scanned PDFs).
- **magick**: ImageMagick CLI available on the system. Use for image conversion, resizing, cropping, format changes, compositing, and other image manipulation.
- **proton-cli**: Available on the system. Unofficial CLI for Proton services (Mail, Drive, Calendar, Pass, Contacts). Handles SRP auth and E2E encryption. Use for reading/sending mail, browsing Drive, managing Calendar/Contacts, and accessing Pass entries. Supports `--output json/yaml` for scripting.
- **python3**: Available on the system. Use for scripting, data processing, and quick computations.
- **jq**: Available on the system. Use for JSON parsing, filtering, and transformation.
- **zellij**: Available on the system. Every terminal runs inside a zellij session. Use `zellij` CLI to list, attach, or interact with other terminal sessions/panes.
- **CLI flags**: ALWAYS use full-length flag names (`--force`, `--recursive`, `--verbose`) instead of short flags (`-f`, `-r`, `-v`) for readability.

## Code

- **Comments**: Only add a comment when it's needed, and only to explain *why* (non-obvious decisions, workarounds, gotchas) — never to restate *what* the code already says.
