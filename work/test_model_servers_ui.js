'use strict';
// Settings > Model servers (settings-ui.js renderModelServers) and what it feeds: the always-visible row icons (Check, Edit, Remove),
// the Use with switches, the key box that never shows a key back, the read-only "Also on model servers" line on the Claude card, the
// Maki / Qwen Code cards pointing here, and New chat greying the entries of a server that does not answer (agent-choice.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { page, load } = require('./fake_dom.js');

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));
const plain = (x) => JSON.parse(JSON.stringify(x));
const KEY = 'test-key-not-real-9f31';

const builtin = (id, name, extra = {}) => ({
  id,
  name,
  letter: name[0],
  builtin: true,
  enabled: true,
  found: true,
  launcher: name + ' on PATH',
  launcherSource: 'path',
  problem: '',
  ...extra,
});
const serverEntry = (id, name) => ({
  id: 'claude@' + id,
  name: 'Claude Code · ' + name,
  letter: 'C',
  builtin: false,
  modelServer: true,
  serverId: id,
  enabled: true,
  found: true,
  launcher: 'x',
  launcherSource: 'model-server',
  problem: '',
  signin: null,
});
const SERVER = {
  id: 'strata',
  name: 'strata',
  url: 'http://127.0.0.1:8080',
  model: 'qwen-b',
  useWith: ['claude'],
  keySet: true,
  keyStorage: 'Sealed with Windows DPAPI',
  wslNote: '',
};
const UP = {
  ...SERVER,
  reachable: true,
  models: ['qwen-a', 'qwen-b'],
  kinds: ['anthropic', 'chat'],
  needsKey: false,
  keyRefused: false,
  error: '',
  down: '',
};
const DOWN = { ...SERVER, reachable: false, models: [], kinds: [], needsKey: false, keyRefused: false, error: 'Cannot reach the model server at http://127.0.0.1:8080 (refused).', down: 'strata is not answering at 127.0.0.1:8080' };

async function open(opts = {}) {
  const servers = opts.servers || [SERVER];
  const health = opts.health || [UP];
  const agents = opts.agents || [
    builtin('omp', 'OMP'),
    builtin('claude', 'Claude Code', { alsoOnServers: servers.filter((s) => s.useWith.includes('claude')).map((s) => s.name) }),
    builtin('codex', 'Codex'),
    ...servers.filter((s) => s.useWith.includes('claude')).map((s) => serverEntry(s.id, s.name)),
  ];
  const shell = page();
  shell.document.contains = (n) => shell.body.contains(n);
  shell.document.createElementNS = (ns, tag) => shell.document.createElement(tag);
  const ctx = load(shell, ['agent-choice.js', 'settings-ui.js']);
  const UI = ctx.AgentSettingsUI;
  const posts = [];
  const gets = [];
  const data = () => ({
    revision: 'r1',
    warning: '',
    settings: { defaults: { migrated: true, projects: {}, byAgent: {} } },
    agents,
    modelServers: servers,
  });
  let registry = 0;
  UI.init({
    get: async (path, params) => {
      gets.push([path, params || null]);
      if (path === '/api/live/settings') return data();
      if (path === '/api/live/model-servers') return { servers: health };
      return {};
    },
    post: async (name, body) => {
      posts.push([name, body]);
      if (name === 'model-servers/check') return opts.check || { reachable: true, models: ['qwen-a'], kinds: ['anthropic'], needsKey: false };
      return data();
    },
    registryChanged() {
      registry++;
    },
  });
  UI.open(opts.section || 'servers');
  await flush();
  await flush();
  const card = () => shell.body.querySelectorAll('section.st-card').find((c) => (c.querySelector('h3') || {}).textContent === 'Model servers');
  const row = () => card().querySelectorAll('.ms-row')[0];
  return { shell, ctx, UI, posts, gets, card, row, registry: () => registry };
}

test('Model servers is its own section right under AIB Linking (WSL), searchable by what people type for it', async () => {
  const { UI } = await open();
  const ids = UI.SECTIONS.map((s) => s.id);
  assert.deepEqual(plain(ids.slice(0, 3)), ['agents', 'wsl', 'servers']);
  assert.equal(UI.SECTIONS.find((s) => s.id === 'servers').label, 'Model servers');
  const hits = (q) => UI.filterIndex(UI.INDEX, q).map((e) => e.id);
  for (const q of ['strata', 'ollama', 'lm studio', 'base url', 'api address', 'use with']) assert.ok(hits(q).includes('model-servers'), q);
});

