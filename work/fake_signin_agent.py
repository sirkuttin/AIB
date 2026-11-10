"""A fake Claude / Codex adapter for the sign-in tests. It never touches the network and never uses a real login.

`fake_signin_agent.py --cli auth status --json`  prints the contents of FAKE_SIGNIN_STATUS_FILE (exit 1 when it says loggedIn false, like the real one).
`fake_signin_agent.py --cli auth login ...`      FAKE_SIGNIN_LOGIN: ok (flips the status file to signed in, exit 0), fail (exit 3), nochange (exit 0, still signed out),
                                                 hang (starts a grandchild, writes its pid to FAKE_SIGNIN_CHILD, then waits for ever).
`fake_signin_agent.py` (no --cli) speaks ACP over stdio: initialize (authMethods from FAKE_SIGNIN_METHODS: claude | claude-custom | codex | none),
authenticate (FAKE_SIGNIN_AUTH=fail makes it fail), session/new (recorded: a sign-in must never get here).
Every call appends one JSON line to FAKE_SIGNIN_LOG."""
import json
import os
import subprocess
import sys
import time

LOG = os.environ.get('FAKE_SIGNIN_LOG')
STATUS = os.environ.get('FAKE_SIGNIN_STATUS_FILE')


def log(kind, **data):
    if LOG:
        with open(LOG, 'a', encoding='utf-8') as handle:
            handle.write(json.dumps(dict(data, kind=kind, pid=os.getpid())) + '\n')


def cli(args):
    log('cli', args=args)
    if args[:2] == ['auth', 'status']:
        text = open(STATUS, encoding='utf-8').read() if STATUS and os.path.exists(STATUS) else '{"loggedIn": false}'
        sys.stdout.write(text)
        sys.stdout.flush()
        try:
            signed_in = json.loads(text).get('loggedIn') is True
        except ValueError:
            signed_in = False
        sys.exit(0 if signed_in else 1)
    if args[:2] == ['auth', 'login']:
        mode = os.environ.get('FAKE_SIGNIN_LOGIN', 'ok')
        if mode == 'ok' and STATUS:
            open(STATUS, 'w', encoding='utf-8').write('{"loggedIn": true, "authMethod": "claude.ai", "email": "placeholder-account", "subscriptionType": "max"}')
        if mode == 'fail':
            sys.exit(3)
        if mode == 'hang':
            child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(300)'])
            if os.environ.get('FAKE_SIGNIN_CHILD'):
                open(os.environ['FAKE_SIGNIN_CHILD'], 'w').write(str(child.pid))
            time.sleep(300)
        sys.exit(0)
    sys.exit(2)


def methods(caps):
    mode = os.environ.get('FAKE_SIGNIN_METHODS', 'claude')
    terminal_ok = bool(((caps or {}).get('auth') or {}).get('terminal'))
    if mode in ('claude', 'claude-custom') and terminal_ok:
        extra = ['--custom-flag'] if mode == 'claude-custom' else []
        return [{'id': 'claude-ai-login', 'name': 'Claude Subscription', 'type': 'terminal', 'args': ['--cli', 'auth', 'login', '--claudeai'] + extra},
                {'id': 'console-login', 'name': 'Anthropic Console', 'type': 'terminal', 'args': ['--cli', 'auth', 'login', '--console']}]
    if mode == 'codex':
        return [{'id': 'chatgpt', 'name': 'Login with ChatGPT', 'description': 'Use your ChatGPT login'},
                {'type': 'env_var', 'id': 'codex-api-key', 'name': 'Use CODEX_API_KEY', 'vars': [{'name': 'CODEX_API_KEY'}]}]
    return []


def acp():
    for raw in sys.stdin:
        try:
            message = json.loads(raw)
        except ValueError:
            continue
        name, ident, params = message.get('method'), message.get('id'), message.get('params') or {}
        if name == 'initialize':
            log('initialize', caps=params.get('clientCapabilities'))
            reply = {'protocolVersion': 1, 'agentCapabilities': {}, 'authMethods': methods(params.get('clientCapabilities'))}
        elif name == 'authenticate':
            log('authenticate', methodId=params.get('methodId'))
            if os.environ.get('FAKE_SIGNIN_AUTH') == 'fail':
                print(json.dumps({'jsonrpc': '2.0', 'id': ident, 'error': {'code': -32000, 'message': 'login refused'}}), flush=True)
                continue
            if STATUS:
                open(STATUS, 'w', encoding='utf-8').write('{"loggedIn": true}')
            reply = {}
        elif name in ('session/new', 'session/load', 'session/resume'):
            log('session', method=name)
            reply = {'sessionId': 'fake'}
        else:
            continue
        print(json.dumps({'jsonrpc': '2.0', 'id': ident, 'result': reply}), flush=True)


if '--cli' in sys.argv:
    cli([a for a in sys.argv[1:] if a != '--cli'])
else:
    acp()
