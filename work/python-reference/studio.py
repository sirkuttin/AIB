#!/usr/bin/env python3
"""Agent Studio: standalone local ACP chat and transcript monitoring. See --help."""
import argparse
import atexit
import base64
import collections
import datetime
import json
import hashlib
import logging
import re
import os
import pathlib
import secrets
import shutil
import subprocess
import sys
import threading
import time
import traceback
import updater
import unicodedata
import urllib.parse
import uuid
import webbrowser
import app_paths
from app_paths import APP_ROOT
import monitor
import elicitation
import acp_schema
import breadth
import msgqueue
import client_caps
import host_client
import runtime_gc
import log_setup
import state_paths
import folders
import editors
import agent_registry
import adapters
import agent_installer
import agent_signin
import changes
import artifacts
import artifact_origin
import tempfile
import artifact_keys   # artifact tool (agent C)
import security
from host_client import HostUnavailable
from ownership import OwnershipConflict, SessionLease, find_external_owner, probe_external_owner
import ownership_probe
import worktree_sync
import worktrees
from ownership_probe import OwnershipEvidence
from state_store import StateStore, Recovery, ConversationState, ProjectPrefs, ReadState, SettingsStore
import chat_folders
from chat_folders import repo_branch, artifact_folder, changes_response
from process_tree import ProcessTree
from acp_connection import Connection, MAX_EVENTS   # the ACP side; re-exported so studio.Connection still works
from studio_shared import builtin_launch, describe_agents, settings_view, notices, conversation_action   # shared with remote_studio
from remote_studio import RemoteStudio, host_command, attach_host   # the web server's proxy to the agent host; re-exported
import web_handler
from web_handler import WEB_STARTED, studio_asset, model_in_use   # the web handler's parts; re-exported so studio.studio_asset etc. still work
from rpc_errors import RpcError, PromptStateUnknown, is_auth_required, describe_auth_methods
from attachments import (MAX_EVENT_IMAGE_BYTES, MAX_TOTAL_ATTACHMENT_BYTES, MAX_PROMPT_BODY_BYTES, split_attachments,
                         validate_image_attachments, validate_file_attachments, map_file_attachments, _event_image_size)

log = logging.getLogger(__name__)
log.addHandler(logging.NullHandler())   # a library logger: quiet until main() configures logging (log_setup.py)

HERE = APP_ROOT
ARTIFACT_URL_FILE = 'artifact-web.json'   # artifact tool (agent C): the web server writes its URL here so agents find it after a restart
CLOSED_GRACE_SECONDS = 10 * 60   # a closed connection stays listed this long so the page can still show "disconnected" and offer reconnect
MAX_CLOSED_CONNECTIONS = 20      # ...and never more than this many closed ones are kept (oldest go first)


