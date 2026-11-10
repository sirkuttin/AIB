"""Worktree per chat, stage G2: live sync of the user's saved edits into the chats' worktrees.

Runs in the agent host process (or in the Studio of an --in-process server), next to the connections. For every project that has at
least one open, Studio-owned worktree chat there is one watcher thread:

  trigger    ReadDirectoryChangesW (Windows, ctypes, stdlib only) pokes the thread; a 2 s poll runs as well, and is the only trigger
             elsewhere. A burst of events is debounced for 400 ms.
  candidates `git status --porcelain -z -uall` in the project folder (GIT_OPTIONAL_LOCKS=0: obeys .gitignore, never writes the user's
             index; fsmonitor is never switched on). `.env*` files are listed by a small walk, as they are usually ignored.
  stability  a changed file is synced when its size and mtime are the same in two consecutive scans. Editor temp files, symlinks, files
             over 20 MB, unmerged files and files with conflict markers are skipped; a locked file is retried.
  no echoes  nothing happens while Merge holds the project's "sync paused" flag; a scan whose project HEAD differs from the previous
             one only takes a new baseline (checkout, pull, rebase, another chat's merge); more than 200 changed files in one scan
             pause the project until the user presses Resume (worktree-sync.json, shown as the amber line, see clash_status).

Per chat worktree, under its worktree lock: a changed file the chat has not touched (its content equals the user base U, CRLF-safe) is
written with a temp file plus os.replace (deleted files are deleted), then worktrees.advance_user_base moves U, so Changes and Merge
do not count it. A file the chat has touched is not written: it is listed in the record's pendingSync for stage G3. `.env*` files are
only ever copied into a chat that has not changed them and never merged. The paths synced since the chat's last turn (record field
syncedPaths) become a note in front of its next prompt.

catch_up() is the one restart function: it diffs the project's working tree against U (a chat opened, the host started, a turn starting).
"""
import contextlib
import ctypes
import logging
import os
import pathlib
import re
import shutil
import stat
import tempfile
import threading
import time

import worktree_merge
import worktrees
from state_store import FileLock, read_json_file, replace_with_retry
from worktrees import GitError, _fs, _same, git

log = logging.getLogger(__name__)
log.addHandler(logging.NullHandler())

SETTLE = 0.4            # seconds of quiet before a scan
MAX_SETTLE = 2.0        # a steady stream of events cannot postpone the scan for longer than this
POLL = 2.0              # the fallback poll (and the only trigger off Windows)
STORM = 200             # more changed files than this in one scan pause the project
MAX_BYTES = 20 * 1024 * 1024
ENV_WALK_EVERY = 10.0
ENV_WALK_LIMIT = 50000
CLOSE_WAIT = 8          # seconds to wait for a project's sync thread (and its git commands) to end when it is stopped
WORKTREE_WAIT = 3       # seconds to wait for a worktree lock held by Merge
MAX_NOTE_PATHS = 50
MAX_STORED_PATHS = 200
SYNC_FILE = 'worktree-sync.json'
UNMERGED = {'DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'}
TEMP_NAME = re.compile(r'(?:\.sw[a-z]$|~$|^\.#|^4913$|\.tmp$|\.tmp\.|^#.*#$|^\.~lock\.|\.crswap$|\.part$|^\.goutputstream-)', re.I)


def is_temp(path):
    """Editor and atomic-save temp names: vim swap files and its 4913 probe, emacs lock and autosave files, *~, *.tmp and the like."""
    return bool(TEMP_NAME.search(str(path).replace('\\', '/').rsplit('/', 1)[-1]))


def is_env(path):
    return str(path).replace('\\', '/').rsplit('/', 1)[-1].startswith('.env')


def _key(project):
    return os.path.normcase(os.path.realpath(str(project)))


# ---- the project's pause flag for a storm (shared with the web process, which shows the line and takes the Resume) ----------
def _flag_path(state_dir):
    return pathlib.Path(state_dir) / SYNC_FILE


def _flag_lock(state_dir):
    return FileLock(pathlib.Path(state_dir) / 'locks' / 'sync-state.lock', 5)


def _flag_read(state_dir):
    status, raw = read_json_file(_flag_path(state_dir))
    return raw if status == 'ok' and isinstance(raw, dict) else {}


def _flag_write(state_dir, items):
    import json
    path = _flag_path(state_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(prefix='.studio-sync-', suffix='.tmp', dir=path.parent)
    try:
        with os.fdopen(handle, 'w', encoding='utf-8') as stream:
            json.dump(items, stream, ensure_ascii=False, separators=(',', ':'))
        replace_with_retry(temporary, path)
    except BaseException:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


def pause_info(state_dir, project):
    """The storm pause of a project ({'project', 'count', 'time'}), or None."""
    found = _flag_read(state_dir).get(_key(project))
    return found if isinstance(found, dict) and found.get('paused') else None


def set_paused(state_dir, project, count):
    lock = _flag_lock(state_dir)
    lock.acquire()
    try:
        items = _flag_read(state_dir)
        items[_key(project)] = {'paused': True, 'project': str(project), 'count': int(count), 'time': time.time()}
        _flag_write(state_dir, items)
    finally:
        lock.release()


def resume(state_dir, project):
    """The user pressed Resume. True when the project was paused. The host's watcher sees the flag go and catches up."""
    if not isinstance(project, str) or not project:
        return False
    lock = _flag_lock(state_dir)
    lock.acquire()
    try:
        items = _flag_read(state_dir)
        found = items.pop(_key(project), None)
        if found is not None:
            _flag_write(state_dir, items)
        return found is not None
    finally:
        lock.release()


def paused_status(state_dir, project):
    """{} when live sync runs, else the fields the amber line needs. Read only."""
    if not isinstance(project, str) or not project or not state_dir:
        return {}
    found = pause_info(state_dir, project)
    if not found:
        return {}
    name = pathlib.Path(project).name or project
    return {'syncPaused': True, 'syncLine': f'Lots of files changed in {name}; live sync paused. Resume?'}


# ---- what git and the file system say ---------------------------------------------------------------------------------
def status_paths(project):
    """{path: XY code} of what `git status --porcelain -z -uall` lists (changed, deleted, new and not ignored). Raises GitError."""
    out = git(['status', '--porcelain', '-z', '-uall', '--no-renames'], project, env={'GIT_OPTIONAL_LOCKS': '0'}).stdout
    found = {}
    for entry in out.split('\0'):
        if len(entry) > 3 and entry[2] == ' ':
            found[entry[3:]] = entry[:2]
    return found


def sig_of(project, path):
    """(kind, size, mtime_ns) of a path in the project folder, None when it is gone."""
    try:
        info = os.lstat(_fs(os.path.join(str(project), path)))
    except OSError:
        return None
    kind = 'l' if stat.S_ISLNK(info.st_mode) else 'd' if stat.S_ISDIR(info.st_mode) else 'f'
    return (kind, info.st_size, info.st_mtime_ns)


def env_files(project):
    """Relative names of the .env* files in the project (a small walk; node_modules, .git and symlinked folders are not entered)."""
    found, seen = [], 0
    root = _fs(project)
    for folder, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in worktrees.SKIP_DIRS and not os.path.islink(os.path.join(folder, d))]
        seen += len(files)
        for name in files:
            if name.startswith('.env') and not is_temp(name):
                found.append(os.path.relpath(os.path.join(folder, name), root).replace('\\', '/'))
        if seen > ENV_WALK_LIMIT:
            break
    return found


