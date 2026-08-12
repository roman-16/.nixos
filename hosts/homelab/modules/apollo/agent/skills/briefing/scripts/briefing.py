#!/usr/bin/env python3
"""The briefing: one message with the shape of the current day.

A timer sends this once a day, with nobody watching. It owns no data of its own - the sky belongs to the weather skill,
the offers to the offers skill, the calendar to Proton - so all it does is ask each of them for
text and post the result once. Each provider already knows how to print instead of send (that is
what --quiet means everywhere), which is what makes one message out of four sources possible.

Two rules decide what appears. A section speaks when it has something to say, or when it broke:
emptiness needs no words, so a day with no events and no offers is just the sky. And a failure
always gets a line, because saying nothing about the weather is indistinguishable from a clear
sky, and a missing calendar would look exactly like a free day.

The calendar it speaks for is the default one, where new events land, because a briefing is for what
the day asks of its reader and not for every calendar they can see - a holiday feed and a habit
tracker between them would bury the appointments. Which calendar that is comes from the account, so
there is nothing to configure and nothing to keep in step. What day an event is on is decided here
rather than taken from the provider's range, which overlaps generously at both ends.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from contextlib import redirect_stdout
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

# Sibling skills, found by name so the agent needs no configuration; the systemd job invokes store
# paths, where siblings do not exist, so it passes these explicitly.
SKILLS = Path(__file__).parent.parent.parent
WEATHER = Path(os.environ.get("APOLLO_WEATHER_SCRIPT") or SKILLS / "weather" / "scripts" / "weather.py")
OFFERS = Path(os.environ.get("APOLLO_OFFERS_SCRIPT") or SKILLS / "offers" / "scripts" / "offers.py")

WEATHER_TIMEOUT = 60
OFFERS_TIMEOUT = 90
CALENDAR_TIMEOUT = 60

# The user's timezone, named explicitly rather than taken from the host: every hour the briefing
# prints comes from a timestamp in whichever zone the provider chose, so the conversion that makes it
# readable must not depend on where this runs.
TZ = ZoneInfo("Europe/Vienna")

# Notes a skill addresses to its caller. They are never part of what the user reads.
MARKER = re.compile(r"^\[[a-z][a-z-]*[:\]]")


def die(msg: str):
    print(f"error: {msg}", file=sys.stderr)
    raise SystemExit(1)


def strip_markers(text: str) -> str:
    """A sibling's printed result, without the notes it addressed to whoever ran it."""
    kept = [line for line in text.splitlines() if not MARKER.match(line.strip())]
    return "\n".join(kept).strip()


def run(command: list, timeout: int) -> str | None:
    """The command's output, or None when it failed. A section that cannot be produced is reported
    as unavailable rather than left out, so nothing is ever quietly missing."""
    try:
        done = subprocess.run(command, capture_output=True, text=True, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        print(f"{command[0]}: {error}", file=sys.stderr)
        return None
    if done.returncode != 0:
        print(f"{command[0]} exited {done.returncode}: {done.stderr.strip()[:400]}", file=sys.stderr)
        return None
    return strip_markers(done.stdout)


# --- sections ------------------------------------------------------------


def fetch_sky() -> str | None:
    return run([sys.executable, str(WEATHER), "show", "--quiet"], WEATHER_TIMEOUT)


def fetch_offers() -> str | None:
    return run([sys.executable, str(OFFERS), "digest", "--quiet"], OFFERS_TIMEOUT)


def calendar_window(day: date) -> tuple:
    """The range that means "this day": both ends name the day itself, since --end is the last day
    included. It is only ever a request - the reply carries whatever overlaps it, and a day past it -
    so what is on the day is settled by covers() rather than by the range."""
    return day.isoformat(), day.isoformat()


def read_events(out: str) -> list | None:
    """The events in a listing, or None when the reply is not one. Every proton-cli collection comes
    back as an envelope keyed by its plural name, so an empty day is [] and None means the calendar
    could not be read - a distinction the briefing reports differently."""
    try:
        payload = json.loads(out or "{}")
    except json.JSONDecodeError as error:
        print(f"proton-cli returned unreadable json: {error}", file=sys.stderr)
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

    An all-day event's end is the midnight it stops at, so its last day is the day before that -
    except where the provider repeats the start instead, which is the other convention in the same
    account (a recurring "Piano" ends where it starts; a public holiday ends the next midnight).
    Taking the later of the two readings satisfies both without stretching a one-day event over two.
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
    """Whether an event is on this day at all. This is what decides membership, because the range the
    provider was asked for is not the range it answers with. An event whose start cannot be read is on
    no day: printing it under today would be a guess, and a guess is what fills a briefing with other
    days' events."""
    span = event_days(event)
    if span is None:
        print(f"skipping an event with an unreadable start: {event.get('title')!r}", file=sys.stderr)
        return False
    return span[0] <= day <= span[1]


def default_calendar() -> str | None:
    """The calendar the briefing speaks for: the one new events land in. Read from the account rather
    than configured, so it follows the account when it changes and there is nothing to set up."""
    out = run(["proton-cli", "calendar", "settings", "get", "--output", "json", "--quiet"],
              CALENDAR_TIMEOUT)
    if out is None:
        return None
    try:
        payload = json.loads(out or "{}")
    except json.JSONDecodeError as error:
        print(f"proton-cli returned unreadable json: {error}", file=sys.stderr)
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
    out = run(["proton-cli", "calendar", "events", "list", "--start", start, "--end", end,
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


# --- delivery ------------------------------------------------------------


def deliver_to_user(text: str) -> str | None:
    """POST the reply to the app's localhost hook, which delivers it to the user on WhatsApp and
    returns the marker to print. Returns the response body (the marker); None only if the app
    could not be reached at all - the one case the caller falls back for."""
    port = os.environ.get("PORT", "8080")
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/internal/skill-message?source=briefing",
        data=text.encode("utf-8"),
        method="POST",
        headers={"Content-Type": "text/plain; charset=utf-8"},
    )
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            return response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        return error.read().decode("utf-8")
    except Exception:
        return None


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="briefing.py", description="the day's briefing")
    sub = p.add_subparsers(dest="cmd", required=True)
    sh = sub.add_parser("show")
    sh.set_defaults(func=cmd_show)
    sh.add_argument("--quiet", action="store_true",
                    help="print the briefing here instead of sending it to the user")
    return p


def main():
    args = build_parser().parse_args()
    # Capture the output so it can be delivered to the user directly, while still writing it to
    # stdout so the caller sees it (for its reasoning and to detect delivery success/failure).
    buffer = io.StringIO()
    try:
        with redirect_stdout(buffer):
            args.func(args)
    finally:
        sys.stdout.write(buffer.getvalue())
    output = buffer.getvalue()
    if not output.strip():
        return
    if args.quiet:
        # Say so explicitly: without a marker the caller cannot tell a silent run from a sent one.
        sys.stdout.write("\n[briefing: quiet - not sent to the user]\n")
        return
    marker = deliver_to_user(output)
    if marker is not None:
        sys.stdout.write(marker)
        return
    # The timer runs this with nobody watching, so a send that never happened has to fail loudly.
    sys.stdout.write("\n[briefing: delivery FAILED - relay the output above to the user yourself]\n")
    raise SystemExit(1)


if __name__ == "__main__":
    main()
