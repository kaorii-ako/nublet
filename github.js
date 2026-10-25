import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {FeedView} from './feed.js';
import {htmlUrl} from './links.js';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

const GH_FALLBACKS = ['/home/linuxbrew/.linuxbrew/bin/gh', '/usr/local/bin/gh', `${GLib.get_home_dir()}/.local/bin/gh`];

export class GithubView extends FeedView {
    static id = 'github';
    static title = 'GitHub';
    static icon = 'folder-remote-symbolic';

    async fetch(cancellable) {
        const gh = GLib.find_program_in_path('gh') ?? GH_FALLBACKS.find(path => GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE));
        if (!gh)
            return 'Install the GitHub CLI (gh) and run gh auth login.';
        const process = Gio.Subprocess.new([gh, 'api', 'notifications?per_page=15'],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        const [stdout] = await process.communicate_utf8_async(null, cancellable);
        if (!process.get_successful())
            return 'gh could not reach GitHub. Run gh auth status in a terminal.';
        return JSON.parse(stdout).map(n => ({
            id: `${n.id}:${n.updated_at}`,
            title: n.subject?.title ?? 'Notification',
            subtitle: `${n.repository?.full_name ?? ''} · ${(n.reason ?? '').replaceAll('_', ' ')}`,
            uri: htmlUrl(n),
        }));
    }
}
