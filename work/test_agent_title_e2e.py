"""A chat renamed in AIB gets the same name in the agent's own list (host/agent_titles.ts): the list `claude --resume` and the VS Code
extension read (the adapter's session/list, the SDK's own session listing) shows AIB's name. Real agent adapters, the local stub model
API (work/stub_model_api.js), temp config, no key, no network.

  AibRenameTest      a real AIB (deno-split web server + agent host) runs a Claude Code chat; Rename (POST /api/live/chat-name) names
                     it; AIB's `discover` (the agent's session/list) then lists the chat under that name. The rename costs no model call,
                     and a turn after it does not bring the old name back (the running CLI re-stamps the name it reads back).
                     Under test AIB gives the agent a throwaway HOME / CLAUDE_CONFIG_DIR (acp/connection.ts testHomeEnv).
  AdapterRenameTest  one layer down, Claude Code AND Codex: the adapter's own `_session/rename` (work/acp_probe.js rename, the call AIB
                     makes) names a saved session with no model call, and the adapter's listing shows it. Claude Code: the transcript
                     gets the CLI's own `custom-title` record.

Guard: no entry for the temp project may appear in the owner's ~/.claude/projects or ~/.codex/sessions.
Adapters: AIB_CLAUDE_ACP / AIB_CODEX_ACP (path to the adapter's dist/index.js), else the global npm install.
"""
import _isolation  # noqa: F401  (test isolation: temp state folder, real per-user folder blocked)
from _isolation import agent_mkdtemp
import json
import os
import pathlib
import shutil
import sys
import time
import unittest
import uuid

sys.path.insert(0, str(_isolation.TESTS / 'contract'))
from _e2e_support import make_repo, run_git  # noqa: E402
from test_worktree_e2e import Chat, wait_for  # noqa: E402
from test_folder_chat_listing_e2e import (  # noqa: E402
    CLAUDE_ACP, CODEX_ACP, NODE, SERVER_KIND, OwnerGuard, RealClaudeFixture, Stub, claude_encoded, probe, stub_claude_env,
)


def model_calls(stub):
    return [c for c in stub.calls() if c['path'].endswith('/messages') or c['path'].endswith('/responses')]


@unittest.skipUnless(NODE and CLAUDE_ACP, 'needs node and the Claude Code ACP adapter (AIB_CLAUDE_ACP or a global npm install)')
@unittest.skipUnless(SERVER_KIND == 'deno-split', 'runs against AIB_SERVER=deno-split (the default)')
class AibRenameTest(unittest.TestCase):

    def test_rename_in_aib_names_the_claude_session(self):
        temp = pathlib.Path(agent_mkdtemp(prefix='aib-title-'))
        self.addCleanup(shutil.rmtree, temp, True)
        stub = Stub(self, temp)
        project = make_repo(temp / f'proj-{uuid.uuid4().hex[:6]}')
        run_git(project, 'config', 'core.autocrlf', 'false')
        OwnerGuard(self, project)

        RealClaudeFixture.stub = stub
        fx = RealClaudeFixture(self)
        web = fx.start_web()
        status, connection = web.post('connect', {'provider': 'claude', 'cwd': str(project), 'background': True})
        self.assertEqual(status, 200, connection)
        chat = Chat(None, connection['id'], web)
        wait_for(lambda: chat.state().get('ready') or (chat.state().get('error') and self.fail(chat.state()['error'])), 'chat ready')
        self.assertIn('STUB codeword=TEAL-7', chat.send('the codeword is TEAL-7'))
        session = chat.session
        self.assertTrue(session)

        def listed_title():
            time.sleep(0.3)  # each look asks the agent (session/list): not 20 times a second
            status, found = web.post('discover', {'provider': 'claude', 'cwd': str(project)})
            self.assertEqual(status, 200, found)
            mine = [s for s in found['sessions'] if s['sessionId'] == session]
            return mine[0]['title'] if mine else None

        self.assertNotEqual(listed_title(), 'Ashborne orchestrator part3')
        calls = len(model_calls(stub))
        name = 'Ashborne orchestrator part3'
        status, out = web.post('chat-name', {'key': f'claude:{session}', 'name': name, 'cwd': str(project)})
        self.assertEqual(status, 200, out)
        self.assertEqual(out['chatNames'].get(f'claude:{session}'), name, 'AIB keeps its own name')
        wait_for(lambda: listed_title() == name, "the agent's own list shows AIB's name", seconds=60)
        self.assertEqual(len(model_calls(stub)), calls, 'the rename made no model call')

        # the chat goes on: the running CLI keeps the new name (it reads it back before it re-stamps its metadata)
        self.assertIn('STUB codeword=TEAL-7', chat.send('what was the codeword?'))
        self.assertEqual(listed_title(), name)

        # a second rename replaces it; a cleared name changes nothing in the agent
        status, _ = web.post('chat-name', {'key': f'claude:{session}', 'name': 'Ashborne orchestrator part4'})
        self.assertEqual(status, 200)
        wait_for(lambda: listed_title() == 'Ashborne orchestrator part4', 'the second name', seconds=60)
        status, _ = web.post('chat-name', {'key': f'claude:{session}', 'name': ''})
        self.assertEqual(status, 200)
        time.sleep(2)
        self.assertEqual(listed_title(), 'Ashborne orchestrator part4')


