/**
 * Subagent worktrees, Antigravity CLI (server/subagents/antigravity.ts), without an agent. The real agy end to end is
 * work/deno/e2e_subagent_antigravity_test.ts; the keeper's side is keeper/hookforward_agy_test.go.
 *   the hook commands: the program first and bare, forward slashes (cmd /c strips the quotes of a command that starts with one);
 *        null for a path they can't hold; AIB's hooks.json entry is added to the user's and removed again, theirs kept
 *   the routes: invoke_subagent is answered with overwrite Workspace "branch" (agy makes the worktree), define_subagent loses
 *        EnableSubagentTools, run_workflow and swarm add are denied, the cap holds; a subagent's first call or SessionStart adopts the
 *        worktree agy made (only exactly that shape, of this repository); its writes only inside it; its shell only there; MCP tools
 *        only AIB's; nesting refused; Stop makes it done (an error stops it); a woken subagent runs again
 *   the record: removal after landing takes agy's worktree and branch (and only theirs)
 */
import { assert, assertEquals } from './_assert.ts';
import { fake, until } from './_connection.ts';
import { withEnv } from './_agents.ts';
import { Sandbox } from './_worktree_fixtures.ts';
import { Connection } from '../../app/server/acp/connection.ts';
import { Aib } from '../../app/server/host/aib.ts';
import { KeeperLink } from '../../app/server/keeper/link.ts';
import { keeperBinary } from '../../app/server/keeper/client.ts';
import { hookForwarderKnowsAgy, hookForwarderOf } from '../../app/server/keeper/client.ts';
import { codexHookCommand } from '../../app/server/subagents/codex.ts';
import { hookCommand } from '../../app/server/subagents/gemini.ts';
import { hookCommand as qwenCommand } from '../../app/server/subagents/gemini.ts';
import { qwenHookCommand } from '../../app/server/subagents/qwen.ts';
import {
  AGY_HOOK_EVENTS,
  AGY_HOOK_NAME,
  AGY_TEXTS,
  agyHook,
  agyHookCommand,
  agyHooksEntry,
  ANTIGRAVITY_ISOLATED_PROMPT,
  ANTIGRAVITY_SUBAGENT_PROMPT,
  forgetChat,
  geminiDirOf,
  hooksFileOf,
  insideFolder,
  mergeHooksJson,
  worktreesRootOf,
  writeHooksFile,
} from '../../app/server/subagents/antigravity.ts';
import { agyGroupOf, MAX_PER_CHAT, ownSubagentPath, readSubagents, type SubagentChat, SubagentWorktrees } from '../../app/server/subagents/service.ts';
import { join } from '../../app/server/platform/path.ts';

const WIN = Deno.build.os === 'windows';
const sep = WIN ? '\\' : '/';
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

Deno.test('Antigravity hook commands: bare program first, forward slashes, bare address file; null when unsafe; unix quoted', () => {
  assertEquals(
    agyHookCommand('C:\\Users\\x\\AIB\\keeper-bin\\ab\\AIB-keeper.exe', 'C:\\Users\\x\\AIB\\artifact-mcp.json', 'agy-pre-tool', 'windows'),
    'C:/Users/x/AIB/keeper-bin/ab/AIB-keeper.exe hook agy-pre-tool C:/Users/x/AIB/artifact-mcp.json',
  );
  for (const [program, file] of [['C:\\Users\\John Smith\\k.exe', 'C:\\a.json'], ['C:\\a&b\\k.exe', 'C:\\a.json'], ['C:\\k.exe', 'C:\\%TEMP%\\a.json'], ['C:\\k.exe', 'C:\\a"b.json'], ['C:\\k.exe', 'relative.json']]) {
    assertEquals(agyHookCommand(program, file, 'agy-stop', 'windows'), null, `${program} ${file}`);
  }
  assertEquals(agyHookCommand('/home/u/k', '/home/u/a.json', 'agy-stop', 'linux'), "'/home/u/k' hook agy-stop '/home/u/a.json'");
  assertEquals(
    agyHookCommand('/usr/bin/k', '/run/h.sock', 'agy-pre-tool', 'linux', true),
    "'/usr/bin/k' hook agy-pre-tool --helper-socket '/run/h.sock'",
  );
  assertEquals(agyHookCommand("/home/o'k/k", '/a.json', 'agy-pre-tool', 'linux'), null);
  assertEquals(AGY_HOOK_EVENTS, ['agy-pre-tool', 'agy-session-start', 'agy-stop']);
  // the entry: PreToolUse grouped by matcher, SessionStart and Stop flat (agy's hooks.json format)
  const entry = agyHooksEntry('C:\\k\\AIB-keeper.exe', 'C:\\s\\a.json', 'windows')!;
  assertEquals(Object.keys(entry), ['PreToolUse', 'SessionStart', 'Stop']);
  const pre = (entry.PreToolUse as { matcher: string; hooks: { type: string; command: string; timeout: number }[] }[])[0];
  assertEquals(pre.matcher, '*');
  assertEquals(pre.hooks[0].command, 'C:/k/AIB-keeper.exe hook agy-pre-tool C:/s/a.json');
  assertEquals((entry.Stop as Json[])[0].command, 'C:/k/AIB-keeper.exe hook agy-stop C:/s/a.json');
  assert(!JSON.stringify(entry).includes('AIB_HOOK_KEY'), 'no key in the file');
  assertEquals(agyHooksEntry('C:\\with space\\k.exe', 'C:\\a.json', 'windows'), null);
});

