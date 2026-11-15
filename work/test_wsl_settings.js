'use strict';
const { APP: APP_DIR } = require('./_paths');
// Settings > AIB Linking (WSL) (wsl-settings-ui.js, docs/wsl/linking-design.md section 11), in the fake DOM with fake routes of
// the frozen contract: GET /api/live/wsl/status (wsl, skipped, isDefault), GET /api/live/wsl/agents?distro&peek=1[&start=1], and
// the install routes. Every state of the mockup that phase 1 draws, the Windows rows unchanged, the section only on Windows, no
// distro started by opening Settings, and Windows and Ubuntu installs of the same agent kept apart.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { page, load } = require('./fake_dom.js');

const settle = async () => {
  for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r));
};
const plain = (v) => JSON.parse(JSON.stringify(v));

const UBUNTU = { name: 'Ubuntu', key: 'ubuntu', state: 'ready', line: '', home: '/home/u', helper: '0.1.0-ab12cd34', problem: '', isDefault: true };
const DEBIAN = { name: 'Debian', key: 'debian', state: 'off', line: '', home: null, helper: null, problem: '', isDefault: false };
const DOCKER = { name: 'docker-desktop', why: "docker-desktop is Docker's own distro; AIB cannot run there." };
const WSL1 = { name: 'Ubuntu-20.04', why: 'Ubuntu-20.04 runs on WSL 1. AIB needs WSL 2.' };
const status = (distros, extra = {}) => Object.assign({ available: distros.length > 0, distros, openRequests: [], skipped: [], wsl: { exe: true, problem: '' } }, extra);

const CLAUDE = { id: 'claude', found: true, version: '0.102.0', installable: true, pinned: '0.102.0', managed: true, bundledCli: true };
const CODEX = { id: 'codex', found: true, version: '2.6.0', installable: true, pinned: '2.6.0', managed: false, bundledCli: false };
const OMP = { id: 'omp', found: false };
const READY_AGENTS = { distro: 'ubuntu', name: 'Ubuntu', agents: [CLAUDE, CODEX, OMP] };

// The Windows agents of AIB Linking (the On/Off switch every distro row follows).
const WIN = [
  { id: 'claude', name: 'Claude Code', letter: 'C', builtin: true, enabled: true, found: false, launcher: 'Not installed', launcherSource: 'missing', installable: true, packageBytes: 400000000 },
  { id: 'codex', name: 'Codex', letter: 'X', builtin: true, enabled: false, found: true, launcher: 'codex-acp', launcherSource: 'installed' },
  { id: 'omp', name: 'OMP', letter: 'O', builtin: true, enabled: true, found: false, launcher: 'Not installed', launcherSource: 'missing' },
];

/**
 * A page with wsl-ui.js, settings-ui.js and wsl-settings-ui.js. o.status: the WSL status; o.agents(params): the agent list answer;
 * o.install(name, body) / o.installGet(params): the install routes; o.stateDir: bootstrap's state folder (Windows by default).
 */
