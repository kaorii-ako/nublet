const VIRTUAL_IFACE = /^(lo|virbr|docker|veth|br-|tun|tap|wg)/;

export function parseCpu(procStat) {
    const fields = procStat.split('\n', 1)[0].trim().split(/\s+/).slice(1).map(Number);
    const idle = fields[3] + (fields[4] || 0);
    const total = fields.slice(0, 8).reduce((a, b) => a + b, 0);
    return {idle, total};
}

export function cpuPercent(previous, current) {
    const total = current.total - previous.total;
    return total > 0 ? Math.round(100 * (1 - (current.idle - previous.idle) / total)) : 0;
}

export function parseMem(meminfo) {
    const value = key => Number(meminfo.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'))?.[1] ?? 0) * 1024;
    const total = value('MemTotal');
    return {total, used: total - value('MemAvailable')};
}

export function parseNet(netDev) {
    let rx = 0, tx = 0;
    for (const line of netDev.split('\n').slice(2)) {
        const [iface, rest] = line.split(':');
        if (!rest || VIRTUAL_IFACE.test(iface.trim()))
            continue;
        const fields = rest.trim().split(/\s+/).map(Number);
        rx += fields[0];
        tx += fields[8];
    }
    return {rx, tx};
}

export function formatRate(bytesPerSecond) {
    const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
    let value = bytesPerSecond, unit = 0;
    while (value >= 1000 && unit < units.length - 1) {
        value /= 1000;
        unit++;
    }
    return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function formatGiB(bytes) {
    return (bytes / 1024 ** 3).toFixed(1);
}
