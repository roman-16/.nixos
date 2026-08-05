#!/usr/bin/env python3
"""Keep Apollo's Obsidian vault in step with its remote.

The vault at $OBSIDIAN_DIR (default <workspace>/obsidian) is a git repo the user also edits from
Obsidian on their phone and laptop, where a plugin commits and pulls every few minutes. So the
remote moves on its own: the vault is the one place Apollo works in that somebody else is writing
to at the same time.

Writing a note is Apollo's job. Reconciling two histories is not - it is deterministic, it has
exactly one safe order, and improvising it costs the user notes - which is why it lives here, and
why this skill has no other verb.

One cycle: commit, fetch, rebase, push. Committing first is the whole safety property, because what
Apollo wrote becomes a commit before any remote content touches the tree, so a note can never be
overwritten before it was recorded. Rebasing rather than merging is safe because these commits have
never left this machine, and it keeps the vault's history linear.

Content is never merged here. When both sides changed the same note, Apollo's commits are parked on
a local branch, its version of each note is written out where it can read it, and the vault is reset
to the remote: clean, current, nothing lost, and the merge left to the one party that reads prose.
"""

from __future__ import annotations

import argparse
import os
import shlex
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path

VAULT = Path(
    os.environ.get("OBSIDIAN_DIR")
    or Path(os.environ.get("APOLLO_WORKSPACE") or os.getcwd()) / "obsidian"
)

# Apollo signs its own commits: the vault's configured identity is the user's, and in a vault two
# parties write to, attribution is the only thing that says later which change came from a
# conversation and which from the app.
AUTHOR_NAME = "Apollo"
AUTHOR_EMAIL = "apollo@halerc.xyz"

# Every commit in this vault is a timestamp, because that is what the Obsidian plugin on the user's
# devices writes and a history reads better uniform than half-annotated. What changed is in the diff.
MESSAGE_FORMAT = "%Y-%m-%d %H:%M:%S"

LOCAL_TIMEOUT = 30
NETWORK_TIMEOUT = 120

# How many times a push may lose the race with the user's devices before giving up. The other side
# commits every few minutes, so losing once is ordinary.
PUSH_ATTEMPTS = 3

# How many paths a report names before it starts counting instead.
LIST_CAP = 12

MAX_ERROR_CHARS = 200


class GitError(Exception):
    """A git command that failed, carrying what git said so a report can quote it."""


def die(msg: str):
    print(f"error: {msg}", file=sys.stderr)
    raise SystemExit(1)


def brief(text: str) -> str:
    collapsed = " ".join(text.split())
    return collapsed[:MAX_ERROR_CHARS] if collapsed else "no output"