function setup(o = {}) {
  const shell = page();
  const ctx = load(shell, ['wsl-ui.js', 'settings-ui.js', 'wsl-settings-ui.js']);
  const calls = { gets: [], posts: [] };
  let current = o.status || status([UBUNTU]);
  const wslHost = {
    getJson: (p, params) => {
      calls.gets.push([p, plain(params || {})]);
      if (p === '/api/live/wsl/status') return Promise.resolve(plain(current));
      if (p === '/api/live/wsl/agents') {
        const r = o.agents ? o.agents(params || {}) : READY_AGENTS;
        return r instanceof Error ? Promise.reject(r) : Promise.resolve(plain(r));
      }
      if (p === '/api/live/wsl/agents/install') return Promise.resolve(plain(o.installGet ? o.installGet(params) : { state: 'idle' }));
      return Promise.resolve({});
    },
    postJson: (name, body) => {
      calls.posts.push([name, plain(body)]);
      const r = o.install ? o.install(name, body) : { state: 'running', stage: 'preparing', percent: 2 };
      return r instanceof Error ? Promise.reject(r) : Promise.resolve(plain(r || {}));
    },
    currentPath: () => '',
  };
  ctx.AIBWsl.init(wslHost);
  const settingsCalls = [];
  const replies = { winInstall: () => ({ state: 'running', stage: 'preparing', percent: 2 }), winStatus: () => ({ state: 'idle' }) };
  const UI = ctx.AgentSettingsUI;
  UI.init({
    get: async (p, params) => {
      settingsCalls.push(['get', p, plain(params || {})]);
      if (p === '/api/live/settings') return { revision: 'r', settings: { defaults: { migrated: true } }, agents: plain(o.win || WIN) };
      if (p === '/api/live/bootstrap') return { stateDir: o.stateDir || 'C:\\Users\\me\\AppData\\Local\\AgentStudio', server: {} };
      if (p === '/api/live/agents/install') return replies.winStatus();
      return {};
    },
    post: async (name, body) => {
      settingsCalls.push(['post', name, plain(body)]);
      if (name === 'agents/install') return replies.winInstall();
      if (name === 'agents/install/cancel') return { state: 'idle' };
      return {};
    },
  });
  const content = () => shell.document.querySelector('.st-content');
  const nav = () => shell.document.querySelectorAll('.st-section').map((b) => b.textContent);
  const rowOf = (key) => content().querySelectorAll('.st-agent').find((r) => r.dataset.agent === key) || null;
  const cardOf = (title) => content().querySelectorAll('.st-card').find((c) => c.querySelector('.st-card-title').textContent === title) || null;
  const agentCalls = () => calls.gets.filter(([p]) => p === '/api/live/wsl/agents').map(([, q]) => q);
  return { shell, ctx, UI, calls, settingsCalls, replies, content, nav, rowOf, cardOf, agentCalls, set: (s) => (current = s) };
}
const buttons = (n) => n.querySelectorAll('button').map((b) => b.textContent);
async function openWsl(t) {
  await settle();
  t.UI.open('wsl');
  await settle();
  await settle();
}

// ---- where the section shows ----------------------------------------------------------------------------------------------
test('the section is listed right under AIB Linking on a Windows AIB, and found by searching "ubuntu"', async () => {
  const t = setup();
  await openWsl(t);
  assert.deepEqual(t.nav().slice(0, 3), ['AIB Linking', 'AIB Linking (WSL)', 'Defaults']);
  assert.equal(t.shell.document.querySelector('h2').textContent, 'AIB Linking (WSL)');
  assert.ok(t.UI.filterIndex(t.UI.INDEX, 'ubuntu').some((e) => e.id === 'wsl-linking'));
  assert.ok(t.UI.filterIndex(t.UI.INDEX, 'distro').some((e) => e.id === 'wsl-linking'));
});

test('a Mac or Linux AIB has no AIB Linking (WSL): not listed, not in search results, opening it shows AIB Linking', async () => {
  const t = setup({ stateDir: '/home/me/.local/share/aib' });
  await settle();
  t.UI.open('agents');
  await settle();
  assert.ok(!t.nav().includes('AIB Linking (WSL)'));
  t.UI.open('wsl');
  await settle();
  assert.equal(t.shell.document.querySelector('h2').textContent, 'AIB Linking');
  t.UI._state.search.value = 'ubuntu';
  t.UI._state.search.dispatch('input');
  await settle();
  assert.ok(!t.content().querySelector('.wl-distro'), 'no WSL cards among the search results');
  assert.deepEqual(t.agentCalls(), [], 'nothing asked of a distro');
});

