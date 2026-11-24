/**
 * Subagent worktrees, P2 (landing) (the port of work/test_subagent_landing_e2e.py): e2e with the REAL Claude Code adapter against
 * the stub model API (work/stub_model_api.js script mode), temp config and temp dirs only. Design: aib-shared/designs/
 * subagent-worktrees/design.md v2 (P2), owner 2026-11-16: subagent work lands exactly like helpers' work (swarm/service.ts helper
 * landing).
 *
 *   HooksOffAdapterTest     the adapter alone (work/acp_probe.js) with `disableAllHooks` in the temp user settings and the per-session
 *                           permission deny AIB sends then (subagents/claude_config.ts subagentsOffSettings): the editing Agent call
 *                           is refused (named type and no type at all), Explore still runs, nothing is written in the folder.
 *   AibSubagentLandingTest  a real AIB (deno-split web server + agent host), a Claude chat in a temp git project:
 *                             B1   foreground editing subagent: nothing in the folder before the turn ends; then one AIB commit
 *                                  "AIB: subagent <description>" on the folder's branch with its file; the main agent's uncommitted
 *                                  edit survives uncommitted; "Merged subagent" line with Undo; its worktree, branch and record gone
 *                             B5   background subagent: lands after its SubagentStop, once the parent is idle
 *                             B6   clash: it changed a file the folder has uncommitted: nothing lands, nothing stashed, the main agent
 *                                  is told (next prompt) with merge_helper and the id; after the edit is committed it lands
 *                             B17  protected path (.husky/pre-commit by Bash): nothing lands, told; the worktree is kept
 *                             B10  hooks off in the user's Claude settings: the editing subagent is refused, the chat line says so
 *                             B21  the user's own WorktreeCreate hook: AIB sends none, adopts the worktree, lands it, never removes it
 *                             P3   a `context: fork` skill is refused (PreToolUse(Skill)); an ordinary skill runs. Typed by the
 *                                  user as `/forker` (no Skill call, no hook), AIB doesn't send it and says why; a typed `/plain` goes
 * Crash recovery (B8) and the junction-safe removal are pinned by work/deno/subagent_landing_test.ts.
 *
 * Needs node, the Claude Code ACP adapter (AIB_CLAUDE_ACP or a global npm install) and Go (keeper program; AIB_TEST_KEEPER_BIN names
 * a built one). Run with TEMP/TMP pointed at a scratch folder.
 */
import { assert, assertEquals, git, isDir, isFile, Json, sleep } from './_e2e.ts';
import {
  agentCall,
  Aib,
  bash,
  CLAUDE_ACP,
  dumped,
  gitLog,
  HAVE_KEEPER_BIN,
  join,
  makeProject,
  NODE_EXE,
  notes,
  OwnerUntouched,
  SERVER_SPLIT,
  Stub,
  stubClaudeEnv,
  stubText,
  subagentRecords,
  T,
  Temp,
  uuid,
} from './_e2e_real.ts';
import { acpProbe } from './_e2e.ts';

const OFF_LINE = 'Subagents that edit files are off in this chat';
const HOOKS_OFF_DENY = ['Agent(general-purpose)', 'Agent(claude)', 'Agent(fork)', 'Task(general-purpose)', 'Task(claude)', 'Task(fork)', 'Workflow', 'EnterWorktree'];
const aibOk = !!(NODE_EXE && CLAUDE_ACP && HAVE_KEEPER_BIN && SERVER_SPLIT);
const exists = (p: string) => {
  try {
    Deno.statSync(p);
    return true;
  } catch {
    return false;
  }
};
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

