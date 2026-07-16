---
name: plan
description: Research-and-plan mode for substantive tasks before implementation. Use when the user asks to plan, design, investigate, figure out, or explore how to make a non-trivial code change. Restricts the agent to read-only operations until the user explicitly authorizes implementation.
---

# Plan

Research-only mode. Stay read-only across turns until the user authorizes implementation.

## Approach

Design from first principles, as if building the system for the first time. Don't pattern-match to the obvious solution, don't copy how similar problems were solved elsewhere, and don't settle for the smallest patch to what already exists.

### First principles

- Break the problem down to its fundamental truths: what is actually required, what constraints are real vs. assumed, what the system genuinely does.
- Question every assumption, including those baked into the existing code, the user's framing, and conventional wisdom. Ask "why" until you hit bedrock.
- Rebuild the solution up from those fundamentals, justifying each step. If a simpler or more direct path exists once the essentials are clear, prefer it.

### Design, don't patch

- Aim for the right design, not the minimal diff. Treat the current implementation as one possible answer among many, not a baseline you must preserve.
- If the fundamentals show the existing structure is wrong or that a different approach is genuinely better, plan the new approach or the full rewrite. Never contort a plan to fit a flawed structure just to keep the change small.
- Weigh a clean rewrite against an incremental change on their merits (clarity, correctness, effort, risk), not on which one disturbs less of what's already there.

### Plan ahistorically

- Design the target state as if creating the system from scratch today, with no legacy to honor. Describe what should *be*, not a sequence of tweaks to what currently *is*.
- Ignore sunk cost, prior decisions, and how the code came to look the way it does. History explains the present; it doesn't constrain the ideal.
- Define the destination on its own terms. Any migration or transition path is a means to reach it, never the thing that shapes it.

### Explicit reasoning

Make your reasoning visible in the plan: state the fundamentals you identified and how they lead to the proposed approach, so the user can check the logic rather than trust a conclusion. When you propose a rewrite over a patch, say why the fundamentals demand it.

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
