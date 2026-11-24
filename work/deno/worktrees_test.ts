/**
 * server/worktrees/worktrees.ts: the cases of work/test_worktree_chat.py, test_worktree_discard.py, test_worktree_foreign.py and
 * test_worktree_userbase.py that exercise worktrees.py directly, parity with Python on the same repo states, registry interop both
 * ways and the cross-process locks. Real git in temp repos and temp state folders only.
 *
 * Skipped (they need a whole AIB, a live connection or the host-side live sync): the flag tests and connection.public() checks,
 * live_list sidebar roots, resume through Aib.connect, the worktree-archive live op and conversation_action
 * (agent kill order, read-only chats, routes and tokens), changes_response, the live connection projectRoot mapping, the real-adapter
 * HOME isolation and state_paths checks. Their worktrees.py parts (plan, create, remove, retry_pending, is_removed, has_changes,
 * ensure, find, ProjectResolver) are covered here directly.
 */
import { assert, assertEquals, assertRejects } from './_assert.ts';
import { createHash } from 'node:crypto';
import { Frozen } from './_frozen.ts';
import {
  commit,
  exists,
  FIXED_DATES,
  makeRepo,
  foreignHolds,
  foreignProbe,
  read,
  runGit,
  Sandbox,
  setFixedDates,
  tryGit,
  write,
} from './_worktree_fixtures.ts';
import * as wt from '../../app/server/worktrees/worktrees.ts';
import * as localOnly from '../../app/server/worktrees/local_only.ts';
import * as sharedLinkMod from '../../app/server/worktrees/shared_link.ts';
import { ignoredFiles } from '../../app/server/swarm/service.ts';
import { envFiles } from '../../app/server/worktrees/sync.ts';
import { pathOf } from '../../app/server/state/paths.ts';
import { dirname } from '../../app/server/platform/ospath.ts';

const WIN = Deno.build.os === 'windows';

async function made(box: Sandbox, key = 'a'.repeat(32)): Promise<{ manager: wt.Manager; plan: wt.Plan; path: string }> {
  const manager = new wt.Manager(box.state);
  const plan = (await manager.plan(box.project, key))!;
  assert(plan, 'a plan');
  await manager.create(plan);
  return { manager, plan, path: plan.path };
}

function onlyRecord(box: Sandbox): wt.WorktreeRecord & { key: string } {
  const all = new wt.Registry(box.state).all();
  const key = Object.keys(all)[0];
  return { ...all[key], key };
}

// ---- creating (test_worktree_chat.py) ------------------------------------------------------------------------------
Deno.test('a worktree is made under the state folder from S; uncommitted work reaches it and the main folder is untouched', async () => {
  using box = new Sandbox();
  const p = box.project;
  write(p, 'tracked.txt', 'one\nedited\n');
  write(p, 'new.txt', 'brand new\n');
  write(p, 'sub/deep.txt', 'deep\n');
  const blob = new Uint8Array(256 * 20).map((_, i) => i % 256);
  write(p, 'image.bin', blob);
  write(p, 'ignored.log', 'secret log\n');
  write(p, 'build/out.txt', 'built\n');
  write(p, '.env', 'KEY=1\n');
  write(p, 'sub/.env.local', 'KEY=2\n');
  write(p, 'node_modules/pkg/.env', 'NO\n');
  runGit(p, 'add', 'new.txt'); // one file staged, the rest not: the user's index must stay as it is
  const indexBefore = Deno.readFileSync(pathOf(p, '.git', 'index'));
  const statusBefore = box.status();
  const headBefore = runGit(p, 'rev-parse', 'HEAD');
  const { plan, path } = await made(box);
  assertEquals(dirname(path), pathOf(box.state, 'worktrees', wt.repoHash(p)));
  assertEquals(read(path, 'tracked.txt'), 'one\nedited\n');
  assertEquals(read(path, 'new.txt'), 'brand new\n');
  assertEquals(read(path, 'sub/deep.txt'), 'deep\n');
  assertEquals([...Deno.readFileSync(pathOf(path, 'image.bin'))], [...blob]);
  assert(!exists(pathOf(path, 'ignored.log')) && !exists(pathOf(path, 'build')) && !exists(pathOf(path, 'node_modules')));
  assertEquals(read(path, '.env'), 'KEY=1\n');
  assertEquals(read(path, 'sub/.env.local'), 'KEY=2\n');
  assertEquals(box.status(), statusBefore);
  assertEquals([...Deno.readFileSync(pathOf(p, '.git', 'index'))], [...indexBefore]);
  assertEquals(runGit(p, 'rev-parse', 'HEAD'), headBefore);
  assertEquals(box.branches(), [plan.branch]);
  const record = onlyRecord(box);
  assertEquals([record.path, record.branch, record.base, record.status, record.project], [path, plan.branch, 'main', 'ready', p]);
  assertEquals((record.snapshot as string).length, 40);
  assertEquals([record.user, record.userHead], [record.snapshot, headBefore.trim()]);
  assertEquals(runGit(p, 'rev-parse', 'main').trim(), runGit(path, 'rev-parse', 'HEAD~1').trim(), 'S sits on top of HEAD');
  assertEquals(runGit(p, 'rev-parse', `refs/studio/${plan.slug}/user`).trim(), record.user, 'U is pinned');
  assertEquals(wt.diffBase(record), record.snapshot);
  assert(!path.startsWith(p + (WIN ? '\\' : '/')), 'never inside the repo');
});

Deno.test('env copy never overwrites and skips symlinks', () => {
  using box = new Sandbox();
  write(box.project, '.env', 'FROM=project\n');
  const target = pathOf(box.base, 'wt');
  write(target, '.env', 'FROM=worktree\n');
  wt.copyEnvFiles(box.project, target);
  assertEquals(read(target, '.env'), 'FROM=worktree\n');
  write(box.base, 'outside.txt', 'x');
  try {
    Deno.symlinkSync(pathOf(box.base, 'outside.txt'), pathOf(box.project, '.env.link'));
  } catch {
    return; // no symlink right on this machine
  }
  wt.copyEnvFiles(box.project, target);
  assert(!exists(pathOf(target, '.env.link')));
});

Deno.test('the branch is unique', async () => {
  using box = new Sandbox();
  const manager = new wt.Manager(box.state);
  const plan = (await manager.plan(box.project, 'a'.repeat(32)))!;
  runGit(box.project, 'branch', plan.branch); // taken by someone else
  const again = (await manager.plan(box.project, 'a'.repeat(32)))!;
  assert(again.branch !== plan.branch && again.branch.startsWith('studio/'));
  assertEquals(again.slug, 'chat-aaaaaaaa-1');
});

