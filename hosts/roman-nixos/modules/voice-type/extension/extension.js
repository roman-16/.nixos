import GObject from 'gi://GObject';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import Soup from 'gi://Soup?version=3.0';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

// Absolute paths substituted at build time by default.nix.
const PW_RECORD = '@PW_RECORD@';
const DOTOOLC = '@DOTOOLC@';
const GJS = '@GJS@';
const KEYMONITOR = '@KEYMONITOR@';

const KEYBIND = 'toggle-recording';
const MODEL = 'voxtral-mini-transcribe-realtime-2602';
const WS_URL = `wss://api.mistral.ai/v1/audio/transcriptions/realtime?model=${MODEL}`;
const SAMPLE_RATE = 16000;
const TARGET_DELAY_MS = 2400;
const CHUNK_BYTES = (SAMPLE_RATE * 2 * 100) / 1000; // 100ms of 16-bit mono
const MAX_SECONDS = 120;
const RESUME_DEBOUNCE_MS = 300; // wait after keys released before resuming typing
const MAX_HOLD_MS = 10000; // force-resume if a key looks stuck
const STOP_GUARD_US = 500000; // ignore a Super+Space "stop" right after opening
const TYPE_HOLD_MS = 1; // dotool key-hold time; lower = faster typing
const TYPE_DELAY_MS = 0; // dotool delay between keys

// The centered modal overlay (à la Alt+F2), showing the live transcription and
// a countdown, capturing Escape / Enter / Super+Space.
const VoiceOverlay = GObject.registerClass(
class VoiceOverlay extends ModalDialog.ModalDialog {
    _init() {
        super._init({styleClass: 'voice-type-overlay', destroyOnClose: true});

        this.onStop = null;
        this.onCancel = null;
        this._openedAt = 0;

        this._status = new St.Label({style_class: 'voice-type-status', text: 'Listening…'});
        this._countdown = new St.Label({style_class: 'voice-type-countdown', text: ''});

        const header = new St.BoxLayout({style_class: 'voice-type-header'});
        header.add_child(this._status);
        header.add_child(new St.Widget({x_expand: true}));
        header.add_child(this._countdown);

        this._text = new St.Label({style_class: 'voice-type-text', text: ''});
        this._text.clutter_text.line_wrap = true;
        // St.Label ellipsizes (END) by default, which clips the text and shows
        // a trailing "…" instead of letting it grow so the ScrollView scrolls.
        this._text.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        const textBox = new St.BoxLayout({style_class: 'voice-type-textbox'});
        textBox.add_child(this._text);

        this._scroll = new St.ScrollView({
            style_class: 'voice-type-scroll',
            reactive: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });
        this._scroll.child = textBox;
        // Keep the latest text visible at the bottom as the transcription grows.
        this._scroll.vadjustment.connect('changed', adj => {
            adj.value = Math.max(0, adj.upper - adj.page_size);
        });

        this._hint = new St.Label({
            style_class: 'voice-type-hint',
            text: 'Enter / Super+Space: insert     ·     Esc: cancel',
        });

        this.contentLayout.add_child(header);
        this.contentLayout.add_child(this._scroll);
        this.contentLayout.add_child(this._hint);
    }

    open() {
        const ok = super.open();
        this._openedAt = GLib.get_monotonic_time();
        return ok;
    }

    setStatus(text) {
        this._status.text = text;
    }

    setCountdown(text) {
        this._countdown.text = text;
    }

    setText(text) {
        this._text.text = text;
    }

    vfunc_key_press_event(event) {
        const symbol = event.get_key_symbol();
        const state = event.get_state();

        if (symbol === Clutter.KEY_Escape) {
            this.onCancel?.();
            return Clutter.EVENT_STOP;
        }
        if (symbol === Clutter.KEY_Return ||
            symbol === Clutter.KEY_KP_Enter ||
            symbol === Clutter.KEY_ISO_Enter) {
            this.onStop?.();
            return Clutter.EVENT_STOP;
        }
        if (symbol === Clutter.KEY_space && (state & Clutter.ModifierType.MOD4_MASK)) {
            if (GLib.get_monotonic_time() - this._openedAt > STOP_GUARD_US)
                this.onStop?.();
            return Clutter.EVENT_STOP;
        }
        return super.vfunc_key_press_event(event);
    }
});

