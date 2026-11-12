"""Deterministic ACP test agent. Does not call a model or execute tools."""
import argparse
import json
import re
import itertools
import time
import sys
import os

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--setup-question', action='store_true', help='Ask a request-scoped form question during initialize')
parser.add_argument('--setup-fail', action='store_true', help='Fail session setup after the setup question is answered')
parser.add_argument('--images', action='store_true', help='Advertise and echo image prompt blocks')
parser.add_argument('--embedded-context', action='store_true', help='Advertise promptCapabilities.embeddedContext and echo resource blocks')
parser.add_argument('--audio', action='store_true', help='Advertise promptCapabilities.audio and echo audio blocks')
parser.add_argument('--rich', action='store_true', help='Reply with markdown, tool calls (with diffs/locations) and resource blocks')
parser.add_argument('--cancel-aware', action='store_true', help='End any pending turn with stopReason cancelled on session/cancel and report permission outcomes')
parser.add_argument('--protocol-version', type=int, default=1, help='protocolVersion to return from initialize')
parser.add_argument('--bad-initialize', action='store_true', help='Return a wrong-typed initialize result')
parser.add_argument('--bad-session', choices=['no-id', 'bad-modes'], help='Return a malformed session/new or session/load result')
parser.add_argument('--malformed', action='store_true', help='Prompt "junk" emits malformed/unknown protocol messages; "die" exits mid-turn; "badstop" returns a bad stopReason')
parser.add_argument('--auth-required', action='store_true', help='Advertise auth methods; session/new and session/load fail with auth_required (-32000) until authenticated')
parser.add_argument('--auth-file', help='With --auth-required: a terminal-style login counts as done once this file exists')
parser.add_argument('--auth-reject', action='store_true', help='With --auth-required: authenticate always fails')
parser.add_argument('--breadth', action='store_true', help='Advertise session capabilities, commands, usage, notices and rich config options')
parser.add_argument('--resume-only', action='store_true', help='With --breadth: advertise session/resume instead of loadSession')
parser.add_argument('--mcp-http', action='store_true', help='With --breadth: advertise http MCP support')
parser.add_argument('--client-caps', action='store_true', help="A prompt 'caps:<JSON list of {method, params}>' makes the agent call those client methods in order and report every response")
parser.add_argument('--list-sessions', action='store_true', help='Advertise session/list with cursor pagination (3 sessions, 2 per page)')
parser.add_argument('--reject-config', action='store_true', help='session/set_config_option and session/set_mode fail (checks how queued settings changes report a refusal)')
parser.add_argument('--require-config-type', action='store_true', help="session/set_config_option fails with -32602 unless params carry type 'id' or 'boolean' (the ACP v2 shape the real adapters demand); also records the last params in the reply")
parser.add_argument('--subagent', action='store_true', help='Announce a cancellable child session when the prompt is "delegate"')
parser.add_argument('--replay-history', action='store_true', help='session/load re-sends two history messages (one user, one agent) before it answers, like real agents do')
parser.add_argument('--demo', action='store_true', help='Demo triggers: stream, html, plan, help (see work/demo-studio/README.md); also remembers the session folder')
parser.add_argument('--models', action='store_true', help="A long model list, three modes with descriptions and an effort setting (implies --breadth's config options); a prompt 'settings?' replies with the current model, mode and effort; session/new calls are counted in the reply too")
parser.add_argument('--beta-auth', action='store_true', help="With --auth-required: the Beta agents' sign-in shapes instead of the fixture ones: a terminal-type method (args ['--fixture-login']), offered only to a client that sends clientCapabilities.auth.terminal, and an agent-type API key method 'gemini-api-key' that takes the key in _meta['api-key']. A successful sign-in writes --auth-file, as a real agent keeps its login")
parser.add_argument('--acp-models', action='store_true', help="Gemini's model shape: session/new carries models {availableModels: [{modelId, name, description}], currentModelId} and no model config option; session/set_model (unstable_setSessionModel) changes it; a prompt 'model?' replies with the current model id")
parser.add_argument('--fixture-login', action='store_true', help='The terminal sign-in itself: write --auth-file, print a line and exit 0 (no ACP)')
parser.add_argument('--terminal-env', action='store_true', help="With --beta-auth: the terminal method also advertises env {'AIB_FIXTURE_LOGIN': 'from-agent'} (ACP v1 map shape); --fixture-login writes that variable's value into --auth-file")
parser.add_argument('--held-turn', action='store_true', help="Claude Code's held turns (claude-agent-acp): announces agentCapabilities._meta.claudeCode; 'helper:<gate>' (or 'helper-ask:<gate>', whose helper asks a permission) starts a background helper, ends its reply (usage_update with _claude/origin human) but holds the response until the helper finished (when <gate> exists) and its follow-up cycle ended (when <gate>.end exists, usage_update with origin task-notification); another prompt settles a held one first, as the adapter does; any other prompt gets 'Fixture reply: <text>'")
parser.add_argument('--not-claude', action='store_true', help='With --held-turn: the same stream without the claudeCode announcement (another agent)')
parser.add_argument('--child-pid-file', help='Start a sleeping child process at launch and write its pid to this file (checks that closing the agent also removes its children)')
args = parser.parse_args()
if args.fixture_login:
    if args.auth_file:
        with open(args.auth_file, 'w', encoding='utf-8') as _f:
            _f.write('signed in' + (' ' + os.environ['AIB_FIXTURE_LOGIN'] if os.environ.get('AIB_FIXTURE_LOGIN') else ''))
    print('Fixture terminal login: signed in.', flush=True)
    sys.exit(0)
if args.child_pid_file:
    import subprocess
    _child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(600)'], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    with open(args.child_pid_file, 'w') as _f:
        _f.write(str(_child.pid))
if args.setup_fail and not args.setup_question:
    parser.error('--setup-fail requires --setup-question')
waiting = {}
caps_run = None  # {'turn': prompt key, 'steps': [...], 'results': [...], 'terminal': id}
setup_answer = False
pending_setup = None
authenticated = False
acp_model = ['gemini-2.5-pro']  # --acp-models: the model session/set_model chose
import os
import pathlib


def auth_ok():
    return not args.auth_required or authenticated or bool(args.auth_file and os.path.exists(args.auth_file))
last_mcp = []
session_cwd = ''
session_name = 'fake-session'
EDIT_IDS = itertools.count(1)  # a fresh tool call id for every edit: the page keys rows by id, a reused one merged edits into one row


def SID():
    """The session id agent messages carry: always 'fake-session' (what the tests expect), except with --demo, where it is the loaded chat's own id."""
    return session_name if args.demo else 'fake-session'


