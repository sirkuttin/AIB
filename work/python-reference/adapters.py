"""Where the agent programs are on this computer. No owner-machine paths: everything is looked up.

  Claude Code   the installed `@agentclientprotocol/claude-agent-acp` package (dist/index.js, run with node)
  Codex         the installed `@zed-industries/codex-acp` package (bin/codex-acp.js, run with node) or `codex-acp` on PATH
  OMP           `omp` on PATH; on Windows also %LOCALAPPDATA%\\omp\\omp.exe

Lookup order for Claude Code and Codex: the command-line flag, then a launcher saved in Settings, then Studio's own install
(`<state_dir>/agents/<id>/<version>/`, only a version folder that has a `.complete` marker, newest first), then the globally
installed adapter, then missing. A launcher from the flag or Settings is a script file that node runs. The adapter is never
started through the npm `.cmd` shim. The npm global folder is found next to node and with `npm root -g`. Studio's own install is
read fresh on every lookup (a folder listing and a small json file), so a new install is seen by the next call in any process.

On macOS and Linux, apps started from the desktop have a short PATH. init_environment() asks the user's login shell for
the real one once at startup and merges it into os.environ (before anything is looked up). It does nothing on Windows.
"""
import os
import pathlib
import platform
import re
import shutil
import subprocess

import json
import logging

import agent_registry

log = logging.getLogger(__name__)

CLAUDE_PACKAGE = ('@agentclientprotocol/claude-agent-acp', 'dist/index.js')
CODEX_PACKAGE = ('@zed-industries/codex-acp', 'bin/codex-acp.js')
# Studio's own installs: the package names that may sit in <version>/node_modules/, current name first, each with the known entry
# file that is used only when its package.json has no usable `bin`.
STUDIO_PACKAGES = {'claude': (CLAUDE_PACKAGE,),
                   'codex': (('@agentclientprotocol/codex-acp', 'dist/index.js'), ('@zed-industries/codex-acp', 'bin/codex-acp.js'))}
COMPLETE_MARKER = '.complete'
CLAUDE_INSTALL = 'npm i -g @agentclientprotocol/claude-agent-acp'
CODEX_INSTALL = 'npm i -g @agentclientprotocol/codex-acp'
PATH_START = '__STUDIO_PATH_START__'
PATH_END = '__STUDIO_PATH_END__'
_env_done = []
LOGIN_SHELL_TIMEOUT = 3.0
NPM_ROOT_TIMEOUT = 10.0


def is_windows():
    return os.name == 'nt'


# ---- login-shell PATH (macOS / Linux) ---------------------------------------------------------------------------------

def parse_marked_path(output):
    """The text between the last START and the END marker, or '' when the markers are missing (shell banners and
    profile noise around them are ignored)."""
    if not isinstance(output, str):
        return ''
    start = output.rfind(PATH_START)
    if start < 0:
        return ''
    start += len(PATH_START)
    end = output.find(PATH_END, start)
    if end < 0:
        return ''
    value = output[start:end].strip()
    return value if value and '\x00' not in value and '\n' not in value else ''


def merge_paths(login, current, sep=None):
    """Entries of `login` first (it is the complete one), then anything only `current` has; no repeats, no empties."""
    sep = sep or os.pathsep
    seen, out = set(), []
    for entry in (login or '').split(sep) + (current or '').split(sep):
        if entry and entry not in seen:
            seen.add(entry)
            out.append(entry)
    return sep.join(out)


def login_shell_path(environ=None, system=None, run=None, timeout=LOGIN_SHELL_TIMEOUT):
    """PATH as the user's login shell sees it, or '' (Windows, no usable $SHELL, a timeout, a failure). Never raises.
    Runs `$SHELL -l -c` (not interactive) with markers around the value so profile output cannot be mistaken for it."""
    environ = os.environ if environ is None else environ
    if (system or platform.system()) == 'Windows':
        return ''
    shell = environ.get('SHELL') or ''
    if not shell or not os.path.isabs(shell) or not os.path.isfile(shell):
        return ''
    script = f"printf '%s' '{PATH_START}'; printf %s \"$PATH\"; printf '%s' '{PATH_END}'"
    run = run or subprocess.run
    try:
        done = run([shell, '-l', '-c', script], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                   timeout=timeout, text=True, errors='replace', env=dict(environ))
    except (OSError, subprocess.SubprocessError, ValueError):
        return ''
    return parse_marked_path(done.stdout or '')


