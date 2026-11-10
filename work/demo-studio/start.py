"""One-command demo Studio for testing Agent Studio by hand or with a QA agent. Standard library only.

  python work/demo-studio/start.py --port 8810            fresh demo data, starts Studio in the background, prints URL and PID
  python work/demo-studio/start.py --port 8810 --keep     reuse the data from the last run (chats, pins, artifacts) if it exists
  python work/demo-studio/start.py --stop --port 8810     stops that Studio and deletes its temp folder (add --keep to keep the data)

Never touches work/agent-studio-state or ~/.claude: everything lives in one temp folder, agent-studio-demo-<port>.
Starts the Deno server (deno run -A outputs/agent-studio/server/main.ts serve --in-process ...) with no console window. Deno is
found as AIB_DENO, else `deno` on PATH. See work/demo-studio/README.md.
"""
import argparse
import base64
import json
import os
import pathlib
import re
import shutil
import socket
import stat
import struct
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zlib

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parents[1]
APP = REPO / 'outputs' / 'agent-studio'
MAIN = APP / 'server' / 'main.ts'   # the Deno server
AGENT = HERE / 'agent.py'
OWNER_PORTS = (8767, 8768, 8777, 8778)   # the owner's live Studio and the AIB desktop app (each: web server, artifact server)
DEFAULT_PORT = 8810
MARKER = '.demo-studio'             # a folder without this file is never deleted
PREFIX = 'agent-studio-demo-'
GIT_USER = ['-c', 'user.name=Demo', '-c', 'user.email=demo@example.invalid', '-c', 'commit.gpgsign=false']


# ---- arguments and refusals -------------------------------------------------------------------
def refused_port(port):
    """Why this port may not be used, or ''. The artifact server listens on port+1, so both must stay clear of the live Studio."""
    if not isinstance(port, int) or not 1 <= port <= 65534:
        return 'Port must be between 1 and 65534.'
    clash = [p for p in OWNER_PORTS if port in (p, p - 1)]
    if clash:
        return (f'Port {port} is refused: 8767/8768 belong to the live Studio and 8777/8778 to the AIB desktop app '
                f'(Studio also uses port+1 for artifacts, so 8766 and 8776 are off limits too). Try {DEFAULT_PORT}.')
    return ''


def hidden_path_reason(path):
    """Studio hides folders under .claude/worktrees or named scratch-* from "All chats", which would make the demo sidebar look empty."""
    parts = [p.lower() for p in pathlib.PurePath(str(path)).parts]
    text = '/' + '/'.join(parts) + '/'
    if '/.claude/worktrees/' in text or '/.git/worktrees/' in text or any(p.startswith('scratch-') or p == 'scratch-workspaces' for p in parts):
        return f'{path} is under a worktree or scratch folder, which Studio hides from the sidebar. Pass --dir with another parent folder.'
    return ''


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--port', type=int, default=DEFAULT_PORT, help=f'Studio port (default {DEFAULT_PORT}); port+1 is used for artifacts. 8766-8768 and 8776-8778 are refused')
    parser.add_argument('--stop', action='store_true', help='Stop the demo Studio on --port and delete its temp folder')
    parser.add_argument('--keep', action='store_true', help='Keep the demo data: reuse it on start, do not delete it on --stop')
    parser.add_argument('--dir', type=pathlib.Path, default=None, help='Parent folder for agent-studio-demo-<port> (default: the system temp folder)')
    parser.add_argument('--timeout', type=float, default=45, help='Seconds to wait for /chat.html (default 45)')
    options = parser.parse_args(argv)
    problem = refused_port(options.port)
    if problem:
        parser.error(problem)
    return options


def demo_dir(options):
    parent = pathlib.Path(options.dir) if options.dir else pathlib.Path(tempfile.gettempdir())
    return parent.resolve() / f'{PREFIX}{options.port}'


# ---- processes ---------------------------------------------------------------------------------
def alive(pid):
    if not pid:
        return False
    if os.name == 'nt':
        out = subprocess.run(['tasklist', '/FI', f'PID eq {pid}', '/FO', 'CSV', '/NH'], capture_output=True, text=True).stdout
        return f'"{pid}"' in out
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def kill_tree(pid):
    if os.name == 'nt':
        subprocess.run(['taskkill', '/PID', str(pid), '/T', '/F'], capture_output=True)
    else:
        import signal
        try:
            os.killpg(pid, signal.SIGTERM)
        except OSError:
            try:
                os.kill(pid, signal.SIGTERM)
            except OSError:
                pass
    for _ in range(50):
        if not alive(pid):
            return True
        time.sleep(0.1)
    return not alive(pid)


