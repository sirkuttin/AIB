"""The server a contract test talks to: the Deno server (the app) by default, or the Python reference server.

Contract tests (work/contract/test_*.py) speak only HTTP, so the same file checks both servers
Which server: the AIB_SERVER environment variable.

    AIB_SERVER=deno-split (default)  deno run -A outputs/agent-studio/server/main.ts serve ...   (Deno web server + Deno agent host;
                                     AIB_KEEPER=0 is set for it: the split host is the fallback when the keeper cannot run)
    AIB_SERVER=deno                  deno run -A outputs/agent-studio/server/main.ts serve --in-process ...   (agents in the keeper,
                                     always on; AIB_KEEPER=0 in the environment gives the plain in-process Python parity path)
    AIB_SERVER=python                python work/python-reference/studio.py --in-process ...   (the reference)
    AIB_SERVER_CMD='["prog", "arg"]'  any other command (JSON list); the standard flags below are appended

A server started without --in-process starts a detached agent host for its temp state folder; the harness stops it (--stop-host
--force) when the test ends.

Every server is started with the same flags as the Python CLI: a private temp --state-dir, empty transcript folders, --port 0,
no auto-reconnect and no owner announcements, and must print "AIB: http://127.0.0.1:<port>" on stdout once listening.
AGENT_STUDIO_TEST=1 is set, so neither server can reach the real data folder, and the ports 8767/8768 are never used.

Run: python -m unittest discover -s work/contract     (AIB_SERVER=python to check the reference)
"""
import http.client
import json
import os
import pathlib
import queue
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time

WORK = pathlib.Path(__file__).resolve().parent.parent
APP = WORK.parent / 'outputs' / 'agent-studio'
PY_REF = WORK / 'python-reference'   # the Python reference server
READY = re.compile(r'AIB: http://127\.0\.0\.1:(\d+)')
FORBIDDEN_PORTS = {8767, 8768}
TOKEN_HEADER = 'X-Studio-Token'


def deno_executable():
    return os.environ.get('AIB_DENO') or shutil.which('deno') or 'deno'


def base_command():
    custom = os.environ.get('AIB_SERVER_CMD')
    if custom:
        return json.loads(custom)
    kind = os.environ.get('AIB_SERVER', 'deno-split')
    if kind == 'python':
        return [sys.executable, '-X', 'utf8', str(PY_REF / 'studio.py'), '--in-process']
    if kind == 'deno':
        return [deno_executable(), 'run', '-A', '--quiet', str(APP / 'server' / 'main.ts'), 'serve', '--in-process']
    if kind == 'deno-split':
        return [deno_executable(), 'run', '-A', '--quiet', str(APP / 'server' / 'main.ts'), 'serve']
    raise SystemExit(f'AIB_SERVER must be python, deno or deno-split, not {kind!r}')


def server_kind():
    return 'custom' if os.environ.get('AIB_SERVER_CMD') else os.environ.get('AIB_SERVER', 'deno-split')


class Response:
    def __init__(self, status, headers, body):
        self.status, self.headers, self.body = status, headers, body

    @property
    def text(self):
        return self.body.decode('utf-8', 'replace')

    def json(self):
        return json.loads(self.body or b'null')

    def __repr__(self):
        return f'<Response {self.status} {self.text[:200]!r}>'


