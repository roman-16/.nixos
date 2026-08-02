import base64
import json
import os
import sqlite3

import pytest
import recall


def run(*argv):
    args = recall.build_parser().parse_args(list(argv))
    args.func(args)


@pytest.fixture
def db(tmp_path, monkeypatch):
    path = tmp_path / "apollo.sqlite"
    con = sqlite3.connect(path)
    con.execute(
        "CREATE TABLE chat (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, "
        "entry_id TEXT, type TEXT, time INTEGER, data TEXT)"
    )
    con.commit()
    con.close()
    monkeypatch.setenv("APOLLO_DB_PATH", str(path))
    return path


def insert(entries):
    """Append entries in order; their chat ids are 1, 2, 3, … (referenced as #1, #2, …)."""
    con = sqlite3.connect(os.environ["APOLLO_DB_PATH"])
    for i, entry in enumerate(entries):
        con.execute(
            "INSERT INTO chat (session_id, entry_id, type, time, data) VALUES (?, ?, ?, ?, ?)",
            ("s1", entry.get("id", f"e{i}"), entry["type"], 1_700_000_000_000 + i * 60_000, json.dumps(entry)),
        )
    con.commit()
    con.close()


# --- entry builders mirroring the shapes chat-store.ts writes ---

def user(text=None, *, images=0, caption=None):
    if images:
        content = ([{"type": "text", "text": caption}] if caption is not None else []) + [
            {"type": "image", "mimeType": "image/png", "data": base64.b64encode(f"img{i}".encode()).decode()}
            for i in range(images)
        ]
    else:
        content = text
    return {"type": "message", "message": {"role": "user", "content": content}}


def apollo(text=None, *, thinking=None):
    content = []
    if thinking is not None:
        content.append({"type": "thinking", "thinking": thinking})
    if text is not None:
        content.append({"type": "text", "text": text})
    return {"type": "message", "message": {"role": "assistant", "content": content}}


def tool_result(text):
    return {"type": "message", "message": {"role": "toolResult", "toolCallId": "t", "content": [{"type": "text", "text": text}]}}


def bash(command, output):
    return {"type": "message", "message": {"role": "bashExecution", "command": command, "output": output, "exitCode": 0}}


def skill(source, text):
    return {"type": "custom", "customType": "skill_message", "data": {"source": source, "text": text}}


def compaction(summary):
    return {"type": "compaction", "summary": summary, "tokensBefore": 1000}


def reload_marker():
    return {"type": "custom", "customType": "apollo_reload", "data": {}}


class TestSearch:
    def test_finds_user_and_apollo_text(self, db, capsys):
        insert([user("I have a dentist appointment tuesday"), apollo("noted, I'll remind you about the dentist")])
        run("search", "dentist")
        out = capsys.readouterr().out
        assert "You:" in out and "Apollo:" in out
        assert out.lower().count("dentist") >= 2

    def test_excludes_internal_but_keeps_skill_messages(self, db, capsys):
        insert([
            apollo(text="visible reply about pineapple", thinking="hidden pineapple thoughts"),
            apollo(thinking="pineapple only in thinking, no reply"),
            tool_result("pineapple from a tool"),
            bash("grep pineapple", "pineapple bash output"),
            skill("macros", "pineapple via macros"),
            compaction("pineapple compaction gist"),
            reload_marker(),
        ])
        run("search", "pineapple")
        out = capsys.readouterr().out.replace("«", "").replace("»", "")  # drop match highlighting
        assert "visible reply about pineapple" in out
        assert "via macros" in out
        for hidden in ("hidden pineapple thoughts", "only in thinking", "from a tool", "bash output", "compaction gist"):
            assert hidden not in out

    def test_notes_apollo_kept_to_itself_are_not_searchable(self, db, capsys):
        insert([
            apollo("<internal>pineapple stays between me and the log</internal>"),
            apollo("pineapple is on the shopping list<internal>pineapple noted quietly</internal>"),
        ])
        run("search", "pineapple")
        out = capsys.readouterr().out.replace("«", "").replace("»", "")  # drop match highlighting
        assert "pineapple is on the shopping list" in out
        assert "between me and the log" not in out
        assert "noted quietly" not in out

    def test_voice_transcript_is_searchable(self, db, capsys):
        insert([user("🎤 remember to buy milk on the way home")])
        run("search", "milk")
        out = capsys.readouterr().out.replace("«", "").replace("»", "")  # drop match highlighting
        assert "buy milk" in out
        assert "🎤" in out

    def test_image_caption_matches_and_flags_image(self, db, capsys):
        insert([user(images=1, caption="my lunch receipt"), user(images=1)])
        run("search", "receipt")
        out = capsys.readouterr().out
        assert "receipt" in out
        assert "[1 image]" in out

    def test_stemming_and_prefix(self, db, capsys):
        insert([user("running to the gym"), user("a big bolognese batch")])
        run("search", "run")
        assert "running" in capsys.readouterr().out
        capsys.readouterr()
        run("search", "bologn*")
        assert "bolognese" in capsys.readouterr().out

    def test_no_results(self, db, capsys):
        insert([user("just some unrelated chatter")])
        run("search", "zzznotanywhere")
        assert "No WhatsApp messages match" in capsys.readouterr().out

    def test_snippets_are_trimmed_by_default(self, db, capsys):
        insert([user(LONG)])
        run("search", "dentist")
        assert LONG not in capsys.readouterr().out

    def test_full_returns_whole_messages(self, db, capsys):
        insert([user(LONG)])
        run("search", "dentist", "--full")
        assert LONG in capsys.readouterr().out

    def test_relevance_is_the_default_order(self, db, capsys):
        insert([user("dentist once"), user("dentist dentist dentist twice")])
        run("search", "dentist")
        assert "most relevant first" in capsys.readouterr().out

    def test_sort_time_reads_oldest_first(self, db, capsys):
        insert([user("dentist once"), user("dentist dentist dentist twice")])
        run("search", "dentist", "--sort", "time")
        out = capsys.readouterr().out
        assert "oldest first" in out
        assert out.index("once") < out.index("twice")

    def test_since_until_filter(self, db, capsys):
        insert([user("dentist one")])  # 2023-11-14 ~ epoch 1.7e12
        run("search", "dentist", "--since", "2099-01-01")
        assert "No WhatsApp messages match" in capsys.readouterr().out


