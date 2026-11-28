'use strict';
// A new chat starts in the folder of the project the window shows, and names that project to the server. A window whose project
// folder is not loaded yet waits and, if it never loads, refuses (owner bug 2026-11-28: the chat started in the folder another
// window had left in the shared folder box, C:\REPOS\braveTV, instead of the new project "Act").
const test = require('node:test');
const assert = require('node:assert/strict');
const { makePage } = require('./chat_harness.js');

const conn = { id: 'conn-1', provider: 'kimi', sessionId: 'session_x', cwd: 'C:/p', closed: false };

function projectWindow({ key, project, waitMs = 300 }) {
  const connects = [],
    state = { project };
  const page = makePage({
    window: {
      __aibTestFolderWaitMs: waitMs,
      AgentWorkspaceUI: {
        init() {},
        activeProject: () => state.project,
        activeProjectRef: () => ({ key, path: (state.project && state.project.path) || '' }),
      },
    },
    local: { 'studio-cwd': 'C:\\REPOS\\braveTV' }, // what another window left in the shared folder box
    routes: {
      '/api/live/connect': (_q, body) => {
        connects.push(body);
        return { body: { id: 'conn-1' } };
      },
      '/api/live/state': () => ({ body: { id: 'conn-1', ready: true, closed: false, pickResults: [] } }),
      '/api/live/list': () => ({ body: { connections: [conn], recovered: [], instanceId: 'A' } }),
      '/api/sessions': () => ({ body: { sessions: [] } }),
      '/api/live/prompt': () => ({ body: { accepted: true } }),
    },
  });
  page.run("newDraft = { provider: 'kimi', cwd: '', picked: true, model: '', mode: '', effort: '' }");
  page.element('cwd').value = 'C:\\REPOS\\braveTV';
  page.element('setup').hidden = true;
  page.element('prompt').value = 'check the files I just added';
  return { page, connects, state };
}

test('a new chat in a known project connects in that project and names it', async () => {
  const { page, connects } = projectWindow({
    key: 'w:c:/repos/act',
    project: { key: 'w:c:/repos/act', name: 'Act', path: 'C:\\REPOS\\Act' },
  });
  await page.run('startNewChat()');
  assert.equal(connects.length, 1);
  assert.equal(connects[0].cwd, 'C:\\REPOS\\Act');
  assert.equal(connects[0].project, 'w:c:/repos/act');
});

test('a WSL project: the chat connects in its wsl:// folder and names its key', async () => {
  const { page, connects } = projectWindow({
    key: 'p:wsl:/Ubuntu/home/me/act',
    project: { key: 'p:wsl:/Ubuntu/home/me/act', name: 'act', path: 'wsl://Ubuntu/home/me/act' },
  });
  await page.run('startNewChat()');
  assert.equal(connects[0].cwd, 'wsl://Ubuntu/home/me/act');
  assert.equal(connects[0].project, 'p:wsl:/Ubuntu/home/me/act');
});

test('a window whose project folder is not known never starts a chat in the shared folder box; the text is kept', async () => {
  const { page, connects } = projectWindow({ key: 'w:c:/repos/act', project: null });
  await page.run('startNewChat()');
  assert.equal(connects.length, 0, 'nothing was started (it used to start in C:\\REPOS\\braveTV)');
  assert.match(page.element('error').textContent, /not loaded yet/);
  assert.equal(page.element('prompt').value, 'check the files I just added');
});

test('the send waits for the project folder to load, then starts there', async () => {
  const { page, connects, state } = projectWindow({ key: 'w:c:/repos/act', project: null, waitMs: 5000 });
  const sending = page.run('startNewChat()');
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(connects.length, 0, 'still waiting');
  state.project = { key: 'w:c:/repos/act', name: 'Act', path: 'C:\\REPOS\\Act' };
  await sending;
  assert.equal(connects.length, 1);
  assert.equal(connects[0].cwd, 'C:\\REPOS\\Act');
});

test('a window with no project ("add project") still uses the typed folder and names no project', async () => {
  const connects = [];
  const page = makePage({
    window: { AgentWorkspaceUI: { init() {}, activeProject: () => null, activeProjectRef: () => null } },
    routes: {
      '/api/live/connect': (_q, body) => (connects.push(body), { body: { id: 'conn-1' } }),
      '/api/live/state': () => ({ body: { id: 'conn-1', ready: true, closed: false, pickResults: [] } }),
      '/api/live/list': () => ({ body: { connections: [conn], recovered: [], instanceId: 'A' } }),
      '/api/sessions': () => ({ body: { sessions: [] } }),
      '/api/live/prompt': () => ({ body: { accepted: true } }),
    },
  });
  page.run("newDraft = { provider: 'kimi', cwd: '', picked: true, model: '', mode: '', effort: '' }");
  page.element('cwd').value = 'D:\\typed';
  page.element('prompt').value = 'hi';
  await page.run('startNewChat()');
  assert.equal(connects[0].cwd, 'D:\\typed');
  assert.equal(connects[0].project, undefined);
});
