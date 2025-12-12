import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const SCRIPT = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'stt-record.sh']);

export default class SpeechToTextExtension extends Extension {
    enable() {
        this._mode = null;
        this._icon = new St.Icon({icon_name: 'audio-input-microphone-symbolic', style_class: 'system-status-icon recording'});
        this._button = new St.Button({style_class: 'panel-button', child: this._icon, visible: false});
        this._button.connect('clicked', () => this._toggle('type'));
        Main.panel._rightBox.insert_child_at_index(this._button, 0);

        const mode = Shell.ActionMode ?? Shell.KeyBindingMode;
        Main.wm.addKeybinding('toggle-typing', this.getSettings(), Meta.KeyBindingFlags.NONE, mode.ALL, () => this._toggle('type'));
        Main.wm.addKeybinding('toggle-clipboard', this.getSettings(), Meta.KeyBindingFlags.NONE, mode.ALL, () => this._toggle('clipboard'));
    }

    disable() {
        Main.wm.removeKeybinding('toggle-typing');
        Main.wm.removeKeybinding('toggle-clipboard');
        this._stop();
        this._button?.destroy();
    }

    _toggle(mode) {
        this._mode ? this._stop() : this._start(mode);
    }

    _start(mode) {
        this._mode = mode;
        this._button.visible = true;
        try { Gio.Subprocess.new([SCRIPT, 'start'], Gio.SubprocessFlags.NONE); }
        catch(e) { this._mode = null; this._button.visible = false; }
    }

    _stop() {
        if (!this._mode) return;
        const mode = this._mode;
        this._mode = null;
        this._button.visible = false;
        try {
            Gio.Subprocess.new(['pkill', '-f', 'arecord.*stt-recording'], Gio.SubprocessFlags.NONE);
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                try { Gio.Subprocess.new([SCRIPT, mode], Gio.SubprocessFlags.NONE); } catch(e) {}
                return GLib.SOURCE_REMOVE;
            });
        } catch(e) {}
    }
}
