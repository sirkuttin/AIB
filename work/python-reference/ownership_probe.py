"""Best-effort, read-only evidence that another client is using a saved conversation.

Verdicts (never "safe"):
  owned_by_studio  this Studio holds the conversation (authoritative)
  owned_elsewhere  strong evidence another client holds it: a live owner announcement, or a native
                   agent process whose command line names the session ID
  possibly_active  weak evidence only: transcript written moments ago by someone else, a process
                   holding the transcript open, an agent process in the same project folder, an
                   expired or unverifiable announcement
  no_evidence      nothing was found; this is NOT proof the conversation is free

Every signal is read-only. Nothing here writes to transcripts, kills processes or opens a file for
writing outside Studio's own announcement files. See docs/ownership-design.md.
"""

from __future__ import annotations

import datetime as _dt
import hashlib
import json
import logging
import os
import re
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Callable, Dict, Iterable, List, Optional

from ownership import OwnershipConflict, find_external_owner

log = logging.getLogger(__name__)
log.addHandler(logging.NullHandler())   # a library logger: quiet until a program configures logging (log_setup.py)

FORMAT_NAME = 'agent-session-owner'
FORMAT_VERSION = 1
MAX_ANNOUNCEMENT_BYTES = 4096
DEFAULT_TTL_SECONDS = 30
HEARTBEAT_SECONDS = 10
ACTIVE_WINDOW_SECONDS = 120      # a transcript written this recently counts as weak evidence
RECENT_WINDOW_SECONDS = 900      # hint scans look only at transcripts this fresh
RELEASE_GRACE_SECONDS = 3.0      # writes this soon after Studio released it are Studio's own
SNAPSHOT_TTL_SECONDS = 4.0
HINT_TTL_SECONDS = 3.0
STATE_ORDER = {'no_evidence': 0, 'possibly_active': 1, 'owned_elsewhere': 2, 'owned_by_studio': 3}
SESSION_ID_RE = re.compile(r'^[A-Za-z0-9._-]{1,128}$')
PROVIDER_RE = re.compile(r'^[a-z0-9_-]{1,32}$')

NO_EVIDENCE_NOTE = ('AIB found no sign of another app using this conversation, but it cannot see every client '
                    '(for example an idle session open in another app writes nothing). This is not proof that it is free.')


class OwnershipEvidence(OwnershipConflict):
    """Raised when the evidence blocks (code 'session_in_use') or needs confirmation (code 'possibly_active')."""

    def __init__(self, message, code, verdict):
        super().__init__(message)
        self.code, self.verdict = code, verdict


def clean_text(value, limit=120):
    """Untrusted text for display: control characters removed, length capped."""
    text = ''.join(ch if ch.isprintable() else ' ' for ch in str(value))
    text = re.sub(r'\s+', ' ', text).strip()
    return text if len(text) <= limit else text[:limit - 1] + '…'


def humanize_age(seconds):
    seconds = max(0, int(seconds))
    if seconds < 90:
        return f'{seconds} second' + ('' if seconds == 1 else 's')
    minutes = round(seconds / 60)
    if minutes < 90:
        return f'{minutes} minutes'
    hours = round(seconds / 3600)
    return f'{hours} hours' if hours < 48 else f'{round(seconds / 86400)} days'


def default_owners_dir():
    """Well-known per-user folder for owner announcements (documented in docs/ownership-design.md)."""
    if os.name == 'nt':
        base = os.environ.get('LOCALAPPDATA') or str(Path.home() / 'AppData' / 'Local')
        return Path(base) / 'agent-sessions' / 'owners'
    base = os.environ.get('XDG_STATE_HOME') or str(Path.home() / '.local' / 'state')
    return Path(base) / 'agent-sessions' / 'owners'


def _iso(when):
    return _dt.datetime.fromtimestamp(when, _dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def _parse_iso(value):
    try:
        parsed = _dt.datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=_dt.timezone.utc)
    return parsed.timestamp()


