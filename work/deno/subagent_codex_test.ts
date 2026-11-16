/**
 * Subagent worktrees, Codex (server/subagents/codex.ts), without an agent. The real codex-acp end to end is
 * work/test_subagent_codex_e2e.py.
 *   the hook commands: a bare program first, the address file quoted (cmd.exe, pwsh and PowerShell 5.1 read it alike: no `||` on
 *        Windows); null for a path they can't hold
 *   the trust hashes match what a real codex app-server 0.166 listed for the same hooks (hooks/list currentHash)
 *   CODEX_CONFIG: the user's own hooks and settings kept, AIB's hooks after theirs with state keys at their group index;
 *        hooks off -> features.multi_agent = false merged into the user's features
 *   hooks off is read from config.toml ([features] hooks / codex_hooks, dotted, inline, profiles), CODEX_CONFIG, requirements
 *   the routes: spawn_agent prepares a worktree; SubagentStart binds it and names it; a subagent's Bash runs there (cd prefix), is
 *        denied when it names the main folder; apply_patch only with absolute paths inside; other MCP tools denied; a subagent AIB
 *        has no worktree for is denied; SubagentStop makes it done (P2 lands it)
 *   the chat's own subagent folder (.cx-<chat>, a writable root of its sandbox): its worktrees there are AIB's own paths
 */
import { assert, assertEquals } from './_assert.ts';
import {
  codexHook,
  codexHookCommand,
  codexHookHash,
  codexHooks,
  namesFolder,
  patchInside,
  readCodexSetup,
  removeSubagentFolder,
  requirementsManagedOnly,
  subagentFolder,
  tomlTurnsHooksOff,
  withCodexHooks,
  withSubagentsOff,
} from '../../outputs/agent-studio/server/subagents/codex.ts';
import { ownSubagentPath, readSubagents, type SubagentChat, SubagentWorktrees } from '../../outputs/agent-studio/server/subagents/service.ts';
import { join } from '../../outputs/agent-studio/server/platform/path.ts';

const WIN = Deno.build.os === 'windows';

function git(cwd: string, ...args: string[]): string {
  const out = new Deno.Command('git', {
    args: ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...args],
    cwd,
    stdout: 'piped',
    stderr: 'piped',
  })
    .outputSync();
  if (!out.success) throw new Error(`git ${args.join(' ')}: ${new TextDecoder().decode(out.stderr)}`);
  return new TextDecoder().decode(out.stdout);
}

