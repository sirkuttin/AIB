'use strict';
const { APP: APP_DIR } = require('./_paths');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const dir = APP_DIR;

const caps = { folder: true, file: true, fileAtLine: true, workspace: true };
const folderOnly = { folder: true, file: false, fileAtLine: false, workspace: false };
const CODE = { id: 'code', name: 'VS Code', kind: 'editor', capabilities: caps };
const DEVIN = { id: 'devin', name: 'Devin', kind: 'editor', capabilities: folderOnly };
const EXPLORER = {
  id: 'explorer',
  name: 'File Explorer',
  kind: 'explorer',
  capabilities: { folder: true, file: true, fileAtLine: false, workspace: false },
};
const TERMINAL = { id: 'terminal', name: 'Windows Terminal', kind: 'terminal', capabilities: folderOnly };

function load(editorsReply) {
  const calls = [];
  const window = {};
  const context = vm.createContext({ window, console, Promise, setTimeout });
  vm.runInContext(fs.readFileSync(path.join(dir, 'editors-ui.js'), 'utf8'), context);
  const E = window.AgentEditors;
  const host = {
    get: async (p, params) => {
      calls.push(['get', p, params]);
      return params && params.project
        ? { workspaces: editorsReply.workspaces || [] }
        : { editors: editorsReply.editors, default: editorsReply.default };
    },
    post: async (p, body) => {
      calls.push(['post', p, body]);
      return { ok: true };
    },
    fail: (e) => calls.push(['fail', e.message]),
    cwd: () => 'C:\\proj',
  };
  return { E, host, calls, window };
}
const plain = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
const same = (a, b, m) => assert.deepStrictEqual(plain(a), plain(b), m);
const labels = (items) => items.map((i) => (i.sep ? '--' : i.label));

test('project menu: default editor first, others inline, Explorer and terminal last', () => {
  const { E } = load({});
  const items = E.projectItems({
    editors: [CODE, DEVIN, EXPLORER, TERMINAL],
    defaultId: 'devin',
    workspaces: [],
    useWorkspace: false,
  });
  same(labels(items), ['Open in Devin', 'Open in VS Code', '--', 'Show in Explorer', 'Open terminal here']);
});

test('project menu: a matching workspace adds workspace, folder-only and the remembered toggle', () => {
  const { E } = load({});
  const ws = [{ path: 'C:\\w\\app.code-workspace', name: 'app', others: 2 }];
  const items = E.projectItems({
    editors: [CODE, EXPLORER, TERMINAL],
    defaultId: 'code',
    workspaces: ws,
    useWorkspace: false,
  });
  same(labels(items), [
    'Open in VS Code',
    '--',
    'Open workspace app',
    'Open this folder only',
    'Always use workspace for this project',
    '--',
    'Show in Explorer',
    'Open terminal here',
  ]);
  assert.equal(items.find((i) => i.id === 'usews').checked, false);
  const on = E.projectItems({ editors: [CODE], defaultId: 'code', workspaces: ws, useWorkspace: true });
  assert.equal(on[0].label, 'Open in VS Code (workspace)');
  assert.equal(on.find((i) => i.id === 'usews').checked, true);
});

test('project menu: no workspace-capable editor means no workspace items; nothing found means no items', () => {
  const { E } = load({});
  const ws = [{ path: 'x.code-workspace', name: 'x', others: 0 }];
  same(labels(E.projectItems({ editors: [DEVIN], defaultId: 'devin', workspaces: ws })), ['Open in Devin']);
  same(E.projectItems({ editors: [], defaultId: '', workspaces: [] }), []);
  same(E.projectItems(null), []);
});

