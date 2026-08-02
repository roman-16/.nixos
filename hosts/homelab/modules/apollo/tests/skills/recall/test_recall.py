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

    def test_the_context_the_app_prepends_is_not_the_users_words(self, db, capsys):
        # A skill note quotes the skill's whole output, so indexing it would both credit the user
        # with those words and index the delivery a second time.
        insert([
            user('<context source="macros" info="The macros skill sent the user a message '
                 'directly.">Today (02.08): grapefruit 90 kcal</context>\n\nthanks'),
            skill("macros", "Today (02.08): grapefruit 90 kcal"),
        ])
        run("search", "grapefruit")
        out = capsys.readouterr().out.replace("«", "").replace("»", "")
        assert "via macros" in out
        assert "You:" not in out  # the user never said "grapefruit"

    def test_a_message_reads_as_it_did_on_the_phone(self, db, capsys):
        insert([user('<context source="time" info="Sent Sunday 02.08.2026 14:47." />\n\n'
                     "what was my first message?")])
        run("history", "--first", "1")
        out = capsys.readouterr().out
        assert "what was my first message?" in out
        assert "<context" not in out and "Sent Sunday" not in out

    def test_the_send_time_metadata_is_not_searchable(self, db, capsys):
        insert([user('<context source="time" info="Sent Sunday 02.08.2026 14:47." />\n\nlog 100g')])
        run("search", "sunday")
        assert "No WhatsApp messages match" in capsys.readouterr().out

    def test_a_reply_quote_is_not_attributed_to_the_quoter(self, db, capsys):
        insert([user('<context source="reply" info="The user is replying to a message you sent '
                     'earlier.">the bolognese is 40% left</context>\n\nfinish it')])
        run("search", "bolognese")
        assert "No WhatsApp messages match" in capsys.readouterr().out

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


class TestQueries:
    """A query is written by paraphrasing a human sentence, so punctuation and filler are certain."""

    def test_punctuation_is_part_of_the_word_not_grammar(self, db, capsys):
        # Every one of these used to be an fts5 syntax error and a wasted round trip.
        insert([user("we rode col d'Iseran"), user("send me an e-mail"), user("it was 50% off"),
                user("reread the backup, macros and reminders skill")])
        for query in ["col d'Iseran", "e-mail", "50%", "reread the backup, macros",
                      "what did I say about the bike?", "kcal (estimated)", "20:30"]:
            run("search", query, "--limit", "2")
            assert "syntax error" not in capsys.readouterr().out

    def test_a_word_with_an_apostrophe_finds_itself(self, db, capsys):
        insert([user("we rode col d'Iseran today"), user("unrelated")])
        run("search", "d'Iseran")
        assert "col d" in capsys.readouterr().out.replace("«", "").replace("»", "")

    def test_the_operators_the_skill_documents_still_work(self, db, capsys):
        insert([user("the bike is fine"), user("the motorcycle is fine"), user("the car is fine")])
        run("search", "bike OR motorcycle", "--limit", "5")
        out = capsys.readouterr().out
        assert "bike" in out and "motorcycle" in out and "car" not in out

    def test_a_quoted_phrase_stays_a_phrase(self, db, capsys):
        insert([user("a leaking fork seal"), user("seal the fork later")])
        run("search", '"fork seal"', "--limit", "5")
        out = capsys.readouterr().out
        assert "leaking" in out
        assert "later" not in out

    def test_a_prefix_still_matches_partial_words(self, db, capsys):
        insert([user("the dentist called")])
        run("search", "dent*")
        assert "dentist" in capsys.readouterr().out.replace("«", "").replace("»", "")

    def test_filler_does_not_have_to_match(self, db, capsys):
        # "what did I say about the fork seal?" must find the message about the fork seal, even
        # though no message contains all eight of those words.
        insert([user("my fork seal is leaking"), user("what a day")])
        run("search", "what did I say about the fork seal?", "--limit", "3")
        out = capsys.readouterr().out.replace("«", "").replace("»", "")
        assert "fork seal is leaking" in out

    def test_a_query_of_pure_filler_searches_for_those_words(self, db, capsys):
        insert([user("how are you?"), user("something else")])
        run("search", "how are you")
        out = capsys.readouterr().out.replace("«", "").replace("»", "")
        assert "how are you" in out

    def test_a_query_with_no_words_at_all_says_so(self, db):
        insert([user("x")])
        with pytest.raises(SystemExit):
            run("search", "?!...")


