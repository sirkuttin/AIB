"""e2e 0 of the "chats work in the project folder" plan (build-plan-1b section 8): a chat started in project P is listed for P by the
agent's OWN listing. Real agent adapters, the local stub model API (work/stub_model_api.js), temp config, no key, no network.

Two layers:
  AibFolderChatListingTest  a real AIB (deno-split web server + agent host) starts a Claude Code chat in a temp git project with
                            no `ownCopy` (1b: the project folder by default), with worktreePerChat off and on. AIB's own `discover` route asks the
                            agent (session/list cwd=P), and the chat must be there with cwd P. Under test AIB gives a real agent a
                            throwaway HOME / CLAUDE_CONFIG_DIR / CODEX_HOME (acp/connection.ts testHomeEnv), so the agent's
                            listing is read from that temp home, never the owner's.
                            Codex: `discover` is Claude/OMP only today, and testHomeEnv replaces CODEX_HOME with an empty folder,
                            so the stub's provider config cannot reach Codex through AIB yet (needs Codex in `discover` and a way
                            to seed config.toml; not in P1).
  AdapterFolderListingTest  the same goal one layer down, for Claude Code AND Codex: the adapter alone (work/acp_probe.js) makes a
                            session in P and its session/list for P has it, for another folder does not.

Guard: before and after, no entry for the temp project may appear in the owner's ~/.claude/projects or ~/.codex/sessions.

Skipped when an adapter is not installed. Adapters: AIB_CLAUDE_ACP / AIB_CODEX_ACP (path to the adapter's dist/index.js), else
the global npm install (`npm root -g`). `node` must be on PATH.
"""
import _isolation  # noqa: F401  (test isolation: temp state folder, real per-user folder blocked)
from _isolation import agent_mkdtemp
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import time
import unittest
import uuid

sys.path.insert(0, str(_isolation.TESTS / 'contract'))
import server_under_test  # noqa: E402
from _e2e_support import make_repo, run_git  # noqa: E402
from test_worktree_e2e import Chat, E2EFixture, wait_for  # noqa: E402

NO_WINDOW = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
STUB = _isolation.TESTS / 'stub_model_api.js'
PROBE = _isolation.TESTS / 'acp_probe.js'
NODE = shutil.which('node')
SERVER_KIND = server_under_test.server_kind()


def npm_root():
    npm = shutil.which('npm')
    if not npm:
        return None
    try:
        out = subprocess.run([npm, 'root', '-g'], capture_output=True, text=True, timeout=20, creationflags=NO_WINDOW, shell=os.name == 'nt')
        return pathlib.Path(out.stdout.strip()) if out.returncode == 0 and out.stdout.strip() else None
    except (OSError, subprocess.SubprocessError):
        return None


def adapter(env_name, package):
    named = os.environ.get(env_name)
    if named:
        return pathlib.Path(named) if pathlib.Path(named).is_file() else None
    root = npm_root()
    entry = root / package / 'dist' / 'index.js' if root else None
    return entry if entry and entry.is_file() else None


def claude_encoded(folder):
    """Claude Code's projects/<name> for a folder: every character that is not a letter or digit becomes '-'."""
    return re.sub(r'[^A-Za-z0-9]', '-', str(folder))


def owner_entries():
    """What a run could leave in the owner's real agent folders: ~/.claude/projects folder names and ~/.codex/sessions files."""
    home = pathlib.Path(os.path.expanduser('~'))
    projects = home / '.claude' / 'projects'
    sessions = home / '.codex' / 'sessions'
    names = set(p.name for p in projects.iterdir()) if projects.is_dir() else set()
    files = set(str(p) for p in sessions.rglob('*.jsonl')) if sessions.is_dir() else set()
    return names, files


