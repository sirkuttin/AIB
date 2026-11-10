"""Studio's own agent installs: one npm install per agent into <state_dir>/agents/<id>/<version>/ (adapters.py finds the result).

The job runs in the agent host process (it lives longer than the web server) and is reached through the host op `install` and the
web routes under /api/live/agents/install. Everything the page needs to survive a web-server restart is on disk:

  <state_dir>/agents/<id>/install.json   the job's state {state, stage, percent, message, version, pid, ...}; written atomically
  <state_dir>/agents/<id>/install.lock   exclusive lock file holding the pid of the process that runs the job (one install per agent)
  <state_dir>/agents/<id>/install.log    npm's own output of the last run (kept for the failure line, never shown whole)
  <state_dir>/agents/<id>/<version>/     the install; `.complete` is written last, and only a folder that has it is ever used

What may be installed is the allow-list agent_versions.json (package, exact reviewed version, lockfile). With a lockfile the job runs
`npm ci`, otherwise `npm install <package>@<exact>`; both with --ignore-scripts --omit=dev --no-audit --no-fund. npm is started as
`node <npm-cli.js>` (never through npm.cmd), so cancel can kill the whole process tree (process_tree.py) and nothing is re-quoted by cmd.exe.
Before anything is started the job is refused, with one plain line, when it is bound to fail: Node missing or older than 22, too little
disk space, or an install path that is too long."""
import json
import logging
import os
import pathlib
import re
import shutil
import subprocess
import threading
import time

import adapters
import agent_registry
from app_paths import APP_ROOT
from host_client import pid_alive
from process_tree import ProcessTree

log = logging.getLogger(__name__)

MIN_NODE_MAJOR = 22              # the adapters' `engines` field
MAX_PATH_CHARS = 240             # Windows stops at 260; leave room for the files npm puts inside
ALLOW_LIST = APP_ROOT / 'agent_versions.json'
STATE_NAME, LOCK_NAME, LOG_NAME = 'install.json', 'install.lock', 'install.log'
NPM_ARGS = ['--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund']
POLL_SECONDS = 0.4
SIZE_EVERY_SECONDS = 1.5
GIB = 1024 ** 3


_node_cache = {}                 # node command -> (checked at, line, node found); the Settings page asks on every open
NODE_CACHE_SECONDS = 30


def node_block(node_command='', force=False, probe=None, now=None):
    """(line, node_found): why installs cannot run on this PC, as one plain grey line ('' when Node.js 22+ is there). Cached for 30 seconds;
    force=True (the "Check again" link) asks again."""
    key = str(node_command or '')
    clock = (now or time.time)()
    hit = _node_cache.get(key)
    if hit and not force and clock - hit[0] < NODE_CACHE_SECONDS:
        return hit[1], hit[2]
    node = adapters.find_node(node_command)
    if not node:
        result = (f'Node.js {MIN_NODE_MAJOR} or newer is needed to install this agent.', False)
    else:
        version = (probe or node_version)(node)
        match = re.match(r'(\d+)', version or '')
        if not match:
            result = (f'Node.js {MIN_NODE_MAJOR} or newer is needed to install this agent, but Node.js did not start.', True)
        elif int(match.group(1)) < MIN_NODE_MAJOR:
            result = (f'Node.js {MIN_NODE_MAJOR} or newer is needed to install this agent; this PC has Node.js {version}.', True)
        else:
            result = ('', True)
    _node_cache[key] = (clock, result[0], result[1])
    return result


class InstallRefused(ValueError):
    """The install cannot work here (or the request is not allowed). The message is the one plain line the page shows."""
    code = 'install_refused'


def load_allow_list(path=None):
    """{agent id: {package, version, lockfile?, packageBytes, minFreeBytes}} from agent_versions.json. Raises ValueError when unreadable."""
    try:
        data = json.loads(pathlib.Path(path or ALLOW_LIST).read_text(encoding='utf-8'))
    except (OSError, ValueError) as error:
        raise ValueError(f'The list of installable agents could not be read: {error}') from error
    agents = data.get('agents') if isinstance(data, dict) else None
    if not isinstance(agents, dict):
        raise ValueError('The list of installable agents is not valid.')
    return agents


def agent_dir(state_dir, agent_id):
    return adapters.agents_root(state_dir) / agent_id


def _write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f'{path.name}.{os.getpid()}.{threading.get_ident()}.tmp')
    temporary.write_text(json.dumps(data), encoding='utf-8')
    for attempt in range(6):   # Windows: a reader may hold the target for a moment
        try:
            os.replace(temporary, path)
            return
        except PermissionError:
            time.sleep(0.05 * (attempt + 1))
    os.replace(temporary, path)


