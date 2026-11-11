'use strict';
/* Condensed views, stage 4: the Prompts view. Only your prompts, each an accordion holding every reply up to your next prompt;
   open state keyed by prompt; a working label on the newest prompt; an error badge; attachment chips; a find box that searches the
   whole saved transcript (the server endpoint) and loads an older page on a click. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { makePage, byClass, flat } = require('./chat_harness.js');
const fakeDom = require('./fake_dom.js');

const SCRIPTS = ['stream-ui.js', 'tool-views.js', 'plan-ui.js', 'views.js', 'views-ui.js'];
const user = (value, time, extra) => ({ role: 'user', label: 'You', value, time, ...extra });
const asst = (value, time) => ({ role: 'assistant', label: 'Assistant', value, time });
const tool = (name, time) => ({
  role: 'tool',
  label: name,
  value: '{}',
  time,
  call: { name, input: { command: 'ls -la' } },
});
const history = (n) => {
  const rows = [];
  for (let i = 0; i < n; i++)
    rows.push(
      user('question ' + i, '2026-01-01T10:0' + i + ':00Z'),
      asst('interim ' + i, '2026-01-01T10:0' + i + ':10Z'),
      tool('Bash', '2026-01-01T10:0' + i + ':20Z'),
      asst('answer ' + i, '2026-01-01T10:0' + i + ':30Z'),
    );
  return rows;
};

function promptsPage() {
  const page = makePage({ scripts: SCRIPTS });
  page.run("selected={provider:'claude',id:'a',key:'a'}");
  page.hook.setView('prompts');
  const box = page.element('messages');
  return {
    page,
    box,
    items: () => byClass(box, 'pv-item'),
    arrows: () => byClass(box, 'pv-arrow').map((a) => a.textContent),
  };
}

/* ---- the shared isPrompt fixtures: the same file the Python test runs against prompts.is_prompt ---- */
test('isPrompt agrees with the shared fixtures (work/prompt_fixtures.json, also run by test_prompts.py)', () => {
  const { ChatViews } = makePage({ scripts: SCRIPTS }).context.window;
  const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'prompt_fixtures.json'), 'utf8'));
  assert.ok(fixtures.length >= 30);
  for (const c of fixtures) {
    const text = c.fill ? c.fill[0] + c.fill[1].repeat(c.fill[2]) + c.fill[3] : c.text;
    const row = {
      role: c.role,
      value: text,
      attachments: Array.from({ length: c.files }, (_, i) => ({ type: 'transcript-image', i })),
    };
    assert.equal(ChatViews.isPrompt(row), c.prompt, c.name);
  }
});

test('Prompts shows only prompts, each closed with its reply count and time; opening one shows every reply, tool rows included', () => {
  const t = promptsPage();
  t.page.hook.showRows(t.box, history(3), 'main');
  assert.equal(t.items().length, 3);
  assert.doesNotMatch(flat(t.box), /answer|interim/, 'no replies while closed');
  assert.deepEqual(t.arrows(), ['▸', '▸', '▸']);
  const head = byClass(t.items()[1], 'pv-head')[0];
  assert.match(flat(head), /question 1/);
  assert.match(byClass(head, 'pv-meta')[0].textContent, /^2 replies · /, 'assistant messages, then the time');
  assert.equal(byClass(head, 'pv-text').length, 1, 'one line, ellipsis by CSS');
  head.listeners.click();
  assert.deepEqual(t.arrows(), ['▸', '▾', '▸']);
  const body = byClass(t.items()[1], 'pv-body')[0];
  assert.equal(body.hidden, false);
  assert.match(flat(body), /interim 1/);
  assert.match(flat(body), /answer 1/);
  assert.match(flat(body), /ls -la/, 'the tool row is drawn as Full draws it');
  assert.doesNotMatch(flat(body), /answer 2|answer 0/, 'only the replies up to the next prompt');
  assert.equal(byClass(t.items()[0], 'pv-body')[0].children.length, 0, 'a closed prompt draws nothing');
  head.listeners.click();
  assert.deepEqual(t.arrows(), ['▸', '▸', '▸']);
  assert.equal(byClass(t.items()[1], 'pv-body')[0].hidden, true);
  assert.equal(byClass(t.items()[2], 'pv-meta')[0].textContent.startsWith('2 replies'), true);
  /* "1 reply" */
  t.page.hook.showRows(t.box, [user('solo', 1), asst('one', 2)], 'main');
  assert.match(byClass(t.box, 'pv-meta')[0].textContent, /^1 reply · /);
});

