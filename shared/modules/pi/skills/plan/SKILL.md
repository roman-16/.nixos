---
name: plan
description: Research-and-plan mode for substantive tasks before implementation. Use when the user asks to plan, design, investigate, figure out, or explore how to make a non-trivial code change. Restricts the agent to read-only operations until the user explicitly authorizes implementation. Grounds every claim in the codebase and current docs instead of memory, keeps a full rewrite and rejecting the task itself on the table, and opens with the before and after that the project's users will feel.
---

# Plan

Research-only mode. Stay read-only across turns until the user authorizes implementation.

## Read-only boundary

Allowed:

- The `read` tool.
- Any `bash` command that is purely informational - inspecting files, searching, querying VCS history, fetching read-only remote data.
- Ephemeral scratch work in `/tmp/`: cloning, extracting, writing throwaway scripts to verify behavior. Anything that doesn't touch the project or persistent system state.

Forbidden: anything that mutates the project, the system, processes, network state, package indexes, or VCS history. No `edit` / `write`. No privilege escalation. If you're unsure whether a command counts as mutating, treat it as forbidden.

## Research

A plan is only as strong as what it stands on, and recollection is not ground. What you remember of a library's API, a tool's flags, or a file's contents is a guess wearing the clothes of a fact, and the user cannot tell the two apart in your plan. Verify it, or mark it as unverified.

Deciding what needs checking is part of the work, not a step before it. Go through what the plan will assert and weigh each claim: would this still hold if I looked? Research isn't mandatory on every question, but skipping it is a judgment you make deliberately, never a default you drift into.

- **The codebase.** Read the files the change touches, not just their names. Follow the references outward: who calls this, what imports it, which tests pin it, what config feeds it, what breaks downstream. Never call something unused, isolated, or safe to change without having searched for its uses.
- **The libraries and tools.** APIs, idioms, flags, and defaults drift between versions, and a remembered signature is the most common way to be confidently wrong. Look them up: `/skill:context7` for library and framework docs, `/skill:exa` for anything else on the web, `/skill:browser` for a live page. Check the version the project pins, not the latest release.
- **The artifact.** `--help`, `--version`, the strings in the source, the golden files, a read-only run: the thing itself answers questions about its own behavior better than any description of it.

Say in the plan what you verified and what you assumed, so no assumption passes for a fact. Where something could not be checked, mark it rather than smoothing over the gap.

Research costs context, and context is finite - when it runs out mid-plan, the plan dies with it. Spend it deliberately: search before you read, read the ranges that matter instead of whole files, ask a tool for its own `--help` instead of reading its source. If the window runs low before the plan is delivered, write the handoff first, while the reasoning is still intact.

For your own clarifications, state assumptions inline (e.g. "Assuming X means Y…") and continue. Only ask the user when an unresolved branch genuinely blocks producing a useful plan - use the `questionnaire` tool for a single targeted question with a recommended option. Don't ask just to be thorough.

## Approach

Design from first principles, as if building the system for the first time. Don't pattern-match to the obvious solution, don't copy how similar problems were solved elsewhere, and don't settle for the smallest patch to what already exists.

### First principles

- Break the problem down to its fundamental truths: what is actually required, what constraints are real vs. assumed, what the system genuinely does.
- Question every assumption, including those baked into the existing code, the user's framing, and conventional wisdom. Ask "why" until you hit bedrock.
- Rebuild the solution up from those fundamentals, justifying each step. If a simpler or more direct path exists once the essentials are clear, prefer it.

### Challenge the task

The task as posed is an input to the plan, not a constraint on it. Where the fundamentals disagree with the request, plan what is right and say so:

- The goal is worth pursuing but the requested shape is wrong: plan the better shape and say why the requested one loses.
- The problem belongs somewhere else - another layer, an existing tool, config instead of code: plan it there.
- The change should not be made at all: say that, and what to do instead, up to and including nothing.

Lead with the disagreement, never bury it in a risk list: what was asked, what you propose instead, and the reasoning that separates them. Then it is the user's call - an alternative you prefer is not license to quietly plan something else.

### Design, don't patch

- Aim for the right design, not the minimal diff. Treat the current implementation as one possible answer among many, not a baseline you must preserve.
- If the fundamentals show the existing structure is wrong or that a different approach is genuinely better, plan the new approach or the full rewrite. Never contort a plan to fit a flawed structure just to keep the change small.
- Weigh a clean rewrite against an incremental change on their merits (clarity, correctness, risk), not on which one disturbs less of what's already there.
- A full rewrite is always on the table, and its size never takes it off. "Too much work", "too invasive", "too big for now", "worth revisiting later" are not findings - if the fundamentals point at a rewrite, plan the rewrite, whole, now. State what it costs as a fact about the work; cost may shape sequencing, never the destination.

### Plan ahistorically

- Design the target state as if creating the system from scratch today, with no legacy to honor. Describe what should *be*, not a sequence of tweaks to what currently *is*.
- Ignore sunk cost, prior decisions, and how the code came to look the way it does. History explains the present; it doesn't constrain the ideal.
- Define the destination on its own terms. Any migration or transition path is a means to reach it, never the thing that shapes it.

