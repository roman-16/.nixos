import argparse
import io
import sys
import urllib.error
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import apollo
import pytest


class Response:
    def __init__(self, body):
        self.body = body

    def read(self):
        return self.body.encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


@pytest.fixture
def hook(monkeypatch):
    """Stands in for the app's localhost hook, recording what it was asked to send."""
    seen = []

    def fake_urlopen(request, timeout=None):
        seen.append(request)
        return Response("\n[skill: delivered to the user \u2713]\n")

    monkeypatch.setattr(apollo.urllib.request, "urlopen", fake_urlopen)
    return seen


@pytest.fixture(autouse=True)
def no_notes():
    apollo.NOTES.clear()
    yield
    apollo.NOTES.clear()


def query(request) -> dict:
    return {k: v[0] for k, v in parse_qs(urlparse(request.full_url).query).items()}


def parser(**kinds) -> argparse.ArgumentParser:
    """A parser with one command per name, each printing what it was told to."""
    p = argparse.ArgumentParser(prog="skill.py")
    sub = p.add_subparsers(dest="cmd", required=True)
    for name, declaration in kinds.items():
        command = apollo.command(sub, name, **declaration)
        command.set_defaults(func=lambda args: print(f"the result of {args.cmd}"))
    return p


def invoke(monkeypatch, p, *argv, workspace=None):
    monkeypatch.setattr(sys, "argv", ["skill.py", *argv])
    apollo.run("skill", p, workspace=workspace)


@pytest.fixture
def sent(monkeypatch):
    """What reached the user, with the app answering that it did."""
    delivered = []

    def fake(skill, text):
        delivered.append(text)
        return apollo.Delivery(True, f"\n[{skill}: delivered to the user \u2713]\n")

    monkeypatch.setattr(apollo, "send_message", fake)
    return delivered


class TestPost:
    def test_it_posts_to_the_apps_hook_on_this_machine(self, hook):
        apollo.post("macros", "skill-message", "hello", timeout=8, unreachable="{error}")
        url = urlparse(hook[0].full_url)
        assert url.hostname == "127.0.0.1"
        assert url.port == 8080
        assert url.path == "/internal/skill-message"
        assert hook[0].get_method() == "POST"

    def test_the_port_follows_the_app(self, hook, monkeypatch):
        monkeypatch.setenv("PORT", "9099")
        apollo.post("macros", "skill-message", "hello", timeout=8, unreachable="{error}")
        assert urlparse(hook[0].full_url).port == 9099

    def test_what_the_user_reads_is_the_body(self, hook):
        apollo.post("macros", "skill-message", "hello", timeout=8, unreachable="{error}")
        assert hook[0].data == b"hello"
        assert hook[0].headers["Content-type"] == "text/plain; charset=utf-8"

    def test_the_skill_is_the_source_and_the_rest_is_the_query(self, hook):
        apollo.post("image", "skill-image", "", timeout=8, unreachable="{error}", path="/tmp/x.png")
        assert query(hook[0]) == {"source": "image", "path": "/tmp/x.png"}

    def test_a_delivered_send_passes_on_the_apps_marker(self, hook):
        delivery = apollo.post("macros", "skill-message", "hello", timeout=8, unreachable="{error}")
        assert delivery.delivered is True
        assert "delivered to the user" in delivery.marker

    def test_a_refusal_is_reported_as_itself_and_is_not_a_delivery(self, monkeypatch):
        def refuse(request, timeout=None):
            raise urllib.error.HTTPError(
                request.full_url, 400, "bad", {},
                io.BytesIO(b"cannot send /tmp/x.pdf: that file is not an image\n"),
            )

        monkeypatch.setattr(apollo.urllib.request, "urlopen", refuse)
        delivery = apollo.send_image("image", Path("/tmp/x.pdf"), "")
        assert delivery.delivered is False
        assert "not an image" in delivery.marker

    def test_an_unreachable_app_is_described_in_our_own_words(self, monkeypatch):
        monkeypatch.setattr(apollo.urllib.request, "urlopen",
                            lambda request, timeout=None: (_ for _ in ()).throw(OSError("refused")))
        delivery = apollo.send_message("macros", "hello")
        assert delivery.delivered is False
        assert delivery.marker.startswith("\n[macros: delivery FAILED (refused)")
        assert "relay the output above" in delivery.marker

    def test_a_picture_and_a_file_go_to_their_own_hooks(self, hook):
        apollo.send_image("diagram", Path("/tmp/flow.png"), "how it flows")
        apollo.send_file("files", Path("/tmp/notes.zip"), "")
        assert urlparse(hook[0].full_url).path == "/internal/skill-image"
        assert query(hook[0]) == {"source": "diagram", "path": "/tmp/flow.png"}
        assert hook[0].data == b"how it flows"
        assert urlparse(hook[1].full_url).path == "/internal/skill-file"
        assert query(hook[1]) == {"source": "files", "path": "/tmp/notes.zip"}

    def test_an_upload_is_given_longer_than_a_message(self):
        assert apollo.MESSAGE_TIMEOUT < apollo.IMAGE_TIMEOUT < apollo.FILE_TIMEOUT


