import re
import subprocess

import obsidian
import pytest


def git(cwd, *args):
    done = subprocess.run(
        ["git", "-C", str(cwd), *args], capture_output=True, text=True, check=False
    )
    if done.returncode != 0:
        raise AssertionError(f"git {' '.join(args)} failed in {cwd}: {done.stderr}")
    return done.stdout.strip()


def identity(repo, name):
    git(repo, "config", "user.name", name)
    git(repo, "config", "user.email", f"{name.lower()}@example.test")


def run(*argv):
    args = obsidian.build_parser().parse_args(list(argv))
    args.func(args)


class Vault:
    """Apollo's clone, plus a second one standing in for the phone, both off one bare origin -
    the situation the skill exists for: two writers, one remote."""

    def __init__(self, root):
        self.origin = root / "origin"
        self.path = root / "vault"
        self.phone = root / "phone"

    def write(self, relative, text):
        target = self.path / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)

    def read(self, relative):
        return (self.path / relative).read_text()

    def commit(self, message="local"):
        git(self.path, "add", "--all")
        git(self.path, "commit", "--quiet", "--message", message)

    def phone_push(self, relative, text):
        target = self.phone / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)
        git(self.phone, "add", "--all")
        git(self.phone, "commit", "--quiet", "--message", f"phone {relative}")
        git(self.phone, "push", "--quiet")

    def status(self):
        return git(self.path, "status", "--porcelain")

    def head(self, ref="HEAD"):
        return git(self.path, "rev-parse", ref)

    def subject(self, ref="HEAD"):
        return git(self.path, "log", "-1", "--format=%s", ref)

    def author(self, ref="HEAD"):
        return git(self.path, "log", "-1", "--format=%an|%ae", ref)

    def merges(self):
        return git(self.path, "log", "--merges", "--format=%s")

    def branches(self):
        return git(self.path, "branch", "--format=%(refname:short)").splitlines()

    def origin_files(self):
        return sorted(git(self.origin, "ls-tree", "-r", "--name-only", "main").splitlines())

    def origin_file(self, relative):
        return git(self.origin, "show", f"main:{relative}")


@pytest.fixture
def vault(tmp_path, monkeypatch):
    home = tmp_path / "home"
    scratch = tmp_path / "tmp"
    home.mkdir()
    scratch.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", "/dev/null")
    monkeypatch.setenv("GIT_CONFIG_SYSTEM", "/dev/null")
    monkeypatch.setattr(obsidian.tempfile, "tempdir", str(scratch))

    v = Vault(tmp_path)
    subprocess.run(
        ["git", "init", "--quiet", "--bare", "--initial-branch=main", str(v.origin)], check=True
    )
    subprocess.run(["git", "clone", "--quiet", str(v.origin), str(v.phone)], check=True)
    identity(v.phone, "Phone")
    (v.phone / "Journal.md").write_text("# Journal\n")
    git(v.phone, "add", "--all")
    git(v.phone, "commit", "--quiet", "--message", "start")
    git(v.phone, "push", "--quiet", "--set-upstream", "origin", "main")
    subprocess.run(["git", "clone", "--quiet", str(v.origin), str(v.path)], check=True)
    identity(v.path, "Vault")
    monkeypatch.setattr(obsidian, "VAULT", v.path)
    return v


def leave_a_conflicted_rebase(vault):
    """What a turn that died mid-sync leaves behind: a rebase git could not finish."""
    vault.write("Journal.md", "# Journal\nmine\n")
    vault.commit()
    vault.phone_push("Journal.md", "# Journal\ntheirs\n")
    git(vault.path, "fetch", "--quiet")
    subprocess.run(
        ["git", "-C", str(vault.path), "rebase", "origin/main"], capture_output=True, check=False
    )
    assert (vault.path / ".git" / "rebase-merge").exists()


class TestHasConflictMarkers:
    def test_an_unresolved_merge_is_recognised(self, tmp_path):
        note = tmp_path / "Note.md"
        note.write_text("<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> origin/main\n")
        assert obsidian.has_conflict_markers(note) is True

    def test_a_note_that_only_mentions_the_marker_is_not(self, tmp_path):
        note = tmp_path / "Note.md"
        note.write_text("git prints <<<<<<< when a merge fails\n")
        assert obsidian.has_conflict_markers(note) is False

    def test_a_binary_attachment_is_never_read_for_markers(self, tmp_path):
        image = tmp_path / "photo.jpg"
        image.write_bytes(b"\xff\xd8\xff<<<<<<<\n>>>>>>>\n")
        assert obsidian.has_conflict_markers(image) is False


class TestDescribe:
    def test_one_file_reads_singular(self):
        assert obsidian.describe("committed", ["Car.md"]) == "committed 1 file: Car.md"

    def test_several_are_listed(self):
        assert obsidian.describe("pulled", ["a.md", "b.md"]) == "pulled 2 files: a.md, b.md"

    def test_a_long_list_starts_counting(self):
        line = obsidian.describe("committed", [f"n{i}.md" for i in range(20)])
        assert "committed 20 files" in line
        assert "… and 8 more" in line