def find_by_command_line(port, state):
    """PIDs whose command line is this demo's Deno server (used when the PID file is gone)."""
    needle_state = str(state)
    found = []
    try:
        if os.name == 'nt':
            script = ("Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*main.ts*' } | "
                      "ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }")
            out = subprocess.run(['powershell', '-NoProfile', '-Command', script], capture_output=True, text=True).stdout
        else:
            out = subprocess.run(['ps', '-eo', 'pid=,args='], capture_output=True, text=True).stdout.replace(' ', '\t', 1)
    except OSError:
        return found
    for line in out.splitlines():
        pid, _, command = line.strip().partition('\t')
        if pid.isdigit() and needle_state in command and re.search(rf'--port\s+{port}\b', command) and int(pid) != os.getpid():
            found.append(int(pid))
    return found


def read_pid(folder):
    try:
        return int(json.loads((folder / 'studio.pid').read_text(encoding='utf-8')).get('pid') or 0)
    except (OSError, ValueError, AttributeError):
        return 0


def stop_studio(port, folder):
    """Stop the Studio recorded in the PID file (or found by command line). Returns the PIDs that were stopped."""
    pids = {read_pid(folder)} - {0}
    pids |= set(find_by_command_line(port, folder / 'state'))
    stopped = []
    for pid in sorted(pids):
        if alive(pid):
            kill_tree(pid)
            stopped.append(pid)
    return stopped


def remove_tree(folder):
    def unlock(function, path, _info):   # git objects are read-only on Windows
        os.chmod(path, stat.S_IWRITE)
        function(path)
    for attempt in range(10):
        try:
            shutil.rmtree(folder, onerror=unlock)
            return True
        except OSError:
            time.sleep(0.3)
    return not folder.exists()


def safe_to_delete(folder):
    return folder.name.startswith(PREFIX) and (folder / MARKER).is_file()


# ---- demo data ---------------------------------------------------------------------------------
def run_git(cwd, *args):
    subprocess.run(['git', *GIT_USER, *args], cwd=str(cwd), check=True, capture_output=True, text=True)


def make_repo(path, files):
    path.mkdir(parents=True, exist_ok=True)
    for name, text in files.items():
        target = path / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding='utf-8', newline='\n')
    run_git(path, 'init', '-q', '-b', 'main')
    run_git(path, 'add', '-A')
    run_git(path, 'commit', '-q', '-m', 'Initial commit')


def png_bytes(width=200, height=120):
    """A small gradient picture with blocks, as a valid PNG (no image library needed)."""
    rows = []
    for y in range(height):
        row = bytearray([0])
        for x in range(width):
            block = (x // 40 + y // 40) % 2
            row += bytes([int(255 * x / width), int(200 * y / height) + 30, 160 if block else 60])
        rows.append(bytes(row))

    def chunk(kind, data):
        body = kind + data
        return struct.pack('>I', len(data)) + body + struct.pack('>I', zlib.crc32(body) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(b''.join(rows))) + chunk(b'IEND', b'')


class Transcript:
    """Writes one saved Claude Code transcript (.jsonl) in the shape Studio's monitor reads."""

    def __init__(self, root, cwd, session, title, start, step=45):
        self.cwd, self.session, self.title, self.clock, self.step = str(cwd), session, title, start, step
        self.rows, self.n = [], 0
        self.folder = root / re.sub(r'[^A-Za-z0-9]', '-', self.cwd)

    def _row(self, kind, message, **extra):
        self.clock += self.step
        self.n += 1
        stamp = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(self.clock))
        self.rows.append(dict({'type': kind, 'sessionId': self.session, 'cwd': self.cwd, 'timestamp': stamp, 'uuid': f'{self.session}-{self.n}', 'message': message}, **extra))

    def user(self, content):
        self._row('user', {'role': 'user', 'content': content})

    def say(self, text):
        self._row('assistant', {'role': 'assistant', 'model': 'demo-model', 'content': [{'type': 'text', 'text': text}]})

    def think(self, text):
        self._row('assistant', {'role': 'assistant', 'model': 'demo-model', 'content': [{'type': 'thinking', 'thinking': text}]})

    def tool(self, name, arguments, output, error=False, extra=None, outputs=None):
        """A tool call and its result. `outputs` is a list of content blocks (for a picture); otherwise `output` is text."""
        call = f'toolu_{self.session}_{self.n + 1}'
        self._row('assistant', {'role': 'assistant', 'model': 'demo-model', 'content': [{'type': 'tool_use', 'id': call, 'name': name, 'input': arguments}]})
        block = {'type': 'tool_result', 'tool_use_id': call, 'content': outputs if outputs is not None else output}
        if error:
            block['is_error'] = True
        self._row('user', {'role': 'user', 'content': [block]}, **({'toolUseResult': extra} if extra else {}))
        return call

    def write(self):
        self.folder.mkdir(parents=True, exist_ok=True)
        rows = self.rows + [{'type': 'ai-title', 'sessionId': self.session, 'title': self.title, 'aiTitle': self.title}]
        path = self.folder / f'{self.session}.jsonl'
        path.write_text(''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in rows), encoding='utf-8')
        os.utime(path, (self.clock, self.clock))
        return path


