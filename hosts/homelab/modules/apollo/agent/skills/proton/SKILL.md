---
name: proton
description: Use whenever ANY Proton action is taken - reading or changing Proton Mail, Drive, Calendar, Contacts, Pass, or Settings via proton-cli. Covers command usage and the confirm-before-mutating policy.
---

# Proton

`proton-cli` drives the user's Proton account (Mail, Drive, Calendar, Contacts, Pass, Settings). It is already authenticated from the environment and handles SRP login plus end-to-end encryption itself - there is nothing to set up, and the session is cached across restarts. Add `--output json` (or `yaml`) when you want to parse a result rather than just read it.

## Discover the commands

Use `--help` to see what's available - `proton-cli --help` for the top-level areas, and `--help` on any subcommand for its exact usage and flags:

```bash
proton-cli --help
proton-cli mail --help
proton-cli mail messages --help
```

## The one rule: confirm before changing anything

Reading is free; every change must be confirmed first.

- **Read on your own** anything that only queries or fetches - typically verbs like `list`, `get`, `info`, `read`, `search`, `download`, and `api GET`.
- **Confirm first** anything that writes - typically verbs like `create`, `update`, `edit`, `delete`, `move`, `rename`, `copy`, `upload`, `trash`, `restore`, `send`, `set`, and `api POST` / `PUT` / `DELETE` / `PATCH`.

When unsure, a command's `--help` makes clear whether it changes anything; if it does, treat it as a mutation. Before running any mutation: **send the user the exact, full command** you intend to run, **wait for the user's explicit confirmation of that command**, then run it. Never run an unconfirmed mutation. `proton-cli` has a global `--dry-run` that previews a mutation without applying it - run it and show the preview next to the command you are proposing.

## Good to know

- **Calendar day ranges end exclusively:** `calendar events list --start 2026-08-03 --end 2026-08-03` returns nothing at all, because `--end` is the midnight the range stops at. One day is `--start <that day> --end <the next day>`, so today needs tomorrow's date.
- **IDs or search terms:** most commands that take an ID also accept a search term (subject, name, title, URL); an ambiguous term lists the candidates and exits `4`, so narrow it.
- **Short IDs:** listings shorten each ID to an 8-char prefix, and you can paste that prefix straight into any command that takes an ID (e.g. `list` shows `NWM5AYGx`, then `mail messages read NWM5AYGx`) - proton-cli caches the IDs it has shown you. A prefix it hasn't listed (fresh session, or copied from elsewhere) isn't cached, so run the matching `list` first or use the full ID; a prefix that matches two cached IDs exits `4` with both. `--output json`/`yaml` and pipes always emit full IDs, and `--full-ids` disables shortening.
- **Create prints the new ID** to stdout (and `✓` to stderr), so you can capture it: `id=$(proton-cli ... create ...)`.
- **Streaming:** `-` means stdin or stdout, e.g. `mail messages send --body -`, `drive items upload - /path`, `drive items download /path --output -`.
- **Exit codes:** `0` ok, `1` user error, `2` auth, `3` not-found, `4` ambiguous/conflict, `5` network/server.
- **Batch mutations:** many mutating commands accept filters (`--older-than`, `--unread`, `--pattern`, `--all`, `--recursive`), so a single command can change many items at once - all the more reason to preview with `--dry-run` and confirm.
- **Eventual consistency:** search/list read a server-side index that lags a few seconds, so a just-changed item may still show (or not yet); confirm a change by reading the specific item by ID rather than re-searching.
- **Headless login:** if Proton demands a CAPTCHA at login it cannot be solved here (no display) and the command fails - report that instead of retrying.
- `proton-cli api GET <path>` reaches endpoints the subcommands don't cover.