Deno.test('projects that cannot get a worktree work in place, with the reason', async () => {
  using box = new Sandbox();
  const manager = new wt.Manager(box.state);
  const plain = pathOf(box.base, 'plain');
  Deno.mkdirSync(plain);
  assertEquals(await wt.whyInPlace(plain), 'not a git repository');
  assertEquals(await manager.plan(plain), null);
  Deno.mkdirSync(pathOf(box.project, 'sub'));
  assertEquals(await wt.whyInPlace(pathOf(box.project, 'sub')), 'the folder is not the root of its git repository');
  const bare = pathOf(box.base, 'bare.git');
  runGit(box.base, 'clone', '-q', '--bare', box.project, bare);
  assertEquals(await wt.whyInPlace(bare), 'bare repository');
  const empty = pathOf(box.base, 'empty');
  Deno.mkdirSync(empty);
  runGit(empty, 'init', '-q', '-b', 'main');
  assertEquals(await wt.whyInPlace(empty), 'the repository has no commits yet');
  write(box.project, '.gitmodules', '[submodule "x"]\n\tpath = x\n\turl = ../x\n');
  assertEquals(await wt.whyInPlace(box.project), 'the repository has submodules');
  Deno.removeSync(pathOf(box.project, '.gitmodules'));
  runGit(box.project, 'checkout', '-q', '--detach');
  assertEquals(await wt.whyInPlace(box.project), 'detached HEAD');
  runGit(box.project, 'checkout', '-q', 'main');
  runGit(box.project, 'checkout', '-q', '-b', 'other');
  commit(box.project, 'tracked.txt', 'other\n', 'other');
  runGit(box.project, 'checkout', '-q', 'main');
  commit(box.project, 'tracked.txt', 'main\n', 'main');
  assert(tryGit(box.project, 'merge', 'other')[0] !== 0);
  assertEquals(await wt.whyInPlace(box.project), 'a merge is in progress');
  assertEquals(await manager.plan(box.project), null);
  assert(!exists(pathOf(box.state, 'worktrees')), 'nothing was made');
});

function assertLeftNothing(box: Sandbox) {
  assertEquals(box.branches(), []);
  assertEquals(new wt.Registry(box.state).all(), {});
  const root = pathOf(box.state, 'worktrees');
  const leftovers = exists(root)
    ? [...Deno.readDirSync(root)].flatMap((d) => d.isDirectory ? [...Deno.readDirSync(pathOf(root, d.name))] : [])
    : [];
  assertEquals(leftovers.map((e) => e.name), []);
  assertEquals(runGit(box.project, 'for-each-ref', 'refs/studio/'), '');
}

Deno.test('the size caps fall back and leave nothing behind', async () => {
  using box = new Sandbox();
  for (let n = 0; n < 5; n++) write(box.project, `u${n}.txt`, 'x');
  const old = { ...wt.limits };
  try {
    wt.limits.MAX_UNTRACKED_FILES = 3;
    const manager = new wt.Manager(box.state);
    const error = await assertRejects(async () => await manager.create((await manager.plan(box.project))!), wt.Fallback);
    assertEquals(error.message, 'too much uncommitted work to copy (5 untracked files, 0 MB)');
    assertLeftNothing(box);
    wt.limits.MAX_UNTRACKED_FILES = old.MAX_UNTRACKED_FILES;
    write(box.project, 'big.bin', 'x'.repeat(4096));
    wt.limits.MAX_SNAPSHOT_BYTES = 1000;
    await assertRejects(async () => await manager.create((await manager.plan(box.project))!), wt.Fallback);
    assertLeftNothing(box);
  } finally {
    Object.assign(wt.limits, old);
  }
});

Deno.test('LFS pointer files fall back and the worktree is removed', async () => {
  using box = new Sandbox();
  const p = box.project;
  const pointer = 'version https://git-lfs.github.com/spec/v1\noid sha256:' +
    'a'.repeat(64) + '\nsize 5\n';
  write(p, '.gitattributes', '*.dat filter=lfs diff=lfs merge=lfs -text\n');
  write(p, 'data.dat', pointer);
  runGit(p, '-c', 'filter.lfs.clean=', 'add', '-A');
  runGit(p, 'commit', '-q', '-m', 'lfs');
  for (const [name, value] of [['filter.lfs.smudge', 'cat'], ['filter.lfs.process', ''], ['filter.lfs.required', 'false']]) {
    runGit(p, 'config', name, value);
  }
  const manager = new wt.Manager(box.state);
  const error = await assertRejects(async () => await manager.create((await manager.plan(p))!), wt.Fallback);
  assertEquals(error.message, 'the worktree would hold Git LFS pointer files');
  assertLeftNothing(box);
  const checkout = pathOf(box.base, 'pointer-checkout');
  runGit(p, 'worktree', 'add', '-q', '--detach', checkout);
  assert(await wt.hasLfsPointers(checkout));
  write(checkout, 'data.dat', 'real content');
  assert(!(await wt.hasLfsPointers(checkout)));
});

Deno.test('a restart in the middle of creating is cleaned up; finished and foreign worktrees are left alone', async () => {
  using box = new Sandbox();
  const manager = new wt.Manager(box.state);
  const finished = await made(box, 'f'.repeat(32));
  const foreign = pathOf(box.base, 'foreign');
  runGit(box.project, 'worktree', 'add', '-q', '-b', 'mine', foreign);
  const plan = (await manager.plan(box.project, 'b'.repeat(32)))!;
  const original = wt.hooks.copyEnvFiles;
  wt.hooks.copyEnvFiles = () => {
    throw new wt.Died();
  };
  try {
    await assertRejects(() => manager.create(plan), wt.Died);
  } finally {
    wt.hooks.copyEnvFiles = original;
  }
  assert(exists(plan.path));
  assertEquals(box.branches().sort(), [finished.plan.branch, plan.branch].sort());
  assertEquals(manager.registry.get(plan.key)!.status, 'creating');
  assertEquals(await new wt.Manager(box.state).cleanupIncomplete(), [plan.key]); // a new AIB on the same state folder
  assert(!exists(plan.path));
  assertEquals(box.branches(), [finished.plan.branch]);
  assertEquals(Object.keys(manager.registry.all()), [finished.plan.key]);
  assert(!runGit(box.project, 'worktree', 'list').replaceAll('/', WIN ? '\\' : '/').includes(plan.path));
  assert(exists(finished.path) && exists(foreign));
  assert(runGit(box.project, 'branch', '--list', 'mine').includes('mine'));
});

Deno.test('a creating record of another live process is left alone', async () => {
  using box = new Sandbox();
  const registry = new wt.Registry(box.state);
  await registry.put('k', {
    path: pathOf(box.state, 'worktrees', 'x', 'y'),
    project: box.project,
    branch: 'studio/y',
    status: 'creating',
    pid: 4242,
  });
  const original = wt.hooks.pidAlive;
  wt.hooks.pidAlive = (pid) => pid === 4242;
  try {
    assertEquals(await new wt.Manager(box.state).cleanupIncomplete(), []);
  } finally {
    wt.hooks.pidAlive = original;
  }
  assertEquals(Object.keys(registry.all()), ['k']);
});

