'use strict';
// Settings -> Agents: the Status column (Ready / Needs sign-in / Not checked), the Sign in button, "Waiting for sign-in…" with Cancel,
// and the New chat gating. The login itself runs in the agent host; these tests only drive the page against a fake server.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { page, load } = require('./fake_dom.js');
const AC = require(path.join(__dirname, '..', 'outputs', 'agent-studio', 'agent-choice.js'));

function setup(agents) {
  const shell = page();
  const ctx = load(shell, ['settings-ui.js']);
  const UI = ctx.AgentSettingsUI;
  const calls = [];
  const replies = {
    settings: () => ({ revision: 'r', settings: { defaults: {} }, agents }),
    status: () => ({ state: 'ready', job: { state: 'idle' } }),
    'agents/signin': () => ({ state: 'signin', job: { state: 'waiting', message: '', command: '' } }),
    'agents/signin/cancel': () => ({ state: 'idle' }),
    'agents/signin/check': () => ({ ok: true, agents: {} }),
  };
  UI._state.host = {
    get: async (path, params) => {
      calls.push(JSON.parse(JSON.stringify(['get', path, params])));
      return path === '/api/live/settings' ? replies.settings() : replies.status();
    },
    post: async (name, body) => {
      calls.push(JSON.parse(JSON.stringify(['post', name, body])));
      return replies[name](body);
    },
  };
  return { ctx, UI, calls, replies };
}
const agent = (state, extra = {}) => ({
  id: 'claude',
  name: 'Claude Code',
  letter: 'C',
  builtin: true,
  enabled: true,
  found: true,
  launcher: "AIB's own install",
  launcherSource: 'studio',
  problem: '',
  installable: true,
  install: null,
  status: '',
  signin: { state, checkedAt: 1, job: null },
  ...extra,
});
const buttons = (row) => row.querySelectorAll('button').map((b) => b.textContent);
const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

test('the Status column says Ready, Needs sign-in or Not checked, and only Needs sign-in has a Sign in button', () => {
  const { UI } = setup([]);
  const ready = UI.agentRow(agent('ready'));
  assert.match(ready.textContent, /Ready/);
  assert.deepEqual(buttons(ready), ['Check again']);
  const needs = UI.agentRow(agent('signin'));
  assert.match(needs.textContent, /Needs sign-in/);
  assert.deepEqual(buttons(needs), ['Sign in', 'Check again']);
  assert.equal(needs.querySelector('button').className, 'st-primary');
  const unknown = UI.agentRow(agent('unknown'));
  assert.match(unknown.textContent, /Not checked/);
  assert.deepEqual(buttons(unknown), ['Check again'], 'Not checked has no Sign in button');
});

test('an agent that is not installed has no status and no Sign in button', () => {
  const { UI } = setup([]);
  const row = UI.agentRow(
    agent('signin', { found: false, signin: null, launcherSource: 'missing', problem: 'Not installed' }),
  );
  assert.doesNotMatch(row.textContent, /Needs sign-in/);
  assert.ok(!buttons(row).includes('Sign in'));
});

test('Sign in posts the agent and the row shows "Waiting for sign-in…" with Cancel only', async () => {
  const { UI, calls } = setup([agent('signin')]);
  const a = agent('signin');
  UI.agentRow(a).querySelector('button').click();
  await flush();
  assert.deepEqual(calls[0], ['post', 'agents/signin', { agent: 'claude' }]);
  const row = UI.agentRow(a);
  assert.match(row.textContent, /Waiting for sign-in…/);
  assert.deepEqual(buttons(row), ['Cancel']);
  assert.doesNotMatch(row.textContent, /Needs sign-in/);
  assert.match(row.textContent, /does not see your password/);
});

test('it polls while waiting and re-reads the list when the process has ended', async () => {
  const { UI, ctx, calls, replies } = setup([agent('signin')]);
  const a = agent('signin');
  UI.agentRow(a).querySelector('button').click();
  await flush();
  replies.status = () => ({ state: 'signin', job: { state: 'waiting', message: '', command: '' } });
  ctx.runTimers();
  await flush();
  assert.deepEqual(calls.at(-1), ['get', '/api/live/agents/signin', { agent: 'claude' }]);
  assert.match(UI.agentRow(a).textContent, /Waiting for sign-in…/, 'still waiting');
  replies.status = () => ({ state: 'ready', job: { state: 'done', message: '', command: '' } });
  replies.settings = () => ({ revision: 'r2', settings: { defaults: {} }, agents: [agent('ready')] });
  ctx.runTimers();
  await flush();
  await flush();
  const row = UI.agentRow(UI._state.data.agents[0]);
  assert.match(row.textContent, /Ready/);
  assert.deepEqual(buttons(row), ['Check again']);
});

