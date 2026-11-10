/**
 * server/worktrees/sync.ts: the cases of work/test_worktree_sync.py, test_worktree_g3.py and test_worktree_e2.py that exercise
 * worktree_sync.py directly (over a fake studio instead of a whole Studio). three_way against Python, the real loop, the
 * cross-process locks and parity with Python on identical repos are in worktree_sync_interop_test.ts (split so both run in parallel).
 *
 * These cases drive ProjectSync.scan() by hand (two scans in a row make a change "stable"), so they do not wait on timers.
 * Turns are the turnStarted / turnEnded hooks called directly.
 * Skipped (they need a whole Studio, a live agent connection or HTTP): the prompt-note delivery through session/prompt, cancel during
 * catch-up, history normalisation (monitor.py), the resume-sync route, and the E2 stash-clash flows (covered by
 * worktree_merge_clash_test.ts).
 */
import { assert, assertEquals } from './_assert.ts';
import { PyParity } from './_parity.ts';
import { commit, runGit, Sandbox, write } from './_worktree_fixtures.ts';
import { BOTH, CHAT_EDIT, type Ctx, exists, list, LINES, note, setup, show, text, touched, USER_EDIT } from './_sync_fixtures.ts';
import * as wt from '../../outputs/agent-studio/server/worktrees/worktrees.ts';
import * as sync from '../../outputs/agent-studio/server/worktrees/sync.ts';
import * as m from '../../outputs/agent-studio/server/worktrees/merge.ts';
import { pathOf } from '../../outputs/agent-studio/server/state/paths.ts';


// ---- live sync (test_worktree_sync.py) --------------------------------------------------------------------------------
Deno.test('a saved edit reaches the worktree and Changes stay empty', async () => {
  using box = new Sandbox();
  const ctx = await setup(box);
  const before = ctx.record();
  write(box.project, 'f.txt', USER_EDIT);
  await ctx.scan();
  assertEquals(text(ctx.wts[0], 'f.txt'), LINES, 'one scan: not stable yet');
  assertEquals(ctx.ps.waiting, ctx.live.settle);
  await ctx.scan();
  assertEquals(text(ctx.wts[0], 'f.txt'), USER_EDIT);
  const record = ctx.record();
  assert(record.user !== before.user);
  assertEquals(record.diffBase, record.user);
  assertEquals(record.syncedPaths, ['f.txt']);
  assertEquals(await touched(ctx), 0);
  assertEquals(await ctx.manager.hasChanges(record), false);
  assertEquals(show(ctx, `${record.user}:f.txt`), USER_EDIT);
});

Deno.test('a file the chat touched is not written and is pending', async () => {
  using box = new Sandbox();
  const ctx = await setup(box);
  write(ctx.wts[0], 'f.txt', CHAT_EDIT);
  write(box.project, 'f.txt', USER_EDIT);
  write(box.project, 'g.txt', 'other file\n');
  await ctx.settle();
  assertEquals(text(ctx.wts[0], 'g.txt'), 'other file\n');
  assertEquals(text(ctx.wts[0], 'f.txt'), CHAT_EDIT);
  const record = ctx.record();
  assertEquals(record.pendingSync, ['f.txt']);
  assertEquals(record.syncedPaths, ['g.txt']);
});

Deno.test("nothing syncs in Merge's stash window and catch-up gets it later", async () => {
  using box = new Sandbox();
  const ctx = await setup(box);
  const lock = wt.pauseLock(box.state, box.project, 5);
  await lock.acquire();
  try {
    write(box.project, 'f.txt', 'during\nb\nc\nd\ne\nf\n');
    await ctx.settle();
    assertEquals(text(ctx.wts[0], 'f.txt'), LINES);
    assertEquals(await ctx.live.catchUp(ctx.keys[0]), 'paused');
  } finally {
    lock.release();
  }
  await ctx.settle();
  assertEquals(text(ctx.wts[0], 'f.txt'), LINES, 'what happened in the window is not echoed afterwards');
  assertEquals(await ctx.live.catchUp(ctx.keys[0]), 'ok');
  assertEquals(text(ctx.wts[0], 'f.txt'), 'during\nb\nc\nd\ne\nf\n');
});

