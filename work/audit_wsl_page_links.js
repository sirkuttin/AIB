'use strict';
// WSL audit (docs/wsl/audit-beta10.md): paths in a WSL chat's replies (files-state.js relTo/dedupe + files-ui.js linkPaths).
// A WSL chat's folder on the page is its ref (c.cwd = 'wsl://ubuntu/home/u/app'); its agent names files by Linux path
// (/home/u/app/...). The KNOWN-BROKEN cases were the audit's failing probes (F2, F5); they pass since the fix and keep their names.
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('./fake_dom.js');
const FS = require('../app/page/files-state.js');

// wsl-ui.js gives the page its WSL ref helpers (AIBWsl.parse/refOf), as in chat.html
const SCRIPTS = ['wsl-ui.js', 'status-words.js', 'ownership-ui.js', 'notify-rules.js', 'sidebar-ui.js', 'workspace-state.js', 'split-tree.js', 'workspace-ui.js', 'tool-views.js', 'files-state.js', 'files-ui.js'];
const REF = 'wsl://ubuntu/home/u/app';
const LINUX = '/home/u/app';
const flush = () => new Promise((r) => setTimeout(r, 0));
const entry = (path, o) => Object.assign({ name: path.slice(path.lastIndexOf('/') + 1), path, dir: false, ignored: false, status: '', changed: 0, size: 10 }, o || {});
const LISTING = { '': [entry('src', { dir: true }), entry('README.md')], src: [entry('src/main.ts')] };

function setup(opts) {
  const o = opts || {};
  const shell = D.page({ ids: ['wsProjectBtn', 'wsRenameProj', 'wsNewProject', 'new', 'connections'], width: 1000 });
  shell.make('b', 'wsListName', shell.byId.wsProjectBtn);
  const find = shell.make('button', 'findChat');
  shell.body.insertBefore(find, shell.byId.connections);
  find.append(shell.make('span'));
  const ctx = D.load(shell, SCRIPTS);
  const calls = [];
  ctx.AgentChangesUI = { hunkRows: () => [], _live: () => ({ data: () => ({ git: true, prefix: '', files: [] }), chatId: () => 'claude:w1', focusFile() {} }) };
  ctx.AgentArtifactsUI = { state: () => ({ list: [] }), open: () => true, registerFile: async () => ({ id: 'x' }) };
  // a WSL chat as the page knows it (c.public(): cwd = the ref, wsl = {distro, name, linuxPath})
  const list = [o.chat || { provider: 'claude', id: 'w1', key: 'k-w1', title: 'WSL chat', cwd: REF, projectPath: REF, wsl: { distro: 'ubuntu', name: 'Ubuntu', linuxPath: LINUX }, created: 1, modified: 1 }];
  const listing = o.listing || LISTING,
    listRoot = o.root || REF;
  const getJson = async (path, q) => {
    calls.push({ path, q: Object.assign({}, q) });
    if (path === '/api/live/files/list') {
      const l = listing[q.dir];
      if (!l) throw Object.assign(new Error('Not found'), { status: 404 });
      return { root: listRoot, dir: q.dir, git: true, entries: l, wsl: listRoot.startsWith('wsl://') || undefined }; // wsl_routes.ts wslFiles: root is the ref
    }
    if (path === '/api/live/files/outside') {
      // the server's WSL outside route would answer (the helper reads it) with the "Outside this project" label
      return { path: q.path, abs: q.path, name: q.path.split('/').pop(), size: 1, binary: false, tooBig: false, image: false, page: false, text: null, lines: 1, viewUrl: '', outside: { kind: 'folder', text: q.path.slice(0, q.path.lastIndexOf('/')) }, wsl: true };
    }
    return {};
  };
  const W = ctx.AgentWorkspaceUI;
  W.init({ aliasKey: (c) => c.provider + ':' + c.id, titleOf: (c) => c.title, conversations: () => list, rerender() { W.sync(list, list[0]); }, getJson, postJson: async () => ({}), open: () => true, showStart() {}, notice() {}, reload() {}, quickPrompt() {} });
  const FU = ctx.AgentFilesUI;
  FU.init({ aliasKey: (c) => c.provider + ':' + c.id, titleOf: (c) => c.title, getJson, post: async () => ({}), notice() {}, conversations: () => list, open: async () => {} });
  W.sync(list, list[0]);
  FU.sync(list[0]);
  return { shell, FU, calls, ctx };
}

