/**
 * Subagent worktrees: finished subagents land or go while another subagent still runs (beta 11 bug, seen live 2026-11-16) (the port
 * of work/test_subagent_cleanup_e2e.py). E2e with the REAL Claude Code adapter against the stub model API (work/stub_model_api.js
 * script mode), temp config and temp dirs only.
 *
 * The bug: a lead chat that always has a background subagent at work was never "idle" for a landing (connection.ts
 * landingIdleReason counted every running subagent, its own worktree or not), so finished subagents, with changes or none, kept
 * their worktree, branch and record for as long as any other subagent ran.
 *
 *   test_finished_land_or_go_beside_a_running_one
 *       one turn starts three background subagents and ends: "sc long" (works for a minute, then writes long.txt), "sc empty"
 *       (changes nothing) and "sc change" (writes chg.txt). While "sc long" still runs, "sc empty"'s worktree, branch and record go
 *       and "sc change" lands as its commit; then "sc long" lands too.
 *   test_parallel_calls_land_under_their_own_names
 *       three Agent calls in one message: each landing commit carries its own description and only its own file (bug 2026-11-16)
 *   test_scratch_only_subagent_is_kept_and_the_parent_told
 *       a subagent that only wrote a page and a note at its worktree top lands nothing; its files stay; the next prompt names them
 *   test_restart_adopts_the_earlier_chats_subagents
 *       a running record of the chat's earlier live id (same conversation) whose Claude Code files say it finished is adopted at the
 *       next turn end and lands
 *   test_startup_removes_empty_leftovers
 *       AIB starts with two "done" records of a chat that is not open, finished an hour ago (leftovers from before an update): the
 *       one with no changes goes by itself (worktree, branch, record); the one with a commit is kept for its chat.
 *
 * Needs node, the Claude Code ACP adapter (AIB_CLAUDE_ACP or a global npm install) and Go (keeper program; AIB_TEST_KEEPER_BIN names
 * a built one). Run with TEMP/TMP pointed at a scratch folder.
 */
import { assert, assertEquals, git, isDir, isFile, Json, normcase, repoHash, sleep } from './_e2e.ts';
import {
  agentCall,
  Aib,
  bash,
  CLAUDE_ACP,
  dumped,
  gitLog,
  HAVE_KEEPER_BIN,
  join,
  NODE_EXE,
  notes,
  SERVER_SPLIT,
  subagentRecords,
  T,
} from './_e2e_real.ts';

const ok = !!(NODE_EXE && CLAUDE_ACP && HAVE_KEEPER_BIN && SERVER_SPLIT);

const branches = (project: string) => new Set(git(project, 'branch', '--list', 'studio/sub-*').split('\n').map((b) => b.trim().replace(/^[ +*]+/, '')).filter(Boolean));
const byDescription = (aib: Aib, description: string) => Object.values(subagentRecords(aib.fx.state)).filter((r) => r.description === description);
const spareBranches = (aib: Aib) => new Set(Object.values(subagentRecords(aib.fx.state)).filter((r) => r.state === 'spare').map((r) => r.branch as string));
const difference = (a: Set<string>, b: Set<string>) => [...a].filter((x) => !b.has(x));
const exists = (p: string) => {
  try {
    Deno.statSync(p);
    return true;
  } catch {
    return false;
  }
};

