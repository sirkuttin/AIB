"""End-to-end tests of worktree-per-chat, one test per user flow.

Every test drives a real Studio the way the page does: a real agent host and a real web server (split mode)
over a temp state folder with server.worktreePerChat on, real temp git repos, and the fake ACP agent (fake_acp.py, which edits
files and commits in its folder on command). Everything goes through the HTTP API with the page token. No browser, no real agent.

Which server: AIB_SERVER, as for the contract suite (work/contract/server_under_test.py): deno-split (default: the Deno web server
and Deno agent host), deno (Deno, --in-process: the restart and takeover tests are skipped, there is no host to restart) or python
(the reference server in work/python-reference).
AIB_DENO names the deno executable if it is not on PATH. The registry is read from its file, as the page's side does, so no test
reaches into the server's own code.

Speed: a class shares one host and web server (every test uses its own project repo); the restart and takeover tests need their own.
Waits are conditions with generous deadlines, never fixed sleeps.
"""
import _isolation  # noqa: F401  (test isolation: temp state folder, real per-user folder blocked)
import json
import os
import pathlib
import subprocess
import sys
import time
import types
import unittest
import urllib.error
import urllib.parse
import urllib.request
import uuid

sys.path.insert(0, str(_isolation.PY_REF))
sys.path.insert(0, str(_isolation.TESTS / 'contract'))
import host_client
import server_under_test
import worktrees
from _e2e_support import FakeHost, Fixture, Web, make_repo, run_git

SERVER_KIND = server_under_test.server_kind()   # AIB_SERVER: deno-split (default), deno or python
LAUNCHER = _isolation.TESTS / 'worktree-e2e-agent.py'
LINES = 'a\nb\nc\nd\ne\nf\n'
WAIT = 90   # seconds: a deadline, not a delay


def wait_for(condition, what, seconds=WAIT):
    deadline = time.time() + seconds
    while True:
        value = condition()
        if value:
            return value
        if time.time() > deadline:
            raise AssertionError(f'Timed out waiting for {what}')
        time.sleep(0.05)


def quote(value):
    return urllib.parse.quote(str(value), safe='')


def split_only(reason):
    """These tests stop or replace the agent host separately from the web server: there is none to stop with --in-process."""
    return unittest.skipIf(SERVER_KIND == 'deno', f'AIB_SERVER=deno runs the agents in the web server ({reason}); AIB_SERVER=deno-split covers it')


class E2EFixture(Fixture):
    """The e2e fixture (_e2e_support.Fixture), with the plain fake agent as the `claude` launcher. The web server is the one
    AIB_SERVER names (work/contract/server_under_test.py): deno-split (default; main.ts serve, which starts the Deno agent host),
    deno (main.ts serve --in-process) or python (the reference, work/python-reference/studio.py, split mode). Each web server gets its own temp state folder and port; cleanup stops the
    host it started (host_client.stop_host, then its exact PID) and kills the web servers."""

    def agent_flags(self):
        flags = super().agent_flags()
        flags[flags.index('--claude-launcher') + 1] = str(LAUNCHER)
        return flags

    def env(self):
        """deno-split: AIB_KEEPER=0 (the split host is the fallback for a keeper that cannot run); deno: the keeper, always on,
        unless AIB_KEEPER=0 is set where the tests run."""
        env = dict(os.environ, AGENT_STUDIO_TEST='1')
        if SERVER_KIND == 'deno-split':
            env.setdefault('AIB_KEEPER', '0')
        return env

    def program(self):
        if SERVER_KIND == 'python':
            return [sys.executable, str(_isolation.PY_REF / 'studio.py')]
        if SERVER_KIND in ('deno', 'deno-split'):
            return [server_under_test.deno_executable(), 'run', '-A', '--quiet', str(_isolation.APP / 'server' / 'main.ts')]
        raise unittest.SkipTest(f'test_worktree_e2e runs against AIB_SERVER=python, deno or deno-split, not {SERVER_KIND!r}')

    def start_web(self, *extra, wait=True):
        """A web server on a port the OS picks (`--port 0`); Web.wait_ready reads it back from the server's log."""
        log = open(self.root / f'web-{len(self.logs)}.log', 'wb')
        self.logs.append(log)
        serve = ['serve', '--in-process'] if SERVER_KIND == 'deno' else (['serve'] if SERVER_KIND == 'deno-split' else [])
        process = subprocess.Popen([*self.program(), *serve, '--port', '0', *self.agent_flags(), '--host-idle-minutes', '0', *extra],
                                   cwd=str(_isolation.APP), stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                   env=self.env(), creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        self.processes.append(process)
        web = Web(process, 0, log.name)
        if wait:
            web.wait_ready(self)
        return web

    def run_cli(self, *args):
        return subprocess.run([*self.program(), *self.agent_flags(), *args], cwd=str(_isolation.APP), capture_output=True, text=True, timeout=60,
                              env=self.env(), creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))


