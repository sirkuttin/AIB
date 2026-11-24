/**
 * Remove AIB from a distro, the Windows side (wsl/remove.ts, wsl/removed.ts, web/wsl_routes.ts; docs/wsl/linking-design.md section
 * 13), with no distro: FakeWslHost (work/deno/_wsl_fake.ts) answers aib.usage / aib.remove, and a RecordingHost adds what a real host
 * has (keep-alive, keeper shutdown, stop) and writes down every step in order.
 *   1. GET /api/live/wsl/aib: the two shapes, peek never starts a distro, start=1 does, chatsWorking from Studio's busy chats, an old
 *      helper's line.
 *   2. POST /api/live/wsl/aib/remove: 400s (distro, mode, confirm), 409 when not running (never a start), 'check' (the page's shape:
 *      no helper-only `final`), 'apply' in the exact order: check, flag, keep-alive, apply, keeper, stop, last step, chat copies.
 *   3. The removed flag: no host for the distro (wslHost, peekWslHost, hostWhenReady says why), status removed + 'off', the next
 *      start=1 / Reconnect clears it; kept in the state folder across a restart; wslIsRemoved for the deleted chat copies.
 *   4. Refusals and failures: Windows' own (a working chat, live chats or terminals, a sign-in terminal, an install job), the helper's
 *      at check (nothing changes) and at apply (flag undone, keep-alive back), the helper failing mid-way (stopped, flag kept, no
 *      last step), the keeper not stopping, the last step failing.
 *   5. The test guard (a real host's root must be the test's /tmp/aib-wsl-test-* AIB_WSL_ROOT) and the last step's arguments.
 */
import { assert, assertEquals, assertRejects } from './_assert.ts';
import { FakeWslHost } from './_wsl_fake.ts';
import { hostWhenReady, peekWslHost, removedLine, setDistroSource, setWslHostResolver, wslHost } from '../../app/server/wsl/access.ts';
import { wslRoutes } from '../../app/server/web/wsl_routes.ts';
import type { WebContext } from '../../app/server/web/server.ts';
import type { AibRemoveResult, WslHost } from '../../app/server/wsl/contract.ts';
import { WslHelperError } from '../../app/server/wsl/contract.ts';
import {
  FINAL_CLEANUP_SCRIPT,
  finalArgs,
  parseFinal,
  removeAib,
  type RemoveSteps,
  setFinalRunnerForTests,
  testGuard,
  windowsRefusals,
} from '../../app/server/wsl/remove.ts';
import {
  addRemovedWorktrees,
  clearDistroRemoved,
  FILE,
  isDistroRemoved,
  markDistroRemoved,
  setRemovedDir,
} from '../../app/server/wsl/removed.ts';
import { wslIsRemoved } from '../../app/server/wsl/worktrees.ts';
import { followInstalls, resetInstallProgress } from '../../app/server/wsl/agent_install.ts';
import type { WslInstall } from '../../app/server/wsl/install.ts';

type Json = Record<string, unknown>;
const T = { sanitizeResources: false, sanitizeOps: false };
const TEST_ROOT = '/tmp/aib-wsl-test-linking-remove';
Deno.env.set('AGENT_STUDIO_TEST', '1');
Deno.env.set('AIB_WSL_ROOT', TEST_ROOT);
setRemovedDir(null); // memory only, unless a test names a folder
const temps: string[] = [];
const temp = () => {
  const dir = Deno.makeTempDirSync({ prefix: 'aib-wsl-remove-' });
  temps.push(dir);
  return dir;
};
globalThis.addEventListener('unload', () => {
  for (const dir of temps) {
    try {
      Deno.removeSync(dir, { recursive: true });
    } catch { /* gone */ }
  }
});

