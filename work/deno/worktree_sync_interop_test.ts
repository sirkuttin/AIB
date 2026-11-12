/**
 * server/worktrees/sync.ts, second half of worktree_sync_test.ts (split so the two halves run in parallel): three_way against
 * Python, the real loop with the folder watcher, the cross-process locks in both directions, and parity with Python on identical
 * repos (the same sequence of user and chat edits synced by Python's code and by the port gives the same worktree files, commits,
 * records, notes and pause state).
 */
import { assert, assertEquals, assertRejects } from './_assert.ts';
import { PyParity, python } from './_parity.ts';
import { FIXED_DATES, makeRepo, pythonHolds, runGit, Sandbox, setFixedDates, write } from './_worktree_fixtures.ts';
import { BOTH, CHAT_EDIT, Conn, list, LiveSync, LINES, ProjectSync, setup, text, until, USER_EDIT, WIN } from './_sync_fixtures.ts';
import * as wt from '../../outputs/agent-studio/server/worktrees/worktrees.ts';
import * as sync from '../../outputs/agent-studio/server/worktrees/sync.ts';
import { pathOf } from '../../outputs/agent-studio/server/state/paths.ts';

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
      const { path: _p, project: _q, pid: _i, created: _c, editsFrom: _e, ...rest } = r; // editsFrom: Deno only
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
