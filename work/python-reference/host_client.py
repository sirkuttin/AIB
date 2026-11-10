"""Client side of the Agent Studio host protocol: find, start, call and stop the long-lived agent host.

The agent host (agent_host.py) owns every ACP adapter process. The web server (studio.py) talks to it through
this module. Only stdlib, no Studio imports, so both sides can use it. See docs/agent-host.md.
"""
import hashlib
import http.client
import json
import os
import pathlib
import shutil
import subprocess
import sys
import time

import app_paths
from app_paths import APP_ROOT
from version import __version__ as APP_VERSION

PROTOCOL_VERSION = 4   # 4: the `signin` op (sign-in check and Sign in job). 3: the `install` op (agent installer job). 2: the worktree-note op may carry `actions` (buttons in the note)
HOST_FORMAT = 'agent-studio-host'
INFO_NAME = 'agent-host.json'
LOG_NAME = 'agent-host.log'
TOKEN_HEADER = 'X-Agent-Host-Token'
MAX_RPC_BYTES = 64 * 1024 * 1024  # a prompt may carry 30 MiB of attachments
LOG_MAX_BYTES = 5 * 1024 * 1024   # agent-host.log is rotated at about this size, keeping LOG_KEEP older files (.1, .2)
LOG_KEEP = 2


# Which build runs this code, recorded in agent-host.json: the desktop app sets AIB_APP_ID=dev.aib.app, a plain web server is 'studio-dev'.
APP_ID = os.environ.get('AIB_APP_ID') or 'studio-dev'


def _code_root():
    return os.path.normcase(str(APP_ROOT))


HASH_SKIP_DIRS = frozenset({'__pycache__', 'docs', 'node_modules', '.git'})


def _source_files(root):
    """Every .py under root (subfolders included) outside HASH_SKIP_DIRS, as (posix relative name, path), sorted."""
    found = []
    for path in pathlib.Path(root).rglob('*.py'):
        parts = path.relative_to(root).parts
        if any(part in HASH_SKIP_DIRS for part in parts[:-1]):
            continue
        found.append(('/'.join(parts), path))
    return sorted(found)


def _source_hash(root=None):
    """sha256 over the relative names and bytes of the .py files under the app folder: identifies the code a process loaded."""
    digest = hashlib.sha256()
    for name, path in _source_files(root or APP_ROOT):
        try:
            digest.update(name.encode('utf-8') + b'\0' + path.read_bytes() + b'\0')
        except OSError:
            digest.update(name.encode('utf-8') + b'\0?')
    return digest.hexdigest()


CODE_ROOT = _code_root()        # computed when this process started: what THIS process runs
SOURCE_HASH = _source_hash()


class HostUnavailable(RuntimeError):
    """The agent host cannot be used right now. `code` says why; `delivered` is False only when the request never left."""
    def __init__(self, message, code='host_unreachable', delivered=True):
        super().__init__(message)
        self.code, self.delivered = code, delivered


class HostIncompatible(HostUnavailable):
    def __init__(self, message, info=None):
        super().__init__(message, 'host_incompatible', False)
        self.info = info or {}


class HostForeignRoot(HostIncompatible):
    """A live host was started from a different code folder. With takeover=False (a web server that already lost its host to
    another version) it is left alone; find_or_start otherwise takes it over, see _take_over."""


class HostBusy(HostUnavailable):
    """A host from another code folder still has chats working. It is left running; the caller waits and retries."""
    def __init__(self, message, info=None, chats=0):
        super().__init__(message, 'host_waiting', False)
        self.info, self.chats = info or {}, chats


def code_warning(host_info):
    """A sentence when the running host loaded different code than this process (same folder, other source hash), else ''.
    host_info is the host's 'info' answer (or agent-host.json): both carry codeRoot and sourceHash. A host from before these
    fields existed is reported as older code too."""
    if not isinstance(host_info, dict) or not host_info.get('pid') and not host_info.get('hostId'):
        return ''
    theirs = host_info.get('sourceHash')
    if theirs is None:
        return 'The running agent host was started by an older version of Agent Studio. Restart it (python studio.py --stop-host) to use the current code.'
    if theirs != SOURCE_HASH:
        return 'The running agent host is running older code than this web server. Restart it (python studio.py --stop-host) when no conversation is working.'
    return ''