// ---- never start a distro by opening Settings ------------------------------------------------------------------------------
test('opening Settings asks the ready distro with peek=1 only, never a distro that is not running; Start and check sends start=1', async () => {
  const t = setup({
    status: status([UBUNTU, DEBIAN]),
    agents: (q) => (q.distro === 'debian' && !q.start ? { distro: 'debian', name: 'Debian', state: 'off', line: '', agents: [] } : q.distro === 'debian' ? { distro: 'debian', name: 'Debian', agents: [CLAUDE] } : READY_AGENTS),
  });
  await openWsl(t);
  assert.deepEqual(t.agentCalls(), [{ distro: 'ubuntu', peek: '1' }], 'one peek for the running distro, none for Debian');
  assert.ok(t.agentCalls().every((q) => !('start' in q)), 'no start parameter on open');
  // a second open of Settings within the minute asks nothing new
  t.UI.close();
  t.UI.open('wsl');
  await settle();
  assert.equal(t.agentCalls().length, 1);
  const deb = t.content().querySelectorAll('.st-card').find((c) => c.dataset.distro === 'debian');
  assert.equal(deb.querySelector('dd').textContent, 'Not running');
  assert.ok(deb.textContent.includes('Debian is not running. AIB starts it when a WSL project needs it.'));
  assert.ok(deb.textContent.includes('about 100 MB'), 'says what Start does: the helper copy');
  const go = deb.querySelectorAll('button').find((b) => b.textContent === 'Start Debian and check');
  assert.ok(go.title.includes('copies AIB\'s helper there the first time (about 100 MB'), go.title);
  go.click();
  await settle();
  assert.deepEqual(t.agentCalls().pop(), { distro: 'debian', peek: '1', start: '1' }, 'only the click asks to start it');
  assert.ok(t.calls.gets.filter(([p]) => p === '/api/live/wsl/status').length >= 2, 'the status is read again after the start');
});

test('a peek answer for a distro that is not ready never fills the new-chat panel cache', async () => {
  const t = setup({ agents: () => ({ distro: 'ubuntu', name: 'Ubuntu', state: 'starting', line: 'Starting Ubuntu…', agents: [] }) });
  await settle();
  await t.ctx.AIBWsl.peekAgents('ubuntu');
  assert.equal(t.ctx.AIBWsl._agentCache.has('ubuntu'), false);
  const r = setup();
  await settle();
  await r.ctx.AIBWsl.peekAgents('ubuntu');
  assert.equal(r.ctx.AIBWsl._agentCache.get('ubuntu').value.agents.length, 3, 'a ready answer does');
});

// ---- the mockup's states ---------------------------------------------------------------------------------------------------
test('all good: the overview lists Ubuntu (WSL default, Ready) and docker-desktop (Not supported, why); Ubuntu\'s group has its status and agents', async () => {
  const t = setup({ status: status([UBUNTU], { skipped: [DOCKER] }) });
  await openWsl(t);
  const over = t.cardOf('WSL on this PC');
  assert.ok(over.querySelector('.wl-lead').textContent.startsWith('Run Claude Code, Codex and the other ACP agents inside your WSL distros'));
  const rows = over.querySelectorAll('.wl-distro');
  assert.deepEqual(rows.map((r) => r.querySelector('strong').textContent), ['Ubuntu', 'docker-desktop']);
  assert.equal(rows[0].querySelector('.st-tag').textContent, 'WSL 2 · WSL default');
  assert.equal(rows[0].querySelector('.st-status').textContent, 'Ready');
  assert.equal(rows[0].querySelector('.st-status').className, 'st-status ok');
  assert.equal(rows[1].querySelector('.st-status').textContent, 'Not supported');
  assert.equal(rows[1].querySelector('.st-note').textContent, "docker-desktop is Docker's own distro; AIB cannot run there.");
  assert.ok(over.textContent.includes('A distro keeps running while a WSL project is open'));
  assert.deepEqual(t.content().querySelectorAll('.st-group').map((h) => h.textContent), ['Ubuntu'], 'a group for the usable distro only');
  const card = t.cardOf('Ubuntu');
  assert.deepEqual(card.querySelectorAll('dt').map((n) => n.textContent), ['State', 'AIB helper', 'Home']);
  assert.deepEqual(card.querySelectorAll('dd').map((n) => n.textContent), ['Ready', '0.1.0-ab12cd34', '/home/u']);
  assert.deepEqual(buttons(card), [], 'no Repair or Open terminal buttons that would do nothing');
  const agents = t.cardOf('Agents in Ubuntu');
  assert.deepEqual(agents.querySelectorAll('.st-agent').map((r) => r.dataset.agent), ['wsl:ubuntu:claude', 'wsl:ubuntu:codex', 'wsl:ubuntu:omp']);
  const claude = t.rowOf('wsl:ubuntu:claude');
  assert.equal(claude.querySelector('.st-tag').textContent, 'Installed by AIB');
  assert.equal(claude.querySelector('.st-status').textContent, 'Found');
  assert.equal(claude.querySelector('.st-command').textContent, '0.102.0');
  assert.ok(claude.textContent.includes('The standalone claude command is not needed'), 'bundledCli: true');
  assert.ok(!claude.textContent.includes('claude.ai/install.sh'));
  const codex = t.rowOf('wsl:ubuntu:codex');
  assert.equal(codex.querySelector('.st-tag').textContent, 'Your own install');
  assert.ok(!codex.textContent.includes('is not needed'), 'bundledCli false: never claims the command is not needed');
  assert.ok(codex.textContent.includes('Optional: to use Codex in your own Ubuntu terminal, install the codex command yourself:'));
  assert.ok(codex.querySelectorAll('code').some((c) => c.textContent === 'npm install -g @openai/codex'));
  assert.equal(codex.querySelector('a').href, 'https://developers.openai.com/codex/cli');
  assert.ok(!buttons(codex).includes('Install in Ubuntu'), 'never an install button for the vendor command');
  const omp = t.rowOf('wsl:ubuntu:omp');
  assert.equal(omp.querySelector('.st-status').textContent, 'Not installed');
  assert.ok(omp.textContent.includes('AIB does not install OMP.'));
  assert.ok(!buttons(omp).some((b) => /^Install/.test(b)));
  assert.ok(buttons(omp).includes('Check again'));
  assert.ok(agents.querySelector('.wl-foot').textContent.includes('Your Windows agents are in AIB Linking.'));
});

