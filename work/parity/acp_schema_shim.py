"""Plain-data wrapper around acp_schema.screen() for the Deno parity tests (work/deno/acp_schema_test.ts).

screen_session(steps) runs the steps against one stub connection and returns everything screen() did, as JSON:
a step is a stdout line (str or any JSON value), {"waiter": [id, method]} to register a pending request,
or {"finish": id} to mark that request answered. Returns {results, events, writes, waiters}.
"""
import threading

import acp_schema


class _Stub:
    def __init__(self):
        self.lock = threading.RLock()
        self.pending, self.events, self.writes = {}, [], []

    def event(self, kind, data):
        self.events.append([kind, data])

    def write(self, message):
        self.writes.append(message)


def screen_session(steps):
    connection = _Stub()
    results = []
    for step in steps:
        if isinstance(step, dict) and set(step) == {'waiter'}:
            key, method = step['waiter']
            connection.pending[key] = {'done': threading.Event(), 'method': method, 'params': {}}
        elif isinstance(step, dict) and set(step) == {'finish'}:
            waiting = connection.pending[step['finish']]
            waiting['response'] = {'result': {}}
            waiting['done'].set()
        else:
            results.append(acp_schema.screen(connection, step))
    waiters = [{'id': key, 'done': w['done'].is_set(), 'response': w.get('response')} for key, w in connection.pending.items()]
    return {'results': results, 'events': connection.events, 'writes': connection.writes, 'waiters': waiters}
