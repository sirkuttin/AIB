/**
 * Subagent worktrees, Codex (server/subagents/codex.ts) (the port of work/test_subagent_codex_e2e.py): e2e with the REAL codex-acp
 * (AIB's pinned 2.6.0: AIB_CODEX_ACP) against the stub model API in script mode (work/stub_model_api.js, Responses namespace
 * tools), a real AIB (deno-split web server + agent host) and temp config only: the model provider reaches Codex through the user's
 * CODEX_CONFIG, which AIB merges its hooks into (so the merge is under test too). Owner rule 2026-11-16: an agent's own subagent that
 * edits files works in its own git worktree and lands like a helper's work; hooks off -> Codex subagents off for that chat.
 *
 *   test_shell_write_lands_at_turn_end   the subagent's exec_command (Set-Content sub-a.txt) runs in its AIB worktree; the main folder
 *                                        has no sub-a.txt while the turn runs (the parent checks); at the turn end one commit
 *                                        "AIB: subagent <message>" lands it; the worktree, branch and record go
 *   test_workspace_mode_worktree_writes_do_not_ask
 *                                        Workspace mode (Codex's unelevated Windows sandbox): the parent's write in the folder and
 *                                        the subagent's in its worktree raise no permission card; the sandbox still refuses the
 *                                        subagent's write outside both
 *   test_absolute_path_into_main_denied  the subagent writes to <project>\escape.txt by absolute path: denied with the worktree
 *                                        named; nothing in the main folder; nothing lands
 *   test_hooks_off_turns_subagents_off   features.hooks = false in the user's CODEX_CONFIG: no hooks; features.multi_agent = false
 *                                        merged into it (the model is offered no spawn_agent); the chat line says so; Activity off
 * Owner guard: the owner's ~/.codex config files keep their mtimes and no new or changed file there mentions the run.
 *
 * Needs node, codex-acp (AIB_CODEX_ACP or a global npm install) and Go (keeper program; AIB_TEST_KEEPER_BIN names a built one), with
 * no space in the temp folder's path (Codex runs a hook command through cmd.exe, program first, unquoted).
 */
import { assert, assertEquals, git, Json, sleep } from './_e2e.ts';
import {
  AibCodex,
  CODEX_ACP,
  dumped,
  execCall,
  HAVE_KEEPER_BIN,
  NODE_EXE,
  notes,
  SERVER_SPLIT,
  spawnCall,
  stubText,
  subagentRecords,
  T,
  waitCall,
} from './_e2e_real.ts';

const ok = !!(NODE_EXE && CODEX_ACP && HAVE_KEEPER_BIN && SERVER_SPLIT);
// the parent's own check, after the subagent ended: the output names what it found (its command text names neither)
const CHECK_A = 'if (Test-Path sub-a.txt) { "main-has-" + "sub-a" } else { "main-has-" + "no-sub-a" }';
const CAPTURE = String.raw`agent_id\W{1,6}([0-9a-f-]{8,})`;
const subBranches = (p: string) => new Set(git(p, 'branch', '--list', 'studio/sub-*').split('\n').map((b) => b.trim().replace(/^[ +*]+/, '')).filter(Boolean));
const spares = (state: string) => new Set(Object.values(subagentRecords(state)).filter((r) => r.state === 'spare').map((r) => r.branch as string));
const rec = (r: unknown) => r as Json;