class Studio:
    def __init__(self, options, port=None, connection_factory=None, saved_cwd=None):
        self.options = options
        self.connection_factory = connection_factory or Connection   # tests pass a factory instead of patching the module name
        self.saved_cwd = saved_cwd      # (provider, session_id) -> folder of a saved transcript; None means the module SAVED_CWD
        self.connections = {}
        self.clock = time.time          # tests replace this to age closed connections without sleeping
        self.token = secrets.token_urlsafe(32)
        log_setup.register_secret(self.token)
        self.instance_id = uuid.uuid4().hex
        self.lock = threading.RLock()
        self.state_dir = pathlib.Path(getattr(options, 'state_dir', app_paths.TESTS_DIR / 'agent-studio-state'))
        self.owner_probe = self._cmdline_owner
        owners_dir = getattr(options, 'owners_dir', None)
        self.owners = ownership_probe.OwnerRegistry(owners_dir, instance_id=self.instance_id) if owners_dir else None
        self.probe = ownership_probe.OwnershipProbe(
            getattr(options, 'omp_sessions', None), getattr(options, 'claude_projects', None), self.owners,
            owned_by_studio=self._studio_owns, own_pids=self._own_agent_pids)
        self.heartbeat_seconds = ownership_probe.HEARTBEAT_SECONDS
        self._heartbeat_stop = threading.Event()
        self._heartbeat_thread = None
        # Recovery state is kept only when a state directory was configured explicitly.
        self.store = StateStore(self.state_dir, f'recovery-{port if port is not None else getattr(options, "port", 0)}') if hasattr(options, 'state_dir') else None
        self.recovery = Recovery(self.store) if self.store else None
        if self.recovery:
            self.recovery.queues = msgqueue.QueueStore(self.state_dir, f'queues-{port if port is not None else getattr(options, "port", 0)}')  # queued messages survive a host restart (paused)
        # Pin / archive / delete marks; kept on disk only when a state directory was configured explicitly.
        self.conversations = ConversationState(self.state_dir if hasattr(options, 'state_dir') else None)
        self.project_prefs = ProjectPrefs(self.state_dir if hasattr(options, 'state_dir') else None)
        self.read_state = ReadState(self.state_dir if hasattr(options, 'state_dir') else None)   # per-chat read position, keyed provider:sessionId
        self.settings = SettingsStore(self.state_dir if hasattr(options, 'state_dir') else None)
        self.worktrees = worktrees.Manager(self.state_dir) if hasattr(options, 'state_dir') else None   # worktree per chat (hidden flag); None without a state dir
        if self.worktrees:
            try:
                self.worktrees.cleanup_incomplete()   # a half-made worktree of a process that died
                self.worktrees.retry_pending()        # removals that were pending (a file in use) + git worktree prune
            except Exception:
                log.exception('Cleaning up half-made worktrees failed')
        self.live_sync = worktree_sync.LiveSync(self) if self.worktrees else None   # live sync of the user's saved edits into chat worktrees (flag worktreePerChat); threads start only for open worktree chats
        self.artifact_url_provider = None   # artifact tool (agent C): callable returning the web server's base URL; set by the agent host
        if hasattr(options, 'state_dir'):
            artifact_keys.configure(self.state_dir)
        # Automatic reconnect of the chats that were open before a restart (see start_auto_reconnect). The command-line flag
        # can only turn it off; the Settings page can too, and is read here, so a change applies at the next start.
        self.auto_reconnect = bool(getattr(options, 'auto_reconnect', True)) and self.settings.auto_reconnect()
        self._reconnect_pending = set()   # (provider, sessionId) queued or being reconnected right now
        self._reconnect_started = False
        self._reconnect_stop = threading.Event()
        self._reconnect_threads = []

    def _turn_ended(self, connection):
        """The agent finished a turn: mark the conversation "your turn" until the user acts on it."""
        if self.live_sync and getattr(connection, 'worktree', None):
            try:
                self.live_sync.turn_ended(connection)   # worktree per chat: the lost-update guard and the merge of files both sides changed
            except Exception:
                log.exception('Merging the user edits at the end of the turn failed')
        if connection.provider and connection.session_id:
            try:
                self.conversations.apply('your_turn', connection.provider, connection.session_id)
            except ValueError:
                pass

    def _studio_owns(self, provider, session_id):
        with self.lock:
            return any(c.provider == provider and c.session_id == session_id and not c.closed for c in self.connections.values())

    def _own_agent_pids(self):
        with self.lock:
            return [c.process.pid for c in self.connections.values() if not c.closed and c.process is not None]

    def _cmdline_owner(self, provider, session_id, excluded_pids=()):
        """Strong, read-only check: a native agent process whose command line names this session."""
        snapshot, _ = self.probe.processes.get(max_age=0)
        if snapshot is None:
            return probe_external_owner(provider, session_id, excluded_pids)
        own = self.probe._own_process_ids(snapshot) | {int(pid) for pid in excluded_pids}
        return find_external_owner([{'pid': p['pid'], 'name': p['name'], 'commandline': p['cmdline']} for p in snapshot if p.get('cmdline')], provider, session_id, own)

    def _announce(self, connection, state=None):
        if not self.owners or not connection.session_id or connection.closed:
            return
        self.owners.announce(connection.provider, connection.session_id, connection.cwd, state or ('working' if connection.busy else 'ready'))
        if self._heartbeat_thread is None:
            with self.lock:
                if self._heartbeat_thread is None:
                    self._heartbeat_thread = threading.Thread(target=self._heartbeat_loop, daemon=True, name='agent-studio-owner-heartbeat')
                    self._heartbeat_thread.start()

    def _withdraw(self, connection):
        if self.live_sync:
            try:
                self.live_sync.refresh()   # the last chat of a project closed: its watcher stops
            except Exception:
                log.exception('Stopping live sync failed')
        if connection.session_id:
            self.probe.note_released(connection.provider, connection.session_id)
            if self.owners:
                self.owners.withdraw(connection.provider, connection.session_id)

    def _heartbeat_loop(self):
        while not self._heartbeat_stop.wait(self.heartbeat_seconds):
            with self.lock:
                live = [c for c in self.connections.values() if c.session_id and not c.closed]
            keys = set()
            for connection in live:
                keys.add((connection.provider, connection.session_id))
                self._announce(connection)
            for provider, session_id in list(self.owners.claimed()) if self.owners else ():
                if (provider, session_id) not in keys:
                    self.owners.withdraw(provider, session_id)

    def check_ownership(self, provider, session_id, cwd, continue_anyway=False, fresh=True):
        """Raise OwnershipEvidence unless the conversation may be opened. The command-line probe has run already."""
        verdict = self.probe.assess(provider, session_id, cwd, skip_cmdline=True, fresh=fresh)
        if verdict['verdict'] == 'owned_elsewhere':
            strong = next(r['text'] for r in verdict['reasons'] if r['strength'] == 'strong')
            raise OwnershipEvidence(f"{strong} Stop it in its current client before continuing here.", 'session_in_use', verdict)
        if verdict['verdict'] == 'possibly_active' and not continue_anyway:
            raise OwnershipEvidence('Another app may be using this conversation: ' + ' '.join(r['text'] for r in verdict['reasons'][:2]), 'possibly_active', verdict)
        return verdict

    conversation_action = conversation_action

    def recovered(self):
        """Conversations the previous Studio process owned and this one does not (yet)."""
        if not self.store:
            return []
        with self.lock:
            open_now = {(c.provider, c.session_id) for c in self.connections.values() if not c.closed}
        result = []
        for item in list(self.store.conversations.values()):
            if (item['provider'], item['sessionId']) in open_now:
                continue
            result.append(dict(item, unknownMessages=self.store.unknown_count(item['provider'], item['sessionId']),
                               unknownReceipts=self.store.unknown_receipts(item['provider'], item['sessionId']),
                               reconnecting=(item['provider'], item['sessionId']) in self._reconnect_pending))
        return result

    # ---- Automatic reconnect after a restart ----------------------------------------------------------
    RECONNECT_TRIES = 3

    def start_auto_reconnect(self, concurrency=2, stagger=1.0, tries=None, retry_delay=5.0):
        """Reload, in the background, every conversation that was live in Studio before the restart.

        Uses the ordinary resume path of connect() with continue_anyway=False, so the ownership check runs:
        a conversation another app owns or may be using is skipped and stays "Not running". Nothing is ever
        sent to an agent. At most `concurrency` start at once, `stagger` seconds apart; a failure is retried
        up to `tries` times and then dropped from the recovery list. Returns how many were queued."""
        if not self.store or not self.auto_reconnect or self._reconnect_started:
            return 0
        self._reconnect_started = True
        tries = tries or self.RECONNECT_TRIES
        items = [(r['provider'], r['sessionId'], r['cwd']) for r in self.recovered()]
        if not items:
            return 0
        with self.lock:
            self._reconnect_pending.update((p, i) for p, i, _ in items)
        work = list(items)
        gate = threading.Lock()
        started = [False]

        def worker():
            while not self._reconnect_stop.is_set():
                with gate:   # one start at a time, spaced out
                    if not work:
                        return
                    item = work.pop(0)
                    if started[0] and self._reconnect_stop.wait(stagger):
                        return
                    started[0] = True
                self._reconnect_one(item, tries, retry_delay)

        for n in range(max(1, int(concurrency))):
            thread = threading.Thread(target=worker, daemon=True, name=f'agent-studio-auto-reconnect-{n}')
            self._reconnect_threads.append(thread)
            thread.start()
        return len(items)

    def _reconnect_one(self, item, tries, retry_delay):
        provider, session_id, cwd = item
        label = f'{provider} {session_id} in {cwd}'
        try:
            for attempt in range(1, tries + 1):
                if self._reconnect_stop.is_set():
                    return
                try:
                    self.connect(provider, cwd, resume=session_id, background=False, continue_anyway=False)
                    print(f'Auto-reconnect: reconnected {label}', file=sys.stderr, flush=True)
                    return
                except OwnershipConflict as error:
                    print(f'Auto-reconnect: skipped {label}: {error}', file=sys.stderr, flush=True)
                    return
                except Exception as error:
                    log.warning('Auto-reconnect of %s failed (try %s of %s)', label, attempt, tries, exc_info=True)
                    print(f'Auto-reconnect: {label} failed (try {attempt} of {tries}): {error}', file=sys.stderr, flush=True)
                    if attempt < tries and self._reconnect_stop.wait(retry_delay):
                        return
            if self.store.forget_conversation(provider, session_id):
                print(f'Auto-reconnect: gave up on {label}; it stays Not running', file=sys.stderr, flush=True)
        finally:
            with self.lock:
                self._reconnect_pending.discard((provider, session_id))

    def forget_recovered(self, provider, session_id):
        if not isinstance(provider, str) or not isinstance(session_id, str):
            raise ValueError('Invalid conversation')
        return bool(self.store and self.store.forget_conversation(provider, session_id))

    def agent_launch(self, provider, fresh=False):
        """(argv list, extra environment dict) that starts this agent. Never a shell string. fresh=True is a brand-new chat:
        an agent turned off in Settings is refused there, but its saved chats can still be reopened."""
        if provider in agent_registry.BUILTIN_IDS:
            if fresh and not self.settings.builtin_enabled(provider):
                raise ValueError(f'{agent_registry.BUILTIN_NAMES[provider]} is turned off in Settings')
            if provider == 'omp':
                if not getattr(self.options, 'omp_command', ''):
                    raise ValueError('OMP is not installed: it was not found on PATH')
                return [self.options.omp_command, 'acp'], {}
            row = builtin_launch(self.options, self.settings, provider)
            if not row['found']:
                raise ValueError(f"{agent_registry.BUILTIN_NAMES[provider]} is not available: {row['problem']}")
            return row['argv'], {}
        agent = self.settings.custom_agent(provider) if agent_registry.is_custom(provider) else None
        if agent is None:
            raise ValueError('That agent is not in Settings (it may have been removed)')
        if fresh and not agent['enabled']:
            raise ValueError(f'{agent["name"]} is turned off in Settings')
        for e in agent['env']:
            log_setup.register_secret(e['value'])   # custom agent env values (often API keys) never reach a log line
        return [agent_registry.check_command(agent['command'])] + list(agent['args']), {e['name']: e['value'] for e in agent['env']}

    # ---- artifact tool (agent C) ------------------------------------------------------------
    def artifact_base_url(self):
        """Base URL of the web server the artifact tool should call ('' when unknown; the tool then reads the URL file)."""
        try:
            url = self.artifact_url_provider() if self.artifact_url_provider else ''
        except Exception:
            log.exception('The artifact URL provider failed')
            url = ''
        if not url and isinstance(getattr(self.options, 'port', None), int) and self.options.port:
            url = f'http://127.0.0.1:{self.options.port}'
        return url or ''

    def artifact_mcp_servers(self, conversation_id, worktree=False):
        """The `studio_artifact` stdio MCP entry for one conversation (appended to the user's --mcp-config entries), or []."""
        if getattr(self.options, 'no_artifact_tool', False) or not hasattr(self.options, 'state_dir'):
            return []
        key = artifact_keys.issue(conversation_id)
        if not key:
            return []
        env = {'STUDIO_ARTIFACT_URL': self.artifact_base_url(), 'STUDIO_ARTIFACT_URL_FILE': str(self.state_dir / ARTIFACT_URL_FILE),
               'STUDIO_ARTIFACT_KEY': key, 'STUDIO_CONVERSATION_ID': conversation_id}
        if worktree:
            env['STUDIO_WORKTREE'] = '1'   # only a worktree chat is offered the merge tools
        return [{'name': 'studio_artifact', 'command': sys.executable, 'args': [str(app_paths.CODE_DIR / 'artifact_mcp.py')],
                 'env': [{'name': k, 'value': v} for k, v in env.items()]}]

    def agent_command(self, provider):
        return self.agent_launch(provider)[0]

    def list_agent_sessions(self, provider, cwd=None, cursor=None):
        """Protocol-native session discovery (session/list). Never loads or prompts a session."""
        if provider not in ('omp', 'claude'):
            raise ValueError('Finding saved chats through the agent works for Claude Code and OMP only')
        command = self.agent_command(provider)
        if cursor is not None and (not isinstance(cursor, str) or not 0 < len(cursor) <= 1024):
            raise ValueError('Invalid session list cursor')
        if cwd is not None and (not isinstance(cwd, str) or len(cwd) > 1024):
            raise ValueError('Invalid workspace filter')
        with self.lock:
            live = next((c for c in self.connections.values() if c.provider == provider and c.ready and not c.closed), None)
        if live:
            return dict(live.list_sessions(cwd, cursor), via='studio-connection')
        probe = self.connection_factory(command, pathlib.Path.home(), provider)
        try:
            probe.initialize_for_discovery()
            return dict(probe.list_sessions(cwd, cursor), via='temporary-process')
        finally:
            probe.close()

    def connect(self, provider, cwd, resume=None, background=False, continue_anyway=False):
        if resume is not None and (not isinstance(resume, str) or len(resume) > 512):
            raise ValueError('Invalid saved session ID')
        self.evict_closed()
        workspace = pathlib.Path(cwd).expanduser().resolve()
        if self.worktrees and self.worktrees.is_removed(workspace, f'{provider}:{resume}' if resume else None):
            raise worktrees.WorktreeGone(worktrees.GONE_MESSAGE)   # discarded (or being removed): readable, not continuable
        record = self.worktrees.for_chat(provider, resume, workspace) if self.worktrees else None   # a chat that has a worktree keeps it, flag or no flag
        if record:
            workspace = pathlib.Path(self.worktrees.ensure(record)).resolve()   # made again from its branch if deleted; WorktreeGone if that is impossible
        if not workspace.is_dir():
            raise ValueError('Choose an existing workspace folder')
        if not agent_registry.is_provider(provider):
            raise ValueError('Choose an agent')
        command, env = self.agent_launch(provider, fresh=not resume)
        with self.lock:
            for connection in self.connections.values():
                if resume and connection.provider == provider and connection.session_id == resume and not connection.closed:
                    if not connection.ready:
                        raise OwnershipConflict('This conversation is already opening in Studio. Wait for it to finish.')
                    return connection
        plan = None
        if resume is None and self.worktrees and self.settings.worktree_per_chat():
            plan = self.worktrees.plan(workspace)   # None: this project works in place (the reason is logged)
        lease = SessionLease(self.state_dir, provider, resume).acquire() if resume else None
        connection = None
        try:
            if resume:
                owner = self.owner_probe(provider, resume, excluded_pids=(os.getpid(),))
                if owner is not None:
                    raise OwnershipConflict(f'This {provider} conversation is already open in another agent process (PID {owner}). Stop it in its current client before continuing here.')
            if resume:
                self.check_ownership(provider, resume, str(workspace), continue_anyway)
            options = {'env': env} if env else {}
            if plan:
                options['start'] = False   # the agent starts in finish_setup, once its worktree exists
            connection = self.connection_factory(command, plan.path if plan else workspace, provider, **options)
            if plan or record:
                connection.worktree = {'branch': plan.branch, 'base': plan.base} if plan else {'branch': record['branch'], 'base': record.get('base', '')}
                connection.project_root = str(workspace) if plan else record['project']   # cwd is the worktree, projectRoot the project
            connection.on_release = self._withdraw
            connection.on_turn_end = self._turn_ended
            if self.live_sync:
                connection.on_turn_start = self.live_sync.turn_started
                connection.context_for_prompt = self.live_sync.context_for
                connection.context_sent = self.live_sync.context_sent
            connection.caps.configure(getattr(self.options, 'enable_client_terminal', False), getattr(self.options, 'enable_client_fs', None))
            connection.session_lease = lease
            connection.mcp_servers = list(getattr(self.options, 'mcp_servers', None) or []) + self.artifact_mcp_servers(connection.id, bool(connection.worktree))  # artifact tool (agent C)
            connection.session_id = resume or None
            connection.recovery = self.recovery
            with self.lock:
                self.connections[connection.id] = connection
            if resume:
                self._announce(connection, 'opening')  # claim before session/load so other clients can see it
            def finish_setup():
                try:
                    if plan:
                        self._make_worktree(connection, plan, workspace)
                    connection.setup(resume or None)
                    if plan and self.worktrees.registry.get(plan.key):
                        self.worktrees.set_session(plan.key, provider, connection.session_id)
                    if not lease:
                        new_lease = SessionLease(self.state_dir, provider, connection.session_id).acquire()
                        with connection.lock:
                            if connection.closed or getattr(connection, '_closing', False):
                                new_lease.release()
                                raise RuntimeError('The agent disconnected while opening the conversation')
                            connection.session_lease = new_lease
                    if connection.closed:
                        raise RuntimeError('The agent disconnected while opening the conversation')
                    if self.recovery:
                        self.recovery.connection_ready(connection)
                    self._announce(connection, 'ready')
                    if self.live_sync:
                        try:
                            self.live_sync.chat_opened(connection)   # watch its project, catch it up on the user's saved edits
                        except Exception:
                            log.exception('Starting live sync failed')
                except Exception as error:
                    log.exception('Opening the conversation failed')
                    connection.error = str(error)
                    connection.close()
                    if plan and not connection.session_id:
                        self.worktrees.discard(plan.key)   # the chat never began: its worktree is not wanted
                    if connection.session_lease is None and lease:
                        lease.release()
                    if not background:
                        raise
                finally:
                    connection.open_done.set()
            if background:
                threading.Thread(target=finish_setup, daemon=True, name=f'agent-studio-open-{connection.id[:8]}').start()
                return connection
            finish_setup()
        except Exception as error:
            log.exception('Connecting to the agent failed')
            if connection:
                connection.error = str(error)
                connection.close()
            elif lease:
                lease.release()
            raise
        return connection

    def _make_worktree(self, connection, plan, project):
        """Make the chat's worktree (background thread), then start its agent there. If the project cannot have one after all
        (too much uncommitted work, LFS pointers, ...) the chat works in the project folder: it has not begun, so nothing is filed under another folder."""
        try:
            self.worktrees.create(plan)
        except worktrees.Fallback:
            connection.retarget(project)
            connection.project_root = str(project)
            connection.worktree = None
        if connection.closed:
            self.worktrees.discard(plan.key)
            raise RuntimeError('The chat was closed while it was starting')
        connection.start_process()

    # ---- Live-connection operations -------------------------------------------------------------
    # Everything the web server needs from the agent side, as plain data in and out. The HTTP handler calls
    # these on whatever backend it has: this Studio (--in-process) or a RemoteStudio that forwards them to the
    # agent host, which runs this same code. Keep them JSON-in, JSON-out.
    web_instance_id = property(lambda self: self.instance_id)
    host_mode = 'in-process'
    settings_view = settings_view
    notices = notices

    def live_info(self):
        with self.lock:
            open_ids = [c.id for c in self.connections.values() if not c.closed]
        return {'instanceId': self.instance_id, 'pid': os.getpid(), 'durableRecovery': bool(self.store), 'ownerAnnouncements': bool(self.owners), 'connections': open_ids}

    def evict_closed(self, now=None):
        """Forget closed connections: any closed longer than CLOSED_GRACE_SECONDS, then the oldest beyond MAX_CLOSED_CONNECTIONS.
        Until then a closed connection stays so the page can read its `disconnected` state. Dropping it frees its events, images and Popen."""
        now = self.clock() if now is None else now
        with self.lock:
            closed = sorted((c for c in self.connections.values() if c.closed and c.closed_at is not None), key=lambda c: c.closed_at)
            drop = [c for c in closed if now - c.closed_at > CLOSED_GRACE_SECONDS]
            keep = [c for c in closed if c not in drop]
            drop += keep[:max(0, len(keep) - MAX_CLOSED_CONNECTIONS)]
            for c in drop:
                self.connections.pop(c.id, None)
        for c in drop:
            try:
                c.tree.kill()
                for stream in (c.process.stdin, c.process.stdout, c.process.stderr):
                    if stream and not stream.closed:
                        stream.close()
            except Exception:
                log.exception('Closing a dropped connection failed')
            c.events.clear()
            c.event_image_bytes = 0
        return [c.id for c in drop]

    def live_list(self):
        self.evict_closed()
        with self.lock:
            connections = list(self.connections.values())
        with self.lock:
            pending = set(self._reconnect_pending)
        listed = []
        for c in connections:
            item = {k: v for k, v in c.public(light=True).items() if k not in ('events', 'permissions')}
            item['reconnecting'] = (c.provider, c.session_id) in pending and not c.closed
            listed.append(item)
        return {'connections': listed, 'autoReconnect': bool(self.store and self.auto_reconnect),
                'recovered': self.recovered(), 'recoveryWarning': self.store.warning if self.store else '', 'instanceId': self.instance_id}

    def live_state(self, connection_id, after=0):
        connection = self.connections.get(connection_id)
        return None if connection is None else connection.public(int(after))

    def emit_artifact(self, conversation_id, data):
        """Artifact created / new version: push {"type":"artifact",...} to the page as a normal conversation event (kind 'artifact')."""
        connection = self.connections.get(conversation_id)
        if connection is None:
            return False
        connection.event('artifact', data)
        return True

    def live_writes(self):
        """{connection id: [file paths that connection's agent wrote]} for open connections (the artifact watcher's only source of new artifacts)."""
        with self.lock:
            connections = [c for c in self.connections.values() if not c.closed]
        return {c.id: c.writes.written() for c in connections}

    def busy_connections(self):
        """Open connections that must not be cut off: working, still opening, or waiting for a person."""
        with self.lock:
            connections = list(self.connections.values())
        busy = []
        for c in connections:
            state = c.attention()['state']
            if state in ('working', 'opening', 'needs_you'):
                busy.append({'id': c.id, 'provider': c.provider, 'cwd': c.cwd, 'state': state})
        return busy

    def ownership_query(self, provider='', session_id='', cwd=''):
        if not provider and not session_id:
            self.probe.refresh_processes_async()
            return {'hints': self.probe.hints(), 'certainty': self.probe.list_certainty()}   # certainty: what a row without a hint means
        if not agent_registry.is_provider(provider) or not session_id or len(session_id) > 512:
            raise ValueError('Choose a provider and a saved session ID')
        security.refuse_network_path(cwd)
        return self.probe.assess(provider, session_id, cwd or None, fresh=True)

    # ---- Worktree removal (Discard, archive, delete) ---------------------------------------------
    def _worktree_record(self, path=None, session=None):
        record = self.worktrees.registry.find(path=path, session=session) if self.worktrees else None
        return record

    def _connections_in(self, path):
        with self.lock:
            return [c for c in self.connections.values() if not c.closed and worktrees._same(c.cwd, path)]

    def worktree_discard(self, body):
        """Discard: stop the chat's agent (its process tree and client terminals), then remove its worktree and branch. Needs body['confirm'] is True,
        the page's one confirmation; without it nothing happens. The only place --force is used."""
        if body.get('confirm') is not True:
            raise ValueError('Discarding needs the confirmation first; nothing was removed')
        connection = self.connections[body['id']]
        record = self._worktree_record(path=connection.cwd)
        if not record:
            raise ValueError('This chat has no worktree of its own')
        connection.close()   # closes the connection, kills the agent's process tree and any client terminals
        tree = getattr(connection, 'tree', None)
        if tree is not None:
            tree.kill()
        outcome = self.worktrees.remove(record['key'], confirmed=True)
        return {'ok': True, 'result': outcome, 'branch': record.get('branch', ''), 'removed': outcome == 'removed', 'pending': outcome == 'pending'}

    def worktree_archive(self, body):
        """Archive or delete of a chat that may have a worktree. Without changes against its diff base (and no live agent in it) the worktree and
        branch are removed silently, without --force. With changes it is kept and the page says so. Never blocks the archive."""
        provider, session_id = body.get('provider'), body.get('sessionId')
        session = f'{provider}:{session_id}' if isinstance(provider, str) and isinstance(session_id, str) and session_id else None
        path = body.get('cwd') if isinstance(body.get('cwd'), str) and body.get('cwd') else None
        record = self._worktree_record(path=path, session=session)
        if not record:
            return {'ok': True, 'worktree': None}
        branch = record.get('branch', '')
        if self._connections_in(record['path']):
            return {'ok': True, 'worktree': {'branch': branch, 'removed': False, 'live': True}}   # still running there: leave it
        if self.worktrees.has_changes(record):
            return {'ok': True, 'worktree': {'branch': branch, 'removed': False, 'keptChanges': True}}
        outcome = self.worktrees.remove(record['key'], confirmed=False)
        return {'ok': True, 'worktree': {'branch': branch, 'removed': outcome == 'removed', 'pending': outcome == 'pending'}}

    def install_call(self, action, agent_id):
        """The agent install job (agent_installer.py): action 'status', 'start' or 'cancel' for one built-in agent.
        Returns (HTTP status, payload); never raises for request errors. The job lives in this process, which is the agent host
        when there is one (it outlives the web server), so a restarted web server asks it again and sees the same job."""
        with self.lock:
            if getattr(self, 'installer', None) is None:
                self.installer = agent_installer.Installer(self.state_dir, getattr(self.options, 'node_command', '') or '')
        try:
            if action == 'start':
                return 200, dict(self.installer.start(agent_id), ok=True)
            if action == 'cancel':
                return 200, dict(self.installer.cancel(agent_id), ok=True)
            if action == 'status':
                return 200, dict(self.installer.status(agent_id), ok=True)
            return 404, {'error': 'Not found'}
        except agent_installer.InstallRefused as error:
            return 409, {'error': str(error), 'code': error.code}
        except (KeyError, ValueError, TypeError, OSError, RuntimeError) as error:
            return 400, {'error': str(error)}

    def signin_call(self, action, agent_id, force=False):
        """The sign-in check and Sign in job (agent_signin.py): action 'status', 'check', 'start' or 'cancel' for one built-in agent;
        'check' with an empty agent id checks every built-in agent that Studio can ask. Returns (HTTP status, payload); never raises for request errors.
        Like the install job it lives in this process, which is the agent host when there is one."""
        with self.lock:
            if getattr(self, 'signer', None) is None:
                self.signer = agent_signin.Signer(self.state_dir, lambda agent: builtin_launch(self.options, self.settings, agent))
        try:
            if action == 'check' and not agent_id:
                return 200, {'ok': True, 'agents': {a: self.signer.check(a, bool(force)) for a in adapters.STUDIO_PACKAGES}}
            if action == 'check':
                return 200, dict(self.signer.check(agent_id, bool(force)), ok=True)
            if action == 'start':
                return 200, dict(self.signer.start(agent_id), ok=True)
            if action == 'cancel':
                return 200, dict(self.signer.cancel(agent_id), ok=True)
            if action == 'status':
                return 200, dict(self.signer.status(agent_id), ok=True)
            return 404, {'error': 'Not found'}
        except agent_signin.SignInRefused as error:
            return 409, {'error': str(error), 'code': error.code}
        except (KeyError, ValueError, TypeError, OSError, RuntimeError) as error:
            return 400, {'error': str(error)}

    LIVE_POST_OPS = frozenset({'connect', 'discover', 'forget', 'prompt', 'cancel', 'permission', 'authenticate', 'elicitation', 'config', 'mode', 'cancel-pending', 'session-op', 'disconnect',
                           'queue', 'queue-edit', 'queue-remove', 'queue-move', 'queue-resume', 'queue-send-now', 'dismiss-unknown', 'worktree-discard', 'worktree-archive'})

    def live_call(self, name, body):
        """One POST /api/live/<name> request. Returns (HTTP status, JSON payload); never raises for request errors."""
        try:
            return self._live_call(name, body)
        except OwnershipConflict as error:
            return 409, dict({'error': str(error), 'code': getattr(error, 'code', 'session_in_use')}, **({'ownership': error.verdict} if getattr(error, 'verdict', None) else {}))
        except PromptStateUnknown as error:
            return 409, {'error': str(error), 'code': 'prompt_state_unknown'}
        except (KeyError, ValueError, TypeError, OSError, RuntimeError, TimeoutError) as error:
            return 400, {'error': str(error)}

    def _live_call(self, name, body):
        if not isinstance(body, dict):
            raise ValueError('Invalid request')
        if name == 'connect':
            background = body.get('background', False)
            if not isinstance(background, bool):
                raise ValueError('background must be a boolean')
            continue_anyway = body.get('continueAnyway', False)
            if not isinstance(continue_anyway, bool):
                raise ValueError('continueAnyway must be a boolean')
            return 200, self.connect(body['provider'], body['cwd'], body.get('resume'), background=background, continue_anyway=continue_anyway).public()
        if name == 'discover':
            return 200, self.list_agent_sessions(body['provider'], body.get('cwd'), body.get('cursor'))
        if name == 'forget':
            return 200, {'ok': True, 'forgotten': self.forget_recovered(body.get('provider'), body.get('sessionId'))}
        if name == 'worktree-note':   # internal (worktree_merge.py): not in LIVE_POST_OPS, so no page route reaches it
            connection = self.connections[body['id']]
            data = {'message': str(body['message'])[:300], 'sessionId': connection.session_id}
            actions = [{'id': a['id'], 'label': str(a.get('label') or a['id'])[:40]} for a in (body.get('actions') or [])
                       if isinstance(a, dict) and a.get('id') in ('keep-mine', 'leave')]   # buttons in the note: only Studio's own two
            if actions:
                data['actions'] = actions
            connection.event('studio_note', data)
            return 200, {'ok': True}
        if name not in self.LIVE_POST_OPS:
            return 404, {'error': 'Not found'}
        if name == 'worktree-discard':
            return 200, self.worktree_discard(body)
        if name == 'worktree-archive':
            return 200, self.worktree_archive(body)
        if name == 'dismiss-unknown':
            provider, session_id, message_id = body.get('provider'), body.get('sessionId'), body.get('clientMessageId')
            if body.get('id') in self.connections:
                connection = self.connections[body['id']]
                provider, session_id = connection.provider, connection.session_id
            if not (self.store and isinstance(provider, str) and isinstance(session_id, str) and isinstance(message_id, str)):
                raise ValueError('provider, sessionId and clientMessageId are required')
            return 200, {'ok': True, 'dismissed': self.store.dismiss_receipt(provider, session_id, message_id)}
        connection = self.connections[body['id']]
        if name == 'prompt':
            result = connection.prompt(body.get('text', ''), body.get('clientMessageId'), body.get('attachments'))
            if connection.provider and connection.session_id and not result.get('duplicate'):
                try:
                    self.conversations.apply('handled', connection.provider, connection.session_id)   # replying is acting
                except ValueError:
                    pass
            return 200, dict(ok=True, **result)
        if name == 'queue':
            result = connection.queue_add(body.get('text', ''), body.get('clientMessageId'), body.get('attachments'))
            if connection.provider and connection.session_id and not result.get('duplicate'):
                try:
                    self.conversations.apply('handled', connection.provider, connection.session_id)   # queueing a reply is acting
                except ValueError:
                    pass
            return 200, dict(ok=True, **result)
        if name == 'queue-edit':
            return 200, connection.queue_edit(body['messageId'], body['action'], body.get('leaseId'), body.get('text'))
        if name == 'queue-remove':
            return 200, connection.queue_remove(body['messageId'])
        if name == 'queue-move':
            return 200, connection.queue_move(body['messageId'], body['to'])
        if name == 'queue-resume':
            return 200, connection.queue_resume()
        if name == 'queue-send-now':
            return 200, connection.queue_send_now(body['messageId'])
        if name == 'cancel':
            connection.cancel(body.get('subagentSessionId'))
        elif name == 'permission':
            connection.permission(body['key'], body.get('option'))
        elif name == 'authenticate':
            connection.answer_auth(body['action'], body.get('methodId'))
        elif name == 'elicitation':
            connection.answer_elicitation(body['key'], body['action'], body.get('content'))
        elif name == 'config':
            return 200, dict(ok=True, **connection.change_setting('config', body['configId'], body['value']))  # queued when a turn is running
        elif name == 'mode':
            return 200, dict(ok=True, **connection.change_setting('mode', None, body['modeId']))
        elif name == 'cancel-pending':
            return 200, {'ok': True, 'pendingChanges': connection.cancel_pending(body['key'])}
        elif name == 'session-op':
            deleted_ref = (connection.provider, connection.session_id) if body.get('op') == 'delete' else None
            result = breadth.session_op(connection, body)
            payload = dict(ok=True, **result)
            if deleted_ref and result.get('done') == 'delete':
                payload['_deleted'] = list(deleted_ref)  # the web layer owns conversation marks and removes this key
            return 200, payload
        elif name == 'disconnect':
            connection.close()
        return 200, {'ok': True}

    def close(self):
        if self.live_sync:
            self.live_sync.stop_all()
        self._heartbeat_stop.set()
        self._reconnect_stop.set()
        if self.recovery:
            self.recovery.shutting_down = True
        for connection in list(self.connections.values()):
            connection.close()
        if self.owners:
            self.owners.withdraw_all()
        if self.store:
            self.store.mark_working_unknown()


