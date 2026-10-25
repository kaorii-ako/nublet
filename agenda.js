import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Calendar from 'resource:///org/gnome/shell/ui/calendar.js';

const DAYS = 2;

function startOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function timeLabel(event, dayStart) {
    const dayEnd = new Date(dayStart.getTime() + 86400000);
    if (event.date <= dayStart && event.end >= dayEnd)
        return 'All day';
    return GLib.DateTime.new_from_unix_local(Math.floor(event.date.getTime() / 1000)).format('%R');
}

export class AgendaView {
    static title = 'Calendar';
    static icon = 'x-office-calendar-symbolic';

    constructor(host) {
        this.title = AgendaView.title;
        this.icon = AgendaView.icon;
        this._host = host;
        this.actor = new St.BoxLayout({style_class: 'nublet-session-list', orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        this._source = new Calendar.DBusEventSource();
        this._source.connectObject(
            'changed', () => this._render(),
            'notify::has-calendars', () => this._render(),
            this);
        this._request();
        this._render();
    }

    _request() {
        const begin = startOfDay(new Date());
        this._range = [begin, new Date(begin.getTime() + DAYS * 86400000)];
        this._source.requestRange(...this._range);
    }

    _render() {
        this.actor.destroy_all_children();
        const [begin] = this._range;
        let any = false;
        for (let day = 0; day < DAYS; day++) {
            const dayStart = new Date(begin.getTime() + day * 86400000);
            const dayEnd = new Date(dayStart.getTime() + 86400000);
            const events = this._source.getEvents(dayStart, dayEnd);
            if (!events.length)
                continue;
            any = true;
            this.actor.add_child(new St.Label({text: day === 0 ? 'Today' : 'Tomorrow', style_class: 'nublet-section-title'}));
            for (const event of events) {
                const row = new St.BoxLayout({style_class: 'nublet-card nublet-event'});
                row.add_child(new St.Label({text: timeLabel(event, dayStart), style_class: 'nublet-event-time', y_align: Clutter.ActorAlign.CENTER}));
                const summary = new St.Label({text: event.summary || 'Untitled', style_class: 'nublet-event-summary', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
                summary.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                row.add_child(summary);
                this.actor.add_child(row);
            }
        }
        if (!any) {
            this.actor.add_child(new St.Label({
                text: this._source.hasCalendars
                    ? 'Nothing today or tomorrow'
                    : 'No calendars yet. Add an account in Settings, Online Accounts.',
                style_class: 'nublet-empty',
            }));
        }
        this._host.relayout();
    }

    setActive(active) {
        if (active)
            this._request();
    }

    destroy() {
        this._source.disconnectObject(this);
        this._source.destroy();
        this.actor.destroy();
    }
}
