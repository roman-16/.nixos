#!/usr/bin/env bash
set -euo pipefail

export WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-0}"

RECORDING_FILE="/dev/shm/stt-recording.wav"
MODEL="@model@"
WHISPER_CLI="@whisper@/bin/whisper-cli"

case "${1:-}" in
    start)
        # Run in foreground - extension will kill this process
        exec rec -q -t wav "$RECORDING_FILE" rate 16k
        ;;
    transcribe)
        if [[ -f "$RECORDING_FILE" ]]; then
            result=$("$WHISPER_CLI" -t 4 -nt -m "$MODEL" -f "$RECORDING_FILE" 2>/dev/null)
            # Remove whisper artifacts like [BLANK_AUDIO]
            result="${result//\[*\]/}"
            result="${result//\(*\)/}"
            result="${result#"${result%%[![:space:]]*}"}"
            result="${result%"${result##*[![:space:]]}"}"
            
            if [[ -n "$result" ]]; then
                echo -n "$result" | wl-copy
            fi
            rm -f "$RECORDING_FILE"
        fi
        ;;
    *)
        echo "Usage: $0 {start|transcribe}"
        exit 1
        ;;
esac