Deno.test('a checkout of many files is not synced', async () => {
  using box = new Sandbox();
  const ctx = await setup(box);
  runGit(box.project, 'checkout', '-q', '-b', 'other');
  for (let n = 0; n < 30; n++) write(box.project, `o${n}.txt`, `${n}\n`);
  write(box.project, 'f.txt', 'other branch\nb\nc\nd\ne\nf\n');
  runGit(box.project, 'add', '-A');
  runGit(box.project, 'commit', '-q', '-m', 'other work');
  runGit(box.project, 'checkout', '-q', 'main');
  await ctx.settle();
  runGit(box.project, 'checkout', '-q', 'other');
  await ctx.settle();
  assertEquals(text(ctx.wts[0], 'f.txt'), LINES);
  assert(!exists(pathOf(ctx.wts[0], 'o0.txt')));
  assertEquals(list(ctx.record().syncedPaths), []);
});

Deno.test('a storm pauses, shows the line, and Resume catches the chats up', async () => {
  using box = new Sandbox();
  const ctx = await setup(box);
  for (let n = 0; n < sync.STORM + 10; n++) write(box.project, `s${n}.txt`, `${n}\n`);
  await ctx.scan();
  const info = sync.pauseInfo(box.state, box.project)!;
  assertEquals([info.paused, info.count, info.project], [true, sync.STORM + 10, box.project]);
  assertEquals(await m.clashStatus({ stateDir: box.state }, box.project), {
    unresolved: false,
    syncPaused: true,
    syncLine: 'Lots of files changed in proj; live sync paused. Resume?',
  });
  await ctx.settle();
  assert(!exists(pathOf(ctx.wts[0], 's0.txt')));
  assertEquals(await ctx.live.catchUp(ctx.keys[0]), 'paused');
  assertEquals(await sync.resumeSync(box.state, box.project), true);
  assertEquals(await m.clashStatus({ stateDir: box.state }, box.project), { unresolved: false });
  await ctx.scan(); // Resume: the catch-up brings the storm files, then a new baseline
  assertEquals(text(ctx.wts[0], 's5.txt'), '5\n');
  write(box.project, 'f.txt', 'after resume\nb\nc\nd\ne\nf\n');
  await ctx.settle();
  assertEquals(text(ctx.wts[0], 'f.txt'), 'after resume\nb\nc\nd\ne\nf\n');
  assertEquals(await touched(ctx), 0);
});

Deno.test('editor temp files are never synced and a temp-rename save is', async () => {
  using box = new Sandbox();
  const ctx = await setup(box);
  const temps = ['.f.txt.swp', 'f.txt~', '4913', 'x.tmp', '.#f.txt', '#f.txt#'];
  for (const name of temps) write(box.project, name, 'temp\n');
  await ctx.settle();
  for (const name of temps) assert(!exists(pathOf(ctx.wts[0], name)), name);
  write(box.project, 'f.txt.tmp', 'saved\nb\nc\nd\ne\nf\n');
  Deno.renameSync(pathOf(box.project, 'f.txt.tmp'), pathOf(box.project, 'f.txt'));
  await ctx.settle();
  assertEquals(text(ctx.wts[0], 'f.txt'), 'saved\nb\nc\nd\ne\nf\n');
  assert(!exists(pathOf(ctx.wts[0], 'f.txt.tmp')));
  assertEquals(ctx.record().syncedPaths, ['f.txt']);
});

Deno.test('temp names and env names match Python', async () => {
  await using py = new PyParity();
  for (const name of ['a/.b.swp', 'b.swx', 'c~', '.#d', '4913', 'e.tmp', 'f.tmp.123', '#g#']) assert(sync.isTemp(name), name);
  for (const name of ['swp.py', 'a.txt', 'tmp/x.py', 'f4913.txt', '.env']) assert(!sync.isTemp(name), name);
  const names = [
    'a/.b.swp',
    'B.SWX',
    'x\\y.tmp',
    '.~lock.x#',
    'a.crswap',
    'b.part',
    '.goutputstream-1',
    '.env',
    'x/.env.local',
    'env',
    'a.Tmp.b',
    '#',
    '##',
  ];
  for (const name of names) {
    assertEquals(sync.isTemp(name), await py.call('worktree_sync', 'is_temp', [name]), name);
    assertEquals(sync.isEnv(name), await py.call('worktree_sync', 'is_env', [name]), name);
  }
  for (const files of [['a'], Array.from({ length: 14 }, (_, i) => `f${i}.txt`)]) {
    assertEquals(sync.clashLine(files), await py.call('worktree_sync', 'clash_line', [files]));
  }
});