def _read_json(path):
    for attempt in range(4):
        try:
            data = json.loads(path.read_text(encoding='utf-8'))
            return data if isinstance(data, dict) else None
        except FileNotFoundError:
            return None
        except (OSError, ValueError):
            time.sleep(0.05 * (attempt + 1))
    return None


IDLE = {'state': 'idle', 'stage': '', 'percent': 0, 'message': ''}


def read_status(state_dir, agent_id):
    """The job's state as the page should see it, read from disk only (the web server calls this; nothing is changed).
    {agent, state: idle|running|failed|done, stage, percent, message, version}. A job whose process has died is reported as failed."""
    saved = _read_json(agent_dir(state_dir, agent_id) / STATE_NAME)
    if not saved or saved.get('state') not in ('running', 'failed', 'done'):
        return dict(IDLE, agent=agent_id)
    out = {'agent': agent_id, 'state': saved['state'], 'stage': str(saved.get('stage') or ''), 'percent': int(saved.get('percent') or 0),
           'message': str(saved.get('message') or ''), 'version': str(saved.get('version') or '')}
    if out['state'] == 'running' and not pid_alive(saved.get('pid')):
        out.update(state='failed', stage='', message='The install was interrupted before it finished. Try again.', interrupted=True)
    return out


def find_npm_cli(node):
    """npm-cli.js next to a node program: the Windows layout (node_modules beside node.exe) or the macOS / Linux prefix layout. '' when absent."""
    base = pathlib.Path(node).resolve().parent
    for candidate in (base / 'node_modules' / 'npm' / 'bin' / 'npm-cli.js', base.parent / 'lib' / 'node_modules' / 'npm' / 'bin' / 'npm-cli.js'):
        if candidate.is_file():
            return str(candidate)
    return ''


