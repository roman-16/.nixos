#!/usr/bin/env python3
"""The briefing: one message with the shape of the current day.

A timer sends this once a day, with nobody watching. It owns no data of its own - the sky belongs to the weather skill,
the offers to the offers skill, the calendar to Proton - so all it does is ask each of them for
text and post the result once. A read is silent everywhere until it is asked to send, which is what
makes one message out of four sources possible.

Two rules decide what appears. A section speaks when it has something to say, or when it broke:
emptiness needs no words, so a day with no events and no offers is just the sky. And a failure
always gets a line, because saying nothing about the weather is indistinguishable from a clear
sky, and a missing calendar would look exactly like a free day.

The calendar it speaks for is the default one, where new events land, because a briefing is for what
the day asks of its reader and not for every calendar they can see - a holiday feed and a habit
tracker between them would bury the appointments. Which calendar that is comes from the account, so
there is nothing to configure and nothing to keep in step. An event that runs across several days
comes back whole, so what the day sees of it - whether it is on the day at all, and which of its
hours are - is worked out here.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "_shared"))

from apollo import Kind, command, run

# Sibling skills, found by name from this file's real location, so they are the same scripts whether
# this runs from the agent's skills directory or by path from a timer.
SKILLS = Path(__file__).resolve().parents[2]
WEATHER = SKILLS / "weather" / "scripts" / "weather.py"
OFFERS = SKILLS / "offers" / "scripts" / "offers.py"

WEATHER_TIMEOUT = 60
OFFERS_TIMEOUT = 90
CALENDAR_TIMEOUT = 60

# The user's timezone, named explicitly rather than taken from the host: every hour the briefing
# prints comes from a timestamp in whichever zone the provider chose, so the conversion that makes it
# readable must not depend on where this runs.
TZ = ZoneInfo("Europe/Vienna")

# Notes a skill addresses to its caller. They are never part of what the user reads.
MARKER = re.compile(r"^\[[a-z][a-z-]*[:\]]")


def strip_markers(text: str) -> str:
    """A sibling's printed result, without the notes it addressed to whoever ran it."""
    kept = [line for line in text.splitlines() if not MARKER.match(line.strip())]
    return "\n".join(kept).strip()


def output_of(argv: list, timeout: int) -> str | None:
    """The command's output, or None when it failed. A section that cannot be produced is reported
    as unavailable rather than left out, so nothing is ever quietly missing."""
    try:
        done = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        print(f"{argv[0]}: {error}", file=sys.stderr)
        return None
    if done.returncode != 0:
        print(f"{argv[0]} exited {done.returncode}: {done.stderr.strip()[:400]}", file=sys.stderr)
        return None
    return strip_markers(done.stdout)


# --- sections ------------------------------------------------------------


def fetch_sky() -> str | None:
    return output_of([sys.executable, str(WEATHER), "show"], WEATHER_TIMEOUT)


def fetch_offers() -> str | None:
    return output_of([sys.executable, str(OFFERS), "digest"], OFFERS_TIMEOUT)


def calendar_window(day: date) -> tuple:
    """The range that means "this day": both ends name the day itself, since --end is the last day
    included. Everything overlapping the day comes back, a multi-day event among them, carrying the
    start and end of the whole event rather than of the part that falls on the day."""
    return day.isoformat(), day.isoformat()


def read_events(out: str) -> list | None:
    """The events in a listing, or None when the reply is not one. Every proton collection comes
    back as an envelope keyed by its plural name, so an empty day is [] and None means the calendar
    could not be read - a distinction the briefing reports differently."""
    try:
        payload = json.loads(out or "{}")
    except json.JSONDecodeError as error:
        print(f"proton returned unreadable json: {error}", file=sys.stderr)
        return None
    events = payload.get("events") if isinstance(payload, dict) else None
    return events if isinstance(events, list) else None


def moment(value) -> datetime | None:
    try:
        return datetime.fromisoformat(str(value))
    except (TypeError, ValueError):
        return None


def local(when: datetime) -> datetime:
    """A timestamp on the user's clock. An hour means nothing until it is read in the zone the reader
    lives in - 14:00Z is a 16:00 appointment - and a timestamp arrives in whichever zone its source
    was anchored to, so the conversion happens here rather than being assumed."""
    return when.astimezone(TZ) if when.tzinfo else when.replace(tzinfo=TZ)


def event_days(event: dict) -> tuple | None:
    """The first and last day an event is on, or None when its start cannot be read.

    An event is on at least the day it starts, and on every day up to the last instant still inside
    it. An end is the moment the event stops rather than a day it reaches into, so an end at midnight
    belongs to the day before.
    """
    start = moment(event.get("start"))
    if start is None:
        return None
    end = moment(event.get("end"))
    # An all-day event names dates rather than instants, so its timestamps are read as written: moving
    # a midnight marker between zones is what turns one day into another.
    if not event.get("all_day"):
        start = local(start)
        end = local(end) if end else None
    first = start.date()
    if end is None:
        return first, first
    # The end is the moment the event stops, so a midnight end is not a day the event reaches into:
    # the last day is the one holding the last instant still inside it. That reads an all-day event
    # and one that runs to midnight alike, and cannot stretch a single day over two.
    return first, max(first, (end - timedelta(microseconds=1)).date())


