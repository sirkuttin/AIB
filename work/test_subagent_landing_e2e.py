"""Subagent worktrees, P2 (landing): e2e with the REAL Claude Code adapter against the stub model API (work/stub_model_api.js script
mode), temp config and temp dirs only. Design: private/designs/subagent-worktrees/design.md v2 (P2), owner 2026-11-16: subagent work
lands exactly like helpers' work (swarm/service.ts helper landing).

  HooksOffAdapterTest     the adapter alone (work/acp_probe.js) with `disableAllHooks` in the temp user settings and the per-session
                          permission deny AIB sends then (subagents/claude_config.ts subagentsOffSettings): the editing Agent call is
                          refused (named type and no type at all), Explore still runs, nothing is written in the folder.
  AibSubagentLandingTest  a real AIB (deno-split web server + agent host), a Claude chat in a temp git project:
                            B1   foreground editing subagent: nothing in the folder before the turn ends; then one AIB commit
                                 "AIB: subagent <description>" on the folder's branch with its file; the main agent's uncommitted
                                 edit survives uncommitted; "Merged subagent" line with Undo; its worktree, branch and record gone
                            B5   background subagent: lands after its SubagentStop, once the parent is idle
                            B6   clash: it changed a file the folder has uncommitted: nothing lands, nothing stashed, the main agent
                                 is told (next prompt) with merge_helper and the id; after the edit is committed, merge_helper lands it
                            B17  protected path (.husky/pre-commit by Bash): nothing lands, told; the worktree is kept
                            B10  hooks off in the user's Claude settings: the editing subagent is refused, the chat line says so
                            B21  the user's own WorktreeCreate hook: AIB sends none, adopts the worktree, lands it, never removes it
                                 (P3: the Agent call shows in the RFD form as a session_message, not a tool call)
                            P3   a `context: fork` skill is refused (PreToolUse(Skill)); an ordinary skill runs
  Crash recovery (B8) and the junction-safe removal are pinned by work/deno/subagent_landing_test.ts.

Needs node, the Claude Code ACP adapter (AIB_CLAUDE_ACP or a global npm install) and Go (keeper program; AIB_TEST_KEEPER_BIN names a
built one). Run with TEMP/TMP pointed at a scratch folder.
"""
import _isolation  # noqa: F401  (test isolation: temp state folder, real per-user folder blocked)
import json
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
from test_worktree_e2e import Chat, wait_for  # noqa: E402
from test_folder_chat_listing_e2e import CLAUDE_ACP, NODE, RealClaudeFixture, stub_claude_env  # noqa: E402
from test_subagent_worktree_e2e import (GO, NO_WINDOW, PROBE, OwnerUntouched, approve_all, dumped, keeper_program, scripted_stub,  # noqa: E402
                                        stub_text)

SERVER_KIND = server_under_test.server_kind()
OFF_LINE = "Subagents that edit files are off in this chat"
HOOKS_OFF_DENY = ['Agent(general-purpose)', 'Agent(claude)', 'Agent(fork)', 'Task(general-purpose)', 'Task(claude)', 'Task(fork)',
                  'Workflow', 'EnterWorktree']


def temp_env(temp, home):
    env = dict(os.environ)
    for name in ('CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT'):
        env.pop(name, None)
    for name in ('HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'):
        env[name] = str(home)
    env.update(APPDATA=str(home / 'AppData' / 'Roaming'), LOCALAPPDATA=str(home / 'AppData' / 'Local'), CLAUDE_CONFIG_DIR=str(temp / 'claude'),
               TEMP=str(temp / 'tmp'), TMP=str(temp / 'tmp'), TMPDIR=str(temp / 'tmp'))
    return env


