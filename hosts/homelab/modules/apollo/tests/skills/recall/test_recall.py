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


class TestAround:
    def test_window_marks_target(self, db, capsys):
        insert([user("a1"), user("a2"), user("a3"), user("a4"), user("a5")])
        run("around", "--id", "3", "--context", "1")
        out = capsys.readouterr().out
        assert "a2" in out and "a3" in out and "a4" in out
        assert "a1" not in out and "a5" not in out
        assert "→ " in out and "#3" in out

    def test_unknown_id_errors(self, db):
        insert([user("x")])
        with pytest.raises(SystemExit):
            run("around", "--id", "999")


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
