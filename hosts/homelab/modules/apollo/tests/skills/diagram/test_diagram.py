from pathlib import Path

import diagram
import pytest


def run(*argv):
    args = diagram.build_parser().parse_args(list(argv))
    args.func(args)


class TestPreflight:
    def hints(self, source: str) -> str:
        return " | ".join(diagram.preflight(source))

    def test_a_plain_diagram_needs_no_warning(self):
        assert diagram.preflight("flowchart TD\n  A[Start] --> B[Finish]") == []

    def test_a_node_called_end_is_the_keyword_that_closes_a_block(self):
        assert "closes a block" in self.hints("flowchart TD\n  A --> end[Done]")

    def test_a_legitimate_end_closing_a_subgraph_is_left_alone(self):
        source = "flowchart TD\n  subgraph one\n    A --> B\n  end\n  B --> C"
        assert self.hints(source) == ""

    def test_a_capitalised_end_is_a_perfectly_good_node(self):
        assert self.hints("flowchart TD\n  A --> End[Done]") == ""

    def test_brackets_inside_an_unquoted_label(self):
        assert "quoted" in self.hints("flowchart TD\n  A[Pay (in cash)] --> B[Done]")

    def test_the_same_label_quoted_is_fine(self):
        assert self.hints('flowchart TD\n  A["Pay (in cash)"] --> B[Done]') == ""

    def test_round_and_square_nodes_side_by_side_are_not_confused(self):
        assert self.hints("flowchart TD\n  A(Start) --> B[Finish]") == ""

    def test_a_sideways_graph_reads_small_on_a_phone(self):
        assert "flowchart TD" in self.hints("flowchart LR\n  A --> B")
        assert "flowchart TD" in self.hints("graph RL\n  A --> B")

    def test_top_down_draws_no_comment(self):
        assert self.hints("flowchart TD\n  A --> B") == ""

    def test_a_sequence_diagram_is_never_called_sideways(self):
        assert self.hints("sequenceDiagram\n  A->>B: hi") == ""

    def test_several_problems_are_all_reported(self):
        assert len(diagram.preflight("flowchart LR\n  A[Pay (cash)] --> end[Done]")) == 3


class TestBuildCommand:
    def command(self) -> list:
        return diagram.build_command(Path("/tmp/x.mmd"), Path("/tmp/x.png"))

    def test_it_renders_the_source_to_the_output(self):
        command = self.command()
        assert command[0] == "mmdc"
        assert "--input" in command and "/tmp/x.mmd" in command
        assert "--output" in command and "/tmp/x.png" in command

    def test_every_diagram_gets_the_same_house_style(self):
        command = self.command()
        for flag, value in (
            ("--backgroundColor", diagram.BACKGROUND),
            ("--width", str(diagram.WIDTH)),
            ("--scale", str(diagram.SCALE)),
        ):
            assert command[command.index(flag) + 1] == value

    def test_it_carries_the_shared_config_and_the_sandbox_settings(self):
        command = self.command()
        assert command[command.index("--configFile") + 1].endswith("mermaid-config.json")
        assert command[command.index("--puppeteerConfigFile") + 1].endswith("puppeteer.json")

    def test_the_style_files_ship_with_the_skill(self):
        assert diagram.CONFIG.is_file()
        assert diagram.PUPPETEER.is_file()

    def test_full_length_flags_only(self):
        assert not [arg for arg in self.command() if arg.startswith("-") and not arg.startswith("--")]