config_options = [
    {'id': 'model', 'name': 'Model', 'category': 'model', 'type': 'select', 'currentValue': 'fast', 'options': [
        {'group': 'g1', 'name': 'Small', 'options': [{'value': 'fast', 'name': 'Fast'}]},
        {'group': 'g2', 'name': 'Large', 'options': [{'value': 'deep', 'name': 'Deep', 'description': 'Slow'}]}]},
    {'id': 'effort', 'name': 'Effort', 'category': 'thought_level', 'type': 'select', 'currentValue': 'low', 'options': [
        {'value': 'low', 'name': 'Low'}, {'value': 'high', 'name': 'High'}]},
    {'id': 'verbose', 'name': 'Verbose', 'type': 'boolean', 'currentValue': False},
    {'id': 'dial', 'name': 'Dial', 'type': 'slider', 'currentValue': 7},
]


MODEL_NAMES = ['Sol 6.1', 'Sol 6.1 Mini', 'Terra 5', 'Terra 5 Fast', 'Luna 4', 'Luna 4 Long', 'Vesta 3', 'Vesta 3 Code',
               'Orion 2', 'Orion 2 Vision', 'Atlas 1', 'Atlas 1 Max', 'Nova 7', 'Nova 7 Lite', 'Pulsar 9', 'Quasar 8']
modes = {'currentModeId': 'code', 'availableModes': [{'id': 'code', 'name': 'Code'}]}
session_news = 0
if args.models:
    args.breadth = True
    config_options = [
        {'id': 'model', 'name': 'Model', 'category': 'model', 'type': 'select', 'currentValue': 'sol-6-1', 'options': [
            dict({'value': n.lower().replace(' ', '-').replace('.', '-'), 'name': n}, **({'description': 'Recommended for most work'} if i == 0 else {'description': 'Larger context window, slower'} if 'Long' in n else {}))
            for i, n in enumerate(MODEL_NAMES)]},
        {'id': 'reasoning_effort', 'name': 'Effort', 'category': 'thought_level', 'type': 'select', 'currentValue': 'medium', 'options': [
            {'value': 'low', 'name': 'Low'}, {'value': 'medium', 'name': 'Medium'}, {'value': 'high', 'name': 'High', 'description': 'Thinks longer before it answers'}]},
        {'id': 'verbose', 'name': 'Verbose', 'type': 'boolean', 'currentValue': False},
    ]
    modes = {'currentModeId': 'auto', 'availableModes': [
        {'id': 'ask', 'name': 'Ask first', 'description': 'Asks before every edit and command'},
        {'id': 'auto', 'name': 'Auto review', 'description': 'Edits files; asks before commands outside the folder'},
        {'id': 'full', 'name': 'Full access', 'description': 'Edits and runs anything without asking'}]}


def current_settings_text():
    model = next((o['currentValue'] for o in config_options if o['id'] == 'model'), '')
    effort = next((o['currentValue'] for o in config_options if o.get('category') == 'thought_level'), '')
    return 'Fixture settings: model=%s mode=%s effort=%s sessions=%d' % (model, modes['currentModeId'], effort, session_news)


def update(value):
    emit({'method': 'session/update', 'params': {'sessionId': session_name, 'update': value}})


def breadth_announce():
    update({'sessionUpdate': 'available_commands_update', 'availableCommands': [
        {'name': 'plan', 'description': 'Make a plan', 'input': {'hint': 'what to plan'}},
        {'name': 'compact', 'description': 'Compact context'},
        {'name': 'review', 'description': 'Review <b>changes</b>'}]})
    if not args.demo:   # the demo keeps each saved chat's own title
        update({'sessionUpdate': 'session_info_update', 'title': 'Fixture <session>', 'updatedAt': '2026-01-02T03:04:05Z'})
    update({'sessionUpdate': 'usage_update', 'size': 200000, 'used': 12345, 'cost': {'amount': 0.25, 'currency': 'USD'}})
    update({'sessionUpdate': 'notice', 'title': 'Fixture notice', 'description': 'Heads up', 'severity': 'warning'})


import threading
_emit_lock = threading.Lock()


def emit(value):
    with _emit_lock:   # streaming turns write from their own thread
        print(json.dumps(dict(jsonrpc='2.0', **value)), flush=True)


_received_log = os.environ.get('FAKE_ACP_LOG')   # every line this agent receives, appended (tests count what reached it)
_mcp_pids = os.environ.get('FAKE_ACP_MCP_PIDS')   # set: start the stdio MCP servers of session/new like a real agent, pids to this file
_mcp_children = []


