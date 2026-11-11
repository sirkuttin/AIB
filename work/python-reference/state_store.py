"""Durable Studio recovery state: owned conversations and prompt receipts.

One JSON file per Studio port lives in the shared --state-dir. It never holds
transcripts or prompt text. Prompt receipts keep only a SHA-256 fingerprint and a
state, so a retried browser request can be recognised after a server restart.
"""
import contextlib
import copy
import json
import os
import pathlib
import re
import tempfile
import threading
import time

import agent_registry
import editors

VERSION = 1
PROVIDERS = agent_registry.BUILTIN_IDS   # built-in agents; user-added agents (custom-<slug>) are accepted too, see agent_registry.is_provider
MAX_CONVERSATIONS = 50
MAX_RECEIPTS_PER_SESSION = 200
MAX_SESSIONS_WITH_RECEIPTS = 50
RECEIPT_STATES = ('working', 'finished', 'error', 'unknown')


def _text(value, limit):
    return value[:limit] if isinstance(value, str) else ''


READ_ATTEMPTS = 5
READ_BACKOFF = 0.05          # seconds, doubled each retry
REPLACE_ATTEMPTS = 8
LOCK_TIMEOUT = 10.0          # a crashed holder cannot block longer than this


def read_json_file(path):
    """Read a JSON state file. Returns (status, value): 'ok', 'missing', 'corrupt' (a real parse error) or
    'busy' (still unreadable after retries: antivirus, indexer or another process holding it)."""
    delay = READ_BACKOFF
    for attempt in range(READ_ATTEMPTS):
        try:
            return 'ok', json.loads(pathlib.Path(path).read_text(encoding='utf-8'))
        except FileNotFoundError:
            return 'missing', None
        except (ValueError, UnicodeError):   # json.JSONDecodeError is a ValueError
            return 'corrupt', None
        except OSError:
            if attempt == READ_ATTEMPTS - 1:
                return 'busy', None
            time.sleep(delay)
            delay = min(delay * 2, 0.5)
    return 'busy', None


def replace_with_retry(source, target):
    """os.replace that rides out the brief PermissionErrors Windows gives while something else has the target open."""
    delay = 0.02
    for attempt in range(REPLACE_ATTEMPTS):
        try:
            os.replace(source, target)
            return
        except PermissionError:
            if attempt == REPLACE_ATTEMPTS - 1:
                raise
            time.sleep(delay)
            delay = min(delay * 2, 0.4)


