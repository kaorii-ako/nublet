import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Graphene from 'gi://Graphene';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {easeOut} from './anim.js';
import {ClaudeSessions} from './claude.js';

const DONE_VISIBLE_SECONDS = 8;
const URGENCY = ['permission', 'terminal', 'error', 'done', 'working', 'idle'];
const ICONS = {
    idle: 'media-record-symbolic',
    working: 'media-record-symbolic',
    permission: 'security-high-symbolic',
    terminal: 'media-record-symbolic',
    done: 'object-select-symbolic',
    error: 'dialog-error-symbolic',
};
const PRIORITY = {permission: 100, error: 90, done: 50, terminal: 45, working: 10};
const ACTIONS = [
    ['Allow once', 'allow', 'nublet-allow'],
    ['Always allow', 'always', ''],
    ['Deny', 'deny', 'nublet-deny'],
    ['Open terminal', 'terminal', ''],
];

function statusText(s) {
    switch (s.state) {
    case 'working': return 'Working';
    case 'permission': return 'Needs approval';
    case 'terminal': return 'Waiting in terminal';
    case 'done': return s.detail || 'Done';
    case 'error': return 'Stopped with an error';
    default: return 'Idle';
    }
}

function byUrgency(a, b) {
    return URGENCY.indexOf(a.state) - URGENCY.indexOf(b.state) || b.updated - a.updated;
}

export class ClaudeView {
    static title = 'Claude';
    static icon = 'utilities-terminal-symbolic';

