import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {cpuPercent, formatGiB, formatRate, parseCpu, parseMem, parseNet} from './statsParse.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.File.prototype, 'query_info_async');

const CPU_SENSORS = new Set(['k10temp', 'zenpower', 'coretemp']);
const PCI_ADDRESS = /^[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-9a-f]$/;

async function readText(path, cancellable) {
    const [bytes] = await Gio.File.new_for_path(path).load_contents_async(cancellable);
    return new TextDecoder().decode(bytes);
}

async function readTemp(path, cancellable) {
    if (!path)
        return null;
    try {
        return Math.round(Number(await readText(path, cancellable)) / 1000);
    } catch (e) {
        if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            throw e;
        return null;
    }
}

async function listDir(path, cancellable) {
    const enumerator = await Gio.File.new_for_path(path).enumerate_children_async('standard::name',
        Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable);
    const names = [];
    for (;;) {
        const infos = await enumerator.next_files_async(32, GLib.PRIORITY_DEFAULT, cancellable);
        if (!infos.length)
            return names;
        names.push(...infos.map(info => info.get_name()));
    }
}

export class StatsView {
    static title = 'Stats';
    static icon = 'power-profile-performance-symbolic';

    constructor(host) {
        this.title = StatsView.title;
        this.icon = StatsView.icon;
        this._host = host;
        this._cancellable = new Gio.Cancellable();
        this._pollId = 0;
        this._sensors = null;
        this._previous = null;

        this.actor = new St.BoxLayout({style_class: 'nublet-grid', orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        this._tiles = {};
        for (const row of [['cpu', 'gpu', 'ram'], ['nvme', 'down', 'up']]) {
            const box = new St.BoxLayout({style_class: 'nublet-grid-row', x_expand: true});
            box.layout_manager.homogeneous = true;
            for (const id of row) {
                const tile = new St.BoxLayout({style_class: 'nublet-card nublet-tile', orientation: Clutter.Orientation.VERTICAL, x_expand: true});
                const label = new St.Label({style_class: 'nublet-dim nublet-small', text: {
                    cpu: 'CPU', gpu: 'GPU', ram: 'Memory', nvme: 'NVMe', down: 'Download', up: 'Upload',
                }[id]});
                const value = new St.Label({style_class: 'nublet-tile-value', text: '-'});
                const detail = new St.Label({style_class: 'nublet-dim nublet-small', text: ' '});
                tile.add_child(label);
                tile.add_child(value);
                tile.add_child(detail);
                box.add_child(tile);
                this._tiles[id] = {value, detail};
            }
            this.actor.add_child(box);
        }
    }

    async _findGpu() {
        const pinned = this._host.settings.get_string('gpu-pci').trim().toLowerCase();
        if (PCI_ADDRESS.test(pinned))
            return `/sys/bus/pci/devices/${pinned}`;
        let best = null, bestVram = -1;
        for (const card of await listDir('/sys/class/drm', this._cancellable)) {
            if (!/^card\d+$/.test(card))
                continue;
            const info = await Gio.File.new_for_path(`/sys/class/drm/${card}/device`).query_info_async(
                'standard::symlink-target', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_DEFAULT, this._cancellable)
                .catch(() => null);
            const address = GLib.path_get_basename(info?.get_symlink_target() ?? '');
            if (!PCI_ADDRESS.test(address))
                continue;
            const device = `/sys/bus/pci/devices/${address}`;
            const vram = Number(await readText(`${device}/mem_info_vram_total`, this._cancellable).catch(() => '0'));
            if (vram > bestVram) {
                best = device;
                bestVram = vram;
            }
        }
        return best;
    }

    async _findSensors() {
        const sensors = {cpu: null, nvme: null, gpu: null, gpuDevice: await this._findGpu()};
        for (const dir of await listDir('/sys/class/hwmon', this._cancellable)) {
            const base = `/sys/class/hwmon/${dir}`;
            const name = (await readText(`${base}/name`, this._cancellable).catch(() => '')).trim();
            if (CPU_SENSORS.has(name) && !sensors.cpu)
                sensors.cpu = `${base}/temp1_input`;
            else if (name === 'nvme' && !sensors.nvme)
                sensors.nvme = `${base}/temp1_input`;
        }
        if (sensors.gpuDevice) {
            const gpuHwmon = (await listDir(`${sensors.gpuDevice}/hwmon`, this._cancellable).catch(() => []))[0];
            if (gpuHwmon)
                sensors.gpu = `${sensors.gpuDevice}/hwmon/${gpuHwmon}/temp1_input`;
        }
        return sensors;
    }

    async _poll() {
        this._sensors ??= await this._findSensors();
        const c = this._cancellable;
        const [stat, meminfo, netDev, gpuBusy, cpuTemp, gpuTemp, nvmeTemp] = await Promise.all([
            readText('/proc/stat', c),
            readText('/proc/meminfo', c),
            readText('/proc/net/dev', c),
            this._sensors.gpuDevice ? readText(`${this._sensors.gpuDevice}/gpu_busy_percent`, c).catch(() => null) : null,
            readTemp(this._sensors.cpu, c),
            readTemp(this._sensors.gpu, c),
            readTemp(this._sensors.nvme, c),
        ]);
        const now = GLib.get_monotonic_time();
        const sample = {cpu: parseCpu(stat), net: parseNet(netDev), at: now};
        const previous = this._previous;
        this._previous = sample;

        const t = this._tiles;
        const degrees = value => value === null ? '' : `${value}°C`;
        if (previous) {
            t.cpu.value.text = `${cpuPercent(previous.cpu, sample.cpu)}%`;
            const seconds = (now - previous.at) / 1e6;
            t.down.value.text = formatRate(Math.max(0, sample.net.rx - previous.net.rx) / seconds);
            t.up.value.text = formatRate(Math.max(0, sample.net.tx - previous.net.tx) / seconds);
        }
        t.cpu.detail.text = degrees(cpuTemp) || ' ';
        t.gpu.value.text = gpuBusy === null ? '-' : `${Number(gpuBusy)}%`;
        t.gpu.detail.text = degrees(gpuTemp) || ' ';
        const mem = parseMem(meminfo);
        t.ram.value.text = `${formatGiB(mem.used)} GiB`;
        t.ram.detail.text = `of ${formatGiB(mem.total)} GiB`;
        t.nvme.value.text = degrees(nvmeTemp) || '-';
        t.nvme.detail.text = 'Composite';
    }

    _tick() {
        this._poll().catch(e => {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                logError(e, 'Nublet: stats');
        });
    }

    setActive(active) {
        if (active && !this._pollId) {
            this._tick();
            this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
                this._tick();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!active && this._pollId) {
            GLib.source_remove(this._pollId);
            this._pollId = 0;
        }
    }

    destroy() {
        this.setActive(false);
        this._cancellable.cancel();
        this.actor.destroy();
    }
}
