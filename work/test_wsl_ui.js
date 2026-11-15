'use strict';
// WSL projects on the page (docs/wsl/design.md section 8), in the fake DOM: wsl-ui.js (names, paths, the distro state line and the
// "Ubuntu wants to open" question), the New project dialog's Location and Linux folder browser, the delete dialog (Remove from AIB, or move the folder to the distro's trash), the editor menu (VS Code / Cursor / Reveal), files-state's greyed Docs row option, and the terminal's sign-in socket.
const test = require('node:test');
const assert = require('node:assert/strict');
const { page, load } = require('./fake_dom.js');

const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
};
const plain = (v) => JSON.parse(JSON.stringify(v));

const UBUNTU = { name: 'Ubuntu', key: 'ubuntu', state: 'ready', line: '', home: '/home/u', helper: '0.1.0-ab12cd34', problem: '', alwaysAllow: false };
const STATUS = { available: true, distros: [UBUNTU], openRequests: [] };

function wslPage(status = STATUS, scripts = [], extra = {}) {
  const shell = page();
  const ctx = load(shell, ['wsl-ui.js', ...scripts]);
  const calls = { gets: [], posts: [] };
  let current = status;
  const host = Object.assign(
    {
      getJson: (path, params) => {
        calls.gets.push([path, plain(params || {})]);
        if (path === '/api/live/wsl/status') return Promise.resolve(plain(current));
        return Promise.resolve({});
      },
      postJson: (name, body) => {
        calls.posts.push([name, plain(body)]);
        return Promise.resolve({ ok: true });
      },
      currentPath: () => 'wsl://ubuntu/home/u/app',
    },
    extra,
  );
  ctx.AIBWsl.init(host);
  return { shell, ctx, calls, W: ctx.AIBWsl, set: (s) => (current = s) };
}

test('refs: split by hand, names from the status, short paths under home, header and tooltip forms', async () => {
  const { W } = wslPage();
  await settle();
  assert.deepEqual(plain(W.parse('wsl://ubuntu/home/u/app')), { key: 'ubuntu', linuxPath: '/home/u/app' });
  assert.equal(W.parse('C:\\work\\app'), null);
  assert.equal(W.parse('wsl://'), null);
  assert.equal(W.isWsl('wsl://ubuntu/srv/x'), true);
  assert.equal(W.distroName('ubuntu'), 'Ubuntu');
  assert.equal(W.distroName('debian'), 'debian', 'unknown distro: its key');
  assert.equal(W.shortPath('wsl://ubuntu/home/u/app'), '~/app');
  assert.equal(W.shortPath('wsl://ubuntu/home/u'), '~');
  assert.equal(W.shortPath('wsl://ubuntu/home/uu/app'), '/home/uu/app', 'only the home folder itself becomes ~');
  assert.equal(W.headerPath('wsl://ubuntu/home/u/app'), 'Ubuntu · ~/app');
  assert.equal(W.tooltip('wsl://ubuntu/home/u/app'), 'Ubuntu: /home/u/app');
  assert.equal(W.displayPath('C:\\work\\app'), 'C:\\work\\app');
  assert.equal(W.refOf('Ubuntu', '/home/u/x'), 'wsl://ubuntu/home/u/x');
  assert.deepEqual(plain(W.fromUnc('\\\\wsl.localhost\\Ubuntu\\home\\u\\app')), { name: 'Ubuntu', linuxPath: '/home/u/app' });
  assert.deepEqual(plain(W.fromUnc('\\\\wsl$\\Ubuntu')), { name: 'Ubuntu', linuxPath: '/' });
  assert.equal(W.fromUnc('\\\\server\\share'), null);
});

test('the status is read once and polled only while this PC has a WSL2 distro', async () => {
  const none = wslPage({ available: false, distros: [], openRequests: [] });
  await settle();
  none.shell.window.runTimers();
  await settle();
  assert.equal(none.calls.gets.filter(([p]) => p === '/api/live/wsl/status').length, 1, 'no WSL: read once, no polling');
  const some = wslPage();
  await settle();
  some.shell.window.runTimers();
  await settle();
  assert.equal(some.calls.gets.filter(([p]) => p === '/api/live/wsl/status').length, 2, 'WSL: read again after the timer');
});