class TestRenderCommand:
    def test_a_missing_source_is_refused_before_anything_starts(self, tmp_path, capsys):
        with pytest.raises(SystemExit):
            run("render", str(tmp_path / "nope.mmd"))
        assert "no diagram source" in capsys.readouterr().err

    def test_an_empty_source_is_refused(self, tmp_path, capsys):
        source = tmp_path / "empty.mmd"
        source.write_text("   \n")
        with pytest.raises(SystemExit):
            run("render", str(source))
        assert "empty" in capsys.readouterr().err

    def test_a_failed_render_sends_nothing_and_says_so(self, tmp_path, capsys, monkeypatch):
        source = tmp_path / "broken.mmd"
        source.write_text("flowchart TD\n  A --> end[Done]")
        sent = []
        monkeypatch.setattr(diagram, "deliver", lambda *args: sent.append(args) or (True, ""))
        monkeypatch.setattr(diagram, "render", lambda *args: diagram.die("Parse error on line 2"))
        with pytest.raises(SystemExit):
            run("render", str(source))
        captured = capsys.readouterr()
        assert sent == []
        assert "Parse error" in captured.err
        # The hint that explains the parse error is printed before the renderer's own message.
        assert "closes a block" in captured.out

    def test_a_drawn_diagram_is_delivered_with_its_caption(self, tmp_path, monkeypatch):
        source = tmp_path / "flow.mmd"
        source.write_text("flowchart TD\n  A --> B")
        out = tmp_path / "flow.png"
        sent = []
        monkeypatch.setattr(diagram, "render", lambda _source, target: target.write_bytes(b"x" * 2000))
        monkeypatch.setattr(
            diagram, "deliver", lambda image, caption: (sent.append((image, caption)), (True, ""))[1]
        )
        run("render", str(source), "--caption", "how it flows", "--out", str(out))
        assert sent == [(out, "how it flows")]

    def test_no_caption_delivers_the_picture_alone(self, tmp_path, monkeypatch):
        source = tmp_path / "flow.mmd"
        source.write_text("flowchart TD\n  A --> B")
        sent = []
        monkeypatch.setattr(diagram, "render", lambda _source, target: target.write_bytes(b"x" * 2000))
        monkeypatch.setattr(
            diagram, "deliver", lambda image, caption: (sent.append((image, caption)), (True, ""))[1]
        )
        run("render", str(source), "--out", str(tmp_path / "flow.png"))
        assert sent[0][1] == ""

    def test_quiet_draws_it_and_sends_nothing(self, tmp_path, capsys, monkeypatch):
        source = tmp_path / "flow.mmd"
        source.write_text("flowchart TD\n  A --> B")
        out = tmp_path / "flow.png"
        sent = []
        monkeypatch.setattr(diagram, "render", lambda _source, target: target.write_bytes(b"x" * 2000))
        monkeypatch.setattr(diagram, "deliver", lambda *args: sent.append(args) or (True, ""))
        run("render", str(source), "--quiet", "--out", str(out))
        captured = capsys.readouterr().out
        assert sent == []
        assert str(out) in captured
        assert "quiet - not sent to the user" in captured


class TestPngSize:
    def test_it_reads_the_header(self, tmp_path):
        # A real PNG, so the header layout is not being taken on trust.
        png = tmp_path / "x.png"
        png.write_bytes(bytes.fromhex(
            "89504e470d0a1a0a0000000d49484452000003c0000000ab0806000000"
        ))
        assert diagram.png_size(png.read_bytes()) == (960, 171)

    def test_anything_that_is_not_a_png_reads_as_nothing(self):
        assert diagram.png_size(b"") is None
        assert diagram.png_size(b"not a png at all, but long enough to measure") is None


class TestShapeHint:
    def test_a_well_proportioned_picture_draws_no_comment(self):
        assert diagram.shape_hint(960, 1200) is None
        assert diagram.shape_hint(800, 600) is None

    def test_a_long_column_is_called_out(self):
        # The eight-step flowchart that started this: 960x2739.
        hint = diagram.shape_hint(960, 2739)
        assert "960x2739" in hint
        assert "column" in hint

    def test_a_wide_strip_is_called_out_with_the_fix(self):
        # The same seven steps drawn sideways: 2952x129.
        hint = diagram.shape_hint(2952, 129)
        assert "strip" in hint
        assert "flowchart TD" in hint

    def test_a_shape_right_at_the_limit_is_left_alone(self):
        assert diagram.shape_hint(1000, int(1000 * diagram.MAX_ASPECT)) is None

    def test_nothing_is_said_about_an_impossible_size(self):
        assert diagram.shape_hint(0, 100) is None


