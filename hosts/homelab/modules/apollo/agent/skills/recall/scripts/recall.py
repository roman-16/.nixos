#!/usr/bin/env python3
"""Search Apollo's WhatsApp history.

Builds a throwaway in-memory FTS5 index over the messages that actually appeared in the
WhatsApp chat - what the user sent (typed text, voice-note transcripts, image captions),
Apollo's text replies, and the "via <skill>" messages that were delivered - and answers
keyword searches over it. Apollo's internal machinery (thinking blocks, tool calls and
their output, compaction summaries) is never indexed.

The chat archive is the app's SQLite database (read-only, $APOLLO_DB_PATH). This script
never writes to it and keeps no index of its own: the index is rebuilt for each query and
discarded, so there is nothing to stay in sync or back up. Output is for Apollo to read -
it is not sent to the user.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sqlite3
import sys
import tempfile
from datetime import datetime

EXT = {"image/gif": "gif", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}

# Results are read by Apollo, so the cost that matters is the context one call consumes. That is a
# property of the call, not of any single message, so the whole call is budgeted and messages arrive
# whole - a clipped message is worse than a missing one, because it looks complete.
OUTPUT_BUDGET = 20_000

# How much of a message a scanning view shows before it is trimmed.
SCAN_CHARS = 200


def die(msg: str):
    print(f"error: {msg}", file=sys.stderr)
    raise SystemExit(1)


def db_path() -> str:
    p = os.environ.get("APOLLO_DB_PATH")
    if not p:
        die("APOLLO_DB_PATH is not set")
    if not os.path.exists(p):
        die("no chat database yet - nothing to recall")
    return p


def connect() -> sqlite3.Connection:
    con = sqlite3.connect(f"file:{db_path()}?mode=ro", uri=True)
    con.execute("PRAGMA busy_timeout = 5000")
    return con


def rows(con: sqlite3.Connection, order: str, where: str = "", params=()):
    clause = f" WHERE {where}" if where else ""
    try:
        return con.execute(f"SELECT id, time, data FROM chat{clause} ORDER BY id {order}", params)
    except sqlite3.OperationalError:
        die("no chat history yet")


# --- extraction: one stored chat row -> a WhatsApp-visible line, or None ---------

def text_of(content) -> str:
    """The plain text of a message's content - a bare string, or the text blocks joined."""
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        return " ".join(
            b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"
        ).strip()
    return ""


def image_count(content) -> int:
    if isinstance(content, list):
        return sum(1 for b in content if isinstance(b, dict) and b.get("type") == "image")
    return 0


def visible(data: str):
    """(who, text, images) for a message that appeared in WhatsApp, else None. Internal
    entries - assistant thinking, tool results, bash, compaction, reload markers - return
    None, and an assistant turn's thinking blocks are dropped by only reading text blocks."""
    try:
        entry = json.loads(data)
    except (json.JSONDecodeError, TypeError):
        return None
    kind = entry.get("type")
    if kind == "message":
        message = entry.get("message") or {}
        role = message.get("role")
        content = message.get("content")
        if role == "user":
            return "You", text_of(content), image_count(content)
        if role == "assistant":
            text = text_of(content)
            return ("Apollo", text, 0) if text else None
        return None  # toolResult / bashExecution never reached WhatsApp
    if kind == "custom" and entry.get("customType") == "skill_message":
        data_field = entry.get("data") or {}
        return f"Apollo (via {data_field.get('source') or 'skill'})", (data_field.get("text") or "").strip(), 0
    return None  # compaction / branch_summary / apollo_reload


def images_of(data: str):
    """The (mimeType, base64) of every image block on a message row."""
    try:
        entry = json.loads(data)
    except (json.JSONDecodeError, TypeError):
        return []
    content = (entry.get("message") or {}).get("content") if entry.get("type") == "message" else None
    if not isinstance(content, list):
        return []
    return [
        (b.get("mimeType") or "image/jpeg", b["data"])
        for b in content
        if isinstance(b, dict) and b.get("type") == "image" and b.get("data")
    ]


# --- formatting ------------------------------------------------------------------

