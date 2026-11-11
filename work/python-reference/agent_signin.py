"""Sign-in check and Sign in button of the built-in agents (Claude Code, Codex). Studio never reads, copies or stores a credential: the agent's
own login runs, and Studio only learns "signed in" / "signed out" from the agent's own status command.

  Status   Claude: `node <entry> --cli auth status --json` (the adapter hands `--cli` to the Claude program). Only whether a login exists is read
           (`kind`, or `loggedIn` / `apiKeySource` / `apiProvider`); the email, plan and organisation in the output are ignored. Never a
           throwaway `session/new`: that would leave a transcript that shows up as a chat. Codex has no status command, so it stays "Not checked"
           until a chat opens and says it needs sign-in.
  Cache    <state_dir>/agents/<id>/signin.json {state: ready|signin|unknown, checkedAt}. Settings reads it from disk; it is refreshed when Settings
           opens (at most once a minute) and by "Check again", never on every settings poll.
  Sign in  A one-off `initialize` (no session) reads the methods the agent advertises. A `terminal` method (Claude's `claude-ai-login`) is run by
           Studio itself: the adapter with the method's args, in a visible console window on Windows, waiting for exit code 0. ACP `authenticate` is
           NEVER sent for a terminal method (the spec forbids it). An `agent` method (Codex's `chatgpt`) is the one case where `authenticate` is sent,
           on that same one-off process, and the agent opens the browser. On macOS / Linux the terminal command is shown instead of started.
  Job      <state_dir>/agents/<id>/signin-job.json {state: waiting|failed|done|manual, message, command, pid}; the job runs in the agent host.
"""
import json
import logging
import os
import pathlib
import queue
import subprocess
import threading
import time

import adapters
from agent_installer import _read_json, _write_json, agent_dir
from host_client import pid_alive
from process_tree import ProcessTree

log = logging.getLogger(__name__)

CACHE_NAME, JOB_NAME = 'signin.json', 'signin-job.json'
CACHE_SECONDS = 60               # opening Settings again within a minute does not run the status command again
STATUS_TIMEOUT = 20
HANDSHAKE_TIMEOUT = 40
AUTHENTICATE_TIMEOUT = 15 * 60   # an agent method: the user finishes it in the browser
CONSOLE_TIMEOUT = 15 * 60
PREFERRED_METHOD = {'claude': 'claude-ai-login', 'codex': 'chatgpt'}
DEFAULT_TERMINAL = {'claude': ('claude-ai-login', ['--cli', 'auth', 'login', '--claudeai'])}   # when the agent advertises nothing usable
NAMES = {'claude': 'Claude Code', 'codex': 'Codex'}
CONSOLE_FLAGS = getattr(subprocess, 'CREATE_NEW_CONSOLE', 0)   # Windows: the login gets its own visible console window
QUIET_FLAGS = getattr(subprocess, 'CREATE_NO_WINDOW', 0)


class SignInRefused(ValueError):
    """The request cannot be done (unknown agent, not installed, ...). The message is the one plain line the page shows."""
    code = 'signin_refused'


def parse_status(text):
    """'ready' | 'signin' | 'unknown' from the output of `auth status --json`. Reads only whether a login exists, never who it is."""
    try:
        data = json.loads(text or '')
    except ValueError:
        return 'unknown'
    if not isinstance(data, dict):
        return 'unknown'
    kind = data.get('kind')
    if isinstance(kind, str) and kind:
        return 'signin' if kind == 'none' else 'ready'
    if not isinstance(data.get('loggedIn'), bool):
        return 'unknown'
    external = bool(data.get('apiProvider')) and data.get('apiProvider') != 'firstParty'   # Bedrock, Vertex...: the login lives outside the agent
    return 'ready' if data['loggedIn'] or data.get('apiKeySource') or external else 'signin'


def read_cached(state_dir, agent_id):
    saved = _read_json(agent_dir(state_dir, agent_id) / CACHE_NAME) or {}
    state = saved.get('state') if saved.get('state') in ('ready', 'signin') else 'unknown'
    return {'state': state, 'checkedAt': float(saved.get('checkedAt') or 0)}


def read_job(state_dir, agent_id):
    """The sign-in job as the page sees it, from disk only: {agent, state: idle|waiting|failed|done|manual, message, command}.
    A waiting job whose process has died (the host was restarted) is reported as failed."""
    saved = _read_json(agent_dir(state_dir, agent_id) / JOB_NAME)
    if not saved or saved.get('state') not in ('waiting', 'failed', 'done', 'manual'):
        return {'agent': agent_id, 'state': 'idle', 'message': '', 'command': ''}
    out = {'agent': agent_id, 'state': saved['state'], 'message': str(saved.get('message') or ''), 'command': str(saved.get('command') or '')}
    if out['state'] == 'waiting' and not pid_alive(saved.get('pid')):
        out.update(state='failed', message='The sign-in was interrupted before it finished. Try again.')
    return out


