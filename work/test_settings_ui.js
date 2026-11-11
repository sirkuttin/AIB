'use strict';
const { APP: APP_DIR } = require('./_paths');
// Settings page logic: search/filter across sections, the page's agent registry merge, defaults for new chats, and the load/save wiring.
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const dir = path.join(APP_DIR);
const AC = require(path.join(dir, 'agent-choice.js'));
const Cmd = require(path.join(dir, 'commands-registry.js'));
globalThis.AgentChoice = AC;
globalThis.AgentCommands = Cmd;
const S = require(path.join(dir, 'settings-ui.js'));

const reset = () => {
  AC.setRegistry([]);
  AC.setDefaults(null);
  AC.setSink(null);
};
const memory = (seed = {}) => {
  const m = { ...seed };
  return {
    getItem: (k) => (k in m ? m[k] : null),
    setItem: (k, v) => {
      m[k] = String(v);
    },
    _m: m,
  };
};
const custom = (id, name, extra = {}) => ({ id, name, builtin: false, enabled: true, ...extra });

// ---- search ----------------------------------------------------------------------------------------------------------
test('an empty search lists every setting, in section order', () => {
  assert.equal(S.filterIndex(S.INDEX, '').length, S.INDEX.length);
  assert.equal(S.filterIndex(S.INDEX, '   ').length, S.INDEX.length);
  const order = S.SECTIONS.map((s) => s.id);
  const seen = S.INDEX.map((e) => order.indexOf(e.section));
  assert.deepEqual(
    seen,
    seen.slice().sort((a, b) => a - b),
    'the index follows the section order',
  );
});

test('every entry belongs to a real section and has a label', () => {
  const ids = new Set(S.SECTIONS.map((s) => s.id));
  assert.deepEqual(
    S.SECTIONS.map((s) => s.label),
    ['AIB Linking', 'Defaults', 'Notifications', 'Editors', 'Keyboard', 'Appearance', 'AIB server'],
  );
  for (const e of S.INDEX) {
    assert.ok(ids.has(e.section), e.id);
    assert.ok(e.label && Array.isArray(e.keywords), e.id);
  }
  assert.equal(new Set(S.INDEX.map((e) => e.id)).size, S.INDEX.length, 'ids are unique');
});

test('search matches label, keywords and the section name, across sections', () => {
  const ids = (q) => S.filterIndex(S.INDEX, q).map((e) => e.id);
  assert.ok(ids('add an acp').includes('agents-add'));
  assert.ok(ids('pid').includes('server-info'), 'a keyword');
  assert.ok(ids('sound').includes('notifications'));
  assert.ok(
    ids('model').includes('default-picks') && ids('model').includes('default-projects'),
    'one word, two sections of results',
  );
  assert.ok(ids('zoom').includes('text-size'));
  assert.ok(ids('keyboard').includes('keyboard'), 'the section name finds its settings');
  assert.deepEqual(ids('zzzzqqq'), []);
});

test('the keeper has no setting: it is always on, so no entry to find', () => {
  assert.ok(!S.INDEX.some((e) => e.id === 'keeper'));
  assert.ok(!S.INDEX.some((e) => e.keywords.includes('AIB_KEEPER')), 'the escape hatch is never shown');
});

test('every word must match; the best match comes first', () => {
  const ids = (q) => S.filterIndex(S.INDEX, q).map((e) => e.id);
  assert.ok(ids('agent default').includes('default-agent'));
  assert.ok(!ids('agent pid').includes('agents-add'), 'both words must match something');
  assert.equal(ids('restart')[0] === 'auto-reconnect' || ids('restart')[0] === 'server-restart', true);
  assert.equal(ids('default agent')[0], 'default-agent');
});

test('the fallback matcher works without the command bar module', () => {
  const saved = globalThis.AgentCommands;
  delete globalThis.AgentCommands;
  try {
    assert.deepEqual(
      S.filterIndex(S.INDEX, 'text size').map((e) => e.id),
      ['text-size'],
    );
    assert.ok(S.filterIndex(S.INDEX, 'pid').some((e) => e.id === 'server-info'));
    assert.deepEqual(S.filterIndex(S.INDEX, 'zzzz'), []);
  } finally {
    globalThis.AgentCommands = saved;
  }
  const custom = (q, fields) => (fields.some((f) => f.text === 'Text size') ? 5 : -1);
  assert.deepEqual(
    S.filterIndex(S.INDEX, 'anything', custom).map((e) => e.id),
    ['text-size'],
    'a ranker can be passed in',
  );
});

