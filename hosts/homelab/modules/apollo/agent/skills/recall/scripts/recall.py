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


def trim(text: str, limit: int = 200) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[:limit] + "…"


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
            continue  # e.g. an uncaptioned image: reachable via recent/around, not keyword search
        batch.append((text, cid, tm or 0, who, images))
        if len(batch) >= 5000:
            mem.executemany("INSERT INTO fts(txt,cid,t,who,img) VALUES (?,?,?,?,?)", batch)
            batch = []
    if batch:
        mem.executemany("INSERT INTO fts(txt,cid,t,who,img) VALUES (?,?,?,?,?)", batch)

    try:
        hits = mem.execute(
            "SELECT cid, t, who, img, snippet(fts, 0, '«', '»', '…', 14) "
            "FROM fts WHERE fts MATCH ? ORDER BY bm25(fts) LIMIT ?",
            (args.query, args.limit),
        ).fetchall()
    except sqlite3.OperationalError as error:
        die(f'bad search "{args.query}" ({error}). Use plain words, OR, "a phrase", or prefix*.')

    if not hits:
        print(f'No WhatsApp messages match "{args.query}". Try broader or different keywords '
              "(synonyms, OR, a prefix*).")
        return
    print(f'Top {len(hits)} match(es) for "{args.query}" (most relevant first):')
    for cid, tm, who, img, snip in hits:
        print(f"[#{cid}] {when(tm)} · {who}: {snip}{marker(img)}")
    print("→ `around --id <#>` for surrounding context; `image --id <#>` to view an image.")


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
    for cid, tm, who, text, images in reversed(out):
        print(f"[#{cid}] {when(tm)} · {who}: {trim(text) or '(no text)'}{marker(images)}")


def cmd_around(args):
    con = connect()
    seq = []
    for cid, tm, data in rows(con, "ASC"):
        seen = visible(data)
        if seen:
            seq.append((cid, tm, *seen))
    pos = next((i for i, r in enumerate(seq) if r[0] == args.id), None)
    if pos is None:
        die(f"no WhatsApp message #{args.id} (it may be an internal, non-chat entry)")
    lo = max(0, pos - args.context)
    hi = min(len(seq), pos + args.context + 1)
    for i in range(lo, hi):
        cid, tm, who, text, images = seq[i]
        prefix = "→ " if i == pos else "  "
        print(f"{prefix}[#{cid}] {when(tm)} · {who}: {trim(text) or '(no text)'}{marker(images)}")


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

    r = sub.add_parser("recent")
    r.set_defaults(func=cmd_recent)
    r.add_argument("--limit", type=int, default=20)
    r.add_argument("--since")
    r.add_argument("--until")

    a = sub.add_parser("around")
    a.set_defaults(func=cmd_around)
    a.add_argument("--id", type=int, required=True)
    a.add_argument("--context", type=int, default=4)

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
