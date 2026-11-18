"""Open elsewhere (aib-shared/designs/open-elsewhere/research.md; server/ownership/handoff.ts): AIB lets go of a Claude Code chat that another
app opened, and takes it back when the person returns.

A real AIB (deno-split web server + agent host) runs a real Claude Code chat through the real ACP adapter against the local stub model
API (work/stub_model_api.js): no key, no network, a throwaway HOME / CLAUDE_CONFIG_DIR (acp/connection.ts testHomeEnv, placed in this
test's temp folder through TMP). "Another app" is the real `claude` CLI started by the test with that same temp config:
`claude --resume <session> -p --input-format stream-json` stays running (holding the session, as an open VS Code tab or terminal does)
until the test closes its stdin, and each line the test writes is a turn typed there.

  test_idle_chat_lets_go_and_comes_back_with_the_outside_turn
      AIB chat idle; the second process appears -> AIB closes its session (its own Claude process and registry record go), the chat
      line says so; AIB's own process never counted as "elsewhere" before. A turn typed in the other process; the other process quits;
      sending in AIB loads the chat again, shows the outside turn and its reply continues from it.
  test_running_turn_lets_go_only_after_the_turn
      A turn is running (the stub holds the reply); the second process appears -> nothing is cut: the turn ends with its reply, then
      AIB lets go.
  test_still_held_needs_open_here_anyway
      Released, the other process still runs: sending is refused (409 held_elsewhere, nothing sent, one line with Open here anyway);
      Open here anyway takes it back.

Skipped without node, the Claude Code ACP adapter, or the `claude` CLI (AIB_CLAUDE_CLI, else PATH). Targeted: run this file alone.
"""
import _isolation  # noqa: F401  (test isolation: temp state folder, real per-user folder blocked)
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import uuid

sys.path.insert(0, str(_isolation.TESTS / 'contract'))
from _e2e_support import make_repo, run_git  # noqa: E402
from test_folder_chat_listing_e2e import CLAUDE_ACP, NODE, SERVER_KIND, OwnerGuard, RealClaudeFixture, Stub, stub_claude_env  # noqa: E402
from test_worktree_e2e import Chat, wait_for  # noqa: E402
from test_subagent_worktree_e2e import GO, keeper_program  # noqa: E402

NO_WINDOW = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
CLAUDE_CLI = os.environ.get('AIB_CLAUDE_CLI') or shutil.which('claude')
RELEASED_LINE = 'Continued in a terminal. AIB let go of this chat. Open it here to take it back.'


def agent_home(session, *roots):
    """The agent's throwaway home (acp/connection.ts testHomeEnv: HOME and CLAUDE_CONFIG_DIR): the temp folder whose Claude Code
    session registry names this chat's session (session ids are unique, so no other run's folder matches)."""
    for root in (*roots, pathlib.Path(tempfile.gettempdir())):
        for home in pathlib.Path(root).glob('agent-studio-test-home-*'):
            if records(home, session):
                return home
    return None