test('distro state line: hidden when ready; "Starting Ubuntu…"; stopped gets a Reconnect button that posts wsl/reconnect', async () => {
  const t = wslPage();
  await settle();
  const box = t.shell.document.querySelector('#wslStateLine');
  assert.ok(box, 'the line exists in <main>');
  assert.equal(box.hidden, true, 'ready: nothing to say');
  t.W._set({ available: true, distros: [Object.assign({}, UBUNTU, { state: 'starting', line: 'Starting Ubuntu…' })] });
  assert.equal(box.hidden, false);
  assert.equal(box.textContent, 'Starting Ubuntu…');
  assert.equal(box.className, 'studio-notice wsl-line', 'the server-notice look');
  t.W._set({ available: true, distros: [Object.assign({}, UBUNTU, { state: 'stopped', line: 'Ubuntu stopped. Reconnect' })] });
  const b = box.querySelector('button');
  assert.equal(box.querySelector('span').textContent, 'Ubuntu stopped.');
  assert.equal(b.textContent, 'Reconnect');
  b.click();
  await settle();
  assert.deepEqual(t.calls.posts[0], ['wsl/reconnect', { distro: 'ubuntu' }]);
});

test('"Ubuntu wants to open <url>": Open, Always allow for Ubuntu, Don\'t open post the answer and the bar goes', async () => {
  const req = { id: 'r1', distro: 'ubuntu', name: 'Ubuntu', url: 'https://example.com/login', at: 1 };
  const t = wslPage(Object.assign({}, STATUS, { openRequests: [req] }));
  await settle();
  const box = t.shell.document.querySelector('#wslOpenAsk');
  assert.equal(box.hidden, false);
  assert.equal(box.querySelector('span').textContent, 'Ubuntu wants to open https://example.com/login');
  const labels = box.querySelectorAll('button').map((b) => b.textContent);
  assert.deepEqual(labels, ['Open', 'Always allow for Ubuntu', "Don't open"]);
  t.set(STATUS);
  box.querySelectorAll('button')[1].click();
  await settle();
  assert.deepEqual(t.calls.posts[0], ['wsl/open-url', { id: 'r1', action: 'always' }]);
  assert.equal(box.hidden, true);
});

// ---- New project ----------------------------------------------------------------------------------------------------------
function newProject(status, pick) {
  const t = wslPage(status, ['notify-rules.js', 'workspace-state.js', 'new-project-ui.js']);
  const checks = [];
  t.ctx.AgentNewProjectUI.init({
    getJson: (path, params) => {
      if (path === '/api/live/folders/start') return Promise.resolve({ start: 'C:\\REPOS', home: 'C:\\Users\\me', source: 'last' });
      if (path === '/api/live/wsl/dirs')
        return Promise.resolve(
          params.path === '/home/u/app'
            ? { path: '/home/u/app', parent: '/home/u', dirs: [], truncated: false }
            : { path: '/home/u', parent: '/home', dirs: [{ name: 'app', isGit: true }, { name: 'notes', isGit: false }], truncated: false },
        );
      checks.push(plain(params));
      return Promise.resolve({ valid: true, exists: true, isDir: true, path: params.path, reason: 'existing', gitAvailable: true });
    },
    postJson: (name) => (name === 'folders/pick' ? Promise.resolve({ path: pick || '' }) : Promise.resolve({ ok: true })),
    projects: () => [],
    keyOf: (p) => String(p),
    done: () => {},
  });
  // wsl/dirs goes through wsl-ui.js's own host: point it at the same answers
  t.ctx.AIBWsl.init({
    getJson: (path, params) =>
      path === '/api/live/wsl/status'
        ? Promise.resolve(plain(status))
        : path === '/api/live/wsl/dirs'
          ? Promise.resolve(
              params.path === '/home/u/app'
                ? { path: '/home/u/app', parent: '/home/u', dirs: [], truncated: false }
                : { path: '/home/u', parent: '/home', dirs: [{ name: 'app', isGit: true }, { name: 'notes', isGit: false }], truncated: false },
            )
          : Promise.resolve({}),
    postJson: () => Promise.resolve({ ok: true }),
    currentPath: () => '',
  });
  return Object.assign(t, { checks });
}