Deno.test('files with conflict markers are skipped until resolved', async () => {
  using box = new Sandbox();
  const ctx = await setup(box);
  write(box.project, 'f.txt', 'a\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> topic\nf\n');
  await ctx.settle();
  assertEquals(text(ctx.wts[0], 'f.txt'), LINES);
  write(box.project, 'f.txt', 'resolved\nb\nc\nd\ne\nf\n');
  await ctx.settle();
  assertEquals(text(ctx.wts[0], 'f.txt'), 'resolved\nb\nc\nd\ne\nf\n');
});

Deno.test('symlinks are skipped', async () => {
  using box = new Sandbox();
  const ctx = await setup(box);
  try {
    Deno.symlinkSync(pathOf(box.project, 'f.txt'), pathOf(box.project, 'link.txt'));
  } catch {
    return; // no symlinks here (Python: skipTest)
  }
  await ctx.settle();
  assert(!exists(pathOf(ctx.wts[0], 'link.txt')));
});

Deno.test('a delete, a rename and a new file in a new folder', async () => {
  using box = new Sandbox();
  const ctx = await setup(box);
  Deno.removeSync(pathOf(box.project, 'tracked.txt'));
  await ctx.scan(); // a deletion needs no second look
  assert(!exists(pathOf(ctx.wts[0], 'tracked.txt')));
  assert(list(ctx.record().syncedPaths).includes('tracked.txt'));
  Deno.renameSync(pathOf(box.project, 'f.txt'), pathOf(box.project, 'h.txt'));
  await ctx.settle();
  assertEquals(text(ctx.wts[0], 'h.txt'), LINES);
  assert(!exists(pathOf(ctx.wts[0], 'f.txt')));
  assert(['h.txt', 'f.txt'].every((p) => list(ctx.record().syncedPaths).includes(p)));
  write(box.project, 'deep/er/new.txt', 'brand new\n');
  await ctx.settle();
  assertEquals(text(ctx.wts[0], 'deep/er/new.txt'), 'brand new\n');
  assertEquals(await touched(ctx), 0);
  assertEquals(await ctx.manager.hasChanges(ctx.record()), false);
});

Deno.test('.env syncs only into chats that have not changed it, and is never merged', async () => {
  using box = new Sandbox();
  const ctx = await setup(box, 2, false, (project) => {
    commit(project, '.gitignore', 'ignored.log\nbuild/\nnode_modules/\n.env\n', 'ignore env');
    write(project, '.env', 'A=1\n');
  });
  assertEquals(text(ctx.wts[0], '.env'), 'A=1\n');
  for (const key of ctx.keys) assertEquals(await ctx.live.catchUp(key), 'ok'); // the chat-open catch-up records what it saw
  for (const n of [0, 1]) assert((ctx.record(n).env as Record<string, string>)['.env']);
  write(ctx.wts[1], '.env', 'MINE=1\n');
  write(box.project, '.env', 'A=2\n');
  await ctx.settle();
  assertEquals(text(ctx.wts[1], '.env'), 'MINE=1\n');
  assertEquals(text(ctx.wts[0], '.env'), 'A=2\n');
  for (const n of [0, 1]) assertEquals(list(ctx.record(n).pendingSync), [], 'an env file is never merged');
  assertEquals(ctx.record(1).syncNotes, [['.env', 'env']]);
  assertEquals(await touched(ctx), 0);
});