test('distro rows have no On/Off switch: they say they follow the Windows switch (one switch per agent)', async () => {
  const t = setup();
  await openWsl(t);
  const claude = t.rowOf('wsl:ubuntu:claude');
  assert.equal(claude.querySelectorAll('input').length, 0, 'no switch');
  assert.equal(claude.querySelector('.st-actions').textContent, 'On: uses the Windows switch in AIB Linking');
  const codex = t.rowOf('wsl:ubuntu:codex');
  assert.equal(codex.querySelector('.st-actions').textContent, 'Off: uses the Windows switch in AIB Linking', 'Codex is off on Windows');
  assert.ok(codex.className.includes('off'), 'drawn as off, as on Windows');
  assert.ok(!buttons(t.cardOf('Agents in Ubuntu')).includes('Uninstall'), 'no Uninstall in phase 1');
  assert.ok(!buttons(t.cardOf('Agents in Ubuntu')).includes('Sign in'), 'no Sign in in phase 1');
});

test('missing: Install in Ubuntu with what it does, the npm command for doing it yourself; Install starts the job in the distro', async () => {
  const t = setup({ agents: () => ({ distro: 'ubuntu', name: 'Ubuntu', agents: [{ id: 'claude', found: false, installable: true, pinned: '0.102.0', install: 'npm i -g @agentclientprotocol/claude-agent-acp' }] }) });
  await openWsl(t);
  const row = t.rowOf('wsl:ubuntu:claude');
  assert.equal(row.querySelector('.st-status').textContent, 'Not installed');
  const go = row.querySelectorAll('button').find((b) => b.textContent === 'Install in Ubuntu');
  assert.equal(go.className, 'st-primary');
  assert.equal(go.disabled, false);
  assert.ok(go.title.includes('~/.aib-server/agents') && go.title.includes('0.102.0'));
  assert.ok(row.textContent.includes('One click: AIB installs Claude Code 0.102.0 into its own folder in Ubuntu'));
  assert.ok(row.textContent.includes('Or install it yourself in Ubuntu:'));
  assert.ok(row.querySelectorAll('code').some((c) => c.textContent === 'npm i -g @agentclientprotocol/claude-agent-acp'));
  assert.ok(!row.textContent.includes('optional'), 'no vendor command line on a missing agent');
  go.click();
  await settle();
  assert.deepEqual(t.calls.posts[0], ['wsl/agents/install', { distro: 'ubuntu', agent: 'claude' }]);
  assert.equal(t.settingsCalls.filter(([k, n]) => k === 'post' && n === 'agents/install').length, 0, 'not the Windows install');
});

