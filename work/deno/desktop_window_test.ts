/**
 * The desktop app's logic (server/desktop/window.ts, single_instance.ts, shortcut.ts) with a fake Shell: no window, tray, dialog or
 * notification is ever shown. The shortcut test writes only into a temp folder.
 */
import { assert, assertEquals } from './_assert.ts';
import { saveRemotePort } from '../../app/server/remote/port.ts';
import {
  choosePortPair,
  desktopPort,
  moveDesktopPort,
  cleanGeometry,
  closeDecision,
  DEFAULT_SIZE,
  DesktopApp,
  type DesktopOptions,
  GEOMETRY_FILE,
  isExternal,
  KEEPER_URL,
  lastPortPair,
  loadGeometry,
  PAGE_AUTH_PROBE,
  PAGE_PROBE,
  pageDecision,
  pageKeyScript,
  parseProbe,
  PHONE_ON_TOOLTIP,
  portFree,
  portGiven,
  rateLimiter,
  saveGeometry,
  saveLastPort,
  type Shell,
  SLOT_ITEMS,
  STOP_CONFIRM_MS,
  STOP_INDEX,
  stopConfirmLabel,
  TRAY_ITEMS,
  TRAY_SLOTS,
  trayChatSlots,
  trayOnlyView,
  type WindowHandle,
} from '../../app/server/desktop/window.ts';
import {
  canPlaceWindows,
  chooseOrder,
  cleanSavedList,
  loadSavedList,
  openAnswer,
  restorePlan,
  WINDOWS_FILE,
} from '../../app/server/desktop/windows.ts';
import { withPopFrom } from '../../app/server/web/server.ts';

type Json = Record<string, unknown>;
import { findOwnWindow } from '../../app/server/desktop/foreground_win.ts';
import { presence as folderPresence } from '../../app/server/desktop/folder_presence.ts';
import { orphanCommand } from '../../app/server/host/aib.ts';
import { PageAccess } from '../../app/server/web/page_access.ts';
import { UpdateService } from '../../app/server/desktop/updater.ts';
import {
  alreadyRunning,
  claim,
  claimFolder,
  guardDataFolder,
  SIGNAL_FILE,
  takeSignal,
  watchSignal,
} from '../../app/server/desktop/single_instance.ts';
import {
  ensureStartMenuShortcut,
  lnkMentions,
  shortcutArgs,
  shortcutScript,
  startMenuDir,
} from '../../app/server/desktop/shortcut.ts';
import { trayIconPng } from '../../app/server/desktop/tray_icon.ts';
import {
  chosenItem,
  menuCommand,
  notifyIconData,
  NOTIFYICONDATAW_SIZE,
  SLOT_SEPARATOR_COMMAND,
  slotMenuOps,
  TRAY_CALLBACK,
  trayEvent,
} from '../../app/server/desktop/tray_win.ts';
import { pidAlive, readInfo, stopHost } from '../../app/server/host/host_client.ts';
import { DENO, FAKE_HOST, Fixture, TEST_OPTIONS, until } from './_host_fixture.ts';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
/** Every write of the window list has landed (a test's temp folder is removed only after). */
async function settled(app: DesktopApp): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const w = app.windows.writing;
    await w;
    await tick(5);
    if (w === app.windows.writing) return;
  }
}
/** Until `ready()` holds (10 s at most). For steps that do real I/O first: a new window reads its saved geometry from disk, which a
 * busy machine can take longer than one tick() for. */
async function waitFor(ready: () => boolean, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await tick(10);
  }
}

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
  assertEquals(portGiven(['--port', '8890']), true); // port-guard: not bound (argv parsing)
  assertEquals(portGiven(['--port=8890']), true); // port-guard: not bound (argv parsing)
  assertEquals(portGiven(['--host-port', '1']), false); // port-guard: not bound (argv parsing)
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

let fakeHwnds = 100;
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
  /** Its own native handle (B1), a distinct number per window. */
  hwnd = BigInt(++fakeHwnds);
  minimized = false;
  maximized = false;
  /** What openFromDesktop answers (K6), and the targets it was asked to open. */
  openAnswer: unknown = 'mine';
  opened: unknown[] = [];
  constructor(readonly options: { title: string; width: number; height: number; x?: number; y?: number }) {
    this.size = [options.width, options.height];
  }
  close() {
    this.closed = true; // from code: no close event (S4)
    this.log.push('close');
  }
  nativeHandle() {
    return this.closed ? null : this.hwnd;
  }
  state() {
    return { minimized: this.minimized, maximized: this.maximized };
  }
  maximize() {
    this.maximized = true;
    this.log.push('maximize');
  }
  /** What the page holds (page-auth.js, in its memory): a new page has no session; `waiting` while a key is on its way. */
  held = { auth: true, session: '', waiting: false };
  /** The launch keys handed to the page (pageKeyScript), what the page answers, and what it does with one (trade it). */
  handed: string[] = [];
  keyAnswer: unknown = 'ok';
  onKey: ((key: string) => void) | null = null;
  navigate(url: string) {
    this.urls.push(url);
    this.href = url;
    this.held = { auth: true, session: '', waiting: false }; // a new page: the old one's memory is gone
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
    if (code === PAGE_AUTH_PROBE) return Promise.resolve(JSON.stringify(this.held));
    const handed = /a\.accept\("([A-Za-z0-9_-]+)"\)/.exec(code);
    if (handed && code.startsWith('(function(){if(location.origin!==')) {
      this.handed.push(handed[1]);
      if (this.keyAnswer === 'ok') this.onKey?.(handed[1]);
      return Promise.resolve(this.keyAnswer);
    }
    const open = /openFromDesktop\((.*)\);return r===/.exec(code);
    if (open) {
      this.opened.push(JSON.parse(open[1]));
      const a = this.openAnswer;
      return Promise.resolve(a === true || a === 'mine' ? 'mine' : a === 'no' ? 'no' : false);
    }
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
    /** bringToFront calls: the handle each was given (B1). */
    fronts: [] as (bigint | null)[],
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
    bringToFront: (hwnd) => (s.fronts.push(hwnd ?? null), { found: true, restored: false, foreground: true }),
    notifier: {
      mechanism: 'fake',
      show: (t, b) => (s.notes.push([t, b]), Promise.resolve({ shown: true, code: 1 })),
    },
  };
  return { s, shell };
}