def start_mcp_servers(servers):
    """What real agents do with the stdio entries of session/new: start each one as a child (kept running), its pid appended to a file."""
    import subprocess
    for server in servers or []:
        if not isinstance(server, dict) or not server.get('command') or server.get('type') in ('http', 'sse'):
            continue
        env = dict(os.environ)
        for item in server.get('env') or []:
            env[item.get('name', '')] = item.get('value', '')
        try:
            child = subprocess.Popen([server['command'], *(server.get('args') or [])], env=env,
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        except OSError as error:
            child = None
            print(f'fake agent: could not start MCP server {server.get("name")}: {error}', file=sys.stderr, flush=True)
        if child:
            _mcp_children.append(child)
            with open(_mcp_pids, 'a', encoding='utf-8') as f:
                f.write(f'{child.pid} {server.get("name", "")} {server["command"]}\n')
stream_answer = {}   # 'stream:' turns: the permission answer, set by the main loop


def result(key, value):
    emit({'id': key, 'result': value})

RICH_MARKDOWN = """# Rich reply

Some **bold**, *italic*, `inline code` and a [safe link](https://example.org/docs).
A [bad link](javascript:alert(1)) and <script>alert(1)</script> stay as text.

- first item
- second item
  - nested item

1. one
2. two

> a quoted note

| Name | Value |
| --- | --- |
| alpha | 1 |

```python
print("hello")
```
"""


def rich_turn(prompt_key):
    sid = SID()

    def update(body):
        emit({'method': 'session/update', 'params': {'sessionId': sid, 'update': body}})
    update({'sessionUpdate': 'agent_message_chunk', 'content': {'type': 'text', 'text': RICH_MARKDOWN}})
    update({'sessionUpdate': 'tool_call', 'toolCallId': 'rich-read', 'title': 'Read config.py', 'kind': 'read', 'status': 'pending', 'locations': [{'path': 'C:/proj/config.py', 'line': 12}]})
    update({'sessionUpdate': 'tool_call_update', 'toolCallId': 'rich-read', 'status': 'completed', 'content': [{'type': 'content', 'content': {'type': 'text', 'text': 'DEBUG = False'}}]})
    update({'sessionUpdate': 'tool_call', 'toolCallId': 'rich-edit', 'title': 'Edit config.py', 'kind': 'edit', 'status': 'in_progress', 'locations': [{'path': 'C:/proj/config.py', 'line': 1}]})
    update({'sessionUpdate': 'tool_call_update', 'toolCallId': 'rich-edit', 'status': 'completed', 'content': [
        {'type': 'diff', 'path': 'C:/proj/config.py', 'oldText': 'DEBUG = False\nPORT = 80\nHOST = "x"\n', 'newText': 'DEBUG = True\nPORT = 80\nHOST = "localhost"\nLOG = 1\n'},
        {'type': 'diff', 'path': 'C:/proj/new_file.txt', 'oldText': None, 'newText': 'brand new\n'}]})
    update({'sessionUpdate': 'tool_call', 'toolCallId': 'rich-exec', 'title': 'Run tests', 'kind': 'execute', 'status': 'completed', 'content': [{'type': 'terminal', 'terminalId': 'term-1'}]})
    update({'sessionUpdate': 'tool_call', 'toolCallId': 'rich-search', 'title': 'Search for TODO', 'kind': 'search', 'status': 'failed'})
    update({'sessionUpdate': 'tool_call', 'toolCallId': 'rich-bash', 'title': 'cd proj && python - <<EOF', 'kind': 'execute', 'status': 'completed',
            'rawInput': {'command': "cd /c/proj && python - <<'EOF'\nimport os\nprint(os.getcwd())  # where\nEOF", 'description': 'Print the working directory', 'timeout': 120000, 'run_in_background': False},
            'rawOutput': 'C:\\proj\n'})
    update({'sessionUpdate': 'agent_message_chunk', 'content': {'type': 'resource_link', 'name': 'Docs', 'uri': 'https://example.org/docs', 'mimeType': 'text/html', 'size': 2048}})
    update({'sessionUpdate': 'agent_message_chunk', 'content': {'type': 'resource_link', 'name': 'config.py', 'uri': 'file:///C:/proj/config.py', 'mimeType': 'text/x-python'}})
    update({'sessionUpdate': 'agent_message_chunk', 'content': {'type': 'resource', 'resource': {'uri': 'file:///C:/proj/notes.txt', 'mimeType': 'text/plain', 'text': 'embedded note line 1\nline 2'}}})
    update({'sessionUpdate': 'agent_message_chunk', 'content': {'type': 'resource', 'resource': {'uri': 'file:///C:/proj/data.bin', 'mimeType': 'application/octet-stream', 'blob': 'AAECAwQF'}}})
    result(prompt_key, {'stopReason': 'end_turn'})


def raw(text):
    print(text, flush=True)


def malformed_prompt(key, params):
    # Each line below violates (or extends) ACP v1 in one specific way; see work/test_conformance.py.
    text = next((b.get('text', '') for b in params['prompt'] if b.get('type') == 'text'), '')
    if text == 'die':
        sys.exit(3)
    if text == 'badstop':
        result(key, {'stopReason': 42})
        return True
    if text != 'junk':
        return False
    update = lambda body, sid='fake-session': raw(json.dumps({'jsonrpc': '2.0', 'method': 'session/update', 'params': dict(({'sessionId': sid} if sid else {}), update=body)}))
    raw('this is not json')
    raw('[1, 2, 3]')
    raw(json.dumps({'method': 'session/update', 'params': {}}))
    raw(json.dumps({'jsonrpc': '2.0', 'id': 99, 'result': {}, 'error': {'code': 1, 'message': 'both'}}))
    raw(json.dumps({'jsonrpc': '2.0', 'method': 7}))
    update({'sessionUpdate': 'agent_message_chunk', 'content': {'type': 'text', 'text': 'no session id'}}, sid=None)
    update({'sessionUpdate': 'agent_message_chunk', 'content': 'not a block'})
    update({'sessionUpdate': 'tool_call', 'toolCallId': 5, 'title': 'x'})
    update({'sessionUpdate': 'plan', 'entries': 'nope'})
    update({'sessionUpdate': 'future_kind_v9', 'anything': True})
    update({'sessionUpdate': 'future_kind_v9', 'anything': False})
    update({'sessionUpdate': 'agent_message_chunk', 'content': {'type': 'future_block', 'x': 1}})
    update({'sessionUpdate': 'agent_message_chunk', 'content': {'type': 'text', 'text': 'valid after junk'}})
    emit({'id': 'bad-perm', 'method': 'session/request_permission', 'params': {'sessionId': SID(), 'toolCall': {'toolCallId': 't'}, 'options': 'none'}})
    emit({'id': 'nope', 'method': 'fs/read_text_file', 'params': {'sessionId': SID(), 'path': 'x'}})
    raw(json.dumps({'jsonrpc': '2.0', 'id': 98765, 'result': {}}))
    raw(json.dumps({'jsonrpc': '2.0', 'id': str(key), 'result': {'stopReason': 'end_turn'}}))
    result(key, {'stopReason': 'end_turn'})
    result(key, {'stopReason': 'end_turn'})
    return True


DEMO_WORDS = ('stream', 'html', 'plan', 'help')
DEMO_HELP = ('Trigger words (send one alone as the whole message): stream = several messages one after another; '
             'html = writes outputs/demo-page.html in the chat folder (appears in Artifacts); plan = a task list; '
             'approve = asks you to allow a tool; form = asks a question; wait = never answers until you stop it; '
             'sleep:5 = works for 5 seconds; delegate = starts a background agent; anything else = a rich reply with tool calls.')


def demo_html(count):
    return ('<!doctype html><meta charset="utf-8"><title>Demo page</title>'
            '<body style="font:16px system-ui;margin:2rem"><h1>Demo page</h1>'
            '<p>Written by the fixture agent, version %d.</p><ul><li>alpha</li><li>beta</li><li>gamma</li></ul></body>' % count)


def demo_turn(key, word):
    """Scripted demo behaviours. Runs on a thread so cancel still works; the turn ends with end_turn or cancelled."""
    import threading
    waiting['turn'] = key
    say = lambda text: update({'sessionUpdate': 'agent_message_chunk', 'content': {'type': 'text', 'text': text}})

    def run():
        def alive():
            return waiting.get('turn') == key
        if word == 'help':
            say(DEMO_HELP)
        elif word == 'stream':
            for index in range(1, 6):
                if not alive():
                    return
                say('Streaming message %d of 5. ' % index)
                time.sleep(0.7)
        elif word == 'plan':
            entries = [('Read the code', 'completed'), ('Write the change', 'in_progress'), ('Run the tests', 'pending'), ('Summarise', 'pending')]
            update({'sessionUpdate': 'plan', 'entries': [{'content': c, 'priority': 'medium', 'status': s} for c, s in entries]})
            say('Here is the plan.')
        elif word == 'html':
            folder = os.path.join(session_cwd or os.getcwd(), 'outputs')
            os.makedirs(folder, exist_ok=True)
            path = os.path.join(folder, 'demo-page.html')
            count = 1
            if os.path.exists(path):
                with open(path, encoding='utf-8') as handle:
                    match = re.search(r'version (\d+)', handle.read())
                count = int(match.group(1)) + 1 if match else 2
            body = demo_html(count)
            with open(path, 'w', encoding='utf-8') as handle:
                handle.write(body)
            update({'sessionUpdate': 'tool_call', 'toolCallId': 'demo-write-%d' % count, 'title': 'Write outputs/demo-page.html', 'kind': 'edit', 'status': 'completed',
                    'locations': [{'path': path}], 'content': [{'type': 'diff', 'path': path, 'oldText': None, 'newText': body}]})
            say('Wrote outputs/demo-page.html (version %d). It shows up in the Artifacts panel in a moment.' % count)
        if alive():
            waiting.pop('turn', None)
            result(key, {'stopReason': 'end_turn'})
    threading.Thread(target=run, daemon=True).start()


WORKTREE_COMMANDS = ('edit:', 'delete:', 'commit:', 'say:', 'context', 'call-tool:')


def worktree_turn(key, prompt_text, blocks):
    """Turn commands that act in the session folder (the chat's worktree), used by work/test_worktree_e2e.py:
    edit:<relpath>|<text>   write the file (a literal \\n in the text is a newline; a relative path is inside the session folder)
    delete:<relpath>        remove the file
    commit:<message>        git add -A, git commit in the session folder (reports the new HEAD)
    say:<text>              just answer
    context                 answer with the <studio-context> note this prompt carried ('none' when it had none)
    call-tool:<action>[:<conversation id>]   call Studio's worktree tool (merge | check | keep_mine | leave) with this chat's own key and,
                            if given, another conversation's id (the key must not work for it); reports 'TOOL <status> <json>'"""
    import subprocess
    import urllib.error
    import urllib.request
    cwd = pathlib.Path(session_cwd or os.getcwd())
    say = lambda text: update({'sessionUpdate': 'agent_message_chunk', 'content': {'type': 'text', 'text': text}})
    if prompt_text.startswith('edit:'):
        path, _, text = prompt_text[5:].partition('|')
        target = cwd / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(text.replace('\\n', '\n').encode('utf-8'))
        update({'sessionUpdate': 'tool_call', 'toolCallId': 'edit-%d' % next(EDIT_IDS), 'title': 'Write ' + path, 'kind': 'edit', 'status': 'completed', 'content': [{'type': 'diff', 'path': str(target), 'oldText': None, 'newText': text}]})
        say('edited ' + path)
    elif prompt_text.startswith('delete:'):
        (cwd / prompt_text[7:]).unlink()
        say('deleted ' + prompt_text[7:])
    elif prompt_text.startswith('commit:'):
        # the repository's own line-ending setting applies, as for a real agent (forcing core.autocrlf=false committed CRLF on Windows)
        git = ['git', '-c', 'user.name=fake-agent', '-c', 'user.email=t@t']
        subprocess.run(git + ['add', '-A'], cwd=str(cwd), check=True, capture_output=True)
        subprocess.run(git + ['commit', '-m', prompt_text[7:]], cwd=str(cwd), check=True, capture_output=True)
        say('committed ' + subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=str(cwd), capture_output=True, text=True).stdout.strip())
    elif prompt_text.startswith('say:'):
        say(prompt_text[4:])
    elif prompt_text == 'context':
        note = next((b.get('text', '') for b in blocks if b.get('type') == 'text' and b.get('text', '').startswith('<studio-context>')), '')
        say('CONTEXT ' + (note or 'none'))
    else:
        action, _, other = prompt_text[len('call-tool:'):].partition(':')
        env = {}
        for server in last_mcp or []:
            if server.get('name') == 'studio_artifact':
                env = {e['name']: e['value'] for e in server.get('env') or []}
        base = env.get('STUDIO_ARTIFACT_URL') or ''
        if not base and env.get('STUDIO_ARTIFACT_URL_FILE'):
            base = pathlib.Path(env['STUDIO_ARTIFACT_URL_FILE']).read_text(encoding='utf-8').strip()
        body = json.dumps({'conversationId': other or env.get('STUDIO_CONVERSATION_ID', ''), 'action': action}).encode('utf-8')
        request = urllib.request.Request(base.rstrip('/') + '/api/live/worktree/tool', data=body, method='POST',
                                         headers={'Content-Type': 'application/json', 'X-Studio-Artifact-Key': env.get('STUDIO_ARTIFACT_KEY', '')})
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                status, reply = response.status, response.read().decode('utf-8', 'replace')
        except urllib.error.HTTPError as error:
            status, reply = error.code, error.read().decode('utf-8', 'replace')
        say('TOOL %s %s' % (status, reply))
    result(key, {'stopReason': 'end_turn'})


