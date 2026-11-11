'use strict';
const { APP: APP_DIR } = require('./_paths');
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const A = require(path.join(APP_DIR, 'agent-choice.js'));

test('agents match the setup form values', () => {
  assert.deepEqual(
    A.AGENTS.map((a) => a.id),
    ['omp', 'claude', 'codex'],
  );
  assert.equal(A.nameOf('claude'), 'Claude Code');
  assert.equal(A.other('omp'), 'claude');
  assert.equal(A.other('claude'), 'omp');
});

test('resolveAgent falls back to OMP for anything unknown', () => {
  assert.equal(A.resolveAgent('claude'), 'claude');
  assert.equal(A.resolveAgent('nope'), 'omp');
  assert.equal(A.resolveAgent(null), 'omp');
});

test('remembered choice survives and storage failures are tolerated', () => {
  const mem = {};
  const store = {
    getItem: (k) => (k in mem ? mem[k] : null),
    setItem: (k, v) => {
      mem[k] = v;
    },
  };
  assert.equal(A.loadChoice(store), 'omp');
  assert.equal(A.saveChoice(store, 'claude'), true);
  assert.equal(A.loadChoice(store), 'claude');
  assert.equal(A.saveChoice(store, 'bogus'), false);
  assert.equal(A.loadChoice(store), 'claude');
  const broken = {
    getItem() {
      throw new Error('x');
    },
    setItem() {
      throw new Error('x');
    },
  };
  assert.equal(A.loadChoice(broken), 'omp');
  assert.equal(A.saveChoice(broken, 'claude'), false);
  assert.equal(A.loadChoice(null), 'omp');
});

test('folder: active project wins, then typed input, then none', () => {
  assert.deepEqual(A.resolveFolder({ activeProject: { path: 'C:\\r\\p' }, inputValue: 'D:\\x' }), {
    cwd: 'C:\\r\\p',
    source: 'project',
  });
  assert.deepEqual(A.resolveFolder({ activeProject: null, inputValue: ' D:\\x ' }), { cwd: 'D:\\x', source: 'input' });
  assert.deepEqual(A.resolveFolder({ activeProject: { path: '' }, inputValue: '' }), { cwd: '', source: 'none' });
  assert.deepEqual(A.resolveFolder(), { cwd: '', source: 'none' });
  assert.deepEqual(A.resolveFolder({ activeProject: { path: '/p' }, inputValue: '/typed', preferInput: true }), {
    cwd: '/typed',
    source: 'input',
  });
  assert.deepEqual(A.resolveFolder({ activeProject: { path: '/p' }, inputValue: '', preferInput: true }), {
    cwd: '/p',
    source: 'project',
  });
  assert.deepEqual(
    A.resolveFolder({ activeProject: { path: '/p' }, explicit: '/old', preferInput: true, inputValue: '/typed' }),
    { cwd: '/old', source: 'explicit' },
  );
});

const rows = (n) =>
  Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', value: 'message number ' + i }));

test('handoff keeps title and only the last few user/assistant messages', () => {
  const t = A.handoffText({
    title: 'Fix the build',
    from: 'omp',
    rows: [{ role: 'tool', value: 'toolout' }, { role: 'thinking', value: 'hmm' }, ...rows(10)],
  });
  assert.match(t, /Continuing from a OMP conversation: Fix the build/);
  assert.ok(t.includes('message number 9') && t.includes('message number 4'));
  assert.ok(!t.includes('message number 3') && !t.includes('hmm') && !t.includes('toolout'));
  assert.match(t, /You: message number 8/);
  assert.match(t, /OMP: message number 9/);
});

test('handoff is capped at 4000 characters and trims long messages', () => {
  const big = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', value: 'x'.repeat(5000) }));
  const t = A.handoffText({ title: 't'.repeat(900), from: 'claude', rows: big });
  assert.ok(t.length <= 4000, String(t.length));
  assert.ok(t.includes('…'));
  const tiny = A.handoffText({ title: 'a', from: 'claude', rows: big, limit: 300 });
  assert.ok(tiny.length <= 300);
});

test('handoff with no messages is just the title line', () => {
  const t = A.handoffText({ title: '', from: 'claude', rows: [] });
  assert.match(t, /^Continuing from a Claude Code conversation\./);
});

// ---- New chat form: one registry, the project's last agent, cached model / mode lists ----------------------------------
const memory = () => {
  const mem = {};
  return {
    mem,
    getItem: (k) => (k in mem ? mem[k] : null),
    setItem: (k, v) => {
      mem[k] = String(v);
    },
  };
};

test('the registry is the single source: every agent has id, name and letter; other() works for any pair', () => {
  for (const a of A.AGENTS) {
    assert.ok(a.id && a.name && a.letter);
    assert.equal(A.nameOf(a.id), a.name);
    assert.equal(A.isAgent(a.id), true);
  }
  assert.notEqual(A.other('omp'), 'omp');
  assert.equal(A.info('mystery').name, 'mystery', 'an unknown id still has a name');
});

