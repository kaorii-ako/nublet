import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {EMPTY, ICONS, STATE_LABELS, activityFor, applyEvent, countsLine, parseEvent, parseSnapshot, summarize} from './polyphParse.js';

Gio._promisify(Gio.DBusConnection.prototype, 'call');

// Polyph's daemon serves its status feed on the session bus. Read-only: approving stays in Polyph itself.
const BUS_NAME = 'org.polyph.Status1';
const OBJECT_PATH = '/org/polyph/Status';
const SNAPSHOT_TIMEOUT_MS = 2000;
const POLYPH_FALLBACKS = [`${GLib.get_home_dir()}/.local/bin/polyph`, '/usr/local/bin/polyph', '/usr/bin/polyph'];

const AGENT_ICONS = {
    waiting_approval: ICONS.waiting,
    blocked: ICONS.blocked,
    error: 'dialog-error-symbolic',
    running: ICONS.running,
    starting: ICONS.running,
};
const AGENT_CLASSES = {
    waiting_approval: 'nublet-state-permission',
    blocked: 'nublet-state-blocked',
    error: 'nublet-state-error',
    running: 'nublet-state-running',
    starting: 'nublet-state-working',
};

function findPolyph() {
    return GLib.find_program_in_path('polyph') ?? POLYPH_FALLBACKS.find(path => GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE));
}

export class PolyphProvider {
    static id = 'polyph';
    static title = 'Polyph';
    static icon = 'network-workgroup-symbolic';
    static parse = parseEvent;

    constructor() {
        this.actor = new St.BoxLayout({style_class: 'nublet-session-list', vertical: true, x_expand: true});
        this._host = null;
        this._state = EMPTY;
        this._present = false;
        this._generation = 0;
        this._queue = null;
        this._subscription = 0;
        this._watchId = 0;
    }

    start(host) {
        this._host = host;
        this._cancellable = new Gio.Cancellable();
        // Calls "vanished" at once when Polyph is not running, and never errors: no daemon means a quiet tab.
        this._watchId = Gio.bus_watch_name(Gio.BusType.SESSION, BUS_NAME, Gio.BusNameWatcherFlags.NONE,
            (connection, name, owner) => this._appeared(connection, owner),
            () => this._vanished());
        this._sync();
    }

    async _appeared(connection, owner) {
        this._unsubscribe();
        const generation = ++this._generation;
        this._present = true;
        this._queue = [];
        this._connection = connection;
        this._subscription = connection.signal_subscribe(owner, BUS_NAME, 'Event', OBJECT_PATH, null,
            Gio.DBusSignalFlags.NONE, (conn, sender, path, iface, signal, params) => this._onLine(params.deepUnpack()[0]));

        let event = null;
        try {
            const reply = await connection.call(BUS_NAME, OBJECT_PATH, BUS_NAME, 'Snapshot', null,
                new GLib.VariantType('(s)'), Gio.DBusCallFlags.NONE, SNAPSHOT_TIMEOUT_MS, this._cancellable);
            event = parseSnapshot(reply.deepUnpack()[0]);
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            // An old or busy daemon: start from nothing and let the events fill in.
        }
        if (generation !== this._generation || this._cancellable.is_cancelled())
            return;
        let state = applyEvent(EMPTY, event);
        for (const queued of this._queue)
            state = applyEvent(state, queued);
        this._queue = null;
        this._state = state;
        this._sync();
    }

    _vanished() {
        this._generation++;
        this._unsubscribe();
        this._present = false;
        this._queue = null;
        this._state = EMPTY;
        this._sync();
    }

    _onLine(line) {
        const event = parseEvent(line);
        if (!event)
            return;
        if (this._queue) {
            this._queue.push(event);
            return;
        }
        this._state = applyEvent(this._state, event);
        this._sync();
    }

    _unsubscribe() {
        if (this._subscription)
            this._connection.signal_unsubscribe(this._subscription);
        this._subscription = 0;
        this._connection = null;
    }

