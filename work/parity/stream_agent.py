"""A tiny ACP agent whose stdout and stderr bytes are awkward on purpose, for the Deno Connection parity test.

The prompt "edge" writes: a multibyte character split across two writes, invalid UTF-8, CRLF and lone-CR line ends, a 3 MB line,
a BOM line, a non-JSON line and an unknown notification; stderr gets trailing blanks, invalid UTF-8, an over-long line and more
lines than Studio keeps. On stdin EOF it writes one last notification and half a UTF-8 character with no newline, then exits.
Does not call a model or execute anything.
"""
import json
import sys
import time

out = sys.stdout.buffer
err = sys.stderr.buffer


def send(data):
    out.write(data)
    out.flush()


def emit(value):
    send(json.dumps(dict(jsonrpc='2.0', **value), ensure_ascii=False).encode('utf-8') + b'\n')


def update(text):
    return {'method': 'session/update', 'params': {'sessionId': 'stream-session', 'update': {'sessionUpdate': 'agent_message_chunk', 'content': {'type': 'text', 'text': text}}}}


def edge(key):
    line = json.dumps(dict(jsonrpc='2.0', **update('split € here')), ensure_ascii=False).encode('utf-8') + b'\n'
    cut = line.index('€'.encode('utf-8')) + 1
    send(line[:cut])
    time.sleep(0.05)
    send(line[cut:])
    send(b'{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"stream-session","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"bad \xff\xfe byte \xf0\x80\x80 end"}}}}\n')
    send(json.dumps(dict(jsonrpc='2.0', **update('crlf'))).encode() + b'\r\n')
    send(json.dumps(dict(jsonrpc='2.0', **update('lone cr'))).encode() + b'\r' + json.dumps(dict(jsonrpc='2.0', **update('after cr'))).encode() + b'\n')
    big = json.dumps(dict(jsonrpc='2.0', **update('x' * 3_000_000))).encode()
    for start in range(0, len(big), 65536):
        send(big[start:start + 65536])
    send(b'\n')
    send(b'\xef\xbb\xbf' + json.dumps(dict(jsonrpc='2.0', **update('bom'))).encode() + b'\n')
    send(b'this is not json\n\n   \n')
    emit({'method': 'x/whatever', 'params': {'a': 1}})
    err.write(b'warn line   \t \n\xfe bad bytes\n' + b'y' * 3000 + b'\n')
    for index in range(35):
        err.write(b'stderr %d\n' % index)
    err.write(b'no newline at the end')
    err.flush()
    emit({'id': key, 'result': {'stopReason': 'end_turn'}})


for raw in sys.stdin:
    message = json.loads(raw)
    method, key, params = message.get('method'), message.get('id'), message.get('params', {})
    if method == 'initialize':
        emit({'id': key, 'result': {'protocolVersion': 1, 'agentCapabilities': {'loadSession': True}}})
    elif method == 'session/new':
        emit({'id': key, 'result': {'sessionId': 'stream-session'}})
    elif method == 'session/prompt':
        text = next((b.get('text', '') for b in params.get('prompt', []) if b.get('type') == 'text'), '')
        if text == 'edge':
            edge(key)
        else:
            emit(update('echo ' + text))
            emit({'id': key, 'result': {'stopReason': 'end_turn'}})
send(json.dumps(dict(jsonrpc='2.0', method='x/tail', params={})).encode() + b'\n\xe2')
