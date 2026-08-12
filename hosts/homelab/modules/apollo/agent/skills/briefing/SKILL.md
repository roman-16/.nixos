---
name: briefing
description: Send the day's briefing - one message with today's weather, daylight, calendar and offers. Use only when the user asks for the briefing itself ("send me the briefing", "brief me", "what does the briefing say"), not for the individual questions behind it.
---

# Briefing

One message with the shape of the day: today's sky, what is on their calendar, and any offers they are watching. The user gets it once a day without you being involved, so this skill is only for when they ask for it out of turn.

`{baseDir}` is this skill's directory. Resolve it to an absolute path before running the script.

```bash
{baseDir}/scripts/briefing.py show
```

## Reach for the parts, not the whole

The briefing is a fixed digest of the current day, not a way to answer questions. When the user asks something specific, use the skill that owns it and answer in your own words:

| They ask                                | Use                                                          |
| --------------------------------------- | ------------------------------------------------------------ |
| weather, rain, sun, how long the day is | the **weather** skill                                        |
| what's on today, when is X, am I free   | `proton-cli calendar events list` (see the **proton** skill) |
| is X on offer, what's cheap this week   | the **offers** skill                                         |

Only "send me the briefing" and the like call for this script.

## Replying

**Its output is written for the user**: the script posts the briefing straight to them on WhatsApp (as a "via briefing" message) and prints `[briefing: delivered to the user ✓ ...]`. When you see that line, **stay silent** - they already have it verbatim, and restating it double-sends. Silence is written, not implied: close the turn with `<internal>…</internal>`, never with a line about staying quiet.

`--quiet` prints it here and sends nothing, ending with `[briefing: quiet - not sent to the user]`. That is for checking what the briefing would say, not for relaying it.

If the script prints `[briefing: delivery FAILED ...]`, the send didn't happen: relay the briefing yourself, just this once.

## What it contains

```
*Monday 03.08*

⛅ Graz: 31° now, up to 36°, still 35° at 19:00, partly cloudy, 0% rain, UV 7
🌅 05:40 → 20:28 · 14h 48m of daylight (4m less than yesterday)

📅 Today
  09:30-10:00  Dentist · Annenstraße 12
  19:00-22:00  Book club

🏷️ Offers
  …
```

**A section only appears when it has something to say.** No events today means no calendar block; nothing on offer means no offers block; a quiet day is just the two sky lines. So a missing block is good news, not a bug - never add a line saying the calendar was empty.

**A section that broke says so** (`📅 Calendar unavailable right now.`), because a silent failure would be indistinguishable from a free day. If you see one of those, the detail is on stderr.

## Notes

- The weather and offers blocks are the weather and offers skills' own output, so anything the user wants changed about them is changed there, not here.
- The calendar block is the current day in the **default calendar** only - the one new events land in. Anything kept elsewhere (a holiday feed, a habit or chore calendar) is deliberately absent, so its absence is never a bug. A multi-day event that runs through the day does appear, as `all day`.
- The daily one is recorded in the chat like any other skill message, so you may see it noted as already delivered on the user's next message. Never resend it.

`{baseDir}` = this skill's directory. Always resolve to the absolute path before executing.
