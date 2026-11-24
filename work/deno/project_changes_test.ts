/**
 * Which worktrees the project's Changes lists (worktrees/project_changes.ts worktreeTargets), and the numbers of a folded section
 * (changes.ts getCounts). Pure: records and helpers are plain objects, no repository except for getCounts.
 */
import { assertEquals } from './_assert.ts';
import { worktreeTargets } from '../../app/server/worktrees/project_changes.ts';
import { getCounts } from '../../app/server/worktrees/changes.ts';
import type { Helper } from '../../app/server/swarm/registry.ts';
import type { SubagentRecord } from '../../app/server/subagents/service.ts';

type Json = Record<string, unknown>;
const P = Deno.build.os === 'windows' ? 'C:\\work\\app' : '/work/app';

const rec = (id: string, state: string, over: Json = {}): SubagentRecord =>
  ({
    id, kind: 'subagent', chat: 'c1', lasting: 'claude:one', project: P, folder: P, slug: id, branch: 'studio/' + id, path: `${P}-wt-${id}`, snapshot: 'S-' + id,
    tree: '', state, toolUseId: '', agentId: '', agentType: 'general-purpose', description: 'job ' + id, createdAt: Number(id.replace(/\D/g, '')) || 0, ...over,
  }) as unknown as SubagentRecord;
const entry = (id: string, state: string, over: Json = {}): Helper => ({ id, kind: 'subagent', state, merge: null, landing: null, sub: { record: id }, ...over }) as unknown as Helper;
const helper = (id: string, state: string, over: Json = {}): Helper =>
  ({
    id, title: 'helper ' + id, project: P, parent: { live: 'c1', lasting: 'claude:one' }, chat: { live: 'h', lasting: '', provider: 'codex' },
    worktree: { path: `${P}-wt-${id}`, branch: 'studio/helper-' + id, base: 'main', start: 'S-' + id }, state, createdAt: Number(id.replace(/\D/g, '')) || 0, ...over,
  }) as unknown as Helper;
const list = (subs: SubagentRecord[], helpers: Helper[] = [], folders = [P]) =>
  worktreeTargets(folders, Object.fromEntries(subs.map((r) => [r.id, r])), helpers, () => true).map((t) => [t.id, t.state, t.why, t.working]);

Deno.test('worktreeTargets: a running or finished-and-waiting subagent is active; spares, preparing and prepared ones are hidden', () => {
  assertEquals(
    list([rec('s1', 'running'), rec('s2', 'user-hook'), rec('s3', 'done'), rec('s4', 'spare'), rec('s5', 'preparing'), rec('s6', 'prepared')]),
    [['s1', 'active', '', true], ['s2', 'active', '', true], ['s3', 'active', '', false]],
  );
});

Deno.test('worktreeTargets: landed work is gone; stopped and refused work is left over', () => {
  const subs = [rec('s1', 'done'), rec('s2', 'stopped'), rec('s3', 'done'), rec('s4', 'done'), rec('s5', 'running')];
  const helpers = [
    entry('s1', 'merged'), // landed: gone
    entry('s3', 'failed'), // a landing that was refused
    entry('s4', 'merged', { sub: { record: 's4', kept: ['.test-logs/x.log'] } }), // landed; test logs stayed in its worktree: still gone
  ];
  assertEquals(list(subs, helpers), [['s2', 'left', 'stopped', false], ['s3', 'left', 'refused', false], ['s5', 'active', '', true]]);
});

Deno.test('worktreeTargets: only this project\'s worktrees; a missing worktree folder is not listed; oldest first', () => {
  const other = rec('s2', 'running', { project: P + '-other', folder: P + '-other' });
  assertEquals(list([rec('s3', 'running'), rec('s1', 'running'), other]).map((r) => r[0]), ['s1', 's3']);
  assertEquals(list([rec('s1', 'running')], [], [P + '/']).map((r) => r[0]), ['s1'], 'a trailing slash is the same folder');
  const gone = worktreeTargets([P], { s1: rec('s1', 'running') }, [], () => false);
  assertEquals(gone, []);
});

Deno.test('worktreeTargets: helpers of the project: working ones are active, a merged one is gone, a stopped or failed one is left over', () => {
  assertEquals(
    list([], [helper('h1', 'working'), helper('h2', 'waiting'), helper('h3', 'done'), helper('h4', 'merged'), helper('h5', 'stopped'), helper('h6', 'failed'), helper('h7', 'working', { project: '/elsewhere' })]),
    [['h1', 'active', '', true], ['h2', 'active', '', true], ['h3', 'active', '', false], ['h5', 'left', 'stopped', false], ['h6', 'left', 'refused', false]],
  );
  const t = worktreeTargets([P], {}, [helper('h1', 'working')], () => true)[0];
  assertEquals([t.kind, t.name, t.provider, t.base, t.parent], ['helper', 'helper h1', 'codex', 'S-h1', { live: 'c1', lasting: 'claude:one' }]);
});

function git(cwd: string, ...args: string[]) {
  const o = new Deno.Command('git', { args: ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], cwd, stdout: 'null', stderr: 'piped' }).outputSync();
  if (!o.success) throw new Error(`git ${args.join(' ')}: ${new TextDecoder().decode(o.stderr)}`);
}

Deno.test('getCounts: the numbers of a folded section without a file list; new files are counted too', async () => {
  const dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-counts-' }));
  try {
    git(dir, 'init', '-q', '-b', 'main');
    Deno.writeTextFileSync(`${dir}/a.txt`, '1\n2\n3\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'base');
    assertEquals(await getCounts(dir), { git: true, files: 0, added: 0, removed: 0 });
    Deno.writeTextFileSync(`${dir}/a.txt`, '1\n2\nthree\nfour\n'); // +2 -1
    Deno.writeTextFileSync(`${dir}/new.txt`, 'x\ny\n'); // new: +2
    assertEquals(await getCounts(dir), { git: true, files: 2, added: 4, removed: 1 });
    // against a snapshot commit: what came after it only
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'S');
    const s = new TextDecoder().decode(new Deno.Command('git', { args: ['rev-parse', 'HEAD'], cwd: dir, stdout: 'piped' }).outputSync().stdout).trim();
    Deno.writeTextFileSync(`${dir}/later.txt`, 'l\n');
    assertEquals(await getCounts(dir, s), { git: true, files: 1, added: 1, removed: 0 });
    assertEquals(await getCounts(dir, 'not-a-commit'), { git: true, files: 1, added: 1, removed: 0 }, 'an unknown base falls back to HEAD');
    assertEquals(await getCounts(Deno.makeTempDirSync({ prefix: 'aib-nogit-' })), { git: false });
  } finally {
    try {
      Deno.removeSync(dir, { recursive: true });
    } catch { /* a temp folder */ }
  }
});
