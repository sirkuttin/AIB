"""P0 of "subagents work in their own worktree": truth checks against the REAL Claude Code / Codex ACP adapters.

Not a unit test: a probe that prints one JSON report per scenario. Real adapters (AIB_CLAUDE_ACP / AIB_CODEX_ACP, else the global
npm install; Codex also from AIB's own agents folder, read only), the stub model API in script mode, a hook recorder, and TEMP
config only: CLAUDE_CONFIG_DIR, CODEX_HOME, HOME, USERPROFILE, APPDATA, LOCALAPPDATA and XDG_* all point into a scratch folder.

    python work/p0_subagent_worktree_probe.py <scratch-dir> <scenario> [<scenario> ...]

Scenarios: aib-hooks, claude-own, user-hook, user-hook-slow, aib-hooks-bypass, wt-fail, hooks-off, background, codex-tools, codex-off, codex-agents-off.
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


def hooks_settings(url, events=('PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'WorktreeCreate', 'WorktreeRemove')):
    out = {}
    for ev in events:
        entry = {'hooks': [{'type': 'http', 'url': f'{url}/hooks/{ev}', 'timeout': 60}]}
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


def claude_scenario(base, name, rules, meta_settings=None, user_settings=None, recorder=(), prompt='P0-PARENT go'):
    base.mkdir(parents=True)
    script = base / 'script.json'
    (base / 'dump').mkdir()
    project = make_repo(base / 'proj')
    # fill paths into the rules
    text = json.dumps({'rules': rules}).replace('@MAINF@', project.as_posix()).replace('@MAIN@', str(project).replace('\\', '\\\\'))
    script.write_text(text, encoding='utf-8')
    stub = Proc([NODE, str(HERE / 'stub_model_api.js'), '--port', '0', '--log', str(base / 'stub.log'), '--stdin', '--script', str(script), '--dump', str(base / 'dump')], 'STUB_PORT')
    hooks = Proc([NODE, str(HERE / 'hook_recorder.js'), '--log', str(base / 'hooks.log'), '--stdin', *recorder], 'HOOKS_PORT')
    env = temp_env(base, f'http://127.0.0.1:{stub.port}')
    hook_url = f'http://127.0.0.1:{hooks.port}'
    if user_settings is not None:
        s = json.dumps(user_settings).replace('@HOOKS@', hook_url).replace('@BASE@', str(base).replace('\\', '/'))
        (base / 'claude' / 'settings.json').write_text(s, encoding='utf-8')
    probe_args = ['--allow', '--events', str(base / 'events.log')]
    if meta_settings is not None:
        settings = json.loads(json.dumps(meta_settings).replace('@HOOKS@', hook_url))
        (base / 'meta.json').write_text(json.dumps({'claudeCode': {'options': {'settings': settings}}}), encoding='utf-8')
        probe_args += ['--meta', str(base / 'meta.json')]
    try:
        out = subprocess.run([NODE, str(HERE / 'acp_probe.js'), *probe_args, str(CLAUDE_ACP), 'new', str(project), f'{prompt} {RUN_MARK}'],
                             capture_output=True, text=True, timeout=300, env=env, creationflags=NO_WINDOW, stdin=subprocess.DEVNULL)
        probe = out.stdout.strip().splitlines()[-1:] or [out.stderr[-1500:]]
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
    return {
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


SCENARIOS = {
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
