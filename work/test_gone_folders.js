'use strict';
/* A project whose folder no longer exists is not listed (and neither are its chats); nothing is hidden, removed or deleted, so it is
   listed again by itself when the folder is back. Real temp folders; the "server" answer comes from the disk, like the real route. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makePage } = require('./chat_harness.js');

const session = (id, cwd, over = {}) => ({
  key: 'omp/p/' + id + '.jsonl',
  provider: 'omp',
  id,
  cwd,
  title: 'Chat ' + id,
  hasMessages: true,
  created: 1,
  modified: 1,
  subagentCount: 0,
  ...over,
});

/* the page re-asks about a folder after GONE_RECHECK: age the answers instead of waiting, then poll (the re-ask lands for the next poll) */
async function recheck(t) {
  for (const v of t.page.hook.folderGone.values()) v.at = 0;
  await t.page.hook.listConversations();
  await new Promise((r) => setTimeout(r, 20));
  await t.page.hook.listConversations();
}

function setup(sessions, connections = []) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aib-gone-'));
  const asked = [];
  const page = makePage({
    scripts: ['status-words.js', 'sidebar-ui.js'],
    routes: {
      '/api/sessions': () => ({ body: { sessions: typeof sessions === 'function' ? sessions(base) : sessions } }),
      '/api/live/list': () => ({ body: { connections, recovered: [], instanceId: 'A' } }),
      '/api/live/folders/gone': (q) => {
        const paths = JSON.parse(q.paths);
        asked.push(paths);
        return { body: { gone: paths.filter((p) => !fs.existsSync(p)) } };
      },
    },
  });
  return { base, page, asked, ids: () => Array.from(page.state.conversations, (c) => c.id) };
}

test('a chat in a missing folder is not listed, and comes back when the folder is created', async () => {
  const t = setup((b) => [session('a', path.join(b, 'here')), session('b', path.join(b, 'gone'))]);
  fs.mkdirSync(path.join(t.base, 'here'));
  await t.page.hook.refreshToken();
  await t.page.hook.listConversations();
  assert.deepEqual(t.ids(), ['a']);
  fs.mkdirSync(path.join(t.base, 'gone'));
  await recheck(t);
  assert.deepEqual(t.ids().sort(), ['a', 'b']);
  fs.rmSync(t.base, { recursive: true });
});

test('dropping a gone project writes nothing: no removed or hidden list is called, the folder and history stay', async () => {
  const t = setup((b) => [session('b', path.join(b, 'gone'))]);
  await t.page.hook.refreshToken();
  await t.page.hook.listConversations();
  assert.deepEqual(t.ids(), []);
  const writes = t.page.calls.filter((c) => (c.options.method || 'GET') !== 'GET');
  assert.deepEqual(writes, []);
  assert.ok(!t.page.calls.some((c) => /project-remove|project-prefs|conversation-state/.test(c.url)));
  assert.equal(t.page.context.localStorage.getItem('studio-project-prefs-v1'), null);
  assert.deepEqual(fs.readdirSync(t.base), []); // nothing was created or deleted in the temp area
  fs.rmSync(t.base, { recursive: true });
});

test('the chat that is open stays until you switch away', async () => {
  const t = setup((b) => [session('open', path.join(b, 'gone')), session('other', path.join(b, 'gone'))]);
  await t.page.hook.refreshToken();
  await t.page.hook.listConversations(); // nothing open yet: both dropped
  assert.deepEqual(t.ids(), []);
  fs.mkdirSync(path.join(t.base, 'gone'));
  await recheck(t);
  assert.deepEqual(t.ids().sort(), ['open', 'other']);
  t.page.run("selected=conversations.find((c)=>c.id==='open')");
  fs.rmdirSync(path.join(t.base, 'gone')); // the folder of the open chat is deleted
  await recheck(t);
  assert.deepEqual(t.ids(), ['open'], 'the open chat stays, its sibling goes');
  t.page.run('selected=null');
  await t.page.hook.listConversations();
  assert.deepEqual(t.ids(), [], 'after switching away it goes too');
  fs.rmSync(t.base, { recursive: true });
});

test('a worktree chat whose worktree folder is gone stays in its existing main project', async () => {
  const t = setup((b) => [
    session('wt', path.join(b, 'main-wt-gone'), { projectRoot: path.join(b, 'main') }),
    session('lost', path.join(b, 'lost-wt'), { projectRoot: path.join(b, 'lost-main') }),
  ]);
  fs.mkdirSync(path.join(t.base, 'main'));
  await t.page.hook.refreshToken();
  await t.page.hook.listConversations();
  assert.deepEqual(t.ids(), ['wt']);
  fs.rmSync(t.base, { recursive: true });
});

test('folders are asked about once, then only after the recheck time; a chat waiting on you is not dropped', async () => {
  const t = setup(
    (b) => [session('a', path.join(b, 'gone')), session('q', path.join(b, 'gone2'))],
    [{ id: 'c1', provider: 'omp', sessionId: 'q', closed: false, elicitations: [{ id: 1 }] }],
  );
  await t.page.hook.refreshToken();
  await t.page.hook.listConversations();
  const first = t.asked.length;
  assert.equal(first, 1);
  await t.page.hook.listConversations();
  await t.page.hook.listConversations();
  assert.equal(t.asked.length, first, 'polls inside the recheck time ask nothing');
  assert.deepEqual(t.ids(), ['q']);
  fs.rmSync(t.base, { recursive: true });
});