@unittest.skipUnless(NODE, 'needs node')
class AdapterRenameTest(unittest.TestCase):
    """The adapter's own `_session/rename`, one layer below AIB: temp CLAUDE_CONFIG_DIR / CODEX_HOME / HOME."""

    def setUp(self):
        self.temp = pathlib.Path(agent_mkdtemp(prefix='aib-title-a-'))
        self.addCleanup(shutil.rmtree, self.temp, True)
        self.stub = Stub(self, self.temp)
        self.project = make_repo(self.temp / f'proj-{uuid.uuid4().hex[:6]}')
        OwnerGuard(self, self.project)
        home = self.temp / 'home'
        for sub in ('claude', 'codex', 'home'):
            (self.temp / sub).mkdir(exist_ok=True)
        env = dict(os.environ)
        for name in ('HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'):
            env[name] = str(home)
        env.update(CLAUDE_CONFIG_DIR=str(self.temp / 'claude'), CODEX_HOME=str(self.temp / 'codex'))
        self.env = stub_claude_env(env, self.stub)
        (self.temp / 'codex' / 'config.toml').write_text(
            'model = "stub-model"\nmodel_provider = "stub"\napproval_policy = "never"\nsandbox_mode = "read-only"\n'
            'check_for_update_on_startup = false\n\n[model_providers.stub]\nname = "stub"\n'
            f'base_url = "{self.stub.url}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n\n'
            '[analytics]\nenabled = false\n', encoding='utf-8')

    def rename(self, entry, name):
        made = probe(entry, self.env, 'new', str(self.project), 'the codeword is TEAL-9')
        session = made['sessionId']
        calls = len(model_calls(self.stub))
        out = probe(entry, self.env, 'rename', session, name)
        self.assertEqual(out, {'renamed': True, 'advertised': True})
        self.assertEqual(len(model_calls(self.stub)), calls, 'the rename made no model call')
        listed = probe(entry, self.env, 'list', str(self.project))
        mine = [s for s in listed['sessions'] if s['sessionId'] == session]
        self.assertEqual(len(mine), 1, listed)
        self.assertEqual(mine[0]['title'], name)
        return session

    @unittest.skipUnless(CLAUDE_ACP, 'needs the Claude Code ACP adapter')
    def test_claude(self):
        session = self.rename(CLAUDE_ACP, 'Ashborne orchestrator part3')
        filed = self.temp / 'claude' / 'projects' / claude_encoded(self.project) / f'{session}.jsonl'
        rows = [json.loads(line) for line in filed.read_text(encoding='utf-8').splitlines() if line.strip()]
        self.assertIn({'type': 'custom-title', 'customTitle': 'Ashborne orchestrator part3', 'sessionId': session}, rows)

    @unittest.skipUnless(CODEX_ACP, 'needs the Codex ACP adapter')
    def test_codex(self):
        self.rename(CODEX_ACP, 'Ashborne orchestrator part3')


if __name__ == '__main__':
    unittest.main()
