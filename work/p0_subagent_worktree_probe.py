"""P0 of "subagents work in their own worktree": truth checks against the REAL Claude Code / Codex ACP adapters.

Not a unit test: a probe that prints one JSON report per scenario. Real adapters (AIB_CLAUDE_ACP / AIB_CODEX_ACP, else the global
npm install; Codex also from AIB's own agents folder, read only), the stub model API in script mode, a hook recorder, and TEMP
config only: CLAUDE_CONFIG_DIR, CODEX_HOME, HOME, USERPROFILE, APPDATA, LOCALAPPDATA and XDG_* all point into a scratch folder.

    python work/p0_subagent_worktree_probe.py <scratch-dir> <scenario> [<scenario> ...]

Scenarios: aib-hooks, claude-own, user-hook, user-hook-slow, aib-hooks-bypass, wt-fail, hooks-off, background, codex-tools, codex-off, codex-agents-off.
P0b: http-refused, http-refused-wt, http-5xx-pre, http-timeout-pre, cmd-exit2-pre, cmd-exit2-wt, cmd-ok, perm-default, perm-accept,
perm-accept-mode, bypass-mode, deny-tools, workflow-agents, continue, fwd-ok, fwd-down, hook-cost, wt-timing, junction, junction-safe.
fwd-ok / fwd-down / hook-cost need <worktree>/.p0b-scratch/fwd.exe, built from work/p0b_forwarder.go. Run with TEMP/TMP/TMPDIR pointed
into the scratch folder too (Claude Code writes task output under %TEMP%/claude; _isolation's temp state folder uses TEMP).
Owner guard: before and after, the owner's ~/.claude/projects and ~/.codex/sessions are listed; the report names any new entry
that mentions this run's id or scratch path (there must be none).
"""
import _isolation  # noqa: F401  (test isolation first)
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import time
import uuid

HERE = pathlib.Path(__file__).resolve().parent
NODE = shutil.which('node')
NO_WINDOW = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
RUN = uuid.uuid4().hex[:8]


def npm_root():
    npm = shutil.which('npm')
    out = subprocess.run([npm, 'root', '-g'], capture_output=True, text=True, timeout=20, creationflags=NO_WINDOW, shell=os.name == 'nt')
    return pathlib.Path(out.stdout.strip())


def adapter(env_name, package, extra=()):
    if os.environ.get(env_name):
        return pathlib.Path(os.environ[env_name])
    for root in [npm_root(), *extra]:
        entry = root / package / 'dist' / 'index.js'
        if entry.is_file():
            return entry
    return None


LOCAL = pathlib.Path(os.environ.get('LOCALAPPDATA', '')) / 'AgentStudio' / 'agents' / 'codex'
CLAUDE_ACP = adapter('AIB_CLAUDE_ACP', '@agentclientprotocol/claude-agent-acp')
CODEX_ACP = adapter('AIB_CODEX_ACP', '@agentclientprotocol/codex-acp', [d / 'node_modules' for d in sorted(LOCAL.glob('*'))] if LOCAL.is_dir() else [])


def git(cwd, *args):
    out = subprocess.run(['git', *args], cwd=cwd, capture_output=True, text=True, creationflags=NO_WINDOW)
    return out.stdout.strip()


def owner_snapshot():
    home = pathlib.Path(os.path.expanduser('~'))
    projects = home / '.claude' / 'projects'
    sessions = home / '.codex' / 'sessions'
    return {
        'projects': set(p.name for p in projects.iterdir()) if projects.is_dir() else set(),
        'sessions': set(str(p) for p in sessions.rglob('*.jsonl')) if sessions.is_dir() else set(),
        'files': {str(f): f.stat().st_mtime for f in [home / '.claude' / 'settings.json', home / '.claude.json',
                                                      home / '.codex' / 'config.toml', home / '.codex' / 'hooks.json'] if f.is_file()},
    }


def owner_check(before, scratch):
    """New owner entries that mention this run (its id or scratch folder). Must be empty."""
    after = owner_snapshot()
    home = pathlib.Path(os.path.expanduser('~'))
    needles = [RUN, str(scratch), str(scratch).replace('\\', '/'), re.sub(r'[^A-Za-z0-9]', '-', str(scratch))]
    hits = []
    for name in after['projects'] - before['projects']:
        if any(n in name for n in needles):
            hits.append(f'~/.claude/projects/{name}')
    # Folders the owner's own sessions touched during the run: their newest files must not mention us either.
    for name in after['projects']:
        folder = home / '.claude' / 'projects' / name
        for f in folder.glob('*.jsonl'):
            try:
                if f.stat().st_mtime < START:
                    continue
                text = f.read_text(encoding='utf-8', errors='replace')
            except OSError:
                continue
            if any(n in text for n in needles[:2]) and RUN_MARK in text and 'p0_subagent_worktree_probe' not in text:
                hits.append(str(f))
    for path in after['sessions'] - before['sessions']:
        text = pathlib.Path(path).read_text(encoding='utf-8', errors='replace')
        if any(n in text for n in needles):
            hits.append(path)
    changed = [f for f, m in after['files'].items() if before['files'].get(f) != m]
    return {'new_projects': sorted(after['projects'] - before['projects']), 'new_codex_sessions': len(after['sessions'] - before['sessions']),
            'mentions_this_run': hits, 'owner_config_files_changed': changed}


START = time.time()
RUN_MARK = f'P0RUN-{RUN}'


class Proc:
    def __init__(self, args, ready, env=None):
        self.p = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
                                  creationflags=NO_WINDOW, env=env)
        line = self.p.stdout.readline()
        m = re.match(ready + r'=(\d+)', line)
        if not m:
            raise RuntimeError(f'{args[1]} did not start: {line!r}')
        self.port = int(m.group(1))

    def stop(self):
        try:
            self.p.stdin.close()
            self.p.wait(5)
        except Exception:
            self.p.kill()


def lines(path):
    p = pathlib.Path(path)
    return [json.loads(x) for x in p.read_text(encoding='utf-8').splitlines() if x.strip()] if p.is_file() else []


