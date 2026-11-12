const { APP: APP_DIR } = require('./_paths');
const test = require('node:test');
const path = require('node:path');
const assert = require('node:assert');
const P = require(path.join(APP_DIR, 'plan-ui.js'));

const user = (text) => ({ role: 'user', value: text });
const live = (entries, time) => ({ role: 'plan', label: 'Plan', time, entries, value: '' });
const tool = (name, input, extra) => ({ role: 'tool', label: name, call: { name, input }, ...extra });
const st = (row) => row.entries.map((e) => e.status[0]).join('');

test('live ACP plan updates collapse into one card at the first position', () => {
  const rows = [
    user('go'),
    { role: 'assistant', value: 'ok' },
    live(
      [
        { content: 'a', status: 'in_progress' },
        { content: 'b', status: 'pending' },
      ],
      1,
    ),
    { role: 'tool', raw: { toolCallId: 't' } },
    live(
      [
        { content: 'a', status: 'completed' },
        { content: 'b', status: 'in_progress' },
      ],
      2,
    ),
  ];
  const out = P.fold(rows, { live: true });
  assert.deepEqual(
    out.map((r) => r.role),
    ['user', 'assistant', 'plan', 'tool'],
  );
  assert.equal(st(out[2]), 'ci');
  assert.equal(out[2].active, true);
  assert.equal(out[2].time, 1);
  assert.equal(out[2].sources.length, 2);
  assert.match(out[2].value, /- \[x\] a\n- \[ \] b \(in progress\)/);
});

test('a new turn gets its own card; the earlier one is not active', () => {
  const rows = [
    user('1'),
    live([{ content: 'a', status: 'completed' }]),
    { role: 'turn-end' },
    user('2'),
    live([{ content: 'z', status: 'in_progress' }]),
  ];
  const out = P.fold(rows, { live: true });
  assert.equal(out.filter((r) => r.role === 'plan').length, 2);
  assert.equal(out[1].active, undefined);
  assert.equal(out[4].active, true);
});

test('TodoWrite and update_plan full lists replace the card content', () => {
  const rows = [
    user('x'),
    tool('TodoWrite', {
      todos: [
        { content: 'a', status: 'in_progress', activeForm: 'Doing a' },
        { content: 'b', status: 'pending' },
      ],
    }),
    { role: 'tool', raw: { toolCallId: 'q' } },
    tool('mcp__ccd_turn__update_plan', {
      items: [
        { content: 'a', status: 'completed' },
        { content: 'b', status: 'in_progress' },
        { content: 'c', status: 'pending' },
      ],
    }),
  ];
  const out = P.fold(rows);
  assert.deepEqual(
    out.map((r) => r.role),
    ['user', 'plan', 'tool'],
  );
  assert.equal(st(out[1]), 'cip');
  assert.equal(out[1].active, undefined);
});

test('advance / done / start patches change the latest list', () => {
  const base = [
    { content: 'a', status: 'in_progress' },
    { content: 'b', status: 'pending' },
    { content: 'c', status: 'pending' },
  ];
  assert.equal(st({ entries: P.applyPatch(base, { advance: true }) }), 'cip');
  assert.equal(st({ entries: P.applyPatch(base, { done: [1, 3], start: 2 }) }), 'cic');
  assert.equal(P.applyPatch(base, {}), null);
  assert.equal(P.applyPatch(null, { advance: true }), null);
  const out = P.fold([
    user('x'),
    tool('mcp__ccd_turn__update_plan', { items: base }),
    tool('mcp__ccd_turn__update_plan', { advance: true }),
    tool('mcp__ccd_turn__update_plan', { advance: true }),
  ]);
  assert.equal(out.length, 2);
  assert.equal(st(out[1]), 'cci');
});

test('a patch with no list known stays a normal tool row; other tools are untouched', () => {
  const rows = [user('x'), tool('mcp__ccd_turn__update_plan', { advance: true }), tool('Bash', { command: 'ls' })];
  assert.deepEqual(P.fold(rows), rows);
});

test('patch in a later turn updates the previous list into a new card', () => {
  const rows = [
    user('1'),
    tool('TodoWrite', {
      todos: [
        { content: 'a', status: 'in_progress' },
        { content: 'b', status: 'pending' },
      ],
    }),
    user('2'),
    tool('mcp__ccd_turn__update_plan', { advance: true }),
  ];
  const out = P.fold(rows);
  assert.equal(out.filter((r) => r.role === 'plan').length, 2);
  assert.equal(st(out[3]), 'ci');
});

