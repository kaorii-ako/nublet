const TAG = /\[(\d+):(\d+(?:\.\d+)?)\]/g;

export function parseLrc(text) {
    const lines = [];
    for (const raw of text.split(/\r?\n/)) {
        const stamps = [...raw.matchAll(TAG)];
        if (!stamps.length)
            continue;
        const words = raw.replace(TAG, '').trim();
        for (const [, minutes, seconds] of stamps)
            lines.push({time: Number(minutes) * 60 + Number(seconds), text: words});
    }
    return lines.sort((a, b) => a.time - b.time);
}

export function lineIndexAt(lines, seconds) {
    let lo = 0, hi = lines.length - 1, found = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (lines[mid].time <= seconds) {
            found = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return found;
}