def _file_text_has_markers(full):
    try:
        with open(_fs(full), 'rb') as handle:
            return bool(worktree_merge.MARKER.search(handle.read().decode('utf-8', 'replace')))
    except OSError:
        return False


def _locked(full):
    """True when the file cannot be read right now (an editor or a scanner holds it)."""
    try:
        with open(_fs(full), 'rb') as handle:
            handle.read(1)
        return False
    except OSError:
        return True


def judge(project, path, sig, unmerged=False):
    """'ok' (sync it), 'skip' (never this content) or 'retry' (look again later) for a changed project file. A gone file is 'ok'."""
    if worktrees._safe_relative(path) == '' or is_temp(path):
        return 'skip'
    if sig is None:
        return 'ok'
    if sig[0] != 'f' or sig[1] > MAX_BYTES or unmerged:
        return 'skip'
    full = os.path.join(str(project), path)
    if _locked(full):
        return 'retry'
    if _file_text_has_markers(full):
        return 'skip'
    return 'ok'


def _same_bytes(a, b):
    try:
        if os.path.getsize(_fs(a)) != os.path.getsize(_fs(b)):
            return False
        with open(_fs(a), 'rb') as left, open(_fs(b), 'rb') as right:
            while True:
                chunk = left.read(1 << 20)
                if chunk != right.read(1 << 20):
                    return False
                if not chunk:
                    return True
    except OSError:
        return False


def _sha(full):
    import hashlib
    try:
        digest = hashlib.sha1()
        with open(_fs(full), 'rb') as handle:
            for chunk in iter(lambda: handle.read(1 << 20), b''):
                digest.update(chunk)
        return digest.hexdigest()
    except OSError:
        return None


def _copy_atomic(source, target):
    """Write `source` over `target` through a temp file in the same folder and os.replace."""
    folder = os.path.dirname(_fs(target))
    os.makedirs(folder, exist_ok=True)
    handle, temporary = tempfile.mkstemp(prefix='.studio-sync-', suffix='.tmp', dir=folder)
    os.close(handle)
    try:
        shutil.copyfile(_fs(source), temporary)
        try:
            shutil.copymode(_fs(source), temporary)
        except OSError:
            pass
        replace_with_retry(temporary, _fs(target))
    except BaseException:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


def _remove_file(root, target):
    """Delete a synced-away file and the folders that became empty (never the worktree itself)."""
    os.unlink(_fs(target))
    folder = os.path.dirname(target)
    while folder and os.path.normcase(os.path.realpath(folder)) != os.path.normcase(os.path.realpath(root)):
        try:
            os.rmdir(_fs(folder))
        except OSError:
            break
        folder = os.path.dirname(folder)


def tell_index(wt, copied, removed, chunk=100):
    """Keep the worktree's own index in step, so `git diff <U>` (the Changes tab) sees a synced new file as the same as U and a synced deletion of
    a file that was never in HEAD as gone: a new file gets an intent-to-add entry, a removed one loses it."""
    for start in range(0, len(copied), chunk):
        part = copied[start:start + chunk]
        tracked = {n for n in git(['ls-files', '-z', '--', *part], wt, check=False).stdout.split('\0') if n}
        new = [p for p in part if p not in tracked]
        if new:
            git(['add', '-N', '--', *new], wt, check=False)
    for path in removed:
        if git(['cat-file', '-e', f'HEAD:{path}'], wt, check=False).returncode != 0:
            git(['update-index', '--force-remove', '--', path], wt, check=False)


# ---- merging what both sides changed (stage G3) -----------------------------------------------------------------------
def _read(path):
    """The bytes of a regular file, None when there is none (or it is a symlink or a folder)."""
    full = _fs(path)
    if os.path.islink(full) or not os.path.isfile(full):
        return None
    with open(full, 'rb') as handle:
        return handle.read()


def _blob_bytes(cwd, path, blob):
    """The content of a blob as a checkout in `cwd` would write it (core.autocrlf and filters applied: a CRLF worktree gets a CRLF base), None for no blob."""
    if not blob:
        return None
    done = git(['cat-file', '--filters', f'--path={path}', blob], cwd, check=False, binary=True)
    if done.returncode != 0:
        done = git(['cat-file', 'blob', blob], cwd, binary=True)
    return done.stdout


def _hash(cwd, path):
    """The blob id git would store for the file ('' when it is not a regular file)."""
    full = os.path.join(str(cwd), path)
    if os.path.islink(_fs(full)) or not os.path.isfile(_fs(full)):
        return ''
    return git(['hash-object', f'--path={path}', '--', full], cwd, check=False).stdout.strip()


def _equal(a, b):
    """Same content, line-ending noise (CRLF against LF) ignored."""
    return a == b or (a is not None and b is not None and a.replace(b'\r\n', b'\n') == b.replace(b'\r\n', b'\n'))


def _binary(*parts):
    return any(p is not None and b'\0' in p[:8000] for p in parts)


