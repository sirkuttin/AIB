'use strict';
// The "New project" dialog in the fake DOM: Folder + Project name are checked together, the live preview line says what Create
// does, and Create sends the folder and the name to the server (which makes the folder). The server is a fake that answers like
// GET /api/live/folders/check?path=&name= and POST folders/create.
const test = require('node:test');
const assert = require('node:assert/strict');
const { page, load } = require('./fake_dom.js');

const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
};

// answers: (path, name) => check payload. created: what POST folders/create returns.
function harness(answers, { projects = [], created = null } = {}) {
  const shell = page();
  const ctx = load(shell, ['notify-rules.js', 'workspace-state.js', 'new-project-ui.js']);
  const calls = { checks: [], posts: [], done: [] };
  ctx.AgentNewProjectUI.init({
    getJson: (path, params) => {
      if (path === '/api/live/folders/start')
        return Promise.resolve({ start: 'C:\\REPOS', home: 'C:\\Users\\me', source: 'last' });
      calls.checks.push(JSON.parse(JSON.stringify(params))); // plain objects: the page runs in its own vm realm
      return Promise.resolve(answers(params.path, params.name));
    },
    postJson: (name, body) => {
      calls.posts.push([name, JSON.parse(JSON.stringify(body))]);
      if (name === 'folders/create')
        return Promise.resolve(
          created || { path: body.name ? body.path + '\\' + body.name : body.path, git: !!body.gitInit },
        );
      if (name === 'folders/pick') return Promise.resolve({ path: 'C:\\REPOS\\' }); // the picker chose the same folder
      return Promise.resolve({ ok: true });
    },
    projects: () => projects,
    keyOf: (p) => String(p).toLowerCase(),
    done: (r) => calls.done.push(JSON.parse(JSON.stringify(r))),
  });
  return { shell, ctx, calls, ui: () => ctx.AgentNewProjectUI._ui() };
}

async function openDialog(h) {
  h.ctx.AgentNewProjectUI.open(null);
  await settle();
  return h.ui();
}

// Type into a box the way the page sees it: value, input event, then the debounce timer fires.
async function type(h, box, value) {
  box.value = value;
  box.dispatch('input');
  h.shell.window.runTimers();
  await settle();
}

const REPOS = 'C:\\REPOS';
// A server that knows C:\REPOS exists and C:\REPOS\old exists inside it.
function server(path, name) {
  const folder = String(path)
    .replace(/[\\/]+$/, '')
    .replace(/^c:/, 'C:');
  const n = String(name || '').trim();
  if (!n) return { valid: true, exists: true, isDir: true, path: folder, reason: 'existing', gitAvailable: true };
  if (n.toUpperCase() === 'CON')
    return { valid: false, reason: 'invalid_name', field: 'name', folder, message: '"CON" is a reserved Windows name' };
  const target = folder + '\\' + n;
  return {
    valid: true,
    exists: n === 'old',
    isDir: n === 'old',
    path: target,
    folder,
    reason: n === 'old' ? 'existing' : 'new',
    gitAvailable: true,
  };
}

test('the dialog has the new Project name note and an empty preview line before anything is checked', async () => {
  const h = harness(server);
  const s = await openDialog(h);
  const note = s.dialog.querySelector('.np-note');
  assert.equal(
    note.textContent,
    'A folder with this name is made inside Folder, or used if it is already there. Leave empty to use Folder itself.',
  );
  assert.equal(s.name.getAttribute('aria-describedby'), 'npNameNote npPreview');
  const preview = s.dialog.querySelector('.np-preview');
  assert.ok(preview, 'the preview line is drawn');
  assert.equal(preview.getAttribute('aria-live'), 'polite');
  const order = s.dialog.querySelector('form').children.map((n) => n.id || n.className);
  assert.ok(order.indexOf('npPreview') > order.indexOf('npName'), 'the preview sits under the name box');
});

