---
name: browser
description: Drive a real web browser from the terminal via Browserbase's `browse` CLI - navigate pages; inspect them through accessibility snapshots, screenshots, and DOM/markdown reads; interact by clicking, typing, selecting, uploading, and raw mouse/keyboard; capture network traffic; manage tabs and named sessions; run locally or on Browserbase's cloud; and use cloud fetch/search, Functions, and templates. Use whenever a task needs to view, navigate, scrape, or act on a web page.
compatibility: Requires Node.js (>=20.19 or >=22.12) with npx on PATH. Runs the latest `browse` via npx; no global install or Nix required. Local browsing needs a Chrome/Chromium-family browser, or use remote mode with BROWSERBASE_API_KEY.
---

# Browser

Browser automation via Browserbase's `browse` CLI. Run every command through `{baseDir}/scripts/browse.sh`.

```bash
{baseDir}/scripts/browse.sh <command> [args]
```

## Learn the commands from the CLI

This skill deliberately does not document individual commands or flags - the CLI is self-describing and always current. Discover usage at runtime instead of guessing:

```bash
{baseDir}/scripts/browse.sh skills show       # START HERE: the CLI's own version-matched agent guide (workflows, sessions, recovery)
{baseDir}/scripts/browse.sh --help            # full command + topic list
{baseDir}/scripts/browse.sh <command> --help  # exact flags for one command
{baseDir}/scripts/browse.sh <topic> --help    # a topic's subcommands, e.g. cloud, tab, network, mouse
```

Run `skills show` before real work, and consult `--help` for exact flags rather than assuming them.

## Always name your sessions

Pass an explicit `--session <name>` (or set `BROWSE_SESSION`) for every real task; never rely on the implicit `default` session. Commands without a session all share `default` and clobber each other's active page. `status`, `doctor` and `stop` also default to `default`, so a bare `browse status` can report "uninitialized" while your named sessions are alive. One name per independent task keeps tabs, cookies, refs and daemon state isolated, and lets you stop each task cleanly.

## Always shut down when done

`browse` keeps a background session/daemon (and browser) alive between commands. When the task is finished - or if it fails or you abandon it - stop it with the CLI's own shutdown command so nothing keeps running. Discover the exact command and flags via `skills show` or `--help` (currently `{baseDir}/scripts/browse.sh stop`), and stop every session you started. Treat it as mandatory: never end a turn with a session left open.

## Troubleshooting

Diagnose browser and session setup with `{baseDir}/scripts/browse.sh doctor` (add `--json` for structured output).

`{baseDir}` = this skill's directory. Always resolve to the absolute path before executing.