class Chat:
    """One conversation, seen through the page's HTTP API."""

    def __init__(self, env, cid, web=None):
        self.env, self.id, self.web = env, cid, web

    def get_web(self):
        return self.web or self.env.web

    def state(self, after=None):
        path = f'/api/live/state?id={self.id}' + (f'&after={after}' if after is not None else '')
        status, data = self.get_web().get(path)
        assert status == 200, data
        return data

    @property
    def cwd(self):
        return self.state()['cwd']

    @property
    def project_root(self):
        return self.state()['projectRoot']

    @property
    def session(self):
        return self.state()['sessionId']

    def settle(self):
        """Let whatever the chat is doing finish (it asks permission for text the fake does not know, e.g. Studio's own guidance)."""
        def idle():
            state = self.state()
            for item in state['permissions']:
                self.get_web().post('permission', {'id': self.id, 'key': item['key'], 'option': 'yes'})
            return not state['busy'] and not state['permissions']
        wait_for(idle, f'chat {self.id} idle')

    def send(self, text, status=200, message_id=None):
        """One turn: send the text and return what the agent said. status != 200 expects the send to be refused (returns the payload)."""
        self.settle()
        before = self.state()['cursor']
        code, sent = self.get_web().post('prompt', {'id': self.id, 'text': text, 'clientMessageId': message_id or uuid.uuid4().hex})
        if status != 200:
            assert code == status, (code, sent)
            return sent
        assert code == 200, sent

        def finished():
            state = self.state(after=before)
            for item in state['permissions']:
                self.get_web().post('permission', {'id': self.id, 'key': item['key'], 'option': 'yes'})
            if state['busy'] or not any(e['kind'] == 'turn_end' for e in state['events']):
                return None
            return state
        state = wait_for(finished, f'the turn {text[:30]!r} to end')
        chunks = [e['data']['update']['content']['text'] for e in state['events']
                  if e['kind'] == 'update' and e['data']['update'].get('sessionUpdate') == 'agent_message_chunk']
        return ''.join(chunks)

    def events(self, kind):
        return [e['data'] for e in self.state(after=0)['events'] if e['kind'] == kind]

    def notes(self):
        return self.events('studio_note')

    def changes(self):
        status, data = self.get_web().get(f'/api/live/changes?id={self.id}&scope=uncommitted')
        assert status == 200, data
        return data

    def changed_paths(self):
        return sorted(f['path'] for f in self.changes()['files'])

    def worktree_status(self):
        status, data = self.get_web().get(f'/api/live/worktree?id={self.id}')
        assert status == 200, data
        return data

    def merge(self, title='T', status=200):
        code, data = self.get_web().post('worktree/merge', {'id': self.id, 'title': title})
        assert code == status, (code, data)
        return data

    def clash(self, action, status=200):
        code, data = self.get_web().post('worktree/clash', {'id': self.id, 'action': action})
        assert code == status, (code, data)
        return data

    def disconnect(self):
        assert self.get_web().post('disconnect', {'id': self.id})[0] == 200


class Env:
    """A host and web server over one temp state folder with worktreePerChat on, plus helpers to make projects and open chats."""

    def __init__(self, owner):
        shim = types.SimpleNamespace(addCleanup=owner.addClassCleanup if isinstance(owner, type) else owner.addCleanup, fail=owner.fail if not isinstance(owner, type) else None)
        self.fx = E2EFixture(shim)
        self.state, self.root = self.fx.state, self.fx.root.resolve()
        self.web = self.fx.start_web()
        status, _ = self.web.post('settings', {'server': {'worktreePerChat': True}})
        assert status == 200
        self.chats = []

    # ---- projects ----
    def project(self, name, files=None, git=True):
        folder = self.root / f'proj-{name}'
        if git:
            make_repo(folder)
            run_git(folder, 'config', 'core.autocrlf', 'false')
            if files:
                self.write(folder, files)
                run_git(folder, 'add', '-A')
                run_git(folder, 'commit', '-m', 'more files')
        else:
            folder.mkdir(parents=True)
            self.write(folder, files or {})
        return folder

    @staticmethod
    def write(folder, files, text=None):
        if isinstance(files, str):
            files = {files: text}
        for name, content in files.items():
            target = pathlib.Path(folder) / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content.encode('utf-8'))

    @staticmethod
    def read(folder, name):
        try:
            return (pathlib.Path(folder) / name).read_bytes().decode('utf-8')
        except OSError:
            return None

    # ---- chats ----
    def open_chat(self, project, resume=None, web=None, expect=200):
        web = web or self.web
        body = {'provider': 'claude', 'cwd': str(project), 'background': True}
        if resume:
            body['resume'] = resume
        status, connection = web.post('connect', body)
        if expect != 200:
            assert status == expect, (status, connection)
            return connection
        assert status == 200, connection
        chat = Chat(self, connection['id'], web)
        wait_for(lambda: chat.state().get('ready') or chat.state().get('error') and (_ for _ in ()).throw(AssertionError(chat.state()['error'])), 'chat ready')
        return chat

    def sync_ready(self, chat, project):
        """Live sync of this project is running: a throw-away file the user saves reaches the chat's copy. Returns once it has."""
        name = f'canary-{uuid.uuid4().hex[:6]}.txt'
        self.write(project, name, 'canary\n')
        wait_for(lambda: self.read(chat.cwd, name) == 'canary\n', 'live sync to start')
        return name

    # ---- the registry (the host owns it; reading the file is what the page's side does too) ----
    def records(self):
        return worktrees.Registry(self.state).all()

    def record(self, chat_or_path):
        path = chat_or_path if isinstance(chat_or_path, (str, pathlib.Path)) else chat_or_path.cwd
        for key, record in self.records().items():
            if os.path.normcase(os.path.realpath(record.get('path', ''))) == os.path.normcase(os.path.realpath(str(path))):
                return dict(record, key=key)
        return None

    def branches(self, project):
        return run_git(project, 'branch', '--list', 'studio/*', '--format=%(refname:short)').split()


def git(folder, *args):
    return run_git(folder, *args)


def porcelain(folder):
    return git(folder, 'status', '--porcelain=v1', '-uall')


def agent_text_has(text, *words):
    return all(word in text for word in words)


class Shared(unittest.TestCase):
    """One host and one web server for the whole class; each test makes its own project repo."""
    env = None

    @classmethod
    def setUpClass(cls):
        cls.env = Env(cls)

    def make(self, files=None, git=True):
        return self.env.project(self._testMethodName.replace('test_', '')[:40], files, git)

    def chat_in(self, project, **kw):
        return self.env.open_chat(project, **kw)


