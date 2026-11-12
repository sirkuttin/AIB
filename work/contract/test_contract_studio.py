"""Contract, differential: the Studio routes of web_handler.py beyond the live and transcript ones (settings, conversation marks, editors,
folders, prompts, Changes, branch, worktree Merge and clash, the worktree tool route) give the same status and payload from the server
under test as from the Python reference, for the same inputs, including bad ones. Each server has its own state folder; temp folders and
a temp git repository stand in for projects.

Nothing here opens a real dialog or program: folders/pick is sent only requests that are refused before a picker would start, and open
only requests that are refused before a program would start (an unknown editor, or a path outside every project Studio knows)."""
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest
import urllib.parse

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from server_under_test import PY_REF, Server  # noqa: E402
from test_contract_transcripts import generate  # noqa: E402

VOLATILE = {'now', 'checkedAt', 'revision', 'instanceId', 'hostId', 'pid', 'updatedAt', 'createdAt', 'at', 'time'}
HAVE_GIT = shutil.which('git') is not None


def strip(value):
    if isinstance(value, dict):
        return {k: strip(v) for k, v in value.items() if k not in VOLATILE and not k.endswith('At')}
    if isinstance(value, list):
        return [strip(v) for v in value]
    return value


def git(repo, *args):
    subprocess.run(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', *args],
                   cwd=str(repo), check=True, capture_output=True, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))


def make_repo(root):
    repo = root / 'repo'
    repo.mkdir()
    git(repo, 'init', '-q', '-b', 'main')
    (repo / 'mod.txt').write_text('a\nb\nc\nd\n', encoding='utf-8')
    (repo / 'gone.txt').write_text('1\n2\n', encoding='utf-8')
    (repo / 'sub').mkdir()
    (repo / 'sub' / 'in.txt').write_text('x\n', encoding='utf-8')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'base')
    (repo / 'mod.txt').write_text('a\nB\nc\nd\ne\n', encoding='utf-8')
    (repo / 'gone.txt').unlink()
    (repo / 'new.txt').write_text('fresh\n', encoding='utf-8')
    return repo