Deno.test({
  name: 'AibCodexSubagentTest test_shell_write_lands_at_turn_end',
  ignore: !ok,
  ...T,
  async fn() {
    const rules = [
      { when: 'CX-EDIT go', reply: { tools: [spawnCall('call_pSpawnA', 'CX-SUB-A write the file')] } },
      { when: 'CX-SUB-A write', reply: { tools: [execCall('call_sExecA', 'Set-Content -Path sub-a.txt -Value from-sub; (Get-Location).Path')] } },
      { when: 'call_sExecA', reply: { text: 'SUB-A-DONE' } },
      { when: 'call_pSpawnA', capture: CAPTURE, reply: { tools: [waitCall('call_pWaitA')] } },
      { when: 'call_pWaitA', reply: { tools: [execCall('call_pCheckA', CHECK_A)] } },
      { when: 'subagent_notification', once: true, reply: { tools: [execCall('call_pCheckA', CHECK_A)] } },
      { when: 'call_pCheckA', reply: { text: 'PARENT-A-DONE' } },
    ];
    await using aib = await AibCodex.start(rules);
    const p = aib.project;
    const chat = aib.chat;
    assertEquals((await chat.state()).subagentIsolation, { on: true, reason: '', readOnly: [] }, JSON.stringify(await notes(chat)));
    assertEquals(git(p, 'status', '--porcelain'), '', 'the main folder is clean before');
    await aib.turn('CX-EDIT go');
    const sent = dumped(aib.stub);
    try {
      assert((stubText(aib.stub) + sent).includes('SUB-A-DONE'), 'the subagent ran');
      assert(sent.includes('main-has-no-sub-a'), 'the subagent changed the main folder before the turn ended');
      assert(sent.includes('AIB gave you your own git worktree'), 'SubagentStart named its worktree');
      assert(sent.includes('Subagents you start with spawn_agent work in their own git worktree'), 'the system prompt line');
      await aib.wait('the subagent to land', () => git(p, 'log', '--format=%s', '-n', '10').includes('AIB: subagent CX-SUB-A write the file'));
    } catch (error) {
      console.error(await aib.report());
      throw error;
    }
    assertEquals(Deno.readTextFileSync(`${p}/sub-a.txt`).replace(/^﻿/, '').trim(), 'from-sub');
    // P3's Activity line, as for Claude's subagents: by the child's agent id (codex-acp's child session id)
    const seen = ((await chat.state()).subagentWorktrees as Record<string, Json> | undefined) ?? {};
    assert(Object.values(seen).some((v) => v.where === 'Own worktree'), `Activity line: ${JSON.stringify(seen)}`);
    assertEquals(git(p, 'show', '--name-only', '--format=', 'HEAD').split(/\s+/).filter(Boolean), ['sub-a.txt']);
    await aib.wait('the merge line', async () => (await notes(chat)).some((n) => n.startsWith('Merged subagent “CX-SUB-A write the file”')));
    await aib.wait('its worktree to go', () => !Object.values(subagentRecords(aib.fx.state)).some((r) => rec(r).description === 'CX-SUB-A write the file'));
    const left = [...subBranches(p)].filter((b) => !spares(aib.fx.state).has(b));
    assertEquals(left, [], 'the landed subagent branch must go');
  },
});

Deno.test({
  name: 'AibCodexSubagentTest test_workspace_mode_worktree_writes_do_not_ask',
  ignore: !ok,
  ...T,
  /**
   * Workspace mode with Codex's Windows sandbox (unelevated: no admin, nothing shown): the folder is writable without a card, and
   * so is the subagent's own worktree (its chat's <state>/worktrees/<repo hash>/.cx-<chat> is a writable root of that chat only, an
   * ACP additionalDirectories entry). A write outside both is still refused by the sandbox.
   */
  async fn() {
    const rulesFor = (project: string) => {
      const outside = `${project.slice(0, Math.max(project.lastIndexOf('\\'), project.lastIndexOf('/')))}${Deno.build.os === 'windows' ? '\\' : '/'}outside-w.txt`;
      return [
        { when: 'CX-WS go', reply: { tools: [execCall('call_pOwnW', 'Set-Content -Path parent-w.txt -Value from-parent')] } },
        { when: 'call_pOwnW', reply: { tools: [spawnCall('call_pSpawnW', 'CX-SUB-W write the file')] } },
        { when: 'CX-SUB-W write', reply: { tools: [execCall('call_sExecW', 'Set-Content -Path sub-w.txt -Value from-sub')] } },
        { when: 'call_sExecW', reply: { tools: [execCall('call_sOutW', `Set-Content -Path '${outside}' -Value outside`)] } },
        { when: 'call_sOutW', reply: { text: 'SUB-W-DONE' } },
        { when: 'call_pSpawnW', capture: CAPTURE, reply: { tools: [waitCall('call_pWaitW')] } },
        { when: 'call_pWaitW', reply: { text: 'PARENT-W-DONE' } },
        { when: 'subagent_notification', once: true, reply: { text: 'PARENT-W-DONE' } },
      ];
    };
    const userConfig = JSON.parse(Deno.env.get('AIB_TEST_CODEX_WS_CONFIG') || '{"windows": {"sandbox": "unelevated"}}');
    await using aib = await AibCodex.start(rulesFor, userConfig);
    const p = aib.project;
    await aib.turn('CX-WS go');
    try {
      assert((stubText(aib.stub) + dumped(aib.stub)).includes('SUB-W-DONE'), 'the subagent ran');
      await aib.wait('the subagent to land', () => git(p, 'log', '--format=%s', '-n', '10').includes('AIB: subagent CX-SUB-W write the file'));
    } catch (error) {
      console.error(await aib.report(), JSON.stringify(aib.cards, null, 1));
      throw error;
    }
    assertEquals(Deno.readTextFileSync(`${p}/sub-w.txt`).replace(/^﻿/, '').trim(), 'from-sub');
    assertEquals(Deno.readTextFileSync(`${p}/parent-w.txt`).replace(/^﻿/, '').trim(), 'from-parent');
    const asked = JSON.stringify(aib.cards);
    assert(!asked.includes('parent-w.txt'), `the folder write asked: ${asked}`);
    assert(!asked.includes('sub-w.txt'), `the subagent's write in its worktree asked: ${asked}`);
    // outside the folder and the worktree the sandbox still refuses the write (the agent must ask to run it unsandboxed)
    const outsideFile = `${p.slice(0, Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')))}${Deno.build.os === 'windows' ? '\\' : '/'}outside-w.txt`;
    let exists = true;
    try {
      Deno.statSync(outsideFile);
    } catch {
      exists = false;
    }
    assert(!exists, 'a write outside the folder and the worktree went through');
    assert(dumped(aib.stub).includes('outside-w.txt'));
    const sent = stubText(aib.stub) + dumped(aib.stub);
    assert(/Access to the path [\s\S]{0,300}?outside-w\.txt[\s\S]{0,10}? is denied/.test(sent), 'the sandbox refused it');
  },
});