test('New project: no Location choice on a PC without a WSL2 distro', async () => {
  const t = newProject({ available: false, distros: [], openRequests: [] });
  await settle();
  t.ctx.AgentNewProjectUI.open(null);
  await settle();
  const ui = t.ctx.AgentNewProjectUI._ui();
  assert.equal(ui.location, null);
  assert.equal(t.shell.document.getElementById('npLocation'), null);
});

test('New project: Location "WSL: Ubuntu" makes Folder a Linux path, checked as a ref, with a distro folder browser', async () => {
  const t = newProject(STATUS);
  await settle();
  t.ctx.AgentNewProjectUI.open(null);
  await settle();
  const ui = t.ctx.AgentNewProjectUI._ui();
  assert.deepEqual(ui.location.children.map((o) => o.textContent), ['Windows', 'WSL: Ubuntu']);
  assert.equal(ui.browseWsl.hidden, true, 'Windows: only the system Browse…');
  ui.location.value = 'ubuntu';
  ui.location.dispatch('change');
  await settle();
  assert.equal(ui.folder.value, '/home/u/', 'starts in the distro home');
  assert.equal(ui.folder.placeholder, '/home/u/project');
  assert.equal(ui.browseWsl.hidden, false);
  assert.equal(ui.browseWsl.textContent, 'Browse Ubuntu…');
  assert.equal(ui.browse.hidden, false, 'the system dialog stays offered');
  assert.equal(t.checks[t.checks.length - 1].path, 'wsl://ubuntu/home/u/');
  ui.browseWsl.click();
  await settle();
  assert.equal(ui.dirs.hidden, false);
  assert.equal(ui.dirs.querySelector('.np-dirs-here').textContent, 'Ubuntu: /home/u');
  const rows = ui.dirs.querySelectorAll('.np-dir').map((b) => b.textContent);
  assert.deepEqual(rows, ['..', 'app (git)', 'notes']);
  ui.dirs.querySelectorAll('.np-dir')[1].click();
  await settle();
  assert.equal(ui.dirs.querySelector('.np-dirs-here').textContent, 'Ubuntu: /home/u/app');
  ui.dirs.querySelector('.np-dirs-head').querySelector('button').click(); // Use this folder
  await settle();
  assert.equal(ui.folder.value, '/home/u/app');
  assert.equal(ui.dirs.hidden, true);
  assert.equal(t.checks[t.checks.length - 1].path, 'wsl://ubuntu/home/u/app');
});

test('New project: a \\\\wsl.localhost pick in the system dialog selects that distro and its Linux path', async () => {
  const t = newProject(STATUS, '\\\\wsl.localhost\\Ubuntu\\home\\u\\code');
  await settle();
  t.ctx.AgentNewProjectUI.open(null);
  await settle();
  const ui = t.ctx.AgentNewProjectUI._ui();
  ui.browse.click();
  await settle();
  assert.equal(ui.location.value, 'ubuntu');
  assert.equal(ui.folder.value, '/home/u/code');
  assert.equal(t.checks[t.checks.length - 1].path, 'wsl://ubuntu/home/u/code');
});