function tempEnv(temp: Temp, home: string): Record<string, string> {
  const env: Record<string, string> = { ...Deno.env.toObject() };
  for (const name of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT']) delete env[name];
  for (const name of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME']) env[name] = home;
  Object.assign(env, {
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    CLAUDE_CONFIG_DIR: temp.join('claude'),
    TEMP: temp.join('tmp'),
    TMP: temp.join('tmp'),
    TMPDIR: temp.join('tmp'),
  });
  return env;
}

Deno.test({
  name: 'HooksOffAdapterTest test_permission_deny_blocks_editing_subagents_with_hooks_off',
  ignore: !(NODE_EXE && CLAUDE_ACP),
  ...T,
  async fn() {
    using temp = new Temp('aib-sr2-off-');
    const mark = `srp2${uuid().slice(0, 6)}`;
    const project = makeProject(temp.path, mark);
    using _own = new OwnerUntouched([mark]);
    const home = temp.join('home');
    for (const sub of ['claude', 'home/AppData/Roaming', 'home/AppData/Local', 'tmp']) temp.mkdir(...sub.split('/'));
    Deno.writeTextFileSync(temp.join('claude', 'settings.json'), JSON.stringify({ disableAllHooks: true }));
    const rules = [
      { when: 'SR-PARENT', reply: { tools: [{ id: 'toolu_pAgent01', name: 'Agent', input: { description: 'sr edit', prompt: 'SUBTASK-A: do the work', subagent_type: 'general-purpose', run_in_background: false } }] } },
      { when: 'SUBTASK-A', reply: { tools: [{ id: 'toolu_sBash01', name: 'Bash', input: { command: 'echo from-sub > sub-a.txt', description: 'write' } }] } },
      { when: 'toolu_sBash01', reply: { text: 'SUB-DONE' } },
      { when: 'toolu_pAgent01', reply: { tools: [{ id: 'toolu_pAgent02', name: 'Agent', input: { description: 'sr untyped', prompt: 'SUBTASK-B: do the work', run_in_background: false } }] } },
      { when: 'SUBTASK-B', reply: { tools: [{ id: 'toolu_sBash02', name: 'Bash', input: { command: 'echo from-sub > sub-b.txt', description: 'write' } }] } },
      { when: 'toolu_sBash02', reply: { text: 'SUB-B-DONE' } },
      { when: 'toolu_pAgent02', reply: { tools: [{ id: 'toolu_pAgent03', name: 'Agent', input: { description: 'sr look', prompt: 'SUBTASK-E: look', subagent_type: 'Explore', run_in_background: false } }] } },
      { when: 'SUBTASK-E', reply: { text: 'EXPLORE-DONE' } },
      { when: 'toolu_pAgent03', reply: { text: 'PARENT-DONE' } },
    ];
    await using stub = await Stub.start(temp.path, rules);
    const env = stubClaudeEnv(tempEnv(temp, home), stub);
    const meta = temp.join('meta.json');
    Deno.writeTextFileSync(meta, JSON.stringify({ claudeCode: { options: { settings: { permissions: { deny: HOOKS_OFF_DENY } } } } }));
    const out = await new Deno.Command(NODE_EXE!, {
      args: [acpProbe, '--allow', '--mode', 'bypassPermissions', '--meta', meta, CLAUDE_ACP!, 'new', project, 'SR-PARENT go'],
      env,
      clearEnv: true,
      stdin: 'null',
      stdout: 'piped',
      stderr: 'piped',
    }).output();
    assert((dec(out.stdout) + stubText(stub)).includes('PARENT-DONE'), dec(out.stderr).slice(-1500));
    const sent = dumped(stub);
    assert(sent.includes("Agent type 'general-purpose' has been denied by permission rule 'Agent(general-purpose)'"));
    assert(!(stubText(stub) + sent).includes('SUB-DONE'), 'the editing subagent ran with hooks off');
    assert(!(stubText(stub) + sent).includes('SUB-B-DONE'), 'the untyped subagent ran with hooks off');
    assert(!exists(join(project, 'sub-a.txt')));
    assert(!exists(join(project, 'sub-b.txt')));
    assert(sent.includes('EXPLORE-DONE'), 'Explore must still run');
    assertEquals(git(project, 'status', '--porcelain'), '');
  },
});

const subjects = (p: string) => git(p, 'log', '--format=%s', '-n', '20');
const noteStarts = async (aib: Aib, prefix: string) => (await notes(aib.chat)).some((n) => n.startsWith(prefix));

Deno.test({
  name: 'AibSubagentLandingTest test_landing_foreground_background_clash_protected',
  ignore: !aibOk,
  ...T,
  async fn() {
    const rules = [
      // B1 foreground
      { when: 'SR-FG', reply: { tools: [agentCall('toolu_pA1', 'sr edit', 'SUBTASK-A: do the work')] } },
      { when: 'SUBTASK-A', reply: { tools: [bash('toolu_sA1', 'echo from-sub > sub-a.txt')] } },
      { when: 'toolu_sA1', reply: { text: 'SUB-A-DONE' } },
      { when: 'toolu_pA1', reply: { tools: [bash('toolu_pA2', 'test -e sub-a.txt && echo SUBA-PRESENT || echo SUBA-ABSENT')] } },
      { when: 'toolu_pA2', reply: { text: 'PARENT-FG-DONE' } },
      // B5 background
      { when: 'SR-BG', reply: { tools: [agentCall('toolu_pB1', 'sr background', 'SUBTASK-B: do the work', true)] } },
      { when: 'SUBTASK-B', reply: { tools: [bash('toolu_sB1', 'sleep 3 && echo from-bg > sub-b.txt')] } },
      { when: 'toolu_sB1', reply: { text: 'SUB-B-DONE' } },
      { when: 'toolu_pB1', reply: { text: 'PARENT-BG-LAUNCHED' } },
      // B6 clash: it changes dirty.txt, which the folder has uncommitted
      { when: 'SR-CLASH', reply: { tools: [agentCall('toolu_pC1', 'sr clash', 'SUBTASK-C: do the work')] } },
      { when: 'SUBTASK-C', reply: { tools: [bash('toolu_sC1', 'echo from-clash >> dirty.txt')] } },
      { when: 'toolu_sC1', reply: { text: 'SUB-C-DONE' } },
      { when: 'toolu_pC1', reply: { text: 'PARENT-CLASH-DONE' } },
      // B17 protected
      { when: 'SR-PROT', reply: { tools: [agentCall('toolu_pD1', 'sr hook', 'SUBTASK-D: do the work')] } },
      { when: 'SUBTASK-D', reply: { tools: [bash('toolu_sD1', 'mkdir -p .husky && echo "echo pwned" > .husky/pre-commit && echo ok > sub-d.txt')] } },
      { when: 'toolu_sD1', reply: { text: 'SUB-D-DONE' } },
      { when: 'toolu_pD1', reply: { text: 'PARENT-PROT-DONE' } },
    ];
    const dirty = (aib: Aib) => Deno.writeTextFileSync(join(aib.project, 'dirty.txt'), 'main-edit\n'); // the main agent's uncommitted edit
    await using aib = await Aib.start(rules, { setup: dirty });
    const p = aib.project;
    const fx = aib.fx;
    const chat = aib.chat;
    const iso = ((await chat.state()).subagentIsolation as Json | undefined) ?? {};
    assertEquals({ on: iso.on, reason: iso.reason }, { on: true, reason: '' });

    // ---- B1: foreground lands at the turn end, as one commit; the main agent's edit stays uncommitted
    await aib.turn('SR-FG go');
    assert(dumped(aib.stub).includes('SUBA-ABSENT'), 'the subagent changed the folder before the turn ended');
    await aib.wait('the foreground subagent to land', () => subjects(p).includes('AIB: subagent sr edit'));
    assertEquals(Deno.readTextFileSync(join(p, 'sub-a.txt')).trim(), 'from-sub');
    assert(git(p, 'status', '--porcelain').includes('?? dirty.txt'), 'the main edit must stay uncommitted');
    assert(!git(p, 'show', '--name-only', '--format=', 'HEAD').includes('dirty.txt'));
    await aib.wait('the merge line', () => noteStarts(aib, 'Merged subagent “sr edit”'));
    const merged = (await chat.state()).events.filter((e) => e.kind === 'studio_note' && String(e.data.message).includes('Merged subagent'));
    assert(((merged[merged.length - 1].data.actions as Json[] | undefined) ?? []).some((a) => a.id === 'swarm-undo'), JSON.stringify(merged[merged.length - 1]));
    await aib.wait('its worktree to go', () => !Object.values(subagentRecords(fx.state)).some((r) => r.description === 'sr edit'));
    const spares = new Set(Object.values(subagentRecords(fx.state)).filter((r) => r.state === 'spare').map((r) => r.branch as string)); // P1's prepared spare stays
    const left = git(p, 'branch', '--list', 'studio/sub-*').split('\n').map((b) => b.trim().replace(/^[ +*]+/, '')).filter(Boolean);
    assertEquals(left.filter((b) => !spares.has(b)), [], 'the landed subagent branch must go');
    assertEquals(git(p, 'stash', 'list'), '');

    // ---- B5: background lands after its SubagentStop, once the parent is idle
    await aib.turn('SR-BG go');
    await aib.wait('the background subagent to land', () => subjects(p).includes('AIB: subagent sr background'), 120);
    assertEquals(Deno.readTextFileSync(join(p, 'sub-b.txt')).trim(), 'from-bg');
    assert(git(p, 'status', '--porcelain').includes('?? dirty.txt'));

    // ---- B6: clash with the folder's uncommitted edit: nothing lands, nothing stashed, the main agent is told
    await aib.turn('SR-CLASH go');
    await aib.wait('the clash line', () => noteStarts(aib, "Didn't land subagent “sr clash”"));
    assertEquals(Deno.readTextFileSync(join(p, 'dirty.txt')), 'main-edit\n');
    assert(!subjects(p).includes('AIB: subagent sr clash'));
    assertEquals(git(p, 'stash', 'list'), '');
    const clash = Object.values(subagentRecords(fx.state)).filter((r) => r.description === 'sr clash');
    assert(clash.length && isDir(clash[0].path as string), 'the clashing worktree must be kept');
    // the user commits the edit; the next turn end tries again and lands it (merge_helper with the id does the same)
    git(p, 'add', 'dirty.txt');
    git(p, 'commit', '-q', '-m', 'user: dirty');
    await aib.turn('SR-NEXT go');
    assert(dumped(aib.stub).includes('changed files with uncommitted edits'), 'the main agent was not told');
    assert(dumped(aib.stub).includes('AIB tries again when your next turn ends')); // swarm off: no merge_helper offered
    await aib.wait('the clash to land after the commit', () => subjects(p).includes('AIB: subagent sr clash'));
    assertEquals(Deno.readTextFileSync(join(p, 'dirty.txt')), 'main-edit\nfrom-clash\n');

    // ---- B17: protected path: nothing lands, told, kept
    await aib.turn('SR-PROT go');
    await aib.wait('the protected line', () => noteStarts(aib, "Didn't land subagent “sr hook”: it changed protected files"));
    assert(!exists(join(p, '.husky')));
    assert(!exists(join(p, 'sub-d.txt')), 'nothing of a refused subagent lands');
    const kept = Object.values(subagentRecords(fx.state)).filter((r) => r.description === 'sr hook');
    assert(kept.length && isDir(kept[0].path as string));
    await aib.turn('SR-AFTER go');
    assert(dumped(aib.stub).includes('changed protected files (.husky/pre-commit)'));
  },
});

Deno.test({
  name: 'AibSubagentLandingTest test_hooks_off_turns_editing_subagents_off',
  ignore: !aibOk,
  ...T,
  async fn() {
    const rules = [
      { when: 'SR-PARENT', reply: { tools: [agentCall('toolu_pA1', 'sr edit', 'SUBTASK-A: do the work')] } },
      { when: 'SUBTASK-A', reply: { tools: [bash('toolu_sA1', 'echo from-sub > sub-a.txt')] } },
      { when: 'toolu_sA1', reply: { text: 'SUB-A-DONE' } },
      { when: 'toolu_pA1', reply: { text: 'PARENT-DONE' } },
    ];
    const off = (aib: Aib) => {
      Deno.mkdirSync(join(aib.project, '.claude'));
      Deno.writeTextFileSync(join(aib.project, '.claude', 'settings.local.json'), JSON.stringify({ disableAllHooks: true }));
    };
    await using aib = await Aib.start(rules, { setup: off });
    assertEquals(((await aib.chat.state()).subagentIsolation as Json | undefined)?.on, false);
    assert(await noteStarts(aib, OFF_LINE), JSON.stringify(await notes(aib.chat)));
    await aib.turn('SR-PARENT go');
    const sent = dumped(aib.stub);
    assert(sent.includes('has been denied by permission rule'));
    assert(!(sent + stubText(aib.stub)).includes('SUB-A-DONE'));
    assert(!exists(join(aib.project, 'sub-a.txt')));
    assert(sent.includes('subagents that edit files are turned off'));
  },
});

Deno.test({
  name: 'AibSubagentLandingTest test_fork_skill_is_refused',
  ignore: !aibOk,
  ...T,
  /**
   * P3 probe (work/p3_skill_fork_probe.py): a `context: fork` skill starts a subagent with no Agent call, in the folder. AIB's
   * PreToolUse(Skill) refuses it; an ordinary skill still runs.
   */
  async fn() {
    const rules = [
      { when: 'SR-SKILL', reply: { tools: [{ id: 'toolu_pS1', name: 'Skill', input: { skill: 'forker' } }] } },
      { when: 'FORKBODY-7', reply: { tools: [bash('toolu_fS1', 'echo from-fork > fork.txt')] } },
      { when: 'toolu_fS1', reply: { text: 'FORK-RAN' } },
      { when: 'toolu_pS1', reply: { tools: [{ id: 'toolu_pS2', name: 'Skill', input: { skill: 'plain' } }] } },
      { when: 'toolu_pS2', reply: { text: 'PARENT-SKILL-DONE' } },
    ];
    const skills = (aib: Aib) => {
      for (const [name, front, body] of [['forker', 'context: fork\nagent: general-purpose\n', 'FORKBODY-7: write fork.txt'], ['plain', '', 'PLAINBODY-7: just say hi']]) {
        const d = join(aib.project, '.claude', 'skills', name);
        Deno.mkdirSync(d, { recursive: true });
        Deno.writeTextFileSync(join(d, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} skill\n${front}---\n${body}\n`);
      }
      git(aib.project, 'add', '-A');
      git(aib.project, 'commit', '-q', '-m', 'skills');
    };
    await using aib = await Aib.start(rules, { setup: skills });
    await aib.turn('SR-SKILL go');
    const sent = dumped(aib.stub);
    assert(sent.includes('skills that run as a forked subagent (context: fork) are off'));
    assert(!(sent + stubText(aib.stub)).includes('FORK-RAN'), 'the fork skill ran');
    assert(!exists(join(aib.project, 'fork.txt')));
    assert((stubText(aib.stub) + sent).includes('PARENT-SKILL-DONE'));
    assert(sent.includes('PLAINBODY-7'), 'an ordinary skill still runs');
    // typed by the user (`/forker`): Claude Code runs it as a forked subagent with no Skill call, so no hook sees it and it edits
    // the folder (p3_skill_fork_probe.py typed-*). AIB doesn't send it: the chat says why, no turn starts, the model is not called.
    const dumpCount = () => aib.stub.dumpFiles().length;
    const requests = dumpCount();
    const [code, body] = await aib.web.post('prompt', { id: aib.chat.id, text: '/forker go', clientMessageId: uuid() });
    assertEquals(code, 200);
    assert(String(body.refused).includes("AIB didn't send /forker"), JSON.stringify(body));
    assertEquals(body.turnState, 'finished');
    await aib.wait('the refusal line', () => noteStarts(aib, "AIB didn't send /forker: it runs as a forked subagent"));
    const state = await aib.chat.state();
    assert(!state.busy);
    assert(state.events.some((e) => e.kind === 'user' && e.data.text === '/forker go'));
    await sleep(2000);
    assertEquals(dumpCount(), requests, 'the typed fork skill reached the model');
    assert(!exists(join(aib.project, 'fork.txt')));
    // a typed ordinary skill still goes to the agent
    await aib.turn('/plain go');
    assert(dumpCount() > requests);
  },
});

Deno.test({
  name: 'AibSubagentLandingTest test_user_worktree_hook_is_adopted_landed_and_kept',
  ignore: !aibOk,
  ...T,
  async fn() {
    const rules = [
      { when: 'SR-PARENT', reply: { tools: [agentCall('toolu_pA1', 'sr user', 'SUBTASK-U: do the work')] } },
      { when: 'SUBTASK-U', reply: { tools: [bash('toolu_sU1', 'echo from-user-wt > sub-u.txt')] } },
      { when: 'toolu_sU1', reply: { text: 'SUB-U-DONE' } },
      { when: 'toolu_pA1', reply: { text: 'PARENT-DONE' } },
    ];
    const holder: { where?: string } = {};
    const userHook = (aib: Aib) => {
      const where = aib.temp.join('user-wts');
      Deno.mkdirSync(where);
      const script = aib.temp.join('wt-hook.sh');
      const fwd = (x: string) => x.replaceAll('\\', '/');
      Deno.writeTextFileSync(
        script,
        'input=$(cat)\n' +
          'name=$(printf %s "$input" | sed -n \'s/.*"name": *"\\([^"]*\\)".*/\\1/p\')\n' +
          `dir="${fwd(where)}/$name"\n` +
          `git -C "${fwd(aib.project)}" worktree add -q -b "user-$name" "$dir" HEAD >/dev/null 2>&1 || exit 1\n` +
          'echo "$dir"\n',
      );
      Deno.mkdirSync(join(aib.project, '.claude'));
      Deno.writeTextFileSync(
        join(aib.project, '.claude', 'settings.local.json'),
        JSON.stringify({ hooks: { WorktreeCreate: [{ hooks: [{ type: 'command', command: `bash "${fwd(script)}"` }] }] } }),
      );
      holder.where = where;
    };
    await using aib = await Aib.start(rules, { setup: userHook });
    await aib.turn('SR-PARENT go');
    const p = aib.project;
    const made = [...Deno.readDirSync(holder.where!)].map((e) => join(holder.where!, e.name));
    assertEquals(made.length, 1, 'the user hook made no worktree');
    try {
      await aib.wait('the user-hook worktree to land', () => subjects(p).includes('AIB: subagent sr user'));
    } catch (error) {
      console.error(JSON.stringify(subagentRecords(aib.fx.state), null, 1), await notes(aib.chat));
      throw error;
    }
    assertEquals(Deno.readTextFileSync(join(p, 'sub-u.txt')).trim(), 'from-user-wt');
    await sleep(3000); // a poll or two after landing: AIB must not remove what the user's hook made
    assert(isDir(made[0]), "AIB removed the user's worktree");
    const name = made[0].slice(Math.max(made[0].lastIndexOf('\\'), made[0].lastIndexOf('/')) + 1);
    assert(git(p, 'branch', '--list', 'user-*').includes(name));
    assert(!Object.values(subagentRecords(aib.fx.state)).some((r) => r.description === 'sr user'), 'its record should go after landing');
    void isFile;
    void gitLog;
  },
});
