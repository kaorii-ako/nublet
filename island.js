import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import GnomeDesktop from 'gi://GnomeDesktop';
import Graphene from 'gi://Graphene';
import Shell from 'gi://Shell';
import St from 'gi://St';
import Cairo from 'cairo';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {nextExpiry, pickActivity} from './activities.js';
import {easeOut, easeOutProperty} from './anim.js';
import {Spring, springParams} from './spring.js';
import {VIEWS} from './views.js';

const EAR = 10;
const PAD = 18;
const HOVER_GROW = {width: 16, height: 6};
const OPEN_WIDTH = 600;
const OPEN_MIN_HEIGHT = 90;
const OPEN_MAX_HEIGHT = 400;
const OPEN_RADIUS = 32;
const GEOMETRY = ['width', 'height', 'radius'];
const PRESS_SCALE = 0.97;
const PRESS = springParams(0.14, 1);
const BUMP = springParams(0.32, 0.55);
const BUMP_KICK = 1.5;
const BLUR = 4;
const LEVEL_WIDTH = 72;
const PRESETS = ['dev', 'life'];

function animationsEnabled() {
    return St.Settings.get().enable_animations;
}

function blurEffect() {
    return new Shell.BlurEffect({name: 'blur', mode: Shell.BlurMode.ACTOR, radius: 0, enabled: false});
}

function centered() {
    return {y_align: Clutter.ActorAlign.CENTER, pivot_point: new Graphene.Point({x: 0.5, y: 0.5})};
}

