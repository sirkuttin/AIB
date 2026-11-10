"""Plain-data wrapper around state_store for the Deno parity and interop tests (work/deno/state_store_test.ts).

run(kind, state_dir, steps) builds one store and runs the steps on it. A step is {"call": method, "args": [...], "kwargs": {...}}
or {"reopen": true} (a new store on the same folder, as after a restart). Each step's result is {"ok": value} or
{"error": type, "message": str}. Returns {"results": [...], "public": <public() or recovery dump at the end>}.
add_many(kind, state_dir, tag, count, pause) adds `count` entries one update at a time, pausing `pause` s before each (the concurrency test runs it beside Deno).
state_dir may be null for an in-memory store. Only test temp folders are ever passed in.
"""
import time

import state_store

KINDS = {'conversations': state_store.ConversationState, 'projects': state_store.ProjectPrefs,
         'read': state_store.ReadState, 'settings': state_store.SettingsStore}


def _open(kind, state_dir, name):
    if kind == 'recovery':
        return state_store.StateStore(state_dir, name)
    return KINDS[kind](state_dir)


def recovery_dump(store):
    return {'conversations': list(store.conversations.values()), 'receipts': store.receipts, 'warning': store.warning,
            'loadedFromPrevious': store.loaded_from_previous}


def _final(kind, store):
    return recovery_dump(store) if kind == 'recovery' else store.public()


def run(kind, state_dir, steps, name='recovery'):
    store = _open(kind, state_dir, name)
    results = []
    for step in steps:
        if step.get('reopen'):
            store = _open(kind, state_dir, name)
            results.append({'ok': None})
            continue
        try:
            value = getattr(store, step['call'])(*step.get('args', []), **step.get('kwargs', {}))
            results.append({'ok': value})
        except Exception as error:   # compared with the Deno side's error
            results.append({'error': type(error).__name__, 'message': str(error)})
    return {'results': results, 'public': _final(kind, store)}


def public(kind, state_dir, name='recovery'):
    return _final(kind, _open(kind, state_dir, name))


def add_many(kind, state_dir, tag, count, pause=0.0):
    store = _open(kind, state_dir, 'recovery')
    for i in range(count):
        time.sleep(pause)
        if kind == 'conversations':
            store.apply('pin', 'omp', f'{tag}-{i}')
        elif kind == 'projects':
            store.update({'set': {f'{tag}-{i}': {'name': 'n'}}})
        elif kind == 'read':
            store.update({'set': {f'omp:{tag}-{i}': {'seenAt': i + 1}}})
        else:
            store.update({'defaults': {'projects': {f'{tag}-{i}': {'model': 'm'}}}})
    return count
