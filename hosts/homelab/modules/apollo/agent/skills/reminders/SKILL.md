---
name: reminders
description: Create, list, update, and delete reminders. Use whenever the user asks to be reminded of something (after a delay or at a time), or to see, reschedule, change, or cancel their reminders.
---

# Reminders

Sets real reminders that fire even when the conversation is idle: at the chosen time Apollo sends the reminder text to the user on WhatsApp. Each reminder is one file in a spool directory that Apollo watches; a fired reminder is deleted automatically, an unfired one stays until it fires or is removed.

`{baseDir}` is this skill's directory. Resolve it to an absolute path before running the script.

```bash
{baseDir}/scripts/reminders.py <command> [flags]
```

The script owns all time math, storage, and the reply: you pass what the user wants, and it delivers its own confirmation to the user (see [Replying](#replying)). You never deliver a fired reminder yourself either - Apollo fires it at its time. Just set it.

## Replying

Every command has an audience. **By default it is the user**: the script posts its printed output straight to them on WhatsApp (as a "via reminders" message) and prints `[reminders: delivered to the user ✓ - do not relay]`. When you see that line, **stay silent** - the user already got it verbatim, and restating it double-sends.

**`--quiet` makes the audience you.** Every command takes it: the output is printed here, nothing is sent, and the last line is `[reminders: quiet - not sent to the user]`. Use it when you need to know something rather than show it - `list --quiet` to check what is already set before answering, for instance - and then reply once in your own words. Silencing a change makes the news yours to deliver: if you set or cancel something quietly, say so.

If the script prints `[reminders: delivery FAILED ...]` instead, the send didn't happen: relay that output yourself, just this once (the reminder was still saved - don't re-run the command).

## Create

Give the reminder text plus when. Use `--in` for a delay (you don't know the current wall-clock time, but the script does), and `--at` for a specific clock/calendar time (compute the ISO from today's date, which is in your context).

```bash
{baseDir}/scripts/reminders.py add --text "get my food" --in 3h
{baseDir}/scripts/reminders.py add --text "call the dentist" --at 2026-07-15T09:00
```

`--in` accepts combined units `s m h d w` (e.g. `90m`, `2h`, `1d`, `1h30m`). `--at` is ISO 8601 in local time (Europe/Vienna). The confirmation names the fire time; the script sends it to the user.

## List

```bash
{baseDir}/scripts/reminders.py list
{baseDir}/scripts/reminders.py list --quiet   # for your eyes only
```

Shows each pending reminder with its id, when it fires (absolute + relative), and text. Without `--quiet` it goes to the user, so run it plain when they actually want to see their reminders. You never need it just to find an id - `update`/`remove` resolve reminders themselves.

## Update

Reschedule and/or change the text. Target the reminder by a word from its text or by the id `list` shows (an id prefix is fine) - the script resolves it, so no lookup `list` first. Pass only what changes; a time flag reschedules, otherwise the time is kept.

```bash
{baseDir}/scripts/reminders.py update dentist --in 30m
{baseDir}/scripts/reminders.py update "get my food" --text "get my food (cold section)"
{baseDir}/scripts/reminders.py update a1b2c3 --at 2026-07-15T10:00
```

## Delete

Target by text or id, exactly like `update`, or clear them all.

```bash
{baseDir}/scripts/reminders.py remove dentist
{baseDir}/scripts/reminders.py remove a1b2c3
{baseDir}/scripts/reminders.py remove --all
```

If the reference matches several reminders (or none), the script says so on stderr and does nothing - it is not sent to the user, so relay it yourself and narrow it down (or ask which one).

## Notes

- `--in` is computed against the real clock at the moment you run it, so it is always accurate.
- The script delivers every command's output to the user (see [Replying](#replying)); don't relay or restate it - that double-sends.
- When a reminder fires it is sent to the user directly and shown in the dashboard chat; on the user's next message you get a `[context]` line noting it went out - it's already delivered, so don't resend it.

`{baseDir}` = this skill's directory. Always resolve to the absolute path before executing.