test('default agent: this project\u2019s last, else the last used anywhere, else the first', () => {
  const store = memory();
  assert.equal(A.loadChoice(store, 'C:\\Repos\\App'), A.AGENTS[0].id, 'nothing remembered: the first agent');
  A.saveChoice(store, 'claude', 'C:\\Repos\\App');
  A.saveChoice(store, 'omp', 'C:\\Repos\\Other');
  assert.equal(A.loadChoice(store, 'c:/repos/app/'), 'claude', 'same folder written differently');
  assert.equal(A.loadChoice(store, 'C:\\Repos\\Other'), 'omp');
  assert.equal(A.loadChoice(store, 'C:\\Repos\\Never'), 'omp', 'unknown project: the last choice anywhere');
  assert.equal(A.loadChoice(store), 'omp', 'no project: the last choice anywhere');
  assert.equal(A.projectKey(''), '');
  assert.equal(A.saveChoice(store, 'bogus', 'C:\\Repos\\App'), false);
  assert.equal(A.loadChoice(store, 'C:\\Repos\\App'), 'claude');
  assert.equal(
    A.loadChoice(
      {
        getItem() {
          throw new Error('x');
        },
      },
      'C:\\p',
    ),
    A.AGENTS[0].id,
    'broken storage',
  );
});

test('the per-project memory is bounded', () => {
  const store = memory();
  for (let i = 0; i < 260; i++) A.saveChoice(store, 'claude', '/p/' + i);
  assert.ok(Object.keys(JSON.parse(store.mem['studio-new-chat-agent-by-project'])).length <= 200);
  assert.equal(A.loadChoice(store, '/p/259'), 'claude');
});

const settingsOf = (over = {}) =>
  Object.assign(
    {
      modes: {
        currentModeId: 'default',
        availableModes: [
          { id: 'default', name: 'Default' },
          { id: 'plan', name: 'Plan' },
        ],
      },
      configOptions: [
        {
          id: 'model',
          category: 'model',
          type: 'select',
          currentValue: 'opus',
          options: [
            { value: 'opus', name: 'Opus 5.5' },
            { group: 'g', options: [{ value: 'sonnet', name: 'Sonnet 5.5' }] },
          ],
        },
      ],
    },
    over,
  );

test('model and mode lists are cached per agent from any session that reports them', () => {
  const store = memory();
  assert.deepEqual(A.loadOptions(store, 'claude'), { model: null, mode: null }, 'nothing cached yet');
  assert.deepEqual(
    A.pickList(null).map((c) => c.name),
    ['Default'],
    'no cache: Default only',
  );
  assert.equal(A.saveOptions(store, 'claude', settingsOf()), true);
  assert.equal(A.saveOptions(store, 'claude', settingsOf()), false, 'unchanged: nothing written');
  const o = A.loadOptions(store, 'claude');
  assert.deepEqual(o.model, {
    configId: 'model',
    choices: [
      { value: 'opus', name: 'Opus 5.5' },
      { value: 'sonnet', name: 'Sonnet 5.5' },
    ],
  });
  assert.deepEqual(o.mode, {
    kind: 'mode',
    choices: [
      { value: 'default', name: 'Default' },
      { value: 'plan', name: 'Plan' },
    ],
  });
  assert.deepEqual(
    A.pickList(o.model).map((c) => c.value),
    ['', 'opus', 'sonnet'],
  );
  assert.deepEqual(A.loadOptions(store, 'omp'), { model: null, mode: null }, 'per agent');
  // a later session of the same agent that only reports a model keeps the cached modes
  A.saveOptions(store, 'claude', {
    configOptions: [{ id: 'model', category: 'model', type: 'select', options: [{ value: 'haiku', name: 'Haiku' }] }],
  });
  const again = A.loadOptions(store, 'claude');
  assert.deepEqual(again.model.choices, [{ value: 'haiku', name: 'Haiku' }]);
  assert.equal(again.mode.choices.length, 2);
});

test('a mode advertised as a config option is cached with its config id; junk is ignored', () => {
  const store = memory();
  A.saveOptions(store, 'omp', {
    configOptions: [
      {
        id: 'mode',
        type: 'select',
        options: [
          { value: 'a', name: 'A' },
          { value: 'b', name: 'B' },
        ],
      },
    ],
  });
  assert.deepEqual(A.loadOptions(store, 'omp').mode, {
    kind: 'config',
    configId: 'mode',
    choices: [
      { value: 'a', name: 'A' },
      { value: 'b', name: 'B' },
    ],
  });
  for (const bad of [null, undefined, {}, { configOptions: 'x' }, { modes: { availableModes: [] } }])
    assert.equal(A.saveOptions(memory(), 'omp', bad), false);
  assert.equal(A.saveOptions(memory(), 'bogus', settingsOf()), false, 'unknown agent');
  assert.equal(
    A.saveOptions(
      {
        getItem() {
          throw new Error('x');
        },
        setItem() {
          throw new Error('x');
        },
      },
      'omp',
      settingsOf(),
    ),
    false,
  );
  assert.deepEqual(A.loadOptions({ getItem: () => '{not json' }, 'omp'), { model: null, mode: null });
});

