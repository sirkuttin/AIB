// terminal-ui.js (window.AibTerminal): the header button, the per-chat panel and its states, the socket wiring, and the interface
// "Run in terminal" uses (open / paste / isOpen). Fake xterm and WebSocket; the real ones are covered by work/deno/terminal_test.ts.
const test = require('node:test');
const assert = require('node:assert/strict');
const { page, load } = require('./fake_dom');

class FakeTerm {
  constructor(options) {
    this.options = options;
    this.cols = 100;
    this.rows = 30;
    this.written = [];
    this.addons = [];
    this.focused = 0;
    this.resets = 0;
    FakeTerm.all.push(this);
  }
  loadAddon(a) {
    this.addons.push(a);
  }
  open(el) {
    this.opened = el;
  }
  onData(fn) {
    this.dataFn = fn;
  }
  onResize(fn) {
    this.resizeFn = fn;
  }
  attachCustomKeyEventHandler(fn) {
    this.keyFn = fn;
  }
  hasSelection() {
    return false;
  }
  write(d) {
    this.written.push(d);
  }
  reset() {
    this.resets++;
  }
  focus() {
    this.focused++;
  }
  dispose() {
    this.disposed = true;
  }
}
FakeTerm.all = [];
class FakeFit {
  fit() {}
}
class FakeCanvas {}

class FakeWS {
  constructor(url, protocols) {
    this.url = url;
    this.protocols = [...protocols];
    this.sent = [];
    this.readyState = 1;
    FakeWS.all.push(this);
  }
  get query() {
    return Object.fromEntries(new URL(this.url).searchParams);
  }
  send(d) {
    this.sent.push(JSON.parse(d));
  }
  close() {
    this.readyState = 3;
  }
  ready(extra = {}) {
    this.message({ type: 'ready', cwd: this.query.cwd, shellName: 'PowerShell 7', resumed: false, ...extra });
  }
  message(obj) {
    this.onmessage({ data: JSON.stringify(obj) });
  }
  drop() {
    this.readyState = 3;
    this.onclose({});
  }
}
FakeWS.all = [];

const tick = () => new Promise((r) => setImmediate(r));
async function until(fn, what) {
  for (let i = 0; i < 200; i++) {
    if (fn()) return;
    await tick();
  }
  throw new Error('timed out: ' + what);
}
const json = (v) => JSON.stringify(v);

function setup({ windows = true, list = [] } = {}) {
  FakeTerm.all = [];
  FakeWS.all = [];
  const shell = page({ ids: ['chat'] });
  const header = shell.make('header', '', shell.main);
  const actions = shell.make('div', '', header);
  actions.className = 'header-actions';
  shell.make('span', 'status', actions);
  shell.window.location = { protocol: 'http:', host: '127.0.0.1:8850' };
  shell.window.navigator = { platform: windows ? 'Win32' : 'Linux x86_64' };
  const ctx = load(shell, ['terminal-ui.js']);
  const T = ctx.AibTerminal;
  const state = { current: null, posts: [], selects: [], refreshes: 0, token: 'TOK', changes: 0, composer: 0 };
  const chats = {
    'claude:a': { key: 'claude:a', cwd: 'C:\\Users\\me\\repo\\.claude\\worktrees\\wt-a', project: 'C:\\Users\\me\\repo', title: 'A' },
    'claude:b': { key: 'claude:b', cwd: 'C:\\work\\b', project: 'C:\\work\\b', title: 'B' },
    'claude:nofolder': { key: 'claude:nofolder', cwd: '', title: 'N' },
  };
  T.init({
    current: () => state.current,
    titleOf: (key) => ({ 'claude:x1': 'Linux AppImage icon', 'claude:x2': 'Chats: injected notes' })[key] || '',
    token: async () => state.token,
    refreshToken: async () => {
      state.refreshes++;
      state.token = 'FRESH';
    },
    get: async (path) => (path === 'terminal/list' ? { terminals: list, max: 8 } : {}),
    post: async (path, body) => {
      state.posts.push([path, body]);
      return { ok: true };
    },
    select: async (key) => {
      state.selects.push(key);
      if (!chats[key]) return false;
      state.current = chats[key];
      T.sync();
      return true;
    },
    changed: () => state.changes++,
    focusComposer: () => state.composer++,
    Terminal: FakeTerm,
    FitAddon: FakeFit,
    CanvasAddon: FakeCanvas,
    WebSocket: FakeWS,
  });
  const dock = shell.byId.chat.querySelector('#terminalDock');
  const button = actions.querySelector('.aib-term-toggle');
  const q = (sel) => dock.querySelector(sel);
  const act = (text) => dock.querySelectorAll('.aib-term-act').find((b) => b.textContent.includes(text));
  const show = (key) => {
    state.current = chats[key];
    T.sync();
  };
  return { shell, T, state, chats, dock, button, actions, q, act, show };
}

