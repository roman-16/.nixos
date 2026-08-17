#!/usr/bin/env python3
"""Files, in both directions.

Sending is the same act as sending a picture - put this in front of the user - so it works the same
way: the file stays a path, the app reads it from this machine, and the marker it answers with says
whether the user has it.

Listing is the other half. A file the user sends lands in a directory of its own, named after the
message that brought it, and that directory empties on a schedule - so what this prints is not an
inventory but a countdown: what is still here, and how long it has left to be moved somewhere that
is actually backed up.
"""

from __future__ import annotations

import argparse
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

# Uploading is the slow part, and a file is far larger than a picture.
DELIVER_TIMEOUT = 300

# Where received files live, and how long they last. Both are read the same way the app reads them,
# so the countdown printed here is the one that actually applies.
FILES_DIR = Path(os.environ.get("APOLLO_FILE_DIR") or Path.home() / "files")
RETENTION_DAYS = int(os.environ.get("APOLLO_FILE_RETENTION_DAYS") or 30)

DAY_SECONDS = 86400


def human_bytes(size: float) -> str:
    for unit, step in (("GB", 1024**3), ("MB", 1024**2)):
        if size >= step:
            return f"{size / step:.1f} {unit}"
    if size >= 1024:
        return f"{round(size / 1024)} KB"
    return f"{round(size)} B"


def deliver(path: Path, caption: str, source: str):
    """POST the file to the app's localhost hook, which sends it on WhatsApp and answers with the
    marker to print. The caption is the body and everything else is the query, exactly as the image
    hook works. Returns (delivered, what to print)."""
    port = os.environ.get("PORT", "8080")
    query = urllib.parse.urlencode({"path": str(path), "source": source})
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/internal/skill-file?{query}",
        data=caption.encode("utf-8"),
        method="POST",
        headers={"Content-Type": "text/plain; charset=utf-8"},
    )
    try:
        with urllib.request.urlopen(request, timeout=DELIVER_TIMEOUT) as response:
            return True, response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        return False, error.read().decode("utf-8")
    except Exception as error:
        return False, f"\n[{source}: could not reach the app to send it ({error})]\n"


def cmd_send(args):
    # Absolute, because the app resolves whatever path it is handed against its own directory.
    path = Path(args.file).expanduser().resolve()
    delivered, marker = deliver(path, args.caption or "", args.source)
    sys.stdout.write(marker)
    if not delivered:
        raise SystemExit(1)


def received() -> list:
    """Every file the user has sent that is still on this machine, newest first. One directory per
    file, holding it under its own name - anything else in there is not a file that arrived."""
    out = []
    if not FILES_DIR.is_dir():
        return out
    for holder in FILES_DIR.iterdir():
        if not holder.is_dir():
            continue
        for path in holder.iterdir():
            if path.is_file():
                out.append((path, path.stat()))
    return sorted(out, key=lambda entry: entry[1].st_mtime, reverse=True)


def left(mtime: float) -> str:
    days = RETENTION_DAYS - int((datetime.now().timestamp() - mtime) // DAY_SECONDS)
    if days <= 0:
        return "deleted in the next sweep"
    return f"{days} day{'' if days == 1 else 's'} left"


def cmd_list(args):
    files = received()
    if not files:
        print(f"No files from the user are on this machine ({FILES_DIR}).")
        return
    print(f"{len(files)} file(s) the user sent, newest first:")
    for path, stat in files:
        when = datetime.fromtimestamp(stat.st_mtime).strftime("%a %d.%m %H:%M")
        print(f"- {path.name}  {human_bytes(stat.st_size)}  {when}  ({left(stat.st_mtime)})")
        print(f"  {path}")
    print("\n[files: anything worth keeping has to be moved to the workspace or the vault]")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="files.py", description="send a file, or see the ones received")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("send")
    s.set_defaults(func=cmd_send)
    s.add_argument("file", help="the file to send")
    s.add_argument("--caption", help="one short line to go under it")
    s.add_argument("--source", default="files",
                   help='what the chat records it as: "via files", ...')

    li = sub.add_parser("list")
    li.set_defaults(func=cmd_list)

    return p


def main():
    args = build_parser().parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
