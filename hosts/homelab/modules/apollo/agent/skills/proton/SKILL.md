---
name: proton
description: Use whenever ANY Proton action is taken - reading or changing Proton Mail, Drive, Calendar, Contacts, Pass, or settings via proton-cli. Covers command usage and the confirm-before-mutating policy.
---

# Proton

`proton-cli` drives the user's Proton account (Mail, Drive, Calendar, Contacts, Pass, settings). It is already signed in as that account and handles SRP login plus end-to-end encryption itself - there is nothing to set up, and the session is saved across restarts. Add `--output json` (or `yaml`) when you want to parse a result rather than just read it.

Every command reads the same way: `proton-cli <app> <collection> <verb>`, one word per idea. `get` is the only way to look one thing up, `update` the only way to change a field, and anywhere a command wants an ID a subject, name, title or URL works too.

## Discover the commands

Use `--help` to see what's available - `proton-cli --help` for the top-level areas, and `--help` on any subcommand for its exact usage and flags:

```bash
proton-cli --help
proton-cli mail --help
proton-cli mail messages --help
```

## The one rule: confirm before changing anything

Reading is free; every change must be confirmed first.

- **Read on your own** anything that only queries or fetches - typically verbs like `list`, `get`, `search`, `download`, `export`, and `api GET`.
- **Confirm first** anything that writes - typically verbs like `create`, `update`, `delete`, `move`, `copy`, `upload`, `trash`, `restore`, `label`, `send`, `reply`, `forward`, `set`, `link`, and `api POST` / `PUT` / `DELETE` / `PATCH`.

When unsure, a command's `--help` makes clear whether it changes anything; if it does, treat it as a mutation. Before running any mutation: **send the user the exact, full command** you intend to run, **wait for the user's explicit confirmation of that command**, then run it. Never run an unconfirmed mutation. `proton-cli` has a global `--dry-run` that previews a mutation without applying it, listing the rows it would touch - run it and show the preview next to the command you are proposing.

## Good to know

- **Collections come back in an envelope:** `--output json` keys every list by its plural name and always carries a `count`, so it is `.messages[]`, `.items[]`, `.events[]`, `.vaults[]`, never a bare array. Keys are `snake_case`, values are names rather than numbers (`"type": "file"`), timestamps are `<verb>_time` in Unix seconds, and sizes are bytes. `create` prints the new ID to stdout, so `id=$(proton-cli ... create ...)` captures it. `api` is the one exception: it passes Proton's own response through unchanged.
- **Settings live with their product:** `settings` is the account, `mail settings` / `drive settings` / `calendar settings` / `pass settings` each carry their own, and folders, labels, filters, addresses and calendars sit under those (`mail settings labels`, `calendar settings calendars`).
- **Calendar ranges are whole days in the user's own zone:** `--start`/`--end` are the first and last day included, so one day is that date twice, and nothing outside them is listed. An event is on a day when it touches any part of it, so a query for one day inside a three-day event returns it, and an event that merely ends at midnight belongs to the day before. Times in JSON carry the user's offset (what the event is anchored to is its own `zone` field), and an all-day event ends at the midnight after its last day, so `end` is never part of it.
- **IDs or search terms:** most commands that take an ID also accept a search term (subject, name, title, URL). An ambiguous term lists the candidates and exits `4`, so narrow it; one that matches nothing exits `3`. A mistyped command is an error, never a silent success.
- **Removals and bulk changes ask first:** `delete` and `empty` always ask, and `trash` asks whenever a filter rather than a name chose what to remove; nothing here can answer a prompt, so such a command fails without `--yes`. Many mutating commands also take filters (`--older-than`, `--unread`, `--pattern`, `--all`, `--recursive`), so one command can change a great many items - which makes these exactly the ones to preview with `--dry-run` and put in front of the user first.
- **Nothing ever waits for input:** this environment runs with `PROTON_NO_INPUT`, so a missing credential, an unanswerable question, or a CAPTCHA at login fails immediately instead of hanging. Report the failure rather than retrying.
- **Eventual consistency:** search/list read a server-side index that lags a few seconds, so a just-changed item may still show (or not yet); confirm a change by reading the specific item by ID rather than re-searching.
- **Streaming:** `-` means stdin or stdout, e.g. `mail messages send --body -`, `drive items upload - /path`, `drive items download /path --output -`. And `proton-cli api GET <path>` reaches endpoints the subcommands don't cover.