test('section counts follow the search and cover every section', () => {
  const all = S.sectionCounts(S.INDEX, '');
  assert.equal(
    Object.values(all).reduce((a, b) => a + b, 0),
    S.INDEX.length,
  );
  const found = S.sectionCounts(S.INDEX, 'model');
  assert.ok(found.defaults >= 2);
  assert.equal(found.keyboard, 0);
  assert.deepEqual(
    Object.keys(found),
    S.SECTIONS.map((s) => s.id),
  );
});

// ---- registry merge --------------------------------------------------------------------------------------------------
test('before the server answers, the built-ins are the registry', () => {
  reset();
  assert.deepEqual(
    AC.AGENTS.map((a) => a.id),
    ['omp', 'claude', 'codex'],
  );
  assert.equal(AC.nameOf('claude'), 'Claude Code');
});

test('mergeRegistry: built-ins first, user agents appended, junk skipped, built-ins never dropped', () => {
  const m = AC.mergeRegistry([
    custom('custom-codex', 'Codex'),
    { id: 'omp', enabled: false },
    null,
    5,
    { id: 'evil' },
    { id: 'custom-' },
    { id: 'custom-Bad' },
    custom('custom-x'.padEnd(60, 'x'), 'Long'),
  ]);
  assert.deepEqual(
    m.all.map((a) => a.id),
    ['omp', 'claude', 'codex', 'custom-codex'],
  );
  assert.deepEqual(
    m.enabled.map((a) => a.id),
    ['claude', 'codex', 'custom-codex'],
  );
  assert.equal(m.all[3].letter, 'C');
  const bare = AC.mergeRegistry([custom('custom-a', 'A')]);
  assert.deepEqual(
    bare.all.map((a) => a.id),
    ['omp', 'claude', 'codex', 'custom-a'],
    'a list that omits the built-ins keeps them, on',
  );
  for (const bad of [null, undefined, 'x', {}, 42])
    assert.deepEqual(
      AC.mergeRegistry(bad).enabled.map((a) => a.id),
      ['omp', 'claude', 'codex'],
    );
});

test('mergeRegistry: a user agent cannot take over a built-in id or its name display', () => {
  const m = AC.mergeRegistry([{ id: 'claude', name: 'Totally Claude', builtin: false, enabled: true }]);
  assert.equal(m.all.find((a) => a.id === 'claude').name, 'Claude Code');
  assert.equal(m.all.length, 3);
});

test('setRegistry updates AGENTS in place; disabled agents leave the list but keep their name', () => {
  reset();
  const held = AC.AGENTS;
  AC.setRegistry([custom('custom-codex', 'Codex'), { id: 'claude', enabled: false }]);
  assert.equal(held, AC.AGENTS, 'other modules can hold the array');
  assert.deepEqual(
    AC.AGENTS.map((a) => a.id),
    ['omp', 'codex', 'custom-codex'],
  );
  assert.equal(AC.isAgent('claude'), false);
  assert.equal(AC.nameOf('claude'), 'Claude Code', 'an old chat with a turned-off agent still shows its name');
  assert.equal(AC.nameOf('custom-codex'), 'Codex');
  assert.equal(AC.nameOf('custom-removed'), 'custom-removed');
  assert.equal(AC.other('omp'), 'codex');
  assert.equal(AC.resolveAgent('claude'), 'omp');
  reset();
});

test('with every agent turned off the New chat list is never empty', () => {
  reset();
  AC.setRegistry([
    { id: 'omp', enabled: false },
    { id: 'claude', enabled: false },
    { id: 'codex', enabled: false },
  ]);
  assert.deepEqual(
    AC.AGENTS.map((a) => a.id),
    ['omp'],
  );
  reset();
});

// ---- defaults --------------------------------------------------------------------------------------------------------
test('a project default beats the global default, which beats the browser memory', () => {
  reset();
  AC.setRegistry([custom('custom-codex', 'Codex')]);
  const store = memory();
  const proj = 'C:\\Repos\\App';
  AC.saveChoice(store, 'claude', proj);
  assert.equal(AC.loadChoice(store, proj), 'claude', 'browser memory is still the fallback');
  AC.setDefaults({ agent: 'custom-codex' });
  assert.equal(AC.loadChoice(store, proj), 'custom-codex', 'the global default wins over memory');
  AC.setDefaults({ agent: 'custom-codex', projects: { [AC.projectKey(proj)]: { agent: 'omp' } } });
  assert.equal(AC.loadChoice(store, proj), 'omp');
  assert.equal(AC.loadChoice(store, 'C:\\Other'), 'custom-codex');
  AC.setDefaults({ agent: 'custom-gone', projects: { [AC.projectKey(proj)]: { agent: 'custom-gone' } } });
  assert.equal(AC.loadChoice(store, proj), 'claude', 'a default naming an agent that is gone is ignored');
  reset();
});