test('applyPlan: the chosen model and mode become the calls made right after the session starts', () => {
  const store = memory();
  A.saveOptions(store, 'claude', settingsOf());
  const o = A.loadOptions(store, 'claude');
  assert.deepEqual(A.applyPlan(o, { model: 'sonnet', mode: 'plan' }), [
    { op: 'config', configId: 'model', value: 'sonnet' },
    { op: 'mode', modeId: 'plan' },
  ]);
  assert.deepEqual(A.applyPlan(o, { model: '', mode: '' }), [], 'Default leaves the agent alone');
  assert.deepEqual(
    A.applyPlan(o, { model: 'gone', mode: 'plan' }),
    [{ op: 'mode', modeId: 'plan' }],
    'a model no longer listed is skipped',
  );
  const viaConfig = { model: null, mode: { kind: 'config', configId: 'mode', choices: [{ value: 'b', name: 'B' }] } };
  assert.deepEqual(A.applyPlan(viaConfig, { mode: 'b' }), [{ op: 'config', configId: 'mode', value: 'b' }]);
  assert.deepEqual(A.applyPlan(null, { model: 'x' }), []);
});

test('agents that are not installed are not offered for new chats', () => {
  const ids = () => A.AGENTS.map((a) => a.id);
  A.setRegistry([
    { id: 'omp', found: true },
    { id: 'claude', found: true },
    { id: 'codex', found: false },
    { id: 'custom-x', name: 'X', found: false },
    { id: 'custom-y', name: 'Y', found: true },
  ]);
  assert.deepEqual(ids(), ['omp', 'claude', 'custom-y']);
  assert.ok(
    A.ALL.some((a) => a.id === 'codex') && A.ALL.some((a) => a.id === 'custom-x'),
    'Settings still sees every agent',
  );
  assert.equal(A.isAgent('codex'), false);
  // a saved choice pointing at a hidden agent falls back to the first usable one
  assert.equal(A.resolveAgent('codex'), 'omp');
  const store = { getItem: () => 'codex', setItem() {} };
  assert.equal(A.loadChoice(store), 'omp');
  assert.equal(A.other('codex'), 'omp');
  // nothing usable: the first built-in stays so the form is never empty
  A.setRegistry([
    { id: 'omp', found: false },
    { id: 'claude', found: false },
    { id: 'codex', found: false },
  ]);
  assert.deepEqual(ids(), ['omp']);
  A.setRegistry([]);
  assert.deepEqual(ids(), ['omp', 'claude', 'codex']);
});

// ---- Beta agents in New chat: Ready ones are offered unless turned Off; the others are listed greyed with the reason ----------------
const betaRow = (id, extra = {}) => ({ id, name: id, beta: true, enabled: true, found: true, signin: { state: 'ready' }, ...extra });

test('a Ready Beta agent (found, signed in, no explicit Off) is offered in New chat and can be the chosen agent', () => {
  A.setRegistry([betaRow('kimi', { name: 'Kimi Code' })]);
  assert.ok(A.AGENTS.some((a) => a.id === 'kimi'));
  assert.equal(A.isAgent('kimi'), true);
  assert.equal(A.resolveAgent('kimi'), 'kimi');
  assert.ok(A.menuRows().some((r) => r.value === 'kimi' && !r.disabled && r.group === 'Beta'));
  assert.equal(A.UNAVAILABLE.length, 0);
});

test('a Ready Beta agent the person turned Off is not offered; it is listed greyed as "Turned off in Settings"', () => {
  A.setRegistry([betaRow('kimi', { name: 'Kimi Code', enabled: false })]);
  assert.equal(A.isAgent('kimi'), false);
  assert.equal(A.resolveAgent('kimi'), 'omp');
  const row = A.menuRows().find((r) => r.value === 'kimi');
  assert.deepEqual([row.disabled, row.reason], [true, 'Turned off in Settings']);
});

test('Beta agents that need sign-in or are not installed are listed greyed with the reason, never pickable', () => {
  A.setRegistry([
    betaRow('gemini', { name: 'Gemini CLI', signin: { state: 'signin' } }),
    betaRow('cursor', { name: 'Cursor CLI', found: false, enabled: false, signin: null }),
  ]);
  assert.equal(A.isAgent('gemini') || A.isAgent('cursor'), false);
  const reasons = Object.fromEntries(A.menuRows().filter((r) => r.disabled).map((r) => [r.value, r.reason]));
  assert.deepEqual(reasons, { gemini: 'Needs sign-in', cursor: 'Not installed' });
  assert.equal(A.setupTarget(), 'gemini', 'the link opens the installed agent that still needs setting up');
  A.setRegistry([]);
  assert.equal(A.UNAVAILABLE.length, 0);
});
