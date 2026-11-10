"""Per-conversation keys for Studio's artifact tool (the `studio_artifact` MCP server, see artifact_mcp.py).

The agent's MCP shim authenticates to the web server's artifact routes with the header X-Studio-Artifact-Key
instead of the page token. The key only works for the conversation it was issued to.

Conversations live in the agent host process while the routes live in the web server process, and either can
restart independently. So keys are not kept in a registry that one process would have to push to the other:
a key is HMAC-SHA256(secret, conversation id), where the secret is a random 32-byte file in the shared state
directory (created once, readable by the current user only). Either process can issue or check any key with no
message passing, and a key stays valid across web-server restarts for as long as the agent process keeps it.

    artifact_keys.configure(state_dir)        # once per process (Studio and RemoteStudio constructors do this)
    key = artifact_keys.issue(conversation_id)
    artifact_keys.check(key, conversation_id)  # True only for the key issued for exactly that conversation
"""
import hashlib
import hmac
import logging
import os
import pathlib
import threading
import time

import log_setup
import security

log = logging.getLogger(__name__)
log.addHandler(logging.NullHandler())   # a library logger: quiet until a program configures logging (log_setup.py)

SECRET_FILE = 'artifact-key-secret'
_lock = threading.Lock()
_state = {'dir': None, 'secret': None}


def _load_secret(directory):
    directory = pathlib.Path(directory)
    path = directory / SECRET_FILE
    directory.mkdir(parents=True, exist_ok=True)
    for _ in range(50):
        try:
            data = path.read_bytes()
            if len(data) >= 32:
                return data
        except FileNotFoundError:
            try:
                descriptor = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            except FileExistsError:
                continue
            with os.fdopen(descriptor, 'wb') as handle:
                handle.write(os.urandom(32))
            continue
        time.sleep(0.02)  # another process is still writing it
    raise OSError('Could not read the artifact key secret')


def configure(state_dir):
    """Choose the shared state directory. Safe to call again; returns True when a secret is available."""
    with _lock:
        if state_dir is None:
            _state.update(dir=None, secret=None)
            return False
        if _state['dir'] != str(state_dir) or _state['secret'] is None:
            try:
                _state.update(dir=str(state_dir), secret=_load_secret(state_dir))
            except OSError:
                _state.update(dir=None, secret=None)
                return False
        return True


def _mac(conversation_id):
    return hmac.new(_state['secret'], b'studio-artifact-key/v1\0' + str(conversation_id).encode('utf-8'), hashlib.sha256).hexdigest()


def issue(conversation_id):
    """The key for this conversation, or None when no state directory is configured."""
    if not conversation_id or _state['secret'] is None:
        return None
    key = _mac(conversation_id)
    log_setup.register_secret(key)   # so it is blanked if it ever reaches a log line
    return key


def check(key, conversation_id):
    """True only when key is the key issued for exactly this conversation. Never raises."""
    try:
        if not key or not conversation_id or _state['secret'] is None:
            return False
        return security.token_matches(str(key), _mac(conversation_id))
    except Exception:
        log.exception('Artifact key check failed; treated as not valid')   # never log the key itself
        return False
