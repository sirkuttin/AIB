"""New project folders: validation, single-level create, smart starting folder, native folder picker.

Everything a typed path can do goes through validate_path(), the one place an allow-list of locations could be added
(see check_location). Nothing here deletes or overwrites anything, and nothing runs input from the user as a command:
git is started with a fixed argument list inside the new folder, the picker is a fixed script that gets the start
folder as plain data.
"""
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import threading

import security

RESERVED = {'CON', 'PRN', 'AUX', 'NUL'} | {f'COM{i}' for i in range(1, 10)} | {f'LPT{i}' for i in range(1, 10)}
BAD_CHARS = '<>:"|?*'
MAX_PATH_CHARS = 400
GIT_TIMEOUT = 20
PICK_TIMEOUT = 600
PICK_UNAVAILABLE = 'Folder picker unavailable, type the path'


class FolderError(ValueError):
    def __init__(self, message, code='invalid'):
        super().__init__(message)
        self.code = code


MAX_KINDS = 300


def _segments(path):
    return [x for x in str(path or '').replace(chr(92), '/').split('/') if x]


def is_scratch(path):
    """Claude desktop scratch folders: a segment starting with scratch- (or a scratch-workspaces folder in the path)."""
    return any(seg.lower().startswith('scratch-') or seg.lower() == 'scratch-workspaces' for seg in _segments(path))


def is_worktree(path):
    """A git worktree folder (not the main checkout): under .claude/worktrees or .git/worktrees, or its .git is a FILE
    pointing into a worktrees folder. Submodules also have a .git file, but theirs points into .git/modules."""
    if security.is_network_path(path):   # never stat a UNC or device path: Windows would authenticate to that server
        return False
    text = str(path or '').replace(chr(92), '/').lower()
    if '/.claude/worktrees/' in text + '/' or '/.git/worktrees/' in text + '/':
        return True
    try:
        marker = pathlib.Path(str(path)) / '.git'
        if marker.is_file():
            head = marker.read_text(encoding='utf-8', errors='replace')[:600].replace(chr(92), '/').lower()
            return head.startswith('gitdir:') and '/worktrees/' in head
    except (OSError, ValueError):
        pass
    return False


def folder_kinds(paths):
    """{path: {worktree, scratch}} for the dropdown filter; cheap (one stat per folder), bounded, read-only."""
    out = {}
    for raw in list(paths or [])[:MAX_KINDS]:
        if isinstance(raw, str) and 0 < len(raw) <= MAX_PATH_CHARS and not security.is_network_path(raw):
            out[raw] = {'worktree': is_worktree(raw), 'scratch': is_scratch(raw)}
    return out


def git_path():
    return shutil.which('git')


def check_location(normalized):
    """Hook for a future allow-list of places projects may be created in. Raise FolderError to refuse. Allows all today."""
    return None


def _result(**kw):
    out = {'valid': False, 'reason': 'empty', 'message': '', 'exists': False, 'isDir': False, 'parentExists': False,
           'name': '', 'path': '', 'parent': '', 'gitAvailable': bool(git_path())}
    out.update(kw)
    return out