Deno.test({
  name: 'AibSubagentCleanupTest test_finished_land_or_go_beside_a_running_one',
  ignore: !ok,
  ...T,
  async fn() {
    const rules = [
      {
        when: 'SC-GO',
        reply: {
          tools: [
            agentCall('toolu_pL1', 'sc long', 'SUBTASK-LONG: do the work', true),
            agentCall('toolu_pE1', 'sc empty', 'SUBTASK-EMPTY: do the work', true),
            agentCall('toolu_pC1', 'sc change', 'SUBTASK-CHG: do the work', true),
          ],
        },
      },
      { when: 'SUBTASK-LONG', reply: { tools: [bash('toolu_sL1', 'ping -n 76 127.0.0.1 > /dev/null; echo from-long > long.txt')] } },
      { when: 'toolu_sL1', reply: { text: 'SUB-LONG-DONE' } },
      { when: 'SUBTASK-EMPTY', reply: { tools: [bash('toolu_sE1', 'sleep 8 && echo nothing-changed')] } },
      { when: 'toolu_sE1', reply: { text: 'SUB-EMPTY-DONE' } },
      { when: 'SUBTASK-CHG', reply: { tools: [bash('toolu_sC1', 'sleep 8 && echo from-chg > chg.txt')] } },
      { when: 'toolu_sC1', reply: { text: 'SUB-CHG-DONE' } },
      { when: 'toolu_pC1', reply: { text: 'PARENT-LAUNCHED' } },
    ];
    await using aib = await Aib.start(rules);
    const p = aib.project;
    await aib.turn('SC-GO go'); // the turn ends with the three still at work (AIB ends a held turn early)
    await aib.wait('all three to have worktrees', () => ['sc long', 'sc empty', 'sc change'].every((d) => byDescription(aib, d).length));
    const empty = byDescription(aib, 'sc empty')[0];
    const settled = () =>
      gitLog(p).includes('AIB: subagent sc change') && !byDescription(aib, 'sc empty').length && !branches(p).has(empty.branch as string) && !exists(empty.path as string);
    try {
      await aib.wait('the finished ones to land or go while "sc long" runs', settled, 55);
    } catch (error) {
      console.error(JSON.stringify(subagentRecords(aib.fx.state), null, 1));
      throw error;
    }
    const long = byDescription(aib, 'sc long');
    if (!(long.length && long[0].state === 'running')) {
      const sent = dumped(aib.stub);
      const at = sent.indexOf('toolu_sL1');
      throw new Error(`"sc long" should still run: ${JSON.stringify(long)}; log: ${gitLog(p)}; its tool result: ${sent.slice(at, at + 800)}`);
    }
    assert(!isFile(join(p, 'long.txt')));
    assertEquals(Deno.readTextFileSync(join(p, 'chg.txt')).trim(), 'from-chg');
    assert(!gitLog(p).includes('AIB: subagent sc empty'), 'a subagent with no changes lands no commit');
    await aib.wait('"sc change" to go after landing', () => !byDescription(aib, 'sc change').length);

    await aib.wait('"sc long" to land after it ends', () => gitLog(p).includes('AIB: subagent sc long'), 150);
    assertEquals(Deno.readTextFileSync(join(p, 'long.txt')).trim(), 'from-long');
    await aib.wait('"sc long" to go after landing', () => !byDescription(aib, 'sc long').length);
    assertEquals(difference(branches(p), spareBranches(aib)), [], 'every finished subagent branch must go');
  },
});

Deno.test({
  name: 'AibSubagentCleanupTest test_parallel_calls_land_under_their_own_names',
  ignore: !ok,
  ...T,
  // Bug 2026-11-16: three Agent calls in one message; each landing commit carries its own subagent's description and file.
  async fn() {
    const rules = [
      {
        when: 'PN-GO',
        reply: {
          tools: [
            agentCall('toolu_pN1', 'pn alpha', 'SUBTASK-ALPHA: do the work', true),
            agentCall('toolu_pN2', 'pn beta', 'SUBTASK-BETA: do the work', true),
            agentCall('toolu_pN3', 'pn gamma', 'SUBTASK-GAMMA: do the work', true),
          ],
        },
      },
      { when: 'SUBTASK-ALPHA', reply: { tools: [bash('toolu_sN1', 'sleep 6 && mkdir -p pn && echo alpha > pn/alpha.txt')] } },
      { when: 'toolu_sN1', reply: { text: 'SUB-ALPHA-DONE' } },
      { when: 'SUBTASK-BETA', reply: { tools: [bash('toolu_sN2', 'sleep 2 && mkdir -p pn && echo beta > pn/beta.txt')] } },
      { when: 'toolu_sN2', reply: { text: 'SUB-BETA-DONE' } },
      { when: 'SUBTASK-GAMMA', reply: { tools: [bash('toolu_sN3', 'sleep 4 && mkdir -p pn && echo gamma > pn/gamma.txt')] } },
      { when: 'toolu_sN3', reply: { text: 'SUB-GAMMA-DONE' } },
      { when: 'toolu_pN3', reply: { text: 'PARENT-LAUNCHED' } },
    ];
    await using aib = await Aib.start(rules);
    const p = aib.project;
    await aib.turn('PN-GO go');
    await aib.wait('all three to land', () => ['alpha', 'beta', 'gamma'].every((n) => gitLog(p).includes(`AIB: subagent pn ${n}`)), 150);
    for (const name of ['alpha', 'beta', 'gamma']) {
      const sha = git(p, 'log', '--format=%H', '--grep', `^AIB: subagent pn ${name}$`, '-n', '1').trim();
      assert(sha, name);
      assertEquals(git(p, 'show', '--name-only', '--format=', sha).trim(), `pn/${name}.txt`, `"pn ${name}" landed another subagent's work`);
    }
  },
});

