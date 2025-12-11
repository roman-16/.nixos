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
        echo "$(date): stream-finish started" >> "$LOG"
        echo "Recording file: $RECORDING_FILE" >> "$LOG"
        ls -la "$RECORDING_FILE" >> "$LOG" 2>&1
        
        if [[ -f "$RECORDING_FILE" ]]; then
            echo "File exists, transcribing..." >> "$LOG"
            result=$("$WHISPER_CLI" -t 4 -m "$MODEL" -f "$RECORDING_FILE" 2>&1 | tee -a "$LOG" | sed 's/\[.*\] *//g')
            echo "After sed: '$result'" >> "$LOG"
            result="${result//\[*\]/}"
            result="${result//\(*\)/}"
            result="${result#"${result%%[![:space:]]*}"}"
            result="${result%"${result##*[![:space:]]}"}"
            echo "Final result: '$result'" >> "$LOG"
            
            if [[ -n "$result" ]]; then
                echo "Typing with ydotool..." >> "$LOG"
                "$YDOTOOL" type -- "$result" >> "$LOG" 2>&1
                echo "ydotool exit code: $?" >> "$LOG"
            else
                echo "Result is empty, not typing" >> "$LOG"
            fi
            rm -f "$RECORDING_FILE"
        else
            echo "Recording file does not exist!" >> "$LOG"
        fi
        echo "$(date): stream-finish done" >> "$LOG"
        ;;
    start)
        echo "$(date): start - starting recording to $RECORDING_FILE" >> "$LOG"
        exec arecord -q -f S16_LE -r 16000 -c 1 -t wav "$RECORDING_FILE"
        ;;
    transcribe)
        echo "$(date): transcribe started" >> "$LOG"
        if [[ -f "$RECORDING_FILE" ]]; then
            echo "$(date): transcribe - file exists" >> "$LOG"
            # Transcribe and strip timestamps with sed
            result=$("$WHISPER_CLI" -t 4 -m "$MODEL" -f "$RECORDING_FILE" 2>/dev/null | sed 's/\[.*\] *//g')
            # Remove whisper artifacts like [BLANK_AUDIO] and (background noise)
            result="${result//\[*\]/}"
            result="${result//\(*\)/}"
            # Trim whitespace
            result="${result#"${result%%[![:space:]]*}"}"
            result="${result%"${result##*[![:space:]]}"}"
            
            if [[ -n "$result" ]]; then
                echo "$(date): transcribe - copying to clipboard: '$result'" >> "$LOG"
                echo -n "$result" | wl-copy
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