test('Codex-style plan input and status names are normalised', () => {
  const out = P.fold([
    tool('update_plan', { plan: [{ step: 's1', status: 'done' }, { step: 's2', status: 'active' }, { step: 's3' }] }),
  ]);
  assert.equal(st(out[0]), 'cip');
  assert.equal(out[0].entries[0].content, 's1');
});

test('empty plans do not make a card', () => {
  const rows = [live([], 1)];
  assert.equal(P.fold(rows).filter((r) => r.entries && r.entries.length).length, 0);
});

test('card DOM: marks, counts, spinner only while active, raw details', () => {
  const made = [];
  global.document = {
    createElement: (tag) => {
      const n = {
        tag,
        children: [],
        className: '',
        textContent: '',
        attrs: {},
        listeners: {},
        append(...c) {
          this.children.push(...c);
        },
        setAttribute(k, v) {
          this.attrs[k] = v;
        },
        addEventListener(t, f) {
          this.listeners[t] = f;
        },
      };
      made.push(n);
      return n;
    },
  };
  const row = P.fold(
    [
      user('x'),
      live([
        { content: 'a', status: 'completed' },
        { content: 'b', status: 'in_progress' },
        { content: 'c', status: 'pending' },
      ]),
    ],
    { live: true },
  )[1];
  const card = P.card(row);
  const all = [];
  const walk = (n) => {
    all.push(n);
    (n.children || []).forEach((c) => typeof c === 'object' && walk(c));
  };
  walk(card);
  const cls = (c) => all.filter((n) => (n.className || '').split(' ').includes(c));
  assert.equal(card.className, 'bubble plan');
  assert.equal(cls('plan-item').length, 3); // the done step is drawn inside the folded line
  assert.equal(cls('plan-count')[0].textContent, '1/3 done');
  assert.equal(cls('plan-spin').length, 1);
  assert.equal(cls('plan-raw').length, 0); // no raw details toggle
  assert.deepEqual(
    cls('plan-mark').map((n) => n.textContent),
    ['', '', '✓', '✓'],
  ); // the done line's own ✓ comes last; current and to-do marks are drawn by CSS (circled dots, dashed circle)
  row.active = false;
  assert.equal(P.card(row).children.length, 2); // header and checklist only
  delete global.document;
});

test('the desktop app wrap-up call ticks off the plan of its turn', () => {
  const tool = (name, input) => ({ role: 'tool', call: { name, input } });
  const out = P.fold([
    { role: 'user', value: 'go' },
    tool('mcp__ccd_turn__update_plan', {
      items: [
        { content: 'A', status: 'in_progress' },
        { content: 'B', status: 'pending' },
      ],
    }),
    tool('mcp__ccd_turn__wrap_up', { recap: 'x' }),
  ]);
  const card = out.find((r) => r.role === 'plan');
  assert.deepEqual(
    card.entries.map((e) => e.status),
    ['completed', 'completed'],
  );
});

test('the wrap-up leaves the plan alone while a background agent of its turn is still running', () => {
  const tool = (name, input, result) => ({ role: 'tool', call: { name, input, result } });
  const plan = tool('mcp__ccd_turn__update_plan', {
    items: [
      { content: 'A', status: 'completed' },
      { content: 'B', status: 'in_progress' },
      { content: 'C', status: 'pending' },
    ],
  });
  const out = P.fold([
    { role: 'user', value: 'go' },
    plan,
    tool('Agent', { prompt: 'x' }, { text: 'Async agent launched successfully.' }),
    tool('mcp__ccd_turn__wrap_up', { recap: 'x' }),
  ]);
  const card = out.find((r) => r.role === 'plan');
  assert.deepEqual(
    card.entries.map((e) => e.status),
    ['completed', 'in_progress', 'pending'],
  );
  assert.equal(card.running, 1);
  /* The same launch reported as a separate result row counts too; a background command does not count (it still holds the wrap-up). */
  const out2 = P.fold([
    { role: 'user', value: 'go' },
    plan,
    tool('Bash', { command: 'x', run_in_background: true }),
    { role: 'result', callId: '1', value: 'Async agent launched successfully.' },
    tool('mcp__ccd_turn__wrap_up', { recap: 'x' }),
  ]);
  assert.equal(out2.find((r) => r.role === 'plan').running, 1);
  /* A later turn without background work ticks the plan as before. */
  const out3 = P.fold([
    { role: 'user', value: 'go' },
    plan,
    tool('Agent', {}, { text: 'Async agent launched' }),
    { role: 'user', value: 'next' },
    tool('mcp__ccd_turn__wrap_up', { recap: 'x' }),
  ]);
  assert.deepEqual(
    out3.find((r) => r.role === 'plan').entries.map((e) => e.status),
    ['completed', 'completed', 'completed'],
  );
});