def init_environment(environ=None, system=None, run=None):
    """Merge the login-shell PATH into the environment. Returns the PATH that was added to ('' when nothing changed).
    The agent host is started from this process, so it inherits the merged PATH."""
    if environ is None:
        if _env_done:
            return ''
        _env_done.append(True)   # once per process: the real environment is merged a single time
        environ = os.environ
    found = login_shell_path(environ, system, run)
    if not found:
        return ''
    merged = merge_paths(found, environ.get('PATH', ''), ':')
    if merged == environ.get('PATH', ''):
        return ''
    environ['PATH'] = merged
    return merged


# ---- node and the npm global folder -----------------------------------------------------------------------------------

_npm_root_cache = {}


def reset_cache():
    _npm_root_cache.clear()


def find_node(configured=None):
    """The node program: the configured one if it exists, else PATH. '' when missing."""
    for candidate in (configured, 'node'):
        if candidate:
            found, _ = agent_registry.command_status(candidate)
            if found:
                return found
    return ''


def npm_root_from_command(node=None, run=None):
    """`npm root -g`, cached per node. '' when npm is missing or slow."""
    key = str(node or '')
    if key in _npm_root_cache:
        return _npm_root_cache[key]
    npm = None
    if node:
        folder = pathlib.Path(node).parent
        for name in (('npm.cmd', 'npm') if is_windows() else ('npm',)):
            if (folder / name).is_file():
                npm = str(folder / name)
                break
    npm = npm or shutil.which('npm')
    value = ''
    if npm:
        try:
            done = (run or subprocess.run)([npm, 'root', '-g'], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                            timeout=NPM_ROOT_TIMEOUT, text=True, errors='replace')
            lines = [line.strip() for line in (done.stdout or '').splitlines() if line.strip()]
            value = lines[-1] if lines else ''
        except (OSError, subprocess.SubprocessError, ValueError):
            value = ''
    _npm_root_cache[key] = value
    return value


def global_roots(node=None, npm_root=None):
    """Folders that can hold globally installed npm packages, best guess first, without repeats."""
    out = []

    def add(path):
        if path:
            text = str(path)
            if text not in out:
                out.append(text)

    if node:
        base = pathlib.Path(node).parent
        add(base / 'node_modules')                    # Windows installers, fnm aliases
        add(base.parent / 'lib' / 'node_modules')     # macOS / Linux prefix layout
    add((npm_root or npm_root_from_command)(node))   # npm_root: a function node -> folder (tests pass their own)
    prefix = os.environ.get('npm_config_prefix') or os.environ.get('NPM_CONFIG_PREFIX')
    if prefix:
        add(pathlib.Path(prefix) / ('node_modules' if is_windows() else 'lib/node_modules'))
    appdata = os.environ.get('APPDATA')
    if is_windows() and appdata:
        add(pathlib.Path(appdata) / 'npm' / 'node_modules')
    if not is_windows():
        for fixed in ('/usr/local/lib/node_modules', '/opt/homebrew/lib/node_modules', '/usr/lib/node_modules'):
            add(fixed)
    return out


def find_package_file(package, node=None, npm_root=None):
    """The entry file of a globally installed npm package, or ''. `package` is (name, path inside the package)."""
    name, entry = package
    for root in global_roots(node, npm_root):
        candidate = pathlib.Path(root).joinpath(*name.split('/')).joinpath(*entry.split('/'))
        if candidate.is_file():
            return str(candidate)
    return ''


# ---- Studio's own installs --------------------------------------------------------------------------------------------

def agents_root(state_dir):
    """<state_dir>/agents: one folder per agent id, one subfolder per version."""
    return pathlib.Path(state_dir) / 'agents'


def _version_key(name):
    """Sort key for version folder names: 1.10.0 above 1.9.0, a release above its prerelease, anything unparsable lowest."""
    match = re.match(r'^v?(\d+(?:\.\d+)*)(?:-(.*))?$', name)
    if not match:
        return (0, (), 0, name)
    return (1, tuple(int(part) for part in match.group(1).split('.')), 0 if match.group(2) else 1, match.group(2) or '')


