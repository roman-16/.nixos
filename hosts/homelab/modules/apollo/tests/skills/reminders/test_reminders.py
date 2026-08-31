import io
import json
import sys
from datetime import datetime

import pytest
import reminders


def run(*argv):
    args = reminders.build_parser().parse_args(list(argv))
    args.func(args)


@pytest.fixture
def spool(tmp_path, monkeypatch):
    monkeypatch.setattr(reminders, "WORKSPACE", tmp_path)
    monkeypatch.setattr(reminders, "REMINDERS_DIR", tmp_path)
    return tmp_path


class TestStore:
    def test_the_spool_is_in_the_workspace_not_wherever_this_ran(self):
        assert reminders.REMINDERS_DIR == reminders.WORKSPACE / "reminders"
        assert reminders.WORKSPACE.is_absolute()


@pytest.fixture
def frozen(monkeypatch):
    monkeypatch.setattr(reminders, "now_ms", lambda: 1_000_000)
    return 1_000_000


def fired(spool, rid: str, text: str, at: int = 5000):
    """An archived reminder, as Apollo leaves it once it has gone out."""
    archive = spool / "archive"
    archive.mkdir(exist_ok=True)
    (archive / f"{rid}.json").write_text(json.dumps(
        {"id": rid, "text": text, "at": at, "createdAt": 0, "firedAt": at}))


class TestParseDuration:
    def test_single_units(self):
        assert reminders.parse_duration("90m") == 90 * 60 * 1000
        assert reminders.parse_duration("2h") == 2 * 3600 * 1000
        assert reminders.parse_duration("1d") == 86400 * 1000
        assert reminders.parse_duration("1w") == 604800 * 1000

    def test_combined_units(self):
        assert reminders.parse_duration("1h30m") == 90 * 60 * 1000
        assert reminders.parse_duration("1w2d") == (604800 + 2 * 86400) * 1000

    def test_tolerates_spaces_and_case(self):
        assert reminders.parse_duration("  1H 30M ") == 90 * 60 * 1000

    def test_rejects_garbage(self):
        with pytest.raises(SystemExit):
            reminders.parse_duration("soon")

    def test_rejects_zero(self):
        with pytest.raises(SystemExit):
            reminders.parse_duration("0m")

    def test_rejects_partial_match(self):
        with pytest.raises(SystemExit):
            reminders.parse_duration("2h5")


class TestParseAt:
    def test_parses_iso_local(self):
        expected = int(datetime(2026, 7, 15, 9, 0).timestamp() * 1000)
        assert reminders.parse_at("2026-07-15T09:00") == expected

    def test_rejects_non_iso(self):
        with pytest.raises(SystemExit):
            reminders.parse_at("next tuesday")


class TestResolveAt:
    def test_in_offsets_from_now(self, frozen):
        args = reminders.build_parser().parse_args(["add", "--text", "x", "--in", "1h"])
        assert reminders.resolve_at(args) == frozen + 3600 * 1000

    def test_at_is_absolute(self):
        args = reminders.build_parser().parse_args(["add", "--text", "x", "--at", "2026-07-15T09:00"])
        assert reminders.resolve_at(args) == int(datetime(2026, 7, 15, 9, 0).timestamp() * 1000)

    def test_both_is_an_error(self):
        args = reminders.build_parser().parse_args(
            ["add", "--text", "x", "--in", "1h", "--at", "2026-07-15T09:00"]
        )
        with pytest.raises(SystemExit):
            reminders.resolve_at(args)

    def test_neither_is_an_error(self):
        args = reminders.build_parser().parse_args(["add", "--text", "x"])
        with pytest.raises(SystemExit):
            reminders.resolve_at(args)


class TestFmtDelta:
    def test_past_is_now(self):
        assert reminders.fmt_delta(0) == "now"
        assert reminders.fmt_delta(-5) == "now"

    def test_sub_minute(self):
        assert reminders.fmt_delta(30 * 1000) == "in <1m"

    def test_minutes_hours_days(self):
        assert reminders.fmt_delta(5 * 60 * 1000) == "in 5m"
        assert reminders.fmt_delta((2 * 60 + 30) * 60 * 1000) == "in 2h 30m"
        assert reminders.fmt_delta(26 * 3600 * 1000) == "in 1d 2h"
        assert reminders.fmt_delta((26 * 3600 + 90) * 1000) == "in 1d 2h 1m"