/** A host the way wsl/hosts.ts makes it, with the steps a real one has, each written down in `steps`. */
class RecordingHost extends FakeWslHost {
  readonly steps: string[] = [];
  starts = 0;
  begun = true;
  live = 0;
  keeperStops = true;
  install: WslInstall | null = null;
  override start(): Promise<void> {
    this.starts++;
    this.begun = true;
    this.state = 'ready';
    return Promise.resolve();
  }
  releaseHold(): Promise<void> {
    this.steps.push('releaseHold');
    return Promise.resolve();
  }
  keepAlive(): void {
    this.steps.push('keepAlive');
  }
  shutdownKeeper(): Promise<{ ok: boolean; live: number; message: string }> {
    this.steps.push('shutdownKeeper');
    return Promise.resolve(this.keeperStops ? { ok: true, live: 0, message: '' } : { ok: false, live: 1, message: '1 chat(s) or terminal(s) still run in Ubuntu' });
  }
  stop(): void {
    this.steps.push('stop');
    this.state = 'stopped';
  }
  liveCount(): Promise<number> {
    return Promise.resolve(this.live);
  }
  override call<M extends Parameters<WslHost['call']>[0]>(method: M, params: Parameters<WslHost['call']>[1]) {
    if (method === 'aib.remove') this.steps.push(`aib.remove ${(params as Json).mode}${isDistroRemoved('ubuntu') ? ' (flag set)' : ''}`);
    return super.call(method, params as never) as ReturnType<WslHost['call']>;
  }
}

function withHost(host: FakeWslHost | null): void {
  setWslHostResolver((d) => (host && d === host.distro.toLowerCase() ? host : null));
  setDistroSource(() => Promise.resolve([{ name: 'Ubuntu', version: 2, isDefault: true }]));
}

function ctxOf(o: { busy?: Json[]; terminals?: { key: string }[] } = {}): WebContext {
  return {
    token: 't',
    stateDir: null,
    terminals: { list: () => o.terminals ?? [] },
    host: { busyConnections: () => Promise.resolve(o.busy ?? []) },
  } as unknown as WebContext;
}

async function route(ctx: WebContext, method: 'GET' | 'POST', path: string, query = '', body: Json | null = null): Promise<[number, Json]> {
  const handler = wslRoutes().get(`${method} ${path}`)!;
  assert(handler, `${method} ${path} is a route`);
  const url = new URL(`http://127.0.0.1${path}${query ? '?' + query : ''}`);
  const [status, out] = await handler(ctx, url, body, new Request(url, { headers: { 'X-Studio-Token': 't' } }));
  return [status, out as Json];
}

function reset(): void {
  clearDistroRemoved('ubuntu');
  setRemovedDir(null);
  setFinalRunnerForTests(null);
  resetInstallProgress();
}

// ---- 1. GET /api/live/wsl/aib -----------------------------------------------------------------------------------------------