def validate_path(raw, windows=None):
    """Pure text validation. Returns (normalized_path, parent, name, segments) or raises FolderError(code)."""
    win = (os.name == 'nt') if windows is None else windows
    text = raw.strip() if isinstance(raw, str) else ''
    if not text:
        raise FolderError('Type a folder name, or Browse', 'empty')
    if len(text) > MAX_PATH_CHARS:
        raise FolderError('That path is too long', 'invalid_name')
    if any(ord(c) < 32 for c in text):
        raise FolderError("Folder names can't contain control characters", 'invalid_name')
    if win:
        text = text.replace('/', '\\')
        if text.startswith('\\\\'):
            raise FolderError('Network paths are not supported here, use a drive letter', 'relative')
        m = re.match(r'^([A-Za-z]:)\\(.*)$', text, re.S)
        if not m:
            raise FolderError('Type the full path, starting with a drive such as C:\\', 'relative')
        root, rest, sep = m.group(1) + '\\', m.group(2), '\\'
    else:
        if not text.startswith('/'):
            raise FolderError('Type the full path, starting with /', 'relative')
        root, rest, sep = '/', text[1:], '/'
    if rest == '':
        raise FolderError('Type a folder name, or Browse', 'partial')
    trailing = rest.endswith(sep)
    if trailing:
        rest = rest[:-1]
        if rest == '':
            raise FolderError('Type a folder name, or Browse', 'partial')
    segments = rest.split(sep)
    for seg in segments:
        if seg == '':
            raise FolderError('The path has an empty folder name (two separators in a row)', 'invalid_name')
        if seg in ('.', '..'):
            raise FolderError('Paths with . or .. are not allowed', 'escape')
        if len(seg) > 255:
            raise FolderError('A folder name is too long', 'invalid_name')
        if win:
            bad = sorted({c for c in seg if c in BAD_CHARS})
            if bad:
                raise FolderError('"%s" can\'t contain %s' % (seg, ' '.join(bad)), 'invalid_name')
            if seg.endswith('.') or seg.endswith(' '):
                raise FolderError('"%s" can\'t end with a dot or a space' % seg, 'invalid_name')
            if seg.split('.')[0].strip().upper() in RESERVED:
                raise FolderError('"%s" is a reserved Windows name' % seg, 'invalid_name')
    if trailing:
        raise FolderError('Type a folder name, or Browse', 'partial')
    joined = root + sep.join(segments)
    parent = root + sep.join(segments[:-1]) if len(segments) > 1 else root
    return joined, parent, segments[-1], segments


def check_path(raw, windows=None):
    """The answer behind GET /api/live/folders/check."""
    try:
        if security.is_network_path(raw):   # on every platform, before anything can look at the filesystem
            raise FolderError('Network paths are not supported here, use a drive letter', 'relative')
        norm, parent, name, _ = validate_path(raw, windows)
    except FolderError as error:
        return _result(valid=False, reason=error.code, message=str(error))
    try:
        check_location(norm)
    except FolderError as error:
        return _result(valid=False, reason='not_allowed', message=str(error), path=norm, name=name, parent=parent)
    try:
        exists, is_dir = os.path.exists(norm), os.path.isdir(norm)
        parent_exists = os.path.isdir(parent)
    except OSError:
        exists = is_dir = parent_exists = False
    base = dict(exists=exists, isDir=is_dir, parentExists=parent_exists, name=name, path=norm, parent=parent)
    if exists and not is_dir:
        return _result(valid=False, reason='not_a_folder', message='"%s" is a file, not a folder' % name, **base)
    if not exists and not parent_exists:
        return _result(valid=False, reason='parent_missing', message="%s doesn't exist" % parent, **base)
    return _result(valid=True, reason='existing' if exists else 'new', message='', **base)


def create_folder(raw, git_init=False, runner=None):
    """One new folder level, never intermediate folders, never an existing one. Returns {path, git, gitError?}."""
    runner = runner or subprocess.run
    info = check_path(raw)
    if not info['valid']:
        raise FolderError(info['message'] or 'Invalid folder', info['reason'])
    if info['exists']:
        raise FolderError('That folder already exists', 'exists')
    path = info['path']
    try:
        os.mkdir(path)
    except FileExistsError:
        raise FolderError('That folder already exists', 'exists')
    except OSError as error:
        raise FolderError('Could not create the folder: %s' % (error.strerror or error), 'mkdir_failed')
    out = {'path': path, 'git': False}
    if git_init:
        git = git_path()
        if not git:
            out['gitError'] = 'git not found'
        else:
            try:
                done = runner([git, 'init'], cwd=path, capture_output=True, text=True, timeout=GIT_TIMEOUT)
                if done.returncode == 0:
                    out['git'] = True
                else:
                    out['gitError'] = (done.stderr or done.stdout or 'git init failed').strip()[:300]
            except (OSError, subprocess.SubprocessError) as error:
                out['gitError'] = str(error)[:300]
    return out