test('OK: a relative path in a WSL chat reply links inside the project (Files list asked, never the outside route)', async () => {
  const t = setup();
  const p = t.shell.document.createElement('p');
  p.append(t.shell.document.createTextNode('I changed src/main.ts.'));
  assert.equal(await t.FU.linkPaths(p), 1);
  assert.equal(p.querySelector('a.fx-path').dataset.filePath, 'src/main.ts');
  assert.ok(!t.calls.some((c) => c.path === '/api/live/files/outside'));
});

test('files-state relTo: a Linux path inside the WSL project folder against its ref', () => {
  // documents the root cause: the page compares the agent's Linux path with the ref, which never matches
  assert.equal(FS.relTo(LINUX + '/src/main.ts', REF), null);
});

test('KNOWN-BROKEN: an absolute Linux path inside the WSL project links as an in-project file, not as "Outside this project" (read-only)', async () => {
  const t = setup();
  const p = t.shell.document.createElement('p');
  p.append(t.shell.document.createTextNode('I changed ' + LINUX + '/src/main.ts and ' + LINUX + '/README.md.'));
  const n = await t.FU.linkPaths(p);
  const asked = t.calls.filter((c) => c.path === '/api/live/files/outside').map((c) => c.q.path);
  const links = p.querySelectorAll('a.fx-path');
  assert.deepEqual(asked, [], 'asked the outside route about files inside the project: ' + asked.join(', '));
  assert.equal(n, 2);
  assert.deepEqual(links.map((a) => a.dataset.filePath), ['src/main.ts', 'README.md']);
});

test('KNOWN-BROKEN: a Write/Edit row naming an absolute Linux path in the WSL project gets an in-project open-file button, not an outside read-only one', async () => {
  const t = setup();
  const box = t.shell.make('div');
  const ok = await t.FU.toolFile(box, LINUX + '/src/main.ts'); // Claude's Edit/Write tool calls carry absolute paths
  const asked = t.calls.filter((c) => c.path === '/api/live/files/outside').map((c) => c.q.path);
  assert.equal(ok, true);
  assert.deepEqual(asked, [], 'the in-project file was asked of the outside route (opens "Outside this project", read only)');
});

test('KNOWN-BROKEN: Linux names are case-sensitive: "readme.md" in a WSL chat reply does not link to README.md (a click would ask for a file that is not there)', async () => {
  const t = setup();
  const p = t.shell.document.createElement('p');
  p.append(t.shell.document.createTextNode('There is no readme.md here.'));
  assert.equal(await t.FU.linkPaths(p), 0, 'linked a name that differs in case (files-ui.js dirNames folds case)');
});

test('KNOWN-BROKEN: Ctrl+click on a Linux path outside a WSL chat\'s folder asks the editor with a ref (the server refuses a bare /home/... path: "That path is not a folder of this PC")', async () => {
  const t = setup();
  const edits = [];
  t.ctx.AgentEditors = { openFile: (p, l, cwd) => edits.push([p, cwd]), fileEditor: () => ({ name: 'VS Code' }) };
  const p = t.shell.document.createElement('p');
  p.append(t.shell.document.createTextNode('Log at /home/u/other/run.log.'));
  await t.FU.linkPaths(p);
  const a = p.querySelector('a.fx-path');
  assert.ok(a, 'linked as an outside file');
  t.shell.document.dispatch('click', { target: a, ctrlKey: true });
  assert.equal(edits.length, 1);
  assert.ok(String(edits[0][0]).startsWith('wsl://') || String(edits[0][1]).startsWith('wsl://'), 'sent ' + JSON.stringify(edits[0]) + ': editors.ts cleanPathText refuses it');
});

// ---- after the fix (docs/wsl/audit-beta10.md F2, F5): more cases than the probes above ----------------------------------------

const COPY = '/home/u/.aib-server/data-x/worktrees/app-abc';
const COPY_REF = 'wsl://ubuntu' + COPY;
const copyChat = () => ({
  provider: 'claude', id: 'w2', key: 'k-w2', title: 'WSL copy chat', cwd: COPY_REF, projectRoot: REF, worktree: { branch: 'aib/chat-1', base: 'main' },
  wsl: { distro: 'ubuntu', name: 'Ubuntu', linuxPath: COPY }, created: 1, modified: 1,
});