@unittest.skipUnless(NODE and CLAUDE_ACP, 'needs node and the Claude Code ACP adapter')
class HooksOffAdapterTest(unittest.TestCase):

    def test_permission_deny_blocks_editing_subagents_with_hooks_off(self):
        temp = pathlib.Path(tempfile.mkdtemp(prefix='aib-sr2-off-'))
        self.addCleanup(shutil.rmtree, temp, True)
        mark = f'srp2{uuid.uuid4().hex[:6]}'
        project = make_repo(temp / mark)
        OwnerUntouched(self, mark)
        home = temp / 'home'
        for sub in ('claude', 'home/AppData/Roaming', 'home/AppData/Local', 'tmp'):
            (temp / sub).mkdir(parents=True, exist_ok=True)
        (temp / 'claude' / 'settings.json').write_text(json.dumps({'disableAllHooks': True}), encoding='utf-8')
        rules = [
            {'when': 'SR-PARENT', 'reply': {'tools': [{'id': 'toolu_pAgent01', 'name': 'Agent', 'input': {
                'description': 'sr edit', 'prompt': 'SUBTASK-A: do the work', 'subagent_type': 'general-purpose', 'run_in_background': False}}]}},
            {'when': 'SUBTASK-A', 'reply': {'tools': [{'id': 'toolu_sBash01', 'name': 'Bash', 'input': {
                'command': 'echo from-sub > sub-a.txt', 'description': 'write'}}]}},
            {'when': 'toolu_sBash01', 'reply': {'text': 'SUB-DONE'}},
            {'when': 'toolu_pAgent01', 'reply': {'tools': [{'id': 'toolu_pAgent02', 'name': 'Agent', 'input': {
                'description': 'sr untyped', 'prompt': 'SUBTASK-B: do the work', 'run_in_background': False}}]}},
            {'when': 'SUBTASK-B', 'reply': {'tools': [{'id': 'toolu_sBash02', 'name': 'Bash', 'input': {
                'command': 'echo from-sub > sub-b.txt', 'description': 'write'}}]}},
            {'when': 'toolu_sBash02', 'reply': {'text': 'SUB-B-DONE'}},
            {'when': 'toolu_pAgent02', 'reply': {'tools': [{'id': 'toolu_pAgent03', 'name': 'Agent', 'input': {
                'description': 'sr look', 'prompt': 'SUBTASK-E: look', 'subagent_type': 'Explore', 'run_in_background': False}}]}},
            {'when': 'SUBTASK-E', 'reply': {'text': 'EXPLORE-DONE'}},
            {'when': 'toolu_pAgent03', 'reply': {'text': 'PARENT-DONE'}},
        ]
        stub = scripted_stub(self, temp, rules)
        env = stub_claude_env(temp_env(temp, home), stub)
        meta = temp / 'meta.json'
        meta.write_text(json.dumps({'claudeCode': {'options': {'settings': {'permissions': {'deny': HOOKS_OFF_DENY}}}}}), encoding='utf-8')
        out = subprocess.run([NODE, str(PROBE), '--allow', '--mode', 'bypassPermissions', '--meta', str(meta), str(CLAUDE_ACP), 'new', str(project),
                              'SR-PARENT go'], capture_output=True, text=True, timeout=300, env=env, creationflags=NO_WINDOW,
                             stdin=subprocess.DEVNULL)
        self.assertIn('PARENT-DONE', out.stdout + stub_text(stub), out.stderr[-1500:])
        sent = dumped(stub)
        self.assertIn("Agent type 'general-purpose' has been denied by permission rule 'Agent(general-purpose)'", sent)
        self.assertNotIn('SUB-DONE', stub_text(stub) + sent, 'the editing subagent ran with hooks off')
        self.assertNotIn('SUB-B-DONE', stub_text(stub) + sent, 'the untyped subagent ran with hooks off')
        self.assertFalse((project / 'sub-a.txt').exists())
        self.assertFalse((project / 'sub-b.txt').exists())
        self.assertIn('EXPLORE-DONE', sent, 'Explore must still run')
        self.assertEqual(run_git(project, 'status', '--porcelain'), '')


def agent_call(tid, desc, prompt, background=False, kind='general-purpose'):
    return {'id': tid, 'name': 'Agent', 'input': {'description': desc, 'prompt': prompt, 'subagent_type': kind, 'run_in_background': background}}


def bash(tid, command):
    return {'id': tid, 'name': 'Bash', 'input': {'command': command, 'description': 'sr step'}}


def notes(chat):
    return [str((e.get('data') or {}).get('message', '')) for e in chat.state()['events'] if e.get('kind') == 'studio_note']


