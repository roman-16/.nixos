---
name: read-only
description: Read-only mode - read, search, query and verify things in /tmp/, while nothing outside it changes until the user explicitly authorizes the change. Use when the user asks to investigate, review, audit, explain, compare, or figure something out without touching it, when they say to look but not change anything, and whenever a skill or task needs a no-mutation boundary that holds across turns. Names what is allowed, what is forbidden, what to do when the work needs a change, and the only thing that lifts the boundary.
---

# Read-only

Nothing changes while this holds: not the project, not the system, not the remote. It holds across every turn - answers, follow-up questions, corrections, refinements - and neither the time spent inside it nor your confidence about what should happen lifts it. Only the user does, explicitly.

## The boundary

Allowed:

- The `read` tool.
- Any `bash` command that is purely informational - inspecting files, searching, querying VCS history, fetching read-only remote data.
- Ephemeral scratch work in `/tmp/`: cloning, extracting, writing throwaway scripts to verify behavior. Anything that doesn't touch the project or persistent system state.

Forbidden: anything that mutates the project, the system, processes, network state, package indexes, or VCS history. No `edit` / `write`. No privilege escalation. If you're unsure whether a command counts as mutating, treat it as forbidden.

A tool that reads by default but writes under a flag counts by what you actually invoke, and a command whose effect you cannot predict counts as mutating. Check it in `/tmp/` against a copy, or leave it.

## When the work needs a change

The boundary is not an obstacle to route around. When something cannot be established without mutating - a build that must run, a dependency that must be installed, a file that must be moved - say so, name the exact command and what it would change, and let the user decide. Never do it once "just to check", and never leave the need unmentioned and the question half-answered.

The same holds for what you find. Something wrong, stale, or dangerous in the code is reported, never repaired: describe it and what fixing it would take, and let the user call it.

## What lifts it

Only an explicit authorization from the user: `implement`, `start`, `go`, `do it`, `apply`, `make the changes`, `execute the plan`, or any phrase clearly authorizing the change. It then covers that work, not standing permission for everything after it - and it never covers what the project's own rules gate separately, git and other approval-bound operations included.

These are not authorization:

- A question about the change, however detailed.
- A refinement, a correction, or a choice among options - those settle what the change should be, not that it happens now.
- Approval of the reasoning: "looks right", "makes sense", "exactly".
- Silence, or the absence of an objection.

When a reply reads like a go but could be a comment, ask - one question, no work started.