# ---------------------------------------------------------------------------------------------
# Windows process helpers (ctypes, read-only). Everything degrades to "unavailable".
# ---------------------------------------------------------------------------------------------
if os.name == 'nt':
    import ctypes
    from ctypes import wintypes as _w

    _k32 = ctypes.WinDLL('kernel32', use_last_error=True)
    _nt = ctypes.WinDLL('ntdll')
    _k32.OpenProcess.restype = _w.HANDLE
    _k32.OpenProcess.argtypes = [_w.DWORD, _w.BOOL, _w.DWORD]
    _k32.ReadProcessMemory.argtypes = [_w.HANDLE, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
    _k32.CloseHandle.argtypes = [_w.HANDLE]
    _k32.CreateToolhelp32Snapshot.restype = _w.HANDLE
    _k32.CreateToolhelp32Snapshot.argtypes = [_w.DWORD, _w.DWORD]
    _k32.GetExitCodeProcess.argtypes = [_w.HANDLE, ctypes.POINTER(_w.DWORD)]
    _k32.GetProcessTimes.argtypes = [_w.HANDLE] + [ctypes.POINTER(_w.FILETIME)] * 4

    class _ProcessEntry(ctypes.Structure):
        _fields_ = [('dwSize', _w.DWORD), ('cntUsage', _w.DWORD), ('th32ProcessID', _w.DWORD), ('th32DefaultHeapID', ctypes.c_void_p),
                    ('th32ModuleID', _w.DWORD), ('cntThreads', _w.DWORD), ('th32ParentProcessID', _w.DWORD), ('pcPriClassBase', _w.LONG),
                    ('dwFlags', _w.DWORD), ('szExeFile', _w.WCHAR * 260)]

    class _BasicInfo(ctypes.Structure):
        _fields_ = [('Reserved1', ctypes.c_void_p), ('PebBaseAddress', ctypes.c_void_p), ('Reserved2', ctypes.c_void_p * 2),
                    ('UniqueProcessId', ctypes.c_void_p), ('Reserved3', ctypes.c_void_p)]

    class _RmUniqueProcess(ctypes.Structure):
        _fields_ = [('dwProcessId', _w.DWORD), ('ftStart', _w.FILETIME)]

    class _RmProcessInfo(ctypes.Structure):
        _fields_ = [('Process', _RmUniqueProcess), ('strAppName', _w.WCHAR * 256), ('strServiceShortName', _w.WCHAR * 64),
                    ('ApplicationType', ctypes.c_int), ('AppStatus', _w.ULONG), ('TSSessionId', _w.DWORD), ('bRestartable', _w.BOOL)]


def _win_open(pid, access):
    return _k32.OpenProcess(access, False, int(pid))


def _win_process_strings(pid):
    """(command line, current directory) read from the process's PEB; (None, None) if not readable.

    Needs only PROCESS_QUERY_INFORMATION | PROCESS_VM_READ on a same-user, 64-bit process."""
    handle = _win_open(pid, 0x0400 | 0x0010)
    if not handle:
        return None, None
    try:
        info = _BasicInfo()
        returned = _w.ULONG()
        if _nt.NtQueryInformationProcess(handle, 0, ctypes.byref(info), ctypes.sizeof(info), ctypes.byref(returned)):
            return None, None

        def read(address, size):
            buffer = ctypes.create_string_buffer(size)
            count = ctypes.c_size_t()
            if not _k32.ReadProcessMemory(handle, ctypes.c_void_p(address), buffer, size, ctypes.byref(count)):
                return None
            return buffer.raw[:count.value]

        pointer = read(info.PebBaseAddress + 0x20, 8)  # PEB.ProcessParameters (x64 layout)
        if not pointer:
            return None, None
        params = int.from_bytes(pointer, 'little')

        def unicode_string(offset, limit):
            header = read(params + offset, 16)
            if not header:
                return None
            length, address = int.from_bytes(header[0:2], 'little'), int.from_bytes(header[8:16], 'little')
            if not length or not address:
                return ''
            raw = read(address, min(length, limit))
            return raw.decode('utf-16-le', 'replace') if raw else None

        return unicode_string(0x70, 16384), unicode_string(0x38, 4096)
    except (OSError, ValueError, AttributeError):
        return None, None
    finally:
        _k32.CloseHandle(handle)


def _win_process_list():
    snapshot = _k32.CreateToolhelp32Snapshot(2, 0)
    if snapshot in (None, -1, ctypes.c_void_p(-1).value):
        raise OSError('Process list unavailable')
    result = []
    try:
        entry = _ProcessEntry()
        entry.dwSize = ctypes.sizeof(entry)
        ok = _k32.Process32FirstW(snapshot, ctypes.byref(entry))
        while ok:
            result.append((int(entry.th32ProcessID), int(entry.th32ParentProcessID), entry.szExeFile))
            ok = _k32.Process32NextW(snapshot, ctypes.byref(entry))
    finally:
        _k32.CloseHandle(snapshot)
    return result


def process_start_time(pid):
    """Process creation time as epoch seconds, or None."""
    if os.name != 'nt':
        return None
    handle = _win_open(pid, 0x1000)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not handle:
        return None
    try:
        created, exited, kernel, user = (_w.FILETIME() for _ in range(4))
        if not _k32.GetProcessTimes(handle, *(ctypes.byref(t) for t in (created, exited, kernel, user))):
            return None
        ticks = (created.dwHighDateTime << 32) | created.dwLowDateTime
        return ticks / 10_000_000 - 11644473600
    finally:
        _k32.CloseHandle(handle)


def process_alive(pid, expected_start=None):
    """True/False when it can be told, None when unknown. A differing start time means PID reuse."""
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return None
    if pid <= 0:
        return False
    if os.name == 'nt':
        handle = _win_open(pid, 0x1000)
        if not handle:
            return False if ctypes.get_last_error() == 87 else None  # 87 = invalid parameter: no such PID
        try:
            code = _w.DWORD()
            if not _k32.GetExitCodeProcess(handle, ctypes.byref(code)) or code.value != 259:
                return False
        finally:
            _k32.CloseHandle(handle)
        started = process_start_time(pid)
        if expected_start is not None and started is not None and abs(started - expected_start) > 5:
            return False
        return True
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except OSError:
        return None


def restart_manager_holders(path):
    """[(pid, app name)] of processes that currently hold `path` open, via the Windows Restart Manager.

    Read-only: it asks Windows who has the file open and takes no handle with a share mode that could
    block a writer. Returns None when unavailable. A client that opens, appends and closes (Claude Code
    and OMP do) is only visible during the instant it holds the file, so [] proves nothing."""
    if os.name != 'nt':
        return None
    try:
        rm = ctypes.WinDLL('rstrtmgr', use_last_error=True)
        session = _w.DWORD(0)
        key = (_w.WCHAR * 33)()
        if rm.RmStartSession(ctypes.byref(session), 0, key):
            return None
        try:
            files = (_w.LPCWSTR * 1)(str(path))
            if rm.RmRegisterResources(session, 1, files, 0, None, 0, None):
                return None
            needed, count, reasons = _w.UINT(0), _w.UINT(0), _w.DWORD(0)
            status = rm.RmGetList(session, ctypes.byref(needed), ctypes.byref(count), None, ctypes.byref(reasons))
            if status == 0:
                return []
            if status != 234:  # ERROR_MORE_DATA
                return None
            buffer = (_RmProcessInfo * needed.value)()
            count = _w.UINT(needed.value)
            if rm.RmGetList(session, ctypes.byref(needed), ctypes.byref(count), buffer, ctypes.byref(reasons)):
                return None
            return [(int(item.Process.dwProcessId), item.strAppName) for item in buffer[:count.value]]
        finally:
            rm.RmEndSession(session)
    except (OSError, AttributeError, ValueError):
        return None


# ---------------------------------------------------------------------------------------------
# Process snapshot (cached) and classification of agent clients
# ---------------------------------------------------------------------------------------------
_INTERESTING = {'claude.exe', 'omp.exe', 'node.exe', 'devin.exe', 'claude', 'omp', 'node', 'devin'}
_PARENT_LABELS = {'devin.exe': 'Devin', 'code.exe': 'VS Code', 'claude.exe': 'Claude app or CLI', 'windowsterminal.exe': 'a terminal',
                  'cmd.exe': 'a terminal', 'powershell.exe': 'a terminal', 'pwsh.exe': 'a terminal', 'python.exe': 'a Python program (possibly another AIB)',
                  'pythonw.exe': 'a Python program (possibly another AIB)', 'cursor.exe': 'Cursor', 'windsurf.exe': 'Windsurf'}


def _ps_lines(run, columns):
    """Lines of `ps -axww -o <columns>`; raises OSError when ps is missing, fails or times out (never returns a guess)."""
    try:
        done = run(['ps', '-axww', '-o', columns], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                   timeout=8, check=False)
    except (OSError, subprocess.SubprocessError, ValueError) as error:
        raise OSError('ps is not available: ' + clean_text(error)) from error
    if done.returncode != 0:
        raise OSError('ps failed')
    out = done.stdout
    text = out.decode('utf-8', 'replace') if isinstance(out, (bytes, bytearray)) else str(out or '')
    return text.splitlines()


def fetch_processes_ps(run=None):
    """macOS: [{pid, ppid, name, cmdline, cwd}] from `ps`. cwd is None (ps does not report it). Any failure raises OSError,
    which the caller reports as "process check unavailable", never as "no process found"."""
    run = run or subprocess.run
    names = {}
    for line in _ps_lines(run, 'pid=,ppid=,comm='):
        parts = line.split(None, 2)
        if len(parts) == 3 and parts[0].isdigit() and parts[1].isdigit():
            names[int(parts[0])] = (int(parts[1]), parts[2].strip())
    if not names:
        raise OSError('ps returned no processes')
    commands = {}
    try:
        for line in _ps_lines(run, 'pid=,command='):
            parts = line.split(None, 1)
            if len(parts) == 2 and parts[0].isdigit():
                commands[int(parts[0])] = parts[1].strip()
    except OSError:
        log.warning('ps command lines unavailable', exc_info=True)   # names alone still identify some clients; no session ids though
    result = []
    for pid, (ppid, comm) in names.items():
        name = os.path.basename(comm)
        result.append({'pid': pid, 'ppid': ppid, 'name': name, 'cmdline': commands.get(pid) if name.lower() in _INTERESTING else None, 'cwd': None})
    return result


def fetch_processes():
    """Windows: [{pid, ppid, name, cmdline, cwd}] for agent-relevant executables plus names of the rest."""
    if os.name == 'nt':
        result = []
        for pid, ppid, name in _win_process_list():
            item = {'pid': pid, 'ppid': ppid, 'name': name, 'cmdline': None, 'cwd': None}
            if name.lower() in _INTERESTING:
                item['cmdline'], item['cwd'] = _win_process_strings(pid)
            result.append(item)
        return result
    proc = Path('/proc')
    if not proc.is_dir():
        if sys.platform == 'darwin':
            return fetch_processes_ps()
        raise OSError('Process inspection is not available on this platform')
    result = []
    for entry in proc.iterdir():
        if not entry.name.isdigit():
            continue
        try:
            raw = (entry / 'cmdline').read_bytes().split(b'\0')
            name = Path(os.readlink(entry / 'exe')).name if (entry / 'exe').exists() else (entry / 'comm').read_text().strip()
            stat = (entry / 'stat').read_text().rsplit(')', 1)[1].split()
            cwd = os.readlink(entry / 'cwd')
        except (OSError, IndexError):
            continue
        result.append({'pid': int(entry.name), 'ppid': int(stat[1]), 'name': name, 'cmdline': ' '.join(p.decode('utf-8', 'replace') for p in raw if p), 'cwd': cwd})
    return result


class ProcessSource:
    """A cached process snapshot. One read serves every probe for SNAPSHOT_TTL_SECONDS."""

    def __init__(self, fetch=fetch_processes, ttl=SNAPSHOT_TTL_SECONDS, clock=time.monotonic):
        self._fetch, self._ttl, self._clock = fetch, ttl, clock
        self._lock = threading.Lock()
        self._data = None
        self._at = None
        self._error = ''
        self.fetches = 0

    @property
    def failed(self):
        """True when the last real read of the process list failed (it stays true until a later read succeeds)."""
        return bool(self._error)

    def get(self, max_age=None, refresh=True):
        """(snapshot or None, error). refresh=False returns only what is already cached."""
        limit = self._ttl if max_age is None else max_age
        with self._lock:
            now = self._clock()
            if self._at is not None and now - self._at < limit:
                return self._data, self._error
            if not refresh:
                return None, 'not sampled recently'
            self.fetches += 1
            try:
                self._data, self._error = list(self._fetch()), ''
            except Exception as error:  # an unreadable process list must never break a continue
                log.warning('Process list unavailable', exc_info=True)
                self._data, self._error = None, clean_text(error) or 'Process list unavailable'
            self._at = self._clock()
            return self._data, self._error


def _listdir(path):
    """os.scandir entries, fully read and closed (entries keep their cached stat data)."""
    with os.scandir(path) as iterator:
        return list(iterator)


def _basename(value):
    return os.path.basename(str(value).replace('\\', '/')).lower()


def classify(proc):
    """Return {'provider', 'kind', 'label', 'session'} for a known agent client process, else None.

    'session' is the session ID in the command line when there is one (then it identifies that session)."""
    name = _basename(proc.get('name') or '')
    command = proc.get('cmdline') or ''
    low = command.lower()
    if '--type=' in low:  # Electron helper process (renderer, gpu, utility): not an agent
        return None
    session = None
    match = re.search(r'--(?:resume|session-id)[= ]"?([A-Za-z0-9._-]+)"?', command)
    if match:
        session = match.group(1)
    if name in ('omp.exe', 'omp'):
        return {'provider': 'omp', 'kind': 'omp', 'label': 'OMP', 'session': session}
    if name in ('node.exe', 'node') and 'claude-agent-acp' in low:
        return {'provider': 'claude', 'kind': 'claude-adapter', 'label': 'Claude Code ACP adapter', 'session': session}
    if name in ('claude.exe', 'claude') and ('stream-json' in low or '@anthropic-ai' in low or 'claude-code' in low):
        return {'provider': 'claude', 'kind': 'claude-engine', 'label': 'Claude Code', 'session': session}
    if name in ('devin.exe', 'devin') and ' acp' in low and '--agent-type' not in low:
        return {'provider': None, 'kind': 'devin', 'label': 'Devin agent', 'session': session}
    return None


def _same_folder(a, b):
    def norm(value):
        value = os.path.normcase(os.path.normpath(str(value))) if value else ''
        return value.rstrip('\\/') if len(value) > 3 else value
    return bool(a) and bool(b) and norm(a) == norm(b)


# ---------------------------------------------------------------------------------------------
# Cooperative registry: owner announcements
# ---------------------------------------------------------------------------------------------
def announcement_prefix(provider, session_id):
    return hashlib.sha256((str(provider) + '\0' + str(session_id)).encode('utf-8')).hexdigest()[:32]


def validate_announcement(data, prefix=None):
    """A normalized announcement dict, or raises ValueError. Every field is untrusted."""
    if not isinstance(data, dict) or data.get('format') != FORMAT_NAME:
        raise ValueError('not an owner announcement')
    version = data.get('version')
    if not isinstance(version, int) or isinstance(version, bool) or version != FORMAT_VERSION:
        raise ValueError('unsupported announcement version')
    provider, session_id = data.get('provider'), data.get('sessionId')
    if not isinstance(provider, str) or not PROVIDER_RE.match(provider):
        raise ValueError('bad provider')
    if not isinstance(session_id, str) or not 0 < len(session_id) <= 512:
        raise ValueError('bad sessionId')
    if prefix is not None and announcement_prefix(provider, session_id) != prefix:
        raise ValueError('announcement does not match its file name')
    client = data.get('client') if isinstance(data.get('client'), dict) else {}
    pid = data.get('pid')
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        raise ValueError('bad pid')
    heartbeat = _parse_iso(data.get('heartbeatAt'))
    if heartbeat is None:
        raise ValueError('bad heartbeatAt')
    ttl = data.get('ttlSeconds', DEFAULT_TTL_SECONDS)
    if not isinstance(ttl, (int, float)) or isinstance(ttl, bool) or not 5 <= ttl <= 300:
        raise ValueError('bad ttlSeconds')
    return {'provider': provider, 'sessionId': session_id,
            'clientName': clean_text(client.get('name') or 'unknown client', 60), 'clientVersion': clean_text(client.get('version') or '', 30),
            'instanceId': clean_text(client.get('instanceId') or '', 64), 'pid': pid,
            'pidStart': _parse_iso(data.get('pidStart')) if data.get('pidStart') else None,
            'hostname': clean_text(data.get('hostname') or '', 80), 'cwd': clean_text(data.get('cwd') or '', 300),
            'state': clean_text(data.get('state') or '', 20), 'heartbeat': heartbeat, 'ttl': float(ttl)}


class OwnerRegistry:
    """Writes announcements for sessions this client owns and reads everyone's.

    One file per (session, instance): <sha256(provider NUL session)[:32]>--<instanceId>.json, so two
    clients can never overwrite each other's claim and a conflict stays visible to both."""

    def __init__(self, directory, client_name='agent-studio', client_version='0.1.0', instance_id=None, ttl=DEFAULT_TTL_SECONDS,
                 clock=time.time, hostname=None, pid=None):
        self.directory = Path(directory)
        self.client_name, self.client_version = client_name, client_version
        self.instance_id = instance_id or os.urandom(8).hex()
        self.ttl, self.clock = ttl, clock
        self.hostname = hostname or socket.gethostname()
        self.pid = pid if pid is not None else os.getpid()
        self._start = process_start_time(self.pid) if pid is None else None
        self._claimed = {}
        self._lock = threading.RLock()
        self.write_error = ''

    def _path(self, provider, session_id):
        return self.directory / f'{announcement_prefix(provider, session_id)}--{re.sub("[^A-Za-z0-9]", "", self.instance_id)[:32]}.json'

    def announce(self, provider, session_id, cwd='', state='ready'):
        """Create or refresh our announcement (atomic replace). Returns False if it could not be written."""
        if not isinstance(session_id, str) or not session_id or not PROVIDER_RE.match(str(provider)):
            return False
        with self._lock:
            now = self.clock()
            previous = self._claimed.get((provider, session_id), {})
            body = {'format': FORMAT_NAME, 'version': FORMAT_VERSION, 'provider': provider, 'sessionId': session_id,
                    'client': {'name': self.client_name, 'version': self.client_version, 'instanceId': self.instance_id},
                    'pid': self.pid, 'pidStart': _iso(self._start) if self._start else None, 'hostname': self.hostname,
                    'cwd': str(cwd or ''), 'state': state, 'announcedAt': previous.get('announcedAt') or _iso(now),
                    'heartbeatAt': _iso(now), 'ttlSeconds': self.ttl}
            path = self._path(provider, session_id)
            try:
                self.directory.mkdir(parents=True, exist_ok=True)
                temporary = path.with_name(path.name + f'.{os.getpid()}.tmp')
                temporary.write_text(json.dumps(body, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
                os.replace(temporary, path)
            except OSError as error:
                self.write_error = clean_text(error)
                return False
            self._claimed[(provider, session_id)] = {'announcedAt': body['announcedAt'], 'cwd': body['cwd'], 'state': state}
            self.write_error = ''
            return True

    def withdraw(self, provider, session_id):
        with self._lock:
            self._claimed.pop((provider, session_id), None)
            try:
                self._path(provider, session_id).unlink()
            except FileNotFoundError:
                pass
            except OSError as error:
                self.write_error = clean_text(error)

    def withdraw_all(self):
        for provider, session_id in list(self._claimed):
            self.withdraw(provider, session_id)

    def claimed(self):
        with self._lock:
            return dict(self._claimed)

    def read(self, provider=None, session_id=None):
        """Return (entries, problems). Each entry: validated announcement + status/age. Never raises."""
        entries, problems = [], 0
        try:
            names = [e.name for e in _listdir(self.directory) if e.name.endswith('.json')]
        except OSError:
            return entries, problems
        prefix = announcement_prefix(provider, session_id) if provider and session_id else None
        now = self.clock()
        for name in names:
            if prefix and not name.startswith(prefix + '--'):
                continue
            path = self.directory / name
            try:
                if path.stat().st_size > MAX_ANNOUNCEMENT_BYTES:
                    raise ValueError('oversized')
                item = validate_announcement(json.loads(path.read_text(encoding='utf-8')), name.split('--', 1)[0])
            except (OSError, ValueError, UnicodeError):
                problems += 1
                continue
            item['own'] = item['instanceId'] == self.instance_id
            item['age'] = max(0.0, now - item['heartbeat'])
            if item['heartbeat'] - now > 300:
                problems += 1  # a heartbeat far in the future means a wrong clock; not trusted
                continue
            fresh = item['age'] <= item['ttl'] + 5
            same_host = not item['hostname'] or item['hostname'].lower() == self.hostname.lower()
            if same_host:
                alive = process_alive(item['pid'], item['pidStart'])
                item['status'] = 'dead' if alive is False else ('live' if fresh else 'stale')
            else:
                item['status'] = 'remote' if fresh else 'expired'
            entries.append(item)
        return entries, problems


# ---------------------------------------------------------------------------------------------
# The probe
# ---------------------------------------------------------------------------------------------
class OwnershipProbe:
    def __init__(self, omp_root=None, claude_root=None, registry: Optional[OwnerRegistry] = None, processes: Optional[ProcessSource] = None,
                 owned_by_studio: Callable[[str, str], bool] = lambda provider, session_id: False,
                 own_pids: Callable[[], Iterable[int]] = lambda: (), lock_probe=restart_manager_holders, clock=time.time,
                 inspect_processes=True):
        self.roots = {'omp': Path(omp_root) if omp_root else None, 'claude': Path(claude_root) if claude_root else None}
        self.registry = registry
        self.processes = processes or ProcessSource()
        self.owned_by_studio, self.own_pids, self.lock_probe, self.clock = owned_by_studio, own_pids, lock_probe, clock
        self.inspect_processes = inspect_processes
        self._released = {}
        self._seen = {}
        self._lock = threading.Lock()
        self._hint_cache = (0.0, {})

    # -- bookkeeping -------------------------------------------------------------------------
    def note_released(self, provider, session_id):
        """Studio just stopped running this conversation: transcript writes up to now are Studio's own."""
        with self._lock:
            self._released[(provider, session_id)] = self.clock()
            for key in sorted(self._released, key=self._released.get)[:-256]:
                self._released.pop(key, None)

    # -- transcripts -------------------------------------------------------------------------
    def find_transcript(self, provider, session_id):
        root = self.roots.get(provider)
        if root is None or not isinstance(session_id, str) or not SESSION_ID_RE.match(session_id):
            return None
        try:
            for folder in _listdir(root):
                if not folder.is_dir():
                    continue
                if provider == 'claude':
                    candidate = Path(folder.path) / f'{session_id}.jsonl'
                    if candidate.is_file():
                        return candidate
                else:
                    for entry in _listdir(folder.path):
                        stem = entry.name[:-6] if entry.name.endswith('.jsonl') else None
                        if stem and (stem == session_id or stem.endswith('_' + session_id)):
                            return Path(entry.path)
        except OSError:
            return None
        return None

    @staticmethod
    def _stem_to_id(provider, name):
        stem = name[:-6]
        return stem.rsplit('_', 1)[-1] if provider == 'omp' else stem

    def _transcript_signal(self, provider, session_id, path, deep):
        """Weak reason when the transcript was written moments ago by someone other than Studio."""
        try:
            stat = path.stat()
        except OSError:
            return None, None
        now = self.clock()
        modified = stat.st_mtime
        age = max(0.0, now - modified)
        with self._lock:
            released = self._released.get((provider, session_id))
            before = self._seen.get(str(path))
            self._seen[str(path)] = (stat.st_size, stat.st_mtime_ns, now)
            for key in sorted(self._seen, key=lambda k: self._seen[k][2])[:-512]:
                self._seen.pop(key, None)
        info = f'Transcript last written {humanize_age(age)} ago'
        if released is not None and modified <= released + RELEASE_GRACE_SECONDS:
            return None, info + ' (by AIB itself, before it released the conversation)'
        newest, label = age, 'Transcript'
        if deep:  # Claude subagents and OMP artifacts live in a sibling folder named like the transcript
            folder = path.with_suffix('')
            try:
                if folder.is_dir():
                    seen = 0
                    for child in folder.rglob('*.jsonl'):
                        seen += 1
                        if seen > 200:
                            break
                        child_age = now - child.stat().st_mtime
                        if child_age < newest:
                            newest, label = max(0.0, child_age), 'A subagent transcript of this conversation'
            except OSError:
                pass
        if newest > ACTIVE_WINDOW_SECONDS:
            return None, info + ' (an idle session open in another app would not write anything)'
        text = f'{label} was written {humanize_age(newest)} ago, and AIB is not the app writing it'
        if before and stat.st_size > before[0]:
            text += f' (it grew by {stat.st_size - before[0]:,} bytes since AIB last looked)'
        return {'signal': 'transcript', 'strength': 'weak', 'text': text + '.'}, None

    # -- processes ---------------------------------------------------------------------------
    def _own_process_ids(self, snapshot):
        own = {os.getpid()}
        own.update(int(p) for p in (self.own_pids() or ()) if isinstance(p, int))
        if snapshot:
            children = {}
            for proc in snapshot:
                children.setdefault(proc['ppid'], []).append(proc['pid'])
            todo = list(own)
            while todo:
                for child in children.get(todo.pop(), ()):
                    if child not in own:
                        own.add(child)
                        todo.append(child)
        return own

    @staticmethod
    def _started_by(snapshot, proc):
        by_pid = {p['pid']: p for p in snapshot}
        seen, current = set(), proc
        for _ in range(6):
            current = by_pid.get(current['ppid'])
            if current is None or current['pid'] in seen:
                return ''
            seen.add(current['pid'])
            label = _PARENT_LABELS.get(_basename(current['name']))
            if label:
                return label
        return ''

    def _process_signals(self, provider, session_id, cwd, snapshot, own, skip_cmdline, project_root=None):
        reasons = []
        if not snapshot:
            return reasons
        if not skip_cmdline:
            wanted = [{'pid': p['pid'], 'name': p['name'], 'commandline': p['cmdline']} for p in snapshot if p.get('cmdline') and _basename(p['name']) in {'claude.exe', 'omp.exe', 'claude', 'omp'}]
            pid = find_external_owner(wanted, provider, session_id, excluded_pids=own)
            if pid is not None:
                reasons.append({'signal': 'command-line', 'strength': 'strong', 'pid': pid,
                                'text': f'A {provider} process (PID {pid}) was started with this exact session ID.'})
        if not (cwd or project_root):
            return reasons
        candidates = []
        for proc in snapshot:
            if proc['pid'] in own:
                continue
            kind = classify(proc)
            if not kind or (kind['provider'] and kind['provider'] != provider):
                continue
            if kind['session'] and kind['session'] != session_id:
                continue  # it names a different session
            if not (_same_folder(proc.get('cwd'), cwd) or _same_folder(proc.get('cwd'), project_root)):   # the chat's cwd or its project root
                continue
            candidates.append((proc, kind))
        pids = {proc['pid'] for proc, _ in candidates}
        shown = [(proc, kind) for proc, kind in candidates if proc['ppid'] not in pids]  # collapse adapter -> engine chains
        for proc, kind in shown[:3]:
            parent = self._started_by(snapshot, proc)
            reasons.append({'signal': 'process-folder', 'strength': 'weak', 'pid': proc['pid'],
                            'text': f"{kind['label']} (PID {proc['pid']}{', started by ' + parent if parent else ''}) is running in this project folder. "
                                    'Agent processes do not reveal which conversation they hold, so AIB cannot tell whether it is this one.'})
        if len(shown) > 3:
            reasons.append({'signal': 'process-folder', 'strength': 'weak', 'text': f'{len(shown) - 3} more agent processes are running in this folder.'})
        return reasons

    # -- registry ----------------------------------------------------------------------------
    def _registry_signals(self, provider, session_id):
        reasons, info = [], []
        if not self.registry:
            return reasons, info, 0
        entries, problems = self.registry.read(provider, session_id)
        for entry in entries:
            if entry['own']:
                continue
            who = f"{entry['clientName']} (PID {entry['pid']})"
            if entry['status'] == 'live':
                reasons.append({'signal': 'announcement', 'strength': 'strong', 'pid': entry['pid'],
                                'text': f"{who} announced that it is running this conversation (heartbeat {humanize_age(entry['age'])} ago)."})
            elif entry['status'] == 'stale':
                reasons.append({'signal': 'announcement', 'strength': 'weak', 'pid': entry['pid'],
                                'text': f"{who} announced this conversation but has not refreshed the announcement for {humanize_age(entry['age'])}, although that process is still running."})
            elif entry['status'] == 'remote':
                reasons.append({'signal': 'announcement', 'strength': 'weak',
                                'text': f"{entry['clientName']} on {entry['hostname'] or 'another computer'} announced this conversation {humanize_age(entry['age'])} ago. AIB cannot check a process on another computer."})
            else:
                info.append(f"{entry['clientName']} once announced this conversation, but the announcement is no longer live ({'process ended' if entry['status'] == 'dead' else 'expired'}).")
        return reasons, info, problems

    # -- the verdict -------------------------------------------------------------------------
    def assess(self, provider, session_id, cwd=None, deep=True, skip_cmdline=False, fresh=False, project_root=None):
        """Full evidence for one conversation. deep=True also asks Windows who holds the transcript open."""
        started = self.clock()
        result = {'provider': provider, 'sessionId': session_id, 'reasons': [], 'notes': [], 'unavailable': [], 'checkedAt': started}
        if self.owned_by_studio(provider, session_id):
            return dict(result, verdict='owned_by_studio', summary='This conversation is running in this AIB.')
        reasons, notes, unavailable = result['reasons'], result['notes'], result['unavailable']
        extra, info, problems = self._registry_signals(provider, session_id)
        reasons.extend(extra)
        notes.extend(info)
        if problems:
            notes.append(f'{problems} unreadable owner announcement file(s) were ignored.')
        path = self.find_transcript(provider, session_id)
        if path is None:
            if self.roots.get(provider):
                notes.append('No local transcript was found for this conversation.')
        else:
            reason, note = self._transcript_signal(provider, session_id, path, deep)
            if reason:
                reasons.append(reason)
            if note:
                notes.append(note)
        snapshot, error = (None, 'process inspection is off')
        if self.inspect_processes:
            snapshot, error = self.processes.get(max_age=0 if fresh else None)
        own = self._own_process_ids(snapshot)
        if snapshot is None:
            unavailable.append('running-process check (' + error + ')')
        else:
            reasons.extend(self._process_signals(provider, session_id, cwd, snapshot, own, skip_cmdline, project_root))
            unreadable = sum(1 for p in snapshot if _basename(p['name']) in {'omp.exe', 'claude.exe', 'omp', 'claude'} and p.get('cmdline') is None and p['pid'] not in own)
            if unreadable:
                notes.append(f'{unreadable} agent process(es) could not be inspected (different user or elevated).')
        if deep and path is not None:
            holders = self.lock_probe(path)
            if holders is None:
                unavailable.append('open-file check')
            else:
                others = [(pid, name) for pid, name in holders if pid not in own]
                if others:
                    pid, name = others[0]
                    reasons.append({'signal': 'file-handle', 'strength': 'weak', 'pid': pid,
                                    'text': f'{clean_text(name, 60)} (PID {pid}) has the transcript file open right now.'})
        verdict = 'owned_elsewhere' if any(r['strength'] == 'strong' for r in reasons) else 'possibly_active' if reasons else 'no_evidence'
        summaries = {
            'owned_elsewhere': 'Another app is running this conversation. AIB will not continue it from here.',
            'possibly_active': 'Another app may be using this conversation. AIB cannot be sure either way.',
            'no_evidence': NO_EVIDENCE_NOTE}
        # 'unknown' is a separate field so the verdict names stay stable: with no evidence found AND a probe that could not run
        # (process list, open-file check), the honest answer is "unknown", never "free".
        result.update(verdict=verdict, summary=summaries[verdict], elapsedMs=round((self.clock() - started) * 1000),
                      certainty='unknown' if verdict == 'no_evidence' and unavailable else 'checked' if verdict == 'no_evidence' else 'evidence')
        return result

    # -- cheap hints for the conversation list -----------------------------------------------
    def list_certainty(self):
        """What a conversation WITHOUT a hint means in the list: 'unknown' when a check this probe relies on cannot run on this
        system (no open-file check off Windows, process list off or unreadable), else 'checked'. The page shows "unknown" wording
        for 'unknown', because "nothing found" would overstate what was looked at. It is the list-wide counterpart of the
        `certainty` that assess() returns for one conversation."""
        if self.lock_probe is restart_manager_holders and os.name != 'nt':
            return 'unknown'
        if not self.inspect_processes or self.processes.failed:
            return 'unknown'
        return 'checked'

    def hints(self):
        """{ 'provider:id': {verdict, summary, reasons} } for conversations with evidence. Cheap: no new
        process scan, no per-row stat beyond directory listings, cached for HINT_TTL_SECONDS."""
        with self._lock:
            stamp, cached = self._hint_cache
        now = self.clock()
        if cached is not None and now - stamp < HINT_TTL_SECONDS and stamp:
            return cached
        found = {}
        snapshot, _ = self.processes.get(refresh=False) if self.inspect_processes else (None, '')
        own = self._own_process_ids(snapshot)
        for provider, root in self.roots.items():
            if root is None:
                continue
            try:
                folders = [f for f in _listdir(root) if f.is_dir()]
            except OSError:
                continue
            for folder in folders:
                try:
                    entries = _listdir(folder.path)
                except OSError:
                    continue
                for entry in entries:
                    if not entry.name.endswith('.jsonl'):
                        continue
                    try:
                        modified = entry.stat().st_mtime
                    except OSError:
                        continue
                    if now - modified > ACTIVE_WINDOW_SECONDS:
                        continue
                    session_id = self._stem_to_id(provider, entry.name)
                    if self.owned_by_studio(provider, session_id):
                        continue
                    reason, _ = self._transcript_signal(provider, session_id, Path(entry.path), False)
                    if reason:
                        found.setdefault((provider, session_id), []).append(reason)
        if self.registry:
            entries, _ = self.registry.read()
            for entry in entries:
                if entry['own'] or entry['status'] not in ('live', 'stale', 'remote'):
                    continue
                strong = entry['status'] == 'live'
                found.setdefault((entry['provider'], entry['sessionId']), []).append({
                    'signal': 'announcement', 'strength': 'strong' if strong else 'weak',
                    'text': f"{entry['clientName']} (PID {entry['pid']}) announced this conversation {humanize_age(entry['age'])} ago."})
        if snapshot:
            wanted = [p for p in snapshot if p['pid'] not in own and p.get('cmdline')]
            for proc in wanted:
                kind = classify(proc)
                if kind and kind['session'] and kind['provider']:
                    found.setdefault((kind['provider'], kind['session']), []).append({
                        'signal': 'command-line', 'strength': 'strong', 'pid': proc['pid'],
                        'text': f"{kind['label']} (PID {proc['pid']}) was started with this exact session ID."})
        hints = {}
        for (provider, session_id), reasons in found.items():
            if self.owned_by_studio(provider, session_id):
                continue
            verdict = 'owned_elsewhere' if any(r['strength'] == 'strong' for r in reasons) else 'possibly_active'
            hints[f'{provider}:{session_id}'] = {'verdict': verdict, 'reasons': reasons[:3]}
        with self._lock:
            self._hint_cache = (now, hints)
        return hints

    def refresh_processes_async(self, max_age=20.0):
        """Warm the process snapshot without blocking a request (used by the list endpoint)."""
        if not self.inspect_processes:
            return
        snapshot, _ = self.processes.get(max_age=max_age, refresh=False)
        if snapshot is None:
            threading.Thread(target=self.processes.get, kwargs={'max_age': 0}, daemon=True, name='agent-studio-process-snapshot').start()


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='Print the ownership evidence Studio would see for a conversation. Read-only.')
    parser.add_argument('--provider', choices=('omp', 'claude'), required=True)
    parser.add_argument('--session', required=True)
    parser.add_argument('--cwd')
    parser.add_argument('--omp-sessions', type=Path, default=Path.home() / '.omp/agent/sessions')
    parser.add_argument('--claude-projects', type=Path, default=Path.home() / '.claude/projects')
    parser.add_argument('--owners-dir', type=Path, default=default_owners_dir())
    args = parser.parse_args()
    probe = OwnershipProbe(args.omp_sessions, args.claude_projects, OwnerRegistry(args.owners_dir, client_name='ownership-probe-cli'))
    print(json.dumps(probe.assess(args.provider, args.session, args.cwd), indent=2))