/**
 * The app as main.ts makes it. stopHost null (default): one process; a function: a separate agent host (an older version's, being
 * drained). No canLeave (default): as with no keeper, so Quit AIB with work keeps AIB in the tray; extra.canLeave: the keeper's rule.
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
  const leaves: boolean[] = [];
  const order: string[] = [];
  const stops: boolean[] = [];
  const options: DesktopOptions = {
    url: 'http://127.0.0.1:8890/',
    stateDir: dir,
    trayIcon: trayIconPng(),
    busyCount: busy,
    ...(stopHost ? { stopHost: (force: boolean) => (stops.push(force), order.push(`stop:${force}`), stopHost(force)) } : {}),
    quit: (stop, leave) => (quits.push(stop), leaves.push(!!leave), order.push('quit'), Promise.resolve()),
    saveDelayMs: 0,
    watchdogMs: 0,
    trayPollMs: 0,
    ...extra,
  };
  const removeTray = shell.removeTray!;
  shell.removeTray = () => (order.push('tray removed'), removeTray());
  const app = new DesktopApp(shell, options);
  await app.start();
  return {
    app,
    s,
    updates,
    quits,
    leaves,
    stops,
    order,
    dir,
    done: () => (app.stop(), settled(app).then(() => Deno.remove(dir, { recursive: true }))),
  };
}

Deno.test('start: one window titled AIB on the page, a keeper, a tray, two bindings that hand out nothing', async () => {
  const { s, done } = await makeApp(() => Promise.resolve(0));
  try {
    assertEquals(s.windows.length, 1);
    const w = s.windows[0];
    assertEquals(w.options.title, 'AIB');
    assertEquals(w.urls, ['http://127.0.0.1:8890/?w=m']);
    assertEquals([...w.bound.keys()], ['aibDesktop', 'aibPageKey'], 'it says "the app" and takes a key request; nothing comes back');
    assertEquals(await w.bound.get('aibDesktop')!(), true);
    assertEquals(s.keepers, 1);
    assertEquals(s.tray?.items.filter((i) => !(i as { hidden?: boolean }).hidden).map((i) => i.label), [
      'Open AIB',
      '',
      'Quit AIB',
      'Stop all chats and quit',
    ]);
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
    await waitFor(() => s.windows.length > 1 && s.windows[1].urls.length > 0, 'the new window on the page');
    assertEquals(s.windows.length, 2, 'the closed window is gone: a new one');
    assertEquals(s.windows[1].urls, ['http://127.0.0.1:8890/?w=m']);
    assert(!app.background, 'the person is back');
    s.tray!.onMenu('open'); // already open: show and focus, no third window
    await waitFor(() => s.windows[1].log.slice(-2).join() === 'show,focus', 'show and focus');
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
    assertEquals(a.s.tray?.items, [...TRAY_ITEMS, ...SLOT_ITEMS], 'the fixed items, then the chat slots (hidden until used)');
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
    await waitFor(() => a.s.windows.length > 1 && a.s.windows[1].urls.length > 0, 'the new window on the page');
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

Deno.test('Quit AIB or closing the window with work the keeper can hold: AIB exits, leaving it to the keeper (as Install now does)', async () => {
  for (const how of ['menu', 'close'] as const) {
    const a = await makeApp(() => Promise.resolve(2), null, { canLeave: () => Promise.resolve('') });
    try {
      if (how === 'menu') a.s.tray!.onMenu('quit');
      else a.s.windows[0].emit('close');
      await tick(20);
      assertEquals(a.s.questions, [], 'no native box');
      assertEquals([a.quits, a.leaves], [[false], [true]], `${how}: quit, nothing stopped, the chats left to the keeper`);
      assert(!a.app.background, 'AIB does not stay in the tray');
      assertEquals(a.s.trayRemoved, 1, 'the icon goes with AIB');
      assertEquals(a.s.windows[0].visible === false || a.s.windows[0].closed, true, 'the window is gone');
    } finally {
      await a.done();
    }
  }
  // Only a terminal command (in the keeper) works: the same.
  const t = await makeApp(() => Promise.resolve(0), null, { canLeave: () => Promise.resolve(''), terminalsBusy: () => 1 });
  try {
    t.s.tray!.onMenu('quit');
    await tick(20);
    assertEquals([t.quits, t.leaves], [[false], [true]]);
  } finally {
    await t.done();
  }
});

Deno.test('Quit AIB when the keeper cannot hold the work (too old, a chat outside it, or the check fails): AIB stays in the tray as before', async () => {
  for (const canLeave of [() => Promise.resolve('the running keeper (1.2.0) cannot hold chats'), () => Promise.reject(new Error('boom'))]) {
    const a = await makeApp(() => Promise.resolve(1), null, { canLeave, trayIdleQuitMs: 5000 });
    try {
      a.s.tray!.onMenu('quit');
      await tick(20);
      assertEquals(a.quits, [], 'nothing stopped, AIB does not exit');
      assert(a.app.background, 'in the tray, quitting by itself once nothing works');
      assertEquals(a.s.windows[0].visible, false);
    } finally {
      a.app.stop();
      await a.done();
    }
  }
});

Deno.test('Quit AIB lets a running merge finish before AIB exits; opening the window meanwhile calls the exit off', async () => {
  let merges = 1;
  const a = await makeApp(() => Promise.resolve(1), null, { canLeave: () => Promise.resolve(''), mergesRunning: () => merges });
  try {
    a.s.tray!.onMenu('quit');
    await tick(600);
    assertEquals(a.quits, [], 'the merge still runs: AIB waits');
    assertEquals(a.s.windows[0].visible, false, 'with the window gone');
    merges = 0;
    await until(() => a.quits.length === 1, 'exit after the merge', 3);
    assertEquals(a.leaves, [true]);
  } finally {
    await a.done();
  }
  merges = 1;
  const b = await makeApp(() => Promise.resolve(1), null, { canLeave: () => Promise.resolve(''), mergesRunning: () => merges });
  try {
    b.s.tray!.onMenu('quit');
    await tick(300);
    b.s.tray!.onMenu('open');
    await tick(20);
    merges = 0;
    await tick(600);
    assertEquals(b.quits, [], 'the person came back: AIB stays');
    assertEquals(b.s.windows[0].visible, true);
  } finally {
    b.app.stop();
    await b.done();
  }
  const c = await makeApp(() => Promise.resolve(1), null, {
    canLeave: () => Promise.resolve(''),
    mergesRunning: () => 1,
    mergeWaitMs: 400,
  });
  try {
    c.s.tray!.onMenu('quit');
    await until(() => c.quits.length === 1, 'a merge that never ends does not keep AIB forever', 3);
  } finally {
    await c.done();
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
    w.href = 'http://127.0.0.1:8890/?w=m';
    w.emit('load'); // S7: geometry is read only after the first load
    await tick();
    w.size = [1000, 700];
    w.pos = [30, 40];
    w.emit('move');
    await tick(20);
    await settled(a.app);
    const saved = JSON.parse(await Deno.readTextFile(`${a.dir}/${WINDOWS_FILE}`));
    assertEquals(saved.windows, [{ id: 'm', kind: 'main', width: 1000, height: 700, x: 30, y: 40, maximized: false }]);
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
    assertEquals(w.urls.at(-1), 'http://127.0.0.1:8890/?w=m');
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

/** quit() waits for the window list's last write (G8, a real file write) before it calls the app's quit: wait for that (≤ 2 s). */
async function quitDone(order: string[]): Promise<void> {
  for (let i = 0; i < 200 && !order.includes('quit'); i++) await tick(10);
}

Deno.test('a separate agent host: quitting never asks and asks it to stop unforced; Stop all chats and quit forces it', async () => {
  const stopHost = () => Promise.resolve({ stopped: true });
  const a = await makeApp(() => Promise.resolve(0), stopHost);
  try {
    a.s.windows[0].emit('close');
    await quitDone(a.order);
    assertEquals(a.order, ['stop:false', 'tray removed', 'quit'], 'nothing left running invisibly once the window is gone');
  } finally {
    await a.done();
  }
  for (const close of [true, false]) {
    const b = await makeApp(() => Promise.resolve(2), stopHost);
    try {
      if (close) b.s.windows[0].emit('close');
      else b.s.tray!.onMenu('quit');
      await quitDone(b.order);
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
      assertEquals(w.href, 'http://127.0.0.1:8890/?w=m', href);
    }
    assertEquals(a.s.external, [], 'nothing local is ever handed to the system browser');
    w.href = 'https://example.com/x';
    w.emit('load');
    await tick();
    assertEquals(a.s.external, ['https://example.com/x']);
    assertEquals(w.href, 'http://127.0.0.1:8890/?w=m');
  } finally {
    await a.done();
  }
});

/** The window side of page_access.ts as main.ts wires it: one-time keys, and the page that trades a handed key for a session. */
function pageKeysFor(access: PageAccess, w?: FakeWindow) {
  if (w) w.onKey = (key) => (w.held = { ...w.held, session: access.pair(key) ?? '' });
  return {
    pageConnected: (held: { session: string }) => access.holds(held),
    pageKeys: { mint: () => access.mintKey(), revoke: (key: string) => access.revoke(key) },
  };
}

