'use strict';
const { APP: APP_DIR } = require('./_paths');
// Settings -> Agents: the Install / Cancel / Retry row of Claude Code and Codex (the installer job itself runs in the agent host).
const test = require('node:test');
const assert = require('node:assert/strict');
const { page, load } = require('./fake_dom.js');

function setup(agents) {
  const shell = page();
  const ctx = load(shell, ['settings-ui.js']);
  const UI = ctx.AgentSettingsUI;
  const calls = [];
  const replies = {
    settings: () => ({ revision: 'r', settings: { defaults: {} }, agents }),
    status: () => ({ state: 'idle' }),
  };
  UI._state.host = {
    get: async (path, params) => {
      calls.push(JSON.parse(JSON.stringify(['get', path, params])));
      return path === '/api/live/settings' ? replies.settings() : replies.status();
    },
    post: async (name, body) => {
      calls.push(JSON.parse(JSON.stringify(['post', name, body])));
      return replies[name] ? replies[name](body) : { state: 'running', stage: 'preparing', percent: 2 };
    },
  };
  return { ctx, UI, calls, replies, shell };
}
const agent = (extra = {}) => ({
  id: 'codex',
  name: 'Codex',
  letter: 'X',
  builtin: true,
  enabled: true,
  found: false,
  launcher: 'Not installed',
  launcherSource: 'missing',
  problem: 'The Codex app is on this PC, but AIB needs its ACP adapter.',
  packageBytes: 300000000,
  installable: true,
  install: null,
  ...extra,
});
const buttons = (row) => row.querySelectorAll('button').map((b) => b.textContent);
const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

test('a missing agent has an Install button and keeps the "needs its adapter" text', () => {
  const { UI } = setup([agent()]);
  const row = UI.agentRow(agent());
  assert.deepEqual(buttons(row), ['Install']);
  assert.equal(row.querySelector('button').className, 'st-primary');
  assert.match(row.textContent, /Not installed/);
  assert.match(row.textContent, /The Codex app is on this PC, but AIB needs its ACP adapter\./);
  assert.doesNotMatch(row.textContent, /npm i/);
  assert.doesNotMatch(row.textContent, /Launcher/, 'no Not installed launcher line under the Not installed badge');
});

test('rows that cannot be installed have no Install button: found, OMP, a broken launcher', () => {
  const { UI } = setup([]);
  assert.deepEqual(buttons(UI.agentRow(agent({ found: true, problem: '', launcherSource: 'installed' }))), []);
  assert.deepEqual(buttons(UI.agentRow(agent({ installable: false }))), []);
  assert.deepEqual(
    buttons(UI.agentRow(agent({ launcherSource: 'settings' }))),
    [],
    'a launcher saved in Settings wins; installing would not change it',
  );
  assert.match(UI.agentRow(agent({ found: true, problem: '', launcherSource: 'studio' })).textContent, /Ready/);
  assert.match(UI.agentRow(agent({ found: true, problem: '', launcherSource: 'installed' })).textContent, /Found/);
});

test('Install posts the agent, shows a progress bar with Cancel, and polls the status', async () => {
  const { UI, ctx, calls, replies } = setup([agent()]);
  const a = agent();
  UI.agentRow(a).querySelector('button').click();
  await flush();
  assert.deepEqual(calls[0], ['post', 'agents/install', { agent: 'codex' }]);
  let row = UI.agentRow(a);
  assert.deepEqual(buttons(row), ['Cancel']);
  const bar = row.querySelector('.st-progress');
  assert.equal(bar.attrs.role, 'progressbar');
  assert.equal(bar.attrs['aria-valuenow'], '2');
  assert.match(row.textContent, /Getting ready/);
  assert.doesNotMatch(row.textContent, /Not installed/, 'the status chip is replaced by the progress while working');
  replies.status = () => ({ state: 'running', stage: 'downloading', percent: 60 });
  ctx.runTimers();
  await flush();
  assert.deepEqual(calls.at(-1), ['get', '/api/live/agents/install', { agent: 'codex' }]);
  row = UI.agentRow(a);
  assert.equal(row.querySelector('.st-progress').attrs['aria-valuenow'], '60');
  assert.equal(row.querySelector('.st-progress-bar').style.width, '60%');
  assert.match(row.textContent, /Installing the ACP adapter… about \d+ seconds/);
});