class TestAdd:
    def test_writes_a_file_and_confirms(self, spool, frozen, capsys):
        run("add", "--text", "call the dentist", "--in", "1h")
        files = list(spool.glob("*.json"))
        assert len(files) == 1
        saved = json.loads(files[0].read_text())
        assert saved["text"] == "call the dentist"
        assert saved["at"] == frozen + 3600 * 1000
        out = capsys.readouterr().out
        assert "✅ Reminder" in out
        assert "call the dentist" in out


class TestList:
    def test_empty(self, spool, capsys):
        run("list")
        assert capsys.readouterr().out.strip() == "No reminders."

    def test_orders_by_fire_time(self, spool, capsys):
        reminders.write_reminder({"id": "late", "text": "B", "at": 5000, "createdAt": 0})
        reminders.write_reminder({"id": "soon", "text": "A", "at": 2000, "createdAt": 0})
        run("list")
        out = capsys.readouterr().out
        assert "2 reminder(s):" in out
        assert out.index("[soon]") < out.index("[late]")

    def test_hides_fired_reminders(self, spool, capsys):
        fired(spool, "a1", "buy milk")
        run("list")
        out = capsys.readouterr().out
        assert "No reminders." in out
        assert "buy milk" not in out

    def test_all_shows_them_with_the_time_they_went_out(self, spool, capsys):
        fired(spool, "a1", "buy milk")
        run("list", "--all")
        out = capsys.readouterr().out
        assert "Fired (1)" in out
        assert "buy milk" in out

    def test_all_says_so_when_nothing_has_fired(self, spool, capsys):
        run("list", "--all")
        assert "Nothing has fired yet." in capsys.readouterr().out

    def test_all_reads_newest_first(self, spool, capsys):
        fired(spool, "older", "older", at=1000)
        fired(spool, "newer", "newer", at=9000)
        run("list", "--all")
        out = capsys.readouterr().out
        assert out.index("[newer]") < out.index("[older]")

    def test_all_caps_the_history_and_counts_the_rest(self, spool, capsys):
        for n in range(reminders.ARCHIVE_LIMIT + 3):
            fired(spool, f"r{n}", f"reminder {n}", at=1000 + n)
        run("list", "--all")
        out = capsys.readouterr().out
        assert f"Fired ({reminders.ARCHIVE_LIMIT + 3})" in out
        assert "and 3 older" in out
        assert out.count("- [r") == reminders.ARCHIVE_LIMIT

    def test_all_tolerates_a_record_that_never_got_its_fire_time(self, spool, capsys):
        archive = spool / "archive"
        archive.mkdir(exist_ok=True)
        (archive / "a1.json").write_text(json.dumps(
            {"id": "a1", "text": "half-written", "at": 5000, "createdAt": 0}))
        run("list", "--all")
        assert "half-written" in capsys.readouterr().out


class TestUpdate:
    def test_changes_text_only_keeps_time(self, spool):
        reminders.write_reminder({"id": "a1", "text": "old", "at": 5000, "createdAt": 0})
        run("update", "a1", "--text", "new")
        saved = json.loads(reminders.path_for("a1").read_text())
        assert saved["text"] == "new"
        assert saved["at"] == 5000

    def test_reschedules(self, spool, frozen):
        reminders.write_reminder({"id": "a1", "text": "x", "at": 5000, "createdAt": 0})
        run("update", "a1", "--in", "1h")
        saved = json.loads(reminders.path_for("a1").read_text())
        assert saved["at"] == frozen + 3600 * 1000

    def test_targets_by_text_substring(self, spool):
        reminders.write_reminder({"id": "a1", "text": "call the dentist", "at": 5000, "createdAt": 0})
        run("update", "dentist", "--text", "call the dentist (morning)")
        assert json.loads(reminders.path_for("a1").read_text())["text"] == "call the dentist (morning)"

    def test_requires_a_change(self, spool):
        reminders.write_reminder({"id": "a1", "text": "x", "at": 5000, "createdAt": 0})
        with pytest.raises(SystemExit):
            run("update", "a1")

    def test_missing_reminder_errors(self, spool):
        with pytest.raises(SystemExit):
            run("update", "nope", "--text", "x")