def three_way(base, current, other, scratch):
    """Combine two versions of a file. base/current/other are bytes or None (no file). Returns (kind, bytes):
    same (current stays), take (other replaces it), delete (the file goes), clean / conflict (merged bytes; conflict has markers),
    binary (cannot merge: keep current), keep_chat_deleted / keep_user_deleted (the chat's side wins). `git merge-file`, no base = empty."""
    if current is None and other is None:
        return 'same', None
    if current is not None and other is not None and _equal(current, other):
        return 'same', current
    if other is None:   # the user deleted it
        if base is None:
            return 'same', current
        return ('delete', None) if _equal(current, base) else ('keep_user_deleted', current)
    if current is None:   # the chat deleted it
        return ('same', None) if base is not None and _equal(other, base) else ('keep_chat_deleted', None)
    if base is not None and _equal(current, base):
        return 'take', other
    if base is not None and _equal(other, base):
        return 'same', current
    if _binary(base, current, other):
        return 'binary', None
    for name, data in (('cur', current), ('base', base or b''), ('other', other)):
        with open(os.path.join(scratch, name), 'wb') as handle:
            handle.write(data)
    done = git(['merge-file', '-L', 'chat (your copy)', '-L', 'base', '-L', 'user (project folder)', 'cur', 'base', 'other'], scratch, check=False, binary=True)
    if done.returncode < 0 or done.returncode > 127:
        raise GitError('git merge-file failed: ' + done.stderr.decode('utf-8', 'replace')[:200])
    with open(os.path.join(scratch, 'cur'), 'rb') as handle:
        merged = handle.read()
    return ('conflict' if done.returncode else 'clean'), merged


def _write_atomic(wt, path, data):
    """Bytes into wt/path through a temp file in the same folder and os.replace (the mode of an existing file is kept)."""
    target = os.path.join(wt, path)
    folder = os.path.dirname(_fs(target))
    os.makedirs(folder, exist_ok=True)
    handle, temporary = tempfile.mkstemp(prefix='.studio-sync-', suffix='.tmp', dir=folder)
    try:
        with os.fdopen(handle, 'wb') as out:
            out.write(data)
        try:
            shutil.copymode(_fs(target), temporary)
        except OSError:
            pass
        replace_with_retry(temporary, _fs(target))
    except BaseException:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


def _add_notes(existing, new):
    found = [list(n) for n in existing or [] if isinstance(n, (list, tuple)) and len(n) == 2]
    for item in new:
        if list(item) not in found:
            found.append(list(item))
    return found[-MAX_STORED_PATHS:]


def open_clashes(record):
    """The files of the record's syncConflicts that still have conflict markers in the chat's copy (read only)."""
    wt = record.get('path', '')
    return [p for p in record.get('syncConflicts') or [] if _file_text_has_markers(os.path.join(wt, p))]


def clash_line(files):
    shown = ', '.join(files[:12]) + (' and more' if len(files) > 12 else '')
    return (f'Waiting for the chat to resolve a clash with your edits in {shown}. '
            f'It is combining your version and its own in its copy; Merge is available once the conflict markers are gone.')


def settle_conflicts(registry, record):
    """Clear the syncConflicts whose markers are gone from the chat's copy and move U to include the user's version of them. Call with the
    worktree lock held. Returns the paths that are still unresolved. If the project's file changed again since the merge, U is not moved
    (it would claim a user edit the copy does not have): the path goes back to pendingSync to be merged again."""
    key = record['key']
    left = list(record.get('syncConflicts') or [])
    if not left:
        return []
    still = open_clashes(record)
    done = [p for p in left if p not in still]
    if not done:
        return still
    merged = record.get('syncMerged') or {}
    advance, again = [], []
    for path in done:
        sha = merged.get(path)
        (advance if sha is not None and worktrees.file_matches_blob(record['project'], path, '' if sha == '-' else sha) else again).append(path)
    if advance:
        worktrees.advance_user_base(record, advance, registry)
    with registry.lock:
        now = registry.get(key) or {}
        registry.update(key, syncConflicts=[p for p in now.get('syncConflicts') or [] if p not in done],
                        syncMerged={k: v for k, v in (now.get('syncMerged') or {}).items() if k not in done},
                        pendingSync=list(dict.fromkeys((now.get('pendingSync') or []) + again)))
    return still


NOTE_TEXT = {
    'binary': 'These binary files were changed by both you and the user. They cannot be merged, so your version was kept',
    'keep_chat_deleted': 'The user edited these files, which you deleted. Your deletion was kept',
    'keep_user_deleted': 'The user deleted these files, which you edited. Your copy was kept',
    'env': 'The user changed these .env files, which you also changed. Env files are never merged, so your version was kept',
}


# ---- watching a folder (Windows) ---------------------------------------------------------------------------------------
class DirWatcher(threading.Thread):
    """ReadDirectoryChangesW on a folder tree. Calls poke(name) for each change ('' after a buffer overflow: rescan everything).
    Never raises; if the folder cannot be watched the thread ends and the caller's poll carries on alone."""
    FILTER = 0x01 | 0x02 | 0x08 | 0x10 | 0x40   # file names, folder names, size, last write, creation

    def __init__(self, folder, poke):
        super().__init__(daemon=True, name='agent-studio-dirwatch')
        self.folder, self.poke = str(folder), poke
        self.stopped = threading.Event()
        self.handle = None
        self.started = threading.Event()

    def run(self):
        try:
            from ctypes import wintypes
            k32 = ctypes.WinDLL('kernel32', use_last_error=True)
            k32.CreateFileW.restype = wintypes.HANDLE
            k32.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
            k32.ReadDirectoryChangesW.argtypes = [wintypes.HANDLE, wintypes.LPVOID, wintypes.DWORD, wintypes.BOOL, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), wintypes.LPVOID, wintypes.LPVOID]
            k32.CancelIoEx.argtypes = [wintypes.HANDLE, wintypes.LPVOID]
            k32.CloseHandle.argtypes = [wintypes.HANDLE]
            handle = k32.CreateFileW(_fs(self.folder), 0x0001, 0x7, None, 3, 0x02000000, None)   # list-directory, share all, open existing, backup semantics
            if handle in (None, ctypes.c_void_p(-1).value, wintypes.HANDLE(-1).value):
                return
            self.handle = handle
            self.k32 = k32
            self.started.set()
            buffer = ctypes.create_string_buffer(64 * 1024)
            got = wintypes.DWORD(0)
            try:
                while not self.stopped.is_set():
                    ok = k32.ReadDirectoryChangesW(handle, buffer, len(buffer), True, self.FILTER, ctypes.byref(got), None, None)
                    if self.stopped.is_set() or not ok:
                        break
                    if got.value == 0:
                        self.poke('')   # the buffer overflowed: some changes were lost
                        continue
                    raw, offset = buffer.raw, 0
                    while True:
                        following, _action, length = struct_unpack(raw, offset)
                        name = raw[offset + 12: offset + 12 + length].decode('utf-16-le', 'replace')
                        self.poke(name)
                        if not following:
                            break
                        offset += following
            finally:
                k32.CloseHandle(handle)
                self.handle = None
        except Exception:
            log.exception('The folder watcher stopped; the poll carries on')
        finally:
            self.started.set()

    def stop(self, timeout=5.0):
        """Cancel the pending read and wait until the thread has closed the directory handle (CancelIoEx, then CloseHandle in the thread)."""
        self.stopped.set()
        if self is threading.current_thread() or not self.is_alive():
            return
        deadline = time.monotonic() + timeout
        while self.is_alive() and time.monotonic() < deadline:
            handle, k32 = self.handle, getattr(self, 'k32', None)
            if handle and k32:
                try:
                    k32.CancelIoEx(handle, None)
                except Exception:
                    pass
            self.join(0.05)
        if self.is_alive():
            log.warning('The folder watcher of %s did not stop in %s s', self.folder, timeout)


