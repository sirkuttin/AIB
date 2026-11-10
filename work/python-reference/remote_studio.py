"""The web server's side of the split mode: RemoteStudio (proxy to the agent host), host_command and attach_host.
Moved out of studio.py; behaviour unchanged."""
import os
import pathlib
import secrets
import sys
import threading
import time
import uuid
import host_client
import log_setup
import artifact_keys
from host_client import HostUnavailable
from state_store import ConversationState, ProjectPrefs, ReadState, SettingsStore
import app_paths
from app_paths import APP_ROOT
from studio_shared import settings_view, notices, conversation_action

HERE = APP_ROOT


class RemoteStudio:
    """The web server's view of the agent host: the same live_* interface as Studio, forwarded over the host RPC.

    It owns only web-side state (the page token, pin/archive marks). Conversations, adapter processes, leases and
    announcements live in the host, so this process can be restarted while turns run. It never closes connections."""
    host_mode = 'split'
    conversation_action = conversation_action
    settings_view = settings_view
    notices = notices

    def __init__(self, options, client=None, live=None, error=None):
        self.options = options
        self.token = secrets.token_urlsafe(32)
        log_setup.register_secret(self.token)
        self.web_instance_id = uuid.uuid4().hex
        self.lock = threading.RLock()
        self.state_dir = pathlib.Path(options.state_dir)
        self.conversations = ConversationState(self.state_dir)
        self.project_prefs = ProjectPrefs(self.state_dir)
        self.read_state = ReadState(self.state_dir)
        self.settings = SettingsStore(self.state_dir)
        self.command = host_command(options)
        artifact_keys.configure(self.state_dir)   # artifact tool (agent C): same shared secret as the agent host
        self.client, self.host_info, self.last_error, self.last_attempt = client, dict(live or {}), error, 0.0
        self.heartbeat_seconds = 10
        self.waiting_chats = error.chats if isinstance(error, host_client.HostBusy) else 0   # chats another AIB version still has working (takeover waits)
        self.yielded = False   # another version took our host over: never take it back (two versions would fight)
        self._stop = threading.Event()
        if client:
            self._attach()
        self._thread = threading.Thread(target=self._heartbeat, daemon=True, name='agent-studio-host-heartbeat')
        self._thread.start()

    instance_id = property(lambda self: self.host_info.get('hostId') or 'host-unavailable')

    def _attach_args(self):
        return {'pid': os.getpid(), 'webInstanceId': self.web_instance_id, 'port': getattr(self.options, 'port', None)}

    def _attach(self):
        try:
            self.client.call('attach', self._attach_args(), timeout=5)
        except (HostUnavailable, ValueError, RuntimeError, OSError):
            pass

    def _heartbeat(self):
        while not self._stop.wait(self.heartbeat_seconds):
            try:
                if self.client is None:
                    self._call('info', timeout=5)
                else:
                    self._call('attach', self._attach_args(), timeout=5)
            except (HostUnavailable, ValueError, RuntimeError, OSError):
                pass

    def _reattach(self, error):
        """The channel to the host failed before the request was sent: find the (new) host, or restart one that crashed."""
        with self.lock:
            info = host_client.read_info(self.state_dir)
            if info is None:
                if self.client is None and self.last_error is not None:
                    raise self.last_error
                raise HostUnavailable('The agent host is not running (it was stopped). Restart Agent Studio to start a new one; conversations that were open are listed for reconnecting.', 'host_stopped', False)
            same = self.client is not None and (info['port'], info['token']) == (self.client.port, self.client.token)
            if same and host_client.pid_alive(info.get('pid')):
                raise error  # alive but not accepting connections: do not start a second one
            if time.time() - self.last_attempt < 5 and self.last_error is not None:
                raise self.last_error
            self.last_attempt = time.time()
            # Take a host over only while waiting for our first one (startup found another version's busy host). A server that
            # already had a host and lost it to another version yields instead: taking it back would make the two fight forever.
            takeover = not self.yielded and self.client is None
            try:
                client, live = host_client.find_or_start(self.state_dir, self.command, say=lambda message: print(message, flush=True), takeover=takeover)
            except HostUnavailable as failure:
                self.last_error = failure
                self.waiting_chats = failure.chats if isinstance(failure, host_client.HostBusy) else 0
                if isinstance(failure, host_client.HostForeignRoot):
                    self.yielded = True
                    failure = host_client.HostForeignRoot(f'Another AIB version took over the agent host: {failure}. Restart this one to take it back when its chats are done.', failure.info)
                    self.last_error = failure
                if isinstance(failure, host_client.HostIncompatible):
                    self.client = None
                raise failure
            self.waiting_chats = 0
            self.client, self.host_info, self.last_error = client, live, None
            self._attach()
            return client

    def _call(self, op, args=None, timeout=30):
        client = self.client
        if client is None:
            client = self._reattach(self.last_error or HostUnavailable('The agent host is not available.'))
        try:
            return client.call(op, args, timeout)
        except HostUnavailable as error:
            if error.delivered:
                raise
            return self._reattach(error).call(op, args, timeout)

    @staticmethod
    def _permanent(error):
        return error.code in ('host_stopped', 'host_incompatible', 'host_waiting')

    def live_info(self):
        try:
            info = self._call('info', timeout=10)
        except HostUnavailable as error:
            if not self._permanent(error):
                raise
            return {'instanceId': 'host-unavailable', 'pid': None, 'durableRecovery': False, 'ownerAnnouncements': False, 'connections': [], 'unavailable': str(error)}
        self.host_info = info
        return info

    def busy_connections(self):
        """Chats the agent host has working, opening or waiting for a person (the update install waits for none). Raises when unknown."""
        return list(self._call('busy', timeout=10).get('busy') or [])

    def live_list(self):
        try:
            return self._call('list', timeout=20)
        except HostUnavailable as error:
            if not self._permanent(error):
                raise
            return {'connections': [], 'recovered': [], 'recoveryWarning': str(error), 'instanceId': 'host-unavailable'}

    def live_state(self, connection_id, after=0):
        return self._call('state', {'id': connection_id, 'after': int(after)}, timeout=20)

    def live_writes(self):
        try:
            return self._call('writes', timeout=10)
        except (HostUnavailable, ValueError, RuntimeError, OSError):
            return {}   # an older host without the 'writes' op, or no host: nothing is attached until it is restarted

    def emit_artifact(self, conversation_id, data):
        try:
            return bool(self._call('artifact', {'conversationId': conversation_id, 'data': data}, timeout=10))
        except (HostUnavailable, ValueError, RuntimeError, OSError):
            return False   # an older host without the 'artifact' op: the page falls back to polling /api/live/artifacts

    def live_call(self, name, body):
        status, payload = self._call('live', {'name': name, 'body': body}, timeout=150 if name in ('connect', 'discover') else 60)
        return status, payload

    def install_call(self, action, agent_id):
        """Agent install job (agent_installer.py): it runs in the agent host, which outlives this web server. Returns (HTTP status, payload)."""
        status, payload = self._call('install', {'action': action, 'agent': agent_id}, timeout=90 if action == 'cancel' else 60)
        return status, payload

    def signin_call(self, action, agent_id, force=False):
        """Sign-in check and Sign in job (agent_signin.py): it runs in the agent host, which outlives this web server. Returns (HTTP status, payload)."""
        status, payload = self._call('signin', {'action': action, 'agent': agent_id, 'force': bool(force)}, timeout=90 if action in ('cancel', 'check') else 60)
        return status, payload

    def ownership_query(self, provider='', session_id='', cwd=''):
        return self._call('ownership', {'provider': provider, 'id': session_id, 'cwd': cwd}, timeout=30)

    def _studio_owns(self, provider, session_id):
        return any(c.get('provider') == provider and c.get('sessionId') == session_id and not c.get('closed') for c in self.live_list()['connections'])

    def close(self):
        """Detach only. The host and its conversations keep running."""
        if self._stop.is_set():
            return
        self._stop.set()
        if self.client is not None:
            try:
                self.client.call('detach', self._attach_args(), timeout=3)
            except (HostUnavailable, ValueError, RuntimeError, OSError):
                pass


