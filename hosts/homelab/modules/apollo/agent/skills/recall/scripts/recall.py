#!/usr/bin/env python3
"""Search Apollo's WhatsApp history.

Builds a throwaway in-memory FTS5 index over the messages that actually appeared in the
WhatsApp chat - what the user sent (typed text, voice-note transcripts, image captions),
Apollo's text replies, and the "via <skill>" messages that were delivered - and answers
keyword searches over it. Apollo's internal machinery (thinking blocks, tool calls and
their output, compaction summaries) is never indexed, and neither is what the app wraps
around a message on either side: the <context> elements prepended to a user's turn, or the
<internal> notes Apollo keeps to itself. Both are metadata; neither reached anyone's phone.

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
import re
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

# Spans Apollo addressed to itself. They live in the transcript but were never sent, so they are
# not part of the chat and are never searched. An unterminated span runs to the end of the block.
INTERNAL_SPAN = re.compile(r"<internal>.*?(?:</internal>|\Z)", re.DOTALL)

# Elements the app prepends to a user's turn: the send time, the reply being answered, a skill
# message already delivered, a backlog header. The user typed none of it. Indexing it would credit
# them with the app's words - and because a skill note quotes that skill's entire output, every
# delivery would land in the index twice: once as itself, once inside the next thing the user said.
CONTEXT_ELEMENT = re.compile(
    r'<context source="[^"]*" info="[^"]*"(?:\s*/>|>.*?</context>)\s*', re.DOTALL
)


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


def strip_internal(text: str) -> str:
    """An assistant message as WhatsApp saw it: without the notes Apollo kept to itself."""
    return INTERNAL_SPAN.sub("", text).strip()


def strip_context(text: str) -> str:
    """A user message as WhatsApp saw it: without the context the app prepended for Apollo."""
    return CONTEXT_ELEMENT.sub("", text).strip()


def image_count(content) -> int:
    if isinstance(content, list):
        return sum(1 for b in content if isinstance(b, dict) and b.get("type") == "image")
    return 0


def visible(data: str):
    """(who, text, images) for a message that appeared in WhatsApp, else None. Internal
    entries - assistant thinking, tool results, bash, compaction, reload markers - return
    None, an assistant turn's thinking blocks are dropped by only reading text blocks, and
    the app's own additions are dropped from both sides: <internal> from Apollo's replies,
    <context> from the user's messages."""
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
            return "You", strip_context(text_of(content)), image_count(content)
        if role == "assistant":
            text = strip_internal(text_of(content))
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

# --- queries -------------------------------------------------------------------

# FTS5 reads punctuation as grammar, so an apostrophe, comma, hyphen or colon in an ordinary
# sentence is a syntax error - and a word containing one cannot be searched for at all. The caller
# writes words, having paraphrased a human sentence, so words are what this takes: the operators the
# skill documents survive, everything else is quoted into a literal term where its punctuation is
# data. Nothing a caller can type is a syntax error.
OPERATORS = {"AND", "NOT", "OR"}
TOKEN = re.compile(r'"[^"]*"|\S+')

# Words that carry no signal in a keyword search. A caller paraphrasing a human question will
# include them, and every one of them is a term the whole query then has to match - which is how
# "what did I say about the fork seal?" finds nothing while "fork seal" finds it. Dropped only when
# something else survives, so searching for "how are you" still searches for those words.
FILLER = {
    "a", "about", "again", "all", "an", "and", "any", "anything", "are", "as", "at", "be", "been",
    "but", "by", "can", "did", "die", "do", "does", "der", "das", "for", "from", "get", "had",
    "has", "have", "he", "her", "him", "his", "how", "i", "ich", "if", "in", "is", "ist", "it",
    "its", "just", "me", "mein", "mir", "my", "no", "not", "of", "on", "or", "our", "say", "said",
    "she", "should", "so", "some", "tell", "that", "the", "their", "them", "then", "there",
    "these", "they", "this", "to", "und", "up", "us", "was", "we", "were", "what", "when",
    "where", "which", "who", "why", "will", "with", "would", "you", "your",
}


def quote_term(term: str) -> str:
    """One word as an FTS5 literal, keeping a trailing * as the prefix search it means."""
    prefix = term.endswith("*")
    body = (term[:-1] if prefix else term).replace('"', "")
    if not any(ch.isalnum() for ch in body):
        return ""
    return f'"{body}"' + ("*" if prefix else "")


