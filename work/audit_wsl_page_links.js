'use strict';
// WSL audit (docs/wsl/audit-beta10.md): paths in a WSL chat's replies (files-state.js relTo/dedupe + files-ui.js linkPaths).
// A WSL chat's folder on the page is its ref (c.cwd = 'wsl://ubuntu/home/u/app'); its agent names files by Linux path
// (/home/u/app/...). Fake DOM, no browser. KNOWN-BROKEN cases run only with AUDIT_WSL=1 (node --test work/audit_wsl_page_links.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('./fake_dom.js');
const FS = require('../outputs/agent-studio/files-state.js');

const SCRIPTS = ['status-words.js', 'ownership-ui.js', 'notify-rules.js', 'sidebar-ui.js', 'workspace-state.js', 'split-tree.js', 'workspace-ui.js', 'tool-views.js', 'files-state.js', 'files-ui.js'];
const REF = 'wsl://ubuntu/home/u/app';
const LINUX = '/home/u/app';
const AUDIT = !!process.env.AUDIT_WSL;
const flush = () => new Promise((r) => setTimeout(r, 0));
const entry = (path, o) => Object.assign({ name: path.slice(path.lastIndexOf('/') + 1), path, dir: false, ignored: false, status: '', changed: 0, size: 10 }, o || {});
const LISTING = { '': [entry('src', { dir: true }), entry('README.md')], src: [entry('src/main.ts')] };

function setup() {
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
  const list = [{ provider: 'claude', id: 'w1', key: 'k-w1', title: 'WSL chat', cwd: REF, projectPath: REF, wsl: { distro: 'ubuntu', name: 'Ubuntu', linuxPath: LINUX }, created: 1, modified: 1 }];
  const getJson = async (path, q) => {
    calls.push({ path, q: Object.assign({}, q) });
    if (path === '/api/live/files/list') {
      const l = LISTING[q.dir];
      if (!l) throw Object.assign(new Error('Not found'), { status: 404 });
      return { root: REF, dir: q.dir, git: true, entries: l, wsl: true }; // wsl_routes.ts wslFiles: root is the ref
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

test('KNOWN-BROKEN: an absolute Linux path inside the WSL project links as an in-project file, not as "Outside this project" (read-only)', { skip: !AUDIT }, async () => {
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

test('KNOWN-BROKEN: a Write/Edit row naming an absolute Linux path in the WSL project gets an in-project open-file button, not an outside read-only one', { skip: !AUDIT }, async () => {
  const t = setup();
  const box = t.shell.make('div');
  const ok = await t.FU.toolFile(box, LINUX + '/src/main.ts'); // Claude's Edit/Write tool calls carry absolute paths
  const asked = t.calls.filter((c) => c.path === '/api/live/files/outside').map((c) => c.q.path);
  assert.equal(ok, true);
  assert.deepEqual(asked, [], 'the in-project file was asked of the outside route (opens "Outside this project", read only)');
});

test('KNOWN-BROKEN: Linux names are case-sensitive: "readme.md" in a WSL chat reply does not link to README.md (a click would ask for a file that is not there)', { skip: !AUDIT }, async () => {
  const t = setup();
  const p = t.shell.document.createElement('p');
  p.append(t.shell.document.createTextNode('There is no readme.md here.'));
  assert.equal(await t.FU.linkPaths(p), 0, 'linked a name that differs in case (files-ui.js dirNames folds case)');
});

test('KNOWN-BROKEN: Ctrl+click on a Linux path outside a WSL chat\'s folder asks the editor with a ref (the server refuses a bare /home/... path: "That path is not a folder of this PC")', { skip: !AUDIT }, async () => {
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
