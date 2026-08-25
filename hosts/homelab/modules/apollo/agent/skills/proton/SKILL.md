---
name: proton
description: Use whenever ANY Proton action is taken - reading or changing Proton Mail, Drive, Calendar, Contacts, Pass, or settings via proton. Covers command usage and the rule that every change is reported to the user with the exact command that made it.
---

# Proton

`proton` drives the user's Proton account (Mail, Drive, Calendar, Contacts, Pass, settings). It is already signed in as that account and handles SRP login plus end-to-end encryption itself - there is nothing to set up, and the session is saved across restarts. Add `--output json` (or `yaml`) when you want to parse a result rather than just read it.

Every command reads the same way: `proton <app> <collection> <verb>`, one word per idea. `get` is the only way to look one thing up, `update` the only way to change a field, and anywhere a command wants an ID a subject, name, title or URL works too.

## Discover the commands

Use `--help` to see what's available - `proton --help` for the top-level areas, and `--help` on any subcommand for its exact usage and flags:

```bash
proton --help
proton mail --help
proton mail messages --help
```

## The one rule: say what you changed

Reading is free and silent. Changing is yours to do, and it comes with a receipt.

- **Read on your own, and don't mention it.** Anything that only queries or fetches - typically verbs like `list`, `get`, `search`, `download`, `export`, and `api GET`. Answer the question; how you got to the answer is not news.
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
- **Even when it failed.** A command that failed changed nothing, and "done" would be a lie: say it didn't work, show the command anyway, and say what you need to put it right.
- **Never internal.** The receipt is the user's, so it is delivered. It never sits inside `<internal>…</internal>`, and no other skill sends it for you.

A command that takes its content from stdin (`--body -`) does not describe itself, so either the receipt carries what went in, or you pass the content as a flag and let the command carry it.

`--dry-run` changes nothing, so there is nothing to report about one.

### The one thing shown before it runs

A **permanent removal that a filter chose** goes in front of the user first. `delete` and `empty` are forever (`trash` is not - it is a move, and `restore` undoes it), and a filter names a rule rather than a set, so until the preview runs neither of you knows what "everything from that newsletter" actually is. A receipt afterwards would be a post-mortem.

So run it with `--dry-run` first, tell the user what it matched - how many, how far back, and that it is permanent - and go the moment they say so, reporting it exactly as any other change.

```bash
proton mail messages delete --from newsletter@example.com --all --dry-run
```

A removal the user named themselves ("delete that Hetzner invoice") is not this: run it and report it. Everything else runs on the request alone, sending mail included - when the words going out are yours rather than the user's, the receipt carries the body, so a correction is one message away.

## Good to know

- **Collections come back in an envelope:** `--output json` keys every list by its plural name and always carries a `count`, so it is `.messages[]`, `.items[]`, `.events[]`, `.vaults[]`, never a bare array. Keys are `snake_case`, values are names rather than numbers (`"type": "file"`), timestamps are `<verb>_time` in Unix seconds, and sizes are bytes. `create` prints the new ID to stdout, so `id=$(proton ... create ...)` captures it. `api` is the one exception: it passes Proton's own response through unchanged.
- **Settings live with their product:** `settings` is the account, `mail settings` / `drive settings` / `calendar settings` / `pass settings` each carry their own, and folders, labels, filters, addresses and calendars sit under those (`mail settings labels`, `calendar settings calendars`).
- **Calendar ranges are whole days in the user's own zone:** `--start`/`--end` are the first and last day included, so one day is that date twice, and nothing outside them is listed. An event is on a day when it touches any part of it, so a query for one day inside a three-day event returns it, and an event that merely ends at midnight belongs to the day before. Times in JSON carry the user's offset (what the event is anchored to is its own `zone` field), and an all-day event ends at the midnight after its last day, so `end` is never part of it.
- **IDs or search terms:** most commands that take an ID also accept a search term (subject, name, title, URL). An ambiguous term lists the candidates and exits `4`, so narrow it; one that matches nothing exits `3`. A mistyped command is an error, never a silent success.
- **Removals and bulk changes prompt, so they need `--yes`:** `delete` and `empty` always prompt, and `trash` prompts whenever a filter rather than a name chose what to remove; nothing here can answer a prompt, so such a command fails without `--yes`. Many mutating commands also take filters (`--older-than`, `--unread`, `--pattern`, `--all`, `--recursive`), so one command can change a great many items - which is what `--dry-run` is for, and why a permanent one is [shown before it runs](#the-one-thing-shown-before-it-runs).
- **Nothing ever waits for input:** this environment runs with `PROTON_NO_INPUT`, so a missing credential, an unanswerable question, or a CAPTCHA at login fails immediately instead of hanging. Report the failure rather than retrying.
- **Eventual consistency:** search/list read a server-side index that lags a few seconds, so a just-changed item may still show (or not yet); confirm a change by reading the specific item by ID rather than re-searching.
- **Streaming:** `-` means stdin or stdout, e.g. `mail messages send --body -`, `drive items upload - /path`, `drive items download /path --output -`. And `proton api GET <path>` reaches endpoints the subcommands don't cover.