class TestCommand:
    def test_a_reading_takes_send_and_a_receipt_does_not(self):
        p = parser(show={"kind": apollo.Kind.READING}, log={})
        assert p.parse_args(["show", "--send"]).send is True
        assert p.parse_args(["log"]).send is False
        with pytest.raises(SystemExit):
            p.parse_args(["log", "--send"])

    def test_machinery_takes_neither_flag(self):
        p = parser(config={"kind": apollo.Kind.MACHINERY})
        for flag in ("--send", "--dry-run"):
            with pytest.raises(SystemExit):
                p.parse_args(["config", flag])

    def test_a_command_that_previews_takes_both(self):
        p = parser(eat={"previews": True})
        args = p.parse_args(["eat", "--dry-run", "--send"])
        assert (args.dry_run, args.send) == (True, True)

    def test_a_receipt_is_what_a_command_is_unless_it_says_otherwise(self):
        assert parser(log={}).parse_args(["log"]).kind is apollo.Kind.RECEIPT

    def test_full_length_flags_only(self):
        p = parser(show={"kind": apollo.Kind.READING}, eat={"previews": True})
        for argv in (["show", "-s"], ["eat", "-d"]):
            with pytest.raises(SystemExit):
                p.parse_args(argv)


class TestDelivers:
    def declared(self, **kinds):
        return parser(**kinds).parse_args([next(iter(kinds))])

    def test_a_receipt_goes_out_by_itself(self):
        assert apollo.delivers(self.declared(log={})) is True

    def test_a_reading_goes_out_only_when_it_is_asked_for(self):
        p = parser(show={"kind": apollo.Kind.READING})
        assert apollo.delivers(p.parse_args(["show"])) is False
        assert apollo.delivers(p.parse_args(["show", "--send"])) is True

    def test_a_preview_is_a_reading_however_the_command_is_declared(self):
        p = parser(eat={"previews": True})
        assert apollo.delivers(p.parse_args(["eat", "--dry-run"])) is False
        assert apollo.delivers(p.parse_args(["eat", "--dry-run", "--send"])) is True
        assert apollo.delivers(p.parse_args(["eat"])) is True

    def test_machinery_never_goes_out(self):
        assert apollo.delivers(self.declared(config={"kind": apollo.Kind.MACHINERY})) is False