Deno.test('a page without a session is handed a one-time key through the private channel: never in a URL, never a navigation', async () => {
  const access = new PageAccess(null, null);
  const base = 'http://127.0.0.1:8890';
  const a = await makeApp(() => Promise.resolve(0), null, { url: `${base}/`, ...pageKeysFor(access) });
  try {
    const w = a.s.windows[0];
    pageKeysFor(access, w);
    assertEquals(w.urls, [`${base}/?w=m`], 'the window opens on its plain page: no key in the URL');
    // The page loads; page-auth.js asked through the binding (aibPageKey) as soon as it ran: the key goes to the top frame.
    w.href = `${base}/?w=m`;
    w.bound.get('aibPageKey')!();
    await tick();
    assertEquals(w.handed.length, 1);
    assert(access.holds(w.held), 'the page traded it for a session the server knows');
    assertEquals(access.pair(w.handed[0]), null, 'the handed key is used up');
    w.emit('load');
    await tick();
    await a.app.watchdogTick();
    assertEquals([w.handed.length, w.urls.length], [1, 1], 'connected: left alone, nothing navigated');
    // A reload (Ctrl+R, a crashed page): a new page with no session. The load check hands it one (a binding call may not come).
    w.held = { auth: true, session: '', waiting: false };
    w.emit('load');
    await tick();
    assertEquals(w.handed.length, 2);
    assert(access.holds(w.held));
    assertEquals(w.urls.length, 1, 'still no navigation');
    // A page that is waiting for its key already (asked through the binding) is not sent a second one.
    w.held = { auth: true, session: '', waiting: true };
    w.emit('load');
    await tick();
    assertEquals(w.handed.length, 2, 'a key is on its way: left alone');
    // Not our page any more (the window shows another site): the script refuses in the page itself, and the key is revoked.
    w.held = { auth: true, session: '', waiting: false };
    w.keyAnswer = 'elsewhere';
    w.bound.get('aibPageKey')!();
    await tick();
    assertEquals(w.handed.length, 3);
    assertEquals(access.pair(w.handed[2]), null, 'a key the page did not take is revoked at once');
    // A page that never connects gets at most 3 keys a minute from the load check, and 6 asked ones (artifact frames can call it).
    for (let i = 0; i < 10; i++) await a.app.checkPage(w, 'load');
    assertEquals(w.handed.length, 3 + 2, 'at most 3 load-check keys in 60 s (one used above)');
    for (let i = 0; i < 10; i++) w.bound.get('aibPageKey')!();
    await tick();
    assertEquals(w.handed.length, 5 + 4, 'at most 6 asked keys in 60 s (two used above)');
    // The script itself: checks the origin in the page, in the same turn, before page-auth.js sees the key.
    const script = pageKeyScript('http://127.0.0.1:8890', 'k'.repeat(43));
    assert(script.startsWith(`(function(){if(location.origin!=="http://127.0.0.1:8890")return 'elsewhere';`), script);
  } finally {
    await a.done();
  }
});

