"""Read-only "Changes" data for a chat's folder: what git sees as uncommitted (status + diff against HEAD).

Everything here only reads. git is run with list arguments (never a shell), a timeout and an output cap, with hooks,
external diff drivers and optional index locks switched off. Paths from the page must match a path git itself reported.
"""
import os
import pathlib
import shutil
import subprocess
import threading

MAX_FILES = 300                      # files listed; the rest only counted
MAX_DIFF_BYTES = 200 * 1024          # per-file diff (and untracked file read) cap
MAX_LIST_BYTES = 4 * 1024 * 1024     # status / numstat output cap
MAX_LINE_CHARS = 2000                # a diff line longer than this is cut
GIT_TIMEOUT = 15
BINARY_PROBE = 8192
EMPTY_TREE = {'sha1': '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
              'sha256': '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321'}
_BASE = ['-c', 'core.quotepath=off', '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', '--no-pager', '--no-optional-locks', '--literal-pathspecs']


class ChangesError(Exception):
    def __init__(self, message, code='invalid'):
        super().__init__(message)
        self.code = code


def git_path():
    return shutil.which('git')


def run_git(args, cwd, timeout=GIT_TIMEOUT, cap=MAX_LIST_BYTES):
    """Run git; returns (stdout bytes up to cap, truncated, returncode). returncode is None on timeout or when git cannot start."""
    git = git_path()
    if not git:
        return b'', False, None
    env = dict(os.environ, GIT_TERMINAL_PROMPT='0', GIT_OPTIONAL_LOCKS='0', GIT_EXTERNAL_DIFF='', LC_ALL='C')
    flags = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
    try:
        proc = subprocess.Popen([git, *_BASE, *args], cwd=str(cwd), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, env=env, creationflags=flags)
    except OSError:
        return b'', False, None
    box = {}

    def read():
        try:
            box['data'] = proc.stdout.read(cap + 1)
        except (OSError, ValueError):
            box['data'] = b''
    reader = threading.Thread(target=read, daemon=True)
    reader.start()
    reader.join(timeout)
    if reader.is_alive():
        proc.kill()
        reader.join(2)
        proc.wait()
        proc.stdout.close()
        return box.get('data', b'')[:cap], True, None
    data = box.get('data', b'')
    if len(data) > cap:
        proc.kill()
        proc.wait()
        proc.stdout.close()
        return data[:cap], True, proc.returncode
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
        proc.stdout.close()
        return data, False, None
    proc.stdout.close()
    return data, False, proc.returncode


def safe_relpath(path):
    """True for a plain repository-relative path as git prints it (forward slashes, no '..', not absolute)."""
    if not isinstance(path, str) or not path or len(path) > 1024 or '\0' in path or '\\' in path or path.startswith('/') or (os.name == 'nt' and ':' in path.split('/')[0]):   # ':' only means a drive on Windows
        return False
    return all(part not in ('', '.', '..') for part in path.split('/'))


def locate(cwd):
    """(toplevel, prefix, base) for a folder inside a git work tree, or None when it is not one.
    prefix is the folder's path inside the repository ('' at the top or 'sub/dir/'); base is HEAD or the empty tree."""
    folder = pathlib.Path(str(cwd))
    if not folder.is_dir() or not git_path():
        return None
    out, _, code = run_git(['rev-parse', '--show-toplevel', '--show-prefix'], folder, cap=8192)
    if code != 0:
        return None
    lines = out.decode('utf-8', 'replace').split('\n')
    if len(lines) < 2 or not lines[0].strip():
        return None
    top = os.path.normpath(lines[0].strip())
    prefix = lines[1].strip()
    _, _, head = run_git(['rev-parse', '--verify', '-q', 'HEAD'], top, cap=1024)
    if head == 0:
        base = 'HEAD'
    else:
        fmt, _, _ = run_git(['rev-parse', '--show-object-format'], top, cap=64)
        base = EMPTY_TREE['sha256' if fmt.strip() == b'sha256' else 'sha1']
    return top, prefix, base


def parse_status(raw):
    """[(xy, path, old_path)] from `git status --porcelain=v1 -z`."""
    parts = raw.decode('utf-8', 'replace').split('\0')
    out, i = [], 0
    while i < len(parts):
        item = parts[i]
        i += 1
        if len(item) < 4:
            continue
        xy, path, old = item[:2], item[3:], ''
        if ('R' in xy or 'C' in xy) and i < len(parts):
            old = parts[i]
            i += 1
        out.append((xy, path, old))
    return out


def status_letter(xy):
    """One letter: C conflict, U untracked, R renamed, D deleted, A added, M modified."""
    if xy == '??':
        return 'U'
    if 'U' in xy or xy in ('AA', 'DD'):
        return 'C'
    for letter in 'RDA':
        if letter in xy:
            return letter
    if 'C' in xy:
        return 'A'
    return 'M'