// ---- resuming --------------------------------------------------------------------------------------------------------
Deno.test('ensure recreates a deleted folder from its branch; branch gone too refuses', async () => {
  using box = new Sandbox();
  const { manager, path, plan } = await made(box);
  await manager.setSession(plan.key, 'omp', 'fake-session');
  commit(path, 'work.txt', 'committed later\n', 'agent work');
  Deno.removeSync(path, { recursive: true });
  const record = manager.forChat('omp', 'fake-session', box.project)!; // found by session even from the project folder
  assertEquals([record.key, record.path], [plan.key, path]);
  assertEquals(await manager.ensure(record), path);
  assertEquals(read(path, 'work.txt'), 'committed later\n');
  assertEquals(manager.registry.find(path)!.key, plan.key);
  Deno.removeSync(path, { recursive: true });
  runGit(box.project, 'worktree', 'prune');
  runGit(box.project, 'branch', '-D', plan.branch);
  const error = await assertRejects(() => manager.ensure(record), wt.WorktreeGone);
  assertEquals(error.message, "This chat's workspace was removed; it can be read but not continued");
  assert(!exists(path));
});

if (WIN) {
  Deno.test('a file beyond 260 characters reaches the worktree (core.longpaths)', async () => {
    using box = new Sandbox();
    const nested = Array(6).fill('n'.repeat(30)).join('\\');
    try {
      write(box.project, nested + '\\file.txt', 'long');
    } catch {
      return; // this machine cannot make paths that long
    }
    const manager = new wt.Manager(box.state);
    const plan = (await manager.plan(box.project))!;
    assert(plan.path.length + nested.length + 'file.txt'.length > 260);
    await manager.create(plan);
    assertEquals(read(plan.path, nested + '\\file.txt'), 'long');
    await manager.discard(plan.key);
    assert(!exists(plan.path));
  });
}

// ---- removing (test_worktree_discard.py) ------------------------------------------------------------------------------
Deno.test('remove after the confirmation takes the worktree, branch, ref and entry; the chat counts as removed', async () => {
  using box = new Sandbox();
  const { manager, path, plan } = await made(box);
  await manager.setSession(plan.key, 'omp', 'fake-session');
  write(path, 'mine.txt', 'work\n');
  assert(await manager.hasChanges(onlyRecord(box)));
  assertEquals(await manager.remove(plan.key, true), 'removed');
  assert(!exists(path));
  assertEquals(box.branches(), []);
  assertEquals(manager.registry.all(), {});
  assertEquals(runGit(box.project, 'for-each-ref', 'refs/studio/'), '');
  assert(!runGit(box.project, 'worktree', 'list', '--porcelain').includes(path));
  assert(manager.isRemoved(path));
  assert(manager.isRemoved(box.project, 'omp:fake-session'), 'the saved chat is read-only wherever it is opened from');
  assert(!manager.isRemoved(box.project));
  const note = Object.values(manager.registry.removed())[0];
  assertEquals([note.project, note.branch, note.base, note.session], [box.project, plan.branch, 'main', 'omp:fake-session']);
  assertEquals(new wt.ProjectResolver(box.state).resolve(path), { project: box.project, branch: plan.branch, base: 'main' });
  assertEquals(await manager.remove(plan.key), 'gone');
});

function brokenRemoval(): () => void {
  wt.testing.git = (args, cwd, options) =>
    args[0] === 'worktree' && args[1] === 'remove'
      ? Promise.resolve({ returncode: 1, stdout: '', stderr: 'error: failed to delete: Permission denied', out: new Uint8Array() })
      : wt.realGit(args, cwd, options);
  wt.testing.rmtree = () => {};
  return () => {
    wt.testing.git = null;
    wt.testing.rmtree = null;
  };
}

Deno.test('a removal that cannot finish is pending, read-only, and a later start finishes it', async () => {
  using box = new Sandbox();
  const { manager, path, plan } = await made(box);
  await manager.setSession(plan.key, 'omp', 'fake-session');
  write(path, 'mine.txt', 'work\n');
  const restore = brokenRemoval();
  try {
    assertEquals(await manager.remove(plan.key, true), 'pending');
  } finally {
    restore();
  }
  const record = onlyRecord(box);
  assertEquals([record.status, record.confirmed], ['removal-pending', true]);
  assert(exists(path));
  assertEquals(box.branches().length, 1, 'the branch stays until the worktree is gone');
  assertEquals(manager.registry.find(path), null, 'nothing resumes a pending worktree');
  assert(manager.isRemoved(path) && manager.isRemoved(box.project, 'omp:fake-session'));
  assertEquals(await new wt.Manager(box.state).retryPending(), [plan.key]);
  assertEquals(manager.registry.all(), {});
  assert(!exists(path));
  assertEquals(box.branches(), []);
  assert(manager.isRemoved(path));
});

Deno.test('--force is used only after the confirmation, also on the startup retry', async () => {
  using box = new Sandbox();
  const calls: string[][] = [];
  wt.testing.git = (args, cwd, options) => {
    calls.push([...args]);
    return wt.realGit(args, cwd, options);
  };
  try {
    const clean = await made(box, 'c'.repeat(32));
    const dirty = await made(box, 'd'.repeat(32));
    write(dirty.path, 'mine.txt', 'work\n');
    assert(!(await clean.manager.hasChanges(clean.manager.registry.get(clean.plan.key)!)));
    assertEquals(await clean.manager.remove(clean.plan.key), 'removed');
    assertEquals(await dirty.manager.remove(dirty.plan.key), 'pending', 'git refuses to remove a dirty worktree without --force');
    assert(!calls.some((c) => c.includes('--force')), JSON.stringify(calls.filter((c) => c[0] === 'worktree')));
    await new wt.Manager(box.state).retryPending();
    assert(!calls.some((c) => c.includes('--force')), 'a pending removal without the confirmation never retries with force');
    assert(exists(dirty.path));
    assertEquals(await dirty.manager.remove(dirty.plan.key, true), 'removed');
    assertEquals(calls.filter((c) => c[0] === 'worktree' && c[1] === 'remove' && c.includes('--force')).length, 1);
  } finally {
    wt.testing.git = null;
  }
});

Deno.test('a pending removal of a clean worktree finishes without force at the next start', async () => {
  using box = new Sandbox();
  const { manager, path, plan } = await made(box);
  const restore = brokenRemoval();
  try {
    assertEquals(await manager.remove(plan.key, false), 'pending');
  } finally {
    restore();
  }
  assertEquals(await manager.retryPending(), [plan.key]);
  assert(!exists(path));
});

Deno.test('hasChanges: a commit counts, line-ending noise and a missing folder do not', async () => {
  using box = new Sandbox();
  const { manager, path, plan } = await made(box);
  assert(!(await manager.hasChanges(onlyRecord(box))));
  commit(path, 'x.txt', 'x\n');
  assert(await manager.hasChanges(onlyRecord(box)));
  assert(!(await manager.hasChanges({ ...onlyRecord(box), path: pathOf(box.base, 'nowhere') })));
  assert(await manager.hasChanges({ ...onlyRecord(box), snapshot: 'f'.repeat(40), user: '', diffBase: '' }), 'unknown base: kept');
  assertEquals(manager.registry.get(plan.key)!.status, 'ready');
});

