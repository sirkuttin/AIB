'use strict';
// The Update button (updates-ui.js) at the right end of the tab strip, right under the window's minimise / maximise / close
// buttons; it replaced the amber "AIB 0.1.x is ready to install. Install now / Later" line (owner, 2026-11-12: "1a 2c 3b 4a").
// And the "What's new in AIB <version>" tab (files-ui.js openNotes) that opens once after an update. Fake DOM, fake server.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const D = require('./fake_dom.js');
const { APP } = require('./_paths');

const U = require(path.join(APP, 'updates-ui.js'));

const READY = {
  state: 'ready',
  current: '0.1.0-beta.9',
  inPlace: true,
  installWhenIdle: false,
  desktop: true,
  configured: true,
  available: { version: '0.1.0-beta.10', path: 'C:/data/updates/0.1.0-beta.10/AIB-0.1.0-beta.10-windows-x64.zip' },
};
const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

// ---- pure ---------------------------------------------------------------------------------------------------------------
test('button(): hidden unless a verified update is ready', () => {
  assert.equal(U.button(null, null).show, false);
  for (const state of ['none', 'found', 'refused', 'error', 'unconfigured'])
    assert.equal(U.button({ state, available: { version: '9.9.9' } }, null).show, false, state);
  assert.equal(U.button({ state: 'ready' }, null).show, false, 'ready without a version');
});

test('button(): reads "Update" (no version); the tooltip names the version and says what happens', () => {
  const b = U.button(READY, null);
  assert.equal(b.show, true);
  assert.equal(b.label, 'Update');
  assert.equal(b.action, 'install');
  assert.equal(b.title, 'AIB 0.1.0-beta.10 is ready. Click to install. AIB closes and opens again; working chats keep running.');
  assert.doesNotMatch(b.label, /\d/, 'no version number on the button');
});

test('button(): waiting for chats reads "Update when chats finish" and a click cancels the wait', () => {
  const b = U.button(Object.assign({}, READY, { installWhenIdle: true }), null);
  assert.equal(b.label, 'Update when chats finish');
  assert.equal(b.action, 'cancel-wait');
  assert.equal(b.waiting, true);
  assert.match(b.title, /^AIB 0\.1\.0-beta\.10 will install when your chats finish\./);
  assert.match(b.title, /Click to cancel the wait\.$/);
});

test('button(): a copy that cannot update itself (.deb, a source run) offers the instructions, never an install', () => {
  const b = U.button(Object.assign({}, READY, { inPlace: false, instructions: 'Install it with: sudo apt install "x.deb"' }), null);
  assert.equal(b.label, 'Update');
  assert.equal(b.action, 'how');
  assert.match(b.title, /cannot install it by itself: click for how/);
});

test('button(): while installing it is disabled and says AIB closes and opens again', () => {
  const b = U.button(READY, { kind: 'installing', chats: 2 });
  assert.equal(b.label, 'Updating…');
  assert.equal(b.disabled, true);
  assert.equal(b.title, 'Installing AIB 0.1.0-beta.10. AIB will close and open again by itself. Your working chats keep running.');
  assert.equal(U.button(READY, { kind: 'installing', chats: 0 }).title, 'Installing AIB 0.1.0-beta.10. AIB will close and open again by itself.');
  const err = U.button(READY, { kind: 'error', text: 'Could not start the install.' });
  assert.equal(err.action, 'install', 'after an error a click tries again');
  assert.match(err.title, /^Could not start the install\. AIB 0\.1\.0-beta\.10 is ready/);
});