test('the latest plan counts background tasks still running, across turns, until their task-notification arrives', () => {
  const tool = (name, input, result) => ({ role: 'tool', call: { name, input, result } });
  const plan = tool('mcp__ccd_turn__update_plan', {
    items: [
      { content: 'A', status: 'completed' },
      { content: 'B', status: 'in_progress' },
    ],
  });
  const launch = (id) =>
    tool('Agent', { prompt: 'x' }, { text: 'Async agent launched successfully.\nagentId: ' + id + ' (internal ID)' });
  const note = (id, status) => ({
    role: 'user',
    value: '<task-notification>\n<task-id>' + id + '</task-id>\n<status>' + status + '</status>\n</task-notification>',
  });
  const run = (rows) =>
    P.fold(rows)
      .filter((r) => r.role === 'plan')
      .pop().running;
  /* No wrap-up needed, and the count survives the turn ending. */
  assert.equal(
    run([
      { role: 'user', value: 'go' },
      plan,
      launch('a1'),
      launch('b2'),
      { role: 'turn-end' },
      { role: 'user', value: 'hi' },
    ]),
    2,
  );
  assert.equal(
    run([
      { role: 'user', value: 'go' },
      plan,
      launch('a1'),
      launch('b2'),
      { role: 'turn-end' },
      note('a1', 'completed'),
    ]),
    1,
  );
  assert.equal(
    run([{ role: 'user', value: 'go' }, plan, launch('a1'), { role: 'turn-end' }, note('a1', 'running')]),
    1,
  );
  assert.equal(run([{ role: 'user', value: 'go' }, plan, launch('a1'), { role: 'turn-end' }, note('a1', 'failed')]), 0);
  /* Like Claude's app, background commands are not counted as running tasks. */
  assert.equal(
    run([
      { role: 'user', value: 'go' },
      plan,
      tool(
        'Bash',
        { command: 'x', run_in_background: true },
        { text: 'Command running in background with ID: bx9. Output is being written to: f' },
      ),
      { role: 'turn-end' },
      { role: 'user', value: 'hi' },
    ]),
    0,
  );
  /* Finishes that arrive mid-turn: the transcript reader's task-done marker (never drawn), a hand-back, or a notice riding on a tool result. */
  const doneOut = P.fold([
    { role: 'user', value: 'go' },
    plan,
    launch('a1'),
    launch('b2'),
    launch('c3'),
    { role: 'task-done', value: 'a1' },
  ]);
  assert.equal(
    doneOut.find((r) => r.role === 'task-done'),
    undefined,
  );
  assert.equal(doneOut.filter((r) => r.role === 'plan').pop().running, 2);
  assert.equal(
    run([
      { role: 'user', value: 'go' },
      plan,
      launch('a1'),
      { role: 'turn-end' },
      {
        role: 'user',
        value:
          'Another Claude session sent a message:\n<agent-message from="a1">\n[Subagent hand-back] The text below ... The report follows:\n  done\n</agent-message>',
      },
    ]),
    0,
  );
  assert.equal(
    run([
      { role: 'user', value: 'go' },
      plan,
      launch('a1'),
      {
        role: 'result',
        value: 'ok\n<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n</task-notification>',
      },
    ]),
    0,
  );
  /* Like Claude's app: the current step spins only while the chat is working; running tasks alone show the dots. */
  const last = (rows, o) =>
    P.fold(rows, o)
      .filter((r) => r.role === 'plan')
      .pop();
  assert.equal(!!last([{ role: 'user', value: 'go' }, plan, launch('a1')]).active, false);
  assert.equal(!!last([{ role: 'user', value: 'go' }, plan, { role: 'turn-end' }]).active, false);
  assert.equal(last([{ role: 'user', value: 'go' }, plan, { role: 'turn-end' }], { working: true }).active, true);
  /* Output that only mentions the launch words (a grep) is not a launch; a live ACP result with content blocks is. */
  assert.equal(
    run([
      { role: 'user', value: 'go' },
      plan,
      { role: 'result', value: '49: Command running in background with ID: b7j7u2ihk.' },
    ]),
    0,
  );
  assert.equal(
    run([
      { role: 'user', value: 'go' },
      plan,
      {
        role: 'tool',
        call: { name: 'Agent', input: {} },
        raw: { rawOutput: [{ type: 'text', text: 'Async agent launched successfully.\nagentId: z9' }] },
      },
    ]),
    1,
  );
  /* A task stopped by hand stops counting. */
  assert.equal(
    run([
      { role: 'user', value: 'go' },
      plan,
      tool('Bash', { command: 'x', run_in_background: true }, { text: 'Command running in background with ID: bx9.' }),
      { role: 'result', value: '{"message":"Successfully stopped task: bx9 (sleep)"}' },
    ]),
    0,
  );
  /* A newer plan counts only tasks started since its own turn began; the older card shows none. */
  const out = P.fold([
    { role: 'user', value: 'go' },
    plan,
    launch('a1'),
    { role: 'turn-end' },
    { role: 'user', value: 'next' },
    plan,
  ]);
  const cards = out.filter((r) => r.role === 'plan');
  assert.equal(cards[0].running, 0);
  assert.equal(cards[1].running, 0);
  const out2 = P.fold([
    { role: 'user', value: 'go' },
    plan,
    launch('a1'),
    { role: 'turn-end' },
    { role: 'user', value: 'next' },
    plan,
    launch('b2'),
  ]);
  assert.equal(out2.filter((r) => r.role === 'plan').pop().running, 1);
});