Deno.test('nothing outside AIB worktrees folder is ever removed', async () => {
  using box = new Sandbox();
  const foreign = pathOf(box.base, 'foreign');
  runGit(box.project, 'worktree', 'add', '-q', '-b', 'mine', foreign);
  const registry = new wt.Registry(box.state);
  await registry.put('k', { path: foreign, project: box.project, branch: 'mine', status: 'ready' });
  const manager = new wt.Manager(box.state);
  assertEquals(await manager.remove('k', true), 'removed'); // nothing of AIB's to remove: the record goes
  assert(exists(foreign));
  assert(runGit(box.project, 'branch', '--list', 'mine').includes('mine'));
  await registry.put('k2', { path: foreign, project: box.project, branch: 'studio/x', status: 'creating', pid: 0 });
  await manager.cleanupIncomplete();
  assert(exists(foreign));
});

// ---- any app's worktree (test_worktree_foreign.py) ----------------------------------------------------------------------
function foreignRepo(box: Sandbox): string {
  const repo = pathOf(box.base, 'repo');
  Deno.mkdirSync(pathOf(repo, 'app'), { recursive: true });
  runGit(box.base, 'init', '-q', '-b', 'main', repo);
  write(repo, 'app/f.txt', 'x');
  runGit(repo, 'add', '-A');
  runGit(repo, 'commit', '-q', '-m', 'one');
  wt.WT_CACHE.clear();
  wt.known.projects = null;
  return repo;
}

const projectOf = (cwd: string) => wt.projectOfWorktree(cwd)?.project ?? null;
const lower = (p: string | null) => (WIN && p ? p.toLowerCase() : p);

Deno.test('worktrees of any app map to their repo; a known project folder wins; normal folders are unchanged', () => {
  using box = new Sandbox(false);
  const repo = foreignRepo(box);
  try {
    const inside = pathOf(repo, '.claude', 'worktrees', 'calm-one');
    runGit(repo, 'worktree', 'add', '-q', '-b', 'calm', inside);
    const found = wt.projectOfWorktree(inside)!;
    assertEquals([lower(found.project), found.branch, found.base], [lower(repo), 'calm', '']);
    const outside = pathOf(box.base, 'elsewhere');
    runGit(repo, 'worktree', 'add', '-q', '-b', 'feature/x', outside);
    assertEquals(lower(projectOf(outside)), lower(repo));
    assertEquals(lower(projectOf(pathOf(outside, 'app'))), lower(repo));
    assertEquals(wt.projectOfWorktree(outside)!.branch, 'feature/x');
    wt.WT_CACHE.clear();
    wt.known.projects = () => [pathOf(repo, 'app')];
    assertEquals(lower(projectOf(pathOf(outside, 'app'))), lower(pathOf(repo, 'app')));
    assertEquals(lower(projectOf(outside)), lower(repo));
    for (const folder of [repo, pathOf(repo, 'app'), box.base]) {
      assertEquals(projectOf(folder), null);
    }
  } finally {
    wt.known.projects = null;
    wt.WT_CACHE.clear();
  }
});

Deno.test('a deleted .claude worktree maps by its path; broken .git files are ignored; results are cached and read no git', () => {
  using box = new Sandbox(false);
  const repo = foreignRepo(box);
  const gone = pathOf(box.base, 'proj', '.claude', 'worktrees', 'pensive-ritchie-26be75');
  assertEquals(wt.projectOfWorktree(gone), { project: pathOf(box.base, 'proj'), branch: '', base: '' });
  assertEquals(projectOf(pathOf(gone, 'sub', 'deep')), pathOf(box.base, 'proj'));
  const texts = [
    'gitdir: ' + pathOf(box.base, 'nowhere', '.git', 'worktrees', 'x'),
    'gitdir: ' + box.base,
    'gitdir: ' + pathOf(repo, '.git'),
    'garbage',
  ];
  texts.forEach((text, index) => {
    write(box.base, `broken${index}/.git`, text);
    assertEquals(projectOf(pathOf(box.base, `broken${index}`)), null, text);
  });
  const outside = pathOf(box.base, 'elsewhere');
  runGit(repo, 'worktree', 'add', '-q', '-b', 'side', outside);
  const first = wt.projectOfWorktree(outside);
  const original = wt.readers.read;
  wt.readers.read = () => {
    throw new Error('a cached cwd is not read again');
  };
  try {
    assertEquals(wt.projectOfWorktree(outside), first);
  } finally {
    wt.readers.read = original;
  }
  assert(wt.WT_CACHE.has(outside));
  wt.WT_CACHE.clear();
});

// ---- the user base U (test_worktree_userbase.py) -------------------------------------------------------------------------
const LINES = 'a\nb\nc\nd\ne\nf\n';

Deno.test('advanceUserBase builds U from the previous U without touching the project; U survives gc; remove drops the ref', async () => {
  using box = new Sandbox();
  commit(box.project, 'f.txt', LINES, 'add f');
  const { manager, plan } = await made(box);
  const before = onlyRecord(box);
  write(box.project, 'f.txt', 'A-user\nb\nc\nd\ne\nf\n');
  write(box.project, 'new.txt', 'brand new\n');
  Deno.removeSync(pathOf(box.project, 'tracked.txt'));
  const statusBefore = box.status();
  const indexBefore = runGit(box.project, 'ls-files', '-s');
  const next = await wt.advanceUserBase(before, ['f.txt', 'new.txt', 'tracked.txt', '../evil', '.git/config'], manager.registry);
  assert(next !== before.user);
  assertEquals(runGit(box.project, 'rev-parse', `${next}^`).trim(), before.user, 'parent is the previous U');
  assertEquals(runGit(box.project, 'show', `${next}:f.txt`), 'A-user\nb\nc\nd\ne\nf\n');
  assertEquals(runGit(box.project, 'show', `${next}:new.txt`), 'brand new\n');
  assert(!runGit(box.project, 'ls-tree', '-r', '--name-only', next).split('\n').includes('tracked.txt'));
  assertEquals([box.status(), runGit(box.project, 'ls-files', '-s')], [statusBefore, indexBefore]);
  const record = onlyRecord(box);
  assertEquals([record.user, record.diffBase, wt.diffBase(record)], [next, next, next]);
  assertEquals(runGit(box.project, 'rev-parse', `refs/studio/${plan.slug}/user`).trim(), next);
  assertEquals(await wt.advanceUserBase(record, ['f.txt'], manager.registry), next, 'nothing new: same U');
  runGit(box.project, 'gc', '--prune=now', '--quiet');
  runGit(box.project, 'cat-file', '-e', next + '^{commit}');
  assertEquals(await manager.remove(plan.key, true), 'removed');
  assertEquals(runGit(box.project, 'for-each-ref', 'refs/studio/').trim(), '');
  await assertRejects(() => wt.advanceUserBase({ project: box.project }, ['f.txt']), wt.GitError);
});

