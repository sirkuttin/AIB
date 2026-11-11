"""Where Agent Studio keeps its data, and who may touch it.

Per-user folder (owner-only):
    Windows  %LOCALAPPDATA%\\AgentStudio
    macOS    ~/Library/Application Support/AgentStudio
    Linux    $XDG_STATE_HOME/agent-studio, else ~/.local/state/agent-studio

Which folder a run uses, first match wins:
    1. --state-dir PATH
    2. environment variable AGENT_STUDIO_STATE_DIR
    3. default: a git WORKTREE keeps the old folder next to its code (<repo>/work/agent-studio-state, as before);
       anything else (the main checkout, later the installed app) uses the per-user folder.

How a checkout counts as "main": walk up from the code folder to the first ".git". A ".git" that is a FILE means a worktree
(or submodule); a path containing .claude/worktrees or .git/worktrees is a worktree whatever its .git looks like. Only a
".git" that is a DIRECTORY (the main checkout), or no ".git" at all (an installed copy), counts as main.

Tests and the demo never reach the real per-user folder. With AGENT_STUDIO_TEST=1 (or when unittest/pytest is loaded)
resolving it raises RealFolderBlocked. work/_isolation.py sets that variable and a temp AGENT_STUDIO_STATE_DIR for tests.

The per-user folder is created owner-only and a Studio refuses to start if Users, Everyone or Authenticated Users can write
to it (Windows: the DACL is read with GetNamedSecurityInfoW and compared by SID, never by localized icacls text; POSIX: mode
0700 and no group/other write). A folder chosen with --state-dir or the environment only produces a warning.

Moving the old data into the per-user folder is migrate.py; prepare() decides when to try it.

Packaged parent apps (Windows). The Claude desktop app is a packaged (MSIX) app, and Windows virtualizes %LOCALAPPDATA% writes
of every process it starts, so a Studio started from a Claude session keeps its "AgentStudio" folder inside
%LOCALAPPDATA%\\Packages\\Claude_*\\LocalCache\\Local, which Windows deletes when that app is reset or uninstalled. package_context()
detects that; adopt_sandbox_copy() moves such a copy to the real folder when Studio runs outside the package (docs/DESKTOP.md).
"""
import os
import pathlib
import subprocess
import sys
import uuid

import app_paths
from app_paths import APP_ROOT

APP_DIR_WINDOWS = 'AgentStudio'
APP_DIR_POSIX = 'agent-studio'
ENV_STATE_DIR = 'AGENT_STUDIO_STATE_DIR'
ENV_TEST = 'AGENT_STUDIO_TEST'
MIGRATED_MARKER = '.migrated'

# Well-known SIDs (locale independent).
SID_EVERYONE, SID_AUTH_USERS, SID_USERS = 'S-1-1-0', 'S-1-5-11', 'S-1-5-32-545'
SID_SYSTEM, SID_ADMINS, SID_CREATOR_OWNER = 'S-1-5-18', 'S-1-5-32-544', 'S-1-3-0'
WIDE_GROUPS = {SID_EVERYONE: 'Everyone', SID_AUTH_USERS: 'Authenticated Users', SID_USERS: 'Users'}
# FILE_WRITE_DATA, FILE_APPEND_DATA, FILE_WRITE_EA, FILE_DELETE_CHILD, FILE_WRITE_ATTRIBUTES, DELETE, WRITE_DAC, WRITE_OWNER, GENERIC_ALL, GENERIC_WRITE
WRITE_MASK = 0x2 | 0x4 | 0x10 | 0x40 | 0x100 | 0x10000 | 0x40000 | 0x80000 | 0x10000000 | 0x40000000


class StateDirError(RuntimeError):
    pass


class RealFolderBlocked(StateDirError):
    """A test or demo tried to use the real per-user folder."""


class StateDirInsecure(StateDirError):
    """The per-user folder can be written by someone other than its owner."""


# ---- locations ---------------------------------------------------------------------------------
def user_state_dir(env=None, platform=None, home=None):
    """The per-user folder for this OS. Pure: no test guard, no I/O (use real_user_state_dir() to get the guarded one)."""
    env = os.environ if env is None else env
    platform = platform or sys.platform
    home = pathlib.Path(home) if home else pathlib.Path.home()
    if platform.startswith('win'):
        base = env.get('LOCALAPPDATA') or str(home / 'AppData' / 'Local')
        return pathlib.Path(base) / APP_DIR_WINDOWS
    if platform == 'darwin':
        return home / 'Library' / 'Application Support' / APP_DIR_WINDOWS
    base = env.get('XDG_STATE_HOME') or str(home / '.local' / 'state')
    return pathlib.Path(base) / APP_DIR_POSIX


