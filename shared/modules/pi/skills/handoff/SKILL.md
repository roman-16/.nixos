---
name: handoff
description: Write or refresh a briefing that transfers everything this session knows, so the next agent continues the work as this agent would - from the briefing alone, with no transcript and no re-explaining. Writes HANDOFF-<slug>.md in the root of the working directory, or, with --inline, the briefing as the message itself when the reader is the next model in this same session. Use when the user asks to hand off or save the session or to write down where things stand, when context is running low, at the end of a work stint, before a long or risky operation that could end the session, or when the session is about to switch model or drop what it holds.
---

# Handoff

Write the briefing that makes what comes next a continuation rather than a restart. A cold agent - new session, different harness, days later, or the same session one model and one pruned transcript later - reads it and picks the work up mid-stride: same intent, same decisions, same knowledge of the code, same next keystroke, as if this session had simply kept going with a fresh context window.

Treat it as a brain dump with structure. You are not summarizing the work, you are transferring the working state of the agent doing it. Everything you are holding in your head goes into the briefing, because after this you are gone and the briefing is all there is.

This skill only writes. There is no resume command: the briefing addresses its own reader, so continuity never depends on the next agent having this skill. Pointing any agent at it is the whole protocol.

## When to write

- The user asks to hand off, save the session, or write down where things stand.
- Context is running low. Write the first version once the approach is settled, around two thirds of the window left, and refresh it at each milestone. A briefing written at the edge of exhaustion is a bad briefing, because by then the knowledge worth transferring is already being squeezed out.
- The work changes hands in place: another model takes over, or the transcript is about to be pruned or compacted.
- A work stint ends, or the user is about to walk away.
- Before a long or risky operation that could kill the session.

## Where it goes

`--inline` in the arguments selects the inline destination. Anything else is a file, and the argument text is the slug.

### A file

For a reader who arrives later, in a session that does not exist yet.

1. The root of the directory the agent is working in, so it is the first thing anyone opening the project sees. Never bury it in a subdirectory.
2. List existing briefings there: `ls HANDOFF-*.md`. If one covers the current task, that is the file - rewrite it in place. Never create a near-duplicate. Files for other tasks are none of your business; leave them untouched.
3. Otherwise name a new one `HANDOFF-<slug>.md`.

It opens with:

```markdown
**You are taking over this work.** This file (`HANDOFF-<slug>.md`) is your entire briefing: everything the previous session knew that still matters is in it. Read it top to bottom, run Verify, then continue at Next as though the session had never broken. Do not re-plan anything settled under Approach, do not retry anything under Traps, and do not repeat anything under Side effects.

Once you have read it, the file has done its job. It may vanish at any moment - the user often deletes it immediately. That says nothing about the work: do not check for it, do not recreate it, do not mention it again. Sibling `HANDOFF-*.md` files belong to unrelated tasks; ignore them.
```

#### Slug

The slug is how the user picks this briefing out of a list weeks later, so it has to carry meaning on its own.

- Lowercase kebab-case, two to four words.
- Name the subject of the work, never its status: `HANDOFF-trader-position-sizing.md`, `HANDOFF-nvidia-wayland-crash.md`, `HANDOFF-apollo-baileys-reconnect.md`.
- Never `wip`, `fix`, `task`, `session`, `changes`, dates, or numbers: `HANDOFF-fix-bug.md` and `HANDOFF-2026-02-12.md` are useless.
- Stable once chosen. Refreshes rewrite the same file even when scope shifts.
- On a clash with an unrelated task, pick a more specific slug. Never append `-2`.

### Inline

For the reader already here: the next model in this same session, taking over across a model switch, a prune, or a compaction. A file would be created and consumed within seconds, so the message is the briefing.

- Nothing touches disk. No slug, no path, no `ls`.
- The message is the briefing and nothing else: no preamble, no "here is the handoff", no closing remark. It starts at the `# Handoff:` heading.
- The transcript is still on screen, and that changes nothing about what goes in: write every fact out in full as if the reader had only this message, because that is what they will have.
- Say nothing about it afterwards, and never offer to save it.

It opens with:

```markdown
**You are taking over this work.** This message is your entire briefing: everything the session above knew that still matters is in it. Read it top to bottom, run Verify, then continue at Next as though nothing had broken. Do not re-plan anything settled under Approach, do not retry anything under Traps, and do not repeat anything under Side effects.

What is left of the conversation above is not a record you can trust: tool output and reasoning are stripped out of it, and fragments mislead. This message is the only account of the work. Anything else, read again from the source before you act on it.
```

