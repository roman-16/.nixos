#!/usr/bin/env python3
"""Draw a diagram and put it in front of the user.

Mermaid source in, a picture on the user's phone out.

The rendering is deliberately not configurable per call. A diagram that arrives in a chat is looked
at once, on a small screen, probably while walking - so every diagram is drawn the same way: black
on white, one type size, at three times the pixel density so it survives being zoomed into. What
varies between diagrams is what they say, not how large the letters are.

A picture comes out at the size the diagram naturally wants, multiplied by the scale. The width is a
ceiling rather than a target: a diagram wider than it gets squeezed down to fit, taking its lettering
with it, which is why a sideways flowchart arrives as an unreadable strip. Nothing here can fix
that - only drawing it the other way up can - so the shape of the result is measured and reported.

Delivery belongs to the image skill, which owns getting a picture to the user whatever produced it -
so this script owns exactly two things nobody else does: turning source into a PNG, and refusing to
send one that did not render.

Everything printed here is for the agent. The thing the user receives is the picture.
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

# Not resolved: each skill is its own store path on the VM, so following the symlink would land
# outside the skills directory and lose sight of the siblings.
SKILL = Path(__file__).parent.parent
CONFIG = SKILL / "mermaid-config.json"
PUPPETEER = SKILL / "puppeteer.json"

# The image skill, found by name so nothing needs configuring; the override is for a caller that
# invokes this by store path, where siblings do not exist.
IMAGE = Path(os.environ.get("APOLLO_IMAGE_SCRIPT") or SKILL.parent / "image" / "scripts" / "image.py")

# The house style (see the module docstring).
BACKGROUND = "white"
SCALE = 3
WIDTH = 1000

# Past this, one side is so much longer than the other that WhatsApp shows the picture as a stamp
# and it has to be opened before it can be read at all.
MAX_ASPECT = 2.5

# A whole browser has to start before anything is drawn, so the ceiling is generous; a diagram that
# has not rendered in two minutes is not going to.
RENDER_TIMEOUT = 120

# Below this there is no picture in the file, whatever the renderer's exit code claimed.
MIN_PNG_BYTES = 1000

# Uploading a photo to WhatsApp is the slow part, not drawing it. Longer than the image skill's own
# ceiling, so its clearer message wins the race when a send hangs.
DELIVER_TIMEOUT = 240

# A node whose id is `end`: mermaid reads it as the keyword that closes a block, and the parse falls
# apart somewhere else entirely, with a message pointing nowhere near the real problem.
BARE_END = re.compile(r"(?:^|[\s>])end\s*[\[({]", re.MULTILINE)

# A bracket inside an unquoted label: the label ends at the first `]` and the remainder is read as
# syntax. The commonest way a hand-written diagram fails.
UNQUOTED_LABEL = re.compile(r"\[[^\"\]\n]*[()\[][^\"\]\n]*\]")

# Sideways graphs are the main way a diagram arrives unreadable: a phone is tall, not wide.
SIDEWAYS = re.compile(r"^\s*(?:flowchart|graph)\s+(?:LR|RL)\b", re.MULTILINE)


def die(msg: str):
    print(f"error: {msg}", file=sys.stderr)
    raise SystemExit(1)


def png_size(data: bytes):
    """(width, height) from a PNG's header, or None when that is not what this is."""
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR":
        return None
    return int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")


def shape_hint(width: int, height: int):
    """What the finished picture's proportions will cost it in a chat bubble, or None when it will
    arrive readable. Advisory: the picture still goes, because a shape the sender did not intend is
    better than silence."""
    if width <= 0 or height <= 0:
        return None
    if height > width * MAX_ASPECT:
        return (f"this came out {width}x{height}, a long thin column - it will arrive small and have "
                "to be opened to be read. Fewer steps, or split it in two.")
    if width > height * MAX_ASPECT:
        return (f"this came out {width}x{height}, a wide strip - everything in it shrinks to fit the "
                "width of a phone. Draw it top to bottom (`flowchart TD`).")
    return None