Deno.test('a worktree with a merge in progress is skipped, then caught up', async () => {
  using box = new Sandbox();
  const ctx = await setup(box);
  const gitdir = await wt.gitDirOf(ctx.wts[0]);
  Deno.writeTextFileSync(pathOf(gitdir, 'MERGE_HEAD'), runGit(ctx.wts[0], 'rev-parse', 'HEAD'));
  write(box.project, 'f.txt', 'blocked\nb\nc\nd\ne\nf\n');
  await ctx.settle();
  assertEquals(text(ctx.wts[0], 'f.txt'), LINES);
  assert(ctx.live.stale.has(ctx.keys[0]));
  await ctx.scan();
  assertEquals(text(ctx.wts[0], 'f.txt'), LINES);
  Deno.removeSync(pathOf(gitdir, 'MERGE_HEAD'));
  await ctx.scan(); // the stale chat is caught up at the next scan
  assertEquals(text(ctx.wts[0], 'f.txt'), 'blocked\nb\nc\nd\ne\nf\n');
  assertEquals(ctx.live.stale.size, 0);
});

Deno.test('other reasons to skip a worktree', async () => {
  using box = new Sandbox();
  const ctx = await setup(box);
  const record = ctx.record();
  assertEquals(await ctx.live.blocked(record), '');
  assertEquals(await ctx.live.blocked({ ...record, mergeConflicts: ['x'] }), 'conflicts to resolve');
  assertEquals(await ctx.live.blocked({ ...record, syncConflicts: ['x'] }), 'conflicts to resolve');
  assertEquals(await ctx.live.blocked({ ...record, syncConflicts: ['x'] }, true), '');
  const gitdir = await wt.gitDirOf(ctx.wts[0]);
  Deno.writeTextFileSync(pathOf(gitdir, 'index.lock'), '');
  assertEquals(await ctx.live.blocked(record), 'git is busy there');
  Deno.removeSync(pathOf(gitdir, 'index.lock'));
  runGit(ctx.wts[0], 'checkout', '-q', '--detach');
  assertEquals(await ctx.live.blocked(record), 'its HEAD is not on its own branch');
  assertEquals(await ctx.live.blocked({ ...record, path: pathOf(box.base, 'nope') }), 'the folder is gone');
});

Deno.test('catch-up without a HEAD move syncs everything that differs', async () => {
  using box = new Sandbox();
  const ctx = await setup(box);
  write(box.project, 'f.txt', 'while closed\nb\nc\nd\ne\nf\n');
  write(box.project, 'new.txt', 'new while closed\n');
  assertEquals(await ctx.live.catchUp(ctx.keys[0]), 'ok');
  assertEquals(text(ctx.wts[0], 'f.txt'), 'while closed\nb\nc\nd\ne\nf\n');
  assertEquals(text(ctx.wts[0], 'new.txt'), 'new while closed\n');
  assertEquals(ctx.record().syncedPaths, ['f.txt', 'new.txt']);
  assertEquals(await touched(ctx), 0);
});

Deno.test('catch-up after a HEAD move syncs only what is dirty now', async () => {
  using box = new Sandbox();
  const ctx = await setup(box);
  commit(box.project, 'other.txt', 'committed by the user\n', 'user commit');
  write(box.project, 'f.txt', 'dirty now\nb\nc\nd\ne\nf\n');
  assertEquals(await ctx.live.catchUp(ctx.keys[0]), 'ok');
  assertEquals(text(ctx.wts[0], 'f.txt'), 'dirty now\nb\nc\nd\ne\nf\n');
  assert(!exists(pathOf(ctx.wts[0], 'other.txt')), 'what the commit brought is not an edit of the user');
});

Deno.test('catch-up at turn start', async () => {
  using box = new Sandbox();
  const ctx = await setup(box);
  write(box.project, 'f.txt', 'before turn\nb\nc\nd\ne\nf\n');
  await ctx.live.turnStarted(ctx.conns[0]);
  assertEquals(text(ctx.wts[0], 'f.txt'), 'before turn\nb\nc\nd\ne\nf\n');
  assertEquals(ctx.record().turnUser, ctx.record().user);
});

Deno.test('the note lists the synced files once, then context_sent clears it', async () => {
  using box = new Sandbox();
  const ctx = await setup(box);
  write(box.project, 'f.txt', 'noted\nb\nc\nd\ne\nf\n');
  await ctx.settle();
  const [line, token] = ctx.live.contextFor(ctx.conns[0])!;
  assertEquals(line, '<studio-context>The user changed these files since your last turn: f.txt</studio-context>');
  assertEquals(token, { paths: ['f.txt'], notes: [] });
  await ctx.live.contextSent(ctx.conns[0], token);
  assertEquals(list(ctx.record().syncedPaths), []);
  assertEquals(ctx.live.contextFor(ctx.conns[0]), null);
  const many = Array.from({ length: 53 }, (_, i) => `p<${i}>.txt`);
  await ctx.manager.registry.update(ctx.keys[0], { syncedPaths: many });
  assert(note(ctx).endsWith('p?48?.txt, p?49?.txt and 3 more</studio-context>'), note(ctx));
});