Deno.test('aib usage route: peek never starts a distro; ready gives AibUsage with chatsWorking; start=1 starts', T, async () => {
  reset();
  withHost(null);
  assertEquals(await route(ctxOf(), 'GET', '/api/live/wsl/aib', 'distro=Ubuntu&peek=1'), [200, { distro: 'ubuntu', name: 'Ubuntu', state: 'off', line: '', usage: null }]);
  const host = new RecordingHost(temp());
  host.begun = false;
  host.state = 'stopped';
  withHost(host);
  const [, off] = await route(ctxOf(), 'GET', '/api/live/wsl/aib', 'distro=Ubuntu&peek=1');
  assertEquals([off.state, off.usage, host.starts], ['off', null, 0]);
  assert(!host.calls.some(([m]) => m === 'aib.usage'), 'peek asks nothing of the helper');
  const busy = [{ cwd: 'wsl://ubuntu/home/u/app', state: 'working' }, { cwd: 'wsl://debian/home/u/x', state: 'working' }, { cwd: 'C:\\x', state: 'working' }];
  const [status, ready] = await route(ctxOf({ busy }), 'GET', '/api/live/wsl/aib', 'distro=Ubuntu&peek=1&start=1');
  assertEquals(status, 200);
  assertEquals(host.starts, 1);
  assertEquals([ready.distro, ready.name, ready.state, ready.line], ['ubuntu', 'Ubuntu', 'ready', '']);
  const usage = ready.usage as Json;
  for (const k of ['root', 'totalBytes', 'current', 'parts', 'versions', 'agents', 'dataFolders', 'worktrees', 'chatsWorking']) assert(k in usage, k);
  assertEquals(usage.chatsWorking, 1);
  // a ready host and peek: answered without a start
  const [, again] = await route(ctxOf(), 'GET', '/api/live/wsl/aib', 'distro=Ubuntu&peek=1');
  assertEquals([again.state, host.starts], ['ready', 1]);
  host.handlers['aib.usage'] = () => {
    throw new WslHelperError('No method aib.usage', 'unknown_method');
  };
  const [, old] = await route(ctxOf(), 'GET', '/api/live/wsl/aib', 'distro=Ubuntu&peek=1');
  assertEquals(old.usage, null);
  assert(/too old/.test(String(old.line)));
  assertEquals((await route(ctxOf(), 'GET', '/api/live/wsl/aib', 'distro=bad name'))[0], 400);
});

// ---- 2. POST /api/live/wsl/aib/remove ------------------------------------------------------------------------------------------

Deno.test('aib remove route: 400s, 409 without a start, the check shape', T, async () => {
  reset();
  const host = new RecordingHost(temp());
  withHost(host);
  const ctx = ctxOf();
  assertEquals((await route(ctx, 'POST', '/api/live/wsl/aib/remove', '', { distro: '', mode: 'check' }))[0], 400);
  assertEquals((await route(ctx, 'POST', '/api/live/wsl/aib/remove', '', { distro: 'Ubuntu', mode: 'everything' }))[1].code, 'bad_mode');
  assertEquals((await route(ctx, 'POST', '/api/live/wsl/aib/remove', '', { distro: 'Ubuntu', mode: 'apply' }))[1].code, 'confirm_needed');
  assertEquals((await route(ctx, 'POST', '/api/live/wsl/aib/remove', '', { distro: 'Ubuntu', mode: 'apply', confirm: 'yes' }))[1].code, 'confirm_needed');
  assertEquals(host.steps, []);

  const [status, check] = await route(ctx, 'POST', '/api/live/wsl/aib/remove', '', { distro: 'Ubuntu', mode: 'check' });
  assertEquals(status, 200);
  assertEquals(Object.keys(check).sort(), ['blocked', 'kept', 'left', 'mode', 'ok', 'removed', 'wouldRemove']);
  assertEquals([check.ok, check.mode, check.blocked, check.removed, check.left], [true, 'check', [], [], []]);
  assertEquals(host.steps, ['aib.remove check']);
  assert(!isDistroRemoved('ubuntu'), 'check changes nothing');

  const asleep = new RecordingHost(temp());
  asleep.begun = false;
  asleep.state = 'stopped';
  withHost(asleep);
  const [code, refused] = await route(ctx, 'POST', '/api/live/wsl/aib/remove', '', { distro: 'Ubuntu', mode: 'check' });
  assertEquals([code, refused.code, asleep.starts, asleep.steps], [409, 'wsl_unavailable', 0, []]);
  withHost(null);
  assertEquals((await route(ctx, 'POST', '/api/live/wsl/aib/remove', '', { distro: 'Ubuntu', mode: 'apply', confirm: true }))[0], 409);
});

