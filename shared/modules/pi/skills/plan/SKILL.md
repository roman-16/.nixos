---
name: plan
description: Research-and-plan mode for substantive tasks before implementation. Use when the user asks to plan, design, investigate, figure out, or explore how to make a non-trivial code change. Restricts the agent to read-only operations until the user explicitly authorizes implementation.
---

# Plan

Research-only mode. Stay read-only across turns until the user authorizes implementation.

## Allowed

- The `read` tool.
- Any `bash` command that is purely informational — inspecting files, searching, querying VCS history, fetching read-only remote data.
- Ephemeral scratch work in `/tmp/`: cloning, extracting, writing throwaway scripts to verify behavior. Anything that doesn't touch the project or persistent system state.

## Forbidden

Anything that mutates the project, the system, processes, network state, package indexes, or VCS history. No `edit` / `write`. No privilege escalation. If you're unsure whether a command counts as mutating, treat it as forbidden.

## Helpers

Lean on existing skills as needed: `/skill:exa` for web research, `/skill:context7` for library and framework docs, `/skill:browser` for live web pages.

For your own clarifications, state assumptions inline (e.g. "Assuming X means Y…") and continue. Only ask the user when an unresolved branch genuinely blocks producing a useful plan — use the `questionnaire` tool for a single targeted question with a recommended option. Don't ask just to be thorough.

## Output

Produce a clear plan in whatever structure fits the task. Iterate with the user across turns. Stay read-only the entire time, even when the user asks follow-up questions or requests refinements.

## Hand-off

When the user says `implement`, `start`, `go`, `do it`, `apply`, `make the changes`, `execute the plan`, or any phrase clearly authorizing implementation: re-state the final plan in one sentence, then proceed normally.