def parse_day(value: str) -> datetime:
    try:
        return datetime.strptime(value.strip(), "%Y-%m-%d")
    except ValueError:
        die(f'invalid date "{value}" (use YYYY-MM-DD)')


def when(ms) -> str:
    return datetime.fromtimestamp(ms / 1000).strftime("%Y-%m-%d %H:%M") if ms else "??"


def marker(images: int) -> str:
    return f" [{images} image{'s' if images > 1 else ''}]" if images else ""


def trim(text: str, limit: int = SCAN_CHARS) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[:limit] + "…"


def body(text: str, full: bool) -> str:
    """A message as it should appear: whole when reading, trimmed when scanning."""
    return text if full else trim(text)


def emit(lines, tail: str = ""):
    """Print within the call's budget. Stops on a whole message and says what it left out, so a
    query that is too broad is visibly too broad rather than quietly incomplete."""
    used = 0
    shown = 0
    for line in lines:
        if used + len(line) > OUTPUT_BUDGET:
            break
        print(line)
        used += len(line) + 1
        shown += 1
    if shown < len(lines):
        print(f"… capped at {shown} of {len(lines)} messages - narrow it with --since/--until, "
              "a smaller --limit, or fewer --ids.")
    elif tail:
        print(tail)


def time_clause(args):
    where, params = [], []
    if getattr(args, "since", None):
        where.append("time >= ?")
        params.append(int(parse_day(args.since).timestamp() * 1000))
    if getattr(args, "until", None):
        where.append("time < ?")
        params.append(int((parse_day(args.until).timestamp() + 86400) * 1000))
    return " AND ".join(where), params


# --- commands --------------------------------------------------------------------

def cmd_search(args):
    con = connect()
    where, params = time_clause(args)
    mem = sqlite3.connect(":memory:")
    mem.execute(
        "CREATE VIRTUAL TABLE fts USING fts5(txt, cid UNINDEXED, t UNINDEXED, "
        "who UNINDEXED, img UNINDEXED, tokenize='porter unicode61')"
    )
    batch = []
    for cid, tm, data in rows(con, "ASC", where, params):
        seen = visible(data)
        if not seen:
            continue
        who, text, images = seen
        if not text:
            continue  # e.g. an uncaptioned image: reachable via recent/show, not keyword search
        batch.append((text, cid, tm or 0, who, images))
        if len(batch) >= 5000:
            mem.executemany("INSERT INTO fts(txt,cid,t,who,img) VALUES (?,?,?,?,?)", batch)
            batch = []
    if batch:
        mem.executemany("INSERT INTO fts(txt,cid,t,who,img) VALUES (?,?,?,?,?)", batch)

    try:
        # Relevance always decides *which* messages come back, so --limit keeps meaning "the best N";
        # --sort only decides the order they are read in.
        hits = mem.execute(
            "SELECT cid, t, who, img, snippet(fts, 0, '«', '»', '…', 14), txt "
            "FROM fts WHERE fts MATCH ? ORDER BY bm25(fts) LIMIT ?",
            (args.query, args.limit),
        ).fetchall()
    except sqlite3.OperationalError as error:
        die(f'bad search "{args.query}" ({error}). Use plain words, OR, "a phrase", or prefix*.')

    if not hits:
        print(f'No WhatsApp messages match "{args.query}". Try broader or different keywords '
              "(synonyms, OR, a prefix*).")
        return
    chronological = args.sort == "time"
    if chronological:
        hits = sorted(hits, key=lambda h: h[1])
    order = "oldest first" if chronological else "most relevant first"
    print(f'Top {len(hits)} match(es) for "{args.query}" ({order}):')
    lines = [
        f"[#{cid}] {when(tm)} · {who}: {text if args.full else snip}{marker(img)}"
        for cid, tm, who, img, snip, text in hits
    ]
    emit(lines, "→ `show --ids <#>` for the full message and its context; `image --id <#>` to view an image.")