def stop_keeper(state_dir, wait=2):
    """The keeper of a test's own temp state folder (<state>/keeper/keeper.json), if one still runs: it exits by itself once it
    holds no chat and has no client; otherwise it is ended by its exact pid (it was started for this folder by this test)."""
    if not state_dir:
        return
    try:
        pid = int(json.loads((pathlib.Path(state_dir) / 'keeper' / 'keeper.json').read_text(encoding='utf-8'))['pid'])
    except (OSError, ValueError, KeyError, TypeError):
        return
    deadline = time.monotonic() + wait
    while time.monotonic() < deadline and pid_alive(pid):
        time.sleep(0.2)
    if pid_alive(pid):
        try:
            if sys.platform == 'win32':
                subprocess.run(['taskkill', '/PID', str(pid), '/F'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                               creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            else:
                os.kill(pid, 9)
        except OSError:
            pass


def pid_alive(pid):
    if sys.platform == 'win32':
        out = subprocess.run(['tasklist', '/FI', f'PID eq {pid}', '/NH', '/FO', 'CSV'], capture_output=True, text=True,
                             creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0)).stdout
        return f'"{pid}"' in out
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def project_key(path):
    """server/desktop/project_delete.ts projectKey (sidebar-ui.js pathKey)."""
    p = str(path).strip()
    raw = p
    p = re.sub(r'^\\\\\?\\', '', p).replace('\\', '/')
    unc = p.startswith('//')
    p = re.sub(r'/{2,}', '/', p)
    segments = [s for s in p.split('/') if s]
    if not segments:
        return ''
    windows = bool(re.match(r'^[a-zA-Z]:', p)) or unc or '\\' in raw
    joined = '/'.join(segments)
    return 'w:' + joined.lower() if windows else 'p:' + joined


def write_added_projects(state_dir, roots):
    """studio-added-projects.json naming every folder (cwd / projectRoot) the transcripts under `roots` mention."""
    folders = set()
    for root in roots:
        for file in pathlib.Path(root).rglob('*.jsonl'):
            for line in file.read_text(encoding='utf-8', errors='replace').splitlines():
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                if isinstance(row, dict):
                    for name in ('cwd', 'projectRoot'):
                        if isinstance(row.get(name), str) and row[name]:
                            folders.add(row[name])
    added = {project_key(f): {'path': f, 'at': 1} for f in sorted(folders) if project_key(f)}
    (pathlib.Path(state_dir) / 'studio-added-projects.json').write_text(json.dumps({'version': 1, 'savedAt': 1, 'added': added}), encoding='utf-8')


class Server:
    """Start with `with Server() as s:`; s.get('/api/...') and s.post(...) send page-like requests with the token."""

    def __init__(self, extra_args=(), env=None, start_timeout=60, omp_dir=None, claude_dir=None, kind=None):
        """omp_dir/claude_dir: transcript folders to show (default: empty temp folders). kind='python' forces the Python server
        (the reference in differential tests), whatever AIB_SERVER says."""
        self.extra_args, self.env_extra, self.start_timeout = list(extra_args), dict(env or {}), start_timeout
        self.omp_override, self.claude_override, self.kind = omp_dir, claude_dir, kind
        self.process = None
        self.port = None
        self.token = None
        self.output = []

    # ---- life cycle ----
    def __enter__(self):
        self.temp = tempfile.mkdtemp(prefix='aib-contract-')
        root = pathlib.Path(self.temp)
        self.state_dir, self.omp_dir, self.claude_dir = root / 'state', root / 'omp', root / 'claude'
        for folder in (self.state_dir, self.omp_dir, self.claude_dir):
            folder.mkdir()
        self.omp_dir = pathlib.Path(self.omp_override or self.omp_dir)
        self.claude_dir = pathlib.Path(self.claude_override or self.claude_dir)
        if self.omp_override or self.claude_override:
            # Fixture history: every folder the fixtures' chats name is an added project, so the Deno server lists them (it lists
            # saved agent chats only for projects the user added).
            write_added_projects(self.state_dir, [self.omp_dir, self.claude_dir])
        command = self.command() + ['--port', '0', '--state-dir', str(self.state_dir), '--omp-sessions', str(self.omp_dir),
                                    '--claude-projects', str(self.claude_dir), '--no-auto-reconnect', '--no-owner-announcements',
                                    *self.extra_args]
        env = dict(os.environ, AGENT_STUDIO_TEST='1', AGENT_STUDIO_STATE_DIR=str(self.state_dir), PYTHONDONTWRITEBYTECODE='1',
                   **self.env_extra)
        if self.effective_kind() == 'deno-split':
            env.setdefault('AIB_KEEPER', '0')   # split mode exists only as the fallback for a keeper that cannot run
        flags = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
        self.process = subprocess.Popen(command, cwd=str(APP), env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                        stderr=subprocess.STDOUT, creationflags=flags)
        lines = queue.Queue()

        def pump():
            for raw in self.process.stdout:
                line = raw.decode('utf-8', 'replace').rstrip()
                self.output.append(line)
                lines.put(line)
            lines.put(None)
        threading.Thread(target=pump, daemon=True, name='contract-server-output').start()
        deadline = time.monotonic() + self.start_timeout
        while self.port is None:
            try:
                line = lines.get(timeout=max(0.1, deadline - time.monotonic()))
            except queue.Empty:
                line = ''
            if line is None or time.monotonic() > deadline:
                self.__exit__(None, None, None)
                raise RuntimeError(f'{self.effective_kind()} server did not start:\n' + '\n'.join(self.output[-40:]))
            match = READY.search(line or '')
            if match:
                self.port = int(match.group(1))
        if self.port in FORBIDDEN_PORTS:
            self.__exit__(None, None, None)
            raise RuntimeError(f'server picked forbidden port {self.port}')
        self.token = self.bootstrap().json()['token']
        return self

    def __exit__(self, *_):
        # A server whose agents run in the keeper: quit it the normal way first (POST /api/live/shutdown closes its chats, so the
        # keeper exits by itself). Killed hard, its keeper would start it again after 5 s (the orphan command).
        if self.process and self.process.poll() is None and self.port and self.token and self.effective_kind() != 'python':
            try:
                self.request('POST', '/api/live/shutdown', self.page_headers(), b'{}', timeout=10)
                self.process.wait(15)
            except Exception:  # noqa: BLE001  best effort; terminate() below
                pass
        if self.process and '--in-process' not in self.command() + self.extra_args:
            # Not --in-process: the server started a detached agent host for the temp state folder. Ask it to stop (the normal
            # --stop-host path), or it outlives the test until its idle timeout.
            try:
                subprocess.run(self.command() + ['--stop-host', '--force', '--state-dir', str(self.state_dir)], cwd=str(APP), timeout=60,
                               env=dict(os.environ, AGENT_STUDIO_TEST='1', AGENT_STUDIO_STATE_DIR=str(self.state_dir)),
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            except (OSError, subprocess.SubprocessError):
                pass
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(10)
        if self.process and self.process.stdout:
            self.process.stdout.close()
        stop_keeper(getattr(self, 'state_dir', None))
        shutil.rmtree(getattr(self, 'temp', ''), ignore_errors=True)

    def effective_kind(self):
        return self.kind or server_kind()

    def command(self):
        if self.kind == 'python':
            return [sys.executable, '-X', 'utf8', str(PY_REF / 'studio.py'), '--in-process']
        return base_command()

    # ---- requests ----
    @property
    def origin(self):
        return f'http://127.0.0.1:{self.port}'

    def page_headers(self, token=True, **extra):
        """What the Studio page sends from fetch(): Host, Origin, same-origin fetch metadata and (by default) the token."""
        headers = {'Host': f'127.0.0.1:{self.port}', 'Origin': self.origin, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors'}
        if token:
            headers[TOKEN_HEADER] = self.token
        headers.update({k.replace('_', '-'): v for k, v in extra.items()})
        return {k: v for k, v in headers.items() if v is not None}

    def request(self, method, path, headers=None, body=None, timeout=30):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=timeout)
        try:
            data = body if isinstance(body, (bytes, type(None))) else json.dumps(body).encode('utf-8')
            headers = dict(headers or {})
            if data is not None:
                headers.setdefault('Content-Type', 'application/json')
            connection.putrequest(method, path, skip_host='Host' in headers, skip_accept_encoding=True)
            for name, value in headers.items():
                connection.putheader(name, value)
            if data is not None:
                connection.putheader('Content-Length', str(len(data)))
            connection.endheaders(data)
            reply = connection.getresponse()
            return Response(reply.status, {k.lower(): v for k, v in reply.getheaders()}, reply.read())
        finally:
            connection.close()

    def bootstrap(self):
        return self.request('GET', '/api/live/bootstrap', {'Host': f'127.0.0.1:{self.port}', 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors'})

    def get(self, path, **headers):
        return self.request('GET', path, self.page_headers(**headers))

    def post(self, path, body=None, **headers):
        return self.request('POST', path, self.page_headers(**headers), {} if body is None else body)


def shape(value):
    """A JSON value's type skeleton, for comparing response shapes across servers: {'a': 'str', 'b': ['int']}."""
    if isinstance(value, dict):
        return {k: shape(v) for k, v in value.items()}
    if isinstance(value, list):
        return [shape(value[0])] if value else []
    return type(value).__name__