class TestRemove:
    def test_by_id(self, spool):
        reminders.write_reminder({"id": "a1", "text": "x", "at": 5000, "createdAt": 0})
        run("remove", "a1")
        assert not reminders.path_for("a1").exists()

    def test_a_reminder_that_never_fired_leaves_no_record(self, spool):
        reminders.write_reminder({"id": "a1", "text": "x", "at": 5000, "createdAt": 0})
        run("remove", "a1")
        assert not (spool / "archive" / "a1.json").exists()

    def test_targets_by_text_substring(self, spool):
        reminders.write_reminder({"id": "a1", "text": "buy milk", "at": 5000, "createdAt": 0})
        run("remove", "milk")
        assert not reminders.path_for("a1").exists()

    def test_all(self, spool, capsys):
        reminders.write_reminder({"id": "a1", "text": "x", "at": 1, "createdAt": 0})
        reminders.write_reminder({"id": "a2", "text": "y", "at": 2, "createdAt": 0})
        run("remove", "--all")
        assert list(spool.glob("*.json")) == []
        assert "Removed 2 reminder(s)" in capsys.readouterr().out

    def test_all_leaves_the_archive_alone(self, spool):
        fired(spool, "kept", "already went out")
        reminders.write_reminder({"id": "a1", "text": "x", "at": 1, "createdAt": 0})
        run("remove", "--all")
        assert (spool / "archive" / "kept.json").exists()

    def test_missing_reminder_errors(self, spool):
        with pytest.raises(SystemExit):
            run("remove", "nope")

    def test_requires_query_or_all(self, spool):
        with pytest.raises(SystemExit):
            run("remove")

    def test_a_fired_reminder_cannot_be_removed(self, spool):
        fired(spool, "a1", "buy milk")
        with pytest.raises(SystemExit):
            run("remove", "milk")
        assert (spool / "archive" / "a1.json").exists()


class TestLoadAll:
    def test_skips_malformed_files(self, spool):
        reminders.write_reminder({"id": "ok", "text": "x", "at": 1, "createdAt": 0})
        (spool / "broken.json").write_text("{not json")
        loaded = reminders.load_all()
        assert [r["id"] for r in loaded] == ["ok"]


class TestArchive:
    def test_archive_dir_follows_the_spool(self, spool):
        assert reminders.archive_dir() == spool / "archive"

    def test_load_archived_skips_malformed_files(self, spool):
        fired(spool, "ok", "x")
        (spool / "archive" / "broken.json").write_text("{not json")
        assert [r["id"] for r in reminders.load_archived()] == ["ok"]

    def test_fired_at_falls_back_to_the_due_time(self):
        assert reminders.fired_at({"at": 500}) == 500
        assert reminders.fired_at({"at": 500, "firedAt": 900}) == 900

    def test_a_new_id_avoids_one_a_fired_reminder_used(self, spool, monkeypatch):
        fired(spool, "aaaaaa", "x")
        ids = iter(["aaaaaa", "bbbbbb"])
        monkeypatch.setattr(reminders.secrets, "token_hex", lambda n: next(ids))
        assert reminders.new_id() == "bbbbbb"