test('the desktop app next-step box becomes a Next step row with recap, question and button labels', () => {
  const tool = (name, input) => ({ role: 'tool', call: { name, input } });
  const out = P.fold([
    { role: 'user', value: 'go' },
    tool('mcp__ccd_turn__wrap_up', {
      recap: 'Done.',
      ask: 'Restart now?',
      actions: [{ label: 'Yes, when idle' }, { action: 'commit' }],
    }),
  ]);
  const step = out.find((r) => r.role === 'nextstep');
  assert.deepEqual([step.recap, step.ask, step.actions], ['Done.', 'Restart now?', ['Yes, when idle', 'Commit']]);
  assert.equal(
    out.some((r) => r.role === 'tool'),
    false,
  );
  assert.equal(P.nextStep(tool('mcp__ccd_turn__wrap_up', {})), null);
});

test('a wrap-up ticks off the latest plan even when a message arrived mid-turn', () => {
  const tool = (name, input) => ({ role: 'tool', call: { name, input } });
  const out = P.fold([
    { role: 'user', value: 'go' },
    tool('mcp__ccd_turn__update_plan', {
      items: [
        { content: 'A', status: 'in_progress' },
        { content: 'B', status: 'pending' },
      ],
    }),
    { role: 'user', value: 'also this' },
    tool('mcp__ccd_turn__wrap_up', { recap: 'Done.' }),
  ]);
  assert.deepEqual(
    out.find((r) => r.role === 'plan').entries.map((e) => e.status),
    ['completed', 'completed'],
  );
});

test('the next-step card sits after the turn’s closing message, like the desktop app', () => {
  const tool = (name, input) => ({ role: 'tool', call: { name, input } });
  const out = P.fold([
    { role: 'user', value: 'go' },
    tool('mcp__ccd_turn__wrap_up', { recap: 'Done.', ask: 'Ok?', actions: [{ label: 'Yes' }] }),
    { role: 'assistant', value: 'Closing message' },
    { role: 'user', value: 'next' },
  ]);
  assert.deepEqual(
    out.map((r) => r.role),
    ['user', 'assistant', 'nextstep', 'user'],
  );
});

