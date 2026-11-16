"""e2e 19 (real-CLI form) of the "chats work in the project folder" plan (build-plan-1b 4.5, 8): AIB's re-file core makes an old copy
chat's transcript show in the agent's OWN listing for the project folder, and the resumed chat still has its history. Real agent
adapters, the local stub model API (work/stub_model_api.js), temp CLAUDE_CONFIG_DIR / CODEX_HOME / HOME, no key, no network.

  Claude Code  a chat made in a copy folder W (the codeword told to the stub), then AIB's refileClaude (work/refile_cli.ts) moves it to
               P with every cwd rewritten: the listing for P has it with cwd P, W's listing no longer does, a backup exists, and a
               load in P with a question gets "STUB codeword=TEAL-42" (the history reached the model). Empty copy-named folders go.
  Codex        what AIB's refileCodex does after the backup: open the chat once in P (session/load cwd=P, no prompt); the listing for
               P then has it and W's does not. AIB never writes Codex's files.

Guard: no entry for the temp folders may appear in the owner's ~/.claude/projects or ~/.codex/sessions.
"""
import _isolation  # noqa: F401
import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import unittest
import uuid

from _e2e_support import make_repo
from test_folder_chat_listing_e2e import CLAUDE_ACP, CODEX_ACP, NODE, NO_WINDOW, OwnerGuard, Stub, claude_encoded, probe, stub_claude_env

DENO = shutil.which('deno')
CLI = _isolation.TESTS / 'refile_cli.ts'


def refile_cli(*args):
    out = subprocess.run([DENO, 'run', '-A', '--quiet', str(CLI), *map(str, args)], capture_output=True, text=True, timeout=120,
                         creationflags=NO_WINDOW, stdin=subprocess.DEVNULL, cwd=str(_isolation.APP))
    lines = [line for line in out.stdout.splitlines() if line.strip().startswith('{')]
    if not lines:
        raise AssertionError(f'refile_cli printed nothing: {out.stdout!r} {out.stderr[-2000:]!r}')
    return json.loads(lines[-1])


@unittest.skipUnless(NODE and DENO, 'needs node and deno')
class RefileE2ETest(unittest.TestCase):

    def setUp(self):
        self.temp = pathlib.Path(tempfile.mkdtemp(prefix='aib-e19-'))
        self.addCleanup(shutil.rmtree, self.temp, True)
        self.stub = Stub(self, self.temp)
        self.state = self.temp / 'state'
        self.state.mkdir()
        # W stands for a copy under this install's worktrees root; P is the project folder
        self.copy = make_repo(self.state / 'worktrees' / 'abc123' / f'chat-{uuid.uuid4().hex[:8]}')
        self.project = make_repo(self.temp / f'proj-{uuid.uuid4().hex[:6]}')
        OwnerGuard(self, self.copy, self.project)
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

    def listed(self, entry, folder):
        return {s['sessionId']: s for s in probe(entry, self.env, 'list', str(folder))['sessions']}

    @unittest.skipUnless(CLAUDE_ACP, 'needs the Claude Code ACP adapter')
    def test_claude_refiled_chat_is_listed_for_project_and_keeps_history(self):
        made = probe(CLAUDE_ACP, self.env, 'new', str(self.copy), 'the codeword is TEAL-42')
        self.assertIn('STUB codeword=TEAL-42', made['reply'])
        session = made['sessionId']
        projects = self.temp / 'claude' / 'projects'
        old_folder = projects / claude_encoded(self.copy)
        self.assertTrue((old_folder / f'{session}.jsonl').is_file())
        self.assertIn(session, self.listed(CLAUDE_ACP, self.copy))
        self.assertNotIn(session, self.listed(CLAUDE_ACP, self.project), 'the problem: not listed for the project before')

        done = refile_cli('claude', self.state, projects, session, self.copy, self.project)
        self.assertEqual(done['outcome'], 'moved', done)
        self.assertTrue(pathlib.Path(done['backup']).is_file(), 'the backup is kept')
        self.assertTrue(pathlib.Path(done['backup']).is_relative_to(self.state / 'refiled' / 'claude'))
        filed = projects / claude_encoded(self.project) / f'{session}.jsonl'
        self.assertTrue(filed.is_file())
        cwds = {json.loads(line).get('cwd') for line in filed.read_text(encoding='utf-8').splitlines() if line.strip()} - {None}
        self.assertEqual({os.path.normcase(c) for c in cwds}, {os.path.normcase(str(self.project))}, 'every cwd is the project')

        mine = self.listed(CLAUDE_ACP, self.project)
        self.assertIn(session, mine, 'listed for the project by the agent itself')
        self.assertEqual(os.path.normcase(mine[session]['cwd']), os.path.normcase(str(self.project)))
        self.assertNotIn(session, self.listed(CLAUDE_ACP, self.copy))
        loaded = probe(CLAUDE_ACP, self.env, 'load', str(self.project), session, 'what is the codeword?')
        self.assertIn('STUB codeword=TEAL-42', loaded['reply'] or '', 'the history reached the model after the move')

        cleaned = refile_cli('clean', projects, self.state / 'worktrees')
        if old_folder.exists():  # Claude Code may keep memory/ or other files there: then the folder must stay
            self.assertIn(str(old_folder), [os.path.normpath(p) for p in cleaned['kept']])
        else:
            self.assertIn(str(old_folder), [os.path.normpath(p) for p in cleaned['removed']])
        self.assertTrue(filed.is_file(), 'the cleanup never deletes a transcript')

    @unittest.skipUnless(CODEX_ACP, 'needs the Codex ACP adapter')
    def test_codex_opened_once_in_project_is_listed_for_project(self):
        made = probe(CODEX_ACP, self.env, 'new', str(self.copy), 'the codeword is TEAL-42')
        session = made['sessionId']
        self.assertIn(session, self.listed(CODEX_ACP, self.copy))
        rollouts = list((self.temp / 'codex' / 'sessions').rglob(f'*-{session}.jsonl'))
        self.assertEqual(len(rollouts), 1, 'refileCodex backs this file up first')
        probe(CODEX_ACP, self.env, 'load', str(self.project), session)  # what refileCodex's load does: no prompt
        self.assertIn(session, self.listed(CODEX_ACP, self.project))
        self.assertNotIn(session, self.listed(CODEX_ACP, self.copy))


if __name__ == '__main__':
    unittest.main()
