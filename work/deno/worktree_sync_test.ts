/**
 * server/worktrees/sync.ts: the cases of work/test_worktree_sync.py, test_worktree_g3.py and test_worktree_e2.py that exercise
 * worktree_sync.py directly (over a fake studio instead of a whole Studio), parity with Python on identical repos (the same sequence of
 * user and chat edits synced by Python's code and by the port gives the same worktree files, commits, records, notes and pause state)
 * and the cross-process locks in both directions.
 *
 * Most cases drive ProjectSync.scan() by hand (two scans in a row make a change "stable"), so they do not wait on timers; a few run the
 * real loop (Deno.watchFs on Windows plus the poll). Turns are the turnStarted / turnEnded hooks called directly.
 * Skipped (they need a whole Studio, a live agent connection or HTTP): the prompt-note delivery through session/prompt, cancel during
 * catch-up, history normalisation (monitor.py), the resume-sync route, and the E2 stash-clash flows (covered by worktree_merge_test.ts).
 */
import { assert, assertEquals, assertRejects } from './_assert.ts';
import { PyParity, python } from './_parity.ts';
import { commit, FIXED_DATES, makeRepo, pythonHolds, read, runGit, Sandbox, setFixedDates, write } from './_worktree_fixtures.ts';
import * as wt from '../../outputs/agent-studio/server/worktrees/worktrees.ts';
import * as sync from '../../outputs/agent-studio/server/worktrees/sync.ts';
import * as m from '../../outputs/agent-studio/server/worktrees/merge.ts';
import { pathOf } from '../../outputs/agent-studio/server/state/paths.ts';

const { LiveSync, ProjectSync } = sync;

const LINES = 'a\nb\nc\nd\ne\nf\n';
const USER_EDIT = 'A-user\nb\nc\nd\ne\nf\n';
const CHAT_EDIT = 'a\nb\nc\nd\ne\nf-chat\n';
const BOTH = 'A-user\nb\nc\nd\ne\nf-chat\n';
const WIN = Deno.build.os === 'windows';

class Conn implements sync.SyncConnection {
  closed = false;
  worktree: unknown = true;
  state: Record<string, unknown> = { state: 'ready', busy: false };
  constructor(readonly cwd: string) {}
  public(): unknown {
    return { ...this.state };
  }
}

interface Ctx {
  box: Sandbox;
  manager: wt.Manager;
  live: sync.LiveSync;
  studio: sync.SyncStudio & { flag: { on: boolean }; connections: Map<string, Conn> };
  conns: Conn[];
  wts: string[];
  keys: string[];
  ps: sync.ProjectSync;
  scan: () => Promise<void>;
  /** Two scans in a row: whatever changed is stable and synced. */
  settle: () => Promise<void>;
  record: (n?: number) => wt.WorktreeRecord & { key: string };
}

function text(folder: string, name: string): string | null {
  try {
    return read(folder, name);
  } catch {
    return null;
  }
}

function exists(path: string): boolean {
  return wt.lexists(path);
}

/** A project with f.txt (and, for G3, bin.dat and g.txt) and `chats` worktree chats; a LiveSync over a fake studio (no watcher). */
async function setup(box: Sandbox, chats = 1, g3 = false, setupProject?: (project: string) => void): Promise<Ctx> {
  runGit(box.project, 'config', 'core.autocrlf', 'false');
  commit(box.project, 'f.txt', LINES, 'add f');
  if (g3) {
    write(box.project, 'bin.dat', new Uint8Array([0, 98, 97, 115, 101, 0]));
    write(box.project, 'g.txt', 'g1\ng2\n');
    runGit(box.project, 'add', '-A');
    runGit(box.project, 'commit', '-q', '-m', 'binary and g');
  }
  setupProject?.(box.project);
  const manager = new wt.Manager(box.state);
  const conns: Conn[] = [], wts: string[] = [], keys: string[] = [];
  for (let n = 0; n < chats; n++) {
    const key = String(n).repeat(32);
    const plan = (await manager.plan(box.project, key))!;
    await manager.create(plan);
    conns.push(new Conn(plan.path));
    wts.push(plan.path);
    keys.push(key);
  }
  const studio = {
    stateDir: box.state,
    worktrees: manager,
    flag: { on: true },
    settings: { worktreePerChat: () => studio.flag.on },
    connections: new Map(conns.map((c, i) => [`c${i}`, c])),
  };
  const live = new LiveSync(studio, 0.05, 0.2, false);
  const ps = new ProjectSync(live, box.project);
  const scan = () => ps.lock.run(() => ps.scan());
  const ctx: Ctx = {
    box,
    manager,
    live,
    studio,
    conns,
    wts,
    keys,
    ps,
    scan,
    settle: async () => {
      await scan();
      await scan();
    },
    record: (n = 0) => ({ ...manager.registry.get(keys[n])!, key: keys[n] }),
  };
  await scan(); // the baseline
  return ctx;
}

