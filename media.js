import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Soup from 'gi://Soup';
import St from 'gi://St';

import {lineIndexAt, parseLrc} from './lyrics.js';

Gio._promisify(Gio.DBusProxy, 'new_for_bus');
Gio._promisify(Gio.DBusConnection.prototype, 'call');
Gio._promisify(Gio.DBusProxy.prototype, 'call');
Gio._promisify(Gio.File.prototype, 'query_info_async');
Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

const PREFIX = 'org.mpris.MediaPlayer2.';
const PLACEHOLDER = new Gio.ThemedIcon({name: 'audio-x-generic-symbolic'});
const MAX_ART_BYTES = 4 * 1024 * 1024;

function unpack(value) {
    return value ? value.deepUnpack() : null;
}

function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0)
        return '0:00';
    const s = Math.floor(seconds);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function isCancelled(e) {
    return e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

export class MediaView {
    static title = 'Media';
    static icon = 'audio-x-generic-symbolic';

    constructor(host) {
        this.title = MediaView.title;
        this.icon = MediaView.icon;
        this._host = host;
        this._players = new Map();
        this._player = null;
        this._active = false;
        this._progressId = 0;
        this._lyricsId = 0;
        this._lyrics = null;
        this._lyricsUrl = null;
        this._art = PLACEHOLDER;
        this._artUrl = null;
        this._cancellable = new Gio.Cancellable();
        this._soup = new Soup.Session({timeout: 10});

        this._buildActor();

        this._nameWatch = Gio.DBus.session.signal_subscribe('org.freedesktop.DBus', 'org.freedesktop.DBus',
            'NameOwnerChanged', '/org/freedesktop/DBus', 'org.mpris.MediaPlayer2',
            Gio.DBusSignalFlags.MATCH_ARG0_NAMESPACE, (conn, sender, path, iface, signal, params) => {
                const [name, , newOwner] = params.deepUnpack();
                if (newOwner)
                    this._addPlayer(name);
                else
                    this._removePlayer(name);
            });
        host.settings.connectObject(
            'changed::lyrics', () => this._loadLyrics(),
            'changed::preferred-player', () => this._choose(),
            this);
        this._listPlayers().catch(e => {
            if (!isCancelled(e))
                logError(e, 'Nublet: listing media players');
        });
    }

    _buildActor() {
        this.actor = new St.BoxLayout({style_class: 'nublet-card nublet-media', x_expand: true});
        this._artIcon = new St.Icon({style_class: 'nublet-media-art', gicon: PLACEHOLDER});
        const right = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, style_class: 'nublet-media-info'});
        this._title = new St.Label({style_class: 'nublet-media-title', text: 'Nothing playing'});
        this._title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._artist = new St.Label({style_class: 'nublet-dim'});
        this._artist.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._line = new St.Label({style_class: 'nublet-media-lyric', visible: false});
        this._line.clutter_text.ellipsize = Pango.EllipsizeMode.END;

        this._track = new St.Widget({style_class: 'nublet-progress', reactive: true, x_expand: true, accessible_name: 'Seek'});
        this._fill = new St.Widget({style_class: 'nublet-progress-fill'});
        this._track.add_child(this._fill);
        this._track.connect('button-press-event', (actor, event) => this._seekTo(event));
        this._track.connect('notify::width', () => this._syncProgress());
        const times = new St.BoxLayout({style_class: 'nublet-media-times'});
        this._elapsed = new St.Label({style_class: 'nublet-dim nublet-small', x_expand: true});
        this._length = new St.Label({style_class: 'nublet-dim nublet-small'});
        times.add_child(this._elapsed);
        times.add_child(this._length);

        const controls = new St.BoxLayout({style_class: 'nublet-media-controls', x_align: Clutter.ActorAlign.CENTER});
        this._prev = this._controlButton('media-skip-backward-symbolic', 'Previous', 'Previous');
        this._playPause = this._controlButton('media-playback-start-symbolic', 'Play or pause', 'PlayPause');
        this._next = this._controlButton('media-skip-forward-symbolic', 'Next', 'Next');
        this._playPause.add_style_class_name('nublet-media-play');
        for (const button of [this._prev, this._playPause, this._next])
            controls.add_child(button);

        for (const child of [this._title, this._artist, this._line, this._track, times, controls])
            right.add_child(child);
        this.actor.add_child(this._artIcon);
        this.actor.add_child(right);
    }

    _controlButton(iconName, label, method) {
        const button = new St.Button({
            style_class: 'nublet-icon-button',
            child: new St.Icon({icon_name: iconName}),
            can_focus: true,
            accessible_name: label,
        });
        button.connect('clicked', () => this._player?.proxy.call(method, null, Gio.DBusCallFlags.NONE, -1, null)
            .catch(e => logError(e, `Nublet: media ${method}`)));
        return button;
    }

    async _listPlayers() {
        const [names] = (await Gio.DBus.session.call('org.freedesktop.DBus', '/org/freedesktop/DBus',
            'org.freedesktop.DBus', 'ListNames', null, null, Gio.DBusCallFlags.NONE, -1, this._cancellable)).deepUnpack();
        for (const name of names.filter(n => n.startsWith(PREFIX)))
            this._addPlayer(name);
    }

    async _addPlayer(name) {
        if (this._players.has(name))
            return;
        const player = {name, proxy: null, status: 'Stopped', metadata: {}, position: 0, positionAt: 0, rate: 1, changed: Date.now()};
        this._players.set(name, player);
        try {
            player.proxy = await Gio.DBusProxy.new_for_bus(Gio.BusType.SESSION, Gio.DBusProxyFlags.NONE, null,
                name, '/org/mpris/MediaPlayer2', 'org.mpris.MediaPlayer2.Player', this._cancellable);
        } catch (e) {
            if (!isCancelled(e))
                logError(e, `Nublet: media player ${name}`);
            this._players.delete(name);
            return;
        }
        if (this._players.get(name) !== player)
            return;
        player.proxy.connect('g-properties-changed', () => this._readPlayer(player, true));
        player.proxy.connect('g-signal', (proxy, sender, signal, params) => {
            if (signal === 'Seeked') {
                [player.position] = params.deepUnpack();
                player.position /= 1e6;
                player.positionAt = GLib.get_monotonic_time();
                this._syncProgress();
                this._syncLyrics();
            }
        });
        this._readPlayer(player, true);
    }

    _removePlayer(name) {
        const player = this._players.get(name);
        if (!player)
            return;
        player.proxy?.run_dispose();
        this._players.delete(name);
        this._choose();
    }

    _readPlayer(player, refreshPosition) {
        const proxy = player.proxy;
        player.status = unpack(proxy.get_cached_property('PlaybackStatus')) ?? 'Stopped';
        player.metadata = unpack(proxy.get_cached_property('Metadata')) ?? {};
        player.rate = unpack(proxy.get_cached_property('Rate')) ?? 1;
        player.canSeek = unpack(proxy.get_cached_property('CanSeek')) ?? false;
        player.changed = Date.now();
        if (refreshPosition)
            this._refreshPosition(player);
        this._choose();
    }

    async _refreshPosition(player) {
        try {
            const result = await player.proxy.call('org.freedesktop.DBus.Properties.Get',
                new GLib.Variant('(ss)', ['org.mpris.MediaPlayer2.Player', 'Position']),
                Gio.DBusCallFlags.NONE, 1000, this._cancellable);
            const [position] = result.deepUnpack();
            player.position = position.deepUnpack() / 1e6;
            player.positionAt = GLib.get_monotonic_time();
            if (player === this._player) {
                this._syncProgress();
                this._syncLyrics();
            }
        } catch (e) {
            if (!isCancelled(e))
                player.position = 0;
        }
    }

    _choose() {
        const players = [...this._players.values()].filter(p => p.proxy);
        const playing = players.filter(p => p.status === 'Playing');
        const pool = playing.length ? playing : players;
        const preferred = this._host.settings.get_string('preferred-player').trim();
        const favourite = preferred ? pool.find(p => p.name.slice(PREFIX.length).startsWith(preferred)) : null;
        const chosen = favourite ?? pool.sort((a, b) => b.changed - a.changed)[0] ?? null;
        this._player = chosen;
        this._sync();
    }

    _now(player) {
        if (!player)
            return 0;
        if (player.status !== 'Playing')
            return player.position;
        return player.position + (GLib.get_monotonic_time() - player.positionAt) / 1e6 * player.rate;
    }

    _sync() {
        const player = this._player;
        const meta = player?.metadata ?? {};
        const title = unpack(meta['xesam:title']) || (player ? 'Unknown title' : 'Nothing playing');
        const artist = (unpack(meta['xesam:artist']) ?? []).join(', ');
        this._title.text = title;
        this._artist.text = artist;
        this._artist.visible = !!artist;
        const playing = player?.status === 'Playing';
        this._playPause.child.icon_name = playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        for (const button of [this._prev, this._playPause, this._next])
            button.reactive = !!player;

        this._loadArt(unpack(meta['mpris:artUrl']));
        this._loadLyrics();
        this._syncProgress();
        this._syncActivity();
        this._syncTimers();
        this._host.relayout();
    }

    _syncActivity() {
        const player = this._player;
        if (player?.status !== 'Playing') {
            this._host.setActivity('media', null);
            return;
        }
        const line = this._currentLine();
        const title = unpack(player.metadata['xesam:title']) || 'Playing';
        this._host.setActivity('media', {
            priority: 30,
            gicon: this._art,
            text: line ?? title,
            key: `${unpack(player.metadata['mpris:trackid']) ?? title}:${line ?? ''}`,
            bars: true,
        });
    }

    async _loadArt(url) {
        if (url === this._artUrl)
            return;
        this._artUrl = url;
        let icon = PLACEHOLDER;
        try {
            if (url?.startsWith('file://')) {
                const file = Gio.File.new_for_uri(url);
                const info = await file.query_info_async('access::can-read', Gio.FileQueryInfoFlags.NONE,
                    GLib.PRIORITY_DEFAULT, this._cancellable);
                if (info.get_attribute_boolean('access::can-read'))
                    icon = new Gio.FileIcon({file});
            } else if (url?.startsWith('https://') || url?.startsWith('http://')) {
                const message = Soup.Message.new('GET', url);
                const bytes = await this._soup.send_and_read_async(message, GLib.PRIORITY_DEFAULT, this._cancellable);
                if (message.get_status() === Soup.Status.OK && bytes.get_size() <= MAX_ART_BYTES)
                    icon = new Gio.BytesIcon({bytes});
            }
        } catch (e) {
            if (isCancelled(e))
                return;
        }
        if (url !== this._artUrl)
            return;
        this._art = icon;
        this._artIcon.gicon = icon;
        this._syncActivity();
    }

    async _loadLyrics() {
        const url = this._host.settings.get_boolean('lyrics')
            ? unpack(this._player?.metadata['xesam:url']) : null;
        if (url === this._lyricsUrl)
            return;
        this._lyricsUrl = url;
        this._lyrics = null;
        this._syncLyrics();
        if (!url?.startsWith('file://'))
            return;
        const lrc = Gio.File.new_for_uri(url.replace(/\.[^./]+$/, '.lrc'));
        try {
            const [bytes] = await lrc.load_contents_async(this._cancellable);
            if (url !== this._lyricsUrl)
                return;
            const lines = parseLrc(new TextDecoder().decode(bytes));
            this._lyrics = lines.length ? lines : null;
        } catch (e) {
            if (isCancelled(e))
                return;
            this._lyrics = null;
        }
        this._syncLyrics();
    }

    _currentLine() {
        if (!this._lyrics || !this._player)
            return null;
        const index = lineIndexAt(this._lyrics, this._now(this._player));
        return index >= 0 && this._lyrics[index].text ? this._lyrics[index].text : null;
    }

    _syncLyrics() {
        if (this._lyricsId) {
            GLib.source_remove(this._lyricsId);
            this._lyricsId = 0;
        }
        const line = this._currentLine();
        this._line.text = line ?? '';
        this._line.visible = !!line;
        this._syncActivity();

        const player = this._player;
        if (!this._lyrics || player?.status !== 'Playing')
            return;
        const index = lineIndexAt(this._lyrics, this._now(player));
        const next = this._lyrics[index + 1];
        if (!next)
            return;
        const wait = Math.max(50, (next.time - this._now(player)) * 1000 / (player.rate || 1));
        this._lyricsId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.ceil(wait), () => {
            this._lyricsId = 0;
            this._syncLyrics();
            return GLib.SOURCE_REMOVE;
        });
    }

    _syncProgress() {
        const player = this._player;
        const length = (unpack(player?.metadata['mpris:length']) ?? 0) / 1e6;
        const now = Math.min(this._now(player), length || Infinity);
        this._elapsed.text = formatTime(now);
        this._length.text = length ? formatTime(length) : '';
        const fraction = length > 0 ? Math.min(1, Math.max(0, now / length)) : 0;
        this._fill.set_size(Math.round(this._track.width * fraction), 4);
    }

    _seekTo(event) {
        const player = this._player;
        const length = unpack(player?.metadata['mpris:length']) ?? 0;
        const trackId = unpack(player?.metadata['mpris:trackid']);
        if (!player?.canSeek || !length || !trackId)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        const [ok, localX] = this._track.transform_stage_point(x, y);
        if (!ok || this._track.width <= 0)
            return Clutter.EVENT_PROPAGATE;
        const target = Math.round(length * Math.min(1, Math.max(0, localX / this._track.width)));
        player.proxy.call('SetPosition', new GLib.Variant('(ox)', [trackId, target]), Gio.DBusCallFlags.NONE, -1, null)
            .catch(e => logError(e, 'Nublet: media seek'));
        return Clutter.EVENT_STOP;
    }

    _syncTimers() {
        const run = this._active && this._player?.status === 'Playing';
        if (run && !this._progressId) {
            this._progressId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                this._syncProgress();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!run && this._progressId) {
            GLib.source_remove(this._progressId);
            this._progressId = 0;
        }
    }

    setActive(active) {
        this._active = active;
        if (active && this._player)
            this._refreshPosition(this._player);
        this._syncTimers();
    }

    destroy() {
        this._cancellable.cancel();
        Gio.DBus.session.signal_unsubscribe(this._nameWatch);
        this._host.settings.disconnectObject(this);
        for (const id of [this._progressId, this._lyricsId]) {
            if (id)
                GLib.source_remove(id);
        }
        this._progressId = this._lyricsId = 0;
        for (const player of this._players.values())
            player.proxy?.run_dispose();
        this._players.clear();
        this._soup.abort();
        this._host.setActivity('media', null);
        this.actor.destroy();
    }
}
