"""Subagent worktrees, Gemini CLI part: e2e with the REAL Gemini CLI over ACP (as AIB launches it) against the local Gemini API stub
(work/gemini_stub_api.js, model pinned with GEMINI_MODEL so the router never calls), temp config only. Design: private
designs/subagent-worktrees/gemini-proof.md; code: server/subagents/gemini.ts.

  GeminiRedirectTest   a real AIB (deno-split web server + agent host) starts a Gemini chat (API-key sign-in) in a temp git project.
                       The parent writes parent-made.txt, then invokes the generalist subagent, which writes sub-made.txt (a path
                       relative to the folder) and finishes.
                         - the subagent's write was moved into its worktree (Gemini told the subagent its input was changed by a
                           hook; the folder never had the file while it ran: it arrives only as AIB's landing commit)
                         - at the parent's turn end it lands in the folder as one AIB commit; the record and worktree go
                         - the parent is unaffected: its own write is in the folder, uncommitted
                         - the chat home is AIB's (its settings have AIB's hook); the "user's" Gemini settings file is unchanged
  GeminiFenceTest      the same play with hooks off in the user's Gemini settings: the fence alone. The subagent's write is denied
                       by AIB's policy (Gemini's "denied by policy" text with AIB's reason reaches the subagent), nothing is written
                       anywhere, the parent's own write works, and the chat says up front that subagent edits are off.
  Both: the owner's ~/.gemini (listing, mtimes), ~/.claude settings and projects, ~/.codex config, hooks and sessions are untouched
  (not ~/.claude.json: the owner's own running Claude Code sessions rewrite it). The chat runs in yolo in a folder the user trusted:
  Gemini 0.68 itself refuses invoke_agent in its default ACP mode, with or without AIB (checked with no --admin-policy).
  The redirect test also checks the Activity card (from the invoke_agent call: running, then completed) and its worktree line.

Needs node, Go (the keeper program is built from keeper/ into a temp folder; AIB_TEST_KEEPER_BIN names a built one) and the Gemini
CLI 0.68 package folder (AIB_GEMINI_CLI = the folder holding node_modules/@google/gemini-cli; default: .gem-scratch/gemini-cli in
this worktree). Run with TEMP/TMP pointed at a scratch folder.
"""
import _isolation  # noqa: F401  (test isolation: temp state folder, real per-user folder blocked)
import json
import re
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import uuid

sys.path.insert(0, str(_isolation.TESTS / 'contract'))
import server_under_test  # noqa: E402
from _e2e_support import make_repo, run_git  # noqa: E402
from test_worktree_e2e import Chat, E2EFixture, wait_for  # noqa: E402
from test_subagent_worktree_e2e import GO, NO_WINDOW, keeper_program  # noqa: E402
from test_folder_chat_listing_e2e import NODE  # noqa: E402

STUB = _isolation.TESTS / 'gemini_stub_api.js'
SERVER_KIND = server_under_test.server_kind()
GEMINI_CLI = pathlib.Path(os.environ.get('AIB_GEMINI_CLI') or (_isolation.REPO / '.gem-scratch' / 'gemini-cli'))
GEMINI_PKG = GEMINI_CLI / 'node_modules' / '@google' / 'gemini-cli'
FENCE_TEXT = "AIB: this subagent can't change files in the project folder."
OFF_LINE = 'Subagents that edit files are off in this Gemini chat: hooks are off in your Gemini settings.'


def owner_state():
    """What a run must not change: the owner's ~/.gemini (listing and mtimes), ~/.claude settings and projects, ~/.codex config and
    sessions."""
    home = pathlib.Path(os.path.expanduser('~'))
    out = {}
    gem = home / '.gemini'
    out['gemini'] = sorted((p.name, p.stat().st_mtime) for p in gem.iterdir()) if gem.is_dir() else None
    # not ~/.claude.json: the owner's own running Claude Code sessions rewrite it all the time
    for f in (home / '.claude' / 'settings.json', home / '.claude' / 'settings.local.json', home / '.codex' / 'config.toml',
              home / '.codex' / 'hooks.json'):
        out[str(f)] = f.stat().st_mtime if f.exists() else None
    projects = home / '.claude' / 'projects'
    out['claude_projects'] = sorted(p.name for p in projects.iterdir()) if projects.is_dir() else []
    sessions = home / '.codex' / 'sessions'
    out['codex_sessions'] = sum(1 for _ in sessions.rglob('*.jsonl')) if sessions.is_dir() else 0
    return out