def struct_unpack(raw, offset):
    import struct
    return struct.unpack_from('<III', raw, offset)


# ---- one project ---------------------------------------------------------------------------------------------------
class ProjectSync:
    def __init__(self, live, project):
        self.live, self.project = live, str(project)
        self.lock = threading.RLock()
        self.stop = threading.Event()
        self.event = threading.Event()
        self.baselined = threading.Event()
        self.head, self.files, self.seen = None, {}, {}
        self.reset = True
        self.was_paused = False
        self.waiting = 0.0      # seconds until the next scan the unfinished work wants (0: none)
        self.env_paths, self.env_next, self.env_dirty = [], 0.0, True
        self.notifier = None
        self.notifier_lock = threading.Lock()
        self.thread = threading.Thread(target=self.run, daemon=True, name='agent-studio-live-sync')

    # -- triggers
    def poke(self, name=None):
        base = (name or '').replace('\\', '/')
        if name and (base == '.git' or base.startswith('.git/') or '/node_modules/' in '/' + base or is_temp(base)):
            return
        if name and is_env(base):
            self.env_dirty = True
        self.event.set()

    def start(self):
        self.ensure_notifier()
        self.thread.start()

    def ensure_notifier(self):
        """The folder watcher runs only while the project is being synced (not after stop, not while paused)."""
        if os.name != 'nt' or not self.live.watch_folders:
            return
        with self.notifier_lock:
            if self.stop.is_set() or (self.notifier is not None and self.notifier.is_alive()):
                return
            self.notifier = DirWatcher(self.project, self.poke)
            self.notifier.start()
            self.notifier.started.wait(2)

    def release_notifier(self):
        """Close the project folder's directory handle and join the watcher thread: the folder can be renamed or deleted afterwards."""
        with self.notifier_lock:
            notifier, self.notifier = self.notifier, None
        if notifier:
            notifier.stop()

    def close(self, wait=True):
        """Stop syncing this project: the watcher's handle is closed and the sync thread (with the git commands it runs) has ended when this returns
        (up to a timeout). Never call it with LiveSync.lock held: the thread takes that lock on its way out."""
        self.stop.set()
        self.event.set()
        self.release_notifier()
        if wait and self.thread.is_alive() and self.thread is not threading.current_thread():
            self.thread.join(CLOSE_WAIT)

    # -- the loop
    def run(self):
        live = self.live
        wait = 0.0
        try:
            while not self.stop.is_set():
                poked = self.event.wait(wait)
                if self.stop.is_set():
                    break
                if poked:
                    began = time.monotonic()
                    while True:
                        self.event.clear()
                        if self.stop.wait(live.settle):
                            return
                        if not self.event.is_set() or time.monotonic() - began > live.max_settle:
                            break
                if not live.wanted(self.project):
                    break
                try:
                    with self.lock:
                        self.scan()
                except Exception:
                    log.exception('Live sync of %s failed', self.project)
                wait = min(self.waiting, live.poll) if self.waiting else live.poll
        finally:
            self.release_notifier()
            live.forget(self)

    # -- one scan
    def listing(self):
        """{path: sig} of the candidates now: what git status lists, plus the .env* files."""
        statuses = status_paths(self.project)
        self.unmerged = {p for p, code in statuses.items() if code in UNMERGED}
        found = {p: sig_of(self.project, p) for p in statuses}
        now = time.monotonic()
        if self.env_dirty or now >= self.env_next:
            self.env_paths = env_files(self.project)
            self.env_next, self.env_dirty = now + ENV_WALK_EVERY, False
        for path in self.env_paths:
            if path not in found:
                found[path] = sig_of(self.project, path)
        return found

    def scan(self):
        live, project, state_dir = self.live, self.project, self.live.state_dir
        self.waiting = 0.0
        if worktrees.sync_paused(state_dir, project):
            self.reset = True   # Merge is stashing: whatever the folder looks like now is not the user's saving
            return
        if pause_info(state_dir, project):
            self.was_paused, self.reset = True, True
            self.release_notifier()   # paused: nothing is watched, no handle on the folder
            return
        head = git(['rev-parse', '--verify', '-q', 'HEAD'], project, check=False).stdout.strip()
        current = self.listing()
        if self.was_paused:   # Resume: the chats catch up on what happened meanwhile, then the baseline restarts
            self.was_paused = False
            self.ensure_notifier()
            live.catch_up_project(project, self.stop)
            self.reset = True
        live.retry_stale()
        if self.reset or self.head is None or head != self.head:
            self.head, self.files, self.seen, self.reset = head, current, {}, False
            self.baselined.set()
            return
        changed = {}
        for path, sig in current.items():
            if self.files.get(path, 'absent') != sig:
                changed[path] = sig
        for path, old in self.files.items():
            if path not in current:
                sig = sig_of(project, path)
                if sig != old:
                    changed[path] = sig
        changed = {p: s for p, s in changed.items() if not is_temp(p)}
        for path in [p for p in self.seen if p not in changed]:
            del self.seen[path]
        if len(changed) > STORM:
            set_paused(state_dir, project, len(changed))
            self.release_notifier()
            self.was_paused = True   # Resume restarts the watcher and catches the chats up
            self.head, self.files, self.seen, self.reset = head, current, {}, True
            log.warning('Live sync of %s paused: %s files changed at once', project, len(changed))
            return
        ready, handled = {}, set()
        for path, sig in changed.items():
            if self.seen.get(path) != sig:
                self.seen[path] = sig
                self.waiting = live.settle   # the same size and mtime on two scans in a row
                continue
            verdict = judge(project, path, sig, path in self.unmerged)
            if verdict == 'retry':
                self.waiting = max(self.waiting, live.poll)
                continue
            handled.add(path)
            if verdict == 'ok':
                ready[path] = sig
        if ready:
            live.sync_ready(project, ready)
        files = dict(current)
        for path in changed:
            if path not in handled:   # not decided yet: it stays "changed" for the next scan
                if path in self.files:
                    files[path] = self.files[path]
                else:
                    files.pop(path, None)
        for path in handled:
            self.seen.pop(path, None)
        self.files = files