    constructor(host) {
        this.title = ClaudeView.title;
        this.icon = ClaudeView.icon;
        this._host = host;
        this._rows = new Map();
        this._expiryId = 0;
        this._active = false;

        this.actor = new St.BoxLayout({
            style_class: 'nublet-session-list',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._empty = new St.Label({text: 'No Claude sessions', style_class: 'nublet-empty'});
        this.actor.add_child(this._empty);

        this._sessions = new ClaudeSessions();
        this._sessions.connect('changed', () => this._sync());
        this._sync();
    }

    setActive(active) {
        this._active = active;
    }

    reveal() {
        let i = 0;
        for (const row of this._rows.values()) {
            row.actor.remove_all_transitions();
            row.actor.set({opacity: 0, translation_y: -4});
            easeOut(row.actor, {opacity: 255, translation_y: 0, duration: 200, delay: 60 + 40 * Math.min(i++, 5)});
        }
    }

    _visible() {
        const now = Date.now() / 1000;
        return [...this._sessions.sessions.values()]
            .filter(s => s.state !== 'idle' && !(s.state === 'done' && now - s.updated > DONE_VISIBLE_SECONDS))
            .sort(byUrgency);
    }

    _sync() {
        const active = this._visible();
        const top = active[0];
        if (top) {
            const what = {permission: top.tool || 'needs approval', error: 'failed', done: 'done'}[top.state];
            this._host.setActivity('claude', {
                priority: PRIORITY[top.state],
                icon: ICONS[top.state],
                iconClass: `nublet-state-${top.state}`,
                text: what ? `${top.tileTitle || top.project} · ${what}` : undefined,
                key: `${top.id}:${top.state}:${top.request ?? ''}`,
                badge: active.length > 1 ? `+${active.length - 1}` : null,
                bump: top.state === 'permission',
                pop: top.state === 'done',
            });
        } else {
            this._host.setActivity('claude', null);
        }
        this._scheduleExpiry();
        this._syncRows();
        this._host.relayout();
    }

    _scheduleExpiry() {
        if (this._expiryId) {
            GLib.source_remove(this._expiryId);
            this._expiryId = 0;
        }
        const now = Date.now() / 1000;
        const expiries = [...this._sessions.sessions.values()]
            .filter(s => s.state === 'done' && now - s.updated <= DONE_VISIBLE_SECONDS)
            .map(s => s.updated + DONE_VISIBLE_SECONDS - now);
        if (!expiries.length)
            return;
        this._expiryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.ceil(Math.min(...expiries) * 1000) + 50, () => {
            this._expiryId = 0;
            this._sync();
            return GLib.SOURCE_REMOVE;
        });
    }

    _syncRows() {
        const sessions = [...this._sessions.sessions.values()].sort(byUrgency);
        const ids = new Set(sessions.map(s => s.id));
        const animate = this._active && St.Settings.get().enable_animations;

        for (const [id, row] of this._rows) {
            if (ids.has(id))
                continue;
            this._rows.delete(id);
            if (animate)
                easeOut(row.actor, {opacity: 0, duration: 90, onStopped: () => row.actor.destroy()});
            else
                row.actor.destroy();
        }

        let previous = null;
        for (const s of sessions) {
            let row = this._rows.get(s.id);
            if (!row) {
                row = this._createRow();
                this._rows.set(s.id, row);
                this.actor.add_child(row.actor);
                if (animate) {
                    row.actor.set({opacity: 0, translation_y: -4});
                    easeOut(row.actor, {opacity: 255, translation_y: 0, duration: 200});
                }
            }
            if (row.actor.get_previous_sibling() !== previous) {
                if (previous)
                    this.actor.set_child_above_sibling(row.actor, previous);
                else
                    this.actor.set_child_below_sibling(row.actor, null);
            }
            this._updateRow(row, s);
            previous = row.actor;
        }
        this._empty.visible = sessions.length === 0;
    }

    _createRow() {
        const actor = new St.BoxLayout({
            style_class: 'nublet-card nublet-session',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        const head = new St.BoxLayout({style_class: 'nublet-session-head'});
        const icon = new St.Icon({
            icon_size: 14,
            y_align: Clutter.ActorAlign.CENTER,
            pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
        });
        const name = new St.Button({style_class: 'nublet-session-name', can_focus: true, y_align: Clutter.ActorAlign.CENTER});
        const status = new St.Label({style_class: 'nublet-dim', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        status.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        head.add_child(icon);
        head.add_child(name);
        head.add_child(status);
        actor.add_child(head);

        const row = {actor, icon, name, status, request: null, requestId: null, session: null, state: null};
        name.connect('clicked', () => this._focus(row.session));
        return row;
    }

    _updateRow(row, s) {
        row.session = s;
        if (row.state !== s.state) {
            const pop = row.state !== null && s.state === 'done';
            row.state = s.state;
            row.icon.icon_name = ICONS[s.state];
            row.icon.style_class = `nublet-session-icon nublet-state-${s.state}`;
            if (pop && this._active) {
                row.icon.remove_all_transitions();
                row.icon.set({scale_x: 0.6, scale_y: 0.6});
                row.icon.ease({scale_x: 1, scale_y: 1, duration: 320, mode: Clutter.AnimationMode.EASE_OUT_BACK});
            }
        }
        const name = s.tileTitle ? `${s.tileTitle} · ${s.project}` : s.project;
        row.name.label = name;
        row.name.accessible_name = `Open terminal for ${name}`;
        row.status.text = statusText(s);

        const requestId = s.state === 'permission' ? s.request : null;
        if (requestId === row.requestId)
            return;
        row.request?.destroy();
        row.request = null;
        row.requestId = requestId;
        if (requestId) {
            row.request = this._requestBlock(row);
            row.actor.add_child(row.request);
        }
    }

    _requestBlock(row) {
        const block = new St.BoxLayout({style_class: 'nublet-request-block', orientation: Clutter.Orientation.VERTICAL});
        const request = new St.Label({text: `${row.session.tool}  ${row.session.detail}`, style_class: 'nublet-request'});
        request.clutter_text.line_wrap = true;
        request.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        block.add_child(request);

        const actions = new St.BoxLayout({style_class: 'nublet-actions'});
        for (const [label, answer, extraClass] of ACTIONS) {
            if (answer === 'always' && !row.session.canAlways)
                continue;
            const button = new St.Button({label, style_class: `nublet-action ${extraClass}`, can_focus: true});
            button.connect('clicked', () => this._answer(row.session, answer));
            actions.add_child(button);
        }
        block.add_child(actions);
        return block;
    }

    _answer(s, answer) {
        this._sessions.respond(s, answer);
        if (answer === 'terminal') {
            this._focus(s);
            return;
        }
        if (![...this._sessions.sessions.values()].some(other => other.request))
            this._host.close();
    }

    _focus(s) {
        if (!s)
            return;
        this._host.close();
        this._sessions.focus(s);
    }

    destroy() {
        if (this._expiryId) {
            GLib.source_remove(this._expiryId);
            this._expiryId = 0;
        }
        this._sessions.destroy();
        this._rows.clear();
        this.actor.destroy();
    }
}