// ---- delete, editors, files, terminal --------------------------------------------------------------------------------------
test('Delete project of a WSL project: "Remove from AIB" by default; the tick box moves the folder to the trash in Ubuntu', async () => {
  const t = wslPage(STATUS, ['delete-project-ui.js']);
  await settle();
  let checked = 0;
  const choices = [];
  const ui = t.ctx.AgentDeleteProjectUI.show({
    name: 'app',
    path: 'wsl://ubuntu/home/u/app',
    chats: 2,
    running: 0,
    check: () => {
      checked++;
      return Promise.resolve({ exists: true, refusal: '', trash: 'gio', worktreeOf: '' });
    },
    confirm: (c) => {
      choices.push(plain(c));
      return Promise.resolve();
    },
  });
  await settle();
  assert.equal(checked, 1, 'the distro is asked what a folder delete would do');
  const disk = ui.box.querySelector('#dpDisk');
  assert.equal(ui.box.querySelector('.dp-disk').hidden, false);
  assert.equal(ui.box.querySelector('.dp-disk').textContent, 'Move folder to trash in Ubuntu');
  assert.equal(disk.checked, false, 'unticked by default');
  assert.equal(disk.disabled, false);
  assert.equal(
    ui.box.querySelector('.dp-main').textContent,
    'Removes app from AIB. Its 2 chats move to Recently deleted. The folder Ubuntu: /home/u/app stays in Ubuntu.',
  );
  const yes = ui.box.querySelector('.dp-ok');
  assert.equal(yes.textContent, 'Remove from AIB');
  disk.checked = true;
  disk.dispatch('change');
  assert.equal(yes.textContent, 'Remove and move folder to trash');
  assert.equal(
    ui.box.querySelector('.dp-warn').textContent,
    'This moves the folder Ubuntu: /home/u/app and everything in it to the trash in Ubuntu, so you can still get it back from there.',
  );
  assert.ok(!/permanent/.test(ui.box.querySelector('.dp-warn').textContent));
  yes.click();
  await settle();
  assert.deepEqual(choices, [{ disk: true, expect: 'gio' }]);
});

test('Delete project of a WSL project: a refusal from the distro disables the tick box and says why; Remove from AIB still works', async () => {
  const t = wslPage(STATUS, ['delete-project-ui.js']);
  await settle();
  const choices = [];
  const ui = t.ctx.AgentDeleteProjectUI.show({
    name: 'app',
    path: 'wsl://ubuntu/home/u/app',
    chats: 0,
    running: 0,
    check: () =>
      Promise.resolve({ exists: true, refusal: 'This distro has no trash AIB can use for this folder', trash: 'permanent', worktreeOf: '' }),
    confirm: (c) => {
      choices.push(plain(c));
      return Promise.resolve();
    },
  });
  await settle();
  assert.equal(ui.box.querySelector('#dpDisk').disabled, true);
  assert.equal(
    ui.box.querySelector('.dp-note').textContent,
    'Deleting the folder is not possible: This distro has no trash AIB can use for this folder',
  );
  ui.box.querySelector('.dp-ok').click();
  await settle();
  assert.deepEqual(choices, [{ disk: false, expect: '' }]);
});

test('Open in editor for a WSL project: VS Code and Cursor (Remote-WSL) and Reveal only; no workspace files are read', async () => {
  const t = wslPage(STATUS, ['editors-ui.js']);
  const gets = [];
  t.ctx.AgentEditors.init({
    get: (path, params) => {
      gets.push([path, plain(params || {})]);
      return Promise.resolve({
        editors: [
          { id: 'code', name: 'VS Code', kind: 'editor', capabilities: { workspace: true, file: true } },
          { id: 'cursor', name: 'Cursor', kind: 'editor', capabilities: { workspace: true, file: true } },
          { id: 'windsurf', name: 'Windsurf', kind: 'editor', capabilities: { workspace: true, file: true } },
          { id: 'explorer', name: 'Explorer', kind: 'explorer', capabilities: {} },
          { id: 'terminal', name: 'Windows Terminal', kind: 'terminal', capabilities: {} },
        ],
        default: 'windsurf',
      });
    },
    post: () => Promise.resolve({}),
  });
  await settle();
  const E = t.ctx.AgentEditors;
  const ref = 'wsl://ubuntu/home/u/app';
  assert.deepEqual(plain(E.workspacesCached(ref)), []);
  const labels = plain(E.projectItems(E.menuModelFor(ref, true)).map((i) => i.label || '—'));
  assert.deepEqual(labels, ['Open in VS Code', 'Open in Cursor', '—', 'Show in Explorer']);
  await E.loadWorkspaces(ref);
  assert.equal(gets.filter(([, p]) => p.project).length, 0, 'no workspace lookup in the distro');
  const win = E.projectItems(E.menuModelFor('C:\\work\\app', false)).map((i) => i.label || '—');
  assert.ok(win.includes('Open in Windsurf') && win.includes('Open terminal here'), 'Windows projects keep every entry');
});

