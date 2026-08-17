import io
import os
import time
import urllib.error
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import files
import pytest


def run(*argv):
    args = files.build_parser().parse_args(list(argv))
    args.func(args)


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
    sent = []

    def fake_urlopen(request, timeout=None):
        sent.append(request)
        return Response("\n[files: delivered to the user \u2713]\n")

    monkeypatch.setattr(files.urllib.request, "urlopen", fake_urlopen)
    return sent


@pytest.fixture
def store(tmp_path, monkeypatch):
    """A file store as the app leaves it: one directory per file, named after its message."""
    root = tmp_path / "files"
    root.mkdir()
    monkeypatch.setattr(files, "FILES_DIR", root)
    monkeypatch.setattr(files, "RETENTION_DAYS", 30)
    return root


def received(store, holder: str, name: str, *, size: int = 10, days_ago: float = 0):
    path = store / holder / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"x" * size)
    when = time.time() - days_ago * files.DAY_SECONDS
    os.utime(path, (when, when))
    return path


def query(request) -> dict:
    return {k: v[0] for k, v in parse_qs(urlparse(request.full_url).query).items()}


class TestHumanBytes:
    def test_it_reads_the_way_a_person_reads_a_size(self):
        assert files.human_bytes(512) == "512 B"
        assert files.human_bytes(151552) == "148 KB"
        assert files.human_bytes(2306867) == "2.2 MB"
        assert files.human_bytes(3 * 1024**3) == "3.0 GB"


class TestSend:
    def test_it_posts_to_the_apps_hook_on_this_machine(self, hook, tmp_path):
        run("send", str(tmp_path / "notes.zip"))
        url = urlparse(hook[0].full_url)
        assert url.hostname == "127.0.0.1"
        assert url.port == 8080
        assert url.path == "/internal/skill-file"
        assert hook[0].get_method() == "POST"

    def test_the_port_follows_the_app(self, hook, tmp_path, monkeypatch):
        monkeypatch.setenv("PORT", "9099")
        run("send", str(tmp_path / "notes.zip"))
        assert urlparse(hook[0].full_url).port == 9099

    def test_the_file_is_named_in_the_query_and_stays_a_path(self, hook, tmp_path):
        target = tmp_path / "bike-notes.zip"
        run("send", str(target))
        assert query(hook[0])["path"] == str(target)
        assert hook[0].data == b""

    def test_the_caption_is_the_body(self, hook, tmp_path):
        run("send", str(tmp_path / "notes.zip"), "--caption", "12 notes from your vault")
        assert hook[0].data == "12 notes from your vault".encode("utf-8")
        assert hook[0].headers["Content-type"] == "text/plain; charset=utf-8"

    def test_a_caption_survives_everything_a_caption_can_contain(self, hook, tmp_path):
        caption = 'two\nlines, "quoted" & 50% \u2705'
        run("send", str(tmp_path / "notes.zip"), "--caption", caption)
        assert hook[0].data.decode("utf-8") == caption

    def test_it_is_recorded_as_files_by_default(self, hook, tmp_path):
        run("send", str(tmp_path / "notes.zip"))
        assert query(hook[0])["source"] == "files"

    def test_a_relative_path_is_made_absolute(self, hook, tmp_path, monkeypatch):
        # The app resolves what it is handed against its own directory, not the caller's.
        monkeypatch.chdir(tmp_path)
        (tmp_path / "here.zip").write_bytes(b"x")
        run("send", "here.zip")
        assert query(hook[0])["path"] == str(tmp_path / "here.zip")

    def test_a_sent_file_echoes_the_marker_and_succeeds(self, hook, tmp_path, capsys):
        run("send", str(tmp_path / "notes.zip"))
        assert "delivered to the user" in capsys.readouterr().out

    def test_a_refused_file_is_reported_as_itself_and_fails(self, monkeypatch, tmp_path, capsys):
        def refuse(request, timeout=None):
            raise urllib.error.HTTPError(
                request.full_url, 400, "bad", {},
                io.BytesIO(b"cannot send /tmp/x: the file is 612.0 MB, and I only send files up to 100.0 MB\n"),
            )

        monkeypatch.setattr(files.urllib.request, "urlopen", refuse)
        with pytest.raises(SystemExit) as exit_info:
            run("send", str(tmp_path / "holiday.mp4"))
        assert exit_info.value.code == 1
        assert "cannot send" in capsys.readouterr().out

    def test_an_unreachable_app_says_so_rather_than_hanging_silently(
        self, monkeypatch, tmp_path, capsys
    ):
        def refused(request, timeout=None):
            raise OSError("Connection refused")

        monkeypatch.setattr(files.urllib.request, "urlopen", refused)
        with pytest.raises(SystemExit):
            run("send", str(tmp_path / "notes.zip"))
        assert "could not reach the app" in capsys.readouterr().out


class TestList:
    def test_it_says_so_when_nothing_has_been_sent_to_apollo(self, store, capsys):
        run("list")
        assert "No files from the user" in capsys.readouterr().out

    def test_it_names_each_file_with_its_size_and_its_path(self, store, capsys):
        received(store, "8f21c4a9", "Handbook.pdf", size=2306867)
        run("list")
        out = capsys.readouterr().out
        assert "Handbook.pdf" in out
        assert "2.2 MB" in out
        assert str(store / "8f21c4a9" / "Handbook.pdf") in out

    def test_newest_first(self, store, capsys):
        received(store, "old", "older.pdf", days_ago=5)
        received(store, "new", "newer.pdf")
        run("list")
        out = capsys.readouterr().out
        assert out.index("newer.pdf") < out.index("older.pdf")

    def test_it_counts_down_rather_than_cataloguing(self, store, capsys):
        received(store, "a", "Handbook.pdf", days_ago=2)
        run("list")
        assert "28 days left" in capsys.readouterr().out

    def test_a_file_past_its_time_says_it_is_going(self, store, capsys):
        received(store, "a", "Handbook.pdf", days_ago=31)
        run("list")
        assert "deleted in the next sweep" in capsys.readouterr().out

    def test_it_repeats_the_one_rule_that_matters(self, store, capsys):
        received(store, "a", "Handbook.pdf")
        run("list")
        assert "moved to the workspace or the vault" in capsys.readouterr().out

    def test_a_store_that_does_not_exist_yet_is_simply_empty(self, tmp_path, monkeypatch, capsys):
        monkeypatch.setattr(files, "FILES_DIR", tmp_path / "never-created")
        run("list")
        assert "No files from the user" in capsys.readouterr().out

    def test_it_ignores_anything_that_is_not_a_received_file(self, store, capsys):
        received(store, "a", "Handbook.pdf")
        (store / "stray.txt").write_text("not mine")
        run("list")
        out = capsys.readouterr().out
        assert "1 file(s)" in out
        assert "stray.txt" not in out
