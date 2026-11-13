'use strict';
// Settings > AIB server > "Keep this PC awake while AIB runs" (settings-ui.js renderKeepAwake): one switch, off by default, the
// help text, a save of server.keepAwake on change, and an error line when the OS refused the request.
const test = require('node:test');
const assert = require('node:assert/strict');
const { page, load } = require('./fake_dom.js');

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));
const HELP =
  'Stops sleep while AIB is open, so agents keep working and your phone can reach AIB. The screen can still turn off. Closing a laptop lid still sleeps the PC.';

async function openServer(keepAwake, status) {
  const shell = page();
  shell.document.contains = (n) => shell.body.contains(n);
  const ctx = load(shell, ['agent-choice.js', 'settings-ui.js']);
  const UI = ctx.AgentSettingsUI;
  const posts = [];
  let server = { keepAwake };
  let kStatus = status;
  const view = () => ({
    revision: 'r' + posts.length,
    warning: '',
    settings: { defaults: { migrated: true, projects: {}, byAgent: {} }, server },
    agents: [],
    keepAwake: kStatus,
  });
  UI.init({
    get: async () => view(),
    post: async (name, body) => {
      posts.push([name, body]);
      if (body.server && 'keepAwake' in body.server) {
        server = { ...server, keepAwake: body.server.keepAwake };
        kStatus = { on: body.server.keepAwake, active: body.server.keepAwake, error: '', backend: 'x' };
      }
      return { ...view(), ok: true };
    },
    registryChanged() {},
  });
  UI.open('server');
  await flush();
  await flush();
  const card = () => shell.body.querySelectorAll('section.st-card').find((c) => c.querySelector('h3').textContent === 'Keep the PC awake');
  return { shell, UI, posts, card };
}

test('the switch is in the AIB server section, off by default, with the help text', async () => {
  const { card, UI } = await openServer(undefined, { on: false, active: false, error: '', backend: 'x' });
  const c = card();
  assert.ok(c, 'a "Keep the PC awake" card');
  assert.equal(c.querySelector('.st-toggle').querySelector('span').textContent, 'Keep this PC awake while AIB runs');
  assert.equal(c.querySelector('.st-toggle').querySelector('input').checked, false);
  assert.ok(c.querySelectorAll('.st-note').some((n) => n.textContent === HELP));
  assert.equal(c.querySelectorAll('.st-note.bad').length, 0, 'no error line when all is well');
  assert.ok(UI.INDEX.some((e) => e.id === 'keep-awake' && e.section === 'server'));
  assert.ok(UI.filterIndex(UI.INDEX, 'sleep').some((e) => e.id === 'keep-awake'), 'found by searching "sleep"');
});

test('turning it on saves server.keepAwake and shows it on', async () => {
  const { card, posts } = await openServer(false, { on: false, active: false, error: '', backend: 'x' });
  const box = card().querySelector('.st-toggle').querySelector('input');
  box.checked = true;
  box.dispatch('change');
  await flush();
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(posts)), [['settings', { server: { keepAwake: true } }]]);
  assert.equal(card().querySelector('.st-toggle').querySelector('input').checked, true);
});

test('an OS refusal shows as an error line under the switch', async () => {
  const { card } = await openServer(true, { on: true, active: false, error: 'Windows refused the request (error 5)', backend: 'x' });
  const line = card().querySelector('.st-note.bad');
  assert.ok(line);
  assert.equal(line.textContent, 'The PC may still sleep: Windows refused the request (error 5)');
});
