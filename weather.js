import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const FORECAST_HOURS = 5;

export class WeatherView {
    static title = 'Weather';
    static icon = 'weather-few-clouds-symbolic';

    constructor(host) {
        this.title = WeatherView.title;
        this.icon = WeatherView.icon;
        this._host = host;
        this._client = Main.panel.statusArea.dateMenu?._weatherItem?._weatherClient ?? null;
        this.actor = new St.BoxLayout({style_class: 'nublet-card nublet-weather', vertical: true, x_expand: true});
        this._client?.connectObject('changed', () => this._render(), this);
        this._render();
    }

    _render() {
        this.actor.destroy_all_children();
        const client = this._client;
        if (!client?.available) {
            this._message('Install GNOME Weather to see the weather here.');
            return;
        }
        if (!client.hasLocation) {
            this._message('Pick a city in GNOME Weather.', 'Open Weather', () => {
                this._host.close();
                client.activateApp();
            });
            return;
        }
        const info = client.info;
        if (client.loading || !info?.is_valid()) {
            this._message(client.loading ? 'Loading weather…' : 'Weather is unavailable right now.');
            return;
        }

        const now = new St.BoxLayout({style_class: 'nublet-weather-now'});
        now.add_child(new St.Icon({icon_name: info.get_symbolic_icon_name(), style_class: 'nublet-weather-icon'}));
        const text = new St.BoxLayout({vertical: true, y_align: Clutter.ActorAlign.CENTER, x_expand: true});
        text.add_child(new St.Label({text: info.get_temp_summary(), style_class: 'nublet-weather-temp'}));
        text.add_child(new St.Label({text: `${info.get_weather_summary()} · ${info.get_location_name()}`, style_class: 'nublet-dim'}));
        now.add_child(text);
        this.actor.add_child(now);

        const hours = new St.BoxLayout({style_class: 'nublet-weather-hours', x_expand: true});
        const nowSeconds = GLib.get_real_time() / 1e6;
        for (const forecast of info.get_forecast_list()) {
            const [ok, timestamp] = forecast.get_value_update();
            if (!ok || timestamp < nowSeconds)
                continue;
            const hour = new St.BoxLayout({vertical: true, style_class: 'nublet-weather-hour', x_expand: true});
            hour.add_child(new St.Label({text: GLib.DateTime.new_from_unix_local(timestamp).format('%H:%M'), style_class: 'nublet-dim nublet-small', x_align: Clutter.ActorAlign.CENTER}));
            hour.add_child(new St.Icon({icon_name: forecast.get_symbolic_icon_name(), icon_size: 16, x_align: Clutter.ActorAlign.CENTER}));
            hour.add_child(new St.Label({text: forecast.get_temp_summary(), style_class: 'nublet-small', x_align: Clutter.ActorAlign.CENTER}));
            hours.add_child(hour);
            if (hours.get_n_children() >= FORECAST_HOURS)
                break;
        }
        if (hours.get_n_children())
            this.actor.add_child(hours);
        this._host.relayout();
    }

    _message(text, action, callback) {
        this.actor.add_child(new St.Label({text, style_class: 'nublet-empty'}));
        if (action) {
            const button = new St.Button({label: action, style_class: 'nublet-action', can_focus: true, x_align: Clutter.ActorAlign.START});
            button.connect('clicked', callback);
            this.actor.add_child(button);
        }
        this._host.relayout();
    }

    setActive(active) {
        if (active)
            this._client?.update();
    }

    destroy() {
        this._client?.disconnectObject(this);
        this.actor.destroy();
    }
}