class TestDelivery:
    def draw(self, tmp_path, monkeypatch, answer):
        source = tmp_path / "flow.mmd"
        source.write_text("flowchart TD\n  A --> B")
        monkeypatch.setattr(diagram, "render", lambda _s, target: target.write_bytes(b"x" * 2000))
        monkeypatch.setattr(diagram, "deliver", lambda *args: answer)
        return source

    def test_a_delivered_diagram_echoes_the_marker_and_succeeds(self, tmp_path, monkeypatch, capsys):
        source = self.draw(tmp_path, monkeypatch, (True, "\n[diagram: delivered to the user \u2713]\n"))
        run("render", str(source), "--out", str(tmp_path / "flow.png"))
        assert "delivered to the user" in capsys.readouterr().out

    def test_a_failed_delivery_says_so_and_fails_loudly(self, tmp_path, monkeypatch, capsys):
        source = self.draw(tmp_path, monkeypatch, (False, "\n[diagram: delivery FAILED]\n"))
        with pytest.raises(SystemExit) as exit_info:
            run("render", str(source), "--out", str(tmp_path / "flow.png"))
        assert exit_info.value.code == 1
        assert "delivery FAILED" in capsys.readouterr().out


class TestHandOff:
    """Drawing is this skill's job; getting the picture to the user is the image skill's."""

    def invoke(self, tmp_path, monkeypatch, returncode=0, stdout="ok", stderr=""):
        calls = []

        class Done:
            def __init__(self):
                self.returncode = returncode
                self.stdout = stdout
                self.stderr = stderr

        def fake_run(command, **kwargs):
            calls.append(command)
            return Done()

        monkeypatch.setattr(diagram.subprocess, "run", fake_run)
        return calls, diagram.deliver(tmp_path / "flow.png", "how it flows")

    def test_it_hands_the_picture_to_the_image_skill(self, tmp_path, monkeypatch):
        calls, _ = self.invoke(tmp_path, monkeypatch)
        assert str(diagram.IMAGE) in calls[0]
        assert "send" in calls[0]
        assert str(tmp_path / "flow.png") in calls[0]

    def test_the_chat_records_it_as_a_diagram_not_an_image(self, tmp_path, monkeypatch):
        calls, _ = self.invoke(tmp_path, monkeypatch)
        assert calls[0][calls[0].index("--source") + 1] == "diagram"

    def test_the_caption_is_passed_along(self, tmp_path, monkeypatch):
        calls, _ = self.invoke(tmp_path, monkeypatch)
        assert calls[0][calls[0].index("--caption") + 1] == "how it flows"

    def test_no_caption_flag_when_there_is_no_caption(self, tmp_path, monkeypatch):
        calls = []
        monkeypatch.setattr(diagram.subprocess, "run",
                            lambda command, **kw: calls.append(command) or type(
                                "D", (), {"returncode": 0, "stdout": "", "stderr": ""})())
        diagram.deliver(tmp_path / "flow.png", "")
        assert "--caption" not in calls[0]

    def test_the_image_skills_answer_is_passed_on_exactly(self, tmp_path, monkeypatch):
        _, (delivered, marker) = self.invoke(
            tmp_path, monkeypatch, stdout="\n[diagram: delivered to the user \u2713]\n")
        assert delivered is True
        assert marker == "\n[diagram: delivered to the user \u2713]\n"

    def test_a_refusal_is_reported_as_a_failure(self, tmp_path, monkeypatch):
        _, (delivered, marker) = self.invoke(
            tmp_path, monkeypatch, returncode=1, stdout="cannot send: not an image")
        assert delivered is False
        assert "cannot send" in marker

    def test_a_missing_image_skill_fails_instead_of_crashing(self, tmp_path, monkeypatch):
        def missing(command, **kwargs):
            raise FileNotFoundError("no such file")

        monkeypatch.setattr(diagram.subprocess, "run", missing)
        delivered, marker = diagram.deliver(tmp_path / "flow.png", "x")
        assert delivered is False
        assert "could not be sent" in marker


class TestSkillLayout:
    def test_the_image_skill_is_found_next_door(self):
        # Each skill is its own store path on the VM, so resolving symlinks here would look for a
        # sibling outside the skills directory and never find one.
        assert diagram.IMAGE.name == "image.py"
        assert diagram.IMAGE.parent.parent.name == "image"
        assert diagram.IMAGE.parent.parent.parent == diagram.SKILL.parent

    def test_the_override_wins_when_the_layout_does_not_hold(self, monkeypatch):
        monkeypatch.setenv("APOLLO_IMAGE_SCRIPT", "/somewhere/else/image.py")
        import importlib

        reloaded = importlib.reload(diagram)
        assert str(reloaded.IMAGE) == "/somewhere/else/image.py"
        monkeypatch.delenv("APOLLO_IMAGE_SCRIPT")
        importlib.reload(diagram)