class TestSyncNothingOwed:
    def test_it_reports_being_in_sync(self, vault, capsys):
        run("sync")
        out = capsys.readouterr().out
        assert "nothing to commit" in out
        assert "the vault is in sync with the remote" in out

    def test_it_creates_no_commit(self, vault):
        before = vault.head()
        run("sync")
        assert vault.head() == before


class TestSyncLocalWork:
    def test_a_new_note_is_committed_and_pushed(self, vault, capsys):
        vault.write("Recipes/Butter Chicken.md", "# Butter Chicken\n")
        run("sync")
        out = capsys.readouterr().out
        assert "committed 1 file: Recipes/Butter Chicken.md" in out
        assert "pushed - the vault is in sync" in out
        assert "Recipes/Butter Chicken.md" in vault.origin_files()

    def test_every_commit_is_a_timestamp_like_the_app_writes(self, vault):
        vault.write("Car.md", "notes\n")
        run("sync")
        assert re.fullmatch(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}", vault.subject())

    def test_a_commit_carries_the_identity_the_vault_is_configured_with(self, vault):
        # The vault is the user's, and its identity is set on the clone, so nothing here overrides it.
        vault.write("Car.md", "notes\n")
        run("sync")
        assert vault.author() == "Vault|vault@example.test"

    def test_names_with_spaces_and_apostrophes_survive(self, vault, capsys):
        vault.write("New Year's Resolution/2026.md", "- ride more\n")
        run("sync")
        assert "New Year's Resolution/2026.md" in capsys.readouterr().out
        assert "New Year's Resolution/2026.md" in vault.origin_files()

    def test_a_deleted_note_is_synced_too(self, vault):
        (vault.path / "Journal.md").unlink()
        run("sync")
        assert "Journal.md" not in vault.origin_files()


class TestSyncRemoteWork:
    def test_the_remote_change_lands_and_is_named(self, vault, capsys):
        vault.phone_push("Recipes/Steak.md", "# Steak\n")
        run("sync")
        out = capsys.readouterr().out
        assert "pulled 1 file: Recipes/Steak.md" in out
        assert "the vault is in sync with the remote" in out
        assert vault.read("Recipes/Steak.md") == "# Steak\n"

    def test_both_sides_keep_their_own_notes(self, vault, capsys):
        vault.phone_push("Recipes/Steak.md", "# Steak\n")
        vault.write("Recipes/Butter Chicken.md", "# Butter Chicken\n")
        run("sync")
        out = capsys.readouterr().out
        assert "committed 1 file: Recipes/Butter Chicken.md" in out
        assert "pulled 1 file: Recipes/Steak.md" in out
        assert vault.origin_files() == [
            "Journal.md",
            "Recipes/Butter Chicken.md",
            "Recipes/Steak.md",
        ]

    def test_the_history_stays_linear(self, vault):
        vault.phone_push("Recipes/Steak.md", "# Steak\n")
        vault.write("Car.md", "notes\n")
        run("sync")
        assert vault.merges() == ""


class TestConflict:
    def collide(self, vault):
        vault.write("Journal.md", "# Journal\nmine\n")
        vault.phone_push("Journal.md", "# Journal\ntheirs\n")

    def test_it_is_reported_with_the_note_that_clashed(self, vault, capsys):
        self.collide(vault)
        run("sync")
        out = capsys.readouterr().out
        assert "⚠️ conflict" in out
        assert "Journal.md" in out
        assert "sync again" in out

    def test_the_vault_is_left_clean_and_on_the_remote(self, vault, capsys):
        self.collide(vault)
        run("sync")
        capsys.readouterr()
        assert vault.status() == ""
        assert vault.head() == vault.head("origin/main")
        assert vault.read("Journal.md") == "# Journal\ntheirs\n"

    def test_nothing_is_pushed(self, vault, capsys):
        self.collide(vault)
        run("sync")
        capsys.readouterr()
        assert vault.origin_file("Journal.md") == "# Journal\ntheirs"

    def test_apollos_version_is_written_out_where_it_can_read_it(self, vault, capsys):
        self.collide(vault)
        run("sync")
        out = capsys.readouterr().out
        saved = next(
            line.split(": ", 1)[1] for line in out.splitlines() if line.startswith("your version of")
        )
        with open(saved) as handle:
            assert handle.read() == "# Journal\nmine\n"

    def test_apollos_commits_are_kept_on_a_branch(self, vault, capsys):
        self.collide(vault)
        run("sync")
        capsys.readouterr()
        parked = [name for name in vault.branches() if name.startswith("apollo/conflict-")]
        assert len(parked) == 1
        assert git(vault.path, "show", f"{parked[0]}:Journal.md") == "# Journal\nmine"

    def test_re_applying_the_change_then_syncing_finishes_the_job(self, vault, capsys):
        self.collide(vault)
        run("sync")
        capsys.readouterr()
        vault.write("Journal.md", "# Journal\ntheirs\nmine\n")
        run("sync")
        assert "pushed - the vault is in sync" in capsys.readouterr().out
        assert vault.origin_file("Journal.md") == "# Journal\ntheirs\nmine"

    def test_a_conflict_is_an_outcome_not_a_failure(self, vault, capsys):
        self.collide(vault)
        run("sync")  # no SystemExit: the vault is in a known, clean state
        capsys.readouterr()