def build_query(raw: str) -> tuple:
    """(FTS5 expression, its literal terms) for whatever the caller typed."""
    tokens: list = []  # (is_operator, text, is_filler)
    for token in TOKEN.findall(raw):
        if len(token) >= 2 and token.startswith('"') and token.endswith('"'):
            inner = token[1:-1].strip()
            if any(ch.isalnum() for ch in inner):
                tokens.append((False, f'"{inner}"', False))  # a phrase is never filler
        elif token in OPERATORS:
            tokens.append((True, token, False))
        else:
            quoted = quote_term(token)
            if quoted:
                word = quoted.strip('"*').lower()
                tokens.append((False, quoted, word in FILLER))
    if any(not op and not filler for op, _, filler in tokens):
        tokens = [t for t in tokens if t[0] or not t[2]]

    parts: list = []
    terms: list = []
    for is_operator, text, _ in tokens:
        if is_operator:
            if parts and parts[-1] not in OPERATORS:
                parts.append(text)
        else:
            parts.append(text)
            terms.append(text)
    while parts and parts[-1] in OPERATORS:
        parts.pop()
    return " ".join(parts), terms


def widened(query: str, terms: list) -> str:
    """The same search asking for any term instead of all of them, or "" when that changes nothing.
    An explicit NOT is left alone: the caller meant to exclude something."""
    if len(terms) < 2 or "NOT" in query.split():
        return ""
    return " OR ".join(terms)


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

def build_index(con, args):
    """The chat as a throwaway FTS index. Rebuilt per call (80ms over a month of history), so there
    is never a second copy of the archive to keep in step with this one."""
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
            continue  # e.g. an uncaptioned image: reachable via history/show, not keyword search
        batch.append((text, cid, tm or 0, who, images))
        if len(batch) >= 5000:
            mem.executemany("INSERT INTO fts(txt,cid,t,who,img) VALUES (?,?,?,?,?)", batch)
            batch = []
    if batch:
        mem.executemany("INSERT INTO fts(txt,cid,t,who,img) VALUES (?,?,?,?,?)", batch)
    return mem


def cmd_search(args):
    mem = build_index(connect(), args)
    query, terms = build_query(args.query)
    if not query:
        die(f'nothing to search for in "{args.query}" - give it some words.')

    def run(expression):
        # Relevance always decides *which* messages come back, so --limit keeps meaning "the best N";
        # --sort only decides the order they are read in.
        return mem.execute(
            "SELECT cid, t, who, img, snippet(fts, 0, '«', '»', '…', 14), txt "
            "FROM fts WHERE fts MATCH ? ORDER BY bm25(fts) LIMIT ?",
            (expression, args.limit),
        ).fetchall()

    hits = run(query)
    # Asking for every word and getting nothing is the quiet failure: it reads as "this was never
    # discussed" when it usually means one word too many. Widen once, and say so.
    loose = ""
    if not hits:
        loose = widened(query, terms)
        if loose:
            hits = run(loose)

    if not hits:
        print(f'No WhatsApp messages match "{args.query}". Try broader or different keywords '
              "(synonyms, OR, a prefix*).")
        return
    if loose:
        print(f'No message matches all of "{args.query}" - these match at least one of its words:')
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


def speaker(who: str) -> str:
    """Which side of the chat a line came from, skills counted apart from Apollo's own words."""
    if who == "You":
        return "you"
    return "via skills" if who.startswith("Apollo (via") else "Apollo"


def cmd_stats(args):
    """How much there is, rather than what is in it.

    "How many photos have I sent", "how often do I bring this up", "when did I last mention it" are
    ordinary questions about a conversation, and without a verb for them the caller ends up querying
    the database by hand - writing a second, private definition of what counts as a message. This
    counts exactly what the rest of the skill can find: same messages, same time bounds.
    """
    con = connect()
    if args.query:
        mem = build_index(con, args)
        query, _ = build_query(args.query)
        if not query:
            die(f'nothing to search for in "{args.query}" - give it some words.')
        hits = mem.execute(
            "SELECT cid, t, who FROM fts WHERE fts MATCH ? ORDER BY t", (query,)
        ).fetchall()
        if not hits:
            print(f'No WhatsApp messages match "{args.query}".')
            return
        sides: dict = {}
        for _, _, who in hits:
            sides[speaker(who)] = sides.get(speaker(who), 0) + 1
        split = ", ".join(f"{n} {side}" for side, n in sorted(sides.items()))
        print(f'"{args.query}" · {len(hits)} message(s) — {split}')
        print(f"First {when(hits[0][1])} [#{hits[0][0]}] · last {when(hits[-1][1])} [#{hits[-1][0]}]")
        return

    where, params = time_clause(args)
    sides: dict = {"Apollo": 0, "via skills": 0, "you": 0}
    months: dict = {}
    total = images = image_messages = voice = 0
    first = last = None
    for _, tm, data in rows(con, "ASC", where, params):
        seen = visible(data)
        if not seen:
            continue
        who, text, imgs = seen
        if not text and not imgs:
            continue
        total += 1
        sides[speaker(who)] += 1
        if imgs:
            images += imgs
            image_messages += 1
        if text.startswith("\U0001f3a4"):
            voice += 1
        if tm:
            first = first if first else tm
            last = tm
            key = datetime.fromtimestamp(tm / 1000).strftime("%Y-%m")
            months[key] = months.get(key, 0) + 1
    if total == 0:
        print("No WhatsApp history in that range.")
        return
    span = f"{when(first)} to {when(last)}" if first and last else ""
    days = int((last - first) / 86_400_000) + 1 if first and last else 0
    print(f"Chat archive · {span} · {days} day(s)")
    print(f"Messages {total:,} — " + ", ".join(f"{n:,} {side}" for side, n in sorted(sides.items())))
    print(f"Images {images:,} in {image_messages:,} message(s) · voice notes {voice:,}")
    if len(months) > 1:
        print("By month:")
        for key in sorted(months):
            print(f"  {key}  {months[key]:,}")