def parse_numstat(raw):
    """{path: (added, removed, binary)} from `git diff --numstat -z` (renames are keyed by the new path)."""
    parts = raw.decode('utf-8', 'replace').split('\0')
    out, i = {}, 0
    while i < len(parts):
        item = parts[i]
        i += 1
        fields = item.split('\t', 2)
        if len(fields) < 3:
            continue
        added, removed, path = fields
        if path == '' and i + 1 < len(parts):
            path = parts[i + 1]
            i += 2
        binary = added == '-' or removed == '-'
        out[path] = (0 if binary else int(added or 0), 0 if binary else int(removed or 0), binary)
    return out


def _real_inside(root, rel):
    full = os.path.join(root, *rel.split('/'))
    try:
        if os.path.islink(full):
            return None
        real = os.path.realpath(full)
        base = os.path.realpath(root)
        if os.path.commonpath([real, base]) != base or not os.path.isfile(real):
            return None
        return real
    except (OSError, ValueError):
        return None


def read_untracked(root, rel, cap=MAX_DIFF_BYTES):
    """(text lines, truncated, binary) for an untracked file; binary or special files give no lines."""
    real = _real_inside(root, rel)
    if real is None:
        return [], False, True
    try:
        with open(real, 'rb') as handle:
            data = handle.read(cap + 1)
    except OSError:
        return [], False, True
    if b'\0' in data[:BINARY_PROBE]:
        return [], False, True
    truncated = len(data) > cap
    text = data[:cap].decode('utf-8', 'replace')
    lines = text.split('\n')
    if lines and lines[-1] == '':
        lines.pop()
    elif truncated and lines:
        lines.pop()   # drop the line cut by the cap
    return [line.rstrip('\r')[:MAX_LINE_CHARS] for line in lines], truncated, False


def parse_name_status(raw):
    """[(letter, path, old_path)] from `git diff --name-status -z -M`."""
    parts = raw.decode('utf-8', 'replace').split('\0')
    out, i = [], 0
    while i < len(parts):
        code = parts[i]
        i += 1
        if not code:
            continue
        letter = code[0]
        if letter in 'RC':
            if i + 1 >= len(parts):
                break
            old, path = parts[i], parts[i + 1]
            i += 2
            out.append(('R' if letter == 'R' else 'A', path, old if letter == 'R' else ''))
        else:
            if i >= len(parts):
                break
            path = parts[i]
            i += 1
            out.append(('C' if letter == 'U' else 'D' if letter == 'D' else 'A' if letter == 'A' else 'M', path, ''))
    return out


def commit_exists(top, commit):
    if not isinstance(commit, str) or not commit or commit.startswith('-'):
        return False
    _, _, code = run_git(['cat-file', '-e', commit + '^{commit}'], top, cap=64)
    return code == 0


def branch_entries(top, prefix, base):
    """([(letter, path, old, untracked)], cut): the working tree against `base`: committed, uncommitted and untracked (not ignored) files.
    cut is True when git's output was cut at the cap."""
    scope = ['--', prefix.rstrip('/')] if prefix else []
    raw, cut, code = run_git(['diff', base, '--name-status', '-z', '-M', '--no-ext-diff', '--no-textconv', *scope], top)
    if code not in (0, 1) and not cut:
        raise ChangesError('git diff failed', 'git_failed')
    entries = [(letter, path, old, False) for letter, path, old in parse_name_status(raw)]
    seen = {path for _, path, _, _ in entries}
    raw2, cut2, code2 = run_git(['ls-files', '--others', '--exclude-standard', '-z', *scope], top)
    if code2 != 0 and not cut2:
        raise ChangesError('git ls-files failed', 'git_failed')
    for path in raw2.decode('utf-8', 'replace').split('\0'):
        if path and path not in seen:
            entries.append(('U', path, '', True))
    entries.sort(key=lambda e: e[1])
    return entries, cut or cut2


def get_changes(cwd, base_commit=None):
    """The file list for the folder's uncommitted changes. {'git': False} when the folder is not in a git work tree.
    With base_commit (a worktree chat's recorded base) the scope is 'branch': the working tree against that commit."""
    found = locate(cwd)
    if not found:
        return {'git': False}
    top, prefix, base = found
    if base_commit and commit_exists(top, base_commit):
        return _get_branch_changes(top, prefix, base_commit)
    scope = ['--', prefix.rstrip('/')] if prefix else []
    raw, cut, code = run_git(['status', '--porcelain=v1', '-z', '--untracked-files=all', *scope], top)
    if code != 0 and not cut:
        raise ChangesError('git status failed', 'git_failed')
    entries = parse_status(raw)
    nums, _, ncode = run_git(['diff', base, '--numstat', '-z', '-M', '--no-ext-diff', '--no-textconv', *scope], top)
    stats = parse_numstat(nums) if ncode in (0, 1) or ncode is None else {}
    truncated = cut
    files = []
    total = 0
    for xy, path, old in entries:
        letter = status_letter(xy)
        if letter != 'U' and path not in stats:
            continue   # e.g. added then deleted again: nothing against HEAD
        total += 1
        if len(files) >= MAX_FILES:
            truncated = True
            continue
        item = {'path': path, 'status': letter, 'added': 0, 'removed': 0, 'binary': False}
        if old:
            item['oldPath'] = old
        if letter == 'U':
            lines, cut_file, binary = read_untracked(top, path)
            item.update(added=len(lines), binary=binary)
            if cut_file:
                item['partial'] = True
        else:
            item['added'], item['removed'], item['binary'] = stats[path]
        files.append(item)
    totals = {'files': len(files), 'added': sum(f['added'] for f in files), 'removed': sum(f['removed'] for f in files)}
    return {'git': True, 'scope': 'uncommitted', 'root': top, 'prefix': prefix, 'files': files, 'totals': totals,
            'filesTotal': total, 'truncated': truncated}