Deno.test('the flag off means no watcher and no note', async () => {
  using box = new Sandbox();
  const ctx = await setup(box);
  ctx.studio.flag.on = false;
  assertEquals(ctx.live.enabled(), false);
  await ctx.live.refresh();
  assertEquals(ctx.live.projects.size, 0);
  assertEquals(ctx.live.contextFor(ctx.conns[0]), null);
  assertEquals(await ctx.live.catchUp(ctx.keys[0]), 'paused');
  assertEquals(await ctx.live.mergePending(ctx.conns[0]), 'off');
  assertEquals(sync.pausedStatus(box.state, box.project), {});
});

// ---- merging what both sides changed (test_worktree_g3.py) -------------------------------------------------------------
Deno.test("different lines merge at turn end; only the chat's lines are changes", async () => {
  using box = new Sandbox();
  const ctx = await setup(box, 1, true);
  const before = ctx.record().user;
  await ctx.live.turnStarted(ctx.conns[0]);
  write(ctx.wts[0], 'f.txt', CHAT_EDIT);
  write(box.project, 'f.txt', USER_EDIT);
  await ctx.settle();
  assertEquals(ctx.record().pendingSync, ['f.txt']);
  assertEquals(text(ctx.wts[0], 'f.txt'), CHAT_EDIT, 'not written while the turn runs');
  await ctx.live.turnEnded(ctx.conns[0]);
  assertEquals(text(ctx.wts[0], 'f.txt'), BOTH);
  const record = ctx.record();
  assertEquals([list(record.pendingSync), list(record.syncConflicts)], [[], []]);
  assert(record.user !== before);
  assertEquals(show(ctx, `${record.user}:f.txt`), USER_EDIT, "U has the user's version");
  assertEquals(await touched(ctx), 1);
  const diff = runGit(ctx.wts[0], 'diff', record.user as string, '--', 'f.txt');
  assert(diff.includes('-f\n+f-chat'));
  assert(note(ctx).includes('f.txt'));
});

Deno.test('a turn start merges what turn end could not', async () => {
  using box = new Sandbox();
  const ctx = await setup(box, 1, true);
  write(ctx.wts[0], 'f.txt', CHAT_EDIT);
  write(box.project, 'f.txt', USER_EDIT);
  await ctx.settle();
  const lock = wt.pauseLock(box.state, box.project, 5);
  await lock.acquire();
  try {
    assertEquals(await ctx.live.mergePending(ctx.conns[0], true), 'paused');
    assertEquals(text(ctx.wts[0], 'f.txt'), CHAT_EDIT);
  } finally {
    lock.release();
  }
  await ctx.live.turnStarted(ctx.conns[0]);
  assertEquals(text(ctx.wts[0], 'f.txt'), BOTH);
});

async function clash(ctx: Ctx): Promise<void> {
  await ctx.live.turnStarted(ctx.conns[0]);
  write(ctx.wts[0], 'f.txt', 'a\nb\nc\nd\ne\nf-chat\n');
  write(ctx.box.project, 'f.txt', 'a\nb\nc\nd\ne\nf-user\n');
  await ctx.settle();
  assertEquals(ctx.record().pendingSync, ['f.txt']);
  await ctx.live.turnEnded(ctx.conns[0]);
}

