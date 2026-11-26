/**
 * The subagent fences and the project's aib-shared/ (app/server/subagents/shared_fence.ts; owner rule 2026-11-25: design and research
 * builders write their reports there). Per provider (Codex, Qwen, Antigravity; Gemini's redirect; Claude has no AIB write fence: its
 * subagents are fenced by Claude Code itself):
 *   a write or shell command into aib-shared/ through the worktree's link, or by the main folder's path, passes;
 *   a write to the main folder outside aib-shared/, `..` out of aib-shared/ and a second link inside it that leads out are refused.
 * The WSL form (the distro's helper runs the same fences) is in wsl_subagent_hooks_test.ts.
 */
import { assert, assertEquals } from './_assert.ts';
import { codexHook, namesFolder, patchInside } from '../../app/server/subagents/codex.ts';
import { qwenHook } from '../../app/server/subagents/qwen.ts';
import { agyHook, forgetChat, worktreesRootOf } from '../../app/server/subagents/antigravity.ts';
import { relativeInside } from '../../app/server/subagents/gemini.ts';
import { inSharedFolder, maskShared, sharedFolderOf } from '../../app/server/subagents/shared_fence.ts';
import { readSubagents, type SubagentChat, SubagentWorktrees } from '../../app/server/subagents/service.ts';
import { join } from '../../app/server/platform/path.ts';

const WIN = Deno.build.os === 'windows';
const sep = WIN ? '\\' : '/';
type Json = Record<string, unknown>;
const fwd = (p: string) => p.replaceAll('\\', '/');

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

const link = (target: string, path: string) => Deno.symlinkSync(target, path, WIN ? { type: 'junction' } : undefined);