Deno.test({
  name: 'AibSubagentCleanupTest test_scratch_only_subagent_is_kept_and_the_parent_told',
  ignore: !ok,
  ...T,
  /**
   * Bug 2026-11-16: a design subagent that only wrote a page and a note at its worktree top lands nothing; the main agent's next
   * prompt names the files and the worktree; nothing reaches the project.
   */
  async fn() {
    const rules = [
      { when: 'SO-GO', reply: { tools: [agentCall('toolu_pS1', 'so design', 'SUBTASK-DESIGN: do the work', true)] } },
      { when: 'SUBTASK-DESIGN', reply: { tools: [bash('toolu_sS1', 'echo "<p>mock</p>" > so-design.html && echo "# review" > so-review.md')] } },
      { when: 'toolu_sS1', reply: { text: 'SUB-DESIGN-DONE' } },
      { when: 'toolu_pS1', reply: { text: 'PARENT-LAUNCHED' } },
      { when: 'SO-NEXT', reply: { text: 'PARENT-NEXT' } },
    ];
    await using aib = await Aib.start(rules);
    const p = aib.project;
    await aib.turn('SO-GO go');
    await aib.wait('the scratch line in the chat', async () => (await notes(aib.chat)).some((n) => n.includes('so design') && n.includes('only left new files')), 90);
    const rec = byDescription(aib, 'so design');
    assert(rec.length, 'its record is kept');
    assert(isFile(join(rec[0].path as string, 'so-design.html')), 'the page stays in its worktree');
    assert(!exists(join(p, 'so-design.html')));
    assert(!gitLog(p).includes('AIB: subagent so design'));
    await aib.turn('SO-NEXT go');
    const sent = dumped(aib.stub);
    const at = sent.indexOf('left new files in its worktree');
    assert(at > -1, 'the main agent was told');
    const told = sent.slice(at, at + 900);
    assert(told.includes('so-design.html'));
    assert(told.includes('so-review.md'));
    assert(told.includes('merge_helper'));
  },
});

Deno.test({
  name: 'AibSubagentCleanupTest test_restart_adopts_the_earlier_chats_subagents',
  ignore: !ok,
  ...T,
  /**
   * Bug 2026-11-16: the chat's live id changed (same conversation); its old subagent finished but its SubagentStop never reached AIB.
   * At the chat's next turn end AIB adopts it, reads Claude Code's files (finished, end_turn) and lands it.
   */
  async fn() {
    const rules = [
      { when: 'RS-HELLO', reply: { text: 'PARENT-HELLO' } },
      { when: 'RS-NEXT', reply: { text: 'PARENT-NEXT' } },
    ];
    await using aib = await Aib.start(rules);
    const p = aib.project;
    const fx = aib.fx;
    await aib.turn('RS-HELLO go');
    const session = await aib.chat.session();
    assert(session);
    const transcripts: string[] = [];
    const walk = (dir: string) => {
      for (const e of Deno.readDirSync(dir)) {
        if (e.isDirectory) walk(join(dir, e.name));
        else if (e.name === `${session}.jsonl`) transcripts.push(join(dir, e.name));
      }
    };
    walk(aib.temp.path);
    assert(transcripts.length, "the session transcript (in the agent's throwaway home)");
    const agent = 'a0ld5e55107d1e';
    const parent = transcripts[0].slice(0, Math.max(transcripts[0].lastIndexOf('\\'), transcripts[0].lastIndexOf('/')));
    const side = join(parent, session, 'subagents');
    Deno.mkdirSync(side, { recursive: true });
    Deno.writeTextFileSync(join(side, `agent-${agent}.meta.json`), JSON.stringify({ agentType: 'general-purpose', description: 'rs old work', toolUseId: 'toolu_rsOld', finished: true }));
    Deno.writeTextFileSync(join(side, `agent-${agent}.jsonl`), JSON.stringify({ type: 'assistant', message: { stop_reason: 'end_turn', content: [] } }) + '\n');
    const head = git(p, 'rev-parse', 'HEAD').trim();
    const folder = join(fx.state, 'worktrees', repoHash(p));
    Deno.mkdirSync(folder, { recursive: true });
    const slug = 'sub-c533d888-1';
    const path = join(folder, slug);
    git(p, 'worktree', 'add', '-q', '-b', `studio/${slug}`, path, head);
    git(p, 'worktree', 'lock', '--reason', 'AIB subagent', path);
    Deno.mkdirSync(join(path, 'rs'));
    Deno.writeTextFileSync(join(path, 'rs', 'old.txt'), 'from-old\n');
    const subs = subagentRecords(fx.state);
    const t = Date.now() / 1000 - 600;
    subs['sa_c533old001'] = {
      id: 'sa_c533old001', kind: 'subagent', chat: 'c533d888' + 'a'.repeat(24), lasting: `claude:${session}`,
      project: p, folder: p, slug, branch: `studio/${slug}`, path, snapshot: head,
      tree: git(p, 'rev-parse', 'HEAD^{tree}').trim(), state: 'running', toolUseId: 'toolu_rsOld', agentId: agent,
      agentType: 'general-purpose', description: 'rs old work', createdAt: t, boundAt: t, acpSeen: true, acpAgentId: agent,
      background: true,
    } as Json;
    Deno.writeTextFileSync(join(fx.state, 'subagent-worktrees.json'), JSON.stringify({ version: 1, subagents: subs }));
    await aib.turn('RS-NEXT go');
    await aib.wait('the adopted subagent to land', () => gitLog(p).includes('AIB: subagent rs old work'), 60);
    assertEquals(Deno.readTextFileSync(join(p, 'rs', 'old.txt')).trim(), 'from-old');
    await aib.wait('its worktree, branch and record to go', () => !byDescription(aib, 'rs old work').length && !branches(p).has(`studio/${slug}`) && !exists(path));
  },
});

