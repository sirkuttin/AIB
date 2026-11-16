"""Subagent worktrees, P1 (enforcement, Claude Code): e2e with the REAL Claude Code adapter against the stub model API
(work/stub_model_api.js script mode), temp config only. Design: private/designs/subagent-worktrees/design.md v2 + p0b-results.md.

  AibSubagentHooksTest   a real AIB (deno-split web server + agent host) starts a Claude chat in a temp git project whose folder has
                         an uncommitted edit. The model (scripted) starts an editing subagent, an Explore subagent, then tries
                         EnterWorktree and Workflow.
                           B2   the editing subagent ran in AIB's worktree (studio/sub-*, under AIB's state folder, git-locked),
                                which has the folder's uncommitted edit; the folder is unchanged (no sub-a.txt, its edit still
                                uncommitted); the record (subagent-worktrees.json) has its agentId and state running
                           B3   Explore got no worktree
                           B16  EnterWorktree and Workflow were denied with AIB's texts
                           B14  forged hook calls with the chat's key: worktree-create refused, nothing bound, the cap holds, a
                                wrong key is refused, a UNC adoption hint is never touched; no key in anything the model was sent
                           B15  the hook routes are not on the web (page / phone) server
                           the system prompt line is there; the owner's ~/.claude, settings and real %TEMP%\\claude untouched
  AdapterFailClosedTest  one layer down: the adapter alone (work/acp_probe.js) with AIB's hook settings shape and the real keeper
                         program as forwarder, AIB unreachable.
                           B13  dead address: the editing Agent call is refused with "AIB is restarting"; nothing written; Explore runs
                           B13b AIB accepts the connection but never answers: refused within the forwarder's deadline, never unisolated
                           B13c another program on the port answers 200 {} or HTML, unsigned: refused (security review P1, MF 1)
                           MF 7 no Git Bash: P2's hooks-off deny rules instead of hooks; the editing subagent never runs, Explore does
  B12 (settings byte-identical on reopen) and the route rules are pinned by work/deno/subagent_hooks_test.ts.

Needs node, the Claude Code ACP adapter (AIB_CLAUDE_ACP or a global npm install) and Go (to build the keeper program from keeper/,
into this test's temp folder; AIB_TEST_KEEPER_BIN names a built one instead). Run with TEMP/TMP pointed at a scratch folder.
"""
import _isolation  # noqa: F401  (test isolation: temp state folder, real per-user folder blocked)
import hashlib
import hmac
import json
import os
import pathlib
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
import uuid

sys.path.insert(0, str(_isolation.TESTS / 'contract'))
import server_under_test  # noqa: E402
from _e2e_support import make_repo, run_git  # noqa: E402
from test_worktree_e2e import Chat, wait_for  # noqa: E402
from test_folder_chat_listing_e2e import CLAUDE_ACP, NODE, RealClaudeFixture, Stub, stub_claude_env  # noqa: E402

NO_WINDOW = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
STUB = _isolation.TESTS / 'stub_model_api.js'
PROBE = _isolation.TESTS / 'acp_probe.js'
SERVER_KIND = server_under_test.server_kind()
GO = shutil.which('go') or ('C:/Program Files/Go/bin/go.exe' if os.path.isfile('C:/Program Files/Go/bin/go.exe') else None)
KEEPER_SRC = _isolation.REPO / 'keeper'

RESTARTING = 'AIB is restarting; try the subagent again in a moment.'
UNCONFIRMED = "AIB could not confirm this hook's answer, so the subagent was blocked; try again in a moment."
ENTER_TEXT = 'In AIB, chats work in the project folder. Use a subagent instead; AIB gives it its own worktree.'
WORKFLOW_TEXT = "Workflows aren't available in AIB chats yet, because their agents can't get their own worktree."
PROMPT_LINE = 'Subagents that edit files work in their own git worktree.'
WF_SCRIPT = ("export const meta = { name: 'sr', description: 'sr probe', phases: [{ title: 'one' }] }\n"
             "phase('one')\nconst r = await agent('WF-AGENT do the work', { label: 'wf1' })\nreturn r\n")