test('a server row: name, address, status, the three row icons always visible, Speaks, model choice, key box, Use with', async () => {
  const { card, row } = await open();
  assert.ok(/local/.test(card().textContent) && /works|any agent/.test(card().textContent), 'says it is local and works across agents');
  const r = row();
  assert.equal(r.querySelector('strong').textContent, 'strata');
  assert.equal(r.querySelector('.st-tag').textContent, 'http://127.0.0.1:8080');
  assert.equal(r.querySelector('.st-status').textContent, 'Answering');
  // small row icons, plain buttons (no hover menu, no popup): each has a label
  const icons = r.querySelectorAll('button').filter((b) => b.classList.contains('ms-icon'));
  assert.deepEqual(plain(icons.map((b) => b.getAttribute('aria-label'))), ['Check strata again', 'Edit strata', 'Remove strata']);
  assert.ok(icons.every((b) => b.title === b.getAttribute('aria-label')));
  assert.equal(r.querySelector('.ms-speaks').textContent, 'Speaks: Anthropic Messages · Chat Completions');
  // the model choice comes from the server's list
  const sel = r.querySelector('select');
  assert.deepEqual(plain(sel.children.map((o) => o.value)), ['', 'qwen-a', 'qwen-b']);
  assert.equal(sel.value, 'qwen-b');
  // the key: a password field that never holds or shows the stored key
  const key = r.querySelector('.st-beta-key').querySelector('input');
  assert.equal(key.type, 'password');
  assert.equal(key.value, '');
  assert.equal(key.placeholder, '•••• (stored)');
  // Use with: one switch per agent that works today; no Codex switch
  const boxes = r.querySelector('.ms-use').querySelectorAll('input');
  assert.deepEqual(plain(boxes.map((b) => [b.dataset.useWith, b.checked, b.disabled])), [['claude', true, false], ['maki', false, false], ['qwen', false, false]]);
  assert.ok(!/Codex/.test(r.querySelector('.ms-use').textContent), 'Codex has no switch until codex@ entries exist');
  assert.ok(/Adds "Claude Code · strata" to New chat/.test(r.querySelector('.ms-use').textContent));
});

test('a switch that the server does not support is greyed with the reason; the others work', async () => {
  const responses = { ...UP, kinds: ['responses'] };
  const { row } = await open({ health: [responses], servers: [{ ...SERVER, useWith: [] }] });
  const boxes = row().querySelector('.ms-use').querySelectorAll('input');
  assert.deepEqual(plain(boxes.map((b) => [b.dataset.useWith, b.disabled])), [['claude', true], ['maki', true], ['qwen', true]]);
  assert.ok(/Claude Code needs a server that speaks Anthropic Messages/.test(row().querySelector('.ms-use').textContent));
  assert.ok(/Qwen Code needs a server that speaks Chat Completions/.test(row().querySelector('.ms-use').textContent));
});

test('Use with: a switch saves {useWith} for that server and nothing else', async () => {
  const { row, posts } = await open();
  const maki = row().querySelector('.ms-use').querySelectorAll('input')[1];
  maki.checked = true;
  maki.dispatch('change');
  await flush();
  assert.deepEqual(plain(posts.at(-1)), ['settings', { agents: { modelServer: { upsert: { id: 'strata', useWith: ['claude', 'maki'] } } } }]);
  const claude = row().querySelector('.ms-use').querySelectorAll('input')[0];
  claude.checked = false;
  claude.dispatch('change');
  await flush();
  assert.deepEqual(plain(posts.at(-1)), ['settings', { agents: { modelServer: { upsert: { id: 'strata', useWith: [] } } } }]);
});

