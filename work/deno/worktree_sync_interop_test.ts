/**
 * server/worktrees/sync.ts, second half of worktree_sync_test.ts (split so the two halves run in parallel): three_way against
 * the answers the retired Python gave, the real loop with the folder watcher, the cross-process locks in both directions (the other
 * process is work/lock_helper.py), and the same sequence of user and chat edits on identical repos giving the worktree files,
 * commits, records, notes and pause state the retired Python gave at every step (kept as fingerprints, fixtures/frozen).
 */
import { assert, assertEquals, assertRejects } from './_assert.ts';
import { python } from './_work.ts';
import { Frozen } from './_frozen.ts';
import { FIXED_DATES, foreignHolds, foreignProbe, makeRepo, runGit, Sandbox, setFixedDates, write } from './_worktree_fixtures.ts';
import { BOTH, CHAT_EDIT, Conn, list, LiveSync, LINES, ProjectSync, setup, text, until, USER_EDIT, WIN } from './_sync_fixtures.ts';
import * as wt from '../../app/server/worktrees/worktrees.ts';
import * as sync from '../../app/server/worktrees/sync.ts';
import { pathOf } from '../../app/server/state/paths.ts';

Deno.test('three_way gives what Python gave on every kind', async () => {
  const py = new Frozen();
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
      const [pyKind, pyData] = await py.frozenList(`three-way-${JSON.stringify([base, current, other])}`) as [string, string | null];
      assertEquals([kind, data === null ? null : new TextDecoder().decode(data)], [pyKind, pyData], JSON.stringify([base, current, other]));
    }
  } finally {
    Deno.removeSync(scratch, { recursive: true });
  }
});

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

// ---- cross-process locks (the other process is work/lock_helper.py) --------------------------------------------------------
Deno.test("another process's pause and worktree locks stop the port's sync, and the port's locks stop another process", async () => {
  using box = new Sandbox();
  const ctx = await setup(box, 1, true);
  const saved = sync.settings.WORKTREE_WAIT;
  sync.settings.WORKTREE_WAIT = 0.3;
  try {
    write(box.project, 'f.txt', USER_EDIT);
    const holder = await foreignHolds(box.state, box.project, ctx.record());
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

    // the other way: the port holds them, so another process cannot take either lock and the worktree is left alone
    write(box.project, 'g.txt', 'g1-user\ng2\n');
    const pause = wt.pauseLock(box.state, box.project, 5);
    const lock = wt.worktreeLock(box.state, ctx.record(), 5);
    await pause.acquire();
    await lock.acquire();
    try {
      assertEquals(await foreignProbe(box.state, box.project, ctx.record(), 'probe'), { pause: 'held', worktree: 'held', paused: true });
      assertEquals(text(ctx.wts[0], 'g.txt'), 'g1\ng2\n');
    } finally {
      lock.release();
      pause.release();
    }
    assertEquals(await foreignProbe(box.state, box.project, ctx.record(), 'probe'), { pause: 'free', worktree: 'free', paused: false });
    assertEquals(await ctx.live.catchUp(ctx.keys[0]), 'ok');
    assertEquals(text(ctx.wts[0], 'g.txt'), 'g1-user\ng2\n');
    assertEquals(ctx.record().syncedPaths, ['f.txt', 'g.txt'], 'one record, written by both runs of catch-up');
  } finally {
    sync.settings.WORKTREE_WAIT = saved;
  }
});

