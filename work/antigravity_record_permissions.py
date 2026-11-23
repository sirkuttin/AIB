"""Record the real `session/request_permission` shapes the REAL Antigravity CLI (`agy acp`) sends. No Google account, no key, no network.

    python work/antigravity_record_permissions.py <agy.exe or agy> <scratch> <out.json>

<agy> is the pinned 1.5.11 build (the file AIB's installer downloads; its SHA-512 is in beta_catalog.ts), kept in a scratch folder.
agy reads GOOGLE_GEMINI_BASE_URL, so with `--gemini-dir <temp>` (settings.json {"modelProvider": "gemini"}), GEMINI_API_KEY=dummy and
an ACP authenticate with `gemini-api-key`, its model calls go to work/gemini_stub_api.js, a local stub that answers with the scripted
function calls below (agy's own tool names: run_command, write_file, edit_file, read_file, search_web). Temp HOME/APPDATA/LOCALAPPDATA/TEMP
only. The driver answers EVERY permission request with a reject option, so nothing the model asks for ever runs.
Output: per scripted call the exact request (project folder replaced by <PROJECT>), plus every request in order and every tool_call update.
"""
import json
import os
import pathlib
import shutil
import subprocess
import sys
import threading

HERE = pathlib.Path(__file__).resolve().parent
NO_WINDOW = getattr(subprocess, 'CREATE_NO_WINDOW', 0)

CALLS = [
    ('write_new_file', 'write_file', {'Path': '<PROJECT>/src/new_file.txt', 'Content': 'created by the model\n'}),
    ('write_overwrite_existing', 'write_file', {'Path': '<PROJECT>/notes.md', 'Content': '# notes\nchanged\n', 'Overwrite': True}),
    ('write_append', 'write_file', {'Path': '<PROJECT>/notes.md', 'Content': 'more\n', 'Append': True}),
    ('edit_in_file', 'edit_file', {'Path': '<PROJECT>/src/app.txt', 'Target': 'hello world', 'Replacement': 'hello agy'}),
    ('edit_delete_text', 'edit_file', {'Path': '<PROJECT>/src/app.txt', 'Target': 'line two\n', 'Replacement': ''}),
    ('write_dot_git_hook', 'write_file', {'Path': '<PROJECT>/.git/hooks/pre-commit', 'Content': 'echo hi\n'}),
    ('write_dot_gemini', 'write_file', {'Path': '<PROJECT>/.gemini/settings.json', 'Content': '{}\n'}),
    ('write_outside_project', 'write_file', {'Path': '<OUTSIDE>/other.txt', 'Content': 'outside\n'}),
    ('write_dotdot_escape', 'write_file', {'Path': '<PROJECT>/../escaped.txt', 'Content': 'escape\n'}),
    ('run_test', 'run_command', {'CommandLine': 'npm test', 'toolSummary': 'Run tests', 'WaitMsBeforeAsync': 5000}),
    ('run_git_status', 'run_command', {'CommandLine': 'git status --short', 'toolSummary': 'Git status', 'WaitMsBeforeAsync': 5000}),
    ('run_git_push', 'run_command', {'CommandLine': 'git push origin main', 'toolSummary': 'Push', 'WaitMsBeforeAsync': 5000}),
    ('run_npm_install', 'run_command', {'CommandLine': 'npm install left-pad', 'toolSummary': 'Install package', 'WaitMsBeforeAsync': 5000}),
    ('run_chain', 'run_command', {'CommandLine': 'npm test && git diff --stat', 'toolSummary': 'Test and diff', 'WaitMsBeforeAsync': 5000}),
    ('run_daemon', 'run_command', {'CommandLine': 'npm run dev', 'toolSummary': 'Dev server', 'IsDaemon': True, 'WaitMsBeforeAsync': 500}),
    ('run_remove', 'run_command', {'CommandLine': 'rm -rf src', 'toolSummary': 'Delete src', 'WaitMsBeforeAsync': 5000}),
    ('read_inside', 'read_file', {'Path': '<PROJECT>/notes.md'}),
    ('read_outside', 'read_file', {'Path': '<OUTSIDE>/secret.txt'}),
    ('search_web', 'search_web', {'query': 'antigravity cli acp'}),
]