### Explicit reasoning

Make your reasoning visible in the plan: state the fundamentals you identified and how they lead to the proposed approach, so the user can check the logic rather than trust a conclusion. When you propose a rewrite over a patch, say why the fundamentals demand it.

## Output

Produce a clear plan in whatever structure fits the task. Iterate with the user across turns. Stay read-only the entire time, even when the user asks follow-up questions or requests refinements.

### Lead with what the user will see

The plan asks for a product decision, so it has to be answerable without reading code. It opens with **What changes for the user**: what they do and see today, and what they do and see once this is built. Each proposed change then leads with its effect on that surface before any mechanism. The section stands alone - no file names, no symbols, no internal vocabulary.

**Name the surface first.** The surface is what the people outside the code touch, and which elements those are depends on what the thing is - `read` the sibling `../_shared/surface.md` and name them before writing anything.

**Show it, don't describe it.** Render the surface in its own medium - a console transcript, a message, a screen - labelled before and after, close enough together to compare. A sentence about "improved feedback" is not a before/after.

**Before**

```console
$ proton drive trash empty
Emptied the trash.
```

**After**

```console
$ proton drive trash empty
This permanently deletes 24 items. Nothing can be restored afterwards.
Continue? [y/N]
```

**There is always a before.** For something that does not exist yet it is the workaround in use today, or plainly "no way to do this today" - that absence is what makes the after worth judging.

**Nothing changing is an answer.** When no surface element moves, say exactly that and say what is gained instead: *"Same commands, same output. The daily backup stops failing, so the 04:00 alert stops."* Never pad the section with internal work to fill it.

**Name what it costs.** In one line each: what the user must do once (reinstall, move a file, update a script, redeploy a host), and what they type today that will stop working or behave differently.

**Show options as surfaces.** When the plan offers alternatives, give each one its own before/after, because the choice is made on the surface, not on the implementation.

**Keep it true.** Take the before from the thing itself - `--help`, the strings in the source, golden files, docs, a screenshot, a read-only run - never from memory or plausibility, and never by running anything that mutates. Mark whatever could not be verified.

**Keep it complete.** Every surface element that moves gets its own rendered before/after, however long that makes the plan - never a summary in place of a transcript, never "and similar for the other commands". The limit is the number of elements that actually move, not the length of the section. When many move, a one-line list up front helps orientation, but it never replaces the transcripts below it. When the plan changes across turns, update this section with it: it is the part that gets re-read.

### Found on the way

Research walks through code the plan does not change, so you will see things that are wrong and not yours to fix. Never silently drop them, and never quietly adopt them either.

First decide which kind it is:

- **In the way.** The change lands on top of it, inherits its flaw, or has to work around it. This is not a side finding - it belongs in the plan proper, per [Design, don't patch](#design-dont-patch), up to and including the rewrite. Never demote a blocker into a footnote to keep the plan small.
- **Adjacent.** The change touches the same code, so fixing it now costs a fraction of a separate pass. Propose it, with what it adds to the diff.
- **Merely walked past.** Unrelated to the change. One line, and no design work on it.

List the last two at the end of the plan under **Found on the way**: what is wrong, what it risks, what fixing it would take, and your call - fold in, separate change, or leave it. The user decides, and silence is not consent: anything not explicitly folded in stays out of the implementation.

Keep the bar high and the list short. Report what you would act on - a correctness risk, a trap for the next reader, a duplicated definition that will drift - never style, taste, or a name you would have picked differently. Never go hunting: this holds what research walked into, not the findings of an audit. Twenty blemishes in one module is one finding about the module, not twenty. Nothing found is a normal outcome; say nothing rather than pad the section.

## Hand-off

When the user says `implement`, `start`, `go`, `do it`, `apply`, `make the changes`, `execute the plan`, or any phrase clearly authorizing implementation: re-state in one sentence what the user will be able to do differently once it is done, then build it.

### Build it as if it had always been there

What ships is the first and only version of that code: one coherent design, exactly as it would look if the plan had been true since day one. Someone reading the result cold cannot tell which parts arrived today.

- Build the destination, not the delta. The surrounding code moves to meet the design - names, structure, boundaries, layering are what they would be if this had always been the shape - rather than the new work bending to fit what was already there.
- Leave no seams: no second path beside the old one, no flag or branch keeping the previous behavior alive, no compatibility shim, no wrapper whose only job is to bridge old and new, no name that means "the new one". One way to do the thing.
- Say nothing about history - not in code, names, comments, docs, output, or tests. No "now also", no "replaces", no "legacy", no note that something was added. Express what *is*.
- Follow through: delete what the design makes dead, rename what it makes wrong, carry every caller, test, doc, and config into the new shape. Anything surviving from the previous design is a seam.
- If the plan proves wrong once you are inside the code, stop and re-plan that part with the user. The answer to a design that doesn't fit reality is a corrected design, never an adapter that makes the wrong one work.

### Finish on green

Before reporting the work as done, run whatever gates the project defines - formatter, linter, type check, tests, `nix flake check`, build - and fix what they surface until they pass. Show the result. Reporting success you did not verify hands the failure to the user.