class OtherApp:
    """`claude --resume <id> -p --input-format stream-json` in the agent's temp home: holds the session until stdin closes."""

    def __init__(self, owner, home, project, stub, session):
        env = {k: v for k, v in os.environ.items() if not k.upper().startswith(('CLAUDE', 'ANTHROPIC', 'AIB_', 'AGENT_STUDIO'))}
        for name in ('HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'APPDATA', 'LOCALAPPDATA'):
            env[name] = str(home)
        for name in ('TMP', 'TEMP', 'TMPDIR'):
            env[name] = str(home / 'tmp')
        env['CLAUDE_CONFIG_DIR'] = str(home)
        env = stub_claude_env(env, stub)
        self.process = subprocess.Popen(
            [CLAUDE_CLI, '--resume', session, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'],
            cwd=str(project), env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=NO_WINDOW)
        owner.addCleanup(self.stop)
        self.lines = []
        self.results = []
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()
        self.err = []
        threading.Thread(target=lambda: self.err.extend(self.process.stderr), daemon=True).start()

    def _read(self):
        for raw in self.process.stdout:
            line = raw.decode('utf-8', 'replace').strip()
            self.lines.append(line)
            try:
                item = json.loads(line)
            except ValueError:
                continue
            if item.get('type') == 'result':
                self.results.append(item)

    @property
    def pid(self):
        return self.process.pid

    def say(self, text):
        """One turn typed in the other app; returns its result text."""
        before = len(self.results)
        self.process.stdin.write((json.dumps({'type': 'user', 'message': {'role': 'user', 'content': text}}) + '\n').encode('utf-8'))
        self.process.stdin.flush()
        wait_for(lambda: len(self.results) > before or self.process.poll() is not None, 'the other app to answer', 120)
        if len(self.results) <= before:
            raise AssertionError(f'the other app ended: {self.lines[-5:]} {b"".join(self.err)[-2000:]!r}')
        return str(self.results[-1].get('result', ''))

    def stop(self):
        if self.process.poll() is None:
            try:
                self.process.stdin.close()
            except OSError:
                pass
            try:
                self.process.wait(20)
            except subprocess.TimeoutExpired:
                self.process.kill()  # only the process this test started
                self.process.wait(10)
        self.reader.join(5)
        for stream in (self.process.stdout, self.process.stderr):
            try:
                stream.close()
            except OSError:
                pass


def records(home, session):
    """{pid: record} of Claude Code's registry files that name the session."""
    out = {}
    folder = home / 'sessions'
    for path in folder.glob('*.json') if folder.is_dir() else []:
        try:
            data = json.loads(path.read_text(encoding='utf-8'))
        except (OSError, ValueError):
            continue
        if data.get('sessionId') == session:
            out[int(data.get('pid', 0))] = data
    return out


def alive(pid):
    if os.name != 'nt':
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False
    out = subprocess.run(['tasklist', '/FI', f'PID eq {pid}', '/NH', '/FO', 'CSV'], capture_output=True, text=True, creationflags=NO_WINDOW)
    return f'"{pid}"' in out.stdout


@unittest.skipUnless(NODE and CLAUDE_ACP and CLAUDE_CLI, 'needs node, the Claude Code ACP adapter and the claude CLI')
@unittest.skipUnless(SERVER_KIND == 'deno-split', 'runs against AIB_SERVER=deno-split (the default)')
class OpenElsewhereTest(unittest.TestCase):

    def setUp(self):
        self.temp = pathlib.Path(tempfile.mkdtemp(prefix='aib-oe-'))
        self.addCleanup(shutil.rmtree, self.temp, True)
        self.stub = Stub(self, self.temp)
        self.project = make_repo(self.temp / f'proj-{uuid.uuid4().hex[:6]}')
        run_git(self.project, 'config', 'core.autocrlf', 'false')
        OwnerGuard(self, self.project)
        RealClaudeFixture.stub = self.stub
        self.server_tmp = self.temp / 'tmp'
        self.server_tmp.mkdir()
        self.fx = self.fixture()(self)
        self.web = self.fx.start_web()
        status, connection = self.web.post('connect', {'provider': 'claude', 'cwd': str(self.project), 'background': True})
        self.assertEqual(status, 200, connection)
        self.chat = Chat(None, connection['id'], self.web)
        wait_for(lambda: self.chat.state().get('ready') or (self.chat.state().get('error') and self.fail(self.chat.state()['error'])), 'chat ready', 120)
        # its HOME and CLAUDE_CONFIG_DIR
        self.home = wait_for(lambda: agent_home(self.chat.session, self.server_tmp), "the agent's temp home", 30)
        (self.home / 'tmp').mkdir(exist_ok=True)

    def fixture(self):
        """The split agent host runs the agent (AIB_KEEPER=0, the e2e default)."""
        return RealClaudeFixture

    def released(self):
        return (self.chat.state().get('elsewhere') or {}).get('released') is True

    def notes(self, kind=None):
        return [n for n in self.chat.notes() if kind is None or n.get('elsewhere') == kind]

    def own_records(self, session, other_pid=None):
        return {pid: r for pid, r in records(self.home, session).items() if pid != other_pid and alive(pid)}

    def test_idle_chat_lets_go_and_comes_back_with_the_outside_turn(self):
        self.assertIn('STUB codeword=ALPHA', self.chat.send('Remember: the codeword is ALPHA'))
        session = self.chat.session
        mine = self.own_records(session)
        self.assertEqual(len(mine), 1, f"AIB's own Claude process has the registry record: {mine}")
        time.sleep(11)  # a watcher event and the 10 s backup scan have both run: AIB's own process is never "elsewhere"
        self.assertNotIn('elsewhere', self.chat.state(), 'AIB counted its own Claude process as another app')

        other = OtherApp(self, self.home, self.project, self.stub, session)
        started = time.time()
        wait_for(self.released, 'AIB to let go of the idle chat', 30)
        self.assertLess(time.time() - started, 15, 'letting go took too long')
        self.assertEqual([n['message'] for n in self.notes('released')], [RELEASED_LINE])
        self.assertEqual(self.notes('released')[0]['actions'], [{'id': 'elsewhere-open', 'label': 'Open here'}])
        wait_for(lambda: not self.own_records(session, other.pid), "AIB's Claude process and its record to go", 15)
        self.assertFalse(self.chat.state()['closed'], 'the chat stays open in AIB (only the session was closed)')

        self.assertIn('STUB codeword=BETA', other.say('Typed elsewhere: the codeword is BETA'))
        other.stop()
        wait_for(lambda: not alive(other.pid), 'the other app to quit', 20)

        reply = self.chat.send('What is the codeword now?')
        self.assertIn('STUB codeword=BETA', reply, 'the reloaded chat continues from the turn typed elsewhere')
        state = self.chat.state()
        self.assertNotIn('elsewhere', state)
        users = [e['data']['update']['content'].get('text', '') for e in self.chat.state(after=0)['events']
                 if e['kind'] == 'update' and e['data']['update'].get('sessionUpdate') == 'user_message_chunk']
        self.assertTrue(any('Typed elsewhere: the codeword is BETA' in u for u in users), users)
        self.assertFalse(any('Remember: the codeword is ALPHA' in u for u in users), 'AIB showed its own history again')
        self.assertEqual([n['message'] for n in self.notes('back')], ['AIB took this chat back, with 1 turn from a terminal above.'])
        self.assertEqual(len(self.own_records(session)), 1, 'AIB holds the session again')

    def test_running_turn_lets_go_only_after_the_turn(self):
        self.assertIn('STUB codeword=ONE', self.chat.send('the codeword is ONE'))
        session = self.chat.session
        status, sent = self.web.post('prompt', {'id': self.chat.id, 'text': 'STUB_WAIT=8 the codeword is GAMMA', 'clientMessageId': uuid.uuid4().hex})
        self.assertEqual(status, 200, sent)
        wait_for(lambda: self.chat.state()['busy'], 'the turn to run')
        other = OtherApp(self, self.home, self.project, self.stub, session)
        wait_for(lambda: self.chat.state().get('elsewhere'), 'AIB to notice the other app', 30)
        state = self.chat.state()
        self.assertTrue(state['busy'], 'the turn still runs')
        self.assertFalse(state['elsewhere']['released'], 'AIB waits for the turn before it lets go')
        wait_for(self.released, 'AIB to let go after the turn', 60)
        events = self.chat.state(after=0)['events']
        said = ''.join(e['data']['update']['content'].get('text', '') for e in events
                       if e['kind'] == 'update' and e['data']['update'].get('sessionUpdate') == 'agent_message_chunk')
        self.assertIn('STUB codeword=GAMMA', said, 'the running turn finished with its reply')
        self.assertEqual([e['data'].get('stopReason') for e in events if e['kind'] == 'turn_end'][-1], 'end_turn')
        self.assertEqual(len(self.notes('released')), 1)
        other.stop()

    def test_still_held_needs_open_here_anyway(self):
        self.assertIn('STUB codeword=ALPHA', self.chat.send('the codeword is ALPHA'))
        session = self.chat.session
        other = OtherApp(self, self.home, self.project, self.stub, session)
        wait_for(self.released, 'AIB to let go', 30)
        calls = len(self.stub.calls())
        status, refused = self.web.post('prompt', {'id': self.chat.id, 'text': 'Are you there?', 'clientMessageId': uuid.uuid4().hex})
        self.assertEqual(status, 409, refused)
        self.assertEqual(refused['code'], 'held_elsewhere')
        self.assertIn('still open in a terminal', refused['error'])
        held = self.notes('held')
        self.assertEqual(len(held), 1)
        self.assertEqual(held[0]['actions'], [{'id': 'elsewhere-force', 'label': 'Open here anyway'}])
        # a second try adds no second line, and nothing reached the model
        self.assertEqual(self.web.post('prompt', {'id': self.chat.id, 'text': 'Again?', 'clientMessageId': uuid.uuid4().hex})[0], 409)
        self.assertEqual(len(self.notes('held')), 1)
        self.assertEqual(len(self.stub.calls()), calls, 'nothing was sent while another app holds the chat')
        self.assertTrue(self.released())
        # Open here (no force) while still held: stays released
        status, answer = self.web.post('session-op', {'id': self.chat.id, 'op': 'open-here'})
        self.assertEqual((status, answer.get('state')), (200, 'held'), answer)
        # Open here anyway
        status, answer = self.web.post('session-op', {'id': self.chat.id, 'op': 'open-here', 'force': True})
        self.assertEqual((status, answer.get('state')), (200, 'back'), answer)
        self.assertNotIn('elsewhere', self.chat.state())
        other.stop()
        wait_for(lambda: not alive(other.pid), 'the other app to quit', 20)
        self.assertIn('STUB codeword=ALPHA', self.chat.send('and the codeword?'))


@unittest.skipUnless(GO or os.environ.get('AIB_TEST_KEEPER_BIN'), 'needs Go to build the keeper program (or AIB_TEST_KEEPER_BIN)')
class OpenElsewhereKeeperTest(OpenElsewhereTest):
    """The same three flows with the chat's agent in the keeper (the owner's setup): session/close and session/load go through its
    channel, the adapter keeps running there, and AIB's own Claude process is found below the keeper channel's adapter."""

    def fixture(self):
        keeper, tmp = keeper_program(self.temp), self.server_tmp

        class Fixture(RealClaudeFixture):
            def env(self):
                env = super().env()
                env.update(AIB_KEEPER='1', AIB_KEEPER_BIN=str(keeper))
                for name in ('TEMP', 'TMP', 'TMPDIR'):  # the server's own temp folder (the keeper's files; the agent gets <test home>/tmp)
                    env[name] = str(tmp)
                return env
        self.addCleanup(self.stop_keeper, keeper)
        return Fixture

    def setUp(self):
        super().setUp()
        self.assertTrue(self.keeper_pids(keeper_program(self.temp)), 'the chat runs in a keeper')

    @staticmethod
    def keeper_pids(keeper):
        """The keepers of this test's own keeper program (its exe is in this test's temp folder, so nothing else runs it)."""
        if os.name != 'nt':
            return []
        name = pathlib.Path(keeper).name
        out = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command',
                              f"Get-CimInstance Win32_Process -Filter \"Name='{name}'\" | ForEach-Object {{ \"$($_.ProcessId)`t$($_.ExecutablePath)\" }}"],
                             capture_output=True, text=True, creationflags=NO_WINDOW, timeout=60)
        want = os.path.normcase(str(keeper))
        return [int(line.split('\t')[0]) for line in out.stdout.splitlines()
                if '\t' in line and os.path.normcase(line.split('\t', 1)[1].strip()) == want]

    def stop_keeper(self, keeper):
        for pid in self.keeper_pids(keeper):  # only keepers of this test's own program
            subprocess.run(['taskkill', '/PID', str(pid), '/T', '/F'], capture_output=True, creationflags=NO_WINDOW)


if __name__ == '__main__':
    unittest.main()
