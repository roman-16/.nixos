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
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

# Uploading a photo is the slow part; drawing or finding it already happened.
DELIVER_TIMEOUT = 180


def deliver(image: Path, caption: str, source: str):
    """POST the picture to the app's localhost hook, which sends it on WhatsApp and answers with the
    marker to print. The caption is the body and everything else is the query, exactly as the hook's
    text sibling works. Returns (delivered, what to print)."""
    port = os.environ.get("PORT", "8080")
    query = urllib.parse.urlencode({"path": str(image), "source": source})
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/internal/skill-image?{query}",
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
    image = Path(args.file).expanduser().resolve()
    delivered, marker = deliver(image, args.caption or "", args.source)
    sys.stdout.write(marker)
    if not delivered:
        raise SystemExit(1)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="image.py", description="send an image to the user")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("send")
    s.set_defaults(func=cmd_send)
    s.add_argument("file", help="the image to send")
    s.add_argument("--caption", help="one short line to go under it")
    s.add_argument("--source", default="image",
                   help='what the chat records it as: "via image", "via diagram", ...')
    return p


def main():
    args = build_parser().parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
