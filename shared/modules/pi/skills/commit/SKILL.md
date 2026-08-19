---
name: commit
description: Commit with a generated Conventional Commits message, then push. Commits the staged changes; when nothing is staged, commits the whole working tree, untracked files included. Never unstages anything. Use when the user asks to commit, save work, or commit and push. The user's confirmation in the questionnaire is the explicit, single-use git approval for the staging, the commit and the push.
---

# Commit

Generate a [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) message from the changes being committed, confirm it with the user, then commit and push.

> **Scope:** This skill may only run `git add --all`, `git commit` (with the generated message) and `git push`. It must **never** unstage anything - no `git restore --staged`, no `git reset` - and never commits anything it did not show the user first.

> **Approval model:** Git is mutating and normally requires fresh, explicit approval per command. Within this skill, the user's confirmation in the questionnaire **is** that approval - and it covers *only* the staging, this one commit, and the push that immediately follows it. It grants no standing permission for any later git operation.

## Workflow

### 1. Run quality gates (if defined)

Before anything else, check the project's instructions (`AGENTS.md`, `CLAUDE.md`, docs, etc.) for defined quality gates - formatters, linters, type checks, tests, build/check commands, or a dedicated "Quality Gates" section. If any are defined, run them **first**, in the order given.

**If any gate fails, stop and tell the user.** Do not proceed to inspect, confirm, or commit until the gates pass. If no quality gates are defined, skip this step.

### 2. Establish the commit set (read-only)

```bash
git status --short --untracked-files=all   # the whole picture, a new directory listed file by file
git diff --staged                          # what the index holds
git diff HEAD                              # tracked changes, staged and unstaged
git log --oneline --max-count=15           # match the repo's existing type/scope conventions
git branch --show-current
git remote                                 # is there a remote to push to?
```

The index decides what the commit set is:

| Index | Commit set |
|-------|------------|
| Holds something | Exactly the staged changes. A partial staging is a deliberate choice, so never widen it. |
| Empty, working tree dirty | The whole working tree: tracked changes and untracked files, `.gitignore` honored. |
| Empty, working tree clean | Nothing. **Stop and tell the user** there is nothing to commit. |

Read the untracked files that enter the set. Their content is part of the change the message has to describe.

### 3. Generate the message

Follow the format below, basing it **only on the commit set**. The subject carries the change and must stand alone. Most commits need no body at all; add one when there is a *why* the diff cannot show - a constraint, a trade-off, a reason that isn't obvious from the code. Never summarize what the diff already says.

### 4. Confirm via questionnaire

Show the full proposed commit message, then the paths in the commit set with their `git status --short` codes, then a horizontal rule (`---`), then ask with the `questionnaire` tool to confirm with a single `Commit and push` option.

That list is where the user checks the blast radius, so it is never abbreviated. Head it with `Commits:`, or with `Commits (nothing staged, taking the working tree):` when the set is the whole tree. When a file in the set carries unstaged changes on top of its staged ones (`MM`), add a line naming it and saying those changes stay behind - a formatter in step 1 rewriting a staged file produces exactly that.

Any other free-form reply is an instruction: apply it, then regenerate and re-confirm both the message and the list. Narrow a set by staging only the paths the user kept, never by unstaging.

### 5. Commit and push

- Stage first when the set is the whole working tree:

  ```bash
  git add --all
  ```

- Commit with a heredoc so the body and footers keep their formatting:

  ```bash
  git commit -F - <<'EOF'
  <type>(<scope>): <description>

  <body>

  <footers>
  EOF
  ```

- Then push. If the branch has no upstream: `git push --set-upstream origin "$(git branch --show-current)"`; otherwise `git push`.
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

- **Subject:** imperative mood, lowercase, no trailing period, ideally ≤ 50 chars (hard limit 72). e.g. `fix(parser): handle multiple spaces in arrays`.
- **Scope:** optional noun in parentheses naming the affected area, e.g. `feat(api): …`.
- **Body:** skip it when the subject and the diff already say everything. When there is a *why* neither can show, say it as briefly as it can be said - often a sentence or two - and let it run longer only when the reasoning genuinely earns the room. Write it in plain language for someone skimming `git log` in six months, not for a reviewer with the diff open: avoid function, type and identifier names unless the name itself is the point, never turn it into a file-by-file inventory, and reach for bullets only when there really are several independent reasons. One blank line after the subject, wrapped at 72 columns.
- **Footers:** optional, one blank line after the body. Git-trailer style - token uses `-` for spaces, then `: ` or ` #`, e.g. `Reviewed-by: Z`, `Refs: #123`.
- **Breaking changes:** add `!` before the colon (`feat!:` / `feat(api)!:`) and/or a `BREAKING CHANGE: <description>` footer (token must be uppercase). Any type can be breaking.

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

### Body

Too long, and written for a reviewer who already has the diff:

```
refactor(load-context): restructure exclusion lists

Split DEFAULT_EXCLUDES into SECRETS, GENERATED and BULKY_FORMATS.
Add BULKY_FORMAT_TOKEN_LIMIT and move *.svg out of the unconditional
list. Change excluded from string[] to { rel, reason }[] and update
registerMessageRenderer. Apply the size check via statSync in the
candidate loop rather than after readFileSync.
```

Better - the subject carries the change, the body adds only the *why*:

```
refactor(load-context): skip bulky assets by size, not by type

Hand-written icons are worth reading; exported ones are a picture
written in numbers. Size decides now, so small SVGs load again.
```

And longer is right when the reasoning needs the room:

```
refactor(load-context): skip bulky assets by size, not by type

Hand-written icons are worth reading; exported ones are a picture
written in numbers, and one of them can eat a tenth of the context
window on its own.

Size alone couldn't decide it. The largest files here are real source,
so a blanket limit would have dropped those while happily keeping
dozens of tiny icons. The format now decides whether size matters at
all, and only then does the limit apply.
```