def _get_branch_changes(top, prefix, base):
    scope = ['--', prefix.rstrip('/')] if prefix else []
    entries, truncated = branch_entries(top, prefix, base)
    nums, _, ncode = run_git(['diff', base, '--numstat', '-z', '-M', '--no-ext-diff', '--no-textconv', *scope], top)
    stats = parse_numstat(nums) if ncode in (0, 1) or ncode is None else {}
    files = []
    total = 0
    for letter, path, old, untracked in entries:
        total += 1
        if len(files) >= MAX_FILES:
            truncated = True
            continue
        item = {'path': path, 'status': letter, 'added': 0, 'removed': 0, 'binary': False}
        if old:
            item['oldPath'] = old
        if untracked:
            lines, cut_file, binary = read_untracked(top, path)
            item.update(added=len(lines), binary=binary)
            if cut_file:
                item['partial'] = True
        else:
            item['added'], item['removed'], item['binary'] = stats.get(path, (0, 0, False))
        files.append(item)
    totals = {'files': len(files), 'added': sum(f['added'] for f in files), 'removed': sum(f['removed'] for f in files)}
    return {'git': True, 'scope': 'branch', 'root': top, 'prefix': prefix, 'files': files, 'totals': totals,
            'filesTotal': total, 'truncated': truncated}


def parse_hunks(text):
    """Hunks from one file's unified diff text: [{'header': '@@ -1,2 +1,3 @@ ...', 'lines': [' ctx', '+add', '-del', '\\ No newline...']}]."""
    hunks, current = [], None
    for line in text.split('\n'):
        if line.startswith('@@ '):
            current = {'header': line[:300], 'lines': []}
            hunks.append(current)
        elif current is not None and line[:1] in (' ', '+', '-', '\\'):
            current['lines'].append(line.rstrip('\r')[:MAX_LINE_CHARS])
    return hunks


def get_file_diff(cwd, path, base_commit=None):
    """Hunks for one file that is currently reported as changed. Raises ChangesError for unknown or unsafe paths."""
    if not safe_relpath(path):
        raise ChangesError('Not a repository path', 'bad_path')
    found = locate(cwd)
    if not found:
        return {'git': False}
    top, prefix, base = found
    if prefix and not path.startswith(prefix):
        raise ChangesError('That file is outside this folder', 'outside')
    if base_commit and commit_exists(top, base_commit):
        entries = [e for e in branch_entries(top, prefix, base_commit)[0] if e[1] == path]
        if not entries:
            raise ChangesError('That file has no changes in this chat', 'not_changed')
        letter, _, old, untracked = entries[0]
        return _file_diff(top, base_commit, path, letter, old, untracked)
    raw, _, code = run_git(['status', '--porcelain=v1', '-z', '--untracked-files=all', *(['--', prefix.rstrip('/')] if prefix else [])], top)
    entries = [e for e in parse_status(raw) if e[1] == path] if code == 0 else []
    if not entries:
        raise ChangesError('That file has no uncommitted changes', 'not_changed')
    xy, _, old = entries[0]
    return _file_diff(top, base, path, status_letter(xy), old, xy == '??')


def _file_diff(top, base, path, letter, old, untracked):
    result = {'git': True, 'path': path, 'status': letter, 'binary': False, 'truncated': False, 'hunks': [],
              'abs': os.path.normpath(os.path.join(top, *path.split('/')))}
    if old:
        result['oldPath'] = old
    if untracked:
        lines, cut, binary = read_untracked(top, path)
        result.update(binary=binary, truncated=cut)
        if lines:
            result['hunks'] = [{'header': f'@@ -0,0 +1,{len(lines)} @@', 'lines': ['+' + line for line in lines]}]
        result.update(added=len(lines), removed=0)
        return result
    specs = [path] + ([old] if old else [])
    out, cut, code = run_git(['diff', base, '--unified=3', '--no-color', '--no-ext-diff', '--no-textconv', '-M', '--', *specs], top, cap=MAX_DIFF_BYTES)
    text = out.decode('utf-8', 'replace')
    hunks = parse_hunks(text)
    result['hunks'] = hunks
    result['truncated'] = bool(cut)
    if not hunks and ('Binary files' in text or 'GIT binary patch' in text):
        result['binary'] = True
    result['added'] = sum(1 for h in hunks for l in h['lines'] if l.startswith('+'))
    result['removed'] = sum(1 for h in hunks for l in h['lines'] if l.startswith('-'))
    return result
