import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

export default class SpeechToTextExtension extends Extension {
    _icon = null;
    _button = null;
    _isRecording = false;
    _process = null;

    enable() {
        this._icon = new St.Icon({
            icon_name: 'audio-input-microphone-symbolic',
            style_class: 'system-status-icon',
        });

        this._button = new St.Bin({
            style_class: 'panel-button stt-button',
            reactive: true,
            can_focus: true,
            track_hover: true,
            child: this._icon,
        });

        this._button.connect('button-press-event', () => {
            this._toggleRecording();
            return true;
        });

        Main.panel._rightBox.insert_child_at_index(this._button, 0);
    }

    disable() {
        this._stopRecording();
        if (this._button) {
            Main.panel._rightBox.remove_child(this._button);
            this._button.destroy();
            this._button = null;
            this._icon = null;
        }
    }

    _toggleRecording() {
        if (this._isRecording) {
            this._stopRecording();
        } else {
            this._startRecording();
        }
    }

    _startRecording() {
        this._isRecording = true;
        this._button.add_style_class_name('recording');

        try {
            const scriptPath = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'stt-record.sh']);
            this._process = Gio.Subprocess.new(
                [scriptPath, 'start'],
                Gio.SubprocessFlags.NONE
            );
        } catch (e) {
            logError(e, 'SpeechToText: Failed to start recording');
            this._isRecording = false;
            this._button.remove_style_class_name('recording');
        }
    }

    _stopRecording() {
        if (!this._isRecording) return;

        this._isRecording = false;
        this._button.remove_style_class_name('recording');

        try {
            // Kill the recording process
            Gio.Subprocess.new(
                ['pkill', '-f', 'rec.*stt-recording'],
                Gio.SubprocessFlags.NONE
            );

            // Run transcription
            const scriptPath = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'stt-record.sh']);
            const proc = Gio.Subprocess.new(
                [scriptPath, 'transcribe'],
                Gio.SubprocessFlags.NONE
            );
        } catch (e) {
            logError(e, 'SpeechToText: Failed to stop recording');
        }
    }
}
