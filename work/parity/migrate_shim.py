"""Plain-data wrappers around migrate.py for the Deno parity tests (work/deno/migrate_test.ts). Temp folders only: every path is one
the Deno test passes in. Messages are collected (migrate's default `say` prints to stdout, which is py_call's reply channel)."""
import os

import migrate


class _Killed(BaseException):
    """A kill in the middle of the copy (Python's own test raises a BaseException from on_file)."""


def _plain(value):
    if isinstance(value, dict):
        return {k: _plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(v) for v in value]
    return str(value) if hasattr(value, 'as_posix') else value


def run(source, target, kill_after=None, touch=None, touch_text=None):
    """migrate.migrate(source, target). kill_after=N: raise a kill after the Nth copied file; touch=relative: when that file has been
    copied, overwrite source/relative with touch_text. Returns {result, messages, seen} or {killed: True, messages, seen}."""
    messages, seen = [], []

    def on_file(relative):
        seen.append(relative)
        if touch is not None and relative == touch:
            with open(os.path.join(source, *relative.split('/')), 'w', encoding='utf-8') as handle:
                handle.write(touch_text)
        if kill_after is not None and len(seen) == kill_after:
            raise _Killed()

    try:
        result = migrate.migrate(source, target, say=messages.append, on_file=on_file)
    except _Killed:
        return {'killed': True, 'messages': messages, 'seen': seen}
    return {'result': _plain(result), 'messages': messages, 'seen': seen}


def plan_files(source):
    files, left = migrate.plan_files(source)
    return {'files': [[relative, str(path)] for relative, path in files], 'left': left}


def rewrite(text, source, target):
    data, count = migrate._rewrite(text.encode('utf-8'), source, target)
    return [data.decode('utf-8'), count]


def pid():
    return os.getpid()


def build_old(old):
    """work/test_state_migration.py's Fixture.build_old, with Python's own stores: settings, pins, recovery list, queued messages, an
    artifact whose sourcePath points into the old folder, the key secret, host files and one free lease. Returns the issued key and
    the artifact id."""
    import json
    import pathlib

    import artifact_keys
    import artifacts
    import host_client
    import msgqueue
    from ownership import SessionLease
    from state_store import StateStore
    old = pathlib.Path(old)
    old.mkdir(parents=True)
    (old / 'studio-settings.json').write_text(json.dumps({'version': 1, 'settings': {'theme': 'dark'}}), encoding='utf-8')
    (old / 'studio-conversations.json').write_text(json.dumps({'version': 1, 'entries': [{'key': 'omp:s1', 'pinned': True}]}), encoding='utf-8')
    (old / 'studio-projects.json').write_text('{}', encoding='utf-8')
    StateStore(old, 'recovery-host').remember_conversation('omp', 's1', 'C:/work/proj', 'my chat')
    msgqueue.QueueStore(old, 'queues-host').put('omp', 's1', [{'id': 'q1', 'text': 'later', 'attachments': [], 'fingerprint': 'f', 'queuedAt': 1.0}])
    try:
        artifact_keys.configure(old)
        key = artifact_keys.issue('conv-1')
        manifest = artifacts.ArtifactStore(old / 'artifacts').create('conv-1', 'Page', 'html', 'page.html', b'<p>hi</p>', source_path=str(old / 'inside.html'))
    finally:
        artifact_keys.configure(None)
    (old / 'agent-host.json').write_text(json.dumps({'format': host_client.HOST_FORMAT, 'pid': 0, 'port': 1, 'token': 'x'}), encoding='utf-8')
    (old / 'agent-host.log').write_text('log\n', encoding='utf-8')
    (old / 'artifact-web.json').write_text(json.dumps({'url': 'http://127.0.0.1:1', 'pid': 0}), encoding='utf-8')
    SessionLease(old, 'omp', 'free').acquire().release()   # leaves a lease file nobody holds
    return {'key': key, 'artifact': manifest['id']}


def read_moved(target, key, artifact_id):
    """What test_artifact_key_issued_before_still_checks_after and test_queue_reconnect_list_and_artifacts_survive look at, read by
    Python's own stores from the moved folder."""
    import pathlib

    import artifact_keys
    import artifacts
    import msgqueue
    from state_store import StateStore
    target = pathlib.Path(target)
    try:
        artifact_keys.configure(target)
        keys = [artifact_keys.check(key, 'conv-1'), artifact_keys.check(key, 'conv-2')]
    finally:
        artifact_keys.configure(None)
    manifest = artifacts.ArtifactStore(target / 'artifacts').get(artifact_id)
    return {
        'keys': keys,
        'queued': [item['id'] for item in msgqueue.QueueStore(target, 'queues-host').get('omp', 's1')],
        'recovery': StateStore.session_key('omp', 's1') in StateStore(target, 'recovery-host').conversations,
        'title': manifest['title'],
        'sourcePath': manifest['sourcePath'],
    }
