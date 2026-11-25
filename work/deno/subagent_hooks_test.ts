/**
 * Subagent worktrees P1 (server/subagents/): the hook settings, the reading of the user's Claude setup, the hook key and the route
 * rules, without an agent. The real adapter end to end is work/deno/e2e_subagent_worktree_test.ts.
 *   B12  the settings object is the same bytes every time (a reopen sends it again; a change would rebuild the session) and holds
 *        no port and no key
 *   hooks off / user WorktreeCreate hook / custom read-only agents are read from temp config folders only
 *   the routes: EnterWorktree and Workflow denied; read-only types pass; never "allow"; WorktreeCreate refuses unknown names and calls
 *        with nothing prepared; the cap; a chat that is not open gets 503 (the forwarder fails closed); a UNC adoption hint is
 *        never touched; spares and unused prepared worktrees go at chat close, a bound one never
 */
import { assert, assertEquals } from './_assert.ts';
import { checkHookKey, configure, hookProof, issue, issueHookKey } from '../../app/server/artifacts/keys.ts';
import {
  gitBashPath,
  hookSettings,
  managedSettings,
  readClaudeSetup,
  setPolicyReader,
  subagentsOffSettings,
} from '../../app/server/subagents/claude_config.ts';
import { ArtifactMcpHttp, CONVERSATION_HEADER, HOOK_KEY_HEADER, HOOK_NONCE_HEADER, HOOK_PROOF_HEADER } from '../../app/server/artifacts/mcp_http.ts';
import { landingWords, MAX_PER_CHAT, readSubagents, type SubagentChat, SubagentWorktrees, TEXTS, unlinkLinks } from '../../app/server/subagents/service.ts';
import { ensureDefault } from '../../app/server/worktrees/local_only.ts';
import { ignoredFiles } from '../../app/server/swarm/service.ts';
import { subagentEnd } from '../../app/server/acp/connection.ts';
import { join } from '../../app/server/platform/path.ts';

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
  assertEquals(s.PreToolUse[0].matcher, 'Agent|Task|EnterWorktree|Workflow|Skill');
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

