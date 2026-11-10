"""Queued messages: what the user types while the agent is working waits here and goes out when the turn ends.

The queue lives on the Connection, so it is owned by the agent host (it survives web-server restarts and a closed tab).
This module holds the pure bookkeeping (items, edit leases, pause reasons) and the small on-disk store; the Connection
decides when to send (Connection._queue_pump).

Rules the owner asked for:
  * One message per turn, first in first out.
  * The queue pauses when a turn ends needing the user (a question, approval or sign-in), when the user interrupts, and
    when a turn fails. It stays paused until the user resumes it.
  * EDITING PAUSES THE QUEUE. An item opened for editing holds an "edit lease". An item with a lease is never sent. If it is
    first in the queue the whole queue waits, however long the edit takes. Saving or cancelling the edit releases the lease.
    A lease that is not renewed expires (default 10 minutes) but is NOT released: the queue stays paused on that item
    ("a queued message was being edited") until the user resumes or removes it. Nothing abandoned is ever auto-sent.
"""
import json
import os
import pathlib
import tempfile
import threading
import time
import uuid

VERSION = 1
LEASE_SECONDS = 600
MAX_ITEMS = 50
MAX_SESSIONS = 50

HOLD_MESSAGES = {
    'needs_you': 'Paused - the agent needs you',
    'interrupted': 'Paused - you interrupted the agent',
    'error': 'Paused - the last turn failed',
    'restart': 'Paused - restored after a restart',
    'unknown': 'Paused - a queued message may already have been sent',
    'manual': 'Paused',
}


class MessageQueue:
    def __init__(self, lease_seconds=None, clock=None):
        self.clock = clock or time.time   # tests inject a fake clock to expire an edit lease without waiting
        self.items = []          # waiting items, first = next up
        self.inflight = None     # the item being handed to the agent right now (kept so it can be persisted and put back)
        self.hold = ''           # a HOLD_MESSAGES key, or '' when nothing but an edit lease can pause the queue
        self.lease_seconds = lease_seconds or LEASE_SECONDS
        self.send_now = False    # the user asked to interrupt the running turn and send the first item

    # ---- items ---------------------------------------------------------------------------------
    def find(self, item_id):
        return next((item for item in self.items if item['id'] == item_id), None)

    def has(self, item_id):
        return self.find(item_id) is not None or (self.inflight is not None and self.inflight['id'] == item_id)

    def add(self, item_id, text, attachments, fingerprint):
        if len(self.items) >= MAX_ITEMS:
            raise ValueError(f'At most {MAX_ITEMS} messages can wait in the queue')
        item = {'id': item_id, 'text': text, 'attachments': attachments or [], 'fingerprint': fingerprint, 'queuedAt': time.time(), 'lease': None, 'note': ''}
        self.items.append(item)
        return item

    def remove(self, item_id):
        item = self.find(item_id)
        if item is None:
            raise ValueError('That message is no longer queued')
        self.items.remove(item)
        if not self.items and self.hold in ('unknown', 'error'):
            self.hold = ''
        return item

    def move(self, item_id, to_index):
        item = self.find(item_id)
        if item is None:
            raise ValueError('That message is no longer queued')
        self.items.remove(item)
        self.items.insert(max(0, min(int(to_index), len(self.items))), item)
        return item

    # ---- edit leases ---------------------------------------------------------------------------
    def lease_active(self, item, now=None):
        lease = item.get('lease')
        return bool(lease) and lease['expires'] > (now or self.clock())

    def acquire(self, item_id, lease_id=None):
        item = self.find(item_id)
        if item is None:
            raise ValueError('That message is no longer queued (it may already have been sent)')
        lease = item['lease']
        lease_id = lease_id or uuid.uuid4().hex
        if lease and lease['id'] != lease_id and self.lease_active(item):
            raise ValueError('That message is already open for editing')
        item['lease'] = {'id': lease_id, 'expires': self.clock() + self.lease_seconds}
        return item

    def _leased(self, item_id, lease_id):
        item = self.find(item_id)
        if item is None:
            raise ValueError('That message is no longer queued (it may already have been sent)')
        if not item['lease'] or item['lease']['id'] != lease_id:
            raise ValueError('This edit is no longer open')
        return item

    def renew(self, item_id, lease_id):
        item = self._leased(item_id, lease_id)
        item['lease']['expires'] = self.clock() + self.lease_seconds
        return item

    def release(self, item_id, lease_id):
        item = self._leased(item_id, lease_id)
        item['lease'] = None
        return item

    # ---- what may be sent ----------------------------------------------------------------------
    def head(self):
        return self.items[0] if self.items else None

    def pause_reason(self):
        """'' when the next item may go out, else why not: editing | abandoned | one of HOLD_MESSAGES."""
        head = self.head()
        if head is None:
            return ''
        if head['lease']:
            return 'editing' if self.lease_active(head) else 'abandoned'
        return self.hold

    def resume(self):
        """The user resumed: clear the hold and any edit lease on the first item (an abandoned edit is dropped, the saved text stays)."""
        self.hold = ''
        head = self.head()
        if head:
            head['lease'] = None
            head['note'] = ''

    # ---- wire form -----------------------------------------------------------------------------
    @staticmethod
    def attachment_summary(attachments):
        out = []
        for entry in attachments or []:
            if isinstance(entry, dict):
                out.append({'kind': entry.get('type', 'image'), 'name': str(entry.get('name') or entry.get('mimeType') or 'attachment')[:120]})
        return out

    def public(self, light=False):
        now = self.clock()
        with_inflight = ([self.inflight] if self.inflight else []) + self.items
        items = []
        for index, item in enumerate(with_inflight):
            text = item['text']
            items.append({'id': item['id'], 'text': text[:300] if light else text, 'attachments': self.attachment_summary(item['attachments']), 'queuedAt': item['queuedAt'],
                          'sending': item is self.inflight, 'editing': bool(item['lease']), 'leaseActive': self.lease_active(item, now),
                          'leaseExpiresAt': item['lease']['expires'] if item['lease'] else None, 'note': item['note']})
        reason = self.pause_reason()
        messages = dict(HOLD_MESSAGES, editing='Paused while you edit', abandoned='Paused - a queued message was being edited')
        return {'items': items, 'paused': bool(reason), 'reason': reason, 'message': messages.get(reason, '') if reason else '', 'leaseSeconds': self.lease_seconds}

    # ---- persistence ---------------------------------------------------------------------------
    def to_saved(self):
        saved = [dict(item, lease=None) for item in ([self.inflight] if self.inflight else []) + self.items]
        return saved

    def load(self, saved, hold='restart'):
        self.items = []
        for raw in saved if isinstance(saved, list) else []:
            if isinstance(raw, dict) and isinstance(raw.get('id'), str) and isinstance(raw.get('text'), str):
                self.items.append({'id': raw['id'][:128], 'text': raw['text'], 'attachments': raw.get('attachments') if isinstance(raw.get('attachments'), list) else [],
                                   'fingerprint': str(raw.get('fingerprint') or ''), 'queuedAt': float(raw.get('queuedAt') or 0), 'lease': None, 'note': str(raw.get('note') or '')})
        self.items = self.items[:MAX_ITEMS]
        self.hold = hold if self.items else ''


