import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

const POLL_SECONDS = 300;
const NEW_SECONDS = 6;

export class FeedView {
    constructor(host) {
        this.title = this.constructor.title;
        this.icon = this.constructor.icon;
        this._host = host;
        this._cancellable = new Gio.Cancellable();
        this._known = null;
        this._items = [];
        this._message = 'Loading…';

        this.actor = new St.BoxLayout({style_class: 'nublet-session-list', vertical: true, x_expand: true});
        this._render();
        this._refresh();
        this._pollId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, POLL_SECONDS, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    async _refresh() {
        try {
            const result = await this.fetch(this._cancellable);
            if (this._cancellable.is_cancelled())
                return;
            if (typeof result === 'string') {
                this._items = [];
                this._message = result;
            } else {
                this._announce(result);
                this._items = result;
                this._message = result.length ? null : 'All caught up';
            }
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            this._message = `Couldn't load: ${e.message}`;
        }
        // Destroyed while the fetch was in flight.
        if (this._cancellable.is_cancelled())
            return;
        this._render();
    }

    _announce(items) {
        const ids = new Set(items.map(item => item.id));
        const fresh = this._known ? items.filter(item => !this._known.has(item.id)) : [];
        this._known = ids;
        if (!fresh.length)
            return;
        this._host.setActivity(this.constructor.id, {
            priority: 60,
            icon: this.icon,
            iconClass: 'nublet-state-feed',
            text: `${this.title} · ${fresh.length} new`,
            key: [...ids].join(),
            pop: true,
            until: Date.now() + NEW_SECONDS * 1000,
        });
    }

    _render() {
        this.actor.destroy_all_children();
        if (this._message)
            this.actor.add_child(new St.Label({text: this._message, style_class: 'nublet-empty'}));
        for (const item of this._items) {
            const button = new St.Button({style_class: 'nublet-card nublet-feed-item', can_focus: true, x_expand: true, accessible_name: item.title});
            const box = new St.BoxLayout({vertical: true, x_expand: true});
            const title = new St.Label({text: item.title, style_class: 'nublet-feed-title'});
            title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            const subtitle = new St.Label({text: item.subtitle, style_class: 'nublet-dim nublet-small'});
            subtitle.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            box.add_child(title);
            box.add_child(subtitle);
            button.set_child(box);
            button.connect('clicked', () => {
                this._host.close();
                Gio.AppInfo.launch_default_for_uri(item.uri, global.create_app_launch_context(0, -1));
            });
            this.actor.add_child(button);
        }
        this._host.relayout();
    }

    setActive(active) {
        if (active)
            this._refresh();
    }

    destroy() {
        this._cancellable.cancel();
        GLib.source_remove(this._pollId);
        this._host.setActivity(this.constructor.id, null);
        this.actor.destroy();
    }
}