Deno.test('autocrlf gives no false touched files; a CRLF blob matches its checked-out form', async () => {
  using box = new Sandbox();
  commit(box.project, 'f.txt', LINES, 'add f');
  runGit(box.project, 'config', 'core.autocrlf', 'true');
  const { manager, path } = await made(box);
  const record = onlyRecord(box);
  const base = record.user as string;
  write(path, 'tracked.txt', 'one\r\n');
  write(path, 'f.txt', LINES.replaceAll('\n', '\r\n'));
  const blobF = runGit(path, 'rev-parse', `${base}:f.txt`).trim();
  const blobT = runGit(path, 'rev-parse', `${base}:tracked.txt`).trim();
  assert(await wt.fileMatchesBlob(path, 'f.txt', blobF));
  assert(await wt.fileMatchesBlob(path, 'tracked.txt', blobT));
  assertEquals(await wt.touchedPaths(path, base), []);
  assert(!(await manager.hasChanges(record)));
  write(path, 'f.txt', 'a\r\nB\r\nc\r\nd\r\ne\r\nf\r\n');
  assertEquals(await wt.touchedPaths(path, base), ['f.txt']);
  assert(!(await wt.fileMatchesBlob(path, 'nope.txt', blobF)));
  assert(await wt.fileMatchesBlob(path, 'nope.txt', ''));
  Deno.removeSync(pathOf(path, 'tracked.txt'));
  assertEquals((await wt.touchedPaths(path, base)).sort(), ['f.txt', 'tracked.txt']);
  const hashed = new Deno.Command('git', {
    args: ['-c', 'core.autocrlf=false', 'hash-object', '-w', '--no-filters', '--stdin'],
    cwd: path,
    stdin: 'piped',
    stdout: 'piped',
  }).spawn();
  const writer = hashed.stdin.getWriter();
  await writer.write(new TextEncoder().encode('x\r\ny\r\n'));
  await writer.close();
  const blob = new TextDecoder().decode((await hashed.output()).stdout).trim();
  write(path, 'x.txt', 'x\r\ny\r\n');
  assert(await wt.fileMatchesBlob(path, 'x.txt', blob));
  write(path, 'x.txt', 'x\r\nz\r\n');
  assert(!(await wt.fileMatchesBlob(path, 'x.txt', blob)));
});

// ---- locks across processes -------------------------------------------------------------------------------------------
Deno.test('the pause and worktree locks exclude another process and the other way round', async () => {
  using box = new Sandbox();
  const record = { project: box.project, branch: 'studio/chat-x', path: pathOf(box.state, 'worktrees', 'h', 'chat-x') };
  assert(!(await wt.syncPaused(box.state, box.project)));
  const holder = await foreignHolds(box.state, box.project, record);
  try {
    assert(await wt.syncPaused(box.state, box.project));
    await assertRejects(() => wt.worktreeLock(box.state, record, 0).acquire());
  } finally {
    await holder.release();
  }
  assert(!(await wt.syncPaused(box.state, box.project)));
  const pause = await wt.pauseLock(box.state, box.project, 1).acquire();
  const own = await wt.worktreeLock(box.state, record, 1).acquire();
  try {
    assertEquals(await foreignProbe(box.state, box.project, record, 'probe'), { pause: 'held', worktree: 'held', paused: true });
  } finally {
    pause.release();
    own.release();
  }
  assertEquals(await foreignProbe(box.state, box.project, record, 'probe'), { pause: 'free', worktree: 'free', paused: false });
});

// ---- the registry file: interop both ways -----------------------------------------------------------------------------
Deno.test('registry: find, update and removal keep the file format; the same writes give the bytes Python wrote', async () => {
  const py = new Frozen();
  using box = new Sandbox();
  const { manager, plan, path } = await made(box);
  await manager.setSession(plan.key, 'omp', 's1');
  const registry = manager.registry;
  assertEquals(Object.keys(registry.all()), [plan.key]);
  assertEquals(registry.find(path)?.key ?? plan.key, plan.key);
  assertEquals(registry.find(null, 'omp:s1')?.key ?? plan.key, plan.key);
  assertEquals(wt.recordForPath(box.state, path)?.key ?? plan.key, plan.key);
  // an update and a put read back, with integer-like keys and non-ASCII text kept
  await registry.update(plan.key, { mergeConflicts: ['a.txt'], syncMerged: { '2': 'x', '1': 'y', b: '-' }, note: 'ünï 😀' });
  await registry.put('other', { path: pathOf(box.state, 'worktrees', 'z'), status: 'ready' });
  const updated = registry.get(plan.key)!;
  assertEquals([updated.mergeConflicts, updated.note], [['a.txt'], 'ünï 😀']);
  const textBefore = Deno.readTextFileSync(registry.path);
  await registry.update(plan.key, {}); // a rewrite keeps the bytes (key order of integer-like keys included)
  assertEquals(Deno.readTextFileSync(registry.path), textBefore);
  await registry.finishRemoval('other');
  assertEquals(Object.keys(registry.removed()), [wt.norm(pathOf(box.state, 'worktrees', 'z'))]);
  await registry.finishRemoval(plan.key);
  assertEquals(registry.all(), {});
  // the same sequence of writes gives the file Python wrote, byte for byte (kept as a fingerprint of that file)
  const records: [string, Record<string, unknown>][] = [
    ['k1', { path: 'C:\\x\\y', status: 'ready', created: 1731234567.25, pid: 12, n: null, ok: true, list: [1, 'two', { '3': 3 }] }],
    ['12', { project: 'ünïcødé 😀 "quoted" \\ back', status: 'creating' }],
    ['k1', { path: '/a/b', status: 'removal-pending', confirmed: true }],
  ];
  const denoState = pathOf(box.base, 'deno-state');
  const fresh = new wt.Registry(denoState);
  for (const [key, record] of records) await fresh.put(key, record);
  await fresh.update('12', { syncMerged: new Map([['9', 'a'], ['10', 'b']]) as unknown as Record<string, unknown>, user: 'u' });
  await fresh.remove('k1');
  const pythonBytes = await py.frozen('registry-bytes');
  assertEquals(Deno.readTextFileSync(pathOf(denoState, 'studio-worktrees.json')), pythonBytes);
  // a corrupt or odd file reads as empty
  Deno.writeTextFileSync(pathOf(denoState, 'studio-worktrees.json'), '{"version":1,"worktrees":{"a":1,"b":{"x":1}},"removed":[]}');
  assertEquals(fresh.all(), { b: { x: 1 } }, 'a record that is not an object is skipped');
  Deno.writeTextFileSync(pathOf(denoState, 'studio-worktrees.json'), '{not json');
  assertEquals(fresh.all(), {});
});