test('defaultPicks: project pick when it names this agent, else the agent default', () => {
  reset();
  const key = AC.projectKey('C:/Repos/App');
  AC.setDefaults({
    byAgent: { omp: { model: 'gm', mode: 'gmode' } },
    projects: { [key]: { agent: 'claude', model: 'opus', mode: '' } },
  });
  assert.deepEqual(AC.defaultPicks('C:/Repos/App', 'claude'), { model: 'opus', mode: '' });
  assert.deepEqual(
    AC.defaultPicks('C:/Repos/App', 'omp'),
    { model: 'gm', mode: 'gmode' },
    'the project pick belongs to another agent',
  );
  assert.deepEqual(AC.defaultPicks('', 'omp'), { model: 'gm', mode: 'gmode' });
  AC.setDefaults({ projects: { [key]: { agent: '', model: 'any' } } });
  assert.equal(
    AC.defaultPicks('C:/Repos/App', 'omp').model,
    'any',
    'a project pick with no agent applies to whichever agent is chosen',
  );
  AC.setDefaults('junk');
  assert.deepEqual(AC.defaultPicks('x', 'omp'), { model: '', mode: '' });
  reset();
});

test('saveChoice reports the project agent to Settings; a failing sink does not break the memory', () => {
  reset();
  const seen = [];
  AC.setSink((id, key) => seen.push([id, key]));
  const store = memory();
  AC.saveChoice(store, 'claude', 'C:/Repos/App');
  AC.saveChoice(store, 'omp', '');
  assert.deepEqual(seen, [['claude', AC.projectKey('C:/Repos/App')]], 'no folder, nothing to remember per project');
  AC.setSink(() => {
    throw new Error('offline');
  });
  assert.equal(AC.saveChoice(store, 'omp', 'C:/Repos/App'), true);
  assert.equal(store.getItem(AC.STORAGE_KEY), 'omp');
  reset();
});

test('legacyPatch carries the per-project memory over once, bounded and validated', () => {
  const map = {};
  for (let i = 0; i < 80; i++) map['p:/proj' + i] = 'claude';
  map['p:/bad'] = 'rm -rf';
  const patch = AC.legacyPatch(
    memory({ 'studio-new-chat-agent-by-project': JSON.stringify(map), 'studio-new-chat-agent': 'claude' }),
  );
  assert.equal(patch.migrated, true);
  assert.ok(Object.keys(patch.projects).length <= 50);
  assert.ok(!('p:/bad' in patch.projects));
  assert.ok(!('agent' in patch), 'the browser-wide last pick stays a fallback and is not turned into a fixed default');
  assert.deepEqual(AC.legacyPatch(memory()), { migrated: true });
  assert.deepEqual(AC.legacyPatch(null), { migrated: true });
});

// ---- load / save wiring ----------------------------------------------------------------------------------------------
function wired(data, seed) {
  reset();
  const calls = { get: [], post: [] };
  let current = data;
  globalThis.localStorage = memory(seed);
  S._state.host = {
    get: async (p) => {
      calls.get.push(p);
      if (current instanceof Error) throw current;
      return JSON.parse(JSON.stringify(current));
    },
    post: async (name, body) => {
      calls.post.push([name, body]);
      if (S._state.reject) throw new Error(S._state.reject);
      current = { ...current, revision: current.revision + 'x' };
      return { ...current, ok: true };
    },
    registryChanged: () => {
      calls.changed = (calls.changed || 0) + 1;
    },
  };
  S._state.data = null;
  S._state.rev = '';
  return calls;
}
const payload = (over = {}) => ({
  revision: 'r1',
  warning: '',
  settings: {
    defaults: { agent: '', byAgent: {}, projects: {}, migrated: true },
    server: { autoReconnect: true },
    agents: {},
  },
  agents: [
    { id: 'omp', enabled: true, builtin: true },
    { id: 'claude', enabled: true, builtin: true },
    custom('custom-codex', 'Codex'),
  ],
  ...over,
});

test('load applies the server list and defaults to the page registry', async () => {
  const calls = wired(
    payload({
      settings: { ...payload().settings, defaults: { agent: 'claude', byAgent: {}, projects: {}, migrated: true } },
    }),
  );
  const data = await S.load();
  assert.equal(data.revision, 'r1');
  assert.deepEqual(
    AC.AGENTS.map((a) => a.id),
    ['omp', 'claude', 'codex', 'custom-codex'],
  );
  assert.equal(AC.getDefaults().agent, 'claude');
  assert.equal(calls.changed, 1, 'the page redraws its New chat form');
  assert.deepEqual(calls.get, ['/api/live/settings']);
  assert.deepEqual(calls.post, [], 'already migrated: nothing is written');
});