# ---- all projects ----------------------------------------------------------------------------------------------------
class LiveSync:
    def __init__(self, studio, settle=SETTLE, poll=POLL, watch_folders=True):
        self.studio = studio
        self.settle, self.poll, self.max_settle = settle, poll, MAX_SETTLE
        self.watch_folders = watch_folders
        self.projects = {}
        self.lock = threading.RLock()
        self.workers = []    # the catch-up threads of chats that just opened
        self.stale = set()   # chat keys that could not take a sync (a merge in progress, a lock): caught up later
        self.closed = False
        self.hooks = threading.RLock()   # the turn hooks run under it; stop_all waits for the ones in flight

    # -- who is watched
    @property
    def state_dir(self):
        return self.studio.state_dir

    def enabled(self):
        studio = self.studio
        return bool(studio.worktrees and studio.settings.worktree_per_chat() and not self.closed)

    def chats(self, project=None):
        """[(key, record)] of the open, Studio-owned worktree chats (of one project)."""
        studio, found, seen = self.studio, [], set()
        if not studio.worktrees:
            return found
        with studio.lock:
            connections = [c for c in studio.connections.values() if not c.closed and getattr(c, 'worktree', None)]
        for connection in connections:
            record = studio.worktrees.registry.find(path=connection.cwd)
            if not record or record['key'] in seen or (project is not None and not _same(record.get('project', ''), project)):
                continue
            seen.add(record['key'])
            found.append((record['key'], record))
        return found

    def wanted(self, project):
        return self.enabled() and bool(self.chats(project))

    def refresh(self):
        """Start a watcher for each project that has an open worktree chat, stop the others. Cheap; called when a chat opens or closes."""
        with self.lock:
            wanted = {}
            if self.enabled():
                for _key_, record in self.chats():
                    wanted.setdefault(_key(record['project']), record['project'])
            gone = [self.projects.pop(key) for key in [k for k in self.projects if k not in wanted]]
            for key, project in wanted.items():
                if key not in self.projects:
                    sync = ProjectSync(self, project)
                    self.projects[key] = sync
                    sync.start()
        for sync in gone:   # outside the lock: closing waits for the sync thread, which takes it on its way out
            sync.close()

    def forget(self, sync):
        with self.lock:
            if self.projects.get(_key(sync.project)) is sync:
                del self.projects[_key(sync.project)]

    def stop_all(self):
        with self.lock:
            self.closed = True
        with self.hooks:   # a turn hook that is merging finishes first (it stops by itself at its next step)
            pass
        with self.lock:
            items, self.projects = list(self.projects.values()), {}
        for sync in items:
            sync.close(wait=False)
        for sync in items:
            sync.thread.join(CLOSE_WAIT)
        for thread in list(self.workers):
            thread.join(5)

    def project_lock(self, project):
        with self.lock:
            sync = self.projects.get(_key(project))
        return sync.lock if sync else contextlib.nullcontext()

    # -- hooks from Studio
    def chat_opened(self, connection):
        """A worktree chat is ready (new, resumed or reconnected at host start): watch its project and catch it up on what the user saved
        while it was closed (in the background: opening a chat never waits for this)."""
        if not self.enabled() or not getattr(connection, 'worktree', None):
            return
        self.refresh()
        record = self.studio.worktrees.registry.find(path=connection.cwd)
        if not record:
            return

        def work():
            with self.lock:
                sync = self.projects.get(_key(record['project']))
            if sync:
                sync.baselined.wait(10)   # the baseline first, so a save between the two is seen by one or the other
            self.catch_up(record['key'])
        thread = threading.Thread(target=work, daemon=True, name='agent-studio-catch-up')
        with self.lock:
            self.workers = [t for t in self.workers if t.is_alive()] + [thread]
        thread.start()

    def turn_started(self, connection):
        """A prompt is about to go to the agent (on the turn's thread): finish the last turn's guard if it could not run, catch up on what the
        user saved, merge the files both sides changed, and remember U as the turn's starting point for the lost-update guard."""
        with self.hooks:
            self._turn_started(connection)

    def _turn_started(self, connection):
        if not getattr(connection, 'worktree', None) or not self.enabled():
            return
        record = self.studio.worktrees.registry.find(path=connection.cwd)
        if not record:
            return
        key = record['key']
        self.finish_turn(connection)
        self.catch_up(key)
        self.merge_pending(connection, at_turn_boundary=True)

        def begin(record):
            if not record.get('turnUser'):
                self.studio.worktrees.registry.update(key, turnUser=record.get('user') or record.get('snapshot') or '', turnSynced=[])
            return 'ok'
        self._with_worktree(key, begin)

    def turn_ended(self, connection):
        """The agent finished a turn (on the turn's thread): the lost-update guard, then the files both sides changed."""
        with self.hooks:
            self._turn_ended(connection)

    def _turn_ended(self, connection):
        if not getattr(connection, 'worktree', None) or not self.enabled():
            return
        self.finish_turn(connection)
        self.merge_pending(connection, at_turn_boundary=True)

    # -- merging what both sides changed (stage G3)
    def _chat_idle(self, connection, at_turn_boundary):
        """True when nothing of the chat is running. At a turn boundary the caller is the turn's own thread, so 'busy' and queued messages do
        not count (the queued message starts only after this returns); a terminal or subagent that is still running does."""
        try:
            state = connection.public(0)
        except Exception:
            return False
        return not worktree_merge.state_idle_reason(state, check_busy=not at_turn_boundary, check_queue=not at_turn_boundary)

    def _with_worktree(self, key, work):
        """Run work(record) with the worktree's lock held, unless sync is paused or the worktree cannot take files. Returns work's result, or
        'gone', 'busy', 'paused' or 'blocked'."""
        registry = self.studio.worktrees.registry
        record = registry.get(key)
        if not record or record.get('status') != 'ready':
            return 'gone'
        record = dict(record, key=key)
        lock = worktrees.worktree_lock(self.state_dir, record, WORKTREE_WAIT)
        try:
            lock.acquire()
        except OSError:
            return 'busy'
        try:
            if worktrees.sync_paused(self.state_dir, record['project']):
                return 'paused'
            if self.blocked(record, merging=True):
                return 'blocked'
            return work(dict(registry.get(key) or record, key=key))
        except (GitError, OSError):
            log.warning("Merging the user's edits into %s failed", record.get('path'), exc_info=True)
            return 'blocked'
        finally:
            lock.release()

    def merge_pending(self, connection, at_turn_boundary=False):
        """Merge the files in pendingSync (both the chat and the user changed them): `git merge-file` with current = the chat's file, base = U's
        version, other = the project's. Only while the chat is idle, under the worktree lock, never while sync is paused."""
        if not getattr(connection, 'worktree', None) or not self.enabled():
            return 'off'
        record = self.studio.worktrees.registry.find(path=connection.cwd)
        if not record:
            return 'gone'
        if not self._chat_idle(connection, at_turn_boundary):
            return 'busy'

        def work(record):
            settle_conflicts(self.studio.worktrees.registry, record)
            record = dict(self.studio.worktrees.registry.get(record['key']) or record, key=record['key'])
            paths = [p for p in record.get('pendingSync') or [] if isinstance(p, str)]
            if paths:
                self._combine(record, paths)
            return 'ok'
        return self._with_worktree(record['key'], work)

    def finish_turn(self, connection):
        """The lost-update guard. Live sync may have written the user's version of a file during the turn that the agent had already read; if it then
        wrote its stale copy back, the user's edit would be undone. For every path synced during the turn: merge again with current = the
        worktree, base = U at the turn's start, other = U now. Running it twice changes nothing."""
        if not getattr(connection, 'worktree', None) or not self.enabled():
            return 'off'
        record = self.studio.worktrees.registry.find(path=connection.cwd)
        if not record or not record.get('turnUser'):
            return 'ok'
        if not self._chat_idle(connection, True):
            return 'busy'

        def work(record):
            registry = self.studio.worktrees.registry
            start = record.get('turnUser')
            paths = [p for p in record.get('turnSynced') or [] if isinstance(p, str)]
            if paths and git(['cat-file', '-e', start + '^{commit}'], record['path'], check=False).returncode == 0:
                self._combine(record, paths, guard_base=start)
            registry.update(record['key'], turnUser='', turnSynced=[])
            return 'ok'
        return self._with_worktree(record['key'], work)

    def _combine(self, record, paths, guard_base=None):
        """The 3-way merge of `paths` into the chat's worktree (worktree lock held). Pending files (guard_base None): base = U's version, other = the
        project folder's. The guard: base = `guard_base`'s version, other = U's. Records the outcome in the registry."""
        registry, key = self.studio.worktrees.registry, record['key']
        project, wt = record['project'], record['path']
        user = record.get('user') or record.get('snapshot')
        done, advance, written, conflicts, notes, kept, merged_with = [], [], [], {}, [], {}, {}
        known_kept = record.get('syncKept') or {}
        scratch = tempfile.mkdtemp(prefix='.studio-merge-', dir=str(worktrees.git_dir_of(wt)))
        try:
            for path in paths:
                if worktrees._safe_relative(path) == '':
                    done.append(path)
                    continue
                full = os.path.join(wt, path)
                if is_env(path):
                    done.append(path)   # never merged: the chat's version stays
                    continue
                if os.path.islink(_fs(full)) or os.path.isdir(_fs(full)):
                    done.append(path)
                    continue
                current = _read(full)
                if guard_base is None:
                    source = os.path.join(project, path)
                    if os.path.islink(_fs(source)) or os.path.isdir(_fs(source)):
                        done.append(path)
                        continue
                    other = _read(source)
                    if other is not None and (len(other) > MAX_BYTES or worktree_merge.MARKER.search(other.decode('utf-8', 'replace'))):
                        continue   # not something to merge now: stays pending
                    sha = _hash(project, path) if other is not None else ''
                    base = _blob_bytes(wt, path, git(['rev-parse', '--verify', '-q', f'{user}:{path}'], wt, check=False).stdout.strip())
                    if known_kept.get(path) == (sha or '-'):
                        done.append(path)   # kept the chat's way already, and the user's file has not changed since
                        continue
                else:
                    start_blob = git(['rev-parse', '--verify', '-q', f'{guard_base}:{path}'], wt, check=False).stdout.strip()
                    now_blob = git(['rev-parse', '--verify', '-q', f'{user}:{path}'], wt, check=False).stdout.strip()
                    if not start_blob:
                        continue   # the file did not exist when the turn began: the agent cannot have read an older version
                    base, other, sha = _blob_bytes(wt, path, start_blob), _blob_bytes(wt, path, now_blob), now_blob
                kind, data = three_way(base, current, other, scratch)
                if kind == 'same':
                    if guard_base is None:
                        advance.append(path)
                        merged_with[path] = sha
                elif kind in ('take', 'clean'):
                    _write_atomic(wt, path, data)
                    written.append(path)
                    if guard_base is None:
                        advance.append(path)
                        merged_with[path] = sha
                elif kind == 'delete':
                    if os.path.isfile(_fs(full)):
                        _remove_file(wt, full)
                    written.append(path)
                    if guard_base is None:
                        advance.append(path)
                        merged_with[path] = sha
                elif kind == 'conflict':
                    _write_atomic(wt, path, data)
                    conflicts[path] = sha or '-'
                else:   # binary, keep_chat_deleted, keep_user_deleted
                    notes.append([path, kind])
                    kept[path] = sha or '-'
                if guard_base is None:
                    done.append(path)
        finally:
            shutil.rmtree(scratch, ignore_errors=True)
        landed = []
        if advance:
            landed = self._advance_checked(record, advance, merged_with)
        if written:
            tell_index(wt, [p for p in written if os.path.lexists(_fs(os.path.join(wt, p)))], [])
        with registry.lock:
            now = registry.get(key) or {}
            fields = {}
            keep_pending = [p for p in now.get('pendingSync') or [] if p not in done or (p in advance and p not in landed)]
            if guard_base is None:
                fields['pendingSync'] = keep_pending
            if conflicts:
                fields['syncConflicts'] = list(dict.fromkeys((now.get('syncConflicts') or []) + list(conflicts)))
                fields['syncMerged'] = dict(now.get('syncMerged') or {}, **conflicts)
            if kept:
                fields['syncKept'] = dict(now.get('syncKept') or {}, **kept)
            if notes:
                fields['syncNotes'] = _add_notes(now.get('syncNotes'), notes)
            told = [p for p in written if p not in conflicts]
            if told:
                fields['syncedPaths'] = list(dict.fromkeys((now.get('syncedPaths') or []) + told))[-MAX_STORED_PATHS:]
            if fields:
                registry.update(key, **fields)
        return {'written': written, 'conflicts': list(conflicts), 'notes': notes}

    def _advance_checked(self, record, paths, expected):
        """advance_user_base for `paths`, but only for the content that was merged (`expected` maps a path to the blob id of the user's version,
        '' or '-' for gone): a file the user saved again meanwhile is left for the next merge, and U goes back if it took such a version."""
        registry = self.studio.worktrees.registry
        project, previous = record['project'], record.get('user') or record.get('snapshot')

        def want(path):
            return '' if expected.get(path) in ('', '-', None) else expected[path]
        stable = [p for p in paths if _hash(project, p) == want(p)]
        if not stable:
            return []
        fresh = worktrees.advance_user_base(record, stable, registry)
        for path in stable:
            blob = git(['rev-parse', '--verify', '-q', f'{fresh}:{path}'], project, check=False).stdout.strip()
            if blob != want(path):   # saved again while U was built
                worktrees.pin_user_base(project, record, previous)
                registry.update(record['key'], user=previous, diffBase=previous)
                return []
        return stable

    def context_for(self, connection):
        """(text, token) of the note for the chat's next prompt, or None. One <studio-context> block: the files the user changed, then what clashed
        (every prompt, until the chat has resolved it), then what could not be merged and was kept the chat's way."""
        if not getattr(connection, 'worktree', None) or not self.enabled():
            return None
        record = self.studio.worktrees.registry.find(path=connection.cwd)
        if not record:
            return None

        def clean(items):
            return [re.sub(r'[<>\x00-\x1f]', '?', str(p)) for p in items[:MAX_NOTE_PATHS]]

        def listing(items):
            return ', '.join(clean(items)) + (f' and {len(items) - MAX_NOTE_PATHS} more' if len(items) > MAX_NOTE_PATHS else '')

        paths = [p for p in record.get('syncedPaths') or [] if isinstance(p, str)]
        notes = [list(n) for n in record.get('syncNotes') or [] if isinstance(n, (list, tuple)) and len(n) == 2 and isinstance(n[0], str)]
        clashes = [p for p in record.get('syncConflicts') or [] if isinstance(p, str)]
        lines = []
        if paths:
            lines.append(f'The user changed these files since your last turn: {listing(paths)}')
        if clashes:
            lines.append(f"These files have a clash between your edit and the user's: {listing(clashes)}. Studio put conflict markers in them. "
                         f'Resolve each in your own copy: keep what both intended, remove every conflict marker and save the file. '
                         f'Studio clears the clash once the markers are gone.')
        for kind, text in NOTE_TEXT.items():
            named = [n[0] for n in notes if n[1] == kind]
            if named:
                lines.append(f'{text}: {listing(named)}')
        if not lines:
            return None
        return ('<studio-context>' + '\n'.join(lines) + '</studio-context>', {'paths': paths, 'notes': notes})

    def context_sent(self, connection, token):
        record = self.studio.worktrees.registry.find(path=connection.cwd) if self.studio.worktrees else None
        if not record:
            return
        if not isinstance(token, dict):
            token = {'paths': token, 'notes': []}
        registry = self.studio.worktrees.registry
        with registry.lock:
            now = registry.get(record['key']) or {}
            sent, noted = set(token.get('paths') or []), [list(n) for n in token.get('notes') or []]
            registry.update(record['key'], syncedPaths=[p for p in now.get('syncedPaths') or [] if p not in sent],
                            syncNotes=[n for n in now.get('syncNotes') or [] if list(n) not in noted])

    # -- syncing
    def sync_ready(self, project, items):
        """The watcher found stable changes in the project: every open chat of it takes them."""
        for key, _record in self.chats(project):
            if self.sync_chat(key, items) in ('busy', 'blocked'):
                self.stale.add(key)

    def retry_stale(self):
        for key in list(self.stale):
            if self.catch_up(key) not in ('busy', 'blocked', 'paused'):
                self.stale.discard(key)

    def catch_up_project(self, project, stop=None):
        for key, _record in self.chats(project):
            if stop is not None and stop.is_set():
                return
            self.catch_up(key, stop)

    def blocked(self, record, merging=False):
        """Why this worktree cannot take files now ('' when it can). `merging`: a clash with the user's edits does not stop merging other files."""
        path = record.get('path', '')
        if not os.path.isdir(_fs(path)):
            return 'the folder is gone'
        if record.get('mergeConflicts') or (record.get('syncConflicts') and not merging):
            return 'conflicts to resolve'
        try:
            gitdir = worktrees.git_dir_of(path)
            for name, label in worktree_merge.GIT_STATES:
                if (gitdir / name).exists():
                    return f'{label} is in progress'
            if (gitdir / 'index.lock').exists():
                return 'git is busy there'
            head = git(['symbolic-ref', '-q', 'HEAD'], path, check=False).stdout.strip()
        except GitError:
            return 'git cannot be read there'
        if head != 'refs/heads/' + record.get('branch', ''):
            return 'its HEAD is not on its own branch'
        return ''

    def sync_chat(self, key, items, env_extra=(), stop=None):
        """Copy the project's current version of `items` ({path: sig or None}) into the chat's worktree where the chat has not touched them.
        Returns 'ok', 'busy' (lock held), 'blocked', 'paused' or 'gone'."""
        registry = self.studio.worktrees.registry
        record = registry.get(key)
        if not record or record.get('status') != 'ready':
            return 'gone'
        record = dict(record, key=key)
        project, wt = record['project'], record['path']
        lock = worktrees.worktree_lock(self.state_dir, record, WORKTREE_WAIT)
        try:
            lock.acquire()
        except OSError:
            return 'busy'
        try:
            if worktrees.sync_paused(self.state_dir, project):
                return 'paused'
            if record.get('syncConflicts'):
                settle_conflicts(registry, record)   # the chat may have resolved a clash since
                record = dict(registry.get(key) or record, key=key)
            why = self.blocked(record)
            if why:
                log.info('Live sync skips %s: %s', wt, why)
                return 'blocked'
            user = record.get('user') or record.get('snapshot')
            if not user:
                return 'blocked'
            synced, moved, pending, env, notes = [], [], [], dict(record.get('env') or {}), []
            copied, removed = [], []
            env_changed = False
            for path in list(items) + [p for p in env_extra if p not in items]:
                if self.closed or (stop is not None and stop.is_set()):
                    break   # stopped meanwhile: what is left is caught up at the next start
                if worktrees._safe_relative(path) == '':
                    continue
                src, dst = os.path.join(project, path), os.path.join(wt, path)
                sig = items.get(path)
                if sig is not None and sig_of(project, path) != sig:
                    continue   # saved again while we looked: the next scan has it
                blob = git(['rev-parse', '--verify', '-q', f'{user}:{path}'], wt, check=False).stdout.strip()
                env_route = is_env(path) and not blob and git(['check-ignore', '-q', '--', path], project, check=False).returncode == 0
                if path in env_extra and path not in items and not env_route:
                    continue
                try:
                    if env_route:
                        outcome = self._sync_env(project, wt, path, env)
                        if outcome == 'synced':
                            synced.append(path)
                        env_changed = env_changed or outcome in ('synced', 'seen', 'kept_new')
                        if outcome == 'kept_new':
                            notes.append([path, 'env'])
                        continue
                    if not worktrees.file_matches_blob(wt, path, blob):
                        pending.append(path)   # the chat has changed it: stage G3
                        continue
                    if os.path.lexists(_fs(src)):
                        if os.path.islink(_fs(src)) or not os.path.isfile(_fs(src)):
                            continue
                        if os.path.lexists(_fs(dst)) and _same_bytes(src, dst):
                            continue
                        _copy_atomic(src, dst)
                        copied.append(path)
                    else:
                        if os.path.isfile(_fs(dst)) and not os.path.islink(_fs(dst)):
                            _remove_file(wt, dst)
                            removed.append(path)
                        else:
                            continue
                    synced.append(path)
                    moved.append(path)
                except OSError:
                    log.warning('Live sync could not write %s into %s', path, wt, exc_info=True)
            fields = {}
            if moved:
                tell_index(wt, copied, removed)
                worktrees.advance_user_base(record, moved, registry)
            with registry.lock:
                now = registry.get(key) or {}
                if pending:
                    fields['pendingSync'] = list(dict.fromkeys((now.get('pendingSync') or []) + pending))[:MAX_STORED_PATHS]
                if synced:
                    fields['syncedPaths'] = list(dict.fromkeys((now.get('syncedPaths') or []) + synced))[-MAX_STORED_PATHS:]
                if env_changed:
                    fields['env'] = env
                if moved and now.get('turnUser'):   # written during a turn: the lost-update guard looks at it when the turn ends
                    fields['turnSynced'] = list(dict.fromkeys((now.get('turnSynced') or []) + moved))[-MAX_STORED_PATHS:]
                if notes:
                    fields['syncNotes'] = _add_notes(now.get('syncNotes'), notes)
                if fields:
                    registry.update(key, **fields)
            return 'ok'
        except GitError:
            log.warning('Live sync into %s failed', wt, exc_info=True)
            return 'blocked'
        finally:
            lock.release()

    def _sync_env(self, project, wt, path, env):
        """A .env* file (ignored by git, never merged): copied into the chat only when the chat has not changed it. `env` maps a path to the
        sha1 of the project's content when it was last seen here ('-' when it was gone). Returns 'synced', 'seen' (recorded, nothing copied) or 'kept'."""
        src, dst = os.path.join(project, path), os.path.join(wt, path)
        there = _sha(src) if os.path.isfile(_fs(src)) and not os.path.islink(_fs(src)) else None
        mine = _sha(dst) if os.path.isfile(_fs(dst)) else None
        known = env.get(path)
        known = None if known in (None, '-') else known
        if path in env:
            untouched = mine == known
        else:
            untouched = mine is None or mine == there
        if not untouched:
            if path in env and env.get(path) != (there or '-') and mine != there:   # the user changed it since the chat last saw it
                env[path] = there or '-'
                return 'kept_new'
            return 'kept'
        if mine == there:
            env[path] = there or '-'
            return 'seen'
        if there is None:
            _remove_file(wt, dst)
        else:
            _copy_atomic(src, dst)
        env[path] = there or '-'
        return 'synced'

    # -- catching up
    def diff_against_user(self, record):
        """Paths whose content in the project's working tree differs from the chat's user base U. If the project HEAD is not the one U was
        made against, only files that are dirty now (the user's own edits, not what a checkout or merge brought)."""
        project = record['project']
        user = record.get('user') or record.get('snapshot')
        head = git(['rev-parse', '--verify', '-q', 'HEAD'], project, check=False).stdout.strip()
        scratch = tempfile.mkdtemp(prefix='.studio-catch-', dir=str(worktrees.git_dir_of(project)))
        try:
            env = {'GIT_INDEX_FILE': os.path.join(scratch, 'index')}
            git(['read-tree', 'HEAD'], project, env=env)
            git(['add', '-A'], project, env=env)
            tree = git(['write-tree'], project, env=env).stdout.strip()
        finally:
            shutil.rmtree(scratch, ignore_errors=True)
        names = [n for n in git(['diff-tree', '-r', '--no-renames', '--name-only', '-z', user + '^{tree}', tree], project).stdout.split('\0') if n]
        statuses = status_paths(project)
        if head != record.get('userHead'):
            names = [n for n in names if n in statuses]
        items = {}
        for name in names:
            sig = sig_of(project, name)
            if judge(project, name, sig, statuses.get(name) in UNMERGED) == 'ok':
                items[name] = None
        return items, env_files(project)

    def catch_up(self, key, stop=None):
        """The one restart function (chat opened, host start, turn start, Resume): sync what differs between the project's working tree and U."""
        if not self.enabled():
            return 'paused'
        registry = self.studio.worktrees.registry
        record = registry.get(key)
        if not record or record.get('status') != 'ready':
            return 'gone'
        project = record.get('project', '')
        if worktrees.sync_paused(self.state_dir, project) or pause_info(self.state_dir, project):
            return 'paused'
        with self.project_lock(project):
            try:
                items, envs = self.diff_against_user(dict(record, key=key))
                return self.sync_chat(key, items, env_extra=envs, stop=stop)
            except (GitError, OSError):
                log.warning('Live sync catch-up of %s failed', record.get('path'), exc_info=True)
                return 'blocked'