def add_agent_arguments(parser):
    """Flags that decide how agents are started. Shared by studio.py and agent_host.py."""
    if os.environ.pop('AIB_BUNDLED_PYTHON', None):
        os.environ.pop('PYTHONHOME', None)   # the desktop app pins it for its own interpreter only: agents must not inherit it
    adapters.init_environment()   # macOS/Linux: the login-shell PATH, before any lookup below (no-op on Windows and after the first call)
    parser.add_argument('--state-dir', type=pathlib.Path, default=None, help='Where Studio keeps its data. Default: the private per-user folder for the main checkout, the old work/agent-studio-state for a git worktree (see state_paths.py); env AGENT_STUDIO_STATE_DIR also works')
    parser.add_argument('--omp-sessions', type=pathlib.Path, default=pathlib.Path.home()/'.omp/agent/sessions')
    parser.add_argument('--claude-projects', type=pathlib.Path, default=pathlib.Path.home()/'.claude/projects')
    parser.add_argument('--omp-command', default=adapters.default_omp_command(), help='The OMP program (default: omp on PATH; on Windows also %%LOCALAPPDATA%%\\omp\\omp.exe)')
    parser.add_argument('--node-command', default=shutil.which('node') or 'node')
    parser.add_argument('--claude-launcher', default='', help='A JavaScript entry point node runs for Claude Code, instead of the installed claude-agent-acp (default: the installed adapter; a launcher saved in Settings is tried before it)')
    parser.add_argument('--codex-launcher', default='', help='A JavaScript entry point node runs for Codex, instead of the installed codex-acp')
    parser.add_argument('--owners-dir', type=pathlib.Path, default=ownership_probe.default_owners_dir(), help='Shared folder where Studio announces the conversations it owns and reads other clients\' announcements (default: %%LOCALAPPDATA%%/agent-sessions/owners). See docs/ownership-design.md')
    parser.add_argument('--no-auto-reconnect', dest='auto_reconnect', action='store_false', help='Do not reload the conversations that were open before a restart. By default the agent host (or an --in-process server) reconnects them in the background after it starts, skipping any that another app may be using; nothing is ever sent')
    parser.add_argument('--no-owner-announcements', action='store_true', help='Do not write or read owner announcements')
    parser.add_argument('--enable-client-terminal', action='store_true', help='OFF by default. Let agents run commands through ACP terminal/* requests, confined to the conversation workspace folder (see docs/client-capabilities.md)')
    parser.add_argument('--enable-client-fs', nargs='?', const='readwrite', choices=('read', 'readwrite'), default=None, metavar='MODE', help='OFF by default. Let agents read (MODE=read) or read and write (MODE=readwrite, the default when MODE is omitted) text files inside the workspace folder through ACP fs/* requests')
    parser.add_argument('--no-artifact-tool', action='store_true', help='Do not give agents Studio\'s artifact tool (the studio_artifact MCP server that publishes pages to the Artifacts panel)')
    parser.add_argument('--mcp-config', type=pathlib.Path, metavar='PATH.json', help='JSON file listing MCP servers to give every session (a list, or {"mcpServers": [...]}; stdio entries {name, command, args, env:[{name,value}]}; http/sse entries {type, name, url, headers:[{name,value}]} are sent only to agents that advertise them). Default: none')