async function until(check: () => unknown | Promise<unknown>, what: string, seconds = 30): Promise<void> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

const show = (ctx: Ctx, spec: string) => runGit(ctx.box.project, 'show', spec);
const touched = async (ctx: Ctx, n = 0) => (await wt.touchedPaths(ctx.wts[n], wt.diffBase(ctx.record(n)))).length;
const note = (ctx: Ctx, n = 0) => ctx.live.contextFor(ctx.conns[n])?.[0] ?? '';
const list = (value: unknown) => (Array.isArray(value) ? value : []);

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

Deno.test('three_way matches Python on every kind', async () => {
  const scratch = Deno.makeTempDirSync({ prefix: 'studio-3way-' });
  try {
    const enc = (s: string | null) => (s === null ? null : new TextEncoder().encode(s));
    const cases: [string | null, string | null, string | null][] = [
      [null, null, null],
      ['a\n', 'b\n', 'b\n'],
      ['a\n', 'a\n', null],
      ['a\n', 'b\n', null],
      [null, 'b\n', null],
      ['a\n', null, 'a\n'],
      ['a\n', null, 'c\n'],
      ['a\nb\nc\nd\n', 'a\nb\nc\nd\n', 'x\nb\nc\nd\n'],
      ['a\nb\nc\nd\n', 'a\nb\nc\nD\n', 'a\nb\nc\nd\n'],
      [LINES, CHAT_EDIT, USER_EDIT],
      [LINES, CHAT_EDIT, 'a\nb\nc\nd\ne\nf-user\n'],
      [null, 'one\n', 'two\n'],
      ['\0x', '\0y', '\0z'],
      ['a\r\nb\r\n', 'a\nb\n', 'a\r\nb\r\n'],
    ];
    for (const [base, current, other] of cases) {
      const [kind, data] = await sync.threeWay(enc(base), enc(current), enc(other), scratch);
      const [pyKind, pyData] = await pyThreeWay(base, current, other, scratch);
      assertEquals([kind, data === null ? null : new TextDecoder().decode(data)], [pyKind, pyData], JSON.stringify([base, current, other]));
    }
  } finally {
    Deno.removeSync(scratch, { recursive: true });
  }
});

/** worktree_sync.three_way through a one-off Python process (bytes in and out as latin-1 text). */
async function pyThreeWay(
  base: string | null,
  current: string | null,
  other: string | null,
  scratch: string,
): Promise<[string, string | null]> {
  const script = `
import json, sys
sys.path.insert(0, sys.argv[1])
import worktree_sync
args = json.loads(sys.argv[2])
b = lambda s: None if s is None else s.encode('utf-8')
kind, data = worktree_sync.three_way(b(args[0]), b(args[1]), b(args[2]), args[3])
print(json.dumps([kind, None if data is None else data.decode('utf-8')]))
`;
  const done = await new Deno.Command(python(), {
    args: ['-X', 'utf8', '-c', script, APP_DIR, JSON.stringify([base, current, other, scratch])],
    stdout: 'piped',
    stderr: 'inherit',
    env: { AGENT_STUDIO_TEST: '1' },
  }).output();
  return JSON.parse(new TextDecoder().decode(done.stdout));
}

const APP_DIR = new URL('../python-reference/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'); // the Python reference

