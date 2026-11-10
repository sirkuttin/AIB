"""Worktree per chat (stage B, settings flag server.worktreePerChat, hidden from the page, on by default).

A new chat in a git project may run in its own git worktree, made under the Studio state folder (never inside the repo):

    <state dir>/worktrees/<repo-hash>/<chat-slug>        branch studio/<chat-slug>, started from a snapshot commit S

S is the project's HEAD plus the user's uncommitted work (tracked edits and untracked, non-ignored files), built with a temporary
index so the user's own index and files are never touched. `.env*` files (usually ignored) are copied over afterwards. A project
that cannot safely get a worktree is used in place, and the reason is logged. Every worktree Studio makes is recorded in
<state dir>/studio-worktrees.json (chat key -> path, branch, base branch, snapshot commit) and only those are ever cleaned up.
"""
import hashlib
import json
import logging
import os
import pathlib
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import time
import uuid

from state_store import FileLock, read_json_file, replace_with_retry

log = logging.getLogger(__name__)
log.addHandler(logging.NullHandler())

MAX_SNAPSHOT_BYTES = 200 * 1024 * 1024   # what the snapshot would add beyond HEAD; more and the chat works in place
MAX_UNTRACKED_FILES = 5000
MAX_REMOVED_NOTES = 500
PENDING = 'removal-pending'   # registry status of a worktree whose removal started (or failed, e.g. a file is in use); retried at startup
GONE_MESSAGE = "This chat's workspace was removed; it can be read but not continued"
SKIP_DIRS = {'node_modules', '.git'}
LFS_MAGIC = b'version https://git-lfs.github.com/spec'
SNAPSHOT_IDENTITY = ['-c', 'user.name=Agent Studio', '-c', 'user.email=studio@localhost', '-c', 'commit.gpgsign=false']

_ACTIVE = set()   # keys being created by this process right now (startup cleanup must not touch them)
_ACTIVE_LOCK = threading.Lock()


class Fallback(Exception):
    """This chat works in place; str(error) says why."""


class WorktreeGone(ValueError):
    """The chat's worktree folder and branch are both gone: it can be read but not continued."""


class GitError(RuntimeError):
    pass


def say(text):
    log.info(text)
    print(text, file=sys.stderr, flush=True)