# ===================================================================================================================
class NewChatTests(Shared):
    def test_1_new_chat_gets_a_worktree_on_a_studio_branch(self):
        env, project = self.env, self.make()
        chat = self.chat_in(project)
        cwd = pathlib.Path(chat.cwd)
        slug = cwd.name
        self.assertEqual(cwd.parent, env.state / 'worktrees' / worktrees.repo_hash(project), 'under <state>/worktrees, one folder per repo')
        self.assertTrue(cwd.joinpath('tracked.txt').is_file())
        self.assertEqual(git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD').strip(), f'studio/{slug}')
        self.assertEqual(env.branches(project), [f'studio/{slug}'])
        self.assertEqual(git(project, 'rev-parse', '--abbrev-ref', 'HEAD').strip(), 'main', 'the project folder stays on its own branch')
        self.assertEqual(porcelain(project), '')
        self.assertIn(os.path.normcase(str(cwd)), os.path.normcase(git(project, 'worktree', 'list', '--porcelain').replace('/', os.sep)))
        state = chat.state()
        self.assertEqual((state['projectRoot'], state['cwd']), (str(project), str(cwd)))
        self.assertEqual(state['worktree'], {'branch': f'studio/{slug}', 'base': 'main'})
        listed = next(c for c in env.web.listing()['connections'] if c['id'] == chat.id)
        self.assertEqual((listed['projectRoot'], listed['worktree']), (str(project), {'branch': f'studio/{slug}', 'base': 'main'}), 'the sidebar card: one project, this branch')
        status, branch = env.web.get(f'/api/live/branch?cwd={quote(cwd)}')
        self.assertEqual((status, branch['branch']), (200, f'studio/{slug}'), 'the chat header label')
        self.assertEqual(chat.changes()['worktree'], {'branch': f'studio/{slug}'})
        record = env.record(chat)
        self.assertEqual((record['branch'], record['base'], record['status'], record['project']), (f'studio/{slug}', 'main', 'ready', str(project)))
        self.assertEqual(record['session'], f'claude:{chat.session}')

    def test_2_uncommitted_project_edits_are_copied_and_the_project_is_untouched(self):
        env = self.env
        project = self.make({'sub/deep.txt': 'deep\n'})
        env.write(project, {'tracked.txt': 'one\nedited\n', 'new.txt': 'brand new\n', 'sub/deep.txt': 'deep\nedited deep\n', 'sub/fresh/x.txt': 'x\n', 'ignored.log': 'ignored\n'})
        (project / 'image.bin').write_bytes(bytes(range(256)) * 20)
        before = {p: p.read_bytes() for p in project.rglob('*') if p.is_file() and '.git' not in p.parts}
        status_before = porcelain(project)
        head_before = git(project, 'rev-parse', 'HEAD')
        chat = self.chat_in(project)
        wt = chat.cwd
        self.assertEqual(env.read(wt, 'tracked.txt'), 'one\nedited\n')
        self.assertEqual(env.read(wt, 'new.txt'), 'brand new\n')
        self.assertEqual(env.read(wt, 'sub/deep.txt'), 'deep\nedited deep\n')
        self.assertEqual(env.read(wt, 'sub/fresh/x.txt'), 'x\n')
        self.assertEqual((pathlib.Path(wt) / 'image.bin').read_bytes(), bytes(range(256)) * 20)
        self.assertIsNone(env.read(wt, 'ignored.log'), 'ignored files are not copied')
        after = {p: p.read_bytes() for p in project.rglob('*') if p.is_file() and '.git' not in p.parts}
        self.assertEqual(after, before, 'the project folder is byte for byte unchanged')
        self.assertEqual((porcelain(project), git(project, 'rev-parse', 'HEAD'), env.branches(project)), (status_before, head_before, [f'studio/{pathlib.Path(wt).name}']))
        self.assertEqual(git(project, 'stash', 'list'), '')
        self.assertEqual(git(project, 'rev-parse', 'main'), head_before, 'main itself never moved: the copy is a side commit on the chat branch')

    def test_11_a_project_that_is_not_a_git_repository_runs_in_place(self):
        env = self.env
        project = self.make({'notes.txt': 'hello\n'}, git=False)
        before = set(env.records())
        chat = self.chat_in(project)
        state = chat.state()
        self.assertEqual((state['cwd'], state['projectRoot']), (str(project), str(project)))
        self.assertNotIn('worktree', state)
        self.assertNotIn('worktree', next(c for c in env.web.listing()['connections'] if c['id'] == chat.id))
        self.assertEqual(set(env.records()), before, 'no worktree registered')
        self.assertFalse((project / '.git').exists(), 'Studio never turns a plain folder into a repository')
        self.assertEqual(chat.send('edit:made.txt|by the agent\\n'), 'edited made.txt')
        self.assertEqual(env.read(project, 'made.txt'), 'by the agent\n', 'the agent works right in the folder')
        self.assertEqual(chat.worktree_status(), {'worktree': False})
        self.assertEqual(chat.send('say:still fine'), 'still fine')
        code, answer = env.web.post('worktree/merge', {'id': chat.id, 'title': 'T'})
        self.assertGreaterEqual(code, 400, 'nothing to merge in a chat without a worktree')


class ChangesTests(Shared):
    def test_3_changes_show_only_the_chats_own_work_even_after_it_commits(self):
        env = self.env
        project = self.make({'f.txt': LINES})
        env.write(project, {'tracked.txt': 'one\nuser edit\n', 'mine.txt': 'my own work\n'})   # the user's, before the chat: copied into its copy
        chat = self.chat_in(project)
        self.assertEqual(chat.changed_paths(), [], 'copied user edits are not the chat\'s changes')
        data = chat.changes()
        self.assertEqual((data['scope'], data['totals']['files']), ('branch', 0))
        chat.send('edit:chat.txt|one\\ntwo\\n')
        chat.send('edit:f.txt|CHAT\\nb\\nc\\nd\\ne\\nf\\n')
        self.assertEqual(chat.changed_paths(), ['chat.txt', 'f.txt'])
        chat.send('commit:the chat commit')
        data = chat.changes()
        self.assertEqual(sorted(f['path'] for f in data['files']), ['chat.txt', 'f.txt'], 'still shown once committed')
        by_path = {f['path']: f for f in data['files']}
        self.assertEqual((by_path['chat.txt']['status'], by_path['chat.txt']['added']), ('A', 2))
        self.assertEqual((by_path['f.txt']['added'], by_path['f.txt']['removed']), (1, 1))
        self.assertEqual(git(chat.cwd, 'status', '--porcelain=v1', '-uall', '--', 'chat.txt', 'f.txt'), '', 'really committed')
        # the user keeps saving: that is synced, and still not the chat's work
        env.sync_ready(chat, project)
        env.write(project, 'mine.txt', 'my own work\nsecond line\n')
        wait_for(lambda: env.read(chat.cwd, 'mine.txt') == 'my own work\nsecond line\n', 'the user\'s save in the copy')
        wait_for(lambda: 'mine.txt' in (env.record(chat).get('syncedPaths') or []), 'the save counted as the user\'s')   # the user base moves just after the file lands
        self.assertEqual(chat.changed_paths(), ['chat.txt', 'f.txt'])
        self.assertEqual(env.read(chat.cwd, 'tracked.txt'), 'one\nuser edit\n')
        status, diff = env.web.get(f'/api/live/changes/file?id={chat.id}&scope=uncommitted&path=f.txt')
        self.assertEqual(status, 200)
        self.assertIn('CHAT', json.dumps(diff))


class LiveSyncTests(Shared):
    def test_4_a_file_the_chat_has_not_touched_syncs_and_the_next_prompt_names_it(self):
        env = self.env
        project = self.make({'f.txt': LINES})
        chat = self.chat_in(project)
        canary = env.sync_ready(chat, project)
        started = time.time()
        env.write(project, 'f.txt', 'user\nb\nc\nd\ne\nf\n')
        wait_for(lambda: env.read(chat.cwd, 'f.txt') == 'user\nb\nc\nd\ne\nf\n', 'the saved file in the copy')
        self.assertLess(time.time() - started, 30, 'within the debounce (generous bound for a loaded machine)')
        self.assertEqual(env.read(project, 'f.txt'), 'user\nb\nc\nd\ne\nf\n', 'the project file is the user\'s own')
        wait_for(lambda: 'f.txt' in (env.record(chat).get('syncedPaths') or []), 'synced paths recorded')   # the user base moves just after the file lands
        self.assertEqual(chat.changed_paths(), [], 'a synced file is not the chat\'s change')
        said = chat.send('context')
        self.assertIn('<studio-context>', said)
        self.assertIn('The user changed these files since your last turn', said)
        self.assertIn('f.txt', said)
        self.assertIn(canary, said)
        self.assertEqual(chat.send('context'), 'CONTEXT none', 'told once, not on every turn')
        self.assertFalse([e for e in chat.events('user') if '<studio-context>' in e['text']], 'the note is not part of the user\'s message')

    def test_5a_a_file_both_edited_is_combined_when_the_lines_differ(self):
        env = self.env
        project = self.make({'f.txt': LINES})
        chat = self.chat_in(project)
        env.sync_ready(chat, project)
        chat.send('edit:f.txt|A-chat\\nb\\nc\\nd\\ne\\nf\\n')   # uncommitted: the chat has touched it
        env.write(project, 'f.txt', 'a\nb\nc\nd\ne\nF-user\n')
        wait_for(lambda: env.record(chat).get('pendingSync') == ['f.txt'], 'the clash candidate recorded')
        self.assertEqual(env.read(chat.cwd, 'f.txt'), 'A-chat\nb\nc\nd\ne\nf\n', 'not written under the chat while it is working on it')
        chat.send('say:next')   # the end of that turn combines the two
        wait_for(lambda: env.read(chat.cwd, 'f.txt') == 'A-chat\nb\nc\nd\ne\nF-user\n', 'both edits combined')
        record = wait_for(lambda: (lambda r: r if not r.get('pendingSync') else None)(env.record(chat)), 'nothing pending')
        self.assertEqual(record.get('syncConflicts') or [], [])
        self.assertEqual(chat.changed_paths(), ['f.txt'])
        self.assertEqual(env.read(project, 'f.txt'), 'a\nb\nc\nd\ne\nF-user\n', 'the project folder is never touched')
        self.assertNotEqual(chat.worktree_status()['state'], 'conflicts')

    def test_5b_edits_on_the_same_lines_clash_block_merge_and_resolving_clears_it(self):
        env = self.env
        project = self.make({'g.txt': LINES})
        chat = self.chat_in(project)
        env.sync_ready(chat, project)
        chat.send('edit:g.txt|X-chat\\nb\\nc\\nd\\ne\\nf\\n')
        env.write(project, 'g.txt', 'Y-user\nb\nc\nd\ne\nf\n')
        wait_for(lambda: env.record(chat).get('pendingSync') == ['g.txt'], 'the clash candidate recorded')
        chat.send('say:next')
        record = wait_for(lambda: (lambda r: r if r.get('syncConflicts') else None)(env.record(chat)), 'syncConflicts')
        self.assertEqual(record['syncConflicts'], ['g.txt'])
        marked = env.read(chat.cwd, 'g.txt')
        self.assertTrue('<<<<<<<' in marked and 'X-chat' in marked and 'Y-user' in marked, marked)
        self.assertEqual(env.read(project, 'g.txt'), 'Y-user\nb\nc\nd\ne\nf\n', 'the user\'s own file has no markers')
        status = chat.worktree_status()
        self.assertEqual((status['state'], status['enabled']), ('conflicts', False))
        self.assertIn('g.txt', status['message'])
        main_before = git(project, 'rev-parse', 'main').strip()
        refused = chat.merge(status=409)
        self.assertIn('g.txt', refused['error'])
        self.assertEqual(git(project, 'rev-parse', 'main').strip(), main_before, 'nothing landed on main')
        said = chat.send('context')
        self.assertIn('g.txt', said)
        self.assertRegex(said.lower(), r'clash|conflict')
        # the chat resolves it in its own copy
        chat.send('edit:g.txt|X-chat and Y-user\\nb\\nc\\nd\\ne\\nf\\n')
        chat.send('say:resolved')
        wait_for(lambda: not env.record(chat).get('syncConflicts'), 'the conflict cleared')
        status = wait_for(lambda: (lambda s: s if s['state'] != 'conflicts' else None)(chat.worktree_status()), 'Merge unblocked')
        self.assertEqual((status['state'], status['enabled']), ('ready', True))
        self.assertEqual(chat.send('context').count('<<<<<<<'), 0)


class MergeTests(Shared):
    def test_6_a_clean_merge_lands_only_the_chats_commits_and_keeps_the_users_edits(self):
        env = self.env
        project = self.make({'u.txt': 'u1\nu2\n'})
        env.write(project, 'u.txt', 'u1\nu2\nuser edit\n')   # before the chat: in its copy from the start
        chat = self.chat_in(project)
        wt = chat.cwd
        canary = env.sync_ready(chat, project)
        env.write(project, 'later.txt', 'saved later\n')
        wait_for(lambda: env.read(wt, 'later.txt') == 'saved later\n', 'later.txt synced')
        chat.send('edit:a.txt|first\\n')
        chat.send('commit:agent commit a')
        chat.send('edit:b.txt|uncommitted b\\n')
        before = git(project, 'rev-parse', 'main').strip()
        status = chat.worktree_status()
        self.assertEqual((status['state'], status['enabled']), ('ready', True))
        result = chat.merge('My title')
        self.assertEqual((result['state'], result['commits'], result['message']), ('merged', 2, 'Merged into main (2 commits)'))
        log = git(project, 'log', '--format=%s', f'{before}..main').splitlines()
        self.assertEqual(log, ['AIB: work from chat My title'], 'the user\'s synced edits moved the chat\'s base, so its work lands as one commit')
        tree = git(project, 'ls-tree', '-r', '--name-only', 'main').split()
        for name in ('a.txt', 'b.txt'):
            self.assertIn(name, tree)
        for name in (canary, 'later.txt'):
            self.assertNotIn(name, tree)
        self.assertEqual(git(project, 'show', 'main:u.txt'), 'u1\nu2\n', 'the user\'s edit never lands')
        # the user's unsaved edits survived stash, merge, unstash
        self.assertEqual(env.read(project, 'u.txt'), 'u1\nu2\nuser edit\n')
        self.assertEqual(env.read(project, 'later.txt'), 'saved later\n')
        self.assertEqual(env.read(project, 'a.txt'), 'first\n', 'the merged work is in the project folder')
        self.assertEqual(git(project, 'stash', 'list'), '', 'the stash Studio made is gone')
        self.assertEqual(git(project, 'ls-files', '-u'), '')
        porcelain_lines = sorted(porcelain(project).splitlines())
        self.assertIn(' M u.txt', porcelain_lines)
        self.assertEqual([l for l in porcelain_lines if l[3:] in ('a.txt', 'b.txt')], [], 'the merged work is committed, not left as uncommitted edits')
        # the chat's copy continues from the new base
        new_base = git(project, 'rev-parse', 'main').strip()
        self.assertEqual(git(wt, 'rev-parse', 'HEAD~1').strip(), new_base, 'reset to the new base (plus the side commit that holds the user\'s edits)')
        self.assertEqual(sorted(git(wt, 'diff', '--name-only', new_base, 'HEAD').split()), sorted(['u.txt', 'later.txt', canary]), 'that commit is only the user\'s edits')
        self.assertEqual(env.read(wt, 'u.txt'), 'u1\nu2\nuser edit\n', 'its copy still has the user\'s newest version')
        self.assertEqual(chat.changed_paths(), [])
        self.assertEqual(chat.worktree_status()['state'], 'nochanges')
        self.assertEqual([n['message'] for n in chat.notes()][-1], 'Merged into main (2 commits)')
        # a follow-up prompt works, and so does a second merge from the new base
        self.assertEqual(chat.send('say:go on'), 'go on')
        chat.send('edit:c.txt|second\\n')
        chat.send('commit:agent commit c')
        self.assertEqual(chat.merge()['message'], 'Merged into main (1 commit)')
        self.assertEqual(git(project, 'show', 'main:c.txt'), 'second\n')
        self.assertEqual(env.read(project, 'u.txt'), 'u1\nu2\nuser edit\n')

    def clashed_chat(self, name):
        """The user's uncommitted edit and the chat's commit hit the same line of tracked.txt: merging lands, re-applying the edit clashes."""
        env = self.env
        project = env.project(name)
        env.write(project, {'tracked.txt': 'user line\n', 'mine.txt': 'user only\n'})
        chat = self.chat_in(project)
        chat.send('edit:tracked.txt|chat line\\n')
        chat.send('commit:chat edit')
        result = chat.merge()
        self.assertEqual(result['state'], 'merged')
        self.assertEqual(result['clash'], ['tracked.txt'])
        chat.settle()
        return project, chat, result

    def test_7_when_re_applying_the_users_edits_clashes_the_note_guides_and_the_line_clears(self):
        env = self.env
        project, chat, result = self.clashed_chat('clash-resolve')
        note = [n for n in chat.notes() if n.get('actions')][-1]
        self.assertIn('tracked.txt', note['message'])
        self.assertIn(result['stash'], note['message'])
        self.assertEqual([(a['id'], a['label']) for a in note['actions']], [('keep-mine', 'Keep my version'), ('leave', "I'll sort it myself")])
        told = [e['text'] for e in chat.events('user')][-1]
        self.assertIn('tracked.txt', told, 'the chat is told, so it can offer to combine')
        self.assertIn(result['stash'], told)
        line = 'tracked.txt has unresolved edits. Ask the chat to fix it.'
        status, amber = env.web.get(f'/api/live/worktree/clash?project={quote(project)}')
        self.assertEqual((status, amber['unresolved'], amber['line'], amber['files']), (200, True, line, ['tracked.txt']))
        # "I'll sort it myself" changes nothing
        snapshot = (porcelain(project), git(project, 'stash', 'list'), env.read(project, 'tracked.txt'), git(project, 'rev-parse', 'main'))
        left = chat.clash('leave')
        self.assertTrue(left['ok'])
        self.assertIn(result['stash'], left['message'])
        self.assertEqual((porcelain(project), git(project, 'stash', 'list'), env.read(project, 'tracked.txt'), git(project, 'rev-parse', 'main')), snapshot)
        self.assertTrue(env.web.get(f'/api/live/worktree/clash?project={quote(project)}')[1]['unresolved'], 'the amber line stays until it is really resolved')
        # "Keep my version": the user's side wins and the line goes away
        kept = chat.clash('keep-mine')
        self.assertTrue(kept['ok'] and kept['dropped'], kept)
        self.assertEqual(env.read(project, 'tracked.txt'), 'user line\n')
        self.assertEqual(env.read(project, 'mine.txt'), 'user only\n')
        self.assertEqual(git(project, 'stash', 'list'), '')
        self.assertEqual(git(project, 'ls-files', '-u'), '')
        self.assertEqual(git(project, 'show', 'main:tracked.txt'), 'chat line\n', 'main holds the merged work')
        self.assertEqual(env.web.get(f'/api/live/worktree/clash?project={quote(project)}')[1], {'unresolved': False})
        self.assertEqual(chat.clash('keep-mine', status=404)['code'], 'no_clash')

    def test_7b_the_chat_combines_the_clash_itself_and_checks_it(self):
        env = self.env
        project, chat, result = self.clashed_chat('clash-combine')
        self.assertTrue(env.web.get(f'/api/live/worktree/clash?project={quote(project)}')[1]['unresolved'])
        markers = env.read(project, 'tracked.txt')
        self.assertIn('<<<<<<<', markers)
        said = chat.send('call-tool:check')
        self.assertTrue(said.startswith('TOOL 409'), 'markers are still in: not done. ' + said)
        self.assertTrue(env.web.get(f'/api/live/worktree/clash?project={quote(project)}')[1]['unresolved'])
        chat.send(f'write:{project / "tracked.txt"}|chat line\nuser line\n')   # the chat edits the file in the project folder
        said = chat.send('call-tool:check')
        self.assertTrue(said.startswith('TOOL 200'), said)
        self.assertIn('tracked.txt', said)
        self.assertEqual(env.web.get(f'/api/live/worktree/clash?project={quote(project)}')[1], {'unresolved': False})
        self.assertEqual(env.read(project, 'tracked.txt').replace('\r\n', '\n'), 'chat line\nuser line\n')   # (the fake writes in text mode: CRLF on Windows)
        self.assertEqual(len(git(project, 'stash', 'list').splitlines()), 1, 'the stash stays as a backup')

    def test_8_the_merge_tool_merges_with_its_own_key_and_is_refused_with_anothers(self):
        env = self.env
        project = self.make()
        mine, other = self.chat_in(project), self.chat_in(project)
        mine.send('edit:mine.txt|mine\\n')
        mine.send('commit:mine commit')
        other.send('edit:other.txt|other\\n')
        other.send('commit:other commit')
        main_before = git(project, 'rev-parse', 'main').strip()
        # another conversation's id with this chat's key
        said = other.send(f'call-tool:merge:{mine.id}')
        self.assertRegex(said, r'^TOOL 40[13] ', said)
        self.assertEqual(git(project, 'rev-parse', 'main').strip(), main_before, 'nothing merged')
        self.assertEqual(mine.worktree_status()['state'], 'ready', 'the other chat is untouched')
        # no permission yet (the user has not pressed "Merge into main"): the tool refuses and merges nothing
        said = mine.send('call-tool:merge')
        self.assertTrue(said.startswith('TOOL 409 '), said)
        self.assertIn('not_asked', said)
        self.assertEqual(git(project, 'rev-parse', 'main').strip(), main_before, 'nothing merged without the permission')
        self.assertEqual(mine.worktree_status()['state'], 'ready')
        # the press of the Merge button records the one-shot permission (and asks the chat to merge)
        code, asked = env.web.post('worktree/merge-request', {'id': mine.id})
        self.assertEqual(code, 200, asked)
        # another chat's key is still refused, now that this chat has the permission
        said = other.send(f'call-tool:merge:{mine.id}')
        self.assertRegex(said, r'^TOOL 40[13] ', said)
        self.assertEqual(git(project, 'rev-parse', 'main').strip(), main_before, 'nothing merged')
        # its own key merges its own chat, even while its own turn runs (the turn the button's message starts: a message id the
        # permission survives; a message the user types themselves would end it)
        said = mine.send('call-tool:merge', message_id='merge-request-e2e')
        self.assertTrue(said.startswith('TOOL 200 '), said)
        reply = json.loads(said[len('TOOL 200 '):])
        self.assertEqual((reply['state'], reply['message']), ('merged', 'Merged into main (1 commit)'))
        self.assertEqual(git(project, 'show', 'main:mine.txt'), 'mine\n')
        self.assertNotIn('other.txt', git(project, 'ls-tree', '-r', '--name-only', 'main'))
        self.assertEqual(git(mine.cwd, 'rev-parse', 'HEAD').strip(), git(project, 'rev-parse', 'main').strip())
        # no credentials at all, and a made-up key
        for headers in ({}, {'X-Studio-Artifact-Key': 'not-a-key'}):
            request = urllib.request.Request(f'http://127.0.0.1:{env.web.port}/api/live/worktree/tool', method='POST', data=json.dumps({'conversationId': other.id, 'action': 'merge'}).encode(),
                                             headers=dict({'Content-Type': 'application/json', 'Origin': f'http://127.0.0.1:{env.web.port}'}, **headers))
            with self.assertRaises(urllib.error.HTTPError) as caught:
                urllib.request.urlopen(request, timeout=30)
            self.assertIn(caught.exception.code, (401, 403), headers)
        self.assertEqual(other.worktree_status()['state'], 'ready', 'still not merged')


class DiscardArchiveTests(Shared):
    def test_9a_discard_removes_the_worktree_and_branch_and_the_chat_is_read_only(self):
        env = self.env
        project = self.make()
        chat = self.chat_in(project)
        chat.send('edit:work.txt|some work\\n')
        wt, session = chat.cwd, chat.session
        self.assertEqual(len(env.branches(project)), 1)
        code, refused = env.web.post('worktree-discard', {'id': chat.id})
        self.assertEqual(code, 400, 'one confirmation is required')
        self.assertTrue(os.path.isdir(wt))
        code, done = env.web.post('worktree-discard', {'id': chat.id, 'confirm': True})
        self.assertEqual((code, done['result'], done['removed']), (200, 'removed', True), done)
        wait_for(lambda: not os.path.exists(wt), 'the folder removed')
        self.assertEqual(env.branches(project), [])
        self.assertIsNone(env.record(wt))
        self.assertNotIn(pathlib.Path(wt).name, git(project, 'worktree', 'list', '--porcelain'))
        self.assertEqual(porcelain(project), '')
        for folder in (wt, str(project)):   # also from the project folder: never continued in the main checkout
            status, answer = env.web.post('connect', {'provider': 'claude', 'cwd': folder, 'resume': session})
            self.assertEqual(status, 400, folder)
            self.assertIn("This chat's workspace was removed; it can be read but not continued", answer['error'])
        status, _ = env.web.post('prompt', {'id': chat.id, 'text': 'say:hi', 'clientMessageId': uuid.uuid4().hex})
        self.assertGreaterEqual(status, 400, 'the discarded chat cannot be sent to')
        self.assertFalse(any(c['id'] == chat.id and not c.get('closed') for c in env.web.listing()['connections']))

    def archive(self, chat, action='archive'):
        provider, session = 'claude', chat.session
        return self.env.web.post('conversation-state', {'action': action, 'provider': provider, 'sessionId': session, 'title': 't'})

    def test_9b_archiving_a_chat_without_changes_cleans_up(self):
        env = self.env
        project = self.make()
        chat = self.chat_in(project)
        wt = chat.cwd
        self.assertEqual(len(env.branches(project)), 1)
        chat.disconnect()
        code, payload = self.archive(chat)
        self.assertEqual(code, 200, payload)
        self.assertEqual(payload['worktree']['removed'], True, payload)
        self.assertNotIn('keptChanges', payload['worktree'])
        wait_for(lambda: not os.path.exists(wt), 'the folder removed')
        self.assertEqual(env.branches(project), [])
        self.assertIsNone(env.record(wt))
        code, payload = self.archive(chat, 'unarchive')
        self.assertEqual(code, 200)
        self.assertNotIn('worktree', payload, 'unarchive brings the chat back and nothing else')

    def test_9c_archiving_a_chat_with_changes_keeps_them(self):
        env = self.env
        project = self.make()
        chat = self.chat_in(project)
        chat.send('edit:kept.txt|precious\\n')
        chat.send('commit:a commit')
        chat.send('edit:loose.txt|uncommitted\\n')
        wt, branch, session = chat.cwd, env.branches(project)[0], chat.session
        chat.disconnect()
        code, payload = self.archive(chat)
        self.assertEqual(code, 200, payload)
        self.assertEqual(payload['worktree'], {'branch': branch, 'removed': False, 'keptChanges': True})
        self.assertTrue(os.path.isdir(wt))
        self.assertEqual(env.branches(project), [branch])
        self.assertEqual(env.read(wt, 'loose.txt'), 'uncommitted\n')
        self.assertEqual(env.record(wt)['status'], 'ready')
        self.assertEqual(self.archive(chat, 'unarchive')[0], 200)
        resumed = self.chat_in(project, resume=session)
        self.assertEqual(resumed.cwd, wt, 'unarchived and continuable in the same copy')
        self.assertEqual(env.read(wt, 'kept.txt'), 'precious\n')


class TwoChatTests(Shared):
    def test_12_two_chats_in_one_project_each_get_a_copy_and_both_merge(self):
        env = self.env
        project = self.make({'shared.txt': LINES})
        one, two = self.chat_in(project), self.chat_in(project)
        self.assertNotEqual(one.cwd, two.cwd)
        self.assertEqual(len(set(env.branches(project))), 2)
        self.assertEqual({c['projectRoot'] for c in env.web.listing()['connections'] if c['id'] in (one.id, two.id)}, {str(project)}, 'one sidebar project')
        one.send('edit:one.txt|from one\\n')
        one.send('commit:commit one')
        two.send('edit:two.txt|from two\\n')
        two.send('commit:commit two')
        self.assertIsNone(env.read(one.cwd, 'two.txt'), 'each has its own copy')
        self.assertIsNone(env.read(two.cwd, 'one.txt'))
        first = one.merge('One')
        self.assertEqual(first['state'], 'merged')
        base_after_one = git(project, 'rev-parse', 'main').strip()
        self.assertEqual(two.worktree_status()['state'], 'ready')
        second = two.merge('Two')
        self.assertEqual(second['state'], 'merged', second)
        tree = git(project, 'ls-tree', '-r', '--name-only', 'main').split()
        self.assertIn('one.txt', tree)
        self.assertIn('two.txt', tree)
        log = git(project, 'log', '--format=%s', 'main').splitlines()
        self.assertIn('commit one', log)
        self.assertIn('commit two', log)
        self.assertEqual(git(project, 'merge-base', '--is-ancestor', base_after_one, 'main') or 'ok', 'ok', 'B was brought up to the new base before it landed')
        self.assertEqual(git(two.cwd, 'rev-parse', 'HEAD').strip(), git(project, 'rev-parse', 'main').strip())
        self.assertEqual(git(one.cwd, 'rev-parse', 'HEAD').strip(), base_after_one, 'A has not moved')
        self.assertEqual(env.read(project, 'one.txt'), 'from one\n')
        self.assertEqual(env.read(project, 'two.txt'), 'from two\n')
        self.assertEqual(porcelain(project), '')
        self.assertEqual(git(project, 'stash', 'list'), '')
        self.assertEqual(one.send('say:still here'), 'still here')


# ===================================================================================================================
class RestartTests(unittest.TestCase):
    """Each test has its own host: they stop and start processes."""

    def setUp(self):
        self.env = Env(self)

    def snapshot(self, project, wt):
        env = self.env
        record = {k: env.record(wt).get(k) for k in ('path', 'branch', 'base', 'snapshot', 'user', 'diffBase', 'status', 'session', 'project')}
        return {'record': record, 'branches': env.branches(project), 'head': git(wt, 'rev-parse', 'HEAD'), 'main': git(project, 'rev-parse', 'main'),
                'status': porcelain(wt), 'project_status': porcelain(project), 'worktrees': git(project, 'worktree', 'list', '--porcelain')}

    def work(self, name):
        env = self.env
        project = env.project(name)
        chat = env.open_chat(project)
        chat.send('edit:committed.txt|safe\\n')
        chat.send('commit:committed work')
        chat.send('edit:loose.txt|not committed\\n')
        return project, chat

    @split_only('no separate web server to restart')
    def test_10a_restarting_only_the_web_server_reattaches_with_nothing_changed(self):
        env = self.env
        project, chat = self.work('web-restart')
        wt = chat.cwd
        before, host_pid = self.snapshot(project, wt), host_client.read_info(env.state)['pid']
        changed_before = chat.changed_paths()
        old = env.web
        old.kill()
        self.assertTrue(host_client.pid_alive(host_pid), 'the host outlives the web server')
        web = env.fx.start_web()
        env.web = web
        self.assertEqual(web.boot['hostPid'], host_pid)
        self.assertEqual(web.boot['connections'], [chat.id])
        again = Chat(env, chat.id, web)
        state = again.state()
        self.assertEqual((state['cwd'], state['projectRoot'], state['worktree']), (before['record']['path'], str(project), {'branch': before['record']['branch'], 'base': 'main'}))
        self.assertEqual(self.snapshot(project, wt), before)
        self.assertEqual(again.changed_paths(), changed_before)
        self.assertEqual(again.worktree_status()['state'], 'ready')
        self.assertEqual(again.send('say:after restart'), 'after restart')
        self.assertEqual(again.merge()['state'], 'merged')
        self.assertEqual(git(project, 'show', 'main:committed.txt'), 'safe\n')

    @split_only('no separate agent host to restart')
    def test_10b_restarting_the_agent_host_keeps_worktrees_and_branches(self):
        env = self.env
        project, chat = self.work('host-restart')
        wt = chat.cwd
        session = chat.session
        before = self.snapshot(project, wt)
        old_pid = host_client.read_info(env.state)['pid']
        env.web.kill()
        stopped = env.fx.run_cli('--stop-host')
        self.assertEqual(stopped.returncode, 0, stopped.stdout + stopped.stderr)
        wait_for(lambda: not host_client.pid_alive(old_pid), 'the host stopped')
        web = env.fx.start_web()
        env.web = web
        self.assertNotEqual(web.boot['hostPid'], old_pid, 'a new host')
        after = self.snapshot(project, wt)
        self.assertEqual(after, before, 'worktree, branch, registry and files are all intact')
        self.assertEqual(env.read(wt, 'loose.txt'), 'not committed\n')

        # The new host reopens the chat by itself (durable recovery); if it has not, the sidebar's resume does the same. Either way: the same copy.
        def recovered():
            return next((c for c in web.listing()['connections'] if c.get('sessionId') == session and c.get('ready')), None)
        try:
            found = wait_for(recovered, 'the chat recovered by the new host', seconds=20)
            resumed = Chat(env, found['id'], web)
        except AssertionError:
            resumed = env.open_chat(project, resume=session)
        self.assertEqual(resumed.cwd, wt, 'continues in the same copy')
        self.assertEqual(resumed.state()['worktree'], {'branch': before['record']['branch'], 'base': 'main'})
        self.assertEqual(resumed.changed_paths(), ['committed.txt', 'loose.txt'])
        self.assertEqual(self.snapshot(project, wt), before, 'reopening changed nothing')
        self.assertEqual(resumed.send('say:back'), 'back')
        self.assertEqual(resumed.merge()['state'], 'merged')
        self.assertEqual(git(project, 'show', 'main:committed.txt'), 'safe\n')

    def test_10c_a_worktree_folder_deleted_by_hand_is_recreated_from_its_branch_on_resume(self):
        env = self.env
        project, chat = self.work('hand-delete')
        wt, branch, session = chat.cwd, env.record(chat)['branch'], chat.session
        chat.disconnect()
        import shutil
        import stat

        def force(function, target, _info):
            os.chmod(target, stat.S_IWRITE)
            function(target)

        def gone():
            if not os.path.exists(wt):
                return True
            try:
                shutil.rmtree(worktrees._fs(wt), onerror=force)
            except OSError:
                return False
            return not os.path.exists(wt)
        wait_for(gone, 'the worktree folder deleted by hand')
        self.assertEqual(env.branches(project), [branch], 'the branch is still there')
        resumed = env.open_chat(project, resume=session)
        self.assertEqual(resumed.cwd, wt, 'the same place')
        self.assertTrue(os.path.isdir(wt))
        self.assertEqual(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD').strip(), branch)
        self.assertEqual(env.read(wt, 'committed.txt'), 'safe\n', 'what the chat committed came back')
        self.assertIn(pathlib.Path(wt).name, git(project, 'worktree', 'list', '--porcelain'))
        self.assertEqual(env.record(wt)['status'], 'ready')
        self.assertEqual(resumed.state()['worktree'], {'branch': branch, 'base': 'main'})
        self.assertEqual(resumed.send('say:alive'), 'alive')
        self.assertEqual(resumed.merge()['state'], 'merged')
        self.assertEqual(git(project, 'show', 'main:committed.txt'), 'safe\n')


@split_only('an in-process server never looks for an agent host to take over')
class TakeoverTests(unittest.TestCase):
    """A real web server that finds an agent host from another code folder (fake hosts, in temp folders only)."""

    def fixture(self):
        return E2EFixture(self)

    def test_13a_an_idle_host_from_another_code_root_is_taken_over(self):
        fx = self.fixture()
        old = FakeHost(fx.state, 0, app_id='dev.aib.app')
        self.addCleanup(old.close)
        web = fx.start_web()
        self.assertEqual(web.boot['hostMode'], 'split')
        self.assertTrue(old.stopped, 'the idle foreign host was asked to stop')
        self.assertIn('stop', old.calls)
        self.assertNotEqual(web.boot['hostPid'], old.proc.pid, 'a host of our own now')
        self.assertEqual(host_client.read_info(fx.state)['codeRoot'], host_client.CODE_ROOT)
        self.assertEqual(web.boot.get('hostTakeoverWaiting', 0), 0)
        self.assertTrue(host_client.pid_alive(web.boot['hostPid']))
        status, payload = web.post('settings', {'server': {'worktreePerChat': True}})
        project = make_repo(fx.root.resolve() / 'proj-takeover')
        status, connection = web.post('connect', {'provider': 'claude', 'cwd': str(project), 'background': True})
        self.assertEqual(status, 200, connection)
        chat = Chat(types.SimpleNamespace(), connection['id'], web)
        wait_for(lambda: chat.state().get('ready'), 'chat ready on the new host')
        self.assertIn('worktree', chat.state())

    def test_13b_a_busy_host_is_not_taken_over_and_is_waited_for(self):
        fx = self.fixture()
        old = FakeHost(fx.state, 2)
        self.addCleanup(old.close)
        web = fx.start_web()
        self.assertEqual(web.boot['hostTakeoverWaiting'], 2, 'the banner: waiting for 2 chats')
        self.assertFalse(old.stopped, 'a busy host is never stopped')
        self.assertTrue(host_client.pid_alive(old.proc.pid))
        self.assertEqual(host_client.read_info(fx.state)['pid'], old.proc.pid, 'its file is still the live one')
        self.assertNotEqual(web.boot.get('hostMode'), 'split-own')
        old.active = 0   # its chats finish: the web server switches over by itself
        wait_for(lambda: web.get('/api/live/bootstrap')[1].get('hostTakeoverWaiting') == 0 and old.stopped, 'the takeover once the chats finished')
        wait_for(lambda: host_client.read_info(fx.state) and host_client.read_info(fx.state)['pid'] != old.proc.pid, 'a host of our own')


if __name__ == '__main__':
    unittest.main()