test('F2: a WSL chat in its own copy links an absolute Linux path in the copy as the copy\'s file (relative to the copy, never outside)', async () => {
  const t = setup({ chat: copyChat(), root: COPY_REF });
  const p = t.shell.document.createElement('p');
  p.append(t.shell.document.createTextNode('Edited ' + COPY + '/src/main.ts.'));
  assert.equal(await t.FU.linkPaths(p), 1);
  const a = p.querySelector('a.fx-path');
  assert.equal(a.dataset.filePath, 'src/main.ts');
  assert.equal(JSON.parse(a.dataset.scope).root, 'chat');
  assert.equal(a.dataset.abs, COPY_REF + '/src/main.ts', 'opens in the editor by its ref');
  assert.ok(!t.calls.some((c) => c.path === '/api/live/files/outside'));
});

test('F2: Ctrl+click on an in-project Linux path link sends the editor the file\'s ref', async () => {
  const t = setup();
  const edits = [];
  t.ctx.AgentEditors = { openFile: (p, l, cwd) => edits.push([p, l, cwd]), fileEditor: () => ({ name: 'VS Code' }) };
  const p = t.shell.document.createElement('p');
  p.append(t.shell.document.createTextNode('See ' + LINUX + '/src/main.ts:12 now.'));
  assert.equal(await t.FU.linkPaths(p), 1);
  t.shell.document.dispatch('click', { target: p.querySelector('a.fx-path'), ctrlKey: true });
  assert.deepEqual(edits, [[REF + '/src/main.ts', 12, REF + '/src']]);
});

test('F5: the exact-case name in a WSL reply still links (README.md), and both README.md and readme.md files link separately', async () => {
  const t = setup({ listing: { '': [entry('README.md'), entry('readme.md')] } });
  const p = t.shell.document.createElement('p');
  p.append(t.shell.document.createTextNode('Compare README.md with readme.md.'));
  assert.equal(await t.FU.linkPaths(p), 2);
  assert.deepEqual(p.querySelectorAll('a.fx-path').map((a) => a.dataset.filePath), ['README.md', 'readme.md']);
});

test('F5 unchanged on Windows: a Windows chat still links names case-insensitively (readme.md -> README.md)', async () => {
  const WIN = String.raw`C:\repo\app`;
  const t = setup({ chat: { provider: 'claude', id: 'c1', key: 'k-c1', title: 'Win chat', cwd: WIN, projectPath: WIN, created: 1, modified: 1 }, root: WIN, listing: { '': [entry('README.md')] } });
  const p = t.shell.document.createElement('p');
  p.append(t.shell.document.createTextNode('See readme.md and ' + WIN + String.raw`\README.md.`));
  assert.equal(await t.FU.linkPaths(p), 1, 'the same file twice in one paragraph links once (case folded on Windows)');
  assert.equal(p.querySelector('a.fx-path').dataset.filePath, 'readme.md');
  assert.ok(!t.calls.some((c) => c.path === '/api/live/files/outside'));
});

test('F5: Ctrl+click on a Windows outside link still sends the Windows path unchanged', async () => {
  const WIN = String.raw`C:\repo\app`;
  const t = setup({ chat: { provider: 'claude', id: 'c1', key: 'k-c1', title: 'Win chat', cwd: WIN, projectPath: WIN, created: 1, modified: 1 }, root: WIN });
  const edits = [];
  t.ctx.AgentEditors = { openFile: (p, l, cwd) => edits.push([p, cwd]), fileEditor: () => ({ name: 'VS Code' }) };
  const p = t.shell.document.createElement('p');
  p.append(t.shell.document.createTextNode(String.raw`Log at C:\other\run.log now.`));
  await t.FU.linkPaths(p);
  t.shell.document.dispatch('click', { target: p.querySelector('a.fx-path'), ctrlKey: true });
  assert.deepEqual(edits, [[String.raw`C:\other\run.log`, String.raw`C:\other`]]);
});

test('Open in Artifacts on a WSL file: its artifact is found by the wsl:// ref it was published from, and a WSL chat holds a Linux-path file', () => {
  const { FU, ctx } = setup();
  const art = { id: 'a1', title: 'Index', wslSource: REF + '/site/index.html', conversationId: 'k-w1' };
  ctx.AgentArtifactsUI.state = () => ({ list: [art] });
  assert.equal(FU._artifactFor(REF, 'site/index.html'), art, 'the tree root is the ref');
  assert.equal(FU._artifactFor(LINUX, 'site/index.html'), art, 'or the Linux path');
  assert.equal(FU._artifactFor(REF, 'site/other.html'), null);
  const c = FU._artChatFor({ root: 'main' }, LINUX + '/site/index.html');
  assert.ok(c && c.id === 'claude:w1', 'the WSL chat whose folder holds the file registers it');
});
