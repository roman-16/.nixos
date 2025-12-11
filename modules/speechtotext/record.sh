#!/usr/bin/env bash
set -euo pipefail

export WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-0}"

RECORDING_FILE="/dev/shm/stt-recording.wav"
MODEL="@model@"
WHISPER_CLI="@whisper@/bin/whisper-cli"
WHISPER_STREAM="@whisper@/bin/whisper-stream"
YDOTOOL="@ydotool@/bin/ydotool"
LOG="/tmp/stt-debug.log"

echo "$(date): stt-record.sh called with args: $*" >> "$LOG"

case "${1:-}" in
    stream)
        echo "$(date): stream - starting recording to $RECORDING_FILE" >> "$LOG"
        exec arecord -q -f S16_LE -r 16000 -c 1 -t wav "$RECORDING_FILE"
        ;;
    stream-finish)
        # Right click: transcribe and COPY to clipboard
        echo "$(date): stream-finish started" >> "$LOG"
        if [[ -f "$RECORDING_FILE" ]]; then
            echo "$(date): stream-finish - file exists" >> "$LOG"
            result=$("$WHISPER_CLI" -t 4 -m "$MODEL" -f "$RECORDING_FILE" 2>/dev/null | sed 's/\[.*\] *//g')
            result="${result//\[*\]/}"
            result="${result//\(*\)/}"
            result="${result#"${result%%[![:space:]]*}"}"
            result="${result%"${result##*[![:space:]]}"}"
            
            if [[ -n "$result" ]]; then
                echo "$(date): stream-finish - copying to clipboard: '$result'" >> "$LOG"
                echo -n "$result" | wl-copy
            else
                echo "$(date): stream-finish - result empty" >> "$LOG"
            fi
            rm -f "$RECORDING_FILE"
        else
            echo "$(date): stream-finish - file does not exist!" >> "$LOG"
        fi
        echo "$(date): stream-finish done" >> "$LOG"
        ;;
    start)
        echo "$(date): start - starting recording to $RECORDING_FILE" >> "$LOG"
        exec arecord -q -f S16_LE -r 16000 -c 1 -t wav "$RECORDING_FILE"
        ;;
    transcribe)
        # Left click: transcribe and TYPE
        echo "$(date): transcribe started" >> "$LOG"
        if [[ -f "$RECORDING_FILE" ]]; then
            echo "$(date): transcribe - file exists" >> "$LOG"
            result=$("$WHISPER_CLI" -t 4 -m "$MODEL" -f "$RECORDING_FILE" 2>/dev/null | sed 's/\[.*\] *//g')
            result="${result//\[*\]/}"
            result="${result//\(*\)/}"
            result="${result#"${result%%[![:space:]]*}"}"
            result="${result%"${result##*[![:space:]]}"}"
            
            if [[ -n "$result" ]]; then
                echo "$(date): transcribe - typing: '$result'" >> "$LOG"
                "$YDOTOOL" type -- "$result" >> "$LOG" 2>&1
                echo "ydotool exit code: $?" >> "$LOG"
            else
                echo "$(date): transcribe - result empty" >> "$LOG"
            fi
            rm -f "$RECORDING_FILE"
        else
            echo "$(date): transcribe - file does not exist!" >> "$LOG"
        fi
        echo "$(date): transcribe done" >> "$LOG"
        ;;
    *)
        echo "Usage: $0 {stream|start|transcribe}"
        exit 1
        ;;
esac
