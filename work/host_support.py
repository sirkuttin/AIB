"""What the Python end-to-end tests need to look at an agent host and the worktree registry the Deno server writes: read, write and
remove agent-host.json, ask a host to stop, call a host over its RPC, and find a chat's worktree record. Stdlib only.

These are the few functions the tests used from the retired Python reference server (2026-11-23), now here as test helpers.
The formats are the Deno server's own: server/host/host_client.ts (agent-host.json, the /rpc call) and server/worktrees/worktrees.ts
(studio-worktrees.json, the per-repo folder name)."""
import hashlib
import http.client
import json
import os
import pathlib
import subprocess
import time


PROTOCOL_VERSION = 4   # server/host/host_client.ts
HOST_FORMAT = 'agent-studio-host'
INFO_NAME = 'agent-host.json'
TOKEN_HEADER = 'X-Agent-Host-Token'
CODE_ROOT = os.path.normcase(str(pathlib.Path(__file__).resolve().parents[1] / 'outputs' / 'agent-studio'))   # what a host started from this checkout publishes as codeRoot


class HostUnavailable(RuntimeError):
    """The agent host cannot be used right now. `delivered` is False only when the request never left."""
    def __init__(self, message, delivered=True):
        super().__init__(message)
        self.delivered = delivered


def info_path(state_dir):
    return pathlib.Path(state_dir) / INFO_NAME


def read_info(state_dir):
    """The host's published address and token, or None when no host file exists. Retries a half-replaced file."""
    for attempt in range(5):
        try:
            data = json.loads(info_path(state_dir).read_text(encoding='utf-8'))
        except FileNotFoundError:
            return None
        except (OSError, ValueError):
            time.sleep(0.05 * (attempt + 1))
            continue
        if isinstance(data, dict) and data.get('format') == HOST_FORMAT and isinstance(data.get('port'), int) and isinstance(data.get('token'), str):
            return data
        return None
    return None


def write_info(state_dir, info):
    """Atomically publish the host file (address + token)."""
    path = info_path(state_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f'{path.name}.{os.getpid()}.tmp')
    temporary.write_text(json.dumps(info, indent=1), encoding='utf-8')
    os.replace(temporary, path)


def remove_info(state_dir, pid=None):
    """Remove the host file, but only ours when a pid is given."""
    current = read_info(state_dir)
    if current is None or (pid is not None and current.get('pid') != pid):
        return False
    try:
        info_path(state_dir).unlink()
        return True
    except OSError:
        return False


def pid_alive(pid):
    if not isinstance(pid, int) or pid <= 0:
        return False
    if os.name == 'nt':
        out = subprocess.run(['tasklist', '/FI', f'PID eq {pid}', '/NH', '/FO', 'CSV'], capture_output=True, text=True,
                             creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0)).stdout
        return f'"{pid}"' in out
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


class HostClient:
    """One authenticated channel to a host: JSON over loopback HTTP, one request per connection."""

    def __init__(self, info):
        self.info = info
        self.port, self.token, self.pid = info['port'], info['token'], info.get('pid')

    def call(self, op, args=None, timeout=30):
        body = json.dumps({'op': op, 'args': args if args is not None else {}}, ensure_ascii=False).encode('utf-8')
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=timeout)
        try:
            try:
                connection.connect()
            except OSError as error:
                raise HostUnavailable(f'The agent host is not accepting connections ({error}).', delivered=False) from error
            try:
                connection.request('POST', '/rpc', body, {'Content-Type': 'application/json', TOKEN_HEADER: self.token})
                response = connection.getresponse()
                data = response.read()
            except (OSError, http.client.HTTPException) as error:
                raise HostUnavailable(f'The agent host stopped answering ({error}).') from error
        finally:
            connection.close()
        try:
            payload = json.loads(data.decode('utf-8'))
        except ValueError as error:
            raise HostUnavailable('The agent host sent an unreadable answer.') from error
        if response.status == 200 and isinstance(payload, dict):
            return payload.get('result')
        message = str(payload.get('error') or f'HTTP {response.status}') if isinstance(payload, dict) else f'HTTP {response.status}'
        raise RuntimeError(message)


def _wait_gone(pid, seconds):
    deadline = time.time() + seconds
    while time.time() < deadline:
        if not pid_alive(pid):
            return True
        time.sleep(0.1)
    return not pid_alive(pid)


def stop_host(state_dir, force=False, wait=20):
    """Ask the host to stop. Returns a dict {stopped, message, refused?, active?}. Never kills a process."""
    info = read_info(state_dir)
    if not info:
        return {'stopped': False, 'message': f'No agent host is running for {state_dir}.', 'running': False}
    try:
        result = HostClient(info).call('stop', {'force': bool(force)}, timeout=15)
    except HostUnavailable as error:
        if pid_alive(info.get('pid')) and error.delivered:
            return {'stopped': False, 'running': True, 'refused': True, 'message': f'Agent host process {info.get("pid")} did not answer: {error}'}
        remove_info(state_dir, info.get('pid'))
        return {'stopped': True, 'running': False, 'message': f'Agent host process {info.get("pid")} was not running; removed its stale file.'}
    if not isinstance(result, dict) or not result.get('stopping'):
        return {'stopped': False, 'running': True, 'refused': True, 'active': (result or {}).get('active', []), 'message': (result or {}).get('message', 'The agent host did not stop.')}
    gone = _wait_gone(info.get('pid'), wait)
    return {'stopped': gone, 'running': not gone, 'message': 'Agent host stopped.' if gone else f'Agent host process {info.get("pid")} is still exiting.'}


# ---- the worktree registry (<state>/studio-worktrees.json) ----

def repo_hash(project):
    """The folder name of a repo's worktrees under <state>/worktrees (server/worktrees/worktrees.ts repoHash)."""
    return hashlib.sha1(os.path.normcase(os.path.realpath(str(project))).encode('utf-8')).hexdigest()[:10]


def worktree_records(state_dir):
    """{chatKey: record} from studio-worktrees.json; {} when there is none."""
    try:
        raw = json.loads((pathlib.Path(state_dir) / 'studio-worktrees.json').read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {}
    items = raw.get('worktrees') if isinstance(raw, dict) else None
    return {k: v for k, v in items.items() if isinstance(v, dict)} if isinstance(items, dict) else {}


def long_path(path):
    """A path the Python file APIs can open even beyond 260 characters on Windows."""
    text = str(path)
    if os.name == 'nt' and len(text) >= 240 and not text.startswith('\\\\?\\'):
        return '\\\\?\\' + os.path.abspath(text)
    return text