test('files-state docsOff (no longer used for WSL projects: their docs work, test_doc_links.js): a greyed, closed Docs row with the reason', () => {
  const shell = page();
  const ctx = load(shell, ['files-state.js']);
  const F = ctx.AgentFilesState;
  const cache = { '': [{ name: 'src', path: 'src', dir: true }, { name: 'aib-docs', path: 'aib-docs', dir: true }] };
  const rows = F.treeRows(cache, new Set(), { docsOff: 'Docs are not available for WSL projects yet', newDoc: false });
  assert.equal(rows[0].path, 'aib-docs');
  assert.equal(rows[0].canOpen, false);
  assert.equal(rows[0].off, 'Docs are not available for WSL projects yet');
  assert.equal(rows.filter((r) => r.path === 'aib-docs').length, 1, 'a real aib-docs folder is not listed twice');
  const normal = F.treeRows(cache, new Set(), { newDoc: true });
  assert.ok(!normal.some((r) => r.off), 'Windows projects unchanged');
});

test('terminal: the sign-in socket names the distro; folder tips read "Ubuntu · ~/" + the last part', async () => {
  const t = wslPage(STATUS, ['terminal-ui.js']);
  await settle();
  const T = t.ctx.AibTerminal;
  const url = T.signinUrl({ protocol: 'http:', host: '127.0.0.1:1' }, 'claude', 80, 24, '', 'ubuntu');
  assert.ok(url.includes('signin=claude') && url.includes('distro=ubuntu'), url);
  assert.ok(!T.signinUrl({ protocol: 'http:', host: 'h' }, 'claude', 80, 24, 'install', 'ubuntu').includes('distro='));
  // a WSL chat's sign-in card: the distro and the advertised method's args together
  const card = new URL(T.signinUrl({ protocol: 'http:', host: 'h' }, 'claude', 80, 24, '', 'ubuntu', ['--cli', 'auth', 'login', '--console']));
  assert.equal(card.searchParams.get('distro'), 'ubuntu');
  assert.deepEqual(card.searchParams.getAll('arg'), ['--cli', 'auth', 'login', '--console']);
  assert.deepEqual(plain(T.shortPath('wsl://ubuntu/home/u/app')), { prefix: 'Ubuntu · ~/', last: 'app' });
  assert.deepEqual(plain(T.shortPath('wsl://ubuntu/srv/data/app')), { prefix: 'Ubuntu · /srv/data/', last: 'app' });
});