test('the accordion stays open when a new turn arrives or older prompts appear (keyed by prompt, not position)', () => {
  const t = promptsPage();
  t.page.hook.showRows(t.box, history(2), 'main');
  byClass(t.items()[1], 'pv-head')[0].listeners.click();
  assert.deepEqual(t.arrows(), ['▸', '▾']);
  t.page.hook.showRows(t.box, [...history(2), user('question 2', 99), asst('answer 2', 100)], 'main');
  assert.deepEqual(t.arrows(), ['▸', '▾', '▸'], 'a new turn: the same prompt is still open');
  assert.match(flat(t.items()[1]), /answer 1/, 'with its replies drawn again');
  t.page.hook.showRows(
    t.box,
    [
      user('older', '2026-01-01T09:00:00Z'),
      asst('older reply', 0.7),
      ...history(2),
      user('question 2', 99),
      asst('answer 2', 100),
    ],
    'main',
  );
  assert.deepEqual(
    t.arrows(),
    ['▸', '▸', '▾', '▸'],
    'older prompts shift the positions; the key still finds its prompt',
  );
});

test('while the chat works the newest prompt shows a spinner and "working · time", its arrow stays closed and it is never auto-opened', () => {
  const t = promptsPage();
  const rows = [
    ...history(2),
    user('and restart Studio', '2026-01-01T21:41:00Z'),
    tool('Bash', '2026-01-01T21:41:05Z'),
  ];
  t.page.hook.showRows(t.box, rows, 'main', { working: true });
  const last = t.items()[2];
  const meta = byClass(last, 'pv-meta')[0];
  assert.match(meta.className, /pv-working/);
  assert.match(flat(meta), /^working · /);
  assert.equal(byClass(meta, 'plan-spin').length, 1, 'a small spinner');
  assert.deepEqual(t.arrows(), ['▸', '▸', '▸']);
  assert.equal(byClass(last, 'pv-body')[0].hidden, true);
  assert.equal(byClass(t.box, 'view-live').length, 0, 'no live line in Prompts');
  assert.doesNotMatch(byClass(t.items()[0], 'pv-meta')[0].className, /pv-working/, 'only the newest prompt');
  /* a poll while it works, and a reply arriving: still closed; then the label goes when the turn ends */
  t.page.hook.showRows(t.box, [...rows, asst('Restarted.', '2026-01-01T21:41:30Z')], 'main', { working: true });
  assert.deepEqual(t.arrows(), ['▸', '▸', '▸']);
  t.page.hook.showRows(t.box, [...rows, asst('Restarted.', '2026-01-01T21:41:30Z')], 'main', { working: false });
  assert.match(byClass(t.items()[2], 'pv-meta')[0].textContent, /^1 reply · /);
  assert.deepEqual(t.arrows(), ['▸', '▸', '▸']);
});

test('an error in the hidden replies puts a small error badge on the header', () => {
  const t = promptsPage();
  const rows = [
    user('first', 1),
    asst('fine', 2),
    user('second', 3),
    {
      role: 'tool',
      label: 'Bash',
      value: '{}',
      time: 4,
      call: { name: 'Bash', input: {}, result: { text: 'boom', isError: true } },
    },
    user('third', 5),
    { role: 'error', label: 'Error', value: 'agent failed', time: 6 },
    user('fourth', 7),
    { role: 'notice', label: 'Disconnected', value: 'lost', time: 8 },
    user('fifth', 9),
    asst('ok', 10),
    user('sixth', 11),
    {
      role: 'tool',
      label: 'Bash',
      value: '{}',
      time: 12,
      call: { name: 'Bash', input: {}, result: { text: 'boom', isError: true } },
    },
    asst('That failed, so I used another way: done.', 13),
  ];
  t.page.hook.showRows(t.box, rows, 'main');
  assert.deepEqual(
    t.items().map((i) => byClass(i, 'pv-err').length),
    [0, 1, 1, 1, 0, 0], // sixth: a step failed mid-turn, the turn went on and succeeded: no error badge
  );
  assert.equal(byClass(t.items()[1], 'pv-err')[0].textContent, 'error');
});

