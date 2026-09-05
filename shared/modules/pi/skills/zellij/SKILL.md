---
name: zellij
description: Read or monitor another zellij pane, tab, or session ("the other tab", a named session such as the dropdown terminal) without touching the user's focus - find the pane, dump its screen and scrollback, poll a running command until it finishes, then report what happened. Use when the user says they started something in another tab and asks to monitor it, asks to check or look at another tab or terminal, or asks why a command running there is stuck.
---

# Zellij

Every terminal here runs inside zellij. The user runs long jobs - test suites, builds, deploys - in a pane of their own and asks you to watch it. Read that pane through the CLI, never by moving the user's focus.

## Find the pane

`$ZELLIJ_SESSION_NAME` is the session you run in; "the other tab" is another tab of it. Anything else is a session of its own: `zellij list-sessions --no-formatting` names them, and every command below takes `zellij --session NAME action ...` to address one.

```console
$ zellij action list-panes --all
TAB_ID  TAB_POS  TAB_NAME  PANE_ID     TYPE      TITLE                      COMMAND                        CWD                               FOCUSED  ...
0       0        Tab #1    plugin_1    plugin    compact-bar                compact-bar                    -                                 false
0       0        Tab #1    terminal_0  terminal  π - Fix flaky test - cli   /nix/store/...-pi/libexec/pi   /home/roman/Documents/proton-cli  true
1       1        Tab #2    terminal_3  terminal  just coverage              atuin pty-proxy --shell zsh    /home/roman/Documents/proton-cli  false
```

Pick by `TAB_NAME`, `CWD` and `TITLE` - the shell puts the running command into the title. `COMMAND` is the pane's root process, usually the shell, so it rarely names the job. Skip `plugin_*` panes and your own (`$ZELLIJ_PANE_ID`). Two candidates: dump both and let the content decide rather than asking.

## Read it

```console
$ zellij action dump-screen --pane-id terminal_3 --full --path /tmp/zellij-terminal_3.txt
$ tail --lines=40 /tmp/zellij-terminal_3.txt
```

`--full` includes the scrollback; without it only the visible viewport comes out. A long run's scrollback is thousands of lines, so dump to a file, search it (`grep --line-number --extended-regexp 'FAIL|panic|Error'`) and read the ranges that matter.

## Monitor it

The job is finished when the tail of the dump is the shell prompt again, or when its process is gone (`pgrep --full 'just coverage'`). Until then, poll: `sleep` an interval fitting the job (a minute for a test suite, ten seconds for a build), dump again, compare. Nothing is said in between - the report comes once, when it is over: the verdict, what failed and why, what to do about it. A question asked mid-run gets a one-line answer, then polling continues.

Stuck is when the tail has not moved across two polls and the process is still alive. Then say what the last line is and how long it has been there.

## Never

- `go-to-tab`, `focus-pane-id`, `move-focus`, `switch-session`, or anything else that changes what the user sees - it flips their screen while they work.
- `write`, `write-chars`, `send-keys`, `close-pane`, `close-tab`: the pane is the user's, and typing into it or closing it is theirs to do.
- Guessing pane ids. `list-panes` is one command.