// ---- the real loop and the folder watcher (LifecycleTests) ---------------------------------------------------------------
Deno.test({
  name: 'the real loop: a save lands, a storm frees the folder, Resume watches again, the last chat closing stops it',
  sanitizeOps: true,
  sanitizeResources: true,
  fn: async () => {
    using box = new Sandbox();
    const ctx = await setup(box);
    const live = new LiveSync(ctx.studio, 0.1, 0.3, true);
    live.maxSettle = 30;
    try {
      await live.chatOpened(ctx.conns[0]);
      assertEquals(live.projects.size, 1);
      const running = [...live.projects.values()][0];
      await until(() => running.baselined.isSet(), 'baseline');
      if (WIN) assert(running.notifier?.alive, 'the folder is watched');
      await Promise.all(live.workers);
      write(box.project, 'f.txt', USER_EDIT);
      await until(() => text(ctx.wts[0], 'f.txt') === USER_EDIT && list(ctx.record().syncedPaths).includes('f.txt'), 'f.txt synced');
      live.settle = 2; // the burst is over before the scan
      for (let n = 0; n < sync.STORM + 10; n++) write(box.project, `s${n}.txt`, `${n}\n`);
      await until(() => sync.pauseInfo(box.state, box.project), 'paused', 60);
      await until(() => running.notifier === null, 'watcher closed by the pause');
      Deno.renameSync(box.project, box.project + '-moved'); // paused: the folder can be renamed at once
      Deno.renameSync(box.project + '-moved', box.project);
      live.settle = 0.1;
      await sync.resumeSync(box.state, box.project);
      await until(() => text(ctx.wts[0], 's5.txt') === '5\n', 'the catch-up brings the storm files', 60);
      if (WIN) await until(() => running.notifier?.alive, 'watching again after Resume');
      ctx.conns[0].closed = true; // the last chat closes
      await live.refresh();
      assertEquals(live.projects.size, 0);
      let ended = false;
      running.done!.then(() => (ended = true));
      await until(() => ended, 'the sync task ended', 10);
      assertEquals(running.notifier, null);
      Deno.renameSync(box.project, box.project + '-moved2');
      Deno.renameSync(box.project + '-moved2', box.project);
    } finally {
      await live.stopAll();
    }
  },
});

Deno.test('the project folder is free right after stopAll', async () => {
  using box = new Sandbox();
  const ctx = await setup(box);
  const live = new LiveSync(ctx.studio, 0.1, 60, true); // a 60 s poll: on Windows only the folder watcher can be this quick
  await live.chatOpened(ctx.conns[0]);
  const running = [...live.projects.values()][0];
  await until(() => running.baselined.isSet(), 'baseline');
  await Promise.all(live.workers);
  if (WIN) {
    write(box.project, 'f.txt', USER_EDIT);
    await until(() => text(ctx.wts[0], 'f.txt') === USER_EDIT, 'synced on the watcher event', 20);
  }
  await live.stopAll();
  assertEquals(running.notifier, null);
  assertEquals(live.projects.size, 0);
  Deno.renameSync(box.project, box.project + '-moved');
  Deno.renameSync(box.project + '-moved', box.project);
  assertEquals(await live.catchUp(ctx.keys[0]), 'paused', 'closed');
});