def node_version(node, run=None):
    """'22.4.0' from `node --version`, or '' when it does not run."""
    try:
        done = (run or subprocess.run)([node, '--version'], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=15,
                                       text=True, errors='replace', creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    except (OSError, subprocess.SubprocessError, ValueError):
        return ''
    match = re.search(r'v?(\d+\.\d+\.\d+\S*)', done.stdout or '')
    return match.group(1) if match else ''


def _size(num):
    return f'{num / GIB:.1f} GB' if num >= GIB else f'{max(1, round(num / 1024 ** 2))} MB'


def folder_bytes(path):
    """Bytes under a folder (best effort, never raises): the install's progress is measured from it."""
    total, stack = 0, [str(path)]
    while stack:
        try:
            with os.scandir(stack.pop()) as entries:
                for entry in entries:
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            stack.append(entry.path)
                        else:
                            total += entry.stat(follow_symlinks=False).st_size
                    except OSError:
                        pass
        except OSError:
            pass
    return total


def remove_tree(path):
    """Delete a folder, retrying while Windows still holds files of a process that was just killed. True when it is gone."""
    def unlock(function, target, _info):
        try:
            os.chmod(target, 0o700)
            function(target)
        except OSError:
            pass
    for attempt in range(8):
        shutil.rmtree(path, onerror=unlock)
        if not os.path.exists(path):
            return True
        time.sleep(0.25 * (attempt + 1))
    return not os.path.exists(path)


def failure_line(log_text, code):
    """One plain line saying why npm failed, from the tail of its output."""
    text = log_text or ''
    table = (('ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|network|EPROTO|ESOCKETTIMEDOUT', 'Could not reach the npm registry. Check the internet connection and try again.'),
             ('ENOSPC', 'The disk is full.'),
             ('EACCES|EPERM|EBUSY', "Studio could not write to its install folder. Close programs that may be using it and try again."),
             ('E404|E403', 'npm could not find that exact version of the adapter.'),
             ('EINTEGRITY', 'npm rejected the download because its checksum did not match.'),
             ('ENOENT.*package-lock|EUSAGE|lock file', 'The saved lockfile does not match the package. This is a Studio bug.'))
    for pattern, line in table:
        if re.search(pattern, text, re.I):
            return line
    lines = [re.sub(r'^npm (?:error|ERR!)\s*', '', l.strip()) for l in text.splitlines() if re.match(r'^\s*npm (?:error|ERR!)', l)]
    lines = [l for l in lines if l and not l.startswith(('A complete log', 'code ', 'path ', 'errno ', 'syscall '))]
    if lines:
        return ('npm said: ' + lines[0])[:160]
    return f'npm stopped with exit code {code}.'


class Job:
    def __init__(self, agent_id, version, folder):
        self.agent_id, self.version, self.folder = agent_id, version, folder
        self.cancel_event = threading.Event()
        self.guard = threading.Lock()
        self.tree = None
        self.thread = None
        self.percent = 0
        self.cancelled = False


class Installer:
    """One per process that runs installs (the agent host; the in-process Studio of tests and demos). `options` supplies node_command."""

    def __init__(self, state_dir, node_command='', allow_list=None, node_probe=None, npm_cli=None, disk_free=None):
        self.state_dir = pathlib.Path(state_dir)
        self.node_command = node_command or ''
        self._allow = allow_list
        self.node_probe = node_probe or node_version
        self.npm_cli = npm_cli            # a fixed npm-cli.js (tests use a fake); None means: look next to node
        self.disk_free = disk_free or (lambda path: shutil.disk_usage(path).free)
        self.jobs = {}
        self.guard = threading.RLock()

    # ---- what can be installed --------------------------------------------------------------------------------------
    def allow_list(self):
        return self._allow if self._allow is not None else load_allow_list()

    def entry(self, agent_id):
        """The allow-list entry for an agent id. Only ids that are known agents are looked at, so an id never becomes part of a path."""
        found = self.allow_list().get(agent_id) if isinstance(agent_id, str) and agent_id in adapters.STUDIO_PACKAGES else None
        if not isinstance(found, dict) or not found.get('package') or not found.get('version'):
            raise InstallRefused('Studio cannot install that agent.')
        return found

    def version_dir(self, agent_id, version):
        return agent_dir(self.state_dir, agent_id) / version

    # ---- checks before anything starts (each refusal is one plain line) -----------------------------------------------
    def preflight(self, agent_id, entry):
        """Returns (node, npm_cli). Raises InstallRefused. Nothing has been created or started yet."""
        name = agent_registry.BUILTIN_NAMES.get(agent_id, agent_id)
        folder = self.version_dir(agent_id, str(entry['version']))
        shown = os.path.abspath(folder)
        if len(shown) > MAX_PATH_CHARS:
            raise InstallRefused(f'The install folder path is {len(shown)} characters long, over the {MAX_PATH_CHARS} Windows can handle. Start Studio with a shorter --state-dir.')
        node = adapters.find_node(self.node_command)
        if not node:
            raise InstallRefused(f'Node.js {MIN_NODE_MAJOR} or newer is needed to install {name}, and Node.js was not found. Install it from nodejs.org and try again.')
        version = self.node_probe(node)
        match = re.match(r'(\d+)', version or '')
        if not match:
            raise InstallRefused(f'Node.js {MIN_NODE_MAJOR} or newer is needed to install {name}, but Node.js did not start.')
        if int(match.group(1)) < MIN_NODE_MAJOR:
            raise InstallRefused(f'Node.js {MIN_NODE_MAJOR} or newer is needed to install {name}; this PC has Node.js {version}. Update Node.js and try again.')
        npm_cli = self.npm_cli or find_npm_cli(node)
        if not npm_cli or not os.path.isfile(npm_cli):
            raise InstallRefused('npm was not found next to Node.js. Reinstall Node.js from nodejs.org and try again.')
        need = max(2 * int(entry.get('packageBytes') or 0), int(entry.get('minFreeBytes') or 0))
        probe = pathlib.Path(shown)
        while not probe.exists() and probe.parent != probe:
            probe = probe.parent
        try:
            free = self.disk_free(str(probe))
        except OSError:
            free = None
        if free is not None and need and free < need:
            raise InstallRefused(f'Not enough free disk space for {name}: it needs about {_size(need)} and this drive has {_size(free)} free.')
        return node, npm_cli

    # ---- the three calls ----------------------------------------------------------------------------------------------
    def status(self, agent_id):
        """The job's state. A job that died with its process (a host restart) is cleaned up and reported as failed."""
        self.entry(agent_id)
        with self.guard:
            view = read_status(self.state_dir, agent_id)
            job = self.jobs.get(agent_id)
            if view.get('interrupted') and not (job and job.thread and job.thread.is_alive()):
                self._finish_dead(agent_id, view)
            return view

    def _finish_dead(self, agent_id, view):
        saved = _read_json(agent_dir(self.state_dir, agent_id) / STATE_NAME) or {}
        if saved.get('version'):
            remove_tree(self.version_dir(agent_id, str(saved['version'])))
        self._save(agent_id, 'failed', '', 0, view['message'], saved.get('version', ''), os.getpid())

    def start(self, agent_id):
        """Start the install, or attach to the one already running. Returns the status (with `attached` true when it was already running).
        Raises InstallRefused with one plain line when it cannot work."""
        entry = self.entry(agent_id)
        version = str(entry['version'])
        with self.guard:
            job = self.jobs.get(agent_id)
            if job and job.thread and job.thread.is_alive():
                return dict(read_status(self.state_dir, agent_id), attached=True)
            folder = self.version_dir(agent_id, version)
            if (folder / adapters.COMPLETE_MARKER).is_file():
                return self._save(agent_id, 'done', 'done', 100, '', version, os.getpid())
            node, npm_cli = self.preflight(agent_id, entry)
            if not self._take_lock(agent_id):
                return dict(read_status(self.state_dir, agent_id), attached=True)   # another process runs it: join that job
            try:
                if folder.exists() and not remove_tree(folder):
                    raise InstallRefused('The folder of an earlier unfinished install could not be removed. Close programs that use it and try again.')
                job = Job(agent_id, version, folder)
                self.jobs[agent_id] = job
                status = self._save(agent_id, 'running', 'preparing', 2, '', version, os.getpid())
                job.thread = threading.Thread(target=self._run, args=(job, entry, node, npm_cli), daemon=True, name=f'install-{agent_id}')
                job.thread.start()
            except BaseException:
                self._drop_lock(agent_id)
                raise
            return dict(status, attached=False)

    def cancel(self, agent_id):
        """Kill the install's whole process tree and delete its half-made folder. Returns the status (idle after a cancel)."""
        self.entry(agent_id)
        with self.guard:
            job = self.jobs.get(agent_id)
        if not job or not job.thread or not job.thread.is_alive():
            return self.status(agent_id)
        with job.guard:
            job.cancelled = True
            job.cancel_event.set()
            if job.tree is not None:
                job.tree.kill()
        job.thread.join(60)
        return read_status(self.state_dir, agent_id)

    # ---- the lock file ------------------------------------------------------------------------------------------------
    def _lock_path(self, agent_id):
        return agent_dir(self.state_dir, agent_id) / LOCK_NAME

    def _take_lock(self, agent_id):
        """Create install.lock exclusively with our pid. False when a live process holds it. A lock of a dead process is taken over."""
        path = self._lock_path(agent_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        for _ in range(3):
            try:
                handle = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            except FileExistsError:
                held = _read_json(path) or {}
                holder = held.get('pid')
                mine_idle = holder == os.getpid() and not (self.jobs.get(agent_id) and self.jobs[agent_id].thread and self.jobs[agent_id].thread.is_alive())
                if pid_alive(holder) and not mine_idle:
                    return False
                try:
                    path.unlink()
                except OSError:
                    time.sleep(0.1)
                continue
            with os.fdopen(handle, 'w', encoding='utf-8') as out:
                json.dump({'pid': os.getpid(), 'at': time.time()}, out)
            return True
        return False

    def _drop_lock(self, agent_id):
        path = self._lock_path(agent_id)
        if (_read_json(path) or {}).get('pid') == os.getpid():
            try:
                path.unlink()
            except OSError:
                pass

    # ---- the job ------------------------------------------------------------------------------------------------------
    def _save(self, agent_id, state, stage, percent, message, version, pid):
        data = {'state': state, 'stage': stage, 'percent': int(percent), 'message': message, 'version': version, 'pid': pid, 'updatedAt': time.time()}
        _write_json(agent_dir(self.state_dir, agent_id) / STATE_NAME, data)
        return {'agent': agent_id, 'state': state, 'stage': stage, 'percent': int(percent), 'message': message, 'version': version}

    def _progress(self, job, stage, percent):
        job.percent = max(job.percent, int(percent))   # never goes backwards
        self._save(job.agent_id, 'running', stage, job.percent, '', job.version, os.getpid())

    def _run(self, job, entry, node, npm_cli):
        agent_id, folder = job.agent_id, job.folder
        outcome, message = 'failed', 'The install stopped unexpectedly.'
        try:
            outcome, message = self._install(job, entry, node, npm_cli)
        except Exception as error:   # a job never takes the host down
            log.exception('Installing %s failed', agent_id)
            outcome, message = 'failed', f'The install stopped unexpectedly: {error}'
        finally:
            try:
                if outcome == 'cancelled':
                    if remove_tree(folder):
                        (agent_dir(self.state_dir, agent_id) / STATE_NAME).unlink(missing_ok=True)   # nothing left: the row is back to Install
                    else:
                        self._save(agent_id, 'failed', '', 0, 'The cancelled install left a folder that could not be removed.', job.version, os.getpid())
                elif outcome == 'failed':
                    remove_tree(folder)
                    self._save(agent_id, 'failed', '', job.percent, message, job.version, os.getpid())
                else:
                    self._save(agent_id, 'done', 'done', 100, '', job.version, os.getpid())
            finally:
                self._drop_lock(agent_id)

    def _install(self, job, entry, node, npm_cli):
        """Returns ('done'|'cancelled'|'failed', message)."""
        agent_id, folder, version = job.agent_id, job.folder, job.version
        package = str(entry['package'])
        lock_source = APP_ROOT / entry['lockfile'] if entry.get('lockfile') else None
        use_lock = bool(lock_source and lock_source.is_file())
        folder.mkdir(parents=True, exist_ok=True)
        (folder / 'package.json').write_text(json.dumps({'name': f'studio-agent-{agent_id}', 'version': '1.0.0', 'private': True,
                                                         'dependencies': {package: version}}, indent=2) + '\n', encoding='utf-8')
        if use_lock:
            shutil.copyfile(lock_source, folder / 'package-lock.json')
            command = [node, npm_cli, 'ci', '--prefix', str(folder)] + NPM_ARGS
        else:
            command = [node, npm_cli, 'install', f'{package}@{version}', '--prefix', str(folder)] + NPM_ARGS
        if job.cancel_event.is_set():
            return 'cancelled', ''
        self._progress(job, 'downloading', 8)
        env = {k: v for k, v in os.environ.items() if k.lower() not in ('npm_config_prefix', 'npm_config_global', 'npm_config_location')}
        env.update(npm_config_loglevel='error', npm_config_progress='false', npm_config_update_notifier='false', npm_config_fund='false', npm_config_audit='false')
        log_file = agent_dir(self.state_dir, agent_id) / LOG_NAME
        with open(log_file, 'wb') as out:
            process = subprocess.Popen(command, cwd=str(folder), env=env, stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT,
                                       creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0), start_new_session=(os.name != 'nt'))
            with job.guard:
                job.tree = ProcessTree(process)
                if job.cancel_event.is_set():
                    job.tree.kill()
            expected = max(1, int(entry.get('packageBytes') or 0))
            last_size = 0.0
            while process.poll() is None:
                if job.cancel_event.wait(POLL_SECONDS):
                    break
                if time.time() - last_size >= SIZE_EVERY_SECONDS:
                    last_size = time.time()
                    self._progress(job, 'downloading', 8 + 80 * min(1.0, folder_bytes(folder) / expected))
            try:
                process.wait(20)   # a killed tree is gone quickly; Windows needs a moment before its files can be deleted
            except subprocess.TimeoutExpired:
                job.tree.kill()
        if job.cancel_event.is_set():
            return 'cancelled', ''
        if process.returncode != 0:
            try:
                tail = log_file.read_text(encoding='utf-8', errors='replace')[-6000:]
            except OSError:
                tail = ''
            return 'failed', failure_line(tail, process.returncode)
        self._progress(job, 'verifying', 92)
        found = self._verify(folder, package, version)
        if found:
            return 'failed', found
        with job.guard:   # the marker is written last, and never after a cancel was accepted
            if job.cancelled:
                return 'cancelled', ''
            (folder / adapters.COMPLETE_MARKER).write_text(json.dumps({'package': package, 'version': version, 'finishedAt': time.time()}), encoding='utf-8')
        return 'done', ''

    @staticmethod
    def _verify(folder, package, version):
        """'' when the installed package is the pinned one and has a usable entry file inside the folder, else one plain line."""
        pkg = folder / 'node_modules' / pathlib.Path(*package.split('/'))
        known = next((p for p in adapters.STUDIO_PACKAGES.get('codex', ()) + adapters.STUDIO_PACKAGES.get('claude', ()) if p[0] == package), (package, ''))
        try:
            installed = json.loads((pkg / 'package.json').read_text(encoding='utf-8')).get('version')
        except (OSError, ValueError, AttributeError):
            return 'The download finished, but the adapter was not in it.'
        if installed != version:
            return f'npm installed version {installed}, not the reviewed version {version}.'
        if not adapters._package_entry(folder, known):
            return "The download finished, but the adapter's start file was not found."
        return ''