def cmd_recent(args):
    con = connect()
    where, params = time_clause(args)
    out = []
    for cid, tm, data in rows(con, "DESC", where, params):
        seen = visible(data)
        if not seen:
            continue
        who, text, images = seen
        if not text and not images:
            continue
        out.append((cid, tm, who, text, images))
        if len(out) >= args.limit:
            break
    if not out:
        print("No WhatsApp history yet.")
        return
    emit([
        f"[#{cid}] {when(tm)} · {who}: {body(text, args.full) or '(no text)'}{marker(images)}"
        for cid, tm, who, text, images in reversed(out)
    ])


def parse_ids(value: str) -> list:
    ids = []
    for part in value.replace(",", " ").split():
        try:
            ids.append(int(part.lstrip("#")))
        except ValueError:
            die(f'not a message id: "{part}" (ids look like 1234, from the [#id] in results)')
    if not ids:
        die("give at least one id: --ids 254,260,791")
    return ids


def cmd_show(args):
    """Read specific messages in full, optionally with their surroundings. Reading is bounded by
    what was asked for, so nothing is trimmed - that is the whole reason to open a message."""
    con = connect()
    seq = []
    for cid, tm, data in rows(con, "ASC"):
        seen = visible(data)
        if seen:
            seq.append((cid, tm, *seen))
    positions = {row[0]: i for i, row in enumerate(seq)}

    ids = parse_ids(args.ids)
    missing = [i for i in ids if i not in positions]
    if missing:
        die(f"no WhatsApp message {', '.join('#' + str(i) for i in missing)} "
            "(it may be an internal, non-chat entry)")

    wanted = set()
    for i in ids:
        pos = positions[i]
        wanted.update(range(max(0, pos - args.context), min(len(seq), pos + args.context + 1)))

    targets = set(ids)
    lines = []
    previous = None
    for i in sorted(wanted):
        if previous is not None and i > previous + 1:
            lines.append("…")
        cid, tm, who, text, images = seq[i]
        prefix = "→ " if cid in targets else "  "
        lines.append(f"{prefix}[#{cid}] {when(tm)} · {who}: {text or '(no text)'}{marker(images)}")
        previous = i
    emit(lines)


def cmd_image(args):
    con = connect()
    try:
        row = con.execute("SELECT data FROM chat WHERE id = ?", (args.id,)).fetchone()
    except sqlite3.OperationalError:
        die("no chat history yet")
    if not row:
        die(f"no message #{args.id}")
    imgs = images_of(row[0])
    if not imgs:
        die(f"message #{args.id} has no image")
    if not 0 <= args.index < len(imgs):
        die(f"message #{args.id} has {len(imgs)} image(s); no index {args.index}")
    mime, encoded = imgs[args.index]
    path = os.path.join(tempfile.gettempdir(), f"recall-{args.id}-{args.index}.{EXT.get(mime, 'jpg')}")
    with open(path, "wb") as handle:
        handle.write(base64.b64decode(encoded))
    print(f"wrote image to {path} ({mime}). Open it with the read tool to view it.")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="recall.py", description="search Apollo's WhatsApp history")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("search")
    s.set_defaults(func=cmd_search)
    s.add_argument("query")
    s.add_argument("--limit", type=int, default=10)
    s.add_argument("--since")
    s.add_argument("--until")
    s.add_argument("--full", action="store_true", help="whole messages instead of match snippets")
    s.add_argument("--sort", choices=["relevance", "time"], default="relevance")

    r = sub.add_parser("recent")
    r.set_defaults(func=cmd_recent)
    r.add_argument("--limit", type=int, default=20)
    r.add_argument("--since")
    r.add_argument("--until")
    r.add_argument("--full", action="store_true", help="whole messages instead of trimmed ones")

    a = sub.add_parser("show")
    a.set_defaults(func=cmd_show)
    a.add_argument("--ids", required=True, help="one or more message ids: 254,260,791")
    a.add_argument("--context", type=int, default=0,
                   help="also show this many messages either side of each id")

    i = sub.add_parser("image")
    i.set_defaults(func=cmd_image)
    i.add_argument("--id", type=int, required=True)
    i.add_argument("--index", type=int, default=0)

    return p


def main():
    args = build_parser().parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