Deno.test({
  name: 'AibCodexSubagentTest test_absolute_path_into_main_denied',
  ignore: !ok,
  ...T,
  async fn() {
    const rulesFor = (project: string) => {
      const target = `${project}${Deno.build.os === 'windows' ? '\\' : '/'}escape.txt`;
      return [
        { when: 'CX-DENY go', reply: { tools: [spawnCall('call_pSpawnB', 'CX-SUB-B try to escape')] } },
        { when: 'CX-SUB-B try', reply: { tools: [execCall('call_sExecB', `Set-Content -Path '${target}' -Value escaped`)] } },
        { when: 'call_sExecB', reply: { text: 'SUB-B-DONE' } },
        { when: 'call_pSpawnB', capture: CAPTURE, reply: { tools: [waitCall('call_pWaitB')] } },
        { when: 'call_pWaitB', reply: { text: 'PARENT-B-DONE' } },
        { when: 'subagent_notification', reply: { text: 'PARENT-B-DONE' } },
      ];
    };
    await using aib = await AibCodex.start(rulesFor); // the project path is only known once AibCodex made it
    await aib.turn('CX-DENY go');
    const sent = dumped(aib.stub);
    try {
      assert(sent.includes("it can't use the main folder"), 'the subagent was told why');
      const used = new Set(aib.stub.calls().map((c) => c.rule));
      assert(used.has(4) || used.has(5), 'the parent went on after its subagent ended');
    } catch (error) {
      console.error(await aib.report());
      throw error;
    }
    let exists = true;
    try {
      Deno.statSync(`${aib.project}/escape.txt`);
    } catch {
      exists = false;
    }
    assert(!exists, 'the subagent wrote into the main folder');
    await sleep(3000); // a landing poll or two: nothing to land
    assertEquals(git(aib.project, 'status', '--porcelain'), '');
    assert(!git(aib.project, 'log', '--format=%s', '-n', '5').includes('AIB: subagent'));
  },
});

Deno.test({
  name: 'AibCodexSubagentTest test_hooks_off_turns_subagents_off',
  ignore: !ok,
  ...T,
  async fn() {
    const rules = [
      { when: 'CX-OFF go', reply: { tools: [spawnCall('call_pSpawnC', 'CX-SUB-C write')] } },
      { when: 'CX-SUB-C write', reply: { tools: [execCall('call_sExecC', 'Set-Content -Path sub-c.txt -Value x')] } },
      { when: 'call_sExecC', reply: { text: 'SUB-C-DONE' } },
      { when: 'call_pSpawnC', reply: { text: 'PARENT-C-DONE' } },
    ];
    await using aib = await AibCodex.start(rules, { features: { hooks: false } });
    const chat = aib.chat;
    assertEquals(((await chat.state()).subagentIsolation as Json | undefined)?.on, false);
    const list = await notes(chat);
    assert(list.some((n) => n.startsWith('Subagents are off in this chat')), JSON.stringify(list));
    await aib.turn('CX-OFF go');
    const offered = new Set<string>();
    for (const c of aib.stub.calls()) {
      if (String(c.path).endsWith('/responses')) for (const t of ((c.tools as string[] | undefined) ?? [])) offered.add(t);
    }
    assert(offered.size > 0, 'the model was offered tools');
    assertEquals([...offered].filter((t) => t.includes('spawn_agent') || t.includes('multi_agent')), [], `subagent tools offered: ${[...offered].sort()}`);
    assert(!(stubText(aib.stub) + dumped(aib.stub)).includes('SUB-C-DONE'));
    let exists = true;
    try {
      Deno.statSync(`${aib.project}/sub-c.txt`);
    } catch {
      exists = false;
    }
    assert(!exists);
    assert(dumped(aib.stub).includes('subagents (spawn_agent) are turned off'));
  },
});