test('installing: progress bar and Cancel from wsl-ui.js\'s job store, polled; Cancel posts the distro\'s cancel', async () => {
  let polls = 0,
    cancelled = false;
  const job = { state: 'running', stage: 'downloading', percent: 46 };
  const t = setup({
    agents: () => ({ distro: 'ubuntu', name: 'Ubuntu', agents: [Object.assign({ id: 'claude', found: false, installable: true, pinned: '0.102.0' }, cancelled ? {} : { job })] }),
    installGet: () => (++polls === 1 ? { state: 'running', stage: 'verifying', percent: 92 } : { state: 'running', stage: 'verifying', percent: 95 }),
    install: (name) => (name === 'wsl/agents/install/cancel' ? ((cancelled = true), { state: 'idle' }) : {}),
  });
  await openWsl(t);
  let row = t.rowOf('wsl:ubuntu:claude');
  assert.equal(t.ctx.AIBWsl.installJob('ubuntu', 'claude').percent, 46, 'the job lives in wsl-ui.js');
  assert.equal(row.querySelector('.st-progress').getAttribute('aria-valuenow'), '46');
  assert.equal(row.querySelector('.st-progress').getAttribute('aria-label'), 'Installing Claude Code in Ubuntu');
  assert.ok(row.textContent.includes('Installing Claude Code in Ubuntu… Downloading and unpacking… It goes on if you close Settings or restart AIB.'));
  assert.deepEqual(buttons(row), ['Cancel']);
  t.shell.window.runTimers();
  await settle();
  row = t.rowOf('wsl:ubuntu:claude');
  assert.equal(row.querySelector('.st-progress').getAttribute('aria-valuenow'), '92', 'repainted from the poll');
  assert.ok(row.textContent.includes('Checking the install…'));
  row.querySelector('button').click();
  await settle();
  assert.deepEqual(t.calls.posts.pop(), ['wsl/agents/install/cancel', { distro: 'ubuntu', agent: 'claude' }]);
  assert.equal(t.ctx.AIBWsl.installJob('ubuntu', 'claude'), null);
  assert.ok(t.agentCalls().length >= 2 && t.agentCalls().every((q) => q.peek === '1'), 'the list is read again, peek only');
});

test('update available: Update in Ubuntu with the pinned line; it posts the distro install', async () => {
  const t = setup({ agents: () => ({ distro: 'ubuntu', name: 'Ubuntu', agents: [Object.assign({}, CLAUDE, { version: '0.98.1', update: true })] }) });
  await openWsl(t);
  const row = t.rowOf('wsl:ubuntu:claude');
  assert.deepEqual(buttons(row).filter((b) => b !== 'Copy'), ['Check again', 'Update in Ubuntu']);
  assert.ok(row.textContent.includes('AIB now uses Claude Code 0.102.0; Ubuntu has 0.98.1. The old copy keeps working until the new one is complete.'));
  row.querySelectorAll('button').find((b) => b.textContent === 'Update in Ubuntu').click();
  await settle();
  assert.deepEqual(t.calls.posts[0], ['wsl/agents/install', { distro: 'ubuntu', agent: 'claude' }]);
  assert.ok(t.rowOf('wsl:ubuntu:claude').textContent.startsWith('CClaude Code'), 'still drawn');
  assert.ok(t.rowOf('wsl:ubuntu:claude').querySelector('.st-progress').getAttribute('aria-label').startsWith('Updating Claude Code in Ubuntu'));
});

test('error: a failed install shows Install failed, npm\'s line and Retry', async () => {
  const failed = { state: 'failed', message: 'The install failed: npm could not reach registry.npmjs.org (ETIMEDOUT).' };
  const t = setup({ agents: () => ({ distro: 'ubuntu', name: 'Ubuntu', agents: [{ id: 'codex', found: false, installable: true, pinned: '2.6.0', job: failed }] }) });
  await openWsl(t);
  const row = t.rowOf('wsl:ubuntu:codex');
  assert.equal(row.querySelector('.st-status').textContent, 'Install failed');
  assert.equal(row.querySelector('.st-note.bad').textContent, failed.message);
  assert.ok(buttons(row).includes('Retry'));
  assert.ok(!row.textContent.includes('One click'), 'the failure, not the pitch');
});

