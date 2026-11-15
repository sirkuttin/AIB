'use strict';
// Settings > Agents > "Helpers from other agents (experimental)" (settings-ui.js renderSwarmHelpers): off by default, the help line,
// and a save of swarm.enabled on change (the server keeps it in swarm-settings.json).
const test = require('node:test');
const assert = require('node:assert/strict');
const { page, load } = require('./fake_dom.js');

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));
const HELP = "Lets a chat's agent start helper agents from other providers. Off by default while it's being finished.";

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

test('the switch is off by default, labelled, with the help line', async () => {
  const { card, UI } = await open(undefined);
  const c = card();
  assert.ok(c, 'a "Helper agents" card');
  assert.equal(c.querySelector('.st-toggle').querySelector('span').textContent, 'Helpers from other agents (experimental)');
  assert.equal(c.querySelector('.st-toggle').querySelector('input').checked, false);
  assert.ok(c.querySelectorAll('.st-note').some((n) => n.textContent === HELP));
  assert.ok(UI.INDEX.some((e) => e.id === 'swarm-helpers'));
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
