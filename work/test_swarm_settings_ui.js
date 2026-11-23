'use strict';
// Settings > AIB Linking > "Helper agents" card (settings-ui.js renderSwarmHelpers): shows what the server says, the help line,
// and a save of swarm.enabled on change (the server keeps it in swarm-settings.json).
const test = require('node:test');
const assert = require('node:assert/strict');
const { page, load } = require('./fake_dom.js');

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));
const HELP =
  'Let a chat start helper agents (Codex, Gemini, Claude Code, or a model server like strata), each in its own copy of the project. You merge their work.';

const shellText = (n) => n.textContent || '';

async function open(swarm) {
  const shell = page();
  shell.document.contains = (n) => shell.body.contains(n);
  const ctx = load(shell, ['agent-choice.js', 'settings-ui.js']);
  const UI = ctx.AgentSettingsUI;
  const posts = [];
  let state = swarm;
  const view = () => ({
    revision: 'r' + posts.length,
    warning: '',
    settings: { defaults: { migrated: true, projects: {}, byAgent: {} }, server: {} },
    agents: [],
    swarm: state,
  });
  UI.init({
    get: async () => view(),
    post: async (name, body) => {
      posts.push([name, body]);
      if (body.swarm) state = { enabled: body.swarm.enabled };
      return { ...view(), ok: true };
    },
    registryChanged() {},
  });
  UI.open('agents');
  await flush();
  await flush();
  const card = () => shell.body.querySelectorAll('section.st-card').find((c) => c.querySelector('h3').textContent === 'Helper agents');
  return { UI, posts, card };
}

test('the card is in AIB Linking, not Experimental: label, help line, search keywords, switch follows the server', async () => {
  const { card, UI } = await open({ enabled: true });
  const c = card();
  assert.ok(c, 'a "Helper agents" card');
  assert.equal(c.querySelector('.st-toggle').querySelector('span').textContent, 'Helpers from other agents');
  assert.equal(c.querySelector('.st-toggle').querySelector('input').checked, true, 'the server default (on) shows on');
  assert.ok(c.querySelectorAll('.st-note').some((n) => n.textContent === HELP));
  const entry = UI.INDEX.find((e) => e.id === 'swarm-helpers');
  assert.ok(entry);
  assert.equal(entry.section, 'agents');
  assert.ok(!/experimental/i.test(entry.label + ' ' + entry.keywords.join(' ')));
  for (const k of ['helpers', 'swarm', 'subagent', 'other agents']) assert.ok(entry.keywords.includes(k) || entry.keywords.includes(k.replace(/s$/, '')), k);
  assert.ok(!UI.SECTIONS || !UI.SECTIONS.some((s) => /experimental/i.test(s.label)));
  assert.ok(!/experimental/i.test(shellText(c)));
});

test('a saved off shows the switch off', async () => {
  const { card } = await open({ enabled: false });
  assert.equal(card().querySelector('.st-toggle').querySelector('input').checked, false);
});

test('turning it on saves swarm.enabled', async () => {
  const { card, posts } = await open({ enabled: false });
  const box = card().querySelector('.st-toggle').querySelector('input');
  box.checked = true;
  box.dispatch('change');
  await flush();
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(posts)), [['settings', { swarm: { enabled: true } }]]);
  assert.equal(card().querySelector('.st-toggle').querySelector('input').checked, true);
});
