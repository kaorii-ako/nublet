import {nextExpiry, pickActivity} from './activities.js';
import {lineIndexAt, parseLrc} from './lyrics.js';
import {hasNubletHooks, withNubletHooks, withoutNubletHooks} from './hookInstall.js';
import {htmlUrl} from './links.js';
import {cpuPercent, formatRate, parseCpu, parseMem, parseNet} from './statsParse.js';

function assert(ok, message) {
    if (!ok)
        throw new Error(`FAIL: ${message}`);
}

const activities = new Map([
    ['media', {priority: 30}],
    ['volume', {priority: 80, until: 1000}],
    ['claude', {priority: 100, until: 500}],
]);
assert(pickActivity(activities, 400).priority === 100, 'highest priority wins');
assert(pickActivity(activities, 600).priority === 80, 'expired activities are skipped');
assert(pickActivity(activities, 2000).priority === 30, 'persistent activity remains');
assert(pickActivity(new Map(), 0) === null, 'no activity means clock');
assert(nextExpiry(activities, 400) === 500 && nextExpiry(activities, 1500) === null, 'next expiry');

const lrc = parseLrc('[ar:Someone]\n[00:12.50]first\n[00:05.00][01:00.00]chorus\nplain\n[00:20]third\r\n');
assert(lrc.length === 4, `parses stamped lines only (${lrc.length})`);
assert(lrc[0].time === 5 && lrc[0].text === 'chorus', 'sorted, multi-stamp lines expand');
assert(lrc.at(-1).time === 60, 'minutes convert');
assert(lineIndexAt(lrc, 4) === -1, 'before first line');
assert(lrc[lineIndexAt(lrc, 13)].text === 'first', 'line at 13s');
assert(lrc[lineIndexAt(lrc, 20)].text === 'third', 'exact stamp');
assert(lineIndexAt([], 10) === -1, 'empty lyrics');

const a = parseCpu('cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 1 2 3');
const b = parseCpu('cpu  150 0 150 900 0 0 0 0 0 0\n');
assert(cpuPercent(a, b) === 50, `cpu percent (${cpuPercent(a, b)})`);
assert(cpuPercent(a, a) === 0, 'no elapsed time');

const mem = parseMem('MemTotal:       32000000 kB\nMemFree: 1 kB\nMemAvailable:   24000000 kB\n');
assert(mem.total === 32000000 * 1024 && mem.used === 8000000 * 1024, 'mem used');

const net = parseNet(`Inter-|   Receive
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets
    lo: 999 1 0 0 0 0 0 0 999 1 0 0 0 0 0 0
enp5s0: 1000 10 0 0 0 0 0 0 200 3 0 0 0 0 0 0
wlp6s0: 500 10 0 0 0 0 0 0 100 3 0 0 0 0 0 0
virbr0: 7777 1 0 0 0 0 0 0 7777 1 0 0 0 0 0 0
`);
assert(net.rx === 1500 && net.tx === 300, `net sums physical interfaces (${net.rx}/${net.tx})`);

assert(formatRate(512) === '512 B/s', formatRate(512));
assert(formatRate(1536000) === '1.5 MB/s', formatRate(1536000));
assert(formatRate(250000) === '250 KB/s', formatRate(250000));

assert(htmlUrl({subject: {url: 'https://api.github.com/repos/kaorii-ako/nublet/pulls/12'}}) === 'https://github.com/kaorii-ako/nublet/pull/12', 'github pull url');
assert(htmlUrl({subject: {url: 'https://api.github.com/repos/o/r/issues/3'}}) === 'https://github.com/o/r/issues/3', 'github issue url');
assert(htmlUrl({subject: {url: null}, repository: {html_url: 'https://github.com/o/r'}}) === 'https://github.com/o/r', 'github fallback url');
assert(htmlUrl({}) === 'https://github.com/notifications', 'github default url');

const userSettings = {
    model: 'opus',
    statusLine: {type: 'command', command: 'mine'},
    hooks: {
        SessionStart: [{hooks: [{type: 'command', command: 'herdr session'}]}],
        Stop: [{hooks: [{type: 'command', command: 'python3', args: ['/old/nublet-claude-hook.py', 'Stop']}]}],
    },
};
const installed = withNubletHooks(userSettings, '/ext/nublet-claude-hook.js');
assert(hasNubletHooks(installed) && !hasNubletHooks({}) , 'detects installed hooks');
assert(installed.hooks.SessionStart.length === 2 && installed.hooks.SessionStart[0].hooks[0].command === 'herdr session', 'keeps other hooks first');
assert(installed.hooks.Stop.length === 1 && installed.hooks.Stop[0].hooks[0].args[1] === '/ext/nublet-claude-hook.js', 'replaces old nublet hooks instead of duplicating');
assert(installed.hooks.PermissionRequest[0].hooks[0].timeout === 130, 'permission hook waits longer than Nublet');
assert(installed.model === 'opus' && installed.statusLine.command === 'mine', 'other settings untouched');
assert(JSON.stringify(withNubletHooks(installed, '/ext/nublet-claude-hook.js')) === JSON.stringify(installed), 'install is idempotent');
const removed = withoutNubletHooks(installed);
assert(!hasNubletHooks(removed) && removed.hooks.SessionStart.length === 1 && !removed.hooks.Stop, 'uninstall removes only nublet');
assert(userSettings.hooks.Stop.length === 1, 'input not mutated');
assert(!('hooks' in withoutNubletHooks({hooks: {Stop: userSettings.hooks.Stop}})), 'empty hooks object dropped');

const legacy = {hooks: {Stop: [{hooks: [{type: 'command', command: 'gjs', args: ['-m', '/old/isle-claude-hook.js', 'Stop']}]}]}};
assert(hasNubletHooks(legacy), 'recognises hooks from the old Isle name');
assert(withNubletHooks(legacy, '/ext/nublet-claude-hook.js').hooks.Stop.length === 1, 'upgrading from Isle replaces the old hook');

print('parsers: all checks passed');