def git_output(*args: str, timeout: int = LOCAL_TIMEOUT) -> str:
    """Run git in the vault and return its stdout verbatim."""
    try:
        done = subprocess.run(
            ["git", "-C", str(VAULT), *args],
            capture_output=True, text=True, timeout=timeout, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise GitError(brief(str(error))) from error
    if done.returncode != 0:
        raise GitError(brief(done.stderr or done.stdout))
    return done.stdout


def git(*args: str, timeout: int = LOCAL_TIMEOUT) -> str:
    return git_output(*args, timeout=timeout).strip()


def git_paths(*args: str) -> list:
    """The paths a git command lists. Always asked for NUL-separated, because git quotes any name
    holding a space, and every note in this vault is titled like a sentence."""
    out = git_output("-c", "core.quotepath=false", *args, "-z")
    return [path for path in out.split("\0") if path]


# --- the vault ------------------------------------------------------------


def require_vault():
    if not (VAULT / ".git").exists():
        die(f"no git repo at {VAULT} - the vault is cloned when the app starts, so say that it is "
            "missing rather than cloning it yourself")


def upstream_ref() -> str:
    try:
        return git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")
    except GitError:
        die(f"{VAULT} tracks no remote branch - say so rather than guessing a remote")


def heal() -> str | None:
    """Undo an operation an interrupted run left half-finished. Only this script rebases here, so an
    abandoned one is never somebody's work in progress - and left in place it makes every later git
    command fail, with nobody on this machine to clear it."""
    for state, verb in (
        ("CHERRY_PICK_HEAD", "cherry-pick"),
        ("MERGE_HEAD", "merge"),
        ("rebase-apply", "rebase"),
        ("rebase-merge", "rebase"),
    ):
        if not (VAULT / ".git" / state).exists():
            continue
        try:
            git(verb, "--abort")
        except GitError:
            continue
        return f"healed a {verb} left over from an earlier run"
    return None


def has_conflict_markers(path: Path) -> bool:
    """Whether a note still carries an unresolved merge. Both ends are required, so a note that
    merely mentions the marker is not mistaken for a broken one."""
    if path.suffix != ".md" or not path.is_file():
        return False
    try:
        text = path.read_text(errors="ignore")
    except OSError:
        return False
    lines = text.splitlines()
    return any(line.startswith("<<<<<<<") for line in lines) and any(
        line.startswith(">>>>>>>") for line in lines
    )


def staged_paths() -> list:
    """What the next commit would record."""
    return sorted(git_paths("diff", "--cached", "--name-only"))


def changed_between(old: str, new: str) -> list:
    return git_paths("diff", "--name-only", f"{old}..{new}")


def unmerged_paths() -> list:
    return git_paths("diff", "--name-only", "--diff-filter=U")


def ahead(upstream: str) -> int:
    return int(git("rev-list", "--count", f"{upstream}..HEAD") or 0)


def commit_local() -> list:
    """Record whatever is in the vault, and return the files it covered."""
    git("add", "--all")
    paths = staged_paths()
    if not paths:
        return []
    broken = [path for path in paths if has_conflict_markers(VAULT / path)]
    if broken:
        git("reset", "--quiet")  # the notes stay exactly as they are, just unstaged
        die("not committing: these notes still hold an unresolved merge, so resolve them first:\n  "
            + "\n  ".join(broken))
    git("-c", f"user.name={AUTHOR_NAME}", "-c", f"user.email={AUTHOR_EMAIL}",
        "commit", "--quiet", "--message", datetime.now().strftime(MESSAGE_FORMAT))
    return paths


def fetch() -> str | None:
    """None on success, else what went wrong. A remote out of reach is an outcome rather than a
    crash: whatever Apollo wrote is already committed here."""
    try:
        git("fetch", "--quiet", timeout=NETWORK_TIMEOUT)
        return None
    except GitError as error:
        return str(error)


def push() -> str | None:
    try:
        git("push", "--quiet", timeout=NETWORK_TIMEOUT)
        return None
    except GitError as error:
        return str(error)


def rebase_onto(upstream: str) -> list | None:
    """Replay Apollo's commits on top of the remote. Returns the conflicting paths, or None when
    there was nothing to reconcile."""
    try:
        git("rebase", "--quiet", upstream)
        return None
    except GitError as error:
        conflicting = unmerged_paths()
        if conflicting:
            return conflicting
        heal()  # not a conflict, so leave no half-finished rebase behind
        die(f"could not replay your commits onto {upstream}: {error}")


def park(conflicting: list, upstream: str) -> tuple:
    """Put the vault back on the remote without losing Apollo's work: its commits stay on a local
    branch that is never pushed, and its version of each conflicting file is written out where it
    can read it. Returns (branch, {path: file})."""
    stamp = datetime.now().strftime("%Y-%m-%d-%H%M%S")
    branch = f"apollo/conflict-{stamp}"
    git("rebase", "--abort")
    git("branch", branch)
    directory = Path(tempfile.gettempdir()) / f"obsidian-{stamp}"
    saved = {}
    for path in conflicting:
        try:
            content = git_output("show", f"{branch}:{path}")
        except GitError:
            continue  # Apollo had deleted it, so there is no version of it to keep
        target = directory / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
        saved[path] = target
    git("reset", "--hard", "--quiet", upstream)
    return branch, saved


# --- reporting ------------------------------------------------------------


def plural(count: int) -> str:
    return "" if count == 1 else "s"


def describe(verb: str, paths: list) -> str:
    shown = paths[:LIST_CAP]
    more = f", … and {len(paths) - len(shown)} more" if len(paths) > len(shown) else ""
    return f"{verb} {len(paths)} file{plural(len(paths))}: {', '.join(shown)}{more}"


def owed(committed: list) -> str:
    return ("the commit is safe here and the next sync will push it" if committed
            else "the vault may be out of date")


def conflict_report(conflicting: list, branch: str, saved: dict) -> list:
    recovery = f"git -C {shlex.quote(str(VAULT))} show {shlex.quote(f'{branch}:{conflicting[0]}')}"
    return [
        f"⚠️ conflict - the remote changed the same file{plural(len(conflicting))} you did: "
        f"{', '.join(conflicting)}",
        *(f"your version of {path}: {target}" for path, target in saved.items()),
        "the vault is clean and now holds the remote's version - re-apply your change to it there, "
        "then sync again",
        f"nothing is lost: your commits are kept on the local branch {branch} ({recovery})",
    ]


def report(lines: list, incoming: list, *tail: str):
    out = [*lines]
    if incoming:
        out.append(describe("pulled", incoming))
    out += [line for line in tail if line]
    print("\n".join(out))


# --- commands -------------------------------------------------------------


def cmd_sync(args):
    require_vault()
    lines = []
    healed = heal()
    if healed:
        lines.append(healed)

    committed = commit_local()
    lines.append(describe("committed", committed) if committed else "nothing to commit")

    upstream = upstream_ref()
    incoming: list = []
    for attempt in range(PUSH_ATTEMPTS):
        before = git("rev-parse", upstream)
        error = fetch()
        if error:
            report(lines, incoming, f"⚠️ could not reach the remote ({error}) - {owed(committed)}")
            raise SystemExit(1)
        after = git("rev-parse", upstream)
        if after != before:
            incoming += [path for path in changed_between(before, after) if path not in incoming]

        conflicting = rebase_onto(upstream)
        if conflicting is not None:
            branch, saved = park(conflicting, upstream)
            report(lines, incoming, *conflict_report(conflicting, branch, saved))
            return

        if ahead(upstream) == 0:
            report(lines, incoming, "the vault is in sync with the remote")
            return
        error = push()
        if error is None:
            report(lines, incoming, "pushed - the vault is in sync")
            return
        if attempt == PUSH_ATTEMPTS - 1:
            report(lines, incoming, f"⚠️ could not push ({error}) - {owed(committed)}")
            raise SystemExit(1)
        # The remote moved between the fetch and the push, which is ordinary with a device
        # committing every few minutes: fold in what landed and run the cycle again.


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="obsidian.py", description="sync the Obsidian vault")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("sync").set_defaults(func=cmd_sync)

    return p


def main():
    args = build_parser().parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
