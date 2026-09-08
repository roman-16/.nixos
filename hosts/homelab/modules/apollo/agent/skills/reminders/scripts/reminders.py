#!/usr/bin/env python3
"""Reminders for Apollo.

Each pending reminder is a JSON file <id>.json under reminders/ in the workspace, which the Apollo
process watches and fires at its time. This script creates, reads, reschedules, and removes them;
firing a due reminder is Apollo's job.

A reminder that fires happened, so Apollo moves it to archive/ with the time it went out and
`list --all` reads it back. One that never fired is nothing to keep, so removing it drops it. A
reminder set, changed or dropped is posted to the user on WhatsApp via the app's localhost hook -
the same "via reminders" channel a fired reminder uses - so the agent never relays it. All time
math happens here, against the real clock.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import sys
import tempfile
import time
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "_shared"))

from apollo import Kind, command, die, run

# Anchored to the workspace rather than the working directory, because where this script is run from
# says nothing about where the user's reminders are - and a spool looked for in the wrong place reads
# exactly like a spool with nothing in it.
WORKSPACE = Path(os.environ.get("APOLLO_WORKSPACE") or Path.home() / "workspace")
REMINDERS_DIR = WORKSPACE / "reminders"

# How many fired reminders `list --all` shows. It stays skimmable, because it can be sent as it is;
# anything older is in the chat archive, which the recall skill searches.
ARCHIVE_LIMIT = 10

UNIT_SECONDS = {"s": 1, "m": 60, "h": 3600, "d": 86400, "w": 604800}
DURATION_PART = re.compile(r"(\d+)([wdhms])")
DURATION_FULL = re.compile(r"(?:\d+[wdhms])+")


def now_ms() -> int:
    return int(time.time() * 1000)


def parse_duration(text: str) -> int:
    """Parse a duration like '90m', '2h', or '1h30m' into milliseconds."""
    cleaned = text.strip().lower().replace(" ", "")
    if not DURATION_FULL.fullmatch(cleaned):
        die(f'invalid duration "{text}" (use e.g. 90m, 2h, 1d, 1h30m)')
    seconds = sum(int(n) * UNIT_SECONDS[u] for n, u in DURATION_PART.findall(cleaned))
    if seconds <= 0:
        die("duration must be positive")
    return seconds * 1000


def parse_at(text: str) -> int:
    """Parse an ISO 8601 local datetime into an epoch-ms timestamp."""
    try:
        return int(datetime.fromisoformat(text.strip()).timestamp() * 1000)
    except ValueError:
        die(f'invalid --at "{text}" (use ISO 8601, e.g. 2026-07-15T09:00)')


def resolve_at(args) -> int:
    """The fire time in epoch-ms from --in or --at (exactly one required)."""
    if args.in_ and args.at:
        die("give either --in or --at, not both")
    if args.in_:
        return now_ms() + parse_duration(args.in_)
    if args.at:
        return parse_at(args.at)
    die("give --in <duration> or --at <ISO datetime>")


def fmt_delta(ms: int) -> str:
    """A relative label like 'in 2h 30m' for a millisecond offset from now."""
    if ms <= 0:
        return "now"
    days, rem = divmod(ms // 1000, 86400)
    hours, rem = divmod(rem, 3600)
    minutes, _ = divmod(rem, 60)
    parts = [f"{n}{u}" for n, u in ((days, "d"), (hours, "h"), (minutes, "m")) if n]
    return "in " + " ".join(parts) if parts else "in <1m"


def fmt_at(at_ms: int) -> str:
    return f"{datetime.fromtimestamp(at_ms / 1000):%Y-%m-%d %H:%M}"


def fmt_when(at_ms: int) -> str:
    return f"{fmt_at(at_ms)} ({fmt_delta(at_ms - now_ms())})"


def path_for(rid: str) -> Path:
    return REMINDERS_DIR / f"{rid}.json"


def archive_dir() -> Path:
    """Where fired reminders live: outside the spool, so what Apollo watches is only live work."""
    return REMINDERS_DIR / "archive"


def read_dir(directory: Path) -> list[dict]:
    out = []
    for path in directory.glob("*.json") if directory.exists() else []:
        try:
            out.append(json.loads(path.read_text()))
        except (json.JSONDecodeError, OSError):
            continue
    return out


def load_all() -> list[dict]:
    """Pending reminders, soonest first."""
    return sorted(read_dir(REMINDERS_DIR), key=lambda r: r.get("at", 0))


def load_archived() -> list[dict]:
    """Fired reminders, newest first - a history is read from its end."""
    return sorted(read_dir(archive_dir()), key=fired_at, reverse=True)


def fired_at(reminder: dict) -> int:
    """When a reminder went out, falling back to when it was due: Apollo completes the archived
    record just after the move that files it away, so between the two only the due time is known."""
    return reminder.get("firedAt") or reminder.get("at", 0)


def write_reminder(reminder: dict):
    REMINDERS_DIR.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=REMINDERS_DIR, prefix=reminder["id"], suffix=".tmp")
    with os.fdopen(fd, "w") as f:
        json.dump(reminder, f)
    os.replace(tmp, path_for(reminder["id"]))


def describe(reminder: dict) -> str:
    return f'[{reminder["id"]}] {reminder["text"]}'


def new_id() -> str:
    """An id no reminder is using and none that fired has used, so a kept record is never overwritten."""
    while True:
        candidate = secrets.token_hex(3)
        if not path_for(candidate).exists() and not (archive_dir() / f"{candidate}.json").exists():
            return candidate


def find_reminder(query: str) -> dict:
    """Resolve a reminder reference by a confidence ladder - exact id, unique id-prefix, then
    a unique case-insensitive text substring - so a reminder can be targeted by the id `list`
    shows or by a word from its text, never needing a pre-check listing. Dies on an ambiguous
    match or a miss (both to stderr, so nothing is sent to the user)."""
    q = query.strip()
    if not q:
        die("give a reminder id or a word from its text")
    reminders = load_all()
    by_id = {r["id"]: r for r in reminders}
    if q in by_id:
        return by_id[q]
    prefixed = [r for r in reminders if r["id"].startswith(q)]
    if len(prefixed) == 1:
        return prefixed[0]
    if len(prefixed) > 1:
        die(f'id "{query}" is ambiguous: {", ".join(describe(r) for r in prefixed)}. Use the full id.')
    matches = [r for r in reminders if q.lower() in r["text"].lower()]
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        die(f'"{query}" matches several reminders: {", ".join(describe(r) for r in matches)}. '
            "Be more specific or use an id (see list).")
    # A reference that only matches a fired reminder is the common confusion: it is still in the
    # chat, so "no reminder matches" would read as a lie. Say what became of it instead.
    fired = [r for r in load_archived()
             if q == r["id"] or q.lower() in r.get("text", "").lower()]
    if fired:
        first = fired[0]
        die(f'"{query}" already fired on {fmt_at(fired_at(first))} - it is archived, '
            f"see list --all. Set a new one with add.")
    die(f'no reminder matches "{query}" - check list.')


def cmd_add(args):
    at = resolve_at(args)
    reminder = {"id": new_id(), "text": args.text, "at": at, "createdAt": now_ms()}
    write_reminder(reminder)
    print(f"✅ Reminder {reminder['id']} set for {fmt_when(at)}: {args.text}")


def cmd_list(args):
    pending = load_all()
    lines = [f"{len(pending)} reminder(s):"] if pending else ["No reminders."]
    lines += [f"- [{r['id']}] {fmt_when(r['at'])}: {r['text']}" for r in pending]
    if args.all:
        archived = load_archived()
        lines.append("")
        if not archived:
            lines.append("Nothing has fired yet.")
        else:
            lines.append(f"Fired ({len(archived)}), newest first:")
            for r in archived[:ARCHIVE_LIMIT]:
                lines.append(f"- [{r['id']}] {fmt_at(fired_at(r))}: {r['text']}")
            if len(archived) > ARCHIVE_LIMIT:
                lines.append(f"… and {len(archived) - ARCHIVE_LIMIT} older.")
    print("\n".join(lines))


def cmd_update(args):
    if args.text is None and not (args.in_ or args.at):
        die("give --text and/or a new time (--in/--at) to change")
    reminder = find_reminder(args.query)
    if args.text is not None:
        reminder["text"] = args.text
    if args.in_ or args.at:
        reminder["at"] = resolve_at(args)
    write_reminder(reminder)
    print(f"✅ Reminder {reminder['id']} updated for {fmt_when(reminder['at'])}: {reminder['text']}")


def cmd_remove(args):
    if args.all:
        reminders = load_all()
        for r in reminders:
            path_for(r["id"]).unlink(missing_ok=True)
        print(f"🗑️ Removed {len(reminders)} reminder(s).")
        return
    if not args.query:
        die("give a reminder id or text, or --all")
    reminder = find_reminder(args.query)
    path_for(reminder["id"]).unlink(missing_ok=True)
    print(f"🗑️ Removed reminder {reminder['id']}: {reminder['text']}")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="reminders.py", description="reminder CRUD")
    sub = p.add_subparsers(dest="cmd", required=True)

    # A reminder set, rescheduled or dropped is a change to what the user is expecting, so it
    # reports to them. The list is the caller's own lookup and reaches them when they asked for it.
    a = command(sub, "add")
    a.set_defaults(func=cmd_add)
    a.add_argument("--text", required=True)
    a.add_argument("--in", dest="in_")
    a.add_argument("--at")

    li = command(sub, "list", kind=Kind.READING)
    li.set_defaults(func=cmd_list)
    li.add_argument("--all", action="store_true", help="also show reminders that have fired")

    u = command(sub, "update")
    u.set_defaults(func=cmd_update)
    u.add_argument("query")
    u.add_argument("--text")
    u.add_argument("--in", dest="in_")
    u.add_argument("--at")

    r = command(sub, "remove")
    r.set_defaults(func=cmd_remove)
    r.add_argument("query", nargs="?")
    r.add_argument("--all", action="store_true")

    return p


def main():
    run("reminders", build_parser(), workspace=WORKSPACE)


if __name__ == "__main__":
    main()