Deno.test('aib remove route: apply runs check, flag, keep-alive, apply, keeper, stop, in that order; then the flag holds', T, async () => {
  reset();
  const host = new RecordingHost(temp());
  const copy = '/home/u/.aib-server/data-0123456789ab/worktrees/aaaa1111/chat-abcd1234';
  host.handlers['aib.remove'] = (p) => ({
    ok: true,
    mode: p.mode,
    blocked: [],
    wouldRemove: [{ path: '/home/u/.aib-server/data-0123456789ab', what: 'data', bytes: 1 }],
    kept: [],
    removed: p.mode === 'apply' ? ['/home/u/.aib-server/data-0123456789ab/worktrees'] : [],
    left: [],
    ...(p.mode === 'apply' ? { final: { data: 'data-0123456789ab', version: null, root: false, copies: [{ path: copy, project: '/home/u/app', branch: 'studio/chat-abcd1234', session: 'claude:s1' }] } } : {}),
  });
  withHost(host);
  const [status, out] = await route(ctxOf(), 'POST', '/api/live/wsl/aib/remove', '', { distro: 'Ubuntu', mode: 'apply', confirm: true });
  assertEquals(status, 200);
  assertEquals(out.ok, true, JSON.stringify(out));
  assertEquals(host.steps, ['aib.remove check', 'releaseHold', 'aib.remove apply (flag set)', 'shutdownKeeper', 'stop']);
  assert(!('final' in out), 'the helper-only part never reaches the page');
  assertEquals(out.removed, ['/home/u/.aib-server/data-0123456789ab/worktrees']);

  // the flag: no host, no start, the line says what to do; status says removed and off
  assert(isDistroRemoved('ubuntu'));
  assertEquals([wslHost('Ubuntu'), peekWslHost('ubuntu')], [null, null]);
  const why = await assertRejects(() => hostWhenReady('ubuntu', 1000));
  assertEquals(why.message, removedLine('Ubuntu'));
  const [, status2] = await route(ctxOf(), 'GET', '/api/live/wsl/status');
  const d = (status2.distros as Json[])[0];
  assertEquals([d.key, d.state, d.removed], ['ubuntu', 'off', true]);
  const [, card] = await route(ctxOf(), 'GET', '/api/live/wsl/aib', 'distro=Ubuntu&peek=1');
  assertEquals([card.state, card.usage], ['off', null]);
  assertEquals((await route(ctxOf(), 'POST', '/api/live/wsl/aib/remove', '', { distro: 'Ubuntu', mode: 'apply', confirm: true }))[0], 409);
  // the deleted chat copy reads as removed, without asking the distro
  const before = host.calls.length;
  assertEquals(await wslIsRemoved(`wsl://ubuntu${copy}`), true);
  assertEquals(await wslIsRemoved('wsl://ubuntu/home/u/app', 'claude:s1'), true);
  assertEquals(host.calls.length, before);
  // "Set up again": start=1 clears the flag and starts
  const starts = host.starts;
  const [, again] = await route(ctxOf(), 'GET', '/api/live/wsl/aib', 'distro=Ubuntu&peek=1&start=1');
  assertEquals([isDistroRemoved('ubuntu'), again.state, host.starts > starts || host.state === 'ready'], [false, 'ready', true]);
  assertEquals((await route(ctxOf(), 'GET', '/api/live/wsl/status'))[1].distros && ((await route(ctxOf(), 'GET', '/api/live/wsl/status'))[1].distros as Json[])[0].removed, false);
  // Reconnect is a start too
  markDistroRemoved('ubuntu');
  const [, rec] = await route(ctxOf(), 'POST', '/api/live/wsl/reconnect', '', { distro: 'Ubuntu' });
  assertEquals([rec.ok, isDistroRemoved('ubuntu')], [true, false]);
});

// ---- 3. the flag's file -----------------------------------------------------------------------------------------------------

