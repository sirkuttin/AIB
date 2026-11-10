"""Open a project folder, a file at a line, or a workspace in an editor installed on this PC.

Safety rules (this module is the only place Studio starts a desktop program on request):
  * the program comes from a fixed table of known editors, found on disk (never from request text);
  * the only request data that reaches a command line is a path that was resolved and found inside a folder Studio
    already knows as a project (or a git worktree of one), or a .code-workspace file that sits next to such a project;
  * programs start with a list of arguments, never through a shell; the one exception is a vendor .cmd launcher, which
    Windows runs through cmd.exe, so paths with cmd metacharacters are refused in that case;
  * nothing is read from VS Code's own state database.
"""
import json
import logging
import os
import pathlib
import re
import shutil
import subprocess
import sys
import threading
import time

import security

log = logging.getLogger(__name__)
log.addHandler(logging.NullHandler())   # a library logger: quiet until a program configures logging (log_setup.py)

MAX_PATH_CHARS = 1024
MAX_LINE = 10_000_000
DETECT_TTL = 30.0
MAX_WORKSPACE_BYTES = 512 * 1024
MAX_WORKSPACES_PER_DIR = 20
PARENT_LEVELS = 3
KINDS = ('folder', 'file', 'workspace')
CMD_UNSAFE = re.compile(r'[&|<>^%!"\r\n]')

# id, display name, command names on PATH, install locations (environment variable, relative path to the .exe)
EDITOR_SPECS = (
    {'id': 'code', 'macApp': 'Visual Studio Code', 'name': 'VS Code', 'commands': ('code.cmd', 'code'), 'fileAtLine': True, 'workspace': True,
     'exes': (('LOCALAPPDATA', 'Programs/Microsoft VS Code/Code.exe'), ('ProgramFiles', 'Microsoft VS Code/Code.exe'),
              ('ProgramFiles(x86)', 'Microsoft VS Code/Code.exe'))},
    {'id': 'cursor', 'macApp': 'Cursor', 'name': 'Cursor', 'commands': ('cursor.cmd', 'cursor'), 'fileAtLine': True, 'workspace': True,
     'exes': (('LOCALAPPDATA', 'Programs/cursor/Cursor.exe'), ('ProgramFiles', 'Cursor/Cursor.exe'))},
    {'id': 'windsurf', 'macApp': 'Windsurf', 'name': 'Windsurf', 'commands': ('windsurf.cmd', 'windsurf'), 'fileAtLine': True, 'workspace': True,
     'exes': (('LOCALAPPDATA', 'Programs/Windsurf/Windsurf.exe'), ('ProgramFiles', 'Windsurf/Windsurf.exe'))},
    # Devin: its command-line flags are not tested yet, so it only opens folders.
    {'id': 'devin', 'macApp': 'Devin', 'name': 'Devin', 'commands': (), 'fileAtLine': False, 'workspace': False, 'folderOnly': True,
     'exes': (('LOCALAPPDATA', 'Programs/Devin/Devin.exe'), ('ProgramFiles', 'Devin/Devin.exe'))},
)
MAC_APP_DIRS = ('/Applications', '~/Applications')
LINUX_TERMINALS = ('x-terminal-emulator', 'gnome-terminal', 'konsole', 'xfce4-terminal')
DEFAULT_ORDER = tuple(spec['id'] for spec in EDITOR_SPECS)


class EditorError(ValueError):
    def __init__(self, message, code='invalid', status=400):
        super().__init__(message)
        self.code = code
        self.status = status


# ---- detection ---------------------------------------------------------------------------------

def _find_editor(spec, env, which, isfile):
    """(exe path, via_cmd) for one editor, or None. A real .exe is preferred over a .cmd launcher."""
    for var, rel in spec['exes']:
        base = env.get(var)
        if base:
            candidate = os.path.join(base, *rel.split('/'))
            if isfile(candidate):
                return candidate, False
    for name in spec['commands']:
        found = which(name)
        if not found:
            continue
        if found.lower().endswith(('.cmd', '.bat')):
            # <install>\bin\code.cmd sits next to <install>\Code.exe; use the exe when it is there.
            for _, rel in spec['exes']:
                sibling = os.path.join(os.path.dirname(os.path.dirname(found)), os.path.basename(rel))
                if isfile(sibling):
                    return sibling, False
            return found, True
        return found, False
    return None


