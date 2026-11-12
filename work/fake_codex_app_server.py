"""A stand-in for `codex app-server` (server/agents/codex_limits.ts appServerLimits): answers initialize and
account/rateLimits/read with fixed numbers, in the documented camelCase shape. Arguments are ignored except:
  --fail      answer account/rateLimits/read with an error
  --log FILE  append each received method to FILE (tests check the handshake and that only one read was made)
"""
import json
import sys

args = sys.argv[1:]
log = args[args.index('--log') + 1] if '--log' in args else None


def send(value):
    print(json.dumps(dict({'jsonrpc': '2.0'}, **value)), flush=True)


for line in sys.stdin:
    message = json.loads(line)
    method = message.get('method')
    if log:
        with open(log, 'a', encoding='utf-8') as f:
            f.write(str(method) + '\n')
    if method == 'initialize':
        send({'id': message['id'], 'result': {'userAgent': 'fake', 'codexHome': '/fake'}})
    elif method == 'account/rateLimits/read' and '--fail' in args:
        send({'id': message['id'], 'error': {'code': -32603, 'message': 'not signed in'}})
    elif method == 'account/rateLimits/read':
        bucket = {'limitId': 'codex', 'limitName': None,
                  'primary': {'usedPercent': 12.0, 'windowDurationMins': 300, 'resetsAt': 4000000000},
                  'secondary': {'usedPercent': 86.0, 'windowDurationMins': 10080, 'resetsAt': 4000500000},
                  'credits': {'hasCredits': False, 'unlimited': False, 'balance': '0'}, 'planType': 'plus'}
        send({'id': message['id'], 'result': {'rateLimits': bucket, 'rateLimitsByLimitId': {'codex': bucket}}})