class TestRun:
    def test_a_receipt_reaches_the_user_and_is_printed_here_too(self, monkeypatch, sent, capsys):
        invoke(monkeypatch, parser(log={}), "log")
        out = capsys.readouterr().out
        assert sent == ["the result of log\n"]
        assert "the result of log" in out
        assert "delivered to the user" in out

    def test_a_reading_stays_here_and_names_the_flag_that_would_send_it(self, monkeypatch, sent,
                                                                       capsys):
        invoke(monkeypatch, parser(show={"kind": apollo.Kind.READING}), "show")
        out = capsys.readouterr().out
        assert sent == []
        assert "the result of show" in out
        assert "[skill: not sent to the user - add --send to deliver it]" in out

    def test_a_reading_that_is_asked_for_reaches_the_user(self, monkeypatch, sent, capsys):
        invoke(monkeypatch, parser(show={"kind": apollo.Kind.READING}), "show", "--send")
        assert sent == ["the result of show\n"]
        assert "delivered to the user" in capsys.readouterr().out

    def test_machinery_says_nothing_about_delivery_at_all(self, monkeypatch, sent, capsys):
        invoke(monkeypatch, parser(config={"kind": apollo.Kind.MACHINERY}), "config")
        out = capsys.readouterr().out
        assert sent == []
        assert "the result of config" in out
        assert "not sent to the user" not in out

    def test_asking_to_send_a_change_is_refused_because_it_goes_out_regardless(self, monkeypatch,
                                                                              sent, capsys):
        with pytest.raises(SystemExit) as exit_info:
            invoke(monkeypatch, parser(eat={"previews": True}), "eat", "--send")
        assert exit_info.value.code == 1
        assert "--send only applies with --dry-run" in capsys.readouterr().err
        assert sent == []

    def test_nothing_printed_is_nothing_sent(self, monkeypatch, sent, capsys):
        p = argparse.ArgumentParser()
        sub = p.add_subparsers(dest="cmd", required=True)
        apollo.command(sub, "log").set_defaults(func=lambda args: None)
        invoke(monkeypatch, p, "log")
        assert sent == []
        assert capsys.readouterr().out == ""

    def test_a_send_that_never_happened_fails_loudly(self, monkeypatch, capsys):
        monkeypatch.setattr(apollo, "send_message",
                            lambda skill, text: apollo.Delivery(False, "\n[skill: delivery FAILED]\n"))
        with pytest.raises(SystemExit) as exit_info:
            invoke(monkeypatch, parser(log={}), "log")
        assert exit_info.value.code == 1
        assert "delivery FAILED" in capsys.readouterr().out

    def test_a_note_is_written_after_the_result_and_never_sent(self, monkeypatch, sent, capsys):
        p = argparse.ArgumentParser()
        sub = p.add_subparsers(dest="cmd", required=True)
        apollo.command(sub, "log").set_defaults(
            func=lambda args: (print("the result"), apollo.hint("[skill] a private note"))
        )
        invoke(monkeypatch, p, "log")
        out = capsys.readouterr().out
        assert sent == ["the result\n"]
        assert "a private note" not in sent[0]
        assert out.index("the result") < out.index("a private note")
        assert apollo.NOTES == []

    def test_a_workspace_that_is_not_there_is_an_error_not_an_empty_store(self, monkeypatch,
                                                                         tmp_path, sent, capsys):
        with pytest.raises(SystemExit) as exit_info:
            invoke(monkeypatch, parser(log={}), "log", workspace=tmp_path / "nope")
        assert exit_info.value.code == 1
        assert "no workspace at" in capsys.readouterr().err
        assert sent == []

    def test_a_command_that_dies_still_shows_what_it_had_printed(self, monkeypatch, sent, capsys):
        p = argparse.ArgumentParser()
        sub = p.add_subparsers(dest="cmd", required=True)
        apollo.command(sub, "log").set_defaults(
            func=lambda args: (print("half a result"), apollo.die("that cannot be done"))
        )
        with pytest.raises(SystemExit):
            invoke(monkeypatch, p, "log")
        captured = capsys.readouterr()
        assert "half a result" in captured.out
        assert "error: that cannot be done" in captured.err
        assert sent == []