def detect(env=None, which=None, isfile=None, windows=None, platform=None, isdir=None):
    """Editors, Explorer and a terminal found on this PC: a list of dicts that includes private launch details under
    'exe' and 'viaCmd'. Use public_entry() for what goes to the page."""
    env = os.environ if env is None else env
    which = shutil.which if which is None else which
    isfile = os.path.isfile if isfile is None else isfile
    windows = (os.name == 'nt') if windows is None else windows
    platform = sys.platform if platform is None else platform
    isdir = os.path.isdir if isdir is None else isdir
    found = []
    for spec in EDITOR_SPECS:
        hit = _find_editor(spec, env, which, isfile)
        if not hit and not windows and platform == 'darwin':
            app = _mac_app(spec['macApp'], isdir)
            if app:   # installed in /Applications but no command-line launcher on PATH: start it with `open -a`
                found.append({'id': spec['id'], 'name': spec['name'], 'kind': 'editor', 'exe': 'open', 'viaCmd': False, 'macApp': spec['macApp'],
                              'folderOnly': bool(spec.get('folderOnly')),
                              'capabilities': {'folder': True, 'file': not spec.get('folderOnly'), 'fileAtLine': False, 'workspace': spec['workspace']}})
                continue
        if hit:
            found.append({'id': spec['id'], 'name': spec['name'], 'kind': 'editor', 'exe': hit[0], 'viaCmd': hit[1],
                          'folderOnly': bool(spec.get('folderOnly')),
                          'capabilities': {'folder': True, 'file': not spec.get('folderOnly'), 'fileAtLine': spec['fileAtLine'], 'workspace': spec['workspace']}})
    if windows:
        root = env.get('SystemRoot') or env.get('windir') or r'C:\Windows'
        explorer = os.path.join(root, 'explorer.exe')
        found.append({'id': 'explorer', 'name': 'File Explorer', 'kind': 'explorer', 'exe': explorer if isfile(explorer) else 'explorer.exe', 'viaCmd': False,
                      'capabilities': {'folder': True, 'file': True, 'fileAtLine': False, 'workspace': False}})
        wt = which('wt.exe') or which('wt')
        if wt:
            found.append({'id': 'terminal', 'name': 'Windows Terminal', 'kind': 'terminal', 'exe': wt, 'viaCmd': False, 'terminal': 'wt',
                          'capabilities': {'folder': True, 'file': False, 'fileAtLine': False, 'workspace': False}})
        else:
            shell = which('powershell.exe') or which('powershell')
            if shell:
                found.append({'id': 'terminal', 'name': 'PowerShell', 'kind': 'terminal', 'exe': shell, 'viaCmd': False, 'terminal': 'powershell',
                              'capabilities': {'folder': True, 'file': False, 'fileAtLine': False, 'workspace': False}})
    if not windows and platform == 'darwin':
        found.append({'id': 'explorer', 'name': 'Finder', 'kind': 'explorer', 'exe': 'open', 'viaCmd': False, 'opener': 'open',
                      'capabilities': {'folder': True, 'file': True, 'fileAtLine': False, 'workspace': False}})
        found.append({'id': 'terminal', 'name': 'Terminal', 'kind': 'terminal', 'exe': 'open', 'viaCmd': False, 'terminal': 'mac',
                      'capabilities': {'folder': True, 'file': False, 'fileAtLine': False, 'workspace': False}})
    elif not windows and platform.startswith('linux'):
        opener = which('xdg-open')
        if opener:
            found.append({'id': 'explorer', 'name': 'File manager', 'kind': 'explorer', 'exe': opener, 'viaCmd': False, 'opener': 'xdg',
                          'capabilities': {'folder': True, 'file': True, 'fileAtLine': False, 'workspace': False}})
        for name in LINUX_TERMINALS:
            terminal = which(name)
            if terminal:
                found.append({'id': 'terminal', 'name': 'Terminal', 'kind': 'terminal', 'exe': terminal, 'viaCmd': False, 'terminal': 'posix',
                              'capabilities': {'folder': True, 'file': False, 'fileAtLine': False, 'workspace': False}})
                break
    return found


