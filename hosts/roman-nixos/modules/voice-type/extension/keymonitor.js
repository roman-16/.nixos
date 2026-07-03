// Standalone gjs monitor spawned by the voice-type extension for the duration
// of a session. It passively watches the physical keyboards (excluding dotool's
// own virtual device) and writes "1"/"0" lines to stdout when the set of held
// keys becomes non-empty/empty, so the extension can pause synthetic typing
// while real keys are pressed.
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';

const EV_KEY = 0x01;
const EVENT_SIZE = 24; // struct input_event on 64-bit: 16 (timeval) + 2 + 2 + 4
const SELF_DEVICE = 'dotool keyboard';

const loop = new GLib.MainLoop(null, false);
const stdout = new GioUnix.OutputStream({fd: 1, close_fd: false});
const encoder = new TextEncoder();
const pressed = new Set();
let busy = false;

function report(state) {
    try {
        stdout.write_all(encoder.encode(`${state ? 1 : 0}\n`), null);
        stdout.flush(null);
    } catch (e) {}
}

function update() {
    const nowBusy = pressed.size > 0;
    if (nowBusy !== busy) {
        busy = nowBusy;
        report(busy);
    }
}

function physicalKeyboards() {
    const [ok, contents] = GLib.file_get_contents('/proc/bus/input/devices');
    if (!ok)
        return [];
    const devices = [];
    let name = '';
    for (const line of new TextDecoder().decode(contents).split('\n')) {
        if (line.startsWith('N: Name='))
            name = line.slice(8).replace(/^"|"$/g, '');
        else if (line.startsWith('H: Handlers=')) {
            const handlers = line.slice(12).trim().split(/\s+/);
            const ev = handlers.find(h => h.startsWith('event'));
            if (handlers.includes('kbd') && name !== SELF_DEVICE && ev)
                devices.push(`/dev/input/${ev}`);
        }
    }
    return devices;
}

function watch(path, index) {
    let stream;
    try {
        stream = Gio.File.new_for_path(path).read(null);
    } catch (e) {
        return;
    }

    const read = () => {
        stream.read_bytes_async(EVENT_SIZE, GLib.PRIORITY_DEFAULT, null, (s, res) => {
            let bytes;
            try {
                bytes = s.read_bytes_finish(res);
            } catch (e) {
                return;
            }
            if (bytes.get_size() < EVENT_SIZE)
                return;
            const arr = bytes.get_data();
            const view = new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
            if (view.getUint16(16, true) === EV_KEY) {
                const code = view.getUint16(18, true);
                const value = view.getInt32(20, true);
                const key = `${index}:${code}`;
                if (value === 1)
                    pressed.add(key);
                else if (value === 0)
                    pressed.delete(key);
                update();
            }
            read();
        });
    };
    read();
}

const devices = physicalKeyboards();
if (devices.length === 0)
    report(false);
devices.forEach(watch);
loop.run();