async function openReady(env, key) {
  const n = FakeWS.all.length;
  const opening = env.T.open(key);
  await until(() => FakeWS.all.length === n + 1, 'socket');
  FakeWS.all[n].ready();
  await opening;
  return FakeWS.all[n];
}
function viewsHidden(env) {
  return env.dock.querySelectorAll('.aib-term-view').every((v) => v.hidden);
}

test('pure parts: socket address, token subprotocol, theme tokens, short folder, idle time, toggle keys', () => {
  const T = require('../outputs/agent-studio/terminal-ui.js');
  const url = new URL(T.socketUrl({ protocol: 'http:', host: '127.0.0.1:8850' }, 'claude:x y', 'C:\\a b', 120, 33, 'windows-powershell'));
  assert.equal(url.origin, 'ws://127.0.0.1:8850');
  assert.equal(url.pathname, '/api/live/terminal');
  assert.deepEqual(Object.fromEntries(url.searchParams), { key: 'claude:x y', cwd: 'C:\\a b', cols: '120', rows: '33', shell: 'windows-powershell' });
  assert.deepEqual(T.protocols('abc-_1'), ['aib-terminal', 'aib-token.abc-_1']);
  const theme = T.themeFrom((name) => ({ '--term-bg': ' #000 ', '--text': '#eee' })[name] || '');
  assert.deepEqual([theme.background, theme.foreground, theme.selectionBackground], ['#000', '#eee', '#3d3456']);
  assert.deepEqual(T.shortPath('C:\\Users\\sirku\\Documents\\Codex\\help\\.claude\\worktrees\\pensive-ritchie'), {
    prefix: '~\\…\\worktrees\\',
    last: 'pensive-ritchie',
  });
  assert.deepEqual(T.shortPath('C:\\work\\b'), { prefix: 'C:\\work\\', last: 'b' });
  assert.deepEqual(T.shortPath('D:\\a\\b\\c\\d'), { prefix: 'D:\\…\\c\\', last: 'd' });
  assert.deepEqual(T.shortPath('/home/me/src/app'), { prefix: '~/src/', last: 'app' });
  assert.deepEqual(T.shortPath('C:\\Users\\me'), { prefix: '~\\', last: '' });
  assert.equal(T.idleText(30_000), 'active');
  assert.equal(T.idleText(5 * 60_000), 'idle 5m');
  assert.equal(T.idleText(3 * 3600_000), 'idle 3h');
  assert.equal(T.idleText(72 * 3600_000), 'idle 3d');
  assert.equal(T.isToggleKey({ ctrlKey: true, code: 'Backquote', key: 'ö' }), true);
  assert.equal(T.isToggleKey({ ctrlKey: true, code: 'KeyJ', key: 'j' }), true);
  assert.equal(T.isToggleKey({ ctrlKey: true, shiftKey: true, code: 'KeyJ' }), false);
  assert.equal(T.clampHeight(10, 500), 120);
  assert.equal(T.clampHeight(900, 500), 500);
});