def _mac_app(name, isdir):
    for base in MAC_APP_DIRS:
        candidate = os.path.join(os.path.expanduser(base), name + '.app')
        if isdir(candidate):
            return candidate
    return None


def public_entry(entry):
    return {'id': entry['id'], 'name': entry['name'], 'kind': entry['kind'], 'capabilities': dict(entry['capabilities'])}


def default_editor(entries):
    """First detected of VS Code, Cursor, Windsurf, Devin; '' when none."""
    ids = [e['id'] for e in entries if e['kind'] == 'editor']
    for wanted in DEFAULT_ORDER:
        if wanted in ids:
            return wanted
    return ''


# ---- paths -------------------------------------------------------------------------------------

def _norm(path):
    return os.path.normcase(os.path.normpath(path))


def _inside(path, root):
    a, b = _norm(path), _norm(root)
    if a == b:
        return True
    prefix = b if b.endswith(os.sep) else b + os.sep
    return a.startswith(prefix)


def _is_anchor(path):
    return os.path.dirname(path) == path


def clean_path_text(value, what='path'):
    """The raw text of a path from a request: a plain absolute-looking string without control characters or UNC forms."""
    if not isinstance(value, str) or not value.strip() or len(value) > MAX_PATH_CHARS:
        raise EditorError(f'Invalid {what}')
    if any(ord(c) < 32 for c in value) or '\x7f' in value:
        raise EditorError(f'Invalid {what}')
    text = value.strip()
    if security.is_network_path(text):   #\\server\share, \\?\C:\..., \\.\device: network and device paths are never opened
        raise EditorError('Network and device paths cannot be opened from Studio', 'path_refused', 403)
    return text


def worktree_main(path, limit=16):
    """For a path inside a linked git worktree, the main checkout's folder ('' when it is not one). Reads only the small
    `.git` pointer file."""
    current = os.path.abspath(path)
    for _ in range(limit):
        marker = os.path.join(current, '.git')
        if os.path.isfile(marker):
            try:
                with open(marker, encoding='utf-8', errors='replace') as stream:
                    head = stream.read(600)
            except OSError:
                return ''
            if not head.lower().startswith('gitdir:'):
                return ''
            gitdir = head[7:].strip().splitlines()[0].strip() if head[7:].strip() else ''
            if not gitdir:
                return ''
            if not os.path.isabs(gitdir):
                gitdir = os.path.join(current, gitdir)
            gitdir = os.path.normpath(gitdir)
            parts = pathlib.PurePath(gitdir).parts
            lowered = [p.lower() for p in parts]
            if 'worktrees' in lowered:
                at = len(lowered) - 1 - lowered[::-1].index('worktrees')
                if at >= 2 and lowered[at - 1] == '.git':
                    return str(pathlib.PurePath(*parts[:at - 1]))
            return ''
        parent = os.path.dirname(current)
        if parent == current:
            break
        current = parent
    return ''


def _real(path):
    try:
        return os.path.realpath(path)
    except (OSError, ValueError):
        return os.path.abspath(path)


def resolve_inside(raw, roots, base=None, what='path'):
    """Resolve a request path (relative paths against `base`, which must itself be inside the roots) and require it to
    be inside one of `roots` or a git worktree of one. Returns the resolved absolute path; raises EditorError."""
    text = clean_path_text(raw, what)
    if not os.path.isabs(text):
        if base is None:
            raise EditorError(f'The {what} must be a full path', 'path_refused', 403)
        text = os.path.join(base, text)
    if os.path.splitdrive(text)[0] and not os.path.isabs(text):   # C:foo (drive-relative)
        raise EditorError(f'The {what} must be a full path', 'path_refused', 403)
    resolved = _real(text)
    real_roots = [_real(r) for r in roots if isinstance(r, str) and r and not _is_anchor(_real(r))]
    if any(_inside(resolved, r) for r in real_roots):
        return resolved
    main = worktree_main(resolved)
    if main and any(_inside(_real(main), r) for r in real_roots):
        return resolved
    raise EditorError('That location is not inside a project folder Studio knows, so Studio will not open it', 'path_refused', 403)