test('attachment chips show on the prompt', () => {
  const t = promptsPage();
  const files = [
    { type: 'resource_link', name: 'report.pdf', uri: 'file:///x/report.pdf' },
    { type: 'image', mimeType: 'image/png' },
    { type: 'resource_link', uri: 'file:///x/notes.txt' },
    { type: 'resource_link', name: 'four.txt', uri: 'file:///x/four.txt' },
  ];
  t.page.hook.showRows(
    t.box,
    [user('see these', 1, { attachments: files }), asst('seen', 2), user('plain', 3)],
    'main',
  );
  assert.deepEqual(
    byClass(t.items()[0], 'pv-chip').map((c) => c.textContent),
    ['report.pdf', 'image', 'notes.txt', '+1'],
  );
  assert.equal(byClass(t.items()[1], 'pv-chip').length, 0);
});

test('each header is a real button with aria-expanded and aria-controls', () => {
  const shell = fakeDom.page();
  const context = fakeDom.load(shell, SCRIPTS);
  const { ChatViews, ChatViewsUI } = context;
  const rows = history(2);
  const proj = ChatViews.project(rows, 'prompts', {});
  const ctx = {
    bubble: (row) => {
      const d = shell.document.createElement('div');
      d.textContent = String(row.value);
      return d;
    },
    groupRows: (list, render) => list.map(render),
  };
  const nodes = ChatViewsUI.promptNodes(proj, 0, ctx);
  assert.equal(nodes.length, 2);
  const head = nodes[0].children[0],
    body = nodes[0].children[1];
  assert.equal(head.tagName, 'BUTTON');
  assert.equal(head.getAttribute('type') || head.type, 'button');
  assert.equal(head.getAttribute('aria-expanded'), 'false');
  assert.equal(head.getAttribute('aria-controls'), body.id);
  assert.ok(body.id);
  head.click();
  assert.equal(head.getAttribute('aria-expanded'), 'true');
  assert.equal(body.hidden, false);
  head.click();
  assert.equal(head.getAttribute('aria-expanded'), 'false');
  assert.equal(body.hidden, true);
});

/* ---- the find box and its endpoint ---- */
function transcriptPage() {
  const all = [];
  const stamp = (n) =>
    '2026-01-01T00:' + String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0') + 'Z';
  for (let n = 0; n < 100; n++) {
    const text =
      n === 5 ? 'find the needle in the haystack' : n === 95 ? 'needle again' : 'question ' + n + ' about widgets';
    all.push(
      { kind: 'user', label: 'User', text, time: stamp(n) },
      { kind: 'assistant', label: 'Assistant', text: 'answer ' + n, time: stamp(n) },
      { kind: 'tool', label: 'Bash', text: JSON.stringify({ command: 'ls' }), callId: 'c' + n, time: stamp(n) },
    );
  }
  const reads = [];
  const routes = {
    '/api/transcript': (q) => {
      reads.push(q);
      const limit = Number(q.limit) || 120;
      let start, end;
      if (q.after !== undefined && q.after !== '') {
        start = Number(q.after);
        end = Math.min(all.length, start + limit);
      } else {
        end = q.before !== undefined ? Number(q.before) : all.length;
        start = Math.max(0, end - limit);
      }
      return {
        body: {
          events: all.slice(start, end),
          total: all.length,
          before: start,
          end,
          context: [],
          revision: [],
          meta: {},
        },
      };
    },
    '/api/live/prompts': (q) => {
      const hits = all
        .map((e, index) => ({ e, index }))
        .filter(({ e }) => e.kind === 'user')
        .map(({ e, index }) => ({ index, time: e.time, text: e.text, files: 0 }));
      const found = hits.filter((h) => h.text.toLowerCase().includes(String(q.q).toLowerCase()));
      return { body: { prompts: found, total: hits.length, matched: found.length } };
    },
  };
  const page = makePage({ scripts: SCRIPTS, routes });
  page.run("selected={provider:'claude',id:'x',key:'claude/x.jsonl'};current=''");
  page.hook.setView('prompts');
  return { page, all, reads, box: page.element('messages') };
}

