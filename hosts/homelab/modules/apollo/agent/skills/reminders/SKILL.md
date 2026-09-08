---
name: reminders
description: Create, list, update, and delete reminders. Use whenever the user asks to be reminded of something (after a delay or at a time), or to see, reschedule, change, or cancel their reminders.
---

# Reminders

Sets real reminders that fire even when the conversation is idle: at the chosen time Apollo sends the reminder text to the user on WhatsApp. Each pending reminder is one file in a spool directory that Apollo watches, and it stays there until it fires or is removed. A reminder that fires is archived with the time it went out, so `list --all` can still show it; one that never fired is gone when removed.

`{baseDir}` is this skill's directory. Resolve it to an absolute path before running the script.

```bash
{baseDir}/scripts/reminders.py <command> [flags]
```

The script owns all time math, storage, and the reply: you pass what the user wants, and it delivers its own confirmation to the user (see [Replying](#replying)). You never deliver a fired reminder yourself either - Apollo fires it at its time. Just set it.

## Replying

**Asked to see them - `--send`; needed them to answer - plain.** A reminder set, changed or dropped is theirs either way.

- **`add`, `update` and `remove`** post what they printed straight to the user on WhatsApp (as a "via reminders" message) and print `[reminders: delivered to the user ✓ ...]`. No `--send`: what they are now expecting is theirs to see. When you see that line, **stay silent** - they already got it verbatim, and restating it double-sends. Silence is written, not implied: close the turn with `<internal>…</internal>`, never with a line about staying quiet.
- **`list` reads** - it prints here and sends nothing, ending with `[reminders: not sent to the user - add --send to deliver it]`. Add `--send` when they asked to see their reminders; leave it off when you need one to answer something ("do I have anything before lunch?").

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
{baseDir}/scripts/reminders.py list --send           # they asked to see them
{baseDir}/scripts/reminders.py list                  # for you, to answer something
{baseDir}/scripts/reminders.py list --all --send     # plus the ones that have fired
```

Shows each pending reminder with its id, when it fires (absolute + relative), and text. `--all` adds the reminders that have already fired, newest first with the time each went out - the 10 most recent, since older ones are in the chat and the recall skill searches it. You never need it just to find an id - `update`/`remove` resolve reminders themselves.

## Update

Reschedule and/or change the text of a **pending** reminder. Target it by a word from its text or by the id `list` shows (an id prefix is fine) - the script resolves it, so no lookup `list` first. Pass only what changes; a time flag reschedules, otherwise the time is kept.

```bash
{baseDir}/scripts/reminders.py update dentist --in 30m
{baseDir}/scripts/reminders.py update "get my food" --text "get my food (cold section)"
{baseDir}/scripts/reminders.py update a1b2c3 --at 2026-07-15T10:00
```

## Delete

Drops a pending reminder so it never fires. Target it by text or id, exactly like `update`, or clear them all.

```bash
{baseDir}/scripts/reminders.py remove dentist
{baseDir}/scripts/reminders.py remove a1b2c3
{baseDir}/scripts/reminders.py remove --all
```

If the reference matches several reminders (or none), the script says so on stderr and does nothing - it is not sent to the user, so relay it yourself and narrow it down (or ask which one). A reference that names a reminder which has already fired says so too, with the time it went out; a fired reminder is finished, so set a new one with `add` rather than trying to revive it.

## Notes

- `--in` is computed against the real clock at the moment you run it, so it is always accurate.
- The script delivers what it sends (see [Replying](#replying)); don't relay or restate a delivered block - that double-sends.
- When a reminder fires it is sent to the user directly and shown in the dashboard chat; on the user's next message you get a `[context]` line noting it went out - it's already delivered, so don't resend it.
- A fired reminder is kept: it moves to the archive with the time it went out and stays readable through `list --all`. `remove` only ever drops a reminder that has not fired.

`{baseDir}` = this skill's directory. Always resolve to the absolute path before executing.
