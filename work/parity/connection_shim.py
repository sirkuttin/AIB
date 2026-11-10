"""Drives Python's acp_connection.Connection through a script of steps, for the Deno differential test
(work/deno/connection_parity_test.ts runs the same script against server/acp/connection.ts and compares).

run_script(agent, flags, steps, provider='omp') starts the agent (agent 'fake' = work/fake_acp.py, 'stream' =
work/parity/stream_agent.py) with Python in a temp folder, runs the steps and returns plain JSON:
{cwd, results: [{ok} | {error, message}], events, writes, stderr, written}. Times and random keys are left as they are;
the Deno side scrubs both outputs the same way. Steps are documented in connection_parity_test.ts. options: {terminal: bool, fs: None | 'read' | 'readwrite'}.
"""
import json
import pathlib
import shutil
import sys
import tempfile
import threading
import time

import acp_connection

WORK = pathlib.Path(__file__).resolve().parent.parent
AGENTS = {'fake': WORK / 'fake_acp.py', 'stream': WORK / 'parity' / 'stream_agent.py'}


def _until(condition, what, seconds=20):
    deadline = time.time() + seconds
    while time.time() < deadline:
        if condition():
            return
        time.sleep(0.01)
    raise TimeoutError('timed out waiting for ' + what)


def condition(c, spec):
    """Named waits shared with the Deno side."""
    name, _, arg = spec.partition(':')
    if name == 'permissions':
        return lambda: bool(c.permissions)
    if name == 'elicitations':
        return lambda: bool(c.elicitations)
    if name == 'auth':
        return lambda: c.auth is not None and not c.auth.get('working')
    if name == 'auth_error':
        return lambda: c.auth is not None and bool(c.auth.get('error'))
    if name == 'idle':
        return lambda: not c.busy and not c.queue.inflight
    if name == 'busy':
        return lambda: c.busy
    if name == 'ready':
        return lambda: c.ready
    if name == 'closed':
        return lambda: c.closed and not c.busy
    if name == 'events':   # events:<kind>:<count>
        kind, _, count = arg.partition(':')
        return lambda: sum(e['kind'] == kind for e in list(c.events)) >= int(count)
    if name == 'text':     # text:<substring>:<count> among update texts
        sub, _, count = arg.rpartition(':')
        return lambda: sum(sub in json.dumps(e['data'], ensure_ascii=False) for e in list(c.events) if e['kind'] == 'update') >= int(count)
    if name == 'subagent':  # subagent:<id>:<state or ''>
        child, _, state = arg.partition(':')
        return lambda: child in c.subagents and (not state or c.subagents[child].get('state') == state)
    raise ValueError('unknown wait ' + spec)


def _withdrawn_key(c, kind):
    return next(e['data']['key'] for e in list(c.events) if e['kind'] == 'request_withdrawn' and e['data']['kind'] == kind)


def step(c, s, state):
    op = s['op']
    if op == 'setup':
        return c.setup(s.get('resume'))
    if op == 'setup_bg':
        def run():
            try:
                c.setup(s.get('resume'))
                state['setup'] = {'ok': None}
            except Exception as error:
                state['setup'] = {'error': type(error).__name__, 'message': str(error)}
        threading.Thread(target=run, daemon=True).start()
        return None
    if op == 'join_setup':
        _until(lambda: 'setup' in state, 'setup')
        return state.pop('setup')
    if op == 'prompt':
        return c.prompt(s['text'], s.get('id'), s.get('attachments'))
    if op == 'fingerprint':
        return c._prepare_prompt(s['text'], s.get('id'), s.get('attachments'))[3]
    if op == 'queue_add':
        return c.queue_add(s['text'], s.get('id'), s.get('attachments'))
    if op == 'queue':
        return getattr(c, 'queue_' + s['action'])(*s.get('args', []))
    if op == 'wait':
        _until(condition(c, s['for']), s['for'])
        return None
    if op == 'sleep':
        time.sleep(s['ms'] / 1000)
        return None
    if op == 'permission':
        key = _withdrawn_key(c, 'permission') if s.get('withdrawn') else next(iter(c.permissions))
        return c.permission(key, s.get('option'))
    if op == 'elicit':
        key = _withdrawn_key(c, 'elicitation') if s.get('withdrawn') else next(iter(c.elicitations))
        return c.answer_elicitation(key, s['action'], s.get('content'))
    if op == 'receive_elicitation':
        return c._receive_elicitation(s['rpcId'], s['params'])
    if op == 'auth':
        return c.answer_auth(s['action'], s.get('method'))
    if op == 'cancel':
        return c.cancel(s.get('subagent'))
    if op == 'cancel_incoming':
        return c.cancel_incoming_request(s['id'])
    if op == 'change':
        return c.change_setting(s['kind'], s.get('configId'), s['value'])
    if op == 'cancel_pending':
        return c.cancel_pending(s['key'])
    if op == 'request':
        return c.request(s['method'], s['params'], s.get('timeout', 30))
    if op == 'discover':
        return c.initialize_for_discovery()
    if op == 'list_sessions':
        return c.list_sessions(s.get('cwd'), s.get('cursor'))
    if op == 'public':
        data = c.public(s.get('after', 0), s.get('light', False))
        data.pop('events')
        return data
    if op == 'attention':
        return c.attention()
    if op == 'write_file':
        (pathlib.Path(state['folder']) / s['name']).write_bytes(s['text'].encode('utf-8'))
        return None
    if op == 'kill':
        c.process.kill()
        return None
    if op == 'close':
        return c.close()
    raise ValueError('unknown op ' + op)


def run_script(agent, flags, steps, provider='omp', options=None):
    options = options or {}
    folder = tempfile.mkdtemp(prefix='aib-conn-parity-')
    steps = json.loads(json.dumps(steps).replace('<cwd>', folder.replace('\\', '/')))   # '<cwd>' in a step: the temp folder, with /
    writes, results, state = [], [], {}
    c = acp_connection.Connection([sys.executable, str(AGENTS[agent]), *flags], pathlib.Path(folder), provider,
                                  enable_terminal=options.get('terminal', False), enable_fs=options.get('fs'))
    state['folder'] = folder
    original = c.write
    c.write = lambda message: (writes.append(json.loads(json.dumps(message))), original(message))[1]
    c.caps.write_response = c.write   # client capability replies too (ClientCaps kept the unwrapped method)
    try:
        for s in steps:
            try:
                results.append({'ok': step(c, s, state)})
            except Exception as error:
                results.append({'error': type(error).__name__, 'message': str(error)})
    finally:
        c.close()
    out = {'cwd': folder, 'results': json.loads(json.dumps(results, default=list)), 'events': json.loads(json.dumps(list(c.events), default=list)),
           'writes': writes, 'stderr': list(c.stderr), 'written': c.writes.written()}
    shutil.rmtree(folder, ignore_errors=True)
    return out
