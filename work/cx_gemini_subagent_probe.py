"""Can AIB fence or redirect a Gemini CLI subagent? Truth checks against the REAL Gemini CLI, no account and no network.

    python work/cx_gemini_subagent_probe.py <gemini entry .js> <scratch> <scenario...> [--acp]

<gemini entry> is a Gemini CLI install's bundle (e.g. <prefix>/node_modules/@google/gemini-cli/bundle/gemini.js), installed into a
scratch prefix, never globally. The model is work/gemini_stub_api.js, a local Gemini API stub reached through
GOOGLE_GEMINI_BASE_URL (Gemini's "gateway" auth); GEMINI_API_KEY is fake. `-m gemini-2.5-flash` pins the model, so Gemini's
model router (which makes its own classifier call when the model is "auto") never runs. GEMINI_CLI_AUTH_OVERRIDE=gemini-api-key
(the startup check rejects "gateway"; the base URL still applies). TEMP config only: GEMINI_CLI_HOME, HOME, USERPROFILE, APPDATA,
LOCALAPPDATA, TEMP/TMP live in the scratch folder. Hooks go in that temp home's user settings: the system settings file is skipped
unless an administrator/root owns its folder.

Every scenario plays (the stub tells the agents apart by the tools Gemini offers each: the parent gets invoke_agent, a subagent
gets complete_task):
  parent  write_file("parent-made.txt") (relative: lands in the session folder), then invoke_agent(generalist)
  sub     write_file("sub-made.txt") (relative), then complete_task
  parent  answers PARENT-DONE
Scenarios:
  log       hooks on, log only: does BeforeTool fire for the subagent's calls, and can the hook tell them from the parent's?
  redirect  the hook rewrites a subagent's write_file path into a worktree AIB made (added with --include-directories)
  deny      the hook denies a subagent's write_file
  policy    no hook; `--admin-policy <dir>` with [[rule]] {toolName = "write_file", subagent = "generalist", decision = "deny"}
  policy-all  the same rule with no subagent scope (proves the file loads: the parent loses write_file too)
--acp drives the same play over ACP (`--acp`, session/new cwd = the project, session/prompt), as AIB launches Gemini. Under ACP the
parent's own tool calls never reach hooks, so the client (AIB's part) marks a subagent in flight from the invoke_agent tool_call.
Owner guard: mtimes of everything under the owner's ~/.gemini and ~/.codex, and ~/.claude outside its busy session folders.
"""
import json
import os
import pathlib
import subprocess
import sys
import threading
import uuid

HERE = pathlib.Path(__file__).resolve().parent
NO_WINDOW = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
RUN = uuid.uuid4().hex[:8]
CLAUDE_BUSY = {'projects', 'todos', 'shell-snapshots', 'statsig', 'session-env', 'file-history', 'debug', 'tasks', 'plugins', 'ide'}


def git(cwd, *args):
    return subprocess.run(['git', *args], cwd=cwd, capture_output=True, text=True, creationflags=NO_WINDOW).stdout.strip()


def make_repo(folder):
    folder.mkdir(parents=True)
    git(folder, 'init', '-q', '-b', 'main')
    git(folder, 'config', 'user.name', 'cx')
    git(folder, 'config', 'user.email', 'cx@example.invalid')
    (folder / 'tracked.txt').write_text('one\n', encoding='utf-8')
    git(folder, 'add', '-A')
    git(folder, 'commit', '-q', '-m', 'first')
    return folder


def script():
    call = lambda name, args: {'call': {'name': name, 'args': args}}  # noqa: E731
    return {'rules': [
        {'when': f'GX-SUB-{RUN}', 'tools': ['complete_task', 'write_file'],
         'reply': call('write_file', {'file_path': 'sub-made.txt', 'content': f'SUB {RUN}\n'})},
        {'when': 'write_file', 'tools': ['complete_task'], 'reply': call('complete_task', {'result': {'response': f'SUB-DONE-{RUN}'}})},
        {'when': f'GX-PARENT-{RUN}', 'tools': ['invoke_agent', 'write_file'],
         'reply': call('write_file', {'file_path': 'parent-made.txt', 'content': f'PARENT {RUN}\n'})},
        {'when': 'write_file', 'tools': ['invoke_agent'],
         'reply': call('invoke_agent', {'agent_name': 'generalist', 'prompt': f'GX-SUB-{RUN} make the file'})},
        {'when': 'invoke_agent', 'tools': ['invoke_agent'], 'reply': {'text': f'PARENT-DONE-{RUN}'}},
    ]}


