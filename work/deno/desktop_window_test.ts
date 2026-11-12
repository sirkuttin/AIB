/**
 * The desktop app's logic (server/desktop/window.ts, single_instance.ts, shortcut.ts) with a fake Shell: no window, tray, dialog or
 * notification is ever shown. The shortcut test writes only into a temp folder.
 */
import { assert, assertEquals } from './_assert.ts';
import {
  choosePortPair,
  lastPortPair,
  saveLastPort,
  cleanGeometry,
  closeDecision,
  DEFAULT_SIZE,
  DesktopApp,
  type DesktopOptions,
  GEOMETRY_FILE,
  isExternal,
  KEEPER_URL,
  loadGeometry,
  PAGE_PROBE,
  pageDecision,
  parseProbe,
  portFree,
  portGiven,
  rateLimiter,
  saveGeometry,
  type Shell,
  STOP_CONFIRM_MS,
  STOP_INDEX,
  stopConfirmLabel,
  TRAY_ITEMS,
  trayOnlyView,
  type WindowHandle,
} from '../../outputs/agent-studio/server/desktop/window.ts';
import { orphanCommand } from '../../outputs/agent-studio/server/host/studio.ts';
import { UpdateService } from '../../outputs/agent-studio/server/desktop/updater.ts';
import {
  alreadyRunning,
  claim,
  claimFolder,
  guardDataFolder,
  SIGNAL_FILE,
  takeSignal,
  watchSignal,
} from '../../outputs/agent-studio/server/desktop/single_instance.ts';
import {
  ensureStartMenuShortcut,
  lnkMentions,
  shortcutArgs,
  shortcutScript,
  startMenuDir,
} from '../../outputs/agent-studio/server/desktop/shortcut.ts';
import { trayIconPng } from '../../outputs/agent-studio/server/desktop/tray_icon.ts';
import {
  chosenItem,
  menuCommand,
  notifyIconData,
  NOTIFYICONDATAW_SIZE,
  TRAY_CALLBACK,
  trayEvent,
} from '../../outputs/agent-studio/server/desktop/tray_win.ts';
import { pidAlive, readInfo, stopHost } from '../../outputs/agent-studio/server/host/host_client.ts';
import { DENO, FAKE_HOST, Fixture, TEST_OPTIONS, until } from './_host_fixture.ts';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

Deno.test('port pair: the first P from 8777 with P and P+1 free', () => {
  const busy = new Set([8777, 8780]);
  assertEquals(choosePortPair((p) => !busy.has(p)), 8778);
  assertEquals(choosePortPair(() => true), 8777);
  const busy2 = new Set([8778]);
  assertEquals(choosePortPair((p) => !busy2.has(p)), 8779, '8777 is free but 8778 is not');
  let threw = false;
  try {
    choosePortPair(() => false, 8777, 5);
  } catch {
    threw = true;
  }
  assert(threw);
});

Deno.test('portFree sees a real listener; portGiven reads --port', () => {
  const l = Deno.listen({ hostname: '127.0.0.1', port: 0 });
  const port = (l.addr as Deno.NetAddr).port;
  assertEquals(portFree(port), false);
  l.close();
  assertEquals(portFree(port), true);
  assertEquals(portGiven([]), false);
  assertEquals(portGiven(['--port', '8890']), true);
  assertEquals(portGiven(['--port=8890']), true);
  assertEquals(portGiven(['--host-port', '1']), false);
});

Deno.test('close decision: only a known zero quits; anything working, or unknown, keeps AIB in the tray', () => {
  assertEquals(closeDecision(0), 'quit');
  assertEquals(closeDecision(1), 'tray');
  assertEquals(closeDecision(null), 'tray');
  assertEquals(stopConfirmLabel(2), 'Click again to stop 2 chats and quit');
  assertEquals(stopConfirmLabel(1), 'Click again to stop 1 chat and quit');
  assertEquals(stopConfirmLabel(0), 'Click again to stop everything and quit', 'only a terminal command or a merge runs');
});

