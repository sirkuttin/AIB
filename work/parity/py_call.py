"""Parity bridge for the Deno port: calls functions of the Python server modules so Deno tests can compare results.

Reads one JSON request per line on stdin: {"module": "rpc_errors", "func": "describe_auth_methods", "args": [...], "kwargs": {...}}
and answers one JSON line: {"ok": <result>} or {"error": "<ExceptionType>", "message": "..."}. Tuples become lists, sets sorted lists.
`func` may be dotted ("RpcError" to construct, "Class.method" for static methods). A special func "__construct_call__" takes
{"cls": ..., "init": [...], "method": ..., "args": [...]} to build an object and call one method on it.
An argument {"__new__": ["module.Class", [args]]} is built into that object before the call.
Started by work/deno/_parity.ts; never imports anything outside the server folder.
"""
import _parity_isolation  # noqa: F401  (must be first: test isolation, as in every work/ test)
import importlib
import json
import sys


def _plain(value):
    if isinstance(value, (list, tuple)):
        return [_plain(v) for v in value]
    if isinstance(value, (set, frozenset)):
        return sorted(_plain(v) for v in value)
    if isinstance(value, dict):
        return {str(k): _plain(v) for k, v in value.items()}
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if isinstance(value, BaseException):
        return {'__error__': type(value).__name__, 'message': str(value)}
    if hasattr(value, '__dict__'):
        return {'__class__': type(value).__name__, **{k: _plain(v) for k, v in vars(value).items() if not k.startswith('_')}}
    return repr(value)


def _resolve(module, dotted):
    target = importlib.import_module(module)
    for part in dotted.split('.'):
        target = getattr(target, part)
    return target


def _revive(value):
    """{"__new__": ["module.Class", [args]]} in an argument builds that object first (e.g. an RpcError to pass to is_auth_required)."""
    if isinstance(value, dict) and set(value) == {'__new__'}:
        dotted, args = value['__new__']
        module, _, name = dotted.rpartition('.')
        return _resolve(module, name)(*[_revive(a) for a in args])
    if isinstance(value, list):
        return [_revive(v) for v in value]
    return value


def handle(request):
    module, func = request['module'], request['func']
    request = dict(request, args=_revive(request.get('args', [])))
    if func == '__construct_call__':
        obj = _resolve(module, request['cls'])(*request.get('init', []), **request.get('init_kwargs', {}))
        return getattr(obj, request['method'])(*request.get('args', []), **request.get('kwargs', {}))
    return _resolve(module, func)(*request.get('args', []), **request.get('kwargs', {}))


def main():
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            reply = {'ok': _plain(handle(json.loads(line)))}
        except Exception as error:   # the Deno side compares errors too
            reply = {'error': type(error).__name__, 'message': str(error)}
        sys.stdout.write(json.dumps(reply, default=repr) + '\n')
        sys.stdout.flush()


if __name__ == '__main__':
    main()
