#!/usr/bin/env bash
set -euo pipefail

FILE="/dev/shm/stt-recording.wav"
DOTOOL="@dotool@/bin/dotool"
WHISPER="@whisper@/bin/whisper-cli -t 4 -m @model@"

# Auto-detect keyboard layout
layout=$(gsettings get org.gnome.desktop.input-sources sources 2>/dev/null | sed "s/.*'xkb', '\([^']*\)'.*/\1/" || echo "us")
export DOTOOL_XKB_LAYOUT="${layout%%+*}"
[[ "$layout" == *+* ]] && export DOTOOL_XKB_VARIANT="${layout#*+}"

transcribe() {
    [[ -f "$FILE" ]] || return
    text=$($WHISPER -f "$FILE" 2>/dev/null | sed 's/\[.*\]//g' | tr '\n' ' ' | sed 's/  */ /g; s/^ *//; s/ *$//')
    rm -f "$FILE"
    [[ -n "$text" ]] && echo "$text"
}

case "${1:-}" in
    start)       rm -f "$FILE"; exec arecord -q -f S16_LE -r 16000 -c 1 -t wav "$FILE" ;;
    type)        text=$(transcribe) && printf 'typedelay 0\ntypehold 0\ntype %s' "$text" | "$DOTOOL" ;;
    clipboard)   text=$(transcribe) && echo -n "$text" | wl-copy ;;
esac