test('Cancel posts the cancel and the row goes back to Needs sign-in', async () => {
  const { UI, calls } = setup([agent('signin')]);
  const a = agent('signin');
  UI.agentRow(a).querySelector('button').click();
  await flush();
  UI.agentRow(a).querySelector('button').click();
  await flush();
  await flush();
  assert.deepEqual(
    calls.find((c) => c[1] === 'agents/signin/cancel'),
    ['post', 'agents/signin/cancel', { agent: 'claude' }],
  );
  assert.deepEqual(buttons(UI.agentRow(UI._state.data.agents[0])), ['Sign in', 'Check again']);
});

test('a failed sign-in shows one line and the Sign in button stays', async () => {
  const failed = { state: 'failed', message: 'The sign-in did not finish (it ended with code 3). Try again.' };
  const { UI } = setup([agent('signin', { signin: { state: 'signin', checkedAt: 1, job: failed } })]);
  await UI.load();
  const row = UI.agentRow(UI._state.data.agents[0]);
  assert.match(row.textContent, /it ended with code 3/);
  assert.deepEqual(buttons(row), ['Sign in', 'Check again']);
});

test('on macOS and Linux the command is shown instead', async () => {
  const manual = {
    state: 'manual',
    message: 'Run this in a terminal.',
    command: 'node adapter.js --cli auth login --claudeai',
  };
  const { UI } = setup([agent('signin', { signin: { state: 'signin', checkedAt: 1, job: manual } })]);
  await UI.load();
  const row = UI.agentRow(UI._state.data.agents[0]);
  assert.match(row.textContent, /--cli auth login --claudeai/);
});

test('a page loaded while a sign-in waits (web restart) shows it and keeps polling', async () => {
  const waiting = { state: 'waiting', message: '', command: '' };
  const { UI, ctx, calls } = setup([agent('signin', { signin: { state: 'signin', checkedAt: 1, job: waiting } })]);
  await UI.load();
  assert.deepEqual(buttons(UI.agentRow(UI._state.data.agents[0])), ['Cancel']);
  ctx.runTimers();
  await flush();
  assert.ok(calls.some((c) => c[1] === '/api/live/agents/signin'));
});

test('the status is refreshed by Check again and by opening Settings, never by loading the list', async () => {
  const { UI, calls } = setup([agent('unknown')]);
  await UI.load();
  await UI.load(true);
  assert.equal(
    calls.filter((c) => c[1] === 'agents/signin/check').length,
    0,
    'a settings poll or reload does not run the check',
  );
  await UI.checkSignins(false);
  assert.deepEqual(
    calls.find((c) => c[1] === 'agents/signin/check'),
    ['post', 'agents/signin/check', { force: false }],
  );
  UI.agentRow(UI._state.data.agents[0])
    .querySelectorAll('button')
    .find((b) => b.textContent === 'Check again')
    .click();
  await flush();
  assert.deepEqual(calls.filter((c) => c[1] === 'agents/signin/check').at(-1), [
    'post',
    'agents/signin/check',
    { force: true },
  ]);
});

test('nothing is checked when no installed agent reports a sign-in state', async () => {
  const { UI, calls } = setup([agent('unknown', { signin: null, found: false })]);
  await UI.load();
  await UI.checkSignins(false);
  assert.equal(calls.filter((c) => c[1] === 'agents/signin/check').length, 0);
});

test('new chats offer installed agents that are Ready or Not checked, never Needs sign-in', () => {
  const ids = () => AC.AGENTS.map((a) => a.id);
  const row = (id, found, state) => ({ id, found, signin: state ? { state } : null });
  AC.setRegistry([row('omp', true), row('claude', true, 'signin'), row('codex', true, 'unknown')]);
  assert.deepEqual(ids(), ['omp', 'codex'], 'Needs sign-in is hidden, Not checked stays');
  assert.ok(
    AC.ALL.some((a) => a.id === 'claude'),
    'Settings still lists it',
  );
  assert.equal(AC.isAgent('claude'), false);
  AC.setRegistry([row('omp', true), row('claude', true, 'ready'), row('codex', true, 'ready')]);
  assert.deepEqual(ids(), ['omp', 'claude', 'codex']);
  AC.setRegistry([row('omp', true), row('claude', false, 'ready'), row('codex', true, 'signin')]);
  assert.deepEqual(ids(), ['omp'], 'not installed and Needs sign-in are both hidden');
  AC.setRegistry([row('omp', true), row('claude', true), row('codex', true)]);
  assert.deepEqual(ids(), ['omp', 'claude', 'codex'], 'an agent with no status at all is offered');
  AC.setRegistry([]);
});