def effective_state(cached_state, live_status=''):
    """What the Status column shows: a chat that is open now knows best ('signin' = it is waiting for sign-in, 'running' = it works)."""
    if live_status == 'signin':
        return 'signin'
    if live_status == 'running':
        return 'ready'
    return cached_state if cached_state in ('ready', 'signin') else 'unknown'


def normalize_methods(raw):
    """[{id, name, kind: 'terminal'|'agent', args}] from initialize.authMethods; methods Studio cannot start (env vars, unknown types) are dropped."""
    out = []
    for item in raw[:20] if isinstance(raw, list) else []:
        if not isinstance(item, dict) or not isinstance(item.get('id'), str) or not item['id'] or len(item['id']) > 256:
            continue
        kind = {None: 'agent', 'agent': 'agent', 'terminal': 'terminal'}.get(item.get('type'))
        if not kind:
            continue
        args = item.get('args')
        ok = isinstance(args, list) and 0 < len(args) <= 12 and all(isinstance(a, str) and 0 < len(a) <= 200 and '\n' not in a and '\r' not in a for a in args)
        out.append({'id': item['id'], 'name': str(item.get('name') or item['id'])[:80], 'kind': kind, 'args': list(args) if ok and kind == 'terminal' else []})
    return out


def choose_method(agent_id, methods):
    """The method the Sign in button runs: the agent's usual one when advertised, else the first one Studio can start. None when there is none."""
    for method in methods:
        if method['id'] == PREFERRED_METHOD.get(agent_id):
            return method
    return methods[0] if methods else None


class HandshakeError(RuntimeError):
    pass


class Handshake:
    """One short-lived adapter process spoken to over ACP stdio. It only reads `initialize.authMethods` (and, for an `agent` method, sends `authenticate`);
    it never creates a session, so no transcript is written."""

    def __init__(self, argv, env, flags=QUIET_FLAGS):
        self.process = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env,
                                        creationflags=flags, start_new_session=(os.name != 'nt'))
        self.tree = ProcessTree(self.process)
        self.lines = queue.Queue()
        self.next_id = 0
        threading.Thread(target=self._pump, daemon=True, name='signin-handshake').start()

    def _pump(self):
        try:
            for raw in self.process.stdout:
                self.lines.put(raw)
        except (OSError, ValueError):
            pass
        self.lines.put(None)

    def _send(self, message):
        try:
            self.process.stdin.write((json.dumps(dict(message, jsonrpc='2.0')) + '\n').encode('utf-8'))
            self.process.stdin.flush()
        except (OSError, ValueError) as error:
            raise HandshakeError('The agent stopped before it answered.') from error

    def request(self, method, params, timeout, cancel=None):
        self.next_id += 1
        mine = self.next_id
        self._send({'id': mine, 'method': method, 'params': params})
        deadline = time.time() + timeout
        while True:
            if cancel is not None and cancel.is_set():
                raise HandshakeError('cancelled')
            if time.time() > deadline:
                raise HandshakeError('The agent did not answer in time.')
            try:
                raw = self.lines.get(timeout=0.25)
            except queue.Empty:
                continue
            if raw is None:
                raise HandshakeError('The agent stopped before it answered.')
            try:
                message = json.loads(raw)
            except ValueError:
                continue
            if not isinstance(message, dict):
                continue
            if 'method' in message and 'id' in message:   # the agent asks the client for something: this client offers nothing
                self._send({'id': message['id'], 'error': {'code': -32601, 'message': 'Method not found'}})
            elif message.get('id') == mine and 'method' not in message:
                if isinstance(message.get('error'), dict):
                    raise HandshakeError(str(message['error'].get('message') or 'The agent refused.')[:200])
                return message.get('result')

    def close(self):
        self.tree.kill()
        try:
            self.process.wait(10)
        except subprocess.TimeoutExpired:
            pass
        for pipe in (self.process.stdin, self.process.stdout):
            try:
                pipe.close()
            except (OSError, ValueError):
                pass


def _spawn_console(argv, env):
    """The login in its own visible console window (Windows). Injectable so tests never open a window."""
    return subprocess.Popen(argv, env=env, stdin=None, creationflags=CONSOLE_FLAGS)


class Job:
    def __init__(self, agent_id):
        self.agent_id = agent_id
        self.cancel_event = threading.Event()
        self.guard = threading.Lock()
        self.tree = None
        self.thread = None


