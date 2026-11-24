/**
 * T1 (multi-window design section 11): presence per window (attention/presence.ts K2; B7 B8 B9 D1). One slot per window id,
 * focused = any fresh focused slot, open chats = the union of the visible ones, the answer names the sound owner, left drops a
 * slot at once, a call without an id goes into slot "_", at most 16 slots. Plus the server side of T6: a chat open in an
 * unfocused but visible window gets no desktop notification (watcher.ts Notifier, unchanged).
 */
import { assert, assertEquals } from './_assert.ts';
import { MAX_SLOTS, Presence, STALE_MS } from '../../app/server/attention/presence.ts';
import { type Fire, Notifier } from '../../app/server/attention/watcher.ts';
import { makeContext, WebServer } from '../../app/server/web/server.ts';
import type { LiveBackend } from '../../app/server/host/backend.ts';
import type { UpdateService } from '../../app/server/desktop/updater.ts';
import type { Source } from '../../app/server/transcripts/monitor.ts';

type Json = Record<string, unknown>;

const win = (w: string, over: Json = {}) => ({
  w,
  kind: w === 'm' ? 'main' : 'project',
  project: w === 'm' ? null : { key: 'p-' + w, name: 'proj ' + w },
  focused: false,
  visible: true,
  idleMs: 300_000,
  open: [] as string[],
  ...over,
});

Deno.test('T1: two windows keep two slots; focused is any fresh focused slot; open chats are the union of the visible windows', () => {
  let now = 1_000_000;
  const p = new Presence(() => now);
  p.reportWindow(win('m', { focused: true, open: ['claude:a'] }));
  p.reportWindow(win('w2', { focused: false, open: ['claude:b', 'claude:a'] }));
  assert(p.focused(), 'm is focused: the later report of w2 (not focused) does not clobber it (B7)');
  assertEquals(p.openOnPc().sort(), ['claude:a', 'claude:b']);
  // m loses focus, w2 keeps reporting not focused: nothing focused
  p.reportWindow(win('m', { focused: false, open: ['claude:a'] }));
  assert(!p.focused());
  // w2 minimised (S5: visible false, open empty): its chats leave the union
  p.reportWindow(win('w2', { visible: false, open: ['claude:b'] }));
  assertEquals(p.openOnPc(), ['claude:a'], 'a hidden window shows nothing');
  // stale: a slot older than 45 s drops
  now += STALE_MS - 1;
  p.reportWindow(win('w2', { focused: true }));
  now += 2;
  assert(p.focused(), 'w2 is fresh');
  assertEquals(p.openOnPc(), [], 'm went stale');
  assertEquals(p.windows().map((x) => x.w), ['w2']);
  now += STALE_MS;
  assert(!p.focused());
  assertEquals(p.windows(), []);
});

Deno.test('T1: left drops a slot at once (B8); a call without w goes into slot "_" (old pages, tests)', () => {
  const now = 5_000_000;
  const p = new Presence(() => now);
  p.reportWindow(win('w3', { focused: true, open: ['claude:x'] }));
  assert(p.focused());
  const a = p.reportWindow({ w: 'w3', left: true });
  assertEquals([p.focused(), p.openOnPc(), a.windows], [false, [], []]);
  // the old call: report(focused, idle, open)
  p.report(true, 1_000, ['claude:old']);
  assertEquals(p.windows().map((x) => [x.w, x.kind, x.focused]), [['_', 'main', true]]);
  // and an old page's body (no w, no kind, no visible)
  p.reportWindow({ focused: false, idleMs: 10, open: ['claude:o2'] });
  assertEquals(p.windows().map((x) => [x.w, x.focused]), [['_', false]]);
  assertEquals(p.openOnPc(), ['claude:o2']);
  assert(p.active() === false && p.focused() === false);
});

