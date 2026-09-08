from pathlib import Path

import apollo
import diagram
import pytest


def run(*argv):
    args = diagram.build_parser().parse_args(list(argv))
    args.func(args)


def drawn(tmp_path, monkeypatch) -> Path:
    """A source file whose render produces a picture, without a browser being started."""
    source = tmp_path / "flow.mmd"
    source.write_text("flowchart TD\n  A --> B")
    monkeypatch.setattr(diagram, "render", lambda _source, target: target.write_bytes(b"x" * 2000))
    return source


def spy(monkeypatch) -> list:
    """What was handed to the app to put in front of the user."""
    sent = []

    def fake(skill, image, caption):
        sent.append((skill, image, caption))
        return apollo.Delivery(True, f"\n[{skill}: delivered to the user \u2713]\n")

    monkeypatch.setattr(diagram, "send_image", fake)
    return sent


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
        sent = spy(monkeypatch)
        monkeypatch.setattr(diagram, "render", lambda *args: diagram.die("Parse error on line 2"))
        with pytest.raises(SystemExit):
            run("render", str(source), "--send")
        captured = capsys.readouterr()
        assert sent == []
        assert "Parse error" in captured.err
        # The hint that explains the parse error is printed before the renderer's own message.
        assert "closes a block" in captured.out

    def test_a_drawn_diagram_is_delivered_with_its_caption(self, tmp_path, monkeypatch):
        out = tmp_path / "flow.png"
        sent = spy(monkeypatch)
        run("render", str(drawn(tmp_path, monkeypatch)), "--caption", "how it flows",
            "--out", str(out), "--send")
        assert sent == [("diagram", out, "how it flows")]

    def test_no_caption_delivers_the_picture_alone(self, tmp_path, monkeypatch):
        sent = spy(monkeypatch)
        run("render", str(drawn(tmp_path, monkeypatch)), "--out", str(tmp_path / "flow.png"),
            "--send")
        assert sent[0][2] == ""

    def test_without_send_it_draws_it_and_sends_nothing(self, tmp_path, capsys, monkeypatch):
        out = tmp_path / "flow.png"
        sent = spy(monkeypatch)
        run("render", str(drawn(tmp_path, monkeypatch)), "--out", str(out))
        captured = capsys.readouterr().out
        assert sent == []
        assert str(out) in captured
        assert "not sent to the user - add --send to deliver it" in captured


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
    def answer(self, tmp_path, monkeypatch, delivery):
        monkeypatch.setattr(diagram, "send_image", lambda *args: delivery)
        return drawn(tmp_path, monkeypatch)

    def test_a_delivered_diagram_echoes_the_marker_and_succeeds(self, tmp_path, monkeypatch, capsys):
        source = self.answer(tmp_path, monkeypatch,
                             apollo.Delivery(True, "\n[diagram: delivered to the user \u2713]\n"))
        run("render", str(source), "--out", str(tmp_path / "flow.png"), "--send")
        assert "delivered to the user" in capsys.readouterr().out

    def test_a_failed_delivery_says_so_and_fails_loudly(self, tmp_path, monkeypatch, capsys):
        source = self.answer(tmp_path, monkeypatch,
                             apollo.Delivery(False, "\n[diagram: delivery FAILED]\n"))
        with pytest.raises(SystemExit) as exit_info:
            run("render", str(source), "--out", str(tmp_path / "flow.png"), "--send")
        assert exit_info.value.code == 1
        assert "delivery FAILED" in capsys.readouterr().out

    def test_the_chat_records_it_as_a_diagram_not_a_picture_from_nowhere(self, tmp_path,
                                                                        monkeypatch):
        sent = spy(monkeypatch)
        run("render", str(drawn(tmp_path, monkeypatch)), "--out", str(tmp_path / "flow.png"),
            "--send")
        assert sent[0][0] == "diagram"


class TestSkillLayout:
    def test_the_style_files_it_draws_with_are_its_own(self):
        assert diagram.SKILL.name == "diagram"
        assert diagram.CONFIG.parent == diagram.SKILL
        assert diagram.PUPPETEER.parent == diagram.SKILL