class Signer:
    """One per process that runs sign-ins (the agent host; the in-process Studio of tests and demos).
    `launch(agent_id)` returns {argv, found, problem} like studio_shared.builtin_launch."""

    def __init__(self, state_dir, launch, spawn_console=None, handshake_flags=QUIET_FLAGS, system_is_windows=None):
        self.state_dir = pathlib.Path(state_dir)
        self.launch = launch
        self.spawn_console = spawn_console or _spawn_console
        self.handshake_flags = handshake_flags
        self.windows = (os.name == 'nt') if system_is_windows is None else system_is_windows
        self.jobs = {}
        self.guard = threading.RLock()
        self.check_locks = {}

    # ---- helpers ------------------------------------------------------------------------------------------------------
    def _agent(self, agent_id):
        if not isinstance(agent_id, str) or agent_id not in adapters.STUDIO_PACKAGES:
            raise SignInRefused('AIB cannot check or start a sign-in for that agent.')
        return agent_id

    def _argv(self, agent_id):
        row = self.launch(agent_id)
        return list(row['argv']) if row and row.get('found') and row.get('argv') else None

    def _env(self):
        return dict(os.environ)

    def _write_cache(self, agent_id, state):
        now = time.time()
        _write_json(agent_dir(self.state_dir, agent_id) / CACHE_NAME, {'state': state, 'checkedAt': now})
        return now

    def _write_job(self, agent_id, state, message='', command='', pid=None):
        _write_json(agent_dir(self.state_dir, agent_id) / JOB_NAME,
                    {'state': state, 'message': message, 'command': command, 'pid': pid if pid is not None else os.getpid(), 'updatedAt': time.time()})

    def _clear_job(self, agent_id):
        (agent_dir(self.state_dir, agent_id) / JOB_NAME).unlink(missing_ok=True)

    # ---- status -------------------------------------------------------------------------------------------------------
    def probe(self, agent_id, argv):
        """Run the agent's own status command. 'ready' | 'signin' | 'unknown' (Codex has none; a timeout or unreadable output is unknown)."""
        if agent_id != 'claude':
            return 'unknown'
        try:
            process = subprocess.Popen(argv + ['--cli', 'auth', 'status', '--json'], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                       env=self._env(), creationflags=QUIET_FLAGS, start_new_session=(os.name != 'nt'))
        except OSError:
            return 'unknown'
        tree = ProcessTree(process)
        try:
            out, _ = process.communicate(timeout=STATUS_TIMEOUT)   # logged out exits 1 and still prints the JSON
        except subprocess.TimeoutExpired:
            tree.kill()
            process.communicate()
            return 'unknown'
        return parse_status(out.decode('utf-8', 'replace'))

    def check(self, agent_id, force=False):
        """Refresh the cached state unless it is younger than CACHE_SECONDS (force=True ignores that). Returns {agent, state, checkedAt, checked}."""
        self._agent(agent_id)
        with self.guard:
            lock = self.check_locks.setdefault(agent_id, threading.Lock())
        with lock:
            cached = read_cached(self.state_dir, agent_id)
            argv = self._argv(agent_id)
            if argv is None:   # not installed: nothing to check, and an old answer would be stale
                (agent_dir(self.state_dir, agent_id) / CACHE_NAME).unlink(missing_ok=True)
                return {'agent': agent_id, 'state': 'unknown', 'checkedAt': 0.0, 'checked': False}
            if force:
                job = read_job(self.state_dir, agent_id)
                if job['state'] in ('manual', 'done', 'failed'):
                    self._clear_job(agent_id)
            if agent_id != 'claude' or (not force and cached['checkedAt'] and time.time() - cached['checkedAt'] < CACHE_SECONDS):
                return dict(cached, agent=agent_id, checked=False)
            state = self.probe(agent_id, argv)
            checked_at = self._write_cache(agent_id, state)
            return {'agent': agent_id, 'state': state, 'checkedAt': checked_at, 'checked': True}

    def status(self, agent_id):
        self._agent(agent_id)
        return dict(read_cached(self.state_dir, agent_id), agent=agent_id, job=read_job(self.state_dir, agent_id))

    # ---- the sign-in job ----------------------------------------------------------------------------------------------
    def start(self, agent_id):
        """Start the agent's own login, or join the one already running. Returns the job view; raises SignInRefused when it cannot start."""
        self._agent(agent_id)
        with self.guard:
            job = self.jobs.get(agent_id)
            if job and job.thread and job.thread.is_alive():
                return dict(read_job(self.state_dir, agent_id), attached=True)
            argv = self._argv(agent_id)
            if argv is None:
                row = self.launch(agent_id) or {}
                raise SignInRefused(f"{NAMES[agent_id]} is not installed yet, so there is nothing to sign in to. {row.get('problem') or ''}".strip())
            job = Job(agent_id)
            self.jobs[agent_id] = job
            self._write_job(agent_id, 'waiting')
            job.thread = threading.Thread(target=self._run, args=(job, argv), daemon=True, name=f'signin-{agent_id}')
            job.thread.start()
        return dict(read_job(self.state_dir, agent_id), attached=False)

    def cancel(self, agent_id):
        """Kill the login's whole process tree (the console window closes with it). Returns the job view (idle after a cancel)."""
        self._agent(agent_id)
        with self.guard:
            job = self.jobs.get(agent_id)
        if job and job.thread and job.thread.is_alive():
            with job.guard:
                job.cancel_event.set()
                if job.tree is not None:
                    job.tree.kill()
            job.thread.join(30)
        elif read_job(self.state_dir, agent_id)['state'] in ('manual', 'failed', 'done'):
            self._clear_job(agent_id)
        return read_job(self.state_dir, agent_id)

    def _run(self, job, argv):
        agent_id = job.agent_id
        outcome, message, command = 'failed', 'The sign-in stopped unexpectedly.', ''
        try:
            outcome, message, command = self._sign_in(job, argv)
        except Exception as error:   # a job never takes the host down
            log.exception('Signing in to %s failed', agent_id)
            outcome, message = 'failed', f'The sign-in stopped unexpectedly: {error}'
        finally:
            if outcome == 'cancelled':
                self._clear_job(agent_id)
            else:
                self._write_job(agent_id, outcome, message, command)

    def _track(self, job, tree):
        with job.guard:
            job.tree = tree
            if job.cancel_event.is_set():
                tree.kill()

    def _sign_in(self, job, argv):
        """Returns (outcome 'done'|'failed'|'cancelled'|'manual', message, command)."""
        agent_id, name = job.agent_id, NAMES[job.agent_id]
        env = self._env()
        methods = []
        handshake = None
        try:
            handshake = Handshake(argv, env, self.handshake_flags)
            self._track(job, handshake.tree)
            init = handshake.request('initialize', {'protocolVersion': 1, 'clientInfo': {'name': 'agent-studio', 'title': 'AIB', 'version': '0.1.0'},
                                                    'clientCapabilities': {'fs': {'readTextFile': False, 'writeTextFile': False}, 'terminal': False, 'auth': {'terminal': True}}},
                                     HANDSHAKE_TIMEOUT, job.cancel_event)
            methods = normalize_methods(init.get('authMethods') if isinstance(init, dict) else None)
        except HandshakeError as error:
            if job.cancel_event.is_set():
                return 'cancelled', '', ''
            log.info('Reading the sign-in methods of %s failed: %s', agent_id, error)
        method = choose_method(agent_id, methods)
        if method is None and agent_id in DEFAULT_TERMINAL:   # nothing usable advertised: the documented login of this adapter
            method = {'id': DEFAULT_TERMINAL[agent_id][0], 'kind': 'terminal', 'args': list(DEFAULT_TERMINAL[agent_id][1])}
        if method is not None and method['kind'] == 'terminal' and not method['args'] and agent_id in DEFAULT_TERMINAL:
            method = dict(method, args=list(DEFAULT_TERMINAL[agent_id][1]))
        if method is None or (method['kind'] == 'terminal' and not method['args']):
            if handshake:
                handshake.close()
            return 'failed', f'{name} did not offer a sign-in that AIB can start. Sign in with the {name} program itself, then choose Check again.', ''
        if method['kind'] == 'agent':   # the only case where ACP `authenticate` is sent: the agent opens the browser itself
            try:
                handshake.request('authenticate', {'methodId': method['id']}, AUTHENTICATE_TIMEOUT, job.cancel_event)
            except HandshakeError as error:
                if job.cancel_event.is_set():
                    return 'cancelled', '', ''
                return 'failed', f'{name} did not sign in: {error}', ''
            finally:
                handshake.close()
            self._write_cache(agent_id, 'ready')
            return 'done', '', ''
        handshake.close()   # a terminal method: never `authenticate`; run the adapter with the method's own args instead
        command = argv + method['args']
        shown = ' '.join(f'"{part}"' if ' ' in part else part for part in command)
        if not self.windows:
            return 'manual', 'Run this in a terminal, finish the sign-in there, then choose Check again.', shown
        process = self.spawn_console(command, env)
        self._track(job, ProcessTree(process))
        deadline = time.time() + CONSOLE_TIMEOUT
        while process.poll() is None:
            if job.cancel_event.wait(0.4):
                return 'cancelled', '', ''
            if time.time() > deadline:
                job.tree.kill()
                return 'failed', 'The sign-in window was open for too long and was closed. Try again.', ''
        code = process.returncode
        state = self.probe(agent_id, argv) if agent_id == 'claude' else ('ready' if code == 0 else 'unknown')   # re-check when the process exits
        self._write_cache(agent_id, state)
        if code != 0:
            return 'failed', f'The sign-in did not finish (it ended with code {code}). Try again.', ''
        if state == 'signin':
            return 'failed', f'The sign-in window closed, but {name} still shows as signed out. Try again.', ''
        return 'done', '', ''
