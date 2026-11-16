"""Can AIB fence or redirect a Gemini CLI subagent? Truth checks against the REAL Gemini CLI, no account and no network.

    python work/cx_gemini_subagent_probe.py <gemini entry .js> <scratch> <scenario...>

<gemini entry> is a Gemini CLI install's bundle (e.g. <prefix>/node_modules/@google/gemini-cli/bundle/gemini.js), installed into a
scratch prefix, never globally. The model is Gemini's own hidden `--fake-responses <jsonl>` replay (as its integration tests use);
GEMINI_API_KEY is fake. TEMP config only: GEMINI_CLI_HOME, HOME, USERPROFILE, APPDATA, LOCALAPPDATA, TEMP/TMP in the scratch folder.

Every scenario plays: the main agent calls invoke_agent(generalist); the subagent calls write_file("sub-made.txt") (a relative
path, so it resolves against the session folder), then complete_task; the main agent answers.
  log       no fence: where does the file land?
  policy    `--admin-policy <dir>` with a rule {toolName = "write_file", subagent = "generalist", decision = "deny"}.
  hook      a BeforeTool hook (in a system settings file named by GEMINI_CLI_SYSTEM_SETTINGS_PATH) rewrites write_file's
            file_path into a worktree AIB made (hookSpecificOutput.tool_input); the worktree is added with --include-directories.
Owner guard: mtimes of everything under the owner's ~/.gemini before and after.
"""
import json
import os
import pathlib
import subprocess
import sys
import uuid

HERE = pathlib.Path(__file__).resolve().parent
NO_WINDOW = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
RUN = uuid.uuid4().hex[:8]


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


def stream(parts):
    return {'method': 'generateContentStream', 'response': [{'candidates': [{'content': {'parts': parts, 'role': 'model'},
            'finishReason': 'STOP', 'index': 0}], 'usageMetadata': {'promptTokenCount': 10, 'candidatesTokenCount': 5, 'totalTokenCount': 15}}]}


def fake_responses():
    return [
        stream([{'functionCall': {'name': 'invoke_agent', 'args': {'agent_name': 'generalist', 'prompt': 'GX-SUB make the file'}}}]),
        stream([{'functionCall': {'name': 'write_file', 'args': {'file_path': 'sub-made.txt', 'content': 'SUB\n'}}}]),
        stream([{'functionCall': {'name': 'complete_task', 'args': {'result': 'SUB-DONE'}}}]),
        stream([{'text': 'PARENT-DONE'}]),
    ]


def owner_gemini():
    g = pathlib.Path(os.path.expanduser('~')) / '.gemini'
    return {str(f): f.stat().st_mtime for f in g.rglob('*') if f.is_file()} if g.is_dir() else {}


def scenario(entry, base, name):
    base.mkdir(parents=True)
    project = make_repo(base / 'proj')
    home = base / 'home'
    (home / 'AppData' / 'Roaming').mkdir(parents=True)
    (home / 'AppData' / 'Local').mkdir(parents=True)
    (base / 'tmp').mkdir()
    fake = base / 'fake.jsonl'
    fake.write_text('\n'.join(json.dumps(r) for r in fake_responses()) + '\n', encoding='utf-8')
    env = dict(os.environ)
    for k in ('GOOGLE_API_KEY', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_GEMINI_BASE_URL'):
        env.pop(k, None)
    env.update(GEMINI_CLI_HOME=str(home), HOME=str(home), USERPROFILE=str(home), APPDATA=str(home / 'AppData' / 'Roaming'),
               LOCALAPPDATA=str(home / 'AppData' / 'Local'), TEMP=str(base / 'tmp'), TMP=str(base / 'tmp'), TMPDIR=str(base / 'tmp'),
               GEMINI_API_KEY='fake-key', GEMINI_CLI_TRUST_WORKSPACE='true', NO_BROWSER='1', CI='1')
    args = ['node', str(entry), '-p', 'GX-PARENT go', '--approval-mode', 'yolo', '--skip-trust', '-o', 'json',
            '--fake-responses-non-strict', str(fake)]  # non-strict: the router's generateContent call must not eat a turn
    wt = base / 'wt' / 'sub1'
    if name == 'policy':
        pol = base / 'admin-policy'
        pol.mkdir()
        (pol / 'aib.toml').write_text('[[rules]]\ntoolName = "write_file"\nsubagent = "generalist"\ndecision = "deny"\npriority = 900\n'
                                      'denyMessage = "AIB: subagents may not edit the main folder"\n', encoding='utf-8')
        args += ['--admin-policy', str(pol)]
    if name == 'hook':
        git(project, 'worktree', 'add', '-q', '-b', 'aib/sub1', str(wt))
        hook = f'node "{HERE / "gemini_hook_probe.js"}" "{base / "hooks.log"}" "{wt}"'
        settings = base / 'aib-system-settings.json'
        settings.write_text(json.dumps({'hooks': {'BeforeTool': [{'matcher': 'write_file', 'hooks': [{'type': 'command', 'command': hook, 'timeout': 30000}]}]}}),
                            encoding='utf-8')
        env['GEMINI_CLI_SYSTEM_SETTINGS_PATH'] = str(settings)
        args += ['--include-directories', str(wt)]
    try:
        out = subprocess.run(args, cwd=project, capture_output=True, text=True, timeout=180, env=env, creationflags=NO_WINDOW,
                             stdin=subprocess.DEVNULL, encoding='utf-8', errors='replace')
        result = {'exit': out.returncode, 'stdout': out.stdout[-2500:], 'stderr': out.stderr[-2500:]}
    except subprocess.TimeoutExpired:
        result = {'exit': 'timeout'}
    hooks_log = base / 'hooks.log'
    return {'scenario': name, 'run': result, 'file_in_main': (project / 'sub-made.txt').is_file(),
            'file_in_worktree': (wt / 'sub-made.txt').is_file(), 'main_status': git(project, 'status', '--porcelain'),
            'hook_log': [json.loads(x) for x in hooks_log.read_text(encoding='utf-8').splitlines() if x.strip()] if hooks_log.is_file() else None}


def main():
    entry = pathlib.Path(sys.argv[1]).resolve()
    scratch = pathlib.Path(sys.argv[2]).resolve()
    scratch.mkdir(parents=True, exist_ok=True)
    before = owner_gemini()
    reports = []
    for name in sys.argv[3:]:
        try:
            reports.append(scenario(entry, scratch / f'gemini-{name}-{RUN}', name))
        except Exception as err:  # a probe reports, it does not stop
            reports.append({'scenario': name, 'error': repr(err)})
    after = owner_gemini()
    report = {'run': RUN, 'gemini': str(entry), 'scenarios': reports,
              'owner_gemini_changed': sorted(k for k in set(before) | set(after) if before.get(k) != after.get(k))}
    out = scratch / f'gemini-report-{RUN}.json'
    out.write_text(json.dumps(report, indent=1), encoding='utf-8')
    print(out)


if __name__ == '__main__':
    main()