Deno.test('every Windows hook writer whose command cmd runs (Antigravity too) never starts with a double quote, whatever the path', () => {
  const programs = ['C:\\k\\AIB-keeper.exe', 'C:\\Users\\x\\AppData\\Local\\AIB\\keeper-bin\\ab12\\AIB-keeper.exe', 'C:\\Program Files\\AIB\\k.exe', '"C:\\k\\AIB-keeper.exe"'];
  const files = ['C:\\s\\artifact-mcp.json', 'C:\\Users\\x y\\state\\a.json', '"C:\\s\\a.json"'];
  let checked = 0;
  for (const program of programs) {
    for (const file of files) {
      for (const event of AGY_HOOK_EVENTS) {
        const command = agyHookCommand(program, file, event, 'windows');
        if (command !== null) {
          assert(!command.startsWith('"') && !command.startsWith("'"), command);
          checked++;
        }
      }
      for (const command of [qwenHookCommand(program, file, 'qwen-pre-tool', 'windows'), codexHookCommand(program, file, 'codex-pre-tool', 'windows')]) {
        if (command !== null) assert(!command.startsWith('"'), command);
      }
    }
  }
  assert(checked >= 3, `wrote ${checked}`);
  for (const program of programs) assert(!qwenCommand(program, 'C:\\s\\a.json').startsWith('"'));
  assert(hookCommand !== undefined);
});

Deno.test('geminiDirOf reads the launch command; worktreesRootOf is where agy puts subagent worktrees', () => {
  assertEquals(geminiDirOf(['agy', 'acp', '--disable-telemetry', '--gemini-dir', 'C:\\x\\gemini-home']), 'C:\\x\\gemini-home');
  assertEquals(geminiDirOf(['agy', 'acp']), '');
  assertEquals(geminiDirOf(['agy', 'acp', '--gemini-dir']), '');
  assertEquals(worktreesRootOf('/a/g'), '/a/g/antigravity-cli/worktrees', "a distro's folder keeps its slashes");
  assertEquals(worktreesRootOf('/a/g/'), '/a/g/antigravity-cli/worktrees');
  assertEquals(worktreesRootOf('C:\\x\\g'), WIN ? 'C:\\x\\g\\antigravity-cli\\worktrees' : join('C:\\x\\g', 'antigravity-cli', 'worktrees'));
});

