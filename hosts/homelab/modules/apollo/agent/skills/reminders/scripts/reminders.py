#!/usr/bin/env python3
"""Reminder CRUD for Apollo.

Each reminder is a JSON file <id>.json in the spool directory (APOLLO_REMINDERS_DIR,
default <workspace>/reminders) that the Apollo process watches and fires at its time. This
script creates, reads, updates, and deletes those files; firing a due reminder is Apollo's
job. Every command posts its own output to the user on WhatsApp via the app's localhost
hook - the same "via reminders" channel a fired reminder uses - so the agent never relays
it. All time math happens here, against the real clock.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import re
import secrets
import sys
import tempfile
import time
import urllib.request
from contextlib import redirect_stdout
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


def describe(reminder: dict) -> str:
    return f'[{reminder["id"]}] {reminder["text"]}'


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
    die(f'no reminder matches "{query}" - check list.')


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

    a = sub.add_parser("add")
    a.set_defaults(func=cmd_add)
    a.add_argument("--text", required=True)
    a.add_argument("--in", dest="in_")
    a.add_argument("--at")

    sub.add_parser("list").set_defaults(func=cmd_list)

    u = sub.add_parser("update")
    u.set_defaults(func=cmd_update)
    u.add_argument("query")
    u.add_argument("--text")
    u.add_argument("--in", dest="in_")
    u.add_argument("--at")

    r = sub.add_parser("remove")
    r.set_defaults(func=cmd_remove)
    r.add_argument("query", nargs="?")
    r.add_argument("--all", action="store_true")

    return p


def deliver_to_user(text: str) -> bool:
    """POST the reply to the app's localhost hook, which sends it to the user on WhatsApp. Returns
    True on success; on any failure the caller lets the agent relay the output instead."""
    port = os.environ.get("PORT", "8080")
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/internal/skill-message?source=reminders",
        data=text.encode("utf-8"),
        method="POST",
        headers={"Content-Type": "text/plain; charset=utf-8"},
    )
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            return 200 <= response.status < 300
    except Exception:
        return False


def main():
    args = build_parser().parse_args()
    # Capture the command's output so it can be delivered to the user directly, while still writing
    # it to stdout so the agent sees it (for its reasoning and to detect delivery success/failure).
    buffer = io.StringIO()
    try:
        with redirect_stdout(buffer):
            args.func(args)
    finally:
        sys.stdout.write(buffer.getvalue())
    output = buffer.getvalue()
    if output.strip():
        sent = deliver_to_user(output)
        sys.stdout.write(
            "\n[reminders: delivered to the user \u2713 - do not relay]\n"
            if sent
            else "\n[reminders: delivery FAILED - relay the output above to the user yourself]\n"
        )


if __name__ == "__main__":
    main()
