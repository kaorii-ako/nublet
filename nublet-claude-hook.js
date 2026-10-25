import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';

const WAIT_SECONDS = Number(GLib.getenv('NUBLET_HOOK_WAIT') ?? '120');
const STATE_DIR = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'nublet-claude']);
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

function readText(path) {
    try {
        return new TextDecoder().decode(GLib.file_get_contents(path)[1]);
    } catch {
        return null;
    }
}

function readJson(path) {
    try {
        return JSON.parse(readText(path) ?? '');
    } catch {
        return {};
    }
}

function writeJson(path, data) {
    const tmp = `${path}.${new Gio.Credentials().get_unix_pid()}.tmp`;
    GLib.file_set_contents(tmp, JSON.stringify(data));
    Gio.File.new_for_path(tmp).move(Gio.File.new_for_path(path), Gio.FileCopyFlags.OVERWRITE, null, null);
}

function parentOf(pid) {
    const stat = readText(`/proc/${pid}/stat`);
    return stat ? Number(stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[1]) : 0;
}

function commOf(pid) {
    return readText(`/proc/${pid}/comm`)?.trim() ?? null;
}

function ancestors(pid) {
    const chain = [];
    while (pid > 1 && chain.length < 64) {
        chain.push(pid);
        pid = parentOf(pid);
    }
    return chain;
}

function claudePid(chain) {
    return chain.find(pid => commOf(pid) === 'claude') ?? chain[0] ?? 0;
}

function run(argv) {
    try {
        const process = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        const [, stdout] = process.communicate_utf8(null, null);
        return stdout ?? '';
    } catch {
        return '';
    }
}

function tmuxInfo() {
    const tmux = GLib.getenv('TMUX'), pane = GLib.getenv('TMUX_PANE');
    if (!tmux || !pane)
        return [null, []];
    const socket = tmux.split(',')[0];
    const session = run(['tmux', '-S', socket, 'display-message', '-p', '-t', pane, '#{session_name}']).trim();
    const clients = session ? run(['tmux', '-S', socket, 'list-clients', '-t', session, '-F', '#{client_pid}']).split(/\s+/).filter(Boolean) : [];
    return [{socket, pane}, clients.flatMap(pid => ancestors(Number(pid)))];
}

function summarize(input) {
    if (!input || typeof input !== 'object')
        return '';
    for (const key of ['command', 'file_path', 'url', 'pattern', 'path', 'prompt']) {
        if (typeof input[key] === 'string')
            return input[key].slice(0, 400);
    }
    return JSON.stringify(input).slice(0, 400);
}

function firstLine(text, limit = 120) {
    return (text ?? '').trim().split('\n', 1)[0].slice(0, limit);
}

function listStateFiles() {
    const names = [];
    const enumerator = Gio.File.new_for_path(STATE_DIR).enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
    for (let info = enumerator.next_file(null); info; info = enumerator.next_file(null))
        names.push(info.get_name());
    return names;
}

function sweepDead() {
    for (const name of listStateFiles()) {
        if (!name.endsWith('.json'))
            continue;
        const pid = readJson(`${STATE_DIR}/${name}`).claude_pid;
        if (Number.isInteger(pid) && pid > 1 && !GLib.file_test(`/proc/${pid}`, GLib.FileTest.EXISTS))
            GLib.unlink(`${STATE_DIR}/${name}`);
    }
}

function nubletAlive() {
    const pid = Number(readText(`${STATE_DIR}/nublet.alive`)?.trim());
    return Number.isInteger(pid) && pid > 0 && commOf(pid) === 'gnome-shell';
}

function waitForResponse(requestId) {
    const path = `${STATE_DIR}/${requestId}.response`;
    const deadline = GLib.get_monotonic_time() + WAIT_SECONDS * 1e6;
    while (GLib.get_monotonic_time() < deadline) {
        const answer = readText(path);
        if (answer !== null) {
            GLib.unlink(path);
            return answer.trim();
        }
        GLib.usleep(200000);
    }
    return null;
}