// Captures the microphone, streams it to Mistral's realtime endpoint, exposes
// the live transcription, and (on commit) types the final text into the focused
// window via dotoolc - gated on physical-keyboard idleness (keymonitor.js).
class Session {
    constructor(apiKey, {onUpdate, onComplete, onError}) {
        this._apiKey = apiKey;
        this._onUpdate = onUpdate;
        this._onComplete = onComplete;
        this._onError = onError;

        this._cancellable = new Gio.Cancellable();
        this._rec = null;
        this._stdout = null;
        this._httpSession = null;
        this._conn = null;
        this._monitor = null;

        this._recording = true;
        this._audioEnded = false;
        this._transcriptionEnded = false;
        this._settled = false;

        this._text = '';

        this._committing = false;
        this._commitDone = null;
        this._queue = [];
        this._typing = false;
        this._canType = true;
        this._resumeId = 0;
        this._maxHoldId = 0;

        this._typeLauncher = new Gio.SubprocessLauncher({
            flags: Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
        });
        this._typeLauncher.setenv(
            'DOTOOL_PIPE',
            GLib.build_filenamev([GLib.get_user_runtime_dir(), 'dotool.pipe']),
            true);
    }

    start() {
        this._startMonitor();

        try {
            this._rec = Gio.Subprocess.new(
                [PW_RECORD, '--rate', String(SAMPLE_RATE), '--channels', '1',
                    '--format', 's16', '--raw', '-'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            this._fail(`pw-record: ${e.message}`);
            return;
        }
        this._stdout = this._rec.get_stdout_pipe();

        this._httpSession = new Soup.Session();
        const msg = Soup.Message.new_from_uri('GET', GLib.Uri.parse(WS_URL, GLib.UriFlags.NONE));
        msg.get_request_headers().append('Authorization', `Bearer ${this._apiKey}`);

        this._httpSession.websocket_connect_async(
            msg, null, null, GLib.PRIORITY_DEFAULT, this._cancellable,
            (session, res) => {
                try {
                    this._conn = session.websocket_connect_finish(res);
                } catch (e) {
                    this._fail(`websocket: ${e.message}`);
                    return;
                }
                this._conn.connect('message', (_c, type, bytes) => this._onMessage(type, bytes));
                this._conn.connect('closed', () => this._endTranscription());
                this._conn.connect('error', (_c, err) => this._fail(`websocket: ${err.message}`));

                this._send({
                    type: 'session.update',
                    session: {
                        audio_format: {encoding: 'pcm_s16le', sample_rate: SAMPLE_RATE},
                        target_streaming_delay_ms: TARGET_DELAY_MS,
                    },
                });
                this._readChunk();
            });
    }

    // Stop the mic; the drained stream flushes and the server sends done.
    finalize() {
        if (!this._recording)
            return;
        this._recording = false;
        this._stopRecorder();
    }

    // Type the final text (called after the overlay has closed and focus
    // returned to the target field). onDone fires once typing has drained.
    commit(text, onDone) {
        if (this._settled) {
            onDone?.();
            return;
        }
        this._committing = true;
        this._commitDone = onDone;
        // Word-by-word so the keyboard gate can pause mid-burst.
        for (const piece of (text.match(/\S+\s*/g) ?? []))
            this._queue.push(piece);
        this._pump();
    }

    abort() {
        if (this._settled)
            return;
        this._settled = true;
        this._cancellable.cancel();
        this._cleanup();
    }

    // --- physical-keyboard gate ---------------------------------------------

    _startMonitor() {
        try {
            this._monitor = Gio.Subprocess.new(
                [GJS, '-m', KEYMONITOR],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            this._monitor = null; // gate disabled: type without pausing
            return;
        }
        const stdout = new Gio.DataInputStream({base_stream: this._monitor.get_stdout_pipe()});
        const readLine = () => {
            stdout.read_line_async(GLib.PRIORITY_DEFAULT, this._cancellable, (s, res) => {
                let line;
                try {
                    [line] = s.read_line_finish_utf8(res);
                } catch (e) {
                    return;
                }
                if (line === null) {
                    this._resume();
                    return;
                }
                if (line === '1')
                    this._onBusy();
                else if (line === '0')
                    this._onIdle();
                readLine();
            });
        };
        readLine();
    }

    _onBusy() {
        this._clearGateTimers();
        this._canType = false;
        this._maxHoldId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, MAX_HOLD_MS, () => {
            this._maxHoldId = 0;
            this._resume();
            return GLib.SOURCE_REMOVE;
        });
    }

    _onIdle() {
        this._clearGateTimers();
        this._resumeId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RESUME_DEBOUNCE_MS, () => {
            this._resumeId = 0;
            this._resume();
            return GLib.SOURCE_REMOVE;
        });
    }

    _resume() {
        this._clearGateTimers();
        this._canType = true;
        this._pump();
    }

    _clearGateTimers() {
        if (this._resumeId) {
            GLib.source_remove(this._resumeId);
            this._resumeId = 0;
        }
        if (this._maxHoldId) {
            GLib.source_remove(this._maxHoldId);
            this._maxHoldId = 0;
        }
    }

    // --- audio + transcription ----------------------------------------------

    _stopRecorder() {
        if (this._rec) {
            try {
                this._rec.send_signal(15); // SIGTERM
            } catch (_) {}
        }
    }

    _readChunk() {
        if (this._audioEnded)
            return;
        this._stdout.read_bytes_async(
            CHUNK_BYTES, GLib.PRIORITY_DEFAULT, this._cancellable, (stream, res) => {
                let bytes;
                try {
                    bytes = stream.read_bytes_finish(res);
                } catch (e) {
                    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        logError(e, 'voice-type: mic read failed');
                    return;
                }
                if (bytes.get_size() === 0) {
                    this._endAudio();
                    return;
                }
                this._send({type: 'input_audio.append', audio: GLib.base64_encode(bytes.get_data())});
                this._readChunk();
            });
    }

    _endAudio() {
        if (this._audioEnded)
            return;
        this._audioEnded = true;
        this._send({type: 'input_audio.flush'});
        this._send({type: 'input_audio.end'});
    }

    _onMessage(type, bytes) {
        if (this._settled || type !== Soup.WebsocketDataType.TEXT)
            return;
        let ev;
        try {
            ev = JSON.parse(new TextDecoder().decode(bytes.get_data()));
        } catch (e) {
            return;
        }
        switch (ev.type) {
        case 'transcription.text.delta':
            if (ev.text) {
                this._text += ev.text;
                this._onUpdate(this._text);
            }
            break;
        case 'transcription.done':
            if (typeof ev.text === 'string' && ev.text.length >= this._text.length)
                this._text = ev.text;
            this._endTranscription();
            break;
        case 'error': {
            const m = ev.error?.message;
            this._fail(typeof m === 'string' ? m : JSON.stringify(m ?? ev.error));
            break;
        }
        }
    }

    _send(obj) {
        if (this._conn && this._conn.get_state() === Soup.WebsocketState.OPEN)
            this._conn.send_text(JSON.stringify(obj));
    }

    _endTranscription() {
        if (this._settled || this._transcriptionEnded)
            return;
        this._transcriptionEnded = true;
        this._closeStream();
        this._onComplete(this._text);
    }

    // Close the mic + socket but keep the keyboard monitor alive for commit().
    _closeStream() {
        this._stopRecorder();
        if (this._conn) {
            try {
                this._conn.close(Soup.WebsocketCloseCode.NORMAL, null);
            } catch (_) {}
            this._conn = null;
        }
        if (this._httpSession) {
            this._httpSession.abort();
            this._httpSession = null;
        }
    }

    // --- typing queue -------------------------------------------------------

    _pump() {
        if (this._typing)
            return;
        if (this._queue.length === 0) {
            this._finishCommit();
            return;
        }
        if (!this._canType)
            return;

        const text = this._queue.shift();
        const line = `typehold ${TYPE_HOLD_MS}\ntypedelay ${TYPE_DELAY_MS}\ntype ${text.replace(/[\n\r]/g, ' ')}\n`;
        let proc;
        try {
            proc = this._typeLauncher.spawnv([DOTOOLC]);
        } catch (e) {
            logError(e, 'voice-type: dotoolc spawn failed');
            this._pump();
            return;
        }
        this._typing = true;
        proc.communicate_utf8_async(line, null, (p, res) => {
            try {
                p.communicate_utf8_finish(res);
            } catch (_) {}
            this._typing = false;
            this._pump();
        });
    }

    _finishCommit() {
        if (!this._committing || this._settled)
            return;
        this._settled = true;
        this._cleanup();
        this._commitDone?.();
    }

    _fail(reason) {
        if (this._settled)
            return;
        this._settled = true;
        log(`voice-type: ${reason}`);
        this._cleanup();
        this._onError(reason);
    }

    _cleanup() {
        this._clearGateTimers();
        this._closeStream();
        if (this._monitor) {
            try {
                this._monitor.force_exit();
            } catch (_) {}
            this._monitor = null;
        }
    }
}

export default class VoiceTypeExtension extends Extension {
    enable() {
        this._session = null;
        this._overlay = null;
        this._recording = false;
        this._tickId = 0;
        this._commitDelayId = 0;
        this._deadlineUs = 0;
        this._settings = this.getSettings();

        Main.wm.addKeybinding(
            KEYBIND,
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._toggle());
    }