def records(fx):
    f = fx.state / 'subagent-worktrees.json'
    return json.loads(f.read_text(encoding='utf-8'))['subagents'] if f.is_file() else {}


def git_log(project):
    return run_git(project, 'log', '--format=%s', '-n', '20')


class Aib:
    """A real AIB with one Claude chat in a temp git project, driven turn by turn."""

    def __init__(self, test, rules, setup=None):
        temp = pathlib.Path(tempfile.mkdtemp(prefix='aib-sr2-'))
        test.addCleanup(shutil.rmtree, temp, True)
        self.test, self.temp = test, temp
        self.mark = f'srp2{uuid.uuid4().hex[:6]}'
        self.project = make_repo(temp / self.mark)
        run_git(self.project, 'config', 'core.autocrlf', 'false')
        if setup:
            setup(self)
        OwnerUntouched(test, self.mark)
        self.stub = scripted_stub(test, temp, rules)
        keeper = keeper_program(temp)

        class Fixture(RealClaudeFixture):
            def env(self):
                env = super().env()
                env['AIB_KEEPER_BIN'] = str(keeper)
                for name in ('TEMP', 'TMP', 'TMPDIR'):
                    env[name] = str(temp / 'tmp')
                return env

        (temp / 'tmp').mkdir(exist_ok=True)
        RealClaudeFixture.stub = self.stub
        self.fx = Fixture(test)
        self.web = self.fx.start_web()
        status, connection = self.web.post('connect', {'provider': 'claude', 'cwd': str(self.project), 'background': True})
        test.assertEqual(status, 200, connection)
        self.chat = Chat(None, connection['id'], self.web)
        wait_for(lambda: self.chat.state().get('ready') or (self.chat.state().get('error') and test.fail(self.chat.state()['error'])), 'chat ready')

    def turn(self, text):
        before = sum(1 for e in self.chat.state()['events'] if e['kind'] == 'turn_end')
        code, _ = self.web.post('prompt', {'id': self.chat.id, 'text': text, 'clientMessageId': uuid.uuid4().hex})
        self.test.assertEqual(code, 200)

        def ended():
            approve_all(self.chat)
            state = self.chat.state()
            return not state['busy'] and sum(1 for e in state['events'] if e['kind'] == 'turn_end') > before
        wait_for(ended, f'the turn {text!r} to end', seconds=240)

    def wait(self, what, check, seconds=60):
        def ok():
            approve_all(self.chat)
            return check()
        wait_for(ok, what, seconds=seconds)