test('the model choice and the key save through the settings patch; the typed key is not kept on the page afterwards', async () => {
  const { row, posts, shell } = await open();
  const sel = row().querySelector('select');
  sel.value = 'qwen-a';
  sel.dispatch('change');
  await flush();
  assert.deepEqual(plain(posts.at(-1)), ['settings', { agents: { modelServer: { upsert: { id: 'strata', model: 'qwen-a' } } } }]);
  const box = row().querySelector('.st-beta-key');
  const input = box.querySelector('input');
  input.value = KEY;
  input.dispatch('input');
  box.querySelectorAll('button').find((b) => b.textContent === 'Save key').click();
  await flush();
  await flush();
  assert.deepEqual(plain(posts.find((p) => p[1].agents && p[1].agents.modelServer && p[1].agents.modelServer.upsert.key)), [
    'settings',
    { agents: { modelServer: { upsert: { id: 'strata', key: KEY } } } },
  ]);
  const after = row().querySelector('.st-beta-key').querySelector('input');
  assert.equal(after.value, '', 'the field is empty again');
  assert.ok(!shell.body.textContent.includes(KEY), 'the key is nowhere on the page');
  // Remove key
  row().querySelector('.st-beta-key').querySelectorAll('button').find((b) => b.textContent === 'Remove key').click();
  await flush();
  assert.deepEqual(plain(posts.find((p) => p[1].agents && p[1].agents.modelServer && p[1].agents.modelServer.upsert.key === null)[1]), { agents: { modelServer: { upsert: { id: 'strata', key: null } } } });
});

test('Check, Edit and Remove are row icons: Check asks the server, Edit opens the form in the row, Remove asks inline first', async () => {
  const { row, posts } = await open();
  const icon = (label) => row().querySelectorAll('button').find((b) => b.getAttribute('aria-label') === label);
  icon('Check strata again').click();
  await flush();
  await flush();
  assert.deepEqual(plain(posts.find((p) => p[0] === 'model-servers/check')), ['model-servers/check', { id: 'strata' }]);
  // Edit: name and address in the row; Save posts only those
  icon('Edit strata').click();
  const form = row().querySelector('.ms-form');
  const [name, url] = form.querySelectorAll('input');
  assert.equal(name.value, 'strata');
  assert.equal(url.value, 'http://127.0.0.1:8080');
  name.value = 'strata 2';
  name.dispatch('input');
  url.value = 'http://127.0.0.1:9090';
  url.dispatch('input');
  form.querySelectorAll('button').find((b) => b.textContent === 'Save').click();
  await flush();
  assert.deepEqual(plain(posts.find((p) => p[0] === 'settings' && p[1].agents.modelServer.upsert.url)[1]), {
    agents: { modelServer: { upsert: { id: 'strata', url: 'http://127.0.0.1:9090', name: 'strata 2' } } },
  });
  // Remove: nothing happens until the inline question is answered; Keep puts it away
  const count = posts.length;
  icon('Remove strata').click();
  assert.ok(/Remove strata\?/.test(row().textContent));
  row().querySelectorAll('button').find((b) => b.textContent === 'Keep').click();
  assert.equal(posts.length, count, 'Keep sends nothing');
  icon('Remove strata').click();
  row().querySelectorAll('button').filter((b) => b.textContent === 'Remove').at(-1).click();
  await flush();
  assert.deepEqual(plain(posts.at(-1)), ['settings', { agents: { modelServer: { remove: 'strata' } } }]);
});

test('Add a model server: asks the server once, picks its first model and switches Claude Code on when it speaks Anthropic Messages', async () => {
  const { card, posts } = await open({ servers: [], health: [], check: { reachable: true, models: ['m-1', 'm-2'], kinds: ['anthropic', 'chat'], needsKey: false } });
  assert.ok(/No model servers yet/.test(card().textContent));
  card().querySelectorAll('button').find((b) => b.textContent === 'Add a model server').click();
  const form = card().querySelector('.ms-form');
  const [name, url, key] = form.querySelectorAll('input');
  assert.equal(key.type, 'password');
  name.value = 'strata';
  name.dispatch('input');
  url.value = 'http://127.0.0.1:8080';
  url.dispatch('input');
  key.value = KEY;
  key.dispatch('input');
  form.querySelectorAll('button').find((b) => b.textContent === 'Add').click();
  await flush();
  await flush();
  assert.deepEqual(plain(posts[0]), ['model-servers/check', { url: 'http://127.0.0.1:8080', key: KEY }]);
  assert.deepEqual(plain(posts[1]), [
    'settings',
    { agents: { modelServer: { upsert: { url: 'http://127.0.0.1:8080', name: 'strata', key: KEY, useWith: ['claude'], model: 'm-1' } } } },
  ]);
});