LONG_REPLY = """Here is what I found in `api/limits.py`:

| Route | Current limit | Proposed |
| --- | --- | --- |
| `/login` | none | 5 / minute |
| `/search` | none | 30 / minute |
| `/export` | none | 2 / minute |

```python
def allow(key, now, window=60, limit=30):
    hits = [t for t in HITS.get(key, []) if now - t < window]
    HITS[key] = hits + [now]
    return len(hits) < limit
```

- the counter is per client address
- old hits are dropped on every call, so memory stays bounded
- a 429 reply carries `Retry-After`
"""


def build_chats(demo, now):
    """Writes every transcript; returns {key: (path, session id)} plus the pin/archive marks."""
    claude = demo / 'claude'
    alpha, beta = demo / 'projects' / 'alpha', demo / 'projects' / 'beta'
    hour = 3600
    chats = {}

    # A1: long chat with every kind of content. Pinned.
    t = Transcript(claude, alpha, 'demo-a1-ratelimit', 'Add rate limiting to the API', now - 30 * hour)
    t.user('Add rate limiting to the API. Keep it simple and add tests.')
    t.think('I should look at how requests are routed before choosing where the limiter goes.')
    t.say("I'll start by reading the code and writing a short plan.")
    todos = lambda a, b, c, d: {'todos': [{'content': 'Read the request handlers', 'status': a, 'activeForm': 'Reading the request handlers'},
                                          {'content': 'Add a limiter module', 'status': b, 'activeForm': 'Adding a limiter module'},
                                          {'content': 'Wire it into the routes', 'status': c, 'activeForm': 'Wiring it into the routes'},
                                          {'content': 'Write tests', 'status': d, 'activeForm': 'Writing tests'}]}
    t.tool('TodoWrite', todos('in_progress', 'pending', 'pending', 'pending'), 'Todos have been modified successfully.')
    t.tool('Read', {'file_path': str(alpha / 'app.py')}, 'def handle(request):\n    return route(request)\n')
    t.tool('Grep', {'pattern': 'def route', 'path': str(alpha)}, 'app.py:4:def route(request):')
    t.tool('Bash', {'command': 'git log --oneline -5', 'description': 'Show the five latest commits'}, 'a1b2c3d Initial commit')
    t.tool('TodoWrite', todos('completed', 'in_progress', 'pending', 'pending'), 'Todos have been modified successfully.')
    t.say(LONG_REPLY)
    t.tool('Write', {'file_path': str(alpha / 'limits.py'), 'content': 'HITS = {}\n'}, 'File created successfully at limits.py')
    for index in range(1, 9):   # a long chat: repeated edit and test cycles
        t.say(f'Cycle {index}: adjusting the window handling and running the checks again.')
        t.tool('Edit', {'file_path': str(alpha / 'limits.py'), 'old_string': f'WINDOW = {index * 10}', 'new_string': f'WINDOW = {index * 10 + 10}'}, 'The file limits.py has been updated.')
        t.tool('Bash', {'command': 'python -m unittest -q', 'description': f'Run the unit tests (round {index})'},
               'F' if index == 3 else '.' * (index + 3) + '\nOK', error=index == 3)
    t.tool('TodoWrite', todos('completed', 'completed', 'in_progress', 'pending'), 'Todos have been modified successfully.')
    t.tool('Bash', {'command': 'python -m http.server 9000', 'description': 'Start the dev server in the background', 'run_in_background': True},
           'Command running in background with ID: bg-demo-1', extra={'backgroundTaskId': 'bg-demo-1'})
    t.tool('Agent', {'description': 'Review the limiter for races', 'subagent_type': 'general-purpose', 'prompt': 'Review limits.py for race conditions.'},
           'Async agent launched successfully.\nagentId: demo-review-1 (internal ID)\nThe agent is working in the background.')
    t.tool('mcp__ccd_turn__update_plan', {'items': [{'content': 'Review the limiter', 'status': 'in_progress'}, {'content': 'Merge the change', 'status': 'pending'}], 'scope': 'first_task'}, 'ok')
    t.say('The limiter is in and the tests pass. A background review is still running.')
    t.tool('mcp__ccd_turn__wrap_up', {'recap': 'Rate limiting is added to /login, /search and /export, with tests. A review agent is still checking it for races.',
                                       'ask': 'Merge it now?', 'actions': [{'label': 'Merge'}, {'label': 'Wait for review'}]}, 'ok')
    t.say('Rate limiting is in: `/login` 5 per minute, `/search` 30 per minute, `/export` 2 per minute.')
    chats['a1'] = (t.write(), t.session)

    # A2: short chat; the one to send messages in (shares alpha with A1).
    t = Transcript(claude, alpha, 'demo-a2-live', 'Live chat: try the fixture agent', now - 5 * hour)
    t.user('Hello! Can you help me test this demo?')
    t.say('Yes. Send one of the trigger words alone as your message: `stream`, `html`, `plan`, `approve`, `form`, `wait`, `delegate` or `help`.')
    chats['a2'] = (t.write(), t.session)

    # A3: a chat in a sub-folder of alpha, with a pasted picture and a tool screenshot.
    docs = alpha / 'docs'
    t = Transcript(claude, docs, 'demo-a3-docs', 'Document the config options', now - 52 * hour)
    t.user([{'type': 'image', 'source': {'type': 'base64', 'media_type': 'image/png', 'data': base64.b64encode(png_bytes()).decode()}},
            {'type': 'text', 'text': 'This is how the settings page looks today. Document every option on it.'}])
    t.say('Thanks. I will write one short entry per option.')
    t.tool('Read', {'file_path': str(docs / 'config.md')}, '# Config\n')
    t.tool('mcp__browser__screenshot', {'url': 'http://localhost:3000/settings'}, '', outputs=[
        {'type': 'text', 'text': 'Screenshot of /settings'}, {'type': 'image', 'source': {'type': 'base64', 'media_type': 'image/png', 'data': base64.b64encode(png_bytes(160, 90)).decode()}}])
    t.say('Done: every option has an entry with its default.')
    chats['a3'] = (t.write(), t.session)

    # B1: medium chat with a plan and a next-step.
    t = Transcript(claude, beta, 'demo-b1-notes', 'Draft the 2.0 release notes', now - 8 * hour)
    t.user('Draft release notes for 2.0 from the changelog.')
    t.tool('mcp__ccd_turn__update_plan', {'items': [{'content': 'Read the changelog', 'status': 'in_progress'}, {'content': 'Group changes', 'status': 'pending'}, {'content': 'Write the notes', 'status': 'pending'}], 'scope': 'first_task'}, 'ok')
    t.tool('Read', {'file_path': str(beta / 'CHANGELOG.md')}, '## 2.0\n- new parser\n- faster startup\n')
    t.tool('mcp__ccd_turn__update_plan', {'advance': True}, 'ok')
    t.say('## Release notes 2.0\n\n**Highlights**\n\n- A new parser\n- Faster startup\n')
    t.tool('mcp__ccd_turn__update_plan', {'advance': True}, 'ok')
    t.tool('mcp__ccd_turn__wrap_up', {'recap': 'The 2.0 notes are drafted from the changelog.', 'ask': 'Publish them?', 'actions': [{'label': 'Publish'}, {'label': 'Edit first'}]}, 'ok')
    chats['b1'] = (t.write(), t.session)

    # B2: archived.
    t = Transcript(claude, beta, 'demo-b2-old', 'Old spike: try the legacy parser', now - 90 * hour)
    t.user('Try the legacy parser on the sample file.')
    t.say('It fails on line 3, so we are keeping the new parser.')
    chats['b2'] = (t.write(), t.session)
    return chats


