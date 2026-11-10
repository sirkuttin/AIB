"""Plain-data wrappers around worktree_sync.py for the Deno parity and interop tests (work/deno/worktree_sync*_test.ts).
Only temp folders and temp git repos are ever passed in. Nothing here starts a thread: scans are run one at a time by the caller, so
both sides see exactly the same sequence of edits.

open(name, state_dir, chats)          a LiveSync (watch_folders off) over a fake studio; chats = [{id, cwd, state}] (state is what
                                      connection.public(0) returns); the session is kept under `name`
scan(name, project)                   one ProjectSync.scan() of the project (the ProjectSync is kept per project; never started)
op(name, method, chat, args, kwargs)  live.<method>(...); `chat` names a connection that is passed first, or None
                                      ('context_for' returns [text, token] or None)
call(name, args, kwargs)              worktree_sync.<name>(...)
set_attr(name, value)                 worktree_sync.<name> = value (e.g. WORKTREE_WAIT)
close(name)                           forgets the session
"""
import pathlib
import threading

import worktree_sync
import worktrees

SESSIONS = {}


class _Settings:
    def worktree_per_chat(self):
        return True


class _Connection:
    def __init__(self, cwd, state):
        self.cwd, self.state, self.closed, self.worktree = cwd, state, False, True

    def public(self, since=0):
        return dict(self.state)


class _Studio:
    def __init__(self, state_dir):
        self.state_dir = pathlib.Path(state_dir)
        self.worktrees = worktrees.Manager(state_dir)
        self.settings = _Settings()
        self.connections = {}
        self.lock = threading.RLock()


def _plain(value):
    if isinstance(value, pathlib.PurePath):
        return str(value)
    if isinstance(value, (list, tuple)):
        return [_plain(v) for v in value]
    if isinstance(value, dict):
        return {k: _plain(v) for k, v in value.items()}
    return value


def open(name, state_dir, chats):  # noqa: A001
    studio = _Studio(state_dir)
    for chat in chats:
        studio.connections[chat['id']] = _Connection(chat['cwd'], chat.get('state') or {'state': 'ready', 'busy': False})
    live = worktree_sync.LiveSync(studio, watch_folders=False)
    SESSIONS[name] = {'studio': studio, 'live': live, 'syncs': {}}
    return True


def scan(name, project):
    session = SESSIONS[name]
    sync = session['syncs'].get(project)
    if sync is None:
        sync = session['syncs'][project] = worktree_sync.ProjectSync(session['live'], project)
    with sync.lock:
        sync.scan()
    return {'waiting': sync.waiting, 'wasPaused': sync.was_paused, 'reset': sync.reset}


def op(name, method, chat=None, args=(), kwargs=None):
    session = SESSIONS[name]
    live = session['live']
    if method == 'set_state':
        session['studio'].connections[chat].state = args[0]
        return True
    head = [session['studio'].connections[chat]] if chat is not None else []
    if method == 'sync_chat':   # items arrive as {path: null}
        args = [args[0], dict(args[1]), *args[2:]]
    return _plain(getattr(live, method)(*head, *args, **(kwargs or {})))


def call(name, args=(), kwargs=None):
    return _plain(getattr(worktree_sync, name)(*args, **(kwargs or {})))


def set_attr(name, value):
    setattr(worktree_sync, name, value)
    return True


def close(name):
    SESSIONS.pop(name, None)
    return True
