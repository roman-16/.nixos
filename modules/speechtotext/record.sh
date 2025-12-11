#!/usr/bin/env bash
set -euo pipefail

export WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-0}"

RECORDING_FILE="/dev/shm/stt-recording.wav"
MODEL="@model@"
WHISPER_CLI="@whisper@/bin/whisper-cli"
WHISPER_STREAM="@whisper@/bin/whisper-stream"
WTYPE="@wtype@/bin/wtype"

case "${1:-}" in
    stream)
        # Record then type result (simpler than real-time streaming)
        exec arecord -q -f S16_LE -r 16000 -c 1 -t wav "$RECORDING_FILE"
        ;;
    stream-finish)
        # Transcribe and type result
        if [[ -f "$RECORDING_FILE" ]]; then
            result=$("$WHISPER_CLI" -t 4 -m "$MODEL" -f "$RECORDING_FILE" 2>/dev/null | sed 's/\[.*\] *//g')
            result="${result//\[*\]/}"
            result="${result//\(*\)/}"
            result="${result#"${result%%[![:space:]]*}"}"
            result="${result%"${result##*[![:space:]]}"}"
            
            if [[ -n "$result" ]]; then
                "$WTYPE" -- "$result"
            fi
            rm -f "$RECORDING_FILE"
        fi
        ;;
    start)
        # Run in foreground - extension will kill this process
        exec arecord -q -f S16_LE -r 16000 -c 1 -t wav "$RECORDING_FILE"
        ;;
    transcribe)
        if [[ -f "$RECORDING_FILE" ]]; then
            # Transcribe and strip timestamps with sed
            result=$("$WHISPER_CLI" -t 4 -m "$MODEL" -f "$RECORDING_FILE" 2>/dev/null | sed 's/\[.*\] *//g')
            # Remove whisper artifacts like [BLANK_AUDIO] and (background noise)
            result="${result//\[*\]/}"
            result="${result//\(*\)/}"
            # Trim whitespace
            result="${result#"${result%%[![:space:]]*}"}"
            result="${result%"${result##*[![:space:]]}"}"
            
            if [[ -n "$result" ]]; then
                echo -n "$result" | wl-copy
            fi
            rm -f "$RECORDING_FILE"
        fi
        ;;
    *)
        echo "Usage: $0 {stream|start|transcribe}"
        exit 1
        ;;
esac
