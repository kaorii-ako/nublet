import GLib from 'gi://GLib';

export const EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure',
    'PermissionRequest', 'Notification', 'Stop', 'StopFailure'];
const MARKERS = ['nublet-claude-hook', 'isle-claude-hook'];

function isNubletGroup(group) {
    return (group?.hooks ?? []).some(hook => [hook.command, ...(hook.args ?? [])].some(part => MARKERS.some(marker => String(part).includes(marker))));
}

export function withoutNubletHooks(settings) {
    const next = JSON.parse(JSON.stringify(settings ?? {}));
    for (const [event, groups] of Object.entries(next.hooks ?? {})) {
        const kept = groups.filter(group => !isNubletGroup(group));
        if (kept.length)
            next.hooks[event] = kept;
        else
            delete next.hooks[event];
    }
    if (next.hooks && !Object.keys(next.hooks).length)
        delete next.hooks;
    return next;
}

export function withNubletHooks(settings, hookPath) {
    const next = withoutNubletHooks(settings);
    next.hooks ??= {};
    for (const event of EVENTS) {
        (next.hooks[event] ??= []).push({hooks: [{
            type: 'command',
            command: 'gjs',
            args: ['-m', hookPath, event],
            timeout: event === 'PermissionRequest' ? 130 : 5,
        }]});
    }
    return next;
}

export function hasNubletHooks(settings) {
    return Object.values(settings?.hooks ?? {}).some(groups => groups.some(isNubletGroup));
}

export function settingsPath() {
    return GLib.build_filenamev([GLib.get_home_dir(), '.claude', 'settings.json']);
}

export function readSettings() {
    const path = settingsPath();
    if (!GLib.file_test(path, GLib.FileTest.EXISTS))
        return {};
    return JSON.parse(new TextDecoder().decode(GLib.file_get_contents(path)[1]));
}

export function writeSettings(settings) {
    const path = settingsPath();
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700);
    if (GLib.file_test(path, GLib.FileTest.EXISTS))
        GLib.file_set_contents(`${path}.bak-nublet-${GLib.DateTime.new_now_local().format('%Y%m%d-%H%M%S')}`, GLib.file_get_contents(path)[1]);
    GLib.file_set_contents(path, `${JSON.stringify(settings, null, 2)}\n`);
}
