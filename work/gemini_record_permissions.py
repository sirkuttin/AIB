"""Record the real `session/request_permission` shapes the REAL Gemini CLI sends over ACP. No account, no key, no network.

    python work/gemini_record_permissions.py <gemini entry .js> <scratch> <out.json>

<gemini entry> is a Gemini CLI install's bundle (<prefix>/node_modules/@google/gemini-cli/bundle/gemini.js), installed into a
scratch prefix with `npm i --prefix`, never globally. The model is work/gemini_stub_api.js (a local Gemini API stub reached through
GOOGLE_GEMINI_BASE_URL); it answers with the scripted function calls below. GEMINI_API_KEY is fake. TEMP config only (GEMINI_CLI_HOME,
HOME, USERPROFILE, APPDATA, LOCALAPPDATA, TEMP live in the scratch folder); the project is a scratch folder outside the user profile
tree the owner uses. The driver answers EVERY permission request with the reject option, so nothing the model asks for ever runs.

The output keeps, per scripted call, the exact `tool_call` update and the exact `session/request_permission` request (the project
folder replaced by the token <PROJECT>, the temp home by <HOME>), plus the initialize/session-new facts (modes, agent info).
"""
import json
import os
import pathlib
import subprocess
import sys
import threading

HERE = pathlib.Path(__file__).resolve().parent
NO_WINDOW = getattr(subprocess, 'CREATE_NO_WINDOW', 0)

# (label, tool name, args). Relative paths resolve against the session folder; <PROJECT> and <OUTSIDE> are filled in below.
CALLS = [
    ('write_new_file', 'write_file', {'file_path': 'src/new_file.txt', 'content': 'created by the model\n'}),
    ('write_existing_file', 'write_file', {'file_path': 'notes.md', 'content': '# notes\nchanged\n'}),
    ('write_absolute_inside', 'write_file', {'file_path': '<PROJECT>/src/abs_inside.txt', 'content': 'abs\n'}),
    ('replace_in_file', 'replace', {'file_path': 'src/app.txt', 'old_string': 'hello world', 'new_string': 'hello gemini',
                                    'instruction': 'Change the greeting', 'allow_multiple': False}),
    ('write_empty_content', 'write_file', {'file_path': 'src/emptied.txt', 'content': ''}),
    ('write_dot_git_hook', 'write_file', {'file_path': '.git/hooks/pre-commit', 'content': 'echo hi\n'}),
    ('write_dot_gemini', 'write_file', {'file_path': '.gemini/settings.json', 'content': '{}\n'}),
    ('write_outside_project', 'write_file', {'file_path': '<OUTSIDE>/other.txt', 'content': 'outside\n'}),
    ('write_dotdot_escape', 'write_file', {'file_path': '../escaped.txt', 'content': 'escape\n'}),
    ('shell_test', 'run_shell_command', {'command': 'npm test', 'description': 'Run the tests'}),
    ('shell_test_dir_path', 'run_shell_command', {'command': 'node --test tests/', 'description': 'Run the tests', 'dir_path': 'src'}),
    ('shell_git_status', 'run_shell_command', {'command': 'git status --short'}),
    ('shell_git_push', 'run_shell_command', {'command': 'git push origin main', 'description': 'Push'}),
    ('shell_npm_install', 'run_shell_command', {'command': 'npm install left-pad', 'description': 'Install a package'}),
    ('shell_chain', 'run_shell_command', {'command': 'npm test && git diff --stat', 'description': 'Test then diff'}),
    ('shell_background', 'run_shell_command', {'command': 'npm run dev', 'description': 'Start the dev server', 'is_background': True}),
    ('shell_dir_outside', 'run_shell_command', {'command': 'git status', 'dir_path': '<OUTSIDE>'}),
    ('shell_remove', 'run_shell_command', {'command': 'rm -rf src', 'description': 'Delete src'}),
    ('shell_long_command', 'run_shell_command', {'command': 'node --test ' + ' '.join(f'tests/some_long_test_name_{i}.js' for i in range(12)),
                                                'description': 'Run the long list of tests'}),
    ('read_inside', 'read_file', {'file_path': 'notes.md'}),
    ('read_outside', 'read_file', {'file_path': '<OUTSIDE>/secret.txt'}),
    ('list_directory', 'list_directory', {'dir_path': 'src'}),
    ('glob', 'glob', {'pattern': '**/*.txt'}),
    ('grep_search', 'grep_search', {'pattern': 'hello'}),
    ('web_fetch', 'web_fetch', {'prompt': 'Summarize https://example.com/page'}),
    ('google_web_search', 'google_web_search', {'query': 'gemini cli acp'}),
    ('save_memory', 'save_memory', {'fact': 'the owner likes tabs'}),
]


def git(cwd, *args):
    return subprocess.run(['git', *args], cwd=cwd, capture_output=True, text=True, creationflags=NO_WINDOW).stdout.strip()