test('the button: far right of the chat header, hidden without a folder, pressed while shown, green dot when hidden but running', async () => {
  const env = setup();
  const { T, button, actions, show, dock } = env;
  const wrap = actions.children.at(-1);
  assert.ok(wrap.classList.contains('aib-term-toggle-wrap') && wrap.contains(button), 'the button is last in .header-actions');
  assert.equal(button.getAttribute('aria-keyshortcuts'), 'Control+` Control+J');
  assert.equal(wrap.hidden, true);
  show('claude:nofolder');
  assert.equal(wrap.hidden, true, 'no folder, no terminal');
  show('claude:a');
  assert.equal(wrap.hidden, false);
  assert.equal(button.getAttribute('aria-label'), 'Open terminal');
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  assert.equal(wrap.querySelector('.aib-term-tip-note').textContent, 'Opens in ~\\…\\worktrees\\wt-a');
  button.dispatch('mouseenter');
  assert.equal(wrap.querySelector('.aib-term-tip').hidden, false);
  button.dispatch('mouseleave');
  assert.equal(wrap.querySelector('.aib-term-tip').hidden, true);

  button.click();
  await until(() => FakeWS.all.length === 1, 'socket');
  FakeWS.all[0].ready();
  await until(() => T.isOpen('claude:a'), 'open');
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  assert.equal(button.getAttribute('aria-label'), 'Hide terminal');
  assert.equal(wrap.querySelector('.aib-term-live').hidden, true);
  // collapse: hidden, session keeps running, dot on the button
  dock.querySelector('.aib-term-collapse').click();
  assert.equal(dock.hidden, true);
  assert.equal(T.hasSession('claude:a'), true);
  assert.equal(button.getAttribute('aria-label'), 'Show terminal (session running)');
  assert.equal(wrap.querySelector('.aib-term-live').hidden, false);
  assert.equal(env.state.posts.length, 0, 'collapsing does not end the shell');
  assert.ok(env.state.composer > 0, 'focus goes back to the message box');
});

test('the panel: under the message box, one shell per chat in its folder; switching chats shows that chat’s panel or none', async () => {
  const env = setup();
  const { T, dock, q, show } = env;
  show('claude:a');
  const ws = await openReady(env, 'claude:a');
  assert.deepEqual(ws.protocols, ['aib-terminal', 'aib-token.TOK']);
  assert.equal(ws.query.key, 'claude:a');
  assert.equal(ws.query.cwd, 'C:\\Users\\me\\repo\\.claude\\worktrees\\wt-a');
  assert.equal(dock.hidden, false);
  assert.equal(dock.parentNode.id, 'chat');
  assert.equal(q('.aib-term-divider').getAttribute('role'), 'separator');
  assert.equal(q('.aib-term-path-prefix').textContent + q('.aib-term-path-last').textContent, '~\\…\\worktrees\\wt-a');
  assert.equal(q('.aib-term-path').title, 'PowerShell 7, running in C:\\Users\\me\\repo\\.claude\\worktrees\\wt-a (click to copy)');
  assert.ok(q('.aib-term-shell').classList.contains('is-ok'));
  assert.equal(q('.aib-term-shell').textContent, 'PowerShell 7');
  assert.ok(q('.aib-term-slot'), 'a slot for Send to chat (phase 4)');
  assert.equal(q('.aib-term-end').getAttribute('aria-label'), 'End terminal session');
  const term = FakeTerm.all[0];
  assert.ok(term.addons[0] instanceof FakeCanvas, 'the canvas renderer goes in first (CSP: no <style> elements)');
  assert.ok(term.focused > 0);
  assert.deepEqual(ws.sent.at(-1), { type: 'resize', cols: 100, rows: 30 });
  term.dataFn('ls\r');
  assert.deepEqual(ws.sent.at(-1), { type: 'input', data: 'ls\r' });
  term.resizeFn({ cols: 90, rows: 20 });
  assert.deepEqual(ws.sent.at(-1), { type: 'resize', cols: 90, rows: 20 });
  ws.onmessage({ data: new Uint8Array([104, 105]).buffer });
  assert.deepEqual([...term.written.at(-1)], [104, 105]);
  assert.equal(term.keyFn({ type: 'keydown', ctrlKey: true, key: 'v' }), false, 'Ctrl+V is left to the safe paste event');

  show('claude:b');
  assert.equal(dock.hidden, true);
  assert.equal(T.isOpen('claude:b'), false);
  await openReady(env, 'claude:b');
  const views = dock.querySelectorAll('.aib-term-view');
  assert.deepEqual(views.map((v) => [v.dataset.key, v.hidden]), [['claude:a', true], ['claude:b', false]]);
  show('claude:a');
  assert.equal(dock.hidden, false);
  assert.deepEqual(views.map((v) => v.hidden), [false, true]);
  assert.equal(FakeWS.all.length, 2, 'no new shell for a chat that has one');

  // the trash button ends the shell and removes the panel
  q('.aib-term-end').click();
  await until(() => env.state.posts.length === 1, 'end posted');
  assert.equal(json(env.state.posts[0]), json(['terminal/end', { key: 'claude:a' }]));
  assert.equal(dock.hidden, true);
  assert.ok(term.disposed);
  assert.equal(T.hasSession('claude:a'), false);
});

