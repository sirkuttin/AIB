"""Open elsewhere for Codex chats (server/ownership/handoff.ts, codex_threads.ts): AIB lets go of a Codex chat that a Codex CLI opened,
and takes it back, with the turns written there, when the person returns.

A real AIB (deno-split web server + agent host, the chat's agent in the keeper) runs a real Codex chat through AIB's pinned codex-acp
(AIB_CODEX_ACP) against the local stub model API (work/stub_model_api.js, plain mode: "the codeword is X" -> "STUB codeword=X"). No
key, no network, a throwaway CODEX_HOME (acp/connection.ts testHomeEnv, in this test's temp folder through TEMP). The model provider
reaches AIB's Codex through CODEX_CONFIG and the other Codex processes through `-c` flags; the owner's ~/.codex is checked untouched.

"Another app" is the real Codex CLI with that same CODEX_HOME:
  - `codex exec resume <thread> -`: its command line names the thread (as `codex resume <thread>` in a terminal does) and it waits
    for its prompt on stdin before it opens the thread, so it is there to be seen while AIB holds the thread (the TUI waits the same
    way, on its "open in another app, r to retry" card); each prompt the test writes is a turn typed there;
  - `codex app-server` that resumes the thread over JSON-RPC: what VS Code's and Codex Desktop's Codex do; its command line names no
    thread, so only the thread's writer lock shows it holds the chat.

  test_idle_chat_lets_go_and_comes_back_with_the_outside_turn
      AIB's chat idle, AIB's own Codex never counted as elsewhere; the CLI appears -> AIB closes its session and the thread's writer
      lock goes at once (thread_unload_delay_secs = 0), the chat line says so. The CLI's turn runs there (Codex accepts it: AIB let
      go); sending in AIB loads the thread again, shows the outside turn, and the reply continues from it.
  test_running_turn_lets_go_only_after_the_turn
      A turn is running (the stub holds the reply 25 s: the CLI is found on the 10 s beat); the CLI appears -> nothing is cut: the turn ends with its reply, then AIB lets go.
  test_still_held_waits_with_no_open_here_anyway
      Released; an app-server client takes the thread: sending is refused (409 held_elsewhere, nothing sent, one line with Open here,
      no Open here anyway: Codex lets one app write); Open here, even forced, stays held; once that app quits, Open here takes it back.

  test_vscode_app_server_lets_go_idle_chats_once
      A fake "VS Code" (a copy of node named Code.exe) starts `codex app-server` (what VS Code's Codex extension does, no thread id):
      AIB lets go of the idle chat with the app-server line, the writer lock goes; sending takes it back; the same app-server
      process does not make AIB let go again.
  test_app_server_does_not_touch_working_chat_or_unrelated_app_server
      An app-server started by a script (not an editor) changes nothing; one started by "VS Code" while a turn runs leaves the
      working chat alone, now and when the turn ends.
  test_let_go_button
      The header icon's server side (session-op let-go): lets go of an idle chat (line, lock gone), says "already" the second time,
      Open here takes it back; a working chat is not let go and the answer says so.

Skipped without node, codex-acp (AIB_CODEX_ACP) or Go (AIB_TEST_KEEPER_BIN names a built keeper). Targeted: run this file alone, with
TEMP/TMP pointed at a scratch folder with no space in its path.
"""
import _isolation  # noqa: F401  (test isolation: temp state folder, real per-user folder blocked)
import json
import os
import pathlib
import shutil
import subprocess
import sys
import threading
import time
import unittest
import uuid

sys.path.insert(0, str(_isolation.TESTS / 'contract'))
from test_worktree_e2e import wait_for  # noqa: E402
from test_subagent_codex_e2e import CODEX_ACP, SERVER_KIND, AibCodex, notes  # noqa: E402
from test_folder_chat_listing_e2e import NODE  # noqa: E402
from test_subagent_worktree_e2e import GO  # noqa: E402