def complete_versions(state_dir, agent_id):
    """Version folders of an agent that finished installing (they hold the `.complete` marker, which is written last), newest first.
    A folder without the marker is a half-made install and never counts. Read fresh each time."""
    base = agents_root(state_dir) / agent_id
    try:
        folders = [entry for entry in base.iterdir() if entry.is_dir() and (entry / COMPLETE_MARKER).is_file()]
    except OSError:
        return []
    return sorted(folders, key=lambda folder: _version_key(folder.name), reverse=True)


def _inside(path, folder):
    try:
        path.resolve().relative_to(folder.resolve())
        return True
    except (ValueError, OSError, RuntimeError):
        return False


def _package_entry(version_dir, package):
    """The entry file of one package in a version folder, from its package.json `bin` (else the known path), or '' when the package
    is not there, the entry would lie outside the version folder (a hostile `bin` such as ../../x), or it is not a file."""
    name, known = package
    folder = version_dir / 'node_modules' / pathlib.Path(*name.split('/'))
    try:
        data = json.loads((folder / 'package.json').read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return ''
    declared = data.get('bin') if isinstance(data, dict) else None
    if isinstance(declared, dict):
        declared = declared.get(name.split('/')[-1]) or next((v for v in declared.values() if isinstance(v, str) and v), None)
    relative = declared if isinstance(declared, str) and declared else known
    candidate = folder / relative
    if not _inside(candidate, version_dir):
        log.warning('Ignoring %s: its entry file %s is outside %s', name, relative, version_dir)
        return ''
    return str(candidate.resolve()) if candidate.is_file() else ''


def find_studio_install(agent_id, state_dir):
    """Studio's own install of an agent: {entry, version, dir, package} for the newest complete version that has a usable entry
    file, or None. No caching: every call reads the disk."""
    if not state_dir or agent_id not in STUDIO_PACKAGES:
        return None
    for folder in complete_versions(state_dir, agent_id):
        for package in STUDIO_PACKAGES[agent_id]:
            entry = _package_entry(folder, package)
            if entry:
                return {'entry': entry, 'version': folder.name, 'dir': str(folder), 'package': package[0]}
    return None


def _studio_launch(agent_id, node_command, state_dir):
    found = find_studio_install(agent_id, state_dir)
    if not found:
        return None
    node = find_node(node_command)
    if not node:
        return _row([], 'studio', found['entry'], 'Node.js was not found. Install Node.js so Studio can start this adapter.', f"Studio's own install: {found['entry']}")
    return _row([node, found['entry']], 'studio', found['entry'], '', f"Studio's own install {found['version']}: {found['entry']} (run with node)")


# ---- agent lookups ----------------------------------------------------------------------------------------------------

def _row(argv, source, path, problem='', note=''):
    return {'argv': list(argv), 'source': source, 'path': path, 'found': bool(argv) and not problem, 'problem': problem,
            'text': note or (' '.join(argv) if argv else '')}


def _script_launch(kind, source, script, node_command, install_hint):
    """flag / settings launcher: a script file that node runs."""
    path = pathlib.Path(str(script)).expanduser()
    node = find_node(node_command) or str(node_command or '')   # a node the caller named explicitly is used as given
    label = {'flag': 'Command-line launcher', 'settings': 'Launcher saved in Settings'}[source]
    if not path.is_file():
        return _row([], source, str(path), f'{label} not found: {path}', f'{label}: {path}')
    if not node:
        return _row([], source, str(path), 'Node.js was not found. Install Node.js so Studio can start this adapter.', f'{label}: {path}')
    return _row([node, str(path.resolve())], source, str(path.resolve()), '', f'{label}: {path.resolve()} (run with node)')


def _installed_launch(kind, package, node_command, install_hint, npm_root=None):
    node = find_node(node_command)
    entry = find_package_file(package, node or None, npm_root)
    if not entry:
        return None
    if not node:
        return _row([], 'installed', entry, 'Node.js was not found. Install Node.js so Studio can start this adapter.', f'Installed adapter: {entry}')
    return _row([node, entry], 'installed', entry, '', f'Installed adapter: {entry} (run with node)')


def resolve_claude(flag='', saved='', node_command='', npm_root=None, state_dir=None):
    """How to start Claude Code: {argv, source, path, found, problem, text}. Never raises."""
    if flag:
        return _script_launch('claude', 'flag', flag, node_command, CLAUDE_INSTALL)
    if saved:
        return _script_launch('claude', 'settings', saved, node_command, CLAUDE_INSTALL)
    row = _studio_launch('claude', node_command, state_dir) or _installed_launch('claude', CLAUDE_PACKAGE, node_command, CLAUDE_INSTALL, npm_root)
    return row or _row([], 'missing', '', 'Not installed. Install the adapter with: ' + CLAUDE_INSTALL, 'Not installed')


def _codex_on_path():
    """A native `codex-acp` program on PATH. The Windows .cmd/.bat shims are skipped: they cannot be started directly."""
    names = ('codex-acp.exe', 'codex-acp.com') if is_windows() else ('codex-acp',)
    for name in names:
        found = shutil.which(name)
        if found:
            return str(pathlib.Path(found).resolve())
    return ''


def codex_looks_installed(which=None, home=None, local_appdata=None, system_windows=None):
    """Cheap signs that Codex itself (not its ACP adapter) is installed: `codex` on PATH, a ~/.codex folder, or on Windows
    the Store app's alias / package folder. Filesystem lookups only, no subprocess."""
    which = which or shutil.which
    windows = is_windows() if system_windows is None else system_windows
    try:
        if which('codex') or (windows and which('codex.exe')):
            return True
        home = pathlib.Path(home) if home else pathlib.Path.home()
        if (home / '.codex').is_dir():
            return True
        if windows:
            base = local_appdata or os.environ.get('LOCALAPPDATA') or str(home / 'AppData' / 'Local')
            base = pathlib.Path(base)
            if any(base.glob('Microsoft/WindowsApps/codex-*.exe')) or any(base.glob('Packages/OpenAI.Codex_*')):
                return True
    except (OSError, ValueError, RuntimeError):
        return False
    return False


CODEX_NEEDS_ADAPTER = 'The Codex app is on this PC, but Studio needs its ACP adapter.'


def resolve_codex(flag='', saved='', node_command='', npm_root=None, on_path=None, codex_present=None, state_dir=None):
    """How to start Codex through codex-acp: same shape as resolve_claude."""
    if flag:
        return _script_launch('codex', 'flag', flag, node_command, CODEX_INSTALL)
    if saved:
        return _script_launch('codex', 'settings', saved, node_command, CODEX_INSTALL)
    row = _studio_launch('codex', node_command, state_dir) or _installed_launch('codex', CODEX_PACKAGE, node_command, CODEX_INSTALL, npm_root)
    if row:
        return row
    path = (on_path or _codex_on_path)()
    if path:
        return _row([path], 'path', path, '', f'codex-acp on PATH: {path}')
    present = (codex_present or codex_looks_installed)()
    problem = CODEX_NEEDS_ADAPTER if present else 'Not installed. Install the adapter with: ' + CODEX_INSTALL
    return _row([], 'missing', '', problem, 'Not installed')


def default_omp_command(which=None, system_windows=None, home=None, local_appdata=None):
    """The OMP program: `omp` on PATH; on Windows also %LOCALAPPDATA%\\omp\\omp.exe. '' when not installed."""
    which = which or shutil.which
    windows = is_windows() if system_windows is None else system_windows
    names = ('omp.exe', 'omp') if windows else ('omp',)
    for name in names:
        found = which(name)
        if found:
            return found
    if windows:
        base = local_appdata or os.environ.get('LOCALAPPDATA') or str((home or pathlib.Path.home()) / 'AppData' / 'Local')
        fallback = pathlib.Path(base) / 'omp' / 'omp.exe'
        if fallback.is_file():
            return str(fallback)
    return ''


def resolve_omp(command):
    if not command:
        return _row([], 'missing', '', 'Not installed. OMP was not found on PATH.', 'Not installed')
    found, problem = agent_registry.command_status(command)
    if not found:
        return _row([], 'flag', str(command), problem, f'{command} acp')
    return _row([found, 'acp'], 'path', found, '', f'{found} acp')
