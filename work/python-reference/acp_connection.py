"""The ACP side of Agent Studio: Connection, one agent process spoken to over JSON-RPC on stdio.
Moved out of studio.py; behaviour unchanged."""
import collections
import datetime
import json
import hashlib
import re
import os
import pathlib
import secrets
import subprocess
import threading
import time
import traceback
import uuid
import elicitation
import acp_schema
import breadth
import msgqueue
import client_caps
import artifacts
import worktrees
from process_tree import ProcessTree
from rpc_errors import PromptStateUnknown, RpcError, describe_auth_methods, is_auth_required
from attachments import (MAX_EVENT_IMAGE_BYTES, MAX_TOTAL_ATTACHMENT_BYTES, split_attachments, validate_image_attachments,
                         validate_file_attachments, map_file_attachments, _event_image_size)
import app_paths
from app_paths import APP_ROOT
from version import __version__
import logging

log = logging.getLogger(__name__)
log.addHandler(logging.NullHandler())   # a library logger: quiet until main() configures logging (log_setup.py)

HERE = APP_ROOT
MAX_EVENTS = 6000


def _is_fixture(command):
    fixtures = app_paths.TESTS_DIR.resolve()
    for part in command if isinstance(command, (list, tuple)) else [command]:
        try:
            if fixtures in pathlib.Path(str(part)).resolve().parents:
                return True
        except (OSError, ValueError):
            continue
    return False


def _guard_real_agent(command):
    """Under test (AGENT_STUDIO_TEST=1, set by work/_isolation.py) a Connection may only start a fixture from the repo's work/ folder.
    Anything else would launch a real agent, so it fails loudly. STUDIO_REAL_ADAPTER_TESTS=1 (opt-in real-adapter tests) or AGENT_STUDIO_ALLOW_REAL_AGENT=1 (one test says so on purpose) lifts it."""
    if os.environ.get('AGENT_STUDIO_TEST') != '1' or os.environ.get('STUDIO_REAL_ADAPTER_TESTS') == '1' or os.environ.get('AGENT_STUDIO_ALLOW_REAL_AGENT') == '1':
        return
    if _is_fixture(command):
        return
    raise RuntimeError(f'Test guard: refusing to start a real agent process: {command!r}. Pass connection_factory= to Studio, or use a fixture under work/.')