Deno.test("hooks.json: AIB's entry is added beside the user's and removed again; an unreadable file is never overwritten", () => {
  const dir = Deno.makeTempDirSync({ prefix: 'aib-agyhooks-' });
  try {
    const entry = agyHooksEntry('C:\\k\\AIB-keeper.exe', 'C:\\s\\a.json', 'windows')!;
    // none yet: created
    assertEquals(writeHooksFile(dir, entry), '');
    const read = () => JSON.parse(Deno.readTextFileSync(hooksFileOf(dir))) as Json;
    assertEquals(Object.keys(read()), [AGY_HOOK_NAME]);
    const bytes = Deno.readTextFileSync(hooksFileOf(dir));
    assertEquals(writeHooksFile(dir, entry), '');
    assertEquals(Deno.readTextFileSync(hooksFileOf(dir)), bytes, 'the same bytes again');
    // the user's own hook stays
    const theirs = { lint: { PostToolUse: [{ matcher: 'run_command', hooks: [{ command: './lint.sh' }] }] }, [AGY_HOOK_NAME]: { old: true } };
    Deno.writeTextFileSync(hooksFileOf(dir), JSON.stringify(theirs));
    assertEquals(writeHooksFile(dir, entry), '');
    assertEquals(Object.keys(read()).sort(), [AGY_HOOK_NAME, 'lint'].sort());
    assertEquals(read().lint, theirs.lint);
    assertEquals(read()[AGY_HOOK_NAME], JSON.parse(JSON.stringify(entry)));
    // removed: theirs kept
    assertEquals(writeHooksFile(dir, null), '');
    assertEquals(Object.keys(read()), ['lint']);
    // not valid: left as it is
    Deno.writeTextFileSync(hooksFileOf(dir), '{ nope');
    assert(writeHooksFile(dir, entry).includes('not valid JSON'));
    assertEquals(Deno.readTextFileSync(hooksFileOf(dir)), '{ nope');
    assertEquals(mergeHooksJson(null, null), {});
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test('the keeper program: only a forwarder that answers hook 5 knows the agy-* events (an older one: not isolated)', async () => {
  const fakes = Deno.makeTempDirSync({ prefix: 'aib-agykeeper-' });
  try {
    for (const [version, knows] of [[1, false], [3, false], [4, false], [5, true]] as const) {
      const program = join(fakes, WIN ? `fwd${version}.cmd` : `fwd${version}.sh`);
      Deno.writeTextFileSync(program, WIN ? `@echo off\r\necho hook ${version}\r\n` : `#!/bin/sh\necho hook ${version}\n`);
      if (!WIN) Deno.chmodSync(program, 0o755);
      assertEquals(await hookForwarderOf(program, fakes), program, `hook ${version} still gives the other agents their hooks`);
      assertEquals(hookForwarderKnowsAgy(program), knows, `hook ${version}`);
    }
  } finally {
    Deno.removeSync(fakes, { recursive: true });
  }
});

Deno.test('insideFolder: absolute, no dot parts, inside only', () => {
  const root = WIN ? 'C:\\g\\wt' : '/g/wt';
  assert(insideFolder(`${root}${sep}a.txt`, root));
  assert(insideFolder(`${root}${sep}x${sep}y${sep}a.txt`, root));
  assert(!insideFolder(root, root));
  assert(insideFolder(root, root, true));
  assert(!insideFolder(`${root}-other${sep}a.txt`, root));
  assert(!insideFolder(`${root}${sep}..${sep}a.txt`, root));
  assert(!insideFolder('a.txt', root));
  assert(!insideFolder('', root));
  if (WIN) assert(insideFolder('c:/G/WT/a.txt', root));
});

// ---- the routes ---------------------------------------------------------------------------------------------------------------

/** What agy does for Workspace "branch": a worktree and a branch of the same name under <gemini dir>/antigravity-cli/worktrees. */
function agyWorktree(project: string, gd: string, parent: string, role: string, type: string, hash: string): string {
  const leaf = `subagent-${role.replaceAll(' ', '-')}-${type}-${hash}`;
  const path = join(worktreesRootOf(gd), parent, leaf);
  Deno.mkdirSync(join(worktreesRootOf(gd), parent), { recursive: true });
  git(project, 'worktree', 'add', '-q', '-b', leaf, path);
  return path;
}

class Lab {
  readonly dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-agyroutes-' }));
  readonly state = join(this.dir, 'state');
  readonly gd = join(this.dir, 'gd');
  readonly project = repo(join(this.dir, 'proj'));
  readonly parent = '0f1e2d3c-aaaa-bbbb-cccc-111122223333';
  readonly chat: SubagentChat = {
    id: 'ag1',
    provider: 'antigravity',
    lasting: 'antigravity:' + this.parent,
    folder: this.project,
    project: this.project,
    agyDir: this.gd,
    hooks: { readOnly: new Set(), userWorktreeHook: false },
  };
  readonly svc: SubagentWorktrees;
  constructor() {
    Deno.mkdirSync(this.state, { recursive: true });
    Deno.mkdirSync(this.gd, { recursive: true });
    this.svc = new SubagentWorktrees(this.state, join(this.state, 'worktrees'), (id) => (id === 'ag1' ? this.chat : null));
  }
  async call(event: string, body: Json): Promise<{ status: number; body: Json }> {
    const a = await agyHook(this.svc, event, this.chat, body);
    return { status: a.status, body: a.body ? JSON.parse(a.body) as Json : {} };
  }
  tool(name: string, args: Json, cwd = this.project, conversationId = this.parent) {
    return this.call('agy-pre-tool', { conversationId, cwd, toolCall: { id: 't1', name, args } });
  }
  records() {
    return Object.values(readSubagents(this.state));
  }
  [Symbol.dispose]() {
    forgetChat('ag1');
    try {
      Deno.removeSync(this.dir, { recursive: true });
    } catch { /* a worktree lock: the OS temp cleanup gets it */ }
  }
}

const allowed = (a: { body: Json }) => JSON.stringify(a.body) === '{"decision":"allow"}';
const denied = (a: { body: Json }) => a.body.decision === 'deny';

Deno.test('Antigravity routes: the main agent starts a subagent: Workspace "branch" is forced; the spawn tools that cannot be isolated are denied', async () => {
  using lab = new Lab();
  const invoke = { TypeName: 'builder', Role: 'Builder Agent', Prompt: 'write the docs please', Workspace: 'inherit' };
  let a = await lab.tool('invoke_subagent', invoke);
  assertEquals(a.body, { decision: 'allow', overwrite: { Workspace: 'branch' } });
  // whatever it asked for
  for (const ws of ['share', 'branch', '/tmp/x', '']) {
    a = await lab.tool('invoke_subagent', { ...invoke, Workspace: ws });
    assertEquals(a.body, { decision: 'allow', overwrite: { Workspace: 'branch' } }, ws);
  }
  // define_subagent: nesting is switched off, nothing else changes
  a = await lab.tool('define_subagent', { Name: 'b', Description: 'd', SystemPrompt: 's', EnableSubagentTools: true });
  assertEquals(a.body, { decision: 'allow', overwrite: { EnableSubagentTools: false } });
  assert(allowed(await lab.tool('define_subagent', { Name: 'b', Description: 'd', SystemPrompt: 's', EnableWriteTools: true })));
  // workflow and swarm workers cannot get a worktree
  a = await lab.tool('run_workflow', { Script: 'print(1)' });
  assertEquals(a.body, { decision: 'deny', reason: AGY_TEXTS.workflow });
  a = await lab.tool('swarm', { action: 'add', name: 'w', brief: 'b', workspace: 'branch' });
  assertEquals(a.body, { decision: 'deny', reason: AGY_TEXTS.swarm });
  for (const action of ['status', 'models', 'title', 'kill', 'model']) assert(allowed(await lab.tool('swarm', { action })), action);
  assert(allowed(await lab.tool('manage_subagents', { Action: 'list' })));
  // the main agent's other tools pass (the forwarder normally answers these itself)
  for (const tool of ['write_file', 'run_command', 'read_file']) assert(allowed(await lab.tool(tool, { Path: join(lab.project, 'a.txt') })), tool);
  assertEquals(lab.records().length, 0, 'nothing is recorded before the worktree exists');
  // the cap counts the starts waiting for their worktree
  for (let i = 0; i < MAX_PER_CHAT; i++) await lab.tool('invoke_subagent', { ...invoke, Prompt: `p${i}` });
  a = await lab.tool('invoke_subagent', invoke);
  assert(denied(a) && String(a.body.reason).includes(`${MAX_PER_CHAT} subagents`), JSON.stringify(a.body));
});

Deno.test("Antigravity routes: a subagent's worktree is adopted at its first event, its calls are fenced, Stop ends it", async () => {
  using lab = new Lab();
  const sub = 'aaaaaaaa-1111-2222-3333-444444444444';
  await lab.tool('invoke_subagent', { TypeName: 'builder', Role: 'Builder Agent', Prompt: 'write the docs\nplease', Workspace: 'inherit' });
  const wtp = agyWorktree(lab.project, lab.gd, lab.parent, 'Builder Agent', 'builder', '57eaaf6f');
  const start = await lab.call('agy-session-start', { conversationId: sub, cwd: wtp });
  assertEquals(start.body, {});
  let recs = lab.records();
  assertEquals(recs.length, 1);
  const rec = recs[0];
  assertEquals([rec.state, rec.agentId, rec.agentType, rec.branch, rec.path], ['running', sub, 'builder', 'subagent-Builder-Agent-builder-57eaaf6f', wtp]);
  assertEquals(rec.description, 'Builder Agent: write the docs please');
  assertEquals(rec.agy, { root: worktreesRootOf(lab.gd) });
  assertEquals(rec.snapshot, git(lab.project, 'rev-parse', 'HEAD').trim(), 'the start is the commit agy branched from');
  assert(ownSubagentPath(join(lab.state, 'worktrees'), rec));

  const call = (name: string, args: Json) => lab.tool(name, args, wtp, sub);
  // writes: only absolute paths inside ITS worktree
  for (const tool of ['write_file', 'edit_file']) {
    assert(allowed(await call(tool, { Path: `${wtp}${sep}x.txt` })), tool);
    const a = await call(tool, { Path: join(lab.project, 'x.txt') });
    assert(denied(a) && String(a.body.reason).includes(wtp), tool);
    assert(denied(await call(tool, { Path: 'x.txt' })), `${tool} relative`);
    assert(denied(await call(tool, { Path: `${wtp}${sep}..${sep}x.txt` })), `${tool} dotdot`);
    assert(denied(await call(tool, {})), `${tool} no path`);
  }
  // the shell starts in the worktree; the main folder is refused
  assert(allowed(await call('run_command', { CommandLine: 'echo hi > a.txt', toolSummary: 's' })));
  assert(denied(await call('run_command', { CommandLine: `echo hi > "${join(lab.project, 'a.txt')}"` })));
  assert(allowed(await call('run_command', { CommandLine: `echo hi > "${join(wtp, 'a.txt')}"` })));
  // MCP: only AIB's own, never the merge tools; nesting and scheduling refused
  assert(allowed(await call('mcp_studio_artifact_doc_read', {})));
  assert(denied(await call('mcp_studio_artifact_merge_into_project', {})));
  assert(denied(await call('mcp_other_write', {})));
  for (const tool of ['invoke_subagent', 'define_subagent', 'run_workflow', 'swarm', 'manage_subagents']) {
    const a = await call(tool, {});
    assertEquals(a.body, { decision: 'deny', reason: AGY_TEXTS.nested }, tool);
  }
  assert(denied(await call('schedule', {})));
  assert(allowed(await call('read_file', { Path: join(lab.project, 'tracked.txt') })), 'reading the main folder is fine');
  assertEquals(lab.records().length, 1, 'still one record');

  // Stop: done
  assertEquals((await lab.call('agy-stop', { conversationId: sub, cwd: wtp, terminationReason: 'NO_TOOL_CALL' })).body, {});
  assertEquals(lab.records()[0].state, 'done');
  // a message wakes it: its next call runs it again, and it lands at its next end
  assert(allowed(await call('read_file', { Path: join(lab.project, 'tracked.txt') })));
  assertEquals(lab.records()[0].state, 'running');
  await lab.call('agy-stop', { conversationId: sub, cwd: wtp, terminationReason: 'ERROR' });
  recs = lab.records();
  assertEquals([recs[0].state, recs[0].stoppedWhy], ['stopped', 'it failed']);
  // a stopped one has no more edits
  assert(denied(await call('write_file', { Path: `${wtp}${sep}y.txt` })));
});

Deno.test('Antigravity routes: two parallel subagents are told apart by their role and type; a Stop alone adopts and ends one', async () => {
  using lab = new Lab();
  const a = 'aaaaaaaa-1111-2222-3333-444444444441', b = 'bbbbbbbb-1111-2222-3333-444444444442', c = 'cccccccc-1111-2222-3333-444444444443';
  await lab.tool('invoke_subagent', { TypeName: 'writer', Role: 'Doc Writer', Prompt: 'docs', Workspace: 'inherit' });
  await lab.tool('invoke_subagent', { TypeName: 'tester', Role: 'Test Runner', Prompt: 'tests', Workspace: 'inherit' });
  const w2 = agyWorktree(lab.project, lab.gd, lab.parent, 'Test Runner', 'tester', '22222222');
  const w1 = agyWorktree(lab.project, lab.gd, lab.parent, 'Doc Writer', 'writer', '11111111');
  // the second call's subagent starts first: it gets ITS description, not the oldest call's
  await lab.tool('read_file', { Path: join(lab.project, 'tracked.txt') }, w2, b);
  await lab.tool('read_file', { Path: join(lab.project, 'tracked.txt') }, w1, a);
  const byAgent = Object.fromEntries(lab.records().map((r) => [r.agentId, r]));
  assertEquals([byAgent[a].description, byAgent[a].agentType], ['Doc Writer: docs', 'writer']);
  assertEquals([byAgent[b].description, byAgent[b].agentType], ['Test Runner: tests', 'tester']);
  // a subagent that never made a call: its Stop adopts it (named from its folder) and ends it
  const w3 = agyWorktree(lab.project, lab.gd, lab.parent, 'Quiet One', 'q', '33333333');
  await lab.call('agy-stop', { conversationId: c, cwd: w3, terminationReason: 'NO_TOOL_CALL' });
  const quiet = lab.records().find((r) => r.agentId === c)!;
  assertEquals([quiet.state, quiet.description], ['done', 'Quiet-One-q-33333333']);
});

Deno.test('Antigravity routes: only exactly what agy makes is adopted; anything else is a subagent with no worktree (reads only)', async () => {
  using lab = new Lab();
  const sub = 'aaaaaaaa-1111-2222-3333-444444444444';
  const other = repo(join(lab.dir, 'other'));
  const elsewhere = join(lab.dir, 'elsewhere');
  const cases: [string, string][] = [];
  // 1. a folder outside the worktrees folder (a hook body naming any path)
  cases.push(['outside the worktrees folder', elsewhere]);
  git(lab.project, 'worktree', 'add', '-q', '-b', 'subagent-x-y-1', elsewhere);
  // 2. under the folder, but another repository's worktree
  const foreign = join(worktreesRootOf(lab.gd), lab.parent, 'subagent-Foreign-f-12345678');
  Deno.mkdirSync(join(worktreesRootOf(lab.gd), lab.parent), { recursive: true });
  git(other, 'worktree', 'add', '-q', '-b', 'subagent-Foreign-f-12345678', foreign);
  cases.push(['another repository', foreign]);
  // 3. a plain folder named like one (no git worktree)
  const plain = join(worktreesRootOf(lab.gd), lab.parent, 'subagent-Plain-p-87654321');
  Deno.mkdirSync(plain, { recursive: true });
  cases.push(['not a worktree', plain]);
  // 4. a subfolder of a real one
  const real = agyWorktree(lab.project, lab.gd, lab.parent, 'Real', 'r', 'abcdef01');
  Deno.mkdirSync(join(real, 'src'), { recursive: true });
  cases.push(['a subfolder', join(real, 'src')]);
  // 5. the project folder itself, and the worktrees root
  cases.push(['the project folder', lab.project]);
  cases.push(['the root', worktreesRootOf(lab.gd)]);
  for (const [why, cwd] of cases) {
    const body = { conversationId: sub, cwd };
    if (why === 'the project folder') continue; // a main-agent call by definition
    const r = await lab.call('agy-pre-tool', { ...body, toolCall: { id: 't', name: 'write_file', args: { Path: join(cwd, 'x.txt') } } });
    const inRoot = insideFolder(cwd, worktreesRootOf(lab.gd)); // a subagent's call is one whose cwd lies under agy's worktrees folder
    if (inRoot) assert(denied(r), `${why}: ${JSON.stringify(r.body)}`);
    else assert(allowed(r), `${why}: not a subagent call at all (the main agent's own folder rules apply)`);
    if (inRoot) {
      assert(String(r.body.reason) === AGY_TEXTS.noWorktree, `${why}: ${r.body.reason}`);
      const reads = await lab.call('agy-pre-tool', { ...body, toolCall: { id: 't', name: 'read_file', args: {} } });
      assert(allowed(reads), `${why}: reads pass`);
    }
  }
  assertEquals(lab.records().length, 0, 'nothing adopted');
  // a bad conversation id is not adopted either
  const bad = await lab.call('agy-pre-tool', { conversationId: 'x y', cwd: real, toolCall: { id: 't', name: 'write_file', args: { Path: join(real, 'a') } } });
  assert(denied(bad));
  assertEquals(lab.records().length, 0);
  // a real one binds
  assert(allowed(await lab.call('agy-pre-tool', { conversationId: sub, cwd: real, toolCall: { id: 't', name: 'write_file', args: { Path: join(real, 'a') } } })));
  assertEquals(lab.records().length, 1);
  // the same worktree for another conversation: refused (it belongs to a record)
  const twin = await lab.call('agy-pre-tool', { conversationId: 'bbbbbbbb-1111', cwd: real, toolCall: { id: 't', name: 'write_file', args: { Path: join(real, 'a') } } });
  assert(denied(twin));
});

Deno.test("Antigravity release: a landed subagent's worktree and branch go, nothing else; the project's own branches stay", async () => {
  using lab = new Lab();
  const sub = 'aaaaaaaa-1111-2222-3333-444444444444';
  await lab.tool('invoke_subagent', { TypeName: 'builder', Role: 'Builder Agent', Prompt: 'x', Workspace: 'inherit' });
  const wtp = agyWorktree(lab.project, lab.gd, lab.parent, 'Builder Agent', 'builder', '57eaaf6f');
  await lab.tool('read_file', {}, wtp, sub);
  git(lab.project, 'branch', 'keep-me');
  // running: never removed from under it
  const id = lab.records()[0].id;
  assertEquals(await lab.svc.release(id), 'running');
  await lab.call('agy-stop', { conversationId: sub, cwd: wtp, terminationReason: 'NO_TOOL_CALL' });
  assertEquals(await lab.svc.release(id), 'removed');
  assertEquals(lab.records().length, 0);
  assert(!(() => {
    try {
      Deno.statSync(wtp);
      return true;
    } catch {
      return false;
    }
  })(), 'the worktree is gone');
  const branches = git(lab.project, 'branch', '--format=%(refname:short)').split(/\r?\n/).filter(Boolean).sort();
  assertEquals(branches, ['keep-me', 'main']);
  assert(!git(lab.project, 'worktree', 'list').includes('subagent-'), git(lab.project, 'worktree', 'list'));
  // the path guard: a record that claims another folder is never removed
  assert(!ownSubagentPath(join(lab.state, 'worktrees'), { path: lab.project, agy: { root: worktreesRootOf(lab.gd) } }));
  assert(!ownSubagentPath(join(lab.state, 'worktrees'), { path: join(worktreesRootOf(lab.gd), 'x', 'sub-1'), agy: { root: worktreesRootOf(lab.gd) } }));
  assert(!ownSubagentPath(join(lab.state, 'worktrees'), { path: join(lab.dir, 'a', 'b', 'subagent-x-1'), agy: { root: worktreesRootOf(lab.gd) } }));
});

Deno.test("Antigravity with extra workspaces: the subagent's cwd is agy's copy of the first one; its git worktree is the sibling that is adopted", async () => {
  using lab = new Lab();
  const sub = 'aaaaaaaa-1111-2222-3333-444444444444';
  assertEquals(agyGroupOf('subagent-Builder-Agent-builder-cf266853-aef52951da43445a8cb741107b3184ea'), 'subagent-Builder-Agent-builder-cf266853');
  assertEquals(agyGroupOf('subagent-Builder-Agent-builder-cf266853'), 'subagent-Builder-Agent-builder-cf266853');
  await lab.tool('invoke_subagent', { TypeName: 'builder', Role: 'Builder Agent', Prompt: 'write', Workspace: 'inherit' });
  const parent = join(worktreesRootOf(lab.gd), lab.parent);
  Deno.mkdirSync(parent, { recursive: true });
  const scratch = join(parent, 'subagent-Builder-Agent-builder-cf266853-aef52951da43445a8cb741107b3184ea'); // a copy of the scratch workspace
  Deno.mkdirSync(scratch);
  const real = join(parent, 'subagent-Builder-Agent-builder-cf266853-proj');
  git(lab.project, 'worktree', 'add', '-q', '-b', 'subagent-Builder-Agent-builder-cf266853-proj', real);
  // another subagent's folder next to them is not part of the group
  const other = agyWorktree(lab.project, lab.gd, lab.parent, 'Other One', 'o', '99999999');
  // the subagent's calls come from the scratch copy
  assert(allowed(await lab.tool('write_file', { Path: `${real}${sep}a.txt` }, scratch, sub)), 'its git worktree is the one adopted');
  const rec = lab.records()[0];
  assertEquals([rec.path, rec.branch, rec.state], [real, 'subagent-Builder-Agent-builder-cf266853-proj', 'running']);
  assertEquals(rec.agy?.also, [scratch]);
  assert(allowed(await lab.tool('write_file', { Path: `${scratch}${sep}note.txt` }, scratch, sub)), "its scratch copy is its own too");
  assert(denied(await lab.tool('write_file', { Path: `${other}${sep}a.txt` }, scratch, sub)), "another subagent's worktree is not");
  assert(denied(await lab.tool('write_file', { Path: join(lab.project, 'a.txt') }, scratch, sub)));
  await lab.call('agy-stop', { conversationId: sub, cwd: scratch, terminationReason: 'NO_TOOL_CALL' });
  assertEquals(await lab.svc.release(rec.id), 'removed');
  const left = [...Deno.readDirSync(parent)].map((e) => e.name);
  assertEquals(left, [other.split(sep).pop()], 'both folders of the group are gone, the other subagent is not touched');
  assertEquals(git(lab.project, 'branch', '--format=%(refname:short)').split(/\r?\n/).filter((b) => b.startsWith('subagent-')), ['subagent-Other-One-o-99999999']);
});

Deno.test('Antigravity prompts: the isolated rule says what happens and what is not there; the asked-for rule says not to start editing subagents', () => {
  assert(ANTIGRAVITY_ISOLATED_PROMPT.includes('own git worktree') && ANTIGRAVITY_ISOLATED_PROMPT.includes('last commit'));
  assert(ANTIGRAVITY_ISOLATED_PROMPT.includes('run_workflow') && ANTIGRAVITY_ISOLATED_PROMPT.includes('swarm'));
  assert(ANTIGRAVITY_SUBAGENT_PROMPT.includes('Do not start subagents'));
});

// ---- the host: what a new Antigravity chat is given -------------------------------------------------------------------------

Deno.test('Antigravity host: a key chat in a git project gets hooks and its env; no git project, a Google sign-in and an unwritable hooks file do not (and say so)', async () => {
  await keeperBinary();
  const restore = withEnv({ AGENT_STUDIO_ALLOW_REAL_AGENT: '1' }); // the hooks are set up for a non-fixture command (the factory runs the fake agent)
  const box = new Sandbox();
  const plain = join(box.base, 'plain');
  Deno.mkdirSync(plain);
  const gd = join(box.base, 'gd');
  const aibs: Aib[] = [];
  const open = async (folder: string, command: string[]) => {
    for (const earlier of aibs.splice(0)) await earlier.close().catch(() => {}); // the fake agent's session is the same every time
    const seen: { env: Record<string, string> }[] = [];
    const keeper = new KeeperLink({ dataDir: box.state, orphan: null, extraArgs: ['--exit-after', '2s', '--orphan-after', '30s'] });
    const aib = new Aib({ claudeLauncher: import.meta.filename!, nodeCommand: 'node', stateDir: box.state, port: 0, ownersDir: null }, { keeper });
    aibs.push(aib);
    aib.ownerProbe = () => null;
    aib.agentLaunch = () => Promise.resolve([command, {}]);
    aib.connectionFactory = (_command, cwd, provider, options) => {
      seen.push({ env: { ...(options?.env ?? {}) } });
      return new Connection(fake('--rich'), cwd, provider, options);
    };
    const c = await aib.connect('antigravity', folder, null, {});
    await until(() => c.ready, 'the chat is ready', 30);
    return { c, env: seen[0].env, aib };
  };
  const notes = (c: Connection) => c.events.filter((e) => e.kind === 'studio_note').map((e) => String((e.data as Json).message));
  const hooksFile = hooksFileOf(gd);
  try {
    const key = ['agy', 'acp', '--disable-telemetry', '--gemini-dir', gd];
    // 1. a key chat in a git project: AIB's entry in the gemini folder's hooks.json, the chat's key and ids in the agent's environment
    let { c, env } = await open(box.project, key);
    assertEquals([c.subagentHooks!.off, c.subagentHooks!.adopted, c.subagentHooks!.agyDir], ['', true, gd]);
    assert(c.subagentIsolationOn());
    assertEquals(c.subagentHooks!.prompt, ANTIGRAVITY_ISOLATED_PROMPT);
    assertEquals([env.AIB_HOOK_CHAT, env.AIB_HOOK_SUBROOT], [c.id, worktreesRootOf(gd)]);
    assert(!('AIB_HOOK_PASS' in env) && env.AIB_HOOK_KEY.length > 16);
    const written = JSON.parse(Deno.readTextFileSync(hooksFile)) as Record<string, Record<string, unknown>>;
    assertEquals(Object.keys(written), [AGY_HOOK_NAME]);
    assert(JSON.stringify(written).includes(' hook agy-pre-tool '));
    assert(!JSON.stringify(written).includes(env.AIB_HOOK_KEY));
    assert(notes(c).some((n) => n.startsWith('Antigravity subagents that edit files work in their own git worktree')), notes(c).join('\n'));

    // 2. not a git project: nothing to give a worktree from; everything passes (as the other agents' subagents), AIB's entry is gone
    ({ c, env } = await open(plain, key));
    assertEquals([c.subagentHooks!.off, c.subagentHooks!.adopted], ['not a git project', undefined]);
    assert(!c.subagentIsolationOn());
    assertEquals(env.AIB_HOOK_PASS, '1');
    assert(!('AIB_HOOK_KEY' in env));
    assertEquals(Object.keys(JSON.parse(Deno.readTextFileSync(hooksFile))), [], "AIB's entry left the file");
    assert(notes(c).some((n) => n.includes("can't be held in their own worktree") && n.includes('not a git project')), notes(c).join('\n'));
    assertEquals(c.subagentRule.includes('Do not start subagents'), true);

    // 3. a Google sign-in (no --gemini-dir): nothing is written anywhere, the agent is asked, the chat says why and names the key route
    const before = Deno.readTextFileSync(hooksFile);
    ({ c, env } = await open(box.project, ['agy', 'acp', '--disable-telemetry']));
    assertEquals(c.subagentHooks!.off, 'Google sign-in');
    assert(!c.subagentIsolationOn() && !('AIB_HOOK_KEY' in env) && !('AIB_HOOK_PASS' in env));
    assertEquals(Deno.readTextFileSync(hooksFile), before, 'no file was touched');
    assert(!isDirSafe(join(box.project, '.agents')), 'nothing in the project');
    assert(notes(c).some((n) => n.includes('signed in with Google') && n.includes('API key')), notes(c).join('\n'));
    assertEquals(c.subagentRule, ANTIGRAVITY_SUBAGENT_PROMPT);

    // 4. a file of the user's own hooks in the gemini folder is kept; one that is not JSON is never overwritten
    Deno.writeTextFileSync(hooksFile, JSON.stringify({ lint: { PostToolUse: [] } }));
    ({ c } = await open(box.project, key));
    assertEquals(Object.keys(JSON.parse(Deno.readTextFileSync(hooksFile))).sort(), [AGY_HOOK_NAME, 'lint']);
    Deno.writeTextFileSync(hooksFile, '{ nope');
    ({ c, env } = await open(box.project, key));
    assertEquals(c.subagentHooks!.off, 'hooks could not be written');
    assertEquals(Deno.readTextFileSync(hooksFile), '{ nope');
    assertEquals(env.AIB_HOOK_PASS, '1');
  } finally {
    for (const a of aibs.reverse()) await a.close().catch(() => {});
    restore();
    box[Symbol.dispose]();
  }
});

const isDirSafe = (p: string) => {
  try {
    return Deno.statSync(p).isDirectory;
  } catch {
    return false;
  }
};