    _sync() {
        if (!this._host)
            return;
        const summary = summarize(this._state);
        this._host.setActivity(PolyphProvider.id, this._present ? activityFor(summary) : null);
        this._render(summary);
        this._host.relayout();
    }

    _render(summary) {
        this.actor.destroy_all_children();
        if (!this._present) {
            this._message('Polyph is not running. Start it with polyph daemon start.');
            return;
        }
        if (!summary.room) {
            this._message('No room open in Polyph');
            return;
        }

        const room = new St.BoxLayout({style_class: 'nublet-card nublet-session', vertical: true, x_expand: true});
        room.add_child(new St.Label({text: summary.name, style_class: 'nublet-feed-title'}));
        const counts = new St.Label({text: countsLine(summary), style_class: 'nublet-dim nublet-small'});
        counts.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        room.add_child(counts);
        this.actor.add_child(room);

        for (const approval of summary.approvals)
            this.actor.add_child(this._approvalRow(approval));
        for (const agent of summary.agents)
            this.actor.add_child(this._agentRow(agent));
        if (!summary.approvals.length && !summary.agents.length)
            this._message('No agents running');
    }

    _message(text) {
        this.actor.add_child(new St.Label({text, style_class: 'nublet-empty'}));
    }

    _approvalRow(approval) {
        const button = new St.Button({
            style_class: 'nublet-card nublet-feed-item',
            can_focus: true,
            x_expand: true,
            accessible_name: `Open approval in Polyph: ${approval.title}`,
        });
        const box = new St.BoxLayout({vertical: true, x_expand: true});
        const head = new St.BoxLayout({style_class: 'nublet-session-head'});
        head.add_child(new St.Icon({icon_name: ICONS.waiting, icon_size: 14, style_class: 'nublet-session-icon nublet-state-permission',
            y_align: Clutter.ActorAlign.CENTER}));
        const title = new St.Label({text: approval.title, style_class: 'nublet-feed-title', y_align: Clutter.ActorAlign.CENTER});
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        head.add_child(title);
        box.add_child(head);
        const subtitle = new St.Label({text: `Waiting for approval · ${approval.agent} · Open in Polyph`, style_class: 'nublet-dim nublet-small'});
        subtitle.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        box.add_child(subtitle);
        button.set_child(box);
        button.connect('clicked', () => this._openApprovals());
        return button;
    }

    _agentRow(agent) {
        const row = new St.BoxLayout({style_class: 'nublet-card nublet-session nublet-session-head', x_expand: true});
        row.add_child(new St.Icon({icon_name: AGENT_ICONS[agent.state], icon_size: 14,
            style_class: `nublet-session-icon ${AGENT_CLASSES[agent.state]}`, y_align: Clutter.ActorAlign.CENTER}));
        row.add_child(new St.Label({text: agent.owner ? `${agent.label} · ${agent.owner}` : agent.label,
            y_align: Clutter.ActorAlign.CENTER}));
        const status = new St.Label({text: agent.task ? `${STATE_LABELS[agent.state]} · ${agent.task}` : STATE_LABELS[agent.state],
            style_class: 'nublet-dim', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        status.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        row.add_child(status);
        return row;
    }

    // Polyph has no link to one approval yet, so this opens the browser client, where pending approvals are listed.
    _openApprovals() {
        this._host?.close();
        const polyph = findPolyph();
        if (!polyph)
            return;
        try {
            Gio.Subprocess.new([polyph, 'web'], Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            logError(e, 'Nublet: opening Polyph');
        }
    }

    stop() {
        this._cancellable?.cancel();
        this._generation++;
        if (this._watchId)
            Gio.bus_unwatch_name(this._watchId);
        this._watchId = 0;
        this._unsubscribe();
        this._host?.setActivity(PolyphProvider.id, null);
        this._host = null;
    }
}
