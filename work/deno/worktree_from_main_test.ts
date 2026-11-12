/**
 * A new chat's worktree starts from the project's main branch (main, else master, else the folder's branch), whatever branch the
 * project folder has checked out. The folder's uncommitted edits come along only when it is on main; on another branch they stay out
 * and the start note says so; live sync waits until the folder is back on main. Chats made before keep their start branch and merge as
 * they did. Real git in temp repos and temp state folders only.
 */
import { assert, assertEquals } from './_assert.ts';
import { commit, FakeStudio, read, runGit, Sandbox, write } from './_worktree_fixtures.ts';
import { list, setup, text } from './_sync_fixtures.ts';
import * as wt from '../../outputs/agent-studio/server/worktrees/worktrees.ts';
import * as m from '../../outputs/agent-studio/server/worktrees/merge.ts';
import * as mr from '../../outputs/agent-studio/server/worktrees/merge_request.ts';
import { pathOf } from '../../outputs/agent-studio/server/state/paths.ts';

const KEY = 'b'.repeat(32);
const NOTE_SIDE = "Started from main. Your uncommitted edits in the project folder are on another branch (claude/side), so they're " +
  "not in this chat's copy.";

const rev = (folder: string, spec: string) => runGit(folder, 'rev-parse', spec).trim();
const names = (folder: string, a: string, b: string) => runGit(folder, 'diff', '--name-only', a, b).split('\n').filter(Boolean);

/** The project folder on claude/side, one commit ahead of main (side.txt). */
function onSide(box: Sandbox): void {
  runGit(box.project, 'config', 'core.autocrlf', 'false');
  runGit(box.project, 'switch', '-q', '-c', 'claude/side');
  commit(box.project, 'side.txt', 'side branch work\n', 'side branch commit');
}

async function make(box: Sandbox, project = box.project): Promise<{ manager: wt.Manager; plan: wt.Plan }> {
  const manager = new wt.Manager(box.state);
  const plan = (await manager.plan(project, KEY))!;
  assert(plan, 'a plan');
  await manager.create(plan);
  return { manager, plan };
}

Deno.test('folder on another branch: the chat starts at main, and its merge into main carries exactly its own commits', async () => {
  using box = new Sandbox();
  onSide(box);
  const mainBefore = rev(box.project, 'main');
  const { manager, plan } = await make(box);
  assertEquals([plan.base, plan.folderBranch, plan.note], ['main', 'claude/side', '']);
  const record = manager.registry.get(KEY)!;
  assertEquals([record.base, record.editsFrom, record.snapshot], ['main', 'main', mainBefore]);
  assertEquals(rev(plan.path, 'HEAD'), mainBefore, "the worktree is main's tip");
  assert(!wt.lexists(pathOf(plan.path, 'side.txt')), "the folder's branch is not in the chat");
  assertEquals(runGit(box.project, 'symbolic-ref', '--short', 'HEAD').trim(), 'claude/side', 'the folder stays where it was');

  const studio = new FakeStudio(box.state);
  studio.add('c1', plan.path);
  commit(plan.path, 'work.txt', 'chat work\n', 'agent work one');
  commit(plan.path, 'more.txt', 'more chat work\n', 'agent work two');
  const state = await m.status(studio, 'c1');
  assertEquals([state.base, state.label], ['main', 'Merge into main']);
  assertEquals(mr.mergeRequestText(String(state.base)).includes('into main'), true);
  const result = await m.mergeFromTool(studio, 'c1');
  assertEquals([result.state, result.target, result.started, result.commits], ['merged', 'main', 'main', 2]);
  assertEquals(names(box.project, mainBefore, 'main'), ['more.txt', 'work.txt'], "only the chat's own changes reach main");
  assertEquals(runGit(box.project, 'log', '--format=%s', `${mainBefore}..main`).trim().split('\n'), [
    'agent work two',
    'agent work one',
  ]);
  assertEquals(studio.notes(), ['Merged into main (2 commits)']);
});

Deno.test("folder on main with uncommitted edits: they are copied into the chat's copy, as before", async () => {
  using box = new Sandbox();
  write(box.project, 'tracked.txt', 'edited on main\n');
  write(box.project, 'new.txt', 'untracked\n');
  const before = box.status();
  const { manager, plan } = await make(box);
  assertEquals([plan.base, plan.folderBranch, plan.note], ['main', 'main', '']);
  assertEquals(read(plan.path, 'tracked.txt'), 'edited on main\n');
  assertEquals(read(plan.path, 'new.txt'), 'untracked\n');
  const record = manager.registry.get(KEY)!;
  assertEquals(rev(box.project, `${record.snapshot}^`), rev(box.project, 'main'), 'S is main plus the edits');
  assertEquals(box.status(), before, 'the folder is untouched');
});

