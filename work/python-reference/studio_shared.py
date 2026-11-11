"""Helpers both Studio (in-process) and RemoteStudio (web server proxy) use, kept apart so neither module imports the other."""
import logging
import host_client
import state_paths
import agent_registry
import adapters
import agent_installer
import agent_signin
from host_client import HostUnavailable

log = logging.getLogger(__name__)


def builtin_launch(options, settings, agent_id):
    """adapters.py lookup for one built-in agent: {argv, source, path, found, problem, text}. Flag, then Settings, then Studio's own install, then the globally installed adapter."""
    node = getattr(options, 'node_command', '') or ''
    if agent_id == 'omp':
        return adapters.resolve_omp(getattr(options, 'omp_command', '') or '')
    flag = str(getattr(options, f'{agent_id}_launcher', '') or '')
    saved = settings.launcher(agent_id) if settings is not None else ''
    state_dir = getattr(options, 'state_dir', None)   # Studio's own installs live under it; read fresh on every call
    return (adapters.resolve_claude if agent_id == 'claude' else adapters.resolve_codex)(flag, saved, node, state_dir=state_dir)


def install_state(options, agent_id):
    """The Studio install job of a built-in agent while it is running or has failed ({state, stage, percent, message, ...}), else None.
    Read from the job's state file, so a restarted web server still shows the progress of a job in the agent host."""
    state_dir = getattr(options, 'state_dir', None)
    if not state_dir or agent_id not in adapters.STUDIO_PACKAGES:
        return None
    view = agent_installer.read_status(state_dir, agent_id)
    return view if view['state'] in ('running', 'failed') else None


def signin_view(options, agent_id, live_status=''):
    """The Status column of a built-in agent: {state: ready|signin|unknown, checkedAt, job}. Read from disk only (the cache the check writes and the job
    file), so the Settings poll never runs a status command; a chat that is open now overrides the cache."""
    state_dir = getattr(options, 'state_dir', None)
    if not state_dir or agent_id not in adapters.STUDIO_PACKAGES:
        return None
    cached = agent_signin.read_cached(state_dir, agent_id)
    job = agent_signin.read_job(state_dir, agent_id)
    return {'state': agent_signin.effective_state(cached['state'], live_status), 'checkedAt': cached['checkedAt'], 'job': job if job['state'] != 'idle' else None}


def describe_agents(options, settings, connections=(), recheck=False):
    """The agent list the Settings page and the New chat dropdown read: built-ins first, then user-added agents.
    Each: {id, name, letter, builtin, enabled, command (display text), args, env, found, resolved, problem, status, install, installable}.
    install is the running or failed Studio install job of Claude Code / Codex (else None); installable says Studio can install the agent.
    signin is {state: ready|signin|unknown, checkedAt, job} for an installed Claude Code / Codex (else None); unknown is shown as "Not checked" and counts as ready.
    status is '' (nothing known), 'running' (a chat of this agent is open and ready) or 'signin' (an open chat is waiting for sign-in);
    it comes from chats already open, so nothing is started to find it out."""
    state = {}
    for c in connections or ():
        if not isinstance(c, dict) or c.get('closed'):
            continue
        provider = c.get('provider')
        if c.get('auth'):
            state[provider] = 'signin'
        elif c.get('ready') and state.get(provider) != 'signin':
            state[provider] = 'running'
    snap = settings.snapshot()
    out = []
    block, node_found, sizes = '', True, {}
    if any(adapters.STUDIO_PACKAGES):
        try:
            block, node_found = agent_installer.node_block(getattr(options, 'node_command', '') or '', force=recheck)
            sizes = {k: v.get('packageBytes') for k, v in agent_installer.load_allow_list().items()}
        except (ValueError, OSError):
            pass
    for agent_id, letter in (('omp', 'O'), ('claude', 'C'), ('codex', 'X')):
        row = builtin_launch(options, settings, agent_id)
        # `launcher`: read-only text for Settings saying which program starts this agent (and where it came from)
        out.append({'id': agent_id, 'name': agent_registry.BUILTIN_NAMES[agent_id], 'letter': letter, 'builtin': True, 'enabled': snap['agents']['builtin'][agent_id],
                    'command': row['text'], 'launcher': row['text'], 'launcherSource': row['source'], 'args': [], 'env': [],
                    'found': row['found'], 'resolved': row['path'] if row['found'] else '', 'problem': row['problem'], 'status': state.get(agent_id, ''),
                    'install': install_state(options, agent_id), 'installable': agent_id in adapters.STUDIO_PACKAGES,
                    'installBlock': block if agent_id in adapters.STUDIO_PACKAGES and row['source'] == 'missing' else '',
                    'installHint': ('Or install it yourself with: ' + adapters.CODEX_INSTALL) if agent_id == 'codex' and not node_found and row['source'] == 'missing' else '',
                    'packageBytes': sizes.get(agent_id) or 0,
                    'signin': signin_view(options, agent_id, state.get(agent_id, '')) if row['found'] else None})
    for a in snap['agents']['custom']:
        found, problem = agent_registry.command_status(a['command'])
        out.append({'id': a['id'], 'name': a['name'], 'letter': agent_registry.letter_of(a['name']), 'builtin': False, 'enabled': a['enabled'], 'command': a['command'],
                    'launcher': a['command'], 'launcherSource': 'custom', 'args': list(a['args']), 'env': agent_registry.hidden_env(a['env']),
                    'found': bool(found), 'resolved': found, 'problem': problem, 'status': state.get(a['id'], '')})
    return out