Deno.test('removed flag: kept in the state folder (a restart keeps it), cleared by the start; chat copies stay remembered', T, () => {
  reset();
  const dir = Deno.makeTempDirSync({ prefix: 'aib-wsl-removed-' });
  setRemovedDir(dir);
  markDistroRemoved('Ubuntu');
  addRemovedWorktrees('ubuntu', [{ path: '/r/data-x/worktrees/a/chat-1', project: '/p', branch: 'studio/chat-1', session: 'codex:z' }]);
  const saved = JSON.parse(Deno.readTextFileSync(`${dir}/${FILE}`));
  assert(saved.distros.ubuntu && saved.worktrees.ubuntu.length === 1);
  setRemovedDir(null); // "another process": memory empty
  assertEquals(isDistroRemoved('ubuntu'), false);
  setRemovedDir(dir); // reads the file again
  assertEquals(isDistroRemoved('UBUNTU'), true);
  clearDistroRemoved('ubuntu');
  assertEquals(isDistroRemoved('ubuntu'), false);
  assertEquals(JSON.parse(Deno.readTextFileSync(`${dir}/${FILE}`)).worktrees.ubuntu.length, 1);
  setRemovedDir(null);
  Deno.removeSync(dir, { recursive: true });
});

// ---- 4. refusals and failures --------------------------------------------------------------------------------------------------

/** Steps that write down their order; each can be told to fail. */
function recordingSteps(o: {
  refusals?: string[];
  check?: Partial<AibRemoveResult>;
  apply?: Partial<AibRemoveResult> | Error;
  keeper?: boolean;
  final?: { removed: string[]; left: string[]; error: string };
  guard?: string;
} = {}): RemoveSteps & { log: string[] } {
  const log: string[] = [];
  const base = (mode: 'check' | 'apply'): AibRemoveResult => ({ ok: true, mode, blocked: [], wouldRemove: [], kept: [], removed: [], left: [] });
  return {
    log,
    refusals: () => Promise.resolve(o.refusals ?? []),
    guard: () => o.guard ?? '',
    call: (mode) => {
      log.push(`call ${mode}`);
      if (mode === 'check') return Promise.resolve({ ...base('check'), ...o.check });
      if (o.apply instanceof Error) return Promise.reject(o.apply);
      return Promise.resolve({ ...base('apply'), removed: ['/r/data-x/worktrees'], final: { data: 'data-0123456789ab', version: '0.1.0-0123abcd', root: true, copies: [] }, ...o.apply });
    },
    markRemoved: () => log.push('mark'),
    undoMark: () => {
      log.push('undo');
      return Promise.resolve();
    },
    releaseHold: () => {
      log.push('releaseHold');
      return Promise.resolve();
    },
    shutdownKeeper: () => {
      log.push('shutdownKeeper');
      return Promise.resolve(o.keeper === false ? { ok: false, live: 1, message: '1 chat(s) or terminal(s) still run in Ubuntu' } : { ok: true, live: 0, message: '' });
    },
    stopHost: () => log.push('stop'),
    finalCleanup: () => {
      log.push('final');
      return Promise.resolve(o.final ?? { removed: ['/r/data-x', '/r/0.1.0-0123abcd', '/r'], left: [], error: '' });
    },
    rememberCopies: () => log.push('copies'),
  };
}