test('session ended: the end line with the exit code, Start new session / Close panel, × instead of trash', async () => {
  const env = setup();
  const { T, q, act, show, dock } = env;
  show('claude:a');
  const ws = await openReady(env, 'claude:a');
  ws.message({ type: 'exit', code: 0 });
  ws.drop();
  assert.equal(q('.aib-term-ended').hidden, false);
  assert.match(q('.aib-term-endline').textContent, /^Session ended · exit code 0 · \d\d:\d\d$/);
  assert.ok(q('.aib-term-shell').classList.contains('is-off'));
  assert.equal(q('.aib-term-shell').textContent, 'PowerShell 7 · ended');
  assert.ok(q('.aib-term-end').classList.contains('is-close'));
  assert.equal(q('.aib-term-end').getAttribute('aria-label'), 'Close terminal panel and clear its output');
  assert.equal(T.isOpen('claude:a'), false);
  assert.equal(T.hasSession('claude:a'), false);
  // hiding and showing again keeps the ended state; nothing restarts by itself
  env.button.click();
  env.button.click();
  assert.equal(FakeWS.all.length, 1);
  assert.equal(q('.aib-term-ended').hidden, false);
  act('Start new session').click();
  await until(() => FakeWS.all.length === 2, 'new session');
  FakeWS.all[1].ready();
  await until(() => T.isOpen('claude:a'), 'running again');
  assert.equal(q('.aib-term-ended').hidden, true);
  // and Close panel clears it
  FakeWS.all[1].message({ type: 'exit', code: 3 });
  assert.match(q('.aib-term-endline').textContent, /exit code 3/);
  act('Close panel').click();
  assert.equal(dock.hidden, true);
  assert.ok(FakeTerm.all[0].disposed);
  assert.equal(env.state.posts.length, 0, 'nothing to end: it had ended');
});

test('shell failed: the reason, Try again and Use Windows PowerShell (a new socket asking for it)', async () => {
  const env = setup();
  const { T, q, act, show } = env;
  show('claude:a');
  const opening = T.open('claude:a');
  await until(() => FakeWS.all.length === 1, 'socket');
  FakeWS.all[0].message({ type: 'error', code: 'spawn_failed', shellName: 'PowerShell 7', message: 'pwsh.exe: not found' });
  FakeWS.all[0].drop();
  await assert.rejects(opening, /not found/);
  assert.ok(q('.aib-term-msg').classList.contains('is-failed'));
  assert.equal(q('.aib-term-msg').getAttribute('role'), 'alert');
  assert.equal(q('.aib-term-mono').textContent, 'pwsh.exe: not found');
  assert.ok(q('.aib-term-shell').classList.contains('is-bad'));
  assert.equal(q('.aib-term-shell').textContent, 'PowerShell 7 · didn’t start');
  assert.equal(viewsHidden(env), true, 'the message replaces the terminal');
  assert.ok(act('Try again'));
  act('Use Windows PowerShell').click();
  await until(() => FakeWS.all.length === 2, 'retry');
  assert.equal(FakeWS.all[1].query.shell, 'windows-powershell');
  FakeWS.all[1].ready({ shellName: 'Windows PowerShell' });
  await until(() => T.isOpen('claude:a'), 'running');
  assert.equal(q('.aib-term-msg').hidden, true);
  assert.equal(q('.aib-term-shell').textContent, 'Windows PowerShell');
});