// ---- parity: the same repo state in, the same answers out ----------------------------------------------------------------
Deno.test('path helpers, the repo hash, the diff base and the user ref give what Python gave', async () => {
  const py = new Frozen();
  using box = new Sandbox();
  const call = (name: string, args: unknown[]) => py.call('worktrees_shim', 'call', [name, args]);
  // repoHash: sha1 of the normalised real path, ten hex characters (the folder name under <state>/worktrees)
  const expectedHash = (path: string) => createHash('sha1').update(wt.norm(Deno.realPathSync(path))).digest('hex').slice(0, 10);
  assertEquals(wt.repoHash(box.project), expectedHash(box.project));
  assert(/^[0-9a-f]{10}$/.test(wt.repoHash(pathOf(box.base, 'not-there'))));
  for (
    const value of [
      'a/b.txt',
      'a\\b.txt',
      '/x',
      'C:/x',
      '../x',
      'a/./b',
      '.git/config',
      '.GIT/x',
      '',
      'a//b',
      '.gitignore',
      'ü/😀',
    ]
  ) {
    assertEquals(wt.safeRelative(value), await call('_safe_relative', [value]), value);
  }
  for (
    const record of [
      {},
      { snapshot: 's' },
      { user: 'u', snapshot: 's' },
      { diffBase: 'd', user: 'u' },
      null,
      'x',
      { branch: 'studio/' },
      { branch: 'studio/a' },
    ]
  ) {
    assertEquals(wt.diffBase(record), await call('diff_base', [record]));
    if (record !== null && typeof record === 'object') {
      assertEquals(wt.userRef(record), await call('user_ref', [record]));
    }
  }
  // plan: a repo gets a plan under the state folder with a studio/ branch; a folder that is no repo gets none
  const plain = pathOf(box.base, 'plain');
  Deno.mkdirSync(plain);
  const plan = (await new wt.Manager(box.state).plan(box.project, 'abcdef0123456789'))!;
  assertEquals([plan.key, plan.project, plan.slug], ['abcdef0123456789', box.project, 'chat-abcdef01']);
  assert(plan.branch.startsWith('studio/chat-abcdef01'), plan.branch);
  assertEquals(plan.path, pathOf(box.state, 'worktrees', wt.repoHash(box.project), 'chat-abcdef01'));
  assertEquals(await new wt.Manager(box.state).plan(plain), null);
});

Deno.test('create, snapshot commit, user base and removal give the commits and records Python gave', async () => {
  const py = new Frozen();
  using box = new Sandbox(false);
  setFixedDates(true);
  try {
    const repos = ['py', 'deno'].map((side) => {
      const project = makeRepo(pathOf(box.base, side, 'proj'));
      write(project, 'tracked.txt', 'one\nedited\n');
      write(project, 'new.txt', 'brand new\n');
      write(project, '.env', 'K=1\n');
      return { project, state: pathOf(box.base, side, 'state') };
    });
    const [pySide, denoSide] = repos;
    assertEquals(runGit(pySide.project, 'rev-parse', 'HEAD'), runGit(denoSide.project, 'rev-parse', 'HEAD'), 'identical repos');
    const key = '0123456789abcdef0123456789abcdef';
    const manager = new wt.Manager(denoSide.state);
    await manager.create((await manager.plan(denoSide.project, key))!);
    const strip = (r: Record<string, unknown>) => {
      const { path: _p, project: _q, pid: _i, created: _c, editsFrom: _e, ...rest } = r;
      return rest;
    };
    const denoRecord = JSON.parse(JSON.stringify(manager.registry.get(key)!)) as Record<string, unknown>; // as created: the later steps update the record
    assertEquals(denoRecord.editsFrom, 'main', 'chats start from main: live sync copies the folder edits of main only');
    write(denoSide.project, 'f.txt', 'user\n');
    const denoU = await wt.advanceUserBase({ ...denoRecord, key }, ['f.txt', 'new.txt', 'gone.txt']);
    const scratchDeno = Deno.makeTempDirSync();
    const denoSnapshot = await wt.snapshotCommit(denoSide.project, scratchDeno);
    Deno.removeSync(scratchDeno, { recursive: true });
    const denoEnv = read(denoRecord.path as string, '.env');
    const denoRemoved = await manager.remove(key, true);
    const mine = {
      record: strip(denoRecord),
      keys: Object.keys(denoRecord).filter((k) => k !== 'editsFrom'),
      env: denoEnv,
      user: denoU,
      snapshot: denoSnapshot,
      removed: denoRemoved,
      all: manager.registry.all(),
      refs: runGit(denoSide.project, 'for-each-ref'),
    };
    const theirs = async () => {
      const pyPlan = await py.call('worktrees_shim', 'manager', [pySide.state, 'plan', [pySide.project, key]]);
      await py.call('worktrees_shim', 'manager', [pySide.state, 'create', [pyPlan]]);
      const pyRecord = (await py.call('worktrees_shim', 'registry', [pySide.state, 'get', [key]])) as Record<string, unknown>;
      const pyEnv = read(pyRecord.path as string, '.env');
      write(pySide.project, 'f.txt', 'user\n');
      const pyU = await py.call('worktrees_shim', 'call', ['advance_user_base', [{ ...pyRecord, key }, ['f.txt', 'new.txt', 'gone.txt']]]);
      const scratchPy = Deno.makeTempDirSync();
      const pySnapshot = await py.call('worktrees_shim', 'call', ['snapshot_commit', [pySide.project, scratchPy]]);
      Deno.removeSync(scratchPy, { recursive: true });
      const pyRemoved = await py.call('worktrees_shim', 'manager', [pySide.state, 'remove', [key, true]]);
      return {
        record: strip(pyRecord),
        keys: Object.keys(pyRecord),
        env: pyEnv,
        user: pyU,
        snapshot: pySnapshot,
        removed: pyRemoved,
        all: await py.call('worktrees_shim', 'registry', [pySide.state, 'all']),
        refs: runGit(pySide.project, 'for-each-ref'),
      };
    };
    assertEquals(JSON.parse(JSON.stringify(mine)), await py.frozen('create-snapshot-remove'));
  } finally {
    setFixedDates(false);
  }
});

Deno.test("git runs with Python's environment: repository overrides removed, prompts and optional locks off", async () => {
  const saved = Deno.env.get('GIT_DIR');
  Deno.env.set('GIT_DIR', '/nowhere');
  try {
    const env = wt.gitEnv({ GIT_INDEX_FILE: 'x' });
    assertEquals([env.GIT_DIR, env.GIT_OPTIONAL_LOCKS, env.GIT_TERMINAL_PROMPT, env.GIT_INDEX_FILE], [undefined, '0', '0', 'x']);
  } finally {
    saved === undefined ? Deno.env.delete('GIT_DIR') : Deno.env.set('GIT_DIR', saved);
  }
  using box = new Sandbox();
  const error = await assertRejects(() => wt.git(['rev-parse', '--verify', 'nope'], box.project), wt.GitError);
  assert(error.message.startsWith('git rev-parse --verify failed: '), error.message);
  const soft = await wt.git(['rev-parse', '--verify', '-q', 'nope'], box.project, { check: false });
  assertEquals(soft.returncode, 1);
  assertEquals(wt.sha1Hex(new TextEncoder().encode('abc')), 'a9993e364706816aba3e25717850c26c9cd0d89d');
  assertEquals(wt.sha1Hex(new Uint8Array(0)), 'da39a3ee5e6b4b0d3255bfef95601890afd80709');
  assertEquals(wt.sha1Hex(new TextEncoder().encode('a'.repeat(1000))), '291e9a6c66994949b57ba5e650361e98fc36b1ba');
});