Deno.test('remove order: the full apply, and every refusal or failure leaves the host off or untouched', T, async () => {
  const full = recordingSteps({ apply: { final: { data: 'data-0123456789ab', version: null, root: false, copies: [{ path: '/c', project: '/p', branch: 'b', session: 's' }] } } });
  const done = await removeAib(full, 'apply');
  assertEquals(full.log, ['call check', 'mark', 'releaseHold', 'call apply', 'shutdownKeeper', 'stop', 'final', 'copies']);
  assertEquals(done.ok, true);
  assertEquals(done.removed, ['/r/data-x/worktrees', '/r/data-x', '/r/0.1.0-0123abcd', '/r']);

  const ours = recordingSteps({ refusals: ['A chat of AIB in Ubuntu is working.'] });
  const r1 = await removeAib(ours, 'apply');
  assertEquals([r1.ok, r1.blocked, ours.log], [false, ['A chat of AIB in Ubuntu is working.'], ['call check']]);

  const helperNo = recordingSteps({ check: { ok: false, blocked: ['The chat copy /c has changes'] } });
  const r2 = await removeAib(helperNo, 'apply');
  assertEquals([r2.ok, r2.blocked, helperNo.log], [false, ['The chat copy /c has changes'], ['call check']]);

  const changed = recordingSteps({ apply: { ok: false, blocked: ['A program works in this AIB\'s data folder (process 9 bash). End it, then remove.'] } });
  const r3 = await removeAib(changed, 'apply');
  assertEquals([r3.ok, changed.log], [false, ['call check', 'mark', 'releaseHold', 'call apply', 'undo']]);
  assertEquals(r3.removed, []);

  const crashed = recordingSteps({ apply: new Error('helper_gone') });
  const r4 = await removeAib(crashed, 'apply');
  assertEquals([r4.ok, crashed.log], [false, ['call check', 'mark', 'releaseHold', 'call apply', 'shutdownKeeper', 'stop']]);
  assert(/Set up again, then Remove again/.test(r4.message ?? ''));

  const busy = recordingSteps({ keeper: false });
  const r5 = await removeAib(busy, 'apply');
  assertEquals([r5.ok, busy.log], [false, ['call check', 'mark', 'releaseHold', 'call apply', 'shutdownKeeper', 'stop']]);
  assert(r5.left.some((l) => /data-0123456789ab/.test(l)) && /did not stop/.test(r5.message ?? ''));

  const lastFails = recordingSteps({ final: { removed: [], left: [], error: 'test guard: not a /tmp/aib-wsl-test-* folder' } });
  const r6 = await removeAib(lastFails, 'apply');
  assertEquals(r6.ok, false);
  assert(/The last step did not run: test guard/.test(r6.message ?? ''));

  const partly = recordingSteps({ final: { removed: ['/r/data-x'], left: ['/r/0.1.0-0123abcd: a program still uses it'], error: '' } });
  const r7 = await removeAib(partly, 'apply');
  assertEquals([r7.ok, r7.left], [false, ['/r/0.1.0-0123abcd: a program still uses it']]);
  assert(r7.message);

  // a chat that went live between the first refusals and the flag: refused right after the flag, which is undone
  const late = recordingSteps();
  let asked = 0;
  late.refusals = () => Promise.resolve(asked++ ? ['A chat or terminal still runs in Ubuntu. Close it, then remove.'] : []);
  const r10 = await removeAib(late, 'apply');
  assertEquals([r10.ok, r10.blocked, late.log], [false, ['A chat or terminal still runs in Ubuntu. Close it, then remove.'], ['call check', 'mark', 'undo']]);

  const guarded = recordingSteps({ guard: 'Test guard: Remove under test needs AIB_WSL_ROOT=/tmp/aib-wsl-test-<random>.' });
  const r8 = await removeAib(guarded, 'apply');
  assertEquals([r8.ok, guarded.log], [false, []]);

  const check = recordingSteps();
  const r9 = await removeAib(check, 'check');
  assertEquals([r9.ok, check.log], [true, ['call check']]);
});