test('Node.js missing: Install is off with the reason, the line says why, the nvm command to copy, Check again asks again (peek, force)', async () => {
  const t = setup({
    agents: () => ({
      distro: 'ubuntu',
      name: 'Ubuntu',
      agents: [{ id: 'claude', found: false, installable: true, pinned: '0.102.0', installBlock: 'Node.js 22 or newer is needed in Ubuntu to install Claude Code, and Ubuntu has no Node.js.', nodeInstall: 'curl … | bash && nvm install 22' }],
    }),
  });
  await openWsl(t);
  const row = t.rowOf('wsl:ubuntu:claude');
  const go = row.querySelectorAll('button').find((b) => b.textContent === 'Install in Ubuntu');
  assert.equal(go.disabled, true);
  assert.equal(go.title, 'Needs Node.js in Ubuntu first');
  assert.ok(row.textContent.includes('Ubuntu has no Node.js.'));
  assert.ok(row.querySelectorAll('code').some((c) => c.textContent === 'curl … | bash && nvm install 22'));
  row.querySelectorAll('button').find((b) => b.textContent === 'Check again').click();
  await settle();
  assert.deepEqual(t.agentCalls().pop(), { distro: 'ubuntu', peek: '1', force: '1' });
});

test('distro stopped: the status card says so with Reconnect (posts wsl/reconnect); no agent list is asked', async () => {
  const t = setup({ status: status([Object.assign({}, UBUNTU, { state: 'stopped', line: 'Ubuntu stopped. Reconnect', helper: null })]) });
  await openWsl(t);
  const card = t.cardOf('Ubuntu');
  assert.equal(card.querySelector('dd').textContent, 'Stopped');
  assert.ok(card.querySelector('.st-note.bad').textContent.startsWith('Ubuntu stopped (Windows restart or wsl --shutdown).'));
  assert.equal(t.cardOf('Agents in Ubuntu'), null);
  assert.equal(t.cardOf('WSL on this PC').querySelector('.st-status').textContent, 'Stopped');
  card.querySelector('button').click();
  await settle();
  assert.deepEqual(t.calls.posts[0], ['wsl/reconnect', { distro: 'ubuntu' }]);
  assert.deepEqual(t.agentCalls(), []);
});

test('starting and problem states: chip Starting with the host\'s line; Problem with its note and Reconnect', async () => {
  const t = setup({ status: status([Object.assign({}, UBUNTU, { state: 'installing', line: 'Setting up AIB in Ubuntu (first time, ~100 MB)', helper: null })]) });
  await openWsl(t);
  assert.equal(t.cardOf('WSL on this PC').querySelector('.st-status').textContent, 'Starting');
  assert.ok(t.cardOf('Ubuntu').textContent.includes('Setting up AIB in Ubuntu (first time, ~100 MB)'));
  t.ctx.AIBWsl._set(status([Object.assign({}, UBUNTU, { state: 'unavailable', problem: 'The AIB helper in Ubuntu failed its checksum.', helper: null })]));
  await settle();
  assert.equal(t.cardOf('WSL on this PC').querySelector('.st-status').textContent, 'Problem');
  assert.equal(t.cardOf('Ubuntu').querySelector('.st-note.bad').textContent, 'The AIB helper in Ubuntu failed its checksum.');
  assert.deepEqual(buttons(t.cardOf('Ubuntu')), ['Reconnect']);
  assert.deepEqual(t.agentCalls(), []);
});

test('no WSL on this PC: one card with wsl --install, Microsoft\'s page and Check again; WSL without a distro: wsl --install -d Ubuntu', async () => {
  const t = setup({ status: status([], { wsl: { exe: false, problem: '' } }) });
  await openWsl(t);
  const card = t.cardOf('WSL on this PC');
  assert.ok(card.textContent.startsWith('WSL on this PCWSL is not installed on this PC.'));
  assert.equal(card.querySelector('code').textContent, 'wsl --install');
  assert.equal(card.querySelector('a').href, 'https://learn.microsoft.com/windows/wsl/install');
  assert.deepEqual(buttons(card), ['Copy', 'Check again']);
  assert.equal(t.content().querySelectorAll('.st-card').length, 1);
  const n = t.calls.gets.filter(([p]) => p === '/api/live/wsl/status').length;
  card.querySelectorAll('button')[1].click();
  await settle();
  assert.equal(t.calls.gets.filter(([p]) => p === '/api/live/wsl/status').length, n + 1, 'Check again reads the status');
  t.ctx.AIBWsl._set(status([], { wsl: { exe: true, problem: '' } }));
  await settle();
  assert.equal(t.cardOf('WSL on this PC').querySelector('code').textContent, 'wsl --install -d Ubuntu');
});

