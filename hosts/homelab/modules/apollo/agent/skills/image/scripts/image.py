#!/usr/bin/env python3
"""Put a picture in front of the user.

A file on this machine goes out as a photo on WhatsApp. That is the whole of it: the app owns the
sending, and this is how anything on this side asks for it - the agent by hand, or another skill
that has just produced a picture and needs it delivered.

The picture stays a path. Whatever drew, downloaded or extracted it wrote it to this same machine,
and the app reads it from there, so there is nothing to encode over a loopback hop.

Nothing here judges whether the file can be sent. The app checks its size, its format and its
dimensions when it reads it, and answers with the reason when it cannot - one authority on that
question rather than two that can disagree.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "_shared"))

from apollo import send_image


def cmd_send(args):
    # Absolute, because the app resolves whatever path it is handed against its own directory.
    picture = Path(args.file).expanduser().resolve()
    delivery = send_image("image", picture, args.caption or "")
    sys.stdout.write(delivery.marker)
    if not delivery.delivered:
        raise SystemExit(1)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="image.py", description="send an image to the user")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("send")
    s.set_defaults(func=cmd_send)
    s.add_argument("file", help="the image to send")
    s.add_argument("--caption", help="one short line to go under it")
    return p


def main():
    args = build_parser().parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