def under_test(env=None):
    env = os.environ if env is None else env
    return env.get(ENV_TEST) == '1' or 'pytest' in sys.modules or 'unittest' in sys.modules


def real_user_state_dir(env=None, platform=None, home=None):
    """user_state_dir(), but raises RealFolderBlocked under tests when that is the REAL folder of this machine and user
    (a fake env/home, as the tests of this module pass, is fine)."""
    path = user_state_dir(env, platform, home)
    if under_test(env) and same_path(path, user_state_dir()):
        raise RealFolderBlocked('Refusing to resolve the real per-user AIB folder while running tests '
                                f'({ENV_TEST}=1 or unittest/pytest is loaded). Pass --state-dir or set {ENV_STATE_DIR} to a temp folder.')
    return path


def _key(path):
    return os.path.normcase(os.path.abspath(str(path)))


def same_path(a, b):
    try:
        return os.path.normcase(os.path.realpath(str(a))) == os.path.normcase(os.path.realpath(str(b)))
    except (OSError, ValueError):
        return _key(a) == _key(b)


def repo_root(code_root):
    """Studio's code lives in <repo>/outputs/agent-studio (private repo) or <repo>/aib (public repo)."""
    return app_paths.repo_root(code_root)


def old_default_dir(code_root):
    return app_paths.tests_dir(code_root) / 'agent-studio-state'


def is_worktree_checkout(code_root):
    """True for a git worktree (see the module docstring). A folder with no .git anywhere above it (an installed copy) is not one."""
    path = pathlib.Path(code_root).resolve()
    text = '/' + str(path).replace('\\', '/').lower().strip('/') + '/'
    if '/.claude/worktrees/' in text or '/.git/worktrees/' in text:
        return True
    for folder in [path, *list(path.parents)[:6]]:
        git = folder / '.git'
        if git.is_file():
            return True
        if git.is_dir():
            return False
    return False


class Resolved:
    def __init__(self, path, source, is_user_folder):
        self.path, self.source, self.is_user_folder = pathlib.Path(path), source, is_user_folder

    def __repr__(self):
        return f'Resolved({str(self.path)!r}, {self.source!r}, user={self.is_user_folder})'


def resolve(cli_state_dir=None, env=None, code_root=None, platform=None, home=None):
    """Pick the state folder. Raises RealFolderBlocked when a test would end up on the real per-user folder."""
    env = os.environ if env is None else env
    code_root = code_root or APP_ROOT
    if cli_state_dir:
        chosen, source = pathlib.Path(cli_state_dir), 'cli'
    elif env.get(ENV_STATE_DIR):
        chosen, source = pathlib.Path(env[ENV_STATE_DIR]).expanduser(), 'env'
    elif is_worktree_checkout(code_root):
        return Resolved(old_default_dir(code_root), 'worktree', False)
    else:
        return Resolved(real_user_state_dir(env, platform, home), 'user', True)
    chosen = pathlib.Path(os.path.abspath(str(chosen)))
    is_user = same_path(chosen, user_state_dir(env, platform, home))
    if is_user and under_test(env) and same_path(chosen, user_state_dir()):
        raise RealFolderBlocked(f'Refusing to use the real per-user AIB folder {chosen} while running tests.')
    return Resolved(chosen, source, is_user)


# ---- packaged parent app (Windows) -------------------------------------------------------------
NO_PACKAGE = 15700   # APPMODEL_ERROR_NO_PACKAGE
ERROR_INSUFFICIENT_BUFFER = 122   # the expected answer to a size query
SANDBOX_TAIL = ('LocalCache', 'Local', APP_DIR_WINDOWS)
SANDBOX_NOTE = 'MIGRATED-TO.txt'   # migrate.NOTE_NAME (not imported: migrate imports this module)