def main():
    agy = pathlib.Path(sys.argv[1]).resolve()
    scratch = pathlib.Path(sys.argv[2]).resolve()
    out_path = pathlib.Path(sys.argv[3]).resolve()
    base = scratch / 'agy-record'
    shutil.rmtree(base, ignore_errors=True)
    project, outside, home, gdir = base / 'proj', base / 'outside', base / 'home', base / 'gdir'
    for d in (project / 'src', outside, home / 'AppData' / 'Roaming', home / 'AppData' / 'Local', base / 'tmp', gdir / 'antigravity-cli'):
        d.mkdir(parents=True, exist_ok=True)
    (gdir / 'antigravity-cli' / 'settings.json').write_text(json.dumps({'modelProvider': 'gemini'}), encoding='utf-8')
    subprocess.run(['git', 'init', '-q', '-b', 'main'], cwd=project, creationflags=NO_WINDOW)
    (project / 'notes.md').write_text('# notes\noriginal\n', encoding='utf-8')
    (project / 'src' / 'app.txt').write_text('hello world\nline two\n', encoding='utf-8')
    (project / 'package.json').write_text('{"scripts":{"test":"node --test"}}\n', encoding='utf-8')
    (outside / 'secret.txt').write_text('s\n', encoding='utf-8')
    fill = lambda v: json.loads(json.dumps(v).replace('<PROJECT>', str(project).replace('\\', '/')).replace('<OUTSIDE>', str(outside).replace('\\', '/')))  # noqa: E731
    rules = [{'when': '', 'tools': ['write_file', 'run_command'], 'reply': {'call': {'name': n, 'args': fill(a)}}} for _, n, a in CALLS]
    rules.append({'when': '', 'tools': ['write_file', 'run_command'], 'reply': {'text': 'RECORD-DONE'}})
    (base / 'stub-script.json').write_text(json.dumps({'rules': rules}, indent=1), encoding='utf-8')
    stub = subprocess.Popen(['node', str(HERE / 'gemini_stub_api.js'), '--script', str(base / 'stub-script.json'), '--log', str(base / 'stub.log'),
                             '--dump-tools', str(base / 'tools.json'), '--stdin'],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, creationflags=NO_WINDOW)
    port = stub.stdout.readline().strip().split('=')[1]
    env = {k: v for k, v in os.environ.items() if not k.startswith(('GOOGLE', 'GEMINI'))}
    env.update(HOME=str(home), USERPROFILE=str(home), APPDATA=str(home / 'AppData' / 'Roaming'), LOCALAPPDATA=str(home / 'AppData' / 'Local'),
               TEMP=str(base / 'tmp'), TMP=str(base / 'tmp'), TMPDIR=str(base / 'tmp'), GEMINI_API_KEY='dummy',
               GOOGLE_GEMINI_BASE_URL=f'http://127.0.0.1:{port}')
    proc = subprocess.Popen([str(agy), 'acp', '--disable-telemetry', '--gemini-dir', str(gdir)], cwd=project, env=env, stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8', errors='replace', creationflags=NO_WINDOW)
    err = []
    threading.Thread(target=lambda: err.extend(proc.stderr), daemon=True).start()
    nid = [0]
    tool_calls = {}
    requests = []

    def send(method, params):
        nid[0] += 1
        proc.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': nid[0], 'method': method, 'params': params}) + '\n')
        proc.stdin.flush()
        want = nid[0]
        while True:
            line = proc.stdout.readline()
            if not line:
                return {'error': 'eof'}
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            if msg.get('method') == 'session/update':
                u = msg['params'].get('update', {})
                if u.get('sessionUpdate') == 'tool_call' and u.get('toolCallId') not in tool_calls:
                    tool_calls[u['toolCallId']] = u
            elif msg.get('method') == 'session/request_permission':
                requests.append(msg['params'])
                opts = msg['params'].get('options', [])
                pick = next((o for o in opts if o.get('kind') == 'reject_once'), opts[-1])
                proc.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': msg['id'], 'result': {'outcome': {'outcome': 'selected', 'optionId': pick.get('optionId')}}}) + '\n')
                proc.stdin.flush()
            elif msg.get('id') == want and 'method' not in msg:
                return msg
    try:
        init = send('initialize', {'protocolVersion': 1, 'clientCapabilities': {'fs': {'readTextFile': False, 'writeTextFile': False}}})
        auth = send('authenticate', {'methodId': 'gemini-api-key', '_meta': {'api-key': 'dummy'}})
        new = send('session/new', {'cwd': str(project), 'mcpServers': []})
        sid = (new.get('result') or {}).get('sessionId')
        res = []
        for label, _n, _a in CALLS:
            # a rejected call ends agy's turn, so each scripted call gets its own prompt; the requests it raised are its own
            before = len(requests)
            r = send('session/prompt', {'sessionId': sid, 'prompt': [{'type': 'text', 'text': f'record {label}'}]}) if sid else None
            res.append({'label': label, 'stop': ((r or {}).get('result') or r or {}).get('stopReason'), 'requests': list(range(before, len(requests)))})
    finally:
        proc.stdin.close()
        try:
            proc.wait(timeout=20)
        except subprocess.TimeoutExpired:
            proc.kill()
        stub.stdin.close()
        stub.wait(timeout=10)

    def scrub(v):
        s = json.dumps(v)
        for real, token in ((str(project), '<PROJECT>'), (str(outside), '<OUTSIDE>'), (str(home), '<HOME>'), (str(gdir), '<GDIR>'), (str(base), '<BASE>')):
            s = s.replace(json.dumps(real)[1:-1], token).replace(real.replace('\\', '/'), token)
        return json.loads(s)

    report = {'agy': '1.5.11 (pinned build)', 'platform': sys.platform, 'args': ['agy', 'acp', '--disable-telemetry', '--gemini-dir', '<GDIR>'],
              'initialize': scrub(init.get('result')), 'authenticate': auth.get('result'), 'session_new': scrub(new.get('result') or new),
              'prompt_result': scrub(res), 'scripted_calls': [{'label': l, 'tool': n, 'args': scrub(fill(a))} for l, n, a in CALLS],
              'permission_request_count': len(requests), 'all_requests_in_order': scrub(requests),
              'tool_call_updates': scrub(list(tool_calls.values())), 'stderr_tail': scrub(''.join(err)[-800:])}
    out_path.write_text(json.dumps(report, indent=1), encoding='utf-8')
    print(out_path, len(requests), 'requests of', len(CALLS), 'calls')


if __name__ == '__main__':
    main()
