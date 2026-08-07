import io
import urllib.error
from urllib.parse import parse_qs, urlparse

import image
import pytest


def run(*argv):
    args = image.build_parser().parse_args(list(argv))
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
        return Response("\n[image: delivered to the user \u2713]\n")

    monkeypatch.setattr(image.urllib.request, "urlopen", fake_urlopen)
    return sent


def query(request) -> dict:
    return {k: v[0] for k, v in parse_qs(urlparse(request.full_url).query).items()}


class TestDeliver:
    def test_it_posts_to_the_apps_hook_on_this_machine(self, hook, tmp_path):
        run("send", str(tmp_path / "x.png"))
        url = urlparse(hook[0].full_url)
        assert url.hostname == "127.0.0.1"
        assert url.port == 8080
        assert url.path == "/internal/skill-image"
        assert hook[0].get_method() == "POST"

    def test_the_port_follows_the_app(self, hook, tmp_path, monkeypatch):
        monkeypatch.setenv("PORT", "9099")
        run("send", str(tmp_path / "x.png"))
        assert urlparse(hook[0].full_url).port == 9099

    def test_the_picture_is_named_in_the_query(self, hook, tmp_path):
        target = tmp_path / "receipt.jpg"
        run("send", str(target))
        assert query(hook[0])["path"] == str(target)

    def test_the_caption_is_the_body(self, hook, tmp_path):
        run("send", str(tmp_path / "x.png"), "--caption", "the one from Tuesday")
        assert hook[0].data == b"the one from Tuesday"
        assert hook[0].headers["Content-type"] == "text/plain; charset=utf-8"

    def test_a_caption_survives_everything_a_caption_can_contain(self, hook, tmp_path):
        caption = 'two\nlines, "quoted" & 50% \u2705'
        run("send", str(tmp_path / "x.png"), "--caption", caption)
        assert hook[0].data.decode("utf-8") == caption

    def test_no_caption_sends_the_picture_alone(self, hook, tmp_path):
        run("send", str(tmp_path / "x.png"))
        assert hook[0].data == b""

    def test_it_is_recorded_as_an_image_by_default(self, hook, tmp_path):
        run("send", str(tmp_path / "x.png"))
        assert query(hook[0])["source"] == "image"

    def test_another_skill_can_say_what_it_is(self, hook, tmp_path):
        run("send", str(tmp_path / "x.png"), "--source", "diagram")
        assert query(hook[0])["source"] == "diagram"

    def test_a_relative_path_is_made_absolute(self, hook, tmp_path, monkeypatch):
        # The app resolves what it is handed against its own directory, not the caller's.
        monkeypatch.chdir(tmp_path)
        (tmp_path / "here.png").write_bytes(b"x")
        run("send", "here.png")
        assert query(hook[0])["path"] == str(tmp_path / "here.png")

    def test_a_home_relative_path_is_expanded(self, hook, monkeypatch, tmp_path):
        monkeypatch.setenv("HOME", str(tmp_path))
        run("send", "~/photo.png")
        assert query(hook[0])["path"] == str(tmp_path / "photo.png")


class TestOutcome:
    def test_a_sent_picture_echoes_the_marker_and_succeeds(self, hook, tmp_path, capsys):
        run("send", str(tmp_path / "x.png"))
        assert "delivered to the user" in capsys.readouterr().out

    def test_a_refused_file_is_reported_as_itself_and_fails(self, monkeypatch, tmp_path, capsys):
        def refuse(request, timeout=None):
            raise urllib.error.HTTPError(
                request.full_url, 400, "bad", {},
                io.BytesIO(b"cannot send /tmp/x.pdf: that file is not an image\n"),
            )

        monkeypatch.setattr(image.urllib.request, "urlopen", refuse)
        with pytest.raises(SystemExit) as exit_info:
            run("send", str(tmp_path / "x.pdf"))
        assert exit_info.value.code == 1
        assert "not an image" in capsys.readouterr().out

    def test_an_undeliverable_picture_echoes_the_failed_marker_and_fails(
        self, monkeypatch, tmp_path, capsys
    ):
        def unavailable(request, timeout=None):
            raise urllib.error.HTTPError(
                request.full_url, 503, "down", {},
                io.BytesIO(b"\n[image: delivery FAILED - relay the output above yourself]\n"),
            )

        monkeypatch.setattr(image.urllib.request, "urlopen", unavailable)
        with pytest.raises(SystemExit):
            run("send", str(tmp_path / "x.png"))
        assert "delivery FAILED" in capsys.readouterr().out

    def test_an_unreachable_app_says_so_rather_than_hanging_silently(
        self, monkeypatch, tmp_path, capsys
    ):
        def refused(request, timeout=None):
            raise OSError("Connection refused")

        monkeypatch.setattr(image.urllib.request, "urlopen", refused)
        with pytest.raises(SystemExit) as exit_info:
            run("send", str(tmp_path / "x.png"), "--source", "diagram")
        assert exit_info.value.code == 1
        out = capsys.readouterr().out
        assert "could not reach the app" in out
        assert out.startswith("\n[diagram:")  # tagged as whoever was sending
