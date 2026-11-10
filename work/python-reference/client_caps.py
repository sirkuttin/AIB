"""Opt-in ACP client capabilities for Agent Studio: terminals and text-file access.

Everything here is OFF by default. A ClientCaps object only answers the methods whose
capability was switched on with --enable-client-terminal / --enable-client-fs; any other
method is left to Studio's normal "capability not advertised" error.

Boundaries (see docs/client-capabilities.md):
  * file paths must be absolute and, after os.path.realpath (symlinks/junctions followed),
    inside the connection's workspace folder;
  * terminals run argv lists with shell=False, only inside the workspace, with a minimal
    environment plus whatever env entries the agent explicitly asks for;
  * every process is tracked per connection and killed on release / connection close.
"""
import collections
import io
import logging
import os
import re
import secrets
import shutil
import subprocess
import tempfile
import threading
import time

log = logging.getLogger(__name__)
log.addHandler(logging.NullHandler())   # a library logger: quiet until a program configures logging (log_setup.py)

MAX_READ_BYTES = 2 * 1024 * 1024        # largest slice returned by fs/read_text_file
MAX_SCAN_BYTES = 64 * 1024 * 1024       # most we will scan to reach a requested start line
MAX_WRITE_BYTES = 8 * 1024 * 1024
DEFAULT_OUTPUT_LIMIT = 1024 * 1024      # terminal output kept when the agent gives no limit
MAX_OUTPUT_LIMIT = 4 * 1024 * 1024      # hard server-side cap, whatever the agent asks for
MAX_TERMINALS = 8
MAX_ENV = 64
MAX_ARGS = 256
MAX_ARG_CHARS = 32768
TAIL_CHARS = 4000                       # output tail shown in public state
RECENT_WRITES = 50
ENV_NAME = re.compile(r'^[A-Za-z_][A-Za-z0-9_]{0,127}$')
BASE_ENV_NAMES = ('PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'HOME', 'USERPROFILE',
                  'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMDATA', 'LANG', 'LC_ALL', 'TERM', 'TZ')
RESERVED_NAMES = {'CON', 'PRN', 'AUX', 'NUL', 'CONIN$', 'CONOUT$', *(f'COM{i}' for i in range(1, 10)), *(f'LPT{i}' for i in range(1, 10))}
TERMINAL_METHODS = ('terminal/create', 'terminal/output', 'terminal/wait_for_exit', 'terminal/kill', 'terminal/release')
FS_READ_METHODS = ('fs/read_text_file',)
FS_WRITE_METHODS = ('fs/write_text_file',)


class CapError(Exception):
    def __init__(self, message, code=-32602):
        super().__init__(message)
        self.code = code


def _norm(path):
    return os.path.normcase(os.path.normpath(path))


def inside(path, root):
    """True if path is root or below it (both already real paths); never raises."""
    try:
        a, b = _norm(path), _norm(root)
        return os.path.commonpath([a, b]) == b
    except ValueError:  # different drives, or mix of absolute/relative
        return False


def resolve_inside(path, workspace, what='path'):
    """Validate an agent-supplied absolute path and return its real location inside workspace."""
    if not isinstance(path, str) or not path or '\0' in path or len(path) > 4096:
        raise CapError(f'{what} must be a non-empty string')
    if not os.path.isabs(path):
        raise CapError(f'{what} must be an absolute path')
    if path.startswith(('\\\\?\\', '\\\\.\\', '//?/', '//./')):
        raise CapError(f'{what} uses a device or extended-length prefix, which is not allowed')
    if path.startswith(('\\\\', '//')):
        raise CapError(f'{what} is a network (UNC) path, which is not allowed')
    if ':' in os.path.splitdrive(path)[1]:
        raise CapError(f'{what} contains a colon (alternate data stream), which is not allowed')
    if os.name == 'nt':
        for part in os.path.splitdrive(path)[1].replace('/', chr(92)).split(chr(92)):
            if part and (part.split('.')[0].strip().upper() in RESERVED_NAMES or (part not in ('.', '..') and part[-1] in '. ')):
                raise CapError(f'{what} contains a reserved Windows device name or trailing dot/space')
    real = os.path.realpath(path)
    root = os.path.realpath(workspace)
    if not inside(real, root):
        raise CapError(f'{what} is outside the workspace folder')
    return real


def _trim_to_limit(buffer, limit):
    """Drop the oldest bytes beyond limit without leaving a split UTF-8 character at the start."""
    if len(buffer) <= limit:
        return False
    del buffer[:len(buffer) - limit]
    while buffer and 0x80 <= buffer[0] <= 0xBF:
        del buffer[0]
    return True