function decide(answer, data) {
    if (answer === 'allow' || answer === 'always') {
        const decision = {behavior: 'allow'};
        const suggestions = data.permission_suggestions;
        if (answer === 'always' && Array.isArray(suggestions) && suggestions.length)
            decision.updatedPermissions = suggestions;
        return decision;
    }
    if (answer === 'deny')
        return {behavior: 'deny', message: 'The user denied this from Nublet.'};
    return null;
}

function readStdin() {
    const stream = new Gio.DataInputStream({base_stream: new GioUnix.InputStream({fd: 0, close_fd: false})});
    const chunks = [];
    for (let bytes = stream.read_bytes(65536, null); bytes.get_size(); bytes = stream.read_bytes(65536, null))
        chunks.push(bytes.toArray());
    const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
        all.set(chunk, offset);
        offset += chunk.length;
    }
    return new TextDecoder().decode(all);
}

function main(event) {
    let data;
    try {
        data = JSON.parse(readStdin());
    } catch {
        return;
    }
    const sessionId = data?.session_id;
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId))
        return;

    GLib.mkdir_with_parents(STATE_DIR, 0o700);
    const path = `${STATE_DIR}/${sessionId}.json`;

    if (event === 'SessionEnd') {
        GLib.unlink(path);
        return;
    }
    if (event === 'SessionStart' || event === 'UserPromptSubmit')
        sweepDead();

    const chain = ancestors(new Gio.Credentials().get_unix_pid());
    chain.shift();
    const [tmux, clientChain] = tmuxInfo();
    const state = readJson(path);
    const cwd = data.cwd || state.cwd || '';
    Object.assign(state, {
        id: sessionId,
        cwd,
        project: GLib.path_get_basename(cwd.replace(/\/+$/, '')) || 'claude',
        claude_pid: claudePid(chain),
        pids: [...chain, ...clientChain],
        tmux,
        updated: Date.now() / 1000,
    });
    if (data.session_title)
        state.title = data.session_title;

    if (event === 'SessionStart') {
        Object.assign(state, {state: 'idle', detail: ''});
    } else if (['UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure'].includes(event)) {
        Object.assign(state, {state: 'working', detail: ''});
    } else if (event === 'Stop') {
        Object.assign(state, {state: 'done', detail: firstLine(data.last_assistant_message)});
    } else if (event === 'StopFailure') {
        Object.assign(state, {state: 'error', detail: 'Stopped with an error'});
    } else if (event === 'Notification') {
        if (data.notification_type !== 'permission_prompt' || state.state === 'permission')
            return;
        Object.assign(state, {state: 'terminal', detail: firstLine(data.message)});
    } else if (event === 'PermissionRequest' && !nubletAlive()) {
        Object.assign(state, {state: 'terminal', tool: data.tool_name || 'Tool', detail: summarize(data.tool_input)});
    } else if (event === 'PermissionRequest') {
        const requestId = GLib.uuid_string_random().replaceAll('-', '');
        Object.assign(state, {
            state: 'permission',
            tool: data.tool_name || 'Tool',
            detail: summarize(data.tool_input),
            can_always: Array.isArray(data.permission_suggestions) && data.permission_suggestions.length > 0,
            request: requestId,
            deadline: Date.now() / 1000 + WAIT_SECONDS,
        });
        writeJson(path, state);

        const decision = decide(waitForResponse(requestId), data);
        delete state.request;
        delete state.deadline;
        state.updated = Date.now() / 1000;
        state.state = decision ? 'working' : 'terminal';
        writeJson(path, state);
        if (decision)
            print(JSON.stringify({hookSpecificOutput: {hookEventName: 'PermissionRequest', decision}}));
        return;
    } else {
        return;
    }
    writeJson(path, state);
}

main(ARGV[0] ?? '');
