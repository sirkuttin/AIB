/**
 * Subagent worktrees P1 (server/subagents/): the hook settings, the reading of the user's Claude setup, the hook key and the route
 * rules, without an agent. The real adapter end to end is work/test_subagent_worktree_e2e.py.
 *   B12  the settings object is the same bytes every time (a reopen sends it again; a change would rebuild the session) and holds
 *        no port and no key
 *   hooks off / user WorktreeCreate hook / custom read-only agents are read from temp config folders only
 *   the routes: EnterWorktree and Workflow denied; read-only types pass; never "allow"; WorktreeCreate refuses unknown names and calls
 *        with nothing prepared; the cap; a chat that is not open gets 503 (the forwarder fails closed); a UNC adoption hint is
 *        never touched; spares and unused prepared worktrees go at chat close, a bound one never
 */
import { assert, assertEquals } from './_assert.ts';
import { checkHookKey, configure, issue, issueHookKey } from '../../outputs/agent-studio/server/artifacts/keys.ts';
import { hookSettings, readClaudeSetup } from '../../outputs/agent-studio/server/subagents/claude_config.ts';
import { MAX_PER_CHAT, readSubagents, type SubagentChat, SubagentWorktrees, TEXTS } from '../../outputs/agent-studio/server/subagents/service.ts';
import { join } from '../../outputs/agent-studio/server/platform/path.ts';

function git(cwd: string, ...args: string[]): string {
  const out = new Deno.Command('git', { args: ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...args], cwd, stdout: 'piped', stderr: 'piped' })
    .outputSync();
  if (!out.success) throw new Error(`git ${args.join(' ')}: ${new TextDecoder().decode(out.stderr)}`);
  return new TextDecoder().decode(out.stdout);
}

function repo(dir: string): string {
  Deno.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'core.autocrlf', 'false');
  Deno.writeTextFileSync(join(dir, 'tracked.txt'), 'one\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'first');
  return dir;
}

Deno.test('B12: hook settings are byte-identical each time, bash-quoted, fail closed, with no port and no key', () => {
  const a = JSON.stringify(hookSettings('C:\\Users\\x\\AIB\\keeper-bin\\abc\\AIB-keeper.exe', 'C:\\Users\\x\\AIB\\artifact-mcp.json', { worktreeCreate: true }));
  const b = JSON.stringify(hookSettings('C:\\Users\\x\\AIB\\keeper-bin\\abc\\AIB-keeper.exe', 'C:\\Users\\x\\AIB\\artifact-mcp.json', { worktreeCreate: true }));
  assertEquals(a, b);
  assert(!a.includes('\\\\'), 'forward slashes only (Git Bash runs the command)');
  assert(!/127\.0\.0\.1|:\d{4,5}/.test(a), 'no address in the settings');
  const s = JSON.parse(a).hooks;
  assertEquals(s.PreToolUse[0].matcher, 'Agent|Task|EnterWorktree|Workflow');
  assertEquals(s.PreToolUse[0].hooks[0].command, '"C:/Users/x/AIB/keeper-bin/abc/AIB-keeper.exe" hook pre-tool "C:/Users/x/AIB/artifact-mcp.json" || exit 2');
  assertEquals(s.PreToolUse[0].hooks[0].timeout, 30);
  assert(s.WorktreeCreate[0].hooks[0].command.endsWith('|| exit 2'));
  assert(!s.PostToolUse[0].hooks[0].command.includes('exit 2'), 'hints fail open');
  const noWt = hookSettings('C:/k.exe', 'C:/a.json', { worktreeCreate: false })!;
  assert(!('WorktreeCreate' in (noWt.hooks as Record<string, unknown>)), "the user's own WorktreeCreate hook is left to make the worktree");
  assertEquals(hookSettings('C:/we"ird/k.exe', 'C:/a.json', { worktreeCreate: true }), null);
});