test('the amber line is gone: no #updateBanner in the page, no banner() in updates-ui.js, no .update-banner style', () => {
  const html = fs.readFileSync(path.join(APP, 'chat.html'), 'utf8');
  assert.doesNotMatch(html, /updateBanner|update-banner/);
  assert.equal(U.banner, undefined);
  for (const css of ['chat.css', 'files.css', 'theme.css', 'header.css', 'workspace.css'])
    assert.doesNotMatch(fs.readFileSync(path.join(APP, css), 'utf8'), /update-banner|#updateBanner/, css);
  const src = fs.readFileSync(path.join(APP, 'updates-ui.js'), 'utf8');
  assert.doesNotMatch(src, /'Later'|Install now'\s*}/, 'no "Later" button');
  assert.doesNotMatch(src, /\bconfirm\(/, 'never a native confirm()');
});

test('the button uses the accent teal (theme tokens)', () => {
  const theme = fs.readFileSync(path.join(APP, 'theme.css'), 'utf8');
  assert.match(theme, /--update-btn-bg: var\(--accent\);/);
  assert.match(theme, /--update-btn-text: var\(--on-accent\);/);
  const css = fs.readFileSync(path.join(APP, 'chat.css'), 'utf8');
  assert.match(css, /\.upd-btn \{[^}]*background: var\(--update-btn-bg\);[^}]*\}/);
  assert.match(css, /\.upd-btn \{[^}]*flex: none;/, 'never squeezed by the tabs: the tab list scrolls instead');
});

// ---- the button in a page ------------------------------------------------------------------------------------------------
// A page with the tab strip and a fake server: status() is what GET /api/live/update answers; install(body) answers or throws.
function pageWith(opts) {
  const o = opts || {};
  const shell = D.page();
  const ctx = D.load(shell, ['updates-ui.js']);
  const posts = [];
  const gets = [];
  let status = o.status || READY;
  const host = {
    get: async (p) => {
      gets.push(p);
      if (p === '/api/live/update/notes') return { notes: o.notes || null };
      return status;
    },
    post: async (name, body) => {
      posts.push(JSON.parse(JSON.stringify([name, body])));
      if (name === 'update/install' && o.install) {
        const r = o.install(body, (s) => (status = s));
        if (r instanceof Error) throw r;
        return r;
      }
      return Object.assign({}, status);
    },
  };
  ctx.AibUpdates.init(host);
  return {
    shell,
    ctx,
    U: ctx.AibUpdates,
    posts,
    gets,
    setStatus: (s) => (status = s),
    btn: () => shell.byId.chatTabs.querySelector('#updateButton'),
    pop: () => shell.body.querySelector('#updatePopover'),
  };
}

test('the button sits at the right end of the tab strip; hidden while there is no update', async () => {
  const t = pageWith({ status: { state: 'none', current: '0.1.0-beta.9' } });
  const b = t.btn();
  assert.ok(b, 'in #chatTabs');
  assert.equal(t.shell.byId.chatTabs.children[t.shell.byId.chatTabs.children.length - 1], b, 'the last thing in the strip');
  assert.equal(b.hidden, true, 'no update: no button');
  t.setStatus(READY);
  await t.U.refresh();
  assert.equal(b.hidden, false);
  assert.equal(b.textContent, 'Update');
  assert.match(b.title, /AIB 0\.1\.0-beta\.10 is ready\. Click to install\./);
  assert.ok(b.classList.contains('upd-btn'));
  // a redraw of the strip (workspace-ui.js replaces its children) puts the same button back at the end
  t.shell.byId.chatTabs.replaceChildren(t.shell.document.createElement('div'));
  t.U.attach(t.shell.byId.chatTabs);
  assert.equal(t.btn(), b);
  assert.equal(t.shell.byId.chatTabs.children[1], b);
  // installed or gone: the button goes
  t.setStatus({ state: 'none', current: '0.1.0-beta.10' });
  await t.U.refresh();
  assert.equal(b.hidden, true);
});

test('a click installs at once (POST update/install, whenIdle false) and the button then says it is updating', async () => {
  const t = pageWith({ install: () => ({ state: 'installing', ok: true, chats: 1 }) });
  await t.U.refresh();
  t.btn().click();
  await flush();
  assert.deepEqual(t.posts[0], ['update/install', { whenIdle: false }]);
  assert.equal(t.posts.length, 1, 'one request, no confirmation step');
  assert.equal(t.btn().textContent, 'Updating…');
  assert.equal(t.btn().disabled, true);
  assert.match(t.btn().title, /AIB will close and open again by itself\. Your working chats keep running\./);
});

test('busy chats that cannot be carried over: it switches to "Update when chats finish" by itself; a click again cancels', async () => {
  const t = pageWith({
    install: (body, set) => {
      if (body.cancelWait) {
        set(READY);
        return READY;
      }
      if (body.whenIdle === false)
        return Object.assign(new Error('This update changes how AIB runs agents, so it waits until no chat is working (2 now).'), {
          code: 'chats_working',
          chats: 2,
          status: 409,
        });
      set(Object.assign({}, READY, { installWhenIdle: true }));
      return { state: 'waiting', chats: 2, ok: true };
    },
  });
  await t.U.refresh();
  t.btn().click();
  await flush();
  assert.deepEqual(
    t.posts.map((p) => p[1]),
    [{ whenIdle: false }, { whenIdle: true }],
    'install now, refused for the working chats, then install when they finish',
  );
  assert.equal(t.btn().textContent, 'Update when chats finish');
  assert.match(t.btn().title, /Click to cancel the wait/);
  assert.ok(t.pop(), 'the popover says why');
  assert.match(t.pop().textContent, /waits until no chat is working \(2 now\)\. AIB installs the update when they finish/);
  t.btn().click();
  await flush();
  assert.deepEqual(t.posts[2], ['update/install', { cancelWait: true }]);
  assert.equal(t.btn().textContent, 'Update');
  assert.equal(t.pop(), null, 'the popover closed');
});

test('an install that cannot happen in place: the click shows the instructions in a small in-page popover, no install request', async () => {
  const deb = Object.assign({}, READY, {
    inPlace: false,
    instructions: 'Install it with: sudo apt install "/data/updates/x.deb"  (or open the file in your software installer). Then start AIB again.',
    available: { version: '0.1.0-beta.10', path: '/data/updates/x.deb' },
  });
  const t = pageWith({ status: deb });
  await t.U.refresh();
  assert.equal(t.btn().textContent, 'Update');
  t.btn().click();
  await flush();
  assert.equal(t.posts.length, 0, 'nothing is installed');
  const pop = t.pop();
  assert.ok(pop, 'the popover');
  assert.equal(pop.parentNode, t.shell.body, 'in the page');
  assert.match(pop.textContent, /AIB 0\.1\.0-beta\.10 is downloaded and verified\. Install it with: sudo apt install/);
  assert.match(pop.textContent, /The file: \/data\/updates\/x\.deb/);
  assert.equal(t.btn().getAttribute('aria-expanded'), 'true');
  t.btn().click();
  assert.equal(t.pop(), null, 'a second click closes it');
  t.btn().click();
  assert.ok(t.pop());
  t.shell.document.dispatch('keydown', { key: 'Escape' });
  assert.equal(t.pop(), null, 'Escape closes it');
  t.btn().click();
  pop.querySelector('.upd-pop-x');
  t.pop().querySelector('.upd-pop-x').click();
  assert.equal(t.pop(), null, 'and its ×');
});

test('a failed install says so in the popover and the tooltip; the next click tries again', async () => {
  let n = 0;
  const t = pageWith({
    install: () => (++n === 1 ? Object.assign(new Error('The downloaded update changed or is missing; it was not run.'), { code: 'checksum_mismatch' }) : { state: 'installing', ok: true }),
  });
  await t.U.refresh();
  t.btn().click();
  await flush();
  assert.match(t.pop().textContent, /The downloaded update changed or is missing/);
  assert.match(t.btn().title, /^The downloaded update changed or is missing/);
  t.btn().click();
  await flush();
  assert.equal(n, 2);
  assert.equal(t.btn().textContent, 'Updating…');
});

// ---- a .deb install (Linux): Install now asks for the system password; the window says so --------------------------------------
const DEB = Object.assign({}, READY, {
  password: true,
  authorizing: false,
  askOnPc: false,
  restarting: false,
  installError: '',
  available: { version: '0.1.0-beta.10', path: '/home/ann/.local/state/agent-studio/updates/0.1.0-beta.10/AIB-0.1.0-beta.10-linux-x64.deb' },
});
const ASKING = 'AIB is asking for your system password to install the update.';

test('button() on a .deb install: says a click asks for the password; "Install now" when a phone or a wait asked for it', () => {
  const b = U.button(DEB, null);
  assert.equal([b.label, b.action].join(' '), 'Update install');
  assert.match(b.title, /Click to install: AIB asks for your system password, then closes and opens again\.$/);
  const asked = U.button(Object.assign({}, DEB, { askOnPc: true }), null);
  assert.equal([asked.label, asked.action, asked.disabled].join(' '), 'Install now install false');
  assert.match(asked.title, /It waits for your click here/);
});

test('button() while the system password prompt is open: "Waiting for password…", disabled, and says the prompt is AIB\'s', () => {
  for (const [st, notice] of [[Object.assign({}, DEB, { authorizing: true }), null], [DEB, { kind: 'authorizing' }]]) {
    const b = U.button(st, notice);
    assert.equal([b.label, b.disabled, b.action].join(' '), 'Waiting for password… true none');
    assert.ok(b.title.startsWith(ASKING), b.title);
  }
  const r = U.button(Object.assign({}, DEB, { restarting: true }), null);
  assert.equal([r.label, r.disabled].join(' '), 'Restart when chats finish true');
  assert.equal(U.cardLine(Object.assign({}, DEB, { authorizing: true })), ASKING);
});

test('.deb click: answered at once ("authorizing"), the popover says AIB asks for the password; a closed prompt shows why', async () => {
  const t = pageWith({ status: DEB, install: (_body, set) => (set(Object.assign({}, DEB, { authorizing: true })), { state: 'authorizing', ok: true }) });
  await t.U.refresh();
  t.btn().click();
  await flush();
  assert.deepEqual(t.posts, [['update/install', { whenIdle: false }]], 'one request; it does not wait for the prompt');
  assert.equal(t.btn().textContent, 'Waiting for password…');
  assert.equal(t.btn().disabled, true);
  assert.ok(t.pop() && t.pop().textContent.includes(ASKING), 'the window says the prompt is AIB\'s');
  // the prompt was closed: the next status poll carries why; the page shows it and Update can be clicked again
  const why = 'The password prompt was closed, so nothing was installed. Install it with: sudo apt install "x.deb"';
  t.setStatus(Object.assign({}, DEB, { installError: why }));
  await t.U.refresh();
  assert.equal(t.btn().textContent, 'Update');
  assert.equal(t.btn().disabled, false);
  assert.ok(t.pop().textContent.includes('The password prompt was closed'), t.pop().textContent);
  assert.match(t.btn().title, /^The password prompt was closed/);
});

test('.deb click: installed, the page reads "Updating…"; partly installed: the fix, no "try again"', async () => {
  const asking = (_body, set) => (set(Object.assign({}, DEB, { authorizing: true })), { state: 'authorizing', ok: true });
  const t = pageWith({ status: DEB, install: asking });
  await t.U.refresh();
  t.btn().click();
  await flush();
  t.setStatus(DEB); // authorizing over, no error: installed, AIB is quitting
  await t.U.refresh();
  assert.equal(t.btn().textContent, 'Updating…');
  const p = pageWith({ status: DEB, install: asking });
  await p.U.refresh();
  p.btn().click();
  await flush();
  const partial = 'The update is only partly installed: ... To finish, open a terminal and run: sudo dpkg --configure -a  then restart AIB.';
  p.setStatus(Object.assign({}, DEB, { installError: partial }));
  await p.U.refresh();
  assert.ok(p.pop().textContent.includes('sudo dpkg --configure -a'));
  assert.ok(!p.pop().textContent.includes('try again'), p.pop().textContent);
});

test('.deb with chats working: no switch to "Update when chats finish" (no later prompt); it says to click again', async () => {
  const msg = 'Some working chats do not run in the keeper (chats working now: 2). Installing asks for your system password, so click Install now again once they finish.';
  const t = pageWith({
    status: DEB,
    install: () => Object.assign(new Error(msg), { code: 'chats_working', body: { code: 'chats_working', chats: 2, password: true } }),
  });
  await t.U.refresh();
  t.btn().click();
  await flush();
  assert.deepEqual(t.posts.map((p) => p[1]), [{ whenIdle: false }], 'never asks for whenIdle on a .deb install');
  assert.ok(t.pop().textContent.includes('click Install now again once they finish'));
  const s = pageWith({
    status: DEB,
    install: () => Object.assign(new Error('Installing AIB 0.1.0-beta.10 needs your system password on the PC'), { code: 'password_on_pc' }),
  });
  await s.U.refresh();
  s.btn().click();
  await flush();
  assert.ok(s.pop().textContent.includes('needs your system password on the PC'));
  assert.equal(s.btn().disabled, false);
});

test('a paired computer sees that a .deb update finishes on the PC with the password', () => {
  const v = U.remoteView({ phase: '' }, { state: 'ready', version: '0.1.0-beta.10', canInstall: true, password: true, installWhenIdle: false }, 'Desk', true, 0);
  assert.equal(v.note, 'Installing asks for the system password on Desk, so it finishes there with Install now.');
});

// ---- "What's new in AIB <version>" ------------------------------------------------------------------------------------------
const SCRIPTS = ['status-words.js', 'notify-rules.js', 'ownership-ui.js', 'sidebar-ui.js', 'workspace-state.js', 'split-tree.js', 'workspace-ui.js', 'tool-views.js', 'markdown.js', 'files-state.js', 'files-ui.js', 'updates-ui.js'];
const NOTES = {
  version: '0.1.0-beta.10',
  releases: [
    { version: '0.1.0-beta.10', date: '2026-11-12T10:00:00Z', page: '', body: '## Update button\n\n- **Update** sits at the top right.' },
    { version: '0.1.0-beta.9', date: '2026-11-05T10:00:00Z', page: '', body: 'Files tab fixes.' },
    { version: '0.1.0-beta.8', date: '', page: '', body: 'Keeper.' },
  ],
};
function workspacePage(notes) {
  const shell = D.page({ ids: ['wsProjectBtn', 'wsRenameProj', 'wsNewProject', 'new', 'connections'] });
  shell.make('b', 'wsListName', shell.byId.wsProjectBtn);
  const find = shell.make('button', 'findChat');
  shell.body.insertBefore(find, shell.byId.connections);
  find.append(shell.make('span'));
  const ctx = D.load(shell, SCRIPTS);
  const list = [{ provider: 'claude', id: 'a1', key: 'k-a1', title: 'Title a1', cwd: 'C:/work/alpha', created: 100, modified: 100 }];
  const getJson = async () => ({});
  const W = ctx.AgentWorkspaceUI;
  W.init({
    aliasKey: (c) => c.provider + ':' + c.id,
    titleOf: (c) => c.title || c.id,
    conversations: () => list,
    rerender() {
      W.sync(list, list[0]);
    },
    getJson,
    postJson: async () => ({}),
    open: () => true,
    showStart() {},
    notice() {},
    reload() {},
    quickPrompt() {},
  });
  const FU = ctx.AgentFilesUI;
  FU.init({ aliasKey: (c) => c.provider + ':' + c.id, titleOf: (c) => c.title || c.id, getJson, notice() {}, conversations: () => list, open: async () => {} });
  W.sync(list, list[0]);
  FU.sync(list[0]);
  const posts = [];
  ctx.AibUpdates.init({
    get: async (p) => (p === '/api/live/update/notes' ? { notes } : READY),
    post: async (name, body) => (posts.push(JSON.parse(JSON.stringify([name, body]))), { ok: true }),
  });
  return { shell, ctx, W, FU, posts };
}
const tabsOf = (t) => t.shell.byId.chatTabs.querySelectorAll('.ws-tab').map((n) => n.querySelector('.ws-tab-title').textContent);

test('the Update button survives every redraw of the workspace tab strip and stays its last item', async () => {
  const t = workspacePage(null);
  await t.ctx.AibUpdates.refresh();
  const strip = t.shell.byId.chatTabs;
  const b = strip.querySelector('#updateButton');
  assert.ok(b && !b.hidden);
  t.W.refresh();
  assert.equal(strip.querySelector('#updateButton'), b, 'the same node after a redraw');
  assert.equal(strip.children[strip.children.length - 1], b, 'at the right end, after the spacer');
  assert.ok(strip.children[strip.children.length - 2].classList.contains('ws-spacer'));
});

test('after an update: one "What\'s new in AIB <version>" tab with every release, newest first; then never again', async () => {
  const t = workspacePage(NOTES);
  assert.equal(await t.ctx.AibUpdates.showNotes(), true);
  assert.deepEqual(t.posts, [['update/notes', { shown: true }]], 'the server is told: not offered again');
  assert.ok(tabsOf(t).includes("What's new in AIB 0.1.0-beta.10"), tabsOf(t).join(' | '));
  const view = t.shell.body.querySelector('#fileView');
  assert.ok(view && !view.hidden, 'the tab is showing');
  assert.ok(t.shell.body.classList.contains('sf-file-on'));
  const secs = view.querySelectorAll('.sf-note-rel');
  assert.deepEqual(
    secs.map((s) => s.querySelector('.sf-note-ver').textContent),
    ['AIB 0.1.0-beta.10', 'AIB 0.1.0-beta.9', 'AIB 0.1.0-beta.8'],
    'newest first, the version just installed on top',
  );
  assert.ok(secs[0].classList.contains('current'));
  assert.match(secs[0].querySelector('.sf-note-meta').textContent, /^Installed now · /);
  assert.match(secs[1].querySelector('.sf-note-meta').textContent, /^Earlier release · /);
  assert.equal(secs[2].querySelector('.sf-note-meta').textContent, 'Earlier release', 'no date: none shown');
  const md = secs[0].querySelector('.sf-note-body');
  assert.ok(['h3', 'h4', 'h5', 'h6'].some((h) => md.querySelector(h)), 'Markdown headings render');
  assert.ok(md.querySelector('strong'), 'Markdown emphasis renders');
  assert.match(view.querySelector('.fx-pv-foot').textContent, /Read-only/);
  assert.match(view.querySelector('.fx-pv-foot').textContent, /3 releases · newest first/);
  // not saved with the file tabs (the notes are not kept in the page)
  assert.doesNotMatch(t.shell.localStorage.getItem('aib-files-tabs-v1') || '', /notes:/);
  for (const k of t.shell.localStorage._data.keys()) assert.doesNotMatch(t.shell.localStorage.getItem(k), /What's new/, k);
  // closing it goes back to the chat
  const tab = t.shell.byId.chatTabs.querySelectorAll('.ws-tab').find((n) => /What's new/.test(n.textContent));
  tab.querySelector('.ws-tab-x').click();
  assert.equal(tabsOf(t).some((x) => /What's new/.test(x)), false);
  assert.ok(!t.shell.body.classList.contains('sf-file-on'));
});

test('no notes (none stored, already shown, another version, or no body): no tab, nothing posted', async () => {
  for (const notes of [null, { version: '0.1.0-beta.10', releases: [] }]) {
    const t = workspacePage(notes);
    assert.equal(await t.ctx.AibUpdates.showNotes(), false);
    assert.deepEqual(t.posts, []);
    assert.equal(tabsOf(t).some((x) => /What's new/.test(x)), false);
  }
});

test('the first status poll also asks for the notes, once', async () => {
  const t = pageWith({ notes: null });
  await t.U.refresh();
  await t.U.refresh();
  assert.equal(t.gets.filter((p) => p === '/api/live/update/notes').length, 1);
});