def make_repo(folder):
    folder.mkdir(parents=True)
    git(folder, 'init', '-b', 'main')
    git(folder, 'config', 'user.name', 'p0')
    git(folder, 'config', 'user.email', 'p0@example.invalid')
    git(folder, 'config', 'core.autocrlf', 'false')
    (folder / 'tracked.txt').write_text('one\n', encoding='utf-8')
    git(folder, 'add', '-A')
    git(folder, 'commit', '-m', 'first')
    # an uncommitted edit, to see whether a subagent's copy has it
    (folder / 'tracked.txt').write_text('one\nUNCOMMITTED-EDIT\n', encoding='utf-8')
    return folder


def temp_env(base, stub_url):
    home = base / 'home'
    for sub in ('claude', 'codex', 'home', 'home/AppData/Roaming', 'home/AppData/Local'):
        (base / sub).mkdir(parents=True, exist_ok=True)
    env = dict(os.environ)
    for name in ('ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BEDROCK_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
                 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'OPENAI_API_KEY'):
        env.pop(name, None)
    for name in ('HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'):
        env[name] = str(home)
    env['APPDATA'] = str(home / 'AppData' / 'Roaming')
    env['LOCALAPPDATA'] = str(home / 'AppData' / 'Local')
    (base / 'tmp').mkdir(exist_ok=True)
    for name in ('TEMP', 'TMP', 'TMPDIR'):  # Claude Code puts task output files under %TEMP%/claude/<project>
        env[name] = str(base / 'tmp')
    env.update(CLAUDE_CONFIG_DIR=str(base / 'claude'), CODEX_HOME=str(base / 'codex'), ANTHROPIC_BASE_URL=stub_url,
               ANTHROPIC_API_KEY='stub-key', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1', DISABLE_AUTOUPDATER='1')
    return env


def hooks_settings(url, events=('PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'WorktreeCreate', 'WorktreeRemove'), timeout=60):
    out = {}
    for ev in events:
        entry = {'hooks': [{'type': 'http', 'url': f'{url}/hooks/{ev}', 'timeout': timeout}]}
        if ev in ('PreToolUse', 'PostToolUse'):
            entry['matcher'] = 'Agent|Task'
        out[ev] = [entry]
    return out


def summarize_events(events):
    calls = []
    for e in events:
        u = (e.get('update') or {}).get('update') or {}
        kind = u.get('sessionUpdate')
        if kind in ('tool_call', 'tool_call_update'):
            meta = u.get('_meta') or {}
            cc = meta.get('claudeCode') or {}
            calls.append({k: v for k, v in {
                'kind': kind, 'id': u.get('toolCallId'), 'title': u.get('title'), 'status': u.get('status'),
                'toolName': cc.get('toolName'), 'parent': cc.get('parentToolUseId'),
                'rawInput': u.get('rawInput'), 'toolResponse': cc.get('toolResponse'),
                'rawOutput': (json.dumps(u.get('rawOutput'))[:600] if u.get('rawOutput') is not None else None),
            }.items() if v is not None})
    return calls


def claude_scenario(base, name, rules, meta_settings=None, user_settings=None, recorder=(), prompt='P0-PARENT go', turn2=None, between=None, mode=None, address_file=None):
    base.mkdir(parents=True, exist_ok=True)
    script = base / 'script.json'
    (base / 'dump').mkdir()
    project = make_repo(base / 'proj')
    # fill paths into the rules
    wt1 = base / 'wt' / 'sub1'  # the fixed worktree path that P0b's command hook (--worktree) and the recorder (--fixed-name) make
    text = (json.dumps({'rules': rules}).replace('@MAINF@', project.as_posix()).replace('@MAIN@', str(project).replace('\\', '\\\\'))
            .replace('@WT@', str(wt1).replace('\\', '\\\\')))
    script.write_text(text, encoding='utf-8')
    stub = Proc([NODE, str(HERE / 'stub_model_api.js'), '--port', '0', '--log', str(base / 'stub.log'), '--stdin', '--script', str(script), '--dump', str(base / 'dump')], 'STUB_PORT')
    hooks = Proc([NODE, str(HERE / 'hook_recorder.js'), '--log', str(base / 'hooks.log'), '--stdin', *recorder], 'HOOKS_PORT')
    env = temp_env(base, f'http://127.0.0.1:{stub.port}')
    hook_url = f'http://127.0.0.1:{hooks.port}'
    if address_file is not None:
        address_file.write_text(hook_url + '\n', encoding='utf-8')
    if user_settings is not None:
        s = json.dumps(user_settings).replace('@HOOKS@', hook_url).replace('@BASE@', str(base).replace('\\', '/'))
        (base / 'claude' / 'settings.json').write_text(s, encoding='utf-8')
    probe_args = ['--allow', '--events', str(base / 'events.log')] + (['--mode', mode] if mode else [])
    if meta_settings is not None:
        settings = json.loads(json.dumps(meta_settings).replace('@HOOKS@', hook_url).replace('@BASE@', base.as_posix()))
        (base / 'meta.json').write_text(json.dumps({'claudeCode': {'options': {'settings': settings}}}), encoding='utf-8')
        probe_args += ['--meta', str(base / 'meta.json')]
    try:
        out = subprocess.run([NODE, str(HERE / 'acp_probe.js'), *probe_args, str(CLAUDE_ACP), 'new', str(project), f'{prompt} {RUN_MARK}'],
                             capture_output=True, text=True, timeout=300, env=env, creationflags=NO_WINDOW, stdin=subprocess.DEVNULL)
        probe = out.stdout.strip().splitlines()[-1:] or [out.stderr[-1500:]]
        t1 = time.time()
        if turn2 is not None:
            session = json.loads(probe[0]).get('sessionId')
            if between:
                probe.append({'between': between(base, project)})
            out = subprocess.run([NODE, str(HERE / 'acp_probe.js'), *probe_args, str(CLAUDE_ACP), 'load', str(project), session, f'{turn2} {RUN_MARK}'],
                                 capture_output=True, text=True, timeout=300, env=env, creationflags=NO_WINDOW, stdin=subprocess.DEVNULL)
            probe += out.stdout.strip().splitlines()[-1:] or [out.stderr[-1500:]]
    except subprocess.TimeoutExpired:
        probe = ['timeout']
    time.sleep(1)
    stub.stop()
    hooks.stop()
    hook_calls = [{'label': h['label'], 'event': h['body'].get('hook_event_name'), 'tool': h['body'].get('tool_name'),
                   'agent_id': h['body'].get('agent_id'), 'agent_type': h['body'].get('agent_type'), 'name': h['body'].get('name'),
                   'cwd': h['body'].get('cwd'), 'input': h['body'].get('tool_input'), 'resp': h['body'].get('tool_response'),
                   'via': h.get('via'), 'reply': h.get('reply'), 'error': h.get('error'), 'keys': sorted(h['body'].keys())}
                  for h in lines(base / 'hooks.log')]
    claude_wt = project / '.claude' / 'worktrees'
    events = lines(base / 'events.log')
    return {
        'permission_requests': [{'title': (e['params'].get('toolCall') or {}).get('title'), 'kind': (e['params'].get('toolCall') or {}).get('kind'),
                                 'options': [o.get('kind') for o in e['params'].get('options', [])],
                                 'rawInput': (e['params'].get('toolCall') or {}).get('rawInput')}
                                for e in events if e.get('request') == 'session/request_permission'],
        'cmd_hooks': [{k: h.get(k) for k in ('label', 'exit', 'reply', 'stderr', 'at', 'startedAt')} | {
                       'event': h['body'].get('hook_event_name'), 'tool': h['body'].get('tool_name'), 'agent_id': h['body'].get('agent_id'),
                       'name': h['body'].get('name'), 'cwd': h['body'].get('cwd'), 'input': h['body'].get('tool_input'),
                       'resp': h['body'].get('tool_response')} for h in lines(base / 'cmd-hooks.log')],
        'console_checks': lines(base / 'console.log'),
        'footprint': {'config_projects': sorted(p.name for p in (base / 'claude' / 'projects').iterdir()) if (base / 'claude' / 'projects').is_dir() else [],
                      'temp_claude': sorted(p.name for p in (base / 'tmp' / 'claude').iterdir()) if (base / 'tmp' / 'claude').is_dir() else [],
                      'subagent_transcripts': sorted(str(p.relative_to(base / 'claude')) for p in (base / 'claude' / 'projects').rglob('*.jsonl'))
                      if (base / 'claude' / 'projects').is_dir() else []},
        'wt1_files': sorted(str(p.relative_to(wt1)) for p in wt1.rglob('*') if p.is_file() and '.git' not in p.parts) if wt1.is_dir() else None,
        'scenario': name,
        'probe': probe,
        'stub': [x for x in lines(base / 'stub.log') if x['path'].endswith('/messages')],
        'hooks': hook_calls,
        'tool_calls': summarize_events(lines(base / 'events.log')),
        'git_worktrees': git(project, 'worktree', 'list', '--porcelain'),
        'git_branches': git(project, 'branch', '-a', '-vv'),
        'git_log': git(project, 'log', '--oneline', '--all'),
        'main_status': git(project, 'status', '--porcelain', '--untracked-files=all'),
        'main_files': sorted(str(p.relative_to(project)) for p in project.rglob('*') if p.is_file() and '.git' not in p.parts),
        'claude_worktrees_dir': sorted(str(p) for p in claude_wt.iterdir()) if claude_wt.is_dir() else [],
        'aib_worktrees': {str(p): sorted(x.name for x in p.iterdir()) for p in (base / 'wt').iterdir()} if (base / 'wt').is_dir() else {},
        'user_worktrees': {str(p): sorted(x.name for x in p.iterdir()) for p in (base / 'user-wt').iterdir()} if (base / 'user-wt').is_dir() else {},
    }


def sub_rules(isolation=None, background=False):
    """Parent calls Agent; the subagent writes a file in its cwd (Bash, relative), then tries to write into the main folder
    (Write, absolute), then tries `git -C <main>`, then a Bash redirect into the main folder; then both finish."""
    agent_input = {'description': 'p0 sub', 'prompt': 'SUBTASK-A: do the work', 'subagent_type': 'general-purpose',
                   'run_in_background': background}
    if isolation:
        agent_input['isolation'] = isolation
    main, fwd = '@MAIN@', '@MAINF@'
    return [
        {'when': 'P0-PARENT', 'reply': {'tools': [{'id': 'toolu_pAgent01', 'name': 'Agent', 'input': agent_input}]}},
        {'when': 'SUBTASK-A', 'reply': {'tools': [{'id': 'toolu_sBash01', 'name': 'Bash', 'input': {
            'command': 'echo from-sub > sub-a.txt && pwd && git rev-parse --abbrev-ref HEAD && cat tracked.txt', 'description': 'write in cwd'}}]}},
        {'when': 'toolu_sBash01', 'reply': {'tools': [{'id': 'toolu_sWrite02', 'name': 'Write', 'input': {
            'file_path': main + '\\escape-write.txt', 'content': 'escaped\n'}}]}},
        {'when': 'toolu_sWrite02', 'reply': {'tools': [{'id': 'toolu_sBash03', 'name': 'Bash', 'input': {
            'command': 'git -C "' + fwd + '" add -A && git -C "' + fwd + '" commit -m escape-commit',
            'description': 'git into main'}}]}},
        {'when': 'toolu_sBash03', 'reply': {'tools': [{'id': 'toolu_sBash04', 'name': 'Bash', 'input': {
            'command': 'echo redirected > "' + fwd + '/escape-redirect.txt"', 'description': 'redirect into main'}}]}},
        {'when': 'toolu_sBash04', 'reply': {'text': 'SUB-DONE'}},
        {'when': 'toolu_pAgent01', 'reply': {'text': 'PARENT-DONE'}},
    ]


def codex_scenario(base, name, codex_config=None):
    base.mkdir(parents=True)
    project = make_repo(base / 'proj')
    stub = Proc([NODE, str(HERE / 'stub_model_api.js'), '--port', '0', '--log', str(base / 'stub.log'), '--stdin'], 'STUB_PORT')
    env = temp_env(base, f'http://127.0.0.1:{stub.port}')
    (base / 'codex' / 'config.toml').write_text(
        'model = "stub-model"\nmodel_provider = "stub"\napproval_policy = "never"\nsandbox_mode = "read-only"\n'
        'check_for_update_on_startup = false\n\n[model_providers.stub]\nname = "stub"\n'
        f'base_url = "http://127.0.0.1:{stub.port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n\n'
        '[analytics]\nenabled = false\n', encoding='utf-8')
    args = ['--events', str(base / 'events.log')]
    if codex_config is not None:
        env['CODEX_CONFIG'] = json.dumps(codex_config)  # codex-acp's per-process session config (merged into every thread)
    try:
        out = subprocess.run([NODE, str(HERE / 'acp_probe.js'), *args, str(CODEX_ACP), 'new', str(project), f'hello {RUN_MARK}'],
                             capture_output=True, text=True, timeout=180, env=env, creationflags=NO_WINDOW, stdin=subprocess.DEVNULL)
        probe = out.stdout.strip().splitlines()[-1:] or [out.stderr[-1500:]]
    except subprocess.TimeoutExpired:
        probe = ['timeout']
    stub.stop()
    calls = [x for x in lines(base / 'stub.log') if x['path'].endswith('/responses')]
    return {'scenario': name, 'codex_config': codex_config, 'probe': probe, 'responses_calls': len(calls),
            'tools_offered': calls[0]['tools'] if calls else None}


# ---- P0b ---------------------------------------------------------------------------------------------------------------------
RESTARTING = "AIB is restarting; try the subagent again in a moment."


def dead_url():
    """A local URL nothing listens on (a port that was free a moment ago)."""
    import socket
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    return f'http://127.0.0.1:{port}'


def cmd(b, label, *flags):
    """A command-hook entry running work/hook_cmd_p0b.js (shaped like AIB's planned forwarder: a console program, stdin JSON)."""
    quoted = ' '.join('"' + f.replace('"', '\\"') + '"' for f in flags)
    return {'type': 'command', 'command': f'node "{(HERE / "hook_cmd_p0b.js").as_posix()}" "{(b / "cmd-hooks.log").as_posix()}" {label} {quoted}'.rstrip(),
            'timeout': 30}


def console(b, label):
    return {'type': 'command', 'command': f'"{pathlib.Path(sys.executable).as_posix()}" "{(HERE / "hook_console_check.py").as_posix()}" "{(b / "console.log").as_posix()}" {label}',
            'timeout': 30}


def cmd_hooks(b, with_console=False, pre_flags=('--force-isolation',), extra=None):
    """AIB's planned hook set, as command hooks: PreToolUse(Agent|Task) forces isolation, WorktreeCreate makes <b>/wt/sub1."""
    pre = [cmd(b, 'pre', *pre_flags)] + ([console(b, 'pre')] if with_console else [])
    wt = [cmd(b, 'wt', '--worktree', str(b / 'wt' / 'sub1'))] + ([console(b, 'wt')] if with_console else [])
    stop = [cmd(b, 'stop')] + ([console(b, 'stop')] if with_console else [])
    hooks = {'PreToolUse': [{'matcher': 'Agent|Task', 'hooks': pre}], 'WorktreeCreate': [{'hooks': wt}],
             'PostToolUse': [{'matcher': 'Agent|Task', 'hooks': [cmd(b, 'post')]}], 'SubagentStop': [{'hooks': stop}]}
    hooks.update(extra or {})
    return {'hooks': hooks}


def perm_rules():
    """The isolated subagent writes inside its own worktree three ways (Write, Read+Edit, Bash); the parent writes in the folder."""
    return [
        {'when': 'P0-PARENT', 'reply': {'tools': [{'id': 'toolu_pWrite00', 'name': 'Write', 'input': {
            'file_path': '@MAIN@\\parent-write.txt', 'content': 'parent\n'}}]}},
        {'when': 'toolu_pWrite00', 'reply': {'tools': [{'id': 'toolu_pAgent01', 'name': 'Agent', 'input': {
            'description': 'p0b perm', 'prompt': 'SUBTASK-P: edit', 'subagent_type': 'general-purpose', 'run_in_background': False}}]}},
        {'when': 'SUBTASK-P', 'reply': {'tools': [{'id': 'toolu_sWrite01', 'name': 'Write', 'input': {
            'file_path': '@WT@\\perm-write.txt', 'content': 'w\n'}}]}},
        {'when': 'toolu_sWrite01', 'reply': {'tools': [{'id': 'toolu_sRead02', 'name': 'Read', 'input': {'file_path': '@WT@\\tracked.txt'}}]}},
        {'when': 'toolu_sRead02', 'reply': {'tools': [{'id': 'toolu_sEdit03', 'name': 'Edit', 'input': {
            'file_path': '@WT@\\tracked.txt', 'old_string': 'one', 'new_string': 'one-edited'}}]}},
        {'when': 'toolu_sEdit03', 'reply': {'tools': [{'id': 'toolu_sBash04', 'name': 'Bash', 'input': {
            'command': 'echo b > perm-bash.txt && pwd', 'description': 'bash in worktree'}}]}},
        {'when': 'toolu_sBash04', 'reply': {'text': 'SUB-DONE'}},
        {'when': 'toolu_pAgent01', 'reply': {'text': 'PARENT-DONE'}},
    ]


WF_SCRIPT = ("export const meta = { name: 'p0b', description: 'p0b probe', phases: [{ title: 'one' }] }\n"
             "phase('one')\nconst r = await agent('WF-AGENT do the work', { label: 'wf1' })\nreturn r\n")


def deny_rules():
    """The parent loads EnterWorktree, calls it, then calls Workflow; AIB's PreToolUse denies both."""
    return [
        {'when': 'P0-PARENT', 'reply': {'tools': [{'id': 'toolu_pTS01', 'name': 'ToolSearch', 'input': {'query': 'select:EnterWorktree', 'max_results': 5}}]}},
        {'when': 'toolu_pTS01', 'reply': {'tools': [{'id': 'toolu_pEW02', 'name': 'EnterWorktree', 'input': {}}]}},
        {'when': 'toolu_pEW02', 'reply': {'tools': [{'id': 'toolu_pWF03', 'name': 'Workflow', 'input': {'script': WF_SCRIPT}}]}},
        {'when': 'toolu_pWF03', 'reply': {'text': 'PARENT-DONE'}},
    ]


def workflow_rules():
    """The parent runs a Workflow whose script starts one agent; that agent writes a file. Do Agent hooks / worktrees see it?"""
    return [
        {'when': 'P0-PARENT', 'reply': {'tools': [{'id': 'toolu_pWF01', 'name': 'Workflow', 'input': {'script': WF_SCRIPT}}]}},
        {'when': 'WF-AGENT', 'reply': {'tools': [{'id': 'toolu_wBash01', 'name': 'Bash', 'input': {
            'command': 'echo from-wf > wf-agent.txt && pwd', 'description': 'wf agent writes'}}]}},
        {'when': 'toolu_wBash01', 'reply': {'text': 'WF-AGENT-DONE'}},
        {'when': 'toolu_pWF01', 'reply': {'text': 'PARENT-WAITS'}},
        {'when': 'task-notification', 'reply': {'text': 'PARENT-DONE'}},
    ]


AGENT_ID = r'agentId\W{1,4}([A-Za-z0-9_-]{6,})'


def continue_rules():
    """Turn 1: an isolated subagent runs and finishes; the parent continues it with SendMessage (worktree still there).
    Turn 2 (after the driver removed the worktree): the parent continues it again."""
    sub_bash = lambda tag, i: {'tools': [{'id': f'toolu_cBash{i}', 'name': 'Bash', 'input': {
        'command': f'echo {tag} > {tag}.txt && pwd && git rev-parse --abbrev-ref HEAD', 'description': f'{tag} write'}}]}
    return [
        {'when': 'P0-PARENT', 'reply': {'tools': [{'id': 'toolu_pAgent01', 'name': 'Agent', 'input': {
            'description': 'p0b cont', 'prompt': 'SUBTASK-C: first', 'subagent_type': 'general-purpose', 'run_in_background': False}}]}},
        {'when': 'SUBTASK-C', 'reply': sub_bash('first', 1)},
        {'when': 'toolu_cBash1', 'reply': {'text': 'SUB-FIRST-DONE'}},
        {'when': 'toolu_pAgent01', 'reply': {'tools': [{'id': 'toolu_pTS02', 'name': 'ToolSearch', 'input': {'query': 'select:SendMessage', 'max_results': 5}}]}},
        {'when': 'toolu_pTS02', 'capture': AGENT_ID, 'reply': {'tools': [{'id': 'toolu_pSM03', 'name': 'SendMessage', 'input': {
            'to': '@CAP@', 'message': 'CONT-ONE go on'}}]}},
        {'when': 'CONT-ONE', 'reply': sub_bash('cont1', 2)},
        {'when': 'toolu_cBash2', 'reply': {'text': 'SUB-CONT1-DONE'}},
        {'when': 'toolu_pSM03', 'reply': {'text': 'PARENT-TURN1-DONE'}},
        # turn 2
        {'when': 'P0B-TURN2', 'reply': {'tools': [{'id': 'toolu_pTS04', 'name': 'ToolSearch', 'input': {'query': 'select:SendMessage', 'max_results': 5}}]}},
        {'when': 'toolu_pTS04', 'capture': AGENT_ID, 'reply': {'tools': [{'id': 'toolu_pSM05', 'name': 'SendMessage', 'input': {
            'to': '@CAP@', 'message': 'CONT-TWO go on'}}]}},
        {'when': 'CONT-TWO', 'reply': sub_bash('cont2', 3)},
        {'when': 'toolu_cBash3', 'reply': {'text': 'SUB-CONT2-DONE'}},
        {'when': 'toolu_pSM05', 'reply': {'text': 'PARENT-TURN2-DONE'}},
        {'when': 'task-notification', 'once': False, 'reply': {'text': 'PARENT-NOTED'}},
    ]


def remove_wt1(base, project):
    """Between turns: remove the subagent's worktree the way AIB would at turn end (worktree only, branch kept)."""
    out = subprocess.run(['git', 'worktree', 'remove', '--force', str(base / 'wt' / 'sub1')], cwd=project, capture_output=True, text=True,
                         creationflags=NO_WINDOW)
    return {'rc': out.returncode, 'err': out.stderr.strip(), 'exists_after': (base / 'wt' / 'sub1').exists()}


def worktree_timing(base):
    """P0b 9: an empty worktree of the AIB repo itself (this worktree's HEAD), timed; detached so no branch is left; then removed."""
    base.mkdir(parents=True)
    repo = HERE.parent
    where = base / 'aib-wt'
    t0 = time.perf_counter()
    add = subprocess.run(['git', 'worktree', 'add', '--detach', str(where), 'HEAD'], cwd=repo, capture_output=True, text=True, creationflags=NO_WINDOW)
    t1 = time.perf_counter()
    files = int(git(where, 'ls-files', '--', '.').count('\n') + 1) if where.is_dir() else 0
    t2 = time.perf_counter()
    # snapshot S the way snapshotCommit does it: a temp index, add -A, write-tree, commit-tree (no ref changes, no stash)
    env = dict(os.environ, GIT_INDEX_FILE=str(base / 'snap.index'))
    subprocess.run(['git', 'read-tree', 'HEAD'], cwd=repo, env=env, capture_output=True, creationflags=NO_WINDOW)
    subprocess.run(['git', 'add', '-A'], cwd=repo, env=env, capture_output=True, creationflags=NO_WINDOW)
    tree = subprocess.run(['git', 'write-tree'], cwd=repo, env=env, capture_output=True, text=True, creationflags=NO_WINDOW).stdout.strip()
    snap = subprocess.run(['git', 'commit-tree', tree, '-p', 'HEAD', '-m', 'p0b snapshot'], cwd=repo, capture_output=True, text=True, creationflags=NO_WINDOW)
    t3 = time.perf_counter()
    rm = subprocess.run(['git', 'worktree', 'remove', '--force', str(where)], cwd=repo, capture_output=True, text=True, creationflags=NO_WINDOW)
    t4 = time.perf_counter()
    return {'scenario': 'wt-timing', 'add_rc': add.returncode, 'add_err': add.stderr.strip()[-300:], 'tracked_files': files,
            'add_seconds': round(t1 - t0, 2), 'snapshot_seconds': round(t3 - t2, 2), 'snapshot_rc': snap.returncode,
            'remove_seconds': round(t4 - t3, 2), 'remove_rc': rm.returncode, 'exists_after': where.exists()}


def junction(base):
    """P0b 10: a worktree with a node_modules directory junction to the folder's node_modules; removing it keeps the target."""
    project = make_repo(base / 'proj')
    (project / '.gitignore').write_text('node_modules/\n', encoding='utf-8')
    git(project, 'add', '.gitignore')
    git(project, 'commit', '-m', 'ignore')
    target = project / 'node_modules' / 'pkg'
    target.mkdir(parents=True)
    (target / 'index.js').write_text('module.exports = 1\n', encoding='utf-8')
    where = base / 'wt' / 'j1'
    git(project, 'worktree', 'add', '-b', 'j1', str(where), 'HEAD')
    mk = subprocess.run(['cmd', '/c', 'mklink', '/J', str(where / 'node_modules'), str(project / 'node_modules')], capture_output=True, text=True,
                        creationflags=NO_WINDOW)
    status = git(where, 'status', '--porcelain', '--ignored')
    seen = (where / 'node_modules' / 'pkg' / 'index.js').is_file()
    rm = subprocess.run(['git', 'worktree', 'remove', str(where)], cwd=project, capture_output=True, text=True, creationflags=NO_WINDOW)
    rm_force = None
    if where.exists():
        rm_force = subprocess.run(['git', 'worktree', 'remove', '--force', str(where)], cwd=project, capture_output=True, text=True, creationflags=NO_WINDOW)
    return {'scenario': 'junction', 'mklink_rc': mk.returncode, 'status_in_wt': status, 'target_seen_through_junction': seen,
            'remove_rc': rm.returncode, 'remove_err': rm.stderr.strip(), 'force_rc': rm_force.returncode if rm_force else None,
            'force_err': rm_force.stderr.strip() if rm_force else None, 'wt_exists_after': where.exists(),
            'target_file_kept': (target / 'index.js').is_file()}


def junction_safe(base):
    """P0b 10b: the same, but the junction itself is removed first with Deno.remove (non-recursive), as AIB (Deno) would."""
    project = make_repo(base / 'proj')
    (project / '.gitignore').write_text('node_modules/\n', encoding='utf-8')
    git(project, 'add', '.gitignore')
    git(project, 'commit', '-m', 'ignore')
    target = project / 'node_modules' / 'pkg'
    target.mkdir(parents=True)
    (target / 'index.js').write_text('module.exports = 1\n', encoding='utf-8')
    where = base / 'wt' / 'j1'
    git(project, 'worktree', 'add', '-b', 'j1', str(where), 'HEAD')
    subprocess.run(['cmd', '/c', 'mklink', '/J', str(where / 'node_modules'), str(project / 'node_modules')], capture_output=True, creationflags=NO_WINDOW)
    script = base / 'rm_junction.ts'
    script.write_text('const p = Deno.args[0];\nconst st = Deno.lstatSync(p);\nconsole.log(JSON.stringify({ isSymlink: st.isSymlink, isDirectory: st.isDirectory }));\n'
                      'Deno.removeSync(p);\n', encoding='utf-8')
    env = dict(os.environ, DENO_DIR=str(base / 'deno-dir'), DENO_NO_UPDATE_CHECK='1')
    rm_j = subprocess.run([shutil.which('deno'), 'run', '--allow-read', '--allow-write', str(script), str(where / 'node_modules')], capture_output=True, text=True,
                          env=env, creationflags=NO_WINDOW)
    kept_after_junction_rm = (target / 'index.js').is_file()
    rm = subprocess.run(['git', 'worktree', 'remove', str(where)], cwd=project, capture_output=True, text=True, creationflags=NO_WINDOW)
    return {'scenario': 'junction-safe', 'deno_rc': rm_j.returncode, 'deno_out': rm_j.stdout.strip(), 'deno_err': rm_j.stderr.strip()[-300:],
            'target_kept_after_junction_removed': kept_after_junction_rm, 'remove_rc': rm.returncode, 'remove_err': rm.stderr.strip(),
            'wt_exists_after': where.exists(), 'target_file_kept': (target / 'index.js').is_file()}


FWD = HERE.parent / '.p0b-scratch' / 'fwd.exe'  # built from work/p0b_forwarder.go (see p0b-results.md)


def fwd_hooks(b, address_file):
    """AIB's planned hook set through the Go forwarder prototype: `fwd.exe <address-file> <event>`."""
    c = lambda ev: {'type': 'command', 'command': f'"{FWD.as_posix()}" "{address_file.as_posix()}" {ev}', 'timeout': 30}
    return {'hooks': {'PreToolUse': [{'matcher': 'Agent|Task', 'hooks': [c('pre-tool')]}], 'WorktreeCreate': [{'hooks': [c('worktree-create')]}],
                      'PostToolUse': [{'matcher': 'Agent|Task', 'hooks': [c('post-agent')]}], 'SubagentStop': [{'hooks': [c('subagent-stop')]}]}}


def fwd_scenario(b, name, up):
    """The forwarder reads the AIB address from a file: `up` = the recorder's address (AIB running), else a dead port (AIB down)."""
    b.mkdir(parents=True)
    addr = b / 'aib-address.txt'
    rules = sub_rules()
    if up:
        # the recorder's port is only known once it runs: claude_scenario writes @HOOKS@ into meta, so point the file at it there
        return claude_scenario(b, name, rules, fwd_hooks(b, addr), recorder=['--force-isolation', '--worktree-root', str(b / 'wt'), '--fixed-name', 'sub1', '--plain-worktree'],
                               address_file=addr)
    addr.write_text(dead_url() + '\n', encoding='utf-8')
    return claude_scenario(b, name, rules, fwd_hooks(b, addr))


def hook_cost(base, n=10):
    """P0b 3: what one command-hook call costs, the way Claude Code runs it (Git Bash: bash.exe -> bash.exe -> the command).
    Median of n runs each: the Go forwarder prototype to a live recorder, the same to a dead address (fail closed), and a node hook."""
    import statistics
    base.mkdir(parents=True)
    bash = pathlib.Path(r'C:\Program Files\Git\bin\bash.exe')
    hooks = Proc([NODE, str(HERE / 'hook_recorder.js'), '--log', str(base / 'hooks.log'), '--stdin'], 'HOOKS_PORT')
    (base / 'up.txt').write_text(f'http://127.0.0.1:{hooks.port}\n', encoding='utf-8')
    (base / 'down.txt').write_text(dead_url() + '\n', encoding='utf-8')
    body = json.dumps({'hook_event_name': 'PreToolUse', 'tool_name': 'Agent', 'tool_input': {'subagent_type': 'general-purpose'}, 'cwd': str(base)})
    cases = {
        'go_forwarder_up': f'"{FWD.as_posix()}" "{(base / "up.txt").as_posix()}" pre-tool',
        'go_forwarder_down': f'"{FWD.as_posix()}" "{(base / "down.txt").as_posix()}" pre-tool',
        'node_hook': f'node "{(HERE / "hook_cmd_p0b.js").as_posix()}" "{(base / "cmd-hooks.log").as_posix()}" pre',
        'bash_only': 'true',
    }
    out = {}
    for name, command in cases.items():
        times, codes = [], set()
        for _ in range(n):
            t0 = time.perf_counter()
            r = subprocess.run([str(bash), '-c', command], input=body, capture_output=True, text=True, creationflags=NO_WINDOW)
            times.append((time.perf_counter() - t0) * 1000)
            codes.add(r.returncode)
        out[name] = {'median_ms': round(statistics.median(times)), 'max_ms': round(max(times)), 'exit_codes': sorted(codes)}
    hooks.stop()
    return {'scenario': 'hook-cost', 'runs_each': n, 'bash': str(bash), 'results': out}


SCENARIOS = {
    # ---- P0b ----
    'fwd-ok': lambda b: fwd_scenario(b, 'fwd-ok', True),
    'fwd-down': lambda b: fwd_scenario(b, 'fwd-down', False),
    'junction-safe': junction_safe,
    'hook-cost': hook_cost,
    # 1. fail-open: HTTP hooks whose server is gone (AIB quit): does the editing subagent run unisolated?
    'http-refused': lambda b: claude_scenario(b, 'http-refused', sub_rules(), {'hooks': hooks_settings(dead_url())}),
    # ... and with isolation in the model's own call: does Claude Code fall back to its own worktree, or fail the call?
    'http-refused-wt': lambda b: claude_scenario(b, 'http-refused-wt', sub_rules(isolation='worktree'), {'hooks': hooks_settings(dead_url())}),
    'http-5xx-pre': lambda b: claude_scenario(b, 'http-5xx-pre', sub_rules(), {'hooks': hooks_settings('@HOOKS@')},
                                              recorder=['--fail-pre', '--worktree-root', str(b / 'wt')]),
    'http-timeout-pre': lambda b: claude_scenario(b, 'http-timeout-pre', sub_rules(), {'hooks': hooks_settings('@HOOKS@', timeout=3)},
                                                  recorder=['--delay-pre', '8000', '--force-isolation', '--worktree-root', str(b / 'wt')]),
    # 1b. command hooks exiting 2 (the forwarder's fail-closed answer)
    'cmd-exit2-pre': lambda b: claude_scenario(b, 'cmd-exit2-pre', sub_rules(), cmd_hooks(b, pre_flags=('--exit2', RESTARTING))),
    # a command hook that answers after its `timeout` (AIB slow, e.g. a big snapshot): does the tool run unisolated?
    'cmd-timeout-pre': lambda b: claude_scenario(b, 'cmd-timeout-pre', sub_rules(), cmd_hooks(b, extra={'PreToolUse': [{'matcher': 'Agent|Task', 'hooks': [
        {**cmd(b, 'pre', '--sleep', '6000', '--exit2', RESTARTING), 'timeout': 2}]}]})),
    'cmd-exit2-wt': lambda b: claude_scenario(b, 'cmd-exit2-wt', sub_rules(), {'hooks': {
        'PreToolUse': [{'matcher': 'Agent|Task', 'hooks': [cmd(b, 'pre', '--force-isolation')]}],
        'WorktreeCreate': [{'hooks': [cmd(b, 'wt', '--exit2', "AIB didn't expect this worktree")]}]}}),
    # 2, 3, 8. the whole planned command-hook set: works? console window? time per call? footprint?
    'cmd-ok': lambda b: claude_scenario(b, 'cmd-ok', sub_rules(), cmd_hooks(b, with_console=True)),
    # 4. permission prompts for the isolated subagent's edits inside its worktree
    'perm-default': lambda b: claude_scenario(b, 'perm-default', perm_rules(), {**cmd_hooks(b), 'permissions': {'defaultMode': 'default'}}),
    'perm-accept': lambda b: claude_scenario(b, 'perm-accept', perm_rules(), {**cmd_hooks(b), 'permissions': {'defaultMode': 'acceptEdits'}}),
    # the same with the mode set the way AIB sets it (ACP session/set_mode), and the P0 A4d bypass re-check
    'perm-accept-mode': lambda b: claude_scenario(b, 'perm-accept-mode', perm_rules(), cmd_hooks(b), mode='acceptEdits'),
    'bypass-mode': lambda b: claude_scenario(b, 'bypass-mode', sub_rules(), cmd_hooks(b), mode='bypassPermissions'),
    # 6. EnterWorktree and Workflow denied by PreToolUse: real tool names, and the reason reaches the parent
    'deny-tools': lambda b: claude_scenario(b, 'deny-tools', deny_rules(), cmd_hooks(b, extra={'PreToolUse': [{
        'matcher': 'Agent|Task|EnterWorktree|Workflow', 'hooks': [cmd(b, 'pre', '--force-isolation',
            '--deny', 'EnterWorktree=In AIB, chats work in the project folder. Use a subagent instead; AIB gives it its own worktree.',
            '--deny', "Workflow=Workflows aren't available in AIB chats yet, because their agents can't get their own worktree.")]}]})),
    # 6b. a Workflow's own agents: do PreToolUse(Agent) / WorktreeCreate see them? where do they write?
    'workflow-agents': lambda b: claude_scenario(b, 'workflow-agents', workflow_rules(), cmd_hooks(b, extra={'PreToolUse': [{
        'matcher': '.*', 'hooks': [cmd(b, 'pre', '--force-isolation')]}]})),
    # 5. continuing a finished subagent: same turn (worktree there), next turn after the worktree was removed
    'continue': lambda b: claude_scenario(b, 'continue', continue_rules(), cmd_hooks(b), turn2='P0B-TURN2', between=remove_wt1),
    # 9, 10. git only
    'wt-timing': worktree_timing,
    'junction': lambda b: junction(b),
    # ---- P0 ----
    # A1 A2 A3 A4 A5 A9: AIB's per-session settings carry HTTP hooks; PreToolUse forces isolation; WorktreeCreate makes the copy.
    'aib-hooks': lambda b: claude_scenario(b, 'aib-hooks', sub_rules(), {'hooks': hooks_settings('@HOOKS@')},
                                           recorder=['--force-isolation', '--worktree-root', str(b / 'wt')]),
    # Where Claude Code itself makes the worktree and branch, and its own enforcement (no AIB hooks; isolation in the call).
    'claude-own': lambda b: claude_scenario(b, 'claude-own', sub_rules(isolation='worktree'), None),
    # A6: the user's own WorktreeCreate command hook in user settings + AIB's HTTP WorktreeCreate in the session settings.
    'user-hook': lambda b: claude_scenario(
        b, 'user-hook', sub_rules(), {'hooks': hooks_settings('@HOOKS@')},
        user_settings={'hooks': {'WorktreeCreate': [{'hooks': [{'type': 'command',
                       'command': f'node "{(HERE / "hook_command.js").as_posix()}" "@BASE@/user-hooks.log" user-WorktreeCreate "@BASE@/user-wt"'}]}]}},
        recorder=['--force-isolation', '--worktree-root', str(b / 'wt')]),
    # A6b: the same, with AIB answering WorktreeCreate 2 s later than the user's hook (does the last answer win, or a tier?).
    'user-hook-slow': lambda b: claude_scenario(
        b, 'user-hook-slow', sub_rules(), {'hooks': hooks_settings('@HOOKS@')},
        user_settings={'hooks': {'WorktreeCreate': [{'hooks': [{'type': 'command',
                       'command': f'node "{(HERE / "hook_command.js").as_posix()}" "@BASE@/user-hooks.log" user-WorktreeCreate "@BASE@/user-wt"'}]}]}},
        recorder=['--force-isolation', '--worktree-root', str(b / 'wt'), '--delay-worktree', '2500']),
    # The owner's usual mode: bypassPermissions. Does the isolation check still refuse writes into the main folder?
    'aib-hooks-bypass': lambda b: claude_scenario(b, 'aib-hooks-bypass', sub_rules(),
                                                  {'hooks': hooks_settings('@HOOKS@'), 'permissions': {'defaultMode': 'bypassPermissions'}},
                                                  recorder=['--force-isolation', '--worktree-root', str(b / 'wt')]),
    # AIB cannot make the copy: what the Agent call and the parent see.
    'wt-fail': lambda b: claude_scenario(b, 'wt-fail', sub_rules(), {'hooks': hooks_settings('@HOOKS@')},
                                         recorder=['--force-isolation', '--fail-worktree']),
    # A7: the user turned hooks off.
    'hooks-off': lambda b: claude_scenario(b, 'hooks-off', sub_rules(), {'hooks': hooks_settings('@HOOKS@')},
                                           user_settings={'disableAllHooks': True},
                                           recorder=['--force-isolation', '--worktree-root', str(b / 'wt')]),
    # A8: a background Agent call.
    'background': lambda b: claude_scenario(b, 'background', sub_rules(background=True), {'hooks': hooks_settings('@HOOKS@')},
                                            recorder=['--force-isolation', '--worktree-root', str(b / 'wt')]),
    # A10: which tools Codex offers its model by default, and with its multi-agent feature switched off.
    'codex-tools': lambda b: codex_scenario(b, 'codex-tools'),
    'codex-off': lambda b: codex_scenario(b, 'codex-off', {'features': {'multi_agent': False}}),
    'codex-agents-off': lambda b: codex_scenario(b, 'codex-agents-off', {'agents': {'enabled': False}}),
}


def main():
    scratch = pathlib.Path(sys.argv[1]).resolve()
    scratch.mkdir(parents=True, exist_ok=True)
    before = owner_snapshot()
    reports = []
    for name in sys.argv[2:]:
        base = scratch / f'{name}-{RUN}'
        try:
            reports.append(SCENARIOS[name](base))
        except Exception as err:  # a probe reports, it does not stop
            reports.append({'scenario': name, 'error': repr(err)})
    report = {'run': RUN, 'claude_acp': str(CLAUDE_ACP), 'codex_acp': str(CODEX_ACP), 'scenarios': reports,
              'owner': owner_check(before, scratch)}
    out = scratch / f'report-{RUN}.json'
    out.write_text(json.dumps(report, indent=1), encoding='utf-8')
    print(out)


if __name__ == '__main__':
    main()