def host_command(options):
    """The command line that starts an agent host configured like this web server."""
    command = [sys.executable, str(app_paths.CODE_DIR / 'agent_host.py'), '--state-dir', str(options.state_dir), '--omp-sessions', str(options.omp_sessions),
               '--claude-projects', str(options.claude_projects), '--omp-command', str(options.omp_command), '--node-command', str(options.node_command),
               '--claude-launcher', str(options.claude_launcher or ''), '--codex-launcher', str(getattr(options, 'codex_launcher', '') or '')]
    if not getattr(options, 'auto_reconnect', True):
        command.append('--no-auto-reconnect')
    command += ['--no-owner-announcements'] if not options.owners_dir else ['--owners-dir', str(options.owners_dir)]
    if getattr(options, 'no_artifact_tool', False):
        command.append('--no-artifact-tool')
    if options.enable_client_terminal:
        command.append('--enable-client-terminal')
    if options.enable_client_fs:
        command += ['--enable-client-fs', options.enable_client_fs]
    if options.mcp_config:
        command += ['--mcp-config', str(options.mcp_config.resolve())]
    command += ['--host-port', str(getattr(options, 'host_port', 0)), '--idle-exit-minutes', str(getattr(options, 'host_idle_minutes', 30))]
    return command


def attach_host(options):
    """Find the running agent host for options.state_dir or start one detached. Returns a RemoteStudio (degraded, with a clear message, when the host is unusable)."""
    say = lambda message: print(message, flush=True)
    try:
        client, live = host_client.find_or_start(options.state_dir, host_command(options), say=say)  # takes over another version's idle host
    except HostUnavailable as error:
        print(f'WARNING: {error}', file=sys.stderr, flush=True)
        return RemoteStudio(options, None, None, error)
    wanted = {'ompCommand': options.omp_command, 'nodeCommand': options.node_command, 'claudeLauncher': options.claude_launcher,
              'enableClientTerminal': bool(options.enable_client_terminal), 'enableClientFs': options.enable_client_fs}
    started = live.get('startedWith') or {}
    differs = [k for k, v in wanted.items() if k in started and started[k] != v]
    if differs:
        say('Note: the agent host that is already running was started with different settings (' + ', '.join(differs) + '); it keeps its own. Run --stop-host to apply new ones.')
    return RemoteStudio(options, client, live)