test('folder missing: amber path with (missing), never a silent fallback; the project folder only when chosen', async () => {
  const env = setup();
  const { T, q, act, show } = env;
  show('claude:a');
  const opening = T.open('claude:a');
  await until(() => FakeWS.all.length === 1, 'socket');
  FakeWS.all[0].message({ type: 'error', code: 'folder_missing', cwd: env.chats['claude:a'].cwd, message: 'gone' });
  FakeWS.all[0].drop();
  await assert.rejects(opening);
  assert.ok(q('.aib-term-path').classList.contains('is-missing'));
  assert.equal(q('.aib-term-path-note').textContent, ' (missing)');
  assert.match(q('.aib-term-path').getAttribute('aria-label'), /^Folder missing: /);
  assert.ok(q('.aib-term-msg').classList.contains('is-missing'));
  assert.equal(q('.aib-term-shell').textContent, 'Shell · not started');
  assert.equal(FakeWS.all.length, 1, 'no other folder was tried');
  const start = act('Start in the project folder');
  assert.equal(start.textContent, 'Start in the project folder (~\\repo)');
  start.click();
  await until(() => FakeWS.all.length === 2, 'project folder');
  assert.equal(FakeWS.all[1].query.cwd, 'C:\\Users\\me\\repo');
  FakeWS.all[1].ready();
  await until(() => T.isOpen('claude:a'), 'running');
  assert.equal(q('.aib-term-path').classList.contains('is-missing'), false);
});

test('too many sessions: which chats hold them (idle ones first), End one and this chat’s terminal starts', async () => {
  const env = setup();
  const { T, q, act, show } = env;
  show('claude:b');
  const now = Date.now();
  const terminals = [
    { key: 'claude:x2', cwd: 'C:\\Users\\me\\wt\\notes-cards', lastActivity: now - 5 * 3600_000 },
    { key: 'claude:x1', cwd: 'C:\\Users\\me\\wt\\app-icon', lastActivity: now - 3600_000 },
    { key: 'claude:x3', cwd: 'C:\\x\\three', lastActivity: now },
    { key: 'claude:x4', cwd: 'C:\\x\\four', lastActivity: now - 7 * 3600_000 },
  ];
  const opening = T.open('claude:b');
  await until(() => FakeWS.all.length === 1, 'socket');
  FakeWS.all[0].message({ type: 'error', code: 'too_many', max: 8, terminals, message: '8 terminals are already open.' });
  FakeWS.all[0].drop();
  await assert.rejects(opening);
  assert.equal(q('.aib-term-msg').querySelector('h3').textContent, '8 terminals are already open');
  const rows = env.dock.querySelectorAll('.aib-term-li');
  assert.deepEqual(rows.map((r) => r.querySelector('.aib-term-li-name').textContent), ['claude:x4', 'Chats: injected notes', 'Linux AppImage icon']);
  assert.equal(rows[1].querySelector('.aib-term-li-idle').textContent, 'idle 5h');
  assert.equal(rows[1].querySelector('.aib-term-act').getAttribute('aria-label'), 'End terminal in Chats: injected notes');
  act('Show all 4').click();
  assert.equal(env.dock.querySelectorAll('.aib-term-li').length, 4);
  env.dock.querySelectorAll('.aib-term-li')[0].querySelector('.aib-term-act').click();
  await until(() => FakeWS.all.length === 2, 'retried after ending one');
  assert.equal(json(env.state.posts[0]), json(['terminal/end', { key: 'claude:x4' }]));
  FakeWS.all[1].ready();
  await until(() => T.isOpen('claude:b'), 'running');
});

