---
name: commit
description: Commit the already-staged changes with a generated Conventional Commits message, then push. Use when the user asks to commit, save staged work, or commit and push. Never stages or unstages anything; if nothing is staged it stops and says so. The user's confirmation in the questionnaire is the explicit, single-use git approval for the commit and the push.
---

# Commit

Generate a [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) message from the
**staged** changes, confirm it with the user, then commit and push.

> **Scope:** This skill may only run `git commit` (with the generated message) and `git push`. It
> must **never** stage or unstage anything — no `git add`, no `git restore --staged`, no `git reset`.
> It commits exactly what is already staged.

> **Approval model:** Git is mutating and normally requires fresh, explicit approval per command.
> Within this skill, the user's confirmation in the questionnaire **is** that approval — and it
> covers *only* this one commit and the push that immediately follows it. It grants no standing
> permission for any later git operation.

## Workflow

### 1. Inspect the staged changes (read-only)

```bash
git diff --staged          # the changes to be committed — base the message on these
git status --short         # confirm what is staged vs unstaged
git log --oneline -15      # match the repo's existing type/scope conventions
git branch --show-current
git remote                 # is there a remote to push to?
```

**If nothing is staged, stop and tell the user** there is nothing staged to commit. Do not stage
anything yourself.

### 2. Generate the message

Follow the format below, basing it **only on the staged diff**. The subject must capture the essence
of the change; the body explains *why* when it isn't obvious. Cover all the staged changes.

### 3. Confirm via questionnaire

Show the full proposed commit message, then a horizontal rule (`---`), then ask with the
`questionnaire` tool to confirm with a single `Commit and push` option.

Any other free-form reply is an instruction: apply it and regenerate/re-confirm the message.

### 4. Commit and push

- Commit with a heredoc so the body and footers keep their formatting:

  ```bash
  git commit -F - <<'EOF'
  <type>(<scope>): <description>

  <body>

  <footers>
  EOF
  ```

- Then push. If the branch has no upstream:
  `git push --set-upstream origin "$(git branch --show-current)"`; otherwise `git push`.
- Always use full-length flags (`--set-upstream`, not `-u`).

## Conventional Commits format

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

### Types

| Type       | Use for                                                        |
|------------|----------------------------------------------------------------|
| `feat`     | A new feature (SemVer MINOR)                                    |
| `fix`      | A bug fix (SemVer PATCH)                                        |
| `docs`     | Documentation only                                             |
| `style`    | Formatting/whitespace, no behavior change                      |
| `refactor` | Code change that neither fixes a bug nor adds a feature        |
| `perf`     | Performance improvement                                        |
| `test`     | Adding or correcting tests                                     |
| `build`    | Build system or dependencies                                   |
| `ci`       | CI configuration and scripts                                   |
| `chore`    | Maintenance, tooling, no production code change                |
| `revert`   | Reverts a previous commit                                      |

### Rules

- **Subject:** imperative mood, lowercase, no trailing period, ideally ≤ 50 chars (hard limit 72).
  e.g. `fix(parser): handle multiple spaces in arrays`.
- **Scope:** optional noun in parentheses naming the affected area, e.g. `feat(api): …`.
- **Body:** optional, one blank line after the subject. Explain *what* and *why*, not *how*. Wrap
  around 72 columns. Free-form paragraphs.
- **Footers:** optional, one blank line after the body. Git-trailer style — token uses `-` for
  spaces, then `: ` or ` #`, e.g. `Reviewed-by: Z`, `Refs: #123`.
- **Breaking changes:** add `!` before the colon (`feat!:` / `feat(api)!:`) and/or a
  `BREAKING CHANGE: <description>` footer (token must be uppercase). Any type can be breaking.

### Examples

```
docs: correct spelling of CHANGELOG
```

```
feat(lang): add Polish language
```

```
fix: prevent racing of requests

Introduce a request id and a reference to latest request. Dismiss
incoming responses other than from latest request.

Refs: #123
```

```
feat(api)!: send confirmation email when a product is shipped

BREAKING CHANGE: the shipment endpoint now requires a customer email.
```

```
revert: let us never again speak of the noodle incident

Refs: 676104e, a215868
```