Deno.test('no pageConnected check (other tests): our page is never navigated for the key', async () => {
  const a = await makeApp(() => Promise.resolve(0));
  try {
    const w = a.s.windows[0];
    w.href = 'http://127.0.0.1:8890/?w=m';
    w.emit('load');
    await tick();
    assertEquals(w.urls.length, 1);
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
    w.href = 'http://127.0.0.1:8890/?w=m';
    await a.app.watchdogTick();
    assertEquals(w.urls.length, 1, 'on our page: nothing to do');
    w.href = 'http://127.0.0.1:40000/';
    w.visible = false;
    await a.app.watchdogTick();
    assertEquals(w.urls.length, 1, 'hidden (in the tray): left alone');
    w.visible = true;
    await a.app.watchdogTick();
    assertEquals(w.urls.at(-1), 'http://127.0.0.1:8890/?w=m');
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
    assertEquals(w.href, 'http://127.0.0.1:8890/?w=m');
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
    w.href = 'http://127.0.0.1:8890/?w=m';
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

Deno.test('the window port never takes the saved phone port or its artifact port; moveDesktopPort frees a held one', async () => {
  const dir = await Deno.makeTempDir();
  try {
    // fake "free" checks only: nothing is bound
    saveRemotePort(dir, 8779, 8782);
    saveLastPort(dir, 8779); // the clash from the owner's PC: the window's saved port is the phone port
    assertEquals(desktopPort(dir, () => true), 8777, 'the saved window port is the phone port: choose another pair');
    saveLastPort(dir, 8778); // pair 8778/8779 overlaps the phone port too
    assertEquals(desktopPort(dir, () => true), 8777);
    saveRemotePort(dir, 8777, 8780);
    assertEquals(desktopPort(dir, () => true), 8778, 'neither 8777 nor 8780 nor a pair that contains them');
    saveLastPort(dir, 8785);
    assertEquals(desktopPort(dir, () => true), 8785, 'a saved port that clashes with nothing is kept');
    assertEquals(moveDesktopPort(dir, () => true, 8785), 8778, 'moves to the first free pair, not the current one or a reserved port');
    assertEquals(lastPortPair(dir, () => true), 8778, 'saved for the next start');
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
    assertEquals(s.windows.length, 0, "nothing pops up over the person's work");
    assertEquals(s.keepers, 1, 'the hidden keeper window keeps the runtime alive');
    assertEquals(s.tray?.items.filter((i) => !(i as { hidden?: boolean }).hidden).map((i) => i.label), [
      'Open AIB',
      '',
      'Quit AIB',
      'Stop all chats and quit',
    ]);
    assertEquals(updates.at(-1), ['AIB · 1 chat needs you, 1 running', 1, '1 chat needs you, 1 running']);
    counts.needsYou = 0;
    await app.trayTick();
    assertEquals(updates.at(-1), ['AIB · 2 chats running', 1, '2 chats running']);
    // A left click or Open AIB makes the window as usual.
    s.tray!.onMenu('open');
    await until(() => s.windows.length === 1, 'the window opens');
    assertEquals(s.windows[0].urls, ['http://127.0.0.1:8890/?w=m']);
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
  assertEquals(orphanCommand(['--port', '8821'], true).args!.slice(-3), ['--port', '8821', '--start-in-tray']); // port-guard: not bound (argv only)
  assertEquals(orphanCommand(['--start-in-tray'], true).args!.filter((a) => a === '--start-in-tray').length, 1);
  assert(!orphanCommand(['serve', '--port', '8821'], true).args!.includes('--start-in-tray'), 'serve has no window to keep away'); // port-guard: not bound (argv only)
  assert(!orphanCommand([], false).args!.includes('--start-in-tray'), 'a source run has no window either');
  const dir = Deno.makeTempDirSync();
  try {
    const service = new UpdateService(dir, { appArgs: ['--port', '8821', '--start-in-tray'], autoCheck: () => false }); // port-guard: not bound (argv only, never launched)
    assertEquals(service.appArgs, ['--port', '8821'], 'the new version opens its window again'); // port-guard: not bound (argv only)
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

// ---------- phone access on: closing the window keeps AIB in the tray (owner's decision 2026-11-12, "Yes, keep in tray") ----------

Deno.test('close decision with phone access on: the tray whatever works; off: the same results as before', () => {
  for (const work of [0, 1, 5, null]) assertEquals(closeDecision(work, true), 'tray', `phone on, ${work} working`);
  assertEquals([closeDecision(0, false), closeDecision(1, false), closeDecision(null, false)], ['quit', 'tray', 'tray']);
});

Deno.test('phone access on: closing the window with nothing working keeps AIB in the tray, no idle quit; Open AIB brings it back', async () => {
  const a = await makeApp(() => Promise.resolve(0), null, { phoneOn: () => true, trayIdleQuitMs: 5000 });
  try {
    a.s.windows[0].emit('close');
    await tick(20);
    assertEquals(a.quits, [], 'AIB does not quit');
    assertEquals(a.s.trayRemoved, 0, 'the tray icon stays');
    assert(a.app.background, 'no window, in the tray');
    const t0 = Date.now();
    for (const at of [0, 6_000, 60_000, 3_600_000]) await a.app.trayTick(t0 + at);
    assertEquals(a.quits, [], 'no idle self-quit while phone access is on (an hour of nothing working)');
    a.s.tray!.onClick();
    await waitFor(() => a.s.windows.length === 2, 'a new window');
    assertEquals(a.s.windows[1].urls, ['http://127.0.0.1:8890/?w=m']);
    assert(!a.app.background);
  } finally {
    await a.done();
  }
});

Deno.test('phone access on: closing with work the keeper could hold, or with a separate agent host, still keeps AIB in the tray', async () => {
  const leave = await makeApp(() => Promise.resolve(2), null, { phoneOn: () => true, canLeave: () => Promise.resolve('') });
  try {
    leave.s.windows[0].emit('close');
    await tick(20);
    assertEquals([leave.quits, leave.leaves], [[], []], 'AIB does not exit: the phone keeps reaching it');
    assert(leave.app.background);
  } finally {
    await leave.done();
  }
  const split = await makeApp(() => Promise.resolve(0), () => Promise.resolve({ stopped: true }), { phoneOn: () => true });
  try {
    split.s.windows[0].emit('close');
    await tick(20);
    assertEquals(split.order, [], 'the agent host is not asked to stop, AIB does not quit');
    assert(split.app.background);
  } finally {
    await split.done();
  }
});

Deno.test('phone access on: Quit AIB quits exactly as before (nothing working: quit; work the keeper holds: left to the keeper)', async () => {
  const idle = await makeApp(() => Promise.resolve(0), null, { phoneOn: () => true });
  try {
    idle.s.windows[0].emit('close'); // first into the tray, then Quit from its menu
    await tick(20);
    assertEquals(idle.quits, []);
    idle.s.tray!.onMenu('quit');
    await tick(20);
    assertEquals([idle.quits, idle.leaves], [[false], [false]], 'quit, nothing stopped');
    assertEquals(idle.s.trayRemoved, 1);
  } finally {
    await idle.done();
  }
  const busy = await makeApp(() => Promise.resolve(2), null, { phoneOn: () => true, canLeave: () => Promise.resolve('') });
  try {
    busy.s.tray!.onMenu('quit');
    await tick(20);
    assertEquals([busy.quits, busy.leaves], [[false], [true]], 'the chats are left to the keeper, never stopped');
  } finally {
    await busy.done();
  }
});

Deno.test('phone access off: closing the window does what it did before (quit when idle, leave to the keeper when it can hold)', async () => {
  const idle = await makeApp(() => Promise.resolve(0), null, { phoneOn: () => false });
  try {
    idle.s.windows[0].emit('close');
    await tick(20);
    assertEquals(idle.quits, [false]);
  } finally {
    await idle.done();
  }
  const busy = await makeApp(() => Promise.resolve(2), null, { phoneOn: () => false, canLeave: () => Promise.resolve('') });
  try {
    busy.s.windows[0].emit('close');
    await tick(20);
    assertEquals([busy.quits, busy.leaves], [[false], [true]]);
  } finally {
    await busy.done();
  }
  const broken = await makeApp(() => Promise.resolve(0), null, {
    phoneOn: () => {
      throw new Error('boom');
    },
  });
  try {
    broken.s.windows[0].emit('close');
    await tick(20);
    assertEquals(broken.quits, [false], 'a phoneOn that throws counts as off');
  } finally {
    await broken.done();
  }
});

Deno.test('phone access turned off while AIB sits in the tray: the idle rule again (quits once nothing has worked for a while)', async () => {
  const phone = { on: true };
  let working = 1;
  const a = await makeApp(() => Promise.resolve(working), null, { phoneOn: () => phone.on, trayIdleQuitMs: 5000 });
  try {
    a.s.windows[0].emit('close');
    await tick(20);
    assert(a.app.background);
    const t0 = Date.now();
    phone.on = false;
    await a.app.trayTick(t0);
    await a.app.trayTick(t0 + 30_000);
    assertEquals(a.quits, [], 'a chat still works: AIB stays until it finishes (nothing is cut off)');
    working = 0;
    await a.app.trayTick(t0 + 31_000);
    await a.app.trayTick(t0 + 35_500);
    assertEquals(a.quits, [], 'idle 4.5 s: not yet');
    await a.app.trayTick(t0 + 36_100);
    assertEquals(a.quits, [false], 'idle 5.1 s: quit');
  } finally {
    await a.done();
  }
});

Deno.test('tray tooltip: "AIB · Phone access on" with the counts while phone access is on; it follows the switch', async () => {
  assertEquals(PHONE_ON_TOOLTIP, 'Phone access on');
  assertEquals(trayOnlyView(2, 0, true), { status: '2 chats running', tooltip: 'AIB · Phone access on · 2 chats running' });
  assertEquals(trayOnlyView(0, 0, true).tooltip, 'AIB · Phone access on · No chat is working');
  assertEquals(trayOnlyView(2, 1, true).tooltip, 'AIB · Phone access on · 1 chat needs you, 1 running');
  assertEquals(trayOnlyView(2, 0).tooltip, 'AIB · 2 chats running', 'off: as before');
  const phone = { on: true };
  const a = await makeApp(() => Promise.resolve(2), null, { phoneOn: () => phone.on });
  try {
    assertEquals(a.updates.at(-1), ['AIB · Phone access on · 2 chats running', 1, '2 chats running']);
    phone.on = false;
    await a.app.trayTick();
    assertEquals(a.updates.at(-1), ['AIB · 2 chats running', 1, '2 chats running'], 'same counts, the tooltip still changes');
    phone.on = true;
    await a.app.trayTick();
    assertEquals(a.updates.at(-1)?.[0], 'AIB · Phone access on · 2 chats running');
  } finally {
    await a.done();
  }
});

Deno.test('tray-only start (--start-in-tray) with phone access on: no idle quit; turned off: it quits once idle', async () => {
  const dir = await Deno.makeTempDir();
  const { shell } = fakeShell();
  const quits: boolean[] = [];
  const phone = { on: true };
  const app = new DesktopApp(shell, {
    url: 'http://127.0.0.1:8890/',
    stateDir: dir,
    trayIcon: trayIconPng(),
    busyCount: () => Promise.resolve(0),
    quit: (stop) => (quits.push(stop), Promise.resolve()),
    saveDelayMs: 0,
    watchdogMs: 0,
    startInTray: true,
    trayPollMs: 0,
    trayIdleQuitMs: 5000,
    phoneOn: () => phone.on,
  });
  try {
    await app.start();
    const t0 = Date.now();
    await app.trayTick(t0);
    await app.trayTick(t0 + 600_000);
    assertEquals(quits, [], 'the phones keep reaching AIB after the keeper restarted it');
    phone.on = false;
    await app.trayTick(t0 + 600_100);
    await app.trayTick(t0 + 606_000);
    assertEquals(quits, [false]);
  } finally {
    app.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('tray chat slots: up to 5 blocked chats in the menu, "+N more" past that, a click opens the chat; the window icon gets the attention dot (inbox 1b)', async () => {
  // the pure rule
  assertEquals(trayChatSlots([]), []);
  const chats = Array.from({ length: 7 }, (_, i) => ({ key: `claude:s${i}`, title: `Chat ${i}`, reason: i === 1 ? 'failed' : 'approval' }));
  assertEquals(trayChatSlots(chats.slice(0, 2)).map((x) => x.label), ['Chat 0 · Approval', 'Chat 1 · Failed']);
  assertEquals(trayChatSlots(chats.slice(0, 5)).length, TRAY_SLOTS, 'five fit without "+N more"');
  const many = trayChatSlots(chats);
  assertEquals(many.length, TRAY_SLOTS);
  assertEquals(many.at(-1), { label: '+3 more', target: { type: 'inbox' } }, '4 chats and "+3 more", which opens the inbox');
  assertEquals(
    trayChatSlots(chats.slice(0, 1), 3).map((x) => x.label),
    ['Chat 0 · Approval', '+2 more'],
    'the count may be ahead of the list',
  );
  assertEquals(trayChatSlots([{ key: 'k', title: 'x'.repeat(100) }])[0].label.length, 60 + ' · Needs you'.length);
  // the Windows menu calls: slots and their line removed, then the line and the labels appended in order
  assertEquals(slotMenuOps(4, 2, ['A']), [
    { op: 'delete', command: SLOT_SEPARATOR_COMMAND },
    { op: 'delete', command: 5 },
    { op: 'delete', command: 6 },
    { op: 'append', command: SLOT_SEPARATOR_COMMAND, label: '', separator: true },
    { op: 'append', command: 5, label: 'A' },
  ]);
  assertEquals(slotMenuOps(4, 2, []).filter((o) => o.op === 'append'), [], 'no chats: no line, no slots');
  assertEquals(chosenItem([...TRAY_ITEMS, ...SLOT_ITEMS], SLOT_SEPARATOR_COMMAND), null, 'the line is never chosen');
  assertEquals(chosenItem([...TRAY_ITEMS, ...SLOT_ITEMS], menuCommand(TRAY_ITEMS.length + 1)), 'chat-1');

  // the app: what the tray tick shows, and what a slot click opens
  let counts = { working: 3, needsYou: 0, blocked: [] as typeof chats };
  const slots: string[][] = [];
  const dots: boolean[] = [];
  const a = await makeApp(() => Promise.resolve(3), null, { trayCounts: () => Promise.resolve(counts) });
  try {
    a.app.shell.updateTraySlots = (labels) => void slots.push(labels);
    a.app.shell.setWindowAttention = (on) => void dots.push(on);
    counts = { working: 3, needsYou: 2, blocked: chats.slice(0, 2) };
    await a.app.trayTick();
    assertEquals(slots, [['Chat 0 · Approval', 'Chat 1 · Failed']]);
    assertEquals(dots, [true], 'blocked chats: the dot on the window icon');
    await a.app.trayTick();
    assertEquals([slots.length, dots.length], [1, 1], 'nothing changed: no menu or icon calls');
    const opened: unknown[] = [];
    a.app.openFromNotification = (t) => (opened.push(t), Promise.resolve(true));
    await a.app.onTrayMenu('chat-1');
    await a.app.onTrayMenu('chat-4'); // an empty slot: nothing
    assertEquals(opened, [{ type: 'chat', key: 'claude:s1' }]);
    counts = { working: 1, needsYou: 0, blocked: [] };
    await a.app.trayTick();
    assertEquals(slots.at(-1), [], 'nothing blocked: the slots leave the menu');
    assertEquals(dots, [true, false], 'and the dot goes');
  } finally {
    await a.done();
  }
});

// ---------- multi-window Phase 2A (design aib-shared/designs/multi-window, T8/T9): fake Shell, no window is shown ----------

const BASE = 'http://127.0.0.1:8890';
const PROJ = { key: 'p:budget', name: 'budget-app', path: 'C:\\work\\budget-app' };
const PROJ2 = { key: 'p:recipe', name: 'recipe-site', path: 'C:\\work\\recipe-site' };
const CHAT = { key: 'claude:csv', project: 'p:budget', title: 'CSV import' };

/** The app (its page URL; never a key in a window URL); `saved`: a desktop-windows.json written before it starts. */
async function makeMulti(extra: Partial<DesktopOptions> = {}, saved?: unknown, shellExtra: Partial<Shell> = {}, busy = 0) {
  const dir = await Deno.makeTempDir();
  if (saved !== undefined) await Deno.writeTextFile(`${dir}/${WINDOWS_FILE}`, typeof saved === 'string' ? saved : JSON.stringify(saved));
  const { s, shell } = fakeShell();
  Object.assign(shell, shellExtra);
  const quits: boolean[] = [];
  const gone: string[] = [];
  const app = new DesktopApp(shell, {
    url: `${BASE}/`,
    stateDir: dir,
    trayIcon: trayIconPng(),
    busyCount: () => Promise.resolve(busy),
    quit: (stop) => (quits.push(stop), Promise.resolve()),
    saveDelayMs: 0,
    watchdogMs: 0,
    trayPollMs: 0,
    onWindowGone: (w) => void gone.push(w),
    ...extra,
  });
  await app.start();
  const win = (id: string) => app.windows.get(id)!.handle as FakeWindow;
  /** The window's page finished loading on its own URL (the fragment taken out, as page-auth.js does). */
  const load = async (id: string, href = app.windows.get(id)!.url.replace(/#.*$/, '')) => {
    const w = win(id);
    w.href = href;
    w.emit('load');
    await tick();
  };
  const savedNow = async () => {
    await settled(app);
    return JSON.parse(await Deno.readTextFile(`${dir}/${WINDOWS_FILE}`));
  };
  return {
    app,
    s,
    dir,
    quits,
    gone,
    win,
    load,
    savedNow,
    done: async () => {
      app.stop();
      await settled(app);
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('multi-window K0: each window gets its own keyed URL and title; one project opens one window (D1a); cap 8', async () => {
  const m = await makeMulti();
  try {
    assertEquals(m.s.windows.length, 1);
    assertEquals(m.win('m').urls, [`${BASE}/?w=m`], 'never a key in a window URL');
    await m.load('m');
    assertEquals(m.win('m').title, 'AIB');
    const dw = m.app.desktopWindows;
    assertEquals(await dw.open({ project: PROJ }, 'm'), { w: 'w2', existed: false });
    const w2 = m.win('w2');
    assertEquals(w2.urls, [`${BASE}/?w=w2&kind=project&project=p%3Abudget`]);
    assertEquals(w2.options.title, 'AIB · budget-app');
    assertEquals(m.s.fronts.at(-1), w2.hwnd, 'the new window comes forward with its own handle');
    assertEquals(await dw.open({ project: PROJ }, 'm'), { w: 'w2', existed: true });
    assertEquals(m.s.windows.length, 2, 'the same project again: focused, no second window');
    assertEquals(await dw.open({ chat: CHAT }, 'w2'), { w: 'w3', existed: false });
    const w3 = m.win('w3');
    assertEquals([w3.options.width, w3.options.height], [480, 720], 'a pop-out is small');
    assertEquals(w3.options.title, 'CSV import · AIB');
    assert(w3.urls[0].startsWith(`${BASE}/?w=w3&kind=chat&mode=chat&chat=claude%3Acsv&project=p%3Abudget`));
    assertEquals(await dw.open({ doc: { project: 'p:budget', name: 'Release plan' } }, 'w2'), { w: 'w4', existed: false });
    assert(m.win('w4').urls[0].startsWith(`${BASE}/doc.html?w=w4&kind=doc&project=p%3Abudget&name=Release+plan`));
    assertEquals(dw.list().map((i) => [i.w, i.kind, i.project, i.chat]), [
      ['m', 'main', null, null],
      ['w2', 'project', 'p:budget', null],
      ['w3', 'chat', 'p:budget', 'claude:csv'],
      ['w4', 'doc', 'p:budget', null],
    ]);
    assert(dw.othersAlive('m') && dw.othersAlive('w2'));
    for (let i = 0; i < 4; i++) await dw.open({ project: { ...PROJ, key: `p:${i}`, name: `p${i}` } }, 'm');
    assertEquals(dw.list().length, 8);
    let cap = false;
    try {
      await dw.open({ project: { ...PROJ, key: 'p:over', name: 'over' } }, 'm');
    } catch (error) {
      cap = (error as Error).name === 'WindowCapError';
    }
    assert(cap, 'the ninth window is refused (409 at the route)');
  } finally {
    await m.done();
  }
});

Deno.test('multi-window B2/B3/S6: every window is checked against its own URL, with its own rate limits; the watchdog checks all', async () => {
  const access = new PageAccess(null, null);
  const m = await makeMulti(pageKeysFor(access));
  try {
    await m.load('m');
    await m.app.desktopWindows.open({ project: PROJ }, 'm');
    const w2 = m.win('w2');
    const own = m.app.windows.get('w2')!.url;
    // S6: the window lands on our page without its own id (the runtime's redirect, a lost query): its own URL again
    await m.load('w2', `${BASE}/`);
    assertEquals(w2.urls, [own, own]);
    await m.load('w2', `${BASE}/?w=m`);
    assertEquals(w2.urls.at(-1), own, "another window's id: its own URL, never the main window's");
    // an outside site: opened in the browser, the window goes back to its own URL
    await m.load('w2', 'https://example.com/x');
    assertEquals(m.s.external, ['https://example.com/x']);
    assertEquals(w2.urls.at(-1), own);
    // our page with its id but no session: handed a one-time key through the private channel, not navigated (N4)
    pageKeysFor(access, w2);
    const n = w2.urls.length;
    w2.held = { auth: true, session: '', waiting: false };
    await m.load('w2', own);
    assertEquals([w2.urls.length, w2.handed.length], [n, 1], 'a key, no navigation');
    assert(access.holds(w2.held), 'connected');
    await m.load('w2', own);
    assertEquals([w2.urls.length, w2.handed.length], [n, 1], 'connected on its own page: left alone');
    assertEquals(m.win('m').handed.length, 1, 'the main window got its own key at its load');
    // per-window limits: w2 used up its 4 "back" sends; the main window still has its own
    for (let i = 0; i < 6; i++) await m.load('w2', 'chrome-error://chromewebdata/');
    const stuck = w2.urls.length;
    await m.load('w2', 'chrome-error://chromewebdata/');
    assertEquals(w2.urls.length, stuck, "w2's limit is used up");
    const mainBefore = m.win('m').urls.length;
    await m.load('m', 'chrome-error://chromewebdata/');
    assertEquals(m.win('m').urls.length, mainBefore + 1, 'the main window is sent back: its limit is its own');
    // the watchdog looks at every visible window; a hidden one is left
    const wd = await makeMulti();
    try {
      await wd.load('m');
      await wd.app.desktopWindows.open({ project: PROJ }, 'm');
      await wd.load('w2');
      const x = wd.win('w2');
      x.href = 'http://127.0.0.1:40000/';
      x.visible = false;
      await wd.app.watchdogTick();
      assertEquals(x.urls.length, 1, 'hidden: left alone');
      x.visible = true;
      await wd.app.watchdogTick();
      assertEquals(x.urls.at(-1), wd.app.windows.get('w2')!.url);
      assertEquals(wd.win('m').urls.length, 1, 'the main window on its page: nothing done');
    } finally {
      await wd.done();
    }
  } finally {
    await m.done();
  }
});

Deno.test('multi-window B5: closing a window that is not the last just closes it; the last one runs the quit rule and stays saved', async () => {
  const m = await makeMulti();
  try {
    await m.load('m');
    await m.app.desktopWindows.open({ project: PROJ }, 'm');
    await m.load('w2');
    m.win('m').emit('close'); // the person closed the main window while w2 is open
    await tick();
    assertEquals(m.quits, [], 'no quit');
    assertEquals(m.gone, ['m'], 'its presence slot goes at once (B8)');
    assertEquals((await m.savedNow()).windows.map((w: { id: string }) => w.id), ['w2'], 'it left the saved list');
    m.win('w2').emit('close'); // the last window, nothing working
    await tick();
    await tick();
    assertEquals(m.quits, [false], 'the last window: the quit rule (nothing works: quit)');
    assertEquals((await m.savedNow()).windows.map((w: { id: string }) => w.id), ['w2'], 'the last window stays in the list (G8)');
  } finally {
    await m.done();
  }
});

Deno.test('multi-window B5: Quit AIB with work running hides every window; Open AIB shows them again, the last-used in front', async () => {
  const m = await makeMulti({}, undefined, {}, 2);
  try {
    await m.load('m');
    await m.app.desktopWindows.open({ project: PROJ }, 'm');
    await m.app.desktopWindows.open({ chat: CHAT }, 'w2');
    m.win('w2').emit('focus');
    await m.app.requestQuit();
    assertEquals(m.quits, [], 'work runs and no keeper: AIB stays in the tray');
    assertEquals(['m', 'w2', 'w3'].map((id) => m.win(id).visible), [false, false, false], 'all three hidden');
    assert(m.app.background);
    m.s.fronts.length = 0;
    m.s.tray!.onMenu('open');
    await tick();
    assertEquals(['m', 'w2', 'w3'].map((id) => m.win(id).visible), [true, true, true]);
    assertEquals(m.s.fronts[0], m.win('w2').hwnd, 'the window used last comes forward (B12)');
    assertEquals(m.s.windows.length, 3, 'no window made twice');
  } finally {
    await m.done();
  }
});

Deno.test('multi-window S4: closing from code (K4 close) drops the window from the list at once; no close event is needed', async () => {
  const m = await makeMulti();
  try {
    await m.load('m');
    await m.app.desktopWindows.open({ project: PROJ }, 'm');
    const w2 = m.win('w2');
    assertEquals(m.app.desktopWindows.close('w2'), true);
    assertEquals([w2.closed, w2.log.at(-1)], [true, 'close'], 'closed from code');
    assertEquals(m.app.desktopWindows.list().map((i) => i.w), ['m']);
    assertEquals(m.gone, ['w2']);
    assertEquals((await m.savedNow()).windows.map((w: { id: string }) => w.id), ['m']);
    assertEquals(m.app.desktopWindows.close('w2'), false, 'gone already');
    assertEquals(m.quits, []);
    // a pinned window closing itself as the last visible one (its project was removed, G4) leaves a main window behind
    m.win('m').emit('close');
    await tick();
    assertEquals(m.quits, [false]);
  } finally {
    await m.done();
  }
});

Deno.test('multi-window G4: a pinned window that closes itself as the last one opens the main window instead of leaving none', async () => {
  const m = await makeMulti({}, {
    v: 1,
    lastFocused: 'w2',
    windows: [{ id: 'w2', kind: 'project', project: PROJ, width: 900, height: 700 }],
  });
  try {
    assertEquals(m.app.desktopWindows.list().map((i) => i.w), ['w2'], 'only the project window was saved');
    assert(m.app.desktopWindows.close('w2'));
    assertEquals(m.app.desktopWindows.list().map((i) => i.w), ['m'], 'a main window took its place');
    assertEquals(m.quits, []);
  } finally {
    await m.done();
  }
});

Deno.test('multi-window B1/B6/K6: a notification goes to the pop-out, then the project window, then main; the window comes forward with its own handle', async () => {
  const m = await makeMulti();
  try {
    await m.load('m');
    await m.app.desktopWindows.open({ project: PROJ }, 'm');
    await m.app.desktopWindows.open({ project: PROJ2 }, 'm');
    await m.load('w2');
    await m.load('w3');
    // the chat's project (budget-app) has window w2: recipe-site's window and main answer 'no' (K6)
    m.win('m').openAnswer = 'no';
    m.win('w3').openAnswer = 'no';
    m.win('w2').openAnswer = 'mine';
    m.win('m').size = [3000, 2000]; // the biggest window is not the one that comes forward
    m.s.fronts.length = 0;
    assert(await m.app.openFromNotification({ type: 'chat', key: 'claude:x' }, 3, 0));
    assertEquals(m.s.fronts[0], m.win('w2').hwnd, "bringToFront got window 2's own handle (B1)");
    assertEquals(m.win('w2').opened.at(-1), { type: 'chat', key: 'claude:x' });
    // the chat popped out: the pop-out is asked first and wins
    await m.app.desktopWindows.open({ chat: { ...CHAT, key: 'claude:x' } }, 'w2');
    const pop = m.app.windows.get('w4')!.handle as FakeWindow;
    pop.openAnswer = 'mine';
    m.win('w2').opened.length = 0;
    m.s.fronts.length = 0;
    assert(await m.app.openFromNotification({ type: 'chat', key: 'claude:x' }, 3, 0));
    assertEquals(m.s.fronts[0], pop.hwnd);
    assertEquals(m.win('w2').opened, [], 'the project window was not asked');
    // nobody takes it and there is no main window: one is made (B6)
    const n = await makeMulti({}, {
      v: 1,
      lastFocused: 'w2',
      windows: [{ id: 'w2', kind: 'project', project: PROJ, width: 900, height: 700 }],
    });
    try {
      n.win('w2').openAnswer = 'no';
      const p = n.app.openFromNotification({ type: 'chat', key: 'claude:other' }, 3, 0);
      await tick();
      assert(await p);
      assertEquals(n.app.desktopWindows.list().map((i) => i.w), ['m', 'w2'], 'the main window was made');
      assertEquals((n.win('m')).opened, [{ type: 'chat', key: 'claude:other' }]);
    } finally {
      await n.done();
    }
  } finally {
    await m.done();
  }
});

Deno.test('multi-window Phase 3: a pop-out keeps the window it was moved out of (from) across a restart; bad values dropped', async () => {
  const m = await makeMulti();
  try {
    await m.load('m');
    const dw = m.app.desktopWindows;
    await dw.open({ project: PROJ }, 'm');
    assertEquals(await dw.open({ chat: CHAT }, 'w2'), { w: 'w3', existed: false });
    assertEquals(await dw.open({ doc: { project: 'p:budget', name: 'Plan' } }, 'm'), { w: 'w4', existed: false });
    assertEquals(dw.list().map((i) => [i.w, i.from]), [['m', null], ['w2', null], ['w3', 'w2'], ['w4', 'm']], 'project windows have none');
    const saved = await m.savedNow();
    assertEquals(saved.windows.map((w: Json) => [w.id, w.from ?? null]), [['m', null], ['w2', null], ['w3', 'w2'], ['w4', 'm']]);
    // the presence answer carries it for the pop-outs (the page that moved it takes it back after a restart)
    const ans = withPopFrom({ ok: true, windows: [{ w: 'm', kind: 'main' }, { w: 'w3', kind: 'chat' }, { w: 'w4', kind: 'doc' }] }, dw);
    assertEquals((ans.windows as Json[]).map((v) => v.from ?? null), [null, 'w2', 'm']);
    assertEquals(withPopFrom({ ok: true, windows: [{ w: 'w3', kind: 'chat' }] }, null).windows, [{ w: 'w3', kind: 'chat' }], 'serve mode');
    // restart: the restored pop-out still knows where it came from
    const n = await makeMulti({}, saved);
    try {
      assertEquals(n.app.desktopWindows.list().map((i) => [i.w, i.kind, i.from]), [['m', 'main', null], ['w2', 'project', null], [
        'w3',
        'chat',
        'w2',
      ], ['w4', 'doc', 'm']]);
    } finally {
      await n.done();
    }
  } finally {
    await m.done();
  }
  // K1 read: only a valid other window id, only on a pop-out
  const list = cleanSavedList({
    v: 1,
    windows: [
      { id: 'm', kind: 'main', width: 900, height: 700, from: 'w2' },
      { id: 'w2', kind: 'project', project: PROJ, width: 900, height: 700, from: 'm' },
      { id: 'w3', kind: 'chat', chat: CHAT, width: 480, height: 720, from: 'w3' },
      { id: 'w4', kind: 'chat', chat: { ...CHAT, key: 'claude:b' }, width: 480, height: 720, from: '../x' },
      { id: 'w5', kind: 'chat', chat: { ...CHAT, key: 'claude:c' }, width: 480, height: 720, from: 'w2' },
    ],
  });
  assertEquals(list.windows.map((w) => [w.id, w.from ?? null]), [['m', null], ['w2', null], ['w3', null], ['w4', null], ['w5', 'w2']]);
});

Deno.test('multi-window K4 route: the pop-out, then the project window, then main (made if needed); the caller itself gets "self"', async () => {
  const m = await makeMulti();
  try {
    await m.load('m');
    const dw = m.app.desktopWindows;
    await dw.open({ project: PROJ }, 'm');
    assertEquals(await dw.route({ project: 'p:budget', chat: 'claude:1' }, 'm'), { to: 'w2' });
    await tick();
    assertEquals(m.win('w2').opened, [{ type: 'chat', key: 'claude:1' }], 'delivered through its openFromDesktop');
    assertEquals(await dw.route({ project: 'p:budget', chat: 'claude:1' }, 'w2'), { to: 'self' });
    assertEquals(await dw.route({ project: 'p:other' }, 'w2'), { to: 'm' }, 'another project from a project window: the main window');
    await tick();
    assertEquals(m.win('m').opened, [{ type: 'project', key: 'p:other' }]);
    await dw.open({ chat: CHAT }, 'w2');
    assertEquals(await dw.route({ project: 'p:budget', chat: CHAT.key }, 'm'), { to: 'w3' }, 'popped out: the pop-out');
    assertEquals(await dw.route({ project: 'p:budget', doc: { project: 'p:budget', name: 'Plan' } }, 'm'), { to: 'w2' });
    // no main window: made
    m.win('m').emit('close');
    await tick();
    assertEquals(dw.list().some((i) => i.w === 'm'), false);
    assertEquals(await dw.route({ project: 'p:other' }, 'w2'), { to: 'm' });
    assert(dw.list().some((i) => i.w === 'm'), 'the main window was made');
  } finally {
    await m.done();
  }
});

Deno.test('multi-window B10/B11/S5/S7/G3: one save timer per window, atomic writes, no save before load, at 0x0 or minimised; maximised keeps its normal size', async () => {
  const m = await makeMulti({ saveDelayMs: 30 });
  try {
    await m.load('m');
    await m.app.desktopWindows.open({ project: PROJ }, 'm');
    const main = m.win('m'), w2 = m.win('w2');
    w2.size = [700, 500];
    w2.emit('resize');
    await tick(50);
    assertEquals((await m.savedNow()).windows[1].width, 1280, 'before its first load nothing is read (S7)');
    await m.load('w2');
    main.size = [1000, 700];
    main.pos = [10, 20];
    main.emit('move');
    w2.pos = [2000, 80];
    w2.emit('move'); // within the first one's delay: both are kept (one timer per window)
    await tick(80);
    let saved = await m.savedNow();
    assertEquals(saved.windows.map((w: SavedWindowJson) => [w.id, w.width, w.height, w.x, w.y]), [
      ['m', 1000, 700, 10, 20],
      ['w2', 700, 500, 2000, 80],
    ]);
    assertEquals([...Deno.readDirSync(m.dir)].filter((f) => f.name.endsWith('.tmp')), [], 'written to a temp file, then renamed');
    // minimised: 0x0 or IsIconic, never saved
    w2.size = [0, 0];
    w2.emit('resize');
    await tick(50);
    w2.size = [700, 500];
    w2.minimized = true;
    w2.pos = [-32000, -32000];
    w2.emit('move');
    await tick(50);
    saved = await m.savedNow();
    assertEquals([saved.windows[1].width, saved.windows[1].x], [700, 2000]);
    // maximised: the flag, with the normal size and position kept
    w2.minimized = false;
    w2.maximized = true;
    w2.size = [2560, 1400];
    w2.pos = [1920, 0];
    w2.emit('resize');
    await tick(50);
    saved = await m.savedNow();
    assertEquals([saved.windows[1].width, saved.windows[1].x, saved.windows[1].maximized], [700, 2000, true]);
  } finally {
    await m.done();
  }
});

interface SavedWindowJson {
  id: string;
  width: number;
  height: number;
  x?: number;
  y?: number;
}

Deno.test('multi-window D3a: every saved window comes back at start, main first, at its size and position; maximised is maximised after load', async () => {
  const saved = {
    v: 1,
    lastFocused: 'w3',
    windows: [
      { id: 'w2', kind: 'project', project: PROJ, x: 2000, y: 80, width: 1280, height: 1000, maximized: true },
      { id: 'm', kind: 'main', x: 80, y: 60, width: 1400, height: 900 },
      { id: 'w3', kind: 'chat', chat: CHAT, x: 3300, y: 100, width: 480, height: 720 },
      { id: 'w4', kind: 'doc', doc: { project: 'p:budget', name: 'Release plan' }, width: 720, height: 900 },
      { id: 'w5', kind: 'bogus' },
    ],
  };
  const m = await makeMulti({}, saved);
  try {
    assertEquals(m.s.windows.map((w) => w.urls[0].replace(BASE, '').replace(/#.*$/, '')), [
      '/?w=m',
      '/?w=w2&kind=project&project=p%3Abudget',
      '/?w=w3&kind=chat&mode=chat&chat=claude%3Acsv&project=p%3Abudget',
      '/doc.html?w=w4&kind=doc&project=p%3Abudget&name=Release+plan',
    ], 'main first (B4), then the saved order; a bad entry dropped');
    assertEquals([m.win('m').size, m.win('m').pos], [[1400, 900], [80, 60]]);
    assertEquals([m.win('w3').size, m.win('w3').pos], [[480, 720], [3300, 100]]);
    assertEquals(m.win('w2').log.includes('maximize'), false, 'not before its first load');
    await m.load('w2');
    assert(m.win('w2').log.includes('maximize'), 'G3: maximised after its normal size and position');
    // G2: the doc window had no position: cascaded from the first window once loaded
    await m.load('m');
    await m.load('w4');
    assertEquals(m.win('w4').pos, [80 + 30 * 1, 60 + 30 * 1]);
    m.s.fronts.length = 0;
    await m.app.showWindow('second launch');
    assertEquals(m.s.fronts[0], m.win('w3').hwnd, 'the saved last-focused window comes forward (B12)');
  } finally {
    await m.done();
  }
});

Deno.test('multi-window restore plan: monitor gone (G1), cascade (G2), folder gone (G4), WSL paths kept (G5), Wayland sizes only (S8)', () => {
  const list = cleanSavedList({
    v: 1,
    windows: [
      { id: 'm', kind: 'main', x: 80, y: 60, width: 1400, height: 900 },
      { id: 'w2', kind: 'project', project: PROJ, x: 9000, y: 9000, width: 1280, height: 1000 },
      { id: 'w3', kind: 'project', project: { key: 'p:gone', name: 'gone', path: 'C:\\gone' }, width: 900, height: 700 },
      {
        id: 'w4',
        kind: 'project',
        project: { key: 'p:wsl', name: 'wsl', path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\x' },
        width: 900,
        height: 700,
      },
      { id: 'w5', kind: 'chat', chat: CHAT, width: 480, height: 720 },
    ],
  });
  const onScreen = (r: { x: number }) => r.x < 5000;
  // the real FolderPresence for the WSL path (a network path: present, never stat'ed, no wsl.exe); the others are test folders
  const folderGone = (p: string) => (p.startsWith('\\\\') ? folderPresence.isGone(p) : p === 'C:\\gone');
  const plan = restorePlan(list, { folderGone, onScreen });
  assertEquals(plan.map((p) => [p.id, p.x ?? null, p.cascade]), [
    ['m', 80, 0],
    ['w2', null, 1], // off every screen: placed by the cascade
    ['w4', null, 2], // a WSL path counts as present: nothing waits for the distro
    ['w5', null, 3],
  ]);
  const wayland = restorePlan(list, { positions: false });
  assert(wayland.every((p) => p.x === undefined && p.cascade === 0), 'Wayland: sizes only, the window manager places them');
  assertEquals(wayland[0].width, 1400);
  assertEquals(restorePlan(null).map((p) => [p.id, p.kind]), [['m', 'main']], 'nothing saved: one main window');
  assertEquals(canPlaceWindows('linux', (k) => ({ WAYLAND_DISPLAY: 'wayland-0' } as Record<string, string>)[k]), false);
  assertEquals(canPlaceWindows('linux', (k) => ({ WAYLAND_DISPLAY: 'wayland-0', GDK_BACKEND: 'x11' } as Record<string, string>)[k]), true);
  assertEquals(canPlaceWindows('windows', () => 'wayland'), true);
});

Deno.test('multi-window G4 at start: a project window whose folder is gone is skipped and dropped at the next save; the old single-window file is migrated', async () => {
  const m = await makeMulti({ folderGone: (p) => p === 'C:\\gone' }, {
    v: 1,
    windows: [
      { id: 'm', kind: 'main', width: 1400, height: 900 },
      { id: 'w2', kind: 'project', project: { key: 'p:gone', name: 'gone', path: 'C:\\gone' }, width: 900, height: 700 },
    ],
  });
  try {
    assertEquals(m.s.windows.length, 1);
    assertEquals((await m.savedNow()).windows.map((w: { id: string }) => w.id), ['m']);
  } finally {
    await m.done();
  }
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/${GEOMETRY_FILE}`, JSON.stringify({ width: 1111, height: 777, x: 5, y: 6 }));
    assertEquals(await loadSavedList(dir), {
      v: 1,
      lastFocused: 'm',
      windows: [{ id: 'm', kind: 'main', width: 1111, height: 777, x: 5, y: 6 }],
    });
    await Deno.writeTextFile(`${dir}/${WINDOWS_FILE}`, '{broken');
    assertEquals((await loadSavedList(dir))!.windows[0].width, 1111, 'an unreadable new file falls back to the old one');
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('multi-window G7/G9: --start-in-tray makes no window until Open AIB, then all; phone on + last closed keeps it for Open AIB', async () => {
  const saved = {
    v: 1,
    windows: [{ id: 'm', kind: 'main', width: 1400, height: 900 }, { id: 'w2', kind: 'project', project: PROJ, width: 900, height: 700 }],
  };
  const t = await makeMulti({ startInTray: true }, saved);
  try {
    assertEquals(t.s.windows.length, 0, "no window over the person's work");
    t.s.tray!.onMenu('open');
    await waitFor(() => t.s.windows.length === 2, 'both windows');
    assertEquals(t.app.desktopWindows.list().map((i) => i.w), ['m', 'w2']);
  } finally {
    await t.done();
  }
  let phone = true;
  const p = await makeMulti({ phoneOn: () => phone }, saved);
  try {
    await p.load('m');
    await p.load('w2');
    p.win('w2').emit('close');
    await tick();
    p.win('m').emit('close');
    await tick();
    assertEquals(p.quits, [], 'phone access on: AIB stays in the tray');
    assertEquals((await p.savedNow()).windows.map((w: { id: string }) => w.id), ['m'], 'the last window stays in the list (G9)');
    p.s.tray!.onMenu('open');
    await waitFor(() => p.s.windows.length === 3, 'the main window back');
    assertEquals(p.app.desktopWindows.list().map((i) => i.w), ['m']);
    phone = false;
  } finally {
    await p.done();
  }
});

Deno.test('multi-window E7/G8: only pop-outs open → Open AIB makes a main window; nothing is written while quitting', async () => {
  const m = await makeMulti({}, { v: 1, windows: [{ id: 'w3', kind: 'chat', chat: CHAT, width: 480, height: 720 }] });
  try {
    assertEquals(m.app.desktopWindows.list().map((i) => i.w), ['w3']);
    await m.app.showWindow('Open AIB');
    assertEquals(m.app.desktopWindows.list().map((i) => i.w).sort(), ['m', 'w3']);
    await m.load('m');
    // The list as it is at quit: the new main window's own save (asked for when it opened) must have landed first (3a: all windows
    // come back); reading the file before it lands made this test race itself.
    assertEquals((await m.savedNow()).windows.map((w: { id: string }) => w.id), ['m', 'w3']);
    const before = await Deno.readTextFile(`${m.dir}/${WINDOWS_FILE}`);
    await m.app.quit(false);
    m.win('m').size = [999, 999];
    m.win('m').emit('resize');
    await m.app.desktopWindows.open({ project: PROJ }, 'm').catch(() => {});
    await tick(20);
    await settled(m.app);
    assertEquals(await Deno.readTextFile(`${m.dir}/${WINDOWS_FILE}`), before, 'G8: the list on disk is the one to restore');
  } finally {
    await m.done();
  }
});

Deno.test('multi-window chooser order and K6 answers (pure)', () => {
  const w = (id: string, kind: 'main' | 'project' | 'chat' | 'doc', project: string | null, chat: string | null, focusedAt = 0) => ({
    w: id,
    kind,
    project,
    chat,
    doc: null,
    focusedAt,
  });
  const wins = [
    w('m', 'main', null, null, 1),
    w('w2', 'project', 'p:a', null, 3),
    w('w3', 'project', 'p:b', null, 2),
    w('w4', 'chat', null, 'c:1', 4),
  ];
  assertEquals(chooseOrder({ chat: 'c:1' }, wins), { order: ['w4', 'w2', 'w3', 'm'], needsMain: false });
  assertEquals(chooseOrder({ chat: 'c:9', project: 'p:b' }, wins).order, ['w3', 'm', 'w2']);
  assertEquals(chooseOrder({}, wins).order, ['m', 'w4', 'w2', 'w3'], 'the inbox: main, then the last used');
  assertEquals(chooseOrder({ chat: 'c:9' }, wins.slice(1)).needsMain, true);
  assertEquals([openAnswer('mine'), openAnswer(true), openAnswer('no'), openAnswer(false), openAnswer(undefined)], [
    'mine',
    'mine',
    'no',
    null,
    null,
  ]);
  assertEquals(
    findOwnWindow(
      [
        { hwnd: 1n, width: 1, height: 1, title: 'AIB' },
        { hwnd: 2n, width: 1200, height: 800, title: 'AIB' },
        { hwnd: 3n, width: 480, height: 720, title: 'CSV import · AIB' },
      ],
      'CSV import · AIB',
      new Set([2n]),
    ),
    3n,
  );
  assertEquals(
    findOwnWindow(
      [{ hwnd: 2n, width: 1200, height: 800, title: 'AIB' }, { hwnd: 4n, width: 900, height: 800, title: 'AIB' }],
      'AIB',
      new Set(),
    ),
    null,
    'two unclaimed with one title: none, not a wrong one',
  );
  assertEquals(
    findOwnWindow(
      [{ hwnd: 2n, width: 1200, height: 800, title: 'AIB' }, { hwnd: 4n, width: 900, height: 800, title: 'x' }],
      'AIB',
      new Set([2n]),
    ),
    4n,
    'the one unclaimed window, before its title is applied',
  );
});