def info_path(state_dir):
    return pathlib.Path(state_dir) / INFO_NAME


def log_path(state_dir):
    return pathlib.Path(state_dir) / LOG_NAME


def read_info(state_dir):
    """The host's published address and token, or None when no host file exists. Retries a half-replaced file."""
    path = info_path(state_dir)
    for attempt in range(5):
        try:
            data = json.loads(path.read_text(encoding='utf-8'))
        except FileNotFoundError:
            return None
        except (OSError, ValueError):
            time.sleep(0.05 * (attempt + 1))
            continue
        if isinstance(data, dict) and data.get('format') == HOST_FORMAT and isinstance(data.get('port'), int) and isinstance(data.get('token'), str):
            return data
        return None
    return None


def restrict_to_user(path):
    """Best effort: make a secrets file readable by the current user only."""
    try:
        if os.name == 'nt':
            user = os.environ.get('USERNAME')
            if not user:
                return
            subprocess.run(['icacls', str(path), '/inheritance:r', '/grant:r', f'{user}:F'], capture_output=True, timeout=15,
                           creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            try:
                pathlib.Path(path).read_bytes()
            except OSError:  # never lock ourselves out
                subprocess.run(['icacls', str(path), '/reset'], capture_output=True, timeout=15, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        else:
            os.chmod(path, 0o600)
    except (OSError, subprocess.SubprocessError):
        pass


def rotate_log(path, max_bytes=LOG_MAX_BYTES, keep=LOG_KEEP, copy_truncate=False):
    """Keep a log under about max_bytes: path becomes path.1, path.1 becomes path.2, ... and the oldest beyond `keep` is dropped.
    copy_truncate=True is for a log some process still has open (it keeps appending to the emptied file). Returns True when rotated."""
    path = pathlib.Path(path)
    try:
        if path.stat().st_size < max_bytes:
            return False
    except OSError:
        return False
    try:
        for number in range(keep, 0, -1):
            older = path.with_name(f'{path.name}.{number}')
            if number == keep:
                older.unlink(missing_ok=True)
            newer = path if number == 1 else path.with_name(f'{path.name}.{number - 1}')
            if number == 1 and copy_truncate:
                shutil.copyfile(path, older)
                with open(path, 'r+b') as handle:
                    handle.truncate(0)
            elif newer.exists():
                os.replace(newer, older)
        return True
    except OSError:
        return False


def write_info(state_dir, info):
    """Atomically publish the host file (address + token), restricted to the current user."""
    path = info_path(state_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f'{path.name}.{os.getpid()}.tmp')
    temporary.write_text(json.dumps(info, indent=1), encoding='utf-8')
    restrict_to_user(temporary)
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
        import ctypes
        kernel = ctypes.windll.kernel32
        kernel.OpenProcess.restype = ctypes.c_void_p
        handle = kernel.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return False
        try:
            code = ctypes.c_ulong()
            return bool(kernel.GetExitCodeProcess(ctypes.c_void_p(handle), ctypes.byref(code))) and code.value == 259
        finally:
            kernel.CloseHandle(ctypes.c_void_p(handle))
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
                raise HostUnavailable(f'The agent host is not accepting connections ({error}).', 'host_unreachable', delivered=False) from error
            try:
                connection.request('POST', '/rpc', body, {'Content-Type': 'application/json', TOKEN_HEADER: self.token})
                response = connection.getresponse()
                data = response.read()
            except (OSError, http.client.HTTPException) as error:
                raise HostUnavailable(f'The agent host stopped answering ({error}).', 'host_unreachable', delivered=True) from error
        finally:
            connection.close()
        try:
            payload = json.loads(data.decode('utf-8'))
        except ValueError as error:
            raise HostUnavailable('The agent host sent an unreadable answer.', 'host_unreachable') from error
        if response.status == 200 and isinstance(payload, dict):
            return payload.get('result')
        if response.status == 403:
            raise HostUnavailable('The agent host refused this web server (token or peer check failed).', 'host_auth', delivered=False)
        message = str(payload.get('error') or f'HTTP {response.status}') if isinstance(payload, dict) else f'HTTP {response.status}'
        kind = payload.get('errorType') if isinstance(payload, dict) else None
        if kind in ('KeyError', 'ValueError', 'TypeError'):
            raise ValueError(message)
        if kind in ('OSError', 'TimeoutError'):
            raise OSError(message)
        raise RuntimeError(message)


def spawn_detached(command, log_file, cwd=None):
    """Start a process that outlives its parent and this console/job. Output goes to log_file."""
    pathlib.Path(log_file).parent.mkdir(parents=True, exist_ok=True)
    rotate_log(log_file)
    out = open(log_file, 'ab')
    try:
        common = dict(cwd=cwd, stdin=subprocess.DEVNULL, stdout=out, stderr=out, close_fds=True)
        if os.name == 'nt':
            flags = getattr(subprocess, 'DETACHED_PROCESS', 0) | getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0) | getattr(subprocess, 'CREATE_NO_WINDOW', 0)
            try:
                return subprocess.Popen(command, creationflags=flags | 0x01000000, **common)  # CREATE_BREAKAWAY_FROM_JOB
            except OSError:  # the launching job does not allow breakaway
                return subprocess.Popen(command, creationflags=flags, **common)
        return subprocess.Popen(command, start_new_session=True, **common)
    finally:
        out.close()


def _incompatible(live, info):
    pid, theirs = info.get('pid'), live.get('protocol')
    busy = live.get('active') or []
    note = (f' It has {len(busy)} conversation(s) that are working or waiting, so it was left running.' if busy
            else f' It has {live.get("open", 0)} open conversation(s), so it was left running.' if live.get('open') else '')
    return HostIncompatible(f'The running agent host (process {pid}) speaks protocol {theirs}; this web server needs protocol {PROTOCOL_VERSION}.{note} '
                            'Finish or interrupt the work, then run "python studio.py --stop-host" (or deploy.py --host) and restart the web server.', live)


def _who(info):
    return f'{info.get("appId") or "an older build"} {info.get("version") or ""}'.strip()


def find_host(state_dir):
    """(client, live_info) for a reachable compatible host, None if there is none (or only a stale file).
    Raises HostIncompatible for a different protocol and HostUnavailable for a live host that does not answer."""
    info = read_info(state_dir)
    if not info:
        return None
    root = info.get('codeRoot')
    if root and os.path.normcase(str(root)) != CODE_ROOT and pid_alive(info.get('pid')):
        raise HostForeignRoot(f'The agent host for this state folder (process {info.get("pid")}, {_who(info)}) was started from a different code folder ({root}); '
                              f'this web server runs from {CODE_ROOT}.', info)
    client = HostClient(info)
    try:
        live = client.call('info', timeout=5)
    except HostUnavailable as error:
        if error.code == 'host_auth':
            raise
        if pid_alive(info.get('pid')) and error.delivered:
            raise HostUnavailable(f'An agent host (process {info.get("pid")}) is running but did not answer: {error}', 'host_unreachable') from error
        return None
    if not isinstance(live, dict) or live.get('protocol') != PROTOCOL_VERSION:
        raise _incompatible(live if isinstance(live, dict) else {}, info)
    return client, live


def _wait_gone(state_dir, pid, seconds):
    deadline = time.time() + seconds
    while time.time() < deadline:
        if not pid_alive(pid):
            return True
        time.sleep(0.1)
    return not pid_alive(pid)


def _take_over(state_dir, foreign, say):
    """Stop a host started from another code folder, but only when no chat is working there (the host itself refuses to stop
    otherwise, so a chat that starts working a moment later is still safe). Raises HostBusy while chats work."""
    info = foreign.info
    try:
        result = HostClient(info).call('stop', {'force': False}, timeout=15)
    except HostUnavailable as error:
        if error.code == 'host_auth' or (pid_alive(info.get('pid')) and error.delivered):
            raise HostUnavailable(f'The agent host of {_who(info)} (process {info.get("pid")}) did not answer: {error}', 'host_unreachable', False) from error
        remove_info(state_dir, info.get('pid'))   # a stale file
        return
    if not isinstance(result, dict) or not result.get('stopping'):
        active = (result or {}).get('active') or []
        chats = len(active) or 1
        raise HostBusy(f'Another AIB version ({_who(info)}) is running {chats} chat(s); it will switch over when they finish.', info, chats)
    say(f'Took over from the agent host of {_who(info)} (process {info.get("pid")}): it had no chat working.')
    if not _wait_gone(state_dir, info.get('pid'), 20):
        raise HostUnavailable(f'The previous agent host (process {info.get("pid")}) was told to stop but is still exiting.', 'host_unreachable', False)


def find_or_start(state_dir, command, wait=40, say=None, replace_idle_incompatible=True, takeover=True):
    """Attach to the host for this state dir, starting one (detached) when none runs. Returns (client, live_info).
    A live host from another code folder (any appId or version: one user owns the folder) is taken over when takeover is true:
    stopped if no chat is working there, else HostBusy is raised (nothing is stopped) and the caller retries later."""
    say = say or (lambda message: None)
    try:
        found = find_host(state_dir)
    except HostIncompatible as error:
        live = error.info
        if isinstance(error, HostForeignRoot):
            if not takeover:
                raise
            _take_over(state_dir, error, say)
            return find_or_start(state_dir, command, wait, say, replace_idle_incompatible, takeover=False)
        if not (replace_idle_incompatible and live.get('open', 1) == 0):
            raise
        say(f'Replacing idle agent host with protocol {live.get("protocol")}.')
        try:
            stopped = HostClient(read_info(state_dir)).call('stop', {}, timeout=10)
        except (HostUnavailable, ValueError, RuntimeError, OSError):
            raise error
        if not isinstance(stopped, dict) or not stopped.get('stopping'):
            raise error
        _wait_gone(state_dir, (read_info(state_dir) or {}).get('pid') or live.get('pid'), 20)
        found = None
    if found:
        return found
    process = spawn_detached(command, log_path(state_dir), cwd=str(APP_ROOT))
    say(f'Started agent host process {process.pid}.')
    deadline, exited_at = time.time() + wait, None
    while time.time() < deadline:
        try:
            found = find_host(state_dir)
        except HostUnavailable as error:
            if isinstance(error, HostIncompatible):
                raise
            found = None
        if found:
            return found
        if process.poll() is not None:
            exited_at = exited_at or time.time()
            if time.time() - exited_at > 5:  # a loser of a start race exits quietly; give the winner time to publish
                tail = ''
                try:
                    tail = log_path(state_dir).read_text(encoding='utf-8', errors='replace')[-600:]
                except OSError:
                    pass
                raise HostUnavailable(f'The agent host exited with code {process.returncode} before it was ready. {tail.strip()}'.strip(), 'host_unreachable', False)
        time.sleep(0.15)
    raise HostUnavailable(f'The agent host did not become ready within {wait} seconds; see {log_path(state_dir)}.', 'host_unreachable', False)


def stop_host(state_dir, force=False, wait=20):
    """Ask the host to stop. Returns a dict {stopped, message, refused?, active?}. Never kills a process."""
    info = read_info(state_dir)
    if not info:
        return {'stopped': False, 'message': f'No agent host is running for {state_dir}.', 'running': False}
    client = HostClient(info)
    try:
        result = client.call('stop', {'force': bool(force)}, timeout=15)
    except HostUnavailable as error:
        if pid_alive(info.get('pid')) and error.delivered:
            return {'stopped': False, 'running': True, 'refused': True, 'message': f'Agent host process {info.get("pid")} is running but did not answer: {error}'}
        remove_info(state_dir, info.get('pid'))
        return {'stopped': True, 'running': False, 'message': f'Agent host process {info.get("pid")} was not running; removed its stale file.'}
    if not isinstance(result, dict) or not result.get('stopping'):
        return {'stopped': False, 'running': True, 'refused': True, 'active': (result or {}).get('active', []), 'message': (result or {}).get('message', 'The agent host did not stop.')}
    gone = _wait_gone(state_dir, info.get('pid'), wait)
    return {'stopped': gone, 'running': not gone, 'message': 'Agent host stopped.' if gone else f'Agent host process {info.get("pid")} was told to stop but is still exiting.'}
