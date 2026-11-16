"""A stand-in for the WSL helper (server/wsl/helper_main.ts, Track A) in work/deno/wsl_hosts_test.ts and the WSL e2e tests.

Speaks the helper protocol of server/wsl/contract.ts: JSON-RPC 2.0 lines on stdin/stdout, first line `helper.ready`. Offers only
env.get, which and fs.stat; `which` of the name "open-url" also sends a `browser.open` notification with params.url, the name
"slow" is never answered, and fs.stat always fails with data.code "not_found". The version in helper.ready is argv[1] (or "fake").
With argv[2] == "mcp" it also has the MCP tunnel: `mcp: {socket}` in helper.ready, the mcp.* methods (always ok), and `which` of the
name "mcp-request" sends an `mcp.request` notification with params.rid. `which` of the name "flood" first sends about 4 MB of
notifications AIB ignores (its ready line then leaves the keeper's 1 MiB record).
"""
import json
import os
import sys

METHODS = ['env.get', 'which', 'fs.stat']


def send(message):
    sys.stdout.write(json.dumps(message) + '\n')
    sys.stdout.flush()


def main():
    mcp = len(sys.argv) > 2 and sys.argv[2] == 'mcp'
    ready = {'helper': sys.argv[1] if len(sys.argv) > 1 else 'fake', 'protocol': 2,
             'methods': METHODS + (['mcp.accept', 'mcp.reply', 'mcp.closed'] if mcp else [])}
    if mcp:
        ready['mcp'] = {'socket': '/tmp/aib-wsl-test/data-000000000000/helper/mcp.sock'}
    send({'jsonrpc': '2.0', 'method': 'helper.ready', 'params': ready})
    for line in sys.stdin:
        try:
            message = json.loads(line)
        except ValueError:
            continue
        rid, method, params = message.get('id'), message.get('method'), message.get('params') or {}
        if method == 'env.get':
            send({'jsonrpc': '2.0', 'id': rid, 'result': {'env': {'PATH': '/usr/bin:/bin', 'HOME': os.environ.get('HOME', '/home/t')},
                                                          'shell': '/bin/bash', 'home': '/home/t', 'arch': 'x86_64'}})
        elif method == 'which':
            name = str(params.get('name', ''))
            if name == 'slow':
                continue
            if name == 'mcp-request':
                send({'jsonrpc': '2.0', 'method': 'mcp.request',
                      'params': {'rid': params.get('rid', ''), 'headers': {'X-Studio-Conversation-Id': 'c'}, 'body': '{}'}})
            if name == 'flood':
                for _ in range(4000):
                    send({'jsonrpc': '2.0', 'method': 'noise', 'params': {'x': 'x' * 1000}})
            if name == 'open-url':
                send({'jsonrpc': '2.0', 'method': 'browser.open', 'params': {'url': params.get('url', '')}})
            send({'jsonrpc': '2.0', 'id': rid, 'result': {'path': '/usr/bin/' + name}})
        elif mcp and method in ('mcp.accept', 'mcp.reply', 'mcp.closed'):
            send({'jsonrpc': '2.0', 'id': rid, 'result': {'ok': True}})
        elif method == 'fs.stat':
            send({'jsonrpc': '2.0', 'id': rid, 'error': {'code': -32000, 'message': 'No such file', 'data': {'code': 'not_found'}}})
        else:
            send({'jsonrpc': '2.0', 'id': rid, 'error': {'code': -32601, 'message': 'unknown method'}})


if __name__ == '__main__':
    main()
