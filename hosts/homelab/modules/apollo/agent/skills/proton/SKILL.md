---
name: proton
description: Use whenever ANY Proton action is taken - reading or changing Proton Mail, Drive, Calendar, Contacts, Pass, or settings via proton. Covers command usage and the rule that every change is reported to the user with the exact command that made it.
---

# Proton

`proton` drives the user's Proton account (Mail, Drive, Calendar, Contacts, Pass, settings). The service signs it in and keeps the session alive, so there is nothing to set up and nobody to ask. Add `--output json` to anything you are going to parse.

From [`proton`](#proton) to the end of this file is the tool's own account of itself: how a command is built, what each listing can be narrowed by, where every command lives. It speaks to any agent anywhere. What comes before it is this account on this machine, and where the two disagree, this part is right.

## The one rule: say what you changed

Reading is free and silent. Changing is yours to do, and it comes with a receipt.

- **Read on your own, and don't mention it.** Anything that only queries or fetches - typically verbs like `list`, `get`, `download`, `export`, and `api GET`. Answer the question; how you got to the answer is not news.
- **Change when the message asked for it.** Anything that writes - typically verbs like `create`, `update`, `delete`, `move`, `copy`, `upload`, `trash`, `restore`, `label`, `send`, `reply`, `forward`, `set`, `link`, and `api POST` / `PUT` / `DELETE` / `PATCH`. "Put the dentist in my calendar" is an instruction, not the opening of a negotiation, so carry it out.
- **Ask only where you would be guessing.** Not for permission, which the request already gave you, but because something is genuinely unsettled: which calendar, which of the three Bergers, whether "clear Friday" means the whole day. One question, then do it.

When unsure whether a command changes anything, its `--help` makes it clear; if it does, it owes a receipt.

### The receipt

One message: what happened in your own words, then every command that changed something, verbatim, in a monospace block.

````
Done, dentist is in your calendar Thu 16.04 15:00-16:00.
```
proton calendar events create --title Dentist --start 2026-04-16T15:00 --duration 1h
```
````

- **Exact.** The command as you actually ran it, flags, filters and `--yes` included. Not tidied, not shortened, not described in words.
- **All of it.** Several changes in one turn make one receipt listing every command, in the order they ran, never one for the first and silence for the rest.
- **Even when it went wrong.** Say what did not work, show the command anyway, and say what you need to put it right. Exit `5` is the one you cannot call from the exit code alone - read the item back first (see below) and report what you found.
- **Never internal.** The receipt is the user's, so it is delivered. It never sits inside `<internal>…</internal>`, and no other skill sends it for you.

A command that takes its content from stdin (`--body -`) does not describe itself, so either the receipt carries what went in, or you pass the content as a flag and let the command carry it. A secret is the exception: `--secret-stdin password` says enough on its own, and the password itself is never quoted in the receipt - it goes to the user as its own line, outside the block.

`--dry-run` changes nothing, so there is nothing to report about one.

### The one thing shown before it runs

A **permanent removal that a filter chose** goes in front of the user first. `delete` and `empty` are forever (`trash` is not - it is a move, and `restore` undoes it), and a filter names a rule rather than a set, so until the preview runs neither of you knows what "everything from that newsletter" actually is. A receipt afterwards would be a post-mortem.

So run it with `--dry-run` first, tell the user what it matched - how many, how far back, and that it is permanent - and go the moment they say so, reporting it exactly as any other change.

```bash
proton mail messages delete --from newsletter@example.com --all --dry-run
```

A removal the user named themselves ("delete that Hetzner invoice") is not this: run it and report it. Everything else runs on the request alone, sending mail included - when the words going out are yours rather than the user's, the receipt carries the body, so a correction is one message away.

## What holds here

- **Nothing waits for input.** `PROTON_NO_INPUT` is set, so a missing credential or a question nobody can answer is an error rather than a wait. `delete` and `empty` always ask before they act, and `trash` asks whenever a filter rather than a name chose what to remove, so those commands need `--yes` or they fail on the asking. Every command that changes something also takes `--dry-run`, which resolves the references and applies the filters and then touches nothing.
- **Five commands are refused outright.** Emptying Drive's, Mail's or Pass's trash, exporting Pass, and signing the session out are turned off by a confirmation policy this environment sets. Such a command exits `6` and says so; `--yes` does not answer it. Report that back and leave it with the user - they can do it in the app - rather than looking for another way round.
- **Exit `2` is the session, not you.** The service holds the sign-in and renews it, so a `2` means it has lapsed and nothing you can run brings it back. Say the Proton session needs restarting, carry on with the rest of the turn, and never ask the user for a password or run `account login` yourself.
- **A change that ended in exit `5` may still have happened.** Proton or the network gave out somewhere in the middle. Read the item back - `get`, or the `list` beside it - before doing anything else, and never send, upload or create again on the strength of the error alone.