Deno.test('the same lines conflict, block Merge, name the file, and resolving clears it', async () => {
  using box = new Sandbox();
  const ctx = await setup(box, 1, true);
  const before = ctx.record().user;
  await clash(ctx);
  const content = text(ctx.wts[0], 'f.txt')!;
  assert(content.includes('<<<<<<< chat (your copy)') && content.includes('f-chat') && content.includes('f-user'));
  const record = ctx.record();
  assertEquals(record.syncConflicts, ['f.txt']);
  assertEquals(list(record.pendingSync), []);
  assertEquals(record.user, before, 'U moves only when the clash is resolved');
  assertEquals(sync.openClashes(record), ['f.txt']);
  const line = note(ctx);
  assert(line.includes("clash between your edit and the user's: f.txt") && line.includes('your own copy'));
  write(ctx.wts[0], 'f.txt', content + 'x\n'); // still has markers
  assertEquals(await ctx.live.mergePending(ctx.conns[0], true), 'ok');
  assertEquals(ctx.record().syncConflicts, ['f.txt']);
  write(ctx.wts[0], 'f.txt', 'a\nb\nc\nd\ne\nf-both\n');
  assertEquals(await ctx.live.mergePending(ctx.conns[0], true), 'ok');
  assertEquals(list(ctx.record().syncConflicts), []);
  assertEquals(show(ctx, `${ctx.record().user}:f.txt`), 'a\nb\nc\nd\ne\nf-user\n');
  assert(!note(ctx).includes('clash'));
  assertEquals(await touched(ctx), 1);
});

Deno.test('a user save after the clash is merged again once resolved', async () => {
  using box = new Sandbox();
  const ctx = await setup(box, 1, true);
  await clash(ctx);
  write(box.project, 'f.txt', 'a\nb\nc\nd\ne\nf-user2\n');
  await ctx.settle(); // blocked by the clash: the chat is stale
  write(ctx.wts[0], 'f.txt', 'a\nb\nc\nd\ne\nf-both\n');
  await ctx.live.turnStarted(ctx.conns[0]); // the clash is cleared, f.txt goes back to pendingSync and is merged again
  const record = ctx.record();
  assertEquals(record.syncConflicts, ['f.txt'], 'f-both against f-user2: a new clash (Python only polls the moment it is clear)');
  assert(text(ctx.wts[0], 'f.txt')!.includes('f-user2'));
  assert(show(ctx, `${record.user}:f.txt`) !== 'a\nb\nc\nd\ne\nf-user2\n', 'U does not claim the newer edit the copy lacks');
  assert(list(record.pendingSync).length || text(ctx.wts[0], 'f.txt') !== 'a\nb\nc\nd\ne\nf-both\n', 'queued again, not lost');
});

Deno.test("the agent's stale write does not undo the user's edit", async () => {
  using box = new Sandbox();
  const ctx = await setup(box, 1, true);
  await ctx.live.turnStarted(ctx.conns[0]);
  write(box.project, 'f.txt', USER_EDIT);
  await ctx.settle();
  assertEquals(text(ctx.wts[0], 'f.txt'), USER_EDIT);
  assertEquals(ctx.record().turnSynced, ['f.txt']);
  write(ctx.wts[0], 'f.txt', CHAT_EDIT); // written back from the read before the user's edit arrived
  await ctx.live.turnEnded(ctx.conns[0]);
  assertEquals(text(ctx.wts[0], 'f.txt'), BOTH);
  assertEquals([list(ctx.record().syncConflicts), ctx.record().turnUser], [[], '']);
  assertEquals(await touched(ctx), 1);
});

Deno.test('a stale write of the unchanged file is fixed too, and running the guard again changes nothing', async () => {
  using box = new Sandbox();
  const ctx = await setup(box, 1, true);
  const start = ctx.record().user as string;
  await ctx.live.turnStarted(ctx.conns[0]);
  write(box.project, 'f.txt', USER_EDIT);
  await ctx.settle();
  write(ctx.wts[0], 'f.txt', LINES);
  await ctx.live.turnEnded(ctx.conns[0]);
  assertEquals(text(ctx.wts[0], 'f.txt'), USER_EDIT);
  await ctx.live.withWorktree(ctx.keys[0], async (rec) => {
    await ctx.live.combine(rec, ['f.txt'], start);
    return 'ok';
  });
  assertEquals(text(ctx.wts[0], 'f.txt'), USER_EDIT);
});