class TestUnreachableRemote:
    def unplug(self, vault, tmp_path):
        git(vault.path, "remote", "set-url", "origin", str(tmp_path / "gone"))

    def test_the_work_is_committed_and_the_failure_is_loud(self, vault, tmp_path, capsys):
        vault.write("Recipes/Butter Chicken.md", "# Butter Chicken\n")
        self.unplug(vault, tmp_path)
        with pytest.raises(SystemExit) as exit_info:
            run("sync")
        out = capsys.readouterr().out
        assert exit_info.value.code == 1
        assert "committed 1 file: Recipes/Butter Chicken.md" in out
        assert "could not reach the remote" in out
        assert "the next sync will push it" in out

    def test_the_next_sync_pushes_what_was_owed(self, vault, tmp_path, capsys):
        vault.write("Recipes/Butter Chicken.md", "# Butter Chicken\n")
        self.unplug(vault, tmp_path)
        with pytest.raises(SystemExit):
            run("sync")
        capsys.readouterr()
        git(vault.path, "remote", "set-url", "origin", str(vault.origin))
        run("sync")
        assert "pushed - the vault is in sync" in capsys.readouterr().out
        assert "Recipes/Butter Chicken.md" in vault.origin_files()

    def test_a_read_that_cannot_reach_the_remote_says_the_vault_may_be_stale(
        self, vault, tmp_path, capsys
    ):
        self.unplug(vault, tmp_path)
        with pytest.raises(SystemExit):
            run("sync")
        assert "the vault may be out of date" in capsys.readouterr().out


class TestPushRace:
    def test_losing_the_race_is_retried_rather_than_reported(self, vault, capsys, monkeypatch):
        vault.write("Recipes/Butter Chicken.md", "# Butter Chicken\n")
        real_push = obsidian.push
        raced = []

        def racing_push():
            if not raced:
                raced.append(True)  # the phone pushes between our fetch and our push
                vault.phone_push("Recipes/Steak.md", "# Steak\n")
            return real_push()

        monkeypatch.setattr(obsidian, "push", racing_push)
        run("sync")
        out = capsys.readouterr().out
        assert raced == [True]
        assert "pushed - the vault is in sync" in out
        assert "pulled 1 file: Recipes/Steak.md" in out
        assert vault.origin_files() == [
            "Journal.md",
            "Recipes/Butter Chicken.md",
            "Recipes/Steak.md",
        ]

    def test_a_push_that_keeps_failing_gives_up_loudly(self, vault, capsys, monkeypatch):
        vault.write("Car.md", "notes\n")
        monkeypatch.setattr(obsidian, "push", lambda: "rejected")
        with pytest.raises(SystemExit) as exit_info:
            run("sync")
        assert exit_info.value.code == 1
        assert "could not push" in capsys.readouterr().out


class TestHealing:
    def test_a_leftover_rebase_is_aborted(self, vault):
        leave_a_conflicted_rebase(vault)
        assert obsidian.heal() == "healed a rebase left over from an earlier run"
        assert not (vault.path / ".git" / "rebase-merge").exists()
        assert vault.status() == ""

    def test_a_clean_vault_needs_no_healing(self, vault):
        assert obsidian.heal() is None

    def test_syncing_after_an_interrupted_turn_is_never_wedged(self, vault, capsys):
        leave_a_conflicted_rebase(vault)
        run("sync")
        out = capsys.readouterr().out
        assert "healed a rebase left over from an earlier run" in out
        assert "rebase in progress" not in out
        assert vault.status() == ""
        assert any(name.startswith("apollo/conflict-") for name in vault.branches())


class TestRefusals:
    def test_an_unresolved_merge_is_not_committed(self, vault, capsys):
        vault.write("Journal.md", "<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> origin/main\n")
        with pytest.raises(SystemExit):
            run("sync")
        assert "Journal.md" in capsys.readouterr().err
        assert vault.status() != ""
        assert vault.head() == vault.head("origin/main")

    def test_a_missing_vault_says_so_instead_of_cloning(self, vault, tmp_path, monkeypatch, capsys):
        monkeypatch.setattr(obsidian, "VAULT", tmp_path / "nope")
        with pytest.raises(SystemExit):
            run("sync")
        err = capsys.readouterr().err
        assert "no git repo at" in err
        assert "nope" in err

    def test_a_vault_tracking_no_remote_says_so(self, vault, capsys):
        git(vault.path, "branch", "--unset-upstream")
        with pytest.raises(SystemExit):
            run("sync")
        assert "tracks no remote branch" in capsys.readouterr().err