// ---- cross-process locks with Python ------------------------------------------------------------------------------------
Deno.test("Python's pause and worktree locks stop the port's sync, and the port's stop Python's (interop)", async () => {
  using box = new Sandbox();
  const ctx = await setup(box, 1, true);
  const saved = sync.settings.WORKTREE_WAIT;
  sync.settings.WORKTREE_WAIT = 0.3;
  await using py = new PyParity();
  try {
    write(box.project, 'f.txt', USER_EDIT);
    const holder = await pythonHolds(box.state, box.project, ctx.record());
    try {
      assertEquals(await ctx.live.catchUp(ctx.keys[0]), 'paused');
      assertEquals(await ctx.live.syncChat(ctx.keys[0], new Map([['f.txt', null]])), 'busy');
      assertEquals(await ctx.live.mergePending(ctx.conns[0]), 'busy');
      await ctx.settle();
      assertEquals(ctx.ps.reset, true, 'a scan under the pause takes a new baseline');
      assertEquals(text(ctx.wts[0], 'f.txt'), LINES);
    } finally {
      await holder.release();
    }
    assertEquals(await ctx.live.catchUp(ctx.keys[0]), 'ok');
    assertEquals(text(ctx.wts[0], 'f.txt'), USER_EDIT);

    // the other way: the port holds them, Python's live sync (same state folder, same worktree) must wait
    await py.call('worktree_sync_shim', 'set_attr', ['WORKTREE_WAIT', 0.3]);
    await py.call('worktree_sync_shim', 'open', ['lock', box.state, [{ id: 'c0', cwd: ctx.wts[0] }]]);
    write(box.project, 'g.txt', 'g1-user\ng2\n');
    const pause = wt.pauseLock(box.state, box.project, 5);
    const lock = wt.worktreeLock(box.state, ctx.record(), 5);
    await pause.acquire();
    await lock.acquire();
    try {
      assertEquals(await py.call('worktree_sync_shim', 'op', ['lock', 'catch_up', null, [ctx.keys[0]]]), 'paused');
      assertEquals(await py.call('worktree_sync_shim', 'op', ['lock', 'sync_chat', null, [ctx.keys[0], { 'g.txt': null }]]), 'busy');
      assertEquals(await py.call('worktree_sync_shim', 'op', ['lock', 'merge_pending', 'c0', []]), 'busy');
      assertEquals(text(ctx.wts[0], 'g.txt'), 'g1\ng2\n');
    } finally {
      lock.release();
      pause.release();
    }
    assertEquals(await py.call('worktree_sync_shim', 'op', ['lock', 'catch_up', null, [ctx.keys[0]]]), 'ok');
    assertEquals(text(ctx.wts[0], 'g.txt'), 'g1-user\ng2\n');
    assertEquals(ctx.record().syncedPaths, ['f.txt', 'g.txt'], 'one record, written by both');
  } finally {
    sync.settings.WORKTREE_WAIT = saved;
    await py.call('worktree_sync_shim', 'set_attr', ['WORKTREE_WAIT', 3]);
    await py.call('worktree_sync_shim', 'close', ['lock']);
  }
});

Deno.test('the pause-flag lock (sync-state.lock) excludes Python and the port both ways (interop)', async () => {
  using box = new Sandbox(false);
  await using py = new PyParity();
  const project = pathOf(box.base, 'proj');
  Deno.mkdirSync(project, { recursive: true });
  const lock = sync.syncFlagLock(box.state);
  await lock.acquire();
  try {
    const reply = await py.raw('worktree_sync', 'set_paused', [box.state, project, 7]);
    assert('error' in reply && reply.error === 'TimeoutError', JSON.stringify(reply));
  } finally {
    lock.release();
  }
  await py.call('worktree_sync', 'set_paused', [box.state, project, 7]);
  assertEquals(sync.pauseInfo(box.state, project)!.count, 7);
  const child = new Deno.Command(python(), {
    args: ['-c', FLAG_HOLDER, APP_DIR, box.state],
    stdin: 'piped',
    stdout: 'piped',
    stderr: 'inherit',
    env: { AGENT_STUDIO_TEST: '1' },
  }).spawn();
  const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
  let got = '';
  while (!got.includes('held')) got += (await reader.read()).value ?? '';
  try {
    const error = await assertRejects(() => sync.resumeSync(box.state, project));
    assertEquals(error.message, 'Timed out waiting for the state file lock (sync-state.lock)');
    assert(sync.pauseInfo(box.state, project) !== null);
  } finally {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode('\n'));
    await writer.close();
    reader.releaseLock();
    await child.stdout.cancel().catch(() => {});
    await child.status;
  }
  assertEquals(await sync.resumeSync(box.state, project), true);
  assertEquals(await py.call('worktree_sync', 'pause_info', [box.state, project]), null);
});

const FLAG_HOLDER = `
import sys
sys.path.insert(0, sys.argv[1])
import worktree_sync
lock = worktree_sync._flag_lock(sys.argv[2])
lock.acquire()
print('held', flush=True)
sys.stdin.readline()
lock.release()
`;

