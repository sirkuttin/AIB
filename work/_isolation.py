"""Test isolation: import this first in every work/test_*.py (a test checks that each one does).

It sets, in os.environ, so that child processes (agent hosts, Studio servers the tests start) inherit them:
    AGENT_STUDIO_TEST=1            state_paths refuses to resolve the real per-user folder (%LOCALAPPDATA%\\AgentStudio etc.)
    AGENT_STUDIO_STATE_DIR=<temp>  a Studio started without --state-dir lands in a throwaway folder, never in the owner's data

A value inherited from an outer test process (AGENT_STUDIO_TEST already 1) is kept so a whole run shares one temp folder.
Anything else, including a real folder in the caller's shell, is replaced. Why an import and not sitecustomize/conftest:
unittest discovery has no conftest, and sitecustomize only loads when work/ is on PYTHONPATH at interpreter start;
an import works for `unittest discover`, for a single `python work/test_x.py`, and its environment reaches subprocesses.
state_paths additionally treats a loaded unittest/pytest as test mode, so a test file that forgot this import still cannot
reach the real folder in its own process.
"""
import atexit
import os
import pathlib
import shutil
import sys
import tempfile


def _install():
    inherited = os.environ.get('AGENT_STUDIO_TEST') == '1' and os.environ.get('AGENT_STUDIO_STATE_DIR')
    if inherited:
        return os.environ['AGENT_STUDIO_STATE_DIR']
    folder = tempfile.mkdtemp(prefix='agent-studio-test-state-')
    os.environ['AGENT_STUDIO_TEST'] = '1'
    os.environ['AGENT_STUDIO_STATE_DIR'] = folder
    atexit.register(shutil.rmtree, folder, True)
    return folder


STATE_DIR = _install()


def _claude_config():
    """CLAUDE_CONFIG_DIR is where a real `claude` process writes its projects/ (and memory/). Pointing it at a temp folder by default
    means a test that starts one and forgets its own temp home still cannot reach the owner's ~/.claude. Nothing in-process reads it.
    (acp_connection.py also gives non-fixture agents a temp HOME/USERPROFILE/APPDATA/XDG under test.) A test that needs another value
    sets it itself, as test_real_adapter_handshake.py does."""
    if os.environ.get('AGENT_STUDIO_TEST') == '1' and os.environ.get('CLAUDE_CONFIG_DIR') and os.environ['CLAUDE_CONFIG_DIR'].startswith(STATE_DIR):
        return
    folder = os.path.join(STATE_DIR, 'claude-config')
    os.makedirs(folder, exist_ok=True)
    os.environ['CLAUDE_CONFIG_DIR'] = folder


_claude_config()


def _fast_shutdown():
    """socketserver.serve_forever polls for shutdown() every 0.5 s by default, so every in-process test server needed up to half a
    second to stop (two servers per Studio: ~1 s per test). Poll every 20 ms here; the app's own default is unchanged, and
    servers in child processes are not affected."""
    import socketserver
    original = socketserver.BaseServer.serve_forever
    if getattr(original, '_fast', False):
        return

    def serve_forever(self, poll_interval=0.5):
        return original(self, min(poll_interval, 0.02))
    serve_forever._fast = True
    socketserver.BaseServer.serve_forever = serve_forever


_fast_shutdown()


# ---- Where things are. ----
REPO = pathlib.Path(__file__).resolve().parents[1]
APP_PARTS = ('outputs', 'agent-studio')   # the app folder under the repo root (the Deno server, the page files)
TESTS_NAME = 'work'                       # the folder holding the tests and fixtures
APP_REL = pathlib.Path(*APP_PARTS)   # for building a fake checkout in a temp folder: base / _isolation.APP_REL
APP = REPO.joinpath(*APP_PARTS)
TESTS = REPO / TESTS_NAME
PY_REF = TESTS / 'python-reference'   # the Python server: the reference the contract and e2e tests compare the Deno server with
