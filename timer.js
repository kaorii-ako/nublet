import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

const PRESETS = [1, 5, 15, 25, 45];
const DONE_SECONDS = 10;

function format(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(total / 3600), m = Math.floor(total / 60) % 60, s = total % 60;
    const mm = h ? String(m).padStart(2, '0') : m;
    return `${h ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

export class TimerView {
    static title = 'Timer';
    static icon = 'alarm-symbolic';

    constructor(host) {
        this.title = TimerView.title;
        this.icon = TimerView.icon;
        this._host = host;
        this._duration = 25 * 60 * 1000;
        this._remaining = this._duration;
        this._endsAt = 0;
        this._tickId = 0;

        this.actor = new St.BoxLayout({style_class: 'nublet-card nublet-timer', orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        this._display = new St.Label({style_class: 'nublet-timer-display', x_align: Clutter.ActorAlign.CENTER});
        const presets = new St.BoxLayout({style_class: 'nublet-actions', x_align: Clutter.ActorAlign.CENTER});
        for (const minutes of PRESETS) {
            const button = new St.Button({label: `${minutes}m`, style_class: 'nublet-action', can_focus: true});
            button.connect('clicked', () => this._set(minutes * 60 * 1000));
            presets.add_child(button);
        }
        const plus = new St.Button({label: '+1m', style_class: 'nublet-action', can_focus: true});
        plus.connect('clicked', () => this._add(60 * 1000));
        presets.add_child(plus);

        const controls = new St.BoxLayout({style_class: 'nublet-actions', x_align: Clutter.ActorAlign.CENTER});
        this._startButton = new St.Button({style_class: 'nublet-action nublet-allow', can_focus: true});
        this._startButton.connect('clicked', () => this._running() ? this._pause() : this._start());
        const reset = new St.Button({label: 'Reset', style_class: 'nublet-action', can_focus: true});
        reset.connect('clicked', () => this._set(this._duration));
        controls.add_child(this._startButton);
        controls.add_child(reset);

        this.actor.add_child(this._display);
        this.actor.add_child(presets);
        this.actor.add_child(controls);
        this._sync();
    }

    _running() {
        return this._endsAt > 0;
    }

    _left() {
        return this._running() ? this._endsAt - Date.now() : this._remaining;
    }

    _set(ms) {
        this._stopTicking();
        this._endsAt = 0;
        this._duration = ms;
        this._remaining = ms;
        this._sync();
    }

    _add(ms) {
        if (this._running())
            this._endsAt += ms;
        else
            this._remaining += ms;
        this._sync();
    }

    _start() {
        if (this._remaining <= 0)
            this._remaining = this._duration;
        this._endsAt = Date.now() + this._remaining;
        this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            if (this._left() <= 0) {
                this._finish();
                return GLib.SOURCE_REMOVE;
            }
            this._sync();
            return GLib.SOURCE_CONTINUE;
        });
        this._sync();
    }

    _pause() {
        this._remaining = this._left();
        this._endsAt = 0;
        this._stopTicking();
        this._sync();
    }

    _finish() {
        this._tickId = 0;
        this._endsAt = 0;
        this._remaining = 0;
        global.display.get_sound_player().play_from_theme('complete', 'Timer done', null);
        this._sync();
        this._host.setActivity('timer', {
            priority: 85,
            icon: 'alarm-symbolic',
            iconClass: 'nublet-state-done',
            text: 'Timer done',
            key: 'done',
            pop: true,
            until: Date.now() + DONE_SECONDS * 1000,
        });
    }

    _stopTicking() {
        if (this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }
    }

    _sync() {
        const left = this._left();
        this._display.text = format(left);
        this._startButton.label = this._running() ? 'Pause' : 'Start';
        if (this._running()) {
            this._host.setActivity('timer', {
                priority: 40,
                icon: 'alarm-symbolic',
                text: format(left),
                key: 'running',
            });
        } else if (this._remaining > 0) {
            this._host.setActivity('timer', null);
        }
    }

    setActive() {
    }

    destroy() {
        this._stopTicking();
        this._host.setActivity('timer', null);
        this.actor.destroy();
    }
}