NO_WINDOW = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
RELEASED_LINE = 'Continued in a terminal. AIB let go of this chat. Open it here to take it back.'


def codex_cli():
    """The codex executable codex-acp runs (its own @openai/codex package), or AIB_CODEX_CLI."""
    named = os.environ.get('AIB_CODEX_CLI')
    if named:
        return pathlib.Path(named)
    if not CODEX_ACP:
        return None
    modules = pathlib.Path(CODEX_ACP).parents[3]
    exe = modules / '@openai' / 'codex-win32-x64' / 'vendor' / 'x86_64-pc-windows-msvc' / 'bin' / 'codex.exe'
    return exe if exe.is_file() else None


CODEX = codex_cli()


def other_env(home):
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith(('OPENAI', 'CODEX', 'AIB_', 'AGENT_STUDIO'))}
    for name in ('HOME', 'USERPROFILE'):
        env[name] = str(home)
    for name in ('TMP', 'TEMP', 'TMPDIR'):
        env[name] = str(home / 'tmp')
    env['CODEX_HOME'] = str(home)
    return env


def provider_flags(stub):
    """The stub model provider as `-c` overrides (AIB's chat gets the same through CODEX_CONFIG)."""
    table = (f'{{name="stub",base_url="{stub.url}/v1",wire_api="responses",requires_openai_auth=false,'
             'supports_websockets=false}')
    return ['-c', 'model="stub-model"', '-c', 'model_provider="stub"', '-c', f'model_providers.stub={table}',
            '-c', 'analytics.enabled=false', '-c', 'check_for_update_on_startup=false']


def lock_file(home, thread):
    return home / 'thread-writer-locks' / f'{thread}.lock'


def agent_home(root, thread):
    """The agent's throwaway CODEX_HOME (testHomeEnv: CODEX_HOME is the temp home itself): the one whose writer lock names the thread
    AIB holds (thread ids are unique, so no other run's folder matches)."""
    for home in pathlib.Path(root).glob('agent-studio-test-home-*'):
        if lock_file(home, thread).exists():
            return home
    return None


def close_pipes(process):
    time.sleep(0.2)  # the reader threads see the end of the output first
    for stream in (process.stdin, process.stdout, process.stderr):
        try:
            if stream:
                stream.close()
        except (OSError, ValueError):
            pass


class OtherCli:
    """`codex exec resume <thread> -` in the agent's CODEX_HOME: named on its command line, waiting for its prompt on stdin."""

    def __init__(self, owner, home, project, stub, thread):
        self.process = subprocess.Popen(
            [str(CODEX), 'exec', '--skip-git-repo-check', '--json', *provider_flags(stub), 'resume', thread, '-'],
            cwd=str(project), env=other_env(home), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            creationflags=NO_WINDOW)
        owner.addCleanup(self.stop)
        self.out, self.err = [], []
        threading.Thread(target=lambda: self.out.extend(self.process.stdout), daemon=True).start()
        threading.Thread(target=lambda: self.err.extend(self.process.stderr), daemon=True).start()

    @property
    def pid(self):
        return self.process.pid

    def say(self, text, wait=True):
        """The turn typed there (its prompt; stdin closes, as the CLI reads it all). Returns what it said."""
        self.process.stdin.write(text.encode('utf-8'))
        self.process.stdin.close()
        if not wait:
            return ''
        code = self.process.wait(120)
        said = b''.join(self.out).decode('utf-8', 'replace')
        if code != 0:
            raise AssertionError(f'the other Codex failed ({code}): {said[-1500:]} {b"".join(self.err).decode("utf-8", "replace")[-2000:]}')
        return said

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
        close_pipes(self.process)