test('load keeps the built-ins when the server cannot be read', async () => {
  const calls = wired(new Error('offline'));
  assert.equal(await S.load(), null);
  assert.deepEqual(
    AC.AGENTS.map((a) => a.id),
    ['omp', 'claude', 'codex'],
  );
  assert.match(S._state.loadError, /offline/);
  assert.equal(calls.post.length, 0);
});

test('the first load moves the old browser memory into Settings, once', async () => {
  const key = AC.projectKey('C:/Repos/App');
  const calls = wired(
    payload({
      settings: { ...payload().settings, defaults: { agent: '', byAgent: {}, projects: {}, migrated: false } },
    }),
    { 'studio-new-chat-agent-by-project': JSON.stringify({ [key]: 'claude' }) },
  );
  await S.load();
  assert.equal(calls.post.length, 1);
  assert.deepEqual(calls.post[0], [
    'settings',
    { defaults: { migrated: true, projects: { [key]: { agent: 'claude' } } } },
  ]);
  await S.load();
  assert.equal(calls.post.length, 1, 'not repeated in this page');
});

test('sync reloads only when the revision changed', async () => {
  const calls = wired(payload());
  await S.load();
  await S.sync('r1');
  await S.sync('');
  await S.sync(undefined);
  assert.equal(calls.get.length, 1);
  await S.sync('r2');
  assert.equal(calls.get.length, 2);
});

test('remember writes the project default once per change and ignores empty projects', async () => {
  const key = AC.projectKey('C:/Repos/App');
  const calls = wired(payload());
  await S.load();
  S.remember('claude', '');
  S.remember('claude', key);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls.post, [['settings', { defaults: { projects: { [key]: { agent: 'claude' } } } }]]);
  assert.deepEqual(
    S._state.data.settings.defaults.projects,
    {},
    'the fake server did not store it, so a second call would post again',
  );
});

test('a refused save keeps the server message and rejects', async () => {
  wired(payload());
  await S.load();
  S._state.reject = 'Command was not found';
  await assert.rejects(() => S._state.host.post('settings', {}), /not found/);
  S._state.reject = '';
});

// ---- command bar and sheet -------------------------------------------------------------------------------------------
test('Settings is a command-bar action with Ctrl+, and appears in the shortcut sheet', () => {
  const ctx = {
    chat: null,
    menu: new Set(),
    projects: [],
    keys: {},
    do: {
      openSettings() {
        this.ran = true;
      },
    },
  };
  const action = Cmd.buildActions(ctx).find((a) => a.id === 'settings');
  assert.ok(action);
  assert.equal(action.shortcut, 'Ctrl+,');
  action.run();
  assert.equal(ctx.do.ran, true);
  assert.ok(
    Cmd.compose({ actions: Cmd.buildActions(ctx), chats: [], projects: [] }, 'settings', 'all').some(
      (r) => r.id === 'settings',
    ),
  );
  assert.ok(
    !Cmd.buildActions({ do: {} }).some((a) => a.id === 'settings'),
    'hidden on a page without the Settings module',
  );
  const rows = Cmd.sheetModel(ctx).flatMap((g) => g.rows);
  assert.ok(rows.some((r) => r.keys === 'Ctrl+,' && r.label === 'Settings'));
});

// ---- hidden environment values ----------------------------------------------------------------------------------------
test('toggling an agent sends an enable-only patch, never its command, arguments or environment', () => {
  assert.deepEqual(S.togglePatch('custom-fake', false), { agents: { enabled: { 'custom-fake': false } } });
  assert.deepEqual(S.togglePatch('codex', true), { agents: { enabled: { codex: true } } });
});

test('editing starts with names only; a blank value keeps the stored one, a typed one replaces it', () => {
  const rows = S.envRowsFrom([{ name: 'TOKEN', set: true }, { name: 'OTHER', set: true }, null, { value: 'x' }]);
  assert.deepEqual(rows, [
    { name: 'TOKEN', set: true, value: '' },
    { name: 'OTHER', set: true, value: '' },
  ]);
  rows[1].value = 'new-value';
  rows.push({ name: 'FRESH', set: false, value: '' }, { name: '  ', set: false, value: '' });
  assert.deepEqual(S.envForSave(rows), [
    { name: 'TOKEN' },
    { name: 'OTHER', value: 'new-value' },
    { name: 'FRESH', value: '' },
  ]);
  assert.deepEqual(S.envRowsFrom(undefined), []);
});

test('restart note: the app says quit and start again; a source run names the deno deploy command; no Python programs', () => {
  const app = S.serverRestartText(true);
  const source = S.serverRestartText(false);
  assert.match(app, /quit AIB \(tray icon > Quit AIB\) and start it again/);
  assert.match(source, /deno run -A outputs\/agent-studio\/server\/main\.ts deploy/);
  for (const text of [app, source]) assert.doesNotMatch(text, /\.py\b|python/i);
});