# ---- workspace files ---------------------------------------------------------------------------

def strip_jsonc(text):
    """Remove // and /* */ comments and trailing commas from JSON-with-comments, leaving strings untouched."""
    out, i, n = [], 0, len(text)
    while i < n:
        ch = text[i]
        if ch == '"':
            j = i + 1
            while j < n and text[j] != '"':
                j += 2 if text[j] == '\\' else 1
            out.append(text[i:j + 1])
            i = j + 1
        elif text.startswith('//', i):
            j = text.find('\n', i)
            i = n if j < 0 else j
        elif text.startswith('/*', i):
            j = text.find('*/', i + 2)
            i = n if j < 0 else j + 2
        else:
            out.append(ch)
            i += 1
    cleaned = ''.join(out)
    # trailing commas: a comma followed only by whitespace and a closing bracket (outside strings)
    result, i, n = [], 0, len(cleaned)
    while i < n:
        ch = cleaned[i]
        if ch == '"':
            j = i + 1
            while j < n and cleaned[j] != '"':
                j += 2 if cleaned[j] == '\\' else 1
            result.append(cleaned[i:j + 1])
            i = j + 1
        elif ch == ',':
            j = i + 1
            while j < n and cleaned[j] in ' \t\r\n':
                j += 1
            if j < n and cleaned[j] in ']}':
                i += 1
            else:
                result.append(ch)
                i += 1
        else:
            result.append(ch)
            i += 1
    return ''.join(result)


def workspace_folders(file_path):
    """Absolute folders listed by one .code-workspace file (local `path` entries only), or None when unreadable."""
    try:
        if os.path.getsize(file_path) > MAX_WORKSPACE_BYTES:
            return None
        with open(file_path, encoding='utf-8-sig', errors='replace') as stream:
            data = json.loads(strip_jsonc(stream.read()))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or not isinstance(data.get('folders'), list):
        return None
    base = os.path.dirname(os.path.abspath(file_path))
    out = []
    for item in data['folders'][:200]:
        value = item.get('path') if isinstance(item, dict) else item if isinstance(item, str) else None
        if isinstance(value, str) and value and '://' not in value:
            out.append(os.path.normpath(value if os.path.isabs(value) else os.path.join(base, value)))
    return out


def find_workspaces(project, parents=PARENT_LEVELS):
    """*.code-workspace files in the project folder and up to `parents` parent folders that list the project as one of
    their folders: [{path, name, folders, others}]. Plain files only; VS Code's own state is never read."""
    here = _real(project)
    matches, current = [], here
    for _ in range(parents + 1):
        try:
            names = sorted(n for n in os.listdir(current) if n.lower().endswith('.code-workspace'))[:MAX_WORKSPACES_PER_DIR]
        except OSError:
            names = []
        for name in names:
            file_path = os.path.join(current, name)
            if not os.path.isfile(file_path):
                continue
            folders = workspace_folders(file_path)
            if folders is None:
                continue
            real = [_real(f) for f in folders]
            if any(_norm(r) == _norm(here) for r in real):
                matches.append({'path': file_path, 'name': name[:-len('.code-workspace')] or name, 'folders': len(real), 'others': len(real) - 1})
        parent = os.path.dirname(current)
        if parent == current:
            break
        current = parent
    return matches


# ---- commands ----------------------------------------------------------------------------------