test('detected list and default come from the server; file editor falls back when the default is folder-only', async () => {
  const { E, host, calls } = load({ editors: [DEVIN, CODE, EXPLORER], default: 'devin' });
  assert.equal(E.loaded(), false);
  await E.init(host);
  assert.equal(E.default, 'devin');
  assert.equal(E.fileEditor().id, 'code');
  assert.equal(E.canOpenFile(), true);
  assert.equal(E.fileTip(7), 'Open in VS Code at line 7');
  assert.equal(E.fileTip(0), 'Open in VS Code');
  assert.equal(E.editorLabel(), 'Devin');
  same(
    E.list().map((e) => e.id),
    ['devin', 'code', 'explorer'],
  );
  assert.equal(await E.setDefault('explorer'), false, 'only editors can be the default');
  assert.equal(await E.setDefault('code'), true);
  assert.equal(E.default, 'code');
  same(
    calls.find((c) => c[0] === 'post'),
    ['post', 'settings', { editors: { default: 'code' } }],
  );
});

test('openFile sends the path, line and the chat folder; openProject honours the workspace preference', async () => {
  const { E, host, calls } = load({
    editors: [CODE, EXPLORER, TERMINAL],
    default: 'code',
    workspaces: [{ path: 'C:\\w\\a.code-workspace', name: 'a', others: 1 }],
  });
  await E.init(host);
  await E.openFile('src/a.py', 12);
  same(calls.at(-1), ['post', 'open', { editor: 'code', kind: 'file', path: 'src/a.py', line: 12, cwd: 'C:\\proj' }]);
  await E.openProject('C:\\proj', { useWorkspace: false });
  same(calls.at(-1), ['post', 'open', { editor: 'code', kind: 'folder', path: 'C:\\proj' }]);
  await E.openProject('C:\\proj', { useWorkspace: true });
  same(calls.at(-1), [
    'post',
    'open',
    { editor: 'code', kind: 'workspace', path: 'C:\\w\\a.code-workspace', cwd: 'C:\\proj' },
  ]);
  await E.showInExplorer('C:\\proj');
  assert.equal(calls.at(-1)[2].editor, 'explorer');
  await E.openTerminal('C:\\proj');
  assert.equal(calls.at(-1)[2].editor, 'terminal');
});

test('server errors reach the page error handler instead of throwing', async () => {
  const { E, host, calls } = load({ editors: [CODE], default: 'code' });
  host.post = async () => {
    throw new Error('That location is not inside a project folder');
  };
  await E.init(host);
  assert.equal(await E.openFolder('C:\\elsewhere'), null);
  same(calls.at(-1), ['fail', 'That location is not inside a project folder']);
});

test('runProjectItem maps menu ids to server calls and saves the toggle', async () => {
  const { E, host, calls } = load({
    editors: [CODE, DEVIN],
    default: 'code',
    workspaces: [{ path: 'C:\\w\\a.code-workspace', name: 'a', others: 1 }],
  });
  await E.init(host);
  await E.loadWorkspaces('C:\\proj');
  const items = E.projectItems(E.menuModelFor('C:\\proj', false));
  const saved = [];
  await E.runProjectItem(
    items.find((i) => i.id === 'workspace:0'),
    'C:\\proj',
    {},
  );
  same(calls.at(-1)[2], { editor: 'code', kind: 'workspace', path: 'C:\\w\\a.code-workspace', cwd: 'C:\\proj' });
  await E.runProjectItem(
    items.find((i) => i.id === 'folder'),
    'C:\\proj',
    {},
  );
  assert.equal(calls.at(-1)[2].kind, 'folder');
  await E.runProjectItem(
    items.find((i) => i.id === 'open:devin'),
    'C:\\proj',
    {},
  );
  assert.equal(calls.at(-1)[2].editor, 'devin');
  await E.runProjectItem(
    items.find((i) => i.id === 'usews'),
    'C:\\proj',
    { setPref: (p) => saved.push(p) },
  );
  same(saved, [{ useWorkspace: true }]);
});

