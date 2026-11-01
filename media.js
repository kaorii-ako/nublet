import Cairo from 'cairo';
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

// Cassette geometry, the dqnamo player scaled to 0.7 (aspect 1.58).
const W = 372, H = 236;
const LX = 32, LY = 22, LW = W - 64, LH = 157;
const BAY_X = W * 0.27, BAY_W = W * 0.46, BAY_H = 38, BAY_Y = H - 8 - BAY_H;

function rgb(hex) {
    return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
}

function roundRect(cr, x, y, w, h, r) {
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

function screw(cr, x, y) {
    const r = 6;
    const g = new Cairo.RadialGradient(x - r * 0.28, y - r * 0.4, 0, x, y, r);
    g.addColorStopRGB(0, ...rgb('#5f5f5c'));
    g.addColorStopRGB(0.48, ...rgb('#30302e'));
    g.addColorStopRGB(0.78, ...rgb('#171716'));
    cr.arc(x, y, r, 0, 2 * Math.PI);
    cr.setSource(g);
    cr.fillPreserve();
    cr.setSourceRGB(...rgb('#060606'));
    cr.setLineWidth(1);
    cr.stroke();
    cr.setSourceRGB(...rgb('#1d1d1b'));
    cr.setLineWidth(1.7);
    for (const a of [Math.PI / 4, -Math.PI / 4]) {
        const dx = Math.cos(a) * r * 0.64, dy = Math.sin(a) * r * 0.64;
        cr.moveTo(x - dx, y - dy);
        cr.lineTo(x + dx, y + dy);
        cr.stroke();
    }
}

// Reel hub in a 100-unit box, as in the original SVG: white disc, six teeth, dark rim.
function reel(cr, x, y, radius, angle) {
    cr.save();
    cr.translate(x, y);
    cr.scale(radius / 50, radius / 50);
    cr.rotate(angle);
    cr.arc(0, 0, 48, 0, 2 * Math.PI);
    cr.setSourceRGB(...rgb('#fcfcfc'));
    cr.fill();
    cr.setSourceRGB(...rgb('#1b1a18'));
    for (let i = 0; i < 6; i++) {
        cr.save();
        cr.rotate(i * Math.PI / 3);
        roundRect(cr, -4, -47, 8, 11, 2);
        cr.fill();
        cr.restore();
    }
    cr.setLineWidth(3);
    cr.arc(0, 0, 48, 0, 2 * Math.PI);
    cr.stroke();
    cr.restore();
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

    // A copy of dqnamo's Cassette Player: cairo draws the shell, label, reels and tape; St overlays text and controls.
    _buildActor() {
        this.actor = new St.BoxLayout({style_class: 'nublet-media', vertical: true, x_expand: true});
        const tape = new St.Widget({layout_manager: new Clutter.FixedLayout(), width: W, height: H, x_align: Clutter.ActorAlign.CENTER});
        this._drawing = new St.DrawingArea({width: W, height: H});
        this._drawing.connect('repaint', area => this._paint(area));
        tape.add_child(this._drawing);
        const place = (actor, x, y) => {
            actor.set_position(Math.round(x), Math.round(y));
            tape.add_child(actor);
            return actor;
        };
        const ellipsized = (style, width) => {
            const label = new St.Label({style_class: style, width});
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            return label;
        };

        this._artist = place(ellipsized('nublet-tape-kicker', LW - 110), LX + 13, LY + 13);
        this._title = place(ellipsized('nublet-tape-title', LW - 100), LX + 13, LY + 25);
        this._title.text = 'Nothing playing';
        const side = new St.BoxLayout({vertical: true, width: 90, style_class: 'nublet-tape-side'});
        side.add_child(new St.Label({style_class: 'nublet-tape-badge', text: 'SIDE A', x_align: Clutter.ActorAlign.END}));
        this._source = new St.Label({style_class: 'nublet-tape-serial', x_align: Clutter.ActorAlign.END});
        side.add_child(this._source);
        place(side, LX + LW - 13 - 90, LY + 11);

        this._track = place(new St.Widget({reactive: true, width: LW - 26, height: 20, accessible_name: 'Seek'}), LX + 13, LY + 108);
        this._track.add_child(new St.Widget({style_class: 'nublet-tape-rail', width: LW - 26, height: 3, y: 9}));
        this._fill = new St.Widget({style_class: 'nublet-tape-fill', height: 3, y: 9});
        this._thumb = new St.Widget({style_class: 'nublet-tape-thumb', width: 13, height: 13, y: 4});
        this._track.add_child(this._fill);
        this._track.add_child(this._thumb);
        this._track.connect('button-press-event', (actor, event) => this._seekTo(event));
        const times = place(new St.BoxLayout({width: LW - 26}), LX + 13, LY + 129);
        this._elapsed = new St.Label({style_class: 'nublet-tape-time', x_expand: true});
        this._length = new St.Label({style_class: 'nublet-tape-time'});
        times.add_child(this._elapsed);
        times.add_child(this._length);

        this._prev = this._controlButton('media-skip-backward-symbolic', 'Previous', 'Previous');
        this._playPause = this._controlButton('media-playback-start-symbolic', 'Play or pause', 'PlayPause');
        this._next = this._controlButton('media-skip-forward-symbolic', 'Next', 'Next');
        this._playPause.add_style_class_name('nublet-tape-play');
        place(this._prev, 143 - 12, BAY_Y + 19 - 12);
        place(this._playPause, W / 2 - 15, BAY_Y + 19 - 15);
        place(this._next, W - 143 - 12, BAY_Y + 19 - 12);

        this._line = new St.Label({style_class: 'nublet-media-lyric', visible: false, x_align: Clutter.ActorAlign.CENTER});
        this._line.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this.actor.add_child(tape);
        this.actor.add_child(this._line);

        this._spin = new Clutter.Timeline({actor: this.actor, duration: 1000, repeat_count: -1});
        this._spin.connect('new-frame', () => this._drawing.queue_repaint());
    }

    _paint(area) {
        const cr = area.get_context();
        const player = this._player;
        const length = (unpack(player?.metadata['mpris:length']) ?? 0) / 1e6;
        const now = this._now(player);
        const progress = length > 0 ? Math.min(1, Math.max(0, now / length)) : 0;
        const angle = St.Settings.get().enable_animations ? (now * 300 % 360) * Math.PI / 180 : 0;

        // Shell: dark plastic, 165deg gradient, hairline inner frame.
        let g = new Cairo.LinearGradient(0, 0, W * 0.27, H);
        g.addColorStopRGB(0, ...rgb('#373735'));
        g.addColorStopRGB(0.52, ...rgb('#20201f'));
        g.addColorStopRGB(1, ...rgb('#0e0e0d'));
        roundRect(cr, 0.5, 0.5, W - 1, H - 1, 13);
        cr.setSource(g);
        cr.fillPreserve();
        cr.setSourceRGB(...rgb('#050505'));
        cr.setLineWidth(1);
        cr.stroke();
        roundRect(cr, 1.5, 1.5, W - 3, H - 3, 12);
        g = new Cairo.LinearGradient(0, 0, 0, 6);
        g.addColorStopRGBA(0, 1, 1, 1, 0.2);
        g.addColorStopRGBA(1, 1, 1, 1, 0);
        cr.setSource(g);
        cr.stroke();
        roundRect(cr, 4.5, 4.5, W - 9, H - 9, 9);
        cr.setSourceRGBA(1, 1, 1, 0.12);
        cr.stroke();

        for (const [x, y] of [[15.5, 15.5], [W - 15.5, 15.5], [15.5, H - 15.5], [W - 15.5, H - 15.5]])
            screw(cr, x, y);

        // Label with the three colour stripes behind the reel window.
        roundRect(cr, LX, LY, LW, LH, 9);
        cr.setSourceRGB(...rgb('#fcfcfc'));
        cr.fill();
        cr.save();
        roundRect(cr, LX, LY, LW, LH, 9);
        cr.clip();
        ['#22c55e', '#14b8a6', '#3b82f6'].forEach((color, i) => {
            cr.setSourceRGB(...rgb(color));
            cr.rectangle(LX, LY + 61 + i * 10, LW, 7);
            cr.fill();
        });
        cr.restore();

        // Reel window capsule.
        const cx = LX + LW * 0.175, cw = LW * 0.65, cy = LY + 52, ch = 46;
        roundRect(cr, cx - 3, cy - 3, cw + 6, ch + 6, (ch + 6) / 2);
        cr.setSourceRGB(...rgb('#fcfcfc'));
        cr.fill();
        roundRect(cr, cx, cy, cw, ch, ch / 2);
        cr.setSourceRGB(...rgb('#1b1a18'));
        cr.fillPreserve();
        g = new Cairo.LinearGradient(0, cy, 0, cy + ch);
        g.addColorStopRGBA(0, 1, 1, 1, 0.13);
        g.addColorStopRGBA(0.45, 1, 1, 1, 0);
        cr.setSource(g);
        cr.fill();

        // Tape window: spools grow and shrink with progress, five guide lines on top.
        const tx = cx + cw * 0.28, tw = cw * 0.44, ty = cy + ch * 0.12, th = ch * 0.76;
        const leftReel = cx + ch / 2, rightReel = cx + cw - ch / 2, mid = cy + ch / 2;
        cr.save();
        roundRect(cr, tx, ty, tw, th, 3);
        cr.setSourceRGB(...rgb('#393631'));
        cr.fillPreserve();
        cr.clip();
        for (const [x, scale] of [[leftReel, 1 - progress * 0.4], [rightReel, 0.6 + progress * 0.4]]) {
            const r = th * 1.8 * scale;
            cr.arc(x, mid, r, 0, 2 * Math.PI);
            cr.setSourceRGB(...rgb('#0d0d0d'));
            cr.fill();
            cr.setSourceRGB(...rgb('#171717'));
            cr.setLineWidth(1);
            for (let ring = r - 2; ring > 4; ring -= 4) {
                cr.arc(x, mid, ring, 0, 2 * Math.PI);
                cr.stroke();
            }
        }
        cr.setSourceRGBA(224 / 255, 215 / 255, 195 / 255, 0.28);
        for (let i = 1; i <= 5; i++)
            cr.rectangle(tx + tw * i / 6 - 1, mid - th * 0.21, 2, th * 0.42);
        cr.fill();
        g = new Cairo.LinearGradient(0, ty, 0, ty + th);
        g.addColorStopRGBA(0, 1, 1, 1, 0.1);
        g.addColorStopRGBA(0.42, 1, 1, 1, 0);
        cr.setSource(g);
        cr.paint();
        cr.restore();
        roundRect(cr, tx, ty, tw, th, 3);
        cr.setSourceRGB(...rgb('#11100f'));
        cr.setLineWidth(2);
        cr.stroke();

        for (const x of [leftReel, rightReel])
            reel(cr, x, mid, ch * 0.39, angle);

        // Control bay: the trapezoid notch under the label.
        cr.moveTo(BAY_X + BAY_W * 0.13, BAY_Y);
        cr.lineTo(BAY_X + BAY_W * 0.87, BAY_Y);
        cr.lineTo(BAY_X + BAY_W, BAY_Y + BAY_H);
        cr.lineTo(BAY_X, BAY_Y + BAY_H);
        cr.closePath();
        g = new Cairo.LinearGradient(0, BAY_Y, 0, BAY_Y + 10);
        g.addColorStopRGBA(0, 0, 0, 0, 0.5);
        g.addColorStopRGBA(1, 99 / 255, 99 / 255, 94 / 255, 0.2);
        cr.setSource(g);
        cr.fill();
        cr.$dispose();
    }

    _controlButton(iconName, label, method) {
        const button = new St.Button({
            style_class: 'nublet-tape-button',
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
        this._artist.text = artist.toUpperCase();
        this._source.text = player ? player.name.slice(PREFIX.length).split('.')[0].toUpperCase() : '';
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
        const x = Math.round((this._track.width - 13) * fraction);
        this._fill.width = x + 6;
        this._thumb.x = x;
        this._drawing.queue_repaint();
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
        if (run && St.Settings.get().enable_animations)
            this._spin.start();
        else
            this._spin.stop();
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
        this._spin.stop();
        this.actor.destroy();
    }
}