Deno.test('folder on another branch with uncommitted edits: not copied, and the start note says so', async () => {
  using box = new Sandbox();
  onSide(box);
  write(box.project, 'tracked.txt', 'edited on the side branch\n');
  write(box.project, 'scratch.txt', 'untracked on side\n');
  const before = box.status();
  const { manager, plan } = await make(box);
  assertEquals(plan.note, NOTE_SIDE);
  assertEquals(read(plan.path, 'tracked.txt'), 'one\n', "main's version");
  assert(!wt.lexists(pathOf(plan.path, 'scratch.txt')));
  assertEquals(manager.registry.get(KEY)!.snapshot, rev(box.project, 'main'));
  assertEquals(box.status(), before, 'the edits stay in the folder');
  assertEquals((await wt.touchedPaths(plan.path, wt.diffBase(manager.registry.get(KEY)))).length, 0, 'Changes are empty');

  // only an untracked file counts too
  using other = new Sandbox();
  onSide(other);
  write(other.project, 'only-new.txt', 'x\n');
  assertEquals((await make(other)).plan.note, NOTE_SIDE);
});

Deno.test('a repo with only master starts from master; one with neither starts from its branch and says why', async () => {
  using box = new Sandbox(false);
  const repo = pathOf(box.base, 'm');
  Deno.mkdirSync(repo);
  runGit(repo, 'init', '-q', '-b', 'master');
  commit(repo, 'a.txt', 'a\n', 'first');
  runGit(repo, 'switch', '-q', '-c', 'feature');
  commit(repo, 'b.txt', 'b\n', 'feature work');
  const { plan } = await make(box, repo);
  assertEquals([plan.base, plan.folderBranch, plan.note], ['master', 'feature', '']);
  assertEquals(rev(plan.path, 'HEAD'), rev(repo, 'master'));
  assertEquals(await m.targetBranch(repo, 'feature'), 'master', 'the merge tool uses the same rule');

  using box2 = new Sandbox(false);
  const trunk = pathOf(box2.base, 't');
  Deno.mkdirSync(trunk);
  runGit(trunk, 'init', '-q', '-b', 'trunk');
  commit(trunk, 'a.txt', 'a\n', 'first');
  write(trunk, 'a.txt', 'edited\n');
  const made = await make(box2, trunk);
  assertEquals([made.plan.base, made.plan.note], ['trunk', 'Started from trunk: this project has no main or master branch.']);
  assertEquals(read(made.plan.path, 'a.txt'), 'edited\n', "on its own branch the folder's edits come along, as before");
});

Deno.test('an empty repo works in place, and the start note says why', async () => {
  using box = new Sandbox(false);
  const empty = pathOf(box.base, 'empty');
  Deno.mkdirSync(empty);
  runGit(empty, 'init', '-q', '-b', 'main');
  const planned = await new wt.Manager(box.state).planWithReason(empty);
  assertEquals([planned.plan, planned.reason], [null, 'the repository has no commits yet']);
  assert(wt.inPlaceNote(planned.reason).includes('the repository has no commits yet'));
  assertEquals(wt.inPlaceNote('not a git repository'), '', 'a plain folder gets no note');
});

Deno.test('a chat made before (started from another branch) still merges as it did', async () => {
  using box = new Sandbox();
  onSide(box);
  const manager = new wt.Manager(box.state);
  const p = (await manager.plan(box.project, KEY))!;
  await manager.create(new wt.Plan(p.project, p.folderBranch, p.key, p.slug, p.branch, p.path)); // the old start: the folder's branch
  const { editsFrom: _gone, ...old } = manager.registry.get(KEY)!; // records from before have no editsFrom
  await manager.registry.put(KEY, old);
  assertEquals(manager.registry.get(KEY)!.base, 'claude/side');
  assert(wt.lexists(pathOf(p.path, 'side.txt')));
  const studio = new FakeStudio(box.state);
  studio.add('c1', p.path);
  commit(p.path, 'work.txt', 'chat work\n', 'agent work');
  const mainBefore = rev(box.project, 'main');
  const result = await m.mergeFromTool(studio, 'c1');
  assertEquals([result.state, result.target, result.started], ['merged', 'main', 'claude/side']);
  assertEquals(names(box.project, mainBefore, 'main'), ['work.txt'], "only the chat's own work, as before");
  assertEquals(rev(box.project, 'claude/side'), rev(box.project, 'HEAD'), 'the start branch is untouched');
});

Deno.test('live sync: nothing from the folder while it is on another branch; caught up once it is back on main', async () => {
  using box = new Sandbox();
  const ctx = await setup(box, 1, false, (project) => {
    runGit(project, 'switch', '-q', '-c', 'claude/side');
    commit(project, 'side.txt', 'side\n', 'side branch commit');
  });
  assertEquals(ctx.record().editsFrom, 'main');
  write(box.project, 'n.txt', 'saved while on side\n');
  await ctx.settle();
  assertEquals(text(ctx.wts[0], 'n.txt'), null, 'not copied while the folder is on claude/side');
  assertEquals(await ctx.live.catchUp(ctx.keys[0]), 'blocked');
  assertEquals(list(ctx.record().syncedPaths), []);
  runGit(box.project, 'switch', '-q', 'main'); // n.txt is untracked: it comes along
  await ctx.settle();
  await ctx.scan();
  assertEquals(text(ctx.wts[0], 'n.txt'), 'saved while on side\n', 'caught up once the folder is on main');
  assert(!wt.lexists(pathOf(ctx.wts[0], 'side.txt')));
});
