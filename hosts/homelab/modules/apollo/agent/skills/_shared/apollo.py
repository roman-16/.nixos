"""How a skill reaches the user, and who its output is for.

Every skill on this machine speaks through the same three localhost hooks - a message, a picture, a
file - and echoes the marker the app answers with, so the words the caller reads about a delivery
are the app's own and identical everywhere.

Who the output is for is the other half, and it is a property of the run rather than of the command.
A **receipt** of something that changed is the user's by definition and always goes out. A **reading**
is data the caller needed, and whether the user wants it depends on what they asked - so it stays
here unless --send says otherwise. **Machinery** - an id, a repaired ledger, a stored setting read
back - is never a message at all.

Nothing reaches the user unless it is a receipt or the caller asked for it. That one rule is what
makes a read free: looking something up costs nothing and shows nothing, so it can be run whenever
the answer is needed.

This module lives beside the skills rather than inside one of them, and each script finds it from
its own real location - the same module whether it runs from the repo, from the store path the
agent's skills directory points at, or by path from a timer.
"""

from __future__ import annotations

import argparse
import io
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from contextlib import redirect_stdout
from enum import Enum
from pathlib import Path
from typing import NamedTuple

# A message is text over loopback. A picture and a file have to be uploaded to WhatsApp before the
# hook answers, which is the slow part, and a file is far larger than a picture.
MESSAGE_TIMEOUT = 8
IMAGE_TIMEOUT = 180
FILE_TIMEOUT = 300


class Kind(Enum):
    """Who a command's output is written for (see the module docstring)."""

    MACHINERY = "machinery"
    READING = "reading"
    RECEIPT = "receipt"


def die(msg: str):
    print(f"error: {msg}", file=sys.stderr)
    raise SystemExit(1)


# Notes addressed to the caller rather than the user. What gets delivered is the command's printed
# result, so these are collected during the run and written after it, outside that buffer: same
# stream, never part of what the user receives.
NOTES: list = []


def hint(msg: str):
    """Tell the caller something the user has no reason to read."""
    NOTES.append(msg)


class Delivery(NamedTuple):
    """Whether the user has it, and what to print about that."""

    delivered: bool
    marker: str


def post(skill: str, hook: str, body: str, *, timeout: int, unreachable: str, **query) -> Delivery:
    """POST to the app's localhost hook, which does the sending and answers with the marker to
    print. What the user reads is the body and everything about the delivery is the query. The
    answer is passed on exactly as it came, so a file the app refuses is reported as itself; only
    an app that cannot be reached at all is described in our own words."""
    port = os.environ.get("PORT", "8080")
    parameters = urllib.parse.urlencode({"source": skill, **query})
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/internal/{hook}?{parameters}",
        data=body.encode("utf-8"),
        method="POST",
        headers={"Content-Type": "text/plain; charset=utf-8"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return Delivery(True, response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        return Delivery(False, error.read().decode("utf-8"))
    except Exception as error:
        return Delivery(False, f"\n[{skill}: {unreachable.format(error=error)}]\n")


def send_message(skill: str, text: str) -> Delivery:
    return post(
        skill, "skill-message", text, timeout=MESSAGE_TIMEOUT,
        unreachable="delivery FAILED ({error}) - relay the output above to the user yourself",
    )


def send_image(skill: str, image: Path, caption: str) -> Delivery:
    return post(skill, "skill-image", caption, timeout=IMAGE_TIMEOUT,
                unreachable="could not reach the app to send it ({error})", path=str(image))


def send_file(skill: str, path: Path, caption: str) -> Delivery:
    return post(skill, "skill-file", caption, timeout=FILE_TIMEOUT,
                unreachable="could not reach the app to send it ({error})", path=str(path))


def not_sent(skill: str) -> str:
    """The marker on a result that stayed here. Said explicitly, because without it the caller
    cannot tell a silent run from a sent one - and it names the flag that would have sent it."""
    return f"\n[{skill}: not sent to the user - add --send to deliver it]\n"


def command(sub, name: str, *, kind: Kind = Kind.RECEIPT,
            previews: bool = False) -> argparse.ArgumentParser:
    """Declare a command and who its output is for.

    `previews` marks one that can be asked to change nothing (--dry-run). Such a run produces a
    reading rather than a receipt, so it takes --send like any other reading, and only then.
    """
    parser = sub.add_parser(name)
    parser.set_defaults(kind=kind, dry_run=False, send=False)
    if previews:
        parser.add_argument("--dry-run", action="store_true",
                            help="work out the result and change nothing")
    if kind is Kind.READING or previews:
        parser.add_argument("--send", action="store_true",
                            help="deliver the result to the user as well")
    return parser


def reading(args) -> bool:
    """Whether this run only read: data the caller asked for, with nothing changed by producing it."""
    return args.kind is Kind.READING or args.dry_run


def delivers(args) -> bool:
    """Whether this run's output goes to the user."""
    if args.kind is Kind.MACHINERY:
        return False
    return args.send if reading(args) else True


def run(skill: str, parser: argparse.ArgumentParser, *, workspace: Path | None = None):
    """Run the command the arguments name, and give its output to whoever it was written for.

    The output is captured so it can be delivered as one message, and written to stdout either way,
    so the caller always sees what was sent and can tell a delivered run from a silent one.
    """
    args = parser.parse_args()
    if args.send and args.kind is Kind.RECEIPT and not args.dry_run:
        die("--send only applies with --dry-run - a logged entry always reaches the user")
    if workspace is not None and not workspace.is_dir():
        die(f"no workspace at {workspace} - this is not where the user's data is")
    buffer = io.StringIO()
    try:
        with redirect_stdout(buffer):
            args.func(args)
    finally:
        sys.stdout.write(buffer.getvalue())
    output = buffer.getvalue()
    delivery = None
    if output.strip():
        if delivers(args):
            delivery = send_message(skill, output)
            sys.stdout.write(delivery.marker)
        elif args.kind is not Kind.MACHINERY:
            sys.stdout.write(not_sent(skill))
    while NOTES:
        sys.stdout.write(f"{NOTES.pop(0)}\n")
    # A send that never happened has to fail loudly. A scheduled run has no agent reading the
    # marker and no second chance, and an exit code is what the app logs and forwards.
    if delivery is not None and not delivery.delivered:
        raise SystemExit(1)
