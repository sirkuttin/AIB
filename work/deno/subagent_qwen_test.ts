/**
 * Subagent worktrees, Qwen Code (server/subagents/qwen.ts), without an agent. The real Qwen Code end to end is
 * work/deno/e2e_subagent_qwen_test.ts.
 *   the hook commands: the program first and bare, forward slashes, `|| exit 2`; never a command that starts with a double quote
 *        (Windows: cmd.exe strips the quotes of such a line and Qwen skips the hook silently: probe 2026-11-25), for every provider
 *        whose hooks cmd.exe runs (Qwen, Codex); null for a path they can't hold. A missing program blocks the call (real cmd.exe).
 *   the system settings: AIB's hooks follow the user's, their deny rules and other settings stay; hooks off -> `agent` denied
 *   hooks off is read from the settings tiers and the environment; an unreadable system file is reported
 *   the routes: agent prepares a worktree and sets working_dir; SubagentStart binds the worktree of ITS call; the subagent's writes
 *        only inside it; its shell only there; MCP tools only AIB's; forks and nesting refused; Explore (no worktree) reads only;
 *        SubagentStop makes it done
 */
import { assert, assertEquals } from './_assert.ts';
import { codexHookCommand } from '../../app/server/subagents/codex.ts';
import { hookCommand } from '../../app/server/subagents/gemini.ts';
import { hookForwarderKnowsQwen, hookForwarderOf } from '../../app/server/keeper/client.ts';
import {
  insideWorktree,
  mergeSystemSettings,
  offFragment,
  onFragment,
  QWEN_HOOK_EVENTS,
  QWEN_TEXTS,
  qwenHook,
  qwenHookCommand,
  qwenHooks,
  readQwenSetup,
  settingsFileOf,
  sweepSettings,
  systemSettingsPath,
  writeSettingsFile,
} from '../../app/server/subagents/qwen.ts';
import { readSubagents, type SubagentChat, SubagentWorktrees } from '../../app/server/subagents/service.ts';
import { join } from '../../app/server/platform/path.ts';

const WIN = Deno.build.os === 'windows';
type Json = Record<string, unknown>;

function git(cwd: string, ...args: string[]): string {
  const out = new Deno.Command('git', {
    args: ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...args],
    cwd,
    stdout: 'piped',
    stderr: 'piped',
  }).outputSync();
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