REAL_TEMP = pathlib.Path(os.environ.get('AIB_REAL_TEMP') or (pathlib.Path(os.environ.get('LOCALAPPDATA', '')) / 'Temp'))

_KEEPER = {}


def keeper_program(temp):
    """The keeper program (it has the `hook` mode): AIB_TEST_KEEPER_BIN, else built from keeper/ into a temp folder of this run."""
    named = os.environ.get('AIB_TEST_KEEPER_BIN')
    if named:
        return pathlib.Path(named)
    if 'exe' not in _KEEPER:
        out = pathlib.Path(tempfile.mkdtemp(prefix='aib-sr-keeper-'))
        exe = out / ('AIB-keeper.exe' if os.name == 'nt' else 'AIB-keeper')
        env = dict(os.environ, CGO_ENABLED='0', GOCACHE=str(out / 'gocache'), GOTMPDIR='')
        flags = '-s -w -H windowsgui' if os.name == 'nt' else '-s -w'
        done = subprocess.run([GO, 'build', '-trimpath', '-ldflags', flags, '-o', str(exe), '.'], cwd=KEEPER_SRC, env=env,
                              capture_output=True, text=True, timeout=600, creationflags=NO_WINDOW)
        if done.returncode != 0:
            raise AssertionError(f'keeper build failed: {done.stderr[-2000:]}')
        _KEEPER['exe'] = exe
    return _KEEPER['exe']


def owner_state():
    """What a run must not change: ~/.claude/projects names, the owner's Claude settings files' mtimes, the real %TEMP%\\claude."""
    home = pathlib.Path(os.path.expanduser('~'))
    projects = home / '.claude' / 'projects'
    mtimes = {}
    for f in (home / '.claude' / 'settings.json', home / '.claude.json', home / '.claude' / 'settings.local.json'):
        mtimes[str(f)] = f.stat().st_mtime if f.exists() else None
    temp_claude = REAL_TEMP / 'claude'
    return {
        'projects': sorted(p.name for p in projects.iterdir()) if projects.is_dir() else [],
        'mtimes': mtimes,
        'temp_claude': sorted(p.name for p in temp_claude.iterdir()) if temp_claude.is_dir() else [],
    }


class OwnerUntouched:
    def __init__(self, owner, *marks):
        self.before = owner_state()
        self.marks = marks
        owner.addCleanup(self.check, owner)

    def check(self, owner):
        after = owner_state()
        owner.assertEqual(after['mtimes'], self.before['mtimes'], "the owner's Claude settings files changed")
        new_projects = set(after['projects']) - set(self.before['projects'])
        for mark in self.marks:
            owner.assertFalse([p for p in new_projects if mark in p], "a test chat was filed in the owner's ~/.claude/projects")
            owner.assertFalse([p for p in set(after['temp_claude']) - set(self.before['temp_claude']) if mark in p],
                              "a test chat wrote into the owner's real %TEMP%\\claude")


def hook_key(state, conversation):
    """The chat's hook key as AIB derives it (artifacts/keys.ts issueHookKey): HMAC-SHA256(secret, label NUL + id)."""
    secret = (pathlib.Path(state) / 'artifact-key-secret').read_bytes()
    return hmac.new(secret, b'studio-hook-key/v1\0' + conversation.encode(), hashlib.sha256).hexdigest()


def hook_post(state, event, conversation, key, body, timeout=30):
    """POST one hook call to AIB's loopback listener (the address in artifact-mcp.json), as the keeper's forwarder does."""
    url = json.loads((pathlib.Path(state) / 'artifact-mcp.json').read_text(encoding='utf-8'))['url'].rsplit('/', 1)[0]
    req = urllib.request.Request(f'{url}/hooks/claude/{event}', data=json.dumps(body).encode(), method='POST',
                                 headers={'Content-Type': 'application/json', 'X-Studio-Hook-Key': key, 'X-Studio-Conversation-Id': conversation})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode()
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode()