class OtherAppServer:
    """`codex app-server` (VS Code's and Codex Desktop's Codex) that resumes the thread over JSON-RPC and holds it until it quits."""

    def __init__(self, owner, home, project, stub):
        self.process = subprocess.Popen([str(CODEX), *provider_flags(stub), 'app-server'], cwd=str(project), env=other_env(home),
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, creationflags=NO_WINDOW)
        owner.addCleanup(self.stop)
        self.answers, self.next = {}, 0
        threading.Thread(target=self._read, daemon=True).start()
        self.call('initialize', {'clientInfo': {'name': 'Codex Desktop', 'version': '1.0'}, 'capabilities': {'experimentalApi': True}})
        self.send({'method': 'initialized'})

    def _read(self):
        for raw in self.process.stdout:
            try:
                message = json.loads(raw)
            except ValueError:
                continue
            if 'id' in message and ('result' in message or 'error' in message):
                self.answers[message['id']] = message

    def send(self, message):
        self.process.stdin.write((json.dumps({'jsonrpc': '2.0', **message}) + '\n').encode('utf-8'))
        self.process.stdin.flush()

    def call(self, method, params):
        self.next += 1
        rid = self.next
        self.send({'id': rid, 'method': method, 'params': params})
        return wait_for(lambda: self.answers.get(rid), f'app-server {method}', 60)

    def stop(self):
        if self.process.poll() is None:
            try:
                self.process.stdin.close()
                self.process.wait(20)
            except (OSError, subprocess.TimeoutExpired):
                self.process.kill()  # only the process this test started
                self.process.wait(10)
        close_pipes(self.process)


FAKE_VSCODE_JS = """
// A stand-in for VS Code's extension host: this program (named Code.exe) starts the Codex extension's `codex app-server` and keeps it.
const { spawn } = require('child_process');
const [codex, ...args] = process.argv.slice(2);
const child = spawn(codex, args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
child.on('exit', () => process.exit(0));
process.stdin.resume();
process.stdin.on('end', () => { child.kill(); process.exit(0); });
"""


class FakeVsCode:
    """`Code.exe script.js codex ... app-server`: the app-server's parent is a program called Code.exe, as under VS Code's extension host.
    parent_name: another name for the parent (an unrelated program)."""

    def __init__(self, owner, home, project, stub, parent_name='Code.exe'):
        folder = pathlib.Path(home) / 'tmp' / ('fake-' + uuid.uuid4().hex[:8])
        folder.mkdir(parents=True, exist_ok=True)
        exe = folder / parent_name
        shutil.copyfile(NODE, exe)
        script = folder / 'extension_host.js'
        script.write_text(FAKE_VSCODE_JS, encoding='utf-8')
        self.process = subprocess.Popen(
            [str(exe), str(script), str(CODEX), *provider_flags(stub), 'app-server'], cwd=str(project), env=other_env(pathlib.Path(home)),
            stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=NO_WINDOW)
        owner.addCleanup(self.stop)

    @property
    def pid(self):
        return self.process.pid

    def stop(self):
        if self.process.poll() is None:
            try:
                self.process.stdin.close()
                self.process.wait(20)
            except (OSError, subprocess.TimeoutExpired):
                self.process.kill()  # only the process this test started
                self.process.wait(10)
        close_pipes(self.process)


@unittest.skipUnless(NODE and CODEX_ACP and CODEX and (GO or os.environ.get('AIB_TEST_KEEPER_BIN')),
                     'needs node, codex-acp (AIB_CODEX_ACP) with its codex executable, and Go or AIB_TEST_KEEPER_BIN')
