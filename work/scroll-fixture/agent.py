"""Scripted ACP agent for the scroll e2e tests (work/deno/scroll_e2e_test.ts). Standard library only, no model calls.

A prompt `script:<path>` starts a turn that follows the JSON-lines file <path>: the test appends one line per step and the agent
sends it at once, so the test decides exactly what arrives and when. Lines:

  {"u": {...}}                    a session/update for this chat (any ACP update body: agent_message_chunk, tool_call, ...)
  {"u": {...}, "sid": "child-1"}  the same for another session id (a subagent's own messages)
  {"ask": "title"}                a permission request (the approval card); the answer is ignored, the script goes on
  {"end": "end_turn"}             the turn ends with that stopReason

Any other prompt is answered with one line and ends at once. session/cancel ends the open turn. Studio starts the Claude launcher
as `<node-command> <launcher> ...`, so extra arguments are accepted and ignored.
"""
import json
import os
import sys
import threading
import time
import uuid

if any(arg in ('-h', '--help') for arg in sys.argv[1:]):
    print(__doc__)
    sys.exit(0)

SESSION = 'scroll-' + uuid.uuid4().hex[:12]
lock = threading.Lock()
turn = {}


def emit(value):
    with lock:
        sys.stdout.write(json.dumps(dict(jsonrpc='2.0', **value)) + '\n')
        sys.stdout.flush()


def update(body, sid=None):
    emit({'method': 'session/update', 'params': {'sessionId': sid or SESSION, 'update': body}})


def end(key, reason='end_turn'):
    if turn.get('key') == key:
        turn.pop('key', None)
        emit({'id': key, 'result': {'stopReason': reason}})


def follow(key, path):
    """Send each line of the script as it is appended; give up after 15 minutes."""
    deadline = time.time() + 900
    pos = 0
    buf = ''
    asks = 0
    while time.time() < deadline and turn.get('key') == key:
        try:
            with open(path, 'r', encoding='utf-8') as f:
                f.seek(pos)
                chunk = f.read()
                pos = f.tell()
        except OSError:
            chunk = ''
        if not chunk:
            time.sleep(0.01)
            continue
        buf += chunk
        while '\n' in buf:
            line, buf = buf.split('\n', 1)
            if not line.strip():
                continue
            step = json.loads(line)
            if 'u' in step:
                update(step['u'], step.get('sid'))
            elif 'ask' in step:
                asks += 1
                emit({'id': 'scroll-ask-%d' % asks, 'method': 'session/request_permission', 'params': {
                    'sessionId': SESSION, 'toolCall': {'title': step['ask'], 'toolCallId': 'scroll-ask-%d' % asks},
                    'options': [{'optionId': 'yes', 'name': 'Allow once', 'kind': 'allow_once'},
                                {'optionId': 'no', 'name': 'Reject', 'kind': 'reject_once'}]}})
            elif 'end' in step:
                end(key, step['end'])
                return
    end(key, 'cancelled')


for raw in sys.stdin:
    try:
        message = json.loads(raw)
    except ValueError:
        continue
    method = message.get('method')
    key = message.get('id')
    params = message.get('params') or {}
    if method == 'initialize':
        emit({'id': key, 'result': {'protocolVersion': 1, 'agentCapabilities': {
            'loadSession': True, 'promptCapabilities': {'image': True, 'embeddedContext': False, 'audio': False}}}})
    elif method in ('session/new', 'session/load', 'session/resume'):
        if method != 'session/new' and params.get('sessionId'):
            SESSION = params['sessionId']
        emit({'id': key, 'result': {'sessionId': SESSION, 'modes': {'currentModeId': 'code', 'availableModes': [{'id': 'code', 'name': 'Code'}]}}})
    elif method == 'session/prompt':
        text = next((b.get('text', '') for b in params.get('prompt', []) if b.get('type') == 'text'
                     and not b.get('text', '').startswith('<studio-context>')), '').strip()
        if text.startswith('script:'):
            turn['key'] = key
            threading.Thread(target=follow, args=(key, text[7:]), daemon=True).start()
        else:
            update({'sessionUpdate': 'agent_message_chunk', 'content': {'type': 'text', 'text': 'ok: ' + text[:200]}})
            emit({'id': key, 'result': {'stopReason': 'end_turn'}})
    elif method == 'session/cancel':
        if 'key' in turn:
            end(turn['key'], 'cancelled')
    elif method in ('session/set_mode', 'session/set_config_option', 'session/close'):
        emit({'id': key, 'result': {}})
    elif key is not None and method:
        emit({'id': key, 'error': {'code': -32601, 'message': 'Method not found'}})
    # answers to our own requests (permission) need nothing