test('project list: a WSL row has a distro chip and "Ubuntu: /home/u/app" in its tooltip; the project button says "Ubuntu · ~/app"', () => {
  const shell = page({ ids: ['wsProjectBtn', 'wsListName', 'wsRenameProj', 'wsNewProject', 'activityHead', 'composerHelp', 'new'] });
  const ctx = load(shell, [
    'wsl-ui.js',
    'status-words.js',
    'ownership-ui.js',
    'notify-rules.js',
    'sidebar-ui.js',
    'workspace-state.js',
    'split-tree.js',
    'workspace-ui.js',
  ]);
  ctx.AIBWsl._set(STATUS);
  const list = [
    { provider: 'claude', id: 'a', key: 'k-a', title: 'A', cwd: 'wsl://ubuntu/home/u/app', created: 100, modified: 100 },
    { provider: 'claude', id: 'b', key: 'k-b', title: 'B', cwd: 'C:\\work\\beta', created: 90, modified: 90 },
  ];
  const W = ctx.AgentWorkspaceUI;
  W.init({
    aliasKey: (c) => c.provider + ':' + c.id,
    titleOf: (c) => c.title,
    conversations: () => list,
    rerender() {},
    getJson: async () => ({}),
    postJson: async () => ({}),
    open: () => true,
    showStart() {},
    notice() {},
    reload() {},
    quickPrompt() {},
  });
  W.sync(list, null);
  const item = W._items().find((i) => String(i.projectPath).startsWith('wsl://'));
  assert.ok(item, 'the WSL chat has a project');
  W.selectProject(item.projectKey);
  W.sync(list, null);
  assert.ok(shell.byId.wsProjectBtn.title.includes('Ubuntu · ~/app'), shell.byId.wsProjectBtn.title);
  W.openProjectMenu();
  const rows = shell.body.querySelectorAll('.ws-prow-main');
  const wsl = rows.filter((r) => r.querySelector('.ws-distro'));
  assert.equal(wsl.length, 1, 'only the WSL project has a chip');
  assert.equal(wsl[0].querySelector('.ws-distro').textContent, 'Ubuntu');
  assert.equal(wsl[0].title.split('\n')[1], 'Ubuntu: /home/u/app');
});

// ---- AIB's own install of an agent in a distro (wsl-ui.js installBox, shown by chat.js in the new-chat agent panel) --------------
function installPage(replies) {
  const gets = [],
    posts = [];
  const t = wslPage(STATUS, [], {
    getJson: (path, params) => {
      gets.push([path, plain(params || {})]);
      if (path === '/api/live/wsl/status') return Promise.resolve(plain(STATUS));
      const r = replies.get && replies.get(path, params);
      return r instanceof Error ? Promise.reject(r) : Promise.resolve(r || {});
    },
    postJson: (name, body) => {
      posts.push([name, plain(body)]);
      const r = replies.post && replies.post(name, body);
      return r instanceof Error ? Promise.reject(r) : Promise.resolve(r || {});
    },
  });
  return Object.assign(t, { gets, posts });
}
const MISSING = { id: 'claude', found: false, installable: true, pinned: '0.102.0', install: 'npm i -g x' };

test('Install in Ubuntu: the button starts the job in the distro; a progress bar with Cancel while it runs; done repaints the panel', async () => {
  let polls = 0;
  const t = installPage({
    post: (name) => (name === 'wsl/agents/install' ? { state: 'running', stage: 'downloading', percent: 30, agent: 'claude' } : {}),
    get: (path) => {
      if (path !== '/api/live/wsl/agents/install') return {};
      polls++;
      return polls === 1 ? { state: 'running', stage: 'verifying', percent: 92 } : { state: 'done', percent: 100 };
    },
  });
  await settle();
  let repainted = 0;
  const box = t.W.installBox({ key: 'ubuntu', id: 'claude', agentName: 'Claude Code', row: MISSING, done: () => repainted++ });
  const go = box.querySelector('button');
  assert.equal(go.textContent, 'Install in Ubuntu');
  assert.ok(go.title.includes('~/.aib-server/agents') && go.title.includes('0.102.0'), go.title);
  go.click();
  await settle();
  assert.deepEqual(t.posts[0], ['wsl/agents/install', { distro: 'ubuntu', agent: 'claude' }]);
  assert.ok(box.textContent.includes('Installing Claude Code in Ubuntu… Downloading and unpacking…'), box.textContent);
  const bar = box.querySelector('.st-progress');
  assert.equal(bar.getAttribute('aria-valuenow'), '30');
  assert.equal(box.querySelector('button').textContent, 'Cancel');
  t.shell.window.runTimers();
  await settle();
  assert.deepEqual(t.gets.filter(([p]) => p === '/api/live/wsl/agents/install')[0][1], { distro: 'ubuntu', agent: 'claude' });
  assert.ok(box.textContent.includes('Checking the install…'));
  assert.equal(box.querySelector('.st-progress').getAttribute('aria-valuenow'), '92');
  t.shell.window.runTimers();
  await settle();
  assert.equal(repainted, 1, 'done: the panel looks at the distro again');
  assert.equal(t.W.installJob('ubuntu', 'claude'), null);
});

