"""Plain-data wrappers around monitor.py for the Deno parity and golden tests (work/deno/monitor_*_test.ts).

handle() runs the real monitor request handler (create_server's Handler.do_GET) on a path and query without a socket
connection: the authorization gate is bypassed (the Deno side ports only what follows it) and respond() is captured.
Servers (and so their caches) are kept per (omp root, claude root) until reset(). Other helpers return JSON-friendly
snapshots of a Transcript, a Store summary, an ElementTree parse, a timestamp, a base64 decode.
"""
import base64
import pathlib
import time
import xml.etree.ElementTree as ET
from datetime import datetime

import monitor
import security

security.authorize = lambda *args, **kwargs: True   # the gate is tested elsewhere; here only the handler logic is compared
_servers = {}


def _server(omp, claude):
    key = (omp, claude)
    if key not in _servers:
        _servers[key] = monitor.create_server(pathlib.Path(omp) if omp is not None else None, 0,
                                              pathlib.Path(claude) if claude is not None else None)
        _servers[key].api_token_getter = lambda: 'tok'
    return _servers[key]


def handle(omp, claude, path, query=''):
    """{'status', 'body'} of one GET; bytes bodies come back as {'__bytes__': base64, 'mime': ...}."""
    server = _server(omp, claude)
    cls = server.RequestHandlerClass
    handler = cls.__new__(cls)
    handler.server = server
    handler.path = path + ('?' + query if query else '')
    reply = {}

    def respond(status, body, mime='application/json; charset=utf-8'):
        reply.update(status=status, body={'__bytes__': base64.b64encode(body).decode(), 'mime': mime} if isinstance(body, bytes) else body)
    handler.respond = respond
    handler.do_GET()
    return reply


def reset():
    for server in _servers.values():
        server.server_close()
    _servers.clear()
    monitor._model_cache.clear()
    monitor._file_cache.clear()
    return True


def snapshot(path):
    t = monitor.Transcript(pathlib.Path(path)).refresh()
    return {'events': t.events, 'commands': list(t.commands.values()), 'meta': t.meta, 'number': t.number,
            'marks': [list(m) for m in t.plan_marks], 'offset': t.offset, 'images': sorted([n, o] for n, o in t.image_offsets.items()),
            'thinking': t.thinking_at, 'ended': sorted(t.ended_ids), 'jobs': t.job_calls, 'signature': list(t.signature)}


def plan_context(path, start, hidden=False):
    return monitor.Transcript(pathlib.Path(path)).refresh().plan_context(start, hidden)


def image(path, n, i, j=None):
    t = monitor.Transcript(pathlib.Path(path)).refresh()
    media, raw = t.image(n, i, j)
    return [media, base64.b64encode(raw).decode()]


def summary(root, path):
    return monitor.Store(pathlib.Path(root)).summary(pathlib.Path(path))


def notice(xml):
    """ElementTree's view of a task-notification: root tag and children (tag, text), or None on ParseError."""
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return None
    return {'tag': root.tag, 'children': [[c.tag, c.text] for c in root]}


def iso(text):
    try:
        return datetime.fromisoformat(text).timestamp()
    except ValueError as error:
        return {'error': str(error)}


def b64(text):
    try:
        return list(base64.b64decode(text, validate=True))
    except ValueError as error:
        return {'error': str(error)}


def latest_model(path):
    return monitor.latest_assistant_model(pathlib.Path(path))


def find_file(provider, root, session_id):
    found = monitor.find_session_file(provider, root, session_id)
    return None if found is None else str(found)


def time_parse(path, rounds=3):
    best = None
    for _ in range(rounds):
        start = time.perf_counter()
        monitor.Transcript(pathlib.Path(path)).refresh()
        took = time.perf_counter() - start
        best = took if best is None else min(best, took)
    return best
