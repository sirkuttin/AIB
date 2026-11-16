"""Subagent worktrees, Codex (server/subagents/codex.ts): e2e with the REAL codex-acp (AIB's pinned 2.6.0: AIB_CODEX_ACP, e.g. a copy
inside the worktree) against the stub model API in script mode (work/stub_model_api.js, Responses namespace tools), a real AIB
(deno-split web server + agent host) and temp config only: the model provider reaches Codex through the user's CODEX_CONFIG, which
AIB merges its hooks into (so the merge is under test too). Owner rule 2026-11-16: an agent's own subagent that edits files works in
its own git worktree and lands like a helper's work; hooks off -> Codex subagents off for that chat.

  AibCodexSubagentTest
    test_shell_write_lands_at_turn_end   the subagent's exec_command (Set-Content sub-a.txt) runs in its AIB worktree (AIB's
                                         "cd '<worktree>'; " prefix through the keeper's forwarder); the main folder has no
                                         sub-a.txt while the turn runs (the parent checks); at the turn end one commit
                                         "AIB: subagent <message>" lands it; the worktree, branch and record go
    test_absolute_path_into_main_denied  the subagent writes to <project>\\escape.txt by absolute path: denied with the worktree
                                         named; nothing in the main folder; nothing lands
    test_hooks_off_turns_subagents_off   features.hooks = false in the user's CODEX_CONFIG: no hooks; features.multi_agent = false
                                         merged into it (the model is offered no spawn_agent); the chat line says so; Activity off
  Owner guard: the owner's ~/.codex config files keep their mtimes and no new or changed file there mentions the run (no Claude runs
  here; the owner's own live Claude sessions write ~/.claude.json, so P1's Claude guard is not used).

Needs node, codex-acp (AIB_CODEX_ACP or a global npm install) and Go (keeper program; AIB_TEST_KEEPER_BIN names a built one), with
no space in the temp folder's path (Codex runs a hook command through cmd.exe, program first, unquoted). Run with TEMP/TMP pointed
at a scratch folder.
"""
import _isolation  # noqa: F401  (test isolation: temp state folder, real per-user folder blocked)
import json
import os
import pathlib
import shutil
import sys
import tempfile
import time
import unittest
import uuid

sys.path.insert(0, str(_isolation.TESTS / 'contract'))
import server_under_test  # noqa: E402
from _e2e_support import make_repo, run_git  # noqa: E402
from test_worktree_e2e import Chat, E2EFixture, wait_for  # noqa: E402
from test_folder_chat_listing_e2e import NODE, adapter  # noqa: E402
from test_subagent_worktree_e2e import GO, approve_all, dumped, keeper_program, scripted_stub, stub_text  # noqa: E402

SERVER_KIND = server_under_test.server_kind()
CODEX_ACP = adapter('AIB_CODEX_ACP', '@agentclientprotocol/codex-acp')


def notes(chat):
    return [str((e.get('data') or {}).get('message', '')) for e in chat.state()['events'] if e.get('kind') == 'studio_note']


def records(state):
    f = pathlib.Path(state) / 'subagent-worktrees.json'
    return json.loads(f.read_text(encoding='utf-8'))['subagents'] if f.is_file() else {}


class CodexOwnerUntouched:
    """The owner's ~/.codex: its config files keep their mtimes, and no new or changed file there mentions this run."""

    def __init__(self, owner, mark):
        self.home = pathlib.Path(os.path.expanduser('~')) / '.codex'
        self.mark = mark
        self.before = self.snapshot()
        owner.addCleanup(self.check, owner)

    def snapshot(self):
        if not self.home.is_dir():
            return {}
        out = {}
        for f in self.home.rglob('*'):
            try:
                if f.is_file():
                    out[str(f)] = f.stat().st_mtime
            except OSError:
                pass
        return out

    def check(self, owner):
        after = self.snapshot()
        for name in ('config.toml', 'hooks.json', 'requirements.toml', 'AGENTS.md'):
            f = str(self.home / name)
            owner.assertEqual(after.get(f), self.before.get(f), f"the owner's ~/.codex/{name} changed")
        changed = [f for f, m in after.items() if self.before.get(f) != m]
        for f in changed:
            p = pathlib.Path(f)
            if p.stat().st_size > 20 * 1024 * 1024:
                continue
            text = p.read_bytes().decode('utf-8', 'replace')
            owner.assertNotIn(self.mark, text, f"a test chat reached the owner's ~/.codex ({f})")