test('two distros and a WSL 1 one: all listed, the WSL 1 one with the command that converts it; a group per usable distro', async () => {
  const t = setup({ status: status([UBUNTU, DEBIAN], { skipped: [WSL1, DOCKER] }) });
  await openWsl(t);
  const over = t.cardOf('WSL on this PC');
  assert.deepEqual(over.querySelectorAll('.wl-distro').map((r) => r.querySelector('strong').textContent), ['Ubuntu', 'Debian', 'Ubuntu-20.04', 'docker-desktop']);
  const w1 = over.querySelectorAll('.wl-distro')[2];
  assert.equal(w1.querySelector('.st-tag').textContent, 'WSL 1');
  assert.equal(w1.querySelector('code').textContent, 'wsl --set-version Ubuntu-20.04 2');
  assert.ok(w1.textContent.includes('back it up first'));
  assert.equal(over.querySelectorAll('.wl-distro')[1].querySelector('.st-tag').textContent, 'WSL 2', 'not the default');
  assert.equal(over.querySelectorAll('.wl-distro')[1].querySelector('.st-status').textContent, 'Not running');
  assert.equal(over.querySelectorAll('.wl-distro')[3].querySelectorAll('code').length, 0, 'docker-desktop: no conversion');
  assert.deepEqual(t.content().querySelectorAll('.st-group').map((h) => h.textContent), ['Ubuntu', 'Debian']);
  assert.ok(t.cardOf('Agents in Ubuntu'));
  assert.equal(t.cardOf('Agents in Debian'), null, 'not running: no agents card and no question to it');
});

// ---- Windows rows unchanged, namespaces apart ------------------------------------------------------------------------------
test('Windows and Ubuntu installs of Claude Code at once: each card has its own job, progress and Cancel', async () => {
  const t = setup({
    agents: () => ({ distro: 'ubuntu', name: 'Ubuntu', agents: [{ id: 'claude', found: false, installable: true, pinned: '0.102.0' }] }),
    install: (name) => (name === 'wsl/agents/install' ? { state: 'running', stage: 'downloading', percent: 30 } : name === 'wsl/agents/install/cancel' ? { state: 'idle' } : {}),
  });
  t.replies.winInstall = () => ({ state: 'running', stage: 'preparing', percent: 5 });
  t.replies.winStatus = () => ({ state: 'running', stage: 'downloading', percent: 60 });
  await openWsl(t);
  t.rowOf('wsl:ubuntu:claude').querySelectorAll('button').find((b) => b.textContent === 'Install in Ubuntu').click();
  await settle();
  t.UI.goSection('agents');
  await settle();
  const win = t.rowOf('claude');
  assert.ok(win, 'the Windows card keeps its key: the agent id');
  win.querySelectorAll('button').find((b) => b.textContent === 'Install').click();
  await settle();
  assert.deepEqual(t.settingsCalls.filter(([k, n]) => k === 'post' && n === 'agents/install').map(([, , b]) => b), [{ agent: 'claude' }]);
  assert.equal(t.rowOf('claude').querySelector('.st-progress').getAttribute('aria-valuenow'), '5', 'Windows: its own job');
  assert.equal(t.rowOf('wsl:ubuntu:claude'), null, 'the distro cards are not on the Windows page');
  t.UI.goSection('wsl');
  await settle();
  const ubu = t.rowOf('wsl:ubuntu:claude');
  assert.equal(ubu.querySelector('.st-progress').getAttribute('aria-valuenow'), '30', 'Ubuntu: its own job');
  ubu.querySelector('button').click(); // Cancel
  await settle();
  assert.deepEqual(t.calls.posts.pop(), ['wsl/agents/install/cancel', { distro: 'ubuntu', agent: 'claude' }]);
  assert.equal(t.settingsCalls.filter(([, n]) => n === 'agents/install/cancel').length, 0, 'the Windows job is not cancelled');
  t.UI.goSection('agents');
  await settle();
  assert.ok(t.rowOf('claude').querySelector('.st-progress'), 'the Windows install still runs');
});