const LOCK_HELPER = decodeURIComponent(new URL('../lock_helper.py', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');

Deno.test('the pause-flag lock (sync-state.lock) excludes another process and the port both ways', async () => {
  using box = new Sandbox(false);
  const project = pathOf(box.base, 'proj');
  Deno.mkdirSync(project, { recursive: true });
  const flagLock = sync.syncFlagLock(box.state);
  const foreignCanLock = async (seconds: number) =>
    new TextDecoder().decode((await new Deno.Command(python(), { args: ['-I', LOCK_HELPER, 'try', flagLock.path, String(seconds)] }).output()).stdout)
      .trim() === 'yes';
  await flagLock.acquire();
  try {
    assertEquals(await foreignCanLock(0.3), false, 'another process got the flag lock the port holds');
  } finally {
    flagLock.release();
  }
  assertEquals(await foreignCanLock(0.3), true);
  await sync.setPaused(box.state, project, 7);
  assertEquals(sync.pauseInfo(box.state, project)!.count, 7);
  const child = new Deno.Command(python(), {
    args: ['-I', LOCK_HELPER, 'hold', flagLock.path],
    stdin: 'piped',
    stdout: 'piped',
    stderr: 'inherit',
  }).spawn();
  const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
  let got = '';
  while (!got.includes('locked')) got += (await reader.read()).value ?? '';
  try {
    const error = await assertRejects(() => sync.resumeSync(box.state, project));
    assertEquals(error.message, 'Timed out waiting for the state file lock (sync-state.lock)');
    assert(sync.pauseInfo(box.state, project) !== null);
  } finally {
    await child.stdin.close();
    reader.releaseLock();
    await child.stdout.cancel().catch(() => {});
    await child.status;
  }
  assertEquals(await sync.resumeSync(box.state, project), true);
  assertEquals(sync.pauseInfo(box.state, project), null);
});

// ---- parity: the same edits on identical repos ----------------------------------------------------------------------------
Deno.test('the same user and chat edits give the worktrees, commits, records, notes and pause state Python gave at every step', async () => {
  const py = new Frozen();
  using box = new Sandbox(false);
  setFixedDates(true);
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
    // Python's side is made lazily, only while freezing (the first step that asks it)
    let pyReady: Promise<void> | null = null;
    const ensurePy = () =>
      pyReady ??= (async () => {
        const pyPlan = await py.call('worktrees_shim', 'manager', [pySide.state, 'plan', [pySide.project, key]]) as Record<string, unknown>;
        await py.call('worktrees_shim', 'manager', [pySide.state, 'create', [pyPlan]]);
        pySide.wt = pyPlan.path as string;
        await py.call('worktree_sync_shim', 'open', ['parity', pySide.state, [{ id: 'c1', cwd: pySide.wt }]]);
      })();
    const manager = new wt.Manager(denoSide.state);
    const plan = (await manager.plan(denoSide.project, key))!;
    await manager.create(plan);
    denoSide.wt = plan.path;
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

    const observe = (fromCalls: unknown[], root: string, record: Record<string, unknown>, pause: Record<string, unknown> | null, project: string) => ({
      calls: fromCalls,
      files: files(root),
      record: JSON.parse(JSON.stringify(strip(record))),
      pause: pauseOf(pause),
      commits: runGit(project, 'log', '--format=%H %s', '--all'),
    });

    /** One step: the edits, then the live-sync calls; everything observable must be what Python gave (one fingerprint per step). */
    const both = async (label: string, edit: (side: typeof pySide) => void, calls: [string, ...unknown[]][]) => {
      edit(denoSide);
      const fromDeno: unknown[] = [];
      for (const [method, ...args] of calls) {
        let one: unknown;
        if (method === 'scan') {
          await ps.lock.run(() => ps.scan());
          one = { waiting: ps.waiting, wasPaused: ps.wasPaused, reset: ps.reset };
        } else if (method === 'resume') {
          one = await sync.resumeSync(denoSide.state, denoSide.project);
        } else {
          const withChat = ['merge_pending', 'turn_started', 'turn_ended', 'finish_turn', 'context_for', 'context_sent'].includes(method);
          const camel = method.replace(/_(.)/g, (_, c) => c.toUpperCase());
          const fn = (live as unknown as Record<string, (...a: unknown[]) => unknown>)[camel].bind(live);
          one = await (withChat ? fn(conn, ...args) : fn(key, ...args));
          if (method === 'context_for' && one) one = JSON.parse(JSON.stringify(one));
        }
        fromDeno.push(one ?? null);
        trail.push(one ?? null);
      }
      const mine = observe(
        fromDeno,
        denoSide.wt,
        manager.registry.get(key)!,
        sync.pauseInfo(denoSide.state, denoSide.project),
        denoSide.project,
      );
      const theirs = async () => {
        await ensurePy();
        edit(pySide);
        const fromPy: unknown[] = [];
        for (const [method, ...args] of calls) {
          if (method === 'scan') fromPy.push(await py.call('worktree_sync_shim', 'scan', ['parity', pySide.project]) ?? null);
          else if (method === 'resume') fromPy.push(await py.call('worktree_sync', 'resume', [pySide.state, pySide.project]) ?? null);
          else {
            const withChat = ['merge_pending', 'turn_started', 'turn_ended', 'finish_turn', 'context_for', 'context_sent'].includes(method);
            fromPy.push(await py.call('worktree_sync_shim', 'op', ['parity', method, withChat ? 'c1' : null, withChat ? args : [key, ...args]]) ?? null);
          }
        }
        return observe(
          fromPy,
          pySide.wt,
          await py.call('worktrees_shim', 'registry', [pySide.state, 'get', [key]]) as Record<string, unknown>,
          await py.call('worktree_sync', 'pause_info', [pySide.state, pySide.project]) as Record<string, unknown> | null,
          pySide.project,
        );
      };
      assertEquals(mine, await py.frozen(`parity-${label}`), label);
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
  }
});
