---
name: rewrite
description: Ground-up rewrite of everything within a scope, rebuilt clean and idiomatic in the language's modern style as if written for the first time, every inherited assumption discarded - while preserving the user-facing contract so the product behaves identically. First argument is the target path (defaults to "."); anything that isn't a path is treated as extra context. Plans first (read-only, first-principles) via the plan skill and implements only after you authorize. Use when asked to rewrite, rebuild, modernize, or overhaul a file, module, or project from scratch.
---

# Rewrite

Rebuild everything within a scope from the ground up: clean, coherent, and idiomatic in the modern style of its language, as if it were being written for the first time today. The code carries no history worth honoring - every prior decision is re-opened and everything is up for change. Exactly one thing is preserved by default: the product keeps behaving as it does now for anyone outside the scope. Even that can move, but only through explicit approval (see [The one exception](#the-one-exception-user-facing-changes)).

## Plan first, always

This skill runs through the `plan` skill. Before touching anything, load it - `read` the sibling `../plan/SKILL.md` - and adopt its discipline in full.

## No history, everything is up for change

Approach the scope as if it had no past. Nothing is kept because it already exists, was expensive to build, or has always been that way - sunk cost and prior decisions carry no weight. Re-open every choice: structure, boundaries, names, data flow, dependencies, file layout, algorithms, patterns, libraries. The only reason to keep anything is that it is still the right answer today, or that the contract requires it - never that it is already there. The current code is at most evidence of what the system does, never a template for how it should be; design the destination on its own terms.

## Resolve the scope

The text accompanying the invocation is `<args>`. Resolve it into a target PATH and optional CONTEXT:

1. Trim `<args>`.
2. Empty -> `PATH="."`, no context.
3. The whole string is an existing file/dir (`test -e`) -> it is `PATH`, no context.
4. Otherwise take the first whitespace token `T`: if `test -e T`, then `PATH=T` and `CONTEXT=` the rest; else `PATH="."` and `CONTEXT=` the whole string.

State the resolved PATH and CONTEXT back before planning so the resolution is visible and you can correct a misread (e.g. a mistyped path that fell through to `.`). No confirmation gate is needed, including for a whole-repo (`.`) scope - the plan skill's read-only hand-off is the safety net. CONTEXT is intent (focus, constraints, motivation); fold it in, but it never shrinks the rewrite below the whole PATH.

## Freeze the contract

The guarantee is that nothing outside the scope notices, so first pin the observable surface at the scope boundary - this is the freeze line, and everything crossing it must stay identical:

- End-user surface: everything in the sibling `../_shared/surface.md` that crosses the scope boundary.
- Config and data: accepted configuration, env vars, file formats, schemas, on-disk and wire formats.
- Boundary API: every symbol, export, or behavior that code outside PATH depends on.
- Observable effects: what it writes, emits, logs as contract, or calls.

Anything inside PATH that does not cross that boundary is free - split, merge, rename, delete, or add at will.

## Design the target

With the first-principles method, design the in-scope code as if authored fresh today:

- Rebuild from fundamentals in the modern, idiomatic style and current best practices of each language present - verify current idioms and APIs with `/skill:context7` or `/skill:exa` when unsure.
- Drop dead code, obsolete workarounds, and assumptions whose reason is gone. For everything that stays, know why.
- Aim for the right structure - naming, boundaries, data flow - not a minimal diff. Follow the project's own conventions (ahistorical code, comments only when the *why* is non-obvious, alphabetical ordering, ...).

## The one exception: user-facing changes

Default: preserve the frozen contract exactly. The only allowed deviation is a change to the user-facing surface that makes it genuinely more coherent. Never apply one silently - list each in the plan, separately, with its rationale and blast radius (including any out-of-scope callers it would force you to touch), and let the user approve or reject it. No approval, no change.

## Verify equivalence

"Users don't notice" only counts if it is checked, so the plan must carry a safety net:

- Prefer the existing tests. If they do not pin the observable behavior, capture it first - characterization tests or golden outputs of the current code (recording during planning is read-only and fine). Throwaway harnesses live in `/tmp/`; a check genuinely worth keeping goes into the real suite.
- After the rewrite, run the net and confirm behavior matches the frozen contract (minus any approved changes). Diff old vs. new outputs where practical.

## Execute (after hand-off)

Once the user authorizes implementation:

1. Establish or confirm the behavior safety net.
2. Rewrite the in-scope code from the ground up per the target design.
3. Run verification and the project's quality gates (formatters, linters, type checks, tests, `nix flake check` - whatever the project defines). Fix until green.
4. Clean up: no leftover files, and no compatibility shim the frozen contract does not require.