Deno.test('windows refusals: working chats, live chats or terminals, a sign-in or Node.js terminal, an install job', T, () => {
  reset();
  const facts = { key: 'ubuntu', name: 'Ubuntu', busy: [] as Json[], terminals: [] as { key: string }[], live: 0 };
  assertEquals(windowsRefusals(facts), []);
  assertEquals(windowsRefusals({ ...facts, busy: [{ cwd: 'wsl://ubuntu/home/u/a' }, { cwd: 'wsl://ubuntu/home/u/b' }, { cwd: 'wsl://debian/x' }] }), [
    '2 chats of AIB in Ubuntu are working. Wait for them to finish, or stop them, then remove.',
  ]);
  assertEquals(windowsRefusals({ ...facts, live: 1 }), ['A chat or terminal still runs in Ubuntu. Close it, then remove.']);
  for (const key of ['signin:claude@ubuntu', 'setup:wsl-node@ubuntu']) {
    assertEquals(windowsRefusals({ ...facts, terminals: [{ key }] }), ['A sign-in or Node.js set-up terminal for Ubuntu is open. Close it, then remove.']);
  }
  assertEquals(windowsRefusals({ ...facts, terminals: [{ key: 'signin:claude@debian' }, { key: 'signin:claude' }] }), []);
  let notify: ((m: string, p: Record<string, unknown>) => void) | null = null;
  followInstalls({ onNotify: (h: (m: string, p: Record<string, unknown>) => void) => ((notify = h), () => {}) } as unknown as WslHost, 'ubuntu');
  notify!('agents.installProgress', { agent: 'codex', state: 'running', stage: 'npm', percent: 40, message: '' });
  assertEquals(windowsRefusals(facts), ['Codex is being installed in Ubuntu right now. Wait for it to finish, or cancel it, then remove.']);
  resetInstallProgress();
});

Deno.test('aib remove route: a working chat in the distro refuses apply before anything changes', T, async () => {
  reset();
  const host = new RecordingHost(temp());
  withHost(host);
  const [, out] = await route(ctxOf({ busy: [{ cwd: 'wsl://ubuntu/home/u/app', state: 'working' }] }), 'POST', '/api/live/wsl/aib/remove', '', { distro: 'Ubuntu', mode: 'apply', confirm: true });
  assertEquals(out.ok, false);
  assert((out.blocked as string[]).some((b) => /is working/.test(b)));
  assertEquals([host.steps, isDistroRemoved('ubuntu')], [['aib.remove check'], false]);
  host.live = 2;
  const [, out2] = await route(ctxOf(), 'POST', '/api/live/wsl/aib/remove', '', { distro: 'Ubuntu', mode: 'check' });
  assert((out2.blocked as string[]).some((b) => /2 chats or terminals still run in Ubuntu/.test(b)));
});

// ---- 5. the test guard and the last step ------------------------------------------------------------------------------------

Deno.test('test guard: under test a real host is only touched at the test root; never the real ~/.aib-server', T, async () => {
  const env = (o: Record<string, string>) => (n: string) => o[n];
  assertEquals(testGuard('/home/u/.aib-server', env({})), ''); // not under test: no test guard (the helper's own guards apply)
  assert(/needs AIB_WSL_ROOT/.test(testGuard('/home/u/.aib-server', env({ AGENT_STUDIO_TEST: '1' }))));
  assert(/needs AIB_WSL_ROOT/.test(testGuard('/home/u/.aib-server', env({ AGENT_STUDIO_TEST: '1', AIB_WSL_ROOT: '/home/u/.aib-server' }))));
  assert(/only touches/.test(testGuard('/home/u/.aib-server', env({ AGENT_STUDIO_TEST: '1', AIB_WSL_ROOT: '/tmp/aib-wsl-test-abc' }))));
  assertEquals(testGuard('/tmp/aib-wsl-test-abc', env({ AGENT_STUDIO_TEST: '1', AIB_WSL_ROOT: '/tmp/aib-wsl-test-abc' })), '');

  // through the route: a real-looking host installed at ~/.aib-server is refused before the helper is asked anything
  reset();
  const host = new RecordingHost(temp());
  host.install = { root: '/home/u/.aib-server', data: '/home/u/.aib-server/data-0123456789ab', version: '0.1.0-0123abcd' } as WslInstall;
  let ran = 0;
  setFinalRunnerForTests(() => {
    ran++;
    return Promise.resolve({ code: 0, stdout: new Uint8Array(), stderr: '' });
  });
  withHost(host);
  const [, out] = await route(ctxOf(), 'POST', '/api/live/wsl/aib/remove', '', { distro: 'Ubuntu', mode: 'apply', confirm: true });
  assertEquals(out.ok, false);
  assert((out.blocked as string[])[0].startsWith('Test guard'));
  assertEquals([host.steps, ran, isDistroRemoved('ubuntu')], [[], 0, false]);

  // at the test root: the last step runs with the checked arguments (here a stand-in runner)
  host.install = { root: TEST_ROOT, data: `${TEST_ROOT}/data-0123456789ab`, version: '0.1.0-0123abcd' } as WslInstall;
  host.handlers['aib.remove'] = (p) => ({
    ok: true, mode: p.mode, blocked: [], wouldRemove: [], kept: [], removed: [], left: [],
    ...(p.mode === 'apply' ? { final: { data: 'data-0123456789ab', version: '0.1.0-0123abcd', root: true, copies: [] } } : {}),
  });
  let argv: string[] = [];
  setFinalRunnerForTests((_d, a) => {
    argv = a;
    return Promise.resolve({ code: 0, stdout: new TextEncoder().encode(`removed=${TEST_ROOT}/data-0123456789ab\nremoved=${TEST_ROOT}\n`), stderr: '' });
  });
  const [, ok] = await route(ctxOf(), 'POST', '/api/live/wsl/aib/remove', '', { distro: 'Ubuntu', mode: 'apply', confirm: true });
  assertEquals(ok.ok, true, JSON.stringify(ok));
  assertEquals(argv.slice(0, 2), ['/bin/sh', '-c']);
  assertEquals(argv[2], FINAL_CLEANUP_SCRIPT);
  assertEquals(argv.slice(3), ['sh', TEST_ROOT, 'data-0123456789ab', '0.1.0-0123abcd', '1', '1']);
  assert(argv.every((a) => a !== ''), 'wsl.exe takes no empty argument');
  assertEquals(ok.removed, [`${TEST_ROOT}/data-0123456789ab`, TEST_ROOT]);
  reset();
});

