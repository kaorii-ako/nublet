import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

Gio._promisify(Gio.File.prototype, 'make_directory_async');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_async');

const STATES = new Set(['idle', 'working', 'permission', 'terminal', 'done', 'error']);
const ANSWERS = new Set(['allow', 'always', 'deny', 'terminal']);
const REQUEST_ID = /^[0-9a-f]{32}$/;
const TMUX_PANE = /^%\d+$/;

function isSessionFile(name) {
    return name?.endsWith('.json') && !name.includes('.tmp');
}

function parseSession(bytes) {
    const s = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof s?.id !== 'string' || !STATES.has(s.state))
        return null;
    return {
        id: s.id,
        state: s.state,
        project: String(s.project ?? 'claude'),
        title: typeof s.title === 'string' ? s.title : '',
        tool: String(s.tool ?? ''),
        detail: String(s.detail ?? ''),
        updated: Number(s.updated) || 0,
        request: REQUEST_ID.test(s.request) ? s.request : null,
        canAlways: s.can_always === true,
        pids: Array.isArray(s.pids) ? s.pids.filter(Number.isInteger) : [],
        tmux: typeof s.tmux?.socket === 'string' && s.tmux.socket.startsWith('/') && TMUX_PANE.test(s.tmux.pane)
            ? {socket: s.tmux.socket, pane: s.tmux.pane}
            : null,
    };
}

export class ClaudeSessions extends Signals.EventEmitter {
    constructor() {
        super();
        this.sessions = new Map();
        this._dir = Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_runtime_dir(), 'nublet-claude']));
        this._cancellable = new Gio.Cancellable();
        this._monitor = null;
        this._start().catch(e => {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                logError(e, 'Nublet: Claude sessions');
        });
    }

    async _start() {
        try {
            await this._dir.make_directory_async(GLib.PRIORITY_DEFAULT, this._cancellable);
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                throw e;
        }

        await this._dir.get_child('nublet.alive').replace_contents_async(
            new TextEncoder().encode(`${new Gio.Credentials().get_unix_pid()}`), null, false,
            Gio.FileCreateFlags.PRIVATE, this._cancellable);

        this._monitor = this._dir.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, this._cancellable);
        this._monitorId = this._monitor.connect('changed', (monitor, file, other, event) => this._onChanged(file, other, event));

        const enumerator = await this._dir.enumerate_children_async('standard::name',
            Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, this._cancellable);
        for (;;) {
            const infos = await enumerator.next_files_async(64, GLib.PRIORITY_DEFAULT, this._cancellable);
            if (!infos.length)
                break;
            for (const info of infos) {
                if (isSessionFile(info.get_name()))
                    this._load(this._dir.get_child(info.get_name()));
            }
        }
    }

    _onChanged(file, other, event) {
        const E = Gio.FileMonitorEvent;
        if (event === E.RENAMED) {
            if (isSessionFile(file.get_basename()))
                this._remove(file);
            if (isSessionFile(other?.get_basename()))
                this._load(other);
        } else if (event === E.MOVED_IN || event === E.CHANGES_DONE_HINT) {
            if (isSessionFile(file.get_basename()))
                this._load(file);
        } else if (event === E.DELETED || event === E.MOVED_OUT) {
            if (isSessionFile(file.get_basename()))
                this._remove(file);
        }
    }

    async _load(file) {
        try {
            const [bytes] = await file.load_contents_async(this._cancellable);
            const session = parseSession(bytes);
            if (!session)
                return;
            this.sessions.set(session.id, session);
            this.emit('changed');
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED) ||
                e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND) || e instanceof SyntaxError)
                return;
            logError(e, 'Nublet: reading Claude session');
        }
    }

    _remove(file) {
        if (this.sessions.delete(file.get_basename().slice(0, -'.json'.length)))
            this.emit('changed');
    }

    async respond(session, answer) {
        if (!ANSWERS.has(answer) || !session.request)
            return;
        const file = this._dir.get_child(`${session.request}.response`);
        session.request = null;
        session.state = answer === 'terminal' ? 'terminal' : 'working';
        this.emit('changed');
        try {
            await file.replace_contents_async(new TextEncoder().encode(answer), null, false,
                Gio.FileCreateFlags.PRIVATE, this._cancellable);
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                logError(e, 'Nublet: answering Claude permission');
        }
    }

    focus(session) {
        const pids = new Set(session.pids);
        const windows = global.display.sort_windows_by_stacking(
            global.get_window_actors().map(a => a.meta_window).filter(w => pids.has(w.get_pid())));
        const match = windows.findLast(w => w.get_title()?.includes(session.project)) ?? windows.at(-1);
        if (match)
            Main.activateWindow(match);

        if (session.tmux) {
            const {socket, pane} = session.tmux;
            try {
                Gio.Subprocess.new(['tmux', '-S', socket,
                    'select-window', '-t', pane, ';',
                    'select-pane', '-t', pane, ';',
                    'switch-client', '-t', pane], Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
            } catch (e) {
                logError(e, 'Nublet: focusing tmux pane');
            }
        }
    }

    destroy() {
        this._cancellable.cancel();
        this._dir.get_child('nublet.alive').delete_async(GLib.PRIORITY_DEFAULT, null, null);
        if (this._monitor) {
            this._monitor.disconnect(this._monitorId);
            this._monitor.cancel();
        }
        this._monitor = null;
        this.disconnectAll();
        this.sessions.clear();
    }
}