class FolderMemory:
    """The parent folder where a project was last created or opened through the New project dialog (one small JSON file)."""
    FILE = 'studio-folders.json'

    def __init__(self, state_dir=None):
        self.path = pathlib.Path(state_dir) / self.FILE if state_dir else None
        self.lock = threading.RLock()
        self._last = ''

    def get(self):
        with self.lock:
            if self.path is not None:
                try:
                    data = json.loads(self.path.read_text(encoding='utf-8'))
                    value = data.get('lastParent') if isinstance(data, dict) else ''
                    return value if isinstance(value, str) else ''
                except (OSError, ValueError):
                    return ''
            return self._last

    def remember_project(self, project_path):
        """Store the parent of an existing project folder. Returns the stored parent."""
        norm, parent, _, _ = validate_path(project_path)
        if not os.path.isdir(norm):
            raise FolderError('That folder does not exist', 'parent_missing')
        with self.lock:
            self._last = parent
            if self.path is not None:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                handle, temporary = tempfile.mkstemp(prefix='.studio-folders-', suffix='.tmp', dir=self.path.parent)
                try:
                    with os.fdopen(handle, 'w', encoding='utf-8') as stream:
                        json.dump({'version': 1, 'lastParent': parent}, stream)
                    os.replace(temporary, self.path)
                except BaseException:
                    try:
                        os.unlink(temporary)
                    except OSError:
                        pass
                    raise
        return parent


def start_folder(memory, home=None):
    """GET /api/live/folders/start. 'last' when the remembered parent still exists, else the home folder; the page then
    prefers the parent holding most of its projects before falling back to home."""
    home = home or str(pathlib.Path.home())
    last = memory.get() if memory else ''
    if last and os.path.isdir(last):
        return {'start': last, 'home': home, 'source': 'last'}
    return {'start': home, 'home': home, 'source': 'home'}


_PICKER_SCRIPT = r'''
import json, sys
try:
    import tkinter
    from tkinter import filedialog
except Exception:
    print(json.dumps({"error": "unavailable"})); sys.exit(0)
start = sys.argv[1] if len(sys.argv) > 1 else ""
try:
    root = tkinter.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    options = {"mustexist": False, "parent": root, "title": "Choose a project folder"}
    if start:
        options["initialdir"] = start
    chosen = filedialog.askdirectory(**options)
    root.destroy()
except Exception:
    print(json.dumps({"error": "unavailable"})); sys.exit(0)
print(json.dumps({"path": chosen or None}))
'''

_pick_lock = threading.Lock()


def _start_dir(raw):
    """Nearest existing folder at or above the typed path, as plain data for the picker (never executed)."""
    text = raw.strip() if isinstance(raw, str) else ''
    if not text or len(text) > MAX_PATH_CHARS or any(ord(c) < 32 for c in text):
        return ''
    probe = pathlib.Path(text)
    for candidate in [probe, *probe.parents]:
        try:
            if candidate.is_dir():
                return str(candidate)
        except OSError:
            return ''
    return ''


def pick_folder(start, runner=None):
    """Native folder dialog in a short-lived child process (Tk must not live in a server thread).
    Returns (status, payload): 200 {path|None}, 409 when one is already open, 503 when tkinter is missing."""
    runner = runner or subprocess.run
    if not _pick_lock.acquire(blocking=False):
        return 409, {'error': 'A folder picker is already open', 'code': 'picker_busy'}
    try:
        try:
            done = runner([sys.executable, '-I', '-c', _PICKER_SCRIPT, _start_dir(start)], capture_output=True, text=True, timeout=PICK_TIMEOUT)
        except subprocess.TimeoutExpired:
            return 504, {'error': 'The folder picker timed out', 'code': 'picker_timeout'}
        except (OSError, subprocess.SubprocessError):
            return 503, {'error': PICK_UNAVAILABLE, 'code': 'picker_unavailable'}
        try:
            lines = [l for l in (done.stdout or '').strip().splitlines() if l.strip()]
            data = json.loads(lines[-1]) if lines else None
        except ValueError:
            data = None
        if not isinstance(data, dict) or data.get('error') or done.returncode != 0:
            return 503, {'error': PICK_UNAVAILABLE, 'code': 'picker_unavailable'}
        path = data.get('path')
        return 200, {'path': path if isinstance(path, str) and path else None}
    finally:
        _pick_lock.release()