def covers(event: dict, day: date) -> bool:
    """Whether an event is on this day at all. A multi-day event arrives whole, and the day an hour
    belongs to is a matter of the zone it is read in rather than of the timestamp as written, so
    membership is settled here. An event whose start cannot be read is on no day: printing it under
    today would be a guess, and a guess is what fills a briefing with other days' events."""
    span = event_days(event)
    if span is None:
        print(f"skipping an event with an unreadable start: {event.get('title')!r}", file=sys.stderr)
        return False
    return span[0] <= day <= span[1]


def default_calendar() -> str | None:
    """The calendar the briefing speaks for: the one new events land in. Read from the account rather
    than configured, so it follows the account when it changes and there is nothing to set up."""
    out = output_of(["proton", "calendar", "settings", "get", "--output", "json", "--quiet"],
                    CALENDAR_TIMEOUT)
    if out is None:
        return None
    try:
        payload = json.loads(out or "{}")
    except json.JSONDecodeError as error:
        print(f"proton returned unreadable json: {error}", file=sys.stderr)
        return None
    calendar = payload.get("default_calendar") if isinstance(payload, dict) else None
    return calendar if isinstance(calendar, str) and calendar else None


def fetch_events(day: date) -> list | None:
    """What is on the day in the default calendar, or None when the calendar could not be read - a
    distinction the briefing reports rather than passing off as a free day."""
    calendar = default_calendar()
    if calendar is None:
        return None
    start, end = calendar_window(day)
    out = output_of(["proton", "calendar", "events", "list", "--start", start, "--end", end,
                     "--calendar", calendar, "--output", "json", "--quiet"], CALENDAR_TIMEOUT)
    if out is None:
        return None
    events = read_events(out)
    return None if events is None else [event for event in events if covers(event, day)]


def event_when(event: dict, day: date) -> str:
    """When an event happens, as the day sees it and on the user's clock. An event that runs past
    midnight at either end is described by the part that falls on this day, not by a time on another
    one."""
    if event.get("all_day"):
        return "all day"
    start, end = moment(event.get("start")), moment(event.get("end"))
    if start is None:
        return "all day"
    start = local(start)
    end = local(end) if end else None
    spans_before = start.date() < day
    spans_after = end is not None and end.date() > day
    if spans_before and spans_after:
        return "all day"
    if spans_before:
        return f"until {end:%H:%M}" if end else "all day"
    if spans_after:
        return f"from {start:%H:%M}"
    if end is None or end == start:
        return f"{start:%H:%M}"
    return f"{start:%H:%M}-{end:%H:%M}"


def event_sort_key(event: dict) -> tuple:
    """All-day first, then by start time: the day's fixed frame before its appointments."""
    start = moment(event.get("start"))
    return (1 if not event.get("all_day") else 0, start.isoformat() if start else "")


def event_line(event: dict, day: date) -> str:
    title = (event.get("title") or "").strip() or "(untitled)"
    location = (event.get("location") or "").strip()
    where = f" · {location}" if location else ""
    return f"  {event_when(event, day):<11}  {title}{where}"


def calendar_block(events: list, day: date) -> str:
    lines = ["📅 Today"]
    lines += [event_line(event, day) for event in sorted(events, key=event_sort_key)]
    return "\n".join(lines)


# --- composition ---------------------------------------------------------


def compose(day: date, sky: str | None, events: list | None, offers: str | None) -> str:
    """The message. `None` means a section could not be produced and says so; empty means there
    was nothing to say and is left out entirely."""
    blocks = [f"*{day:%A %d.%m}*"]
    blocks.append(sky.strip() if sky else "🌡️ Weather unavailable right now.")
    if events is None:
        blocks.append("📅 Calendar unavailable right now.")
    elif events:
        blocks.append(calendar_block(events, day))
    if offers is None:
        blocks.append("🏷️ Offers unavailable right now.")
    elif offers:
        blocks.append(offers.strip())
    return "\n\n".join(blocks)


def cmd_show(args):
    day = date.today()
    print(compose(day, fetch_sky(), fetch_events(day), fetch_offers()))


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="briefing.py", description="the day's briefing")
    sub = p.add_subparsers(dest="cmd", required=True)
    # A briefing is composed rather than kept, so composing one changes nothing: the timer asks for
    # it to be sent, and anyone checking what it would say reads it here.
    command(sub, "show", kind=Kind.READING).set_defaults(func=cmd_show)
    return p


def main():
    run("briefing", build_parser())


if __name__ == "__main__":
    main()