// ---- aib-shared/: one real folder in the main folder, a link in every worktree (owner 2026-11-17) --------------------------------
async function localOnlyProject(box: Sandbox): Promise<void> {
  runGit(box.project, 'config', 'core.autocrlf', 'false');
  const lo = await localOnly.ensureDefault(box.project); // the temp repo's own .git/info/exclude
  assertEquals(lo?.entries, ['aib-shared']);
  assertEquals(lo?.defaultState, 'on');
}

const sharedLink = (path: string) => pathOf(path, 'aib-shared');
function assertLinked(path: string, project: string): void {
  const st = Deno.lstatSync(sharedLink(path));
  assert(st.isSymlink, `${sharedLink(path)} is a link (a junction on Windows), not a folder`);
  assert(sharedLinkMod.linksTo(sharedLink(path), pathOf(project, 'aib-shared')), 'it points at the main folder\'s real aib-shared');
}

Deno.test('aib-shared: the exclude block gets /aib-shared (no trailing slash: it ignores the link too)', async () => {
  using box = new Sandbox();
  await localOnlyProject(box);
  const exclude = Deno.readTextFileSync(pathOf(box.project, '.git', 'info', 'exclude'));
  assert(exclude.includes(`${localOnly.BLOCK_START}\n/aib-shared\n${localOnly.BLOCK_END}`), exclude);
  assert(!/^\/private/m.test(exclude));
});

Deno.test('aib-shared: a new worktree gets the link; a file written through it is in the main folder at once; git shows nothing', async () => {
  using box = new Sandbox();
  await localOnlyProject(box);
  const { manager, path, plan } = await made(box);
  assertLinked(path, box.project);
  write(path, 'aib-shared/notes/x.md', 'written in the worktree\n');
  assertEquals(read(box.project, 'aib-shared/notes/x.md'), 'written in the worktree\n', 'no copy, no sync: the same file');
  write(box.project, 'aib-shared/from-main.md', 'main\n');
  assertEquals(read(path, 'aib-shared/from-main.md'), 'main\n');
  assertEquals(runGit(path, 'status', '--porcelain', '--untracked-files=all'), '', 'the worktree shows nothing');
  assertEquals(box.status(), '', 'nor does the main folder');
  runGit(path, 'add', '-A');
  assertEquals(runGit(path, 'diff', '--cached', '--name-only'), '', 'git add -A takes nothing from it');
  assert(!(await manager.hasChanges(onlyRecord(box))), 'the link is no change of the chat');
  assertEquals(await manager.remove(plan.key), 'removed');
});

Deno.test('aib-shared: removing a worktree (plain, confirmed, discard) takes the link only; the real folder keeps every file', async () => {
  using box = new Sandbox();
  await localOnlyProject(box);
  write(box.project, 'aib-shared/keep.md', 'keep me\n');
  const first = await made(box);
  write(first.path, 'aib-shared/new.md', 'from the chat\n');
  assertEquals(await first.manager.remove(first.plan.key), 'removed');
  assert(!exists(first.path));
  const second = await made(box, 'b'.repeat(32));
  write(second.path, 'work.txt', 'unmerged work\n');
  assertEquals(await second.manager.remove(second.plan.key, true), 'removed', 'git worktree remove --force and rmtree');
  assert(!exists(second.path));
  const third = await made(box, 'c'.repeat(32));
  await third.manager.discard(third.plan.key);
  assert(!exists(third.path));
  assertEquals(read(box.project, 'aib-shared/keep.md'), 'keep me\n');
  assertEquals(read(box.project, 'aib-shared/new.md'), 'from the chat\n');
  assertEquals([...Deno.readDirSync(pathOf(box.project, 'aib-shared'))].map((e) => e.name).sort(), ['keep.md', 'new.md']);
});

Deno.test('aib-shared: a link that cannot be removed keeps the removal pending; nothing is deleted', async () => {
  using box = new Sandbox();
  await localOnlyProject(box);
  write(box.project, 'aib-shared/keep.md', 'keep me\n');
  const { manager, path, plan } = await made(box);
  write(path, 'work.txt', 'other work\n');
  sharedLinkMod._linkHooks.unlink = () => { // the link stays (a locked junction)
    throw new Deno.errors.PermissionDenied('in use');
  };
  try {
    assertEquals(await manager.remove(plan.key, true), 'pending', 'even confirmed: never a delete that could follow the link');
    assertLinked(path, box.project);
    assertEquals(read(path, 'work.txt'), 'other work\n');
    assertEquals(onlyRecord(box).status, 'removal-pending');
  } finally {
    sharedLinkMod._linkHooks.unlink = null;
  }
  assertEquals(await new wt.Manager(box.state).retryPending(), [plan.key]);
  assert(!exists(path));
  assertEquals(read(box.project, 'aib-shared/keep.md'), 'keep me\n');
});

Deno.test('aib-shared: a real aib-shared folder in a worktree is the worktree\'s own: removal deletes it, never the main one', async () => {
  using box = new Sandbox();
  await localOnlyProject(box);
  write(box.project, 'aib-shared/keep.md', 'keep me\n');
  const { manager, path, plan } = await made(box);
  Deno.removeSync(sharedLink(path));
  write(path, 'aib-shared/own.md', 'own\n');
  assertEquals(await manager.remove(plan.key, true), 'removed');
  assertEquals([...Deno.readDirSync(pathOf(box.project, 'aib-shared'))].map((e) => e.name), ['keep.md']);
});

Deno.test('aib-shared: an old worktree gets its link before it is used again (ensure), and a recreated one too', async () => {
  using box = new Sandbox();
  await localOnlyProject(box);
  const { manager, path, plan } = await made(box);
  Deno.removeSync(sharedLink(path)); // a worktree from before 0.13.0: no link
  assertEquals(await manager.ensure(onlyRecord(box)), path);
  assertLinked(path, box.project);
  Deno.removeSync(sharedLink(path));
  Deno.mkdirSync(sharedLink(path)); // an agent's empty mkdir before the link existed: replaced
  await manager.ensure(onlyRecord(box));
  assertLinked(path, box.project);
  Deno.removeSync(sharedLink(path));
  write(path, 'aib-shared/draft.md', 'a draft\n'); // a real folder with files: never deleted, left as it is
  await manager.ensure(onlyRecord(box));
  assert(!Deno.lstatSync(sharedLink(path)).isSymlink);
  assertEquals(read(path, 'aib-shared/draft.md'), 'a draft\n');
  Deno.removeSync(sharedLink(path), { recursive: true });
  Deno.removeSync(path, { recursive: true }); // deleted outside AIB: made again from its branch, with the link
  await manager.ensure(onlyRecord(box));
  assertLinked(path, box.project);
  assertEquals(await manager.remove(plan.key), 'removed');
  assert(exists(pathOf(box.project, 'aib-shared')));
});