def _package_family_from_api(kernel=None):
    """The family name of the package this very process belongs to (GetCurrentPackageFullName), or None. Packaged apps themselves
    answer this; processes they start do NOT (they get NO_PACKAGE and are only virtualized), see _package_family_from_probe."""
    import ctypes
    if kernel is None:
        if os.name != 'nt':
            return None
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    length = ctypes.c_uint32(0)
    code = kernel.GetCurrentPackageFullName(ctypes.byref(length), None)
    if code == NO_PACKAGE or code not in (0, ERROR_INSUFFICIENT_BUFFER) or not length.value:
        return None
    buffer = ctypes.create_unicode_buffer(length.value)
    if kernel.GetCurrentPackageFullName(ctypes.byref(length), buffer) != 0:
        return None
    parts = buffer.value.split('_')   # <name>_<version>_<arch>_<resource id>_<publisher id>
    return f'{parts[0]}_{parts[-1]}' if len(parts) >= 2 else buffer.value


def _package_family_from_probe(env=None):
    """Children of a packaged app have no package identity but still get their %LOCALAPPDATA% writes redirected into the package.
    Prove it: write a small marker in %LOCALAPPDATA% and look for it under Packages\\*\\LocalCache\\Local. Returns that package's
    family name (its folder name), or None."""
    env = os.environ if env is None else env
    base = env.get('LOCALAPPDATA')
    if not base or not os.path.isdir(base):
        return None
    name = f'.studio-package-probe-{os.getpid()}-{uuid.uuid4().hex[:8]}'
    marker = pathlib.Path(base) / name
    try:
        marker.write_bytes(b'')
    except OSError:
        return None
    try:
        for package in sorted(pathlib.Path(base, 'Packages').glob('*')):
            if (package / 'LocalCache' / 'Local' / name).exists():
                return package.name
        return None
    except OSError:
        return None
    finally:
        try:
            marker.unlink()
        except OSError:
            pass


def package_context(env=None, platform=None, kernel=None):
    """The family name (e.g. 'Claude_pzs8sxrjxfjjc') of the Windows package whose sandbox this process writes into, or None
    (not Windows, or running outside any package). Asks GetCurrentPackageFullName first, then checks for inherited redirection."""
    platform = platform or sys.platform
    if not platform.startswith('win'):
        return None
    try:
        return _package_family_from_api(kernel) or _package_family_from_probe(env)
    except Exception:   # never let detection stop Studio from starting
        return None


def package_label(family):
    """'Claude' for 'Claude_pzs8sxrjxfjjc'."""
    return str(family).split('_')[0] if family else ''


def sandbox_copies(env=None, platform=None):
    """Sandbox copies of the Studio folder that hold user data: [(package family, folder)] newest first, or []. Only the Claude package
    (Claude_*) is looked at, or, when no Claude package has one, any package if exactly one does. Copies already moved (note
    MIGRATED-TO.txt) are ignored. Reading them from outside the package works at their real path."""
    env = os.environ if env is None else env
    platform = platform or sys.platform
    base = env.get('LOCALAPPDATA')
    if not platform.startswith('win') or not base:
        return []
    found = []
    try:
        for package in pathlib.Path(base, 'Packages').glob('*'):
            folder = package.joinpath(*SANDBOX_TAIL)
            if folder.is_dir() and _has_data(folder) and not (folder / SANDBOX_NOTE).exists():
                newest = max((folder / n).stat().st_mtime for n in ('studio-settings.json', 'studio-conversations.json') if (folder / n).is_file())
                found.append((newest, package.name, folder))
    except OSError:
        return []
    found.sort(key=lambda row: row[0], reverse=True)
    claude = [row for row in found if row[1].lower().startswith('claude_')]
    chosen = claude or (found if len(found) == 1 else [])
    return [(family, folder) for _, family, folder in chosen]


def _count_worktrees(source):
    try:
        return sum(1 for p in (pathlib.Path(source) / 'worktrees').iterdir() if p.is_dir())
    except OSError:
        return 0