class TestFindReminder:
    def test_exact_id(self, spool):
        reminders.write_reminder({"id": "a1b2c3", "text": "call dentist", "at": 1, "createdAt": 0})
        assert reminders.find_reminder("a1b2c3")["text"] == "call dentist"

    def test_unique_id_prefix(self, spool):
        reminders.write_reminder({"id": "a1b2c3", "text": "x", "at": 1, "createdAt": 0})
        assert reminders.find_reminder("a1b")["id"] == "a1b2c3"

    def test_text_substring_is_case_insensitive(self, spool):
        reminders.write_reminder({"id": "a1", "text": "Call the Dentist", "at": 1, "createdAt": 0})
        reminders.write_reminder({"id": "b2", "text": "buy milk", "at": 2, "createdAt": 0})
        assert reminders.find_reminder("dentist")["id"] == "a1"

    def test_ambiguous_text_errors(self, spool):
        reminders.write_reminder({"id": "a1", "text": "call dentist", "at": 1, "createdAt": 0})
        reminders.write_reminder({"id": "b2", "text": "call vet", "at": 2, "createdAt": 0})
        with pytest.raises(SystemExit):
            reminders.find_reminder("call")

    def test_no_match_errors(self, spool):
        reminders.write_reminder({"id": "a1", "text": "x", "at": 1, "createdAt": 0})
        with pytest.raises(SystemExit):
            reminders.find_reminder("zzz")

    def test_a_fired_reminder_is_named_as_fired(self, spool, capsys):
        fired(spool, "a1", "call the dentist")
        with pytest.raises(SystemExit):
            reminders.find_reminder("dentist")
        err = capsys.readouterr().err
        assert "already fired" in err
        assert "list --all" in err

    def test_blank_query_errors(self, spool):
        with pytest.raises(SystemExit):
            reminders.find_reminder("   ")


class TestDelivery:
    def test_deliver_to_user_posts_and_returns_the_marker(self, monkeypatch):
        seen = {}

        class Resp:
            def read(self):
                return "\n[reminders: delivered to the user \u2713 - do not relay]\n".encode("utf-8")

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        def fake_urlopen(request, timeout=None):
            seen["url"] = request.full_url
            seen["data"] = request.data
            return Resp()

        monkeypatch.setattr(reminders.urllib.request, "urlopen", fake_urlopen)
        marker = reminders.deliver_to_user("hello")
        assert "source=reminders" in seen["url"]
        assert seen["data"] == b"hello"
        assert "delivered to the user" in marker

    def test_deliver_to_user_returns_error_body_on_http_error(self, monkeypatch):
        def raise_503(request, timeout=None):
            raise reminders.urllib.error.HTTPError(
                request.full_url, 503, "err", {},
                io.BytesIO("\n[reminders: delivery FAILED - relay the output above to the user yourself]\n".encode("utf-8")),
            )

        monkeypatch.setattr(reminders.urllib.request, "urlopen", raise_503)
        assert "delivery FAILED" in reminders.deliver_to_user("hello")

    def test_deliver_to_user_returns_none_when_unreachable(self, monkeypatch):
        def boom(request, timeout=None):
            raise OSError("refused")

        monkeypatch.setattr(reminders.urllib.request, "urlopen", boom)
        assert reminders.deliver_to_user("hello") is None


class TestAudience:
    def invoke(self, monkeypatch, *argv):
        monkeypatch.setattr(sys, "argv", ["reminders.py", *argv])
        reminders.main()

    def spy(self, monkeypatch):
        sent = []

        def fake(text):
            sent.append(text)
            return "\n[reminders: delivered to the user \u2713 - do not relay]\n"

        monkeypatch.setattr(reminders, "deliver_to_user", fake)
        return sent

    def test_a_plain_command_sends_its_result(self, spool, monkeypatch, capsys):
        sent = self.spy(monkeypatch)
        self.invoke(monkeypatch, "add", "--text", "call the dentist", "--in", "1h")
        assert len(sent) == 1
        assert "call the dentist" in sent[0]

    def test_nothing_can_be_read_or_changed_out_of_the_users_sight(self):
        parser = reminders.build_parser()
        for argv in (["add", "--text", "x", "--in", "1h"], ["list"], ["list", "--all"],
                     ["update", "x", "--text", "y"], ["remove", "--all"]):
            with pytest.raises(SystemExit):
                parser.parse_args([*argv, "--quiet"])

    def test_a_workspace_that_is_not_there_is_an_error_not_an_empty_spool(self, monkeypatch,
                                                                         tmp_path, capsys):
        monkeypatch.setattr(reminders, "WORKSPACE", tmp_path / "nope")
        with pytest.raises(SystemExit):
            self.invoke(monkeypatch, "list")
        assert "No reminders." not in capsys.readouterr().out