Deno.test('a stale write that clashes becomes a conflict', async () => {
  using box = new Sandbox();
  const ctx = await setup(box, 1, true);
  await ctx.live.turnStarted(ctx.conns[0]);
  write(box.project, 'f.txt', 'a\nb\nc\nd\ne\nf-user\n');
  await ctx.settle();
  write(ctx.wts[0], 'f.txt', CHAT_EDIT);
  await ctx.live.turnEnded(ctx.conns[0]);
  assert(text(ctx.wts[0], 'f.txt')!.includes('<<<<<<<'));
  assertEquals(ctx.record().syncConflicts, ['f.txt']);
});

Deno.test("binary files keep the chat's version and say so", async () => {
  using box = new Sandbox();
  const ctx = await setup(box, 1, true);
  await ctx.live.turnStarted(ctx.conns[0]);
  write(ctx.wts[0], 'bin.dat', new Uint8Array([0, 99, 104, 97, 116, 0]));
  write(box.project, 'bin.dat', new Uint8Array([0, 117, 115, 101, 114, 0]));
  await ctx.settle();
  assertEquals(ctx.record().pendingSync, ['bin.dat']);
  await ctx.live.turnEnded(ctx.conns[0]);
  assertEquals([...Deno.readFileSync(pathOf(ctx.wts[0], 'bin.dat'))], [0, 99, 104, 97, 116, 0]);
  const record = ctx.record();
  assertEquals([list(record.pendingSync), list(record.syncConflicts)], [[], []]);
  assertEquals(record.syncNotes, [['bin.dat', 'binary']]);
  assert(note(ctx).includes('These binary files were changed by both you and the user') && note(ctx).includes('bin.dat'));
  await ctx.live.mergePending(ctx.conns[0], true);
  assertEquals(ctx.record().syncNotes, [['bin.dat', 'binary']], 'kept already: not noted twice');
});

Deno.test('the chat deleted a file the user edited, and the other way round', async () => {
  using box = new Sandbox();
  const ctx = await setup(box, 1, true);
  await ctx.live.turnStarted(ctx.conns[0]);
  Deno.removeSync(pathOf(ctx.wts[0], 'g.txt'));
  write(box.project, 'g.txt', 'g1\ng2-user\n');
  write(ctx.wts[0], 'f.txt', CHAT_EDIT);
  Deno.removeSync(pathOf(box.project, 'f.txt'));
  await ctx.settle();
  assertEquals(ctx.record().pendingSync, ['f.txt', 'g.txt']);
  await ctx.live.turnEnded(ctx.conns[0]);
  assert(!exists(pathOf(ctx.wts[0], 'g.txt')), "the chat's deletion stays");
  assertEquals(text(ctx.wts[0], 'f.txt'), CHAT_EDIT);
  const line = note(ctx);
  assert(line.includes('which you deleted. Your deletion was kept: g.txt'));
  assert(line.includes('which you edited. Your copy was kept: f.txt'));
  assertEquals(list(ctx.record().pendingSync), []);
  assertEquals(text(box.project, 'g.txt'), 'g1\ng2-user\n', 'the project folder is never touched');
});

Deno.test('a file added on both sides merges with an empty base', async () => {
  using box = new Sandbox();
  const ctx = await setup(box, 1, true);
  await ctx.live.turnStarted(ctx.conns[0]);
  write(ctx.wts[0], 'new.txt', 'from the chat\n');
  write(box.project, 'new.txt', 'from the user\n');
  write(ctx.wts[0], 'same.txt', 'same on both\n');
  write(box.project, 'same.txt', 'same on both\n');
  await ctx.settle();
  await ctx.live.turnEnded(ctx.conns[0]);
  const content = text(ctx.wts[0], 'new.txt')!;
  assert(content.includes('<<<<<<<') && content.includes('from the chat') && content.includes('from the user'));
  const record = ctx.record();
  assertEquals(record.syncConflicts, ['new.txt']);
  assertEquals(text(ctx.wts[0], 'same.txt'), 'same on both\n');
  assertEquals(show(ctx, `${record.user}:same.txt`), 'same on both\n', 'identical additions are clean and U has the file');
  assertEquals(list(record.pendingSync), []);
});