test('Add: a server that does not speak Anthropic Messages starts with no switch on; an empty address is refused on the page', async () => {
  const { card, posts } = await open({ servers: [], health: [], check: { reachable: true, models: ['m-1'], kinds: ['chat'], needsKey: false } });
  card().querySelectorAll('button').find((b) => b.textContent === 'Add a model server').click();
  card().querySelector('.ms-form').querySelectorAll('button').find((b) => b.textContent === 'Add').click();
  await flush();
  assert.equal(posts.length, 0, 'nothing is sent without an address');
  assert.ok(/Type the server address/.test(card().textContent));
  const url = card().querySelector('.ms-form').querySelectorAll('input')[1];
  url.value = 'http://127.0.0.1:1234';
  url.dispatch('input');
  card().querySelector('.ms-form').querySelectorAll('button').find((b) => b.textContent === 'Add').click();
  await flush();
  await flush();
  assert.deepEqual(plain(posts[1][1].agents.modelServer.upsert), { url: 'http://127.0.0.1:1234', useWith: [], model: 'm-1' });
});

test('a server that does not answer: status "Not answering", the plain line, and nothing started or stopped by AIB', async () => {
  const { row } = await open({ health: [DOWN] });
  assert.equal(row().querySelector('.st-status').textContent, 'Not answering');
  const down = row().querySelector('.ms-down').textContent;
  assert.ok(down.includes('strata is not answering at 127.0.0.1:8080'), down);
  assert.ok(/never starts or stops your server/.test(down), down);
  // needs a key / key refused
  const needs = await open({ health: [{ ...UP, needsKey: true }], servers: [{ ...SERVER, keySet: false }] });
  assert.equal(needs.row().querySelector('.st-status').textContent, 'Needs a key');
  const refused = await open({ health: [{ ...UP, keyRefused: true }] });
  assert.equal(refused.row().querySelector('.st-status').textContent, 'Key refused');
});

test('the Claude card carries one read-only line; the server entry is not drawn as a card; Maki and Qwen Code point here', async () => {
  const { shell } = await open({ section: 'agents' });
  const agentsCard = shell.body.querySelectorAll('section.st-card').find((c) => (c.querySelector('h3') || {}).textContent === 'Agents');
  const names = agentsCard.querySelectorAll('.st-agent').map((r) => r.querySelector('strong').textContent);
  assert.deepEqual(plain(names), ['Claude Code', 'Codex', 'OMP'], 'no card for Claude Code · strata');
  const claude = agentsCard.querySelectorAll('.st-agent')[0];
  assert.ok(claude.querySelector('.st-also-servers').textContent.startsWith('Also on model servers: strata'));
  assert.equal(claude.querySelector('.st-also-servers').querySelector('button').textContent, 'Model servers');
  assert.equal(agentsCard.querySelectorAll('.st-agent')[1].querySelector('.st-also-servers'), null, 'only agents that are on a server');
  // the link goes to the section
  claude.querySelector('.st-also-servers').querySelector('button').click();
  await flush();
  assert.ok(shell.body.querySelectorAll('section.st-card').some((c) => (c.querySelector('h3') || {}).textContent === 'Model servers'));
});

test('New chat: a server that does not answer greys its entry with the reason, in the Model servers group after the tested agents', async () => {
  const { UI, ctx, gets, registry } = await open({ health: [DOWN], section: 'agents' });
  await UI.checkServers();
  await flush();
  assert.ok(gets.some((g) => g[0] === '/api/live/model-servers'), 'asked when New chat opens');
  const AC = ctx.AgentChoice;
  const rows = AC.menuRows();
  const entry = rows.find((r) => r.value === 'claude@strata');
  assert.deepEqual(plain([entry.disabled, entry.group, entry.reason, entry.server]), [true, 'Model servers', 'strata is not answering at 127.0.0.1:8080', true]);
  assert.ok(rows.findIndex((r) => r.value === 'claude@strata') > rows.findIndex((r) => r.value === 'codex'));
  assert.ok(!AC.AGENTS.some((a) => a.id === 'claude@strata'), 'not pickable');
  assert.equal(AC.setupTarget(), '', 'the Set up in Settings link has nothing to open for a server: start it');
  assert.ok(registry() > 0, 'the New chat form is told');
});

test('New chat: a server that answers is a normal entry in the Model servers group', async () => {
  const { UI, ctx } = await open({ health: [UP], section: 'agents' });
  await UI.checkServers();
  await flush();
  const rows = ctx.AgentChoice.menuRows();
  const entry = rows.find((r) => r.value === 'claude@strata');
  assert.deepEqual(plain([!!entry.disabled, entry.group, entry.name]), [false, 'Model servers', 'Claude Code · strata']);
});
