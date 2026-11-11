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
  closeQuestion,
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
  TRAY_ONLY_ITEMS,
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
import { trayIconBytes, trayIconPng } from '../../outputs/agent-studio/server/desktop/tray_icon.ts';
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

Deno.test('close decision: only a known zero quits without asking', () => {
  assertEquals(closeDecision(0), 'quit');
  assertEquals(closeDecision(1), 'ask');
  assertEquals(closeDecision(null), 'ask');
  assertEquals(
    closeQuestion(2),
    '2 chats are still working.\n\nOK: stop them and quit AIB.\nCancel: keep them running; AIB stays in the tray.',
  );
  assert(closeQuestion(1).startsWith('1 chat is still working.'));
  assert(closeQuestion(null).startsWith('Chats may still be working.'));
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
      iconDark: Uint8Array | null | undefined;
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
    createTray: (icon, tooltip, items, onClick, onMenu, iconDark) =>
      void (s.tray = { items, onClick, onMenu, tooltip, icon, iconDark }),
    removeTray: () => void s.trayRemoved++,
    ask: (m) => (s.questions.push(m), Promise.resolve(s.answer)),
    openExternal: (u) => void s.external.push(u),
    notifier: {
      ready: () => Promise.resolve(true),
      request: () => Promise.resolve('granted'),
      show: (t, b) => void s.notes.push([t, b]),
    },
  };
  return { s, shell };
}

async function makeApp(
  busy: () => Promise<number>,
  answer = false,
  stopHost: (force: boolean) => Promise<unknown> = () => Promise.resolve({ stopped: true }),
) {
  const dir = await Deno.makeTempDir();
  const { s, shell } = fakeShell(answer);
  const quits: boolean[] = [];
  const order: string[] = [];
  const stops: boolean[] = [];
  const options: DesktopOptions = {
    url: 'http://127.0.0.1:8890/',
    stateDir: dir,
    trayIcon: trayIconPng(),
    busyCount: busy,
    stopHost: (force) => (stops.push(force), order.push(`stop:${force}`), stopHost(force)),
    quit: (stop) => (quits.push(stop), order.push('quit'), Promise.resolve()),
    saveDelayMs: 0,
    watchdogMs: 0,
  };
  const removeTray = shell.removeTray!;
  shell.removeTray = () => (order.push('tray removed'), removeTray());
  const app = new DesktopApp(shell, options);
  await app.start();
  return { app, s, quits, stops, order, dir, done: () => Deno.remove(dir, { recursive: true }) };
}

Deno.test('start: one window titled AIB on the page, a keeper, a tray, three bindings only', async () => {
  const { s, done } = await makeApp(() => Promise.resolve(0));
  try {
    assertEquals(s.windows.length, 1);
    const w = s.windows[0];
    assertEquals(w.options.title, 'AIB');
    assertEquals(w.urls, ['http://127.0.0.1:8890/']);
    assertEquals([...w.bound.keys()].sort(), ['aibNotify', 'aibNotifyReady', 'aibRequestNotifications']);
    assertEquals(s.keepers, 1);
    assertEquals(s.tray?.items.map((i) => i.label), ['Open AIB', 'Quit AIB']);
    const png = trayIconPng();
    assertEquals([...png.slice(1, 4)], [0x50, 0x4e, 0x47], 'a PNG');
    assertEquals(s.tray?.icon, png, 'the tray gets the icon tray_icon.ts chose (Windows: the theme glyph for the worker tray)');
    assertEquals(s.tray?.iconDark, null, 'no dark icon given: none passed on');
  } finally {
    await done();
  }
});