def tree(root, skip=()):
    out = {}
    if not root.is_dir():
        return out
    for dirpath, dirnames, files in os.walk(root):
        if pathlib.Path(dirpath) == root:
            dirnames[:] = [d for d in dirnames if d not in skip]
        for f in files:
            p = os.path.join(dirpath, f)
            try:
                out[p] = os.stat(p).st_mtime
            except OSError:
                pass
    return out


def owner_state():
    home = pathlib.Path(os.path.expanduser('~'))
    return {**tree(home / '.gemini'), **tree(home / '.codex'), **tree(home / '.claude', CLAUDE_BUSY)}


def start_stub(base):
    sc = base / 'stub-script.json'
    sc.write_text(json.dumps(script(), indent=1), encoding='utf-8')
    stub = subprocess.Popen(['node', str(HERE / 'gemini_stub_api.js'), '--script', str(sc), '--log', str(base / 'stub.log'), '--stdin'],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, creationflags=NO_WINDOW)
    port = stub.stdout.readline().strip().split('=')[1]
    return stub, port


def acp_drive(args, cwd, env, state):
    """Minimal ACP client: initialize, session/new {cwd}, session/prompt; answers permission requests with the first allow.
    It also plays AIB's part: under ACP the parent's own tool calls never reach hooks (BeforeTool(invoke_agent) never fires), so the
    client marks a subagent in flight from the ACP stream: tool_call invoke_agent__* in_progress writes <state>, its completion
    removes it. The hook reads <state>."""
    proc = subprocess.Popen(args, cwd=cwd, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            creationflags=NO_WINDOW, text=True, encoding='utf-8', errors='replace')
    err = []
    threading.Thread(target=lambda: err.extend(proc.stderr), daemon=True).start()
    nid = [0]
    updates = []

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
                updates.append({k: u.get(k) for k in ('sessionUpdate', 'title', 'kind', 'status', 'toolCallId')})
                if str(u.get('toolCallId') or '').startswith('invoke_agent'):
                    if u.get('status') in ('pending', 'in_progress'):
                        state.write_text(json.dumps({'by': 'acp-client', 'toolCallId': u.get('toolCallId')}), encoding='utf-8')
                    elif u.get('status') in ('completed', 'failed') and state.exists():
                        state.unlink()
            elif msg.get('method') == 'session/request_permission':
                opts = msg['params'].get('options', [])
                pick = next((o for o in opts if o.get('kind', '').startswith('allow')), opts[0] if opts else {})
                proc.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': msg['id'], 'result': {'outcome': {'outcome': 'selected', 'optionId': pick.get('optionId')}}}) + '\n')
                proc.stdin.flush()
                updates.append({'permission': msg['params'].get('toolCall', {}).get('title')})
            elif msg.get('id') == want:
                return msg
    try:
        init = send('initialize', {'protocolVersion': 1, 'clientCapabilities': {'fs': {'readTextFile': False, 'writeTextFile': False}}})
        new = send('session/new', {'cwd': str(cwd), 'mcpServers': []})
        sid = (new.get('result') or {}).get('sessionId')
        res = send('session/prompt', {'sessionId': sid, 'prompt': [{'type': 'text', 'text': f'GX-PARENT-{RUN} go'}]}) if sid else None
        return {'init_ok': 'result' in init, 'session_new': new.get('error') or 'ok', 'prompt': res,
                'updates': updates[-40:], 'stderr': ''.join(err)[-1500:]}
    finally:
        proc.stdin.close()
        try:
            proc.wait(timeout=20)
        except subprocess.TimeoutExpired:
            proc.kill()