Deno.test('geometry: cleaned, saved and loaded', async () => {
  assertEquals(cleanGeometry(null), DEFAULT_SIZE);
  assertEquals(cleanGeometry({ width: 100, height: 900 }), DEFAULT_SIZE, 'too small');
  assertEquals(cleanGeometry({ width: 1000.4, height: 700, x: 10, y: -5 }), { width: 1000, height: 700, x: 10, y: -5 });
  assertEquals(cleanGeometry({ width: 1000, height: 700, x: -32000, y: -32000 }), { width: 1000, height: 700 }, 'minimized');
  assertEquals(cleanGeometry({ width: '1000', height: 700 }), DEFAULT_SIZE);
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/${GEOMETRY_FILE}`;
    assertEquals(await loadGeometry(path), DEFAULT_SIZE, 'missing file');
    await saveGeometry(path, { width: 900, height: 600, x: 40, y: 50 });
    assertEquals(await loadGeometry(path), { width: 900, height: 600, x: 40, y: 50 });
    await saveGeometry(path, { width: 900, height: 600, x: -32000, y: -32000 });
    assertEquals(await loadGeometry(path), { width: 900, height: 600, x: 40, y: 50 }, 'a minimized window keeps the last good one');
    await Deno.writeTextFile(path, '{not json');
    assertEquals(await loadGeometry(path), DEFAULT_SIZE);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('link rule and rate limit', () => {
  const page = 'http://127.0.0.1:8777';
  assertEquals(isExternal('https://example.com/', page), true);
  assertEquals(isExternal('http://127.0.0.1:8778/', page), true);
  assertEquals(isExternal('http://127.0.0.1:8777/x', page), false);
  assertEquals(isExternal('/x', page), false);
  assertEquals(isExternal('file:///C:/x', page), false);
  assertEquals(isExternal('about:blank', page), false);
  let t = 0;
  const ok = rateLimiter(2, 1000, () => t);
  assertEquals([ok(), ok(), ok()], [true, true, false]);
  t = 1000;
  assertEquals(ok(), true);
});

// ---------- DesktopApp with a fake shell ----------

class FakeWindow implements WindowHandle {
  closed = false;
  visible = true;
  urls: string[] = [];
  bound = new Map<string, (...a: unknown[]) => unknown>();
  handlers = new Map<string, (() => void)[]>();
  size: [number, number] = [0, 0];
  pos: [number, number] = [0, 0];
  title = '';
  href = '';
  log: string[] = [];
  constructor(readonly options: { title: string; width: number; height: number }) {
    this.size = [options.width, options.height];
  }
  navigate(url: string) {
    this.urls.push(url);
    this.href = url;
  }
  show() {
    this.visible = true;
    this.log.push('show');
  }
  hide() {
    this.visible = false;
    this.log.push('hide');
  }
  focus() {
    this.log.push('focus');
  }
  setTitle(t: string) {
    this.title = t;
  }
  isClosed() {
    return this.closed;
  }
  getSize() {
    return this.size;
  }
  getPosition() {
    return this.pos;
  }
  setSize(w: number, h: number) {
    this.size = [w, h];
  }
  setPosition(x: number, y: number) {
    this.pos = [x, y];
  }
  bind(name: string, fn: (...a: unknown[]) => unknown) {
    this.bound.set(name, fn);
  }
  on(event: string, fn: () => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn]);
  }
  emit(event: string) {
    if (event === 'close') this.closed = true; // the runtime destroys the window; the event can't be cancelled
    for (const fn of this.handlers.get(event) ?? []) fn();
  }
  isVisible() {
    return this.visible;
  }
  evaluate(code: string) {
    if (code === PAGE_PROBE) return Promise.resolve(this.href ? JSON.stringify({ href: this.href, title: this.title }) : undefined);
    return Promise.resolve(code === 'location.href' ? this.href : undefined);
  }
}

function fakeShell(answer = false) {
  const s = {
    windows: [] as FakeWindow[],
    keepers: 0,
    keeper: null as FakeWindow | null,
    tray: null as null | {
      items: { id: string; label: string }[];
      onClick: () => void;
      onMenu: (id: string) => void;
      tooltip: string;
      icon: Uint8Array;
    },
    questions: [] as string[],
    answer,
    external: [] as string[],
    notes: [] as [string, string][],
    trayRemoved: 0,
  };
  const shell: Shell = {
    createWindow: (o) => {
      const w = new FakeWindow(o);
      s.windows.push(w);
      return w;
    },
    createKeeper: () => {
      s.keepers++;
      s.keeper = new FakeWindow({ title: 'AIB', width: 1, height: 1 });
      s.keeper.href = 'about:blank';
      return s.keeper;
    },
    createTray: (icon, tooltip, items, onClick, onMenu) => void (s.tray = { items, onClick, onMenu, tooltip, icon }),
    removeTray: () => void s.trayRemoved++,
    ask: (m) => (s.questions.push(m), Promise.resolve(s.answer)),
    openExternal: (u) => void s.external.push(u),
    notifier: {
      mechanism: 'fake',
      show: (t, b) => (s.notes.push([t, b]), Promise.resolve({ shown: true, code: 1 })),
    },
  };
  return { s, shell };
}

/**
 * The app as main.ts makes it. stopHost null (default): one process with the keeper, the shipped setup; a function: a separate
 * agent host (an older version's, being drained).
 */
async function makeApp(
  busy: () => Promise<number>,
  stopHost: ((force: boolean) => Promise<unknown>) | null = null,
  extra: Partial<DesktopOptions> = {},
) {
  const dir = await Deno.makeTempDir();
  const { s, shell } = fakeShell();
  const updates: [string, number, string][] = [];
  shell.updateTray = (tooltip, index, label) => void updates.push([tooltip, index, label]);
  const quits: boolean[] = [];
  const order: string[] = [];
  const stops: boolean[] = [];
  const options: DesktopOptions = {
    url: 'http://127.0.0.1:8890/',
    stateDir: dir,
    trayIcon: trayIconPng(),
    busyCount: busy,
    ...(stopHost ? { stopHost: (force: boolean) => (stops.push(force), order.push(`stop:${force}`), stopHost(force)) } : {}),
    quit: (stop) => (quits.push(stop), order.push('quit'), Promise.resolve()),
    saveDelayMs: 0,
    watchdogMs: 0,
    trayPollMs: 0,
    ...extra,
  };
  const removeTray = shell.removeTray!;
  shell.removeTray = () => (order.push('tray removed'), removeTray());
  const app = new DesktopApp(shell, options);
  await app.start();
  return { app, s, updates, quits, stops, order, dir, done: () => (app.stop(), Deno.remove(dir, { recursive: true })) };
}

Deno.test('start: one window titled AIB on the page, a keeper, a tray, one binding only', async () => {
  const { s, done } = await makeApp(() => Promise.resolve(0));
  try {
    assertEquals(s.windows.length, 1);
    const w = s.windows[0];
    assertEquals(w.options.title, 'AIB');
    assertEquals(w.urls, ['http://127.0.0.1:8890/']);
    assertEquals([...w.bound.keys()], ['aibDesktop'], 'it only says "the app"; notifications go through the server');
    assertEquals(await w.bound.get('aibDesktop')!(), true);
    assertEquals(s.keepers, 1);
    assertEquals(s.tray?.items.map((i) => i.label), ['Open AIB', '', 'Quit AIB', 'Stop all chats and quit']);
    const png = trayIconPng();
    assertEquals([...png.slice(1, 4)], [0x50, 0x4e, 0x47], 'a PNG');
    assertEquals(s.tray?.icon, png, 'the tray gets the colour icon tray_icon.ts chose (16 or 32 px)');
  } finally {
    await done();
  }
});

Deno.test('closing with no chat working quits through the normal path, no question', async () => {
  const { s, quits, app, done } = await makeApp(() => Promise.resolve(0));
  try {
    s.windows[0].emit('close');
    await tick();
    assertEquals(quits, [false]);
    assertEquals(s.questions, []);
    await app.showWindow(); // after quitting nothing reopens
    assertEquals(s.windows.length, 1);
  } finally {
    await done();
  }
});

Deno.test('closing with chats working: no question, nothing stopped; AIB stays in the tray and the tray reopens a new window', async () => {
  const { s, quits, app, done } = await makeApp(() => Promise.resolve(2));
  try {
    s.windows[0].emit('close');
    await tick();
    assertEquals(s.questions, [], 'no native box');
    assertEquals(quits, []);
    assertEquals(s.trayRemoved, 0, 'the tray icon stays while they work');
    assert(app.background, 'quits by itself once nothing works');
    s.tray!.onClick();
    await tick();
    assertEquals(s.windows.length, 2, 'the closed window is gone: a new one');
    assertEquals(s.windows[1].urls, ['http://127.0.0.1:8890/']);
    assert(!app.background, 'the person is back');
    s.tray!.onMenu('open'); // already open: show and focus, no third window
    await tick();
    assertEquals(s.windows.length, 2);
    assertEquals(s.windows[1].log.slice(-2), ['show', 'focus']);
  } finally {
    app.stop();
    await done();
  }
});

Deno.test('an unreadable count never quits: AIB stays in the tray, no question', async () => {
  const b = await makeApp(() => Promise.reject(new Error('host gone')));
  try {
    b.s.windows[0].emit('close');
    await tick();
    assertEquals(b.s.questions, []);
    assertEquals(b.quits, []);
    assert(b.app.background);
    await b.app.trayTick(Date.now() + 60_000);
    assertEquals(b.quits, [], 'an unknown count is never idle');
  } finally {
    b.app.stop();
    await b.done();
  }
});

Deno.test('tray: icon, menu Open AIB / status / Quit AIB / Stop all chats and quit; left click and Open show the window', async () => {
  const a = await makeApp(() => Promise.resolve(2));
  try {
    assertEquals(a.s.tray?.tooltip, 'AIB');
    assertEquals(a.s.tray?.items, TRAY_ITEMS);
    assertEquals(TRAY_ITEMS.map((i) => [i.label, !!i.disabled]), [
      ['Open AIB', false],
      ['', true],
      ['Quit AIB', false],
      ['Stop all chats and quit', false],
    ]);
    assertEquals(a.updates.at(-1), ['AIB · 2 chats running', 1, '2 chats running'], 'the status line, window or not');
    a.s.windows[0].emit('close'); // 2 working: AIB stays in the tray with no window
    await tick();
    assertEquals(a.s.windows[0].closed, true);
    a.s.tray!.onClick();
    await tick();
    assertEquals(a.s.windows.length, 2, 'a left click makes a new window');
    a.s.windows[1].emit('close');
    await tick(20);
    await a.app.onTrayMenu('open');
    assertEquals(a.s.windows.length, 3, 'Open AIB makes a new window');
    a.s.tray!.onMenu('nonsense');
    await tick();
    assertEquals(a.s.windows.length, 3, 'an unknown id does nothing');
    assertEquals(a.s.questions, [], 'never a native box');
  } finally {
    a.app.stop();
    await a.done();
  }
});

Deno.test('Windows tray: callback events, menu commands and the NOTIFYICONDATAW layout', () => {
  assertEquals(trayEvent(0x0202), 'click'); // WM_LBUTTONUP
  assertEquals(trayEvent(0x0205), 'menu'); // WM_RBUTTONUP
  assertEquals(trayEvent(0x007b), 'menu'); // WM_CONTEXTMENU
  assertEquals(trayEvent(0x0200), null); // WM_MOUSEMOVE
  assertEquals(trayEvent(0x0203), null); // WM_LBUTTONDBLCLK
  assertEquals(trayEvent(0x12340205n), 'menu', 'only the low word counts');
  assertEquals(trayEvent(0x0405), 'balloon-click'); // NIN_BALLOONUSERCLICK
  assertEquals(trayEvent(0x0404), null); // NIN_BALLOONTIMEOUT
  const items = [{ id: 'open', label: 'Open AIB' }, { id: 'quit', label: 'Quit AIB' }];
  assertEquals(items.map((_, i) => menuCommand(i)), [1, 2]);
  assertEquals([chosenItem(items, 0), chosenItem(items, 1), chosenItem(items, 2), chosenItem(items, 3)], [null, 'open', 'quit', null]);
  const nid = notifyIconData({ hwnd: 0x1234n, flags: 7, callbackMessage: TRAY_CALLBACK, hIcon: 0xabcdn, tip: 'AIB' + 'x'.repeat(200) });
  const v = new DataView(nid.buffer);
  assertEquals(nid.length, NOTIFYICONDATAW_SIZE);
  assertEquals(v.getUint32(0, true), 976);
  assertEquals(v.getBigUint64(8, true), 0x1234n);
  assertEquals(v.getUint32(16, true), 1);
  assertEquals(v.getUint32(20, true), 7);
  assertEquals(v.getUint32(24, true), TRAY_CALLBACK);
  assertEquals(v.getBigUint64(32, true), 0xabcdn);
  assertEquals(String.fromCharCode(v.getUint16(40, true), v.getUint16(42, true), v.getUint16(44, true)), 'AIB');
  assertEquals(v.getUint16(40 + 126 * 2, true), 'x'.charCodeAt(0));
  assertEquals(v.getUint16(40 + 127 * 2, true), 0, 'the tooltip keeps its terminating zero');
});

Deno.test('tray Quit AIB with chats working hides the window and stays in the tray; with nothing working it just quits', async () => {
  const a = await makeApp(() => Promise.resolve(3));
  try {
    a.s.tray!.onMenu('quit');
    await tick();
    assertEquals(a.s.questions, []);
    assertEquals(a.quits, [], 'no chat is stopped');
    assertEquals(a.s.windows[0].visible, false, 'the window goes');
    assert(a.app.background);
    a.s.tray!.onMenu('open');
    await tick();
    assertEquals(a.s.windows.length, 1, 'the hidden window comes back: same page, nothing reloaded');
    assertEquals(a.s.windows[0].visible, true);
    assert(!a.app.background);
  } finally {
    a.app.stop();
    await a.done();
  }
  const b = await makeApp(() => Promise.resolve(0));
  try {
    b.s.tray!.onMenu('quit');
    await tick();
    assertEquals(b.quits, [false]);
    assertEquals(b.s.trayRemoved, 1, 'quitting removes the icon');
  } finally {
    await b.done();
  }
});

Deno.test('in the background AIB quits by itself once nothing has worked for a while: chats, helpers, queues, terminal commands, merges', async () => {
  const counts = { working: 1, needsYou: 0 };
  let terminals = 0;
  let merges = 0;
  const a = await makeApp(() => Promise.resolve(counts.working), null, {
    trayCounts: () => Promise.resolve({ ...counts }),
    terminalsBusy: () => terminals,
    mergesRunning: () => merges,
    trayIdleQuitMs: 5000,
  });
  try {
    const t0 = Date.now();
    await a.app.trayTick(t0);
    await a.app.trayTick(t0 + 60_000);
    assertEquals(a.quits, [], 'the window is open: never quits by itself');
    a.s.windows[0].emit('close');
    await tick();
    assert(a.app.background);
    counts.working = 0;
    terminals = 1; // a command still runs in a chat's terminal
    await a.app.trayTick(t0 + 61_000);
    await a.app.trayTick(t0 + 70_000);
    assertEquals(a.quits, [], 'a terminal command keeps it');
    terminals = 0;
    merges = 1;
    await a.app.trayTick(t0 + 80_000);
    assertEquals(a.quits, [], 'a merge keeps it');
    merges = 0;
    await a.app.trayTick(t0 + 81_000);
    await a.app.trayTick(t0 + 85_500);
    assertEquals(a.quits, [], 'idle 4.5 s: not yet');
    await a.app.trayTick(t0 + 86_100);
    assertEquals(a.quits, [false], 'idle 5.1 s: quits, nothing stopped by force');
  } finally {
    a.app.stop();
    await a.done();
  }
  // Closing with only a terminal command or a merge running (no chat) keeps AIB in the tray too.
  for (const extra of [{ terminalsBusy: () => 1 }, { mergesRunning: () => 1 }]) {
    const b = await makeApp(() => Promise.resolve(0), null, extra);
    try {
      b.s.windows[0].emit('close');
      await tick();
      assertEquals(b.quits, []);
      assert(b.app.background);
    } finally {
      b.app.stop();
      await b.done();
    }
  }
});

Deno.test('a window opened again while the close rule is still counting is never hidden', async () => {
  let release: (n: number) => void = () => {};
  let slow = false;
  const a = await makeApp(() => (slow ? new Promise<number>((r) => (release = r)) : Promise.resolve(2)));
  try {
    slow = true;
    a.s.windows[0].emit('close'); // the count is slow to come
    await tick();
    slow = false;
    await a.app.onTrayMenu('open'); // the person is back first
    assertEquals(a.s.windows.length, 2);
    release(2);
    await tick(20);
    assertEquals(a.s.windows[1].visible, true, 'the new window stays');
    assert(!a.app.background);
    assertEquals(a.quits, []);
  } finally {
    await a.done();
  }
});

Deno.test('Stop all chats and quit: the first click turns the item into a confirm line; a second click stops everything; it times out', async () => {
  const a = await makeApp(() => Promise.resolve(2));
  try {
    const t0 = Date.now();
    await a.app.requestStop(t0);
    assertEquals(a.quits, [], 'one click stops nothing');
    assertEquals(a.s.questions, [], 'no native box');
    assertEquals(a.updates.at(-1)?.slice(1), [STOP_INDEX, 'Click again to stop 2 chats and quit']);
    await a.app.requestStop(t0 + 2000);
    assertEquals(a.quits, [true], 'confirmed: every chat is stopped');
    assertEquals(a.s.trayRemoved, 1);
  } finally {
    a.app.stop();
    await a.done();
  }
  const b = await makeApp(() => Promise.resolve(1));
  try {
    const t0 = Date.now();
    await b.app.requestStop(t0);
    await b.app.requestStop(t0 + STOP_CONFIRM_MS + 1);
    assertEquals(b.quits, [], 'too late: that click only arms it again');
    assertEquals(b.updates.at(-1)?.slice(1), [STOP_INDEX, 'Click again to stop 1 chat and quit']);
  } finally {
    b.app.stop();
    await b.done();
  }
  const c = await makeApp(() => Promise.resolve(0));
  try {
    c.s.tray!.onMenu('stop');
    await tick();
    assertEquals(c.quits, [false], 'nothing works: it just quits');
  } finally {
    await c.done();
  }
});

Deno.test('the window remembers its size and position in the data folder', async () => {
  const a = await makeApp(() => Promise.resolve(0));
  try {
    const w = a.s.windows[0];
    assertEquals(w.size, [DEFAULT_SIZE.width, DEFAULT_SIZE.height]);
    w.size = [1000, 700];
    w.pos = [30, 40];
    w.emit('move');
    await tick(20);
    assertEquals(JSON.parse(await Deno.readTextFile(`${a.dir}/${GEOMETRY_FILE}`)), { width: 1000, height: 700, x: 30, y: 40 });
    const again = new DesktopApp(fakeShell().shell, { ...a.app.options });
    await again.openWindow();
    const w2 = again.window as FakeWindow;
    assertEquals([w2.size, w2.pos], [[1000, 700], [30, 40]]);
  } finally {
    await a.done();
  }
});

Deno.test('a page that left the app origin opens outside and the window goes back', async () => {
  const a = await makeApp(() => Promise.resolve(0));
  try {
    const w = a.s.windows[0];
    w.emit('load');
    await tick();
    assertEquals(a.s.external, []);
    assertEquals(w.title, 'AIB');
    w.href = 'https://example.com/docs';
    w.emit('load');
    await tick();
    assertEquals(a.s.external, ['https://example.com/docs']);
    assertEquals(w.urls.at(-1), 'http://127.0.0.1:8890/');
  } finally {
    await a.done();
  }
});

Deno.test('notifications: the app shows them through its OS notifier, rate-limited', async () => {
  const a = await makeApp(() => Promise.resolve(0));
  try {
    const req = { title: 't', body: 'b', target: null, test: false };
    assertEquals(await a.app.notifications.show(req), { shown: true, code: 1 });
    for (let i = 0; i < 5; i++) await a.app.notifications.show(req);
    assertEquals((await a.app.notifications.show(req)).shown, false, 'the 7th within 30 s is dropped');
    assertEquals(a.s.notes.length, 6);
  } finally {
    await a.done();
  }
});

// ---------- single instance ----------

Deno.test('single instance: the second claim signals the first, which shows its window', async () => {
  const dir = await Deno.makeTempDir();
  try {
    const first = await claim(dir);
    assert(first.primary);
    let shown = 0;
    const stop = await watchSignal(dir, () => shown++, 20);
    const second = await claim(dir);
    assertEquals(second.primary, false);
    for (let i = 0; i < 50 && shown === 0; i++) await tick(20);
    assertEquals(shown, 1);
    assertEquals(await takeSignal(dir), false, 'the signal was consumed');
    stop();
    if (first.primary) first.lock.close();
    const third = await claim(dir);
    assert(third.primary, 'a released lock is free again');
    if (third.primary) third.lock.close();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('one AIB per folder: a desktop launch while a server owns the folder shows a box, opens no window, exits 2', async () => {
  const dir = await Deno.makeTempDir();
  const { s, shell } = fakeShell(true);
  const server = await claimFolder(dir, { mode: 'server', port: 8913 });
  try {
    assert(server.primary);
    let code: number | null = null;
    await guardDataFolder(dir, {
      mode: 'desktop',
      say: () => {},
      notice: async (m) => void (await shell.ask(m)), // the box (nativeNotice in the app)
      exit: (c) => {
        code = c;
        throw new Error('exit');
      },
    }).catch(() => {});
    assertEquals(code, 2);
    assertEquals(s.questions, [alreadyRunning(dir, { pid: Deno.pid, mode: 'server', port: 8913 })]);
    assertEquals([s.windows.length, s.keepers, s.tray], [0, 0, null], 'no second app: no window, keeper or tray');
    assertEquals(await takeSignal(dir), false);
  } finally {
    if (server.primary) server.release();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('a stale signal from before the app started is ignored', async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/${SIGNAL_FILE}`, '{}');
    let shown = 0;
    const stop = await watchSignal(dir, () => shown++, 20);
    await tick(80);
    stop();
    assertEquals(shown, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------- Start menu shortcut ----------

Deno.test('shortcut: path, script and arguments', () => {
  assertEquals(
    startMenuDir((n) => (n === 'APPDATA' ? 'C:\\Users\\u\\AppData\\Roaming' : undefined)),
    'C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs',
  );
  assertEquals(startMenuDir(() => undefined), null);
  const script = shortcutScript('C:\\S\\AIB.lnk', "D:\\Bob's apps\\AIB\\AIB.exe");
  assert(script.includes("$t = 'D:\\Bob''s apps\\AIB\\AIB.exe'"), 'single quotes doubled');
  const args = shortcutArgs('C:\\S\\AIB.lnk', 'D:\\AIB\\AIB.exe');
  assertEquals(args.slice(0, -1), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand']);
  assert(!args.includes('-WindowStyle'), 'never hides the console it shares');
  const bin = atob(args.at(-1)!);
  let decoded = '';
  for (let i = 0; i < bin.length; i += 2) decoded += String.fromCharCode(bin.charCodeAt(i) | (bin.charCodeAt(i + 1) << 8));
  assertEquals(decoded, shortcutScript('C:\\S\\AIB.lnk', 'D:\\AIB\\AIB.exe'));
  const enc = (s: string) => new Uint8Array([...s].flatMap((c) => [c.charCodeAt(0) & 0xff, c.charCodeAt(0) >> 8]));
  assertEquals(lnkMentions(new TextEncoder().encode('xx C:\\A\\AIB.EXE yy'), 'c:\\a\\aib.exe'), true);
  assertEquals(lnkMentions(enc('C:\\A\\AIB.exe'), 'C:\\A\\AIB.exe'), true);
  assertEquals(lnkMentions(enc('C:\\B\\AIB.exe'), 'C:\\A\\AIB.exe'), false);
});

Deno.test('shortcut: skipped off Windows, for deno.exe, or with no folder', async () => {
  assertEquals(await ensureStartMenuShortcut('C:\\A\\AIB.exe', 'C:\\S', 'linux'), 'skipped');
  assertEquals(await ensureStartMenuShortcut('C:\\A\\AIB.exe', 'C:\\S', 'darwin'), 'skipped');
  assertEquals(await ensureStartMenuShortcut('C:\\deno\\deno.exe', 'C:\\S', 'windows'), 'skipped');
  assertEquals(await ensureStartMenuShortcut('C:\\A\\AIB.exe', null, 'windows'), 'skipped');
});

Deno.test({
  name: 'shortcut: made in a temp folder, kept when it points here, remade when it points elsewhere',
  ignore: Deno.build.os !== 'windows',
  fn: async () => {
    const dir = await Deno.makeTempDir();
    try {
      const exe = 'C:\\Windows\\System32\\notepad.exe'; // only the shortcut's target; nothing is started
      assertEquals(await ensureStartMenuShortcut(exe, `${dir}\\Programs`), 'made');
      const lnk = `${dir}\\Programs\\AIB.lnk`;
      assert(lnkMentions(await Deno.readFile(lnk), exe));
      assertEquals(await ensureStartMenuShortcut(exe, `${dir}\\Programs`), 'same');
      const other = 'C:\\Windows\\System32\\calc.exe';
      assertEquals(await ensureStartMenuShortcut(other, `${dir}\\Programs`), 'made');
      assert(lnkMentions(await Deno.readFile(lnk), other));
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test('a separate agent host: quitting never asks and asks it to stop unforced; Stop all chats and quit forces it', async () => {
  const stopHost = () => Promise.resolve({ stopped: true });
  const a = await makeApp(() => Promise.resolve(0), stopHost);
  try {
    a.s.windows[0].emit('close');
    await tick();
    assertEquals(a.order, ['stop:false', 'tray removed', 'quit'], 'nothing left running invisibly once the window is gone');
  } finally {
    await a.done();
  }
  for (const close of [true, false]) {
    const b = await makeApp(() => Promise.resolve(2), stopHost);
    try {
      if (close) b.s.windows[0].emit('close');
      else b.s.tray!.onMenu('quit');
      await tick();
      assertEquals(b.s.questions, []);
      assertEquals(b.order, ['stop:false', 'tray removed', 'quit'], 'the chats keep running in the agent host, under its own icon');
    } finally {
      await b.done();
    }
  }
  const c = await makeApp(() => Promise.resolve(2), stopHost);
  try {
    const t0 = Date.now();
    await c.app.requestStop(t0);
    await c.app.requestStop(t0 + 100);
    assertEquals(c.order, ['stop:true', 'tray removed', 'quit']);
  } finally {
    await c.done();
  }
  const d = await makeApp(() => Promise.resolve(0), () => Promise.reject(new Error('refused')));
  try {
    d.s.tray!.onMenu('quit');
    await tick();
    assertEquals(d.order, ['stop:false', 'tray removed', 'quit'], 'a refusal or failure never holds the quit up');
  } finally {
    await d.done();
  }
});

Deno.test({
  name: 'quitting with the real stopHost: an idle host stops; a chat that started meanwhile makes it refuse and it keeps running',
  ...TEST_OPTIONS,
  fn: async () => {
    for (const active of [0, 1]) {
      await using fx = new Fixture();
      Deno.writeTextFileSync(`${fx.state}/fake-active`, String(active));
      const [host] = fx.spawn([DENO, 'run', '-A', '--quiet', FAKE_HOST, fx.state, 'C:/x', 'studio-dev', '0.0.9', 'deno', '1'], 'fake-host');
      await until(async () => (await readInfo(fx.state))?.pid === host.pid, 'fake host file', 30);
      // The window's busy count said 0, but the host's own count is what stopHost(force=false) goes by.
      const app = await makeApp(() => Promise.resolve(0), (force) => stopHost(fx.state, force, 5));
      try {
        app.s.windows[0].emit('close');
        await until(() => app.quits.length === 1, 'quit');
        if (active) {
          assert(pidAlive(host.pid), 'a working chat keeps its host');
          assertEquals((await readInfo(fx.state))?.pid, host.pid);
        } else await until(() => !pidAlive(host.pid), 'idle host stopped');
      } finally {
        await app.done();
      }
    }
  },
});

// ---------- the window must stay on our page; the keeper must stay hidden ----------

Deno.test('page decision: ours, back (other local port, error page, blank) or external', () => {
  const page = 'http://127.0.0.1:8777/';
  assertEquals(pageDecision('http://127.0.0.1:8777/chat.html?x=1', page), 'ours');
  assertEquals(pageDecision('http://127.0.0.1:51234/', page), 'back', "the desktop runtime's own DENO_SERVE_ADDRESS port");
  assertEquals(pageDecision('http://localhost:8777/', page), 'back', 'another origin, but this machine');
  assertEquals(pageDecision('http://127.0.0.1:8778/a', page), 'back', 'the artifact origin is never handed to the browser from here');
  assertEquals(pageDecision('http://[::1]:9000/', page), 'back');
  assertEquals(pageDecision('chrome-error://chromewebdata/', page), 'back', 'the browser error page');
  assertEquals(pageDecision('about:blank', page), 'back');
  assertEquals(pageDecision('not a url', page), 'back');
  assertEquals(pageDecision('https://example.com/docs', page), 'external');
  assertEquals(pageDecision('http://192.168.1.5:8777/', page), 'external');
  assertEquals(parseProbe(JSON.stringify({ href: 'about:blank', title: '' })), { href: 'about:blank', title: '' });
  assertEquals(parseProbe(undefined), null);
  assertEquals(parseProbe('{broken'), null);
});

Deno.test('a load on another local port or an error page goes back to our page and never opens outside', async () => {
  const a = await makeApp(() => Promise.resolve(0));
  try {
    const w = a.s.windows[0];
    for (const href of ['http://127.0.0.1:51234/', 'chrome-error://chromewebdata/', 'about:blank']) {
      w.href = href;
      w.emit('load');
      await tick();
      assertEquals(w.href, 'http://127.0.0.1:8890/', href);
    }
    assertEquals(a.s.external, [], 'nothing local is ever handed to the system browser');
    w.href = 'https://example.com/x';
    w.emit('load');
    await tick();
    assertEquals(a.s.external, ['https://example.com/x']);
    assertEquals(w.href, 'http://127.0.0.1:8890/');
  } finally {
    await a.done();
  }
});

Deno.test('going back is rate-limited, so a page that fails at once makes no navigation loop', async () => {
  const a = await makeApp(() => Promise.resolve(0));
  try {
    const w = a.s.windows[0];
    const before = w.urls.length;
    for (let i = 0; i < 10; i++) {
      w.href = 'chrome-error://chromewebdata/';
      await a.app.checkPage(w, 'load');
    }
    assertEquals(w.urls.length - before, 4);
  } finally {
    await a.done();
  }
});

Deno.test('watchdog: a visible window off our page goes back; a hidden one is left; the keeper is hidden again', async () => {
  const a = await makeApp(() => Promise.resolve(0));
  try {
    const w = a.s.windows[0];
    w.href = 'http://127.0.0.1:8890/';
    await a.app.watchdogTick();
    assertEquals(w.urls.length, 1, 'on our page: nothing to do');
    w.href = 'http://127.0.0.1:40000/';
    w.visible = false;
    await a.app.watchdogTick();
    assertEquals(w.urls.length, 1, 'hidden (in the tray): left alone');
    w.visible = true;
    await a.app.watchdogTick();
    assertEquals(w.urls.at(-1), 'http://127.0.0.1:8890/');
    a.s.keeper!.visible = true;
    await a.app.watchdogTick();
    assertEquals(a.s.keeper!.visible, false);
  } finally {
    await a.done();
  }
});

Deno.test('watchdog runs on its own timer and stops with the app', async () => {
  const dir = await Deno.makeTempDir();
  const { s, shell } = fakeShell();
  const app = new DesktopApp(shell, {
    url: 'http://127.0.0.1:8890/',
    stateDir: dir,
    trayIcon: trayIconPng(),
    busyCount: () => Promise.resolve(0),
    quit: () => Promise.resolve(),
    saveDelayMs: 0,
    watchdogMs: 20,
  });
  try {
    await app.start();
    const w = s.windows[0];
    w.href = 'http://127.0.0.1:40000/';
    await tick(120);
    assertEquals(w.href, 'http://127.0.0.1:8890/');
  } finally {
    app.stop();
    await tick(30); // let a pending save timer run out
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('keeper: put on about:blank and hidden; any load or focus hides it again and sends it back to about:blank', async () => {
  const a = await makeApp(() => Promise.resolve(0));
  try {
    const k = a.s.keeper!;
    assertEquals(k.urls, [KEEPER_URL]);
    assertEquals(k.visible, false);
    k.visible = true;
    k.href = 'http://127.0.0.1:51234/';
    k.emit('load');
    await tick();
    assertEquals(k.visible, false);
    assertEquals(k.urls.at(-1), KEEPER_URL);
    k.visible = true;
    k.emit('focus');
    assertEquals(k.visible, false);
    assertEquals(a.s.windows.length, 1, 'the keeper is not the window: the app still has one');
  } finally {
    await a.done();
  }
});

Deno.test('the first load of our page calls onPageLoaded once (the update health marker)', async () => {
  const dir = await Deno.makeTempDir();
  const { s, shell } = fakeShell();
  let loaded = 0;
  const app = new DesktopApp(shell, {
    url: 'http://127.0.0.1:8890/',
    stateDir: dir,
    trayIcon: trayIconPng(),
    busyCount: () => Promise.resolve(0),
    quit: () => Promise.resolve(),
    onPageLoaded: () => void loaded++,
    saveDelayMs: 0,
    watchdogMs: 0,
  });
  try {
    await app.start();
    const w = s.windows[0];
    w.href = 'about:blank';
    w.emit('load');
    await tick();
    assertEquals(loaded, 0, 'not our page yet');
    w.href = 'http://127.0.0.1:8890/';
    w.emit('load');
    w.emit('load');
    await tick();
    assertEquals(loaded, 1);
  } finally {
    app.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('the last port is reused when free (same origin, so localStorage drafts survive a restart or an update)', async () => {
  const dir = await Deno.makeTempDir();
  try {
    assertEquals(lastPortPair(dir, () => true), null, 'nothing saved yet');
    saveLastPort(dir, 8781);
    assertEquals(lastPortPair(dir, () => true), 8781);
    assertEquals(lastPortPair(dir, (p) => p !== 8782), null, 'its artifact port is taken: choose again');
    Deno.writeTextFileSync(`${dir}/desktop-port.json`, '{"port": "x"}');
    assertEquals(lastPortPair(dir, () => true), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------- keeper gap 2: the keeper's orphan restart starts AIB in the tray, never with a window ----------

async function trayOnlyApp(counts: { working: number; needsYou: number }, answer = false, idleMs = 10_000) {
  const dir = await Deno.makeTempDir();
  const { s, shell } = fakeShell(answer);
  const updates: [string, number, string][] = [];
  shell.updateTray = (tooltip, index, label) => void updates.push([tooltip, index, label]);
  const quits: boolean[] = [];
  const app = new DesktopApp(shell, {
    url: 'http://127.0.0.1:8890/',
    stateDir: dir,
    trayIcon: trayIconPng(),
    busyCount: () => Promise.resolve(counts.working),
    trayCounts: () => Promise.resolve({ ...counts }),
    quit: (stop) => (quits.push(stop), Promise.resolve()),
    saveDelayMs: 0,
    watchdogMs: 0,
    startInTray: true,
    trayPollMs: 0,
    trayIdleQuitMs: idleMs,
  });
  await app.start();
  return { app, s, updates, quits, done: () => (app.stop(), Deno.remove(dir, { recursive: true })) };
}

Deno.test('tray-only start (--start-in-tray): no window, a keeper, the tray menu Open AIB / status / Quit AIB / Stop all chats and quit', async () => {
  const counts = { working: 2, needsYou: 1 };
  const { app, s, updates, quits, done } = await trayOnlyApp(counts);
  try {
    assertEquals(s.windows.length, 0, 'nothing pops up over the person\'s work');
    assertEquals(s.keepers, 1, 'the hidden keeper window keeps the runtime alive');
    assertEquals(s.tray?.items.map((i) => i.label), ['Open AIB', '', 'Quit AIB', 'Stop all chats and quit']);
    assertEquals(updates.at(-1), ['AIB · 1 chat needs you, 1 running', 1, '1 chat needs you, 1 running']);
    counts.needsYou = 0;
    await app.trayTick();
    assertEquals(updates.at(-1), ['AIB · 2 chats running', 1, '2 chats running']);
    // A left click or Open AIB makes the window as usual.
    s.tray!.onMenu('open');
    await until(() => s.windows.length === 1, 'the window opens');
    assertEquals(s.windows[0].urls, ['http://127.0.0.1:8890/']);
    assertEquals(quits, []);
  } finally {
    await done();
  }
});

Deno.test('tray-only start: Stop all chats and quit confirms in the menu (no box), then stops the chats and quits', async () => {
  const counts = { working: 1, needsYou: 0 };
  const a = await trayOnlyApp(counts);
  try {
    a.s.tray!.onMenu('stop');
    await until(() => a.updates.some((u) => u[1] === STOP_INDEX), 'the confirm line');
    assertEquals(a.updates.at(-1)?.slice(1), [STOP_INDEX, 'Click again to stop 1 chat and quit']);
    assertEquals(a.quits, []);
    a.s.tray!.onMenu('stop');
    await until(() => a.quits.length === 1, 'quit');
    assertEquals(a.quits, [true], 'stop the agents');
    assertEquals(a.s.trayRemoved, 1, 'no dead icon left behind');
    assertEquals(a.s.questions, []);
  } finally {
    await a.done();
  }
});

Deno.test('tray-only start: quits by itself once nothing has worked for a while, unless the window is open', async () => {
  const counts = { working: 1, needsYou: 0 };
  const a = await trayOnlyApp(counts, false, 5000);
  try {
    const t0 = Date.now();
    await a.app.trayTick(t0);
    counts.working = 0;
    await a.app.trayTick(t0 + 1000);
    await a.app.trayTick(t0 + 5500);
    assertEquals(a.quits, [], 'not yet: idle for 4.5 s');
    await a.app.trayTick(t0 + 6100);
    assertEquals(a.quits, [false], 'idle 5.1 s: quit, chats not stopped by force');
  } finally {
    await a.done();
  }
  const b = await trayOnlyApp({ working: 0, needsYou: 0 }, false, 5000);
  try {
    b.s.tray!.onClick();
    await until(() => b.s.windows.length === 1, 'the window opens');
    const t0 = Date.now();
    await b.app.trayTick(t0);
    await b.app.trayTick(t0 + 60_000);
    assertEquals(b.quits, [], 'the person opened the window: AIB stays');
  } finally {
    await b.done();
  }
  assertEquals(trayOnlyView(0, 0).status, 'No chat is working');
});
Deno.test('tray-only start: the orphan command adds --start-in-tray for the desktop app only; an update drops it again', () => {
  assertEquals(orphanCommand([], true).args!.slice(-1), ['--start-in-tray']);
  assertEquals(orphanCommand(['--port', '8821'], true).args!.slice(-3), ['--port', '8821', '--start-in-tray']);
  assertEquals(orphanCommand(['--start-in-tray'], true).args!.filter((a) => a === '--start-in-tray').length, 1);
  assert(!orphanCommand(['serve', '--port', '8821'], true).args!.includes('--start-in-tray'), 'serve has no window to keep away');
  assert(!orphanCommand([], false).args!.includes('--start-in-tray'), 'a source run has no window either');
  const dir = Deno.makeTempDirSync();
  try {
    const service = new UpdateService(dir, { appArgs: ['--port', '8821', '--start-in-tray'], autoCheck: () => false });
    assertEquals(service.appArgs, ['--port', '8821'], 'the new version opens its window again');
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test('tray-only start: a data folder already taken exits quietly (no window asked to show, no message box)', async () => {
  const dir = await Deno.makeTempDir();
  const { s, shell } = fakeShell(true);
  const other = await claimFolder(dir, { mode: 'desktop' });
  try {
    assert(other.primary);
    let code: number | null = null;
    await guardDataFolder(dir, {
      mode: 'desktop',
      quiet: true,
      say: () => {},
      notice: async (m) => void (await shell.ask(m)),
      exit: (c) => {
        code = c;
        throw new Error('exit');
      },
    }).catch(() => {});
    assertEquals(code, 0);
    assertEquals(s.questions, [], 'no message box');
    assertEquals(await takeSignal(dir), false, 'the running app is not asked to show its window');
  } finally {
    if (other.primary) other.release();
    await Deno.remove(dir, { recursive: true });
  }
});