class FileLock:
    """Cross-process advisory lock on '<state file>.lock' (msvcrt on Windows, flock elsewhere, as in ownership.py).
    Not reentrant; callers hold the store's thread lock first. Raises TimeoutError (an OSError) after `timeout`."""

    def __init__(self, path, timeout=None):
        self.path = pathlib.Path(path)
        self.timeout = LOCK_TIMEOUT if timeout is None else timeout
        self._file = None

    def acquire(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        handle = open(self.path, 'a+b')
        deadline = time.monotonic() + self.timeout
        try:
            if os.name == 'nt':
                import msvcrt
                handle.seek(0, os.SEEK_END)
                if handle.tell() == 0:
                    handle.write(b'\0')
                    handle.flush()
            while True:
                try:
                    if os.name == 'nt':
                        handle.seek(0)
                        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                    else:
                        import fcntl
                        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except OSError:
                    if time.monotonic() >= deadline:
                        raise TimeoutError(f'Timed out waiting for the state file lock ({self.path.name})')
                    time.sleep(0.01)
            self._file = handle
        except BaseException:
            handle.close()
            raise

    def release(self):
        handle, self._file = self._file, None
        if handle is None:
            return
        try:
            if os.name == 'nt':
                import msvcrt
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        except OSError:
            pass
        finally:
            handle.close()

    def __enter__(self):
        self.acquire()
        return self

    def __exit__(self, *_exc):
        self.release()


class JsonFileStore:
    """Shared plumbing for the stores that keep one JSON file: a cross-process lock around reload+modify+save, and the
    rule that a file that could not be read (as opposed to one that is corrupt) is never overwritten."""
    path = None
    _unreadable = False

    def _file_lock(self):
        if self.path is None:
            return contextlib.nullcontext()
        return FileLock(self.path.with_name(self.path.name + '.lock'))

    @contextlib.contextmanager
    def _lock_for_update(self):
        """Hold the cross-process lock for a whole reload -> modify -> save. A lock that cannot be had in time
        becomes a ValueError, which every caller already reports as 'could not save'."""
        lock = self._file_lock()
        try:
            lock.__enter__()
        except OSError as error:
            raise ValueError(f'AIB could not save: {error}')
        try:
            yield
        finally:
            lock.__exit__(None, None, None)

    def _require_readable(self):
        if self._unreadable:
            raise OSError('the saved file could not be read just now, so it was left untouched; try again')

    def _unreadable_now(self, message):
        self._unreadable = True
        self.warning = message
        self._seen = None   # forces a fresh read attempt on the next sync


class StateStore(JsonFileStore):
    def __init__(self, state_dir, name='recovery'):
        self.directory = pathlib.Path(state_dir)
        self.path = self.directory / f'studio-{name}.json'
        self.lock = threading.RLock()
        self.conversations = {}   # 'provider:sessionId' -> display record
        self.receipts = {}        # 'provider:sessionId' -> {clientMessageId: {fingerprint, state, at}}
        self.loaded_from_previous = []
        self.warning = ''
        self._load()

    @staticmethod
    def session_key(provider, session_id):
        return f'{provider}:{session_id}'

    def _load(self):
        status, raw = read_json_file(self.path)
        if status == 'missing':
            return
        if status == 'busy':
            self._unreadable = True   # keep what we have and do not overwrite the file until a read succeeds
            self.warning = 'Saved AIB recovery state could not be read just now and was left untouched.'
            return
        if status == 'corrupt':
            self.warning = 'Saved AIB recovery state was unreadable and was ignored.'
            self._quarantine()
            return
        if not isinstance(raw, dict) or raw.get('version') != VERSION:
            self.warning = 'Saved AIB recovery state has an unknown version and was ignored.'
            return
        for item in raw.get('conversations', [])[:MAX_CONVERSATIONS] if isinstance(raw.get('conversations'), list) else []:
            record = self._clean_conversation(item)
            if record:
                self.conversations[self.session_key(record['provider'], record['sessionId'])] = record
        receipts = raw.get('receipts')
        for key, items in list((receipts if isinstance(receipts, dict) else {}).items())[:MAX_SESSIONS_WITH_RECEIPTS]:
            if not isinstance(key, str) or not isinstance(items, dict):
                continue
            cleaned = {}
            for message_id, receipt in list(items.items())[-MAX_RECEIPTS_PER_SESSION:]:
                if isinstance(message_id, str) and 1 <= len(message_id) <= 128 and isinstance(receipt, dict) and isinstance(receipt.get('fingerprint'), str):
                    state = receipt.get('state')
                    # A server that stopped mid-turn cannot know whether the agent received or finished it.
                    state = 'unknown' if state in ('working', 'unknown') or state not in RECEIPT_STATES else state
                    cleaned[message_id] = {'fingerprint': receipt['fingerprint'][:128], 'state': state, 'at': float(receipt.get('at') or 0)}
                    if state == 'unknown' and receipt.get('dismissed') is True:
                        cleaned[message_id]['dismissed'] = True
            if cleaned:
                self.receipts[key] = cleaned
        self.loaded_from_previous = [dict(item) for item in self.conversations.values()]
        if any(r['state'] == 'unknown' for items in self.receipts.values() for r in items.values()):
            self.save()

    def _quarantine(self):
        try:
            os.replace(self.path, self.path.with_suffix('.corrupt'))
        except OSError:
            pass

    @staticmethod
    def _clean_conversation(item):
        if not isinstance(item, dict) or not agent_registry.is_provider(item.get('provider')):
            return None
        session_id, cwd = item.get('sessionId'), item.get('cwd')
        if not isinstance(session_id, str) or not session_id or len(session_id) > 512 or not isinstance(cwd, str) or not cwd:
            return None
        project_root = item.get('projectRoot')   # records saved before worktree chats have none: the project folder is the cwd
        project_root = project_root[:1024] if isinstance(project_root, str) and project_root else cwd[:1024]
        return {'provider': item['provider'], 'sessionId': session_id, 'cwd': cwd[:1024], 'projectRoot': project_root, 'title': _text(item.get('title'), 200),
                'openedAt': float(item.get('openedAt') or 0), 'lastSeen': float(item.get('lastSeen') or 0)}

    def save(self):
        with self.lock:
            payload = {'version': VERSION, 'savedAt': time.time(), 'conversations': list(self.conversations.values()),
                       'receipts': self.receipts}
            try:
                if self._unreadable:
                    # The file could not be read earlier: retry the read, and never overwrite it while it is still unreadable.
                    status, _ = read_json_file(self.path)
                    if status == 'busy':
                        raise OSError('the saved file could not be read just now, so it was left untouched')
                    self._unreadable = False
                    # Readable again: take what is on disk rather than overwrite it with our empty/stale view.
                    self.conversations, self.receipts = {}, {}
                    self._load()
                    return
                self.directory.mkdir(parents=True, exist_ok=True)
                handle, temporary = tempfile.mkstemp(prefix='.studio-recovery-', suffix='.tmp', dir=self.directory)
                try:
                    with os.fdopen(handle, 'w', encoding='utf-8') as stream:
                        json.dump(payload, stream, ensure_ascii=False, separators=(',', ':'))
                        stream.flush()
                        os.fsync(stream.fileno())
                    replace_with_retry(temporary, self.path)
                except BaseException:
                    try:
                        os.unlink(temporary)
                    except OSError:
                        pass
                    raise
                self.warning = ''
            except OSError as error:
                self.warning = f'AIB could not save recovery state: {error}'

    def remember_conversation(self, provider, session_id, cwd, title='', project_root=None):
        if not agent_registry.is_provider(provider) or not isinstance(session_id, str) or not session_id:
            return
        key = self.session_key(provider, session_id)
        now = time.time()
        with self.lock:
            old = self.conversations.pop(key, None)
            self.conversations[key] = {'provider': provider, 'sessionId': session_id, 'cwd': str(cwd)[:1024],
                                       'projectRoot': str(project_root or cwd)[:1024],
                                       'title': _text(title, 200) or (old or {}).get('title', ''),
                                       'openedAt': (old or {}).get('openedAt') or now, 'lastSeen': now}
            while len(self.conversations) > MAX_CONVERSATIONS:
                self.conversations.pop(next(iter(self.conversations)))
            self.save()

    def forget_conversation(self, provider, session_id):
        with self.lock:
            removed = self.conversations.pop(self.session_key(provider, session_id), None)
            if removed:
                self.save()
            return removed is not None

    def receipt(self, provider, session_id, message_id):
        with self.lock:
            found = self.receipts.get(self.session_key(provider, session_id), {}).get(message_id)
            return dict(found) if found else None

    def set_receipt(self, provider, session_id, message_id, fingerprint, state):
        if state not in RECEIPT_STATES or not message_id:
            return
        key = self.session_key(provider, session_id)
        with self.lock:
            items = self.receipts.pop(key, {})
            items.pop(message_id, None)
            items[message_id] = {'fingerprint': fingerprint, 'state': state, 'at': time.time()}
            while len(items) > MAX_RECEIPTS_PER_SESSION:
                items.pop(next(iter(items)))
            self.receipts[key] = items
            while len(self.receipts) > MAX_SESSIONS_WITH_RECEIPTS:
                self.receipts.pop(next(iter(self.receipts)))
            self.save()

    def unknown_count(self, provider, session_id):
        return len(self.unknown_receipts(provider, session_id))

    def unknown_receipts(self, provider, session_id):
        """Messages that were mid-send at a restart and not yet dismissed by the user: [{clientMessageId, at}]."""
        with self.lock:
            items = self.receipts.get(self.session_key(provider, session_id), {})
            return [{'clientMessageId': mid, 'at': r.get('at', 0)} for mid, r in items.items() if r['state'] == 'unknown' and not r.get('dismissed')]

    def dismiss_receipt(self, provider, session_id, message_id):
        """"It arrived, dismiss": keeps the receipt unknown (a resend of this id stays refused) but stops warning about it."""
        with self.lock:
            receipt = self.receipts.get(self.session_key(provider, session_id), {}).get(message_id)
            if not receipt or receipt['state'] != 'unknown':
                return False
            if not receipt.get('dismissed'):
                receipt['dismissed'] = True
                self.save()
            return True

    def mark_working_unknown(self):
        """Used at orderly shutdown, before the process exits."""
        with self.lock:
            changed = False
            for items in self.receipts.values():
                for receipt in items.values():
                    if receipt['state'] == 'working':
                        receipt['state'] = 'unknown'
                        changed = True
            if changed:
                self.save()


class Recovery:
    """Hook object a Studio installs on each Connection; never raises into the caller."""

    def __init__(self, store):
        self.store = store
        self.shutting_down = False
        self.queues = None   # msgqueue.QueueStore, set by Studio

    def receipt(self, connection, message_id):
        return self.store.receipt(connection.provider, connection.session_id, message_id)

    def receipt_changed(self, connection, message_id, receipt):
        if self.shutting_down or not connection.session_id:
            return
        self.store.set_receipt(connection.provider, connection.session_id, message_id, receipt['fingerprint'], receipt['state'])

    def connection_ready(self, connection):
        if self.shutting_down or not connection.session_id:
            return
        connection.persisted = True
        self.store.remember_conversation(connection.provider, connection.session_id, connection.cwd, project_root=getattr(connection, 'project_root', None))
        if self.queues:
            saved = self.queues.get(connection.provider, connection.session_id)
            if saved:
                connection.queue_restore(saved)

    def queue_changed(self, connection):
        if self.queues and not self.shutting_down and connection.session_id:
            with connection.lock:
                saved = connection.queue.to_saved()
            self.queues.put(connection.provider, connection.session_id, saved)

    def connection_closed(self, connection):
        # Orderly Studio shutdown keeps the entry so the next start can offer reconnecting.
        if self.shutting_down or not connection.persisted or not connection.session_id:
            return
        self.store.forget_conversation(connection.provider, connection.session_id)
        if self.queues:
            self.queues.forget(connection.provider, connection.session_id)   # the user ended this conversation: its queue goes with it


class ConversationState(JsonFileStore):
    """Studio-side pin / archive / delete marks, shared by every browser and every Studio on --state-dir.

    One small JSON file keyed by 'provider:sessionId'. Nothing here touches the agent's own
    transcripts: "delete" is a tombstone that hides a conversation from Studio and can be undone.
    Only entries that carry a mark are kept, and the file is bounded.
    """
    FILE = 'studio-conversations.json'
    MAX_ENTRIES = 2000
    ACTIONS = ('pin', 'unpin', 'hold', 'resume', 'archive', 'unarchive', 'delete', 'restore', 'your_turn', 'handled')
    MAX_NOTE = 120

    def __init__(self, state_dir=None):
        # No directory means in-memory only (used when a Studio is built without --state-dir).
        self.path = pathlib.Path(state_dir) / self.FILE if state_dir else None
        self.lock = threading.RLock()
        self.entries = {}
        self.warning = ''
        self._nonce = os.urandom(3).hex()
        self._counter = 0
        self._seen = None   # (mtime_ns, size) of the file as last read or written by this process
        with self.lock:
            self._reload()

    @staticmethod
    def session_key(provider, session_id):
        return f'{provider}:{session_id}'

    @staticmethod
    def _stamp(value):
        try:
            number = float(value)
        except (TypeError, ValueError):
            return 0.0
        return number if 0 < number < float('inf') else 0.0

    @classmethod
    def _clean(cls, key, item):
        if not isinstance(key, str) or not isinstance(item, dict):
            return None
        provider, _, session_id = key.partition(':')
        if not agent_registry.is_provider(provider) or not session_id or len(session_id) > 512:
            return None
        entry = {'pinnedAt': cls._stamp(item.get('pinnedAt')), 'archivedAt': cls._stamp(item.get('archivedAt')),
                 'deletedAt': cls._stamp(item.get('deletedAt')), 'holdAt': cls._stamp(item.get('holdAt')),
                 'yourTurnAt': cls._stamp(item.get('yourTurnAt'))}
        if not any(entry.values()):
            return None
        entry['holdNote'] = _text(item.get('holdNote'), cls.MAX_NOTE).strip() if entry['holdAt'] else ''
        entry['agentDeleted'] = bool(item.get('agentDeleted')) and bool(entry['deletedAt'])
        entry['title'] = _text(item.get('title'), 200)
        entry['cwd'] = _text(item.get('cwd'), 1024)
        entry['projectRoot'] = _text(item.get('projectRoot'), 1024) or entry['cwd']   # a missing projectRoot means cwd
        return entry

    def _file_stamp(self):
        try:
            info = self.path.stat()
            return (info.st_mtime_ns, info.st_size)
        except OSError:
            return None

    def _reload(self):
        if self.path is None:
            self.entries = {}
            return
        self._counter += 1
        self._seen = self._file_stamp()
        status, raw = read_json_file(self.path)
        if status == 'busy':
            # Keep the in-memory marks; the file is left alone until a read succeeds.
            self._unreadable_now('Saved pin/archive/delete marks could not be read just now; changes are paused.')
            return
        self._unreadable = False
        self.entries = {}
        if status == 'missing':
            return
        if status == 'corrupt':
            self.warning = 'Saved pin/archive/delete marks were unreadable and were ignored.'
            try:
                os.replace(self.path, self.path.with_suffix('.corrupt'))
            except OSError:
                pass
            self._seen = self._file_stamp()
            return
        entries = raw.get('entries') if isinstance(raw, dict) and raw.get('version') == VERSION else None
        if not isinstance(entries, dict):
            self.warning = 'Saved pin/archive/delete marks have an unknown format and were ignored.'
            return
        self.warning = ''
        for key, item in list(entries.items())[:self.MAX_ENTRIES]:
            entry = self._clean(key, item)
            if entry:
                self.entries[key] = entry

    def _sync(self):
        """Pick up changes written by another Studio; costs one stat() when nothing changed."""
        if self.path is not None and self._file_stamp() != self._seen:
            self._reload()

    def revision(self):
        with self.lock:
            self._sync()
            return f'{self._nonce}.{self._counter}'

    def public(self):
        with self.lock:
            self._sync()
            return {'revision': f'{self._nonce}.{self._counter}', 'entries': {k: dict(v) for k, v in self.entries.items()}, 'warning': self.warning}

    def _prune(self):
        if len(self.entries) <= self.MAX_ENTRIES:
            return

        def rank(item):
            entry = item[1]
            kind = 0 if entry['agentDeleted'] else 1 if entry['deletedAt'] else 2 if entry['archivedAt'] else 3
            return (kind, max(entry['pinnedAt'], entry['archivedAt'], entry['deletedAt'], entry['holdAt'], entry['yourTurnAt']))
        for key, _ in sorted(self.entries.items(), key=rank)[:len(self.entries) - self.MAX_ENTRIES]:
            del self.entries[key]

    def _save(self):
        if self.path is None:
            return
        self._require_readable()
        payload = {'version': VERSION, 'savedAt': time.time(), 'entries': self.entries}
        self.path.parent.mkdir(parents=True, exist_ok=True)
        handle, temporary = tempfile.mkstemp(prefix='.studio-conversations-', suffix='.tmp', dir=self.path.parent)
        try:
            with os.fdopen(handle, 'w', encoding='utf-8') as stream:
                json.dump(payload, stream, ensure_ascii=False, separators=(',', ':'))
                stream.flush()
                os.fsync(stream.fileno())
            replace_with_retry(temporary, self.path)
        except BaseException:
            try:
                os.unlink(temporary)
            except OSError:
                pass
            raise
        self._seen = self._file_stamp()

    def apply(self, action, provider, session_id, title='', cwd='', agent_deleted=False, note='', project_root=''):
        if action not in self.ACTIONS:
            raise ValueError('Unknown conversation action')
        if not agent_registry.is_provider(provider):
            raise ValueError('Choose a provider')
        if not isinstance(session_id, str) or not session_id or len(session_id) > 512 or any(ord(c) < 32 for c in session_id):
            raise ValueError('Choose a saved conversation')
        key = self.session_key(provider, session_id)
        now = time.time()
        with self.lock, self._lock_for_update():
            self._sync()
            before = {k: dict(v) for k, v in self.entries.items()}
            entry = dict(self.entries.get(key) or {'pinnedAt': 0.0, 'archivedAt': 0.0, 'deletedAt': 0.0, 'holdAt': 0.0, 'holdNote': '', 'agentDeleted': False, 'title': '', 'cwd': '', 'projectRoot': '', 'yourTurnAt': 0.0})
            if action in ('pin', 'archive', 'hold') and entry['deletedAt']:
                raise ValueError('Restore this conversation first')
            if action == 'pin':
                if entry['archivedAt']:
                    raise ValueError('Unarchive this conversation before pinning it')
                entry['pinnedAt'] = entry['pinnedAt'] or now
                entry['holdAt'] = 0.0              # pinning a held chat takes it off hold
                entry['holdNote'] = ''
            elif action == 'unpin':
                entry['pinnedAt'] = 0.0
            elif action == 'hold':
                if entry['archivedAt']:
                    raise ValueError('Unarchive this conversation before putting it on hold')
                entry['holdAt'] = entry['holdAt'] or now      # re-holding only updates the note
                entry['holdNote'] = _text(note, self.MAX_NOTE).strip()
                entry['pinnedAt'] = 0.0            # putting a pinned chat on hold unpins it
                entry['yourTurnAt'] = 0.0          # holding is acting on it
            elif action == 'resume':
                entry['holdAt'] = 0.0
                entry['holdNote'] = ''
            elif action == 'archive':
                entry['archivedAt'] = entry['archivedAt'] or now
                entry['pinnedAt'] = 0.0            # archiving unpins
                entry['holdAt'] = 0.0              # and clears on hold
                entry['holdNote'] = ''
                entry['yourTurnAt'] = 0.0
            elif action == 'unarchive':
                entry['archivedAt'] = 0.0
            elif action == 'delete':
                entry['deletedAt'] = entry['deletedAt'] or now
                entry['pinnedAt'] = 0.0
                entry['yourTurnAt'] = 0.0
                entry['agentDeleted'] = entry['agentDeleted'] or bool(agent_deleted)
                entry['title'] = _text(title, 200) or entry['title']
                entry['cwd'] = _text(cwd, 1024) or entry['cwd']
                entry['projectRoot'] = _text(project_root, 1024) or entry['projectRoot'] or entry['cwd']
            elif action == 'restore':
                entry['deletedAt'] = 0.0
                entry['agentDeleted'] = False
            elif action == 'your_turn':
                # The agent finished a turn. Parked chats (held / archived / deleted) are not waiting on anyone.
                if entry['holdAt'] or entry['archivedAt'] or entry['deletedAt']:
                    return None
                entry['yourTurnAt'] = now
            elif action == 'handled':
                entry['yourTurnAt'] = 0.0          # the user acted: replied, or clicked Mark handled
            cleaned = self._clean(key, entry)
            if cleaned:
                self.entries[key] = cleaned
            else:
                self.entries.pop(key, None)
            if self.entries == before:
                return dict(cleaned) if cleaned else None
            self._prune()
            try:
                self._save()
            except OSError as error:
                self.entries = before
                self.warning = f'AIB could not save pin/archive/delete marks: {error}'
                raise ValueError(self.warning)
            self.warning = ''
            self._counter += 1
            return dict(self.entries[key]) if key in self.entries else None


class ProjectPrefs(JsonFileStore):
    """Rail preferences per project: display name, colour, hidden flag and the order of the rail.

    One small JSON file shared by every browser and every Studio on --state-dir. Projects are identified by the
    page's own project key (a normalised folder path). A display name never renames a folder. Only projects that
    carry a preference are stored, and every string is validated and size limited.
    """
    FILE = 'studio-projects.json'
    MAX_PROJECTS = 300
    MAX_KEY = 512
    MAX_NAME = 60
    COLORS = ('blue', 'sky', 'teal', 'indigo', 'violet', 'orchid', 'pink', 'slate')   # keep in sync with workspace-state.js

    def __init__(self, state_dir=None):
        self.path = pathlib.Path(state_dir) / self.FILE if state_dir else None
        self.lock = threading.RLock()
        self.projects = {}   # key -> {'name': str, 'color': str, 'hidden': bool, 'muted': True (only when set)}
        self.order = []      # project keys, rail order
        self.warning = ''
        self._nonce = os.urandom(3).hex()
        self._counter = 0
        self._seen = None
        with self.lock:
            self._reload()

    @classmethod
    def _key(cls, value):
        if not isinstance(value, str) or not value or len(value) > cls.MAX_KEY or any(ord(c) < 32 for c in value):
            return None
        return value

    @classmethod
    def _name(cls, value):
        if not isinstance(value, str):
            return ''
        return ' '.join(''.join(c if ord(c) >= 32 else ' ' for c in value).split())[:cls.MAX_NAME]

    @classmethod
    def _clean_pref(cls, item):
        if not isinstance(item, dict):
            return None
        color = item.get('color') if item.get('color') in cls.COLORS else ''
        pref = {'name': cls._name(item.get('name')), 'color': color, 'hidden': item.get('hidden') is True}
        if item.get('muted') is True:
            pref['muted'] = True      # only stored when set, so older readers and files see the same three fields
        if item.get('useWorkspace') is True:
            pref['useWorkspace'] = True   # "Always open this project's .code-workspace", stored only when set
        return pref if (pref['name'] or pref['color'] or pref['hidden'] or pref.get('muted') or pref.get('useWorkspace')) else None

    @classmethod
    def _clean_order(cls, value):
        out, seen = [], set()
        for key in (value if isinstance(value, list) else []):
            key = cls._key(key)
            if key and key not in seen:
                seen.add(key)
                out.append(key)
            if len(out) >= cls.MAX_PROJECTS:
                break
        return out

    def _file_stamp(self):
        try:
            info = self.path.stat()
            return (info.st_mtime_ns, info.st_size)
        except OSError:
            return None

    def _reload(self):
        if self.path is None:
            self.projects, self.order = {}, []
            return
        self._counter += 1
        self._seen = self._file_stamp()
        status, raw = read_json_file(self.path)
        if status == 'busy':
            self._unreadable_now('Saved project preferences could not be read just now; changes are paused.')
            return
        self._unreadable = False
        self.projects, self.order = {}, []
        if status == 'missing':
            return
        if status == 'corrupt':
            self.warning = 'Saved project preferences were unreadable and were ignored.'
            try:
                os.replace(self.path, self.path.with_suffix('.corrupt'))
            except OSError:
                pass
            self._seen = self._file_stamp()
            return
        if not isinstance(raw, dict) or raw.get('version') != VERSION or not isinstance(raw.get('projects'), dict):
            self.warning = 'Saved project preferences have an unknown format and were ignored.'
            return
        self.warning = ''
        for key, item in list(raw['projects'].items())[:self.MAX_PROJECTS]:
            pref = self._clean_pref(item) if self._key(key) else None
            if pref:
                self.projects[key] = pref
        self.order = self._clean_order(raw.get('order'))

    def _sync(self):
        if self.path is not None and self._file_stamp() != self._seen:
            self._reload()

    def revision(self):
        with self.lock:
            self._sync()
            return f'{self._nonce}.{self._counter}'

    def public(self):
        with self.lock:
            self._sync()
            return {'revision': f'{self._nonce}.{self._counter}', 'order': list(self.order),
                    'projects': {k: dict(v) for k, v in self.projects.items()}, 'warning': self.warning}

    def _save(self):
        if self.path is None:
            return
        self._require_readable()
        payload = {'version': VERSION, 'savedAt': time.time(), 'order': self.order, 'projects': self.projects}
        self.path.parent.mkdir(parents=True, exist_ok=True)
        handle, temporary = tempfile.mkstemp(prefix='.studio-projects-', suffix='.tmp', dir=self.path.parent)
        try:
            with os.fdopen(handle, 'w', encoding='utf-8') as stream:
                json.dump(payload, stream, ensure_ascii=False, separators=(',', ':'))
                stream.flush()
                os.fsync(stream.fileno())
            replace_with_retry(temporary, self.path)
        except BaseException:
            try:
                os.unlink(temporary)
            except OSError:
                pass
            raise
        self._seen = self._file_stamp()

    def update(self, body):
        """Apply {'set': {key: {name?, color?, hidden?, muted?, useWorkspace?}}, 'order': [keys]}; fields not mentioned are kept.
        An empty name / colour or hidden/muted=false clears that field."""
        if not isinstance(body, dict):
            raise ValueError('Invalid request')
        changes, order = body.get('set'), body.get('order')
        if changes is not None and not isinstance(changes, dict):
            raise ValueError('Invalid project changes')
        if order is not None and not isinstance(order, list):
            raise ValueError('Invalid project order')
        if changes is not None and len(changes) > 50:
            raise ValueError('Too many project changes at once')
        with self.lock, self._lock_for_update():
            self._sync()
            before_projects, before_order = {k: dict(v) for k, v in self.projects.items()}, list(self.order)
            try:
                for key, patch in (changes or {}).items():
                    if self._key(key) is None or not isinstance(patch, dict):
                        raise ValueError('Invalid project')
                    current = dict(self.projects.get(key) or {'name': '', 'color': '', 'hidden': False})
                    if 'name' in patch:
                        if not isinstance(patch['name'], str):
                            raise ValueError('Invalid project name')
                        current['name'] = self._name(patch['name'])
                    if 'color' in patch:
                        if patch['color'] not in self.COLORS + ('',):
                            raise ValueError('Unknown project colour')
                        current['color'] = patch['color']
                    if 'hidden' in patch:
                        if not isinstance(patch['hidden'], bool):
                            raise ValueError('Invalid hidden flag')
                        current['hidden'] = patch['hidden']
                    if 'muted' in patch:
                        if not isinstance(patch['muted'], bool):
                            raise ValueError('Invalid muted flag')
                        current['muted'] = patch['muted']
                    if 'useWorkspace' in patch:
                        if not isinstance(patch['useWorkspace'], bool):
                            raise ValueError('Invalid workspace flag')
                        current['useWorkspace'] = patch['useWorkspace']
                    cleaned = self._clean_pref(current)
                    if cleaned:
                        self.projects[key] = cleaned
                    else:
                        self.projects.pop(key, None)
                if order is not None:
                    self.order = self._clean_order(order)
                if len(self.projects) > self.MAX_PROJECTS:
                    raise ValueError('Too many projects with saved preferences')
            except ValueError:
                self.projects, self.order = before_projects, before_order
                raise
            if self.projects == before_projects and self.order == before_order:
                return
            try:
                self._save()
            except OSError as error:
                self.projects, self.order = before_projects, before_order
                self.warning = f'AIB could not save project preferences: {error}'
                raise ValueError(self.warning)
            self.warning = ''
            self._counter += 1


class ReadState(JsonFileStore):
    """What the user has seen in each chat, kept on disk so it survives restarts and is the same in every browser.

    Keyed by the chat's stable identity 'provider:sessionId' (what saved chats use), never a live connection id.
    seenAt is the newest event time (epoch ms) the user has seen; seenIndex (optional) is how many messages had been seen,
    which places the unread line again after a restart replays history without original times. Least recently written
    chats are dropped past MAX_CHATS.
    """
    FILE = 'studio-read-state.json'
    MAX_CHATS = 2000
    MAX_KEY = 300
    MAX_SET = 500
    MAX_TIME = 4102444800000   # year 2100, in ms: anything above is a unit mistake
    MAX_INDEX = 10_000_000

    def __init__(self, state_dir=None):
        self.path = pathlib.Path(state_dir) / self.FILE if state_dir else None
        self.lock = threading.RLock()
        self.chats = {}   # key -> {'seenAt': int ms, 'seenIndex'?: int, 'at': float (write order, for the LRU cap)}
        self.warning = ''
        self._nonce = os.urandom(3).hex()
        self._counter = 0
        self._seen = None
        with self.lock:
            self._reload()

    @classmethod
    def _key(cls, value):
        if not isinstance(value, str) or not 3 <= len(value) <= cls.MAX_KEY or any(ord(c) < 32 for c in value):
            return None
        provider, _, ident = value.partition(':')
        return value if provider and ident and re.fullmatch(r'[a-z0-9][a-z0-9_-]*', provider) else None

    @classmethod
    def _int(cls, value, limit):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or value != value or value < 0 or value > limit:
            return None
        return int(value)

    @classmethod
    def _clean(cls, item):
        if not isinstance(item, dict):
            return None
        seen_at = cls._int(item.get('seenAt'), cls.MAX_TIME)
        if seen_at is None:
            return None
        out = {'seenAt': seen_at}
        index = cls._int(item.get('seenIndex'), cls.MAX_INDEX)
        if index is not None:
            out['seenIndex'] = index
        at = item.get('at')
        out['at'] = float(at) if isinstance(at, (int, float)) and not isinstance(at, bool) and at == at else 0.0
        return out

    def _file_stamp(self):
        try:
            info = self.path.stat()
            return (info.st_mtime_ns, info.st_size)
        except OSError:
            return None

    def _reload(self):
        if self.path is None:
            self.chats = {}
            return
        self._counter += 1
        self._seen = self._file_stamp()
        status, raw = read_json_file(self.path)
        if status == 'busy':
            self._unreadable_now('Saved read positions could not be read just now; changes are paused.')
            return
        self._unreadable = False
        self.chats = {}
        if status == 'missing':
            return
        if status == 'corrupt':
            self.warning = 'Saved read positions were unreadable and were ignored.'
            try:
                os.replace(self.path, self.path.with_suffix('.corrupt'))
            except OSError:
                pass
            self._seen = self._file_stamp()
            return
        if not isinstance(raw, dict) or raw.get('version') != VERSION or not isinstance(raw.get('chats'), dict):
            self.warning = 'Saved read positions have an unknown format and were ignored.'
            return
        self.warning = ''
        for key, item in raw['chats'].items():
            entry = self._clean(item) if self._key(key) else None
            if entry:
                self.chats[key] = entry
        self._prune()

    def _sync(self):
        if self.path is not None and self._file_stamp() != self._seen:
            self._reload()

    def _prune(self):
        extra = len(self.chats) - self.MAX_CHATS
        if extra > 0:
            for key in sorted(self.chats, key=lambda k: self.chats[k]['at'])[:extra]:
                del self.chats[key]

    def revision(self):
        with self.lock:
            self._sync()
            return f'{self._nonce}.{self._counter}'

    def public(self):
        with self.lock:
            self._sync()
            return {'revision': f'{self._nonce}.{self._counter}', 'warning': self.warning,
                    'chats': {k: {f: v[f] for f in ('seenAt', 'seenIndex') if f in v} for k, v in self.chats.items()}}

    def _save(self):
        if self.path is None:
            return
        self._require_readable()
        payload = {'version': VERSION, 'savedAt': time.time(), 'chats': self.chats}
        self.path.parent.mkdir(parents=True, exist_ok=True)
        handle, temporary = tempfile.mkstemp(prefix='.studio-read-', suffix='.tmp', dir=self.path.parent)
        try:
            with os.fdopen(handle, 'w', encoding='utf-8') as stream:
                json.dump(payload, stream, ensure_ascii=False, separators=(',', ':'))
                stream.flush()
                os.fsync(stream.fileno())
            replace_with_retry(temporary, self.path)
        except BaseException:
            try:
                os.unlink(temporary)
            except OSError:
                pass
            raise
        self._seen = self._file_stamp()

    def update(self, body):
        """Apply {'set': {key: {seenAt, seenIndex?}}}. A position only moves forward: an older seenAt is ignored, an equal one
        keeps the larger index, and a newer one without an index keeps the stored index."""
        if not isinstance(body, dict) or not isinstance(body.get('set'), dict):
            raise ValueError('Invalid request')
        changes = body['set']
        if len(changes) > self.MAX_SET:
            raise ValueError('Too many read positions at once')
        clean = {}
        for key, item in changes.items():
            entry = self._clean(item) if self._key(key) else None
            if entry is None:
                raise ValueError('Invalid read position')
            clean[key] = entry
        with self.lock, self._lock_for_update():
            self._sync()
            before = {k: dict(v) for k, v in self.chats.items()}
            now = time.time()
            for key, new in clean.items():
                old = self.chats.get(key)
                if old and new['seenAt'] < old['seenAt']:
                    continue
                merged = {'seenAt': new['seenAt']}
                index = new.get('seenIndex')
                if old and new['seenAt'] == old['seenAt']:
                    both = [i for i in (index, old.get('seenIndex')) if i is not None]
                    index = max(both) if both else None
                elif index is None and old:
                    index = old.get('seenIndex')
                if index is not None:
                    merged['seenIndex'] = index
                if old and all(old.get(f) == merged.get(f) for f in ('seenAt', 'seenIndex')):
                    continue
                now += 1e-6   # a batch keeps its own order
                merged['at'] = now
                self.chats[key] = merged
            if all(self.chats.get(k) == before.get(k) for k in set(self.chats) | set(before)):
                return
            self._prune()
            try:
                self._save()
            except OSError as error:
                self.chats = before
                self.warning = f'AIB could not save read positions: {error}'
                raise ValueError(self.warning)
            self.warning = ''
            self._counter += 1


class SettingsStore(JsonFileStore):
    """Studio settings: the agent list (built-in switches + user-added ACP agents), New chat defaults and server options.

    One small validated JSON file in --state-dir, shared by the web server and the agent host (the host re-reads it when its
    mtime changes, so a new agent is launchable without restarting anything). Writes are atomic. `revision` changes on every
    save, in this process or another, so other windows know to refresh. Agent environment values are stored as plain text:
    ACP adapters need them. The file is the user's own and lives in the state folder.

      {"version":1,
       "agents":   {"builtin": {"omp": true, "claude": true, "codex": true}, "custom": [{id,name,command,args,env,enabled}]},
       "defaults": {"agent": "", "byAgent": {id: {model, mode}}, "projects": {projectKey: {agent, model, mode}}, "migrated": false},
       "server":   {"autoReconnect": true},
       "editors":  {"default": "" | "code" | "cursor" | "windsurf" | "devin"},
       "appearance": {"defaultView": "full" | "chat"},   # the chat view a new chat starts in ("prompts" is a switch-to view only)
       "launchers": {"claude": "", "codex": ""}}     # optional script file node runs instead of the installed adapter

    public() never contains an environment value: custom agents show env as [{name, set: true}].
    """
    FILE = 'studio-settings.json'
    MAX_PROJECTS = 300
    MAX_VALUE = 200
    DEFAULT_VIEWS = ('full', 'chat')

    def __init__(self, state_dir=None):
        self.path = pathlib.Path(state_dir) / self.FILE if state_dir else None
        self.lock = threading.RLock()
        self.data = self.blank()
        self.warning = ''
        self._nonce = os.urandom(3).hex()
        self._counter = 0
        self._seen = None
        with self.lock:
            self._reload()

    @staticmethod
    def blank():
        return {'agents': {'builtin': {'omp': True, 'claude': True, 'codex': True}, 'custom': []},
                'defaults': {'agent': '', 'byAgent': {}, 'projects': {}, 'migrated': False},
                'server': {'autoReconnect': True, 'worktreePerChat': True, 'autoUpdateCheck': True},   # worktreePerChat: on by default; hidden, never shown by public()
                'editors': {'default': ''},
                'appearance': {'defaultView': 'full'},
                'launchers': {'claude': '', 'codex': ''}}

    # ---- cleaning (used for the file and for patches) ----
    @classmethod
    def _value(cls, value):
        if not isinstance(value, str):
            return ''
        return ''.join(c for c in value if ord(c) >= 32 and ord(c) != 127).strip()[:cls.MAX_VALUE]

    @classmethod
    def _choice(cls, item, with_agent):
        item = item if isinstance(item, dict) else {}
        out = {'model': cls._value(item.get('model')), 'mode': cls._value(item.get('mode'))}
        if with_agent:
            agent = item.get('agent')
            out['agent'] = agent if agent == '' or agent_registry.is_provider(agent) else ''
        return out if any(out.values()) else None

    @classmethod
    def _clean_doc(cls, raw):
        doc = cls.blank()
        if not isinstance(raw, dict):
            return doc
        agents = raw.get('agents') if isinstance(raw.get('agents'), dict) else {}
        builtin = agents.get('builtin') if isinstance(agents.get('builtin'), dict) else {}
        for agent_id in agent_registry.BUILTIN_IDS:
            if isinstance(builtin.get(agent_id), bool):
                doc['agents']['builtin'][agent_id] = builtin[agent_id]
        taken = set()
        for item in (agents.get('custom') if isinstance(agents.get('custom'), list) else [])[:agent_registry.MAX_AGENTS]:
            try:
                if not isinstance(item, dict) or item.get('id') in taken or not agent_registry.is_custom(item.get('id')):
                    continue
                cleaned = agent_registry.clean_agent(item, taken, existing={'id': item.get('id'), 'enabled': True}, check=False)
            except ValueError:
                continue
            taken.add(cleaned['id'])
            doc['agents']['custom'].append(cleaned)
        defaults = raw.get('defaults') if isinstance(raw.get('defaults'), dict) else {}
        agent = defaults.get('agent')
        doc['defaults']['agent'] = agent if agent == '' or agent_registry.is_provider(agent) else ''
        doc['defaults']['migrated'] = defaults.get('migrated') is True
        for key, item in (defaults.get('byAgent') if isinstance(defaults.get('byAgent'), dict) else {}).items():
            choice = cls._choice(item, False)
            if agent_registry.is_provider(key) and choice:
                doc['defaults']['byAgent'][key] = choice
        for key, item in list((defaults.get('projects') if isinstance(defaults.get('projects'), dict) else {}).items())[:cls.MAX_PROJECTS]:
            choice = cls._choice(item, True)
            if ProjectPrefs._key(key) and choice:
                doc['defaults']['projects'][key] = choice
        server = raw.get('server') if isinstance(raw.get('server'), dict) else {}
        if isinstance(server.get('autoReconnect'), bool):
            doc['server']['autoReconnect'] = server['autoReconnect']
        if isinstance(server.get('worktreePerChat'), bool):
            doc['server']['worktreePerChat'] = server['worktreePerChat']
        if isinstance(server.get('autoUpdateCheck'), bool):
            doc['server']['autoUpdateCheck'] = server['autoUpdateCheck']
        editor = raw.get('editors') if isinstance(raw.get('editors'), dict) else {}
        doc['editors']['default'] = editor.get('default') if editor.get('default') in editors.DEFAULT_ORDER else ''
        appearance = raw.get('appearance') if isinstance(raw.get('appearance'), dict) else {}
        if appearance.get('defaultView') in cls.DEFAULT_VIEWS:
            doc['appearance']['defaultView'] = appearance['defaultView']
        launchers = raw.get('launchers') if isinstance(raw.get('launchers'), dict) else {}
        for key in doc['launchers']:
            doc['launchers'][key] = cls._launcher_path(launchers.get(key))
        return doc

    @staticmethod
    def _launcher_path(value):
        if not isinstance(value, str):
            return ''
        text = value.strip()
        return text if 0 < len(text) <= agent_registry.MAX_COMMAND and not any(ord(c) < 32 for c in text) else ''

    # ---- file ----
    def _file_stamp(self):
        try:
            info = self.path.stat()
            return (info.st_mtime_ns, info.st_size)
        except OSError:
            return None

    def _reload(self):
        if self.path is None:
            self.data = self.blank()
            return
        self._counter += 1
        self._seen = self._file_stamp()
        status, raw = read_json_file(self.path)
        if status == 'busy':
            self._unreadable_now('Saved settings could not be read just now; changes are paused.')
            return
        self._unreadable = False
        self.data = self.blank()
        if status == 'missing':
            self.warning = ''
            return
        if status == 'corrupt':
            self.warning = 'Saved settings were unreadable and were ignored (the file was kept as .corrupt).'
            try:
                os.replace(self.path, self.path.with_suffix('.corrupt'))
            except OSError:
                pass
            self._seen = self._file_stamp()
            return
        if not isinstance(raw, dict) or raw.get('version') != VERSION:
            self.warning = 'Saved settings have an unknown format and were ignored.'
            return
        self.warning = ''
        self.data = self._clean_doc(raw)

    def _sync(self):
        if self.path is not None and self._file_stamp() != self._seen:
            self._reload()

    def _save(self):
        if self.path is None:
            return
        self._require_readable()
        payload = dict(self.data, version=VERSION, savedAt=time.time())
        self.path.parent.mkdir(parents=True, exist_ok=True)
        handle, temporary = tempfile.mkstemp(prefix='.studio-settings-', suffix='.tmp', dir=self.path.parent)
        try:
            with os.fdopen(handle, 'w', encoding='utf-8') as stream:
                json.dump(payload, stream, ensure_ascii=False, separators=(',', ':'))
                stream.flush()
                os.fsync(stream.fileno())
            replace_with_retry(temporary, self.path)
        except BaseException:
            try:
                os.unlink(temporary)
            except OSError:
                pass
            raise
        self._seen = self._file_stamp()

    # ---- reading ----
    def revision(self):
        with self.lock:
            self._sync()
            return f'{self._nonce}.{self._counter}'

    def snapshot(self):
        with self.lock:
            self._sync()
            return copy.deepcopy(self.data)

    def public(self):
        with self.lock:
            self._sync()
            shown = copy.deepcopy(self.data)
            shown['server'].pop('worktreePerChat', None)   # hidden flag: the page sees nothing new
            for agent in shown['agents']['custom']:
                agent['env'] = agent_registry.hidden_env(agent['env'])   # names only: values are never sent to the page
            return {'revision': f'{self._nonce}.{self._counter}', 'settings': shown, 'warning': self.warning}

    def custom_agents(self):
        return self.snapshot()['agents']['custom']

    def custom_agent(self, agent_id):
        return next((a for a in self.custom_agents() if a['id'] == agent_id), None)

    def builtin_enabled(self, agent_id):
        return self.snapshot()['agents']['builtin'].get(agent_id, True)

    def launcher(self, agent_id):
        """The launcher script saved in Settings for 'claude' or 'codex' ('' when none)."""
        return self.snapshot()['launchers'].get(agent_id, '')

    def auto_reconnect(self):
        return self.snapshot()['server']['autoReconnect']

    def auto_update_check(self):
        """Settings > About > Automatically check for updates (on by default: the owner chose automatic updates)."""
        return self.snapshot()['server']['autoUpdateCheck']

    def worktree_per_chat(self):
        """Hidden flag (off by default): a new chat in a git project gets its own git worktree. No page control sets it."""
        return self.snapshot()['server']['worktreePerChat']

    # ---- writing ----
    def update(self, body):
        """Apply a patch: {agents: {builtin: {omp: bool}, upsert: {id?, name, command, args, env, enabled}, remove: id},
        defaults: {agent, migrated, byAgent: {id: {model, mode} | null}, projects: {key: {agent, model, mode} | null}},
        server: {autoReconnect}}. Nothing is saved unless the whole patch is valid. Returns True when something changed."""
        if not isinstance(body, dict) or not body:
            raise ValueError('Invalid request')
        unknown = set(body) - {'agents', 'defaults', 'server', 'editors', 'appearance', 'launchers'}
        if unknown:
            raise ValueError('Unknown settings section: ' + ', '.join(sorted(str(k)[:30] for k in unknown)))
        with self.lock, self._lock_for_update():
            self._sync()
            work = copy.deepcopy(self.data)
            self._apply_agents(work, body.get('agents'))
            self._apply_defaults(work, body.get('defaults'))
            self._apply_server(work, body.get('server'))
            self._apply_editors(work, body.get('editors'))
            self._apply_appearance(work, body.get('appearance'))
            self._apply_launchers(work, body.get('launchers'))
            work = self._clean_doc(work)   # one last pass: what is kept is exactly what a reload would give
            if work == self.data:
                return False
            before = self.data
            self.data = work
            try:
                self._save()
            except OSError as error:
                self.data = before
                self.warning = f'AIB could not save settings: {error}'
                raise ValueError(self.warning)
            self.warning = ''
            self._counter += 1
            return True

    @staticmethod
    def _section(value, name):
        if value is None:
            return {}
        if not isinstance(value, dict):
            raise ValueError(f'Invalid {name} settings')
        return value

    def _apply_agents(self, work, patch):
        patch = self._section(patch, 'agents')
        if set(patch) - {'builtin', 'enabled', 'upsert', 'remove'}:
            raise ValueError('Unknown agents setting')
        for agent_id, enabled in self._section(patch.get('enabled'), 'agents').items():   # on/off only: nothing else of the agent is touched
            if not isinstance(enabled, bool):
                raise ValueError('Agents can only be turned on or off')
            if agent_id in agent_registry.BUILTIN_IDS:
                work['agents']['builtin'][agent_id] = enabled
                continue
            target = next((a for a in work['agents']['custom'] if a['id'] == agent_id), None)
            if target is None:
                raise ValueError('That agent is not in the list')
            target['enabled'] = enabled
        for agent_id, enabled in self._section(patch.get('builtin'), 'agents').items():
            if agent_id not in agent_registry.BUILTIN_IDS or not isinstance(enabled, bool):
                raise ValueError('Built-in agents can only be turned on or off')
            work['agents']['builtin'][agent_id] = enabled
        custom = work['agents']['custom']
        if 'remove' in patch:
            target = patch['remove']
            if target in agent_registry.BUILTIN_IDS:
                raise ValueError('Built-in agents cannot be removed; turn them off instead')
            if not any(a['id'] == target for a in custom):
                raise ValueError('That agent is not in the list')
            custom[:] = [a for a in custom if a['id'] != target]
            for value in work['defaults']['projects'].values():
                if value.get('agent') == target:
                    value['agent'] = ''
            work['defaults']['byAgent'].pop(target, None)
            if work['defaults']['agent'] == target:
                work['defaults']['agent'] = ''
        if 'upsert' in patch:
            raw = patch['upsert']
            if not isinstance(raw, dict):
                raise ValueError('Invalid agent')
            existing = None
            if raw.get('id') is not None:
                existing = next((a for a in custom if a['id'] == raw.get('id')), None)
                if existing is None:
                    raise ValueError('That agent is not in the list')
            elif len(custom) >= agent_registry.MAX_AGENTS:
                raise ValueError(f'At most {agent_registry.MAX_AGENTS} added agents')
            taken = {a['id'] for a in custom}
            cleaned = agent_registry.clean_agent(raw, taken, existing=existing, check=True)
            names = {a['name'].lower() for a in custom if a is not existing} | {n.lower() for n in agent_registry.BUILTIN_NAMES.values()}
            if cleaned['name'].lower() in names:
                raise ValueError('Another agent already has that name')
            if existing is None:
                custom.append(cleaned)
            else:
                custom[custom.index(existing)] = cleaned

    def _apply_defaults(self, work, patch):
        patch = self._section(patch, 'defaults')
        if set(patch) - {'agent', 'byAgent', 'projects', 'migrated'}:
            raise ValueError('Unknown defaults setting')
        target = work['defaults']
        if 'agent' in patch:
            if not isinstance(patch['agent'], str) or (patch['agent'] != '' and not agent_registry.is_provider(patch['agent'])):
                raise ValueError('Choose an agent')
            target['agent'] = patch['agent']
        if 'migrated' in patch:
            if not isinstance(patch['migrated'], bool):
                raise ValueError('Invalid migrated flag')
            target['migrated'] = patch['migrated']
        for key, value in self._section(patch.get('byAgent'), 'defaults').items():
            if not agent_registry.is_provider(key) or not (value is None or isinstance(value, dict)):
                raise ValueError('Invalid agent default')
            self._merge_choice(target['byAgent'], key, value, False)
        projects = self._section(patch.get('projects'), 'defaults')
        if len(projects) > 50:
            raise ValueError('Too many project defaults at once')
        for key, value in projects.items():
            if ProjectPrefs._key(key) is None or not (value is None or isinstance(value, dict)):
                raise ValueError('Invalid project default')
            self._merge_choice(target['projects'], key, value, True)
        if len(target['projects']) > self.MAX_PROJECTS:
            raise ValueError('Too many projects with saved defaults')

    def _merge_choice(self, store, key, value, with_agent):
        if value is None:
            store.pop(key, None)
            return
        current = dict(store.get(key) or {})
        for field in ('model', 'mode') + (('agent',) if with_agent else ()):
            if field in value:
                if not isinstance(value[field], str):
                    raise ValueError(f'Invalid {field}')
                if field == 'agent' and value[field] != '' and not agent_registry.is_provider(value[field]):
                    raise ValueError('Choose an agent')
                current[field] = value[field]
        cleaned = self._choice(current, with_agent)
        if cleaned:
            store[key] = cleaned
        else:
            store.pop(key, None)

    def _apply_editors(self, work, patch):
        patch = self._section(patch, 'editors')
        if set(patch) - {'default'}:
            raise ValueError('Unknown editors setting')
        if 'default' in patch:
            if patch['default'] != '' and patch['default'] not in editors.DEFAULT_ORDER:
                raise ValueError('Choose VS Code, Cursor, Windsurf or Devin')
            work['editors']['default'] = patch['default']

    def _apply_appearance(self, work, patch):
        patch = self._section(patch, 'appearance')
        if set(patch) - {'defaultView'}:
            raise ValueError('Unknown appearance setting')
        if 'defaultView' in patch:
            if patch['defaultView'] not in self.DEFAULT_VIEWS:   # "prompts" is for finding something: a switch-to view, never a default
                raise ValueError('Choose Full or Chat as the default chat view')
            work['appearance']['defaultView'] = patch['defaultView']

    def _apply_launchers(self, work, patch):
        patch = self._section(patch, 'launchers')
        if set(patch) - set(work['launchers']):
            raise ValueError('Unknown launcher')
        for key, value in patch.items():
            if value is None or value == '':
                work['launchers'][key] = ''
                continue
            text = self._launcher_path(value)
            path = pathlib.Path(text).expanduser() if text else None
            if path is None or not path.is_absolute() or not path.is_file():
                raise ValueError('The launcher must be the full path of an existing script file')
            work['launchers'][key] = str(path)

    def _apply_server(self, work, patch):
        patch = self._section(patch, 'server')
        if set(patch) - {'autoReconnect', 'worktreePerChat', 'autoUpdateCheck'}:
            raise ValueError('Unknown server setting')
        if 'worktreePerChat' in patch:
            if not isinstance(patch['worktreePerChat'], bool):
                raise ValueError('worktreePerChat must be true or false')
            work['server']['worktreePerChat'] = patch['worktreePerChat']
        if 'autoUpdateCheck' in patch:
            if not isinstance(patch['autoUpdateCheck'], bool):
                raise ValueError('autoUpdateCheck must be true or false')
            work['server']['autoUpdateCheck'] = patch['autoUpdateCheck']
        if 'autoReconnect' in patch:
            if not isinstance(patch['autoReconnect'], bool):
                raise ValueError('autoReconnect must be true or false')
            work['server']['autoReconnect'] = patch['autoReconnect']
