"""Plain-data wrappers around adapters / agent_installer / agent_signin / studio_shared for the Deno parity tests
(work/deno/adapters_test.ts, installer_test.ts, signin_test.ts, shared_test.ts).

The machine lookups the Python tests mock.patch (global npm folders, codex-acp on PATH, signs of Codex, the Node.js check) are
patched here from arguments, so both sides answer from the same temp fixture. Nothing here starts npm or an agent.
"""
import argparse
import contextlib
from unittest import mock

import adapters
import agent_installer
import agent_signin
import studio_shared
from state_store import SettingsStore


@contextlib.contextmanager
def _machine(roots, on_path='', codex_present=False, block=None):
    adapters.reset_cache()
    with contextlib.ExitStack() as stack:
        stack.enter_context(mock.patch.object(adapters, 'global_roots', side_effect=lambda node=None, npm_root=None: list(roots)))
        stack.enter_context(mock.patch.object(adapters, '_codex_on_path', return_value=on_path))
        stack.enter_context(mock.patch.object(adapters, 'codex_looks_installed', return_value=codex_present))
        if block is not None:
            stack.enter_context(mock.patch.object(agent_installer, 'node_block', return_value=tuple(block)))
        yield


def resolve(kind, flag='', saved='', node='', state_dir=None, roots=(), on_path='', codex_present=False):
    """adapters.resolve_claude / resolve_codex with the npm global folders limited to `roots`."""
    with _machine(roots, on_path, codex_present):
        if kind == 'claude':
            return adapters.resolve_claude(flag, saved, node, state_dir=state_dir)
        return adapters.resolve_codex(flag, saved, node, state_dir=state_dir)


def version_order(names):
    """Version folder names sorted newest first, as complete_versions orders them."""
    return sorted(names, key=adapters._version_key, reverse=True)


def describe(state_dir, settings_dir, options, connections=(), roots=(), on_path='', codex_present=False, block=('', True)):
    """studio_shared.describe_agents with a real SettingsStore on settings_dir and options given as a dict of snake_case names."""
    namespace = argparse.Namespace(state_dir=state_dir, **options)
    with _machine(roots, on_path, codex_present, block):
        return studio_shared.describe_agents(namespace, SettingsStore(settings_dir), list(connections))


def installer_save(state_dir, agent_id, state, stage, percent, message, version, pid):
    """Write install.json exactly as the Python job does."""
    return agent_installer.Installer(state_dir, allow_list={})._save(agent_id, state, stage, percent, message, version, pid)


def installer_lock(state_dir, agent_id, action):
    """Installer._take_lock ('take', with this process's pid) or _drop_lock ('drop'), as the Python job does."""
    installer = agent_installer.Installer(state_dir, allow_list={})
    if action == 'take':
        return installer._take_lock(agent_id)
    installer._drop_lock(agent_id)
    return True


def signer_write(state_dir, agent_id, cache_state=None, job=None):
    """Write signin.json and/or signin-job.json exactly as the Python signer does. job = [state, message, command, pid]."""
    signer = agent_signin.Signer(state_dir, lambda agent_id: None)
    if cache_state is not None:
        signer._write_cache(agent_id, cache_state)
    if job is not None:
        signer._write_job(agent_id, *job)
    return True


def install_state(state_dir, agent_id):
    return studio_shared.install_state(argparse.Namespace(state_dir=state_dir), agent_id)


def signin_view(state_dir, agent_id, live_status=''):
    return studio_shared.signin_view(argparse.Namespace(state_dir=state_dir), agent_id, live_status)