def settings_view(self, recheck=False):
    """GET /api/live/settings: the stored settings, the agent list with live status, and the revision other windows compare."""
    try:
        connections = self.live_list().get('connections', [])
    except (HostUnavailable, ValueError, RuntimeError, OSError):
        connections = []
    return dict(self.settings.public(), agents=describe_agents(self.options, self.settings, connections, recheck=recheck), **self.notices())


_PACKAGE = []   # cached package_context() of this process (it cannot change while running)


def package_notice(package, state_dir):
    """The amber line when Studio itself runs inside a packaged app's sandbox (its data is then in that app's private folder)."""
    if not package:
        return ''
    return (f"AIB is running inside {state_paths.package_label(package)}'s sandbox, so its data is stored in that app's private folder ({state_dir}). "
            'Restart AIB from outside that app to use your normal data folder.')


def sandbox_notice(migration):
    """The line for a data folder held in a packaged app's sandbox that this (unpackaged) Studio did not move: waiting, conflict, or refused."""
    m = migration or {}
    if m.get('kind') != 'sandbox' or m.get('state') in (None, 'none'):
        return ''
    left = m.get('worktreesLeft') or 0
    if m['state'] == 'done':
        return (f"{left} chat worktree{'s' if left != 1 else ''} stay{'' if left != 1 else 's'} in the old folder ({m.get('source')}): moving a git worktree would break its link to the repository. "
                'Nothing was deleted there.') if left else ''
    source = m.get('source') or "the Claude app's private folder"
    if m['state'] == 'conflict':
        return (f"AIB data exists in two places: your normal folder and the Claude app's private folder ({source}). AIB is using the normal folder "
                'and has not merged or overwritten anything. Decide which one to keep and move the other aside; AIB will not choose for you.')
    if m['state'] == 'waiting':
        return (f"Waiting to move your data from the Claude app's private folder ({source}): {m.get('reason') or 'something there is still running'}. "
                'AIB keeps using that folder for now and tries again at its next start, once no chat is working and the agent host there has stopped.')
    return f"Moving your data from the Claude app's private folder ({source}) did not happen: {m.get('reason') or m['state']}. AIB is using your normal folder."


def notices(self):
    """What the page may show as a banner: migration {state, reason} ('waiting', 'blocked' or 'failed' mean this run uses the old data folder),
    hostCodeWarning (the running agent host loaded older code than this web server; '' when fine), packageNotice (Studio runs inside a
    packaged app's sandbox), sandboxNotice (a copy of the data in such a sandbox waits to be moved, conflicts or was refused) and packageContext."""
    if not _PACKAGE:
        _PACKAGE.append(state_paths.package_context())
    migration = getattr(self.options, 'migration', None) or {'state': 'none'}
    return {'migration': migration, 'hostCodeWarning': host_client.code_warning(getattr(self, 'host_info', None)),
            'packageContext': _PACKAGE[0], 'packageNotice': package_notice(_PACKAGE[0], getattr(self.options, 'state_dir', '')),
            'sandboxNotice': sandbox_notice(migration),
            'hostTakeoverWaiting': getattr(self, 'waiting_chats', 0) or 0}   # chats another AIB version still has working: this one switches over when they finish


def conversation_action(self, body):
    """Validated pin/archive/delete/restore request. Returns (status, payload)."""
    if not isinstance(body, dict):
        raise ValueError('Invalid request')
    action, provider, session_id = body.get('action'), body.get('provider'), body.get('sessionId')
    if action == 'delete' and self._studio_owns(provider, session_id):
        return 409, {'error': 'This conversation is live in AIB. End the AIB session first; nothing was deleted.', 'code': 'session_live'}
    title, cwd = body.get('title', ''), body.get('cwd', '')
    note, project_root = body.get('note', ''), body.get('projectRoot', '')
    entry = self.conversations.apply(action, provider, session_id, title=title if isinstance(title, str) else '',
                                     cwd=cwd if isinstance(cwd, str) else '', project_root=project_root if isinstance(project_root, str) else '', note=note if isinstance(note, str) else '')
    payload = {'ok': True, 'entry': entry, 'revision': self.conversations.revision()}
    if action in ('archive', 'delete') and isinstance(provider, str) and isinstance(session_id, str):
        removal = _worktree_after(self, provider, session_id)
        if removal is not None:
            payload['worktree'] = removal
    return 200, payload


def _worktree_after(self, provider, session_id):
    """A chat in its own Studio worktree that is archived or deleted: ask the side that owns the agents to remove a worktree without changes
    (see Studio.worktree_archive); one with changes is kept. None for every other chat (nothing is called, nothing changes). Never fails the action."""
    import worktrees
    try:
        if not worktrees.Registry(self.state_dir).find(session=f'{provider}:{session_id}'):
            return None
        status, answer = self.live_call('worktree-archive', {'provider': provider, 'sessionId': session_id})
    except Exception:
        log.exception('Checking the chat\'s worktree after archive failed')
        return None
    return answer.get('worktree') if status == 200 and isinstance(answer, dict) else None