Deno.test('the hook key has its own label: never an artifact key, only for its own chat', () => {
  const dir = Deno.makeTempDirSync({ prefix: 'aib-hookkey-' });
  try {
    configure(dir);
    const key = issueHookKey('chat-1')!;
    assert(checkHookKey(key, 'chat-1'));
    assert(!checkHookKey(key, 'chat-2'));
    assert(!checkHookKey(issue('chat-1'), 'chat-1'), 'the artifact key is not a hook key');
  } finally {
    configure(null);
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("the user's Claude setup is read from the given config folders only", () => {
  const dir = Deno.makeTempDirSync({ prefix: 'aib-claudecfg-' });
  try {
    const config = join(dir, 'config'), project = join(dir, 'proj');
    Deno.mkdirSync(join(config, 'agents'), { recursive: true });
    Deno.mkdirSync(join(project, '.claude', 'agents'), { recursive: true });
    const env = { CLAUDE_CONFIG_DIR: config };
    assertEquals(readClaudeSetup(project, env).hooksOff, '');
    assert(readClaudeSetup(project, env).readOnly.includes('Explore'));
    Deno.writeTextFileSync(join(config, 'agents', 'reviewer.md'), '---\nname: reviewer\ntools: Read, Grep, Glob\n---\nlook');
    Deno.writeTextFileSync(join(config, 'agents', 'fixer.md'), '---\nname: fixer\ntools: Read, Edit\n---\nfix');
    Deno.writeTextFileSync(join(project, '.claude', 'agents', 'all.md'), '---\nname: all\n---\nanything');
    Deno.writeTextFileSync(join(project, '.claude', 'agents', 'Explore.md'), '---\nname: Explore\ntools: Bash\n---\nshadowed');
    const setup = readClaudeSetup(project, env);
    assert(setup.readOnly.includes('reviewer'));
    assert(!setup.readOnly.includes('fixer') && !setup.readOnly.includes('all'));
    assert(!setup.readOnly.includes('Explore'), 'a project agent named Explore that can run Bash is not read-only');
    Deno.writeTextFileSync(join(project, '.claude', 'settings.json'), JSON.stringify({ hooks: { WorktreeCreate: [{ hooks: [] }] } }));
    assertEquals(readClaudeSetup(project, env).userWorktreeHook, "the project's .claude/settings.json");
    Deno.writeTextFileSync(join(config, 'settings.json'), JSON.stringify({ disableAllHooks: true }));
    assertEquals(readClaudeSetup(project, env).hooksOff, 'disableAllHooks is on in your Claude Code settings');
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test('the hook routes: deny, pass, bind, cap, closed chats, hints; never allow; only AIB-made unbound worktrees go', async () => {
  const dir = Deno.makeTempDirSync({ prefix: 'aib-subroutes-' });
  try {
    const state = join(dir, 'state'), root = join(state, 'worktrees');
    const project = repo(join(dir, 'proj'));
    Deno.writeTextFileSync(join(project, 'dirty.txt'), 'main-edit\n'); // the main agent's uncommitted edit
    let open = true;
    const chat: SubagentChat = {
      id: 'c0ffee00aa',
      provider: 'claude',
      lasting: 'claude:s1',
      folder: project,
      project,
      hooks: { readOnly: new Set(['Explore']), userWorktreeHook: false },
    };
    const service = new SubagentWorktrees(state, root, (id) => (open && id === chat.id ? chat : null));
    const call = (event: string, body: unknown) => service.hook(event, chat.id, body);
    const decision = async (event: string, body: unknown) => JSON.parse((await call(event, body)).body)?.hookSpecificOutput ?? {};

    assertEquals((await decision('pre-tool', { tool_name: 'EnterWorktree', tool_input: {} })).permissionDecisionReason, TEXTS.enterWorktree);
    assertEquals((await decision('pre-tool', { tool_name: 'Workflow', tool_input: {} })).permissionDecisionReason, TEXTS.workflow);
    assertEquals(await decision('pre-tool', { tool_name: 'Agent', tool_input: { subagent_type: 'Explore' } }), {});
    assertEquals(readSubagents(state), {}, 'a read-only type gets nothing');

    const w0 = await call('worktree-create', { name: 'agent-early' });
    assertEquals(w0.status, 409, 'nothing prepared: refused');
    const pre = await decision('pre-tool', { tool_name: 'Agent', tool_use_id: 'toolu_1', tool_input: { prompt: 'x', subagent_type: 'general-purpose' } });
    assertEquals(pre.updatedInput.isolation, 'worktree');
    assert(!('permissionDecision' in pre), 'never allow: the chat\'s own permission flow applies');
    assertEquals((await call('worktree-create', { name: 'not-an-agent' })).status, 409);
    const bound = await call('worktree-create', { name: 'agent-a1' });
    assertEquals(bound.status, 200);
    const path = bound.body;
    assertEquals(Deno.readTextFileSync(join(path, 'dirty.txt')), 'main-edit\n', 'S has the uncommitted edit');
    assert(git(project, 'worktree', 'list', '--porcelain').includes('locked'), 'git-locked');
    const rec = Object.values(readSubagents(state)).find((r) => r.agentId === 'a1')!;
    assertEquals([rec.state, rec.toolUseId, rec.branch.startsWith('studio/sub-c0ffee00-')], ['running', 'toolu_1', true]);
    assertEquals(service.worktreeOf(chat.id, 'toolu_1'), path, 'allow-rule parity finds the worktree by the Agent call');
    assertEquals(service.worktreeOf('other-chat', 'toolu_1'), null);

    // a UNC hint is never touched; a forged stop counts as a hint only
    await call('post-agent', { tool_use_id: 'toolu_9', tool_response: { agentId: 'zz', worktreePath: '\\\\203.0.113.9\\share' } });
    // an internal fork's stop (agent_type "") changes nothing; a stop with its agentId makes it done (P2: it then lands only once
    // the parent is idle, under the parent's landing lock; nothing is removed here)
    await call('subagent-stop', { agent_id: 'a1', agent_type: '' });
    assertEquals(Object.values(readSubagents(state)).find((r) => r.agentId === 'a1')!.state, 'running');
    await call('subagent-stop', { agent_id: 'a1', agent_type: 'general-purpose' });
    assertEquals(Object.values(readSubagents(state)).find((r) => r.agentId === 'a1')!.state, 'done');

    // the cap: the chat holds at most MAX_PER_CHAT worktrees (the bound one counts)
    let denied = '';
    for (let i = 0; i < MAX_PER_CHAT + 1 && !denied; i++) {
      const d = await decision('pre-tool', { tool_name: 'Agent', tool_use_id: `toolu_c${i}`, tool_input: { prompt: 'x' } });
      denied = d.permissionDecisionReason ?? '';
    }
    assertEquals(denied, TEXTS.cap);

    // the turn ends: unused prepared ones become one spare or go; the bound one stays
    await service.turnEnded(chat.id);
    const left = Object.values(readSubagents(state));
    assertEquals(left.filter((r) => r.state === 'spare').length, 1);
    assertEquals(left.filter((r) => r.state === 'prepared').length, 0);
    // the next call takes the spare (moved to the new S)
    Deno.writeTextFileSync(join(project, 'dirty.txt'), 'main-edit-2\n');
    const again = await decision('pre-tool', { tool_name: 'Agent', tool_use_id: 'toolu_2', tool_input: { prompt: 'y' } });
    assertEquals(again.updatedInput.isolation, 'worktree');
    const second = await call('worktree-create', { name: 'agent-a2' });
    assertEquals(Deno.readTextFileSync(join(second.body, 'dirty.txt')), 'main-edit-2\n', 'the spare was moved to the new S');

    // the chat closes: spares and unused prepared go, bound ones stay (landing is P2's); not open: 503 (the forwarder fails closed)
    await new Promise((r) => setTimeout(r, 300)); // let a background spare finish
    await service.chatClosed(chat.id);
    const kept = Object.values(readSubagents(state));
    assertEquals(kept.map((r) => r.state).sort(), ['done', 'running']);
    assert(kept.every((r) => { try { return Deno.statSync(r.path).isDirectory; } catch { return false; } }));
    open = false;
    assertEquals((await call('pre-tool', { tool_name: 'Agent', tool_input: {} })).status, 503);
    for (const r of kept) {
      git(project, 'worktree', 'unlock', r.path);
      git(project, 'worktree', 'remove', '--force', r.path);
    }
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});