test('paste: opens if needed, never types an Enter, asks first when a command is running, no hint afterwards', async () => {
  const env = setup();
  const { T, q, act, show } = env;
  show('claude:a');
  const pasting = T.paste('claude:a', 'npm test\nnpm run lint\n');
  await until(() => FakeWS.all.length === 1, 'socket');
  const ws = FakeWS.all[0];
  ws.ready();
  await until(() => ws.sent.some((m) => m.type === 'busy?'), 'asked whether busy');
  const ask = ws.sent.find((m) => m.type === 'busy?');
  ws.message({ type: 'busy', id: ask.id, busy: false });
  assert.equal(await pasting, true);
  assert.deepEqual(ws.sent.at(-1), { type: 'paste', data: 'npm test\nnpm run lint\n' });
  assert.ok(!ws.sent.some((m) => m.type === 'input'), 'paste must not type anything (no Enter)');
  assert.equal(q('.aib-term-warn').hidden, true, 'no overlay or hint after a paste');

  // busy: the warning, then Cancel
  const busyAsks = () => ws.sent.filter((m) => m.type === 'busy?');
  const second = T.paste('claude:a', 'git status');
  await until(() => busyAsks().length === 2, 'asked again');
  ws.message({ type: 'busy', id: busyAsks()[1].id, busy: true });
  await until(() => !q('.aib-term-warn').hidden, 'warning');
  assert.equal(q('.aib-term-warn').getAttribute('role'), 'alert');
  assert.match(q('.aib-term-warn').textContent, /A command is still running\. Pasting would type into it\./);
  act('Cancel').click();
  assert.equal(await second, false);
  assert.equal(ws.sent.filter((m) => m.type === 'paste').length, 1, 'nothing pasted on Cancel');
  assert.equal(q('.aib-term-warn').hidden, true);
  // busy: Paste anyway
  const third = T.paste('claude:a', 'git log');
  await until(() => busyAsks().length === 3, 'asked a third time');
  ws.message({ type: 'busy', id: busyAsks()[2].id, busy: true });
  await until(() => !q('.aib-term-warn').hidden, 'warning again');
  act('Paste anyway').click();
  assert.equal(await third, true);
  assert.deepEqual(ws.sent.at(-1), { type: 'paste', data: 'git log' });

  // another chat (a split side pane, or not open): selected first
  const other = T.paste('claude:b', 'dir');
  await until(() => FakeWS.all.length === 2, 'second socket');
  FakeWS.all[1].ready();
  await until(() => FakeWS.all[1].sent.some((m) => m.type === 'busy?'), 'asked');
  FakeWS.all[1].message({ type: 'busy', id: FakeWS.all[1].sent.find((m) => m.type === 'busy?').id, busy: false });
  assert.equal(await other, true);
  assert.deepEqual(env.state.selects, ['claude:b']);
  await assert.rejects(T.paste('claude:gone', 'x'), /could not be opened/);
  show('claude:nofolder');
  await assert.rejects(T.paste('claude:nofolder', 'x'), /no folder/);
});

test('a refused socket retries once with a fresh token', async () => {
  const env = setup();
  env.show('claude:a');
  const opening = env.T.open('claude:a');
  await until(() => FakeWS.all.length === 1, 'socket');
  FakeWS.all[0].drop();
  await until(() => FakeWS.all.length === 2, 'retry');
  assert.equal(env.state.refreshes, 1);
  assert.deepEqual(FakeWS.all[1].protocols, ['aib-terminal', 'aib-token.FRESH']);
  FakeWS.all[1].ready();
  await opening;
});

test('Ctrl+` and Ctrl+J (by key position): open and focus; pressed in the terminal: hide and back to the message box', async () => {
  const env = setup();
  const { T, dock, shell, show, state } = env;
  show('claude:a');
  shell.document.dispatch('keydown', { ctrlKey: true, code: 'KeyJ', key: 'j' });
  await until(() => FakeWS.all.length === 1, 'socket');
  FakeWS.all[0].ready();
  await until(() => !dock.hidden && T.isOpen('claude:a'), 'shown');
  const inside = dock.querySelector('.aib-term-view');
  const ev = shell.document.dispatch('keydown', { ctrlKey: true, code: 'Backquote', key: '`', target: inside });
  assert.ok(ev.defaultPrevented);
  assert.equal(dock.hidden, true);
  assert.equal(state.composer, 1);
  assert.equal(T.hasSession('claude:a'), true);
});

test('sidebar: shells already running when the page loads get the row icon; rowIcon is null otherwise', async () => {
  const env = setup({ list: [{ key: 'claude:x1', cwd: 'C:\\a', lastActivity: Date.now() }] });
  await until(() => env.state.changes > 0, 'list read');
  assert.equal(env.T.hasSession('claude:x1'), true);
  const iconEl = env.T.rowIcon('claude:x1');
  assert.ok(iconEl);
  assert.equal(iconEl.getAttribute('aria-label'), 'Terminal session running');
  assert.equal(env.T.rowIcon('claude:a'), null);
});