def finish_agent_options(options, parser):
    options.mcp_servers = []
    if options.no_owner_announcements:
        options.owners_dir = None
    if options.mcp_config:
        try:
            options.mcp_servers = breadth.load_mcp_config(options.mcp_config)
        except ValueError as error:
            parser.error(f'--mcp-config: {error}')


ROUTE_SET = web_handler.Routes(Studio.LIVE_POST_OPS)   # the one route table (web_handler.route_specs): dispatch and scopes both come from it
ROUTES = ROUTE_SET.security   # the security.RouteTable (the monitor's routes plus Studio's) that security.authorize reads



def serve(server, studio):
    """Run the web server until it is stopped (Ctrl+C, SIGTERM/SIGBREAK, POST /api/live/shutdown), then close. For a split
    Studio, close only detaches: the agent host and its conversations keep running."""
    security.install_shutdown_signals(server)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        studio.close()
        server.server_close()


def create_server(options, backend=None, connection_factory=None):
    """The web server. backend=None runs agents in this process (Studio); pass a RemoteStudio to use the agent host."""
    server = monitor.create_server(options.omp_sessions, options.port, options.claude_projects)
    catalog = getattr(server, 'catalog', None)
    chat_folders.SAVED_CWD = catalog.session_cwd if hasattr(catalog, 'session_cwd') else None
    if catalog is not None and hasattr(options, 'state_dir'):
        catalog.set_project_resolver(worktrees.ProjectResolver(options.state_dir))   # saved worktree chats map back to their project
    base = server.RequestHandlerClass
    studio = backend if backend is not None else Studio(options, connection_factory=connection_factory)
    folder_memory = folders.FolderMemory(getattr(studio, 'state_dir', None) if hasattr(options, 'state_dir') else None)
    worktrees.KNOWN_PROJECTS = lambda: [k[2:] for k in list(getattr(getattr(studio, 'project_prefs', None), 'projects', {}) or {}) if isinstance(k, str) and k.startswith('w:')]   # a known project folder inside a repo wins for chats in any worktree
    launcher = editors.Launcher(lambda: editors.known_roots(studio), preferred=lambda: studio.settings.snapshot()['editors']['default'])
    server.editor_launcher = launcher   # tests replace its popen
    # ---- artifacts: store, watcher and the separate artifact origin (see docs/design/artifacts-contract.md) ----
    scratch = None if hasattr(options, 'state_dir') else tempfile.TemporaryDirectory(prefix='studio-artifacts-')
    artifact_store = artifacts.ArtifactStore((pathlib.Path(options.state_dir) if scratch is None else pathlib.Path(scratch.name)) / 'artifacts')
    artifact_origin_server = artifact_origin.OriginServer(artifact_store.root, server.server_port)
    artifact_store.origin = artifact_origin_server.url
    server.gate.artifact_ports.add(artifact_origin_server.port)   # the artifact origin is same-site, never the page: hard-denied as Host or Origin
    # A chat's artifacts are keyed by its lasting id ("provider:sessionId"), not the live connection id, so they survive a reconnect.
    def open_connections():
        return [c for c in studio.live_list().get('connections', []) if not c.get('closed')]

    def chat_of(ident):
        for c in open_connections():
            if c.get('id') == ident and c.get('provider') and c.get('sessionId'):
                return f"{c['provider']}:{c['sessionId']}"
        return ident

    def connection_of(ident):
        for c in open_connections():
            if c.get('id') == ident or (c.get('provider') and c.get('sessionId') and f"{c['provider']}:{c['sessionId']}" == ident):
                return c.get('id')
        return None

    def emit_to_chat(chat, data):
        target = connection_of(chat)
        return bool(target) and studio.emit_artifact(target, dict(data, conversationId=target))

    def project_root_of(ident):
        # The chat's projectRoot (what its artifacts are tagged with): a live connection's, else None, which means its cwd.
        target = connection_of(ident)
        for c in open_connections():
            if target and c.get('id') == target:
                return c.get('projectRoot') or None
        return None

    artifact_service = artifacts.Service(artifact_store, lambda: studio.token, lambda ident: artifact_folder(studio, connection_of(ident) or ident),
                                         emit_to_chat, chat_of=chat_of, root_for=lambda ident: project_root_of(ident))

    def artifact_conversations():
        # 'writes': the files each chat's own agent wrote (in-process: read from the connection; split: asked from the agent host).
        # Chats with several connections (a reconnect) merge their lists. The watcher attaches nothing else.
        written = studio.live_writes()
        merged = {}
        for c in open_connections():
            chat = chat_of(c.get('id'))
            entry = merged.setdefault(chat, {'id': chat, 'cwd': c.get('cwd'), 'projectRoot': c.get('projectRoot') or c.get('cwd'), 'writes': []})
            entry['writes'].extend(p for p in written.get(c.get('id'), []) if p not in entry['writes'])
        return list(merged.values())
    artifact_watcher = artifacts.Watcher(artifact_service, artifact_conversations)
    artifact_watcher.start()
    server.api_token_getter = lambda: studio.token   # monitor routes check the same page token as Studio's own
    server.artifact_service, server.artifact_store,server.artifact_origin = artifact_service, artifact_store, artifact_origin_server
    original_server_close = server.server_close

    def server_close():
        artifact_watcher.stop()
        artifact_origin_server.stop()
        original_server_close()
        if scratch is not None:
            scratch.cleanup()
    server.server_close = server_close

    updates = updater.UpdateService(options.state_dir if scratch is None else scratch.name, auto_check=studio.settings.auto_update_check, busy_chats=lambda: len(studio.busy_connections()),
                                    quit_fn=lambda: threading.Thread(target=server.shutdown, daemon=True, name='update-quit').start())
    server.updates = updates
    original_close = server.server_close
    server.server_close = lambda: (updates.stop(), original_close())[1]
    web_context = web_handler.WebContext(studio, options, launcher, folder_memory, artifact_service, artifact_store, ROUTE_SET, updates)
    Handler = web_handler.make_handler(base, web_context)

    server.RequestHandlerClass = Handler
    return server, studio


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8767, help='Local HTTP port (default: 8767)')
    add_agent_arguments(parser)
    log_setup.add_arguments(parser)
    parser.add_argument('--open', action='store_true', help='Open Agent Studio in your default browser')
    parser.add_argument('--in-process', action='store_true', help='Run agents inside this process, as before the agent host existed: restarting this server then ends every conversation. For tests and debugging (see docs/agent-host.md)')
    parser.add_argument('--stop-host', action='store_true', help='Ask the agent host for --state-dir to stop and exit; refuses while a conversation is working, opening or waiting for you unless --force')
    parser.add_argument('--force', action='store_true', help='With --stop-host: stop even if conversations are working (their turns are cut off)')
    parser.add_argument('--host-port', type=int, default=0, help='Loopback port for a new agent host (default: random; clients read it from <state-dir>/agent-host.json)')
    parser.add_argument('--host-idle-minutes', type=float, default=30, help='A new agent host exits after this long with no open conversation and no web server attached (default 30; 0 = never)')
    parser.add_argument('--migrate-from', type=pathlib.Path, default=None, metavar='PATH', help='Move the data of this old state folder into --state-dir once (default source for the per-user folder: work/agent-studio-state next to the main checkout)')
    options = parser.parse_args()
    finish_agent_options(options, parser)
    state_paths.apply(options, parser, HERE, attempt_migration=not options.stop_host)
    if not 0 <= options.port <= 65535:
        parser.error('--port must be between 0 and 65535')
    log_setup.setup('studio', level=options.log_level, state_dir=options.state_dir, filename='studio.log')
    os.environ.setdefault(log_setup.ENV_LEVEL, str(options.log_level))   # a host this server starts logs at the same level
    if options.stop_host:
        result = host_client.stop_host(options.state_dir, options.force)
        print(result['message'])
        for item in result.get('active') or []:
            print(f"  {item['provider']} in {item['cwd']}: {item['state']}")
        sys.exit(0 if result.get('stopped') or not result.get('running') else 2)
    try:
        server, studio = create_server(options, None if options.in_process else attach_host(options))
    except OSError as error:
        parser.error(str(error))
    atexit.register(studio.close)
    server.updates.start()   # the daily update check and the wait-for-idle install (a test's create_server does not start it)
    if options.in_process:
        studio.start_auto_reconnect()
    url = f'http://127.0.0.1:{server.server_port}'
    try:   # artifact tool (agent C): agents re-read this when Studio restarts on another port
        (pathlib.Path(options.state_dir) / ARTIFACT_URL_FILE).write_text(json.dumps({'url': url, 'pid': os.getpid()}), encoding='utf-8')
    except OSError:
        pass
    if options.in_process:
        print(f'Agent Studio: {url}\nIn-process mode: keep this process running while agents work. Ctrl+C stops owned ACP connections.', flush=True)
    else:
        print(f'Agent Studio: {url}\nAgents run in the separate agent host, so this server can be restarted without stopping them (python studio.py --stop-host ends the host).', flush=True)
    runtime = runtime_gc.current_runtime(HERE)
    if runtime is not None:   # the desktop app: drop older versions' runtime folders that no agent host uses any more
        threading.Thread(target=runtime_gc.collect, args=(options.state_dir, runtime), daemon=True, name='runtime-gc').start()
    if options.open:
        webbrowser.open(url)
    serve(server, studio)


if __name__ == '__main__':
    main()
