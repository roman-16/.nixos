import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export default class SpeechToTextExtension extends Extension {
    _button = null;
    _icon = null;
    _isStreaming = false;
    _isRecording = false;
    _proc = null;

    enable() {
        this._icon = new St.Icon({
            icon_name: 'audio-input-microphone-symbolic',
            style_class: 'system-status-icon',
        });

        this._button = new St.Button({
            style_class: 'panel-button',
            child: this._icon,
            reactive: true,
            can_focus: true,
            track_hover: true,
        });

        this._button.connect('button-press-event', (actor, event) => {
            const button = event.get_button();
            if (button === 1) {  // Left click
                this._toggleStreaming();
            } else if (button === 3) {  // Right click
                this._toggleRecording();
            }
            return Clutter.EVENT_STOP;
        });

        Main.panel._rightBox.insert_child_at_index(this._button, 0);
    }

    disable() {
        this._stopStreaming();
        this._stopRecording();
        if (this._button) {
            Main.panel._rightBox.remove_child(this._button);
            this._button.destroy();
            this._button = null;
        }
        this._icon = null;
    }

    _getScriptPath() {
        return GLib.build_filenamev([
            GLib.get_home_dir(), '.local', 'bin', 'stt-record.sh'
        ]);
    }

    // Streaming mode (left click) - real-time typing
    _toggleStreaming() {
        if (this._isStreaming) {
            this._stopStreaming();
        } else {
            this._startStreaming();
        }
    }

    _startStreaming() {
        if (this._isRecording) return;
        
        this._isStreaming = true;
        this._icon.add_style_class_name('recording');

        try {
            this._proc = Gio.Subprocess.new(
                [this._getScriptPath(), 'stream'],
                Gio.SubprocessFlags.NONE
            );
        } catch (e) {
            logError(e, 'SpeechToText: Failed to start streaming');
            this._isStreaming = false;
            this._icon.remove_style_class_name('recording');
        }
    }

    _stopStreaming() {
        if (!this._isStreaming) return;

        this._isStreaming = false;
        this._icon.remove_style_class_name('recording');

        try {
            // Kill the recording process
            Gio.Subprocess.new(
                ['pkill', '-f', 'arecord.*stt-recording'],
                Gio.SubprocessFlags.NONE
            );

            // Wait a bit for the file to be written, then transcribe and type
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                try {
                    Gio.Subprocess.new(
                        [this._getScriptPath(), 'stream-finish'],
                        Gio.SubprocessFlags.NONE
                    );
                } catch (e) {
                    logError(e, 'SpeechToText: Failed to run stream-finish');
                }
                return GLib.SOURCE_REMOVE;
            });
        } catch (e) {
            logError(e, 'SpeechToText: Failed to stop streaming');
        }

        this._proc = null;
    }

    // Recording mode (right click) - record then paste
    _toggleRecording() {
        if (this._isRecording) {
            this._stopRecording();
        } else {
            this._startRecording();
        }
    }

    _startRecording() {
        if (this._isStreaming) return;
        
        this._isRecording = true;
        this._icon.add_style_class_name('recording');

        try {
            this._proc = Gio.Subprocess.new(
                [this._getScriptPath(), 'start'],
                Gio.SubprocessFlags.NONE
            );
        } catch (e) {
            logError(e, 'SpeechToText: Failed to start recording');
            this._isRecording = false;
            this._icon.remove_style_class_name('recording');
        }
    }

    _stopRecording() {
        if (!this._isRecording) return;

        this._isRecording = false;
        this._icon.remove_style_class_name('recording');

        try {
            Gio.Subprocess.new(
                ['pkill', '-f', 'arecord.*stt-recording'],
                Gio.SubprocessFlags.NONE
            );

            // Wait a bit for the file to be written, then transcribe
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                try {
                    Gio.Subprocess.new(
                        [this._getScriptPath(), 'transcribe'],
                        Gio.SubprocessFlags.NONE
                    );
                } catch (e) {
                    logError(e, 'SpeechToText: Failed to run transcribe');
                }
                return GLib.SOURCE_REMOVE;
            });
        } catch (e) {
            logError(e, 'SpeechToText: Failed to stop recording');
        }

        this._proc = null;
    }
}