@unittest.skipUnless(SERVER_KIND == 'deno-split', 'runs against AIB_SERVER=deno-split (the default)')
class CodexOpenElsewhereTest(unittest.TestCase):

    def setUp(self):
        self.aib = AibCodex(self, [])  # no rules: every reply is the plain codeword reply
        self.chat, self.web, self.stub, self.project = self.aib.chat, self.aib.web, self.aib.stub, self.aib.project

    def send(self, text, status=200):
        return self.chat.send(f'{text} {self.aib.mark}', status=status)  # the mark: the owner guard looks for it in ~/.codex

    def released(self):
        return (self.chat.state().get('elsewhere') or {}).get('released') is True

    def notes_of(self, kind):
        return [e['data'] for e in self.chat.state(after=0)['events'] if e['kind'] == 'studio_note' and e['data'].get('elsewhere') == kind]

    def start(self):
        """One AIB turn, so Codex has written the thread; returns (thread id, its CODEX_HOME)."""
        self.assertIn('STUB codeword=ALPHA', self.send('Remember: the codeword is ALPHA'))
        thread = self.chat.session
        home = wait_for(lambda: agent_home(self.aib.temp / 'tmp', thread), "the agent's CODEX_HOME", 30)
        (home / 'tmp').mkdir(exist_ok=True)
        return thread, home

    def test_idle_chat_lets_go_and_comes_back_with_the_outside_turn(self):
        thread, home = self.start()
        self.assertTrue(lock_file(home, thread).exists(), "AIB's Codex holds the thread's writer lock")
        time.sleep(11)  # the 10 s beat ran: AIB's own Codex (app-server, hooks, shells) is never "elsewhere"
        self.assertNotIn('elsewhere', self.chat.state(), 'AIB counted its own Codex as another app')

        other = OtherCli(self, home, self.project, self.stub, thread)
        started = time.time()
        wait_for(self.released, 'AIB to let go of the idle chat', 30)
        self.assertLess(time.time() - started, 15, 'letting go took too long')
        self.assertEqual([n['message'] for n in self.notes_of('released')], [RELEASED_LINE])
        self.assertEqual(self.notes_of('released')[0]['actions'], [{'id': 'elsewhere-open', 'label': 'Open here'}])
        wait_for(lambda: not lock_file(home, thread).exists(), 'the writer lock to go (the thread unloaded at once)', 10)
        self.assertFalse(self.chat.state()['closed'], 'the chat stays open in AIB (only the session was closed)')

        said = other.say(f'Typed elsewhere: the codeword is BETA {self.aib.mark}')
        self.assertIn('STUB codeword=BETA', said, 'the other Codex opened the thread and wrote its turn')

        reply = self.send('What is the codeword now?')
        self.assertIn('STUB codeword=BETA', reply, 'the reloaded chat continues from the turn typed elsewhere')
        self.assertNotIn('elsewhere', self.chat.state())
        users = [e['data']['update']['content'].get('text', '') for e in self.chat.state(after=0)['events']
                 if e['kind'] == 'update' and e['data']['update'].get('sessionUpdate') == 'user_message_chunk']
        self.assertTrue(any('Typed elsewhere: the codeword is BETA' in u for u in users), users)
        self.assertFalse(any('Remember: the codeword is ALPHA' in u for u in users), 'AIB showed its own history again')
        self.assertEqual([n['message'] for n in self.notes_of('back')], ['AIB took this chat back, with 1 turn from a terminal above.'])
        self.assertTrue(lock_file(home, thread).exists(), 'AIB holds the thread again')

    def test_running_turn_lets_go_only_after_the_turn(self):
        thread, home = self.start()
        status, sent = self.web.post('prompt', {'id': self.chat.id, 'text': f'STUB_WAIT=25 the codeword is GAMMA {self.aib.mark}',
                                                'clientMessageId': uuid.uuid4().hex})
        self.assertEqual(status, 200, sent)
        wait_for(lambda: self.chat.state()['busy'], 'the turn to run')
        other = OtherCli(self, home, self.project, self.stub, thread)
        wait_for(lambda: self.chat.state().get('elsewhere'), 'AIB to notice the other Codex', 30)
        state = self.chat.state()
        self.assertTrue(state['busy'], 'the turn still runs')
        self.assertFalse(state['elsewhere']['released'], 'AIB waits for the turn before it lets go')
        self.assertTrue(lock_file(home, thread).exists(), 'AIB still holds the thread while its turn runs')
        wait_for(self.released, 'AIB to let go after the turn', 60)
        events = self.chat.state(after=0)['events']
        said = ''.join(e['data']['update']['content'].get('text', '') for e in events
                       if e['kind'] == 'update' and e['data']['update'].get('sessionUpdate') == 'agent_message_chunk')
        self.assertIn('STUB codeword=GAMMA', said, 'the running turn finished with its reply')
        self.assertEqual([e['data'].get('stopReason') for e in events if e['kind'] == 'turn_end'][-1], 'end_turn')
        self.assertEqual(len(self.notes_of('released')), 1)
        self.assertIn('STUB codeword=DELTA', other.say(f'the codeword is DELTA {self.aib.mark}'), 'the other Codex got the thread')

    def test_still_held_waits_with_no_open_here_anyway(self):
        thread, home = self.start()
        cli = OtherCli(self, home, self.project, self.stub, thread)
        wait_for(self.released, 'AIB to let go', 30)
        cli.say('', wait=False)  # an empty prompt: that CLI gives up and quits without opening the thread
        wait_for(lambda: cli.process.poll() is not None, 'the CLI to quit', 60)
        app = OtherAppServer(self, home, self.project, self.stub)
        resumed = app.call('thread/resume', {'threadId': thread})
        self.assertNotIn('error', resumed, resumed)
        self.assertTrue(lock_file(home, thread).exists(), 'the app-server client holds the thread')

        calls = len(self.stub.calls())
        refused = self.send('Are you there?', status=409)
        self.assertEqual(refused['code'], 'held_elsewhere')
        self.assertEqual(refused['error'], 'This chat is still open in another app, so nothing was sent. Close it there, then send again.')
        held = self.notes_of('held')
        self.assertEqual([n['message'] for n in held], ['Still open in another app. Close it there first, then choose Open here '
                                                        '(Codex lets only one app write to a chat at a time).'])
        self.assertEqual(held[0]['actions'], [{'id': 'elsewhere-open', 'label': 'Open here'}], 'no Open here anyway for Codex')
        self.assertEqual(self.web.post('prompt', {'id': self.chat.id, 'text': 'Again?', 'clientMessageId': uuid.uuid4().hex})[0], 409)
        self.assertEqual(len(self.notes_of('held')), 1, 'a second try adds no second line')
        self.assertEqual(len(self.stub.calls()), calls, 'nothing was sent while another app holds the chat')
        for force in (False, True):  # Codex refuses a second writer: forcing changes nothing
            status, answer = self.web.post('session-op', {'id': self.chat.id, 'op': 'open-here', 'force': force})
            self.assertEqual((status, answer.get('state')), (200, 'held'), answer)
        self.assertTrue(self.released())

        app.stop()
        wait_for(lambda: not lock_file(home, thread).exists(), 'the app-server client to let go', 20)
        status, answer = self.web.post('session-op', {'id': self.chat.id, 'op': 'open-here'})
        self.assertEqual((status, answer.get('state')), (200, 'back'), answer)
        self.assertNotIn('elsewhere', self.chat.state())
        self.assertIn('STUB codeword=ALPHA', self.send('and the codeword?'))

    def test_vscode_app_server_lets_go_idle_chats_once(self):
        thread, home = self.start()
        time.sleep(11)  # AIB's own app-server is never counted
        self.assertNotIn('elsewhere', self.chat.state(), "AIB counted its own app-server as VS Code's")
        FakeVsCode(self, home, self.project, self.stub)
        started = time.time()
        wait_for(self.released, "AIB to let go when VS Code's Codex started", 30)
        self.assertLess(time.time() - started, 15)
        line = "VS Code's Codex started: AIB let go so you can open this chat there. Open it here to take it back."
        self.assertEqual([n['message'] for n in self.notes_of('released')], [line])
        self.assertEqual(self.notes_of('released')[0]['actions'], [{'id': 'elsewhere-open', 'label': 'Open here'}])
        wait_for(lambda: not lock_file(home, thread).exists(), 'the writer lock to go', 10)
        self.assertFalse(self.chat.state()['closed'])

        self.assertIn('STUB codeword=ALPHA', self.send('What is the codeword?'), 'sending takes the chat back')
        self.assertNotIn('elsewhere', self.chat.state())
        self.assertTrue(lock_file(home, thread).exists(), 'AIB holds the thread again')
        time.sleep(12)  # a beat: that same app-server (pid and start) does not make AIB let go again
        self.assertNotIn('elsewhere', self.chat.state())
        self.assertEqual(len(self.notes_of('released')), 1)

    def test_app_server_does_not_touch_working_chat_or_unrelated_app_server(self):
        thread, home = self.start()
        FakeVsCode(self, home, self.project, self.stub, parent_name='script_runner.exe')  # not an editor
        time.sleep(13)
        self.assertNotIn('elsewhere', self.chat.state(), "an app-server a script started is not VS Code's")
        self.assertTrue(lock_file(home, thread).exists())

        status, sent = self.web.post('prompt', {'id': self.chat.id, 'text': f'STUB_WAIT=25 the codeword is GAMMA {self.aib.mark}',
                                                'clientMessageId': uuid.uuid4().hex})
        self.assertEqual(status, 200, sent)
        wait_for(lambda: self.chat.state()['busy'], 'the turn to run')
        FakeVsCode(self, home, self.project, self.stub)
        time.sleep(14)  # at least one beat while the turn runs
        state = self.chat.state()
        self.assertTrue(state['busy'], 'the turn still runs')
        self.assertNotIn('elsewhere', state, 'a working chat is never let go for an app-server (and nothing waits for its turn)')
        self.assertTrue(lock_file(home, thread).exists())
        wait_for(lambda: not self.chat.state()['busy'], 'the turn to end', 60)
        time.sleep(12)
        self.assertNotIn('elsewhere', self.chat.state(), 'once seen, that app-server does not act when the turn ends')
        self.assertIn('STUB codeword=GAMMA', self.send('and the codeword?'))

    def test_let_go_button(self):
        thread, home = self.start()
        status, answer = self.web.post('session-op', {'id': self.chat.id, 'op': 'let-go'})
        self.assertEqual((status, answer.get('state')), (200, 'released'), answer)
        self.assertTrue(self.released())
        self.assertEqual([n['message'] for n in self.notes_of('released')],
                         ['AIB let go of this chat so another app can open it. Open it here to take it back.'])
        wait_for(lambda: not lock_file(home, thread).exists(), 'the writer lock to go', 10)
        status, answer = self.web.post('session-op', {'id': self.chat.id, 'op': 'let-go'})
        self.assertEqual((status, answer.get('state')), (200, 'already'), answer)
        status, answer = self.web.post('session-op', {'id': self.chat.id, 'op': 'open-here'})
        self.assertEqual((status, answer.get('state')), (200, 'back'), answer)
        self.assertNotIn('elsewhere', self.chat.state())
        self.assertTrue(lock_file(home, thread).exists())

        status, sent = self.web.post('prompt', {'id': self.chat.id, 'text': f'STUB_WAIT=20 the codeword is GAMMA {self.aib.mark}',
                                                'clientMessageId': uuid.uuid4().hex})
        self.assertEqual(status, 200, sent)
        wait_for(lambda: self.chat.state()['busy'], 'the turn to run')
        status, answer = self.web.post('session-op', {'id': self.chat.id, 'op': 'let-go'})
        self.assertEqual((status, answer.get('state')), (200, 'busy'), answer)
        self.assertEqual(answer['message'], 'This chat is working, so AIB did not let go. Try again when it is idle.')
        self.assertNotIn('elsewhere', self.chat.state(), 'nothing was let go and nothing waits')
        self.assertTrue(lock_file(home, thread).exists())


if __name__ == '__main__':
    unittest.main()
