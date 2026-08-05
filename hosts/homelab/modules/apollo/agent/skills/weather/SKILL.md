---
name: weather
description: Weather and daylight for the user's place - what today or any coming day will be like, and how long the sun is up. Use whenever the user asks about the weather, temperature, rain, sun, UV, wind, sunrise or sunset, how long the day is, or whether to take a jacket.
---

# Weather

Answers what the sky is doing: the weather for a day, and how much daylight it has. Both come from one call, so one command gives you both. Never work out a temperature, a sunrise or a day length yourself - the script owns all of it.

`{baseDir}` is this skill's directory. Resolve it to an absolute path before running the script.

```bash
{baseDir}/scripts/weather.py <command> [flags]
```

To the user this is just "the weather" - never name the provider the data comes from, since it is an implementation detail that may change.

## Replying

**`show` is written for the user**: the script posts its output straight to them on WhatsApp (as a "via weather" message) and prints `[weather: delivered to the user ✓ ...]`. When you see that line, **stay silent** - they already have it verbatim, and restating it double-sends. Silence is written, not implied: close the turn with `<internal>…</internal>`, never with a line about staying quiet.

Add `--quiet` when you need the numbers in order to answer something in your own words ("should I cycle to work?", "is it jacket weather?"). The output is then printed here, nothing is sent, and the last line is `[weather: quiet - not sent to the user]`. Run it plain only when they asked to _see_ the weather, and then say nothing after.

**`config` and `config-set` are machinery for you** - nothing is sent, so say whatever needs saying in your own words.

If the script prints `[weather: delivery FAILED ...]`, the send didn't happen: relay that output yourself, just this once.

## Setup (once, or when the user moves)

Weather is a place, so the script needs coordinates. **Ask the user for theirs the first time it comes up, then never again** - they are stored.

```bash
{baseDir}/scripts/weather.py config-set --place Graz --lat 47.07 --lon 15.44
{baseDir}/scripts/weather.py config
```

`--place` is only the label that appears in the message. Coordinates are decimal degrees; if the user gives them in degrees-minutes-seconds, convert before passing them.

## Asking

```bash
{baseDir}/scripts/weather.py show                        # today
{baseDir}/scripts/weather.py show --date 2026-08-06      # any day up to 16 ahead
{baseDir}/scripts/weather.py show --days 4               # a compact outlook
```

`show` prints two lines - the weather and the daylight:

```
⛅ Graz: 31° now, up to 36°, still 35° at 19:00, partly cloudy, 0% rain, UV 7
🌅 05:40 → 20:28 · 14h 48m of daylight (4m less than yesterday)
```

The shape is the same every day, plus three clauses that appear only when they mean something: **UV** when it is 6 or above, **wind** when gusts reach 40 km/h, and **the 19:00 temperature** when the evening stays within 3° of the day's high, which is what a night with no relief looks like. So a plain day reads short, and a hazardous one says so without you adding anything.

For a day other than today the line names the day and gives the 08:00 temperature instead of the current one. A date in the past, or beyond 16 days, is refused - say so rather than guessing.

## Notes

- Sunrise, sunset and the day length are astronomy, not forecast: they are exact, and the `(4m less than yesterday)` comparison is the reason to state them at all.
- A forecast a day ahead is usually within a degree; rain is the shakier half, so treat a rain percentage as a chance and never promise dry weather.
- The script retries a failing provider itself. If it still fails it says so on stderr and sends nothing, so relay that in your own words instead of pretending to know.
- Everything is the place's local time, and every number is rounded for reading. Don't recompute or convert anything.

`{baseDir}` = this skill's directory. Always resolve to the absolute path before executing.
