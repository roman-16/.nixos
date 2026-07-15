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

## Tips

- `--output json` / `--output yaml` for machine-readable output; `--full-ids` when a shortened ID is ambiguous.
- `proton-cli api GET <path>` reaches endpoints the subcommands don't cover.