test('Windows rows are drawn as before: the On/Off switch, Built in, Install, no distro wording', async () => {
  const t = setup();
  await settle();
  t.UI.open('agents');
  await settle();
  await settle();
  const claude = t.rowOf('claude');
  assert.equal(claude.querySelector('.st-tag').textContent, 'Built in');
  assert.deepEqual(buttons(claude), ['Install']);
  assert.equal(claude.querySelector('input').type, 'checkbox');
  assert.equal(claude.querySelector('.st-actions').textContent, 'On');
  assert.ok(!claude.textContent.includes('Ubuntu'));
  // the same row through agentRow without an env and with the Windows default are the same
  const a = t.UI._state.data.agents[0];
  assert.equal(t.UI.agentRow(a, { sharedBlock: true }).textContent, claude.textContent);
});

test('makeEnv: a Beta card outside Windows says it uses the Windows key instead of a second key box', async () => {
  const t = setup();
  await settle();
  const beta = { id: 'qwen', name: 'Qwen Code', letter: 'Q', beta: true, enabled: true, found: true, betaInfo: { keyEnv: 'OPENAI_API_KEY', signin: 'key' } };
  const env = t.UI.makeEnv({ key: (x) => 'wsl:ubuntu:' + x.id });
  const row = t.UI.agentRow(beta, {}, env);
  assert.equal(row.dataset.agent, 'wsl:ubuntu:qwen');
  assert.equal(row.querySelectorAll('input').length, 0, 'no key box, no switch');
  assert.ok(row.textContent.includes('API key (OPENAI_API_KEY): uses your Windows key, saved in AIB Linking.'));
  const winRow = t.UI.agentRow(beta, {});
  assert.ok(winRow.querySelector('input[type="password"]') || winRow.querySelectorAll('input').some((i) => i.type === 'password'), 'Windows keeps its key box');
});

// ---- links -----------------------------------------------------------------------------------------------------------------
test('"Set up Ubuntu in Settings" opens the section with the distro\'s card of that agent in view', async () => {
  const t = setup();
  await settle();
  const seen = [];
  t.ctx.AIBWslSettings.open('ubuntu', 'codex');
  await settle();
  await settle();
  assert.equal(t.shell.document.querySelector('h2').textContent, 'AIB Linking (WSL)');
  const row = t.rowOf('wsl:ubuntu:codex');
  row.scrollIntoView = (o) => seen.push(o);
  t.shell.window.runTimers();
  assert.deepEqual(plain(seen), [{ block: 'center' }]);
  // chat.js: the new-chat panel's "not installed" state carries the link
  const chat = fs.readFileSync(path.join(APP_DIR, 'chat.js'), 'utf8');
  assert.ok(chat.includes("link('Set up ' + name + ' in Settings', () => window.AIBWslSettings.open(p.key, provider)"));
  const html = fs.readFileSync(path.join(APP_DIR, 'chat.html'), 'utf8');
  assert.ok(html.indexOf('/wsl-settings-ui.js') > html.indexOf('/settings-ui.js'), 'loaded after settings-ui.js');
});

test('Settings > About: the WSL lines link to AIB Linking (WSL)', async () => {
  const t = setup();
  await settle();
  t.UI.open('server');
  await settle();
  await settle();
  const about = t.content().querySelectorAll('.st-card').find((c) => c.dataset.setting === 'server-info');
  assert.ok(about.textContent.includes('WSL: Ubuntu'));
  const link = about.querySelectorAll('button').find((b) => b.textContent === 'AIB Linking (WSL)');
  assert.ok(link, about.textContent);
  link.click();
  await settle();
  assert.equal(t.shell.document.querySelector('h2').textContent, 'AIB Linking (WSL)');
});