class StudioContract(unittest.TestCase):
    maxDiff = None

    @classmethod
    def setUpClass(cls):
        cls.fixture = generate('subagents-fixture')
        claude = cls.fixture / 'claude'
        omp = cls.fixture / 'empty-omp'
        omp.mkdir(exist_ok=True)
        cls.root = pathlib.Path(tempfile.mkdtemp(prefix='aib-contract-studio-')).resolve()
        cls.repo = make_repo(cls.root) if HAVE_GIT else None
        cls.subject = Server(claude_dir=claude, omp_dir=omp).__enter__()
        cls.reference = Server(claude_dir=claude, omp_dir=omp, kind='python').__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.subject.__exit__(None, None, None)
        cls.reference.__exit__(None, None, None)
        shutil.rmtree(cls.root, ignore_errors=True)
        shutil.rmtree(cls.fixture, ignore_errors=True)

    def compare(self, a, b, what, normalize=None):
        def body(reply, server):
            data = json.loads(json.dumps(reply.json()).replace(json.dumps(str(server.state_dir))[1:-1], '<state>'))
            return strip(normalize(data, server) if normalize else data)
        self.assertEqual((a.status, body(a, self.subject)), (b.status, body(b, self.reference)), what)

    def same_get(self, path, normalize=None):
        a, b = self.subject.get(path), self.reference.get(path)
        self.compare(a, b, path, normalize)
        return a, b

    def same_post(self, path, body, normalize=None):
        a, b = self.subject.post(path, body), self.reference.post(path, body)
        self.compare(a, b, f'{path} {body}', normalize)
        return a, b

    # ---- settings and conversation marks ----
    def test_settings(self):
        # The Beta agents (server/agents/beta_catalog.ts) are Deno-only: drop their rows from the subject's lists before comparing.
        # So is the per-agent `setup` block (install prerequisites, server/agents/beta_setup.ts; commits 4db7392, 12e4d91 added it
        # to the built-in cards too): the Python reference has no such key, so drop it from the subject's agent rows.
        beta = {'copilot', 'opencode', 'gemini', 'qwen', 'cursor', 'goose', 'vibe', 'cline', 'kimi', 'kilo'}

        def no_beta(data, server):
            if server is not self.subject:
                return data
            def walk(v):
                if isinstance(v, dict):
                    return {k: walk(x) for k, x in v.items() if not (k == 'setup' and 'id' in v and 'installBlock' in v)}
                if isinstance(v, list):
                    return [walk(x) for x in v if not (isinstance(x, dict) and x.get('id') in beta)]
                return v
            return walk(data)
        same_get = lambda path: self.same_get(path, no_beta)
        same_post = lambda path, body: self.same_post(path, body, no_beta)
        same_get('/api/live/settings')
        same_get('/api/live/settings?recheck=0')
        for body in ({}, {'editors': {'default': 'nope'}}, {'appearance': {'defaultView': 'transcript'}}, {'appearance': 5},
                     {'agents': {'builtin': {'omp': False}}}, {'agents': {'custom': 'x'}}, {'launchers': {'claude': 7}}):
            same_post('/api/live/settings', body)
        same_get('/api/live/settings')
        same_post('/api/live/settings', {'agents': {'builtin': {'omp': True}}})

    def test_conversation_marks(self):
        for body in ({'action': 'pin', 'provider': 'claude', 'sessionId': 'mark-1', 'title': 'T', 'cwd': str(self.root)},
                     {'action': 'archive', 'provider': 'claude', 'sessionId': 'mark-1'},
                     {'action': 'restore', 'provider': 'claude', 'sessionId': 'mark-1'},
                     {'action': 'delete', 'provider': 'claude', 'sessionId': 'mark-2', 'title': 'gone'},
                     {'action': 'nope', 'provider': 'claude', 'sessionId': 'x'},
                     {'action': 'pin', 'provider': 5, 'sessionId': 'x'},
                     {'action': 'pin', 'provider': 'claude'}):
            self.same_post('/api/live/conversation-state', body)
        self.same_get('/api/live/conversation-state')

    # ---- editors (never started: unknown editor, or a path outside every known project) ----
    def test_editors(self):
        self.same_get('/api/live/editors')
        self.same_get('/api/live/editors?project=' + urllib.parse.quote(str(self.root)))   # not a known project
        self.same_get('/api/live/editors?project=%5C%5Cserver%5Cshare')
        listed = self.subject.get('/api/live/editors').json()['editors']
        known = next((e['id'] for e in listed if e.get('kind') == 'explorer'), None) or (listed[0]['id'] if listed else 'nope')
        outside = str(pathlib.Path(tempfile.gettempdir()).resolve())
        for body in ({}, {'editor': 5}, {'editor': 'nope', 'path': outside}, {'editor': known, 'kind': 'bogus', 'path': outside},
                     {'editor': known, 'path': outside, 'line': 0}, {'editor': known, 'path': outside, 'line': 'x'},
                     {'editor': known, 'path': outside}, {'editor': known, 'path': 'relative/path'},
                     {'editor': known, 'path': '\\\\server\\share'}, {'editor': known, 'kind': 'workspace', 'path': outside + '\\x.txt'},
                     {'editor': known, 'path': ''}):
            self.same_post('/api/live/open', body)

    # ---- folders (temp folders; the picker is never opened) ----
    def test_folders(self):
        bases = {id(self.subject): self.root / 's' / 'base', id(self.reference): self.root / 'r' / 'base'}
        for base in bases.values():
            base.mkdir(parents=True, exist_ok=True)

        def norm(data, server):
            text = json.dumps(data)
            for path, label in ((bases[id(server)], '<base>'), (bases[id(server)].parent, '<parent>')):
                text = text.replace(json.dumps(str(path))[1:-1], label)
            return json.loads(text)

        def both_get(fmt):
            a = self.subject.get(fmt.replace('<base>', urllib.parse.quote(str(bases[id(self.subject)]))))
            b = self.reference.get(fmt.replace('<base>', urllib.parse.quote(str(bases[id(self.reference)]))))
            self.compare(a, b, fmt, norm)

        def both_post(path, body):
            text = json.dumps(body)
            a = self.subject.post(path, json.loads(text.replace('<base>', json.dumps(str(bases[id(self.subject)]))[1:-1])))
            b = self.reference.post(path, json.loads(text.replace('<base>', json.dumps(str(bases[id(self.reference)]))[1:-1])))
            self.compare(a, b, f'{path} {body}', norm)

        self.same_get('/api/live/folders/start')
        for query in ('path=<base>', 'path=<base>%5Cnew-one', 'path=', 'path=relative', 'path=<base>%5Ccon', 'path=<base>%5Ca%3Fb',
                      'path=%5C%5Cserver%5Cshare'):
            both_get('/api/live/folders/check?' + query)
        for body in ({'path': '<base>\\made'}, {'path': '<base>\\made'}, {'path': '<base>\\with-git', 'gitInit': True}, {'path': 5},
                     {'path': '<base>\\x', 'gitInit': 'yes'}, {'path': 'relative'}, {'path': '<base>\\bad|name'}):
            both_post('/api/live/folders/create', body)
        both_get('/api/live/folders/start')
        for body in ({'path': '<base>\\made'}, {'path': '<base>\\missing'}, {'path': 5}, {}):
            both_post('/api/live/folders/remember', body)
        both_get('/api/live/folders/start')
        both_get('/api/live/folders/kinds?path=<base>%5Cmade&path=<base>%5Cwith-git')
        kinds = urllib.parse.quote(json.dumps([str(self.root / 'x'), 5, None]))
        self.same_get(f'/api/live/folders/kinds?paths={kinds}')
        self.same_get('/api/live/folders/kinds?paths=not-json')
        self.same_get('/api/live/folders/kinds')
        for body in ({'start': 5}, {'start': None}, {'start': ['x']}):   # refused before any picker starts
            self.same_post('/api/live/folders/pick', body)

    # ---- prompts ----
    def test_prompts(self):
        sessions = self.subject.get('/api/sessions').json()['sessions']
        self.assertTrue(sessions)
        for session in sessions[:4]:
            key = session['key']
            for query in ('', '&q=the', '&q=NOTHING', '&thinking=1', '&limit=1', '&limit=0', '&limit=5000', '&limit=abc', '&limit='):
                self.same_get(f'/api/live/prompts?key={urllib.parse.quote(key)}{query}')
        for query in ('', 'key=', 'key=nope', 'key=claude%2F..%2F..%2Fx', 'key=omp%2Fmissing'):
            self.same_get('/api/live/prompts?' + query)

    # ---- Changes, branch, worktree ----
    @unittest.skipUnless(HAVE_GIT, 'needs git')
    def test_changes_and_branch(self):
        repo = str(self.repo)
        self.same_post('/api/live/conversation-state', {'action': 'delete', 'provider': 'claude', 'sessionId': 'chg', 'cwd': repo})
        reply, _ = self.same_get('/api/live/changes?id=claude:chg')
        self.assertEqual(reply.status, 200, reply.text)   # the chat's folder is known (from its mark), so the repository is read
        for query in ('id=claude:chg', 'id=claude:chg&scope=branch', 'id=claude:chg&scope=nope', 'id=', 'id=claude:unknown', 'id=' + 'x' * 700):
            self.same_get('/api/live/changes?' + query)
        for name in ('mod.txt', 'new.txt', 'gone.txt', 'sub/in.txt', '../outside.txt', '', 'missing.txt'):
            self.same_get('/api/live/changes/file?id=claude:chg&path=' + urllib.parse.quote(name))
        a = self.subject.request('GET', '/api/live/changes?id=claude:chg', self.subject.page_headers(token=False))
        b = self.reference.request('GET', '/api/live/changes?id=claude:chg', self.reference.page_headers(token=False))
        self.compare(a, b, 'changes without a token')
        for query in ('cwd=' + urllib.parse.quote(repo), 'cwd=' + urllib.parse.quote(repo + '\\sub'), 'cwd=', 'cwd=%5C%5Cserver%5Cshare',
                      'cwd=' + urllib.parse.quote(str(self.root))):
            self.same_get('/api/live/branch?' + query)

    @unittest.skipUnless(HAVE_GIT, 'needs git')
    def test_worktree_routes(self):
        repo = str(self.repo)
        self.same_post('/api/live/conversation-state', {'action': 'delete', 'provider': 'claude', 'sessionId': 'wt', 'cwd': repo})
        for query in ('id=claude:wt', 'id=', 'id=nope'):
            self.same_get('/api/live/worktree?' + query)
        for query in ('project=' + urllib.parse.quote(repo), 'project=', 'project=' + urllib.parse.quote(str(self.root))):
            self.same_get('/api/live/worktree/clash?' + query)
        for body in ({'id': 'nope'}, {'id': 'claude:wt', 'title': 'x'}, {}, {'id': 5, 'title': 7}):
            self.same_post('/api/live/worktree/merge', body)
        for body in ({'id': 'nope', 'action': 'bogus'}, {'id': 'nope', 'action': 'keep-mine'}, {'id': 'nope', 'action': 'leave'}, {'id': 'nope'},
                     {'action': 'resume-sync', 'project': repo}, {'action': 'resume-sync', 'project': 5}, {'action': 'resume-sync'}):
            self.same_post('/api/live/worktree/clash', body)

    @unittest.skipUnless(HAVE_GIT, 'needs git')
    def test_resume_sync_shares_the_hosts_flag_file_and_lock(self):
        """Resume clears the pause flag the agent host's live sync wrote (worktree_sync.set_paused), in the same file, under the same
        cross-process lock: while the test process holds that lock the request waits, then succeeds."""
        import importlib
        import threading
        import time
        sys.path.insert(0, str(PY_REF))
        sync = importlib.import_module('worktree_sync')
        state_store = importlib.import_module('state_store')
        repo = str(self.repo)
        for server in (self.subject, self.reference):
            sync.set_paused(str(server.state_dir), repo, 1234)
        self.same_get('/api/live/worktree/clash?project=' + urllib.parse.quote(repo))
        self.assertTrue(self.subject.get('/api/live/worktree/clash?project=' + urllib.parse.quote(repo)).json().get('syncPaused'))
        for server in (self.subject, self.reference):
            lock = state_store.FileLock(pathlib.Path(server.state_dir) / 'locks' / 'sync-state.lock', 5)
            lock.acquire()
            threading.Timer(1.0, lock.release).start()
            started = time.monotonic()
            server.resume_reply = server.post('/api/live/worktree/clash', {'action': 'resume-sync', 'project': repo})
            server.resume_wait = time.monotonic() - started
            self.assertIsNone(sync.pause_info(str(server.state_dir), repo))
        self.compare(self.subject.resume_reply, self.reference.resume_reply, 'resume-sync')
        self.assertEqual(self.subject.resume_reply.json(), {'ok': True, 'resumed': True})
        self.assertGreater(self.subject.resume_wait, 0.7, 'the request did not wait for the lock')
        self.same_post('/api/live/worktree/clash', {'action': 'resume-sync', 'project': repo})   # nothing paused any more

    def test_update_routes(self):
        # 'desktop' is Deno-only (the reference is never the desktop app; updater_test.ts pyView drops it too): a source run says false.
        deno_only = lambda data, server: {k: v for k, v in data.items() if k != 'desktop'} if server is self.subject else data
        a, _ = self.same_get('/api/live/update', deno_only)
        if self.subject.effective_kind() in ('deno', 'deno-split'):
            self.assertIs(a.json()['desktop'], False)
        for body in ({'whenIdle': 'yes'}, {'cancelWait': True}, {'whenIdle': False}, {'whenIdle': True}):
            self.same_post('/api/live/update/install', body, deno_only)
        a, b = self.subject.post('/api/live/update/check', {}), self.reference.post('/api/live/update/check', {})
        self.compare(a, b, 'update/check', deno_only)
        self.same_get('/api/live/update', deno_only)

    def test_worktree_tool_route_gate(self):
        """The agent's merge route: the page token is not enough, a bad key is refused, a valid key reaches the merge (which refuses)."""
        import importlib
        sys.path.insert(0, str(PY_REF))
        keys = importlib.import_module('artifact_keys')

        def agent_post(server, body, key):
            headers = {'Host': f'127.0.0.1:{server.port}', 'X-Studio-Artifact-Key': key}
            return server.request('POST', '/api/live/worktree/tool', headers, body)

        def key_for(server, conversation):
            keys.configure(str(server.state_dir))
            return keys.issue(conversation) or ''
        for body in ({'conversationId': 'claude:nope'}, {'conversationId': 'claude:nope', 'action': 'keep_mine'},
                     {'conversationId': 'claude:nope', 'action': 'bogus'}):
            self.same_post('/api/live/worktree/tool', body)   # page token: refused
            a = agent_post(self.subject, body, 'not-a-key')
            b = agent_post(self.reference, body, 'not-a-key')
            self.compare(a, b, f'bad key {body}')
            a = agent_post(self.subject, body, key_for(self.subject, 'claude:nope'))
            b = agent_post(self.reference, body, key_for(self.reference, 'claude:nope'))
            self.compare(a, b, f'good key {body}')
            a = agent_post(self.subject, dict(body, conversationId='claude:other'), key_for(self.subject, 'claude:nope'))
            b = agent_post(self.reference, dict(body, conversationId='claude:other'), key_for(self.reference, 'claude:nope'))
            self.compare(a, b, f'key of another chat {body}')
        for server in (self.subject, self.reference):
            server.size_reply = server.request('POST', '/api/live/worktree/tool', {'Host': f'127.0.0.1:{server.port}'}, b'')
        self.compare(self.subject.size_reply, self.reference.size_reply, 'empty body')
        keys.configure(None)


if __name__ == '__main__':
    unittest.main()