Deno.test('T1: a report the closing page sent before its left, arriving after it, does not bring the slot back; a reload does', () => {
  let now = 6_000_000;
  const p = new Presence(() => now);
  p.reportWindow(win('m', { page: 'pagem0001' }));
  p.reportWindow(win('w2', { page: 'pagea0001', focused: true }));
  p.reportWindow({ w: 'w2', left: true, page: 'pagea0001' });
  // the blur / hidden report of the same page load, on another connection, lands late
  p.reportWindow(win('w2', { page: 'pagea0001', visible: false }));
  assertEquals(p.windows().map((x) => x.w), ['m'], 'the closed window stays gone');
  // a reload of window w2 is a new page load: it reports at once
  now += 200;
  p.reportWindow(win('w2', { page: 'pageb0002' }));
  assertEquals(p.windows().map((x) => x.w).sort(), ['m', 'w2']);
  // a page without the field (an older page) keeps today's behaviour
  p.reportWindow({ w: 'w3', left: true });
  p.reportWindow(win('w3'));
  assert(p.windows().some((x) => x.w === 'w3'));
  // a computer's tab: the same rule
  assertEquals(p.reportDevice('dev-1', { w: 't-abcd', page: 'pagec0003' }).windows.map((x) => x.w), ['t-abcd']);
  p.reportDevice('dev-1', { w: 't-abcd', left: true, page: 'pagec0003' });
  assertEquals(p.reportDevice('dev-1', { w: 't-abcd', page: 'pagec0003' }).windows, [], "the computer's closed tab stays gone");
});

Deno.test('T1: the sound owner is the focused window, else the one focused last (D1)', () => {
  let now = 1_000;
  const p = new Presence(() => now);
  assertEquals(p.answer().soundOwner, null, 'nobody reported');
  p.reportWindow(win('m'));
  assertEquals(p.answer().soundOwner, null, 'never focused');
  now += 10;
  p.reportWindow(win('m', { focused: true }));
  p.reportWindow(win('w2'));
  assertEquals(p.answer().soundOwner, 'm');
  now += 10;
  p.reportWindow(win('w2', { focused: true }));
  p.reportWindow(win('m', { focused: true })); // a late report from m that still thinks it has focus: the latest focus wins
  now += 10;
  p.reportWindow(win('w2', { focused: true }));
  assertEquals(p.answer().soundOwner, 'w2');
  // both in the background: the one focused last speaks (exactly one chime)
  now += 10;
  p.reportWindow(win('w2', { focused: false }));
  p.reportWindow(win('m', { focused: false }));
  assertEquals(p.answer().soundOwner, 'w2');
  // the last-focused window closes: the other one that was focused before takes over
  p.leave('w2');
  assertEquals(p.answer().soundOwner, 'm');
});

Deno.test('T1: the answer lists the fresh windows; bad ids, kinds and keys are refused; names are cut; at most 16 slots', () => {
  let now = 1_000;
  const p = new Presence(() => now);
  const a = p.reportWindow({
    w: 'w4',
    kind: 'chat',
    project: { key: 'proj', name: 'x'.repeat(200) + '\u0007' },
    chat: 'claude:s1',
    focused: true,
    visible: true,
    open: ['claude:s1', 42, '', 'bad\u0001key', 'y'.repeat(401)],
  });
  assertEquals(a, {
    ok: true,
    soundOwner: 'w4',
    openAll: ['claude:s1'],
    windows: [{ w: 'w4', kind: 'chat', project: 'proj', chat: 'claude:s1', doc: null, focused: true, visible: true }],
    quiet: false, // phase 2: true while you are at a paired computer (presence_where_test.ts)
  });
  p.reportWindow({ w: 'w5', kind: 'doc', project: { key: 'proj', name: 'n' }, doc: { project: 'proj', name: 'Release plan' } });
  assertEquals(p.windows()[1].doc, { project: 'proj', name: 'Release plan' });
  for (
    const bad of [
      { w: 'w9' },
      { w: 'w1' },
      { w: 'M' },
      { w: 't-AB12' },
      { w: 't-ab' },
      { w: 5 },
      { w: 'w2', kind: 'popup' },
      { w: 'w2', project: { key: '' } },
      { w: 'w2', project: { key: 'a\nb' } },
      { w: 'w2', project: 'flat' },
      { w: 'w2', chat: 'z'.repeat(401) },
    ]
  ) {
    let refused = false;
    try {
      p.reportWindow(bad);
    } catch (error) {
      refused = (error as Error).name === 'ValueError';
    }
    assert(refused, JSON.stringify(bad));
  }
  // 20 open entries at most
  p.reportWindow({ w: 't-abcd', open: Array.from({ length: 30 }, (_, i) => `claude:${i}`) });
  assertEquals(p.windows().find((x) => x.w === 't-abcd')!.kind, 'main');
  assertEquals(p.openOnPc().filter((k) => /^claude:\d+$/.test(k)).length, 20);
  // 16 slots: the one reported longest ago goes first
  const q = new Presence(() => now);
  for (let i = 0; i < MAX_SLOTS + 2; i++) {
    now += 1;
    q.reportWindow({ w: `t-tab${String(i).padStart(2, '0')}`, focused: false });
  }
  const ids = q.windows().map((x) => x.w);
  assertEquals(ids.length, MAX_SLOTS);
  assertEquals([ids.includes('t-tab00'), ids.includes('t-tab01'), ids.includes('t-tab02')], [false, false, true]);
});