test('when the install finishes the list is read again and the row shows Ready', async () => {
  const { UI, ctx, calls, replies } = setup([agent()]);
  const a = agent();
  UI.agentRow(a).querySelector('button').click();
  await flush();
  replies.status = () => ({ state: 'done', stage: 'done', percent: 100 });
  replies.settings = () => ({
    revision: 'r2',
    settings: { defaults: {} },
    agents: [agent({ found: true, problem: '', launcherSource: 'studio', launcher: 'Studio install' })],
  });
  ctx.runTimers();
  await flush();
  await flush();
  assert.ok(
    calls.some((c) => c[1] === '/api/live/settings'),
    'settings are loaded again',
  );
  const row = UI.agentRow(UI._state.data.agents[0]);
  assert.match(row.textContent, /Ready/);
  assert.deepEqual(buttons(row), []);
});

test('Cancel posts the cancel, and the row goes back to Install', async () => {
  const { UI, calls, replies } = setup([agent()]);
  const a = agent();
  UI.agentRow(a).querySelector('button').click();
  await flush();
  replies['agents/install/cancel'] = () => ({ state: 'idle' });
  UI.agentRow(a).querySelector('button').click();
  await flush();
  await flush();
  assert.deepEqual(
    calls.find((c) => c[1] === 'agents/install/cancel'),
    ['post', 'agents/install/cancel', { agent: 'codex' }],
  );
  assert.deepEqual(buttons(UI.agentRow(UI._state.data.agents[0])), ['Install']);
});

test('a failure shows one line and Retry; Retry starts again', async () => {
  const failed = {
    state: 'failed',
    stage: '',
    percent: 30,
    message: 'Could not reach the npm registry. Check the internet connection and try again.',
  };
  const { UI, calls, replies } = setup([agent({ install: failed })]);
  await UI.load();
  const a = UI._state.data.agents[0];
  const row = UI.agentRow(a);
  assert.match(row.textContent, /Install failed/);
  assert.match(row.textContent, /Could not reach the npm registry/);
  assert.deepEqual(buttons(row), ['Retry']);
  replies['agents/install'] = () => ({ state: 'running', stage: 'preparing', percent: 2, attached: false });
  row.querySelector('button').click();
  await flush();
  assert.deepEqual(calls.at(-1), ['post', 'agents/install', { agent: 'codex' }]);
  assert.deepEqual(buttons(UI.agentRow(a)), ['Cancel']);
});

test('a refusal is shown as one plain line with Retry', async () => {
  const { UI, replies } = setup([agent()]);
  replies['agents/install'] = () => {
    throw new Error(
      'Node.js 22 or newer is needed to install Codex; this PC has Node.js 20.11.0. Update Node.js and try again.',
    );
  };
  const a = agent();
  UI.agentRow(a).querySelector('button').click();
  await flush();
  const row = UI.agentRow(a);
  assert.match(row.textContent, /this PC has Node\.js 20\.11\.0/);
  assert.deepEqual(buttons(row), ['Retry']);
});

test('a page loaded while a job runs (after a web restart) shows the progress and keeps polling', async () => {
  const running = { state: 'running', stage: 'downloading', percent: 45 };
  const { UI, ctx, calls } = setup([agent({ install: running })]);
  await UI.load();
  const row = UI.agentRow(UI._state.data.agents[0]);
  assert.deepEqual(buttons(row), ['Cancel']);
  assert.equal(row.querySelector('.st-progress').attrs['aria-valuenow'], '45');
  ctx.runTimers();
  await flush();
  assert.ok(
    calls.some((c) => c[1] === '/api/live/agents/install'),
    'it polls the job',
  );
});

test('agentRow is exported for a later start page', () => {
  const { UI } = setup([]);
  assert.equal(typeof UI.agentRow, 'function');
});