# ---- git ---------------------------------------------------------------------------------------------------------
def git(args, cwd, env=None, check=True, timeout=600, identity=False, binary=False, input=None):
    environment = {k: v for k, v in os.environ.items() if k not in ('GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR')}
    environment['GIT_OPTIONAL_LOCKS'] = '0'   # read-only commands must not refresh the user's index
    environment['GIT_TERMINAL_PROMPT'] = '0'
    environment.update(env or {})
    command = ['git', '-c', 'core.longpaths=true', *(SNAPSHOT_IDENTITY if identity else []), *args]
    try:
        if binary:   # bytes in, bytes out (file content, and input that must not get Windows line endings)
            done = subprocess.run(command, cwd=str(cwd), capture_output=True, env=environment, input=input, timeout=timeout,
                                  creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        else:
            done = subprocess.run(command, cwd=str(cwd), capture_output=True, text=True, encoding='utf-8', errors='replace', env=environment,
                                  input=input, timeout=timeout, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    except (OSError, subprocess.TimeoutExpired) as error:
        if check:
            raise GitError(f'git {args[0]} failed: {error}')
        return subprocess.CompletedProcess(command, 1, b'' if binary else '', str(error))
    if check and done.returncode != 0:
        detail = done.stderr or done.stdout
        detail = detail.decode('utf-8', 'replace') if isinstance(detail, bytes) else detail
        raise GitError(f'git {" ".join(args[:2])} failed: {detail.strip()[:400]}')
    return done


def _same(a, b):
    try:
        return os.path.normcase(os.path.realpath(str(a))) == os.path.normcase(os.path.realpath(str(b)))
    except (OSError, ValueError):
        return False


def _norm(path):
    try:
        return os.path.normcase(os.path.realpath(str(path)))
    except (OSError, ValueError):
        return os.path.normcase(str(path))


def _fs(path):
    """A path the Python file APIs can open even beyond 260 characters on Windows."""
    text = str(path)
    if os.name == 'nt' and len(text) >= 240 and not text.startswith('\\\\?\\'):
        return '\\\\?\\' + os.path.abspath(text)
    return text


def _rmtree(path):
    def writable(function, target, _excinfo):
        try:
            os.chmod(target, stat.S_IWRITE)
            function(target)
        except OSError:
            pass
    shutil.rmtree(_fs(path), onerror=writable)


# ---- the record --------------------------------------------------------------------------------------------------
class Registry:
    """<state dir>/studio-worktrees.json: {"version":1,"worktrees":{chatKey: {...}}}. Small, rewritten whole and atomically."""
    FILE = 'studio-worktrees.json'

    def __init__(self, state_dir):
        self.state_dir = pathlib.Path(state_dir)
        self.path = self.state_dir / self.FILE
        self.lock = threading.RLock()

    @property
    def root(self):
        return self.state_dir / 'worktrees'

    def _read(self):
        status, raw = read_json_file(self.path)
        raw = raw if status == 'ok' and isinstance(raw, dict) else {}
        items, removed = raw.get('worktrees'), raw.get('removed')
        items = {k: v for k, v in items.items() if isinstance(v, dict)} if isinstance(items, dict) else {}
        removed = {k: v for k, v in removed.items() if isinstance(v, dict)} if isinstance(removed, dict) else {}
        return items, removed

    def _load(self):
        return self._read()[0]

    def _save(self, items, removed=None):
        if removed is None:
            removed = self._read()[1]
        self.state_dir.mkdir(parents=True, exist_ok=True)
        handle, temporary = tempfile.mkstemp(prefix='.studio-worktrees-', suffix='.tmp', dir=self.state_dir)
        try:
            with os.fdopen(handle, 'w', encoding='utf-8') as stream:
                payload = {'version': 1, 'worktrees': items}
                if removed:
                    payload['removed'] = removed
                json.dump(payload, stream, ensure_ascii=False, separators=(',', ':'))
            replace_with_retry(temporary, self.path)
        except BaseException:
            try:
                os.unlink(temporary)
            except OSError:
                pass
            raise

    def removed(self):
        """Worktrees Studio removed on purpose: {normalised path: {project, branch, base}}. Only so the chat can say "workspace removed"
        and stay under its project; nothing here points at a folder."""
        with self.lock:
            return self._read()[1]

    def finish_removal(self, key):
        """The worktree and branch are gone: drop the record and leave a small note of where it was."""
        with self.lock:
            items, removed = self._read()
            record = items.pop(key, None)
            if record and record.get('path'):
                removed[_norm(record['path'])] = {'project': record.get('project', ''), 'branch': record.get('branch', ''), 'base': record.get('base', ''),
                                                  'session': record.get('session', ''), 'time': time.time()}
                for old in sorted(removed, key=lambda k: removed[k].get('time', 0))[:-MAX_REMOVED_NOTES]:
                    removed.pop(old, None)
            self._save(items, removed)

    def all(self):
        with self.lock:
            return self._load()

    def get(self, key):
        return self.all().get(key)

    def put(self, key, record):
        with self.lock:
            items = self._load()
            items[key] = record
            self._save(items)

    def update(self, key, **fields):
        with self.lock:
            items = self._load()
            if key in items:
                items[key] = dict(items[key], **fields)
                self._save(items)

    def remove(self, key):
        with self.lock:
            items = self._load()
            if items.pop(key, None) is not None:
                self._save(items)

    def find(self, path=None, session=None):
        """The record for a worktree path, else the only record of a saved session ('provider:sessionId'). Only finished ones."""
        items = {k: v for k, v in self.all().items() if v.get('status') == 'ready'}
        if path is not None:
            for key, record in items.items():
                if _same(record.get('path', ''), path):
                    return dict(record, key=key)
        if session:
            hits = [(k, v) for k, v in items.items() if v.get('session') == session]
            if len(hits) == 1:
                return dict(hits[0][1], key=hits[0][0])
        return None


def diff_base(record):
    """The commit a worktree chat's "branch" view compares against: the user base U (stage G1: S at the start, then the project's
    saved edits copied in by live sync). The registry field diffBase always equals U; the snapshot S is the fallback for old records. Never the moving base tip."""
    if not isinstance(record, dict):
        return ''
    return record.get('diffBase') or record.get('user') or record.get('snapshot') or ''


def user_ref(record):
    """refs/studio/<slug>/user: pins the user base U so `git gc` never prunes it ('' for a record without a studio/ branch)."""
    branch = record.get('branch', '') if isinstance(record, dict) else ''
    return f'refs/studio/{branch[len("studio/"):]}/user' if branch.startswith('studio/') and len(branch) > len('studio/') else ''


def pin_user_base(project, record, commit):
    ref = user_ref(record)
    if ref and commit:
        git(['update-ref', ref, commit], project)


def unpin_user_base(project, record):
    ref = user_ref(record)
    if ref and project:
        git(['update-ref', '-d', ref], project, check=False)


def record_for_path(state_dir, path):
    """The finished registry record of the Studio worktree at `path` (with its key), or None. Read only."""
    if not state_dir or not path:
        return None
    return Registry(state_dir).find(path=path)


def _read(path, limit=4096):
    try:
        with open(_fs(path), 'rb') as handle:
            return handle.read(limit).decode('utf-8', 'replace').strip()
    except OSError:
        return ''


def main_checkout_of(path):
    """For a linked worktree folder: (main checkout folder, branch) read from its .git file, gitdir and commondir; None otherwise.
    No subprocess."""
    marker = os.path.join(str(path), '.git')
    if not os.path.isfile(_fs(marker)):
        return None
    text = _read(marker)
    if not text.startswith('gitdir:'):
        return None
    gitdir = text[len('gitdir:'):].strip()
    if not os.path.isabs(gitdir):
        gitdir = os.path.join(str(path), gitdir)
    gitdir = os.path.normpath(gitdir)
    if not os.path.isdir(_fs(gitdir)) or os.path.basename(os.path.dirname(gitdir)) != 'worktrees':
        return None   # a gitdir that is missing or is not a <repo>/.git/worktrees/<name> folder (a submodule, say) is ignored
    common = _read(os.path.join(gitdir, 'commondir'))
    if common:
        common = os.path.normpath(common if os.path.isabs(common) else os.path.join(gitdir, common))
    else:
        parent = os.path.dirname(gitdir)
        if os.path.basename(parent) != 'worktrees':
            return None
        common = os.path.dirname(parent)
    if os.path.basename(common) != '.git' or not os.path.isdir(_fs(common)) or not _same(os.path.dirname(os.path.dirname(gitdir)), common):
        return None
    head = _read(os.path.join(gitdir, 'HEAD'))
    branch = head[len('ref: refs/heads/'):] if head.startswith('ref: refs/heads/') else head[:7]
    return os.path.dirname(common), branch


_PATTERN = re.compile(r'^(.+?)[\\/]\.claude[\\/]worktrees[\\/][^\\/]+(?:[\\/].*)?$', re.IGNORECASE)
_WT_CACHE = {}   # cwd -> (project, branch, relative location inside the worktree) or None
KNOWN_PROJECTS = []   # a callable returning the folders Studio knows as projects; set by studio.create_server


def _worktree_root(cwd):
    """(worktree top folder, main checkout, branch) for a cwd inside a linked git worktree; None. Reads files only."""
    folder = pathlib.Path(cwd)
    for candidate in [folder, *list(folder.parents)[:12]]:
        marker = candidate / '.git'
        if os.path.isdir(_fs(marker)):
            return None   # an ordinary checkout
        if os.path.isfile(_fs(marker)):
            found = main_checkout_of(candidate)
            return (candidate, found[0], found[1]) if found else None
    return None


def _cached_lookup(cwd):
    if cwd in _WT_CACHE:
        return _WT_CACHE[cwd]
    result = None
    exists = False
    try:
        exists = os.path.exists(_fs(cwd))
        if exists:
            found = _worktree_root(cwd)
            if found:
                top, main, branch = found
                rel = os.path.relpath(os.path.normpath(cwd), str(top))
                result = (os.path.normpath(main), branch, '' if rel == '.' else rel)
        else:
            match = _PATTERN.match(cwd)
            if match:
                result = (match.group(1), '', '')
    except (OSError, ValueError):
        result = None
    if result is None and not exists:
        return None   # not cached: a worktree folder Studio is about to create must be found once it exists
    if len(_WT_CACHE) > 5000:
        _WT_CACHE.clear()
    _WT_CACHE[cwd] = result
    return result


def project_of_worktree(cwd):
    """{'project', 'branch', 'base'} when cwd lies in a git worktree made by any app (the main checkout is the project; a known
    Studio project folder inside the repo that holds the worktree's relative location wins); None for anything else. Cached per cwd."""
    if not cwd or not isinstance(cwd, str):
        return None
    found = _cached_lookup(cwd)
    if not found:
        return None
    project, branch, rel = found
    if rel:
        try:
            relative = os.path.normcase(rel).replace('\\', '/')
            best, chosen = '', None
            for known in (KNOWN_PROJECTS() if callable(KNOWN_PROJECTS) else []):
                inner = os.path.normcase(os.path.relpath(known, project)).replace('\\', '/')
                if inner not in ('.', '') and not inner.startswith('..') and not os.path.isabs(inner) \
                        and (relative == inner or relative.startswith(inner + '/')) and len(inner) > len(best):
                    best, chosen = inner, known
            if chosen:
                project = os.path.normpath(chosen)
        except (ValueError, OSError, TypeError):
            pass
    return {'project': project, 'branch': branch, 'base': ''}


class ProjectResolver:
    """cwd -> {'project', 'branch', 'base'} when `cwd` is a worktree Studio made (registry entry, else a folder under
    <state dir>/worktrees whose .git points at a main checkout), else None. Used for saved chats, which only know their cwd."""

    def __init__(self, state_dir):
        self.state_dir = pathlib.Path(state_dir)
        self.registry = Registry(state_dir)
        self._sig = None
        self._records = []

    def _all(self):
        try:
            stat = os.stat(self.registry.path)
            sig = (stat.st_mtime_ns, stat.st_size)
        except OSError:
            sig = None
        if sig != self._sig:
            self._records = list(self.registry.all().values())
            self._sig = sig
        return self._records

    def __call__(self, cwd):
        if not cwd or not isinstance(cwd, str):
            return None
        for record in self._all():
            if record.get('path') and record.get('project') and _same(record['path'], cwd):
                return {'project': record['project'], 'branch': record.get('branch', ''), 'base': record.get('base', '')}
        root = os.path.normcase(os.path.realpath(str(self.registry.root)))
        here = os.path.normcase(os.path.realpath(cwd))
        gone = self.registry.removed().get(here)   # a worktree Studio removed: the chat stays under its project
        if gone and gone.get('project'):
            return {'project': gone['project'], 'branch': gone.get('branch', ''), 'base': gone.get('base', '')}
        return project_of_worktree(cwd)


# ---- deciding ----------------------------------------------------------------------------------------------------
class Plan:
    def __init__(self, project, base, key, slug, branch, path):
        self.project, self.base, self.key, self.slug, self.branch, self.path = str(project), base, key, slug, branch, str(path)


def repo_hash(project):
    return hashlib.sha1(os.path.normcase(os.path.realpath(str(project))).encode('utf-8')).hexdigest()[:10]


def why_in_place(project):
    """'' when the project can get a worktree, else the reason it is used in place. Cheap: a few read-only git calls."""
    project = pathlib.Path(project)
    if shutil.which('git') is None:
        return 'git is not installed'
    bare = git(['rev-parse', '--is-bare-repository'], project, check=False)
    if bare.returncode != 0:
        return 'not a git repository'
    if bare.stdout.strip() == 'true':
        return 'bare repository'
    top = git(['rev-parse', '--show-toplevel'], project, check=False)
    if top.returncode != 0 or not _same(top.stdout.strip(), project):
        return 'the folder is not the root of its git repository'
    gitdir = pathlib.Path(git(['rev-parse', '--absolute-git-dir'], project).stdout.strip())
    for name, label in (('MERGE_HEAD', 'a merge'), ('rebase-merge', 'a rebase'), ('rebase-apply', 'a rebase'), ('CHERRY_PICK_HEAD', 'a cherry-pick'), ('REVERT_HEAD', 'a revert')):
        if (gitdir / name).exists():
            return f'{label} is in progress'
    if git(['symbolic-ref', '-q', 'HEAD'], project, check=False).returncode != 0:
        return 'detached HEAD'
    if git(['rev-parse', '--verify', '-q', 'HEAD'], project, check=False).returncode != 0:
        return 'the repository has no commits yet'
    if (project / '.gitmodules').exists():
        return 'the repository has submodules'
    return ''


def snapshot_size(project):
    """(untracked file count, bytes the snapshot adds beyond HEAD: untracked files and tracked files that differ from HEAD)."""
    untracked = [n for n in git(['ls-files', '-o', '--exclude-standard', '-z'], project).stdout.split('\0') if n]
    changed = [n for n in git(['diff', '--name-only', '-z', 'HEAD'], project).stdout.split('\0') if n]
    total = 0
    for name in untracked + changed:
        try:
            total += os.lstat(_fs(pathlib.Path(project) / name)).st_size
        except OSError:
            pass
    return len(untracked), total


# ---- making one --------------------------------------------------------------------------------------------------
def snapshot_commit(project, scratch):
    """The commit S: HEAD plus the working tree, built in a temporary index. The project's own index and files are not touched."""
    env = {'GIT_INDEX_FILE': str(pathlib.Path(scratch) / 'snapshot-index')}
    git(['read-tree', 'HEAD'], project, env=env)
    git(['add', '-A'], project, env=env)
    tree = git(['write-tree'], project, env=env).stdout.strip()
    return git(['commit-tree', tree, '-p', 'HEAD', '-m', 'Studio snapshot'], project, env=env, identity=True).stdout.strip()


# ---- the user base U (stage G1) ----------------------------------------------------------------------------------
def git_dir_of(cwd):
    return pathlib.Path(git(['rev-parse', '--absolute-git-dir'], cwd).stdout.strip())


def _safe_relative(path):
    """The forward-slash relative form of a project path, or '' when it is not a plain path inside the project."""
    text = str(path or '').replace('\\', '/')
    parts = text.split('/')
    if not text or text.startswith('/') or ':' in parts[0] or any(p in ('', '.', '..') for p in parts) or parts[0].lower() == '.git':
        return ''
    return text


def advance_user_base(record, paths, registry=None):
    """A new user base U from the previous U plus the current content of `paths` (relative names) in the project folder: files that exist
    are added or replaced, files that are gone are removed. Built in a temporary index, so neither the project's index nor its files are
    touched. U is pinned by refs/studio/<slug>/user and recorded (user, diffBase, userHead) when `registry` and record['key'] are given.
    Returns the new U (the previous one when nothing differs)."""
    project = record['project']
    previous = record.get('user') or record.get('snapshot')
    if not previous:
        raise GitError('This worktree has no user base to advance')
    names = []
    for path in paths or []:
        name = _safe_relative(path)
        if name and name not in names:
            names.append(name)
    scratch = tempfile.mkdtemp(prefix='.studio-user-', dir=str(git_dir_of(project)))
    try:
        env = {'GIT_INDEX_FILE': os.path.join(scratch, 'index')}
        git(['read-tree', previous], project, env=env)
        modes = {}
        if names:
            for line in git(['ls-files', '-s', '-z', '--', *names], project, env=env).stdout.split('\0'):
                meta, _, name = line.partition('\t')
                if name:
                    modes[name] = meta.split(' ')[0]
        lines = []
        for name in names:
            full = pathlib.Path(project) / name
            if os.path.islink(_fs(full)):
                sha = git(['hash-object', '-w', '--stdin'], project, binary=True, input=os.readlink(_fs(full)).encode('utf-8')).stdout.decode().strip()
                lines.append(f'120000 {sha}\t{name}\n')
            elif os.path.isfile(_fs(full)):
                sha = git(['hash-object', '-w', f'--path={name}', '--', str(full)], project).stdout.strip()
                mode = modes.get(name) or ('100755' if os.name != 'nt' and os.stat(_fs(full)).st_mode & 0o111 else '100644')
                lines.append(f'{mode} {sha}\t{name}\n')
            elif not os.path.isdir(_fs(full)):
                lines.append('0 ' + '0' * 40 + f'\t{name}\n')
        if lines:
            git(['update-index', '--index-info'], project, env=env, binary=True, input=''.join(lines).encode('utf-8'))
        tree = git(['write-tree'], project, env=env).stdout.strip()
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
    result = previous
    if tree != git(['rev-parse', previous + '^{tree}'], project).stdout.strip():
        result = git(['commit-tree', tree, '-p', previous, '-m', 'Studio: user edits'], project, identity=True).stdout.strip()
    pin_user_base(project, record, result)
    if registry is not None and record.get('key'):
        head = git(['rev-parse', '--verify', '-q', 'HEAD'], project, check=False).stdout.strip()
        registry.update(record['key'], user=result, diffBase=result, userHead=head)
    return result


# ---- locks across processes (stage G1): the web process, the host, and later the live sync all use these ----------
def _lock_file(state_dir, name):
    return pathlib.Path(state_dir) / 'locks' / name


def pause_lock(state_dir, project, timeout=None):
    """The project-level "sync paused" flag. Merge holds it from stash to unstash; live sync must not copy anything into a worktree
    while another process holds it (see sync_paused)."""
    return FileLock(_lock_file(state_dir, f'sync-paused-{repo_hash(project)}.lock'), timeout)


def worktree_lock(state_dir, record, timeout=None):
    """One lock per worktree: Merge holds it while it commits, lands and resets the worktree; live sync takes it to write into it."""
    slug = (record.get('branch') or record.get('path') or 'worktree').replace('\\', '/').rstrip('/').split('/')[-1]
    return FileLock(_lock_file(state_dir, f'worktree-{repo_hash(record.get("project") or "")}-{slug}.lock'), timeout)


def sync_paused(state_dir, project):
    """True when another holder (any process) has the project's pause flag right now. Takes and drops the lock at once."""
    lock = pause_lock(state_dir, project, timeout=0)
    try:
        lock.acquire()
    except OSError:
        return True
    lock.release()
    return False


# ---- comparing a file with a blob without CRLF noise (stage G1) --------------------------------------------------
def file_matches_blob(cwd, path, blob):
    """True when the file `path` (relative to `cwd`) is the same as git blob `blob`, as git itself would store it. Core.autocrlf=true
    turns LF blobs into CRLF files on checkout: the file is hashed with its clean filters (`hash-object --path`), and also compared with
    the blob as a checkout would write it (`cat-file --filters --path`). An empty `blob` means "the file does not exist"."""
    full = pathlib.Path(cwd) / path
    if not os.path.lexists(_fs(full)):
        return not blob
    if not blob or os.path.islink(_fs(full)) or not os.path.isfile(_fs(full)):
        return False
    if git(['hash-object', f'--path={path}', '--', str(full)], cwd, check=False).stdout.strip() == blob:
        return True
    smudged = git(['cat-file', '--filters', f'--path={path}', blob], cwd, check=False, binary=True)
    if smudged.returncode != 0:
        return False
    try:
        with open(_fs(full), 'rb') as handle:
            return handle.read() == smudged.stdout
    except OSError:
        return False


def touched_paths(cwd, base):
    """Paths whose working-tree content differs from commit `base` (changed, deleted, or new and not ignored), CRLF-safe: files git lists
    as different only because of line-ending conversion are not touched. Raises GitError when git cannot tell."""
    names = [n for n in git(['diff', '--name-only', '-z', '--no-renames', base, '--'], cwd).stdout.split('\0') if n]
    touched = []
    for name in names:
        blob = git(['rev-parse', '--verify', '-q', f'{base}:{name}'], cwd, check=False).stdout.strip()
        if not file_matches_blob(cwd, name, blob):
            touched.append(name)
    touched += [n for n in git(['ls-files', '-o', '--exclude-standard', '-z'], cwd).stdout.split('\0') if n and n not in touched]
    return touched


def copy_env_files(project, target):
    """Copy .env* files at the same relative paths; skip symlinks, node_modules and .git; never overwrite."""
    project = pathlib.Path(project)
    for folder, dirs, files in os.walk(_fs(project)):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not os.path.islink(os.path.join(folder, d))]
        for name in files:
            if not name.startswith('.env'):
                continue
            source = os.path.join(folder, name)
            if os.path.islink(source) or not os.path.isfile(source):
                continue
            relative = os.path.relpath(source, _fs(project))
            destination = os.path.join(_fs(target), relative)
            if os.path.lexists(destination):
                continue
            try:
                os.makedirs(os.path.dirname(destination), exist_ok=True)
                shutil.copy2(source, destination)
            except OSError:
                log.warning('Could not copy %s into the worktree', relative, exc_info=True)


def has_lfs_pointers(path):
    """True when the worktree holds Git LFS pointer files instead of the real content (git-lfs was not there to fetch it)."""
    attributes = git(['grep', '-l', '-e', 'filter=lfs', '--', '.gitattributes', '*.gitattributes'], path, check=False)
    if attributes.returncode != 0:
        return False
    names = [n for n in git(['ls-files', '-z'], path).stdout.split('\0') if n]
    if not names:
        return False
    process = subprocess.run(['git', 'check-attr', '-z', 'filter', '--stdin'], cwd=str(path), input='\0'.join(names) + '\0', capture_output=True, text=True,
                             encoding='utf-8', errors='replace', creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    parts = process.stdout.split('\0')
    for index in range(0, len(parts) - 2, 3):
        if parts[index + 2] != 'lfs':
            continue
        try:
            with open(_fs(pathlib.Path(path) / parts[index]), 'rb') as stream:
                if stream.read(len(LFS_MAGIC)) == LFS_MAGIC:
                    return True
        except OSError:
            continue
    return False


class Manager:
    def __init__(self, state_dir):
        self.registry = Registry(state_dir)

    # -- deciding
    def plan(self, project, key=None):
        """A Plan for a new chat in `project`, or None (the chat works in place; the reason is logged)."""
        project = pathlib.Path(project)
        try:
            reason = why_in_place(project)
        except (GitError, OSError) as error:
            reason = f'git could not be read: {error}'
        if reason:
            say(f'Worktree: {project} works in place: {reason}')
            return None
        key = key or uuid.uuid4().hex
        base = git(['symbolic-ref', '--short', 'HEAD'], project).stdout.strip()
        folder = self.registry.root / repo_hash(project)
        number = 0
        while True:
            slug = f'chat-{key[:8]}' + (f'-{number}' if number else '')
            branch = f'studio/{slug}'
            taken = git(['show-ref', '--verify', '--quiet', f'refs/heads/{branch}'], project, check=False).returncode == 0 or os.path.lexists(_fs(folder / slug))
            if not taken:
                return Plan(project, base, key, slug, branch, folder / slug)
            number += 1

    # -- creating (runs in the background)
    def create(self, plan):
        """Make the worktree of `plan`. Raises Fallback(reason) when the chat must work in place; whatever was made is removed first.
        A crash (the process dying) leaves a 'creating' record that cleanup_incomplete() removes at the next start."""
        record = {'path': plan.path, 'project': plan.project, 'branch': plan.branch, 'base': plan.base, 'snapshot': '', 'status': 'creating', 'pid': os.getpid(), 'created': time.time()}
        with _ACTIVE_LOCK:
            _ACTIVE.add(plan.key)
        try:
            self.registry.put(plan.key, record)
            try:
                untracked, size = snapshot_size(plan.project)
                if untracked > MAX_UNTRACKED_FILES or size > MAX_SNAPSHOT_BYTES:
                    raise Fallback(f'too much uncommitted work to copy ({untracked} untracked files, {size // (1024 * 1024)} MB)')
                self.registry.root.mkdir(parents=True, exist_ok=True)
                scratch = tempfile.mkdtemp(prefix='.snapshot-', dir=self.registry.root)
                try:
                    snapshot = snapshot_commit(plan.project, scratch)
                finally:
                    shutil.rmtree(scratch, ignore_errors=True)
                record['snapshot'] = snapshot
                head = git(['rev-parse', 'HEAD'], plan.project).stdout.strip()
                pin_user_base(plan.project, {'branch': plan.branch}, snapshot)   # U = S at the start; the ref keeps it from `git gc`
                self.registry.update(plan.key, snapshot=snapshot, user=snapshot, userHead=head)
                os.makedirs(_fs(pathlib.Path(plan.path).parent), exist_ok=True)
                git(['worktree', 'add', '-b', plan.branch, plan.path, snapshot], plan.project)
                copy_env_files(plan.project, plan.path)
                if has_lfs_pointers(plan.path):
                    raise Fallback('the worktree would hold Git LFS pointer files')
            except Fallback as reason:
                self._discard(record)
                self.registry.remove(plan.key)
                say(f'Worktree: {plan.project} works in place: {reason}')
                raise
            except Exception as error:
                log.exception('Making the worktree failed')
                self._discard(record)
                self.registry.remove(plan.key)
                say(f'Worktree: {plan.project} works in place: could not make the worktree ({error})')
                raise Fallback(f'could not make the worktree: {error}')
            self.registry.update(plan.key, status='ready')
        finally:
            with _ACTIVE_LOCK:
                _ACTIVE.discard(plan.key)

    def _discard(self, record):
        """Remove a worktree Studio made, its branch and its git registration. Refuses anything outside Studio's own worktrees folder."""
        path, project, branch = record.get('path', ''), record.get('project', ''), record.get('branch', '')
        root = os.path.normcase(os.path.realpath(str(self.registry.root)))
        inside = path and os.path.normcase(os.path.realpath(path)).startswith(root + os.sep)
        if not inside:
            log.warning('Not removing %s: it is not under Studio\'s worktrees folder', path)
            return
        project_ok = project and pathlib.Path(project).is_dir()
        if project_ok:
            git(['worktree', 'remove', '--force', path], project, check=False)
        if os.path.lexists(_fs(path)):
            _rmtree(path)
        if project_ok:
            git(['worktree', 'prune'], project, check=False)
            if branch.startswith('studio/'):
                git(['branch', '-D', branch], project, check=False)
            unpin_user_base(project, record)

    def discard(self, key):
        record = self.registry.get(key)
        if record:
            self._discard(record)
            self.registry.remove(key)

    def set_session(self, key, provider, session_id):
        if self.registry.get(key):
            self.registry.update(key, session=f'{provider}:{session_id}')

    def cleanup_incomplete(self):
        """At startup: remove worktrees a previous process died in the middle of making. Returns the keys cleaned."""
        done = []
        for key, record in self.registry.all().items():
            if record.get('status') != 'creating':
                continue
            with _ACTIVE_LOCK:
                if key in _ACTIVE:
                    continue
            pid = record.get('pid')
            if pid != os.getpid() and _pid_alive(pid):
                continue   # another running Studio is making it
            self._discard(record)
            self.registry.remove(key)
            done.append(key)
            say(f'Worktree: removed a half-made worktree of an earlier run: {record.get("path")}')
        return done

    # -- removing
    def has_changes(self, record):
        """True when the worktree differs from its diff base (committed, edited or new files) or that cannot be told: then nothing is removed
        without the user's say. A missing folder has no changes to lose."""
        path, base = record.get('path', ''), diff_base(record)
        if not os.path.isdir(_fs(path)):
            return False
        if not base or git(['cat-file', '-e', base + '^{commit}'], path, check=False).returncode != 0:
            return True
        try:
            return bool(touched_paths(path, base))   # against U, ignoring line-ending noise
        except GitError:
            return True

    def _inside_root(self, path):
        root = _norm(self.registry.root)
        return bool(path) and _norm(path).startswith(root + os.sep)

    def _attempt_removal(self, record, force):
        """One try at removing a worktree: `git worktree remove` (with --force only when `force`), then its branch. True when both are gone.
        Never touches a folder outside Studio's own worktrees folder."""
        path, project, branch = record.get('path', ''), record.get('project', ''), record.get('branch', '')
        if not self._inside_root(path):
            log.warning('Not removing %s: it is not under the Studio worktrees folder', path)
            return True   # nothing of Studio's to remove; do not keep a record forever
        project_ok = bool(project) and pathlib.Path(project).is_dir() and git(['rev-parse', '--git-dir'], project, check=False).returncode == 0
        if os.path.lexists(_fs(path)):
            if project_ok:
                git(['worktree', 'remove', *(['--force'] if force else []), path], project, check=False)
            if force and os.path.lexists(_fs(path)):
                try:
                    _rmtree(path)   # the user confirmed discarding: what git left behind (files it could not delete) goes too
                except OSError:
                    pass
            if os.path.lexists(_fs(path)):
                return False   # in use (Windows) or git refused: pending
        if project_ok:
            git(['worktree', 'prune'], project, check=False)
            if branch.startswith('studio/') and git(['show-ref', '--verify', '--quiet', f'refs/heads/{branch}'], project, check=False).returncode == 0:
                if git(['branch', '-D', branch], project, check=False).returncode != 0:
                    return False
            unpin_user_base(project, record)
        return True

    def remove(self, key, confirmed=False):
        """Remove a chat's worktree, its branch and its registry entry. `confirmed` is the user's yes to discarding it (Discard): only then
        is --force used. Returns 'removed', 'pending' (marked "removal pending": something is in use, retried at the next start) or 'gone'
        (no such record). The record is marked pending first, so a crash half-way is retried too and the registry never points at nothing."""
        record = self.registry.get(key)
        if not record:
            return 'gone'
        self.registry.update(key, status=PENDING, confirmed=bool(confirmed) or bool(record.get('confirmed')))
        try:
            done = self._attempt_removal(record, bool(confirmed))
        except Exception:
            log.exception('Removing the worktree %s failed', record.get('path'))
            done = False
        if done:
            self.registry.finish_removal(key)
            say(f'Worktree: removed {record.get("path")} and {record.get("branch")}')
            return 'removed'
        say(f'Worktree: {record.get("path")} is in use; removal is pending and retried at the next start')
        return 'pending'

    def retry_pending(self):
        """At startup: finish removals that were pending (a file was in use, or Studio stopped half-way), then `git worktree prune` for every
        project Studio keeps worktrees of. Returns the keys finished."""
        done, projects = [], set()
        for key, record in self.registry.all().items():
            if record.get('project'):
                projects.add(record['project'])
            if record.get('status') != PENDING:
                continue
            try:
                finished = self._attempt_removal(record, bool(record.get('confirmed')))
            except Exception:
                log.exception('Retrying the removal of %s failed', record.get('path'))
                finished = False
            if finished:
                self.registry.finish_removal(key)
                done.append(key)
                say(f'Worktree: finished removing {record.get("path")}')
        for project in projects:
            if pathlib.Path(project).is_dir():
                git(['worktree', 'prune'], project, check=False)
        return done

    def is_removed(self, workspace, session=None):
        """True when `workspace` (or the saved chat `session`, 'provider:sessionId', whatever folder it is opened from) belongs to a Studio
        worktree that was removed or is being removed: that chat can be read but not continued."""
        here = _norm(workspace)
        removed = self.registry.removed()
        if session and any(r.get('session') == session for r in removed.values()):
            return True
        if session and any(r.get('session') == session and r.get('status') == PENDING for r in self.registry.all().values()):
            return True
        if not self._inside_root(workspace):
            return False
        if here in removed:
            return True
        return any(_norm(r.get('path', '')) == here and r.get('status') == PENDING for r in self.registry.all().values())

    # -- resuming
    def for_chat(self, provider, session_id, workspace):
        return self.registry.find(path=workspace, session=f'{provider}:{session_id}' if session_id else None)

    def ensure(self, record):
        """The folder of a recorded worktree, made again from its branch when it was deleted outside Studio.
        Raises WorktreeGone (the chat can be read but not continued) when the branch is gone as well. Never returns another folder."""
        path, project, branch = record['path'], record['project'], record['branch']
        if os.path.isdir(_fs(path)):
            return path
        if not (project and pathlib.Path(project).is_dir()) or git(['rev-parse', '--git-dir'], project, check=False).returncode != 0:
            raise WorktreeGone(GONE_MESSAGE)
        git(['worktree', 'prune'], project, check=False)   # forget the registration of the deleted folder
        if git(['show-ref', '--verify', '--quiet', f'refs/heads/{branch}'], project, check=False).returncode != 0:
            raise WorktreeGone(GONE_MESSAGE)
        os.makedirs(_fs(pathlib.Path(path).parent), exist_ok=True)
        try:
            git(['worktree', 'add', path, branch], project)
        except GitError as error:
            raise WorktreeGone(f'{GONE_MESSAGE} ({error})')
        copy_env_files(project, path)
        say(f'Worktree: recreated {path} from {branch}')
        return path


def _pid_alive(pid):
    import host_client
    return host_client.pid_alive(pid)