function repo(dir: string): string {
  Deno.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  Deno.writeTextFileSync(join(dir, 'tracked.txt'), 'one\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'first');
  return dir;
}

Deno.test('Codex hook commands: bare program first, quoted address file, fail closed; null when unsafe', () => {
  assertEquals(
    codexHookCommand(
      'C:\\Users\\x\\AgentStudio\\keeper-bin\\ab\\AIB-keeper.exe',
      'C:\\Users\\x\\AgentStudio\\artifact-mcp.json',
      'codex-pre-tool',
      'windows',
    ),
    'C:\\Users\\x\\AgentStudio\\keeper-bin\\ab\\AIB-keeper.exe hook codex-pre-tool "C:\\Users\\x\\AgentStudio\\artifact-mcp.json"',
  );
  assertEquals(
    codexHookCommand('C:\\Users\\John Smith\\k.exe', 'C:\\a.json', 'codex-pre-tool', 'windows'),
    null,
    'a space: cmd.exe would split it',
  );
  assertEquals(codexHookCommand('C:\\a&b\\k.exe', 'C:\\a.json', 'codex-pre-tool', 'windows'), null);
  assertEquals(codexHookCommand('C:\\k.exe', 'C:\\%TEMP%\\a.json', 'codex-pre-tool', 'windows'), null, '% expands even in quotes');
  assertEquals(codexHookCommand('C:\\k.exe', 'C:\\$x\\a.json', 'codex-pre-tool', 'windows'), null, '$ expands in PowerShell quotes');
  assertEquals(codexHookCommand('C:\\$x\\k.exe', 'C:\\a.json', 'codex-pre-tool', 'windows'), null, '$ in a bare PowerShell word');
  assertEquals(
    codexHookCommand('/home/u/k', '/home/u/a.json', 'codex-subagent-stop', 'linux'),
    "'/home/u/k' hook codex-subagent-stop '/home/u/a.json' || exit 2",
  );
  assertEquals(codexHookCommand("/home/o'k/k", '/a.json', 'codex-pre-tool', 'linux'), null);
});

Deno.test('trust hashes match what codex app-server 0.166 listed (hooks/list currentHash)', () => {
  // listed by a real app-server for these exact hooks (.sx-scratch probe, 2026-11-16)
  const cmd = 'cd /d "C:\\x y" && AIB-keeper.exe hook codex-pre-tool "C:\\a\\b.json" || exit 2';
  assertEquals(
    codexHookHash('pre_tool_use', null, { command: cmd, timeout: 30 }),
    'sha256:c69503b4ad320b7f1a5b0f9d9d78706d81e896b7cdc84291622de5fd2d9d0013',
  );
  assertEquals(
    codexHookHash('subagent_start', 'x', { command: 'foo', timeout: 30 }),
    'sha256:b5ff6cea2b4dabca6f879e1b2c45b41103690a663db9dc0420e2f96c2231fc1f',
  );
});

Deno.test("CODEX_CONFIG: the user's hooks and settings are kept; AIB's hooks follow theirs, trusted at their index", () => {
  const user = {
    model: 'gpt-x',
    features: { web_search: true },
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'mine', timeout: 5 }] }],
      state: { 'mine-key': { trusted_hash: 'h' } },
    },
  };
  const hooks = codexHooks('C:\\k\\AIB-keeper.exe', 'C:\\s\\artifact-mcp.json', 'D:\\proj', user.hooks, 'windows')!;
  // deno-lint-ignore no-explicit-any
  const merged = withCodexHooks(user, hooks) as Record<string, any>;
  assertEquals(merged.model, 'gpt-x');
  assertEquals(merged.hooks.PreToolUse.length, 2);
  assertEquals(merged.hooks.PreToolUse[0].hooks[0].command, 'mine');
  assertEquals(
    merged.hooks.PreToolUse[1].hooks[0].command,
    'C:\\k\\AIB-keeper.exe hook codex-pre-tool "C:\\s\\artifact-mcp.json"',
  );
  assertEquals(merged.hooks.state['mine-key'], { trusted_hash: 'h' });
  const pre = codexHookHash('pre_tool_use', null, merged.hooks.PreToolUse[1].hooks[0]);
  assertEquals(merged.hooks.state['C:\\<session-flags>\\config.toml:pre_tool_use:1:0'], { trusted_hash: pre });
  assertEquals(merged.hooks.state['D:\\<session-flags>\\config.toml:pre_tool_use:1:0'], { trusted_hash: pre }, "the project's drive too");
  assert(merged.hooks.state['C:\\<session-flags>\\config.toml:subagent_start:0:0'], 'SubagentStart: its first group');
  assert(!JSON.stringify(merged).includes('AIB_HOOK_KEY'), 'no key in the config');
  assertEquals(codexHooks('C:\\with space\\k.exe', 'C:\\a.json', 'C:\\p', null, 'windows'), null);
  // deno-lint-ignore no-explicit-any
  const off = withSubagentsOff(user) as Record<string, any>;
  assertEquals(off.features, { web_search: true, multi_agent: false });
  assertEquals(off.model, 'gpt-x');
  assertEquals(withSubagentsOff(null), { features: { multi_agent: false } });
});