test('find searches the whole transcript through the endpoint; a hit on an older page is a closed header that loads it on a click', async () => {
  const t = transcriptPage();
  const key = 'claude/x.jsonl';
  await t.page.hook.pollHistory(key);
  const w = t.page.state.historyWindows.get(key);
  assert.equal(w.start, 180, 'only the newest page is loaded');
  t.page.hook.repaintMain();
  assert.equal(byClass(t.box, 'pv-item').length, 40, 'the newest prompts of the page, windowed');
  /* typing filters the loaded prompts at once, and the server is asked for the whole transcript */
  t.page.hook.setFindQuery('needle');
  clearTimeout(t.page.hook.promptFind.timer);
  assert.equal(byClass(t.box, 'pv-item').length, 1, 'the loaded prompt that matches');
  assert.equal(byClass(t.box, 'pv-stub').length, 0, 'the server has not answered yet');
  await t.page.hook.runFind('needle');
  const asked = t.page.calls.filter((c) => c.url === '/api/live/prompts');
  assert.equal(asked.length, 1);
  assert.deepEqual({ ...asked[0].query }, { key, q: 'needle', thinking: '0', limit: '200' });
  const stubs = byClass(t.box, 'pv-stub');
  assert.equal(stubs.length, 1, 'the match on an older page, which is not loaded');
  assert.match(flat(stubs[0]), /find the needle in the haystack/);
  assert.equal(byClass(t.box, 'pv-item').length, 1);
  assert.match(flat(t.box), /needle again/);
  assert.doesNotMatch(flat(t.box), /widgets/, 'other prompts are filtered out');
  /* a click loads that page (pages, until it is loaded) and opens the prompt */
  const before = t.reads.length;
  stubs[0].listeners.click();
  for (let i = 0; i < 20 && w.start > 0; i++) await t.page.tick();
  await t.page.tick();
  const older = t.reads.slice(before).filter((q) => q.before !== undefined);
  assert.deepEqual(
    older.map((q) => Number(q.before)),
    [180, 60],
    'two older pages were loaded, newest first',
  );
  assert.equal(w.start, 0);
  assert.equal(byClass(t.box, 'pv-stub').length, 0, 'the hit is loaded now');
  const opened = byClass(t.box, 'pv-item').filter((i) => /open/.test(i.className));
  assert.equal(opened.length, 1);
  assert.match(flat(opened[0]), /find the needle in the haystack/);
  assert.match(flat(opened[0]), /answer 5/, 'with its replies');
  assert.equal(byClass(opened[0], 'pv-arrow')[0].textContent, '▾');
  /* clearing the box brings back every loaded prompt (all 100 now) */
  t.page.hook.setFindQuery('');
  assert.equal(byClass(t.box, 'pv-item').length, 100);
});

test('the Prompts find box is mounted above the list, hidden in other views, and is a labelled search field', () => {
  const shell = fakeDom.page();
  const context = fakeDom.load(shell, SCRIPTS);
  const host = shell.make('div', 'promptFind', shell.body);
  let q = '',
    shown = true;
  const calls = [];
  const find = context.ChatViewsUI.mountFind(host, {
    query: () => q,
    set: (v) => {
      q = v;
      calls.push(v);
    },
    visible: () => shown,
    note: () => '3 of 9 prompts match',
  });
  const input = host.querySelectorAll('input')[0];
  assert.equal(input.getAttribute('aria-label'), 'Find in your messages');
  assert.equal(input.placeholder, 'Find in your messages');
  assert.equal(host.hidden, false);
  input.value = 'abc';
  input.dispatch('input');
  assert.deepEqual(calls, ['abc']);
  assert.match(host.textContent || flat(host), /3 of 9 prompts match/);
  shown = false;
  find.sync();
  assert.equal(host.hidden, true);
});

test('an empty find shows "No prompts match." and an empty chat "No prompts yet." (not the class name)', () => {
  const shell = fakeDom.page();
  const { ChatViews, ChatViewsUI } = fakeDom.load(shell, SCRIPTS);
  const ctx = { bubble: () => shell.document.createElement('div'), groupRows: (l) => l };
  const proj = ChatViews.project([], 'prompts', {});
  const none = ChatViewsUI.promptNodes(proj, 0, { ...ctx, query: 'zzz' });
  assert.equal(none.length, 1);
  assert.equal(none[0].textContent, 'No prompts match.');
  assert.equal(none[0].className, 'empty-state');
  assert.equal(ChatViewsUI.promptNodes(proj, 0, { ...ctx, query: '' })[0].textContent, 'No prompts yet.');
});