def adopt_sandbox_copy(target, env=None, platform=None, say=None, attempt=True):
    """Studio runs OUTSIDE any package and `target` is the real per-user folder. Decide what to do about a sandbox copy.
    Returns (folder to use, migration) where migration is {'state', 'reason', 'source', 'kind': 'sandbox', ...}:
      none      no sandbox copy (or already moved): nothing changes.
      conflict  target already has user data AND a sandbox copy exists: nothing is merged or overwritten; the owner decides.
      done      the copy was moved to target (migrate.migrate: copy, verify, note in the sandbox copy, source kept).
      waiting   a host or chat in the sandbox copy is still running (or attempt is False): this run keeps using the sandbox
                copy (the same files the packaged server used, so it reaches the same running host); retried at the next start.
      blocked/failed  migrate refused: keep using target."""
    say = say or (lambda message: print(message, flush=True))
    target = pathlib.Path(target)
    copies = sandbox_copies(env, platform)
    if not copies:
        return target, {'state': 'none', 'reason': '', 'source': None, 'kind': 'sandbox'}
    package, source = copies[0]
    extra = ''
    if len(copies) > 1:
        extra = f' ({len(copies)} copies were found in app sandboxes; using the newest, from {package})'
        say(f'Several sandbox copies of the AIB data exist; using the newest: {source}')
    if _has_data(target) or (target / MIGRATED_MARKER).exists():
        return target, {'state': 'conflict', 'reason': f'{target} and {source} both hold AIB data' + extra,
                        'source': str(source), 'package': package, 'kind': 'sandbox'}
    if not attempt:
        return source, {'state': 'waiting', 'reason': 'not attempted by this command' + extra, 'source': str(source), 'package': package, 'kind': 'sandbox'}
    import migrate
    result = migrate.migrate(source, target, say=say)
    result.update(kind='sandbox', package=package)
    result['worktreesLeft'] = _count_worktrees(source)   # never moved: a moved git worktree loses its link to the repository
    if result['state'] == 'waiting':
        say(f'AIB data will move from {source} to {target} at a later start. This run keeps using {source}: {result["reason"]}')
        return source, result
    return target, result


# ---- owner-only access -------------------------------------------------------------------------
def _win_api():
    import ctypes
    from ctypes import wintypes as w
    advapi = ctypes.WinDLL('advapi32', use_last_error=True)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    pv = ctypes.c_void_p
    advapi.GetNamedSecurityInfoW.argtypes = [w.LPCWSTR, ctypes.c_int, w.DWORD, ctypes.POINTER(pv), ctypes.POINTER(pv), ctypes.POINTER(pv), ctypes.POINTER(pv), ctypes.POINTER(pv)]
    advapi.GetNamedSecurityInfoW.restype = w.DWORD
    advapi.GetAclInformation.argtypes = [pv, pv, w.DWORD, ctypes.c_int]
    advapi.GetAclInformation.restype = w.BOOL
    advapi.GetAce.argtypes = [pv, w.DWORD, ctypes.POINTER(pv)]
    advapi.GetAce.restype = w.BOOL
    advapi.ConvertSidToStringSidW.argtypes = [pv, ctypes.POINTER(w.LPWSTR)]
    advapi.ConvertSidToStringSidW.restype = w.BOOL
    advapi.OpenProcessToken.argtypes = [pv, w.DWORD, ctypes.POINTER(pv)]
    advapi.OpenProcessToken.restype = w.BOOL
    advapi.GetTokenInformation.argtypes = [pv, ctypes.c_int, pv, w.DWORD, ctypes.POINTER(w.DWORD)]
    advapi.GetTokenInformation.restype = w.BOOL
    kernel.LocalFree.argtypes = [pv]
    kernel.LocalFree.restype = pv
    kernel.GetCurrentProcess.restype = pv
    kernel.CloseHandle.argtypes = [pv]
    return ctypes, advapi, kernel


def _sid_string(ctypes, advapi, kernel, sid_pointer):
    from ctypes import wintypes as w
    text = w.LPWSTR()
    if not advapi.ConvertSidToStringSidW(sid_pointer, ctypes.byref(text)):
        return ''
    try:
        return text.value or ''
    finally:
        kernel.LocalFree(ctypes.cast(text, ctypes.c_void_p))


def windows_current_user_sid():
    """The SID of the user this process runs as (from its token), e.g. 'S-1-5-21-...'."""
    from ctypes import wintypes as w
    ctypes, advapi, kernel = _win_api()
    token = ctypes.c_void_p()
    if not advapi.OpenProcessToken(kernel.GetCurrentProcess(), 0x8, ctypes.byref(token)):  # TOKEN_QUERY
        raise OSError('OpenProcessToken failed')
    try:
        size = w.DWORD(0)
        advapi.GetTokenInformation(token, 1, None, 0, ctypes.byref(size))  # TokenUser
        buffer = ctypes.create_string_buffer(size.value)
        if not advapi.GetTokenInformation(token, 1, buffer, size, ctypes.byref(size)):
            raise OSError('GetTokenInformation failed')
        sid_pointer = ctypes.c_void_p.from_buffer(buffer).value  # TOKEN_USER starts with the PSID
        return _sid_string(ctypes, advapi, kernel, ctypes.c_void_p(sid_pointer))
    finally:
        kernel.CloseHandle(token)


