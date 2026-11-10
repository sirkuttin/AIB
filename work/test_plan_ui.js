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
        append(...c) {
          this.children.push(...c);
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
  assert.equal(cls('plan-item').length, 3);
  assert.equal(cls('plan-count')[0].textContent, '1/3 done');
  assert.equal(cls('plan-spin').length, 1);
  assert.equal(cls('plan-raw').length, 0); // no raw details toggle
  assert.deepEqual(
    cls('plan-mark').map((n) => n.textContent),
    ['✓', '', ''],
  ); // current and to-do marks are drawn by CSS (circled dots, dashed circle)
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
