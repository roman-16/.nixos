import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export default class SpeechToTextExtension extends Extension {
    _button = null;
    _icon = null;
    _isRecording = false;
    _recordingMode = null;  // 'typing' or 'clipboard'
    _proc = null;
    _settings = null;

    enable() {
        this._settings = this.getSettings();

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

        // Click on icon toggles typing mode
        this._button.connect('clicked', () => {
            this._toggleRecording('typing');
        });

        Main.panel._rightBox.insert_child_at_index(this._button, 0);

        // Register global keybindings
        this._bindShortcuts();
    }

    disable() {
        this._unbindShortcuts();
        this._stopRecording();
        
        if (this._button) {
            Main.panel._rightBox.remove_child(this._button);
            this._button.destroy();
            this._button = null;
        }
        this._icon = null;
        this._settings = null;
    }

    _bindShortcuts() {
        const ModeType = Shell.hasOwnProperty('ActionMode')
            ? Shell.ActionMode
            : Shell.KeyBindingMode;

        Main.wm.addKeybinding(
            'toggle-typing',
            this._settings,
            Meta.KeyBindingFlags.NONE,
            ModeType.ALL,
            () => this._toggleRecording('typing')
        );

        Main.wm.addKeybinding(
            'toggle-clipboard',
            this._settings,
            Meta.KeyBindingFlags.NONE,
            ModeType.ALL,
            () => this._toggleRecording('clipboard')
        );
    }

    _unbindShortcuts() {
        Main.wm.removeKeybinding('toggle-typing');
        Main.wm.removeKeybinding('toggle-clipboard');
    }

    _getScriptPath() {
        return GLib.build_filenamev([
            GLib.get_home_dir(), '.local', 'bin', 'stt-record.sh'
        ]);
    }

    _toggleRecording(mode) {
        if (this._isRecording) {
            this._stopRecording();
        } else {
            this._startRecording(mode);
        }
    }

    _startRecording(mode) {
        this._isRecording = true;
        this._recordingMode = mode;
        this._icon.add_style_class_name('recording');

        try {
            this._proc = Gio.Subprocess.new(
                [this._getScriptPath(), 'start'],
                Gio.SubprocessFlags.NONE
            );
        } catch (e) {
            logError(e, 'SpeechToText: Failed to start recording');
            this._isRecording = false;
            this._recordingMode = null;
            this._icon.remove_style_class_name('recording');
        }
    }

    _stopRecording() {
        if (!this._isRecording) return;

        const mode = this._recordingMode;
        this._isRecording = false;
        this._recordingMode = null;
        this._icon.remove_style_class_name('recording');

        try {
            Gio.Subprocess.new(
                ['pkill', '-f', 'arecord.*stt-recording'],
                Gio.SubprocessFlags.NONE
            );

            // Wait a bit for the file to be written, then transcribe
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                try {
                    const command = mode === 'typing' ? 'transcribe-type' : 'transcribe-clipboard';
                    Gio.Subprocess.new(
                        [this._getScriptPath(), command],
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