def approve_all(chat):
    """Answer the chat's permission cards with their allow-once option (the subagent's Bash in its worktree asks, like the folder's)."""
    for item in chat.state()['permissions']:
        options = (item.get('params') or {}).get('options') or []
        allow = next((o['optionId'] for o in options if o.get('kind') == 'allow_once'), None)
        if allow:
            chat.get_web().post('permission', {'id': chat.id, 'key': item['key'], 'option': allow})


def stub_text(stub):
    return stub.log.read_text(encoding='utf-8') if stub.log.is_file() else ''


def scripted_stub(owner, folder, rules):
    """The stub in script mode, with --dump so the test can read what the model was sent."""
    script = pathlib.Path(folder) / 'script.json'
    script.write_text(json.dumps({'rules': rules}), encoding='utf-8')
    dump = pathlib.Path(folder) / 'dump'
    dump.mkdir(exist_ok=True)
    stub = Stub.__new__(Stub)
    stub.log = pathlib.Path(folder) / 'stub.log'
    stub.process = subprocess.Popen([NODE, str(STUB), '--port', '0', '--log', str(stub.log), '--stdin', '--script', str(script), '--dump', str(dump)],
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, encoding='utf-8',
                                    creationflags=NO_WINDOW)
    owner.addCleanup(stub.stop)
    line = stub.process.stdout.readline()
    if not line.startswith('STUB_PORT='):
        raise AssertionError(f'stub did not start: {line!r}')
    stub.port = int(line.strip().split('=')[1])
    stub.url = f'http://127.0.0.1:{stub.port}'
    stub.dump = dump
    return stub


def dumped(stub):
    return '\n'.join(p.read_text(encoding='utf-8') for p in sorted(stub.dump.glob('*.json')))


def parent_rules(main):
    return [
        {'when': 'SR-PARENT', 'reply': {'tools': [{'id': 'toolu_pAgent01', 'name': 'Agent', 'input': {
            'description': 'sr edit', 'prompt': 'SUBTASK-A: do the work', 'subagent_type': 'general-purpose', 'run_in_background': False}}]}},
        {'when': 'SUBTASK-A', 'reply': {'tools': [{'id': 'toolu_sBash01', 'name': 'Bash', 'input': {
            # P2: .husky makes the landing refuse (protected path), so the worktree and record stay for these P1 checks
            'command': 'echo from-sub > sub-a.txt && mkdir -p .husky && echo x > .husky/pre-commit && pwd && cat dirty.txt',
            'description': 'write in cwd'}}]}},
        {'when': 'toolu_sBash01', 'reply': {'tools': [{'id': 'toolu_sWrite02', 'name': 'Write', 'input': {
            'file_path': str(pathlib.Path(main) / 'escape-write.txt'), 'content': 'escaped\n'}}]}},
        {'when': 'toolu_sWrite02', 'reply': {'text': 'SUB-DONE'}},
        {'when': 'toolu_pAgent01', 'reply': {'tools': [{'id': 'toolu_pAgent02', 'name': 'Agent', 'input': {
            'description': 'sr look', 'prompt': 'SUBTASK-E: look around', 'subagent_type': 'Explore', 'run_in_background': False}}]}},
        {'when': 'SUBTASK-E', 'reply': {'text': 'EXPLORE-DONE'}},
        {'when': 'toolu_pAgent02', 'reply': {'tools': [{'id': 'toolu_pTS03', 'name': 'ToolSearch', 'input': {'query': 'select:EnterWorktree', 'max_results': 5}}]}},
        {'when': 'toolu_pTS03', 'reply': {'tools': [{'id': 'toolu_pEW04', 'name': 'EnterWorktree', 'input': {}}]}},
        {'when': 'toolu_pEW04', 'reply': {'tools': [{'id': 'toolu_pWF05', 'name': 'Workflow', 'input': {'script': WF_SCRIPT}}]}},
        {'when': 'toolu_pWF05', 'reply': {'text': 'PARENT-DONE'}},
    ]