def windows_dacl(path):
    """[(sid_string, ace_type, mask, flags)] for every ACE of the folder's DACL, or None for a NULL DACL (everyone has full access)."""
    from ctypes import wintypes as w
    ctypes, advapi, kernel = _win_api()
    owner, dacl, descriptor = ctypes.c_void_p(), ctypes.c_void_p(), ctypes.c_void_p()
    code = advapi.GetNamedSecurityInfoW(str(path), 1, 0x1 | 0x4, ctypes.byref(owner), None, ctypes.byref(dacl), None, ctypes.byref(descriptor))  # SE_FILE_OBJECT, OWNER|DACL
    if code:
        raise OSError(code, f'GetNamedSecurityInfoW failed for {path} (error {code})')
    try:
        if not dacl.value:
            return None
        info = (w.DWORD * 3)()
        if not advapi.GetAclInformation(dacl, ctypes.cast(info, ctypes.c_void_p), ctypes.sizeof(info), 2):  # AclSizeInformation
            raise OSError('GetAclInformation failed')
        entries = []
        for index in range(info[0]):
            ace = ctypes.c_void_p()
            if not advapi.GetAce(dacl, index, ctypes.byref(ace)):
                raise OSError('GetAce failed')
            head = ctypes.string_at(ace.value, 8)
            ace_type, flags, mask = head[0], head[1], int.from_bytes(head[4:8], 'little')
            offset = 8
            if ace_type in (5, 6, 7, 8, 11, 12, 13, 14, 15, 16, 17):  # object / compound ACEs: GUIDs sit before the SID
                object_flags = int.from_bytes(ctypes.string_at(ace.value + 8, 4), 'little')
                offset = 12 + (16 if object_flags & 1 else 0) + (16 if object_flags & 2 else 0)
            entries.append((_sid_string(ctypes, advapi, kernel, ctypes.c_void_p(ace.value + offset)), ace_type, mask, flags))
        return entries
    finally:
        if descriptor.value:
            kernel.LocalFree(descriptor)


ALLOW_TYPES = {0, 5, 9, 11}  # ACCESS_ALLOWED, _OBJECT, _CALLBACK, _CALLBACK_OBJECT


def acl_problems(path, platform=None):
    """List of reasons somebody other than the owner can write to path (empty list = private). Raises OSError when it cannot be read."""
    platform = platform or sys.platform
    path = pathlib.Path(path)
    if platform.startswith('win'):
        entries = windows_dacl(path)
        if entries is None:
            return ['the folder has no access list, so everyone can write to it']
        found = []
        for sid, ace_type, mask, _flags in entries:
            if ace_type in ALLOW_TYPES and sid in WIDE_GROUPS and mask & WRITE_MASK:
                found.append(f'{WIDE_GROUPS[sid]} ({sid}) can write')
        return sorted(set(found))
    status = os.stat(path)
    found = []
    if status.st_mode & 0o022:
        found.append(f'group or others can write (mode {status.st_mode & 0o777:03o})')
    if hasattr(os, 'geteuid') and status.st_uid != os.geteuid():
        found.append('the folder belongs to another user')
    return found