class Stub:
    """The stub model API on a port the OS picks; stopped with the test."""

    def __init__(self, owner, folder):
        self.log = pathlib.Path(folder) / 'stub.log'
        self.process = subprocess.Popen([NODE, str(STUB), '--port', '0', '--log', str(self.log), '--stdin'], stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, encoding='utf-8',
                                        creationflags=NO_WINDOW)
        owner.addCleanup(self.stop)
        line = self.process.stdout.readline()
        match = re.match(r'STUB_PORT=(\d+)', line)
        if not match:
            raise AssertionError(f'stub did not start: {line!r}')
        self.port = int(match.group(1))
        self.url = f'http://127.0.0.1:{self.port}'

    def stop(self):
        try:
            self.process.stdin.close()
        except OSError:
            pass
        try:
            self.process.wait(5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(5)
        self.process.stdout.close()

    def calls(self):
        if not self.log.is_file():
            return []
        return [json.loads(line) for line in self.log.read_text(encoding='utf-8').splitlines() if line.strip()]


def stub_claude_env(base, stub):
    env = dict(base)
    for name in ('ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BEDROCK_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'):
        env.pop(name, None)
    env.update(ANTHROPIC_BASE_URL=stub.url, ANTHROPIC_API_KEY='stub-key', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1', DISABLE_AUTOUPDATER='1')
    return env


class OwnerGuard:
    def __init__(self, owner, *projects):
        self.projects = projects
        self.names, self.files = owner_entries()
        owner.addCleanup(self.check, owner)

    def check(self, owner):
        names, files = owner_entries()
        for project in self.projects:
            enc = claude_encoded(project)
            owner.assertNotIn(enc, names - self.names, "a test chat was filed in the owner's ~/.claude/projects")
        new_codex = files - self.files
        for path in new_codex:
            text = pathlib.Path(path).read_text(encoding='utf-8', errors='replace')[:20000]
            for project in self.projects:
                owner.assertNotIn(json.dumps(str(project))[1:-1], text, "a test chat was filed in the owner's ~/.codex/sessions")


CLAUDE_ACP = adapter('AIB_CLAUDE_ACP', '@agentclientprotocol/claude-agent-acp')
CODEX_ACP = adapter('AIB_CODEX_ACP', '@agentclientprotocol/codex-acp')


class RealClaudeFixture(E2EFixture):
    """The e2e fixture with the REAL Claude Code adapter as the `claude` launcher, run by node, talking to the stub."""
    stub = None

    def agent_flags(self):
        flags = super().agent_flags()
        flags[flags.index('--claude-launcher') + 1] = str(CLAUDE_ACP)
        flags[flags.index('--node-command') + 1] = NODE
        return flags

    def env(self):
        # The test guard (acp/connection.ts guardRealAgent) is lifted for this server only; testHomeEnv still gives the agent a
        # throwaway home, and the stub keeps it off the network.
        return dict(stub_claude_env(super().env(), self.stub), AGENT_STUDIO_ALLOW_REAL_AGENT='1')


@unittest.skipUnless(NODE and CLAUDE_ACP, 'needs node and the Claude Code ACP adapter (AIB_CLAUDE_ACP or a global npm install)')
@unittest.skipUnless(SERVER_KIND == 'deno-split', 'runs against AIB_SERVER=deno-split (the default)')
class AibFolderChatListingTest(unittest.TestCase):

    def test_chat_started_in_project_is_listed_for_project_by_claude(self):
        self.listed_for_project(worktrees_on=False)

    def test_new_chat_without_own_copy_is_listed_for_project_with_worktrees_on(self):
        # build plan 1b: no `ownCopy` and nothing else working in the project -> the chat runs in P even with worktreePerChat on
        self.listed_for_project(worktrees_on=True)

    def listed_for_project(self, worktrees_on):
        temp = pathlib.Path(agent_mkdtemp(prefix='aib-e0-'))
        self.addCleanup(shutil.rmtree, temp, True)
        stub = Stub(self, temp)
        project = make_repo(temp / f'proj-{uuid.uuid4().hex[:6]}')
        run_git(project, 'config', 'core.autocrlf', 'false')
        other = make_repo(temp / 'other')
        OwnerGuard(self, project, other)

        RealClaudeFixture.stub = stub
        fx = RealClaudeFixture(self)
        web = fx.start_web()
        # The old hidden flag no longer decides (1b): either way a new chat with no `ownCopy` works in the project folder.
        status, _ = web.post('settings', {'server': {'worktreePerChat': worktrees_on}})
        self.assertEqual(status, 200)
        status, connection = web.post('connect', {'provider': 'claude', 'cwd': str(project), 'background': True})
        self.assertEqual(status, 200, connection)
        chat = Chat(None, connection['id'], web)
        wait_for(lambda: chat.state().get('ready') or (chat.state().get('error') and self.fail(chat.state()['error'])), 'chat ready')
        self.assertEqual(os.path.normcase(chat.cwd), os.path.normcase(str(project)), 'no ownCopy: the chat runs in the folder')
        self.assertNotIn('worktree', chat.state(), 'no copy: live.worktree is absent')
        reply = chat.send('the codeword is TEAL-42')
        self.assertIn('STUB codeword=TEAL-42', reply)
        session = chat.session
        self.assertTrue(session)
        self.assertTrue(any(c['path'].endswith('/messages') for c in stub.calls()), 'the agent talked to the stub')

        status, found = web.post('discover', {'provider': 'claude', 'cwd': str(project)})
        self.assertEqual(status, 200, found)
        mine = [s for s in found['sessions'] if s['sessionId'] == session]
        self.assertEqual(len(mine), 1, found)
        self.assertEqual(os.path.normcase(mine[0]['cwd']), os.path.normcase(str(project)))
        status, elsewhere = web.post('discover', {'provider': 'claude', 'cwd': str(other)})
        self.assertEqual(status, 200, elsewhere)
        self.assertNotIn(session, [s['sessionId'] for s in elsewhere['sessions']])



def probe(entry, env, *args, timeout=180):
    out = subprocess.run([NODE, str(PROBE), str(entry), *args], capture_output=True, text=True, timeout=timeout, env=env,
                         creationflags=NO_WINDOW, stdin=subprocess.DEVNULL)
    lines = [line for line in out.stdout.splitlines() if line.strip().startswith('{')]
    if not lines:
        raise AssertionError(f'probe printed nothing: {out.stdout!r} {out.stderr[-2000:]!r}')
    result = json.loads(lines[-1])
    if 'error' in result:
        raise AssertionError(result)
    return result


@unittest.skipUnless(NODE, 'needs node')
class AdapterFolderListingTest(unittest.TestCase):
    """The agent's own listing for P, one layer below AIB: the adapter alone, temp CLAUDE_CONFIG_DIR / CODEX_HOME / HOME."""

    def setUp(self):
        self.temp = pathlib.Path(agent_mkdtemp(prefix='aib-e0a-'))
        self.addCleanup(shutil.rmtree, self.temp, True)
        self.stub = Stub(self, self.temp)
        self.project = make_repo(self.temp / f'proj-{uuid.uuid4().hex[:6]}')
        self.other = make_repo(self.temp / 'other')
        OwnerGuard(self, self.project, self.other)
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

    def check(self, entry):
        made = probe(entry, self.env, 'new', str(self.project), 'the codeword is TEAL-42')
        self.assertIn('STUB codeword=TEAL-42', made['reply'])
        listed = probe(entry, self.env, 'list', str(self.project))
        mine = [s for s in listed['sessions'] if s['sessionId'] == made['sessionId']]
        self.assertEqual(len(mine), 1, listed)
        self.assertEqual(os.path.normcase(mine[0]['cwd']), os.path.normcase(str(self.project)))
        elsewhere = probe(entry, self.env, 'list', str(self.other))
        self.assertNotIn(made['sessionId'], [s['sessionId'] for s in elsewhere['sessions']])
        return made['sessionId']

    @unittest.skipUnless(CLAUDE_ACP, 'needs the Claude Code ACP adapter')
    def test_claude(self):
        session = self.check(CLAUDE_ACP)
        filed = self.temp / 'claude' / 'projects' / claude_encoded(self.project) / f'{session}.jsonl'
        self.assertTrue(filed.is_file(), f'expected {filed}')

    @unittest.skipUnless(CODEX_ACP, 'needs the Codex ACP adapter')
    def test_codex(self):
        self.check(CODEX_ACP)
        self.assertTrue(any((self.temp / 'codex' / 'sessions').rglob('rollout-*.jsonl')))


if __name__ == '__main__':
    unittest.main()