@unittest.skipUnless(NODE and CLAUDE_ACP, 'needs node and the Claude Code ACP adapter (AIB_CLAUDE_ACP or a global npm install)')
@unittest.skipUnless(GO or os.environ.get('AIB_TEST_KEEPER_BIN'), 'needs Go to build the keeper program (or AIB_TEST_KEEPER_BIN)')
@unittest.skipUnless(SERVER_KIND == 'deno-split', 'runs against AIB_SERVER=deno-split (the default)')
class AibSubagentLandingTest(unittest.TestCase):

    def test_landing_foreground_background_clash_protected(self):
        rules = [
            # B1 foreground
            {'when': 'SR-FG', 'reply': {'tools': [agent_call('toolu_pA1', 'sr edit', 'SUBTASK-A: do the work')]}},
            {'when': 'SUBTASK-A', 'reply': {'tools': [bash('toolu_sA1', 'echo from-sub > sub-a.txt')]}},
            {'when': 'toolu_sA1', 'reply': {'text': 'SUB-A-DONE'}},
            {'when': 'toolu_pA1', 'reply': {'tools': [bash('toolu_pA2', 'test -e sub-a.txt && echo SUBA-PRESENT || echo SUBA-ABSENT')]}},
            {'when': 'toolu_pA2', 'reply': {'text': 'PARENT-FG-DONE'}},
            # B5 background
            {'when': 'SR-BG', 'reply': {'tools': [agent_call('toolu_pB1', 'sr background', 'SUBTASK-B: do the work', background=True)]}},
            {'when': 'SUBTASK-B', 'reply': {'tools': [bash('toolu_sB1', 'sleep 3 && echo from-bg > sub-b.txt')]}},
            {'when': 'toolu_sB1', 'reply': {'text': 'SUB-B-DONE'}},
            {'when': 'toolu_pB1', 'reply': {'text': 'PARENT-BG-LAUNCHED'}},
            # B6 clash: it changes dirty.txt, which the folder has uncommitted
            {'when': 'SR-CLASH', 'reply': {'tools': [agent_call('toolu_pC1', 'sr clash', 'SUBTASK-C: do the work')]}},
            {'when': 'SUBTASK-C', 'reply': {'tools': [bash('toolu_sC1', 'echo from-clash >> dirty.txt')]}},
            {'when': 'toolu_sC1', 'reply': {'text': 'SUB-C-DONE'}},
            {'when': 'toolu_pC1', 'reply': {'text': 'PARENT-CLASH-DONE'}},
            # B17 protected
            {'when': 'SR-PROT', 'reply': {'tools': [agent_call('toolu_pD1', 'sr hook', 'SUBTASK-D: do the work')]}},
            {'when': 'SUBTASK-D', 'reply': {'tools': [bash('toolu_sD1', 'mkdir -p .husky && echo "echo pwned" > .husky/pre-commit && echo ok > sub-d.txt')]}},
            {'when': 'toolu_sD1', 'reply': {'text': 'SUB-D-DONE'}},
            {'when': 'toolu_pD1', 'reply': {'text': 'PARENT-PROT-DONE'}},
        ]

        def dirty(aib):
            (aib.project / 'dirty.txt').write_text('main-edit\n', encoding='utf-8')  # the main agent's uncommitted edit
        aib = Aib(self, rules, dirty)
        p, fx, chat = aib.project, aib.fx, aib.chat
        self.assertEqual({k: chat.state().get('subagentIsolation', {}).get(k) for k in ('on', 'reason')}, {'on': True, 'reason': ''})

        # ---- B1: foreground lands at the turn end, as one commit; the main agent's edit stays uncommitted
        aib.turn('SR-FG go')
        sent = dumped(aib.stub)
        self.assertIn('SUBA-ABSENT', sent, 'the subagent changed the folder before the turn ended')
        aib.wait('the foreground subagent to land', lambda: 'AIB: subagent sr edit' in git_log(p))
        self.assertEqual((p / 'sub-a.txt').read_text(encoding='utf-8').strip(), 'from-sub')
        self.assertIn('?? dirty.txt', run_git(p, 'status', '--porcelain'), 'the main edit must stay uncommitted')
        self.assertNotIn('dirty.txt', run_git(p, 'show', '--name-only', '--format=', 'HEAD'))
        aib.wait('the merge line', lambda: any(n.startswith('Merged subagent “sr edit”') for n in notes(chat)))
        merged = [e for e in chat.state()['events'] if e.get('kind') == 'studio_note' and 'Merged subagent' in str(e['data'].get('message'))]
        self.assertTrue(any(a.get('id') == 'swarm-undo' for a in merged[-1]['data'].get('actions', [])), merged[-1])
        aib.wait('its worktree to go', lambda: not [r for r in records(fx).values() if r.get('description') == 'sr edit'])
        spares = {r['branch'] for r in records(fx).values() if r['state'] == 'spare'}  # P1's prepared spare stays
        left = {b.strip(' +*') for b in run_git(p, 'branch', '--list', 'studio/sub-*').splitlines() if b.strip()}
        self.assertEqual(left - spares, set(), 'the landed subagent branch must go')
        self.assertEqual(run_git(p, 'stash', 'list'), '')

        # ---- B5: background lands after its SubagentStop, once the parent is idle
        aib.turn('SR-BG go')
        aib.wait('the background subagent to land', lambda: 'AIB: subagent sr background' in git_log(p), seconds=120)
        self.assertEqual((p / 'sub-b.txt').read_text(encoding='utf-8').strip(), 'from-bg')
        self.assertIn('?? dirty.txt', run_git(p, 'status', '--porcelain'))

        # ---- B6: clash with the folder's uncommitted edit: nothing lands, nothing stashed, the main agent is told
        aib.turn('SR-CLASH go')
        aib.wait('the clash line', lambda: any(n.startswith("Didn't land subagent “sr clash”") for n in notes(chat)))
        self.assertEqual((p / 'dirty.txt').read_text(encoding='utf-8'), 'main-edit\n')
        self.assertNotIn('AIB: subagent sr clash', git_log(p))
        self.assertEqual(run_git(p, 'stash', 'list'), '')
        clash = [r for r in records(fx).values() if r.get('description') == 'sr clash']
        self.assertTrue(clash and pathlib.Path(clash[0]['path']).is_dir(), 'the clashing worktree must be kept')
        # the user commits the edit; the next turn end tries again and lands it (merge_helper with the id does the same)
        run_git(p, 'add', 'dirty.txt')
        run_git(p, 'commit', '-q', '-m', 'user: dirty')
        aib.turn('SR-NEXT go')
        self.assertIn('changed files with uncommitted edits', dumped(aib.stub), 'the main agent was not told')
        self.assertIn('AIB tries again when your next turn ends', dumped(aib.stub))  # swarm off: no merge_helper offered
        aib.wait('the clash to land after the commit', lambda: 'AIB: subagent sr clash' in git_log(p))
        self.assertEqual((p / 'dirty.txt').read_text(encoding='utf-8'), 'main-edit\nfrom-clash\n')

        # ---- B17: protected path: nothing lands, told, kept
        aib.turn('SR-PROT go')
        aib.wait('the protected line', lambda: any(n.startswith("Didn't land subagent “sr hook”: it changed protected files") for n in notes(chat)))
        self.assertFalse((p / '.husky').exists())
        self.assertFalse((p / 'sub-d.txt').exists(), 'nothing of a refused subagent lands')
        kept = [r for r in records(fx).values() if r.get('description') == 'sr hook']
        self.assertTrue(kept and pathlib.Path(kept[0]['path']).is_dir())
        aib.turn('SR-AFTER go')
        self.assertIn('changed protected files (.husky/pre-commit)', dumped(aib.stub))

    def test_hooks_off_turns_editing_subagents_off(self):
        rules = [
            {'when': 'SR-PARENT', 'reply': {'tools': [agent_call('toolu_pA1', 'sr edit', 'SUBTASK-A: do the work')]}},
            {'when': 'SUBTASK-A', 'reply': {'tools': [bash('toolu_sA1', 'echo from-sub > sub-a.txt')]}},
            {'when': 'toolu_sA1', 'reply': {'text': 'SUB-A-DONE'}},
            {'when': 'toolu_pA1', 'reply': {'text': 'PARENT-DONE'}},
        ]

        def off(aib):
            (aib.project / '.claude').mkdir()
            (aib.project / '.claude' / 'settings.local.json').write_text(json.dumps({'disableAllHooks': True}), encoding='utf-8')
        aib = Aib(self, rules, off)
        self.assertEqual(aib.chat.state().get('subagentIsolation', {}).get('on'), False)
        self.assertTrue(any(n.startswith(OFF_LINE) for n in notes(aib.chat)), notes(aib.chat))
        aib.turn('SR-PARENT go')
        sent = dumped(aib.stub)
        self.assertIn('has been denied by permission rule', sent)
        self.assertNotIn('SUB-A-DONE', sent + stub_text(aib.stub))
        self.assertFalse((aib.project / 'sub-a.txt').exists())
        self.assertIn('subagents that edit files are turned off', sent)

    def test_fork_skill_is_refused(self):
        """P3 probe (work/p3_skill_fork_probe.py): a `context: fork` skill starts a subagent with no Agent call, in the folder. AIB's
        PreToolUse(Skill) refuses it; an ordinary skill still runs."""
        rules = [
            {'when': 'SR-SKILL', 'reply': {'tools': [{'id': 'toolu_pS1', 'name': 'Skill', 'input': {'skill': 'forker'}}]}},
            {'when': 'FORKBODY-7', 'reply': {'tools': [bash('toolu_fS1', 'echo from-fork > fork.txt')]}},
            {'when': 'toolu_fS1', 'reply': {'text': 'FORK-RAN'}},
            {'when': 'toolu_pS1', 'reply': {'tools': [{'id': 'toolu_pS2', 'name': 'Skill', 'input': {'skill': 'plain'}}]}},
            {'when': 'toolu_pS2', 'reply': {'text': 'PARENT-SKILL-DONE'}},
        ]

        def skills(aib):
            for name, front, body in (('forker', 'context: fork\nagent: general-purpose\n', 'FORKBODY-7: write fork.txt'),
                                      ('plain', '', 'PLAINBODY-7: just say hi')):
                d = aib.project / '.claude' / 'skills' / name
                d.mkdir(parents=True)
                (d / 'SKILL.md').write_text(f'---\nname: {name}\ndescription: {name} skill\n{front}---\n{body}\n', encoding='utf-8')
            run_git(aib.project, 'add', '-A')
            run_git(aib.project, 'commit', '-q', '-m', 'skills')
        aib = Aib(self, rules, skills)
        aib.turn('SR-SKILL go')
        sent = dumped(aib.stub)
        self.assertIn('skills that run as a forked subagent (context: fork) are off', sent)
        self.assertNotIn('FORK-RAN', sent + stub_text(aib.stub), 'the fork skill ran')
        self.assertFalse((aib.project / 'fork.txt').exists())
        self.assertIn('PARENT-SKILL-DONE', stub_text(aib.stub) + sent)
        self.assertIn('PLAINBODY-7', sent, 'an ordinary skill still runs')

    def test_user_worktree_hook_is_adopted_landed_and_kept(self):
        rules = [
            {'when': 'SR-PARENT', 'reply': {'tools': [agent_call('toolu_pA1', 'sr user', 'SUBTASK-U: do the work')]}},
            {'when': 'SUBTASK-U', 'reply': {'tools': [bash('toolu_sU1', 'echo from-user-wt > sub-u.txt')]}},
            {'when': 'toolu_sU1', 'reply': {'text': 'SUB-U-DONE'}},
            {'when': 'toolu_pA1', 'reply': {'text': 'PARENT-DONE'}},
        ]
        holder = {}

        def user_hook(aib):
            where = aib.temp / 'user-wts'
            where.mkdir()
            script = aib.temp / 'wt-hook.sh'
            fwd = lambda x: str(x).replace('\\', '/')
            script.write_text(
                'input=$(cat)\n'
                'name=$(printf %s "$input" | sed -n \'s/.*"name": *"\\([^"]*\\)".*/\\1/p\')\n'
                f'dir="{fwd(where)}/$name"\n'
                f'git -C "{fwd(aib.project)}" worktree add -q -b "user-$name" "$dir" HEAD >/dev/null 2>&1 || exit 1\n'
                'echo "$dir"\n', encoding='utf-8')
            (aib.project / '.claude').mkdir()
            (aib.project / '.claude' / 'settings.local.json').write_text(json.dumps({'hooks': {'WorktreeCreate': [{'hooks': [
                {'type': 'command', 'command': f'bash "{fwd(script)}"'}]}]}}), encoding='utf-8')
            holder['where'] = where
        aib = Aib(self, rules, user_hook)
        aib.turn('SR-PARENT go')
        p = aib.project
        made = list(holder['where'].iterdir())
        self.assertEqual(len(made), 1, 'the user hook made no worktree')
        try:
            aib.wait('the user-hook worktree to land', lambda: 'AIB: subagent sr user' in git_log(p))
        except AssertionError:
            print(json.dumps(records(aib.fx), indent=1), notes(aib.chat), file=sys.stderr)
            raise
        self.assertEqual((p / 'sub-u.txt').read_text(encoding='utf-8').strip(), 'from-user-wt')
        time.sleep(3)  # a poll or two after landing: AIB must not remove what the user's hook made
        self.assertTrue(made[0].is_dir(), "AIB removed the user's worktree")
        self.assertIn(made[0].name, run_git(p, 'branch', '--list', 'user-*'))
        self.assertFalse([r for r in records(aib.fx).values() if r.get('description') == 'sr user'], 'its record should go after landing')


if __name__ == '__main__':
    unittest.main()