def main():
    entry = pathlib.Path(sys.argv[1]).resolve()
    scratch = pathlib.Path(sys.argv[2]).resolve()
    out_path = pathlib.Path(sys.argv[3]).resolve()
    base = scratch / 'gemini-record'
    base.mkdir(parents=True, exist_ok=True)
    project = base / 'proj'
    outside = base / 'outside'
    home = base / 'home'
    for d in (project / 'src', outside, home / 'AppData' / 'Roaming', home / 'AppData' / 'Local', base / 'tmp'):
        d.mkdir(parents=True, exist_ok=True)
    git(project, 'init', '-q', '-b', 'main')
    (project / 'notes.md').write_text('# notes\noriginal\n', encoding='utf-8')
    (project / 'src' / 'app.txt').write_text('hello world\nline two\n', encoding='utf-8')
    (project / 'src' / 'emptied.txt').write_text('had content\n', encoding='utf-8')
    (project / 'package.json').write_text('{"scripts":{"test":"node --test"}}\n', encoding='utf-8')
    (outside / 'secret.txt').write_text('s\n', encoding='utf-8')

    fill = lambda v: json.loads(json.dumps(v).replace('<PROJECT>', str(project).replace('\\', '/')).replace('<OUTSIDE>', str(outside).replace('\\', '/')))  # noqa: E731
    rules = [{'when': '', 'tools': ['write_file'], 'reply': {'call': {'name': n, 'args': fill(a)}}} for _, n, a in CALLS]
    rules.append({'when': '', 'tools': ['write_file'], 'reply': {'text': 'RECORD-DONE'}})
    (base / 'stub-script.json').write_text(json.dumps({'rules': rules}, indent=1), encoding='utf-8')
    (base / 'stub.log').unlink(missing_ok=True)
    stub = subprocess.Popen(['node', str(HERE / 'gemini_stub_api.js'), '--script', str(base / 'stub-script.json'), '--log', str(base / 'stub.log'), '--stdin'],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, creationflags=NO_WINDOW)
    port = stub.stdout.readline().strip().split('=')[1]
    env = dict(os.environ)
    for k in ('GOOGLE_API_KEY', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_GENAI_USE_VERTEXAI', 'GEMINI_MODEL'):
        env.pop(k, None)
    env.update(GEMINI_CLI_HOME=str(home), HOME=str(home), USERPROFILE=str(home), APPDATA=str(home / 'AppData' / 'Roaming'),
               LOCALAPPDATA=str(home / 'AppData' / 'Local'), TEMP=str(base / 'tmp'), TMP=str(base / 'tmp'), TMPDIR=str(base / 'tmp'),
               GEMINI_API_KEY='dummy', GOOGLE_GEMINI_BASE_URL=f'http://127.0.0.1:{port}', GEMINI_CLI_TRUST_WORKSPACE='true',
               GEMINI_CLI_AUTH_OVERRIDE='gemini-api-key', NO_BROWSER='1', CI='1')
    args = ['node', str(entry), '-m', 'gemini-2.5-flash', '--skip-trust', '--acp']
    proc = subprocess.Popen(args, cwd=project, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            creationflags=NO_WINDOW, text=True, encoding='utf-8', errors='replace')
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
            elif msg.get('id') == want:
                return msg
    try:
        init = send('initialize', {'protocolVersion': 1, 'clientCapabilities': {'fs': {'readTextFile': False, 'writeTextFile': False}}})
        new = send('session/new', {'cwd': str(project), 'mcpServers': []})
        sid = (new.get('result') or {}).get('sessionId')
        res = send('session/prompt', {'sessionId': sid, 'prompt': [{'type': 'text', 'text': 'record the permission shapes'}]}) if sid else None
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
        for real, token in ((str(project), '<PROJECT>'), (str(outside), '<OUTSIDE>'), (str(home), '<HOME>'), (str(base), '<BASE>')):
            s = s.replace(json.dumps(real)[1:-1], token).replace(real.replace('\\', '/'), token)
        return json.loads(s)

    shapes = []
    for i, (label, name, a) in enumerate(CALLS):
        # Gemini's call ids are `<tool>__<tool>_<time>_0` (no counter): a request belongs to the scripted call it names
        def mine(r):
            tc = r['toolCall']
            if not tc['toolCallId'].startswith(name + '__'):
                return False
            fa = fill(a)
            if name in ('write_file', 'replace'):
                return os.path.basename(fa['file_path']) == os.path.basename(str((tc.get('locations') or [{}])[0].get('path', '')).replace('\\', '/')) \
                    and (name == 'replace' or tc['content'][0]['newText'] == fa['content'])
            if name == 'run_shell_command':
                return tc['title'] == fa['command'] and (tc['content'][0]['content']['text'].startswith('[in ' + fa['dir_path'] + ']') if 'dir_path' in fa
                                                         else '[background]' in tc['content'][0]['content']['text'] if fa.get('is_background')
                                                         else '[background]' not in tc['content'][0]['content']['text'])
            return True
        hit = next((r for r in requests if mine(r)), None)
        shapes.append({'label': label, 'tool': name, 'args': scrub(fill(a)), 'asked': hit is not None,
                       'tool_call_update': scrub(tool_calls.get(hit['toolCall']['toolCallId'])) if hit else None,
                       'request': scrub(hit) if hit else None})
    report = {'gemini_cli': _version(entry), 'platform': sys.platform, 'args': ['gemini', '-m', 'gemini-2.5-flash', '--skip-trust', '--acp'],
              'initialize': scrub(init.get('result')), 'session_new': scrub(new.get('result') or new), 'prompt_result': scrub(res),
              'permission_request_count': len(requests), 'shapes': shapes, 'all_requests_in_order': scrub(requests),
              'tool_call_updates': scrub(list(tool_calls.values())), 'stderr_tail': scrub(''.join(err)[-800:])}
    out_path.write_text(json.dumps(report, indent=1), encoding='utf-8')
    print(out_path, len(requests), 'requests;', sum(1 for s in shapes if s['asked']), 'of', len(CALLS), 'calls asked')


def _version(entry):
    pkg = entry.parent.parent / 'package.json'
    try:
        return json.loads(pkg.read_text(encoding='utf-8')).get('version')
    except Exception:
        return None


if __name__ == '__main__':
    main()