Deno.test('MF 3: a custom agent is read-only only when every tool it lists is a known read-only one', () => {
  const dir = Deno.makeTempDirSync({ prefix: 'aib-claudecfg-' });
  const was = setPolicyReader(null);
  try {
    const config = join(dir, 'config'), project = join(dir, 'proj');
    Deno.mkdirSync(join(config, 'agents'), { recursive: true });
    const agent = (name: string, front: string) => Deno.writeTextFileSync(join(config, 'agents', `${name}.md`), `---\nname: ${name}\n${front}\n---\nx`);
    agent('looker', 'tools: Read, Grep, Glob, LS, WebFetch, WebSearch, TodoWrite');
    agent('quoted', 'tools: ["Read", "Grep"]');
    agent('mcpwrite', 'tools: Read, mcp__filesystem__write_file');
    agent('mcpall', 'tools: Read, mcp__*');
    agent('skill', 'tools: Read, Skill');
    agent('future', 'tools: Read, SomeNewTool');
    agent('star', 'tools: "*"');
    agent('nested', 'tools: Read, Agent');
    agent('servers', 'tools: Read, Grep\nmcpServers:\n  - fs');
    agent('blocklist', 'tools:\n  - Read');
    const ro = readClaudeSetup(project, { CLAUDE_CONFIG_DIR: config }).readOnly;
    assert(ro.includes('looker') && ro.includes('quoted'), ro.join(','));
    for (const name of ['mcpwrite', 'mcpall', 'skill', 'future', 'star', 'nested', 'servers', 'blocklist']) {
      assert(!ro.includes(name), `${name} may edit, so it gets a worktree`);
    }
  } finally {
    setPolicyReader(was);
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test('should-fix 8: every managed settings location is read: the file, managed-settings.d, the HKLM/HKCU policy keys', () => {
  const dir = Deno.makeTempDirSync({ prefix: 'aib-managed-' });
  const asked: string[] = [];
  const was = setPolicyReader((hive, path, name) => {
    asked.push(`${hive}\\${path}:${name}`);
    return hive === 'HKCU' ? JSON.stringify({ allowManagedHooksOnly: true }) : undefined;
  });
  try {
    Deno.mkdirSync(join(dir, 'managed-settings.d'), { recursive: true });
    Deno.writeTextFileSync(join(dir, 'managed-settings.json'), JSON.stringify({}));
    Deno.writeTextFileSync(join(dir, 'managed-settings.d', '20-hooks.json'), JSON.stringify({ disableAllHooks: true }));
    Deno.writeTextFileSync(join(dir, 'managed-settings.d', '.hidden.json'), JSON.stringify({ x: 1 }));
    Deno.writeTextFileSync(join(dir, 'managed-settings.d', 'notes.txt'), 'x');
    const docs = managedSettings(dir);
    assertEquals(docs.map(([where]) => where), [
      'managed Claude Code settings',
      'managed Claude Code settings (managed-settings.d/20-hooks.json)',
      'the Claude Code policy in the registry (HKCU)',
    ]);
    assertEquals(docs[1][1], { disableAllHooks: true });
    assertEquals(asked, ['HKLM\\SOFTWARE\\Policies\\ClaudeCode:Settings', 'HKCU\\SOFTWARE\\Policies\\ClaudeCode:Settings']);
    // readClaudeSetup sees the registry policy (the real managed folder is not this one)
    const project = join(dir, 'proj');
    assertEquals(readClaudeSetup(project, { CLAUDE_CONFIG_DIR: join(dir, 'cfg') }).hooksOff,
      'allowManagedHooksOnly is on in the Claude Code policy in the registry (HKCU)');
  } finally {
    setPolicyReader(was);
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test('MF 7: Git Bash is found the way Claude Code finds it, or the chat gets deny rules instead of hooks', () => {
  if (Deno.build.os !== 'windows') {
    assertEquals(gitBashPath({}), 'sh');
    return;
  }
  const files = new Set<string>();
  const exists = (p: string) => files.has(p.toLowerCase());
  assertEquals(gitBashPath({ PATH: 'C:\\nothing' }, exists), null);
  files.add('d:\\tools\\git\\cmd\\git.exe');
  assertEquals(gitBashPath({ Path: 'C:\\nothing;D:\\Tools\\Git\\cmd' }, exists), null, 'git without bash beside it');
  files.add('d:\\tools\\git\\bin\\bash.exe');
  assertEquals(gitBashPath({ Path: 'C:\\nothing;D:\\Tools\\Git\\cmd' }, exists), 'D:\\Tools\\Git\\bin\\bash.exe');
  files.add('c:\\program files\\git\\bin\\bash.exe');
  assertEquals(gitBashPath({ PATH: '' }, exists), 'C:\\Program Files\\Git\\bin\\bash.exe');
  files.add('e:\\bash\\bash.exe');
  assertEquals(gitBashPath({ CLAUDE_CODE_GIT_BASH_PATH: 'E:\\bash\\bash.exe' }, exists), 'E:\\bash\\bash.exe');
  assertEquals(gitBashPath({ CLAUDE_CODE_GIT_BASH_PATH: 'E:\\bash\\pwsh.exe' }, exists), 'C:\\Program Files\\Git\\bin\\bash.exe',
    'not a bash: auto-detection, as Claude Code');
  // what a chat without Git Bash gets instead of hooks: P2's hooks-off deny rules (editing types off, read-only ones still run)
  const off = subagentsOffSettings('C:/nowhere', { CLAUDE_CONFIG_DIR: 'C:/nowhere/cfg' }, ['Explore', 'Plan']);
  const deny = (off.permissions as { deny: string[] }).deny;
  assert(deny.includes('Agent(general-purpose)') && deny.includes('Workflow') && deny.includes('EnterWorktree'), deny.join(','));
  assert(!deny.includes('Agent(Explore)') && !('hooks' in off));
});

Deno.test('MF 1: every hook answer is signed over the nonce, the status and the body (the same proof as keeper/hookforward.go)', async () => {
  // the vector keeper/hookforward_test.go checks too
  assertEquals(hookProof('k-123', 'abcdef0123456789', 200, new TextEncoder().encode('{}')),
    '8499c10f781827e1c0c1f5c0f017ff99d1d934efaab9c083690ce1cc5bafe6f3');
  const dir = Deno.makeTempDirSync({ prefix: 'aib-hookproof-' });
  configure(dir);
  const server = new ArtifactMcpHttp({
    conversation: () => null,
    baseUrl: () => '',
    urlFile: '',
    hook: (event) => Promise.resolve(event === 'pre-tool' ? { status: 200, body: '{"a":1}', type: 'application/json' } : { status: 503, body: 'no', type: 'text/plain' }),
  });
  try {
    const url = server.start().replace(/\/mcp$/, '');
    const key = issueHookKey('chat-1')!;
    const nonce = 'ab'.repeat(32);
    const hit = (event: string, headers: Record<string, string>) =>
      fetch(`${url}/hooks/claude/${event}`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json', ...headers } });
    const ok = await hit('pre-tool', { [HOOK_KEY_HEADER]: key, [CONVERSATION_HEADER]: 'chat-1', [HOOK_NONCE_HEADER]: nonce });
    const body = new Uint8Array(await ok.arrayBuffer());
    assertEquals(ok.status, 200);
    assertEquals(ok.headers.get(HOOK_PROOF_HEADER), hookProof(key, nonce, 200, body));
    const closed = await hit('post-agent', { [HOOK_KEY_HEADER]: key, [CONVERSATION_HEADER]: 'chat-1', [HOOK_NONCE_HEADER]: nonce });
    assertEquals(closed.headers.get(HOOK_PROOF_HEADER), hookProof(key, nonce, 503, new Uint8Array(await closed.arrayBuffer())));
    const wrongKey = await hit('pre-tool', { [HOOK_KEY_HEADER]: issueHookKey('chat-2')!, [CONVERSATION_HEADER]: 'chat-1', [HOOK_NONCE_HEADER]: nonce });
    await wrongKey.body?.cancel();
    assertEquals([wrongKey.status, wrongKey.headers.get(HOOK_PROOF_HEADER)], [401, null], 'never signed without the key');
    const noNonce = await hit('pre-tool', { [HOOK_KEY_HEADER]: key, [CONVERSATION_HEADER]: 'chat-1' });
    await noNonce.body?.cancel();
    assertEquals(noNonce.headers.get(HOOK_PROOF_HEADER), null);
  } finally {
    await server.close();
    configure(null);
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test('P3: skills that run as a forked subagent (context: fork) are refused; other skills pass; hooks off denies them too', async () => {
  const dir = Deno.makeTempDirSync({ prefix: 'aib-forkskill-' });
  const was = setPolicyReader(null);
  try {
    const state = join(dir, 'state'), config = join(dir, 'config');
    const project = repo(join(dir, 'proj'));
    const write = (path: string, text: string) => {
      Deno.mkdirSync(path.replace(/[\\/][^\\/]+$/, ''), { recursive: true });
      Deno.writeTextFileSync(path, text);
    };
    write(join(project, '.claude', 'skills', 'forker', 'SKILL.md'), '---\nname: forker\ndescription: f\ncontext: fork\nagent: general-purpose\n---\nwrite');
    write(join(project, '.claude', 'skills', 'inline', 'SKILL.md'), '---\nname: inline\ndescription: i\n---\nsteps');
    write(join(project, '.claude', 'commands', 'ops', 'forkcmd.md'), '---\ndescription: c\ncontext: "fork"\n---\nrun');
    write(join(config, 'skills', 'userfork', 'SKILL.md'), '﻿---\nname: userfork\ncontext: fork\n---\nx');
    write(join(project, 'apps', 'web', '.claude', 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ncontext: fork\n---\nx');
    const chat: SubagentChat = {
      id: 'f0f0f0f0aa', provider: 'claude', lasting: 'claude:s1', folder: project, project,
      hooks: { readOnly: new Set(['Explore']), userWorktreeHook: false, configDir: config },
    };
    const service = new SubagentWorktrees(state, join(state, 'worktrees'), (id) => (id === chat.id ? chat : null));
    const skill = async (name: string) => JSON.parse((await service.hook('pre-tool', chat.id, { tool_name: 'Skill', tool_input: { skill: name } })).body);
    for (const name of ['forker', 'forkcmd', 'ops:forkcmd', 'userfork', 'someplugin:forker', 'apps/web:deploy']) {
      const out = (await skill(name)).hookSpecificOutput;
      assertEquals(out?.permissionDecision, 'deny', name);
      assertEquals(out.permissionDecisionReason, TEXTS.forkSkill(name));
    }
    for (const name of ['inline', 'unknown', 'apps/other:deploy', '../x:deploy2', '']) assertEquals(await skill(name), {}, `${name} passes`);
    assertEquals(readSubagents(state), {}, 'a skill call records nothing');
    // hooks off: the chat's per-session deny rules name the fork skills too
    const deny = (subagentsOffSettings(project, { CLAUDE_CONFIG_DIR: config }, ['Explore']).permissions as { deny: string[] }).deny;
    for (const name of ['forker', 'forkcmd', 'userfork']) assert(deny.includes(`Skill(${name})`), deny.join(','));
    assert(!deny.includes('Skill(inline)'));
  } finally {
    setPolicyReader(was);
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test('P3: the stream settles subagents whose SubagentStop never came: finished = done, killed = stopped; continued runs again', async () => {
  const dir = Deno.makeTempDirSync({ prefix: 'aib-subends-' });
  try {
    const state = join(dir, 'state');
    const project = repo(join(dir, 'proj'));
    const chat: SubagentChat = {
      id: 'e0e0e0e0aa', provider: 'claude', lasting: 'claude:s1', folder: project, project,
      hooks: { readOnly: new Set(['Explore']), userWorktreeHook: false },
    };
    const service = new SubagentWorktrees(state, join(state, 'worktrees'), (id) => (id === chat.id ? chat : null));
    const start = async (n: number) => {
      await service.hook('pre-tool', chat.id, { tool_name: 'Agent', tool_use_id: `toolu_e${n}`, tool_input: { prompt: 'x', description: `sub ${n}` } });
      await service.hook('worktree-create', chat.id, { name: `agent-ag${n}` });
    };
    const stateOf = (agentId: string) => Object.values(readSubagents(state)).find((r) => r.agentId === agentId);
    for (const n of [1, 2, 3, 4]) await start(n);
    assertEquals([1, 2, 3, 4].map((n) => stateOf(`ag${n}`)!.state), ['running', 'running', 'running', 'running']);
    // AIB was down when they ended (their SubagentStop failed open): the take-over / turn end reads the replayed stream
    await service.reconcileEnded(chat.id, new Map([['ag1', 'end_turn'], ['ag2', 'cancelled'], ['ag3', ''], ['other', 'end_turn']]));
    assertEquals(stateOf('ag1')!.state, 'done');
    assertEquals([stateOf('ag2')!.state, stateOf('ag2')!.stoppedWhy], ['stopped', 'it was cancelled']);
    assertEquals([stateOf('ag3')!.state, stateOf('ag3')!.stoppedWhy], ['stopped', 'it ended without saying why']);
    assertEquals(stateOf('ag4')!.state, 'running', 'still running: untouched');
    // a background one TaskStop killed: its SubagentStop came first (a hint only: another hook may block a stop), then the stream said
    // cancelled: stopped, never landed
    await service.hook('subagent-stop', chat.id, { agent_id: 'ag4', agent_type: 'general-purpose' });
    assertEquals(stateOf('ag4')!.state, 'running', 'a SubagentStop alone is not its end');
    await service.acpEnded(chat.id, 'ag4', 'cancelled');
    assertEquals(stateOf('ag4')!.state, 'stopped');
    // a finished one the main agent continues (SendMessage, hidden in the RFD form): running again, then done at its next end
    await service.acpEnded(chat.id, 'ag1', null);
    assertEquals(stateOf('ag1')!.state, 'running');
    await service.acpEnded(chat.id, 'ag1', 'end_turn');
    assertEquals(stateOf('ag1')!.state, 'done');
    await service.acpEnded(chat.id, 'ag2', null);
    assertEquals(stateOf('ag2')!.state, 'stopped', 'a stopped one is not revived by the stream');
    // Activity's words for the chat
    const words = service.activity(chat.id);
    assertEquals(words.ag1, { where: 'Own worktree', landing: 'Lands when the turn ends' });
    assertEquals(words.ag2, { where: 'Own worktree', landing: 'Stopped — ask the agent to merge it' });
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test('stopping the parent turn stops only the subagents it waits on: background ones run on and still land (owner, 2026-11-16)', async () => {
  const dir = Deno.makeTempDirSync({ prefix: 'aib-subcancel-' });
  try {
    const state = join(dir, 'state');
    const project = repo(join(dir, 'proj'));
    const chat: SubagentChat = {
      id: 'c0c0c0c0aa', provider: 'claude', lasting: 'claude:s1', folder: project, project,
      hooks: { readOnly: new Set(['Explore']), userWorktreeHook: false },
    };
    const service = new SubagentWorktrees(state, join(state, 'worktrees'), (id) => (id === chat.id ? chat : null));
    const start = async (n: number, background: boolean) => {
      const input = { prompt: 'x', description: `sub ${n}`, ...(background ? { run_in_background: true } : {}) };
      await service.hook('pre-tool', chat.id, { tool_name: 'Agent', tool_use_id: `toolu_c${n}`, tool_input: input });
      await service.hook('worktree-create', chat.id, { name: `agent-cg${n}` });
    };
    const stateOf = (agentId: string) => Object.values(readSubagents(state)).find((r) => r.agentId === agentId)!;
    await start(1, true); // run_in_background
    await start(2, false); // foreground: the turn waits on it
    await start(3, false); // foreground that a Send now moved to the background: its Agent call returned while it runs
    await service.hook('post-agent', chat.id, { tool_name: 'Agent', tool_use_id: 'toolu_c3', tool_response: { agentId: 'cg3', status: 'async_launched' } });
    assertEquals([service.inBackground(chat.id, 'cg1'), service.inBackground(chat.id, 'cg2'), service.inBackground(chat.id, 'cg3')], [true, false, true]);
    await service.turnCancelled(chat.id, 'claude');
    assertEquals(stateOf('cg1').state, 'running', 'a background subagent is not part of the stopped turn');
    assertEquals([stateOf('cg2').state, stateOf('cg2').stoppedWhy], ['stopped', 'the turn was stopped']);
    assertEquals(stateOf('cg3').state, 'running', 'moved to the background: runs on');
    // it ends later: done, so it lands as usual (the landing itself: work/deno/e2e_subagent_cancel_test.ts)
    await service.hook('subagent-stop', chat.id, { agent_id: 'cg1', agent_type: 'general-purpose' });
    assertEquals(stateOf('cg1').state, 'running', 'the hook is a hint');
    await service.acpEnded(chat.id, 'cg1', 'end_turn'); // the stream's word is the end
    assertEquals(stateOf('cg1').state, 'done');
    assertEquals(service.activity(chat.id).cg1, { where: 'Own worktree', landing: 'Lands when the turn ends' });
    // the explicit stop still works: the stream says Claude Code cancelled it (the Activity panel's per-subagent stop, TaskStop)
    await service.acpEnded(chat.id, 'cg3', 'cancelled');
    assertEquals([stateOf('cg3').state, stateOf('cg3').stoppedWhy], ['stopped', 'it was cancelled']);
    // Codex and Gemini subagents run inside the turn: a stopped turn stops them all, as before
    const service2 = new SubagentWorktrees(join(dir, 'state2'), join(dir, 'state2', 'worktrees'), (id) => (id === chat.id ? chat : null));
    await service2.hook('pre-tool', chat.id, { tool_name: 'Agent', tool_use_id: 'toolu_c9', tool_input: { prompt: 'x', description: 'sub 9', run_in_background: true } });
    await service2.hook('worktree-create', chat.id, { name: 'agent-cg9' });
    await service2.turnCancelled(chat.id); // no provider: every running one stops
    assertEquals(Object.values(readSubagents(join(dir, 'state2'))).find((r) => r.agentId === 'cg9')!.state, 'stopped');
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test('P3: the landing words of a swarm subagent entry', () => {
  assertEquals(landingWords({ state: 'merged', merge: {}, sub: { files: 3 } }), 'Merged · 3 files');
  assertEquals(landingWords({ state: 'merged', merge: {}, sub: { files: 1 } }), 'Merged · 1 file');
  assertEquals(landingWords({ state: 'merged', merge: null, sub: { empty: true, files: 0 } }), 'No changes');
  assertEquals(landingWords({ state: 'merged', merge: { undo: { revert: 'x' } }, sub: { files: 2 } }), 'Merge undone');
  assertEquals(landingWords({ state: 'failed', reason: 'protected' }), "Didn't land: it changed protected files");
  assertEquals(landingWords({ state: 'done', landing: { waitsFor: 'touched-dirty' } }), "Didn't land: files it changed have uncommitted edits");
  assertEquals(landingWords({ state: 'done', landing: { waitsFor: '' } }), 'Lands when the turn ends');
  assertEquals(landingWords({ state: 'stopped' }), 'Stopped — ask the agent to merge it');
  for (const t of ['Own copy', 'own copy']) assert(!JSON.stringify(TEXTS).includes(t));
});

Deno.test('P3: subagentEnd reads the adapter\'s RFD end states', () => {
  assertEquals(subagentEnd({ state: 'running' }), null);
  assertEquals(subagentEnd(undefined), null);
  assertEquals(subagentEnd({ state: 'idle', stopReason: 'end_turn' }), 'end_turn');
  assertEquals(subagentEnd({ state: 'idle', stopReason: 'cancelled' }), 'cancelled');
  assertEquals(subagentEnd({ state: 'idle', stopReason: 'error' }), 'error');
  assertEquals(subagentEnd({ state: 'idle' }), '');
  assertEquals(subagentEnd({ state: 'unknown' }), 'unknown');
  assertEquals(subagentEnd({ state: 'failed' }), 'error');
});

Deno.test('aib-shared: a subagent worktree gets the link; a file it writes there is in the main folder at once; removal keeps it', async () => {
  const dir = Deno.makeTempDirSync({ prefix: 'aib-subshared-' });
  try {
    const state = join(dir, 'state'), root = join(state, 'worktrees');
    const project = repo(join(dir, 'proj'));
    assertEquals((await ensureDefault(project))?.defaultState, 'on', '/aib-shared in the temp repo\'s own exclude');
    const chat: SubagentChat = {
      id: 'aa11bb22cc',
      provider: 'claude',
      lasting: 'claude:s9',
      folder: project,
      project,
      hooks: { readOnly: new Set(), userWorktreeHook: false },
    };
    const service = new SubagentWorktrees(state, root, (id) => (id === chat.id ? chat : null));
    await service.hook('pre-tool', chat.id, { tool_name: 'Agent', tool_use_id: 'toolu_s', tool_input: { prompt: 'x', subagent_type: 'general-purpose' } });
    const bound = await service.hook('worktree-create', chat.id, { name: 'agent-s1' });
    assertEquals(bound.status, 200);
    const path = bound.body;
    assert(Deno.lstatSync(join(path, 'aib-shared')).isSymlink, 'a link (a junction on Windows), not a copy');
    Deno.writeTextFileSync(join(path, 'aib-shared', 'draft.md'), 'from the subagent\n');
    assertEquals(Deno.readTextFileSync(join(project, 'aib-shared', 'draft.md')), 'from the subagent\n', 'in the main folder at once');
    assertEquals(git(path, 'status', '--porcelain', '--untracked-files=all'), '', 'git in the subagent worktree shows nothing');
    assertEquals(git(project, 'status', '--porcelain', '--untracked-files=all'), '', 'nor in the main folder');
    assertEquals(await ignoredFiles(path), [], 'nothing of its own to keep the worktree for');
    unlinkLinks(path); // the service's own removal path (removeSubagentWorktree): links first
    git(project, 'worktree', 'unlock', path);
    git(project, 'worktree', 'remove', '--force', path);
    assertEquals(Deno.readTextFileSync(join(project, 'aib-shared', 'draft.md')), 'from the subagent\n', 'the real folder keeps it');
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
    // MF 2: isolation "remote" is no exemption: it gets a worktree like any editing call
    const remote = await decision('pre-tool', { tool_name: 'Agent', tool_use_id: 'toolu_r', tool_input: { prompt: 'x', isolation: 'remote' } });
    assertEquals(remote.updatedInput, { prompt: 'x', isolation: 'worktree' });

    // a UNC hint is never touched; a forged stop counts as a hint only
    await call('post-agent', { tool_use_id: 'toolu_9', tool_response: { agentId: 'zz', worktreePath: '\\\\203.0.113.9\\share' } });
    // an internal fork's stop (agent_type "") changes nothing; a stop with its agentId makes it done (P2: it then lands only once
    // the parent is idle, under the parent's landing lock; nothing is removed here)
    await call('subagent-stop', { agent_id: 'a1', agent_type: '' });
    assertEquals(Object.values(readSubagents(state)).find((r) => r.agentId === 'a1')!.state, 'running');
    await call('subagent-stop', { agent_id: 'a1', agent_type: 'general-purpose' });
    assertEquals(Object.values(readSubagents(state)).find((r) => r.agentId === 'a1')!.state, 'running', 'a stop alone is only a hint (2026-11-25)');
    await service.acpEnded(chat.id, 'a1', 'end_turn');
    assertEquals(Object.values(readSubagents(state)).find((r) => r.agentId === 'a1')!.state, 'done');

    // the cap: at most MAX_PER_CHAT live subagents (the finished a1 does not count: subagent_restart_test.ts)
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