test('Install in Ubuntu: Cancel posts the cancel; a failure shows its line and Retry', async () => {
  const t = installPage({
    post: (name) =>
      name === 'wsl/agents/install'
        ? { state: 'running', stage: 'preparing', percent: 2 }
        : name === 'wsl/agents/install/cancel'
          ? { state: 'idle' }
          : {},
  });
  await settle();
  const box = t.W.installBox({ key: 'ubuntu', id: 'codex', agentName: 'Codex', row: Object.assign({}, MISSING, { id: 'codex' }), done: () => {} });
  box.querySelector('button').click();
  await settle();
  box.querySelector('button').click(); // Cancel
  await settle();
  assert.deepEqual(t.posts[1], ['wsl/agents/install/cancel', { distro: 'ubuntu', agent: 'codex' }]);
  assert.equal(t.W.installJob('ubuntu', 'codex'), null);

  const f = installPage({ post: () => Object.assign(Error('Could not reach the npm registry. Check the internet connection and try again.'), { code: '' }) });
  await settle();
  const fbox = f.W.installBox({ key: 'ubuntu', id: 'claude', agentName: 'Claude Code', row: MISSING, done: () => {} });
  fbox.querySelector('button').click();
  await settle();
  assert.ok(fbox.querySelector('.bad').textContent.startsWith('Could not reach the npm registry'));
  assert.equal(fbox.querySelector('button').textContent, 'Retry');
});

test('Install in Ubuntu: without Node.js the button is off, the line says why, the nvm command can be copied, Check again asks with force', async () => {
  const t = installPage({ get: (path) => (path === '/api/live/wsl/agents' ? { agents: [] } : {}) });
  await settle();
  const row = Object.assign({}, MISSING, {
    installBlock: 'Node.js 22 or newer is needed in Ubuntu to install Claude Code, and Ubuntu has no Node.js.',
    nodeInstall: 'curl … | bash && nvm install 22',
  });
  const box = t.W.installBox({ key: 'ubuntu', id: 'claude', agentName: 'Claude Code', row, done: () => {} });
  assert.ok(box.textContent.includes('Ubuntu has no Node.js.'));
  assert.equal(box.querySelector('code').textContent, 'curl … | bash && nvm install 22');
  const buttons = box.querySelectorAll('button');
  assert.deepEqual(buttons.map((b) => b.textContent), ['Copy', 'Install in Ubuntu', 'Check again']);
  assert.equal(buttons[1].disabled, true);
  buttons[2].click();
  await settle();
  assert.deepEqual(t.gets.filter(([p]) => p === '/api/live/wsl/agents').pop()[1], { distro: 'ubuntu', force: '1' });
});

test('Update in Ubuntu: AIB\'s own install older than the pinned version; a job still running after a reload is shown and polled', async () => {
  const t = installPage({ get: () => ({ state: 'running', stage: 'downloading', percent: 50 }) });
  await settle();
  const row = { id: 'claude', found: true, managed: true, update: true, version: '0.101.0', pinned: '0.102.0', installable: true };
  const box = t.W.installBox({ key: 'ubuntu', id: 'claude', agentName: 'Claude Code', row, done: () => {} });
  assert.ok(box.textContent.includes('AIB now uses Claude Code 0.102.0; Ubuntu has 0.101.0.'));
  assert.equal(box.querySelector('button').textContent, 'Update in Ubuntu');
  const running = Object.assign({}, row, { job: { state: 'running', stage: 'downloading', percent: 10 } });
  const box2 = t.W.installBox({ key: 'ubuntu', id: 'codex', agentName: 'Codex', row: running, done: () => {} });
  assert.ok(box2.textContent.startsWith('Updating Codex in Ubuntu…'));
  t.shell.window.runTimers();
  await settle();
  assert.equal(box2.querySelector('.st-progress').getAttribute('aria-valuenow'), '50');
});