def spawn(tid, message):
    return {'id': tid, 'name': 'multi_agent_v1.spawn_agent', 'input': {'message': message}}


def wait(tid):
    return {'id': tid, 'name': 'multi_agent_v1.wait_agent', 'input': {'targets': ['@CAP@'], 'timeout_ms': 60000}}


def exec_(tid, cmd):
    return {'id': tid, 'name': 'exec_command', 'input': {'cmd': cmd}}


# the parent's own check, after the subagent ended: the output names what it found (its command text names neither)
CHECK_A = 'if (Test-Path sub-a.txt) { "main-has-" + "sub-a" } else { "main-has-" + "no-sub-a" }'
CAPTURE = r'agent_id\W{1,6}([0-9a-f-]{8,})'


class AibCodex:
    """A real AIB with one Codex chat in a temp git project, driven turn by turn."""

    def __init__(self, test, rules, user_config=None):
        temp = pathlib.Path(tempfile.mkdtemp(prefix='aib-srcx-'))
        test.addCleanup(shutil.rmtree, temp, True)
        if ' ' in str(temp):
            test.skipTest('the temp folder has a space: Codex hooks cannot name the keeper there (TEMP=a scratch folder)')
        self.test, self.temp = test, temp
        self.mark = f'srcx{uuid.uuid4().hex[:6]}'
        self.project = make_repo(temp / self.mark)
        run_git(self.project, 'config', 'core.autocrlf', 'false')
        CodexOwnerUntouched(test, self.mark)
        self.stub = scripted_stub(test, temp, rules(self.project) if callable(rules) else rules)
        keeper = keeper_program(temp)
        provider = {'model': 'stub-model', 'model_provider': 'stub', 'model_providers': {'stub': {
            'name': 'stub', 'base_url': f'{self.stub.url}/v1', 'wire_api': 'responses', 'requires_openai_auth': False,
            'supports_websockets': False}}, 'analytics': {'enabled': False}, 'check_for_update_on_startup': False,
            'approvals_reviewer': 'user'}  # approvals come to AIB (its permission cards), not to an automatic reviewer model
        config = {**provider, **(user_config or {})}
        (temp / 'tmp').mkdir(exist_ok=True)

        class Fixture(E2EFixture):
            def agent_flags(self):
                return super().agent_flags() + ['--codex-launcher', str(CODEX_ACP), '--node-command', NODE]

            def env(self):
                env = dict(super().env(), AGENT_STUDIO_ALLOW_REAL_AGENT='1', AIB_KEEPER_BIN=str(keeper), CODEX_CONFIG=json.dumps(config))
                for name in ('OPENAI_API_KEY', 'CODEX_HOME', 'CODEX_PATH'):
                    env.pop(name, None)
                for name in ('TEMP', 'TMP', 'TMPDIR'):
                    env[name] = str(temp / 'tmp')
                return env

        self.fx = Fixture(test)
        self.web = self.fx.start_web()
        # Workspace access: the sandboxed mode whose approvals come to AIB's permission cards (the default Auto review mode asks a
        # reviewer model, which the stub is not); a subagent's write in its worktree (outside the chat's folder) asks there
        status, connection = self.web.post('connect', {'provider': 'codex', 'cwd': str(self.project), 'background': True,
                                                       'picks': {'mode': 'workspace-write'}})
        test.assertEqual(status, 200, connection)
        self.chat = Chat(None, connection['id'], self.web)
        wait_for(lambda: self.chat.state().get('ready') or (self.chat.state().get('error') and test.fail(self.chat.state()['error'])),
                 'chat ready', seconds=120)

    def turn(self, text, seconds=300):
        before = sum(1 for e in self.chat.state()['events'] if e['kind'] == 'turn_end')
        code, _ = self.web.post('prompt', {'id': self.chat.id, 'text': f'{text} {self.mark}', 'clientMessageId': uuid.uuid4().hex})
        self.test.assertEqual(code, 200)

        def ended():
            approve_all(self.chat)
            state = self.chat.state()
            return not state['busy'] and sum(1 for e in state['events'] if e['kind'] == 'turn_end') > before
        wait_for(ended, f'the turn {text!r} to end', seconds=seconds)

    def wait(self, what, check, seconds=90):
        def ok():
            approve_all(self.chat)
            return check()
        wait_for(ok, what, seconds=seconds)

    def report(self):
        calls = [json.loads(x) for x in stub_text(self.stub).splitlines() if x.strip()]
        steps = [(c.get('rule'), (c.get('last') or '')[-300:]) for c in calls if c.get('path', '').endswith('/responses')]
        return json.dumps({'records': records(self.fx.state), 'notes': notes(self.chat), 'steps': steps}, indent=1)[-9000:]