Deno.test('aib-shared: no link where the project commits aib-shared/ (tracked) or has no AIB line', async () => {
  using box = new Sandbox();
  runGit(box.project, 'config', 'core.autocrlf', 'false');
  const plain = await made(box);
  assert(!exists(sharedLink(plain.path)), 'no /aib-shared line: no link');
  assertEquals(await plain.manager.remove(plain.plan.key), 'removed');
  commit(box.project, 'aib-shared/committed.md', 'tracked\n');
  const lo = await localOnly.ensureDefault(box.project);
  assertEquals(lo?.defaultState, 'off', 'a tracked aib-shared/ gets no AIB line');
  const tracked = await made(box, 'b'.repeat(32));
  assert(!Deno.lstatSync(sharedLink(tracked.path)).isSymlink, 'the checked-out folder, not a link');
  assertEquals(await tracked.manager.remove(tracked.plan.key), 'removed');
  assertEquals(read(box.project, 'aib-shared/committed.md'), 'tracked\n');
});

Deno.test('aib-shared: a project in a subfolder of its repository: the link goes at its own place in a worktree (subagents)', async () => {
  using box = new Sandbox();
  runGit(box.project, 'config', 'core.autocrlf', 'false');
  commit(box.project, 'app/readme.md', 'app\n');
  const app = pathOf(box.project, 'app');
  const lo = await localOnly.ensureDefault(app);
  assertEquals([lo?.prefix, lo?.entries, lo?.defaultState], ['app/', ['aib-shared'], 'on']);
  assert(Deno.readTextFileSync(pathOf(box.project, '.git', 'info', 'exclude')).includes('\n/app/aib-shared\n'));
  const copy = pathOf(box.state, 'sub-copy'); // a subagent worktree is a checkout of the whole repository
  runGit(box.project, 'worktree', 'add', '-q', '--detach', copy);
  assertEquals(await sharedLinkMod.linkSharedFor(copy, app), 'linked');
  assertEquals(await sharedLinkMod.linkSharedFor(copy, app), 'kept');
  assert(sharedLinkMod.linksTo(pathOf(copy, 'app', 'aib-shared'), pathOf(app, 'aib-shared')));
  assert(!exists(pathOf(copy, 'aib-shared')));
  write(copy, 'app/aib-shared/x.md', 'x\n');
  assertEquals(read(app, 'aib-shared/x.md'), 'x\n');
  assertEquals(runGit(copy, 'status', '--porcelain', '--untracked-files=all'), '');
  assert(await sharedLinkMod.unlinkSharedFor(copy, app));
  assert(!exists(pathOf(copy, 'app', 'aib-shared')));
  runGit(box.project, 'worktree', 'remove', '--force', copy);
  assertEquals(read(app, 'aib-shared/x.md'), 'x\n');
});

Deno.test('aib-shared: a subagent finds no "ignored files" of its own in the link (the worktree is not kept for it)', async () => {
  using box = new Sandbox();
  await localOnlyProject(box);
  write(box.project, 'aib-shared/main-note.md', 'main\n');
  const { manager, path, plan } = await made(box);
  write(path, 'aib-shared/sub-note.md', 'from the subagent\n');
  assertEquals(await ignoredFiles(path), [], 'files reached through the link are already in the main folder');
  write(path, 'scratch.log', 'x');
  runGit(path, 'config', 'core.excludesFile', '');
  Deno.writeTextFileSync(pathOf(path, '.gitignore'), 'scratch.log\n');
  assertEquals(await ignoredFiles(path), ['scratch.log'], 'its own ignored files still count');
  assertEquals(await manager.remove(plan.key, true), 'removed');
  assertEquals(read(box.project, 'aib-shared/sub-note.md'), 'from the subagent\n');
});

Deno.test('local only: .env files inside a local-only folder are never copied into a chat (copyEnvFiles and the live-sync walk)', async () => {
  using box = new Sandbox();
  await localOnlyProject(box);
  write(box.project, '.env', 'TOP=1\n');
  write(box.project, 'aib-shared/.env', 'SECRET=1\n');
  write(box.project, 'aib-shared/sub/.env.local', 'SECRET=2\n');
  write(box.project, 'sub/.env', 'SUB=1\n');
  const { manager, path, plan } = await made(box);
  assertEquals(read(path, '.env'), 'TOP=1\n');
  assertEquals(read(path, 'sub/.env'), 'SUB=1\n');
  assertLinked(path, box.project); // aib-shared/ is the link to the main folder's, never a copy
  assertEquals(envFiles(box.project, ['aib-shared']).sort(), ['.env', 'sub/.env']);
  assertEquals(envFiles(box.project).sort(), ['.env', 'aib-shared/.env', 'aib-shared/sub/.env.local', 'sub/.env'], 'unchanged without entries');
  Deno.removeSync(sharedLink(path));
  Deno.removeSync(path, { recursive: true });
  await manager.ensure(onlyRecord(box)); // made again from its branch: the same skip
  assert(exists(pathOf(path, '.env')));
  assertLinked(path, box.project);
  assertEquals(await manager.remove(plan.key), 'removed');
  assertEquals(read(box.project, 'aib-shared/.env'), 'SECRET=1\n');
});

Deno.test('local only: defaults are written only by a real AIB, or for projects under the temp folder', () => {
  using box = new Sandbox();
  const here = decodeURIComponent(new URL('.', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'); // work/deno of this repo
  assert(localOnly.defaultsAllowed(box.state, box.project), 'a temp AIB and a temp project');
  assert(!localOnly.defaultsAllowed(box.state, here), 'a temp AIB never writes a real repository');
  assert(!localOnly.defaultsAllowed('', here), 'neither does an AIB without a state folder');
  assert(localOnly.defaultsAllowed('', box.project));
});

Deno.test('planWithReason: the Windows manager never plans a WSL project (its ref); no git runs on Windows for it', async () => {
  const dir = Deno.makeTempDirSync({ prefix: 'aib-wsl-plan-' });
  try {
    const manager = new wt.Manager(dir);
    // AIB routes WSL projects to their distro's helper (wsl/worktrees.ts); a missed route is refused here, not run
    assertEquals(await manager.planWithReason('wsl://ubuntu/home/u/app'), { plan: null, reason: wt.WSL_PLANNED_THERE });
    assertEquals(await manager.plan('wsl://ubuntu/home/u/app'), null);
    assertEquals(Object.keys(manager.registry.all()), []);
    // build plan 1b (P1): a chat that wanted its own copy is told every reason, plainly (only a missed route reaches this one)
    assertEquals(
      wt.inPlaceNote(wt.WSL_PLANNED_THERE),
      "Couldn't make an own copy for this chat, so it works in the project folder: a WSL project's worktree is made in its distro.",
    );
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});