def norm(p):
    return os.path.normcase(os.path.realpath(str(p)))


@unittest.skipUnless(NODE and CLAUDE_ACP, 'needs node and the Claude Code ACP adapter (AIB_CLAUDE_ACP or a global npm install)')
@unittest.skipUnless(GO or os.environ.get('AIB_TEST_KEEPER_BIN'), 'needs Go to build the keeper program (or AIB_TEST_KEEPER_BIN)')
@unittest.skipUnless(SERVER_KIND == 'deno-split', 'runs against AIB_SERVER=deno-split (the default)')
class AibSubagentHooksTest(unittest.TestCase):

    def test_editing_subagent_gets_its_own_worktree(self):
        temp = pathlib.Path(tempfile.mkdtemp(prefix='aib-sr-'))
        self.addCleanup(shutil.rmtree, temp, True)
        mark = f'srp1{uuid.uuid4().hex[:6]}'
        project = make_repo(temp / mark)
        run_git(project, 'config', 'core.autocrlf', 'false')
        (project / 'dirty.txt').write_text('main-edit\n', encoding='utf-8')  # the main agent's uncommitted edit
        OwnerUntouched(self, mark)
        stub = scripted_stub(self, temp, parent_rules(project))
        keeper = keeper_program(temp)

        class Fixture(RealClaudeFixture):
            def env(self):
                env = super().env()
                env['AIB_KEEPER_BIN'] = str(keeper)
                for name in ('TEMP', 'TMP', 'TMPDIR'):  # the server's own temp folder (the agent gets <test home>/tmp)
                    env[name] = str(temp / 'tmp')
                return env

        (temp / 'tmp').mkdir()
        RealClaudeFixture.stub = stub
        fx = Fixture(self)
        web = fx.start_web()
        status, connection = web.post('connect', {'provider': 'claude', 'cwd': str(project), 'background': True})
        self.assertEqual(status, 200, connection)
        chat = Chat(None, connection['id'], web)
        wait_for(lambda: chat.state().get('ready') or (chat.state().get('error') and self.fail(chat.state()['error'])), 'chat ready')
        self.assertEqual(chat.state().get('subagentIsolation'), {'on': True, 'reason': ''})

        code, _ = web.post('prompt', {'id': chat.id, 'text': 'SR-PARENT go', 'clientMessageId': uuid.uuid4().hex})
        self.assertEqual(code, 200)

        def ended():
            approve_all(chat)
            state = chat.state()
            return not state['busy'] and any(e['kind'] == 'turn_end' for e in state['events'])
        wait_for(ended, 'the parent turn to end', seconds=240)
        sent = dumped(stub)
        self.assertIn('PARENT-DONE', stub_text(stub) + sent + json.dumps(chat.state()['events'])[-20000:])

        # B2: the record, its worktree (S had the uncommitted edit), the folder untouched
        records = json.loads((fx.state / 'subagent-worktrees.json').read_text(encoding='utf-8'))['subagents']
        bound = [r for r in records.values() if r['state'] in ('running', 'done')]  # done: its SubagentStop came (P2)
        self.assertEqual(len(bound), 1, records)
        rec = bound[0]
        self.assertTrue(rec['agentId'])
        self.assertEqual(rec['toolUseId'], 'toolu_pAgent01')
        self.assertTrue(rec['branch'].startswith('studio/sub-'), rec)
        self.assertTrue(norm(rec['path']).startswith(norm(fx.state / 'worktrees')), rec)
        wt = pathlib.Path(rec['path'])
        self.assertEqual((wt / 'sub-a.txt').read_text(encoding='utf-8').strip(), 'from-sub')
        self.assertEqual((wt / 'dirty.txt').read_text(encoding='utf-8').strip(), 'main-edit', 'S carries the uncommitted edit')
        self.assertFalse((project / 'sub-a.txt').exists(), 'the subagent wrote into the project folder')
        self.assertFalse((project / 'escape-write.txt').exists(), "Claude Code's own fence held")
        self.assertIn('?? dirty.txt', run_git(project, 'status', '--porcelain'), 'the main edit stays uncommitted')
        listing = run_git(project, 'worktree', 'list', '--porcelain')
        block = [b for b in listing.split('\n\n') if norm(rec['path']) in norm(b.split('\n')[0].replace('worktree ', ''))]
        self.assertTrue(block and 'locked' in block[0], listing)
        # B3: Explore got none (only the editing call has a record besides spares)
        self.assertFalse([r for r in records.values() if r.get('agentType') == 'Explore'], records)
        self.assertIn('EXPLORE-DONE', sent)
        # B16: the refusals reached the model
        self.assertIn(ENTER_TEXT, sent)
        self.assertIn(WORKFLOW_TEXT, sent)
        # 2.5: the prompt line
        self.assertIn(PROMPT_LINE, sent)

        # B14: forged calls with the chat's key
        key = hook_key(fx.state, chat.id)
        self.assertNotIn(key, sent, 'the hook key reached the model')
        self.assertEqual(hook_post(fx.state, 'worktree-create', chat.id, 'f' * 64, {'name': 'agent-x'})[0], 401)
        status, text = hook_post(fx.state, 'worktree-create', chat.id, key, {'name': 'agent-forged1'})
        self.assertEqual((status, text), (409, "AIB didn't expect this worktree"))
        status, text = hook_post(fx.state, 'worktree-create', chat.id, key, {'name': 'feature-x'})
        self.assertEqual(status, 409)
        status, text = hook_post(fx.state, 'pre-tool', chat.id, key, {'tool_name': 'EnterWorktree', 'tool_input': {}})
        self.assertEqual(json.loads(text)['hookSpecificOutput']['permissionDecision'], 'deny')
        # a forged stop and a UNC adoption hint change nothing that matters
        hook_post(fx.state, 'subagent-stop', chat.id, key, {'agent_id': rec['agentId'], 'agent_type': ''})  # an internal fork's: ignored (P2: a typed stop makes it done)
        hook_post(fx.state, 'post-agent', chat.id, key, {'tool_use_id': 'toolu_x', 'tool_response': {'agentId': 'zzz', 'worktreePath': r'\\203.0.113.9\share'}})
        after = json.loads((fx.state / 'subagent-worktrees.json').read_text(encoding='utf-8'))['subagents']
        self.assertEqual(after[rec['id']]['state'], rec['state'])
        self.assertEqual(after[rec['id']]['path'], rec['path'])
        # the cap: forged editing Agent calls are prepared until the chat holds 8, then refused
        answers = [hook_post(fx.state, 'pre-tool', chat.id, key, {'tool_name': 'Agent', 'tool_use_id': f'toolu_f{i}',
                                                                   'tool_input': {'subagent_type': 'general-purpose', 'prompt': 'x'}})[1]
                   for i in range(9)]
        denied = [a for a in answers if 'permissionDecision' in a]
        self.assertTrue(denied and 'already has 8 subagents' in denied[-1], answers[-3:])
        self.assertFalse([a for a in answers if '"allow"' in a], 'a hook route answered allow')
        held = [r for r in json.loads((fx.state / 'subagent-worktrees.json').read_text(encoding='utf-8'))['subagents'].values()
                if r['chat'] == chat.id and r['state'] in ('preparing', 'prepared', 'running', 'done', 'stopped')]
        self.assertEqual(len(held), 8)

        # B15: not on the web server (the page and the phone use it)
        try:
            req = urllib.request.Request(f'http://127.0.0.1:{web.port}/hooks/claude/pre-tool', data=b'{}', method='POST',
                                         headers={'Content-Type': 'application/json', 'X-Studio-Hook-Key': key, 'X-Studio-Conversation-Id': chat.id})
            code = urllib.request.urlopen(req, timeout=10).status
        except urllib.error.HTTPError as error:
            code = error.code
        self.assertIn(code, (401, 403, 404))

        # turn end removed nothing bound; the forged prepared ones become a spare or go at the next turn end (not landing: P2)
        self.assertTrue(wt.is_dir())