def build_command(entry, kind, path, line=None):
    """The argument list (never a shell string) that opens `path` with this program. `path` is already validated."""
    exe, program = entry['exe'], entry['kind']
    if entry.get('macApp'):   # an installed app without a command-line launcher: `open -a <App> <path>`
        if program == 'editor' and kind == 'file' and not entry['capabilities']['file']:
            raise EditorError(f"{entry['name']} can only open folders from Studio for now", 'unsupported', 400)
        if kind == 'workspace' and not entry['capabilities']['workspace']:
            raise EditorError(f"{entry['name']} cannot open workspace files from Studio", 'unsupported', 400)
        return [exe, '-a', entry['macApp'], path]
    if program == 'editor':
        caps = entry['capabilities']
        if kind == 'file':
            if not caps['file']:
                raise EditorError(f"{entry['name']} can only open folders from Studio for now", 'unsupported', 400)
            return [exe, '-r', '--goto', f'{path}:{line}'] if line else [exe, '-r', path]
        if kind == 'workspace':
            if not caps['workspace']:
                raise EditorError(f"{entry['name']} cannot open workspace files from Studio", 'unsupported', 400)
            return [exe, '-r', path]
        return [exe, path] if entry.get('folderOnly') else [exe, '-r', path]
    if program == 'explorer' and entry.get('opener') == 'open':   # macOS Finder: reveal a file, open a folder
        if kind == 'workspace':
            raise EditorError('Finder opens folders and files only', 'unsupported', 400)
        return [exe, '-R', path] if kind == 'file' else [exe, path]
    if program == 'explorer' and entry.get('opener') == 'xdg':   # Linux has no portable "select this file": open its folder
        if kind == 'workspace':
            raise EditorError('The file manager opens folders and files only', 'unsupported', 400)
        return [exe, os.path.dirname(path) if kind == 'file' else path]
    if program == 'explorer':
        if kind == 'workspace':
            raise EditorError('Explorer opens folders and files only', 'unsupported', 400)
        return [exe, '/select,', path] if kind == 'file' else [exe, path]
    if program == 'terminal':
        if kind != 'folder':
            raise EditorError('The terminal opens in a folder', 'unsupported', 400)
        if entry.get('terminal') == 'mac':
            return [exe, '-a', 'Terminal', path]
        if entry.get('terminal') == 'wt' and ';' not in path:   # wt treats ';' as a command separator
            return [exe, '-d', path]
        return None   # handled by the caller: start the shell with the folder as its working directory
    raise EditorError('Unknown program', 'unsupported', 400)


