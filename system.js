import Gio from 'gi://Gio';
import Gvc from 'gi://Gvc';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {getMixerControl} from 'resource:///org/gnome/shell/ui/status/volume.js';

Gio._promisify(Gio.DBusProxy, 'new_for_bus');

const VOLUME_SECONDS = 1.5;
const HEADPHONES_SECONDS = 4;
const AUDIO_KINDS = new Set([17, 18, 19, 21]);
const SKIPPED_RECORDERS = new Set(['org.gnome.VolumeControl', 'org.PulseAudio.pavucontrol']);

function isVolumeIcon(icon) {
    return /audio-volume/.test(icon?.to_string?.() ?? '');
}

export class SystemActivities {
    constructor(host) {
        this._host = host;
        this._cancellable = new Gio.Cancellable();
        this._devices = new Map();

        this._interceptOsd();

        this._mixer = getMixerControl();
        this._mixer.connectObject(
            'stream-added', () => this._syncMicrophone(),
            'stream-removed', () => this._syncMicrophone(),
            'stream-changed', () => this._syncMicrophone(),
            'state-changed', () => this._syncMicrophone(),
            this);
        this._syncMicrophone();

        this._camera = new Shell.CameraMonitor();
        this._camera.connectObject('notify::cameras-in-use',
            () => host.setPrivacy('camera', this._camera.cameras_in_use), this);
        host.setPrivacy('camera', this._camera.cameras_in_use);

        this._watchUPower().catch(e => {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                logError(e, 'Nublet: UPower');
        });
    }

    _interceptOsd() {
        const manager = Main.osdWindowManager;
        const showAll = manager.showAll;
        const show = manager.show;
        manager.showAll = (icon, label, level, maxLevel) => {
            if (isVolumeIcon(icon) && typeof level === 'number')
                this._showVolume(icon, level, maxLevel);
            else
                showAll.call(manager, icon, label, level, maxLevel);
        };
        manager.show = (icon, label, levels) => {
            const first = Object.values(levels ?? {})[0];
            if (isVolumeIcon(icon) && typeof first?.level === 'number')
                this._showVolume(icon, first.level, first.maxLevel);
            else
                show.call(manager, icon, label, levels);
        };
    }

    _showVolume(icon, level, maxLevel) {
        const max = maxLevel > 1 ? maxLevel : 1;
        this._host.setActivity('volume', {
            priority: 80,
            icon: icon instanceof Gio.ThemedIcon ? icon.get_names()[0] : 'audio-volume-high-symbolic',
            text: `${Math.round(level * 100)}%`,
            level: level / max,
            key: 'volume',
            until: Date.now() + VOLUME_SECONDS * 1000,
        });
    }

    _syncMicrophone() {
        const recording = this._mixer.get_state() === Gvc.MixerControlState.READY &&
            this._mixer.get_sources().some(source => source.state === Gvc.MixerStreamState.RUNNING) &&
            this._mixer.get_source_outputs().some(output => !SKIPPED_RECORDERS.has(output.get_application_id()));
        this._host.setPrivacy('microphone', recording);
    }

    async _watchUPower() {
        this._upower = await Gio.DBusProxy.new_for_bus(Gio.BusType.SYSTEM, Gio.DBusProxyFlags.DO_NOT_LOAD_PROPERTIES,
            null, 'org.freedesktop.UPower', '/org/freedesktop/UPower', 'org.freedesktop.UPower', this._cancellable);
        this._upower.connect('g-signal', (proxy, sender, signal, params) => {
            const [path] = params.deepUnpack();
            if (signal === 'DeviceAdded')
                this._watchDevice(path).catch(e => {
                    if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        logError(e, 'Nublet: UPower device');
                });
            else if (signal === 'DeviceRemoved')
                this._forget(path);
        });
    }

    async _watchDevice(path) {
        const device = await Gio.DBusProxy.new_for_bus(Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null,
            'org.freedesktop.UPower', path, 'org.freedesktop.UPower.Device', this._cancellable);
        if (!AUDIO_KINDS.has(device.get_cached_property('Type')?.unpack())) {
            device.run_dispose();
            return;
        }
        this._forget(path);
        this._devices.set(path, device);
        if (!this._announce(device))
            device.connect('g-properties-changed', () => this._announce(device) && this._forget(path));
        else
            this._forget(path);
    }

    _announce(device) {
        const percentage = device.get_cached_property('Percentage')?.unpack() ?? 0;
        if (percentage <= 0)
            return false;
        const model = device.get_cached_property('Model')?.unpack() || 'Headphones';
        this._host.setActivity('headphones', {
            priority: 70,
            icon: 'audio-headphones-symbolic',
            text: `${model} · ${Math.round(percentage)}%`,
            key: model,
            until: Date.now() + HEADPHONES_SECONDS * 1000,
        });
        return true;
    }

    _forget(path) {
        this._devices.get(path)?.run_dispose();
        this._devices.delete(path);
    }

    destroy() {
        this._cancellable.cancel();
        delete Main.osdWindowManager.showAll;
        delete Main.osdWindowManager.show;
        this._mixer.disconnectObject(this);
        this._camera.disconnectObject(this);
        this._camera.run_dispose();
        this._upower?.run_dispose();
        for (const path of [...this._devices.keys()])
            this._forget(path);
    }
}