Deno.test('.env files are never merged: the note says so', async () => {
  using box = new Sandbox();
  const ctx = await setup(box, 1, true, (project) => {
    commit(project, '.gitignore', 'ignored.log\nbuild/\nnode_modules/\n.env\n', 'ignore env');
    write(project, '.env', 'A=1\n');
  });
  assertEquals(await ctx.live.catchUp(ctx.keys[0]), 'ok');
  await ctx.live.turnStarted(ctx.conns[0]);
  write(ctx.wts[0], '.env', 'MINE=1\n');
  write(box.project, '.env', 'A=2\n');
  ctx.ps.envDirty = true; // the watcher would have poked '.env'
  await ctx.settle();
  await ctx.live.turnEnded(ctx.conns[0]);
  assertEquals(text(ctx.wts[0], '.env'), 'MINE=1\n');
  const record = ctx.record();
  assertEquals([list(record.pendingSync), list(record.syncConflicts)], [[], []]);
  assert(note(ctx).includes('.env files, which you also changed. Env files are never merged') && note(ctx).includes(': .env'));
  assertEquals(text(box.project, '.env'), 'A=2\n');
  assertEquals(await touched(ctx), 0);
});

Deno.test('autocrlf gives no false merges, and a real merge keeps CRLF', async () => {
  const crlf = (s: string) => new TextEncoder().encode(s.replaceAll('\n', '\r\n'));
  {
    using box = new Sandbox();
    const ctx = await setup(box, 1, true, (project) => runGit(project, 'config', 'core.autocrlf', 'true'));
    const before = ctx.record().user;
    await ctx.live.turnStarted(ctx.conns[0]);
    write(ctx.wts[0], 'f.txt', crlf(LINES));
    write(box.project, 'f.txt', crlf(LINES));
    await ctx.settle();
    await ctx.live.turnEnded(ctx.conns[0]);
    const record = ctx.record();
    assertEquals([list(record.pendingSync), list(record.syncConflicts), list(record.syncNotes)], [[], [], []]);
    assertEquals(record.user, before);
    assertEquals(await touched(ctx), 0);
  }
  {
    using box = new Sandbox();
    const ctx = await setup(box, 1, true, (project) => runGit(project, 'config', 'core.autocrlf', 'true'));
    await ctx.live.turnStarted(ctx.conns[0]);
    write(ctx.wts[0], 'f.txt', crlf(CHAT_EDIT));
    write(box.project, 'f.txt', crlf(USER_EDIT));
    await ctx.settle();
    assertEquals(ctx.record().pendingSync, ['f.txt']);
    await ctx.live.turnEnded(ctx.conns[0]);
    assertEquals(new TextDecoder().decode(Deno.readFileSync(pathOf(ctx.wts[0], 'f.txt'))), BOTH.replaceAll('\n', '\r\n'));
    assertEquals(list(ctx.record().syncConflicts), []);
    assertEquals(await touched(ctx), 1);
  }
});

Deno.test('nothing is merged while the chat is busy or sync is paused', async () => {
  using box = new Sandbox();
  const ctx = await setup(box, 1, true);
  ctx.conns[0].state = { state: 'busy', busy: true };
  write(ctx.wts[0], 'f.txt', CHAT_EDIT);
  write(box.project, 'f.txt', USER_EDIT);
  await ctx.settle();
  assertEquals(await ctx.live.mergePending(ctx.conns[0]), 'busy');
  assertEquals(text(ctx.wts[0], 'f.txt'), CHAT_EDIT);
  ctx.conns[0].state = { state: 'ready', busy: false, clientCaps: { terminals: [{ status: 'running' }] } };
  assertEquals(await ctx.live.mergePending(ctx.conns[0], true), 'busy', 'a running terminal counts even at a turn boundary');
  ctx.conns[0].state = { state: 'ready', busy: false };
  await ctx.manager.registry.update(ctx.keys[0], { turnUser: ctx.record().user });
  const lock = wt.pauseLock(box.state, box.project, 5);
  await lock.acquire();
  try {
    assertEquals(await ctx.live.mergePending(ctx.conns[0]), 'paused');
    assertEquals(await ctx.live.finishTurn(ctx.conns[0]), 'paused');
    assertEquals(text(ctx.wts[0], 'f.txt'), CHAT_EDIT);
  } finally {
    lock.release();
  }
  assertEquals(await ctx.live.mergePending(ctx.conns[0]), 'ok');
  assertEquals(text(ctx.wts[0], 'f.txt'), BOTH);
});
