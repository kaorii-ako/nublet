import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import St from 'gi://St';

const LIMIT = 20;
const MAX_CHARS = 10000;
const SECRET_HINT = 'x-kde-passwordManagerHint';

export class ClipboardView {
    static title = 'Clipboard';
    static icon = 'edit-paste-symbolic';

    constructor(host) {
        this.title = ClipboardView.title;
        this.icon = ClipboardView.icon;
        this._host = host;
        this._items = [];
        this._clipboard = St.Clipboard.get_default();

        this.actor = new St.BoxLayout({style_class: 'nublet-session-list', vertical: true, x_expand: true});
        const header = new St.BoxLayout({style_class: 'nublet-section-head'});
        header.add_child(new St.Label({text: 'Kept in memory only, cleared on logout', style_class: 'nublet-dim nublet-small', x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
        const clear = new St.Button({label: 'Clear', style_class: 'nublet-action', can_focus: true});
        clear.connect('clicked', () => {
            this._items = [];
            this._render();
        });
        header.add_child(clear);
        this._list = new St.BoxLayout({vertical: true, style_class: 'nublet-session-list', x_expand: true});
        this.actor.add_child(header);
        this.actor.add_child(this._list);

        this._selection = global.display.get_selection();
        this._selection.connectObject('owner-changed', (selection, type) => {
            if (type === Meta.SelectionType.SELECTION_CLIPBOARD)
                this._capture();
        }, this);
        this._render();
    }

    _capture() {
        if (this._selection.get_mimetypes(Meta.SelectionType.SELECTION_CLIPBOARD).includes(SECRET_HINT))
            return;
        this._clipboard.get_text(St.ClipboardType.CLIPBOARD, (clipboard, text) => {
            if (!this._list || !text?.trim() || text.length > MAX_CHARS)
                return;
            this._items = [text, ...this._items.filter(item => item !== text)].slice(0, LIMIT);
            this._render();
        });
    }

    _render() {
        this._list.destroy_all_children();
        if (!this._items.length) {
            this._list.add_child(new St.Label({text: 'Copy something and it shows up here', style_class: 'nublet-empty'}));
        }
        for (const text of this._items) {
            const button = new St.Button({style_class: 'nublet-card nublet-clip', can_focus: true, x_expand: true,
                accessible_name: `Copy ${text.slice(0, 40)}`});
            const label = new St.Label({text: text.replace(/\s+/g, ' ').trim(), style_class: 'nublet-clip-text', x_expand: true});
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            button.set_child(label);
            button.connect('clicked', () => {
                this._clipboard.set_text(St.ClipboardType.CLIPBOARD, text);
                this._host.close();
            });
            this._list.add_child(button);
        }
        this._host.relayout();
    }

    setActive() {
    }

    destroy() {
        this._selection.disconnectObject(this);
        this._items = [];
        this.actor.destroy();
        this._list = null;
    }
}