class QueueStore:
    """studio-queues-<name>.json in the state dir. Unlike the recovery file this holds message text (and attachment data), because
    the whole point is to send it later; it is only readable by your user and an entry is deleted as soon as the message is sent."""

    def __init__(self, directory, name):
        self.directory = pathlib.Path(directory)
        self.path = self.directory / f'studio-{name}.json'
        self.lock = threading.RLock()
        self.sessions = {}   # 'provider:sessionId' -> [saved items]
        self.warning = ''
        try:
            raw = json.loads(self.path.read_text(encoding='utf-8'))
            if isinstance(raw, dict) and raw.get('version') == VERSION and isinstance(raw.get('sessions'), dict):
                for key, items in list(raw['sessions'].items())[:MAX_SESSIONS]:
                    if isinstance(key, str) and isinstance(items, list) and items:
                        self.sessions[key] = items
        except FileNotFoundError:
            pass
        except (OSError, ValueError, UnicodeError):
            self.warning = 'Saved queued messages were unreadable and were ignored.'

    @staticmethod
    def key(provider, session_id):
        return f'{provider}:{session_id}'

    def get(self, provider, session_id):
        with self.lock:
            return [dict(item) for item in self.sessions.get(self.key(provider, session_id), [])]

    def put(self, provider, session_id, saved):
        key = self.key(provider, session_id)
        with self.lock:
            if saved:
                self.sessions.pop(key, None)
                self.sessions[key] = saved
                while len(self.sessions) > MAX_SESSIONS:
                    self.sessions.pop(next(iter(self.sessions)))
            elif self.sessions.pop(key, None) is None:
                return
            self._save()

    def forget(self, provider, session_id):
        self.put(provider, session_id, [])

    def _save(self):
        try:
            self.directory.mkdir(parents=True, exist_ok=True)
            handle, temporary = tempfile.mkstemp(prefix='.studio-queues-', suffix='.tmp', dir=self.directory)
            try:
                with os.fdopen(handle, 'w', encoding='utf-8') as stream:
                    json.dump({'version': VERSION, 'savedAt': time.time(), 'sessions': self.sessions}, stream, ensure_ascii=False, separators=(',', ':'))
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temporary, self.path)
            except BaseException:
                try:
                    os.unlink(temporary)
                except OSError:
                    pass
                raise
            self.warning = ''
        except OSError as error:
            self.warning = f'Studio could not save queued messages: {error}'
