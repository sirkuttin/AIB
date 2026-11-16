"""Can AIB put a Codex subagent in its own git worktree? Truth checks against the REAL codex-acp / codex app-server.

Not a unit test: a probe that prints one JSON report path. Same set-up as work/p0_subagent_worktree_probe.py (whose helpers it
reuses): AIB's own codex-acp (AIB_CODEX_ACP, else the global npm install, else %LOCALAPPDATA%\\AgentStudio\\agents\\codex, read
only), the stub model API in script mode (work/stub_model_api.js, namespaced Responses tools), TEMP config only (CODEX_HOME,
HOME, USERPROFILE, APPDATA, LOCALAPPDATA, XDG_*, TEMP/TMP all inside the scratch folder).

    python work/cx_codex_subagent_probe.py <scratch> <scenario...>

Scenarios
  hooks-list   AIB's hooks passed the codex-acp way (`-c hooks={...}` on `codex app-server`): are they loaded, and trusted?
               Prints each hook's key and currentHash (a hook from a config layer only runs once trusted).
  spawn-log    The parent calls multi_agent_v1.spawn_agent; the subagent runs exec_command (writes sub-made.txt, prints its
               folder). Hooks (trusted through hooks.state in the same CODEX_CONFIG) only log: which events fire, with which
               agent_id / cwd, for the parent's spawn_agent and the subagent's own calls. Where does the file land?
  spawn-redirect  The same, the hook rewrites the subagent's exec_command into a worktree AIB made (updatedInput) and tells
               it about the worktree at SubagentStart (additionalContext). Does the file land in the worktree?
  spawn-deny   The same, the hook denies the subagent's exec_command. Does anything land in the main folder?
Owner guard: before and after, the owner's ~/.codex sessions and config files, ~/.claude/projects and ~/.gemini mtimes are checked.
"""
import json
import os
import pathlib
import subprocess
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import p0_subagent_worktree_probe as p0  # noqa: E402

HERE = p0.HERE
CODEX_EXE = None
if p0.CODEX_ACP:
    pkg_root = p0.CODEX_ACP.parents[3]  # .../node_modules/@agentclientprotocol/codex-acp/dist/index.js -> node_modules
    found = sorted(pkg_root.glob('@openai/codex-*/vendor/*/bin/codex.exe')) or sorted(pkg_root.glob('@openai/codex-*/vendor/*/bin/codex'))
    CODEX_EXE = found[0] if found else None


def gemini_snapshot():
    g = pathlib.Path(os.path.expanduser('~')) / '.gemini'
    return {str(f): f.stat().st_mtime for f in g.rglob('*') if f.is_file()} if g.is_dir() else {}


def write_config(base, port, model='stub-model'):
    (base / 'codex' / 'config.toml').write_text(
        f'model = "{model}"\nmodel_provider = "stub"\napproval_policy = "never"\nsandbox_mode = "danger-full-access"\n'
        'approvals_reviewer = "user"\ncheck_for_update_on_startup = false\n\n[model_providers.stub]\nname = "stub"\n'
        f'base_url = "http://127.0.0.1:{port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n\n'
        '[analytics]\nenabled = false\n', encoding='utf-8')


def hook_cmd(base, *flags):
    # Codex runs a hook command with `cmd.exe /C` on Windows: a line that starts with a quote loses its outer quotes, so the
    # program is the bare `node` (on PATH) and only the arguments are quoted.
    parts = [str(HERE / 'codex_hook_probe.js'), str(base / 'hooks.log'), *flags]
    return 'node ' + ' '.join(f'"{x}"' for x in parts)


def hooks_block(base, *flags):
    entry = lambda matcher=None: [{**({'matcher': matcher} if matcher else {}), 'hooks': [{'type': 'command', 'command': hook_cmd(base, *flags), 'timeout': 30}]}]
    return {'PreToolUse': entry('.*'), 'SubagentStart': entry(), 'SubagentStop': entry()}


def list_hooks(base, env, project, hooks):
    """hooks/list on a real app-server started the way codex-acp starts it with CODEX_CONFIG.hooks."""
    import importlib  # noqa: F401  (keep the probe single-file friendly)
    arg = 'hooks=' + toml_inline(hooks)
    out = subprocess.run([p0.NODE, str(HERE / 'codex_hooks_list.js'), str(CODEX_EXE), str(project), '-c', arg],
                         capture_output=True, text=True, timeout=60, env=env, creationflags=p0.NO_WINDOW, stdin=subprocess.DEVNULL)
    try:
        return json.loads(out.stdout.strip().splitlines()[-1])
    except Exception:
        return {'error': 'no output', 'stdout': out.stdout[-800:], 'stderr': out.stderr[-800:]}


def toml_inline(value):
    """The same TOML inline form codex-acp's configOverride() writes."""
    if isinstance(value, list):
        return '[' + ', '.join(toml_inline(v) for v in value) + ']'
    if isinstance(value, dict):
        return '{ ' + ', '.join(f'{json.dumps(k)} = {toml_inline(v)}' for k, v in value.items()) + ' }'
    return json.dumps(value)


def flat_hooks(listing):
    out = []
    for group in (listing or {}).get('data', []) if isinstance(listing, dict) else []:
        for h in group.get('hooks', []):
            out.append({k: h.get(k) for k in ('key', 'eventName', 'source', 'currentHash', 'trustStatus', 'enabled')})
    return out


def trusted_hooks(base, env, project, hooks):
    """hooks + hooks.state.<key>.trusted_hash for every hook the app-server lists, so they run without a trust prompt."""
    listing = list_hooks(base, env, project, hooks)
    state = {h['key']: {'trusted_hash': h['currentHash']} for h in flat_hooks(listing) if h.get('key') and h.get('currentHash')}
    return {**hooks, 'state': state}, listing