def caps_next():
    global caps_run
    run = caps_run
    if len(run['results']) >= len(run['steps']):
        caps_run = None
        emit({'method': 'session/update', 'params': {'sessionId': SID(), 'update': {'sessionUpdate': 'agent_message_chunk', 'content': {'type': 'text', 'text': 'CAPS-RESULTS ' + json.dumps(run['results'])}}}})
        result(run['turn'], {'stopReason': 'end_turn'})
        return
    step = run['steps'][len(run['results'])]
    params = json.loads(json.dumps(step.get('params', {})).replace('"$term"', json.dumps(run.get('terminal'))))
    params.setdefault('sessionId', 'fake-session')
    emit({'id': 'cap-%d' % len(run['results']), 'method': step['method'], 'params': params})


held = {}   # --held-turn: 'turn' = the prompt whose response is held; 'helper-perm' = the helper's open permission (an Event)


def held_turn(key, text):
    """--held-turn prompts (see the flag's help): the shape of claude-agent-acp's updates, as a real run showed them."""
    if 'turn' in held:   # the adapter settles a held turn when the next prompt arrives
        result(held.pop('turn'), {'stopReason': 'end_turn'})
    human = {'_claude/origin': {'kind': 'human'}}
    if not (text.startswith('helper:') or text.startswith('helper-ask:')):
        update({'sessionUpdate': 'agent_message_chunk', 'content': {'type': 'text', 'text': 'Fixture reply: ' + text}})
        update({'sessionUpdate': 'usage_update', 'size': 200000, 'used': 2000, '_meta': human})
        result(key, {'stopReason': 'end_turn'})
        return
    ask = text.startswith('helper-ask:')
    gate = text.split(':', 1)[1]
    child = 'helper-1'
    update({'sessionUpdate': 'usage_update', 'size': 200000, 'used': 1000})   # usage during the turn: no origin
    update({'sessionUpdate': 'tool_call', 'toolCallId': 'agent-1', 'title': 'Agent', 'kind': 'think', 'status': 'pending', '_meta': {'claudeCode': {'toolName': 'Agent'}}})
    update({'sessionUpdate': 'subagent_update', 'sessionId': child, 'title': 'Background helper', 'capabilities': {'cancel': {}}, 'state': {'state': 'running'}})
    # The helper's own config, on its session (claude-agent-acp's subagent form: the Agent input's model, its mode and type).
    emit({'method': 'session/update', 'params': {'sessionId': child, 'update': {'sessionUpdate': 'config_option_update', 'configOptions': [
        {'id': 'mode', 'name': 'Mode', 'category': 'mode', 'type': 'select', 'currentValue': 'bypassPermissions', 'options': [{'value': 'bypassPermissions', 'name': 'Bypass permissions'}]},
        {'id': 'model', 'name': 'Model', 'category': 'model', 'type': 'select', 'currentValue': 'sonnet', 'options': [{'value': 'sonnet', 'name': 'Sonnet 5.5'}]},
        {'id': 'agent', 'name': 'Agent', 'type': 'select', 'currentValue': 'general-purpose', 'options': [{'value': 'general-purpose', 'name': 'general-purpose'}]}],
        '_meta': {'claudeCode': {'parentToolUseId': 'agent-1'}}}}})
    update({'sessionUpdate': 'tool_call_update', 'toolCallId': 'agent-1', 'status': 'completed'})
    update({'sessionUpdate': 'agent_message_chunk', 'content': {'type': 'text', 'text': 'Started a helper.'}})
    update({'sessionUpdate': 'usage_update', 'size': 200000, 'used': 1500})
    update({'sessionUpdate': 'usage_update', 'size': 200000, 'used': 1500, '_meta': human})   # the result: the reply ended
    held['turn'] = key

    def helper():
        deadline = time.time() + 300
        while not os.path.exists(gate) and time.time() < deadline:
            time.sleep(0.02)
        emit({'method': 'session/update', 'params': {'sessionId': child, 'update': {'sessionUpdate': 'agent_message_chunk', 'content': {'type': 'text', 'text': 'helper at work'}, '_meta': {'claudeCode': {'parentToolUseId': 'agent-1'}}}}})
        if ask:
            answered = threading.Event()
            held['helper-perm'] = answered
            emit({'id': 'helper-perm', 'method': 'session/request_permission', 'params': {'sessionId': child, 'toolCall': {'title': 'Helper approval', 'toolCallId': 'helper-tool'}, 'options': [{'optionId': 'yes', 'name': 'Allow once', 'kind': 'allow_once'}]}})
            answered.wait(300)
            emit({'method': 'session/update', 'params': {'sessionId': child, 'update': {'sessionUpdate': 'agent_message_chunk', 'content': {'type': 'text', 'text': 'helper approved'}, '_meta': {'claudeCode': {'parentToolUseId': 'agent-1'}}}}})
        update({'sessionUpdate': 'subagent_update', 'sessionId': child, 'state': {'state': 'idle', 'stopReason': 'end_turn'}})
        update({'sessionUpdate': 'usage_update', 'size': 200000, 'used': 1700})
        update({'sessionUpdate': 'agent_message_chunk', 'content': {'type': 'text', 'text': 'Helper finished.'}})   # Claude Code's own follow-up
        while not os.path.exists(gate + '.end') and time.time() < deadline:
            time.sleep(0.02)
        update({'sessionUpdate': 'usage_update', 'size': 200000, 'used': 1800, '_meta': {'_claude/origin': {'kind': 'task-notification'}}})
        if held.get('turn') == key:
            result(held.pop('turn'), {'stopReason': 'end_turn'})
    threading.Thread(target=helper, daemon=True).start()