def cmd_history(args):
    """Read a stretch of the timeline from either end of it.

    A conversation has two ends and questions are asked from both - "what were we just doing"
    and "how did this start". The anchor is always explicit, so a window never has to be
    guessed at: --last counts back from the newest message, --first forward from the oldest,
    and either way the messages are printed in the order they happened.
    """
    oldest_first = args.first is not None
    limit = args.first if oldest_first else (args.last if args.last is not None else 20)
    if limit < 1:
        die("ask for at least one message")
    con = connect()
    where, params = time_clause(args)
    out = []
    for cid, tm, data in rows(con, "ASC" if oldest_first else "DESC", where, params):
        seen = visible(data)
        if not seen:
            continue
        who, text, images = seen
        if not text and not images:
            continue
        out.append((cid, tm, who, text, images))
        if len(out) >= limit:
            break
    if not out:
        print("No WhatsApp history in that range.")
        return
    ordered = out if oldest_first else list(reversed(out))
    emit([
        f"[#{cid}] {when(tm)} · {who}: {body(text, args.full) or '(no text)'}{marker(images)}"
        for cid, tm, who, text, images in ordered
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
    # ids are shared with entries that never reached WhatsApp, so a caller reading a stretch will
    # land on one sooner or later. Show whatever resolved and name the rest: discarding six good
    # ids over two internal ones only buys a second call.
    found = [i for i in ids if i in positions]
    missing = [i for i in ids if i not in positions]
    if not found:
        die(f"no WhatsApp message {', '.join('#' + str(i) for i in ids)} "
            "(internal entries - thinking, tool calls, compaction - share the same numbering)")
    if missing:
        print(f"(no chat message for {', '.join('#' + str(i) for i in missing)} - "
              "internal entries, skipped)")

    wanted = set()
    for i in found:
        pos = positions[i]
        wanted.update(range(max(0, pos - args.context), min(len(seq), pos + args.context + 1)))

    targets = set(found)
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

    # Every reading command takes --full: asking for everything should never be the thing that
    # fails, even where the answer is already whole.
    reading = argparse.ArgumentParser(add_help=False)
    reading.add_argument("--full", action="store_true",
                         help="whole messages instead of trimmed ones (show is always whole)")

    s = sub.add_parser("search", parents=[reading])
    s.set_defaults(func=cmd_search)
    s.add_argument("query")
    s.add_argument("--limit", type=int, default=10)
    s.add_argument("--since")
    s.add_argument("--until")
    s.add_argument("--sort", choices=["relevance", "time"], default="relevance")

    h = sub.add_parser("history", parents=[reading])
    h.set_defaults(func=cmd_history)
    end = h.add_mutually_exclusive_group()
    end.add_argument("--last", type=int, metavar="N", help="the newest N messages (the default)")
    end.add_argument("--first", type=int, metavar="N", help="the oldest N messages")
    h.add_argument("--since")
    h.add_argument("--until")

    a = sub.add_parser("show", parents=[reading])
    a.set_defaults(func=cmd_show)
    a.add_argument("--ids", required=True, help="one or more message ids: 254,260,791")
    a.add_argument("--context", type=int, default=0,
                   help="also show this many messages either side of each id")

    st = sub.add_parser("stats")
    st.set_defaults(func=cmd_stats)
    st.add_argument("query", nargs="?", help="count only the messages matching this")
    st.add_argument("--since")
    st.add_argument("--until")

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