_TEST_HOME = []
HOME_VARS = ('HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'APPDATA', 'LOCALAPPDATA')


def _test_home_env(command):
    """Under test, a real (non-fixture) agent gets a throwaway home so it can never write into the owner's ~/.claude. {} otherwise."""
    if os.environ.get('AGENT_STUDIO_TEST') != '1' or _is_fixture(command):
        return {}
    if not _TEST_HOME:
        import atexit
        import shutil
        import tempfile
        folder = tempfile.mkdtemp(prefix='agent-studio-test-home-')
        atexit.register(shutil.rmtree, folder, True)
        _TEST_HOME.append(folder)
    return {name: _TEST_HOME[0] for name in HOME_VARS}


class Connection:
    def __init__(self, command, cwd, provider, enable_terminal=False, enable_fs=None, env=None, start=True):
        _guard_real_agent(command)
        self.id = uuid.uuid4().hex
        self.provider, self.cwd = provider, str(cwd)
        self.worktree = None   # {'branch', 'base'} of a chat that runs in its own git worktree (stage B)
        found = worktrees.project_of_worktree(self.cwd)   # a chat in any app's git worktree belongs to the main checkout
        self.project_root = found['project'] if found else self.cwd   # the project this chat belongs to; a worktree chat's cwd differs from it
        self.session_id = None
        self.events = collections.deque()
        self.event_image_bytes = 0
        self.permissions = {}
        self.elicitations = {}
        self.withdrawn = collections.OrderedDict()
        self.auth, self.auth_methods, self.auth_response, self.auth_event = None, [], None, threading.Event()
        self.setup_abort = ''
        self.known_sessions = set()
        self.pending = {}
        self.counter = 0
        self.sequence = 0
        self.busy = False
        self.turn_ended_at = None   # wall-clock time of the last turn_end event (attention summary)
        self.turn_started_at = None  # wall-clock time the current prompt turn started (attention busySince)
        self.closed = False
        self.initial = {}
        self.image_supported = False
        self.prompt_caps = {'image': False, 'audio': False, 'embeddedContext': False}
        self.settings = {}
        self.pending_changes = collections.OrderedDict()  # setting key -> change queued during a turn; the host owns it (survives web-server restarts)
        self.change_failures = []                         # last few queued changes the agent refused: {seq, key, ..., message, time}
        self.change_seq = 0
        self.breadth = breadth.new_state()
        self.mcp_servers = []
        self.error = ''
        self.ready = False
        self.prompt_receipts = collections.OrderedDict()
        self.queue = msgqueue.MessageQueue()  # messages written while the agent works; the host owns it (see msgqueue.py)
        self.recovery = None        # Recovery hook installed by Studio; None in standalone use
        self.persisted = False      # True once this connection is in the durable recovery list
        self.writes = artifacts.WriteTracker(cwd)   # files this agent wrote: the only way a file becomes this chat's artifact
        self.subagents = {}         # child sessionId -> latest announcement (title, description, capabilities, state)
        self.session_lease = None
        self.on_turn_end = None     # Studio hook: the agent finished a turn, so it is the user's turn
        self.prompt_seq = 0         # number of the latest prompt() accepted
        self.cancel_seq = 0         # cancel() cancels every prompt up to this number (one still before its send is dropped; later ones go through)
        self.on_turn_start = None   # Studio hook (worktree live sync): called on the turn's thread before the prompt is sent
        self.context_for_prompt = None   # Studio hook: connection -> (text, token) or None, a note sent as an extra text block in front of the prompt
        self.context_sent = None    # Studio hook: (connection, token) once the prompt went through; the note is not sent again
        self.on_release = None      # Studio hook: withdraw the owner announcement when the conversation stops
        self.stderr = collections.deque(maxlen=30)
        self.lock = threading.RLock()
        self.write_lock = threading.Lock()
        self.caps = client_caps.ClientCaps(cwd, enable_terminal, enable_fs, lambda sid: sid in self.known_sessions, self.event, self.write)  # opt-in, off by default
        self.open_done = threading.Event()
        # command is always a list (never a shell string). env: extra variables for an agent the user added in Settings.
        self.command, self.env = command, env
        self.closed_at = None
        self.process = self.tree = self.read_thread = self.error_thread = None
        if start:   # start=False: the chat's worktree is still being made; the agent starts with start_process() once its folder exists
            self.start_process()

    def retarget(self, cwd):
        """Change the folder of an agent that has not started yet (a worktree that could not be made: the chat works in place)."""
        if self.process is not None:
            raise RuntimeError('The agent already started')
        self.cwd = str(cwd)
        self.caps.workspace = self.cwd
        self.writes.cwd = self.cwd

    def start_process(self):
        command, cwd, env = self.command, self.cwd, self.env
        self.process = subprocess.Popen(command, cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env=dict(os.environ, **_test_home_env(command), **(env or {})) if (env or _test_home_env(command)) else None, text=True, encoding='utf-8', errors='replace', bufsize=1, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
            start_new_session=(os.name != 'nt'))   # own process group on POSIX so close() can reach the agent's children
        self.tree = ProcessTree(self.process)
        self.read_thread = threading.Thread(target=self.read, daemon=True)
        self.error_thread = threading.Thread(target=self.read_errors, daemon=True)
        self.read_thread.start()
        self.error_thread.start()

    def event(self, kind, data):
        with self.lock:
            self.sequence += 1
            item = {'seq': self.sequence, 'kind': kind, 'data': data, 'time': time.time()}
            if kind == 'update' and not self.ready and self.session_id:
                item['replay'] = True   # history the agent re-sends on session/load: 'time' is the reconnect, not when it was said
            if len(self.events) >= MAX_EVENTS:
                self.event_image_bytes -= _event_image_size(self.events.popleft())
            self.events.append(item)
            self.event_image_bytes += _event_image_size(item)
            if kind == 'update':
                self._track_subagent(data)
            while self.event_image_bytes > MAX_EVENT_IMAGE_BYTES and len(self.events) > 1:
                self.event_image_bytes -= _event_image_size(self.events.popleft())

    def _track_subagent(self, params):
        """Remember what the agent says each child can do (RFD form: capabilities.cancel)."""
        update = params.get('update') if isinstance(params, dict) else None
        if not isinstance(update, dict) or update.get('sessionUpdate') != 'subagent_update':
            return
        child = update.get('sessionId')
        if not isinstance(child, str) or not child or child == self.session_id:
            return
        entry = self.subagents.setdefault(child, {'capabilities': {}})
        for name in ('title', 'description'):
            if isinstance(update.get(name), str) and update[name].strip():
                entry[name] = update[name][:500]
        if isinstance(update.get('capabilities'), dict):
            entry['capabilities'] = update['capabilities']
        state = update.get('state')
        state = state.get('state') if isinstance(state, dict) else state
        if isinstance(state, str):
            entry['state'] = state
        while len(self.subagents) > 200:
            self.subagents.pop(next(iter(self.subagents)))

    def write(self, message):
        with self.write_lock:
            self.process.stdin.write(json.dumps(message, ensure_ascii=False) + '\n')
            self.process.stdin.flush()

    def request(self, method, params, timeout=30):
        if method == 'initialize':
            params = breadth.augment_initialize(params)
        with self.lock:
            self.counter += 1
            key = self.counter
            entry = {'done': threading.Event(), 'method': method, 'params': params}
            self.pending[key] = entry
        try:
            self.write({'jsonrpc': '2.0', 'id': key, 'method': method, 'params': params})
            if not entry['done'].wait(timeout):
                raise TimeoutError(f'{method} did not respond within {timeout} seconds')
            result = entry['response']
            if 'error' in result:
                raise RuntimeError(result['error'].get('message', str(result['error'])))
            return result.get('result', {})
        finally:
            with self.lock:
                self.pending.pop(key, None)

    def read_errors(self):
        for line in self.process.stderr:
            self.stderr.append(line.rstrip()[:2000])

    def read(self):
        failure = ''
        try:
            for line in self.process.stdout:
                message = acp_schema.screen(self, line)
                if message is None:
                    continue
                if 'method' not in message:
                    with self.lock:
                        waiting = self.pending.get(message.get('id'))
                        if waiting:
                            waiting['response'] = message
                            waiting['done'].set()
                    continue
                method, params = message['method'], message.get('params', {})
                if 'id' in message:
                    if method == 'session/request_permission' and self._own_artifact_tool(params):
                        # Studio's own artifact tool only publishes into this chat; never make the user approve it.
                        allow = next((o for o in params.get('options', []) if isinstance(o, dict) and o.get('kind') == 'allow_once'), None)
                        if allow and isinstance(allow.get('optionId'), str):
                            self.write({'jsonrpc': '2.0', 'id': message['id'], 'result': {'outcome': {'outcome': 'selected', 'optionId': allow['optionId']}}})
                            continue
                    if method == 'session/request_permission':
                        key = secrets.token_hex(12)
                        with self.lock:
                            self.permissions[key] = {'rpcId': message['id'], 'params': params}
                        self.event('permission', {'key': key, 'params': params})
                    elif self.caps.handles(method):
                        self.caps.dispatch(message)
                    elif method == 'elicitation/create':
                        try:
                            self._receive_elicitation(message['id'], params)
                        except (ValueError, TypeError, KeyError) as error:
                            self.write({'jsonrpc': '2.0', 'id': message['id'], 'error': {'code': -32602, 'message': str(error)}})
                    else:
                        self.write({'jsonrpc': '2.0', 'id': message['id'], 'error': {'code': -32601, 'message': f'Client capability not advertised: {method}'}})
                elif method == 'session/update':
                    update = params.get('update', {})
                    with self.lock:
                        sid = params.get('sessionId')
                        if isinstance(sid, str) and sid:
                            self.known_sessions.add(sid)
                        # Some agents report subagent session IDs in update payloads.
                        for name in ('subagentSessionId', 'childSessionId'):
                            child = update.get(name)
                            if isinstance(child, str) and child:
                                self.known_sessions.add(child)
                        subagent = update.get('subagent')
                        if isinstance(subagent, dict) and isinstance(subagent.get('sessionId'), str) and subagent['sessionId']:
                            self.known_sessions.add(subagent['sessionId'])
                        if self.session_id is None or sid in (None, self.session_id):
                            breadth.apply_update(self.breadth, update, time.time())
                        if update.get('sessionUpdate') == 'config_option_update':
                            self.settings['configOptions'] = update.get('configOptions', [])
                        if update.get('sessionUpdate') == 'current_mode_update':
                            self.settings.setdefault('modes', {})['currentModeId'] = update.get('currentModeId')
                    self.writes.observe(params)
                    self.event('update', params)
                elif method == 'elicitation/complete':
                    self.complete_elicitation(params)
                elif method == '$/cancel_request':
                    request_id = params.get('requestId') if isinstance(params, dict) else None
                    self.cancel_incoming_request(request_id)
                else:
                    self.event('notice', {'method': method, 'params': params})
        except (OSError, ValueError) as error:
            self.error = str(error)
        except Exception as error:
            # A bug in one of our handlers must not leave a half-working connection behind: say what happened, then stop the agent.
            log.exception('Internal error while reading from the agent; closing the connection')
            trace = traceback.format_exc()
            self.traceback = trace
            for line in trace.rstrip().splitlines()[-12:]:
                self.stderr.append(line[:2000])
            failure = f'Studio hit an internal error while reading from the agent ({type(error).__name__}: {error}). The connection was closed; reconnect to continue.'
            self.error = failure
            try:
                self.tree.kill()
            except Exception:
                log.exception('Killing the agent process tree failed')
        finally:
            self.closed = True
            if self.closed_at is None:
                self.closed_at = time.time()
            self.ready = False
            self.busy = False
            with self.lock:
                self.permissions.clear()
                self.pending_changes.clear()
                self._clear_elicitations_locked()
                for entry in self.pending.values():
                    entry['response'] = {'error': {'message': failure or 'ACP connection closed. ' +'\n'.join(list(self.stderr)[-3:])}}
                    entry['done'].set()
            self.release_lease()
            self.caps.shutdown()
            self.event('disconnected', {'message': self.error or 'Agent connection closed'})

    def release_lease(self):
        with self.lock:
            lease, self.session_lease = self.session_lease, None
        if lease:
            lease.release()
        hook = self.on_release
        if hook:
            try:
                hook(self)
            except Exception:
                log.exception('on_release hook failed')

    def _paused_for_user(self):
        with self.lock:
            return bool(self.elicitations or self.permissions or (self.auth and not self.auth.get('working')))

    def _setup_request(self, method, params, timeout):
        """Like request(), but the timeout clock stops while a person is being asked something."""
        if method == 'initialize':
            params = breadth.augment_initialize(params)
        with self.lock:
            self.counter += 1
            key = self.counter
            entry = {'done': threading.Event(), 'method': method, 'params': params}
            self.pending[key] = entry
        try:
            self.write({'jsonrpc': '2.0', 'id': key, 'method': method, 'params': params})
            waited = 0.0
            while not entry['done'].wait(0.25):
                if not self._paused_for_user():
                    waited += 0.25
                if waited >= timeout:
                    raise TimeoutError(f'{method} did not respond within {timeout} seconds')
            response = entry['response']
            if 'error' in response:
                raise RpcError(response['error'])
            return response.get('result', {})
        finally:
            with self.lock:
                self.pending.pop(key, None)

    def _check_setup_abort(self):
        if self.setup_abort:
            raise ValueError(self.setup_abort)

    def _abort_setup(self, message):
        """Fail connection setup now (e.g. the person declined a setup question)."""
        with self.lock:
            self.setup_abort = self.setup_abort or message
            for entry in list(self.pending.values()):
                if not entry['done'].is_set():
                    entry['response'] = {'error': {'message': message, 'code': None}}
                    entry['done'].set()
            self.auth_response = ('cancel', None)
            self.auth_event.set()

    def _setup_session_call(self, method, params):
        for attempt in range(4):
            try:
                result = self._setup_request(method, params, 90)
                self._check_setup_abort()
                return result
            except RpcError as error:
                self._check_setup_abort()
                if not is_auth_required(error):
                    raise
                if attempt == 3:
                    raise ValueError('The agent still reports that sign-in is required. ' + str(error))
                self._await_auth(error)
        raise ValueError('Sign-in did not complete')

    def _await_auth(self, error):
        """Block connection setup until the person signs in, retries, or cancels."""
        with self.lock:
            self.auth = {'methods': list(self.auth_methods), 'message': str(error)[:500], 'error': '', 'working': False}
            self.auth_response = None
            self.auth_event.clear()
        self.event('auth_required', {'methods': self.auth['methods'], 'message': self.auth['message']})
        deadline = time.time() + 1800
        try:
            while True:
                if not self.auth_event.wait(0.25):
                    if self.closed:
                        raise RuntimeError('The agent disconnected while waiting for sign-in')
                    if time.time() > deadline:
                        raise ValueError('Sign-in timed out. The conversation was not opened.')
                    continue
                self.auth_event.clear()
                self._check_setup_abort()
                action, method_id = self.auth_response or ('cancel', None)
                if action == 'cancel':
                    raise ValueError('Sign-in was cancelled, so the conversation was not opened.')
                if action == 'retry':
                    return
                with self.lock:
                    self.auth['working'], self.auth['error'] = True, ''
                try:
                    self._setup_request('authenticate', {'methodId': method_id}, 120)
                    self._check_setup_abort()
                    return
                except (RpcError, TimeoutError) as failure:
                    self._check_setup_abort()
                    if self.closed:
                        raise
                    with self.lock:
                        self.auth['working'], self.auth['error'] = False, 'Sign-in failed: ' + str(failure)[:300]
        finally:
            with self.lock:
                self.auth = None

    def answer_auth(self, action, method_id=None):
        """Called from the HTTP layer: choose an in-app method, retry after an external sign-in, or cancel."""
        with self.lock:
            auth = self.auth
            if not auth:
                raise ValueError('No sign-in is pending for this connection')
            if auth.get('working'):
                raise ValueError('Sign-in is already in progress')
            if action == 'authenticate':
                method = next((m for m in auth['methods'] if m['id'] == method_id), None) if isinstance(method_id, str) else None
                if method is None:
                    raise ValueError('Unknown sign-in method')
                if method['kind'] != 'agent':
                    raise ValueError('This sign-in must be completed outside Studio. Follow the instructions shown, then choose Retry.')
            elif action not in ('retry', 'cancel'):
                raise ValueError('Action must be authenticate, retry, or cancel')
            else:
                method_id = None
            self.auth_response = (action, method_id)
            self.auth_event.set()

    def setup(self, resume=None):
        self.ready = False
        if resume:
            self.known_sessions.add(resume)
        self.initial = self._setup_request('initialize', {'protocolVersion': 1, 'clientInfo': {'name': 'agent-studio', 'title': 'Agent Studio', 'version': __version__},
            'clientCapabilities': {**self.caps.capabilities(), 'subagents': {}, 'elicitation': {'form': {}, 'url': {}}}}, 45)
        self._check_setup_abort()
        if not isinstance(self.initial, dict) or self.initial.get('protocolVersion') != 1:
            raise ValueError('The agent did not negotiate supported ACP protocol version 1')
        advertised = self.initial.get('agentCapabilities', {}).get('promptCapabilities', {})
        advertised = advertised if isinstance(advertised, dict) else {}
        self.prompt_caps = {key: advertised.get(key) is True for key in ('image', 'audio', 'embeddedContext')}
        self.image_supported = self.prompt_caps['image']
        self.auth_methods = describe_auth_methods(self.initial.get('authMethods'), self.provider)
        mcp_servers, self.breadth['skippedMcp'] = breadth.select_mcp_servers(self.mcp_servers, self.initial)
        if resume:
            resume_caps = breadth.session_capabilities(self.initial)
            if not resume_caps['loadSession'] and not resume_caps['resume']:
                raise ValueError('This agent does not advertise session loading. Start a new conversation instead.')
            self.session_id = resume
            result = self._setup_session_call('session/load' if resume_caps['loadSession'] else 'session/resume', dict({'sessionId': resume, 'cwd': self.cwd, 'mcpServers': mcp_servers}, **self._artifact_prompt(mcp_servers)))
        else:
            result = self._setup_session_call('session/new', dict({'cwd': self.cwd, 'mcpServers': mcp_servers}, **self._artifact_prompt(mcp_servers)))
            self.session_id = result.get('sessionId') if isinstance(result, dict) else None
        if not isinstance(result, dict) or not isinstance(self.session_id, str) or not self.session_id:
            raise ValueError('The agent returned an invalid session response')
        self.settings.update(result)
        self.known_sessions.add(self.session_id)
        self.ready = True
        self.event('connected', {'sessionId': self.session_id, 'provider': self.provider})

    def initialize_for_discovery(self):
        """Initialize only (no session) so session/list can run in a short-lived process."""
        self.initial = self.request('initialize', {'protocolVersion': 1, 'clientInfo': {'name': 'agent-studio', 'title': 'Agent Studio', 'version': __version__},
            'clientCapabilities': {'fs': {'readTextFile': False, 'writeTextFile': False}, 'terminal': False}}, 45)
        if not isinstance(self.initial, dict) or self.initial.get('protocolVersion') != 1:
            raise ValueError('The agent did not negotiate supported ACP protocol version 1')

    def list_sessions(self, cwd=None, cursor=None):
        capabilities = self.initial.get('agentCapabilities', {}) if isinstance(self.initial, dict) else {}
        session_caps = capabilities.get('sessionCapabilities') if isinstance(capabilities, dict) else None
        if not isinstance(session_caps, dict) or session_caps.get('list') is None:
            return {'supported': False, 'sessions': [], 'nextCursor': None}
        params = {}
        if cwd:
            params['cwd'] = cwd
        if cursor:
            params['cursor'] = cursor
        result = self.request('session/list', params, 60)
        raw = result.get('sessions') if isinstance(result, dict) else None
        if not isinstance(raw, list):
            raise ValueError('The agent returned an invalid session list')
        sessions = []
        for item in raw[:500]:
            if isinstance(item, dict) and isinstance(item.get('sessionId'), str) and item['sessionId'] and len(item['sessionId']) <= 512 and isinstance(item.get('cwd'), str):
                sessions.append({'sessionId': item['sessionId'], 'cwd': item['cwd'][:1024],
                                 'title': item['title'][:300] if isinstance(item.get('title'), str) else '',
                                 'updatedAt': item['updatedAt'] if isinstance(item.get('updatedAt'), str) else ''})
        next_cursor = result.get('nextCursor')
        return {'supported': True, 'sessions': sessions, 'nextCursor': next_cursor if isinstance(next_cursor, str) and next_cursor else None}

    def _prepare_prompt(self, text, client_message_id, attachments):
        if not isinstance(text, str) or len(text) > 200000:
            raise ValueError('Prompt text must be at most 200,000 characters')
        image_blocks, file_blocks, file_summaries, file_fingerprints = [], [], [], []
        if attachments is not None and attachments != []:
            image_items, file_items = split_attachments(attachments)
            image_total = 0
            if image_items:
                if not self.image_supported:
                    raise ValueError('This agent does not advertise image prompt support')
                image_blocks, image_total = validate_image_attachments(image_items)
            if file_items:
                records, file_total = validate_file_attachments(file_items)
                if image_total + file_total > MAX_TOTAL_ATTACHMENT_BYTES:
                    raise ValueError(f'Attachments exceed the {MAX_TOTAL_ATTACHMENT_BYTES // 1048576} MiB total limit')
                file_blocks, file_summaries = map_file_attachments(records, self.prompt_caps)
                file_fingerprints = [{'name': r['name'], 'mimeType': r['mimeType'], 'size': r['size'], 'sha256': r['sha256']} for r in records]
        if not text.strip() and not image_blocks and not file_blocks:
            raise ValueError('Enter a prompt or attach at least one image or file')
        if client_message_id is not None and (not isinstance(client_message_id, str) or not 1 <= len(client_message_id) <= 128):
            raise ValueError('Invalid client message ID')
        if file_fingerprints:
            fingerprint_data = json.dumps([text, image_blocks, file_fingerprints], ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')
        elif image_blocks:
            fingerprint_data = json.dumps([text, image_blocks], ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')
        else:
            fingerprint_data = text.encode('utf-8')
        fingerprint = hashlib.sha256(fingerprint_data).hexdigest()
        return image_blocks, file_blocks, file_summaries, fingerprint

    def prompt(self, text, client_message_id=None, attachments=None):
        image_blocks, file_blocks, file_summaries, fingerprint = self._prepare_prompt(text, client_message_id, attachments)
        with self.lock:
            receipt = self.prompt_receipts.get(client_message_id) if client_message_id else None
            if not receipt and client_message_id and self.recovery and self.session_id:
                receipt = self.recovery.receipt(self, client_message_id)
            if receipt:
                if receipt['fingerprint'] != fingerprint:
                    raise ValueError('This client message ID was already used for different text')
                if receipt['state'] == 'unknown':
                    raise PromptStateUnknown('This message was being sent when Studio stopped, so Studio cannot tell whether the agent received it. Check the conversation. If it is missing, press Send again.')
                return {'accepted': True, 'duplicate': True, 'clientMessageId': client_message_id, 'turnState': receipt['state']}
            if self.closed or not self.ready or not self.session_id:
                raise ValueError('This connection is not ready')
            if self.busy:
                raise ValueError('Wait for the current turn, or interrupt it before sending another prompt')
            self.busy = True
            self.turn_started_at = time.time()
            self.error = ''
            self.prompt_seq += 1
            seq = self.prompt_seq
            if client_message_id:
                self.prompt_receipts[client_message_id] = {'fingerprint': fingerprint, 'state': 'working'}
                while len(self.prompt_receipts) > 1000:
                    self.prompt_receipts.popitem(last=False)
            if client_message_id:
                self._receipt_changed(client_message_id)
        self._drain_pending()  # changes still queued from a finished turn go first; a failure is reported but never drops this prompt
        user_event = {'text': text, 'attachments': image_blocks, 'sessionId': self.session_id, 'clientMessageId': client_message_id}
        if file_summaries:
            user_event['files'] = file_summaries  # names, types, sizes and a bounded text preview; never the full content
        self.event('user', user_event)
        def run():
            try:
                context = self._studio_context()
                blocks = ([{'type': 'text', 'text': context[0]}] if context else []) + ([{'type': 'text', 'text': text}] if text.strip() else []) + file_blocks + image_blocks
                if self.cancel_seq >= seq:   # cancelled while the hook above was still working: the agent never had this turn
                    result = {'stopReason': 'cancelled'}
                else:
                    result = self.request('session/prompt', {'sessionId': self.session_id, 'prompt': blocks}, 86400)
                    self._studio_context_sent(context)
                self.turn_ended_at = time.time()
                self._queue_note_outcome(result=result)
                self.event('turn_end', result)
                hook = self.on_turn_end
                if hook and not (isinstance(result, dict) and result.get('stopReason') == 'cancelled'):
                    try:
                        hook(self)
                    except Exception:
                        log.exception('on_turn_end hook failed')
                if client_message_id:
                    with self.lock:
                        if client_message_id in self.prompt_receipts:
                            self.prompt_receipts[client_message_id]['state'] = 'finished'
                    self._receipt_changed(client_message_id)
            except Exception as error:
                log.exception('Prompt turn failed')
                self.error = str(error)
                self._queue_note_outcome(failed=True)
                self.event('error', {'message': str(error)})
                if client_message_id:
                    with self.lock:
                        if client_message_id in self.prompt_receipts:
                            self.prompt_receipts[client_message_id]['state'] = 'error'
                    self._receipt_changed(client_message_id)
            finally:
                self.withdraw_turn_requests()
                self._finish_turn()
                self._queue_after_turn()
        threading.Thread(target=run, daemon=True).start()
        return {'accepted': True, 'duplicate': False, 'clientMessageId': client_message_id, 'turnState': 'working'}

    def _studio_context(self):
        """(text, token) of the note to put in front of this prompt (kept out of the user event and the prompt fingerprint), or None."""
        start, provider = self.on_turn_start, self.context_for_prompt
        if start:
            try:
                start(self)
            except Exception:
                log.exception('on_turn_start hook failed')
        if not provider:
            return None
        try:
            return provider(self)
        except Exception:
            log.exception('The note for the prompt could not be made')
            return None

    def _studio_context_sent(self, context):
        done = self.context_sent
        if context and done:
            try:
                done(self, context[1])
            except Exception:
                log.exception('Clearing the sent note failed')

    # ---- settings changes: applied now between turns, queued during a turn -----------------------
    @staticmethod
    def _change_key(kind, config_id=None):
        return 'mode' if kind == 'mode' else f'config:{config_id}'

    def set_config(self, config_id, value):
        """Validated session/set_config_option, applied now."""
        params = breadth.build_config_request(self.settings, config_id, value)
        self.settings.update(self.request('session/set_config_option', dict(params, sessionId=self.session_id)))

    def set_mode(self, mode_id):
        """Validated session/set_mode, applied now."""
        breadth.check_mode(self.settings, mode_id)
        self.request('session/set_mode', {'sessionId': self.session_id, 'modeId': mode_id})
        self.settings.setdefault('modes', {})['currentModeId'] = mode_id

    def change_setting(self, kind, config_id, value):
        """A mode/config change from the UI. Idle: applied now (errors raise). Mid-turn: validated, then queued as the
        one pending value for that setting (last choice wins; picking the current value withdraws it) and applied
        in order when the turn ends, before the next prompt is accepted."""
        if kind not in ('mode', 'config'):
            raise ValueError('Unknown setting kind')
        if self.closed or not self.ready or not self.session_id:
            raise ValueError('This connection is not ready')
        if kind == 'mode':
            breadth.check_mode(self.settings, value)
        else:
            breadth.build_config_request(self.settings, config_id, value)
        key = self._change_key(kind, config_id)
        with self.lock:
            if self.busy:
                self.pending_changes.pop(key, None)
                if breadth.current_value(self.settings, kind, config_id) != value:
                    self.pending_changes[key] = {'key': key, 'kind': kind, 'configId': config_id if kind == 'config' else None, 'value': value, 'queuedAt': time.time()}
                return {'queued': key in self.pending_changes, 'pendingChanges': self.pending_list()}
        self._drain_pending()  # leftovers from an earlier turn keep their order ahead of this change
        if kind == 'mode':
            self.set_mode(value)
        else:
            self.set_config(config_id, value)
        return {'queued': False, 'pendingChanges': self.pending_list()}

    def cancel_pending(self, key):
        with self.lock:
            if self.pending_changes.pop(key, None) is None:
                raise ValueError('That change is no longer queued')
        return self.pending_list()

    def pending_list(self):
        with self.lock:
            return [dict(v) for v in self.pending_changes.values()]

    def _apply_pending_entry(self, entry):
        error = None
        try:
            if breadth.current_value(self.settings, entry['kind'], entry['configId']) != entry['value']:
                if entry['kind'] == 'mode':
                    self.set_mode(entry['value'])
                else:
                    self.set_config(entry['configId'], entry['value'])
        except Exception as caught:
            log.warning('Applying a queued setting change failed', exc_info=True)
            error = str(caught) or type(caught).__name__
        with self.lock:
            if self.pending_changes.get(entry['key']) is entry:  # a newer choice made meanwhile stays queued
                del self.pending_changes[entry['key']]
            if error:
                self.change_seq += 1
                self.change_failures.append({'seq': self.change_seq, 'key': entry['key'], 'kind': entry['kind'], 'configId': entry['configId'], 'value': entry['value'], 'message': error[:500], 'time': time.time()})
                del self.change_failures[:-5]

    def _drain_pending(self):
        """Apply queued changes one by one, in the order chosen. A refused change is recorded in change_failures and dropped."""
        while True:
            with self.lock:
                if self.closed or not self.ready:
                    self.pending_changes.clear()
                    return
                entry = next(iter(self.pending_changes.values()), None)
            if entry is None:
                return
            self._apply_pending_entry(entry)

    def _finish_turn(self):
        """The turn is over: apply what was queued, then (and only when nothing new was queued meanwhile) accept prompts again."""
        try:
            self._drain_pending()
        except Exception:
            log.exception('Applying queued setting changes failed; dropping them')
            with self.lock:
                self.pending_changes.clear()
        finally:
            while True:
                with self.lock:
                    if not self.pending_changes:
                        self.busy = False
                        return
                try:
                    self._drain_pending()
                except Exception:
                    log.exception('Applying queued setting changes failed; dropping them')
                    with self.lock:
                        self.pending_changes.clear()

    # ---- queued messages: written while the agent works, sent one per turn when it ends ---------------------
    def _queue_changed(self):
        hook = self.recovery
        if hook and self.session_id:
            try:
                hook.queue_changed(self)
            except Exception:
                log.exception('Saving the message queue failed')

    def _known_receipt(self, client_message_id):
        receipt = self.prompt_receipts.get(client_message_id)
        if not receipt and self.recovery and self.session_id:
            receipt = self.recovery.receipt(self, client_message_id)
        return receipt

    def queue_public(self, light=False):
        with self.lock:
            return self.queue.public(light)

    def queue_restore(self, saved):
        """After a host restart: the saved queue comes back PAUSED; nothing is sent until the user resumes."""
        with self.lock:
            self.queue.load(saved, 'restart')

    def queue_add(self, text, client_message_id=None, attachments=None):
        """Same payload as prompt(). Returns at once; a message that arrives while the agent is idle and nothing waits ahead of it is sent right away."""
        _, _, _, fingerprint = self._prepare_prompt(text, client_message_id, attachments)
        with self.lock:
            if self.closed or not self.ready or not self.session_id:
                raise ValueError('This connection is not ready')
            item_id = client_message_id or uuid.uuid4().hex
            receipt = self._known_receipt(item_id) if client_message_id else None
            queued = self.queue.find(item_id) or (self.queue.inflight if self.queue.inflight and self.queue.inflight['id'] == item_id else None)
            known = receipt or queued
            if known:
                if (receipt['fingerprint'] if receipt else known['fingerprint']) != fingerprint:
                    raise ValueError('This client message ID was already used for different text')
                if receipt and receipt['state'] == 'unknown':
                    raise PromptStateUnknown('This message was being sent when Studio stopped, so Studio cannot tell whether the agent received it. Check the conversation. If it is missing, press Send again.')
                return {'accepted': True, 'duplicate': True, 'queued': queued is not None, 'clientMessageId': item_id, 'turnState': receipt['state'] if receipt else 'queued', 'queue': self.queue.public()}
            self.queue.add(item_id, text, attachments if attachments else [], fingerprint)
        self._queue_changed()
        self._queue_pump()
        with self.lock:
            return {'accepted': True, 'duplicate': False, 'queued': self.queue.has(item_id), 'clientMessageId': item_id, 'turnState': 'queued' if self.queue.has(item_id) else 'working', 'queue': self.queue.public()}

    def queue_edit(self, item_id, action, lease_id=None, text=None):
        """Edit lease on a queued message: acquire (open the editor), renew (editor still open), save (new text, releases), cancel (releases).
        While the lease is held the message is never sent; if it is the first one, nothing is sent at all."""
        if action not in ('acquire', 'renew', 'save', 'cancel'):
            raise ValueError('Unknown edit action')
        with self.lock:
            q = self.queue
            if action == 'acquire':
                item = q.acquire(item_id, lease_id)
                return {'ok': True, 'leaseId': item['lease']['id'], 'text': item['text'], 'queue': q.public()}
            if action == 'renew':
                q.renew(item_id, lease_id)
                return {'ok': True, 'queue': q.public()}
            if action == 'cancel':
                q.release(item_id, lease_id)
            else:
                item = q._leased(item_id, lease_id)
                if not isinstance(text, str):
                    raise ValueError('Message text is required')
                _, _, _, fingerprint = self._prepare_prompt(text, None, item['attachments'])
                item['text'], item['fingerprint'], item['note'] = text, fingerprint, ''
                q.release(item_id, lease_id)
        self._queue_changed()
        self._queue_pump()
        return {'ok': True, 'queue': self.queue_public()}

    def queue_remove(self, item_id):
        with self.lock:
            if self.queue.inflight and self.queue.inflight['id'] == item_id:
                raise ValueError('That message is already being sent')
            self.queue.remove(item_id)
        self._queue_changed()
        self._queue_pump()
        return {'ok': True, 'queue': self.queue_public()}

    def queue_move(self, item_id, to_index):
        with self.lock:
            self.queue.move(item_id, to_index)
        self._queue_changed()
        self._queue_pump()
        return {'ok': True, 'queue': self.queue_public()}

    def queue_resume(self):
        with self.lock:
            self.queue.resume()
        self._queue_changed()
        self._queue_pump()
        return {'ok': True, 'queue': self.queue_public()}

    def queue_send_now(self, item_id):
        """Interrupt the running turn and send this message first. Refused while its editor is open."""
        with self.lock:
            q = self.queue
            item = q.find(item_id)
            if item is None:
                raise ValueError('That message is no longer queued (it may already have been sent)')
            if q.lease_active(item):
                raise ValueError('Save or cancel the edit first')
            q.move(item_id, 0)
            item['lease'] = None
            q.hold = ''
            interrupt = self.busy
            q.send_now = interrupt
        self._queue_changed()
        if interrupt:
            self.cancel()
            if not self.busy:  # the turn ended on its own meanwhile
                with self.lock:
                    self.queue.send_now = False
        self._queue_pump()
        return {'ok': True, 'queue': self.queue_public()}

    def _queue_note_outcome(self, result=None, failed=False):
        """A turn just ended: decide whether the queue must wait for the user. Runs before the turn's own requests are withdrawn."""
        with self.lock:
            q = self.queue
            if q.send_now or not q.items or q.hold:
                return
            needs = len(self.permissions) + len(self.elicitations) + (1 if self.auth else 0)
            if failed:
                q.hold = 'error'
            elif needs:
                q.hold = 'needs_you'
            elif isinstance(result, dict) and result.get('stopReason') == 'cancelled':
                q.hold = 'interrupted'

    def _queue_after_turn(self):
        with self.lock:
            if self.queue.send_now:
                self.queue.send_now = False
                self.queue.hold = ''
        self._queue_changed()
        self._queue_pump()

    def _queue_pump(self):
        """Send the first waiting message if nothing stops it: connection idle, no hold, no edit lease on that message, nobody waiting on the user."""
        while True:
            with self.lock:
                q = self.queue
                if self.closed or not self.ready or self.busy or not self.session_id or q.inflight or not q.items or q.pause_reason():
                    return
                if self.permissions or self.elicitations or self.auth:
                    return
                item = q.items.pop(0)
                q.inflight = item
            failure, result = None, None
            try:
                result = self.prompt(item['text'], item['id'], item['attachments'] or None)   # receipts make a retry of the same id harmless
            except PromptStateUnknown:
                failure = ('unknown', 'Studio cannot tell whether this one was already sent. Remove it, or press Resume to send it again.')
            except Exception as error:
                log.warning('Sending a queued message failed', exc_info=True)
                failure = ('' if 'Wait for the current turn' in str(error) else 'error', str(error)[:300])
            with self.lock:
                q.inflight = None
                if failure:
                    item['note'] = failure[1] if failure[0] else ''
                    q.items.insert(0, item)
                    if failure[0]:
                        q.hold = failure[0]
            self._queue_changed()
            if failure or not (result or {}).get('duplicate') or self.busy:
                return

    def _stale_error(self, key, what):
        reason = self.withdrawn.get(key)
        return ValueError(f'This {what} was withdrawn: {reason}' if reason else f'This {what} is no longer pending')

    def _route(self, session_id):
        if session_id is None:
            return 'setup'
        if session_id == self.session_id:
            return 'main'
        return 'subagent' if session_id in self.known_sessions else 'unknown'

    def _note_withdrawn_locked(self, key, kind, reason, session_id=None):
        self.withdrawn[key] = reason
        while len(self.withdrawn) > 200:
            self.withdrawn.popitem(last=False)
        self.event('request_withdrawn', {'key': key, 'kind': kind, 'reason': reason, 'sessionId': session_id})

    def _reply_quietly(self, rpc_id, result):
        try:
            self.write({'jsonrpc': '2.0', 'id': rpc_id, 'result': result})
        except (OSError, ValueError):
            pass

    def _receipt_changed(self, client_message_id):
        hook = self.recovery
        with self.lock:
            receipt = dict(self.prompt_receipts.get(client_message_id) or {})
        if hook and receipt:
            hook.receipt_changed(self, client_message_id, receipt)

    ARTIFACT_PROMPT = ('You are running inside Agent Studio, which shows artifacts beside the chat; when the user says "artifact" they '
                       'mean this viewer and its studio_artifact tool. When you make something the user '
                       'should look at rather than source code (an HTML page, report, chart, diagram, SVG, Markdown document or image), '
                       'save its file under the project\'s outputs/ folder (for example outputs/report.html), never in the project root '
                       'or among source files, then publish it with the studio_artifact publish tool (pass a file path or the content) and mention it in your reply '
                       'as the Markdown link the tool returns. When you change it, use the studio_artifact update tool so it gets a new '
                       'version, and do not tell the user to open the file by hand. Only publish to claude.ai (or any other web '
                       'artifact or sharing service) when the user explicitly asks for a claude.ai page or a shareable link.')

    WORKTREE_PROMPT = ('In this chat you work in your own copy of the project, on the git branch {branch} (it started from {base}). '
                       'When you finish a piece of work, ask the user whether to merge it into the project. Merge only after they say yes, '
                       'by calling the merge_into_project tool. Never merge on your own.')

    def _artifact_prompt(self, servers):
        """{'systemPrompt': ...} that tells the agent about Studio's artifact tool, or {} when this chat has no such tool or the
        agent does not advertise client system prompts (ACP unstable `systemPrompt`; appended after the agent's own)."""
        own = str(app_paths.CODE_DIR / 'artifact_mcp.py')
        if not any(isinstance(e, dict) and e.get('name') == 'studio_artifact' and own in [str(a) for a in e.get('args') or []] for e in servers or []):
            return {}
        out = {}
        caps = (self.initial or {}).get('agentCapabilities') if isinstance(self.initial, dict) else None
        session_caps = caps.get('sessionCapabilities') if isinstance(caps, dict) else None
        if isinstance(session_caps, dict) and session_caps.get('systemPrompt'):
            content = [{'type': 'text', 'text': self.ARTIFACT_PROMPT}]
            worktree = getattr(self, 'worktree', None)
            if worktree:   # only a chat that works in its own worktree (the merge tool comes with it)
                content.append({'type': 'text', 'text': self.WORKTREE_PROMPT.format(branch=worktree.get('branch', ''), base=worktree.get('base') or 'the project branch')})
            out['systemPrompt'] = {'mode': 'append', 'content': content}
        return out

    OWN_ARTIFACT_TOOL = re.compile(r'^mcp__studio_artifact__(?:publish|update|list|merge_into_project|resolve_edit_clash)$')

    def _own_artifact_tool(self, params):
        """True when a permission request is for Studio's studio_artifact tool on a chat Studio gave that tool to."""
        servers = getattr(self, 'mcp_servers', None) or []
        own = str(app_paths.CODE_DIR / 'artifact_mcp.py')
        if not any(isinstance(entry, dict) and entry.get('name') == 'studio_artifact' and own in [str(a) for a in entry.get('args') or []] for entry in servers):
            return False
        call = params.get('toolCall') if isinstance(params, dict) else None
        if not isinstance(call, dict):
            return False
        meta = call.get('_meta') if isinstance(call.get('_meta'), dict) else {}
        claude = meta.get('claudeCode') if isinstance(meta.get('claudeCode'), dict) else {}
        name = claude.get('toolName') or call.get('name') or call.get('title') or ''
        return isinstance(name, str) and bool(self.OWN_ARTIFACT_TOOL.match(name))

    def permission(self, key, option):
        with self.lock:
            pending = self.permissions.get(key)
            if not pending:
                raise self._stale_error(key, 'approval')
            options = pending['params'].get('options', [])
            if option is not None and option not in [o.get('optionId') for o in options]:
                raise ValueError('Unknown approval option')
            outcome = {'outcome': 'cancelled'} if option is None else {'outcome': 'selected', 'optionId': option}
            self.write({'jsonrpc': '2.0', 'id': pending['rpcId'], 'result': {'outcome': outcome}})
            del self.permissions[key]

    def _receive_elicitation(self, rpc_id, params):
        if not isinstance(params, dict) or params.get('mode') not in ('form', 'url'):
            raise ValueError('Only form and url elicitation modes are supported')
        sid, request_id = params.get('sessionId'), params.get('requestId')
        if sid is not None:
            if not isinstance(sid, str) or sid not in self.known_sessions:
                raise ValueError('Elicitation references an unknown session')
            if request_id is not None:
                raise ValueError('Session-scoped elicitation cannot include requestId')
        elif request_id is None or isinstance(request_id, bool) or not isinstance(request_id, (str, int)):
            raise ValueError('Request-scoped elicitation requires a string or integer requestId')
        if request_id is not None and (isinstance(request_id, (str, int)) is False or isinstance(request_id, bool)):
            raise ValueError('Invalid elicitation requestId')
        if params.get('toolCallId') is not None and (sid is None or not isinstance(params['toolCallId'], str)):
            raise ValueError('toolCallId requires a session-scoped request')
        if not isinstance(params.get('message'), str) or len(params['message']) > 10000:
            raise ValueError('Elicitation message must be a string of at most 10000 characters')
        if params['mode'] == 'url':
            elicitation.validate_url_request(params)
        else:
            elicitation.validate_schema(params.get('requestedSchema'))
        key = secrets.token_urlsafe(18)
        with self.lock:
            if len(self.elicitations) >= 100:
                raise ValueError('Too many pending elicitation requests')
            if params['mode'] == 'url' and any(p['params'].get('elicitationId') == params['elicitationId'] for p in self.elicitations.values()):
                raise ValueError('A request with this elicitationId is already pending')
            self.elicitations[key] = {'rpcId': rpc_id, 'params': params}
        self.event('elicitation', {'key': key, 'params': params})

    def answer_elicitation(self, key, action, content=None):
        if action not in ('accept', 'decline', 'cancel'):
            raise ValueError('Action must be accept, decline, or cancel')
        with self.lock:
            pending = self.elicitations.get(key)
            if not pending:
                raise self._stale_error(key, 'request')
            result = {'action': action}
            if action == 'accept' and pending['params'].get('mode') == 'url':
                pass  # the person confirmed they completed the out-of-band interaction
            elif action == 'accept':
                result['content'] = elicitation.validate_content(pending['params']['requestedSchema'], {} if content is None else content)
            self.write({'jsonrpc': '2.0', 'id': pending['rpcId'], 'result': result})
            del self.elicitations[key]
            if action != 'accept' and not self.ready and not self.closed:
                what = 'a question' if pending['params'].get('mode') == 'form' else 'a link request'
                self._abort_setup(f'You {"declined" if action == "decline" else "cancelled"} {what} while the conversation was opening ("{str(pending["params"].get("message", ""))[:120]}"), so it was not opened.')

    def complete_elicitation(self, params):
        """elicitation/complete: the agent says an out-of-band URL interaction finished."""
        eid = params.get('elicitationId') if isinstance(params, dict) else None
        if not isinstance(eid, str):
            return
        with self.lock:
            for key, item in list(self.elicitations.items()):
                if item['params'].get('mode') == 'url' and item['params'].get('elicitationId') == eid:
                    self._reply_quietly(item['rpcId'], {'action': 'accept'})
                    del self.elicitations[key]
                    self._note_withdrawn_locked(key, 'elicitation', 'The agent reported this request complete.', item['params'].get('sessionId'))

    def cancel_incoming_request(self, request_id):
        """Withdraw UI for an agent-originated RPC; IDs are direction-specific."""
        if isinstance(request_id, bool) or not isinstance(request_id, (str, int)):
            return
        reason = 'The agent cancelled this request.'
        with self.lock:
            self._clear_permissions_locked(rpc_id=request_id, reason=reason)
            self._clear_elicitations_locked(rpc_id=request_id, reason=reason)

    def _clear_permissions_locked(self, session_id=None, rpc_id=None, reason='The session ended.', scoped=False, everything=False):
        for key, item in list(self.permissions.items()):
            sid = item['params'].get('sessionId') if isinstance(item.get('params'), dict) else None
            rpc_match = rpc_id is not None and type(item.get('rpcId')) is type(rpc_id) and item.get('rpcId') == rpc_id
            if everything or rpc_match or (session_id is not None and sid in (session_id, None)) or (scoped and sid is not None):
                self._reply_quietly(item['rpcId'], {'outcome': {'outcome': 'cancelled'}})
                del self.permissions[key]
                self._note_withdrawn_locked(key, 'permission', reason, sid)

    def _clear_elicitations_locked(self, session_id=None, request_id=None, rpc_id=None, reason='The session ended.', scoped=False):
        everything = session_id is None and request_id is None and rpc_id is None and not scoped
        for key, item in list(self.elicitations.items()):
            params = item['params']
            rpc_match = rpc_id is not None and type(item.get('rpcId')) is type(rpc_id) and item.get('rpcId') == rpc_id
            request_match = request_id is not None and type(params.get('requestId')) is type(request_id) and params.get('requestId') == request_id
            if everything or rpc_match or request_match or (session_id is not None and params.get('sessionId') == session_id) or (scoped and params.get('sessionId') is not None):
                self._reply_quietly(item['rpcId'], {'action': 'cancel'})
                del self.elicitations[key]
                self._note_withdrawn_locked(key, 'elicitation', reason, params.get('sessionId'))

    def withdraw_turn_requests(self):
        """The turn that raised these requests is over; nothing may answer them any more."""
        reason = 'The turn that asked for this has ended.'
        with self.lock:
            self._clear_permissions_locked(session_id=self.session_id, reason=reason)
            self._clear_elicitations_locked(session_id=self.session_id, reason=reason)

    def cancel_subagent(self, child_session_id):
        """Stop one child only when the agent announced a cancel capability for it."""
        with self.lock:
            entry = self.subagents.get(child_session_id) if isinstance(child_session_id, str) else None
            if self.closed or not self.ready:
                raise ValueError('This connection is not ready')
            if not entry or not isinstance(entry.get('capabilities'), dict) or 'cancel' not in entry['capabilities']:
                raise ValueError('This agent did not advertise cancellation for that subagent')
            if entry.get('state') in ('idle', 'completed', 'complete', 'failed', 'cancelled', 'canceled', 'stopped'):
                raise ValueError('That subagent is not running')
        self.write({'jsonrpc': '2.0', 'method': 'session/cancel', 'params': {'sessionId': child_session_id}})

    def cancel(self, subagent=None):
        if subagent is not None:
            return self.cancel_subagent(subagent)
        # ACP prompt-turn cancellation: answer every pending permission request with the `cancelled`
        # outcome FIRST (recorded as withdrawn), then notify session/cancel; the agent ends the turn with stopReason `cancelled`.
        self.cancel_seq = self.prompt_seq
        with self.lock:
            self._clear_permissions_locked(everything=True, reason='The turn was cancelled.')
        if self.session_id and not self.closed:
            try:
                self.write({'jsonrpc': '2.0', 'method': 'session/cancel', 'params': {'sessionId': self.session_id}})
            except (OSError, ValueError):
                pass
        with self.lock:
            self._clear_elicitations_locked(scoped=True, reason='The turn was cancelled.')

    def close(self):
        with self.lock:
            if getattr(self, '_closing', False):
                return
            self._closing = True
        try:
            for key in list(self.permissions):
                self.permission(key, None)
            with self.lock:
                self._clear_elicitations_locked()
            if self.busy:
                self.cancel()
            if self.process is not None:
                self.process.stdin.close()
                self.process.wait(timeout=5)
        except (OSError, subprocess.TimeoutExpired):
            self.process.terminate()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                pass
        # The adapter had its chance to exit cleanly; now take down whatever it left running (claude CLI, MCP servers, ...).
        if self.process is not None:
            self.tree.kill()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                pass
        self.closed = True
        if self.closed_at is None:
            self.closed_at = time.time()
        self.ready = False
        self.caps.shutdown()
        self.release_lease()
        if self.recovery:
            self.recovery.connection_closed(self)
        if self.process is not None:
            self.read_thread.join(timeout=2)
            self.error_thread.join(timeout=2)
            for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
                if stream and not stream.closed:
                    stream.close()

    def attention(self):
        """Cheap summary for the sidebar, status line and notifications. needs_you wins over working."""
        with self.lock:
            needs = len(self.permissions) + len(self.elicitations) + (1 if self.auth else 0)  # includes subagent requests
            state = 'closed' if self.closed else 'needs_you' if needs else 'opening' if not self.ready else 'working' if self.busy else 'idle'
            ended = self.turn_ended_at
            started = self.turn_started_at if self.busy and not self.closed else None
        iso = lambda t: datetime.datetime.fromtimestamp(t, datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ') if t else None
        return {'state': state, 'needs': 0 if state == 'closed' else needs, 'turnEndedAt': iso(ended), 'busySince': iso(started)}

    def public(self, after=0, light=False):
        """Wire form of this connection. light=True is the sidebar listing: no events and no permission bodies."""
        with self.lock:
            events = list(self.events)
            data = {'attention': self.attention(), 'id': self.id, 'provider': self.provider, 'cwd': self.cwd, 'projectRoot': self.project_root, 'sessionId': self.session_id,
                'busy': self.busy, 'closed': self.closed, 'error': self.error, 'settings': self.settings,
                'queue': self.queue.public(light),
                'pendingChanges': [dict(v) for v in self.pending_changes.values()], 'changeFailures': [dict(v) for v in self.change_failures],
                'state': 'closed' if self.closed else 'input_needed' if self.elicitations or self.permissions or self.auth else 'opening' if not self.ready else 'working' if self.busy else 'ready',
                'ready': bool(self.ready and not self.closed),
                'subagents': {k: dict(v) for k, v in self.subagents.items()},
                'imageSupported': self.image_supported,
                'promptCapabilities': dict(self.prompt_caps),
                'breadth': breadth.public_state(self),
                'events': [] if light else [e for e in events if e['seq'] > after], 'cursor': self.sequence,
                'reset': bool(events and after and after < events[0]['seq'] - 1),
                'setupDone': self.open_done.is_set(), 'auth': dict(self.auth) if self.auth else None,
                'permissions': [] if light else [{'key': k, 'params': v['params'], 'route': self._route(v['params'].get('sessionId') if isinstance(v['params'], dict) else None)} for k, v in self.permissions.items()],
                'elicitations': [{'key': k, 'params': v['params'], 'route': self._route(v['params'].get('sessionId'))} for k, v in self.elicitations.items()],
                'clientCaps': self.caps.public(),
                'unknownReceipts': self.unknown_receipts()}
            if self.worktree:   # only a worktree chat has this key; the page does not show it yet
                data['worktree'] = dict(self.worktree)
            return data

    def unknown_receipts(self):
        """Messages that were mid-send when Studio last restarted and are still unresolved (see state_store)."""
        store = getattr(self.recovery, 'store', None)
        return store.unknown_receipts(self.provider, self.session_id) if store and self.session_id else []