Deno.test('hooks off is read from config.toml, CODEX_CONFIG and the managed requirements (cautiously)', () => {
  assert(tomlTurnsHooksOff('[features]\nhooks = false\n'));
  assert(tomlTurnsHooksOff('[features]\ncodex_hooks = false # old name\n'));
  assert(tomlTurnsHooksOff('features.hooks = false\n'));
  assert(tomlTurnsHooksOff('features = { multi_agent = true, hooks = false }\n'));
  assert(tomlTurnsHooksOff('[profiles.work.features]\nhooks = "no"\n'), 'a value that is not true counts as off');
  assert(!tomlTurnsHooksOff('[features]\nhooks = true\nmulti_agent = false\n'));
  assert(!tomlTurnsHooksOff('[hooks]\n[[hooks.PreToolUse]]\nmatcher = "x"\n'));
  assert(!tomlTurnsHooksOff('model = "x"\n# features.hooks = false\n'));
  assert(requirementsManagedOnly('[hooks]\nallow_managed_hooks_only = true\n'));
  assert(!requirementsManagedOnly('allow_managed_hooks_only = false\n'));
  const dir = Deno.makeTempDirSync({ prefix: 'aib-codexcfg-' });
  try {
    const home = join(dir, 'codex'), proj = join(dir, 'proj');
    Deno.mkdirSync(home, { recursive: true });
    Deno.mkdirSync(join(proj, '.codex'), { recursive: true });
    const env = { CODEX_HOME: home, ProgramData: join(dir, 'pd') };
    assertEquals(readCodexSetup(proj, env, 'windows').hooksOff, '');
    Deno.writeTextFileSync(join(proj, '.codex', 'config.toml'), '[features]\nhooks = false\n');
    assert(readCodexSetup(proj, env, 'windows').hooksOff.includes('.codex/config.toml'));
    Deno.removeSync(join(proj, '.codex', 'config.toml'));
    Deno.mkdirSync(join(dir, 'pd', 'OpenAI', 'Codex'), { recursive: true });
    Deno.writeTextFileSync(join(dir, 'pd', 'OpenAI', 'Codex', 'requirements.toml'), 'allow_managed_hooks_only = true\n');
    assert(readCodexSetup(proj, env, 'windows').hooksOff.includes('allow_managed_hooks_only'));
    Deno.removeSync(join(dir, 'pd'), { recursive: true });
    assert(readCodexSetup(proj, { ...env, CODEX_CONFIG: '{"features":{"hooks":false}}' }, 'windows').hooksOff.includes('CODEX_CONFIG'));
    assertEquals(readCodexSetup(proj, { ...env, CODEX_CONFIG: '{"model":"m"}' }, 'windows').config, { model: 'm' });
    assert(readCodexSetup(proj, { ...env, CODEX_CONFIG: '{oops' }, 'windows').configError);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test('namesFolder and patchInside', () => {
  const main = WIN ? 'C:\\Users\\me\\proj' : '/home/me/proj';
  const wt = WIN ? 'C:\\Users\\me\\AppData\\Local\\AgentStudio\\worktrees\\abc\\sub-1' : '/home/me/.aib/worktrees/abc/sub-1';
  const fwd = (p: string) => p.replaceAll('\\', '/');
  assert(namesFolder(`echo x > ${main}\\a.txt`, [main], wt));
  assert(namesFolder(`echo x > "${fwd(main)}/a.txt"`, [main], wt));
  assert(namesFolder(`cd ${main}`, [main], wt));
  if (WIN) {
    assert(namesFolder('echo x > /c/Users/me/proj/a.txt', [main], wt), 'Git Bash form');
    assert(namesFolder('echo x > c:\\\\users\\\\ME\\\\proj\\\\a.txt', [main], wt), 'doubled backslashes, any case');
  }
  assert(!namesFolder(`echo x > ${main}-old/a.txt`, [main], wt), 'another folder that starts the same');
  assert(!namesFolder('echo x > a.txt', [main], wt));
  assert(!namesFolder(`cat ${wt}\\a.txt`, [WIN ? 'C:\\Users\\me' : '/home/me'], wt), 'its own worktree under the home folder');
  assert(
    namesFolder(`cat ${wt}\\..\\sub-2\\a.txt C:\\Users\\me\\x`.replace('C:\\Users\\me\\x', WIN ? 'C:\\Users\\me\\x' : '/home/me/x'), [
      WIN ? 'C:\\Users\\me' : '/home/me',
    ], wt),
  );
  const sep = WIN ? '\\' : '/';
  assert(patchInside(`*** Begin Patch\n*** Add File: ${wt}${sep}f.txt\n+x\n*** End Patch`, wt));
  assert(patchInside(`*** Begin Patch\n*** Update File: ${fwd(wt)}/src/f.txt\n@@\n-a\n+b\n*** End of File\n*** End Patch`, wt));
  assert(
    !patchInside('*** Begin Patch\n*** Add File: f.txt\n+x\n*** End Patch', wt),
    'relative: Codex would resolve it in the main folder',
  );
  assert(!patchInside(`*** Begin Patch\n*** Add File: ${main}${sep}f.txt\n*** End Patch`, wt));
  assert(!patchInside(`*** Begin Patch\n*** Add File: ${wt}${sep}..${sep}f.txt\n*** End Patch`, wt));
  assert(!patchInside(`*** Begin Patch\n*** Update File: ${wt}${sep}a\n*** Move to: ${main}${sep}a\n*** End Patch`, wt));
  assert(!patchInside(`*** Begin Patch\n*** Rename File: ${wt}${sep}a\n*** End Patch`, wt), 'an unknown header');
});

Deno.test('Codex routes: spawn prepares, start binds and names it, Bash runs there, the main folder is refused, stop ends it', async () => {
  const dir = Deno.makeTempDirSync({ prefix: 'aib-codexroutes-' });
  const state = join(dir, 'state'), root = join(state, 'worktrees');
  Deno.mkdirSync(state, { recursive: true });
  const project = repo(join(dir, 'proj'));
  const chat: SubagentChat = {
    id: 'cx1',
    provider: 'codex',
    lasting: 'codex:s1',
    folder: project,
    project,
    hooks: { readOnly: new Set(), userWorktreeHook: false },
  };
  const svc = new SubagentWorktrees(state, root, (id) => (id === 'cx1' ? chat : null));
  const call = async (event: string, body: Record<string, unknown>) => {
    const a = await codexHook(svc, event, chat, body);
    return { status: a.status, body: a.body ? JSON.parse(a.body) : {} };
  };
  try {
    // a subagent nobody spawned: refused
    let a = await call('codex-pre-tool', { tool_name: 'Bash', agent_id: 'ghost', tool_input: { command: 'echo hi' } });
    assertEquals(a.body.hookSpecificOutput.permissionDecision, 'deny');

    a = await call('codex-pre-tool', {
      tool_name: 'spawn_agent',
      tool_use_id: 'call_1',
      tool_input: { message: 'Write the file\nplease' },
    });
    assertEquals(a.body, {}, 'spawn passes once its worktree is ready');
    const prepared = Object.values(readSubagents(state)).find((r) => r.toolUseId === 'call_1')!;
    assertEquals(prepared.state, 'prepared');
    assertEquals(prepared.description, 'Write the file please');
    assert(prepared.path.startsWith(root));

    a = await call('codex-subagent-start', { agent_id: 'agent-1', agent_type: 'default' });
    assertEquals(a.body.hookSpecificOutput.hookEventName, 'SubagentStart');
    assert(a.body.hookSpecificOutput.additionalContext.includes(prepared.path));
    assertEquals(readSubagents(state)[prepared.id].state, 'running');
    assertEquals(readSubagents(state)[prepared.id].agentId, 'agent-1');

    a = await call('codex-pre-tool', { tool_name: 'Bash', agent_id: 'agent-1', tool_input: { command: 'echo hi > a.txt' } });
    assertEquals(a.body.hookSpecificOutput.permissionDecision, 'allow');
    assertEquals(a.body.hookSpecificOutput.updatedInput, { command: `cd '${prepared.path.replaceAll('\\', '/')}'; echo hi > a.txt` });

    a = await call('codex-pre-tool', {
      tool_name: 'Bash',
      agent_id: 'agent-1',
      tool_input: { command: `echo hi > "${join(project, 'a.txt')}"` },
    });
    assertEquals(a.body.hookSpecificOutput.permissionDecision, 'deny');
    assert(a.body.hookSpecificOutput.permissionDecisionReason.includes(prepared.path));

    a = await call('codex-pre-tool', {
      tool_name: 'apply_patch',
      agent_id: 'agent-1',
      tool_input: { command: '*** Begin Patch\n*** Add File: b.txt\n+x\n*** End Patch' },
    });
    assertEquals(a.body.hookSpecificOutput.permissionDecision, 'deny');
    a = await call('codex-pre-tool', {
      tool_name: 'apply_patch',
      agent_id: 'agent-1',
      tool_input: { command: `*** Begin Patch\n*** Add File: ${join(prepared.path, 'b.txt')}\n+x\n*** End Patch` },
    });
    assertEquals(a.body, {});
    a = await call('codex-pre-tool', { tool_name: 'mcp__filesystem__write_file', agent_id: 'agent-1', tool_input: {} });
    assertEquals(a.body.hookSpecificOutput.permissionDecision, 'deny');
    a = await call('codex-pre-tool', { tool_name: 'mcp__studio_artifact__doc_read', agent_id: 'agent-1', tool_input: {} });
    assertEquals(a.body, {});
    a = await call('codex-pre-tool', { tool_name: 'mcp__studio_artifact__merge_into_project', agent_id: 'agent-1', tool_input: {} });
    assertEquals(a.body.hookSpecificOutput.permissionDecision, 'deny');

    await call('codex-subagent-stop', { agent_id: 'agent-1', agent_type: 'default' });
    assertEquals(readSubagents(state)[prepared.id].state, 'done', 'done: P2 lands it when the parent is idle');
    a = await call('codex-pre-tool', { tool_name: 'Bash', agent_id: 'agent-1', tool_input: { command: 'echo again' } });
    assertEquals(a.body.hookSpecificOutput.permissionDecision, 'allow', 'continued (send_input): its own worktree again');
    assertEquals(readSubagents(state)[prepared.id].state, 'running');
    assertEquals(git(project, 'status', '--porcelain'), '', 'nothing in the main folder');
  } finally {
    await svc.chatClosed('cx1');
    for (const r of Object.values(readSubagents(state))) {
      try {
        git(project, 'worktree', 'unlock', r.path);
      } catch { /* not locked */ }
    }
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("a Codex chat's own subagent folder: <root>/<repo hash>/.cx-<chat>; its worktrees are AIB's own paths; removed only empty", async () => {
  const { repoHash } = await import('../../outputs/agent-studio/server/worktrees/worktrees.ts');
  const temp = Deno.makeTempDirSync({ prefix: 'aib-cx-own-', dir: Deno.env.get('TEMP') ?? undefined });
  try {
    const root = join(temp, 'worktrees'), project = join(temp, 'proj');
    const folder = subagentFolder(root, project, 'c1');
    assertEquals(folder, join(root, repoHash(project), '.cx-c1'));
    const sub = join(folder, 'sub-c1-1');
    Deno.mkdirSync(sub, { recursive: true });
    assert(ownSubagentPath(root, { path: sub, project }));
    assert(!ownSubagentPath(root, { path: folder, project }), 'the chat folder itself is no worktree');
    assert(!ownSubagentPath(root, { path: join(root, repoHash(project), 'cx-c1', 'sub-c1-1'), project }), 'any other middle folder');
    removeSubagentFolder(folder);
    assert(Deno.statSync(sub).isDirectory, 'a folder with a worktree in it stays');
    Deno.removeSync(sub);
    removeSubagentFolder(folder);
    let gone = false;
    try {
      Deno.statSync(folder);
    } catch {
      gone = true;
    }
    assert(gone, 'an empty chat folder goes');
  } finally {
    Deno.removeSync(temp, { recursive: true });
  }
});