def write_marks(state, chats, now):
    entries = {f'claude:{chats["a1"][1]}': {'pinnedAt': now - 3600, 'title': 'Add rate limiting to the API'},
               f'claude:{chats["b2"][1]}': {'archivedAt': now - 1800, 'title': 'Old spike: try the legacy parser'}}
    state.mkdir(parents=True, exist_ok=True)
    (state / 'studio-conversations.json').write_text(json.dumps({'version': 1, 'savedAt': now, 'entries': entries}), encoding='utf-8')


def generate(demo):
    """Everything the demo shows, except the artifact (published once Studio is up)."""
    for name in ('state', 'claude', 'omp', 'owners', 'projects', 'bin'):
        (demo / name).mkdir(parents=True, exist_ok=True)
    now = time.time()
    make_repo(demo / 'projects' / 'alpha', {'app.py': 'def route(request):\n    return "ok"\n\n\ndef handle(request):\n    return route(request)\n',
                                            'README.md': '# Alpha\nA tiny demo service.\n', 'docs/config.md': '# Config\n'})
    make_repo(demo / 'projects' / 'beta', {'CHANGELOG.md': '## 2.0\n- new parser\n- faster startup\n', 'README.md': '# Beta\n'})
    alpha = demo / 'projects' / 'alpha'   # uncommitted work for the Changes tab: one modified tracked file, one new file
    (alpha / 'app.py').write_text('def route(request):\n    if too_many(request):\n        return 429\n    return "ok"\n\n\ndef too_many(request):\n    return False\n\n\ndef handle(request):\n    return route(request)\n', encoding='utf-8', newline='\n')
    (alpha / 'limits.py').write_text('HITS = {}\nWINDOW = 60\n\n\ndef allow(key, now, limit=30):\n    hits = [t for t in HITS.get(key, []) if now - t < WINDOW]\n    HITS[key] = hits + [now]\n    return len(hits) < limit\n', encoding='utf-8', newline='\n')
    chats = build_chats(demo, now)
    write_marks(demo / 'state', chats, now)
    # OMP is started as `<omp-command> acp`; a tiny launcher runs the fixture agent for it.
    if os.name == 'nt':
        launcher = demo / 'bin' / 'omp.cmd'
        launcher.write_text(f'@echo off\r\n"{sys.executable}" "{AGENT}" %*\r\n', encoding='utf-8')
    else:
        launcher = demo / 'bin' / 'omp'
        launcher.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{AGENT}" "$@"\n', encoding='utf-8')
        launcher.chmod(0o755)
    (demo / MARKER).write_text('Created by work/demo-studio/start.py. Safe to delete.\n', encoding='utf-8')
    (demo / 'chats.json').write_text(json.dumps({k: v[1] for k, v in chats.items()}), encoding='utf-8')
    return launcher


