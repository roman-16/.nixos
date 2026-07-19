#!/usr/bin/env python3
"""Reminder CRUD for Apollo.

Each reminder is a JSON file <id>.json in the spool directory (APOLLO_REMINDERS_DIR,
default <workspace>/reminders) that the Apollo process watches and fires at its time. This
script only creates, reads, updates, and deletes those files; the firing and WhatsApp
delivery are Apollo's job. All time math happens here, against the real clock.
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

_DEFAULT_DIR = Path(os.environ.get("APOLLO_WORKSPACE") or os.getcwd()) / "reminders"
REMINDERS_DIR = Path(os.environ.get("APOLLO_REMINDERS_DIR") or _DEFAULT_DIR)

UNIT_SECONDS = {"s": 1, "m": 60, "h": 3600, "d": 86400, "w": 604800}
DURATION_PART = re.compile(r"(\d+)([wdhms])")
DURATION_FULL = re.compile(r"(?:\d+[wdhms])+")


def die(msg: str):
    print(f"error: {msg}", file=sys.stderr)
    raise SystemExit(1)


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


def fmt_when(at_ms: int) -> str:
    when = datetime.fromtimestamp(at_ms / 1000)
    return f"{when:%Y-%m-%d %H:%M} ({fmt_delta(at_ms - now_ms())})"


def path_for(rid: str) -> Path:
    return REMINDERS_DIR / f"{rid}.json"


def load_all() -> list[dict]:
    out = []
    for path in REMINDERS_DIR.glob("*.json") if REMINDERS_DIR.exists() else []:
        try:
            out.append(json.loads(path.read_text()))
        except (json.JSONDecodeError, OSError):
            continue
    out.sort(key=lambda r: r.get("at", 0))
    return out


def write_reminder(reminder: dict):
    REMINDERS_DIR.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=REMINDERS_DIR, prefix=reminder["id"], suffix=".tmp")
    with os.fdopen(fd, "w") as f:
        json.dump(reminder, f)
    os.replace(tmp, path_for(reminder["id"]))


def cmd_add(args):
    at = resolve_at(args)
    reminder = {"id": secrets.token_hex(3), "text": args.text, "at": at, "createdAt": now_ms()}
    write_reminder(reminder)
    print(f"✅ Reminder {reminder['id']} set for {fmt_when(at)}: {args.text}")


def cmd_list(args):
    reminders = load_all()
    if not reminders:
        print("No reminders.")
        return
    print(f"{len(reminders)} reminder(s):")
    for r in reminders:
        print(f"- [{r['id']}] {fmt_when(r['at'])}: {r['text']}")


def cmd_update(args):
    path = path_for(args.id)
    if not path.exists():
        die(f'no reminder with id "{args.id}"')
    reminder = json.loads(path.read_text())
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
    if not args.id:
        die("give --id <id> or --all")
    if not path_for(args.id).exists():
        die(f'no reminder with id "{args.id}"')
    path_for(args.id).unlink(missing_ok=True)
    print(f"🗑️ Removed reminder {args.id}.")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="reminders.py", description="reminder CRUD")
    sub = p.add_subparsers(dest="cmd", required=True)

    a = sub.add_parser("add")
    a.set_defaults(func=cmd_add)
    a.add_argument("--text", required=True)
    a.add_argument("--in", dest="in_")
    a.add_argument("--at")

    sub.add_parser("list").set_defaults(func=cmd_list)

    u = sub.add_parser("update")
    u.set_defaults(func=cmd_update)
    u.add_argument("--id", required=True)
    u.add_argument("--text")
    u.add_argument("--in", dest="in_")
    u.add_argument("--at")

    r = sub.add_parser("remove")
    r.set_defaults(func=cmd_remove)
    r.add_argument("--id")
    r.add_argument("--all", action="store_true")

    return p


def main():
    args = build_parser().parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
