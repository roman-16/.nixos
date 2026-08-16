---
name: plan
description: Research-and-plan mode for substantive tasks before implementation. Use when the user asks to plan, design, investigate, figure out, or explore how to make a non-trivial code change. Restricts the agent to read-only operations until the user explicitly authorizes implementation. Every plan opens with the before and after that the project's users will feel.
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
- Any `bash` command that is purely informational - inspecting files, searching, querying VCS history, fetching read-only remote data.
- Ephemeral scratch work in `/tmp/`: cloning, extracting, writing throwaway scripts to verify behavior. Anything that doesn't touch the project or persistent system state.

## Forbidden

Anything that mutates the project, the system, processes, network state, package indexes, or VCS history. No `edit` / `write`. No privilege escalation. If you're unsure whether a command counts as mutating, treat it as forbidden.

## Helpers

Lean on existing skills as needed: `/skill:exa` for web research, `/skill:context7` for library and framework docs, `/skill:browser` for live web pages.

For your own clarifications, state assumptions inline (e.g. "Assuming X means Y…") and continue. Only ask the user when an unresolved branch genuinely blocks producing a useful plan - use the `questionnaire` tool for a single targeted question with a recommended option. Don't ask just to be thorough.

## Output

Produce a clear plan in whatever structure fits the task. Iterate with the user across turns. Stay read-only the entire time, even when the user asks follow-up questions or requests refinements.

### Lead with what the user will see

The plan asks for a product decision, so it has to be answerable without reading code. It opens with **What changes for the user**: what they do and see today, and what they do and see once this is built. Each proposed change then leads with its effect on that surface before any mechanism. The section stands alone - no file names, no symbols, no internal vocabulary.

**Name the surface first.** Who the user is, and what they touch, depends on what the thing is:

| The thing is | The surface is |
| --- | --- |
| A bot or assistant | Messages sent and received, and what it does unprompted |
| A CLI | Commands typed, flags, prompts, printed output, exit codes, `--help` |
| A library | Calls, signatures, semantics, errors |
| A service or API | Requests, responses, status codes, errors |
| A system or config module | Commands and aliases available, what runs on boot, files it manages, manual steps it demands |
| A web app or dashboard | Screens, controls, what is on them, what a click does |
| An agent skill or extension | What the user asks for, what the agent does with it, what comes back |

Two audiences mean two surfaces, and both get shown.

**Show it, don't describe it.** Render the surface in its own medium - a console transcript, a message, a screen - labelled before and after, close enough together to compare. A sentence about "improved feedback" is not a before/after.

**Before**

```console
$ proton-cli drive trash empty
Emptied the trash.
```

**After**

```console
$ proton-cli drive trash empty
This permanently deletes 24 items. Nothing can be restored afterwards.
Continue? [y/N]
```

**There is always a before.** For something that does not exist yet it is the workaround in use today, or plainly "no way to do this today" - that absence is what makes the after worth judging.

**Nothing changing is an answer.** When no surface element moves, say exactly that and say what is gained instead: *"Same commands, same output. The daily backup stops failing, so the 04:00 alert stops."* Never pad the section with internal work to fill it.

**Name what it costs.** In one line each: what the user must do once (reinstall, move a file, update a script, redeploy a host), and what they type today that will stop working or behave differently.

**Show options as surfaces.** When the plan offers alternatives, give each one its own before/after, because the choice is made on the surface, not on the implementation.

**Keep it true.** Take the before from the thing itself - `--help`, the strings in the source, golden files, docs, a screenshot, a read-only run - never from memory or plausibility, and never by running anything that mutates. Mark whatever could not be verified.

**Keep it complete.** Every surface element that moves gets its own rendered before/after, however long that makes the plan - never a summary in place of a transcript, never "and similar for the other commands". The limit is the number of elements that actually move, not the length of the section. When many move, a one-line list up front helps orientation, but it never replaces the transcripts below it. When the plan changes across turns, update this section with it: it is the part that gets re-read.

## Hand-off

When the user says `implement`, `start`, `go`, `do it`, `apply`, `make the changes`, `execute the plan`, or any phrase clearly authorizing implementation: re-state in one sentence what the user will be able to do differently once it is done, then proceed normally.