test('chat menu: Open folder in <editor> only when an editor name and a folder exist', () => {
  const document = {
    getElementById: () => null,
    addEventListener() {},
    createElement: () => ({ setAttribute() {}, append() {}, dataset: {} }),
  };
  const window = { document };
  const context = vm.createContext({ window, document, console, Promise });
  vm.runInContext(fs.readFileSync(path.join(dir, 'organize-ui.js'), 'utf8'), context);
  const O = window.AgentOrganizeUI;
  O.init({
    aliasKey: (c) => c.provider + ':' + c.id,
    titleOf: (c) => c.title || 'x',
    getSelected: () => null,
    conversations: () => [],
    get: async () => ({}),
    post: async () => ({}),
  });
  const chat = { provider: 'claude', id: 's1', cwd: 'C:\\proj', title: 't' };
  const ids = (items) => items.filter((i) => !i.sep).map((i) => i.id);
  assert.ok(ids(O.menuModel(chat, { editor: 'VS Code' })).includes('editor'));
  assert.equal(O.menuModel(chat, { editor: 'VS Code' }).find((i) => i.id === 'editor').label, 'Open folder in VS Code');
  assert.ok(!ids(O.menuModel(chat, {})).includes('editor'));
  assert.ok(!ids(O.menuModel({ ...chat, cwd: '' }, { editor: 'VS Code' })).includes('editor'));
});

test('command bar: three project actions appear only when the page can run them', () => {
  const C = require(path.join(APP_DIR, 'commands-registry.js'));
  const d = { openProjectEditor() {}, showProjectExplorer() {}, openProjectTerminal() {} };
  const titles = (ctx) =>
    C.buildActions(ctx)
      .filter((a) => a.id.startsWith('project-'))
      .map((a) => a.title);
  same(titles({ chat: null, projects: [], do: d, editor: { name: 'Cursor', explorer: true, terminal: true } }), [
    'Open project in Cursor',
    'Show project in Explorer',
    'Open terminal in project',
  ]);
  same(titles({ chat: null, projects: [], do: d, editor: { name: 'Cursor', explorer: false, terminal: false } }), [
    'Open project in Cursor',
  ]);
  same(titles({ chat: null, projects: [], do: {}, editor: { name: 'Cursor', explorer: true, terminal: true } }), []);
  same(titles({ chat: null, projects: [], do: d, editor: null }), []);
});

test('tool rows: file target comes from ACP locations, the call path or a diff item; no path means no button', () => {
  const window = {};
  class N {
    constructor() {
      this.children = [];
      this.attrs = {};
      this.dataset = {};
      this.className = '';
    }
    append(...n) {
      this.children.push(...n);
    }
    setAttribute(k, v) {
      this.attrs[k] = v;
    }
    addEventListener() {}
    get classList() {
      return { add() {} };
    }
    set textContent(v) {
      this._t = v;
    }
  }
  const context = vm.createContext({ window, document: { createElement: () => new N() }, URL, console });
  vm.runInContext(fs.readFileSync(path.join(dir, 'tool-views.js'), 'utf8'), context);
  const T = window.ToolViews;
  same(T.fileTarget({ raw: { kind: 'edit', locations: [{ path: 'C:\\p\\a.py', line: 40 }] } }), {
    path: 'C:\\p\\a.py',
    line: 40,
  });
  same(
    T.fileTarget({
      raw: {
        kind: 'edit',
        rawInput: { file_path: 'C:\\p\\b.py', old_string: 'a', new_string: 'b' },
        _meta: { claudeCode: { toolName: 'Edit' } },
      },
    }),
    { path: 'C:\\p\\b.py', line: null },
  );
  same(
    T.fileTarget({
      raw: { kind: 'edit', content: [{ type: 'diff', path: 'C:\\p\\c.py', oldText: '', newText: 'x' }] },
    }),
    { path: 'C:\\p\\c.py', line: null },
  );
  same(T.fileTarget({ call: { name: 'Write', input: { file_path: 'file:///C:/p/d.txt', content: 'x' } } }), {
    path: 'C:/p/d.txt',
    line: null,
  });
  same(T.fileTarget({ call: { name: 'Read', input: { file_path: 'C:\\p\\e.py', offset: 30 } } }), {
    path: 'C:\\p\\e.py',
    line: 30,
  });
  assert.equal(T.fileTarget({ call: { name: 'Bash', input: { command: 'ls' } } }), null);
  assert.equal(T.fileTarget({ raw: { kind: 'execute', title: 'ls' } }), null);
  assert.equal(T.fileTarget({ call: { name: 'Grep', input: { pattern: 'x', path: 'C:\\p' } } }), null);
});
