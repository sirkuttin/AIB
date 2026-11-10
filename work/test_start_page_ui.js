'use strict';
// The first-run start page: shown only after Settings has loaded, only while no enabled agent is ready, swapped for the New chat
// form the moment one is, with a way out when every agent fails. Driven against a fake server and the fake DOM; no real agent runs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { page, load } = require('./fake_dom.js');
const { APP } = require('./_paths');

const row = (id, extra = {}) => ({
  id,
  name: { claude: 'Claude Code', codex: 'Codex', omp: 'OMP' }[id] || id,
  letter: id[0].toUpperCase(),
  builtin: true,
  enabled: true,
  found: false,
  launcher: '',
  launcherSource: 'missing',
  problem: 'Not installed',
  installable: id !== 'omp',
  install: null,
  installBlock: '',
  status: '',
  signin: null,
  ...extra,
});
const ready = (id, state) =>
  row(id, { found: true, launcherSource: 'studio', problem: '', signin: state ? { state, job: null } : null });
const NOTHING = () => [row('omp'), row('claude'), row('codex')];

function setup(agents, { newChat = true } = {}) {
  const shell = page({ ids: ['startPage'] });
  const ctx = load(shell, ['agent-choice.js', 'settings-ui.js', 'start-page-ui.js']);
  const UI = ctx.AgentSettingsUI,
    SP = ctx.StartPageUI;
  const calls = [];
  const state = { agents, fail: false };
  UI.init({
    get: async (p, params) => {
      calls.push(['get', p, params]);
      if (state.fail) throw new Error('down');
      return { revision: 'r' + calls.length, settings: { defaults: {} }, agents: state.agents };
    },
    post: async (name, body) => {
      calls.push(['post', name, body]);
      if (name === 'settings')
        return { revision: 'saved', settings: { defaults: { migrated: true } }, agents: state.agents };
      return { ok: true, agents: {} };
    },
    registryChanged() {},
  });
  shell.body.classList.toggle('new-chat', newChat);
  SP.init();
  return { shell, ctx, UI, SP, calls, state, box: shell.byId.startPage, body: shell.body };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 5));
const shows = (s) => s.body.classList.contains('start-page') && !s.box.hidden;

test('it shows only after the settings have loaded', async () => {
  const s = setup(NOTHING());
  assert.equal(shows(s), false, 'nothing is decided before /api/live/settings has returned');
  assert.equal(s.box.hidden, true);
  s.state.fail = true;
  await s.UI.load();
  assert.equal(shows(s), false, 'a settings list nobody could read never raises the page');
  s.state.fail = false;
  await s.UI.load();
  assert.equal(shows(s), true);
  assert.match(s.box.textContent, /Set up an agent to start chatting/);
  s.state.fail = true; // a restart: the last list stays, the page does not flash away or back
  await s.UI.load();
  assert.equal(shows(s), true);
});

test('it has the heading, the subtitle, the text, the footer and a See more agents link', async () => {
  const s = setup(NOTHING());
  await s.UI.load();
  const text = s.box.textContent;
  assert.match(text, /Every good administration starts with a cabinet\./);
  assert.match(
    text,
    /AIB talks to coding agents you already use\. Pick one: AIB installs what it needs, then you sign in with that agent's own account\./,
  );
  assert.match(
    text,
    /Once one agent is ready, this page is replaced by the normal new-chat screen\. You can add more agents any time in Settings → Agents\./,
  );
  const more = s.box.querySelectorAll('button').find((b) => b.textContent === 'See more agents');
  more.click();
  assert.equal(s.UI.isOpen(), true);
  assert.equal(s.UI._state.section, 'agents');
});

test('Not checked counts as ready: no page', async () => {
  for (const agents of [
    [row('omp'), ready('claude', 'unknown'), row('codex')],
    [row('omp'), ready('claude', null), row('codex')],
    [row('omp'), ready('claude', 'ready'), row('codex')],
  ]) {
    const s = setup(agents);
    await s.UI.load();
    assert.equal(shows(s), false);
  }
});

test('not installed, Needs sign-in and turned off all count as not ready; OMP and a custom agent can make it ready', async () => {
  let s = setup([row('omp'), ready('claude', 'signin'), row('codex', { enabled: false, found: true })]);
  await s.UI.load();
  assert.equal(shows(s), true);
  s = setup([ready('omp'), row('claude'), row('codex')]);
  await s.UI.load();
  assert.equal(shows(s), false, 'OMP found and enabled is ready');
  const custom = { id: 'custom-mine', name: 'Mine', letter: 'M', builtin: false, enabled: true, found: true };
  s = setup([...NOTHING(), custom]);
  await s.UI.load();
  assert.equal(shows(s), false, 'a custom agent that is found is ready');
  s = setup([...NOTHING(), { ...custom, found: false }]);
  await s.UI.load();
  assert.equal(shows(s), true);
});