SKIP_REASON = 'needs node, codex-acp (AIB_CODEX_ACP or a global npm install) and Go or AIB_TEST_KEEPER_BIN, against AIB_SERVER=deno-split'


@unittest.skipUnless(NODE and CODEX_ACP and (GO or os.environ.get('AIB_TEST_KEEPER_BIN')) and SERVER_KIND == 'deno-split', SKIP_REASON)
class AibCodexSubagentTest(unittest.TestCase):

    def test_shell_write_lands_at_turn_end(self):
        rules = [
            {'when': 'CX-EDIT go', 'reply': {'tools': [spawn('call_pSpawnA', 'CX-SUB-A write the file')]}},
            {'when': 'CX-SUB-A write', 'reply': {'tools': [exec_('call_sExecA', 'Set-Content -Path sub-a.txt -Value from-sub; (Get-Location).Path')]}},
            {'when': 'call_sExecA', 'reply': {'text': 'SUB-A-DONE'}},
            {'when': 'call_pSpawnA', 'capture': CAPTURE, 'reply': {'tools': [wait('call_pWaitA')]}},
            {'when': 'call_pWaitA', 'reply': {'tools': [exec_('call_pCheckA', CHECK_A)]}},
            {'when': 'subagent_notification', 'once': True, 'reply': {'tools': [exec_('call_pCheckA', CHECK_A)]}},
            {'when': 'call_pCheckA', 'reply': {'text': 'PARENT-A-DONE'}},
        ]
        aib = AibCodex(self, rules)
        p, chat = aib.project, aib.chat
        self.assertEqual(chat.state().get('subagentIsolation'), {'on': True, 'reason': '', 'readOnly': []}, notes(chat))
        self.assertEqual(run_git(p, 'status', '--porcelain'), '', 'the main folder is clean before')
        aib.turn('CX-EDIT go')
        sent = dumped(aib.stub)
        try:
            self.assertIn('SUB-A-DONE', stub_text(aib.stub) + sent, 'the subagent ran')
            self.assertIn('main-has-no-sub-a', sent, 'the subagent changed the main folder before the turn ended')
            self.assertIn('AIB gave you your own git worktree', sent, 'SubagentStart named its worktree')
            self.assertIn('Subagents you start with spawn_agent work in their own git worktree', sent, 'the system prompt line')
            aib.wait('the subagent to land', lambda: 'AIB: subagent CX-SUB-A write the file' in run_git(p, 'log', '--format=%s', '-n', '10'))
        except AssertionError:
            print(aib.report(), file=sys.stderr)
            raise
        self.assertEqual((p / 'sub-a.txt').read_text(encoding='utf-8-sig').strip(), 'from-sub')
        # P3's Activity line, as for Claude's subagents: by the child's agent id (codex-acp's child session id)
        seen = chat.state().get('subagentWorktrees') or {}
        self.assertTrue([v for v in seen.values() if v.get('where') == 'Own worktree'], f'Activity line: {seen}')
        self.assertEqual(run_git(p, 'show', '--name-only', '--format=', 'HEAD').split(), ['sub-a.txt'])
        aib.wait('the merge line', lambda: any(n.startswith('Merged subagent “CX-SUB-A write the file”') for n in notes(chat)))
        aib.wait('its worktree to go', lambda: not [r for r in records(aib.fx.state).values() if r.get('description') == 'CX-SUB-A write the file'])
        spares = {r['branch'] for r in records(aib.fx.state).values() if r['state'] == 'spare'}
        left = {b.strip(' +*') for b in run_git(p, 'branch', '--list', 'studio/sub-*').splitlines() if b.strip()}
        self.assertEqual(left - spares, set(), 'the landed subagent branch must go')

    def test_absolute_path_into_main_denied(self):
        def rules_for(project):
            target = str(project / 'escape.txt')
            return [
                {'when': 'CX-DENY go', 'reply': {'tools': [spawn('call_pSpawnB', 'CX-SUB-B try to escape')]}},
                {'when': 'CX-SUB-B try', 'reply': {'tools': [exec_('call_sExecB', f"Set-Content -Path '{target}' -Value escaped")]}},
                {'when': 'call_sExecB', 'reply': {'text': 'SUB-B-DONE'}},
                {'when': 'call_pSpawnB', 'capture': CAPTURE, 'reply': {'tools': [wait('call_pWaitB')]}},
                {'when': 'call_pWaitB', 'reply': {'text': 'PARENT-B-DONE'}},
                {'when': 'subagent_notification', 'reply': {'text': 'PARENT-B-DONE'}},
            ]
        aib = AibCodex(self, rules_for)  # the project path is only known once AibCodex made it
        aib.turn('CX-DENY go')
        sent = dumped(aib.stub)
        try:
            self.assertIn("it can't use the main folder", sent, 'the subagent was told why')
            used = {json.loads(x).get('rule') for x in stub_text(aib.stub).splitlines() if x.strip()}
            self.assertTrue(used & {4, 5}, 'the parent went on after its subagent ended')
        except AssertionError:
            print(aib.report(), file=sys.stderr)
            raise
        self.assertFalse((aib.project / 'escape.txt').exists(), 'the subagent wrote into the main folder')
        time.sleep(3)  # a landing poll or two: nothing to land
        self.assertEqual(run_git(aib.project, 'status', '--porcelain'), '')
        self.assertNotIn('AIB: subagent', run_git(aib.project, 'log', '--format=%s', '-n', '5'))

    def test_hooks_off_turns_subagents_off(self):
        rules = [
            {'when': 'CX-OFF go', 'reply': {'tools': [spawn('call_pSpawnC', 'CX-SUB-C write')]}},
            {'when': 'CX-SUB-C write', 'reply': {'tools': [exec_('call_sExecC', 'Set-Content -Path sub-c.txt -Value x')]}},
            {'when': 'call_sExecC', 'reply': {'text': 'SUB-C-DONE'}},
            {'when': 'call_pSpawnC', 'reply': {'text': 'PARENT-C-DONE'}},
        ]
        aib = AibCodex(self, rules, {'features': {'hooks': False}})
        chat = aib.chat
        self.assertEqual(chat.state().get('subagentIsolation', {}).get('on'), False)
        self.assertTrue(any(n.startswith('Subagents are off in this chat') for n in notes(chat)), notes(chat))
        aib.turn('CX-OFF go')
        calls = [json.loads(line) for line in stub_text(aib.stub).splitlines() if line.strip()]
        offered = {t for c in calls if c['path'].endswith('/responses') for t in (c.get('tools') or [])}
        self.assertTrue(offered, 'the model was offered tools')
        self.assertFalse([t for t in offered if 'spawn_agent' in t or 'multi_agent' in t], f'subagent tools offered: {sorted(offered)}')
        self.assertNotIn('SUB-C-DONE', stub_text(aib.stub) + dumped(aib.stub))
        self.assertFalse((aib.project / 'sub-c.txt').exists())
        self.assertIn('subagents (spawn_agent) are turned off', dumped(aib.stub))


if __name__ == '__main__':
    unittest.main()