test("the owner's case: c:\\REPOS\\ + spaghetti says it creates C:\\REPOS\\spaghetti and Create is enabled", async () => {
  const h = harness(server);
  const s = await openDialog(h);
  await type(h, s.folder, 'c:\\REPOS\\');
  await type(h, s.name, 'spaghetti');
  const last = h.calls.checks[h.calls.checks.length - 1];
  assert.deepEqual(last, { path: 'c:\\REPOS\\', name: 'spaghetti' }, 'the name goes to the server check');
  assert.equal(s.preview.textContent, 'Creates C:\\REPOS\\spaghetti');
  assert.equal(s.preview.className, 'np-preview ok');
  assert.equal(s.hint.textContent, 'Folder found');
  assert.equal(s.primary.disabled, false);
  assert.equal(s.primary.textContent, 'Create project');
  assert.equal(s.gitRow.hidden, false, 'git is offered for the new folder');

  s.dialog.querySelector('form').dispatch('submit');
  await settle();
  assert.deepEqual(h.calls.posts, [['folders/create', { path: REPOS, name: 'spaghetti', gitInit: true }]]);
  assert.equal(h.calls.done.length, 1);
  assert.deepEqual(
    [h.calls.done[0].path, h.calls.done[0].name, h.calls.done[0].created],
    ['C:\\REPOS\\spaghetti', '', true],
    'the display name is the folder name, which is the given name',
  );
  assert.equal(h.ctx.AgentNewProjectUI.isOpen(), false);
});

test('a subfolder that is already there is used: "Uses … (already there)", Open project, nothing created', async () => {
  const h = harness(server);
  const s = await openDialog(h);
  await type(h, s.folder, 'C:\\REPOS');
  await type(h, s.name, 'old');
  assert.equal(s.preview.textContent, 'Uses C:\\REPOS\\old (already there)');
  assert.equal(s.primary.textContent, 'Open project');
  assert.equal(s.gitRow.hidden, true);
  s.dialog.querySelector('form').dispatch('submit');
  await settle();
  assert.deepEqual(h.calls.posts, [['folders/remember', { path: 'C:\\REPOS\\old' }]]);
  assert.deepEqual([h.calls.done[0].path, h.calls.done[0].created], ['C:\\REPOS\\old', false]);
});

test('an existing folder with no name is the project itself, as before', async () => {
  const h = harness(server);
  const s = await openDialog(h);
  await type(h, s.folder, 'C:\\REPOS\\');
  assert.equal(s.hint.textContent, 'Existing folder');
  assert.equal(s.preview.textContent, 'Uses C:\\REPOS (already there)');
  assert.equal(s.primary.disabled, false);
});

test('a folder that is already a project says Opens … (already a project)', async () => {
  const h = harness(server, { projects: [{ key: 'c:\\repos\\old', path: 'C:\\REPOS\\old' }] });
  const s = await openDialog(h);
  await type(h, s.folder, 'C:\\REPOS');
  await type(h, s.name, 'old');
  assert.equal(s.preview.textContent, 'Opens C:\\REPOS\\old (already a project)');
});

test('a bad name is shown in red on the preview line and keeps Create disabled', async () => {
  const h = harness(server);
  const s = await openDialog(h);
  await type(h, s.folder, 'C:\\REPOS');
  await type(h, s.name, 'CON');
  assert.equal(s.preview.textContent, '"CON" is a reserved Windows name');
  assert.equal(s.preview.className, 'np-preview error');
  assert.equal(s.name.getAttribute('aria-invalid'), 'true');
  assert.equal(s.folder.getAttribute('aria-invalid'), 'false');
  assert.equal(s.primary.disabled, true);
});

test('while a name change is being checked the preview is blank and Create waits', async () => {
  const h = harness(server);
  const s = await openDialog(h);
  await type(h, s.folder, 'C:\\REPOS');
  s.name.value = 'new-one';
  s.name.dispatch('input');
  assert.equal(s.preview.textContent, '', 'no stale preview');
  assert.equal(s.primary.disabled, true);
  h.shell.window.runTimers();
  await settle();
  assert.equal(s.preview.textContent, 'Creates C:\\REPOS\\new-one');
  assert.equal(s.primary.disabled, false);
});

