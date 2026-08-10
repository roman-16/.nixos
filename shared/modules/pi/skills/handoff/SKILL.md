---
name: handoff
description: Write or refresh a HANDOFF-<slug>.md briefing in the root of the working directory so any fresh agent can take over the work from that file alone, with no transcript and no re-explaining. Use when the user asks to hand off or save the session or to write down where things stand, when context is running low, at the end of a work stint, or before a long or risky operation that could end the session.
---

# Handoff

Produce a briefing that lets a cold agent - a new session, a different harness, days later - continue this work from one file, as if the session had never ended.

This skill only writes. There is no resume command: the file addresses its own reader, so continuity never depends on the next agent having this skill. Pointing any agent at the file is the whole protocol.

## When to write

- The user asks to hand off, save the session, or write down where things stand.
- Context is running low. Write the first version once the approach is settled (around two thirds of the window left) and refresh it at each milestone. A briefing written at the edge of exhaustion is a bad briefing.
- A work stint ends, or the user is about to walk away.
- Before a long or risky operation that could kill the session.

## Where to write

1. The root of the directory the agent is working in, so it is the first thing anyone opening the project sees. Never bury it in a subdirectory.
2. List existing briefings there: `ls HANDOFF-*.md`. If one covers the current task, that is the file - rewrite it in place. Never create a near-duplicate. Files for other tasks are none of your business; leave them untouched.
3. Otherwise name a new one `HANDOFF-<slug>.md`. An argument passed to the skill is the slug.

### Slug

The slug is how the user picks this briefing out of a list weeks later, so it has to carry meaning on its own.

- Lowercase kebab-case, two to four words.
- Name the subject of the work, never its status: `HANDOFF-trader-position-sizing.md`, `HANDOFF-nvidia-wayland-crash.md`, `HANDOFF-apollo-baileys-reconnect.md`.
- Never `wip`, `fix`, `task`, `session`, `changes`, dates, or numbers: `HANDOFF-fix-bug.md` and `HANDOFF-2026-02-12.md` are useless.
- Stable once chosen. Refreshes rewrite the same file even when scope shifts.
- On a clash with an unrelated task, pick a more specific slug. Never append `-2`.

## What to write

The bar: the reader must act exactly as this session would have acted with a larger context window. Same intent, same decisions, same knowledge of the code, same next move. Anything short of that is a status report, not a handoff.

So transfer everything this session is holding in its head that still matters:

- The goal and what counts as done.
- The decisions and their reasons, so they are not relitigated.
- What the user rejected, in the user's own words, so it is not re-proposed.
- Exactly where the work stands, including anything half-applied or currently broken.
- What was learned about this project that is not obvious from reading it.
- How to run, check, and observe the work.
- What already happened outside the code and must not happen twice.
- Which attempts failed and why.
- What is still waiting on the user.

Facts the code already holds are cheap to recover, so point at them instead of copying them. State claims so the reader can check them rather than trust them, and make the immediate next action concrete enough to execute without deliberating.

Write the whole file every time, in this shape:

````markdown
# Handoff: <one-line task>

**You are taking over this work.** This file (`HANDOFF-<slug>.md`) is your entire briefing: everything the previous session knew that still matters is in it. Read it top to bottom, run Verify, then continue at Next as though the session had never broken. Do not re-plan anything settled under Approach, do not retry anything under Traps, and do not repeat anything under Side effects.

Updated <DD.MM.YYYY HH:MM CET> · `<working root>`

**This file is disposable.** It is scratch continuity state for this one task, not documentation, and it can be gone at any moment - if it is missing, no work is in flight, which is the normal state. Never restore it, never recreate it, never give it a second thought. It asks nothing of you except deletion once the goal is met. Sibling `HANDOFF-*.md` files belong to unrelated tasks; ignore them.

## Goal

What done means, in the user's terms, with acceptance criteria.

## Approach

- **Decided:** X, because Y.
- **Rejected:** Z, because W. Do not propose it again.
- **Deliberately out of scope:** V, deferred because U.

## Constraints

- Verbatim user wording where the exact phrasing matters: "..."
- Hard limits that shape the solution.

## State

**Verified** (claim plus what proved it)

- ...

**Assumed** (nobody checked)

- ...

**Half-done or broken right now**

- ...

## Next

1. The immediate action, concrete enough to execute without deciding anything.
2. ...

## Verify

```bash
<the project's own gates, e.g. nix fmt && nix flake check>
<how to run, deploy, or observe the thing, and what each command proves>
```

## Landmarks

- `path/to/file.nix:34` - why this spot matters.
- How this project actually works where reading it would not tell you.

## Traps

- Tried A, failed because B. Do not retry.

## Side effects already taken

- Deployed at 13:05, migration already run. Do not repeat.

## Open questions

- Blocked on the user: <question> (options: ...)
````

Drop a section only when it would be empty. Never invent content to fill one.

## Writing rules

- Write from the reader's ignorance, not from your memory. Every reference names its target: never "the fix", "that file", "as discussed", "the approach from before". If a sentence only parses for someone who watched the session, it is broken.
- Rewrite the file whole. Never append, never keep a log of past versions, never write "previously" or "changed to". Express only what is true now.
- Never duplicate code that is already on disk. Point at `path:line` and say why it matters.
- Every claim is either backed by something that proved it or sits under Assumed. No confident guesses.
- Around 200 lines is plenty. The briefing must stay cheap to load; if it is growing, it is narrating instead of briefing.
- Imperative and dense, addressed to an agent. No hedging, no pleasantries, no restating the obvious.
- No secrets, no credentials, no tool-call chronology.

## Before you finish

Read the file back as though you had never seen this session, and answer honestly:

- Can you take the first action under Next right now, without asking the user anything and without searching the project to work out what was meant?
- Would you arrive at the same approach, and leave the same things alone, without having seen the conversation?
- Does the file place the work precisely, including whatever is half-applied?
- If one of its claims had gone stale, would Verify expose that instead of you trusting it?
- Is there anything you know that the file does not say, which would change what you do next?

Fix whatever fails before reporting the file as ready.

## Finish

Report the path, then the line the user can paste into a fresh agent:

```
Read HANDOFF-<slug>.md and continue.
```

Delete the file once the goal is met and Verify passes, and say that you did. If it is unclear whether the work is truly finished, ask instead of deleting.
