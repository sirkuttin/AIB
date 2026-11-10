"""Plain-data wrappers around state_paths for the Deno parity tests (work/deno/state_paths_test.ts).

pathlib paths become str, Resolved/Plan become dicts, `say` callbacks are collected into a list, and package_context can be forced
(the Python tests mock it the same way). Errors propagate, so py_call.py reports RealFolderBlocked / StateDirInsecure by name.
"""
import os
from unittest import mock

import state_paths


def user_state_dir(env, platform, home):
    return str(state_paths.user_state_dir(env, platform, home))


def resolve(cli, env, code_root, platform=None, home=None):
    found = state_paths.resolve(cli, env, code_root, platform, home)
    return {'path': str(found.path), 'source': found.source, 'isUserFolder': found.is_user_folder}


def real_user_state_dir(env, platform=None, home=None):
    return str(state_paths.real_user_state_dir(env, platform, home))


def old_default_dir(code_root):
    return str(state_paths.old_default_dir(code_root))


def same_path(a, b):
    return state_paths.same_path(a, b)


def sandbox_copies(env, platform):
    return [[family, str(folder)] for family, folder in state_paths.sandbox_copies(env, platform)]


def adopt_sandbox_copy(target, env, platform, attempt=True):
    messages = []
    use, result = state_paths.adopt_sandbox_copy(target, env=env, platform=platform, say=messages.append, attempt=attempt)
    return {'use': str(use), 'migration': _plain_paths(result), 'messages': messages}


def prepare(cli, migrate_from, code_root, env, attempt=True, package=None):
    messages = []
    with mock.patch.object(state_paths, 'package_context', return_value=package):
        plan = state_paths.prepare(cli, migrate_from, code_root, env=env, attempt_migration=attempt, say=messages.append)
    return {'stateDir': str(plan.state_dir), 'migration': _plain_paths(plan.migration), 'warnings': plan.warnings, 'messages': messages,
            'resolved': {'path': str(plan.resolved.path), 'source': plan.resolved.source, 'isUserFolder': plan.resolved.is_user_folder}}


def acl_problems(path):
    return state_paths.acl_problems(path)


def ensure_private_dir(path, strict=True):
    messages = []
    created = state_paths.ensure_private_dir(path, strict=strict, say=messages.append)
    return {'created': created, 'messages': messages}


def make_owner_only(path):
    state_paths.make_owner_only(path)
    return True


def windows_dacl(path):
    entries = state_paths.windows_dacl(path)
    return None if entries is None else [list(entry) for entry in entries]


def windows_current_user_sid():
    return state_paths.windows_current_user_sid()


def pid():
    return os.getpid()


def _plain_paths(value):
    if isinstance(value, dict):
        return {k: _plain_paths(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain_paths(v) for v in value]
    return str(value) if hasattr(value, 'as_posix') else value


def migrate(source, target):
    """migrate.migrate with its messages collected (its default `say` prints to stdout, which is py_call's reply channel)."""
    import migrate as migrate_module
    messages = []
    result = _plain_paths(migrate_module.migrate(source, target, say=messages.append))
    return {'result': result, 'messages': messages}
