"""Plain-data wrappers around worktrees.py and worktree_merge.py for the Deno parity and interop tests
(work/deno/worktrees_test.ts, work/deno/worktree_merge_test.ts). Only temp folders and temp git repos are ever passed in.

set_env(env)                                   sets (None: removes) environment variables, e.g. fixed git dates so both sides make the same commits
registry(state_dir, method, args, kwargs)      Registry(state_dir).<method>(...)
manager(state_dir, method, args)               Manager(state_dir).<method>(...); a Plan argument is passed as its dict
call(name, args, kwargs)                       worktrees.<name>(...) (paths in the result as str)
merge(state_dir, chat_id, state, op, args)     worktree_merge.<op>(studio, chat_id, *args) over a fake studio whose live_state
                                               returns `state`; returns {'result'} or {'refused': [code, status, message]}, plus the
                                               live_call calls made ('calls')
"""
import os
import pathlib

import worktree_merge
import worktrees


def set_env(env):
    for name, value in env.items():
        if value is None:
            os.environ.pop(name, None)
        else:
            os.environ[name] = value
    return True


def _plain(value):
    if isinstance(value, pathlib.PurePath):
        return str(value)
    if isinstance(value, (list, tuple)):
        return [_plain(v) for v in value]
    if isinstance(value, dict):
        return {k: _plain(v) for k, v in value.items()}
    return value


def registry(state_dir, method, args=(), kwargs=None):
    return _plain(getattr(worktrees.Registry(state_dir), method)(*args, **(kwargs or {})))


def manager(state_dir, method, args=()):
    args = [worktrees.Plan(a['project'], a['base'], a['key'], a['slug'], a['branch'], a['path']) if isinstance(a, dict) and a.get('__class__') == 'Plan' else a
            for a in args]
    try:
        result = getattr(worktrees.Manager(state_dir), method)(*args)
    except worktrees.Fallback as error:
        return {'fallback': str(error)}
    except worktrees.WorktreeGone as error:
        return {'gone': str(error)}
    if isinstance(result, worktrees.Plan):
        return dict(vars(result), __class__='Plan')
    return _plain(result)


def call(name, args=(), kwargs=None):
    return _plain(getattr(worktrees, name)(*args, **(kwargs or {})))


class _Studio:
    def __init__(self, state_dir, chat_id, state):
        self.state_dir = pathlib.Path(state_dir)
        self.chat_id, self.state, self.calls = chat_id, state, []

    def live_state(self, chat_id):
        if chat_id != self.chat_id:
            raise KeyError(chat_id)
        return dict(self.state)

    def live_call(self, op, payload):
        self.calls.append([op, payload])
        return 200, {}


def merge(state_dir, chat_id, state, op='merge', args=()):
    studio = _Studio(state_dir, chat_id, state)
    try:
        if op == 'clash_status':
            out = {'result': worktree_merge.clash_status(studio, *args)}
        else:
            out = {'result': getattr(worktree_merge, op)(studio, chat_id, *args)}
    except worktree_merge.Refused as error:
        out = {'refused': [error.code, error.status, str(error)]}
    out['calls'] = studio.calls
    return out