Deno.test('start: the dark-mode tray icon (trayIconDark) reaches createTray for Deno.Tray.setIconDark', async () => {
  const { s, shell } = fakeShell();
  const dir = await Deno.makeTempDir();
  try {
    const dark = trayIconBytes({ art: 'dark', size: 32 });
    const app = new DesktopApp(shell, {
      url: 'http://127.0.0.1:8890/',
      stateDir: dir,
      trayIcon: trayIconBytes({ art: 'color', size: 32 }),
      trayIconDark: dark,
      busyCount: () => Promise.resolve(0),
      quit: () => Promise.resolve(),
      saveDelayMs: 0,
      watchdogMs: 0,
    });
    await app.start();
    assertEquals(s.tray?.iconDark, dark);
    assertEquals(s.tray?.icon, trayIconBytes({ art: 'color', size: 32 }));
  } finally {
    await Deno.remove(dir, { recursive: true });
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

Deno.test('closing with chats working asks; Cancel keeps running in the tray, the tray reopens a new window', async () => {
  const { s, quits, done } = await makeApp(() => Promise.resolve(2), false);
  try {
    s.windows[0].emit('close');
    await tick();
    assertEquals(s.questions, [closeQuestion(2)]);
    assertEquals(quits, []);
    s.tray!.onClick();
    await tick();
    assertEquals(s.windows.length, 2, 'the closed window is gone: a new one');
    assertEquals(s.windows[1].urls, ['http://127.0.0.1:8890/']);
    s.tray!.onMenu('open'); // already open: show and focus, no third window
    await tick();
    assertEquals(s.windows.length, 2);
    assertEquals(s.windows[1].log.slice(-2), ['show', 'focus']);
  } finally {
    await done();
  }
});

Deno.test('OK stops the agents and quits; an unreadable count asks too', async () => {
  const a = await makeApp(() => Promise.resolve(1), true);
  try {
    a.s.windows[0].emit('close');
    await tick();
    assertEquals(a.quits, [true]);
  } finally {
    await a.done();
  }
  const b = await makeApp(() => Promise.reject(new Error('host gone')), false);
  try {
    b.s.windows[0].emit('close');
    await tick();
    assertEquals(b.s.questions, [closeQuestion(null)]);
    assertEquals(b.quits, []);
  } finally {
    await b.done();
  }
});

Deno.test('tray: icon, tooltip AIB, menu Open AIB / Quit AIB; left click and Open show the window, Quit asks', async () => {
  const a = await makeApp(() => Promise.resolve(2), false);
  try {
    assertEquals(a.s.tray?.tooltip, 'AIB');
    assertEquals(a.s.tray?.items, [{ id: 'open', label: 'Open AIB' }, { id: 'quit', label: 'Quit AIB' }]);
    a.s.windows[0].emit('close'); // 2 working, Cancel: AIB stays in the tray with no window
    await tick();
    assertEquals(a.s.windows[0].closed, true);
    a.s.tray!.onClick();
    await tick();
    assertEquals(a.s.windows.length, 2, 'a left click makes a new window');
    a.s.windows[1].emit('close');
    await tick();
    a.s.tray!.onMenu('open');
    await tick();
    assertEquals(a.s.windows.length, 3, 'Open AIB makes a new window');
    a.s.tray!.onMenu('nonsense');
    await tick();
    assertEquals(a.s.windows.length, 3, 'an unknown id does nothing');
    const asked = a.s.questions.length;
    a.s.tray!.onMenu('quit');
    await tick();
    assertEquals(a.s.questions.length, asked + 1, 'Quit AIB asks while chats work');
    assertEquals(a.quits, []);
    assertEquals(a.s.trayRemoved, 0, 'Cancel keeps the tray icon');
    a.s.answer = true;
    a.s.tray!.onMenu('quit');
    await tick();
    assertEquals(a.quits, [true]);
    assertEquals(a.s.trayRemoved, 1, 'quitting removes the icon');
  } finally {
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

Deno.test('tray Quit asks the same question; with nothing working it just quits', async () => {
  const a = await makeApp(() => Promise.resolve(3), false);
  try {
    a.s.tray!.onMenu('quit');
    await tick();
    assertEquals(a.s.questions, [closeQuestion(3)]);
    assertEquals(a.quits, []);
    assertEquals(a.s.windows[0].closed, false, 'Cancel leaves the open window alone');
    a.s.answer = true;
    a.s.tray!.onMenu('quit');
    await tick();
    assertEquals(a.quits, [true]);
  } finally {
    await a.done();
  }
  const b = await makeApp(() => Promise.resolve(0));
  try {
    b.s.tray!.onMenu('quit');
    await tick();
    assertEquals(b.quits, [false]);
  } finally {
    await b.done();
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

Deno.test('notification bindings: capped text and a rate limit', async () => {
  const a = await makeApp(() => Promise.resolve(0));
  try {
    const notify = a.s.windows[0].bound.get('aibNotify')!;
    assertEquals(await notify('t'.repeat(300), 'b'), true);
    assertEquals(a.s.notes[0][0].length, 200);
    for (let i = 0; i < 5; i++) await notify('x', 'y');
    assertEquals(await notify('x', 'y'), false, 'the 7th within 30 s is dropped');
    assertEquals(a.s.notes.length, 6);
    assertEquals(await a.s.windows[0].bound.get('aibNotifyReady')!(), true);
    assertEquals(await a.s.windows[0].bound.get('aibRequestNotifications')!(), 'granted');
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

Deno.test('quitting stops the agent host too: unforced with nothing working, forced after OK, never after Cancel', async () => {
  const a = await makeApp(() => Promise.resolve(0));
  try {
    a.s.windows[0].emit('close');
    await tick();
    assertEquals(a.order, ['stop:false', 'tray removed', 'quit'], 'nothing left running invisibly once the window is gone');
  } finally {
    await a.done();
  }
  const b = await makeApp(() => Promise.resolve(2), true);
  try {
    b.s.windows[0].emit('close');
    await tick();
    assertEquals(b.order, ['stop:true', 'tray removed', 'quit']);
  } finally {
    await b.done();
  }
  const c = await makeApp(() => Promise.resolve(2), false);
  try {
    c.s.windows[0].emit('close');
    await tick();
    assertEquals(c.order, [], 'Cancel keeps the host and the tray');
    assertEquals(c.s.tray?.items.length, 2);
  } finally {
    await c.done();
  }
  const d = await makeApp(() => Promise.resolve(0), false, () => Promise.reject(new Error('refused')));
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
      const app = await makeApp(() => Promise.resolve(0), false, (force) => stopHost(fx.state, force, 5));
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

Deno.test('askOnClose false (the design 4.4 switch): closing or Quit with chats working never asks; the host is asked to stop unforced', async () => {
  for (const close of [true, false]) {
    const dir = await Deno.makeTempDir();
    const { s, shell } = fakeShell(true);
    const order: string[] = [];
    const app = new DesktopApp(shell, {
      url: 'http://127.0.0.1:8890/',
      stateDir: dir,
      trayIcon: trayIconPng(),
      busyCount: () => Promise.resolve(2),
      stopHost: (force) => (order.push(`stop:${force}`), Promise.resolve({})),
      quit: (stop) => (order.push(`quit:${stop}`), Promise.resolve()),
      askOnClose: false,
      saveDelayMs: 0,
      watchdogMs: 0,
    });
    try {
      await app.start();
      if (close) s.windows[0].emit('close');
      else s.tray!.onMenu('quit');
      await tick();
      assertEquals(s.questions, []);
      assertEquals(order, ['stop:false', 'quit:false'], 'the chats keep running in the agent host');
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
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

Deno.test('tray-only start (--start-in-tray): no window, a keeper, the tray menu Open AIB / status / Stop chats and quit', async () => {
  const counts = { working: 2, needsYou: 1 };
  const { app, s, updates, quits, done } = await trayOnlyApp(counts);
  try {
    assertEquals(s.windows.length, 0, 'nothing pops up over the person\'s work');
    assertEquals(s.keepers, 1, 'the hidden keeper window keeps the runtime alive');
    assertEquals(s.tray?.items.map((i) => i.label), ['Open AIB', '', 'Stop chats and quit']);
    assertEquals(TRAY_ONLY_ITEMS.map((i) => !!i.disabled), [false, true, false], 'the status line is greyed');
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

Deno.test('tray-only start: Stop chats and quit asks first; Cancel keeps everything, OK stops the chats and quits', async () => {
  const counts = { working: 1, needsYou: 0 };
  const cancel = await trayOnlyApp(counts, false);
  try {
    cancel.s.tray!.onMenu('stop');
    await until(() => cancel.s.questions.length === 1, 'the question');
    assert(cancel.s.questions[0].startsWith('Stop chats and quit AIB?'), cancel.s.questions[0]);
    assert(cancel.s.questions[0].includes('1 chat running'), cancel.s.questions[0]);
    await new Promise((r) => setTimeout(r, 20));
    assertEquals(cancel.quits, []);
  } finally {
    await cancel.done();
  }
  const ok = await trayOnlyApp(counts, true);
  try {
    ok.s.tray!.onMenu('stop');
    await until(() => ok.quits.length === 1, 'quit');
    assertEquals(ok.quits, [true], 'stop the agents');
    assertEquals(ok.s.trayRemoved, 1, 'no dead icon left behind');
  } finally {
    await ok.done();
  }
});

Deno.test('tray-only start: quits by itself once nothing has worked for a while, unless the window was opened', async () => {
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