/* ---- order and fold of the plan card ---- */
function fakeDoc() {
  const mk = (tag) => ({
    tag,
    children: [],
    className: '',
    textContent: '',
    hidden: false,
    attrs: {},
    listeners: {},
    append(...c) {
      this.children.push(...c);
    },
    setAttribute(k, v) {
      this.attrs[k] = v;
    },
    addEventListener(t, f) {
      this.listeners[t] = f;
    },
    click() {
      this.listeners.click && this.listeners.click({});
    },
  });
  global.document = { createElement: mk };
}
const nodes = (n, out = []) => {
  out.push(n);
  (n.children || []).forEach((c) => typeof c === 'object' && nodes(c, out));
  return out;
};
const byCls = (n, c) => nodes(n).filter((x) => (x.className || '').split(' ').includes(c));
const textsOf = (n) => byCls(n, 'plan-text').map((x) => x.textContent);
const mkRow = (statuses, time) => ({
  role: 'plan',
  turn: 1,
  time,
  entries: statuses.map((s, i) => ({ content: 's' + (i + 1), status: s })),
  value: P.checklist(statuses.map((s, i) => ({ content: 's' + (i + 1), status: s }))),
});
const C = 'completed',
  I = 'in_progress',
  W = 'pending';

test('card order: in progress, then to do, then one "N done" line (agent order inside each group)', () => {
  fakeDoc();
  const card = P.card(mkRow([C, W, I, C, W, I], 'ord'));
  const list = byCls(card, 'plan-list')[0];
  const top = list.children.map((li) => li.className);
  assert.deepEqual(top, [
    'plan-item plan-in_progress',
    'plan-item plan-in_progress',
    'plan-item plan-pending',
    'plan-item plan-pending',
    'plan-done-fold',
  ]);
  assert.deepEqual(
    list.children.slice(0, 4).map((li) => li.children[2].textContent),
    ['s3', 's6', 's2', 's5'],
  );
  assert.equal(byCls(card, 'plan-done-text')[0].textContent, '2 done');
  assert.equal(byCls(card, 'plan-count')[0].textContent, '2/6 done');
  delete global.document;
});

test('the done line is collapsed by default, opens on click (a button, so Enter/Space too) and stays open across a redraw', () => {
  fakeDoc();
  const row = mkRow([C, C, W], 'fold1');
  let card = P.card(row);
  let btn = byCls(card, 'plan-done-toggle')[0];
  assert.equal(btn.tag, 'button');
  assert.equal(btn.type, 'button');
  assert.equal(btn.attrs['aria-expanded'], 'false');
  assert.equal(byCls(card, 'plan-done-list')[0].hidden, true);
  assert.equal(byCls(card, 'plan-done-arrow')[0].textContent, '▸');
  btn.click();
  assert.equal(btn.attrs['aria-expanded'], 'true');
  assert.equal(byCls(card, 'plan-done-list')[0].hidden, false);
  assert.equal(byCls(card, 'plan-done-arrow')[0].textContent, '▾');
  /* redraw (new card object, same plan): still open; another plan is unaffected */
  card = P.card({ ...row, entries: row.entries.map((e) => ({ ...e })) });
  btn = byCls(card, 'plan-done-toggle')[0];
  assert.equal(btn.attrs['aria-expanded'], 'true');
  assert.equal(byCls(P.card(mkRow([C, W], 'fold2')), 'plan-done-toggle')[0].attrs['aria-expanded'], 'false');
  btn.click();
  assert.equal(byCls(P.card(row), 'plan-done-toggle')[0].attrs['aria-expanded'], 'false');
  delete global.document;
});

test('an all-done card shows only the header and the "N done" line; no done line when nothing is done', () => {
  fakeDoc();
  const card = P.card(mkRow([C, C, C, C], 'alldone'));
  const list = byCls(card, 'plan-list')[0];
  assert.equal(list.children.length, 1);
  assert.equal(list.children[0].className, 'plan-done-fold');
  assert.equal(byCls(card, 'plan-done-text')[0].textContent, '4 done');
  assert.equal(byCls(card, 'plan-count')[0].textContent, '4/4 done');
  assert.equal(byCls(P.card(mkRow([W, I], 'nodone')), 'plan-done-fold').length, 0);
  delete global.document;
});

test("Copy still copies every step in the agent's original order", () => {
  const row = P.fold([
    user('x'),
    live([
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'pending' },
      { content: 'c', status: 'in_progress' },
      { content: 'd', status: 'completed' },
    ]),
  ])[1];
  assert.equal(row.value, '- [x] a\n- [ ] b\n- [ ] c (in progress)\n- [x] d');
});
