"""Subagent worktrees: finished subagents land or go while another subagent still runs (beta 11 bug, seen live 2026-11-16). E2e with
the REAL Claude Code adapter against the stub model API (work/stub_model_api.js script mode), temp config and temp dirs only.

The bug: a lead chat that always has a background subagent at work was never "idle" for a landing (connection.ts landingIdleReason
counted every running subagent, its own worktree or not), so finished subagents, with changes or none, kept their worktree, branch
and record for as long as any other subagent ran.

  AibSubagentCleanupTest
    test_finished_land_or_go_beside_a_running_one
        one turn starts three background subagents and ends: "sc long" (works for a minute, then writes long.txt), "sc empty"
        (changes nothing) and "sc change" (writes chg.txt). While "sc long" still runs, "sc empty"'s worktree, branch and record go
        and "sc change" lands as its commit; then "sc long" lands too.
    test_parallel_calls_land_under_their_own_names
        three Agent calls in one message: each landing commit carries its own description and only its own file (bug 2026-11-16)
    test_scratch_only_subagent_is_kept_and_the_parent_told
        a subagent that only wrote a page and a note at its worktree top lands nothing; its files stay; the next prompt names them
    test_restart_adopts_the_earlier_chats_subagents
        a running record of the chat's earlier live id (same conversation) whose Claude Code files say it finished is adopted at the
        next turn end and lands
    test_startup_removes_empty_leftovers
        AIB starts with two "done" records of a chat that is not open, finished an hour ago (leftovers from before an update): the
        one with no changes goes by itself (worktree, branch, record); the one with a commit is kept for its chat.

Needs node, the Claude Code ACP adapter (AIB_CLAUDE_ACP or a global npm install) and Go (keeper program; AIB_TEST_KEEPER_BIN names a
built one). Run with TEMP/TMP pointed at a scratch folder.
"""
import _isolation  # noqa: F401  (test isolation: temp state folder, real per-user folder blocked)
import hashlib
import json
import os
import pathlib
import time
import unittest

from _e2e_support import run_git  # noqa: E402
from test_folder_chat_listing_e2e import CLAUDE_ACP, NODE  # noqa: E402
from test_subagent_worktree_e2e import GO, dumped  # noqa: E402
from test_subagent_landing_e2e import SERVER_KIND, Aib, agent_call, bash, git_log, notes, records  # noqa: E402


def branches(project):
    return {b.strip(' +*') for b in run_git(project, 'branch', '--list', 'studio/sub-*').splitlines() if b.strip()}


def by_description(fx, description):
    return [r for r in records(fx).values() if r.get('description') == description]


def repo_hash(project):
    """worktrees.ts repoHash: sha1 of the project's normcased real path, first 10 hex digits."""
    return hashlib.sha1(os.path.normcase(os.path.realpath(str(project))).encode('utf-8')).hexdigest()[:10]