# ---- starting ----------------------------------------------------------------------------------
def deno_executable():
    return os.environ.get('AIB_DENO') or shutil.which('deno')


def studio_command(options, demo):
    launcher = demo / 'bin' / ('omp.cmd' if os.name == 'nt' else 'omp')
    return [deno_executable(), 'run', '-A', '--quiet', str(MAIN), 'serve', '--port', str(options.port), '--state-dir', str(demo / 'state'), '--omp-sessions', str(demo / 'omp'),
            '--claude-projects', str(demo / 'claude'), '--owners-dir', str(demo / 'owners'), '--in-process', '--no-auto-reconnect', '--no-owner-announcements',
            '--node-command', sys.executable, '--claude-launcher', str(AGENT), '--omp-command', str(launcher)]


def http(url, body=None, headers=None, timeout=5):
    request = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(), headers=dict(headers or {}, **({'Content-Type': 'application/json'} if body is not None else {})))
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.status, response.read()


def wait_ready(port, process, timeout):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if process.poll() is not None:
            return False
        try:
            if http(f'http://127.0.0.1:{port}/chat.html')[0] == 200:
                return True
        except (urllib.error.URLError, OSError, ValueError):
            pass
        time.sleep(0.3)
    return False


def publish_artifact(port, session):
    """One artifact in chat A1, made through Studio's own API (the same call the artifact tool makes)."""
    base = f'http://127.0.0.1:{port}'
    token = json.loads(http(base + '/api/live/bootstrap')[1])['token']
    page = ('<!doctype html><meta charset="utf-8"><title>Rate limits</title><body style="font:16px system-ui;margin:2rem">'
            '<h1>Rate limits</h1><table border="1" cellpadding="6" style="border-collapse:collapse"><tr><th>Route</th><th>Limit</th></tr>'
            '<tr><td>/login</td><td>5 / minute</td></tr><tr><td>/search</td><td>30 / minute</td></tr><tr><td>/export</td><td>2 / minute</td></tr></table></body>')
    status, _ = http(base + '/api/live/artifacts/publish', {'conversationId': f'claude:{session}', 'title': 'Rate limits', 'content': page, 'filename': 'rate-limits.html'},
                     {'X-Studio-Token': token, 'Origin': base})   # a page POST must name its Origin
    return status == 200