def aib_hook_settings(keeper, address):
    """subagents/claude_config.ts hookSettings, the same shape (forward slashes, double quotes, `|| exit 2`, timeout 30)."""
    p, a = str(keeper).replace('\\', '/'), str(address).replace('\\', '/')
    hook = lambda ev, blocking: {'type': 'command', 'command': f'"{p}" hook {ev} "{a}"' + (' || exit 2' if blocking else ''), 'timeout': 30}
    return {'hooks': {
        'PreToolUse': [{'matcher': 'Agent|Task|EnterWorktree|Workflow', 'hooks': [hook('pre-tool', True)]}],
        'PostToolUse': [{'matcher': 'Agent|Task', 'hooks': [hook('post-agent', False)]}],
        'SubagentStop': [{'hooks': [hook('subagent-stop', False)]}],
        'WorktreeCreate': [{'hooks': [hook('worktree-create', True)]}],
    }}


@unittest.skipUnless(NODE and CLAUDE_ACP, 'needs node and the Claude Code ACP adapter')
@unittest.skipUnless(GO or os.environ.get('AIB_TEST_KEEPER_BIN'), 'needs Go to build the keeper program (or AIB_TEST_KEEPER_BIN)')
class AdapterFailClosedTest(unittest.TestCase):

    def run_probe(self, address_doc, hang=False, refused=None, settings=None):
        temp = pathlib.Path(tempfile.mkdtemp(prefix='aib-sr-a-'))
        self.addCleanup(shutil.rmtree, temp, True)
        mark = f'srp1{uuid.uuid4().hex[:6]}'
        project = make_repo(temp / mark)
        OwnerUntouched(self, mark)
        rules = [
            {'when': 'SR-PARENT', 'reply': {'tools': [{'id': 'toolu_pAgent01', 'name': 'Agent', 'input': {
                'description': 'sr edit', 'prompt': 'SUBTASK-A: do the work', 'subagent_type': 'general-purpose', 'run_in_background': False}}]}},
            {'when': 'SUBTASK-A', 'reply': {'tools': [{'id': 'toolu_sBash01', 'name': 'Bash', 'input': {
                'command': 'echo from-sub > sub-a.txt', 'description': 'write'}}]}},
            {'when': 'toolu_sBash01', 'reply': {'text': 'SUB-DONE'}},
            {'when': 'toolu_pAgent01', 'reply': {'tools': [{'id': 'toolu_pAgent02', 'name': 'Agent', 'input': {
                'description': 'sr look', 'prompt': 'SUBTASK-E: look', 'subagent_type': 'Explore', 'run_in_background': False}}]}},
            {'when': 'SUBTASK-E', 'reply': {'text': 'EXPLORE-DONE'}},
            {'when': 'toolu_pAgent02', 'reply': {'text': 'PARENT-DONE'}},
        ]
        stub = scripted_stub(self, temp, rules)
        address = temp / 'artifact-mcp.json'
        address.write_text(json.dumps(address_doc), encoding='utf-8')
        home = temp / 'home'
        for sub in ('claude', 'home/AppData/Roaming', 'home/AppData/Local', 'tmp'):
            (temp / sub).mkdir(parents=True, exist_ok=True)
        env = dict(os.environ)
        for name in ('CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT'):
            env.pop(name, None)
        for name in ('HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'):
            env[name] = str(home)
        env.update(APPDATA=str(home / 'AppData' / 'Roaming'), LOCALAPPDATA=str(home / 'AppData' / 'Local'), CLAUDE_CONFIG_DIR=str(temp / 'claude'),
                   TEMP=str(temp / 'tmp'), TMP=str(temp / 'tmp'), TMPDIR=str(temp / 'tmp'),
                   AIB_HOOK_KEY='k' * 64, AIB_HOOK_CHAT='c' * 32, AIB_HOOK_READONLY='Explore,Plan,claude-code-guide,statusline-setup')
        env = stub_claude_env(env, stub)
        meta = temp / 'meta.json'
        settings = settings or aib_hook_settings(keeper_program(temp), address)
        meta.write_text(json.dumps({'claudeCode': {'options': {'settings': settings}}}), encoding='utf-8')
        started = time.time()
        out = subprocess.run([NODE, str(PROBE), '--allow', '--meta', str(meta), str(CLAUDE_ACP), 'new', str(project), 'SR-PARENT go'],
                             capture_output=True, text=True, timeout=300, env=env, creationflags=NO_WINDOW, stdin=subprocess.DEVNULL)
        took = time.time() - started
        self.assertIn('PARENT-DONE', out.stdout + stub_text(stub), out.stderr[-1500:])
        sent = dumped(stub)
        if refused is not False:
            self.assertIn(refused or RESTARTING, sent, 'the editing Agent call was not refused')
        self.assertNotIn('SUB-DONE', stub_text(stub) + sent, 'the editing subagent ran')
        self.assertFalse((project / 'sub-a.txt').exists(), 'the subagent ran unisolated in the folder')
        self.assertEqual(run_git(project, 'status', '--porcelain'), '', 'the folder changed')
        self.assertIn('EXPLORE-DONE', sent, 'Explore must run while AIB is down')
        self.assertFalse((project / '.claude' / 'worktrees').exists())
        return took

    def test_aib_unreachable_refuses_editing_subagent(self):
        sock = socket.socket()
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
        sock.close()
        self.run_probe({'url': f'http://127.0.0.1:{port}/mcp', 'pid': 1})

    def test_aib_hanging_refuses_within_deadline(self):
        sock = socket.socket()
        sock.bind(('127.0.0.1', 0))
        sock.listen(16)
        held = []
        stop = threading.Event()

        def accept():  # accepts and never answers (an AIB stuck mid-request)
            sock.settimeout(0.5)
            while not stop.is_set():
                try:
                    held.append(sock.accept()[0])
                except OSError:
                    pass
        thread = threading.Thread(target=accept, daemon=True)
        thread.start()
        self.addCleanup(lambda: (stop.set(), [c.close() for c in held], sock.close()))
        took = self.run_probe({'url': f'http://127.0.0.1:{sock.getsockname()[1]}/mcp', 'pid': os.getpid()})
        self.assertTrue(held, 'the forwarder never connected')
        self.assertLess(took, 200)

    def squatter(self, body, content_type):
        """A listener that is not AIB (a dev server on AIB's old port) answering 200 to everything; its address file names a live pid."""
        import http.server

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers.get('Content-Length') or 0))
                self.send_response(200)
                self.send_header('Content-Type', content_type)
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return {'url': f'http://127.0.0.1:{server.server_address[1]}/mcp', 'pid': os.getpid()}

    def test_squatter_200_empty_json_never_runs_the_subagent(self):
        """Security review P1 MF 1 / should-fix 12: an unsigned 200 {} blocks the editing subagent (it never runs in the folder)."""
        self.run_probe(self.squatter(b'{}', 'application/json'), refused=UNCONFIRMED)

    def test_no_git_bash_deny_rules_turn_subagents_off(self):
        """MF 7: a chat without Git Bash gets no hooks but P2's hooks-off deny rules (claude_config.ts subagentsOffSettings, the shape
        it gives a chat with no custom agents): with every permission prompt allowed, the editing subagent is refused and never runs in
        the folder; Explore still runs."""
        editing = ['claude', 'fork', 'general-purpose']
        off = {'permissions': {'deny': [r for n in editing for r in (f'Agent({n})', f'Task({n})')] + ['Workflow', 'EnterWorktree']}}
        self.run_probe({'closed': True, 'pid': os.getpid()}, refused=False, settings=off)

    def test_squatter_200_html_never_runs_the_subagent(self):
        self.run_probe(self.squatter(b'<!doctype html><title>dev</title>', 'text/html'), refused=UNCONFIRMED)


if __name__ == '__main__':
    unittest.main()