Deno.test('T6 (server side, B9): a chat open in an unfocused but visible window gets no desktop notification; others do', async () => {
  let now = 1_000_000;
  const presence = new Presence(() => now);
  const desktop: Json[] = [];
  const n = new Notifier({
    desktop: () => (req) => (desktop.push(req), Promise.resolve({ shown: true })),
    push: () => null,
    presence,
    viewPrefs: { public: () => ({ prefs: {} }) } as never,
    clock: () => now,
  });
  const needs = (k: string): Fire => ({ key: 'claude:' + k, chat: 'c-' + k, kind: 'needs', title: 'Chat ' + k });
  // window m shows chat a, window w2 shows chat b; neither has focus (both visible on two monitors)
  presence.reportWindow(win('m', { open: ['claude:a'] }));
  presence.reportWindow(win('w2', { open: ['claude:b'] }));
  await n.fire([needs('b')]);
  assertEquals(desktop, [], 'b is on screen in w2 (before: only the last report counted, m clobbered by w2 or the other way)');
  await n.fire([needs('a')]);
  assertEquals(desktop, [], 'a is on screen in m');
  await n.fire([needs('c')]);
  assertEquals(desktop.map((d) => d.title), ['Chat c'], 'c is in no window');
  // w2 minimised: b is no longer in front of the owner
  now += 70_000; // a new 60 s group
  presence.reportWindow(win('m', { open: ['claude:a'] }));
  presence.reportWindow(win('w2', { visible: false, open: [] }));
  await n.fire([needs('b')]);
  assertEquals(desktop.map((d) => d.title), ['Chat c', 'Chat b']);
  // any window focused: no desktop notification at all
  now += 70_000;
  presence.reportWindow(win('m', { open: ['claude:a'] }));
  presence.reportWindow(win('w2', { focused: true }));
  await n.fire([needs('d')]);
  assertEquals(desktop.length, 2);
  n.close();
});

Deno.test('T1: POST /api/live/presence keeps a slot per window and answers with the sound owner, openAll and the windows', async () => {
  const stateDir = await Deno.makeTempDir({ prefix: 'aib-presence-win-' });
  const ctx = makeContext({
    stateDir,
    host: {} as LiveBackend,
    updates: {} as UpdateService,
    webInstanceId: 'test',
    cliPort: 0,
    transcripts: {} as Source,
    claudeProjects: stateDir,
    ompSessions: stateDir,
    shutdown: () => {},
    keepAwakeBackend: null,
  });
  const server = new WebServer(ctx);
  const port = await server.listen(0); // a free port the OS picks
  const origin = `http://127.0.0.1:${port}`;
  const post = async (body: unknown) => {
    const r = await fetch(`${origin}/api/live/presence`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Studio-Token': ctx.token, Origin: origin },
      body: JSON.stringify(body),
    });
    return [r.status, await r.json()] as [number, Json];
  };
  try {
    let [status, a] = await post(win('m', { focused: true, open: ['claude:a'] }));
    assertEquals([status, a.ok, a.soundOwner, a.openAll], [200, true, 'm', ['claude:a']]);
    [status, a] = await post(win('w2', { open: ['claude:b'] }));
    assertEquals([a.soundOwner, (a.openAll as string[]).sort(), (a.windows as Json[]).map((x) => x.w)], ['m', ['claude:a', 'claude:b'], [
      'm',
      'w2',
    ]]);
    assert(ctx.presence.focused(), 'w2 did not clobber m');
    [status, a] = await post({ w: 'm', left: true });
    assertEquals([a.soundOwner, a.openAll, ctx.presence.focused()], [null, ['claude:b'], false]);
    [status, a] = await post({ w: 'w99', focused: true });
    assertEquals(status, 400, 'a bad window id');
    // an old page: no w -> slot "_"
    [status, a] = await post({ focused: true, idleMs: 0, open: [] });
    assertEquals([status, a.soundOwner], [200, '_']);
  } finally {
    await server.close();
    await Deno.remove(stateDir, { recursive: true }).catch(() => {});
  }
});