def make_owner_only(path):
    """Restrict a folder we just created: Windows keeps owner + SYSTEM + Administrators (by SID), POSIX uses mode 0700."""
    path = pathlib.Path(path)
    if os.name == 'nt':
        grants = [f'*{SID_SYSTEM}:(OI)(CI)F', f'*{SID_ADMINS}:(OI)(CI)F', f'*{windows_current_user_sid()}:(OI)(CI)F']
        result = subprocess.run(['icacls', str(path), '/inheritance:r', '/grant:r', *grants], capture_output=True, timeout=30,
                                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        if result.returncode != 0:
            raise StateDirError(f'Could not restrict {path} to its owner (icacls exit code {result.returncode}).')
        try:
            list(path.iterdir())  # never lock ourselves out
        except OSError as error:
            raise StateDirError(f'Restricting {path} locked this user out: {error}') from error
    else:
        os.chmod(path, 0o700)


def ensure_private_dir(path, strict=True, say=None):
    """Create path owner-only if it does not exist, then check it. strict=True raises StateDirInsecure when others can write;
    strict=False prints a warning instead. An existing folder is checked but never changed."""
    path = pathlib.Path(path)
    say = say or (lambda message: print(message, file=sys.stderr, flush=True))
    created = not path.exists()
    if created:
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.mkdir(path, 0o700)
        except FileExistsError:
            created = False
        else:
            make_owner_only(path)
    try:
        problems = acl_problems(path)
    except OSError as error:
        problems = [f'its permissions could not be read ({error})']
    if problems:
        text = f'{path} is not private: ' + '; '.join(problems) + '.'
        if strict:
            raise StateDirInsecure(text + ' AIB will not keep its data there. Fix the folder permissions or choose another --state-dir.')
        say('WARNING: ' + text)
    return created


# ---- choosing the folder for this run ----------------------------------------------------------
class Plan:
    """state_dir: the folder to run on. migration: {'state': 'none'|'done'|'waiting'|'blocked'|'failed', 'reason', 'source'}."""
    def __init__(self, state_dir, resolved, migration, warnings):
        self.state_dir, self.resolved, self.migration, self.warnings = pathlib.Path(state_dir), resolved, migration, warnings


def _has_data(source):
    return (source / 'studio-settings.json').is_file() or (source / 'studio-conversations.json').is_file()


def prepare(cli_state_dir=None, migrate_from=None, code_root=None, env=None, attempt_migration=True, say=None):
    """Decide the state folder for this run, moving the old data first when that is due. Raises StateDirError on a refusal."""
    say = say or (lambda message: print(message, flush=True))
    code_root = pathlib.Path(code_root or APP_ROOT)
    resolved = resolve(cli_state_dir, env, code_root)
    warnings = []
    target = resolved.path
    migration = {'state': 'none', 'reason': '', 'source': None}
    explicit_override = resolved.source in ('cli', 'env')
    wants = resolved.is_user_folder or (migrate_from is not None and explicit_override)
    if resolved.source == 'user' and package_context(env) is None:   # outside any package: take over a copy the Claude app's sandbox holds
        target, sandbox = adopt_sandbox_copy(target, env=env, attempt=attempt_migration, say=say)
        if sandbox['state'] != 'none':
            migration = sandbox
    if wants and not (target / MIGRATED_MARKER).exists() and migration.get('kind') != 'sandbox':
        source = pathlib.Path(os.path.abspath(str(migrate_from))) if migrate_from else old_default_dir(code_root)
        if same_path(source, target):
            pass
        elif _has_data(source):
            migration['source'] = str(source)
            if not attempt_migration:   # e.g. --stop-host: just look where the data still is
                migration.update(state='waiting', reason='migration not attempted by this command')
                target = source
            else:
                import migrate
                migration = migrate.migrate(source, target, say=say)
                if migration['state'] != 'done':
                    say(f'AIB data will move to {target} at a later start. This run uses {source}: {migration["reason"]}')
                    target = source
    final_is_user = same_path(target, resolved.path) and resolved.is_user_folder
    if final_is_user:
        ensure_private_dir(target, strict=True)
    elif target.exists():
        try:
            problems = acl_problems(target)
        except OSError:
            problems = []
        if problems:
            warnings.append(f'{target} is not private: ' + '; '.join(problems) + '.')
    return Plan(target, resolved, migration, warnings)


def apply(options, parser, code_root=None, attempt_migration=True):
    """Resolve options.state_dir (None means the default) and set options.state_dir, options.migration and options.state_warnings.
    Exits through parser.error on a refusal."""
    try:
        plan = prepare(getattr(options, 'state_dir', None), getattr(options, 'migrate_from', None), code_root, attempt_migration=attempt_migration)
    except StateDirError as error:
        parser.error(str(error))
    options.state_dir, options.migration, options.state_warnings = plan.state_dir, plan.migration, plan.warnings
    for line in plan.warnings:
        print('WARNING: ' + line, file=sys.stderr, flush=True)
    return plan