const lines = (row) => row.querySelectorAll('.st-note').map((n) => n.textContent);

// Node.js missing or too old (an intended change from "no Install"): the card says what it needs, like a Beta card.
const NODE = (state, version = '') => ({
  id: 'node',
  name: 'Node.js',
  need: 'Node.js 22 or newer',
  state,
  version,
  min: '22',
  command: 'winget install -e --id OpenJS.NodeJS.LTS',
  installLabel: 'Install Node.js 26 (LTS)',
  page: 'https://nodejs.org/en/download',
  source: '',
});
const nodeSetup = (state, version) => ({
  kind: 'npm',
  command: '',
  source: '',
  uninstallDocs: '',
  prereqs: [NODE(state, version)],
  blockedBy: state === 'found' ? '' : 'Install Node.js first',
});

test('Node missing or too old: Install shows but is off, "Install Node.js first" under the header, Needs first with its installer', async () => {
  const block = 'Node.js 22 or newer is needed to install this agent.';
  const missing = agent({ installBlock: block, setup: nodeSetup('missing') });
  const { UI, calls, replies } = setup([missing]);
  const row = UI.agentRow(missing);
  assert.deepEqual(buttons(row), ['Install', 'Install Node.js 26 (LTS)', 'Check again']);
  const install = row.querySelector('.st-agent-head').querySelector('.st-primary');
  assert.equal([install.textContent, install.disabled].join(), 'Install,true');
  assert.equal(row.querySelector('.st-beta-blocked').textContent, 'Install Node.js first');
  assert.equal(row.querySelector('.st-beta-need-text').textContent, 'Node.js 22 or newer: missing');
  assert.equal(
    row.querySelector('.st-beta-need').querySelector('code').textContent,
    'winget install -e --id OpenJS.NodeJS.LTS',
  );
  assert.ok(!row.textContent.includes(block), 'the old grey line is replaced by Needs first');
  const old = UI.agentRow(agent({ installBlock: block, setup: nodeSetup('old', '20.11.1') }));
  assert.equal(old.querySelector('.st-beta-need-text').textContent, 'Node.js 22 or newer: too old (20.11.1)');
  assert.equal(calls.length, 0, 'nothing was posted');
  replies.settings = () => ({
    revision: 'r',
    settings: { defaults: {} },
    agents: [agent({ setup: nodeSetup('found', '26.13.1') })],
  });
  row
    .querySelectorAll('button')
    .find((b) => b.textContent === 'Check again')
    .click();
  await flush();
  assert.deepEqual(calls.at(-1), ['get', '/api/live/settings', { recheck: '1' }]);
  const ready = UI.agentRow(UI._state.data.agents[0]);
  assert.deepEqual(buttons(ready), ['Install']);
  assert.equal(ready.querySelector('.st-primary').disabled, false);
  assert.equal(ready.querySelector('.st-beta-needs'), null, 'Node.js found: no list on a built-in card');
});

test("Install Node.js on a built-in card runs in the card's terminal (prereq:node); after exit 0 the check runs again", async () => {
  const missing = agent({ installBlock: 'x', setup: nodeSetup('missing') });
  const { UI, ctx, calls, replies } = setup([missing]);
  UI._state.data = { agents: [missing] };
  const runs = [];
  ctx.AibTerminal = { runSetup: (view, id, step, h) => (runs.push([id, step, h]), { close() {} }) };
  UI.agentRow(missing)
    .querySelectorAll('button')
    .find((b) => b.textContent === 'Install Node.js 26 (LTS)')
    .click();
  assert.deepEqual(
    runs.map((r) => [r[0], r[1]]),
    [['codex', 'prereq:node']],
  );
  replies.settings = () => ({
    revision: 'r',
    settings: { defaults: {} },
    agents: [agent({ setup: nodeSetup('found', '26.13.1') })],
  });
  runs[0][2].onExit(0);
  await flush();
  await flush();
  const after = calls.slice(-2);
  assert.deepEqual(
    after,
    [
      ['get', '/api/live/settings', { recheck: '1' }],
      ['post', 'terminal/end', { key: 'setup:codex' }],
    ],
    'checked again (PATH re-read), then Node.js found: the panel closes',
  );
});