    disable() {
        Main.wm.removeKeybinding(KEYBIND);
        this._clearCountdown();
        if (this._commitDelayId) {
            GLib.source_remove(this._commitDelayId);
            this._commitDelayId = 0;
        }
        this._session?.abort();
        this._session = null;
        this._overlay?.destroy();
        this._overlay = null;
        this._recording = false;
        this._settings = null;
    }

    // Only fires when idle; while the overlay is open the modal grabs the key,
    // so Super+Space "stop" is handled inside the overlay.
    _toggle() {
        if (this._session)
            return;
        this._start();
    }

    _readApiKey() {
        const path = GLib.build_filenamev([GLib.get_user_config_dir(), 'voice-type', 'config.json']);
        try {
            const [ok, contents] = GLib.file_get_contents(path);
            if (!ok)
                return null;
            return JSON.parse(new TextDecoder().decode(contents)).mistralApiKey ?? null;
        } catch (e) {
            return null;
        }
    }

    _start() {
        const apiKey = this._readApiKey();
        if (!apiKey) {
            Main.notify('Voice Type', 'Missing Mistral API key');
            return;
        }

        this._overlay = new VoiceOverlay();
        this._overlay.onCancel = () => this._cancel();
        this._overlay.onStop = () => this._stop();
        if (!this._overlay.open()) {
            this._overlay.destroy();
            this._overlay = null;
            Main.notify('Voice Type', 'Could not open the overlay');
            return;
        }

        this._session = new Session(apiKey, {
            onUpdate: text => this._overlay?.setText(text),
            onComplete: text => this._onComplete(text),
            onError: msg => this._onError(msg),
        });
        this._recording = true;
        this._session.start();
        this._startCountdown();
    }

