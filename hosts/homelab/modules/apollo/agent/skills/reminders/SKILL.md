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

The script owns all time math and storage; you pass what the user wants and relay the confirmation it prints. You never deliver the reminder yourself - Apollo fires it at the time. Just set it.

## Create

Give the reminder text plus when. Use `--in` for a delay (you don't know the current wall-clock time, but the script does), and `--at` for a specific clock/calendar time (compute the ISO from today's date, which is in your context).

```bash
{baseDir}/scripts/reminders.py add --text "get my food" --in 3h
{baseDir}/scripts/reminders.py add --text "call the dentist" --at 2026-07-15T09:00
```

`--in` accepts combined units `s m h d w` (e.g. `90m`, `2h`, `1d`, `1h30m`). `--at` is ISO 8601 in local time (Europe/Vienna).

## List

```bash
{baseDir}/scripts/reminders.py list
```

Shows each pending reminder with its id, when it fires (absolute + relative), and text.

## Update

Reschedule and/or change the text by id (get ids from `list`). Pass only what changes; a time flag reschedules, otherwise the time is kept.

```bash
{baseDir}/scripts/reminders.py update --id a1b2c3 --in 30m
{baseDir}/scripts/reminders.py update --id a1b2c3 --text "get my food (cold section)"
```

## Delete

```bash
{baseDir}/scripts/reminders.py remove --id a1b2c3
{baseDir}/scripts/reminders.py remove --all
```

## Notes

- `--in` is computed against the real clock at the moment you run it, so it is always accurate.
- After creating or updating, tell the user when it will fire. After `list`, relay the list.
- When a reminder fires it is sent to the user directly and shown in the dashboard chat; on the user's next message you get a `[context]` line noting it went out - it's already delivered, so don't resend it.

`{baseDir}` = this skill's directory. Always resolve to the absolute path before executing.