class Lab {
  readonly dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-sharedfence-' }));
  readonly state = join(this.dir, 'state');
  readonly project = join(this.dir, 'proj');
  readonly shared = join(this.project, 'aib-shared');
  readonly gd = join(this.dir, 'gd');
  readonly svc: SubagentWorktrees;
  chat: SubagentChat;
  constructor(provider: string) {
    Deno.mkdirSync(this.state, { recursive: true });
    Deno.mkdirSync(join(this.project, 'app'), { recursive: true });
    Deno.mkdirSync(this.gd, { recursive: true });
    git(this.project, 'init', '-q', '-b', 'main');
    Deno.writeTextFileSync(join(this.project, 'tracked.txt'), 'one\n');
    Deno.writeTextFileSync(join(this.project, 'app', 'x.txt'), 'x\n');
    git(this.project, 'add', '-A');
    git(this.project, 'commit', '-q', '-m', 'first');
    Deno.mkdirSync(this.shared, { recursive: true });
    // a second link inside aib-shared/ that leads out of it
    link(join(this.project, 'app'), join(this.shared, 'out'));
    this.chat = {
      id: 'sf1',
      provider,
      lasting: `${provider}:s1`,
      folder: this.project,
      project: this.project,
      ...(provider === 'antigravity' ? { agyDir: this.gd } : {}),
      hooks: { readOnly: new Set(), userWorktreeHook: false },
    };
    this.svc = new SubagentWorktrees(this.state, join(this.state, 'worktrees'), (id) => (id === 'sf1' ? this.chat : null));
  }
  /** The worktree's own aib-shared link, as AIB makes it (shared_link.ts). */
  linkInto(worktree: string): void {
    const at = join(worktree, 'aib-shared');
    let st: Deno.FileInfo | null = null;
    try {
      st = Deno.lstatSync(at);
    } catch { /* none */ }
    if (st && !st.isSymlink) { // this repo has no local-only line, so AIB copied the folder: put the link in its place, as shared_link.ts does
      try {
        Deno.removeSync(join(at, 'out')); // a copied link of the fixture: the link only
      } catch { /* none */ }
      Deno.removeSync(at, { recursive: true });
    }
    if (!st?.isSymlink) link(this.shared, at);
    assertEquals(Deno.realPathSync(join(worktree, 'aib-shared')), Deno.realPathSync(this.shared), 'the link leads to the main folder');
  }
  async [Symbol.asyncDispose](): Promise<void> {
    forgetChat('sf1');
    await this.svc.chatClosed('sf1');
    for (const r of Object.values(readSubagents(this.state))) {
      try {
        Deno.removeSync(join(r.path, 'aib-shared')); // the link only
      } catch { /* none */ }
      try {
        git(this.project, 'worktree', 'unlock', r.path);
      } catch { /* not locked */ }
    }
    try {
      Deno.removeSync(join(this.shared, 'out'));
    } catch { /* gone */ }
    for (let i = 0; i < 10; i++) {
      try {
        Deno.removeSync(this.dir, { recursive: true });
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
  }
}

Deno.test('inSharedFolder: inside aib-shared/ only; dot parts and links that lead out are refused', async () => {
  await using lab = new Lab('codex');
  const s = sharedFolderOf(lab.project);
  assertEquals(s, lab.shared);
  assert(inSharedFolder(join(s, 'r.md'), s));
  assert(inSharedFolder(join(s, 'new', 'deep', 'r.md'), s), 'folders that do not exist yet');
  assert(inSharedFolder(fwd(join(s, 'r.md')), s), 'forward slashes');
  if (WIN) assert(inSharedFolder(join(s, 'R.MD').toUpperCase(), s), 'any case on Windows');
  assert(!inSharedFolder(s, s), 'the folder itself is not a file');
  assert(inSharedFolder(s, s, true));
  assert(!inSharedFolder(join(lab.project, 'tracked.txt'), s), 'the main folder');
  assert(!inSharedFolder(`${s}${sep}..${sep}tracked.txt`, s), '..');
  assert(!inSharedFolder(`${s}${sep}..${sep}app${sep}x.txt`, s), '.. into app');
  assert(!inSharedFolder(`${s}${sep}.${sep}r.md`, s), 'a dot part');
  assert(!inSharedFolder(`${s}-old${sep}r.md`, s), 'a sibling that starts the same');
  assert(!inSharedFolder(join(s, 'out', 'x.txt'), s), 'a second link leading out');
  assert(!inSharedFolder(join(s, 'out', 'new.txt'), s), 'a second link leading out, new file');
  assert(!inSharedFolder('r.md', s), 'relative');
  assert(!inSharedFolder(join(s, 'r.md'), ''), 'no folder');
});

Deno.test('namesFolder with the shared folder: aib-shared/ by its main path passes; the rest of the main folder does not', async () => {
  await using lab = new Lab('codex');
  const main = lab.project, s = lab.shared, wt = join(lab.dir, 'wt');
  const names = (command: string) => namesFolder(command, [main], wt, [s]);
  assert(!names(`echo x > ${s}${sep}r.md`));
  assert(!names(`echo x > "${fwd(s)}/r.md"`));
  assert(!names(`cat ${fwd(s)}/a.md > ${fwd(s)}/b.md`), 'two paths');
  assert(names(`echo x > ${main}${sep}a.txt`));
  assert(names(`echo x > ${fwd(main)}/a.txt`));
  assert(names(`echo x > ${s}${sep}..${sep}a.txt`), '..');
  assert(names(`echo x > ${fwd(s)}/../app/x.txt`), '.. into app');
  assert(names(`echo x > ${fwd(s)}/out/x.txt`), 'a second link leading out');
  assert(names(`echo x > ${fwd(s)}-old/x.txt`), 'a sibling that starts the same');
  assert(names(`echo x > ${fwd(s)}/r.md; echo y > ${fwd(main)}/a.txt`), 'one allowed path does not excuse another');
  assert(names(`echo x > ${fwd(s)}/$HOME/../r.md`), 'a variable in the path');
  assert(namesFolder(`echo x > ${s}${sep}r.md`, [main], wt), 'without the shared folder given it is refused as before');
  if (WIN) {
    const drive = /^([A-Za-z]):\\(.*)$/.exec(s)!;
    assert(!names(`echo x > /${drive[1].toLowerCase()}/${fwd(drive[2])}/r.md`), 'Git Bash form');
    assert(names(`echo x > /${drive[1].toLowerCase()}/${fwd(drive[2])}/../a.txt`), 'Git Bash form, ..');
  }
  assertEquals(maskShared('abc', [s]), 'abc');
});

Deno.test('Codex fence: aib-shared/ through the link and by the main path passes; the rest of the main folder, .. and a second link do not', async () => {
  await using lab = new Lab('codex');
  const call = async (body: Json) => {
    const a = await codexHook(lab.svc, body.event as string, lab.chat, body);
    return JSON.parse(a.body || '{}') as { hookSpecificOutput?: Json };
  };
  const pre = (extra: Json) => call({ event: 'codex-pre-tool', agent_id: 'cx1', ...extra });
  await call({ event: 'codex-pre-tool', tool_name: 'spawn_agent', tool_use_id: 'call_1', tool_input: { message: 'write the report' } });
  await call({ event: 'codex-subagent-start', agent_id: 'cx1', agent_type: 'default' });
  const rec = Object.values(readSubagents(lab.state))[0];
  lab.linkInto(rec.path);
  const denied = (a: { hookSpecificOutput?: Json }) => a.hookSpecificOutput?.permissionDecision === 'deny';
  const patch = (path: string) => `*** Begin Patch\n*** Add File: ${path}\n+hi\n*** End Patch`;
  const apply = (path: string) => pre({ tool_name: 'apply_patch', tool_input: { command: patch(path) } });
  const bash = (command: string) => pre({ tool_name: 'Bash', tool_input: { command } });
  // apply_patch
  assert(!denied(await apply(join(rec.path, 'aib-shared', 'r.md'))), 'through the worktree link');
  assert(!denied(await apply(join(lab.shared, 'r.md'))), 'by the main folder path');
  assert(denied(await apply(join(lab.project, 'tracked.txt'))), 'the main folder outside aib-shared');
  assert(denied(await apply(`${lab.shared}${sep}..${sep}tracked.txt`)), '..');
  assert(denied(await apply(`${rec.path}${sep}aib-shared${sep}..${sep}..${sep}x.txt`)), '.. through the link');
  assert(denied(await apply(join(lab.shared, 'out', 'x.txt'))), 'a second link');
  // shell
  const through = await bash(`echo hi > ${fwd(rec.path)}/aib-shared/r.md`);
  assert(!denied(through), 'through the worktree link');
  assert(String((through.hookSpecificOutput!.updatedInput as Json).command).includes('cd '), 'it still runs in the worktree');
  assert(!denied(await bash(`echo hi > ${fwd(lab.shared)}/r.md`)), 'by the main folder path');
  assert(denied(await bash(`echo hi > ${fwd(lab.project)}/tracked.txt`)), 'the main folder outside aib-shared');
  assert(denied(await bash(`echo hi > ${fwd(lab.shared)}/../tracked.txt`)), '..');
  assert(denied(await bash(`echo hi > ${fwd(lab.shared)}/out/x.txt`)), 'a second link');
  assert(patchInside(patch(join(lab.shared, 'r.md')), rec.path, lab.shared));
  assert(!patchInside(patch(join(lab.shared, 'r.md')), rec.path), 'not without the folder given');
});

Deno.test('Qwen fence: aib-shared/ through the link and by the main path passes; the rest of the main folder, .. and a second link do not', async () => {
  await using lab = new Lab('qwen');
  const call = async (event: string, body: Json) => {
    const a = await qwenHook(lab.svc, event, lab.chat, body);
    return JSON.parse(a.body || '{}') as { hookSpecificOutput?: Json };
  };
  await call('qwen-pre-tool', {
    tool_name: 'agent',
    tool_call_id: 'call_one',
    tool_input: { description: 'one', prompt: 'p', subagent_type: 'general-purpose' },
  });
  await call('qwen-subagent-start', { agent_id: 'general-purpose-call_one', agent_type: 'general-purpose' });
  const rec = Object.values(readSubagents(lab.state))[0];
  lab.linkInto(rec.path);
  const id = 'general-purpose-call_one';
  const denied = (a: { hookSpecificOutput?: Json }) => a.hookSpecificOutput?.permissionDecision === 'deny';
  const write = (tool: string, file_path: string) => call('qwen-pre-tool', { tool_name: tool, agent_id: id, tool_input: { file_path } });
  const shell = (command: string, directory?: string) =>
    call('qwen-pre-tool', { tool_name: 'run_shell_command', agent_id: id, tool_input: { command, ...(directory ? { directory } : {}) } });
  for (const tool of ['write_file', 'edit']) {
    assert(!denied(await write(tool, join(rec.path, 'aib-shared', 'r.md'))), `${tool} through the link`);
    assert(!denied(await write(tool, join(lab.shared, 'r.md'))), `${tool} by the main path`);
    assert(denied(await write(tool, join(lab.project, 'tracked.txt'))), `${tool} main folder`);
    assert(denied(await write(tool, `${lab.shared}${sep}..${sep}tracked.txt`)), `${tool} ..`);
    assert(denied(await write(tool, join(lab.shared, 'out', 'x.txt'))), `${tool} second link`);
  }
  assert(!denied(await shell(`echo hi > ${fwd(rec.path)}/aib-shared/r.md`)), 'shell through the link');
  assert(!denied(await shell(`echo hi > ${fwd(lab.shared)}/r.md`)), 'shell by the main path');
  assert(!denied(await shell('ls', lab.shared)), 'directory = aib-shared');
  assert(denied(await shell('ls', lab.project)), 'directory = the main folder');
  assert(denied(await shell('ls', `${lab.shared}${sep}..`)), 'directory = ..');
  assert(denied(await shell(`echo hi > ${fwd(lab.project)}/tracked.txt`)), 'shell main folder');
  assert(denied(await shell(`echo hi > ${fwd(lab.shared)}/../tracked.txt`)), 'shell ..');
  assert(denied(await shell(`echo hi > ${fwd(lab.shared)}/out/x.txt`)), 'shell second link');
});

Deno.test('Antigravity fence: aib-shared/ through the link and by the main path passes; the rest of the main folder, .. and a second link do not', async () => {
  await using lab = new Lab('antigravity');
  const parent = '0f1e2d3c-aaaa-bbbb-cccc-111122223333', sub = 'aaaaaaaa-1111-2222-3333-444444444444';
  const call = async (event: string, body: Json) => {
    const a = await agyHook(lab.svc, event, lab.chat, body);
    return a.body ? JSON.parse(a.body) as Json : {};
  };
  await call('agy-pre-tool', {
    conversationId: parent,
    cwd: lab.project,
    toolCall: {
      id: 't0',
      name: 'invoke_subagent',
      args: { TypeName: 'builder', Role: 'Builder Agent', Prompt: 'write', Workspace: 'inherit' },
    },
  });
  const leaf = 'subagent-Builder-Agent-builder-57eaaf6f';
  const wtp = join(worktreesRootOf(lab.gd), parent, leaf);
  Deno.mkdirSync(join(worktreesRootOf(lab.gd), parent), { recursive: true });
  git(lab.project, 'worktree', 'add', '-q', '-b', leaf, wtp);
  await call('agy-session-start', { conversationId: sub, cwd: wtp });
  lab.linkInto(wtp);
  const tool = (name: string, args: Json) => call('agy-pre-tool', { conversationId: sub, cwd: wtp, toolCall: { id: 't1', name, args } });
  const ok = (a: Json) => a.decision === 'allow', no = (a: Json) => a.decision === 'deny';
  for (const name of ['write_file', 'edit_file']) {
    assert(ok(await tool(name, { Path: join(wtp, 'aib-shared', 'r.md') })), `${name} through the link`);
    assert(ok(await tool(name, { Path: join(lab.shared, 'r.md') })), `${name} by the main path`);
    assert(no(await tool(name, { Path: join(lab.project, 'tracked.txt') })), `${name} main folder`);
    assert(no(await tool(name, { Path: `${lab.shared}${sep}..${sep}tracked.txt` })), `${name} ..`);
    assert(no(await tool(name, { Path: join(lab.shared, 'out', 'x.txt') })), `${name} second link`);
  }
  assert(ok(await tool('run_command', { CommandLine: `echo hi > "${join(wtp, 'aib-shared', 'r.md')}"` })), 'shell through the link');
  assert(ok(await tool('run_command', { CommandLine: `echo hi > "${join(lab.shared, 'r.md')}"` })), 'shell by the main path');
  assert(no(await tool('run_command', { CommandLine: `echo hi > "${join(lab.project, 'tracked.txt')}"` })), 'shell main folder');
  assert(no(await tool('run_command', { CommandLine: `echo hi > "${join(lab.shared, '..', 'tracked.txt')}"` })), 'shell ..');
  assert(no(await tool('run_command', { CommandLine: `echo hi > "${join(lab.shared, 'out', 'x.txt')}"` })), 'shell second link');
});

Deno.test("Gemini fence: a main-folder aib-shared path is redirected into the worktree's link (inside the allowed folder); .. is refused", () => {
  const folder = WIN ? 'C:\\p' : '/p', wt = WIN ? 'C:\\s\\wt' : '/s/wt';
  assertEquals(relativeInside(join(folder, 'aib-shared', 'r.md'), folder, wt), ['aib-shared', 'r.md']);
  assertEquals(relativeInside(join(wt, 'aib-shared', 'r.md'), folder, wt), ['aib-shared', 'r.md']);
  assertEquals(relativeInside(`${folder}${sep}aib-shared${sep}..${sep}..${sep}x`, folder, wt), null);
  assertEquals(relativeInside(WIN ? 'C:\\other\\x' : '/other/x', folder, wt), null);
});