@unittest.skipUnless(NODE and CLAUDE_ACP, 'needs node and the Claude Code ACP adapter (AIB_CLAUDE_ACP or a global npm install)')
@unittest.skipUnless(GO or os.environ.get('AIB_TEST_KEEPER_BIN'), 'needs Go to build the keeper program (or AIB_TEST_KEEPER_BIN)')
@unittest.skipUnless(SERVER_KIND == 'deno-split', 'runs against AIB_SERVER=deno-split (the default)')
class AibSubagentCleanupTest(unittest.TestCase):

    def test_finished_land_or_go_beside_a_running_one(self):
        rules = [
            {'when': 'SC-GO', 'reply': {'tools': [
                agent_call('toolu_pL1', 'sc long', 'SUBTASK-LONG: do the work', background=True),
                agent_call('toolu_pE1', 'sc empty', 'SUBTASK-EMPTY: do the work', background=True),
                agent_call('toolu_pC1', 'sc change', 'SUBTASK-CHG: do the work', background=True),
            ]}},
            {'when': 'SUBTASK-LONG', 'reply': {'tools': [bash('toolu_sL1', 'ping -n 76 127.0.0.1 > /dev/null; echo from-long > long.txt')]}},
            {'when': 'toolu_sL1', 'reply': {'text': 'SUB-LONG-DONE'}},
            {'when': 'SUBTASK-EMPTY', 'reply': {'tools': [bash('toolu_sE1', 'sleep 8 && echo nothing-changed')]}},
            {'when': 'toolu_sE1', 'reply': {'text': 'SUB-EMPTY-DONE'}},
            {'when': 'SUBTASK-CHG', 'reply': {'tools': [bash('toolu_sC1', 'sleep 8 && echo from-chg > chg.txt')]}},
            {'when': 'toolu_sC1', 'reply': {'text': 'SUB-CHG-DONE'}},
            {'when': 'toolu_pC1', 'reply': {'text': 'PARENT-LAUNCHED'}},
        ]
        aib = Aib(self, rules)
        p, fx = aib.project, aib.fx
        aib.turn('SC-GO go')  # the turn ends with the three still at work (AIB ends a held turn early)
        aib.wait('all three to have worktrees', lambda: all(by_description(fx, d) for d in ('sc long', 'sc empty', 'sc change')))
        empty = by_description(fx, 'sc empty')[0]

        def settled():
            return ('AIB: subagent sc change' in git_log(p) and not by_description(fx, 'sc empty')
                    and empty['branch'] not in branches(p) and not pathlib.Path(empty['path']).exists())
        try:
            aib.wait('the finished ones to land or go while "sc long" runs', settled, seconds=55)
        except AssertionError:
            print(json.dumps(records(fx), indent=1), file=__import__('sys').stderr)
            raise
        long = by_description(fx, 'sc long')
        if not (long and long[0]['state'] == 'running'):
            sent = dumped(aib.stub)
            at = sent.find('toolu_sL1')
            self.fail(f'"sc long" should still run: {long}; log: {git_log(p)}; its tool result: {sent[at:at + 800]}')
        self.assertFalse((p / 'long.txt').exists())
        self.assertEqual((p / 'chg.txt').read_text(encoding='utf-8').strip(), 'from-chg')
        self.assertNotIn('AIB: subagent sc empty', git_log(p), 'a subagent with no changes lands no commit')
        aib.wait('"sc change" to go after landing', lambda: not by_description(fx, 'sc change'))

        aib.wait('"sc long" to land after it ends', lambda: 'AIB: subagent sc long' in git_log(p), seconds=150)
        self.assertEqual((p / 'long.txt').read_text(encoding='utf-8').strip(), 'from-long')
        aib.wait('"sc long" to go after landing', lambda: not by_description(fx, 'sc long'))
        spares = {r['branch'] for r in records(fx).values() if r['state'] == 'spare'}
        self.assertEqual(branches(p) - spares, set(), 'every finished subagent branch must go')

    def test_parallel_calls_land_under_their_own_names(self):
        """Bug 2026-11-16: three Agent calls in one message; each landing commit carries its own subagent's description and file."""
        rules = [
            {'when': 'PN-GO', 'reply': {'tools': [
                agent_call('toolu_pN1', 'pn alpha', 'SUBTASK-ALPHA: do the work', background=True),
                agent_call('toolu_pN2', 'pn beta', 'SUBTASK-BETA: do the work', background=True),
                agent_call('toolu_pN3', 'pn gamma', 'SUBTASK-GAMMA: do the work', background=True),
            ]}},
            {'when': 'SUBTASK-ALPHA', 'reply': {'tools': [bash('toolu_sN1', 'sleep 6 && mkdir -p pn && echo alpha > pn/alpha.txt')]}},
            {'when': 'toolu_sN1', 'reply': {'text': 'SUB-ALPHA-DONE'}},
            {'when': 'SUBTASK-BETA', 'reply': {'tools': [bash('toolu_sN2', 'sleep 2 && mkdir -p pn && echo beta > pn/beta.txt')]}},
            {'when': 'toolu_sN2', 'reply': {'text': 'SUB-BETA-DONE'}},
            {'when': 'SUBTASK-GAMMA', 'reply': {'tools': [bash('toolu_sN3', 'sleep 4 && mkdir -p pn && echo gamma > pn/gamma.txt')]}},
            {'when': 'toolu_sN3', 'reply': {'text': 'SUB-GAMMA-DONE'}},
            {'when': 'toolu_pN3', 'reply': {'text': 'PARENT-LAUNCHED'}},
        ]
        aib = Aib(self, rules)
        p = aib.project
        aib.turn('PN-GO go')
        aib.wait('all three to land', lambda: all(f'AIB: subagent pn {n}' in git_log(p) for n in ('alpha', 'beta', 'gamma')), seconds=150)
        for name in ('alpha', 'beta', 'gamma'):
            sha = run_git(p, 'log', '--format=%H', '--grep', f'^AIB: subagent pn {name}$', '-n', '1').strip()
            self.assertTrue(sha, name)
            self.assertEqual(run_git(p, 'show', '--name-only', '--format=', sha).strip(), f'pn/{name}.txt', f'"pn {name}" landed another subagent\'s work')

    def test_scratch_only_subagent_is_kept_and_the_parent_told(self):
        """Bug 2026-11-16: a design subagent that only wrote a page and a note at its worktree top lands nothing; the main agent's next
        prompt names the files and the worktree; nothing reaches the project."""
        rules = [
            {'when': 'SO-GO', 'reply': {'tools': [agent_call('toolu_pS1', 'so design', 'SUBTASK-DESIGN: do the work', background=True)]}},
            {'when': 'SUBTASK-DESIGN', 'reply': {'tools': [bash('toolu_sS1', 'echo "<p>mock</p>" > so-design.html && echo "# review" > so-review.md')]}},
            {'when': 'toolu_sS1', 'reply': {'text': 'SUB-DESIGN-DONE'}},
            {'when': 'toolu_pS1', 'reply': {'text': 'PARENT-LAUNCHED'}},
            {'when': 'SO-NEXT', 'reply': {'text': 'PARENT-NEXT'}},
        ]
        aib = Aib(self, rules)
        p, fx = aib.project, aib.fx
        aib.turn('SO-GO go')
        aib.wait('the scratch line in the chat', lambda: any('so design' in n and 'only left new files' in n for n in notes(aib.chat)), seconds=90)
        rec = by_description(fx, 'so design')
        self.assertTrue(rec, 'its record is kept')
        self.assertTrue(pathlib.Path(rec[0]['path'], 'so-design.html').is_file(), 'the page stays in its worktree')
        self.assertFalse((p / 'so-design.html').exists())
        self.assertNotIn('AIB: subagent so design', git_log(p))
        aib.turn('SO-NEXT go')
        sent = dumped(aib.stub)
        at = sent.find('left new files in its worktree')
        self.assertGreater(at, -1, 'the main agent was told')
        told = sent[at:at + 900]
        self.assertIn('so-design.html', told)
        self.assertIn('so-review.md', told)
        self.assertIn('merge_helper', told)

    def test_restart_adopts_the_earlier_chats_subagents(self):
        """Bug 2026-11-16: the chat's live id changed (same conversation); its old subagent finished but its SubagentStop never
        reached AIB. At the chat's next turn end AIB adopts it, reads Claude Code's files (finished, end_turn) and lands it."""
        rules = [
            {'when': 'RS-HELLO', 'reply': {'text': 'PARENT-HELLO'}},
            {'when': 'RS-NEXT', 'reply': {'text': 'PARENT-NEXT'}},
        ]
        aib = Aib(self, rules)
        p, fx = aib.project, aib.fx
        aib.turn('RS-HELLO go')
        session = aib.chat.session
        self.assertTrue(session)
        transcripts = list(aib.temp.rglob(f'{session}.jsonl'))
        self.assertTrue(transcripts, 'the session transcript (in the agent\'s throwaway home)')
        agent = 'a0ld5e55107d1e'
        side = transcripts[0].parent / session / 'subagents'
        side.mkdir(parents=True, exist_ok=True)
        (side / f'agent-{agent}.meta.json').write_text(json.dumps({'agentType': 'general-purpose', 'description': 'rs old work',
                                                                     'toolUseId': 'toolu_rsOld', 'finished': True}), encoding='utf-8')
        (side / f'agent-{agent}.jsonl').write_text(json.dumps({'type': 'assistant', 'message': {'stop_reason': 'end_turn', 'content': []}}) + '\n',
                                                   encoding='utf-8')
        head = run_git(p, 'rev-parse', 'HEAD').strip()
        folder = fx.state / 'worktrees' / repo_hash(p)
        folder.mkdir(parents=True, exist_ok=True)
        slug = 'sub-c533d888-1'
        path = folder / slug
        run_git(p, 'worktree', 'add', '-q', '-b', f'studio/{slug}', str(path), head)
        run_git(p, 'worktree', 'lock', '--reason', 'AIB subagent', str(path))
        (path / 'rs').mkdir()
        (path / 'rs' / 'old.txt').write_text('from-old\n', encoding='utf-8')
        subs = records(fx)
        t = time.time() - 600
        subs['sa_c533old001'] = {
            'id': 'sa_c533old001', 'kind': 'subagent', 'chat': 'c533d888' + 'a' * 24, 'lasting': f'claude:{session}',
            'project': str(p), 'folder': str(p), 'slug': slug, 'branch': f'studio/{slug}', 'path': str(path), 'snapshot': head,
            'tree': run_git(p, 'rev-parse', 'HEAD^{tree}').strip(), 'state': 'running', 'toolUseId': 'toolu_rsOld', 'agentId': agent,
            'agentType': 'general-purpose', 'description': 'rs old work', 'createdAt': t, 'boundAt': t, 'acpSeen': True, 'acpAgentId': agent,
            'background': True,
        }
        (fx.state / 'subagent-worktrees.json').write_text(json.dumps({'version': 1, 'subagents': subs}), encoding='utf-8')
        aib.turn('RS-NEXT go')
        aib.wait('the adopted subagent to land', lambda: 'AIB: subagent rs old work' in git_log(p), seconds=60)
        self.assertEqual((p / 'rs' / 'old.txt').read_text(encoding='utf-8').strip(), 'from-old')
        aib.wait('its worktree, branch and record to go', lambda: not by_description(fx, 'rs old work') and f'studio/{slug}' not in branches(p)
                 and not path.exists())

    def test_startup_removes_empty_leftovers(self):
        chat = '0dd0dd00' + 'a' * 24
        seeded = {}

        def seed(aib):
            p = aib.project
            head = run_git(p, 'rev-parse', 'HEAD').strip()
            tree = run_git(p, 'rev-parse', 'HEAD^{tree}').strip()
            folder = aib.fx.state / 'worktrees' / repo_hash(p)
            folder.mkdir(parents=True)
            subs = {}
            for n, (rid, desc) in enumerate((('sa_0dd0empty', 'left empty'), ('sa_0dd0chang', 'left changed')), start=1):
                slug = f'sub-0dd0dd00-{n}'
                path = folder / slug
                run_git(p, 'worktree', 'add', '-q', '-b', f'studio/{slug}', str(path), head)
                run_git(p, 'worktree', 'lock', '--reason', 'AIB subagent', str(path))
                if desc == 'left changed':
                    (path / 'kept.txt').write_text('work\n', encoding='utf-8')
                    run_git(path, 'add', 'kept.txt')
                    run_git(path, 'commit', '-q', '-m', 'sub work')
                done = time.time() - 3600
                subs[rid] = {
                    'id': rid, 'kind': 'subagent', 'chat': chat, 'lasting': 'claude:0dd0dd00-0000-0000-0000-000000000000',
                    'project': str(p), 'folder': str(p), 'slug': slug, 'branch': f'studio/{slug}', 'path': str(path),
                    'snapshot': head, 'tree': tree, 'state': 'done', 'toolUseId': f'toolu_{rid}', 'agentId': f'a{n}0dd0dd0',
                    'agentType': 'general-purpose', 'description': desc, 'createdAt': done - 60, 'boundAt': done - 59,
                    'acpSeen': True, 'acpAgentId': f'a{n}0dd0dd0',
                    'hints': {'postAgent': {'at': done - 59, 'status': 'async_launched'}, 'stops': 1, 'lastStopAt': done}, 'doneAt': done,
                }
                seeded[desc] = subs[rid]
            (aib.fx.state / 'subagent-worktrees.json').write_text(json.dumps({'version': 1, 'subagents': subs}), encoding='utf-8')

        aib = Aib(self, [], seed=seed)
        p, fx = aib.project, aib.fx
        gone = seeded['left empty']
        aib.wait('the empty leftover to go', lambda: not by_description(fx, 'left empty') and gone['branch'] not in branches(p)
                 and not pathlib.Path(gone['path']).exists(), seconds=60)
        time.sleep(5)  # a few polls more: the one with work must stay for its chat
        kept = seeded['left changed']
        self.assertTrue(by_description(fx, 'left changed'), 'the leftover with a commit must be kept')
        self.assertTrue(pathlib.Path(kept['path'], 'kept.txt').is_file())
        self.assertIn(kept['branch'], branches(p))
        self.assertFalse((p / 'kept.txt').exists(), 'nothing lands without its chat')


if __name__ == '__main__':
    unittest.main()