class TestWidening:
    def test_it_widens_rather_than_dead_ending(self, db, capsys):
        insert([user("the fork seal is leaking"), user("unrelated chatter")])
        run("search", "fork seal gasket bearing", "--limit", "3")
        out = capsys.readouterr().out
        assert "match at least one" in out
        assert "fork" in out.replace("«", "").replace("»", "")

    def test_a_precise_hit_is_never_labelled_as_loose(self, db, capsys):
        insert([user("the fork seal is leaking")])
        run("search", "fork seal")
        assert "match at least one" not in capsys.readouterr().out

    def test_an_exclusion_is_left_alone(self, db, capsys):
        # NOT means the caller wants something kept out; widening would put it back.
        insert([user("the bike is fine")])
        run("search", "gasket NOT bike")
        assert "match at least one" not in capsys.readouterr().out

    def test_a_genuinely_absent_topic_still_reports_nothing(self, db, capsys):
        insert([user("the bike is fine")])
        run("search", "parliament")
        assert "No WhatsApp messages match" in capsys.readouterr().out


class TestStats:
    def test_it_answers_how_many_images_in_one_call(self, db, capsys):
        insert([user(images=2, caption="two labels"), user(images=1), user("no picture")])
        run("stats")
        out = capsys.readouterr().out
        assert "Images 3 in 2 message(s)" in out

    def test_it_counts_the_sides_of_the_conversation_apart(self, db, capsys):
        insert([user("hi"), apollo("hello"), apollo("and again"), skill("macros", "day summary")])
        out_lines = (run("stats"), capsys.readouterr().out)[1]
        assert "Messages 4" in out_lines
        assert "1 you" in out_lines
        assert "2 Apollo" in out_lines
        assert "1 via skills" in out_lines

    def test_it_counts_voice_notes(self, db, capsys):
        insert([user("🎤 remember the milk"), user("typed")])
        assert "voice notes 1" in (run("stats"), capsys.readouterr().out)[1]

    def test_it_reports_the_span_it_covers(self, db, capsys):
        insert([user("first"), user("second")])
        assert "Chat archive" in (run("stats"), capsys.readouterr().out)[1]

    def test_it_counts_only_what_the_rest_of_the_skill_can_find(self, db, capsys):
        # The same definition of "a message" as search and history: no thinking, no tool output.
        insert([user("real"), tool_result("internal"), compaction("gist"), apollo(thinking="hmm")])
        assert "Messages 1" in (run("stats"), capsys.readouterr().out)[1]

    def test_a_topic_gets_a_count_and_its_first_and_last(self, db, capsys):
        insert([user("the dentist called"), user("nothing"), apollo("about that dentist")])
        run("stats", "dentist")
        out = capsys.readouterr().out
        assert "2 message(s)" in out
        assert "1 you" in out and "1 Apollo" in out
        assert "First" in out and "last" in out

    def test_a_topic_never_mentioned_says_so(self, db, capsys):
        insert([user("the bike is fine")])
        run("stats", "parliament")
        assert "No WhatsApp messages match" in capsys.readouterr().out

    def test_an_empty_range_says_so(self, db, capsys):
        insert([user("today")])
        run("stats", "--since", "2099-01-01")
        assert "No WhatsApp history in that range." in capsys.readouterr().out


