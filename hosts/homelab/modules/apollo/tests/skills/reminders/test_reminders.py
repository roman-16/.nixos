import io
import json
from datetime import datetime

import pytest
import reminders


def run(*argv):
    args = reminders.build_parser().parse_args(list(argv))
    args.func(args)


@pytest.fixture
def spool(tmp_path, monkeypatch):
    monkeypatch.setattr(reminders, "REMINDERS_DIR", tmp_path)
    return tmp_path


@pytest.fixture
def frozen(monkeypatch):
    monkeypatch.setattr(reminders, "now_ms", lambda: 1_000_000)
    return 1_000_000


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

    def test_missing_reminder_errors(self, spool):
        with pytest.raises(SystemExit):
            run("remove", "nope")

    def test_requires_query_or_all(self, spool):
        with pytest.raises(SystemExit):
            run("remove")


class TestLoadAll:
    def test_skips_malformed_files(self, spool):
        reminders.write_reminder({"id": "ok", "text": "x", "at": 1, "createdAt": 0})
        (spool / "broken.json").write_text("{not json")
        loaded = reminders.load_all()
        assert [r["id"] for r in loaded] == ["ok"]


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