class TestRecent:
    def test_oldest_to_newest_and_skips_internal(self, db, capsys):
        insert([user("first"), tool_result("dropme"), apollo("second"), compaction("gist"), user("third")])
        run("recent", "--limit", "10")
        out = capsys.readouterr().out
        assert out.index("first") < out.index("second") < out.index("third")
        assert "dropme" not in out and "gist" not in out

    def test_limit(self, db, capsys):
        insert([user(f"msg {n}") for n in range(5)])
        run("recent", "--limit", "2")
        out = capsys.readouterr().out
        assert "msg 3" in out and "msg 4" in out
        assert "msg 0" not in out

    def test_empty(self, db, capsys):
        run("recent")
        assert "No WhatsApp history yet." in capsys.readouterr().out

    def test_trimmed_by_default_and_whole_with_full(self, db, capsys):
        insert([user(LONG)])
        run("recent")
        assert LONG not in capsys.readouterr().out
        run("recent", "--full")
        assert LONG in capsys.readouterr().out


LONG = (
    "The dentist appointment is on tuesday at 14:30 with Dr. Berger, and I need to bring the "
    "insurance card plus the x-rays from last year, otherwise they will have to redo them which "
    "costs extra and takes another hour of my afternoon that I would rather spend anywhere else."
)


class TestShow:
    def test_reads_a_message_whole(self, db, capsys):
        insert([user(LONG)])
        run("show", "--ids", "1")
        out = capsys.readouterr().out
        assert LONG in out
        assert "…" not in out

    def test_several_ids_in_one_call(self, db, capsys):
        insert([user("first"), user("second"), user("third")])
        run("show", "--ids", "1,3")
        out = capsys.readouterr().out
        assert "first" in out and "third" in out
        assert "second" not in out

    def test_ids_may_be_separated_by_spaces_or_hashes(self, db, capsys):
        insert([user("first"), user("second")])
        run("show", "--ids", "#1 #2")
        out = capsys.readouterr().out
        assert "first" in out and "second" in out

    def test_context_widens_each_id_and_marks_the_targets(self, db, capsys):
        insert([user("a1"), user("a2"), user("a3"), user("a4"), user("a5")])
        run("show", "--ids", "3", "--context", "1")
        out = capsys.readouterr().out
        assert "a2" in out and "a3" in out and "a4" in out
        assert "a1" not in out and "a5" not in out
        assert "→ " in out and "#3" in out

    def test_separate_stretches_are_marked_as_such(self, db, capsys):
        insert([user("a1"), user("a2"), user("a3"), user("a4"), user("a5")])
        run("show", "--ids", "1,5")
        assert "…" in capsys.readouterr().out

    def test_adjacent_ids_need_no_marker(self, db, capsys):
        insert([user("a1"), user("a2")])
        run("show", "--ids", "1,2")
        assert "…" not in capsys.readouterr().out

    def test_unknown_id_errors(self, db):
        insert([user("x")])
        with pytest.raises(SystemExit):
            run("show", "--ids", "999")

    def test_a_nonsense_id_errors(self, db):
        insert([user("x")])
        with pytest.raises(SystemExit):
            run("show", "--ids", "abc")


class TestBudget:
    def test_a_too_wide_call_stops_on_a_whole_message_and_says_so(self, db, capsys):
        insert([user(f"message {n} " + "x" * 600) for n in range(60)])
        run("recent", "--limit", "60", "--full")
        out = capsys.readouterr().out
        assert "capped at" in out
        assert "narrow it" in out
        assert len(out) < 25_000

    def test_output_within_budget_is_never_capped(self, db, capsys):
        insert([user("short one"), user("short two")])
        run("recent", "--full")
        assert "capped at" not in capsys.readouterr().out


class TestImage:
    def test_materializes_to_tmp(self, db, capsys):
        insert([user(images=1, caption="a receipt")])
        run("image", "--id", "1")
        out = capsys.readouterr().out
        assert "wrote image to" in out
        path = out.split("wrote image to ", 1)[1].split(" (", 1)[0].strip()
        assert os.path.exists(path)
        with open(path, "rb") as handle:
            assert handle.read() == b"img0"

    def test_no_image_errors(self, db):
        insert([user("no image here")])
        with pytest.raises(SystemExit):
            run("image", "--id", "1")


class TestErrors:
    def test_missing_db(self, monkeypatch):
        monkeypatch.setenv("APOLLO_DB_PATH", "/tmp/recall-does-not-exist-xyzzy.sqlite")
        with pytest.raises(SystemExit):
            run("search", "anything")
