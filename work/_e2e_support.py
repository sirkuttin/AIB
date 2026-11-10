"""Helpers for work/test_worktree_e2e.py (they came from the Python unit tests test_agent_host.py, test_host_takeover.py and
test_worktree_chat.py, which were removed with the Python app): a temp state folder and workspace whose web servers and agent
hosts are cleaned up, a web server handle, a fake agent host for the takeover tests, and git helpers.

Speaks to agent hosts through the Python reference's host_client (work/python-reference), which reads and writes the same
agent-host.json as the Deno server. Every child process is started without a console window."""
import _isolation  # noqa: F401  (test isolation: temp state folder, real per-user folder blocked)
import http.server
import json
import os
import pathlib
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

sys.path.insert(0, str(_isolation.PY_REF))
import host_client  # noqa: E402

FAKE_LAUNCHER = _isolation.TESTS / 'combined-fixture/agent.py'
NO_WINDOW = getattr(subprocess, 'CREATE_NO_WINDOW', 0)


def free_port():
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        return probe.getsockname()[1]


def http_json(method, port, path, token=None, body=None, timeout=30):
    data = None if body is None else json.dumps(body).encode('utf-8')
    request = urllib.request.Request(f'http://127.0.0.1:{port}{path}', data=data, method=method)
    if data is not None:
        request.add_header('Content-Type', 'application/json')
    if token:
        request.add_header('X-Studio-Token', token)
    if method != 'GET':
        request.add_header('Origin', f'http://127.0.0.1:{port}')   # a page POST must name its Origin
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read() or b'{}')


class Fixture:
    """A state dir, a workspace and cleanup for the web servers and hosts started against them. Subclasses start the web
    servers (start_web) and run the CLI (run_cli)."""

    def __init__(self, case, name='fixture'):
        self.tmp = tempfile.TemporaryDirectory()
        case.addCleanup(self.tmp.cleanup)
        self.root = pathlib.Path(self.tmp.name)
        self.state, self.owners, self.workspace = self.root / 'state', self.root / 'owners', self.root / 'workspace'
        for folder in (self.state, self.owners, self.workspace, self.root / 'omp', self.root / 'claude'):
            folder.mkdir()
        self.processes, self.logs, self.host_pids = [], [], set()
        self.case = case
        case.addCleanup(self.cleanup)

    def agent_flags(self):
        return ['--state-dir', str(self.state), '--omp-sessions', str(self.root / 'omp'), '--claude-projects', str(self.root / 'claude'),
                '--owners-dir', str(self.owners), '--node-command', sys.executable, '--claude-launcher', str(FAKE_LAUNCHER)]

    def host_info(self):
        info = host_client.read_info(self.state)
        if info and info['pid'] != os.getpid():  # never track (or later kill) the test runner itself
            self.host_pids.add(info['pid'])
        return info

    def host(self):
        info = self.host_info()
        return host_client.HostClient(info) if info else None

    def cleanup(self):
        try:
            info = self.host_info()
            if info and info['pid'] != os.getpid():
                host_client.stop_host(self.state, force=True, wait=10)
        except Exception:
            pass
        for process in self.processes:
            if process.poll() is None:
                process.kill()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                pass
        for pid in self.host_pids:  # last resort, only PIDs this fixture's hosts reported
            if host_client.pid_alive(pid):
                try:
                    os.kill(pid, signal.SIGTERM)
                except OSError:
                    pass
        deadline = time.time() + 10
        while time.time() < deadline and any(host_client.pid_alive(pid) for pid in self.host_pids):
            time.sleep(0.1)
        for log in self.logs:
            log.close()


class Web:
    def __init__(self, process, port, log_name):
        self.process, self.port, self.log_name = process, port, log_name
        self.token = self.instance = self.web_instance = None

    def wait_ready(self, fixture, seconds=60):
        deadline = time.time() + seconds
        while time.time() < deadline:
            if self.process.poll() is not None:
                raise AssertionError(f'web server exited: {pathlib.Path(self.log_name).read_text(errors="replace")}')
            try:
                status, boot = http_json('GET', self.port, '/api/live/bootstrap', timeout=5)
            except (OSError, ValueError):
                time.sleep(0.2)
                continue
            if status == 200:
                self.boot, self.token, self.instance, self.web_instance = boot, boot['token'], boot['instanceId'], boot['webInstanceId']
                fixture.host_info()
                return
        raise AssertionError('web server did not answer: ' + pathlib.Path(self.log_name).read_text(errors='replace'))

    def get(self, path, **kw):
        if path != '/api/live/bootstrap':
            kw.setdefault('token', self.token)   # every /api/ GET except bootstrap needs the page token
        return http_json('GET', self.port, path, **kw)

    def post(self, name, body, **kw):
        return http_json('POST', self.port, '/api/live/' + name, token=self.token, body=body, **kw)

    def listing(self):
        return self.get('/api/live/list')[1]

    def kill(self):
        self.process.kill()
        self.process.wait(timeout=10)


class FakeHost:
    """Speaks just enough of the host RPC: info and stop. Working chats make stop refuse, as the real host does."""
    def __init__(self, state, active=0, code_root='C:/other/checkout', app_id='studio-dev', version='0.0.9'):
        self.state, self.active, self.calls, self.stopped = pathlib.Path(state), active, [], False
        fake = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                fake.calls.append(request['op'])
                busy = [{'provider': 'claude', 'cwd': 'C:\\x', 'state': 'working'}] * fake.active
                if request['op'] == 'info':
                    result = {'protocol': host_client.PROTOCOL_VERSION, 'open': fake.active, 'active': busy, 'pid': fake.proc.pid}
                elif request['op'] == 'stop' and busy:
                    result = {'stopping': False, 'active': busy, 'message': 'busy'}
                elif request['op'] == 'stop':
                    result = {'stopping': True, 'active': []}
                    fake.stopped = True
                else:
                    result = {}
                data = json.dumps({'result': result}).encode()
                self.send_response(200)
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                if result.get('stopping'):
                    threading.Thread(target=fake.exit, daemon=True).start()

        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        # A fake has no process of its own: a sleeping child makes pid_alive true until the fake "exits".
        self.proc = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'], creationflags=NO_WINDOW)
        host_client.write_info(self.state, {'format': host_client.HOST_FORMAT, 'protocol': host_client.PROTOCOL_VERSION, 'pid': self.proc.pid,
                                            'port': self.server.server_port, 'token': 't' * 20, 'hostId': 'fake', 'startedAt': time.time(),
                                            'codeRoot': code_root, 'sourceHash': 'x', 'appId': app_id, 'version': version})

    def exit(self):
        time.sleep(0.2)
        host_client.remove_info(self.state, self.proc.pid)
        self.proc.kill()

    def close(self):
        self.proc.kill()
        self.proc.wait()
        self.server.shutdown()
        self.server.server_close()


def run_git(cwd, *args):
    done = subprocess.run(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', *args], cwd=str(cwd),
                          capture_output=True, text=True, encoding='utf-8', creationflags=NO_WINDOW)
    if done.returncode != 0:
        raise AssertionError(f'git {args} failed: {done.stderr}')
    return done.stdout


def make_repo(folder):
    folder = pathlib.Path(folder)
    folder.mkdir(parents=True)
    run_git(folder, 'init', '-b', 'main')
    (folder / 'tracked.txt').write_text('one\n', encoding='utf-8')
    (folder / '.gitignore').write_text('ignored.log\nbuild/\nnode_modules/\n', encoding='utf-8')
    run_git(folder, 'add', '-A')
    run_git(folder, 'commit', '-m', 'first')
    return folder