class Terminal:
    def __init__(self, terminal_id, session_id, argv, cwd, process, limit):
        self.id, self.session_id, self.argv, self.cwd, self.process, self.limit = terminal_id, session_id, argv, cwd, process, limit
        self.buffer = bytearray()
        self.truncated = False
        self.exit_code = None
        self.signal = None
        self.killed = False
        self.released = False
        self.created = time.time()
        self.lock = threading.Lock()
        self.exited = threading.Event()
        self.reader = threading.Thread(target=self._pump, daemon=True, name=f'terminal-{terminal_id}')
        self.reader.start()

    def _pump(self):
        try:
            while True:
                chunk = self.process.stdout.read1(65536) if hasattr(self.process.stdout, 'read1') else self.process.stdout.read(65536)
                if not chunk:
                    break
                with self.lock:
                    self.buffer.extend(chunk)
                    if _trim_to_limit(self.buffer, self.limit):
                        self.truncated = True
        except (OSError, ValueError):
            pass
        try:
            self.process.stdout.close()
        except OSError:
            pass
        try:
            code = self.process.wait()
        except OSError:
            code = None
        with self.lock:
            self.exit_code = code
            self.exited.set()

    def status(self):
        if self.released:
            return 'released'
        if not self.exited.is_set():
            return 'running'
        return 'killed' if self.killed else 'exited'

    def exit_status(self):
        if not self.exited.is_set():
            return None
        code = self.exit_code
        if code is not None and code < 0:  # POSIX: negative means terminated by signal
            return {'exitCode': None, 'signal': str(-code)}
        return {'exitCode': code, 'signal': None}

    def snapshot(self):
        with self.lock:
            return bytes(self.buffer).decode('utf-8', 'replace'), self.truncated

    def kill(self):
        if self.process.poll() is not None:
            return
        self.killed = True
        pid = self.process.pid
        try:
            if os.name == 'nt':
                # Exact PID from our own Popen; /T also removes its child processes.
                subprocess.run(['taskkill', '/PID', str(pid), '/T', '/F'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                               timeout=10, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            else:
                import signal
                os.killpg(pid, signal.SIGKILL)
        except (OSError, subprocess.SubprocessError):
            pass
        try:
            self.process.kill()
        except OSError:
            pass
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass
        self.exited.wait(5)


class ClientCaps:
    """Per-connection capability handler. `fs` is None, 'read' or 'readwrite'."""

    def __init__(self, workspace, terminal=False, fs=None, known_session=None, record=None, write_response=None):
        if fs not in (None, 'read', 'readwrite'):
            raise ValueError("fs must be None, 'read' or 'readwrite'")
        self.workspace = str(workspace)
        self.terminal_enabled = bool(terminal)
        self.fs_mode = fs
        self.known_session = known_session or (lambda sid: True)
        self.record = record or (lambda kind, data: None)
        self.write_response = write_response
        self.terminals = collections.OrderedDict()
        self.writes = collections.deque(maxlen=RECENT_WRITES)
        self.lock = threading.RLock()
        self.write_lock = threading.Lock()
        self.shut = False

    def configure(self, terminal=False, fs=None):
        """Switch capabilities on; call before the initialize request is sent."""
        if fs not in (None, 'read', 'readwrite'):
            raise ValueError("fs must be None, 'read' or 'readwrite'")
        self.terminal_enabled, self.fs_mode = bool(terminal), fs

    # --- advertised capabilities -------------------------------------------------
    def capabilities(self):
        return {'fs': {'readTextFile': self.fs_mode in ('read', 'readwrite'), 'writeTextFile': self.fs_mode == 'readwrite'},
                'terminal': self.terminal_enabled}

    def handles(self, method):
        if method in TERMINAL_METHODS:
            return self.terminal_enabled
        if method in FS_READ_METHODS:
            return self.fs_mode in ('read', 'readwrite')
        if method in FS_WRITE_METHODS:
            return self.fs_mode == 'readwrite'
        return False

    # --- dispatch -----------------------------------------------------------------
    def dispatch(self, message):
        """Answer one agent->client request. Blocking waits run on a worker thread."""
        if message['method'] == 'terminal/wait_for_exit':
            threading.Thread(target=self._respond, args=(message,), daemon=True).start()
        else:
            self._respond(message)

    def _respond(self, message):
        try:
            params = message.get('params')
            if not isinstance(params, dict):
                raise CapError('params must be an object')
            sid = params.get('sessionId')
            if not isinstance(sid, str) or not self.known_session(sid):
                raise CapError('Unknown sessionId')
            result = self.call(message['method'], params)
            reply = {'jsonrpc': '2.0', 'id': message['id'], 'result': result}
        except CapError as error:
            reply = {'jsonrpc': '2.0', 'id': message['id'], 'error': {'code': error.code, 'message': str(error)}}
        except Exception as error:  # never let a bad request take down the reader thread
            log.exception('Client capability request failed')
            reply = {'jsonrpc': '2.0', 'id': message['id'], 'error': {'code': -32603, 'message': f'Client capability failed: {type(error).__name__}: {error}'}}
        try:
            self.write_response(reply)
        except (OSError, ValueError):
            pass

    def call(self, method, params):
        if not self.handles(method):
            raise CapError(f'Client capability not advertised: {method}', -32601)
        name = method.replace('/', '_')
        return getattr(self, 'do_' + name)(params)

    # --- filesystem ----------------------------------------------------------------
    @staticmethod
    def _positive_int(value, name):
        if value is None:
            return None
        if isinstance(value, bool) or not isinstance(value, int) or value < 1:
            raise CapError(f'{name} must be a positive integer')
        return value

    def do_fs_read_text_file(self, params):
        real = resolve_inside(params.get('path'), self.workspace)
        line, limit = self._positive_int(params.get('line'), 'line'), self._positive_int(params.get('limit'), 'limit')
        if not os.path.isfile(real):
            raise CapError('path is not a regular file')
        if line is None and limit is None and os.path.getsize(real) > MAX_READ_BYTES:
            raise CapError(f'File is larger than {MAX_READ_BYTES} bytes; request a slice with line and limit')
        start = (line or 1) - 1
        out, size, scanned = [], 0, 0
        with io.open(real, 'rb') as handle:
            for index, raw in enumerate(handle):
                scanned += len(raw)
                if index == 0 and b'\0' in raw[:8192]:
                    raise CapError('File looks binary, not text')
                if index < start:
                    if scanned > MAX_SCAN_BYTES:
                        raise CapError('File is too large to seek to that line')
                    continue
                if limit is not None and len(out) >= limit:
                    break
                size += len(raw)
                if size > MAX_READ_BYTES:
                    raise CapError(f'Requested text exceeds {MAX_READ_BYTES} bytes; request fewer lines')
                out.append(raw)
        return {'content': b''.join(out).decode('utf-8', 'replace')}

    def do_fs_write_text_file(self, params):
        content = params.get('content')
        if not isinstance(content, str):
            raise CapError('content must be a string')
        data = content.encode('utf-8')
        if len(data) > MAX_WRITE_BYTES:
            raise CapError(f'content exceeds {MAX_WRITE_BYTES} bytes')
        real = resolve_inside(params.get('path'), self.workspace)
        if '.git' in {part.lower() for part in os.path.normpath(real).split(os.sep)}:
            raise CapError('Writing inside a .git folder is not allowed')
        if os.path.isdir(real):
            raise CapError('path is a directory')
        parent = os.path.dirname(real)
        with self.write_lock:
            created = not os.path.exists(real)
            # real is already inside the workspace, so any directories created here are too.
            os.makedirs(parent, exist_ok=True)
            fd, temp = tempfile.mkstemp(dir=parent, prefix='.studio-write-', suffix='.tmp')
            try:
                with os.fdopen(fd, 'wb') as handle:
                    handle.write(data)
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(temp, real)
            except BaseException:
                try:
                    os.unlink(temp)
                except OSError:
                    pass
                raise
        entry = {'path': real, 'bytes': len(data), 'created': created, 'sessionId': params.get('sessionId'), 'time': time.time()}
        with self.lock:
            self.writes.append(entry)
        self.record('client_fs', dict(entry, op='write'))
        return None

    # --- terminals -----------------------------------------------------------------
    def _terminal(self, params):
        terminal_id = params.get('terminalId')
        with self.lock:
            terminal = self.terminals.get(terminal_id) if isinstance(terminal_id, str) else None
        if terminal is None or terminal.session_id != params.get('sessionId') or terminal.released:
            raise CapError('Unknown terminalId')
        return terminal

    def _environment(self, requested):
        env = {k: v for k, v in os.environ.items() if k.upper() in BASE_ENV_NAMES}
        if requested is None:
            return env
        if not isinstance(requested, list) or len(requested) > MAX_ENV:
            raise CapError(f'env must be a list of at most {MAX_ENV} name/value objects')
        for item in requested:
            if not isinstance(item, dict) or not isinstance(item.get('name'), str) or not isinstance(item.get('value'), str):
                raise CapError('Each env entry needs string name and value')
            if not ENV_NAME.match(item['name']) or '\0' in item['value'] or len(item['value']) > MAX_ARG_CHARS:
                raise CapError(f'Invalid environment variable: {item["name"][:40]!r}')
            env[item['name']] = item['value']
        return env

    def do_terminal_create(self, params):
        command, args = params.get('command'), params.get('args', [])
        if not isinstance(command, str) or not command.strip() or '\0' in command or len(command) > 4096:
            raise CapError('command must be a non-empty string')
        if args is None:
            args = []
        if not isinstance(args, list) or len(args) > MAX_ARGS or any(not isinstance(a, str) or '\0' in a or len(a) > MAX_ARG_CHARS for a in args):
            raise CapError(f'args must be a list of at most {MAX_ARGS} strings')
        cwd = self.workspace if params.get('cwd') is None else resolve_inside(params['cwd'], self.workspace, 'cwd')
        if not os.path.isdir(cwd):
            raise CapError('cwd is not an existing directory')
        limit = params.get('outputByteLimit')
        if limit is None:
            limit = DEFAULT_OUTPUT_LIMIT
        elif isinstance(limit, bool) or not isinstance(limit, int) or limit < 0:
            raise CapError('outputByteLimit must be a non-negative integer')
        limit = min(limit, MAX_OUTPUT_LIMIT)
        env = self._environment(params.get('env'))
        program = command if os.path.dirname(command) else shutil.which(command, path=env.get('PATH') or os.defpath)
        if not program or not os.path.isfile(program):
            raise CapError(f'Command not found: {command[:80]}')
        if os.name == 'nt' and program.lower().endswith(('.bat', '.cmd')):
            raise CapError('Batch files (.bat/.cmd) are not allowed because cmd.exe would reinterpret the arguments')
        with self.lock:
            if self.shut:
                raise CapError('Connection is closing', -32603)
            if sum(1 for t in self.terminals.values() if not t.released) >= MAX_TERMINALS:
                raise CapError(f'At most {MAX_TERMINALS} terminals may be open at once; release one first')
            flags = getattr(subprocess, 'CREATE_NO_WINDOW', 0) | getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0)
            try:
                process = subprocess.Popen([program, *args], cwd=cwd, env=env, shell=False, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                           stderr=subprocess.STDOUT, creationflags=flags, start_new_session=(os.name != 'nt'))
            except (OSError, ValueError) as error:
                raise CapError(f'Could not start command: {error}', -32603)
            terminal_id = 'term_' + secrets.token_hex(8)
            self.terminals[terminal_id] = Terminal(terminal_id, params['sessionId'], [command, *args], cwd, process, limit)
        self.record('client_terminal', {'op': 'create', 'terminalId': terminal_id, 'command': command, 'args': args[:20], 'cwd': cwd})
        return {'terminalId': terminal_id}

    def do_terminal_output(self, params):
        terminal = self._terminal(params)
        output, truncated = terminal.snapshot()
        result = {'output': output, 'truncated': truncated}
        status = terminal.exit_status()
        if status:
            result['exitStatus'] = status
        return result

    def do_terminal_wait_for_exit(self, params):
        terminal = self._terminal(params)
        terminal.exited.wait()
        terminal.reader.join(timeout=2)
        return terminal.exit_status() or {'exitCode': None, 'signal': None}

    def do_terminal_kill(self, params):
        self._terminal(params).kill()
        return None

    def do_terminal_release(self, params):
        terminal = self._terminal(params)
        terminal.released = True
        terminal.kill()
        with self.lock:
            self.terminals.pop(terminal.id, None)
        self.record('client_terminal', {'op': 'release', 'terminalId': terminal.id})
        return None

    # --- cleanup and state ---------------------------------------------------------
    def close_session(self, session_id):
        with self.lock:
            victims = [t for t in self.terminals.values() if t.session_id == session_id]
            for t in victims:
                t.released = True
                self.terminals.pop(t.id, None)
        for t in victims:
            t.kill()

    def shutdown(self):
        with self.lock:
            self.shut = True
            victims = list(self.terminals.values())
            self.terminals.clear()
        for t in victims:
            t.released = True
            t.kill()

    def public(self):
        with self.lock:
            terminals = list(self.terminals.values())
            writes = list(self.writes)
        rows = []
        for t in terminals:
            output, truncated = t.snapshot()
            status = t.exit_status()
            rows.append({'id': t.id, 'sessionId': t.session_id, 'command': ' '.join([t.argv[0], *t.argv[1:]])[:500], 'cwd': t.cwd, 'status': t.status(),
                         'exitCode': status['exitCode'] if status else None, 'signal': status['signal'] if status else None,
                         'truncated': truncated or len(output) > TAIL_CHARS, 'outputTail': output[-TAIL_CHARS:]})
        return {'terminal': self.terminal_enabled, 'fs': self.fs_mode, 'terminals': rows, 'writes': writes}