Deno.test('last step: its arguments are checked on Windows too; its output is read line by line', () => {
  const final = { data: 'data-0123456789ab', version: '0.1.0-beta.10-0123abcd', root: false, copies: [] };
  assertEquals(finalArgs('/home/u/.aib-server', final, false), { args: ['/home/u/.aib-server', 'data-0123456789ab', '0.1.0-beta.10-0123abcd', '0', '0'] });
  assertEquals(finalArgs('/home/u/.aib-server', { ...final, version: null }, true), { args: ['/home/u/.aib-server', 'data-0123456789ab', '-', '0', '1'] });
  for (const [root, f] of [
    ['/home/u', final],
    ['/', final],
    ['/home/u/../.aib-server', final],
    ['relative/.aib-server', final],
    ['/home/u/.aib-server', { ...final, data: '../data-0123456789ab' }],
    ['/home/u/.aib-server', { ...final, data: 'data-xyz' }],
    ['/home/u/.aib-server', { ...final, version: '../../etc' }],
    ['/home/u/.aib-server', { ...final, version: '' }],
  ] as [string, typeof final][]) {
    assert('refused' in finalArgs(root, f, false), `${root} ${JSON.stringify(f)}`);
  }
  assertEquals(parseFinal('noise\nremoved=/r/a\nleft=/r/b: a program still uses it\r\nerror=x\ngone=/r\n'), {
    removed: ['/r/a'],
    left: ['/r/b: a program still uses it'],
    error: 'x',
    gone: true,
  });
  // the script's own rules (the real runs are in wsl_linking_remove_e2e_test.ts)
  assert(FINAL_CLEANUP_SCRIPT.includes('rm -rf --one-file-system -- "$1"'));
  assert(FINAL_CLEANUP_SCRIPT.includes('rmdir -- "$root"'));
  assert(!/rm -rf[^\n]*\$root"?\s*$/m.test(FINAL_CLEANUP_SCRIPT), 'the root is never rm -rf');
  assert(FINAL_CLEANUP_SCRIPT.includes('test guard'));
});