test('a failure line wins over the block and the adapter text; only one line shows', () => {
  const { UI } = setup([]);
  const failed = { state: 'failed', message: 'The install failed.' };
  const row = UI.agentRow(
    agent({ install: failed, installBlock: 'Node.js 22 or newer is needed to install this agent.' }),
  );
  assert.deepEqual(lines(row), ['The install failed.']);
  assert.deepEqual(lines(UI.agentRow(agent())), ['The Codex app is on this PC, but AIB needs its ACP adapter.']);
});

test('the npm hint shows only when installs cannot run at all, and names the right package', () => {
  const { UI } = setup([]);
  const text = UI.agentRow(
    agent({
      installBlock: 'Node.js 22 or newer is needed to install this agent.',
      installHint: 'Or install it yourself with: npm i -g @agentclientprotocol/codex-acp',
    }),
  ).textContent;
  assert.match(text, /@agentclientprotocol\/codex-acp/);
  assert.doesNotMatch(text, /zed-industries/);
});

test('progress copy: an estimate from packageBytes, none when the size is unknown', () => {
  const { UI } = setup([]);
  const running = { state: 'running', stage: 'downloading', percent: 0 };
  const withSize = UI.agentRow(agent({ install: running })).querySelectorAll('.st-note')[0].textContent;
  assert.equal(withSize, 'Installing the ACP adapter… about 60 seconds');
  const unknown = UI.agentRow(agent({ install: running, packageBytes: 0 })).querySelectorAll('.st-note')[0].textContent;
  assert.equal(unknown, 'Installing the ACP adapter…');
});