def script(run):
    """The play: the parent writes, then invokes the generalist; the subagent writes a relative path and finishes."""
    return {'rules': [
        {'when': f'GX-PARENT-{run}', 'tools': ['invoke_agent'],
         'reply': {'call': {'name': 'write_file', 'args': {'file_path': 'parent-made.txt', 'content': f'PARENT {run}\n'}}}},
        {'when': 'functionResponse', 'tools': ['invoke_agent'],
         'reply': {'call': {'name': 'invoke_agent', 'args': {'agent_name': 'generalist', 'prompt': f'GX-SUB-{run} write the file'}}}},
        {'when': f'GX-SUB-{run}', 'in': 'any', 'tools': ['complete_task'],
         'reply': {'call': {'name': 'write_file', 'args': {'file_path': 'sub-made.txt', 'content': f'SUB {run}\n'}}}},
        {'when': 'functionResponse', 'in': 'last', 'tools': ['complete_task'],
         'reply': {'call': {'name': 'complete_task', 'args': {'result': f'SUB-DONE {run}'}}}},
        {'when': 'functionResponse', 'tools': ['invoke_agent'], 'reply': {'text': f'PARENT-DONE {run}'}},
    ]}


class Stub:
    def __init__(self, owner, folder, run):
        sc = pathlib.Path(folder) / 'script.json'
        sc.write_text(json.dumps(script(run)), encoding='utf-8')
        self.log = pathlib.Path(folder) / 'stub.log'
        self.process = subprocess.Popen([NODE, str(STUB), '--script', str(sc), '--log', str(self.log), '--stdin'],
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
                                        encoding='utf-8', creationflags=NO_WINDOW)
        owner.addCleanup(self.stop)
        line = self.process.stdout.readline()
        if not line.startswith('STUB_PORT='):
            raise AssertionError(f'stub did not start: {line!r}')
        self.port = int(line.strip().split('=')[1])

    def stop(self):
        try:
            self.process.stdin.close()
            self.process.wait(timeout=10)
        except Exception:
            self.process.kill()

    def text(self):
        return self.log.read_text(encoding='utf-8') if self.log.is_file() else ''


def install_gemini(state):
    """AIB's own install layout (<state>/agents/gemini/<version>, with .complete) as a junction to the test's Gemini CLI folder, so
    AIB launches it as `node <entry> --acp` (AIB checks the entry's real path stays inside the version folder)."""
    base = pathlib.Path(state) / 'agents' / 'gemini'
    base.mkdir(parents=True, exist_ok=True)
    link = base / '0.68.0'
    (GEMINI_CLI / '.complete').write_text('', encoding='utf-8')
    if not link.exists():
        if os.name == 'nt':
            subprocess.run(['cmd', '/c', 'mklink', '/J', str(link), str(GEMINI_CLI)], check=True, capture_output=True, creationflags=NO_WINDOW)
        else:
            link.symlink_to(GEMINI_CLI, target_is_directory=True)
    return link


def unlink_junction(link):
    try:
        os.rmdir(link) if os.name == 'nt' else pathlib.Path(link).unlink()  # the link only, never its target
    except OSError:
        pass