test('a named folder that appeared between the check and Create is used, not reported as created', async () => {
  const h = harness(server, { created: { path: 'C:\\REPOS\\racy', git: false, existed: true } });
  const s = await openDialog(h);
  await type(h, s.folder, 'C:\\REPOS');
  await type(h, s.name, 'racy');
  s.git.checked = false;
  s.dialog.querySelector('form').dispatch('submit');
  await settle();
  assert.deepEqual(h.calls.posts, [['folders/create', { path: REPOS, name: 'racy', gitInit: false }]]);
  assert.deepEqual([h.calls.done[0].path, h.calls.done[0].created], ['C:\\REPOS\\racy', false]);
});

test('no name and a new folder still creates the folder itself, without a name in the request', async () => {
  const h = harness((path) => ({
    valid: true,
    exists: false,
    path: 'C:\\REPOS\\fresh',
    reason: 'new',
    gitAvailable: true,
  }));
  const s = await openDialog(h);
  await type(h, s.folder, 'C:\\REPOS\\fresh');
  assert.equal(s.hint.textContent, 'New folder');
  assert.equal(s.preview.textContent, 'Creates C:\\REPOS\\fresh');
  s.dialog.querySelector('form').dispatch('submit');
  await settle();
  assert.deepEqual(h.calls.posts, [['folders/create', { path: 'C:\\REPOS\\fresh', gitInit: true }]]);
  assert.equal(h.calls.done[0].created, true);
});

// The dialog opens on the remembered folder plus a trailing separator (C:\REPOS\). With Name empty, Enter must not make C:\REPOS a
// project by accident: Create waits until a name is typed, Folder is edited, or Browse is used.
test('the untouched prefilled folder with an empty name keeps Create disabled and asks for a name', async () => {
  const h = harness(server);
  const s = await openDialog(h);
  assert.equal(s.folder.value, 'C:\\REPOS\\', 'prefilled with the remembered folder and a trailing separator');
  assert.equal(s.preview.textContent, 'Type a project name, or pick a folder');
  assert.equal(s.preview.className, 'np-preview hint');
  assert.equal(s.primary.disabled, true);
  assert.equal(s.gitRow.hidden, true);
  s.dialog.querySelector('form').dispatch('submit');
  await settle();
  assert.deepEqual(h.calls.posts, [], 'Enter does nothing');
  assert.deepEqual(h.calls.done, []);

  await type(h, s.name, 'spaghetti');
  assert.equal(s.preview.textContent, 'Creates C:\\REPOS\\spaghetti');
  assert.equal(s.primary.disabled, false);
  await type(h, s.name, '  ');
  assert.equal(
    s.preview.textContent,
    'Type a project name, or pick a folder',
    'clearing the name brings the guard back',
  );
  assert.equal(s.primary.disabled, true);
});

test('editing the prefilled folder ends the guard, even when typed back to the same text', async () => {
  const h = harness(server);
  const s = await openDialog(h);
  await type(h, s.folder, 'C:\\REPOS');
  assert.equal(s.preview.textContent, 'Uses C:\\REPOS (already there)');
  assert.equal(s.primary.disabled, false);
  await type(h, s.folder, 'C:\\REPOS\\');
  assert.equal(s.preview.textContent, 'Uses C:\\REPOS (already there)');
  assert.equal(s.primary.disabled, false);
});

test('Browse ends the guard: an empty name then means "use this folder"', async () => {
  const h = harness(server);
  const s = await openDialog(h);
  assert.equal(s.primary.disabled, true);
  s.browse.click();
  await settle();
  assert.equal(s.folder.value, 'C:\\REPOS');
  assert.equal(s.preview.textContent, 'Uses C:\\REPOS (already there)');
  assert.equal(s.primary.disabled, false);
});