// ---- parity: the same edits on identical repos ----------------------------------------------------------------------------
Deno.test('parity: the same user and chat edits give the same worktrees, commits, records, notes and pause state as Python', async () => {
  await using py = new PyParity();
  using box = new Sandbox(false);
  setFixedDates(true);
  await py.call('worktrees_shim', 'set_env', [FIXED_DATES]);
  const key = '0123456789abcdef0123456789abcdef';
  try {
    const sides = ['py', 'deno'].map((name) => {
      const project = makeRepo(pathOf(box.base, name, 'proj'));
      runGit(project, 'config', 'core.autocrlf', 'false');
      write(project, '.gitignore', 'ignored.log\nbuild/\nnode_modules/\n.env\n');
      write(project, 'f.txt', LINES);
      write(project, 'g.txt', 'g1\ng2\n');
      write(project, 'n.txt', 'n1\nn2\nn3\nn4\n');
      write(project, 'bin.dat', new Uint8Array([0, 98, 0]));
      runGit(project, 'add', '-A');
      runGit(project, 'commit', '-q', '-m', 'files');
      write(project, '.env', 'A=1\n');
      return { name, project, state: pathOf(box.base, name, 'state'), wt: '' };
    });
    const [pySide, denoSide] = sides;
    const pyPlan = await py.call('worktrees_shim', 'manager', [pySide.state, 'plan', [pySide.project, key]]) as Record<string, unknown>;
    await py.call('worktrees_shim', 'manager', [pySide.state, 'create', [pyPlan]]);
    pySide.wt = pyPlan.path as string;
    const manager = new wt.Manager(denoSide.state);
    const plan = (await manager.plan(denoSide.project, key))!;
    await manager.create(plan);
    denoSide.wt = plan.path;
    await py.call('worktree_sync_shim', 'open', ['parity', pySide.state, [{ id: 'c1', cwd: pySide.wt }]]);
    const conn = new Conn(denoSide.wt);
    const studio = {
      stateDir: denoSide.state,
      worktrees: manager,
      settings: { worktreePerChat: () => true },
      connections: new Map([['c1', conn]]),
    };
    const live = new LiveSync(studio, sync.settings.SETTLE, sync.settings.POLL, false);
    const ps = new ProjectSync(live, denoSide.project);

    const files = (root: string): Record<string, string> => {
      const out: Record<string, string> = {};
      const walk = (folder: string, rel: string) => {
        for (const entry of [...Deno.readDirSync(folder)].sort((a, b) => (a.name < b.name ? -1 : 1))) {
          if (entry.name === '.git') continue;
          const sub = rel ? `${rel}/${entry.name}` : entry.name;
          if (entry.isDirectory) walk(pathOf(folder, entry.name), sub);
          else out[sub] = new TextDecoder().decode(Deno.readFileSync(pathOf(folder, entry.name)));
        }
      };
      walk(root, '');
      return out;
    };
    const strip = (r: Record<string, unknown>) => {
      const { path: _p, project: _q, pid: _i, created: _c, ...rest } = r;
      return rest;
    };
    const pauseOf = (info: Record<string, unknown> | null) => (info ? { paused: info.paused, count: info.count } : null);
    const trail: unknown[] = [];

    /** One step on both sides: the edits, then the same live-sync calls; everything observable must match. */
    const both = async (label: string, edit: (side: typeof pySide) => void, calls: [string, ...unknown[]][]) => {
      for (const side of sides) edit(side);
      for (const [method, ...args] of calls) {
        let fromPy: unknown, fromDeno: unknown;
        if (method === 'scan') {
          fromPy = await py.call('worktree_sync_shim', 'scan', ['parity', pySide.project]);
          await ps.lock.run(() => ps.scan());
          fromDeno = { waiting: ps.waiting, wasPaused: ps.wasPaused, reset: ps.reset };
        } else if (method === 'resume') {
          fromPy = await py.call('worktree_sync', 'resume', [pySide.state, pySide.project]);
          fromDeno = await sync.resumeSync(denoSide.state, denoSide.project);
        } else {
          const withChat = ['merge_pending', 'turn_started', 'turn_ended', 'finish_turn', 'context_for', 'context_sent'].includes(method);
          fromPy = await py.call('worktree_sync_shim', 'op', ['parity', method, withChat ? 'c1' : null, withChat ? args : [key, ...args]]);
          const camel = method.replace(/_(.)/g, (_, c) => c.toUpperCase());
          const fn = (live as unknown as Record<string, (...a: unknown[]) => unknown>)[camel].bind(live);
          fromDeno = await (withChat ? fn(conn, ...args) : fn(key, ...args));
          if (method === 'context_for' && fromDeno) fromDeno = JSON.parse(JSON.stringify(fromDeno));
        }
        assertEquals(fromDeno ?? null, fromPy ?? null, `${label}: ${method}`);
        trail.push(fromDeno ?? null);
      }
      assertEquals(files(denoSide.wt), files(pySide.wt), `${label}: worktree files`);
      const pyRecord = await py.call('worktrees_shim', 'registry', [pySide.state, 'get', [key]]) as Record<string, unknown>;
      assertEquals(
        JSON.parse(JSON.stringify(strip(manager.registry.get(key)!))),
        strip(pyRecord),
        `${label}: record (U, notes, pending...)`,
      );
      assertEquals(
        pauseOf(sync.pauseInfo(denoSide.state, denoSide.project)),
        pauseOf(await py.call('worktree_sync', 'pause_info', [pySide.state, pySide.project]) as Record<string, unknown> | null),
        `${label}: pause`,
      );
      assertEquals(
        runGit(denoSide.project, 'log', '--format=%H %s', '--all'),
        runGit(pySide.project, 'log', '--format=%H %s', '--all'),
        `${label}: commits`,
      );
    };

    await both('baseline', () => {}, [['scan'], ['catch_up']]);
    await both('saves', (s) => {
      write(s.project, 'f.txt', USER_EDIT);
      write(s.project, 'deep/new.txt', 'new\n');
      Deno.removeSync(pathOf(s.project, 'tracked.txt'));
    }, [['scan'], ['scan'], ['context_for']]);
    await both('note sent', () => {}, [['context_sent', { paths: ['f.txt', 'tracked.txt', 'deep/new.txt'], notes: [] }]]);
    await both('clean merge', (s) => {
      write(s.wt, 'f.txt', BOTH);
      write(s.project, 'f.txt', 'A-user\nb\nc-user\nd\ne\nf\n');
    }, [['scan'], ['scan'], ['merge_pending', true], ['context_for']]);
    await both('conflict', (s) => {
      write(s.wt, 'g.txt', 'g1\ng2-chat\n');
      write(s.project, 'g.txt', 'g1\ng2-user\n');
    }, [['scan'], ['scan'], ['merge_pending', true], ['context_for']]);
    await both('blocked by the clash', (s) => write(s.project, 'n.txt', 'n1\nn2\nn3\nn4-user\n'), [['scan'], ['scan']]);
    await both('resolved', (s) => write(s.wt, 'g.txt', 'g1\ng2-both\n'), [['merge_pending', true], ['scan'], ['context_for']]);
    await both('binary and env', (s) => {
      write(s.wt, 'bin.dat', new Uint8Array([0, 99, 0]));
      write(s.project, 'bin.dat', new Uint8Array([0, 117, 0]));
      write(s.wt, '.env', 'MINE=1\n');
      write(s.project, '.env', 'A=2\n');
    }, [['catch_up'], ['merge_pending', true], ['context_for']]);
    await both('turn starts', () => {}, [['turn_started']]);
    await both('stale write', (s) => write(s.project, 'n.txt', 'n1-user\nn2\nn3\nn4-user\n'), [['scan'], ['scan']]);
    await both('turn ends', (s) => write(s.wt, 'n.txt', 'n1\nn2\nn3\nn4-chat\n'), [['turn_ended'], ['context_for']]);
    await both('storm', (s) => {
      for (let n = 0; n < sync.STORM + 5; n++) write(s.project, `s/${n}.txt`, `${n}\n`);
    }, [['scan'], ['scan'], ['catch_up']]);
    await both('resume', () => {}, [['resume'], ['scan'], ['scan']]);
    await both('rename and delete', (s) => {
      Deno.renameSync(pathOf(s.project, 'deep/new.txt'), pathOf(s.project, 'deep/renamed.txt'));
      Deno.removeSync(pathOf(s.project, 's/3.txt'));
    }, [['scan'], ['scan'], ['context_for']]);
    assert(trail.some((t) => t === 'ok'), 'the steps did something');
  } finally {
    setFixedDates(false);
    await py.call('worktrees_shim', 'set_env', [{ GIT_AUTHOR_DATE: null, GIT_COMMITTER_DATE: null }]);
    await py.call('worktree_sync_shim', 'close', ['parity']);
  }
});