for line in sys.stdin:
    if _received_log:
        with open(_received_log, 'a', encoding='utf-8') as _log:
            _log.write(line if line.endswith(chr(10)) else line + chr(10))
    message = json.loads(line)
    method = message.get('method')
    key = message.get('id')
    params = message.get('params', {})
    if args.malformed and method == 'session/prompt' and malformed_prompt(key, params):
        continue
    if args.malformed and method is None and key in ('bad-perm', 'nope'):
        emit({'method': 'session/update', 'params': {'sessionId': SID(), 'update': {'sessionUpdate': 'agent_message_chunk', 'content': {'type': 'text', 'text': 'Fixture reply %s: %s' % (key, message.get('error', {}).get('code'))}}}})
    elif method == 'initialize' and args.bad_initialize:
        result(key, {'protocolVersion': '1', 'agentCapabilities': []})
    elif method in ('session/new', 'session/load') and args.bad_session == 'no-id':
        result(key, {'modes': None})
    elif method in ('session/new', 'session/load') and args.bad_session == 'bad-modes':
        result(key, {'sessionId': SID(), 'modes': {'currentModeId': 5, 'availableModes': {}}})
    elif method == 'initialize':
        capabilities = {'loadSession': True, 'promptCapabilities': {'image': args.images, 'embeddedContext': args.embedded_context, 'audio': args.audio}}
        if args.breadth:
            capabilities['loadSession'] = not args.resume_only
            capabilities['sessionCapabilities'] = {'list': {}, 'close': {}, 'delete': {}, 'resume': {}}
            capabilities['mcpCapabilities'] = {'http': args.mcp_http, 'sse': False}
        if args.list_sessions:
            capabilities.setdefault('sessionCapabilities', {})['list'] = {}
        if args.held_turn and not args.not_claude:
            capabilities['_meta'] = {'claudeCode': {'promptQueueing': True}}
        init = {'protocolVersion': args.protocol_version, 'agentCapabilities': capabilities}
        if args.auth_required and args.beta_auth:
            wants_terminal = bool(((params.get('clientCapabilities') or {}).get('auth') or {}).get('terminal'))
            init['authMethods'] = [{'id': 'gemini-api-key', 'name': 'Use an API key', 'description': 'Key in _meta.api-key'}]
            if wants_terminal:
                terminal_method = {'id': 'fixture-terminal-login', 'name': 'Sign in in a terminal', 'type': 'terminal', 'args': ['--fixture-login']}
                if args.terminal_env:
                    terminal_method['env'] = {'AIB_FIXTURE_LOGIN': 'from-agent'}
                init['authMethods'].insert(0, terminal_method)
        elif args.auth_required:
            init['authMethods'] = [{'id': 'fixture-login', 'name': 'Fixture sign-in', 'description': 'In-app fixture sign-in'},
                {'id': 'fixture-terminal', 'name': 'Fixture terminal login', 'description': 'Run in a terminal', '_meta': {'terminal-auth': {'command': 'fixture-cli', 'args': ['login']}}}]
        result(key, init)
        if args.setup_question:
            emit({'id': 'setup-question', 'method': 'elicitation/create', 'params': {
                'requestId': 'fixture-setup', 'mode': 'form', 'message': 'Fixture setup: confirm workspace label.',
                'requestedSchema': {'type': 'object', 'properties': {'label': {'type': 'string', 'title': 'Workspace label'}}, 'required': ['label']}}})
    elif method == 'authenticate' and args.beta_auth:
        key_given = ((params.get('_meta') or {}).get('api-key') or '') if isinstance(params.get('_meta'), dict) else ''
        if params.get('methodId') == 'gemini-api-key' and key_given:
            authenticated = True
            if args.auth_file:
                with open(args.auth_file, 'w', encoding='utf-8') as _f:
                    _f.write('api key')
            result(key, {})
        else:
            emit({'id': key, 'error': {'code': -32602, 'message': 'Fixture sign-in needs an API key in _meta.api-key'}})
    elif method == 'authenticate':
        if args.auth_reject or params.get('methodId') != 'fixture-login':
            emit({'id': key, 'error': {'code': -32602, 'message': 'Fixture sign-in rejected'}})
        else:
            authenticated = True
            result(key, {})
    elif method in ('session/new', 'session/load'):
        if not auth_ok():
            emit({'id': key, 'error': {'code': -32000, 'message': 'Authentication required', 'data': {'reason': 'auth_required'}}})
        elif args.setup_question and not setup_answer:
            pending_setup = (key, method, params)
        elif args.setup_fail:
            emit({'id': key, 'error': {'code': -32000, 'message': 'Fixture setup failure'}})
        else:
            session_name = params.get('sessionId', 'fake-session')
            session_cwd = params.get('cwd') or session_cwd
            last_mcp = params.get('mcpServers')
            if _mcp_pids and method == 'session/new':
                start_mcp_servers(last_mcp)
            if args.replay_history and method == 'session/load':
                update({'sessionUpdate': 'user_message_chunk', 'content': {'type': 'text', 'text': 'old question'}})
                update({'sessionUpdate': 'agent_message_chunk', 'content': {'type': 'text', 'text': 'old answer'}})
            if method == 'session/new':
                session_news += 1
            session_result = {'sessionId': session_name, 'modes': json.loads(json.dumps(modes))}
            if args.breadth:
                session_result['configOptions'] = config_options
            if args.acp_models:
                session_result['models'] = {'currentModelId': acp_model[0], 'availableModels': [
                    {'modelId': 'gemini-2.5-pro', 'name': 'Gemini 2.5 Pro', 'description': 'Most capable'},
                    {'modelId': 'gemini-2.5-flash', 'name': 'Gemini 2.5 Flash'}]}
            result(key, session_result)
            if args.breadth:
                breadth_announce()
    elif method == 'session/set_model' and args.acp_models:
        if params.get('modelId') in ('gemini-2.5-pro', 'gemini-2.5-flash'):
            acp_model[0] = params['modelId']
            result(key, {})
        else:
            emit({'id': key, 'error': {'code': -32602, 'message': 'Unknown model'}})
    elif method == 'session/prompt' and args.acp_models and 'model?' in json.dumps(params.get('prompt')):
        update({'sessionUpdate': 'agent_message_chunk', 'content': {'type': 'text', 'text': 'Fixture model: ' + acp_model[0]}})
        result(key, {'stopReason': 'end_turn'})
    elif method == 'session/resume':
        session_name = params.get('sessionId', 'fake-session')
        session_cwd = params.get('cwd') or session_cwd
        last_mcp = params.get('mcpServers')
        result(key, {'modes': {'currentModeId': 'code', 'availableModes': [{'id': 'code', 'name': 'Code'}]}, 'configOptions': config_options})
        breadth_announce()
    elif method == 'session/list' and args.breadth:
        sessions = [{'sessionId': SID(), 'cwd': 'C:\\work', 'title': 'First <b>', 'updatedAt': '2026-01-01T00:00:00Z'}, {'sessionId': 'other', 'cwd': 'C:\\work', 'title': None}]
        if params.get('cursor'):
            result(key, {'sessions': sessions[1:], 'nextCursor': None})
        else:
            result(key, {'sessions': sessions[:1], 'nextCursor': 'page2'})
    elif method in ('session/close', 'session/delete'):
        result(key, {})
    elif method == 'session/list':
        everything = [{'sessionId': f'agent-listed-{i}', 'cwd': '/fixture/project', 'title': f'Agent listed {i}', 'updatedAt': f'2026-11-0{i}T00:00:00Z'} for i in (1, 2, 3)]
        start = int(params.get('cursor', 'offset:0').split(':')[1])
        page = everything[start:start + 2]
        result(key, dict({'sessions': page}, **({'nextCursor': f'offset:{start + 2}'} if start + 2 < len(everything) else {})))
    elif method == 'session/prompt' and args.subagent and any(b.get('text') == 'delegate' for b in params['prompt']):
        emit({'method': 'session/update', 'params': {'sessionId': SID(), 'update': {'sessionUpdate': 'subagent_update', 'sessionId': 'child-1', 'title': 'Review the fixture', 'description': 'Reads the fixture and reports', 'capabilities': {'cancel': {}}, 'state': {'state': 'running'}}}})
        waiting['turn'] = key
    elif method == 'session/prompt' and args.held_turn:
        held_turn(key, next((b.get('text', '') for b in params['prompt'] if b.get('type') == 'text' and not b.get('text', '').startswith('<studio-context>')), ''))
    elif key == 'helper-perm' and 'helper-perm' in held:
        held.pop('helper-perm').set()
    elif method == 'session/prompt':
        blocks = params['prompt']
        images = [block for block in blocks if block.get('type') == 'image']
        attached = [block for block in blocks if block.get('type') in ('resource', 'audio') or (block.get('type') == 'text' and block.get('text', '').startswith('Attached file:'))]
        prompt_text = next((block.get('text', '') for block in blocks if block.get('type') == 'text' and not block.get('text', '').startswith('<studio-context>')), '')   # Studio's live-sync note comes first and is not the user's words
        if args.models and prompt_text.strip() == 'settings?':
            update({'sessionUpdate': 'agent_message_chunk', 'content': {'type': 'text', 'text': current_settings_text()}})
            result(key, {'stopReason': 'end_turn'})
            continue
        if args.demo and prompt_text.strip().lower() in DEMO_WORDS and not images and not attached:
            demo_turn(key, prompt_text.strip().lower())
        elif args.client_caps and prompt_text.startswith('caps:'):
            caps_run = {'turn': key, 'steps': json.loads(prompt_text[5:]), 'results': []}
            caps_next()
        elif prompt_text.startswith('write:'):   # write:<path>|<text>: the agent writes a file and reports it as an edit tool call with a diff
            path, _, text = prompt_text[6:].partition('|')
            pathlib.Path(path).write_text(text, encoding='utf-8')
            update({'sessionUpdate': 'tool_call', 'toolCallId': 'w1', 'title': 'Write', 'kind': 'edit', 'status': 'completed', 'content': [{'type': 'diff', 'path': path, 'oldText': None, 'newText': text}]})
            result(key, {'stopReason': 'end_turn'})
        elif prompt_text.startswith(WORKTREE_COMMANDS):   # worktree e2e turns (see worktree_turn)
            worktree_turn(key, prompt_text, blocks)
        elif args.rich and not images and not attached and prompt_text not in ('wait', 'form', 'approve', 'child-ask', 'leave-open'):  # these keep their own flows under --rich
            rich_turn(key)
        elif attached:
            echo = []
            for block in attached:
                resource = block.get('resource') or {}
                echo.append({'type': block['type'], 'mimeType': block.get('mimeType') or resource.get('mimeType'), 'uri': resource.get('uri'),
                             'textLength': len(resource['text']) if 'text' in resource else None, 'blobLength': len(resource['blob']) if 'blob' in resource else None,
                             'dataLength': len(block['data']) if 'data' in block else None,
                             'inline': block['text'][:160] if block['type'] == 'text' else None})
            emit({'method': 'session/update', 'params': {'sessionId': SID(), 'update': {'sessionUpdate': 'agent_message_chunk', 'content': {'type': 'text', 'text': 'Fixture attachments: ' + json.dumps(echo) + (' images: ' + json.dumps([i.get('mimeType') for i in images]) if images else '')}}}})
            result(key, {'stopReason': 'end_turn'})
        elif images:
            emit({'method': 'session/update', 'params': {'sessionId': SID(), 'update': {'sessionUpdate': 'agent_message_chunk', 'content': {'type': 'text', 'text': 'Fixture images: ' + json.dumps([image.get('mimeType') for image in images])}}}})
            result(key, {'stopReason': 'end_turn'})
        elif prompt_text == 'url' or prompt_text == 'url-complete':
            waiting['url'] = key
            emit({'id': 'url-test', 'method': 'elicitation/create', 'params': {
                'sessionId': SID(), 'mode': 'url', 'elicitationId': 'fixture-url', 'message': 'Fixture: sign in to the example service.',
                'url': 'https://accounts.example.com/oauth?client=fixture'}})
            if prompt_text == 'url-complete':
                emit({'method': 'elicitation/complete', 'params': {'elicitationId': 'fixture-url'}})
        elif prompt_text == 'leave-open' or prompt_text.startswith('leave-open:'):   # 'leave-open:<file>' ends its turn only when the test creates the file
            emit({'id': 'leave-open', 'method': 'elicitation/create', 'params': {
                'sessionId': SID(), 'mode': 'form', 'message': 'Fixture: left pending when the turn ends.',
                'requestedSchema': {'type': 'object', 'properties': {'x': {'type': 'string'}}}}})
            emit({'id': 'leave-open-perm', 'method': 'session/request_permission', 'params': {'sessionId': SID(), 'toolCall': {'title': 'Left pending', 'toolCallId': 'lp'}, 'options': [{'optionId': 'yes', 'name': 'Allow once', 'kind': 'allow_once'}]}})
            if ':' in prompt_text:
                import threading
                def end_when_released(turn_key=key, path=prompt_text.split(':', 1)[1]):
                    deadline = time.time() + 300
                    while not os.path.exists(path) and time.time() < deadline:
                        time.sleep(0.02)
                    result(turn_key, {'stopReason': 'end_turn'})
                threading.Thread(target=end_when_released, daemon=True).start()
            else:
                result(key, {'stopReason': 'end_turn'})
        elif prompt_text == 'agent-cancel':
            emit({'id': 'cancel-me', 'method': 'session/request_permission', 'params': {'sessionId': SID(), 'toolCall': {'title': 'Will be withdrawn', 'toolCallId': 'cm'}, 'options': [{'optionId': 'yes', 'name': 'Allow once', 'kind': 'allow_once'}]}})
            emit({'method': '$/cancel_request', 'params': {'requestId': 'cancel-me'}})
            result(key, {'stopReason': 'end_turn'})
        elif prompt_text == 'child-ask':
            waiting['child'] = key
            emit({'method': 'session/update', 'params': {'sessionId': 'child-session', 'update': {'sessionUpdate': 'agent_message_chunk', 'content': {'type': 'text', 'text': 'child started'}}}})
            emit({'id': 'child-perm', 'method': 'session/request_permission', 'params': {'sessionId': 'child-session', 'toolCall': {'title': 'Child approval', 'toolCallId': 'child-tool'}, 'options': [{'optionId': 'yes', 'name': 'Allow once', 'kind': 'allow_once'}]}})
        elif prompt_text == 'mcp':
            update({'sessionUpdate': 'agent_message_chunk', 'content': {'type': 'text', 'text': 'MCP: ' + json.dumps(last_mcp, sort_keys=True)}})
            result(key, {'stopReason': 'end_turn'})
        elif prompt_text == '/compact':
            update({'sessionUpdate': 'compaction_update', 'compactionId': 'c1', 'status': 'in_progress'})
            update({'sessionUpdate': 'compaction_summary_chunk', 'compactionId': 'c1', 'content': {'type': 'text', 'text': 'Summary text'}})
            update({'sessionUpdate': 'compaction_update', 'compactionId': 'c1', 'status': 'completed'})
            update({'sessionUpdate': 'usage_update', 'size': 200000, 'used': 900})
            update({'sessionUpdate': 'current_mode_update', 'currentModeId': 'code'})
            result(key, {'stopReason': 'end_turn'})
        elif prompt_text.startswith('stream:'):   # 'stream:<n>:<ms>': n chunks, one every ms; halfway it asks a permission and waits
            count, _, gap = prompt_text[7:].partition(':')
            def stream(turn_key=key, count=int(count), gap=float(gap or 100) / 1000):
                for i in range(count):
                    if i == count // 2:
                        done = threading.Event()
                        stream_answer['event'] = done
                        emit({'id': 'stream-ask', 'method': 'session/request_permission', 'params': {'sessionId': SID(), 'toolCall': {'title': 'Stream approval', 'toolCallId': 'stream-tool'}, 'options': [{'optionId': 'yes', 'name': 'Allow once', 'kind': 'allow_once'}, {'optionId': 'no', 'name': 'Reject', 'kind': 'reject_once'}]}})
                        done.wait(600)
                        update({'sessionUpdate': 'agent_message_chunk', 'content': {'type': 'text', 'text': 'answer=%s ' % stream_answer.get('outcome')}})
                    update({'sessionUpdate': 'agent_message_chunk', 'content': {'type': 'text', 'text': 'chunk%d ' % i}})
                    time.sleep(gap)
                result(turn_key, {'stopReason': 'end_turn'})
            threading.Thread(target=stream, daemon=True).start()
        elif prompt_text == 'wait':
            waiting['turn'] = key
        elif prompt_text.startswith('sleep:'):  # a turn that ends by itself after N seconds (cancel still ends it early)
            import threading
            waiting['turn'] = key
            def finish(turn_key=key):
                time.sleep(float(prompt_text[6:]))
                if waiting.get('turn') == turn_key:
                    waiting.pop('turn')
                    result(turn_key, {'stopReason': 'end_turn'})
            threading.Thread(target=finish, daemon=True).start()
        elif prompt_text.startswith('gate:'):   # a turn that ends when the test creates the named file (no timer to outrun on a loaded machine)
            import threading
            waiting['turn'] = key
            def open_gate(turn_key=key, path=prompt_text[5:]):
                deadline = time.time() + 300
                while not os.path.exists(path) and time.time() < deadline:
                    time.sleep(0.02)
                if waiting.get('turn') == turn_key:
                    waiting.pop('turn')
                    result(turn_key, {'stopReason': 'end_turn'})
            threading.Thread(target=open_gate, daemon=True).start()
        elif prompt_text == 'form':
            waiting['form'] = key
            emit({'id': 'form-test', 'method': 'elicitation/create', 'params': {
                'sessionId': SID(), 'mode': 'form', 'message': 'Fixture form: provide a name and plan.',
                'requestedSchema': {'type': 'object', 'properties': {
                    'name': {'type': 'string', 'title': 'Name'},
                    'plan': {'type': 'string', 'oneOf': [
                        {'const': 'basic', 'title': 'Basic', 'description': 'Basic fixture plan'},
                        {'const': 'pro', 'title': 'Pro', 'description': 'Pro fixture plan'}]},
                }, 'required': ['name', 'plan']}}})
        else:
            waiting['permission'] = key
            emit({'id': 'approve-test', 'method': 'session/request_permission', 'params': {'sessionId': SID(), 'toolCall': {'title': 'Fixture approval', 'toolCallId': 'fake-tool'}, 'options': [{'optionId': 'yes', 'name': 'Allow once', 'kind': 'allow_once'}, {'optionId': 'no', 'name': 'Reject', 'kind': 'reject_once'}]}})
    elif key == 'stream-ask':
        outcome = message.get('result', {}).get('outcome', {})
        stream_answer['outcome'] = outcome.get('optionId') or outcome.get('outcome')
        if 'event' in stream_answer:
            stream_answer.pop('event').set()
    elif key == 'url-test':
        emit({'method': 'session/update', 'params': {'sessionId': SID(), 'update': {'sessionUpdate': 'agent_message_chunk', 'content': {'type': 'text', 'text': 'Fixture url response: ' + json.dumps(message.get('result', {}), sort_keys=True)}}}})
        result(waiting.pop('url'), {'stopReason': 'end_turn'})
    elif key == 'child-perm':
        result(waiting.pop('child'), {'stopReason': 'end_turn'})
    elif isinstance(key, str) and key.startswith('cap-') and caps_run is not None:
        caps_run['results'].append({'result': message.get('result'), 'error': message.get('error')})
        if isinstance(message.get('result'), dict) and 'terminalId' in message['result']:
            caps_run['terminal'] = message['result']['terminalId']
        caps_next()
    elif key == 'form-test':
        emit({'method': 'session/update', 'params': {'sessionId': SID(), 'update': {'sessionUpdate': 'agent_message_chunk', 'content': {'type': 'text', 'text': 'Fixture form response: ' + json.dumps(message.get('result', {}), sort_keys=True)}}}})
        result(waiting.pop('form'), {'stopReason': 'end_turn'})
    elif key == 'setup-question':
        setup_answer = True
        if pending_setup:
            setup_key, setup_method, setup_params = pending_setup
            pending_setup = None
            if args.setup_fail:
                emit({'id': setup_key, 'error': {'code': -32000, 'message': 'Fixture setup failure'}})
            else:
                result(setup_key, {'sessionId': setup_params.get('sessionId', 'fake-session'), 'modes': {'currentModeId': 'code', 'availableModes': [{'id': 'code', 'name': 'Code'}]}})
    elif key == 'approve-test' and args.cancel_aware:
        outcome = message.get('result', {}).get('outcome', {}).get('outcome')
        emit({'method': 'session/update', 'params': {'sessionId': SID(), 'update': {'sessionUpdate': 'agent_message_chunk', 'content': {'type': 'text', 'text': 'Fixture permission outcome: ' + str(outcome)}}}})
        result(waiting.pop('permission'), {'stopReason': 'cancelled' if outcome == 'cancelled' else 'end_turn'})
    elif key == 'approve-test':
        emit({'method': 'session/update', 'params': {'sessionId': SID(), 'update': {'sessionUpdate': 'agent_message_chunk', 'content': {'type': 'text', 'text': 'Fixture response'}}}})
        result(waiting.pop('permission'), {'stopReason': 'end_turn'})
    elif method == 'session/cancel' and args.cancel_aware:
        # Spec: the pending prompt MUST end with `cancelled`. A pending permission is ended when its cancelled answer arrives.
        if 'turn' in waiting:
            result(waiting.pop('turn'), {'stopReason': 'cancelled'})
    elif method == 'session/cancel' and params.get('sessionId', '').startswith('child-'):
        emit({'method': 'session/update', 'params': {'sessionId': SID(), 'update': {'sessionUpdate': 'subagent_update', 'sessionId': params['sessionId'], 'state': {'state': 'idle'}}}})
    elif method == 'session/cancel':
        if 'turn' in waiting:
            result(waiting.pop('turn'), {'stopReason': 'cancelled'})
    elif method in ('session/set_mode', 'session/set_config_option') and args.reject_config:
        emit({'id': key, 'error': {'code': -32602, 'message': 'Fixture refuses this setting'}})
    elif method == 'session/set_mode':
        if args.models:
            if params.get('modeId') not in [m['id'] for m in modes['availableModes']]:
                emit({'id': key, 'error': {'code': -32602, 'message': 'Unknown mode'}})
                continue
            modes['currentModeId'] = params.get('modeId')
        result(key, {})
    elif method == 'session/set_config_option' and args.require_config_type and params.get('type') not in ('id', 'boolean'):
        emit({'id': key, 'error': {'code': -32602, 'message': 'Invalid params: missing field `type`'}})
    elif method == 'session/set_config_option':
        if args.breadth:
            for option in config_options:
                if option['id'] == params.get('configId'):
                    option['currentValue'] = params.get('value')
            result(key, {'configOptions': config_options})
        else:
            result(key, {'configOptions': []})