    _startCountdown() {
        this._deadlineUs = GLib.get_monotonic_time() + MAX_SECONDS * 1000000;
        this._tick();
    }

    _tick() {
        const remaining = Math.max(0, Math.ceil((this._deadlineUs - GLib.get_monotonic_time()) / 1000000));
        this._overlay?.setCountdown(`${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`);
        if (remaining <= 0) {
            this._stop();
            return;
        }
        this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            this._tickId = 0;
            this._tick();
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearCountdown() {
        if (this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }
    }

    _stop() {
        if (!this._session || !this._recording)
            return;
        this._recording = false;
        this._clearCountdown();
        this._overlay?.setStatus('Finishing…');
        this._overlay?.setCountdown('');
        this._session.finalize();
    }

    _cancel() {
        this._clearCountdown();
        this._session?.abort();
        this._session = null;
        this._overlay?.close();
        this._overlay = null;
        this._recording = false;
    }

    _onComplete(finalText) {
        this._clearCountdown();
        this._overlay?.close(); // restores focus to the previously focused field
        this._overlay = null;

        const session = this._session;
        if (!session)
            return;
        // Let focus settle after the modal closes, then type.
        this._commitDelayId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            this._commitDelayId = 0;
            session.commit(finalText, () => this._finishSession());
            return GLib.SOURCE_REMOVE;
        });
    }

    _onError(msg) {
        this._clearCountdown();
        this._overlay?.close();
        this._overlay = null;
        this._session?.abort();
        this._session = null;
        this._recording = false;
        Main.notify('Voice Type', `Error: ${msg}`);
    }

    _finishSession() {
        this._session = null;
        this._recording = false;
    }
}