/** The chat closes, worktrees unlock and the folder goes (the chat's spare is built in the background: wait for it, retry). */
async function tidy(svc: SubagentWorktrees, chat: string, dir: string, state: string, project: string): Promise<void> {
  await svc.chatClosed(chat);
  for (let i = 0; i < 20; i++) {
    for (const r of Object.values(readSubagents(state))) {
      try {
        git(project, 'worktree', 'unlock', r.path);
      } catch { /* not locked */ }
    }
    try {
      Deno.removeSync(dir, { recursive: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await svc.chatClosed(chat);
    }
  }
  Deno.removeSync(dir, { recursive: true });
}

Deno.test('Qwen hook commands: bare program first, forward slashes, quoted address file, fail closed; null when unsafe', () => {
  assertEquals(
    qwenHookCommand(
      'C:\\Users\\x\\AIB\\keeper-bin\\ab\\AIB-keeper.exe',
      'C:\\Users\\x\\AIB\\artifact-mcp.json',
      'qwen-pre-tool',
      'windows',
    ),
    'C:/Users/x/AIB/keeper-bin/ab/AIB-keeper.exe hook qwen-pre-tool C:/Users/x/AIB/artifact-mcp.json || exit 2',
  );
  assertEquals(
    qwenHookCommand('C:\\Users\\John Smith\\k.exe', 'C:\\a.json', 'qwen-pre-tool', 'windows'),
    null,
    'a space: cmd.exe would split it',
  );
  assertEquals(qwenHookCommand('C:\\a&b\\k.exe', 'C:\\a.json', 'qwen-pre-tool', 'windows'), null);
  assertEquals(qwenHookCommand('C:\\k.exe', 'C:\\%TEMP%\\a.json', 'qwen-pre-tool', 'windows'), null, '% expands even in quotes');
  assertEquals(qwenHookCommand('C:\\$x\\k.exe', 'C:\\a.json', 'qwen-pre-tool', 'windows'), null);
  assertEquals(qwenHookCommand('C:\\k.exe', 'C:\\a"b.json', 'qwen-pre-tool', 'windows'), null);
  // the address file is never quoted: Node hands cmd.exe the command with its quotes escaped, so a quoted file reaches the program with them
  assertEquals(
    qwenHookCommand('C:\\k.exe', 'C:\\Users\\John Smith\\state\\a.json', 'qwen-pre-tool', 'windows'),
    null,
    'a space in the file',
  );
  assertEquals(qwenHookCommand('C:\\k.exe', 'relative.json', 'qwen-pre-tool', 'windows'), null, 'not an absolute path');
  assertEquals(
    qwenHookCommand('/home/u/k', '/home/u/a.json', 'qwen-subagent-stop', 'linux'),
    "'/home/u/k' hook qwen-subagent-stop '/home/u/a.json' || exit 2",
  );
  assertEquals(
    qwenHookCommand('/usr/bin/k', '/run/h.sock', 'qwen-pre-tool', 'linux', true),
    "'/usr/bin/k' hook qwen-pre-tool --helper-socket '/run/h.sock' || exit 2",
  );
  assertEquals(qwenHookCommand("/home/o'k/k", '/a.json', 'qwen-pre-tool', 'linux'), null);
  assertEquals(qwenHooks('C:\\k\\AIB-keeper.exe', 'C:\\s\\a.json', 'windows') !== null, true);
  assertEquals(qwenHooks('C:\\with space\\k.exe', 'C:\\a.json', 'windows'), null);
  const hooks = qwenHooks('C:\\k\\AIB-keeper.exe', 'C:\\s\\a.json', 'windows')!;
  assertEquals(Object.keys(hooks), ['PreToolUse', 'SubagentStart', 'SubagentStop']);
  assertEquals(QWEN_HOOK_EVENTS, ['qwen-pre-tool', 'qwen-subagent-start', 'qwen-subagent-stop']);
  assert(!JSON.stringify(hooks).includes('AIB_HOOK_KEY'), 'no key in the settings');
});

Deno.test('Windows hook writers whose command cmd.exe runs never start with a double quote (Qwen, Codex), whatever the path', () => {
  // cmd.exe /d /s /c strips the first and last quote of a line that starts with one: the hook is silently skipped (Qwen 0.27.2 probe)
  const programs = [
    'C:\\k\\AIB-keeper.exe',
    'C:\\Users\\x\\AppData\\Local\\AIB\\keeper-bin\\ab12\\AIB-keeper.exe',
    'D:\\a-b_c\\keeper.exe',
    'C:\\Program Files\\AIB\\k.exe',
    '"C:\\k\\AIB-keeper.exe"',
  ];
  const files = ['C:\\s\\artifact-mcp.json', 'C:\\Users\\x y\\state\\a.json', '"C:\\s\\a.json"'];
  let checked = 0;
  for (const program of programs) {
    for (const file of files) {
      for (const event of QWEN_HOOK_EVENTS) {
        const command = qwenHookCommand(program, file, event, 'windows');
        if (command !== null) {
          assert(!command.startsWith('"'), `qwen: ${command}`);
          assert(!command.startsWith("'"), `qwen: ${command}`);
          checked++;
        }
      }
      for (const event of ['codex-pre-tool', 'codex-subagent-start', 'codex-subagent-stop']) {
        const command = codexHookCommand(program, file, event, 'windows');
        if (command !== null) {
          assert(!command.startsWith('"'), `codex: ${command}`);
          checked++;
        }
      }
    }
  }
  assert(checked > 10, `the writers wrote ${checked} commands`);
  // Gemini's hook runs in PowerShell (`& 'program' ...`) or bash: never a line that starts with a double quote either; Claude's runs
  // in Git Bash, where a quoted program is the verified form (claude_config.ts hookSettings)
  for (const program of programs) assert(!hookCommand(program, 'C:\\s\\a.json').startsWith('"'), hookCommand(program, 'C:\\s\\a.json'));
});

Deno.test('the keeper program: only a forwarder that answers hook 4 knows the qwen-* events (an older one turns Qwen subagents off)', async () => {
  const fakes = Deno.makeTempDirSync({ prefix: 'aib-qwenkeeper-' });
  try {
    for (const [version, knows] of [[1, false], [2, false], [3, false], [4, true]] as const) {
      const program = join(fakes, WIN ? `fwd${version}.cmd` : `fwd${version}.sh`);
      Deno.writeTextFileSync(program, WIN ? `@echo off\r\necho hook ${version}\r\n` : `#!/bin/sh\necho hook ${version}\n`);
      if (!WIN) Deno.chmodSync(program, 0o755);
      assertEquals(await hookForwarderOf(program, fakes), program, `hook ${version} still gives the other agents their hooks`);
      assertEquals(hookForwarderKnowsQwen(program), knows, `hook ${version}`);
    }
  } finally {
    Deno.removeSync(fakes, { recursive: true });
  }
});

Deno.test({
  name: 'a Qwen hook command whose program is missing exits 2 (blocks the call) under cmd.exe /d /s /c, as Qwen runs it',
  ignore: !WIN,
  fn() {
    const dir = Deno.makeTempDirSync({ prefix: 'aib-qwencmd-' });
    try {
      const command = qwenHookCommand(join(dir, 'no-such-keeper.exe'), join(dir, 'a.json'), 'qwen-pre-tool', 'windows')!;
      const out = new Deno.Command('cmd.exe', { args: ['/d', '/s', '/c', command], stdin: 'null', stdout: 'piped', stderr: 'piped' })
        .outputSync();
      assertEquals(out.code, 2, new TextDecoder().decode(out.stderr));
      // and a program that is there and exits 0 passes the call (the `||` is not run)
      const ok = new Deno.Command('cmd.exe', {
        args: ['/d', '/s', '/c', `${Deno.env.get('SystemRoot')!.replaceAll('\\', '/')}/System32/whoami.exe || exit 2`],
        stdin: 'null',
        stdout: 'null',
        stderr: 'null',
      }).outputSync();
      assertEquals(ok.code, 0);
    } finally {
      Deno.removeSync(dir, { recursive: true });
    }
  },
});

Deno.test("Qwen system settings: AIB's hooks follow the user's; their deny rules and settings stay; off denies `agent`", () => {
  const theirs = {
    model: { name: 'm' },
    hooks: { PreToolUse: [{ matcher: 'x', hooks: [{ type: 'command', command: 'mine' }] }], Stop: [{ hooks: [] }] },
    permissions: { deny: ['run_shell_command(rm)'], allow: ['read_file'] },
  };
  const hooks = qwenHooks('C:\\k\\AIB-keeper.exe', 'C:\\s\\a.json', 'windows')!;
  const merged = mergeSystemSettings(theirs, onFragment(hooks)) as Json & { hooks: Record<string, unknown[]>; permissions: Json };
  assertEquals(merged.model, theirs.model);
  assertEquals(merged.hooks.PreToolUse.length, 2);
  assertEquals((merged.hooks.PreToolUse[0] as Json).matcher, 'x', 'theirs first');
  assertEquals(merged.hooks.Stop, theirs.hooks.Stop);
  assertEquals(merged.hooks.SubagentStop.length, 1);
  assertEquals(merged.permissions.allow, ['read_file']);
  assertEquals(merged.permissions.deny, ['run_shell_command(rm)', 'Agent(claude-code)', 'Agent(codex)']);
  assertEquals(theirs.hooks.PreToolUse.length, 1, "the user's object is not changed");
  const off = mergeSystemSettings(theirs, offFragment()) as Json & { permissions: Json };
  assertEquals(off.hooks, theirs.hooks, 'no AIB hook when off');
  assertEquals(off.permissions.deny, ['run_shell_command(rm)', 'Agent(claude-code)', 'Agent(codex)', 'agent']);
  assertEquals(mergeSystemSettings(null, offFragment()), { permissions: { deny: ['Agent(claude-code)', 'Agent(codex)', 'agent'] } });
  assertEquals((mergeSystemSettings(null, onFragment(hooks)) as Json & { hooks: Json }).hooks, hooks);
});

Deno.test('Qwen hooks off: read from the settings tiers and the environment; an unreadable system file is reported', () => {
  const dir = Deno.makeTempDirSync({ prefix: 'aib-qwencfg-' });
  try {
    const home = join(dir, 'qh'), project = join(dir, 'proj'), sys = join(dir, 'sys.json');
    Deno.mkdirSync(home, { recursive: true });
    Deno.mkdirSync(join(project, '.qwen'), { recursive: true });
    const env = { QWEN_HOME: home, QWEN_CODE_SYSTEM_SETTINGS_PATH: sys, USERPROFILE: dir, HOME: dir };
    let s = readQwenSetup(project, env);
    assertEquals([s.hooksOff, s.system, s.systemError], ['', null, ''], 'nothing there: hooks on');
    assertEquals(systemSettingsPath(env), sys);
    Deno.writeTextFileSync(join(home, 'settings.json'), '// mine\n{"disableAllHooks": true, "x": 1,}');
    assert(readQwenSetup(project, env).hooksOff.includes('your Qwen settings'), 'user settings (comments and trailing commas read)');
    Deno.writeTextFileSync(join(home, 'settings.json'), '{"disableAllHooks": false}');
    assertEquals(readQwenSetup(project, env).hooksOff, '');
    Deno.writeTextFileSync(join(project, '.qwen', 'settings.json'), '{"disableAllHooks": true}');
    assert(readQwenSetup(project, env).hooksOff.includes('project'), 'a project file counts too (the safe side)');
    Deno.removeSync(join(project, '.qwen', 'settings.json'));
    Deno.writeTextFileSync(sys, '{"disableAllHooks": true, "hooks": {}}');
    s = readQwenSetup(project, env);
    assert(s.hooksOff.includes('system'));
    assertEquals(s.system, { disableAllHooks: true, hooks: {} });
    Deno.writeTextFileSync(sys, '{ not json');
    s = readQwenSetup(project, env);
    assert(s.systemError.includes('not valid JSON'), s.systemError);
    Deno.removeSync(sys);
    assertEquals(readQwenSetup(project, { ...env, QWEN_CODE_SAFE_MODE: '1' }).hooksOff, 'QWEN_CODE_SAFE_MODE is on');
    assertEquals(readQwenSetup(project, { ...env, QWEN_CODE_SAFE_MODE: '0' }).hooksOff, '');
    // the file AIB writes: AIB's own folder, the same bytes on every write
    const file = settingsFileOf(join(dir, 'state'), 'chat1');
    assertEquals(file, join(dir, 'state', 'qwen', 'chat1', 'settings.json'));
    const text = () => Deno.readTextFileSync(writeSettingsFile(file, mergeSystemSettings(null, offFragment())));
    assertEquals(text(), text());
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("a chat's settings file stays when AIB lets go of it (a keeper-held chat restarts its agent on it); the sweep removes only old, unused ones", () => {
  const state = Deno.makeTempDirSync({ prefix: 'aib-qwensweep-' });
  try {
    const ids = ['a'.repeat(32), 'b'.repeat(32), 'c'.repeat(32), 'd'.repeat(32)];
    for (const id of ids) writeSettingsFile(settingsFileOf(state, id), mergeSystemSettings(null, offFragment()));
    const old = new Date(Date.now() - 2 * 3600 * 1000);
    for (const id of [ids[0], ids[1], ids[2]]) Deno.utimeSync(join(state, 'qwen', id), old, old);
    Deno.mkdirSync(join(state, 'qwen', 'not-a-chat'), { recursive: true });
    Deno.utimeSync(join(state, 'qwen', 'not-a-chat'), old, old);
    // ids[1] is open or running in the keeper, ids[3] is young, 'not-a-chat' is no chat's folder
    assertEquals(sweepSettings(state, new Set([ids[1]])), 2);
    const left = [...Deno.readDirSync(join(state, 'qwen'))].map((e) => e.name).sort();
    assertEquals(left, [ids[1], ids[3], 'not-a-chat'].sort());
    assertEquals(sweepSettings(join(state, 'nothing-here'), new Set()), 0);
  } finally {
    Deno.removeSync(state, { recursive: true });
  }
});

Deno.test('insideWorktree: absolute paths inside it only', () => {
  const wt = WIN ? 'C:\\s\\worktrees\\ab\\sub-1-1' : '/s/worktrees/ab/sub-1-1';
  const sep = WIN ? '\\' : '/';
  assert(insideWorktree(`${wt}${sep}a.txt`, wt));
  assert(insideWorktree(`${wt}${sep}src${sep}a.txt`, wt));
  assert(insideWorktree(`${wt.replaceAll('\\', '/')}/a.txt`, wt), 'forward slashes');
  assert(!insideWorktree('a.txt', wt), 'relative');
  assert(!insideWorktree(wt, wt), 'the folder itself is no file in it');
  assert(!insideWorktree(`${wt}-2${sep}a.txt`, wt), 'a sibling that starts with the same name');
  assert(!insideWorktree(`${wt}${sep}..${sep}a.txt`, wt));
  assert(!insideWorktree(`${wt}${sep}.${sep}a.txt`, wt));
  assert(!insideWorktree(WIN ? 'C:\\proj\\a.txt' : '/proj/a.txt', wt));
  assert(!insideWorktree('', wt));
});

Deno.test('Qwen routes: agent prepares and sets working_dir; start binds its own call; edits and shell stay in the worktree', async () => {
  const dir = Deno.makeTempDirSync({ prefix: 'aib-qwenroutes-' });
  const state = join(dir, 'state'), root = join(state, 'worktrees');
  Deno.mkdirSync(state, { recursive: true });
  const project = repo(join(dir, 'proj'));
  const chat: SubagentChat = {
    id: 'qw1',
    provider: 'qwen',
    lasting: 'qwen:s1',
    folder: project,
    project,
    hooks: { readOnly: new Set(['Explore']), userWorktreeHook: false },
  };
  const svc = new SubagentWorktrees(state, root, (id) => (id === 'qw1' ? chat : null));
  const call = async (event: string, body: Json) => {
    const a = await qwenHook(svc, event, chat, body);
    return { status: a.status, body: (a.body ? JSON.parse(a.body) : {}) as Json & { hookSpecificOutput: Json & { updatedInput: Json } } };
  };
  const denied = (a: { body: Json }) => (a.body.hookSpecificOutput as Json | undefined)?.permissionDecision === 'deny';
  try {
    // a subagent nobody prepared (Explore, or a forged id): reads only
    let a = await call('qwen-pre-tool', { tool_name: 'run_shell_command', agent_id: 'Explore-t0', tool_input: { command: 'echo hi' } });
    assert(denied(a));
    assertEquals(a.body.hookSpecificOutput.permissionDecisionReason, QWEN_TEXTS.noWorktree);
    for (const tool of ['write_file', 'edit', 'notebook_edit', 'mcp__studio_artifact__doc_read', 'skill', 'monitor']) {
      assert(denied(await call('qwen-pre-tool', { tool_name: tool, agent_id: 'Explore-t0', tool_input: {} })), tool);
    }
    for (const tool of ['read_file', 'glob', 'grep_search', 'list_directory', 'web_fetch', 'tool_search', 'report_findings']) {
      assertEquals((await call('qwen-pre-tool', { tool_name: tool, agent_id: 'Explore-t0', tool_input: {} })).body, {}, tool);
    }
    assertEquals(
      (await call('qwen-subagent-start', { agent_id: 'Explore-t0', agent_type: 'Explore' })).body,
      {},
      'no worktree for Explore',
    );

    // forks and nested subagents are refused
    a = await call('qwen-pre-tool', { tool_name: 'agent', tool_call_id: 'c0', tool_input: { subagent_type: 'fork', prompt: 'x' } });
    assertEquals(a.body.hookSpecificOutput.permissionDecisionReason, QWEN_TEXTS.fork);
    a = await call('qwen-pre-tool', {
      tool_name: 'agent',
      agent_id: 'general-purpose-c1',
      tool_call_id: 'n1',
      tool_input: { prompt: 'x' },
    });
    assertEquals(a.body.hookSpecificOutput.permissionDecisionReason, QWEN_TEXTS.nested);
    assertEquals(Object.keys(readSubagents(state)).length, 0, 'nothing was prepared for them');

    // two parallel agent calls: each gets its own worktree as working_dir
    const input = (d: string) => ({ description: d, prompt: `do ${d}`, subagent_type: 'general-purpose', run_in_background: true });
    const a1 = await call('qwen-pre-tool', { tool_name: 'agent', tool_call_id: 'call_one', tool_input: input('one') });
    const a2 = await call('qwen-pre-tool', { tool_name: 'agent', tool_call_id: 'call_two', tool_input: input('two') });
    const out1 = a1.body.hookSpecificOutput, out2 = a2.body.hookSpecificOutput;
    assertEquals([out1.permissionDecision, out2.permissionDecision], ['allow', 'allow']);
    assertEquals({ ...out1.updatedInput, working_dir: '' }, { ...input('one'), working_dir: '' }, 'the call itself is kept');
    const recs = Object.values(readSubagents(state));
    const rec1 = recs.find((r) => r.toolUseId === 'call_one')!, rec2 = recs.find((r) => r.toolUseId === 'call_two')!;
    assertEquals(out1.updatedInput.working_dir, rec1.path.replaceAll('\\', '/'));
    assertEquals(out2.updatedInput.working_dir, rec2.path.replaceAll('\\', '/'));
    assert(rec1.path !== rec2.path && rec1.path.startsWith(root));
    assertEquals([rec1.state, rec1.description], ['prepared', 'one']);
    // `git worktree list` shows them as linked worktrees of the project (Qwen needs that for working_dir)
    assert(
      git(project, 'worktree', 'list', '--porcelain').toLowerCase().replaceAll('\\', '/').includes(
        rec1.path.toLowerCase().replaceAll('\\', '/'),
      ),
    );

    // the SECOND call's subagent starts first: it gets ITS worktree, not the oldest
    a = await call('qwen-subagent-start', { agent_id: 'general-purpose-call_two', agent_type: 'general-purpose' });
    assert(String(a.body.hookSpecificOutput.additionalContext).includes(rec2.path));
    assertEquals(readSubagents(state)[rec2.id].state, 'running');
    assertEquals(readSubagents(state)[rec2.id].agentId, 'general-purpose-call_two');
    assertEquals(readSubagents(state)[rec1.id].state, 'prepared');
    // a prefix of another id binds nothing
    assertEquals((await call('qwen-subagent-start', { agent_id: 'general-purpose-call', agent_type: 'general-purpose' })).body, {});
    a = await call('qwen-subagent-start', { agent_id: 'general-purpose-call_one', agent_type: 'general-purpose' });
    assert(String(a.body.hookSpecificOutput.additionalContext).includes(rec1.path));

    const id = 'general-purpose-call_one';
    const sep = WIN ? '\\' : '/';
    // writes: only absolute paths inside the worktree
    for (const tool of ['write_file', 'edit']) {
      assertEquals(
        (await call('qwen-pre-tool', { tool_name: tool, agent_id: id, tool_input: { file_path: `${rec1.path}${sep}x.txt` } })).body,
        {},
        tool,
      );
      a = await call('qwen-pre-tool', { tool_name: tool, agent_id: id, tool_input: { file_path: `${project}${sep}x.txt` } });
      assert(denied(a) && String(a.body.hookSpecificOutput.permissionDecisionReason).includes(rec1.path), tool);
      assert(
        denied(await call('qwen-pre-tool', { tool_name: tool, agent_id: id, tool_input: { file_path: 'x.txt' } })),
        `${tool} relative`,
      );
      assert(
        denied(await call('qwen-pre-tool', { tool_name: tool, agent_id: id, tool_input: { file_path: `${rec2.path}${sep}x.txt` } })),
        `${tool} another subagent's worktree`,
      );
    }
    assertEquals(
      (await call('qwen-pre-tool', {
        tool_name: 'notebook_edit',
        agent_id: id,
        tool_input: { notebook_path: `${rec1.path}${sep}n.ipynb` },
      })).body,
      {},
    );
    assert(
      denied(
        await call('qwen-pre-tool', { tool_name: 'notebook_edit', agent_id: id, tool_input: { notebook_path: `${project}${sep}n.ipynb` } }),
      ),
    );
    // the shell: it starts in the worktree; the main folder is refused, and so is a `directory` outside it
    assertEquals(
      (await call('qwen-pre-tool', { tool_name: 'run_shell_command', agent_id: id, tool_input: { command: 'echo hi > a.txt' } })).body,
      {},
    );
    assert(
      denied(
        await call('qwen-pre-tool', {
          tool_name: 'run_shell_command',
          agent_id: id,
          tool_input: { command: `echo hi > "${join(project, 'a.txt')}"` },
        }),
      ),
    );
    assert(
      denied(
        await call('qwen-pre-tool', { tool_name: 'run_shell_command', agent_id: id, tool_input: { command: 'ls', directory: project } }),
      ),
    );
    assertEquals(
      (await call('qwen-pre-tool', { tool_name: 'run_shell_command', agent_id: id, tool_input: { command: 'ls', directory: rec1.path } }))
        .body,
      {},
    );
    // MCP tools: AIB's own only
    assert(denied(await call('qwen-pre-tool', { tool_name: 'mcp__filesystem__write_file', agent_id: id, tool_input: {} })));
    assertEquals((await call('qwen-pre-tool', { tool_name: 'mcp__studio_artifact__doc_read', agent_id: id, tool_input: {} })).body, {});
    assert(denied(await call('qwen-pre-tool', { tool_name: 'mcp__studio_artifact__merge_into_project', agent_id: id, tool_input: {} })));
    // any other tool passes; the main agent's own call of a tool other than agent passes
    assertEquals((await call('qwen-pre-tool', { tool_name: 'read_file', agent_id: id, tool_input: {} })).body, {});
    assertEquals(
      (await call('qwen-pre-tool', { tool_name: 'write_file', tool_input: { file_path: `${project}${sep}main.txt` } })).body,
      {},
    );

    // stop: done (it lands); an unknown id changes nothing
    await call('qwen-subagent-stop', { agent_id: 'ghost', agent_type: 'general-purpose' });
    await call('qwen-subagent-stop', { agent_id: id, agent_type: 'general-purpose' });
    assertEquals(readSubagents(state)[rec1.id].state, 'done');
    assertEquals(readSubagents(state)[rec2.id].state, 'running');
    assertEquals(git(project, 'status', '--porcelain'), '', 'nothing in the main folder');
    assertEquals((await qwenHook(svc, 'qwen-bogus', chat, {})).status, 404);
  } finally {
    await tidy(svc, 'qw1', dir, state, project);
  }
});

Deno.test('Qwen routes: an agent call with no id is refused; the cap is the chat cap', async () => {
  const dir = Deno.makeTempDirSync({ prefix: 'aib-qwencap-' });
  const state = join(dir, 'state'), root = join(state, 'worktrees');
  Deno.mkdirSync(state, { recursive: true });
  const project = repo(join(dir, 'proj'));
  const chat: SubagentChat = {
    id: 'qw2',
    provider: 'qwen',
    lasting: '',
    folder: project,
    project,
    hooks: { readOnly: new Set(['Explore']), userWorktreeHook: false },
  };
  const svc = new SubagentWorktrees(state, root, (id) => (id === 'qw2' ? chat : null));
  try {
    const a = await qwenHook(svc, 'qwen-pre-tool', chat, { tool_name: 'agent', tool_input: { prompt: 'x' } });
    assert(JSON.parse(a.body).hookSpecificOutput.permissionDecision === 'deny');
    const b = await qwenHook(svc, 'qwen-pre-tool', chat, { tool_name: 'Agent', tool_call_id: 'k1', tool_input: { prompt: 'x' } });
    assertEquals(JSON.parse(b.body).hookSpecificOutput.permissionDecision, 'allow', 'the tool is named agent; Agent reads the same');
  } finally {
    await tidy(svc, 'qw2', dir, state, project);
  }
});