@unittest.skipUnless(NODE and GEMINI_PKG.is_dir(), 'needs node and the Gemini CLI package (AIB_GEMINI_CLI)')
@unittest.skipUnless(GO or os.environ.get('AIB_TEST_KEEPER_BIN'), 'needs Go to build the keeper program (or AIB_TEST_KEEPER_BIN)')
@unittest.skipUnless(SERVER_KIND == 'deno-split', 'runs against AIB_SERVER=deno-split (the default)')
class GeminiSubagentCase(unittest.TestCase):
    hooks_off = False

    def play(self):
        temp = pathlib.Path(tempfile.mkdtemp(prefix='aib-srg-'))
        self.addCleanup(shutil.rmtree, temp, True)
        run = uuid.uuid4().hex[:8]
        project = make_repo(temp / f'srg{run}')
        run_git(project, 'config', 'core.autocrlf', 'false')
        before = owner_state()
        def owner_untouched():
            after = owner_state()
            changed = sorted(k for k in set(before) | set(after) if before.get(k) != after.get(k))
            self.assertEqual(changed, [], "the owner's ~/.gemini, ~/.claude or ~/.codex changed")
        self.addCleanup(owner_untouched)
        user_home = temp / 'user-gemini-home'  # "the user's" Gemini home (GEMINI_CLI_HOME): never the owner's
        (user_home / '.gemini' / 'tmp').mkdir(parents=True)
        user_settings = {'general': {'checkpointing': {'enabled': False}}}
        if self.hooks_off:
            user_settings['hooksConfig'] = {'enabled': False}
        # the user trusted this folder (Gemini allows yolo only in a trusted folder): their trustedFolders.json
        (user_home / '.gemini' / 'trustedFolders.json').write_text(json.dumps({str(project): 'TRUST_FOLDER'}), encoding='utf-8')
        settings_file = user_home / '.gemini' / 'settings.json'
        settings_file.write_text(json.dumps(user_settings), encoding='utf-8')
        settings_before = settings_file.read_bytes()
        stub = Stub(self, temp, run)
        keeper = keeper_program(temp)
        (temp / 'tmp').mkdir()

        class Fixture(E2EFixture):
            def agent_flags(self):
                flags = super().agent_flags()
                flags[flags.index('--node-command') + 1] = NODE  # AIB runs its own Gemini install with node
                return flags

            def env(self):
                env = super().env()
                for k in ('GOOGLE_API_KEY', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_GENAI_USE_VERTEXAI'):
                    env.pop(k, None)
                env.update(AGENT_STUDIO_ALLOW_REAL_AGENT='1', AIB_KEEPER_BIN=str(keeper), GEMINI_CLI_HOME=str(user_home),
                           GEMINI_API_KEY='fake-key', GOOGLE_GEMINI_BASE_URL=f'http://127.0.0.1:{stub.port}',
                           GEMINI_CLI_AUTH_OVERRIDE='gemini-api-key', GEMINI_MODEL='gemini-2.5-flash', NO_BROWSER='1')
                for name in ('TEMP', 'TMP', 'TMPDIR'):
                    env[name] = str(temp / 'tmp')
                return env

        fx = Fixture(self)
        installed = install_gemini(fx.state)
        self.addCleanup(unlink_junction, installed)  # before the state folder is removed: never delete through the junction
        web = fx.start_web()
        status, connection = web.post('connect', {'provider': 'gemini', 'cwd': str(project), 'background': True})
        self.assertEqual(status, 200, connection)
        chat = Chat(None, connection['id'], web)
        wait_for(lambda: chat.state().get('ready') or (chat.state().get('error') and self.fail(chat.state()['error'])), 'chat ready', seconds=120)
        # Gemini 0.68 itself refuses invoke_agent in its default ACP mode, with or without AIB ("Tool execution for "Generalist
        # Agent" denied by policy": checked with no --admin-policy); in yolo it runs subagents. The fence must hold there too.
        code, changed = web.post('mode', {'id': chat.id, 'modeId': 'yolo'})
        self.assertEqual(code, 200, changed)
        code, _ = web.post('prompt', {'id': chat.id, 'text': f'GX-PARENT-{run} go', 'clientMessageId': uuid.uuid4().hex})
        self.assertEqual(code, 200)

        def approve_all():
            for item in chat.state()['permissions']:
                options = (item.get('params') or {}).get('options') or []
                allow = next((o['optionId'] for o in options if o.get('kind') == 'allow_once'), None)
                if allow:
                    chat.get_web().post('permission', {'id': chat.id, 'key': item['key'], 'option': allow})

        def ended():
            approve_all()
            state = chat.state()
            return not state['busy'] and any(e['kind'] == 'turn_end' for e in state['events'])
        wait_for(ended, 'the parent turn to end', seconds=240)
        self.assertIn(f'PARENT-DONE {run}', stub.text())
        self.assertEqual(settings_file.read_bytes(), settings_before, "the user's Gemini settings were written")
        return fx, chat, project, stub, run, user_home


class GeminiRedirectTest(GeminiSubagentCase):

    def test_subagent_write_lands_in_its_worktree_then_at_turn_end(self):
        fx, chat, project, stub, run, user_home = self.play()
        log = stub.text()
        # the subagent's write ran, with its file_path moved by AIB's hook (Gemini says so in the subagent's tool result)
        self.assertIn('were modified by a hook', log)
        self.assertNotIn('denied by policy', log)
        # parent unaffected: its own write is in the folder, uncommitted
        self.assertEqual((project / 'parent-made.txt').read_text(encoding='utf-8'), f'PARENT {run}\n')
        # at turn end the subagent's work lands as AIB's commit (the swarm landing), and nothing else of the parent's is committed
        wait_for(lambda: (project / 'sub-made.txt').is_file() and 'sub-made.txt' in run_git(project, 'show', '--name-only', '--format=%s', 'HEAD'),
                 'the subagent work to land', seconds=120)
        self.assertEqual((project / 'sub-made.txt').read_text(encoding='utf-8'), f'SUB {run}\n')
        subject = run_git(project, 'log', '-1', '--format=%s')
        self.assertIn('subagent', subject.lower())
        files = run_git(project, 'show', '--name-only', '--format=', 'HEAD').split()
        self.assertEqual(files, ['sub-made.txt'], 'only the subagent file landed')
        self.assertIn('?? parent-made.txt', run_git(project, 'status', '--porcelain'))
        # the record goes and its worktree with it, once landed
        records = fx.state / 'subagent-worktrees.json'
        landed = lambda: [r for r in json.loads(records.read_text(encoding='utf-8'))['subagents'].values() if r['state'] != 'spare']  # noqa: E731
        wait_for(lambda: not landed(), 'the landed record to be released', seconds=60)
        spares = [r for r in json.loads(records.read_text(encoding='utf-8'))['subagents'].values()]
        self.assertLessEqual(len(spares), 1, 'at most the chat spare stays while the chat is open')
        helpers = json.loads((fx.state / 'swarm-helpers.json').read_text(encoding='utf-8'))['helpers'].values()
        landed_paths = [pathlib.Path(h['worktree']['path']) for h in helpers if h.get('kind') == 'subagent' and h.get('state') == 'merged']
        self.assertEqual(len(landed_paths), 1, helpers)
        self.assertRegex(str(landed_paths[0]), r'[\\/]\.gem-[0-9a-f]{32}[\\/]sub-')
        wait_for(lambda: not landed_paths[0].exists(), 'the landed worktree folder to go', seconds=60)
        porcelain = run_git(project, 'worktree', 'list', '--porcelain')
        # (this repo's own scratch folder is named .gem-scratch: match AIB's .gem-<chat id> folders only)
        live = [b for b in porcelain.split('\n\n') if re.search(r'[\\/]\.gem-[0-9a-f]{32}[\\/]', b) and 'prunable' not in b]
        self.assertEqual(len(live), len(spares), porcelain)
        # Activity: a card for the subagent, from its invoke_agent call (running, then completed), with P3's worktree line
        state = chat.state()
        self.assertEqual(state.get('subagentIsolation', {}).get('on'), True, state.get('subagentIsolation'))
        cards = [e['data']['update'] for e in state['events'] if e.get('kind') == 'update'
                 and (e.get('data') or {}).get('update', {}).get('sessionUpdate') == 'subagent_update']
        self.assertEqual([c['state'] for c in cards], ['running', 'completed'], cards)
        self.assertEqual(cards[0]['agentType'], 'generalist')
        info = (state.get('subagentWorktrees') or {}).get(cards[0]['sessionId'])
        self.assertTrue(info and info.get('where'), state.get('subagentWorktrees'))
        # the chat's home is AIB's own: its settings carry AIB's hook; the user's folder has no AIB file
        homes = list((fx.state / 'gemini').glob('*/home/.gemini/settings.json'))
        self.assertEqual(len(homes), 1, homes)
        self.assertIn('gemini-before-tool', homes[0].read_text(encoding='utf-8'))
        self.assertFalse((user_home / '.gemini' / 'policies').exists())
        self.assertNotIn('AIB_HOOK_KEY', log, 'no key reached the model')


class GeminiFenceTest(GeminiSubagentCase):
    hooks_off = True

    def test_fence_denies_subagent_edits_when_the_redirect_is_off(self):
        fx, chat, project, stub, run, user_home = self.play()
        log = stub.text()
        self.assertIn('denied by policy', log)
        self.assertIn(FENCE_TEXT, log)
        self.assertFalse((project / 'sub-made.txt').exists(), 'the subagent wrote into the project folder')
        self.assertEqual((project / 'parent-made.txt').read_text(encoding='utf-8'), f'PARENT {run}\n', 'the parent is unaffected')
        notes = [e for e in chat.state()['events'] if e.get('kind') == 'studio_note']
        self.assertTrue(any(OFF_LINE in json.dumps(e) for e in notes), notes)
        self.assertFalse(list((fx.state / 'gemini').glob('*/home')), 'no chat home without the redirect')
        time.sleep(2)  # nothing lands later either
        self.assertFalse((project / 'sub-made.txt').exists())


if __name__ == '__main__':
    unittest.main()