Deno.test({
  name: 'AibSubagentCleanupTest test_startup_removes_empty_leftovers',
  ignore: !ok,
  ...T,
  async fn() {
    const chat = '0dd0dd00' + 'a'.repeat(24);
    const seeded: Record<string, Json> = {};
    const seed = (aib: Aib) => {
      const p = aib.project;
      const head = git(p, 'rev-parse', 'HEAD').trim();
      const tree = git(p, 'rev-parse', 'HEAD^{tree}').trim();
      const folder = join(aib.fx.state, 'worktrees', repoHash(p));
      Deno.mkdirSync(folder, { recursive: true });
      const subs: Record<string, Json> = {};
      [['sa_0dd0empty', 'left empty'], ['sa_0dd0chang', 'left changed']].forEach(([rid, desc], index) => {
        const n = index + 1;
        const slug = `sub-0dd0dd00-${n}`;
        const path = join(folder, slug);
        git(p, 'worktree', 'add', '-q', '-b', `studio/${slug}`, path, head);
        git(p, 'worktree', 'lock', '--reason', 'AIB subagent', path);
        if (desc === 'left changed') {
          Deno.writeTextFileSync(join(path, 'kept.txt'), 'work\n');
          git(path, 'add', 'kept.txt');
          git(path, 'commit', '-q', '-m', 'sub work');
        }
        const done = Date.now() / 1000 - 3600;
        subs[rid] = {
          id: rid, kind: 'subagent', chat, lasting: 'claude:0dd0dd00-0000-0000-0000-000000000000',
          project: p, folder: p, slug, branch: `studio/${slug}`, path,
          snapshot: head, tree, state: 'done', toolUseId: `toolu_${rid}`, agentId: `a${n}0dd0dd0`,
          agentType: 'general-purpose', description: desc, createdAt: done - 60, boundAt: done - 59,
          acpSeen: true, acpAgentId: `a${n}0dd0dd0`,
          hints: { postAgent: { at: done - 59, status: 'async_launched' }, stops: 1, lastStopAt: done }, doneAt: done,
        };
        seeded[desc] = subs[rid];
      });
      Deno.writeTextFileSync(join(aib.fx.state, 'subagent-worktrees.json'), JSON.stringify({ version: 1, subagents: subs }));
    };
    await using aib = await Aib.start([], { seed });
    const p = aib.project;
    const gone = seeded['left empty'];
    await aib.wait('the empty leftover to go', () => !byDescription(aib, 'left empty').length && !branches(p).has(gone.branch as string) && !exists(gone.path as string), 60);
    await sleep(5000); // a few polls more: the one with work must stay for its chat
    const kept = seeded['left changed'];
    assert(byDescription(aib, 'left changed').length, 'the leftover with a commit must be kept');
    assert(isFile(join(kept.path as string, 'kept.txt')));
    assert(branches(p).has(kept.branch as string));
    assert(!isFile(join(p, 'kept.txt')), 'nothing lands without its chat');
    void isDir;
    void normcase;
  },
});