def port_busy(port):
    with socket.socket() as sock:
        sock.settimeout(0.5)
        return sock.connect_ex(('127.0.0.1', port)) == 0


def start(options):
    problem = hidden_path_reason(demo_dir(options))
    if problem:
        print(problem, file=sys.stderr)
        return 2
    demo = demo_dir(options)
    if demo.exists():
        stop_studio(options.port, demo)   # a leftover run of this same demo
        if not options.keep or not (demo / MARKER).is_file():
            if demo.exists() and not safe_to_delete(demo):
                print(f'{demo} exists but is not a demo folder; refusing to delete it. Remove it yourself.', file=sys.stderr)
                return 2
            remove_tree(demo)
    for port in (options.port, options.port + 1):
        if port_busy(port):
            print(f'Port {port} is already in use (Studio needs {options.port} and {options.port + 1}). Stop that program or pick another --port.', file=sys.stderr)
            return 2
    if not deno_executable():
        print('Deno was not found: put deno on PATH or set AIB_DENO to the deno executable.', file=sys.stderr)
        return 2
    fresh = not demo.exists()
    if fresh:
        demo.mkdir(parents=True)
        generate(demo)
    log = open(demo / 'studio.log', 'ab')
    flags = 0
    kwargs = {}
    if os.name == 'nt':
        flags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
    else:
        kwargs['start_new_session'] = True
    process = subprocess.Popen(studio_command(options, demo), stdin=subprocess.DEVNULL, stdout=log, stderr=log, creationflags=flags, cwd=str(demo), **kwargs)
    (demo / 'studio.pid').write_text(json.dumps({'pid': process.pid, 'port': options.port, 'startedAt': time.time()}), encoding='utf-8')
    if not wait_ready(options.port, process, options.timeout):
        tail = (demo / 'studio.log').read_text(encoding='utf-8', errors='replace')[-1500:]
        print(f'Studio did not answer on port {options.port}.\n{tail}', file=sys.stderr)
        kill_tree(process.pid)
        return 1
    note = ''
    if fresh:
        try:
            chats = json.loads((demo / 'chats.json').read_text(encoding='utf-8'))
            if not publish_artifact(options.port, chats['a1']):
                note = ' (the demo artifact could not be published)'
        except (urllib.error.URLError, OSError, ValueError, KeyError) as error:
            note = f' (the demo artifact could not be published: {error})'
    print(f'Demo Studio: http://127.0.0.1:{options.port}/chat.html{note}')
    print(f'PID: {process.pid}')
    print(f'Data: {demo}')
    where = f' --dir "{options.dir}"' if options.dir else ''
    print(f'Stop: python {pathlib.PurePath(__file__).as_posix()} --stop --port {options.port}{where}')
    return 0


def stop(options):
    demo = demo_dir(options)
    stopped = stop_studio(options.port, demo)
    print('Stopped PID ' + ', '.join(map(str, stopped)) if stopped else f'No demo Studio was running on port {options.port}.')
    if demo.exists() and not options.keep:
        if not safe_to_delete(demo):
            print(f'{demo} is not a demo folder; left alone.', file=sys.stderr)
            return 2
        print(('Removed ' if remove_tree(demo) else 'Could not remove ') + str(demo))
    elif demo.exists():
        print(f'Kept {demo}')
    return 0


def main(argv=None):
    options = parse_args(argv)
    return stop(options) if options.stop else start(options)


if __name__ == '__main__':
    sys.exit(main())