class TestHistory:
    def test_oldest_to_newest_and_skips_internal(self, db, capsys):
        insert([user("first"), tool_result("dropme"), apollo("second"), compaction("gist"), user("third")])
        run("history", "--last", "10")
        out = capsys.readouterr().out
        assert out.index("first") < out.index("second") < out.index("third")
        assert "dropme" not in out and "gist" not in out

    def test_last_takes_the_newest(self, db, capsys):
        insert([user(f"msg {n}") for n in range(5)])
        run("history", "--last", "2")
        out = capsys.readouterr().out
        assert "msg 3" in out and "msg 4" in out
        assert "msg 0" not in out

    def test_first_takes_the_oldest(self, db, capsys):
        insert([user(f"msg {n}") for n in range(5)])
        run("history", "--first", "2")
        out = capsys.readouterr().out
        assert "msg 0" in out and "msg 1" in out
        assert "msg 4" not in out

    def test_first_answers_what_was_my_first_message_in_one_call(self, db, capsys):
        insert([user("you there?"), apollo("yep"), user("do you have a workspace?")])
        run("history", "--first", "1")
        out = capsys.readouterr().out
        assert "you there?" in out
        assert "workspace" not in out

    def test_first_reads_chronologically_too(self, db, capsys):
        insert([user("one"), user("two"), user("three")])
        run("history", "--first", "3")
        out = capsys.readouterr().out
        assert out.index("one") < out.index("two") < out.index("three")

    def test_defaults_to_the_newest_end(self, db, capsys):
        insert([user(f"msg {n}") for n in range(25)])
        run("history")
        out = capsys.readouterr().out
        assert "msg 24" in out
        assert "msg 0" not in out

    def test_a_day_is_both_bounds_read_from_its_start(self, db, capsys):
        insert([user("in range")])
        run("history", "--since", "2099-01-01", "--until", "2099-01-01", "--first", "50")
        assert "No WhatsApp history in that range." in capsys.readouterr().out

    def test_the_two_ends_are_mutually_exclusive(self, db):
        with pytest.raises(SystemExit):
            run("history", "--first", "2", "--last", "2")

    def test_empty(self, db, capsys):
        run("history")
        assert "No WhatsApp history in that range." in capsys.readouterr().out

    def test_trimmed_by_default_and_whole_with_full(self, db, capsys):
        insert([user(LONG)])
        run("history")
        assert LONG not in capsys.readouterr().out
        run("history", "--full")
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

    def test_a_batch_survives_ids_that_are_internal_entries(self, db, capsys):
        # ids 2 and 4 are internal: a caller reading a stretch of ids will land on them, and
        # discarding the whole call over one of them only buys a second call.
        insert([user("keep me"), tool_result("internal"), user("me too"), compaction("gist")])
        run("show", "--ids", "1,2,3,4")
        out = capsys.readouterr().out
        assert "keep me" in out and "me too" in out
        assert "#2" in out and "#4" in out  # named as skipped
        assert "internal" in out and "gist" not in out

    def test_only_a_wholly_unresolvable_request_fails(self, db):
        insert([user("x"), tool_result("internal")])
        with pytest.raises(SystemExit):
            run("show", "--ids", "2,999")

    def test_unknown_id_errors(self, db):
        insert([user("x")])
        with pytest.raises(SystemExit):
            run("show", "--ids", "999")

    def test_a_nonsense_id_errors(self, db):
        insert([user("x")])
        with pytest.raises(SystemExit):
            run("show", "--ids", "abc")

    def test_full_is_accepted_even_though_reading_is_always_whole(self, db, capsys):
        insert([user(LONG)])
        run("show", "--ids", "1", "--full")
        assert LONG in capsys.readouterr().out


class TestBudget:
    def test_a_too_wide_call_stops_on_a_whole_message_and_says_so(self, db, capsys):
        insert([user(f"message {n} " + "x" * 600) for n in range(60)])
        run("history", "--last", "60", "--full")
        out = capsys.readouterr().out
        assert "capped at" in out
        assert "narrow it" in out
        assert len(out) < 25_000

    def test_output_within_budget_is_never_capped(self, db, capsys):
        insert([user("short one"), user("short two")])
        run("history", "--full")
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