def spawn_rules(cmd):
    return [
        {'when': 'CX-PARENT go', 'reply': {'tools': [{'id': 'call_pSpawn01', 'name': 'multi_agent_v1.spawn_agent',
                                                       'input': {'message': 'CX-SUB task: make the file'}}]}},
        {'when': 'CX-SUB task', 'reply': {'tools': [{'id': 'call_sExec01', 'name': 'exec_command', 'input': {'cmd': cmd}}]}},
        {'when': 'call_sExec01', 'reply': {'text': 'SUB-DONE'}},
        {'when': 'call_pSpawn01', 'capture': r'agent_id\W{1,6}([0-9a-f-]{8,})',
         'reply': {'tools': [{'id': 'call_pWait01', 'name': 'multi_agent_v1.wait_agent', 'input': {'targets': ['@CAP@'], 'timeout_ms': 30000}}]}},
        {'when': 'call_pWait01', 'reply': {'text': 'PARENT-DONE'}},
    ]


def spawn_scenario(base, name, mode):
    base.mkdir(parents=True)
    project = p0.make_repo(base / 'proj')
    wt = base / 'wt' / 'sub1'
    if mode == 'redirect':
        p0.git(project, 'worktree', 'add', '-q', '-b', 'aib/sub1', str(wt))
    script = base / 'script.json'
    cmd = 'Set-Content -Path sub-made.txt -Value SUB; (Get-Location).Path'
    script.write_text(json.dumps({'rules': spawn_rules(cmd)}), encoding='utf-8')
    (base / 'dump').mkdir()
    stub = p0.Proc([p0.NODE, str(HERE / 'stub_model_api.js'), '--port', '0', '--log', str(base / 'stub.log'), '--stdin',
                    '--script', str(script), '--dump', str(base / 'dump')], 'STUB_PORT')
    env = p0.temp_env(base, f'http://127.0.0.1:{stub.port}')
    write_config(base, stub.port)
    flags = {'log': (), 'redirect': ('--worktree', str(wt)), 'deny': ('--deny-subagent',)}[mode]
    hooks, listing = trusted_hooks(base, env, project, hooks_block(base, *flags))
    env['CODEX_CONFIG'] = json.dumps({'hooks': hooks})
    try:
        out = subprocess.run([p0.NODE, str(HERE / 'acp_probe.js'), '--events', str(base / 'events.log'), '--allow', '--mode', 'agent-full-access', str(p0.CODEX_ACP),
                              'new', str(project), f'CX-PARENT go {p0.RUN_MARK}'],
                             capture_output=True, text=True, timeout=240, env=env, creationflags=p0.NO_WINDOW, stdin=subprocess.DEVNULL)
        probe = out.stdout.strip().splitlines()[-1:] or [out.stderr[-1500:]]
    except subprocess.TimeoutExpired:
        probe = ['timeout']
    stub.stop()
    calls = [x for x in p0.lines(base / 'stub.log') if x['path'].endswith('/responses')]
    return {
        'scenario': name, 'probe': probe,
        'hooks_listed': flat_hooks(listing) or listing,
        'responses_calls': [{'rule': c.get('rule'), 'tools': c.get('tools'), 'last': (c.get('last') or '')[-300:]} for c in calls],
        'hook_log': p0.lines(base / 'hooks.log'),
        'file_in_main': (project / 'sub-made.txt').is_file(),
        'file_in_worktree': (wt / 'sub-made.txt').is_file(),
        'main_status': p0.git(project, 'status', '--porcelain'),
    }


def hooks_list_scenario(base, name):
    base.mkdir(parents=True)
    project = p0.make_repo(base / 'proj')
    env = p0.temp_env(base, 'http://127.0.0.1:9/')
    write_config(base, 9)
    hooks = hooks_block(base)
    first = list_hooks(base, env, project, hooks)
    trusted, _ = trusted_hooks(base, env, project, hooks)
    second = list_hooks(base, env, project, trusted)
    return {'scenario': name, 'codex_exe': str(CODEX_EXE), 'untrusted': flat_hooks(first) or first,
            'with_state': flat_hooks(second) or second}


SCENARIOS = {
    'hooks-list': lambda b: hooks_list_scenario(b, 'hooks-list'),
    'spawn-log': lambda b: spawn_scenario(b, 'spawn-log', 'log'),
    'spawn-redirect': lambda b: spawn_scenario(b, 'spawn-redirect', 'redirect'),
    'spawn-deny': lambda b: spawn_scenario(b, 'spawn-deny', 'deny'),
}


def main():
    scratch = pathlib.Path(sys.argv[1]).resolve()
    scratch.mkdir(parents=True, exist_ok=True)
    before, gem_before = p0.owner_snapshot(), gemini_snapshot()
    reports = []
    for name in sys.argv[2:]:
        try:
            reports.append(SCENARIOS[name](scratch / f'{name}-{p0.RUN}'))
        except Exception as err:  # a probe reports, it does not stop
            reports.append({'scenario': name, 'error': repr(err)})
    gem_after = gemini_snapshot()
    report = {'run': p0.RUN, 'codex_acp': str(p0.CODEX_ACP), 'codex_exe': str(CODEX_EXE), 'scenarios': reports,
              'owner': {**p0.owner_check(before, scratch),
                        'gemini_changed': sorted(k for k in set(gem_before) | set(gem_after) if gem_before.get(k) != gem_after.get(k))}}
    out = scratch / f'report-{p0.RUN}.json'
    out.write_text(json.dumps(report, indent=1), encoding='utf-8')
    print(out)


if __name__ == '__main__':
    main()