class Launcher:
    """Detection cache and the one place a program is started. `popen` is injectable so tests never launch anything."""

    def __init__(self, roots, popen=None, detect_fn=None, windows=None, preferred=None, platform=None):
        self._roots = roots              # callable returning the folders Studio knows as projects
        self._preferred = preferred or (lambda: '')   # callable returning the default editor id saved in Settings
        self._popen = popen or subprocess.Popen
        self._detect = detect_fn or (lambda: detect(windows=windows, platform=platform))
        self._windows = (os.name == 'nt') if windows is None else windows
        self._lock = threading.Lock()
        self._cache, self._at = [], 0.0

    def entries(self, fresh=False):
        with self._lock:
            if fresh or not self._at or time.time() - self._at > DETECT_TTL:
                self._cache, self._at = self._detect(), time.time()
            return list(self._cache)

    def listing(self, project=None):
        entries = self.entries()
        saved = self._preferred()
        chosen = saved if any(e['id'] == saved and e['kind'] == 'editor' for e in entries) else default_editor(entries)
        out = {'editors': [public_entry(e) for e in entries], 'default': chosen, 'detectedDefault': default_editor(entries), 'workspaces': []}
        if project:
            folder = resolve_inside(project, self._roots(), what='project folder')
            out['project'] = folder
            out['workspaces'] = find_workspaces(folder)
        return out

    def open(self, body):
        if not isinstance(body, dict):
            raise EditorError('Invalid request')
        editor_id, kind = body.get('editor'), body.get('kind', 'folder')
        if not isinstance(editor_id, str) or kind not in KINDS:
            raise EditorError('Choose an editor and what to open')
        line = body.get('line')
        if line is not None and (isinstance(line, bool) or not isinstance(line, int) or not 1 <= line <= MAX_LINE):
            raise EditorError('Invalid line number')
        entry = next((e for e in self.entries() if e['id'] == editor_id), None)
        if entry is None:
            raise EditorError('That program was not found on this PC', 'not_found', 404)
        roots = self._roots()
        base = None
        if body.get('cwd') is not None:
            base = resolve_inside(body['cwd'], roots, what='folder')
        path = resolve_inside(body.get('path'), roots, base=base) if kind != 'workspace' else self._workspace_path(body.get('path'), roots, base)
        if kind == 'folder' and not os.path.isdir(path):
            raise EditorError('That folder no longer exists', 'missing', 404)
        if kind == 'file':
            if os.path.isdir(path) or not os.path.exists(path):
                raise EditorError('That file no longer exists', 'missing', 404)
        command = build_command(entry, kind, path, line)
        if entry['viaCmd'] and any(CMD_UNSAFE.search(part) for part in (command or [])[1:]):
            raise EditorError('That path has characters that cannot be passed safely to the editor launcher', 'unsafe_path', 400)
        self._start(entry, command, path)
        return {'ok': True, 'editor': entry['id'], 'name': entry['name'], 'kind': kind}

    def _workspace_path(self, raw, roots, base):
        text = clean_path_text(raw, 'workspace file')
        if not text.lower().endswith('.code-workspace'):
            raise EditorError('That is not a workspace file', 'path_refused', 403)
        candidate = _real(text if os.path.isabs(text) else os.path.join(base or '', text))
        if not os.path.isfile(candidate):
            raise EditorError('That workspace file no longer exists', 'missing', 404)
        for root in roots:
            if isinstance(root, str) and root and not _is_anchor(_real(root)):
                if any(_norm(m['path']) == _norm(candidate) for m in find_workspaces(root)) or _inside(candidate, _real(root)):
                    return candidate
        raise EditorError('That workspace file does not belong to a project Studio knows', 'path_refused', 403)

    def _start(self, entry, command, path):
        flags = 0
        kwargs = {'stdin': subprocess.DEVNULL, 'stdout': subprocess.DEVNULL, 'stderr': subprocess.DEVNULL, 'close_fds': True}
        cwd = None
        if command is None:   # PowerShell (or wt with a ';' path): the folder is the working directory, so no path is in the command text
            command = [entry['exe'], '-NoExit'] if entry.get('terminal') == 'powershell' else [entry['exe']]
            cwd = path
        if self._windows:
            if entry['kind'] == 'terminal' and entry.get('terminal') == 'powershell':
                flags = getattr(subprocess, 'CREATE_NEW_CONSOLE', 0x10)
            elif entry['kind'] != 'explorer':
                flags = getattr(subprocess, 'DETACHED_PROCESS', 0x8) | getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0x200)
            kwargs['creationflags'] = flags
        else:
            kwargs['start_new_session'] = True   # the program must outlive Studio and not share its process group
        if cwd:
            kwargs['cwd'] = cwd
        try:
            self._popen(command, **kwargs)
        except OSError as error:
            raise EditorError(f"Could not start {entry['name']}: {error}", 'launch_failed', 500)


def known_roots(studio):
    """Folders Studio knows as projects: open and recovered chats, saved conversation marks, and projects with saved prefs."""
    roots = []

    def add(value):
        if isinstance(value, str) and value and os.path.isabs(value) and value not in roots:
            roots.append(value)
    try:
        listed = studio.live_list()
        for item in list(listed.get('connections', [])) + list(listed.get('recovered', [])):
            add(item.get('cwd') if isinstance(item, dict) else None)
    except Exception:   # a host problem must not hide the roots we do have
        log.exception('Listing live conversations for editor roots failed')
    try:
        for entry in list(studio.conversations.entries.values()):
            add(entry.get('cwd'))
    except Exception:
        log.exception('Reading saved conversation folders for editor roots failed')
    try:
        for key in list(studio.project_prefs.projects):
            if isinstance(key, str) and key.startswith('w:'):
                add(key[2:])
    except Exception:
        log.exception('Reading project folders for editor roots failed')
    return roots