def preflight(source: str) -> list:
    """Traps that break a render, or a phone screen, in ways the error message will not explain."""
    hints = []
    if BARE_END.search(source):
        hints.append(
            "a node called `end` closes a block instead of naming a node - rename it (`End`, `done`)"
        )
    if UNQUOTED_LABEL.search(source):
        hints.append('a label containing brackets has to be quoted: A["text (like this)"]')
    if SIDEWAYS.search(source):
        hints.append("this draws left to right, which lands small on a phone - prefer `flowchart TD`")
    return hints


def build_command(source: Path, out: Path) -> list:
    return [
        "mmdc",
        "--input", str(source),
        "--output", str(out),
        "--backgroundColor", BACKGROUND,
        "--width", str(WIDTH),
        "--scale", str(SCALE),
        "--configFile", str(CONFIG),
        "--puppeteerConfigFile", str(PUPPETEER),
        "--quiet",
    ]


def render(source: Path, out: Path):
    try:
        done = subprocess.run(build_command(source, out), capture_output=True, text=True,
                              timeout=RENDER_TIMEOUT, check=False)
    except FileNotFoundError:
        die("the diagram renderer is not installed on this machine - say so rather than improvising")
    except subprocess.TimeoutExpired:
        die(f"the diagram took longer than {RENDER_TIMEOUT}s to draw - simplify it and try again")
    if done.returncode != 0:
        detail = done.stderr.strip() or done.stdout.strip() or "no output"
        die(f"the diagram did not render, so nothing was sent:\n{detail}")
    if not out.exists() or out.stat().st_size < MIN_PNG_BYTES:
        die("the renderer produced no picture, so nothing was sent - check the source")


def deliver(image: Path, caption: str):
    """Hand the picture to the image skill, which knows how to reach the user. Tagged as a diagram,
    so that is what the chat records it as. Returns (delivered, what to print) - its marker, passed
    on exactly as it came."""
    command = [sys.executable, str(IMAGE), "send", str(image), "--source", "diagram"]
    if caption:
        command += ["--caption", caption]
    try:
        done = subprocess.run(command, capture_output=True, text=True,
                              timeout=DELIVER_TIMEOUT, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        return False, f"\n[diagram: the picture could not be sent ({error})]\n"
    if done.stderr.strip():
        sys.stderr.write(done.stderr)
    return done.returncode == 0, done.stdout


def note(hint):
    if hint:
        print(f"[diagram] {hint}")


def cmd_render(args):
    source = Path(args.file)
    if not source.is_file():
        die(f"there is no diagram source at {source} - write it with your write tool first")
    text = source.read_text()
    if not text.strip():
        die(f"{source} is empty - write the mermaid source into it first")
    # Said before the render, because when one of these is the reason it failed, the renderer's own
    # message will not point anywhere near it.
    for hint in preflight(text):
        note(hint)
    # Absolute, because the app resolves the path it is handed against its own working directory.
    out = (Path(args.out) if args.out else Path(tempfile.gettempdir()) / f"{source.stem}.png").resolve()
    render(source, out)
    size = png_size(out.read_bytes()[:24])
    if size:
        note(shape_hint(*size))
    if args.quiet:
        print(f"rendered {out} ({out.stat().st_size} bytes)")
        print("[diagram: quiet - not sent to the user]")
        return
    delivered, marker = deliver(out, args.caption or "")
    sys.stdout.write(marker)
    if not delivered:
        raise SystemExit(1)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="diagram.py", description="draw a diagram and send it")
    sub = p.add_subparsers(dest="cmd", required=True)

    r = sub.add_parser("render")
    r.set_defaults(func=cmd_render)
    r.add_argument("file", help="the file you wrote the mermaid source into")
    r.add_argument("--caption", help="one short line to go under the picture")
    r.add_argument("--out", help="where to write the PNG (default: a temp file named after the source)")
    r.add_argument("--quiet", action="store_true",
                   help="draw and check it here, sending nothing to the user")
    return p


def main():
    args = build_parser().parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