export const Island = GObject.registerClass(
class Island extends St.Widget {
    _init(settings, onCollapsedWidth, openPrefs) {
        super._init({
            name: 'nublet',
            style_class: 'nublet',
            reactive: true,
            clip_to_allocation: true,
            pivot_point: new Graphene.Point({x: 0.5, y: 0}),
        });

        this._settings = settings;
        this._onCollapsedWidth = onCollapsedWidth;
        this._openPrefs = openPrefs;
        this._state = 'collapsed';
        this._grab = null;
        this._collapsedWidth = 0;
        this._spacerWidth = 0;
        this._openHeight = OPEN_MIN_HEIGHT;
        this._compactSize = [0, 0];
        this._compactKey = null;
        this._expiryId = 0;
        this._springs = null;
        this._scale = new Spring(1, 0.0005);
        this._scaleParams = PRESS;
        this._activities = new Map();
        this._privacy = {microphone: false, camera: false};
        this._views = new Map();
        this._tabButtons = new Map();
        this._tab = null;

        this.host = {
            settings,
            setActivity: (id, activity) => this._setActivity(id, activity),
            setPrivacy: (kind, active) => this._setPrivacy(kind, active),
            relayout: () => this._retarget(),
            close: () => this._close(),
            isOpen: () => this._state === 'open',
        };

        this._body = new St.Button({
            style_class: 'nublet-body',
            track_hover: true,
            can_focus: false,
            accessible_name: 'Nublet',
        });
        this.add_child(this._body);

        this._ears = [0, 1].map(side => {
            const ear = new St.DrawingArea({width: EAR, height: EAR});
            ear.connect('repaint', area => {
                const cr = area.get_context();
                cr.setSourceRGBA(0, 0, 0, 1);
                cr.paint();
                cr.setOperator(Cairo.Operator.CLEAR);
                cr.arc(side ? EAR : 0, EAR, EAR, 0, 2 * Math.PI);
                cr.fill();
                cr.$dispose();
            });
            this.add_child(ear);
            return ear;
        });

        this._buildCompact();
        this._buildContent();

        this._timeline = new Clutter.Timeline({actor: this, duration: 1000, repeat_count: -1});
        this._timeline.connectObject('new-frame', () => this._tick(), this);

        this._clock = new GnomeDesktop.WallClock();
        this._clock.connectObject('notify::clock', () => this._syncCompact(), this);

        this._readSettings();
        this._settings.connectObject(
            'changed::motion-speed', () => this._readSettings(),
            'changed::motion-bounce', () => this._readSettings(),
            'changed::preset', () => this._syncViews(),
            'changed::dev-widgets', () => this._syncViews(),
            'changed::life-widgets', () => this._syncViews(),
            this);

        this._compact.connectObject('style-changed', () => this._syncCompact(), GObject.ConnectFlags.AFTER, this);
        this._body.connectObject(
            'notify::hover', () => {
                if (this._state !== 'open')
                    this._setState(this._body.hover ? 'hover' : 'collapsed');
            },
            'notify::pressed', () => {
                this._scale.target = this._body.pressed && this._state !== 'open' ? PRESS_SCALE : 1;
                this._scaleParams = PRESS;
                this._kick();
            },
            'clicked', () => this._open(),
            this);
        this.connectObject('captured-event', (actor, event) => this._onCapturedEvent(event), this);

        Main.overview.connectObject('showing', () => this._close(), this);
        Main.layoutManager.connectObject('monitors-changed', () => this._retarget(), this);
        Main.panel.connectObject('notify::height', () => this._retarget(), this);

        this.connect('destroy', () => this._onDestroy());
        this._syncViews();
    }

    _buildCompact() {
        this._compact = new St.BoxLayout({style_class: 'nublet-compact'});
        this._compactArt = new St.Icon({style_class: 'nublet-compact-art', visible: false, ...centered()});
        this._compactIcon = new St.Icon({visible: false, ...centered()});
        this._compactLabel = new St.Label({style_class: 'nublet-clock', ...centered()});
        this._compactLabel.add_effect(blurEffect());
        this._levelTrack = new St.Widget({style_class: 'nublet-level', visible: false, width: LEVEL_WIDTH, ...centered()});
        this._levelFill = new St.Widget({style_class: 'nublet-level-fill'});
        this._levelTrack.add_child(this._levelFill);
        this._compactBadge = new St.Label({style_class: 'nublet-badge', visible: false, ...centered()});
        this._bars = new St.BoxLayout({style_class: 'nublet-bars', visible: false, ...centered()});
        for (let i = 0; i < 4; i++)
            this._bars.add_child(new St.Widget({style_class: 'nublet-bar', pivot_point: new Graphene.Point({x: 0.5, y: 1})}));
        this._privacyDots = {
            microphone: new St.Widget({style_class: 'nublet-privacy nublet-privacy-mic', visible: false, ...centered()}),
            camera: new St.Widget({style_class: 'nublet-privacy nublet-privacy-camera', visible: false, ...centered()}),
        };
        for (const child of [this._compactArt, this._compactIcon, this._compactLabel, this._levelTrack,
            this._compactBadge, this._bars, this._privacyDots.microphone, this._privacyDots.camera])
            this._compact.add_child(child);
        this.add_child(this._compact);

        this._ghost = new St.Label({style_class: 'nublet-clock', visible: false});
        this._ghost.add_effect(blurEffect());
        this.add_child(this._ghost);
    }

    _buildContent() {
        this._content = new St.BoxLayout({
            style_class: 'nublet-content',
            vertical: true,
            opacity: 0,
            visible: false,
            pivot_point: new Graphene.Point({x: 0.5, y: 0}),
        });

        this._header = new St.BoxLayout({style_class: 'nublet-header'});
        this._presetBox = new St.BoxLayout({style_class: 'nublet-segmented', y_align: Clutter.ActorAlign.CENTER});
        this._presetButtons = PRESETS.map(preset => {
            const button = new St.Button({
                label: preset === 'dev' ? 'Dev' : 'Life',
                style_class: 'nublet-segment',
                toggle_mode: true,
                can_focus: true,
            });
            button.connect('clicked', () => this._settings.set_string('preset', preset));
            this._presetBox.add_child(button);
            return [preset, button];
        });
        this._tabs = new St.BoxLayout({style_class: 'nublet-tabs', x_expand: true, x_align: Clutter.ActorAlign.CENTER});
        const gear = new St.Button({
            style_class: 'nublet-icon-button',
            child: new St.Icon({icon_name: 'emblem-system-symbolic'}),
            can_focus: true,
            accessible_name: 'Nublet settings',
            y_align: Clutter.ActorAlign.CENTER,
        });
        gear.connect('clicked', () => {
            this._close();
            this._openPrefs();
        });
        this._header.add_child(this._presetBox);
        this._header.add_child(this._tabs);
        this._header.add_child(gear);

        this._stack = new St.BoxLayout({vertical: true, x_expand: true});
        this._scroll = new St.ScrollView({
            style_class: 'nublet-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            child: this._stack,
            x_expand: true,
            y_expand: true,
        });
        this._content.add_child(this._header);
        this._content.add_child(this._scroll);
        this.add_child(this._content);
    }

    _readSettings() {
        const speed = this._settings.get_int('motion-speed') / 100;
        const bounce = this._settings.get_int('motion-bounce') / 100;
        this._params = {
            open: springParams(0.32 / speed, 1 - bounce),
            hover: springParams(0.25 / speed, 1),
            close: springParams(0.28 / speed, 1),
        };
        this._retarget();
    }

    _presetWidgets() {
        const preset = this._settings.get_string('preset');
        const ids = this._settings.get_strv(`${PRESETS.includes(preset) ? preset : 'dev'}-widgets`);
        return ids.filter(id => VIEWS[id]);
    }

    _syncViews() {
        const wanted = this._presetWidgets();
        for (const [id, view] of this._views) {
            if (wanted.includes(id))
                continue;
            this._activities.delete(id);
            view.destroy();
            this._views.delete(id);
        }

        this._tabs.destroy_all_children();
        this._tabButtons.clear();
        for (const id of wanted) {
            let view = this._views.get(id);
            if (!view) {
                try {
                    view = new VIEWS[id](this.host);
                } catch (e) {
                    logError(e, `Nublet: creating ${id}`);
                    continue;
                }
                view.actor.visible = false;
                this._stack.add_child(view.actor);
                this._views.set(id, view);
            }
            const button = new St.Button({
                style_class: 'nublet-tab',
                child: new St.Icon({icon_name: view.icon}),
                toggle_mode: true,
                can_focus: true,
                accessible_name: view.title,
            });
            button.connect('clicked', () => this._selectTab(id));
            this._tabs.add_child(button);
            this._tabButtons.set(id, button);
        }

        const preset = this._settings.get_string('preset');
        for (const [name, button] of this._presetButtons)
            button.checked = name === preset;

        this._selectTab(this._views.has(this._tab) ? this._tab : wanted.find(id => this._views.has(id)) ?? null, false);
        this._syncCompact();
    }

    _selectTab(id, animate = true) {
        const previous = this._tab;
        const ids = [...this._views.keys()];
        this._tab = id;
        for (const [viewId, view] of this._views) {
            const selected = viewId === id;
            view.actor.visible = selected;
            this._tabButtons.get(viewId).checked = selected;
            view.setActive(selected && this._state === 'open');
        }
        const view = this._views.get(id);
        if (view && animate && previous !== id && animationsEnabled()) {
            const direction = ids.indexOf(id) > ids.indexOf(previous) ? 1 : -1;
            view.actor.remove_all_transitions();
            view.actor.set({opacity: 0, translation_x: 10 * direction});
            easeOut(view.actor, {opacity: 255, translation_x: 0, duration: 180});
        }
        this._retarget();
    }

    _setActivity(id, activity) {
        if (activity)
            this._activities.set(id, {...activity, id});
        else
            this._activities.delete(id);
        this._syncCompact();
    }

    _setPrivacy(kind, active) {
        this._privacy[kind] = active;
        this._syncCompact();
    }

    _syncCompact() {
        if (!this._compact.get_stage())
            return;

        const now = Date.now();
        const activity = pickActivity(this._activities, now);
        const previousText = this._compactLabel.text;
        this._compactLabel.text = activity?.text ?? this._clock.clock;

        const key = activity && activity.text !== undefined ? `${activity.id}:${activity.key ?? ''}` : 'clock';
        if (this._compactKey !== null && key !== this._compactKey) {
            this._crossfade(previousText);
            this._entrance(activity);
        }
        this._compactKey = key;

        this._compactArt.visible = !!activity?.gicon;
        if (activity?.gicon && this._compactArt.gicon !== activity.gicon)
            this._compactArt.gicon = activity.gicon;

        this._compactIcon.visible = !!activity?.icon && !activity?.gicon;
        if (this._compactIcon.visible) {
            this._compactIcon.icon_name = activity.icon;
            this._compactIcon.style_class = `nublet-compact-icon ${activity.iconClass ?? ''}`;
        }

        const hasLevel = typeof activity?.level === 'number';
        this._levelTrack.visible = hasLevel;
        if (hasLevel)
            this._levelFill.set_size(Math.round(LEVEL_WIDTH * Math.min(1, Math.max(0, activity.level))), 4);

        this._compactBadge.visible = !!activity?.badge;
        this._compactBadge.text = activity?.badge ?? '';
        this._syncBars(!!activity?.bars);

        for (const [kind, dot] of Object.entries(this._privacyDots))
            dot.visible = this._privacy[kind];

        this._scheduleExpiry(now);

        const [, width] = this._compact.get_preferred_width(-1);
        const [, height] = this._compact.get_preferred_height(width);
        this._compactSize = [width, height];
        this._collapsedWidth = Math.ceil(width + 2 * PAD);
        this._retarget();
    }

    _entrance(activity) {
        if (!activity || !animationsEnabled())
            return;
        if (activity.bump) {
            this._scale.velocity += BUMP_KICK;
            this._scaleParams = BUMP;
            this._kick();
        }
        if (activity.pop) {
            const icon = this._compactIcon;
            icon.remove_all_transitions();
            icon.set({scale_x: 0.6, scale_y: 0.6});
            icon.ease({scale_x: 1, scale_y: 1, duration: 320, mode: Clutter.AnimationMode.EASE_OUT_BACK});
        }
    }

    _syncBars(playing) {
        const animate = playing && animationsEnabled();
        if (this._bars.visible === playing && this._barsAnimated === animate)
            return;
        this._bars.visible = playing;
        this._barsAnimated = animate;
        [...this._bars].forEach((bar, i) => {
            bar.remove_all_transitions();
            bar.scale_y = 1;
            if (animate) {
                bar.ease({
                    scale_y: 0.25,
                    duration: 380 + i * 110,
                    repeatCount: -1,
                    autoReverse: true,
                    mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                });
            }
        });
    }

    _crossfade(previousText) {
        if (!animationsEnabled() || previousText === this._compactLabel.text)
            return;
        const ghost = this._ghost;
        ghost.remove_all_transitions();
        ghost.text = previousText;
        ghost.set_position(this._compact.x + this._compactLabel.x, this._compact.y + this._compactLabel.y);
        ghost.opacity = 255;
        ghost.show();
        const ghostBlur = ghost.get_effect('blur');
        ghostBlur.radius = 0;
        ghostBlur.enabled = true;
        easeOut(ghost, {
            opacity: 0,
            duration: 90,
            onStopped: () => {
                ghost.hide();
                ghostBlur.enabled = false;
            },
        });
        easeOutProperty(ghost, '@effects.blur.radius', BLUR, {duration: 90});

        const label = this._compactLabel;
        const labelBlur = label.get_effect('blur');
        label.remove_all_transitions();
        label.set({opacity: 0, scale_x: 0.96, scale_y: 0.96});
        labelBlur.radius = BLUR;
        labelBlur.enabled = true;
        easeOut(label, {
            opacity: 255,
            scale_x: 1,
            scale_y: 1,
            duration: 200,
            delay: 30,
            onStopped: () => {
                labelBlur.enabled = false;
            },
        });
        easeOutProperty(label, '@effects.blur.radius', 0, {duration: 200, delay: 30});
    }

    _scheduleExpiry(now) {
        if (this._expiryId) {
            GLib.source_remove(this._expiryId);
            this._expiryId = 0;
        }
        const next = nextExpiry(this._activities, now);
        if (next === null)
            return;
        this._expiryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, next - now + 20, () => {
            this._expiryId = 0;
            this._syncCompact();
            return GLib.SOURCE_REMOVE;
        });
    }

    _measureOpenHeight() {
        const top = this._panelHeight() + 6;
        const width = OPEN_WIDTH - 2 * PAD;
        const [, headerHeight] = this._header.get_preferred_height(width);
        const view = this._views.get(this._tab);
        const [, viewHeight] = view ? view.actor.get_preferred_height(width) : [0, 0];
        const spacing = this._content.get_theme_node().get_length('spacing');
        this._openHeight = Math.min(OPEN_MAX_HEIGHT,
            Math.max(OPEN_MIN_HEIGHT, Math.ceil(top + headerHeight + spacing + viewHeight + PAD)));
        return this._openHeight;
    }

    _panelHeight() {
        return Main.panel.height || 32;
    }

    _target() {
        const h = this._panelHeight();
        if (this._state === 'open')
            return {width: OPEN_WIDTH, height: this._measureOpenHeight(), radius: OPEN_RADIUS};
        if (this._state === 'hover') {
            const height = h + HOVER_GROW.height;
            return {width: this._collapsedWidth + HOVER_GROW.width, height, radius: height / 2};
        }
        return {width: this._collapsedWidth, height: h, radius: h / 2};
    }

    _setState(state) {
        const wasOpen = this._state === 'open';
        this._state = state;
        if (state === 'open' && !wasOpen)
            this._revealContent();
        else if (state !== 'open' && wasOpen)
            this._hideContent();
        this._views.get(this._tab)?.setActive(state === 'open');
        this._retarget();
    }

    _revealContent() {
        const top = pickActivity(this._activities, Date.now());
        if (top && this._views.has(top.id) && top.id !== this._tab)
            this._selectTab(top.id, false);

        const content = this._content;
        content.remove_all_transitions();
        content.set({opacity: 0, translation_y: -6, scale_x: 0.98, scale_y: 0.98});
        content.show();
        easeOut(content, {opacity: 255, translation_y: 0, scale_x: 1, scale_y: 1, duration: 200, delay: 60});
        this._views.get(this._tab)?.reveal?.();
    }

    _hideContent() {
        const content = this._content;
        content.remove_all_transitions();
        easeOut(content, {
            opacity: 0,
            duration: 90,
            onStopped: () => {
                if (this._state !== 'open')
                    content.hide();
            },
        });
    }

    _retarget() {
        if (!this._collapsedWidth || !this._params)
            return;

        const target = this._target();
        if (!this._springs) {
            this._springs = Object.fromEntries(GEOMETRY.map(k => [k, new Spring(target[k])]));
            this._springs.spacer = new Spring(this._collapsedWidth);
            this._apply();
            return;
        }

        for (const k of GEOMETRY)
            this._springs[k].target = target[k];
        this._springs.spacer.target = this._collapsedWidth;
        this._geometryParams = this._params[this._state === 'open' ? 'open' : this._state === 'hover' ? 'hover' : 'close'];
        this._kick();
    }

    _kick() {
        if (!this._springs)
            return;
        if (!animationsEnabled()) {
            this._timeline.stop();
            this._snapAll();
            this._apply();
            return;
        }
        if (!this._timeline.is_playing())
            this._timeline.start();
    }

    _snapAll() {
        for (const spring of Object.values(this._springs))
            spring.snap();
        this._scale.snap();
    }

    _tick() {
        const dt = this._timeline.get_delta() / 1000;
        for (const k of GEOMETRY)
            this._springs[k].step(dt, this._geometryParams ?? this._params.close);
        this._springs.spacer.step(dt, this._params.close);
        this._scale.step(dt, this._scaleParams);

        if (Object.values(this._springs).every(s => s.settled) && this._scale.settled) {
            this._snapAll();
            this._timeline.stop();
        }
        this._apply();
    }

    _apply() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        const w = Math.max(1, Math.round(this._springs.width.value));
        const h = Math.max(1, Math.round(this._springs.height.value));
        const r = Math.max(0, Math.round(this._springs.radius.value));

        this.set_position(monitor.x + Math.round((monitor.width - w) / 2) - EAR, monitor.y);
        this.set_size(w + 2 * EAR, h);
        this.set_scale(this._scale.value, this._scale.value);
        this._body.set_position(EAR, 0);
        this._body.set_size(w, h);
        this._body.set_style(`border-radius: 0 0 ${r}px ${r}px;`);
        this._ears[0].set_position(0, 0);
        this._ears[1].set_position(EAR + w, 0);

        const [cw, ch] = this._compactSize;
        const band = Math.min(h, this._panelHeight() + HOVER_GROW.height);
        this._compact.set_position(EAR + Math.round((w - cw) / 2), Math.round((band - ch) / 2));

        const top = this._panelHeight() + 6;
        this._content.set_position(EAR + Math.round((w - OPEN_WIDTH) / 2) + PAD, top);
        this._content.set_size(OPEN_WIDTH - 2 * PAD, this._openHeight - top - PAD);

        const spacer = Math.round(this._springs.spacer.value);
        if (spacer !== this._spacerWidth) {
            this._spacerWidth = spacer;
            this._onCollapsedWidth(spacer + 2 * EAR);
        }
    }

    _open() {
        if (this._state === 'open')
            return;
        this._grab = Main.pushModal(this, {actionMode: Shell.ActionMode.POPUP});
        this._setState('open');
    }

    _close() {
        if (this._state !== 'open')
            return;
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        this._setState(this._body.hover ? 'hover' : 'collapsed');
    }

    _onCapturedEvent(event) {
        if (this._state !== 'open')
            return Clutter.EVENT_PROPAGATE;

        const type = event.type();
        if (type === Clutter.EventType.KEY_PRESS && event.get_key_symbol() === Clutter.KEY_Escape) {
            this._close();
            return Clutter.EVENT_STOP;
        }

        if (type === Clutter.EventType.BUTTON_PRESS || type === Clutter.EventType.TOUCH_BEGIN) {
            const [x, y] = event.get_coords();
            const [bx, by] = this._body.get_transformed_position();
            const [bw, bh] = this._body.get_transformed_size();
            if (x < bx || y < by || x >= bx + bw || y >= by + bh) {
                this._close();
                return Clutter.EVENT_STOP;
            }
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _onDestroy() {
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        if (this._expiryId) {
            GLib.source_remove(this._expiryId);
            this._expiryId = 0;
        }
        for (const view of this._views.values())
            view.destroy();
        this._views.clear();
        this._activities.clear();
        this._timeline.stop();
        this._timeline.disconnectObject(this);
        this._timeline = null;
        this._clock.disconnectObject(this);
        this._clock.run_dispose();
        this._clock = null;
        this._settings.disconnectObject(this);
        this._settings = null;
        Main.overview.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        Main.panel.disconnectObject(this);
        this._onCollapsedWidth = null;
        this._openPrefs = null;
    }
});