## What to write

The bar: the reader acts exactly as this session would have acted with a larger context window. Anything short of that is a status report, not a handoff.

Transfer all of it:

- The goal, in the user's terms, and what counts as done.
- The decisions and their reasons, so they are not relitigated.
- What the user rejected, in the user's own words, so it is not re-proposed.
- The arc of the work so far: what was attempted, in order, what happened, and what each attempt revealed. The successor inherits the road travelled, not just the current position.
- Exactly where the work stands, down to anything half-applied, uncommitted, or broken right now.
- Everything learned about this project that reading it would not tell you: the surprising behaviour, the file that lies, the dependency that matters, the thing that looks wrong and is correct.
- How to run, check, and observe the work, and what each command proves.
- The environment it runs in: services, hosts, ports, paths, tools, whatever the work depends on being true of the machine.
- What already happened outside the code and must not happen twice.
- Which attempts failed and why, precisely enough that the reader does not repeat them by accident.
- What is still waiting on the user.

When in doubt whether something matters, put it in. A fact you drop is a fact the successor has to rediscover, or worse, gets wrong.

Point at facts the code already holds rather than copying them, but inline the exact text wherever the text itself is the payload: a half-applied edit, the verbatim error, the failing command and its output, the config block under discussion. Pointers are for what the reader can look up; text is for what they cannot reconstruct.

State claims so the reader can check them rather than trust them, and make the immediate next action concrete enough to execute without deliberating.

Write the whole briefing every time, in this shape:

````markdown
# Handoff: <one-line task>

<the opening for the destination, from [Where it goes](#where-it-goes)>

Updated <DD.MM.YYYY HH:MM CET> · `<working root>`

## Goal

What done means, in the user's terms, with acceptance criteria.

## Approach

- **Decided:** X, because Y.
- **Rejected:** Z, because W. Do not propose it again.
- **Deliberately out of scope:** V, deferred because U.

## Constraints

- Verbatim user wording where the exact phrasing matters: "..."
- Hard limits that shape the solution.

## Story so far

Chronological. Each step: what it was meant to do, what happened, what it changed on disk or in your understanding.

1. ...

## State

**Verified** (claim plus what proved it)

- ...

**Assumed** (nobody checked)

- ...

**Half-done or broken right now**

- Exact file, exact shape it is in, exact remaining edit.

## Next

1. The immediate action, concrete enough to execute without deciding anything.
2. ...

## Verify

```bash
<the project's own gates, e.g. nix fmt && nix flake check>
<how to run, deploy, or observe the thing, and what each command proves>
```

## Environment

- Services, hosts, ports, paths, versions, tooling the work assumes.

## Landmarks

- `path/to/file.nix:34` - why this spot matters.
- How this project actually works where reading it would mislead you.

## Traps

- Tried A, failed because B, with the error: `...`. Do not retry.

## Side effects already taken

- Deployed at 13:05, migration already run. Do not repeat.

## Open questions

- Blocked on the user: <question> (options: ...)
````

Add sections when the work has more to hand over than this shape holds. Drop one only when it would be empty, and never invent content to fill it.

## Writing rules

- Write from the reader's ignorance, not from your memory. Every reference names its target: never "the fix", "that file", "as discussed", "the approach from before". If a sentence only parses for someone who watched the session, it is broken.
- Write it whole. Never append, never keep a log of past versions, never write "previously" or "changed to" about the briefing itself. The Story section carries the history of the work; the rest states only what is true now.
- Every claim is either backed by something that proved it or sits under Assumed. No confident guesses, no polish over uncertainty.
- Imperative and dense, addressed to an agent. No hedging, no pleasantries, no restating what the reader can see.
- No secrets and no credentials. Name where they live, never what they are.

## Before you finish

Read it back as though you had never seen this session, and answer honestly:

- Can you take the first action under Next right now, without asking the user anything and without searching the project to work out what was meant?
- Would you arrive at the same approach, and leave the same things alone, without having seen the conversation?
- Does it place the work precisely, including whatever is half-applied?
- If one of its claims had gone stale, would Verify expose that instead of you trusting it?
- Is there anything you know that it does not say, which would change what you do next, or cost the reader time to rediscover?

Fix whatever fails before the briefing leaves your hands.

## Finish

A file: report the path, then the line the user can paste into a fresh agent:

```
Read HANDOFF-<slug>.md and continue.
```

Delete it once the goal is met and Verify passes, and say that you did. If it is unclear whether the work is truly finished, ask instead of deleting.

Inline: the briefing is the whole message. Nothing before it, nothing after it.
