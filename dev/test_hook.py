import json
import os
import subprocess
import sys
import tempfile
import threading
import time

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'nublet-claude-hook.js')


def run(runtime, event, payload, wait='120'):
    env = {**os.environ, 'XDG_RUNTIME_DIR': runtime, 'NUBLET_HOOK_WAIT': wait}
    env.pop('TMUX', None)
    result = subprocess.run(['gjs', '-m', HOOK, event], input=json.dumps(payload),
                            capture_output=True, text=True, env=env, timeout=30)
    assert result.returncode == 0, result.stderr
    return result.stdout.strip()


def state(runtime, sid):
    with open(os.path.join(runtime, 'nublet-claude', f'{sid}.json')) as f:
        return json.load(f)


def answer_when_asked(runtime, sid, answer):
    def worker():
        for _ in range(100):
            try:
                request = state(runtime, sid).get('request')
            except (OSError, ValueError):
                request = None
            if request:
                with open(os.path.join(runtime, 'nublet-claude', f'{request}.response'), 'w') as f:
                    f.write(answer)
                return
            time.sleep(0.05)
    thread = threading.Thread(target=worker)
    thread.start()
    return thread


def spawn_named(runtime, name):
    link = os.path.join(runtime, name)
    os.symlink('/usr/bin/sleep', link)
    return subprocess.Popen([link, '120'])


def mark_alive(runtime, pid):
    with open(os.path.join(runtime, 'nublet-claude', 'nublet.alive'), 'w') as f:
        f.write(str(pid))


def timed(fn):
    started = time.monotonic()
    result = fn()
    return result, time.monotonic() - started


def main():
    runtime = tempfile.mkdtemp()
    sid = 'test-session'
    base = {'session_id': sid, 'cwd': '/home/u/projects/nublet'}
    request = {**base, 'tool_name': 'Bash', 'tool_input': {'command': 'rm -rf build'},
               'permission_suggestions': [{'type': 'addRules', 'rules': [{'toolName': 'Bash', 'ruleContent': 'rm -rf build'}],
                                           'behavior': 'allow', 'destination': 'localSettings'}]}

    assert run(runtime, 'SessionStart', base) == ''
    assert state(runtime, sid)['state'] == 'idle'
    assert state(runtime, sid)['project'] == 'nublet'

    out, took = timed(lambda: run(runtime, 'PermissionRequest', request))
    assert out == '' and took < 3, 'without Nublet running the hook must not hold the terminal prompt'
    assert state(runtime, sid)['state'] == 'terminal'

    impostor = spawn_named(runtime, 'not-the-shell')
    shell = spawn_named(runtime, 'gnome-shell')
    try:
        mark_alive(runtime, impostor.pid)
        out, took = timed(lambda: run(runtime, 'PermissionRequest', request))
        assert out == '' and took < 3, 'a live pid that is not gnome-shell does not count as Nublet'

        mark_alive(runtime, shell.pid)

        run(runtime, 'UserPromptSubmit', {**base, 'prompt': 'hi'})
        assert state(runtime, sid)['state'] == 'working'

        thread = answer_when_asked(runtime, sid, 'allow')
        out = json.loads(run(runtime, 'PermissionRequest', request))
        thread.join()
        assert out['hookSpecificOutput']['decision'] == {'behavior': 'allow'}, out
        assert state(runtime, sid)['state'] == 'working'
        assert 'request' not in state(runtime, sid)

        thread = answer_when_asked(runtime, sid, 'always')
        out = json.loads(run(runtime, 'PermissionRequest', request))
        thread.join()
        assert out['hookSpecificOutput']['decision']['updatedPermissions'] == request['permission_suggestions'], out

        thread = answer_when_asked(runtime, sid, 'deny')
        out = json.loads(run(runtime, 'PermissionRequest', request))
        thread.join()
        assert out['hookSpecificOutput']['decision']['behavior'] == 'deny', out

        thread = answer_when_asked(runtime, sid, 'terminal')
        assert run(runtime, 'PermissionRequest', request) == ''
        thread.join()
        assert state(runtime, sid)['state'] == 'terminal'

        assert run(runtime, 'PermissionRequest', request, wait='0.3') == ''
        assert state(runtime, sid)['state'] == 'terminal'
    finally:
        impostor.kill()
        shell.kill()

    run(runtime, 'PostToolUse', base)
    run(runtime, 'Stop', {**base, 'last_assistant_message': 'All done.\nDetails...'})
    assert state(runtime, sid)['state'] == 'done'
    assert state(runtime, sid)['detail'] == 'All done.'

    assert run(runtime, 'SessionStart', {'session_id': '../escape', 'cwd': '/'}) == ''
    assert not os.path.exists(os.path.join(runtime, 'escape.json'))

    with open(os.path.join(runtime, 'nublet-claude', 'dead.json'), 'w') as f:
        json.dump({'id': 'dead', 'claude_pid': 2 ** 22 + 1}, f)
    run(runtime, 'UserPromptSubmit', base)
    assert not os.path.exists(os.path.join(runtime, 'nublet-claude', 'dead.json'))

    run(runtime, 'SessionEnd', base)
    assert not os.path.exists(os.path.join(runtime, 'nublet-claude', f'{sid}.json'))

    print('nublet-claude-hook: all checks passed')


if __name__ == '__main__':
    main()