test('settings.css: the installer rules use theme tokens, no raw hex', () => {
  const css = require('node:fs').readFileSync(require('node:path').join(APP_DIR, 'settings.css'), 'utf8');
  const start = css.indexOf('.st-agent-head button {');
  assert.ok(start > 0);
  assert.doesNotMatch(css.slice(start), /#[0-9a-fA-F]{3,8}/);
});

// ---- Uninstall: only AIB's own install, only in Settings, confirmed first ----

const studioRow = (extra = {}) =>
  agent({ found: true, problem: '', launcherSource: 'studio', launcher: "AIB's own install 2.6.0", ...extra });

test('Uninstall is offered in Settings only for the copy AIB installed itself', () => {
  const { UI } = setup([]);
  const settings = { sharedBlock: true, uninstall: true };
  assert.ok(buttons(UI.agentRow(studioRow(), settings)).includes('Uninstall'));
  assert.equal(
    UI.agentRow(studioRow(), settings)
      .querySelectorAll('button')
      .find((b) => b.textContent === 'Uninstall').className,
    'st-danger',
  );
  for (const source of ['installed', 'path', 'settings', 'flag', 'missing']) {
    assert.ok(!buttons(UI.agentRow(studioRow({ launcherSource: source }), settings)).includes('Uninstall'), source);
  }
  assert.ok(
    !buttons(UI.agentRow(studioRow({ installable: false }), settings)).includes('Uninstall'),
    'OMP is never installed by AIB',
  );
  assert.ok(!buttons(UI.agentRow(studioRow({ builtin: false }), settings)).includes('Uninstall'));
  assert.ok(
    !buttons(UI.agentRow(studioRow(), { sharedBlock: true })).includes('Uninstall'),
    'the start page draws no Uninstall',
  );
  const running = studioRow({ install: { state: 'running', stage: 'downloading', percent: 40 } });
  assert.deepEqual(buttons(UI.agentRow(running, settings)), ['Cancel'], 'not while an install runs');
});

test('Uninstall asks first; Cancel in the question sends nothing', async () => {
  const { UI, ctx, calls } = setup([studioRow()]);
  const asked = [];
  ctx.confirm = (text) => (asked.push(text), false);
  UI.agentRow(studioRow(), { uninstall: true })
    .querySelectorAll('button')
    .find((b) => b.textContent === 'Uninstall')
    .click();
  await flush();
  assert.equal(asked.length, 1);
  assert.match(asked[0], /^Uninstall Codex\?/);
  assert.match(asked[0], /deletes the copy AIB installed/);
  assert.deepEqual(
    calls.filter((c) => c[1] === 'agents/install/uninstall'),
    [['post', 'agents/install/uninstall', { agent: 'codex', check: true }]],
    'only the refusal check was asked; nothing was uninstalled',
  );
});

test('Uninstall confirmed: posts the agent, then reads the list again', async () => {
  const { UI, ctx, calls, replies } = setup([studioRow()]);
  ctx.confirm = () => true;
  replies['agents/install/uninstall'] = () => ({ state: 'idle', removed: ['2.6.0'] });
  replies.settings = () => ({ revision: 'r2', settings: { defaults: {} }, agents: [agent()] });
  UI.agentRow(studioRow(), { uninstall: true })
    .querySelectorAll('button')
    .find((b) => b.textContent === 'Uninstall')
    .click();
  await flush();
  await flush();
  const posts = calls.filter((c) => c[1] === 'agents/install/uninstall');
  assert.deepEqual(posts, [
    ['post', 'agents/install/uninstall', { agent: 'codex', check: true }],
    ['post', 'agents/install/uninstall', { agent: 'codex' }],
  ]);
  const after = calls.findIndex((c) => c[1] === 'agents/install/uninstall' && !c[2].check);
  assert.ok(
    calls.slice(after).some((c) => c[1] === '/api/live/settings'),
    'the list is read again',
  );
  assert.deepEqual(buttons(UI.agentRow(UI._state.data.agents[0], { uninstall: true })), ['Install'], 'back to Install');
});

test("a refused Uninstall (a chat is open) shows the server's line on the row", async () => {
  const { UI, ctx, replies } = setup([studioRow()]);
  ctx.confirm = () => true;
  replies['agents/install/uninstall'] = () => {
    throw new Error('Codex has a chat open in AIB. Close it first (wait for any work to finish), then uninstall.');
  };
  UI.agentRow(studioRow(), { uninstall: true })
    .querySelectorAll('button')
    .find((b) => b.textContent === 'Uninstall')
    .click();
  await flush();
  const row = UI.agentRow(studioRow(), { uninstall: true });
  assert.match(row.textContent, /Codex has a chat open in AIB\. Close it first/);
  assert.ok(buttons(row).includes('Uninstall'), 'it can be tried again');
});

test('a refusal the server can know comes before the question, which is then never asked (QA 4 #4)', async () => {
  const { UI, ctx, calls, replies } = setup([studioRow()]);
  const asked = [];
  ctx.confirm = (text) => (asked.push(text), true);
  replies['agents/install/uninstall'] = (body) => {
    if (body.check) throw new Error("Codex has a chat open in AIB. End that chat's session first, then uninstall.");
    throw new Error('never sent');
  };
  UI.agentRow(studioRow(), { uninstall: true })
    .querySelectorAll('button')
    .find((b) => b.textContent === 'Uninstall')
    .click();
  await flush();
  assert.deepEqual(asked, [], 'no confirm question for something that cannot happen');
  assert.ok(!calls.some((c) => c[1] === 'agents/install/uninstall' && !c[2].check));
  assert.match(UI.agentRow(studioRow(), { uninstall: true }).textContent, /End that chat's session first/);
});

test('a host that does not know the check (404) still asks and uninstalls', async () => {
  const { UI, ctx, calls, replies } = setup([studioRow()]);
  ctx.confirm = () => true;
  replies['agents/install/uninstall'] = (body) => {
    if (body.check) throw Object.assign(new Error('Not found'), { status: 404 });
    return { state: 'idle', removed: ['2.6.0'] };
  };
  UI.agentRow(studioRow(), { uninstall: true })
    .querySelectorAll('button')
    .find((b) => b.textContent === 'Uninstall')
    .click();
  await flush();
  await flush();
  assert.ok(calls.some((c) => c[1] === 'agents/install/uninstall' && !c[2].check));
});

test('an uninstall refusal goes away once its cause is gone: the list reload asks again (QA 4 #3)', async () => {
  const { UI, ctx, replies } = setup([studioRow()]);
  ctx.confirm = () => true;
  let open = true;
  replies['agents/install/uninstall'] = (body) => {
    if (open) throw new Error('Codex has a chat open in AIB.');
    return body.check ? { state: 'idle', removed: [] } : { state: 'idle', removed: ['2.6.0'] };
  };
  UI.agentRow(studioRow(), { uninstall: true })
    .querySelectorAll('button')
    .find((b) => b.textContent === 'Uninstall')
    .click();
  await flush();
  assert.match(UI.agentRow(studioRow(), { uninstall: true }).textContent, /has a chat open/);
  open = false; // the chat was ended
  await UI.load(true);
  await flush();
  assert.doesNotMatch(
    UI.agentRow(studioRow(), { uninstall: true }).textContent,
    /has a chat open/,
    'stale refusal cleared',
  );
});

test("the question's promise about saved chats matches the agent: Claude Code keeps them in the list, Codex does not (QA 4 #4)", async () => {
  for (const [id, name, want, not] of [
    ['claude', 'Claude Code', /Saved chats stay in the list\./, /shows them only/],
    [
      'codex',
      'Codex',
      /Codex keeps its own saved chats, but AIB shows them only while they are open here\./,
      /stay in the list/,
    ],
  ]) {
    const a = studioRow({ id, name });
    const { UI, ctx } = setup([a]);
    const asked = [];
    ctx.confirm = (text) => (asked.push(text), false);
    UI.agentRow(a, { uninstall: true })
      .querySelectorAll('button')
      .find((b) => b.textContent === 'Uninstall')
      .click();
    await flush();
    assert.match(asked[0], want, name);
    assert.doesNotMatch(asked[0], not, name);
  }
});

test('Settings page: one name for the agents page, the full version, an Updates card that keeps its heading, the layout frame (QA 4 #1, #5, #13, #16)', async () => {
  const shell = page();
  const ctx = load(shell, ['updates-ui.js', 'settings-ui.js']);
  const UI = ctx.AgentSettingsUI;
  const get = async (p) => {
    if (p === '/api/live/settings') return { revision: 'r', settings: { defaults: {}, server: {} }, agents: [] };
    if (p === '/api/live/bootstrap')
      return { server: { version: '0.1.0-beta.2', versionLabel: 'AIB 0.1.0 beta' }, stateDir: 'C:/x' };
    if (p === '/api/live/update') return { state: 'none', current: '0.1.0-beta.2', desktop: true, configured: true };
    return {};
  };
  UI.init({ get, post: async () => ({}), registryChanged() {} });
  ctx.AibUpdates.init({ get, post: async () => ({}) }, null);
  const pageNode = shell.body.querySelector('.st-page');
  assert.ok(
    pageNode.querySelector('.st-frame').querySelector('.st-nav'),
    'nav and settings sit in the frame the size container query lays out',
  );
  UI.open('agents');
  await flush();
  assert.equal(
    pageNode.querySelector('.st-head').querySelector('h2').textContent,
    'AIB Linking',
    'the heading is the nav name (owner: AIB Linking)',
  );
  UI.open('server');
  await flush();
  await flush();
  assert.match(pageNode.textContent, /AIB 0\.1\.0-beta\.2/, 'the full version, beta number included');
  assert.doesNotMatch(pageNode.textContent, /AIB 0\.1\.0 beta(?!\.)/);
  const updates = pageNode.querySelectorAll('.st-card').find((c) => c.querySelector('.st-updates'));
  assert.ok(updates, 'the Updates card');
  ctx.AibUpdates.refresh && (await ctx.AibUpdates.refresh());
  assert.equal(updates.querySelector('h3').textContent, 'Updates', 'a redraw of the card keeps its heading');
});