test('the rows are the shared agentRow: Claude Code, Codex, then the other built-ins; Install and Sign in come from it', async () => {
  const s = setup([row('omp'), row('codex'), ready('claude', 'signin')]);
  const calls = [];
  const original = s.ctx.AgentSettingsUI.agentRow;
  s.ctx.AgentSettingsUI.agentRow = (a) => {
    calls.push(a.id);
    return original(a);
  };
  await s.UI.load();
  assert.deepEqual(calls.slice(0, 3), ['claude', 'codex', 'omp']);
  assert.deepEqual(
    s.UI.orderAgents(NOTHING()).map((a) => a.id),
    ['claude', 'codex', 'omp'],
    'Settings uses the same order',
  );
  const rows = s.box.querySelectorAll('.st-agent');
  assert.equal(rows.length, 3);
  const buttons = (r) => r.querySelectorAll('button').map((b) => b.textContent);
  assert.ok(buttons(rows[0]).includes('Sign in'));
  assert.ok(buttons(rows[1]).includes('Install'));
  const source = fs.readFileSync(path.join(APP, 'start-page-ui.js'), 'utf8');
  assert.doesNotMatch(source, /st-agent-head|st-progress-bar/, 'no copy of the row lives in the start page');
  assert.match(source, /\.agentRow\(/);
});

test('it swaps to the New chat form when an agent becomes ready, with no reload', async () => {
  const s = setup(NOTHING());
  await s.UI.load();
  assert.equal(shows(s), true);
  s.state.agents = [row('omp'), ready('claude', 'ready'), row('codex')];
  await s.UI.load();
  assert.equal(shows(s), false);
  assert.equal(s.box.hidden, true);
  assert.equal(s.box.children.length, 0);
  assert.equal(s.shell.document.activeElement, s.shell.byId.prompt || s.shell.document.activeElement);
});

test('an install that finishes on the page hands over by itself', async () => {
  const s = setup(NOTHING());
  await s.UI.load();
  s.state.agents = [row('omp'), ready('claude', null), row('codex')];
  const install = s.box.querySelectorAll('button').find((b) => b.textContent === 'Install');
  install.click(); // posts agents/install; the fake answers {ok}, which is not a running job
  await flush();
  await flush();
  assert.equal(shows(s), false);
});

test('it shows in a new-chat pane only, not over an open conversation', async () => {
  const s = setup(NOTHING(), { newChat: false });
  await s.UI.load();
  assert.equal(s.body.classList.contains('new-chat'), false);
  assert.equal(s.box.children.length, 0, 'an open conversation draws nothing');
  s.body.classList.add('new-chat'); // the focused pane is a new chat (chat.js then calls update)
  s.SP.update();
  assert.match(s.box.textContent, /Set up an agent/);
  s.body.classList.remove('new-chat');
  const css = fs.readFileSync(path.join(APP, 'start-page.css'), 'utf8');
  assert.match(css, /body\.new-chat\.start-page #startPage\s*\{\s*display: flex/);
  assert.match(css, /#startPage\s*\{\s*display: none/);
});

const allFail = () => [
  row('omp'),
  row('claude', { installBlock: 'Node.js 22 or newer is needed to install this agent.' }),
  row('codex', {
    installBlock: 'Node.js 22 or newer is needed to install this agent.',
    installHint: 'Or install it yourself with: npm i -g @agentclientprotocol/codex-acp',
  }),
];

test('when every agent fails there is a Node line, Check again, Use my own install and an add-by-hand link', async () => {
  const s = setup(allFail());
  await s.UI.load();
  assert.equal(shows(s), true);
  const stuck = s.box.querySelector('.sp-stuck');
  assert.ok(stuck);
  assert.equal(
    s.box.textContent.split('Node.js 22 or newer is needed').length - 1,
    1,
    'the Node.js line shows once for the page',
  );
  assert.match(stuck.textContent, /Use my own install/);
  assert.match(stuck.textContent, /npm i -g @agentclientprotocol\/claude-agent-acp/);
  assert.match(stuck.textContent, /npm i -g @agentclientprotocol\/codex-acp/);
  const names = stuck.querySelectorAll('button').map((b) => b.textContent);
  assert.deepEqual(names, ['Settings', 'add an agent by hand']);
  const before = s.calls.length;
  s.box
    .querySelectorAll('button')
    .find((b) => b.textContent === 'Check again')
    .click();
  await flush();
  assert.equal(s.calls.length - before, 1, 'one recheck, no retry loop');
  assert.deepEqual(JSON.parse(JSON.stringify(s.calls.at(-1))), ['get', '/api/live/settings', { recheck: '1' }]);
  s.box.querySelector('.sp-stuck').querySelectorAll('button')[0].click();
  assert.equal(s.UI.isOpen(), true);
  assert.equal(s.UI._state.section, 'agents');
  s.box.querySelector('.sp-stuck').querySelectorAll('button')[1].click();
  assert.ok(s.UI._state.form, 'the Add an ACP agent form is open');
});

test('a failed install on every agent still offers Settings and adding an agent, without a Node line', async () => {
  const failed = { install: { state: 'failed', message: 'npm failed' } };
  const s = setup([row('omp'), row('claude', failed), row('codex', failed)]);
  await s.UI.load();
  const stuck = s.box.querySelector('.sp-stuck');
  assert.ok(stuck);
  assert.doesNotMatch(stuck.textContent, /Node\.js/);
  assert.deepEqual(
    stuck.querySelectorAll('button').map((b) => b.textContent),
    ['Settings', 'add an agent by hand'],
  );
});

test('with an Install button still working there is no way-out panel yet', async () => {
  const s = setup(NOTHING());
  await s.UI.load();
  assert.equal(s.box.querySelector('.sp-stuck'), null);
});

test('chat.html loads the page module and keeps #startPage inside #chat', () => {
  const html = fs.readFileSync(path.join(APP, 'chat.html'), 'utf8');
  assert.ok(html.indexOf('src="/start-page-ui.js"') > html.indexOf('src="/settings-ui.js"'));
  assert.ok(html.indexOf('id="startPage"') > html.indexOf('<section id="chat"'));
  assert.ok(html.indexOf('id="startPage"') < html.indexOf('</section></main>'));
});

test('the header view switch is hidden while the start page shows and returns with the New chat form', () => {
  const css = fs.readFileSync(path.join(APP, 'start-page.css'), 'utf8');
  assert.match(css, /body\.new-chat\.start-page #viewSwitch\s*\{\s*display: none/);
});

test('an install that finishes runs the sign-in check at once and the page never paints Not checked in between', async () => {
  const s = setup(NOTHING());
  await s.UI.load();
  const painted = [];
  s.ctx.AgentSettingsUI.onChange(() => painted.push(s.box.textContent));
  const checked = [row('omp'), ready('claude', 'signin'), row('codex')];
  s.state.agents = [row('omp'), ready('claude', 'unknown'), row('codex')]; // what the list says right after the install
  const post = s.UI._state.host.post;
  s.UI._state.host.post = async (name, body) => {
    if (name === 'agents/install') return { state: 'idle' };
    if (name === 'agents/signin/check') s.state.agents = checked;
    return post(name, body);
  };
  s.box
    .querySelectorAll('button')
    .find((b) => b.textContent === 'Install')
    .click();
  for (let i = 0; i < 6; i++) await flush();
  assert.ok(
    s.calls.some((c) => c[0] === 'post' && c[1] === 'agents/signin/check'),
    'the sign-in status check ran',
  );
  assert.equal(shows(s), true, 'Needs sign-in keeps the start page');
  assert.match(s.box.textContent, /Needs sign-in/);
  assert.match(s.box.textContent, /Sign in/);
  assert.ok(
    painted.every((t) => !/Not checked/.test(t)),
    'no intermediate Not checked paint',
  );
});

test('the start page has the standard 16px side padding at narrow widths', () => {
  const css = fs.readFileSync(path.join(APP, 'start-page.css'), 'utf8');
  assert.match(css, /padding:\s*36px 16px 24px/);
  assert.match(css, /box-sizing:\s*border-box/);
});

test('a turned-off agent shows as Turned off with a Turn on button, never as ready (QA 4 #2)', async () => {
  const s = setup([row('claude', { enabled: false, found: true, launcherSource: 'studio', problem: '' }), row('codex'), row('omp')]);
  await s.UI.load();
  assert.equal(shows(s), true, 'an agent that is off does not count as set up');
  const claude = s.box.querySelectorAll('.st-agent').find((n) => /Claude Code/.test(n.textContent));
  assert.match(claude.textContent, /Turned off/);
  assert.doesNotMatch(claude.textContent, /Not checked|Found|Ready/, 'no readiness badge for an agent that is off');
  const on = claude.querySelectorAll('button').find((b) => b.textContent === 'Turn on');
  assert.ok(on, 'Turn on is offered on the start page');
  s.state.agents = [row('claude', { found: true, launcherSource: 'studio', problem: '' }), row('codex'), row('omp')];
  on.click();
  await flush();
  assert.deepEqual(
    JSON.parse(JSON.stringify(s.calls.find((c) => c[0] === 'post' && c[1] === 'settings' && c[2].agents))),
    ['post', 'settings', { agents: { enabled: { claude: true } } }],
    'on/off only',
  );
  assert.equal(shows(s), false, 'turned on and ready: the page hands over to New chat');
});

test('the Node.js line sits right under the agent that needs it, not after the list (QA 4 #19)', async () => {
  const block = 'Node.js 22 or newer is needed to install this agent.';
  const s = setup([row('claude', { installBlock: block }), row('codex', { installBlock: block }), row('omp')]);
  await s.UI.load();
  const kids = s.box.querySelector('.sp-agents').children;
  const at = kids.findIndex((n) => n.className && n.className.includes('sp-node'));
  assert.ok(at > 0, 'inside the agent list');
  assert.match(kids[at - 1].textContent, /Codex/, 'right after the last agent that needs Node.js');
  assert.equal(s.box.querySelectorAll('.sp-node').length, 1, 'once for the page');
});
