#!/usr/bin/env bash
set -euo pipefail

export WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-0}"

RECORDING_FILE="/dev/shm/stt-recording.wav"
MODEL="@model@"
WHISPER_CLI="@whisper@/bin/whisper-cli"
YDOTOOL="@ydotool@/bin/ydotool"
LOG="/tmp/stt-debug.log"

echo "$(date): stt-record.sh called with args: $*" >> "$LOG"

transcribe_audio() {
    if [[ ! -f "$RECORDING_FILE" ]]; then
        echo "$(date): transcribe - file does not exist!" >> "$LOG"
        return 1
    fi
    
    echo "$(date): transcribe - file exists" >> "$LOG"
    local result
    result=$("$WHISPER_CLI" -t 4 -m "$MODEL" -f "$RECORDING_FILE" 2>/dev/null | sed 's/\[.*\] *//g')
    result="${result//\[*\]/}"
    result="${result//\(*\)/}"
    result="${result#"${result%%[![:space:]]*}"}"
    result="${result%"${result##*[![:space:]]}"}"
    
    rm -f "$RECORDING_FILE"
    echo "$result"
}

case "${1:-}" in
    start)
        echo "$(date): start - starting recording to $RECORDING_FILE" >> "$LOG"
        exec arecord -q -f S16_LE -r 16000 -c 1 -t wav "$RECORDING_FILE"
        ;;
    transcribe-type)
        # Transcribe and TYPE via clipboard+paste
        echo "$(date): transcribe-type started" >> "$LOG"
        result=$(transcribe_audio)
        
        if [[ -n "$result" ]]; then
            echo "$(date): transcribe-type - typing via clipboard+paste: '$result'" >> "$LOG"
            echo -n "$result" | wl-copy
            sleep 0.15
            # Paste with Shift+Insert (keycodes: 42=LeftShift, 110=Insert)
            "$YDOTOOL" key 42:1 110:1 110:0 42:0 >> "$LOG" 2>&1
            echo "ydotool exit code: $?" >> "$LOG"
        else
            echo "$(date): transcribe-type - result empty" >> "$LOG"
        fi
        echo "$(date): transcribe-type done" >> "$LOG"
        ;;
    transcribe-clipboard)
        # Transcribe and COPY to clipboard only
        echo "$(date): transcribe-clipboard started" >> "$LOG"
        result=$(transcribe_audio)
        
        if [[ -n "$result" ]]; then
            echo "$(date): transcribe-clipboard - copying to clipboard: '$result'" >> "$LOG"
            echo -n "$result" | wl-copy
        else
            echo "$(date): transcribe-clipboard - result empty" >> "$LOG"
        fi
        echo "$(date): transcribe-clipboard done" >> "$LOG"
        ;;
    *)
        echo "Usage: $0 {start|transcribe-type|transcribe-clipboard}"
        exit 1
        ;;
esac