def scenario(entry, base, name, acp):
    base.mkdir(parents=True)
    project = make_repo(base / 'proj')
    home = base / 'home'
    (home / 'AppData' / 'Roaming').mkdir(parents=True)
    (home / 'AppData' / 'Local').mkdir(parents=True)
    (base / 'tmp').mkdir()
    stub, port = start_stub(base)
    env = dict(os.environ)
    for k in ('GOOGLE_API_KEY', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_GENAI_USE_VERTEXAI', 'GEMINI_MODEL'):
        env.pop(k, None)
    env.update(GEMINI_CLI_HOME=str(home), HOME=str(home), USERPROFILE=str(home), APPDATA=str(home / 'AppData' / 'Roaming'),
               LOCALAPPDATA=str(home / 'AppData' / 'Local'), TEMP=str(base / 'tmp'), TMP=str(base / 'tmp'), TMPDIR=str(base / 'tmp'),
               GEMINI_API_KEY='fake-key', GOOGLE_GEMINI_BASE_URL=f'http://127.0.0.1:{port}', GEMINI_CLI_TRUST_WORKSPACE='true',
               GEMINI_CLI_AUTH_OVERRIDE='gemini-api-key', NO_BROWSER='1', CI='1')
    args = ['node', str(entry), '-m', 'gemini-2.5-flash', '--approval-mode', 'yolo', '--skip-trust']
    args += ['--acp'] if acp else ['-p', f'GX-PARENT-{RUN} go', '-o', 'json']
    wt = base / 'wt' / 'sub1'
    state = base / 'subagent-inflight.json'
    if name.startswith('policy'):
        # The TOML table is [[rule]] (toml-loader.ts PolicySchema), not [[rules]]: an unknown table is silently ignored.
        # policy-all: the same rule with no subagent scope (it must block the parent too).
        pol = base / 'admin-policy'
        pol.mkdir()
        scope = '' if name == 'policy-all' else 'subagent = "generalist"\n'
        (pol / 'aib.toml').write_text(f'[[rule]]\ntoolName = "write_file"\n{scope}decision = "deny"\npriority = 900\n'
                                      'denyMessage = "AIB: subagents may not edit the main folder"\n', encoding='utf-8')
        args += ['--admin-policy', str(pol)]
    if name in ('log', 'redirect', 'deny'):
        git(project, 'worktree', 'add', '-q', '-b', 'aib/sub1', str(wt))
        hook = f'node "{HERE / "gemini_hook_probe.js"}" "{base / "hooks.log"}" "{wt}" {name} "{state}"'
        hk = [{'matcher': '.*', 'hooks': [{'type': 'command', 'command': hook, 'timeout': 30000}]}]
        # Hooks ride in the per-session home's user settings (GEMINI_CLI_HOME/.gemini/settings.json). The system settings file
        # (GEMINI_CLI_SYSTEM_SETTINGS_PATH) is skipped unless its folder is owned by an administrator/root, so AIB can't use it.
        (home / '.gemini').mkdir()
        (home / '.gemini' / 'settings.json').write_text(json.dumps({'hooks': {'BeforeTool': hk, 'AfterTool': hk}}), encoding='utf-8')
        args += ['--include-directories', str(wt)]
    try:
        if acp:
            result = acp_drive(args, project, env, state)
        else:
            out = subprocess.run(args, cwd=project, capture_output=True, text=True, timeout=180, env=env, creationflags=NO_WINDOW,
                                 stdin=subprocess.DEVNULL, encoding='utf-8', errors='replace')
            result = {'exit': out.returncode, 'stdout': out.stdout[-2500:], 'stderr': out.stderr[-2500:]}
    except subprocess.TimeoutExpired:
        result = {'exit': 'timeout'}
    finally:
        stub.stdin.close()
        stub.wait(timeout=10)
    jl = lambda p: [json.loads(x) for x in p.read_text(encoding='utf-8').splitlines() if x.strip()] if p.is_file() else None  # noqa: E731
    return {'scenario': name, 'acp': acp, 'run': result,
            'parent_file_in_main': (project / 'parent-made.txt').is_file(),
            'sub_file_in_main': (project / 'sub-made.txt').is_file(),
            'sub_file_in_worktree': (wt / 'sub-made.txt').is_file(),
            'main_status': git(project, 'status', '--porcelain'),
            'worktree_status': git(wt, 'status', '--porcelain') if wt.is_dir() else None,
            'stub_log': jl(base / 'stub.log'), 'hook_log': jl(base / 'hooks.log')}


def main():
    argv = [a for a in sys.argv[1:] if a != '--acp']
    acp = '--acp' in sys.argv
    entry = pathlib.Path(argv[0]).resolve()
    scratch = pathlib.Path(argv[1]).resolve()
    scratch.mkdir(parents=True, exist_ok=True)
    before = owner_state()
    reports = []
    for name in argv[2:]:
        try:
            reports.append(scenario(entry, scratch / f'gemini-{name}{"-acp" if acp else ""}-{RUN}', name, acp))
        except Exception as err:  # a probe reports, it does not stop
            reports.append({'scenario': name, 'error': repr(err)})
    after = owner_state()
    report = {'run': RUN, 'gemini': str(entry), 'scenarios': reports,
              'owner_changed': sorted(k for k in set(before) | set(after) if before.get(k) != after.get(k))}
    out = scratch / f'gemini-report-{RUN}.json'
    out.write_text(json.dumps(report, indent=1), encoding='utf-8')
    print(out)


if __name__ == '__main__':
    main()
