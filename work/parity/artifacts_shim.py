"""Plain-data wrappers around artifacts.py and artifact_origin.py for the Deno parity and interop tests
(work/deno/artifacts_test.ts, work/deno/artifact_origin_test.ts). Only test temp folders are ever passed in.

store_run(root, steps) builds one ArtifactStore on `root` (a fixed clock, origin http://127.0.0.1:1) and runs the steps:
  {"call": method, "args": [...], "kwargs": {...}}   a store method; an argument {"bytes": "text"} is that text as UTF-8 bytes,
                                                   {"hex": "..."} raw bytes, {"ref": i} the id of the artifact step i returned
  {"clock": t}                                     set the store's clock
  {"limits": {"MAX_BYTES": n, "MAX_VERSIONS": n}}  patch the retention limits for the following steps
Each result is {"ok": value} or {"error": type, "message": str, "status", "code"}.

service_run(root, project, steps, live=None) builds a Service whose chats all live in `project` (chat_of maps through `live`):
  {"get": path, "args": {name: [values]}, "headers": {...}} / {"post": path, "body": ..., "headers": {...}}
  {"clock": t} / {"write": [relative path, text]} (a file in the project)
Returns {"results": [[status, payload], ...], "events": [[conversation id, event], ...]}.

watcher_run(root, project, steps): a Watcher over chats c1 / c2 in `project`, as work/test_artifacts.py's WatcherTests drive it:
  {"tick": advance} / {"clock": advance} / {"write": [name, text, by or null, now]} / {"unlink": name} / {"preview": [cid, name]}
Returns {"events": [...], "store": [summaries, oldest folder first]}.
"""
import os
import pathlib
import time
import types

import artifact_origin
import artifacts


class _Headers(dict):
    def get(self, name, default=None):
        for key, value in self.items():
            if key.lower() == str(name).lower():
                return value
        return default


class _Clock:
    def __init__(self, t=1000.0):
        self.t = t

    def __call__(self):
        return self.t


def _arg(value, results=()):
    if isinstance(value, dict) and set(value) == {'ref'}:   # the id of the artifact an earlier step returned
        found = results[value['ref']]['ok']
        return (found[0] if isinstance(found, (list, tuple)) else found)['id']
    if isinstance(value, dict) and set(value) == {'bytes'}:
        return value['bytes'].encode('utf-8')
    if isinstance(value, dict) and set(value) == {'hex'}:
        return bytes.fromhex(value['hex'])
    return value


def _error(error):
    return {'error': type(error).__name__, 'message': str(error), 'status': getattr(error, 'status', None), 'code': getattr(error, 'code', None)}


def store_run(root, steps, clock=1000.0):
    store = artifacts.ArtifactStore(root, _Clock(clock))
    store.origin = 'http://127.0.0.1:1'
    saved = {'MAX_BYTES': artifacts.MAX_BYTES, 'MAX_VERSIONS': artifacts.MAX_VERSIONS}
    results = []
    try:
        for step in steps:
            if 'clock' in step:
                store.clock.t = float(step['clock'])   # time.time() is always a float
                results.append({'ok': None})
                continue
            if 'limits' in step:
                for name, value in step['limits'].items():
                    setattr(artifacts, name, value)
                results.append({'ok': None})
                continue
            try:
                args = [_arg(a, results) for a in step.get('args', [])]
                kwargs = {k: _arg(v, results) for k, v in step.get('kwargs', {}).items()}
                value = getattr(store, step['call'])(*args, **kwargs)
                results.append({'ok': value})
            except Exception as error:   # compared with the Deno side's error
                results.append(_error(error))
    finally:
        for name, value in saved.items():
            setattr(artifacts, name, value)
    return results


def _refs(value, results):
    """{"ref": i} anywhere in a request: the id of the artifact that request i answered with."""
    if isinstance(value, dict) and set(value) == {'ref'}:
        return results[value['ref']][1]['id']
    if isinstance(value, dict):
        return {k: _refs(v, results) for k, v in value.items()}
    if isinstance(value, list):
        return [_refs(v, results) for v in value]
    return value


def service_run(root, project, steps, live=None, clock=1000.0):
    store = artifacts.ArtifactStore(root, _Clock(clock))
    store.origin = 'http://127.0.0.1:1'
    events = []
    live = live or {}
    service = artifacts.Service(store, lambda: 't', lambda ident: None if ident.startswith('nope') else project,
                                lambda cid, event: events.append([cid, event]), chat_of=lambda ident: live.get(ident, ident))
    results = []
    for step in steps:
        if 'clock' in step:
            store.clock.t = float(step['clock'])
            continue
        if 'write' in step:
            path = pathlib.Path(project) / step['write'][0]
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(step['write'][1].encode('utf-8'))
            continue
        handler = types.SimpleNamespace(headers=_Headers(step.get('headers', {'X-Studio-Token': 't'})))
        if 'get' in step:
            results.append(list(service.handle_get(handler, step['get'], _refs(step.get('args', {}), results))))
        else:
            results.append(list(service.handle_post(handler, step['post'], _refs(step.get('body'), results))))
    return {'results': results, 'events': events}


def watcher_run(root, project, steps):
    clock = _Clock()
    store = artifacts.ArtifactStore(root, clock)
    store.origin = 'http://127.0.0.1:1'
    events = []
    service = artifacts.Service(store, lambda: 't', lambda cid: project, lambda cid, event: events.append([cid, event]))
    writes = {'c1': [], 'c2': []}
    now = [100.0]
    watcher = artifacts.Watcher(service, lambda: [{'id': c, 'cwd': project, 'writes': list(p)} for c, p in writes.items()],
                                clock=lambda: now[0], list_every=0)
    outputs = pathlib.Path(project) / 'outputs'
    outputs.mkdir(parents=True, exist_ok=True)
    for step in steps:
        if 'tick' in step:
            now[0] += float(step['tick'])
            watcher.tick()
        elif 'clock' in step:
            clock.t += float(step['clock'])
        elif 'write' in step:
            name, text, by, stamp = step['write']
            path = outputs / name
            path.write_bytes(text.encode('utf-8'))
            os.utime(path, ns=(stamp, stamp))
            if by and str(path) not in writes[by]:
                writes[by].append(str(path))
        elif 'unlink' in step:
            (outputs / step['unlink']).unlink()
        elif 'preview' in step:
            cid, name = step['preview']
            _, real = service.resolve_path(cid, str(outputs / name))
            service.sync_file(cid, real, 'preview', cwd=project)
    manifests = sorted(store.all(), key=lambda m: m['createdAt'])
    return {'events': events, 'store': [dict(store.summary(m), byes=[v['by'] for v in m['versions']]) for m in manifests]}


def guess_title(path, kind, text):
    return artifacts.guess_title(path, kind, text.encode('utf-8'))


def inject_scroll(text):
    return artifact_origin.inject_scroll(text.encode('utf-8')).decode('utf-8')


def markdown_page(source, title):
    return artifact_origin.markdown_page(source, title).decode('utf-8')


def tracker_run(cwd, updates, now=5.0):
    tracker = artifacts.WriteTracker(cwd)
    recorded = [tracker.observe(u, now=now) for u in updates]
    return {'recorded': recorded, 'written': tracker.written()}


def mime_guess(name):
    import mimetypes
    return mimetypes.guess_type(name)[0]


_origins = {}


def origin_start(root, studio_port):
    server = artifact_origin.OriginServer(root, studio_port)
    _origins[server.port] = server
    return server.port


def origin_stop(port):
    _origins.pop(port).stop()
    time.sleep(0)
    return True
