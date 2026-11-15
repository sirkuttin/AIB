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
  const shell = page({ store: o.store || {} });
  const ctx = load(shell, ['wsl-ui.js', 'terminal-ui.js', 'composer-chips.js', 'settings-ui.js', 'wsl-settings-ui.js']);
  const calls = { gets: [], posts: [] };
  let current = o.status || status([UBUNTU]);
  const answer = (r) => (r instanceof Error ? Promise.reject(r) : r && typeof r.then === 'function' ? r : Promise.resolve(plain(r || {})));
  const wslHost = {
    getJson: (p, params) => {
      calls.gets.push([p, plain(params || {})]);
      if (p === '/api/live/wsl/status') return Promise.resolve(plain(current));
      if (p === '/api/live/wsl/agents') {
        const r = o.agents ? o.agents(params || {}) : READY_AGENTS;
        return r instanceof Error ? Promise.reject(r) : Promise.resolve(plain(r));
      }
      if (p === '/api/live/wsl/prereqs') return answer(o.prereqs ? o.prereqs(params || {}) : needsOf(P_OK, (params || {}).distro));
      if (p === '/api/live/wsl/agents/install') return Promise.resolve(plain(o.installGet ? o.installGet(params) : { state: 'idle' }));
      if (p === '/api/live/wsl/aib') return answer(o.aib ? o.aib(params || {}) : aibOf(USAGE, (params || {}).distro));
      return Promise.resolve({});
    },
    postJson: (name, body) => {
      calls.posts.push([name, plain(body)]);
      if (name === 'wsl/agents/enabled') return answer(o.enabled ? o.enabled(body) : { ok: true, enabled: body.enabled });
      if (name === 'wsl/aib/remove') return answer(o.remove ? o.remove(body) : body.mode === 'check' ? CHECK_OK : APPLY_OK);
      if (name === 'wsl/agents/uninstall') return answer(o.uninstall ? o.uninstall(body) : { ok: true, removed: ['~/.aib-server/agents/' + body.id] });
      const r = o.install ? o.install(name, body) : { state: 'running', stage: 'preparing', percent: 2 };
      return r instanceof Error ? Promise.reject(r) : Promise.resolve(plain(r || {}));
    },
    currentPath: () => o.currentPath || '',
  };
  // The terminal panels: what each run asked for (the socket address built by terminal-ui.js's own signinUrl), and its hooks to
  // finish it with. Nothing is opened.
  const terms = [];
  const T = ctx.AibTerminal;
  const record = (box, id, hooks) => {
    const h = hooks || {};
    const loc = { protocol: 'http:', host: '127.0.0.1:1' };
    const url = h.url ? h.url(loc, 80, 24) : T.signinUrl(loc, id, 80, 24, h.step || '', h.distro || '', h.args, !!h.start);
    const run = { id, hooks: h, url, closed: false, close() { run.closed = true; } };
    terms.push(run);
    return run;
  };
  T.runSignin = (box, id, hooks) => record(box, id, hooks);
  T.runSetup = (box, id, step, hooks) => record(box, id, Object.assign({}, hooks, { step }));
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
  const needCalls = () => calls.gets.filter(([p]) => p === '/api/live/wsl/prereqs').map(([, q]) => q);
  const aibCalls = () => calls.gets.filter(([p]) => p === '/api/live/wsl/aib').map(([, q]) => q);
  const removeCalls = () => calls.posts.filter(([n]) => n === 'wsl/aib/remove').map(([, b]) => b);
  const picker = () => content().querySelector('.wl-pick').querySelector('select');
  const groups = () => content().querySelectorAll('.st-group').map((h) => h.textContent);
  const choose = async (key) => {
    const sel = picker();
    sel.value = key;
    sel.dispatch('change');
    await settle();
  };
  return { shell, ctx, UI, calls, settingsCalls, replies, content, nav, rowOf, cardOf, agentCalls, needCalls, aibCalls, removeCalls, picker, groups, choose, terms, set: (s) => (current = s) };
}
// GET /api/live/wsl/prereqs answers (section 12): EnvPrereqs of a ready distro, prereqs: null for one that is not.
const P_OK = {
  node: { state: 'ok', version: '24.11.1', path: '/home/u/.nvm/versions/node/v24.11.1/bin/node', manager: 'nvm' },
  npm: { state: 'ok', version: '11.6.2' },
  git: { state: 'ok', version: '2.43.0' },
  curl: { state: 'ok' },
  diskFreeMB: 822000,
  arch: 'x64',
  loginShell: '/usr/bin/zsh',
  envMode: 'login-interactive',
  nvm: { present: true },
  canInstallNode: true,
};
const withNode = (node, extra = {}) => Object.assign({}, P_OK, { node }, extra);
const needsOf = (p, distro = 'ubuntu') => ({ distro, name: distro === 'debian' ? 'Debian' : 'Ubuntu', state: 'ready', line: '', prereqs: p });
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
  assert.deepEqual(t.needCalls(), [{ distro: 'ubuntu', peek: '1' }], 'the prerequisites: peek too, never start');
  // the drop-down shows one distro at a time: picking Debian (not running) asks it nothing
  await t.choose('debian');
  assert.equal(t.agentCalls().length, 1);
  assert.equal(t.needCalls().length, 1);
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
  assert.equal(claude.querySelector('.st-status').textContent, 'Installed', 'AIB\'s own copy, no sign-in answer: Installed');
  assert.equal(t.rowOf('wsl:ubuntu:codex').querySelector('.st-status').textContent, 'Found', 'your own install: Found');
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

test('each distro card has its own switch "Use in Ubuntu" from rows[].enabled, apart from the Windows one (Codex off on Windows, on in Ubuntu)', async () => {
  const t = setup({ agents: () => ({ distro: 'ubuntu', name: 'Ubuntu', agents: [Object.assign({ enabled: false }, CLAUDE), Object.assign({ enabled: true }, CODEX), OMP] }) });
  await openWsl(t);
  const claude = t.rowOf('wsl:ubuntu:claude');
  const box = claude.querySelector('.st-actions').querySelector('input');
  assert.equal(box.type, 'checkbox');
  assert.equal(box.checked, false, 'off in Ubuntu although on in Windows');
  assert.equal(claude.querySelector('.st-actions').querySelector('.st-toggle').textContent, 'Use in Ubuntu');
  assert.ok(claude.className.includes('off'), 'drawn as off');
  const codex = t.rowOf('wsl:ubuntu:codex');
  assert.equal(codex.querySelector('.st-actions').querySelector('input').checked, true, 'on in Ubuntu although off in Windows');
  assert.ok(!codex.className.includes('off'));
  assert.equal(t.rowOf('wsl:ubuntu:omp').querySelector('.st-actions').querySelector('input').checked, true, 'no saved value: on');
  assert.ok(!t.content().textContent.includes('uses the Windows switch'), 'the phase 1 line is gone');
});

test('the distro switch: drawn at once, posts {distro, id, enabled}, never the Windows settings; kept after the answer', async () => {
  let release;
  const t = setup({ enabled: (b) => new Promise((r) => (release = () => r({ ok: true, enabled: b.enabled }))) });
  await openWsl(t);
  const box = t.rowOf('wsl:ubuntu:claude').querySelector('.st-actions').querySelector('input');
  box.checked = false;
  box.dispatch('change');
  await settle();
  assert.deepEqual(t.calls.posts.pop(), ['wsl/agents/enabled', { distro: 'ubuntu', id: 'claude', enabled: false }]);
  assert.equal(t.rowOf('wsl:ubuntu:claude').querySelector('.st-actions').querySelector('input').checked, false, 'off before the answer');
  assert.ok(t.rowOf('wsl:ubuntu:claude').className.includes('off'));
  release();
  await settle();
  assert.equal(t.rowOf('wsl:ubuntu:claude').querySelector('.st-actions').querySelector('input').checked, false, 'still off after it');
  assert.equal(t.settingsCalls.filter(([k, n]) => k === 'post' && /settings/.test(n)).length, 0, 'the Windows switch is not touched');
  assert.ok(!t.rowOf('wsl:ubuntu:claude').querySelector('.st-note.bad'));
});

test('the distro switch fails: it goes back and the card says why; a refused answer (ok: false) too', async () => {
  let reply = Error('The settings file could not be written.');
  const t = setup({ enabled: () => reply });
  await openWsl(t);
  let box = t.rowOf('wsl:ubuntu:codex').querySelector('.st-actions').querySelector('input');
  box.checked = false;
  box.dispatch('change');
  await settle();
  let row = t.rowOf('wsl:ubuntu:codex');
  assert.equal(row.querySelector('.st-actions').querySelector('input').checked, true, 'rolled back');
  assert.equal(row.querySelector('.st-note.bad').textContent, 'The switch could not be saved: The settings file could not be written. Codex stays on in Ubuntu.');
  reply = { ok: false };
  box = row.querySelector('.st-actions').querySelector('input');
  box.checked = false;
  box.dispatch('change');
  await settle();
  row = t.rowOf('wsl:ubuntu:codex');
  assert.equal(row.querySelector('.st-actions').querySelector('input').checked, true);
  assert.equal(row.querySelector('.st-note.bad').textContent, 'The switch could not be saved. Codex stays on in Ubuntu.');
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
    prereqs: () => Error('Not found'), // a server without the prerequisites route: the row's own nvm line stays
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
  assert.equal(go.title, 'Needs Node.js first');
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
  assert.deepEqual(t.groups(), ['Ubuntu'], 'one distro at a time: the WSL default first');
  assert.ok(t.cardOf('Agents in Ubuntu'));
  await t.choose('debian');
  assert.deepEqual(t.groups(), ['Debian']);
  assert.equal(t.cardOf('Agents in Debian'), null, 'not running: no agents card and no question to it');
  assert.equal(t.cardOf('What Debian needs'), null);
  assert.ok(t.agentCalls().every((q) => q.distro === 'ubuntu'));
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

// ==== phase 2 (docs/wsl/linking-design.md section 12) ========================================================================
const DEBIAN_READY = Object.assign({}, UBUNTU, { name: 'Debian', key: 'debian', home: '/home/d', isDefault: false });
const listOf = (q) => ({ distro: q.distro, name: q.distro === 'debian' ? 'Debian' : 'Ubuntu', agents: [CLAUDE, CODEX, OMP] });
const heads = (card) => card.querySelectorAll('.dv-check-head').map((h) => [h.children[1].textContent, h.children[2].textContent]);
const noStart = (t) => [...t.agentCalls(), ...t.needCalls()].every((q) => !('start' in q));

// ---- the distro drop-down ----------------------------------------------------------------------------------------------------
test('drop-down: every distro at the top (WSL default marked, the unusable ones off with their reason); WSL\'s default is shown first', async () => {
  const t = setup({ status: status([DEBIAN_READY, UBUNTU], { skipped: [DOCKER, WSL1] }), agents: listOf });
  await openWsl(t);
  const sel = t.picker();
  const all = t.content().all();
  const at = (n) => all.indexOf(n);
  assert.ok(at(t.content().querySelector('.wl-pick')) < at(t.cardOf('WSL on this PC')), 'the drop-down comes first');
  assert.ok(at(t.cardOf('WSL on this PC')) < at(t.content().querySelector('.st-group')), 'then the compact WSL on this PC card, then the group');
  assert.ok(!t.content().all().slice(0, at(t.content().querySelector('.wl-pick'))).some((n) => String(n.className).split(' ').includes('st-card')), 'no card above it');
  assert.deepEqual(sel.querySelectorAll('option').map((o) => o.textContent), [
    'Debian',
    'Ubuntu (WSL default)',
    "docker-desktop (not supported: docker-desktop is Docker's own distro; AIB cannot run there)",
    'Ubuntu-20.04 (not supported: Ubuntu-20.04 runs on WSL 1. AIB needs WSL 2)',
  ]);
  assert.deepEqual(sel.querySelectorAll('option').map((o) => o.disabled), [false, false, true, true]);
  assert.equal(sel.value, 'ubuntu');
  assert.equal(sel.getAttribute('aria-label'), 'The distro this page shows');
  assert.deepEqual(t.groups(), ['Ubuntu'], 'one distro\'s cards at a time');
  assert.deepEqual(t.agentCalls(), [{ distro: 'ubuntu', peek: '1' }], 'nothing asked of the distro not shown');
  await t.choose('debian');
  assert.equal(t.shell.localStorage.getItem('aib-wsl-distro'), 'debian', 'remembered (a view preference)');
  assert.deepEqual(t.groups(), ['Debian']);
  assert.ok(t.cardOf('What Debian needs') && t.cardOf('Agents in Debian'));
  assert.deepEqual(t.agentCalls().pop(), { distro: 'debian', peek: '1' });
  assert.deepEqual(t.needCalls().pop(), { distro: 'debian', peek: '1' });
  assert.ok(noStart(t), 'picking a distro never starts one');
});

test('drop-down: the remembered choice wins over WSL\'s default; one that is gone falls back to the default; none marked: the first usable', async () => {
  const t = setup({ status: status([UBUNTU, DEBIAN_READY]), agents: listOf, store: { 'aib-wsl-distro': 'debian' } });
  await openWsl(t);
  assert.equal(t.picker().value, 'debian');
  assert.deepEqual(t.groups(), ['Debian']);
  const gone = setup({ status: status([DEBIAN_READY, UBUNTU]), agents: listOf, store: { 'aib-wsl-distro': 'arch' } });
  await openWsl(gone);
  assert.equal(gone.picker().value, 'ubuntu', 'the default');
  const none = setup({ status: status([DEBIAN_READY, Object.assign({}, UBUNTU, { isDefault: false })]), agents: listOf });
  await openWsl(none);
  assert.equal(none.picker().value, 'debian', 'the first usable one');
});

test('drop-down: a WSL project open picks its distro (over the remembered one); a choice made then stays while that project stays open', async () => {
  const t = setup({ status: status([UBUNTU, DEBIAN_READY]), agents: listOf, currentPath: 'wsl://debian/home/d/app', store: { 'aib-wsl-distro': 'ubuntu' } });
  await openWsl(t);
  assert.equal(t.picker().value, 'debian');
  await t.choose('ubuntu');
  t.UI.close();
  t.UI.open('wsl');
  await settle();
  assert.equal(t.picker().value, 'ubuntu', 'the person\'s choice is kept');
});

test('drop-down: one distro still has the drop-down (one entry), so the page looks the same for everyone', async () => {
  const t = setup();
  await openWsl(t);
  assert.deepEqual(t.picker().querySelectorAll('option').map((o) => o.textContent), ['Ubuntu (WSL default)']);
  assert.deepEqual(t.groups(), ['Ubuntu']);
});

test('"Set up Debian in Settings" (the new-chat panel) opens the page with Debian picked, its agent card in view', async () => {
  const t = setup({ status: status([UBUNTU, DEBIAN_READY]), agents: listOf });
  await settle();
  const seen = [];
  t.ctx.AIBWslSettings.open('Debian', 'codex');
  await settle();
  await settle();
  assert.equal(t.picker().value, 'debian');
  assert.deepEqual(t.groups(), ['Debian']);
  assert.equal(t.shell.localStorage.getItem('aib-wsl-distro'), 'debian');
  t.rowOf('wsl:debian:codex').scrollIntoView = (o) => seen.push(o);
  t.shell.window.runTimers();
  assert.deepEqual(plain(seen), [{ block: 'center' }]);
});

// ---- What Ubuntu needs ---------------------------------------------------------------------------------------------------------
test('What Ubuntu needs, all there: Node.js (version, manager, path), npm, git, curl, free space, "Checked with"; Check again forces a new look', async () => {
  const t = setup();
  await openWsl(t);
  const card = t.cardOf('What Ubuntu needs');
  assert.ok(t.content().all().indexOf(card) < t.content().all().indexOf(t.cardOf('Agents in Ubuntu')), 'above the agents');
  assert.deepEqual(heads(card), [
    ['Node.js 22.19 or newer', 'found 24.11.1 (nvm)'],
    ['npm', 'found 11.6.2'],
    ['git', 'found 2.43.0'],
    ['curl', 'found'],
    ['Free space in your home folder', '802.7 GB free'],
  ]);
  assert.ok(card.querySelectorAll('li').every((li) => li.className === 'ok'));
  assert.equal(card.querySelector('.wl-path').textContent, '/home/u/.nvm/versions/node/v24.11.1/bin/node');
  assert.equal(card.querySelector('.wl-checked').textContent, 'Checked with: zsh login shell (interactive). Check again');
  assert.ok(!buttons(card).some((b) => /Install Node/.test(b)), 'no Install while Node.js is there');
  card.querySelector('.wl-checked').querySelector('button').click();
  await settle();
  assert.deepEqual(t.needCalls().pop(), { distro: 'ubuntu', peek: '1', force: '1' });
  assert.ok(noStart(t));
});

test('Node.js missing: Install Node.js opens the card\'s terminal with setup=wsl-node&distro=ubuntu; exit 0 checks again (force) and refreshes the agents', async () => {
  let p = withNode({ state: 'missing' }, { nvm: { present: false } });
  const t = setup({
    prereqs: (q) => needsOf(p, q.distro),
    agents: () => ({ distro: 'ubuntu', name: 'Ubuntu', agents: [{ id: 'claude', found: false, installable: true, pinned: '0.102.0', nodeInstall: 'curl … nvm' }, CODEX, OMP] }),
  });
  await openWsl(t);
  let card = t.cardOf('What Ubuntu needs');
  assert.deepEqual(heads(card)[0], ['Node.js 22.19 or newer', 'missing']);
  assert.equal(card.querySelector('li').className, 'bad');
  assert.ok(card.textContent.includes('Needed to install Claude Code, Codex and the other npm agents in Ubuntu.'));
  assert.ok(card.textContent.includes('Install runs nvm\'s official installer in a terminal here, in Ubuntu'));
  // the agent: Install off, "Needs Node.js first", and no nvm line of its own (the card above has the button)
  const row = t.rowOf('wsl:ubuntu:claude');
  const go = row.querySelectorAll('button').find((b) => b.textContent === 'Install in Ubuntu');
  assert.equal(go.disabled, true);
  assert.equal(go.title, 'Needs Node.js first');
  assert.ok(row.textContent.includes('Needs Node.js first: see What Ubuntu needs above.'));
  assert.ok(!row.textContent.includes('curl … nvm'));
  assert.ok(!row.textContent.includes('One click'));
  card.querySelectorAll('button').find((b) => b.textContent === 'Install Node.js in Ubuntu').click();
  await settle();
  assert.equal(t.terms.length, 1);
  const url = new URL(t.terms[0].url);
  assert.equal(url.pathname, '/api/live/terminal');
  assert.equal(url.searchParams.get('setup'), 'wsl-node');
  assert.equal(url.searchParams.get('distro'), 'ubuntu', 'terminal-ui.js keeps the distro for this step');
  assert.equal(url.searchParams.get('start'), null);
  card = t.cardOf('What Ubuntu needs');
  const panel = card.querySelector('.st-beta-term');
  assert.ok(panel, 'the panel is on the card');
  assert.equal(panel.querySelector('.st-beta-term-title').textContent, 'Installing Node.js in Ubuntu: nvm\'s official installer, then nvm install --lts');
  assert.equal(card.querySelectorAll('button').find((b) => b.textContent === 'Install Node.js in Ubuntu').disabled, true, 'one install at a time');
  const agentsBefore = t.agentCalls().length;
  p = P_OK;
  t.terms[0].hooks.onExit(0);
  await settle();
  assert.deepEqual(t.needCalls().pop(), { distro: 'ubuntu', peek: '1', force: '1' });
  assert.ok(t.agentCalls().length > agentsBefore && t.agentCalls().pop().force === '1', 'the agent rows are read again');
  assert.equal(t.terms[0].closed, true);
  assert.equal(t.cardOf('What Ubuntu needs').querySelector('.st-beta-term'), null, 'closed once Node.js is seen');
  assert.equal(t.rowOf('wsl:ubuntu:claude').querySelectorAll('button').find((b) => b.textContent === 'Install in Ubuntu').disabled, false, 'Install is on now');
});

test('Node.js install that fails, or ends without Node.js seen: the panel stays and says so', async () => {
  const t = setup({ prereqs: (q) => needsOf(withNode({ state: 'missing' }), q.distro) });
  await openWsl(t);
  const go = () => t.cardOf('What Ubuntu needs').querySelectorAll('button').find((b) => b.textContent === 'Install Node.js in Ubuntu');
  go().click();
  await settle();
  t.terms[0].hooks.onExit(3);
  await settle();
  assert.equal(t.cardOf('What Ubuntu needs').querySelector('.st-beta-term').querySelector('[role="status"]').textContent, 'Install failed. See the output above.');
  go().click();
  await settle();
  t.terms[1].hooks.onExit(0);
  await settle();
  assert.ok(t.cardOf('What Ubuntu needs').querySelector('.st-beta-term').textContent.includes('The install finished, but AIB does not see Node.js in Ubuntu yet.'));
});

test('Node.js too old and broken: the state and why; Install offered when canInstallNode', async () => {
  const t = setup({ prereqs: (q) => needsOf(withNode({ state: 'old', version: '18.19.1', manager: 'system', path: '/usr/bin/node' }), q.distro) });
  await openWsl(t);
  let card = t.cardOf('What Ubuntu needs');
  assert.deepEqual(heads(card)[0], ['Node.js 22.19 or newer', 'too old (18.19.1)']);
  assert.ok(card.textContent.includes('AIB needs Node.js 22.19 or newer in Ubuntu to install Claude Code, Codex and the other npm agents.'));
  assert.ok(buttons(card).includes('Install Node.js in Ubuntu'));
  const b = setup({ prereqs: (q) => needsOf(withNode({ state: 'broken', path: '/home/u/bin/node', note: 'node exited with code 127.' }), q.distro) });
  await openWsl(b);
  card = b.cardOf('What Ubuntu needs');
  assert.deepEqual(heads(card)[0], ['Node.js 22.19 or newer', 'found, but it does not run']);
  assert.ok(card.textContent.includes('The node program in Ubuntu (/home/u/bin/node) does not run.'));
  assert.ok(card.textContent.includes('node exited with code 127.'));
});

test('Node.js from asdf or mise with no version set: says so with the manager\'s own command, never offers nvm', async () => {
  const blocked = 'Node.js comes from asdf in Ubuntu, so AIB does not install another one.';
  const t = setup({ prereqs: (q) => needsOf(withNode({ state: 'shim_unset', manager: 'asdf', path: '/home/u/.asdf/shims/node' }, { canInstallNode: false, nodeInstallBlocked: blocked, nvm: { present: false } }), q.distro) });
  await openWsl(t);
  const card = t.cardOf('What Ubuntu needs');
  assert.deepEqual(heads(card)[0], ['Node.js 22.19 or newer', 'asdf has no Node.js version set']);
  assert.ok(card.textContent.includes('Node.js in Ubuntu comes from asdf, and asdf has no Node.js version set, so node does not run.'));
  assert.equal(card.querySelector('code').textContent, 'asdf install nodejs latest && asdf set -u nodejs "$(asdf latest nodejs)"');
  assert.ok(card.textContent.includes(blocked));
  assert.ok(!buttons(card).some((b) => /Install/.test(b)), 'no Install button');
  assert.ok(!/nvm/.test(card.textContent), 'nvm is never offered');
  assert.ok(buttons(card).includes('Open Ubuntu terminal') && buttons(card).includes('Check again'));
  // even with canInstallNode wrongly true, a shim never gets the nvm button
  const m = setup({ prereqs: (q) => needsOf(withNode({ state: 'shim_unset', manager: 'mise' }), q.distro) });
  await openWsl(m);
  const mc = m.cardOf('What Ubuntu needs');
  assert.deepEqual(heads(mc)[0], ['Node.js 22.19 or newer', 'mise has no Node.js version set']);
  assert.equal(mc.querySelector('code').textContent, 'mise use -g node@lts');
  assert.ok(!buttons(mc).some((b) => /Install/.test(b)) && !/nvm/.test(mc.textContent));
});

test('canInstallNode false: the reason verbatim, Open Ubuntu terminal (a shell in the distro\'s home, in the card) and Check again', async () => {
  const why = 'AIB cannot install Node.js in Ubuntu: your home folder is not writable.';
  const t = setup({ prereqs: (q) => needsOf(withNode({ state: 'missing' }, { canInstallNode: false, nodeInstallBlocked: why }), q.distro) });
  await openWsl(t);
  const card = t.cardOf('What Ubuntu needs');
  assert.ok(card.querySelectorAll('.st-note.bad').some((n) => n.textContent === why));
  assert.ok(!buttons(card).includes('Install Node.js in Ubuntu'));
  card.querySelectorAll('button').find((b) => b.textContent === 'Open Ubuntu terminal').click();
  await settle();
  const url = new URL(t.terms[0].url);
  assert.equal(url.searchParams.get('key'), 'wsl-shell:ubuntu');
  assert.equal(url.searchParams.get('cwd'), 'wsl://ubuntu/home/u');
  assert.equal(t.cardOf('What Ubuntu needs').querySelector('.st-beta-term-title').textContent, 'A terminal in Ubuntu');
  t.terms[0].hooks.onExit(0);
  await settle();
  assert.equal(t.needCalls().pop().force, '1', 'a look again after the terminal ends');
});

test('git and curl missing: the apt command to copy only (never run by AIB); low free space and a plain shell are said', async () => {
  const t = setup({ prereqs: (q) => needsOf(Object.assign({}, P_OK, { git: { state: 'missing' }, curl: { state: 'missing' }, diskFreeMB: 380, envMode: 'plain', loginShell: '/bin/bash' }), q.distro) });
  await openWsl(t);
  const card = t.cardOf('What Ubuntu needs');
  assert.deepEqual(heads(card).slice(2), [
    ['git', 'missing'],
    ['curl', 'missing'],
    ['Free space in your home folder', '380 MB free'],
  ]);
  assert.deepEqual(card.querySelectorAll('code').map((c) => c.textContent), ['sudo apt install git', 'sudo apt install curl']);
  assert.ok(card.textContent.includes('It needs your password, so AIB does not run it. Run it yourself in Ubuntu:'));
  assert.ok(!buttons(card).some((b) => /^Install|apt/.test(b)), 'no button runs apt');
  assert.ok(card.textContent.includes('Installs need room in Ubuntu: Claude Code about 1 GB, Codex about 600 MB.'));
  assert.ok(card.querySelector('.wl-checked').textContent.startsWith('Checked with: plain shell, without your login profile. A version manager set up only in your shell profile is not seen this way.'));
  const posts = t.calls.posts.length;
  for (const b of card.querySelectorAll('button').filter((x) => x.textContent === 'Copy')) b.click();
  await settle();
  assert.equal(t.calls.posts.length, posts, 'Copy posts nothing');
});

test('What Ubuntu needs while the distro is not ready (prereqs: null): its line; a non-interactive login shell is said when so', async () => {
  const t = setup({ prereqs: () => ({ distro: 'ubuntu', name: 'Ubuntu', state: 'starting', line: 'Starting Ubuntu…', prereqs: null }) });
  await openWsl(t);
  assert.ok(t.cardOf('What Ubuntu needs').textContent.includes('Starting Ubuntu…'));
  const n = setup({ prereqs: (q) => needsOf(Object.assign({}, P_OK, { envMode: 'login' }), q.distro) });
  await openWsl(n);
  assert.ok(n.cardOf('What Ubuntu needs').querySelector('.wl-checked').textContent.startsWith('Checked with: zsh login shell (non-interactive).'));
});

// ---- sign-in -------------------------------------------------------------------------------------------------------------------
test('sign-in states: Signed in (with the account), Not signed in (Sign in), unknown (its note); the old "Found" footnote is gone', async () => {
  const t = setup({
    agents: () => ({
      distro: 'ubuntu',
      name: 'Ubuntu',
      agents: [
        Object.assign({}, CLAUDE, { signin: { state: 'signed_in', account: 'me@example.com' } }),
        Object.assign({}, CODEX, { signin: { state: 'signed_out' } }),
        Object.assign({}, OMP, { found: true, version: '1.2.0', signin: { state: 'unknown', note: 'AIB has no sign-in check for OMP.' } }),
      ],
    }),
  });
  await openWsl(t);
  const claude = t.rowOf('wsl:ubuntu:claude');
  assert.equal(claude.querySelector('.st-status').textContent, 'Signed in');
  assert.equal(claude.querySelector('.wl-signin').textContent, 'Signed in to Claude Code in Ubuntu as me@example.com.');
  assert.ok(!buttons(claude).includes('Sign in'));
  const codex = t.rowOf('wsl:ubuntu:codex');
  assert.equal(codex.querySelector('.st-status').textContent, 'Not signed in');
  assert.equal(codex.querySelector('.st-status').className, 'st-status warn');
  assert.ok(codex.querySelector('.wl-signin').textContent.startsWith('Not signed in to Codex in Ubuntu yet. Sign in runs Codex\'s own sign-in in a Ubuntu terminal here'));
  assert.ok(buttons(codex).includes('Sign in'));
  const omp = t.rowOf('wsl:ubuntu:omp');
  assert.equal(omp.querySelector('.st-status').textContent, 'Found');
  assert.equal(omp.querySelector('.wl-signin').textContent, 'Sign-in in Ubuntu: unknown (AIB has no sign-in check for OMP).');
  assert.ok(!buttons(omp).includes('Sign in'), 'no Sign in AIB cannot run');
  const foot = t.cardOf('Agents in Ubuntu').querySelector('.wl-foot').textContent;
  assert.ok(!foot.includes('"Found" means'), foot);
  assert.ok(foot.includes('Sign-in is checked in Ubuntu each time this page reads its agents.'));
});

test('Sign in: the distro sign-in terminal on the card (signin=codex&distro=ubuntu, no start); exit 0 reads the agents again and closes it', async () => {
  const t = setup({ agents: () => ({ distro: 'ubuntu', name: 'Ubuntu', agents: [Object.assign({}, CODEX, { signin: { state: 'signed_out' } })] }) });
  await openWsl(t);
  t.rowOf('wsl:ubuntu:codex').querySelectorAll('button').find((b) => b.textContent === 'Sign in').click();
  await settle();
  const url = new URL(t.terms[0].url);
  assert.equal(url.searchParams.get('signin'), 'codex');
  assert.equal(url.searchParams.get('distro'), 'ubuntu');
  assert.equal(url.searchParams.get('start'), null, 'a ready distro: no start');
  const row = t.rowOf('wsl:ubuntu:codex');
  assert.equal(row.querySelector('.st-beta-term-title').textContent, 'Signing in to Codex in Ubuntu');
  assert.ok(!buttons(row).includes('Sign in'), 'one sign-in at a time');
  const before = t.agentCalls().length;
  t.terms[0].hooks.onExit(0);
  await settle();
  assert.ok(t.agentCalls().length > before && t.agentCalls().pop().force === '1');
  assert.equal(t.terms[0].closed, true);
  assert.equal(t.rowOf('wsl:ubuntu:codex').querySelector('.st-beta-term'), null);
  assert.ok(noStart(t));
});

test('Sign in for a distro that stopped running since the page was drawn: start=1, only on that click', async () => {
  const t = setup({ agents: () => ({ distro: 'ubuntu', name: 'Ubuntu', agents: [Object.assign({}, CLAUDE, { signin: { state: 'signed_out' } })] }) });
  await openWsl(t);
  assert.ok(noStart(t), 'opening the page never sends start');
  t.ctx.AIBWsl.status().distros[0].state = 'off'; // not repainted yet: the button is still there
  t.rowOf('wsl:ubuntu:claude').querySelectorAll('button').find((b) => b.textContent === 'Sign in').click();
  await settle();
  assert.equal(new URL(t.terms[0].url).searchParams.get('start'), '1');
  assert.ok(noStart(t), 'the page\'s own questions still never start it');
});

// ---- uninstall -------------------------------------------------------------------------------------------------------------------
test('Uninstall only where canUninstall; the question says exactly what goes; No does nothing; Yes posts {distro, id} and reads the list again', async () => {
  const asked = [];
  let yes = false;
  const t = setup({ agents: () => ({ distro: 'ubuntu', name: 'Ubuntu', agents: [Object.assign({}, CLAUDE, { canUninstall: true }), Object.assign({}, CODEX, { canUninstall: false }), OMP] }) });
  t.ctx.confirm = (q) => (asked.push(q), yes);
  await openWsl(t);
  assert.ok(buttons(t.rowOf('wsl:ubuntu:claude')).includes('Uninstall'));
  assert.equal(t.rowOf('wsl:ubuntu:claude').querySelectorAll('button').find((b) => b.textContent === 'Uninstall').className, 'st-danger');
  assert.ok(!buttons(t.rowOf('wsl:ubuntu:codex')).includes('Uninstall'), 'your own install: never');
  assert.ok(!buttons(t.rowOf('wsl:ubuntu:omp')).includes('Uninstall'));
  const click = () => t.rowOf('wsl:ubuntu:claude').querySelectorAll('button').find((b) => b.textContent === 'Uninstall').click();
  click();
  await settle();
  assert.equal(
    asked[0],
    'Uninstall Claude Code from Ubuntu? This deletes only the copy AIB installed there (~/.aib-server/agents/claude). Your own installs of Claude Code and your sign-in in ~/.claude in Ubuntu stay. To use Claude Code in Ubuntu again, install it again here.',
  );
  assert.equal(t.calls.posts.filter(([n]) => n === 'wsl/agents/uninstall').length, 0, 'No: nothing sent');
  yes = true;
  const before = t.agentCalls().length;
  click();
  await settle();
  assert.deepEqual(t.calls.posts.filter(([n]) => n === 'wsl/agents/uninstall'), [['wsl/agents/uninstall', { distro: 'ubuntu', id: 'claude' }]]);
  assert.equal(t.settingsCalls.filter(([, n]) => n === 'agents/install/uninstall').length, 0, 'not the Windows uninstall');
  assert.ok(t.agentCalls().length > before && t.agentCalls().pop().force === '1');
});

test('Uninstall refused: the blocked reason verbatim on the card; a failed request says its message', async () => {
  const blocked = 'A chat runs from Claude Code in Ubuntu (app · Fix login). End it first.';
  let reply = { ok: false, removed: [], blocked };
  const t = setup({ agents: () => ({ distro: 'ubuntu', name: 'Ubuntu', agents: [Object.assign({}, CLAUDE, { canUninstall: true })] }), uninstall: () => reply });
  t.ctx.confirm = () => true;
  await openWsl(t);
  const click = () => t.rowOf('wsl:ubuntu:claude').querySelectorAll('button').find((b) => b.textContent === 'Uninstall').click();
  click();
  await settle();
  assert.equal(t.rowOf('wsl:ubuntu:claude').querySelector('.st-note.bad').textContent, blocked);
  reply = Error('Ubuntu did not answer.');
  click();
  await settle();
  assert.equal(t.rowOf('wsl:ubuntu:claude').querySelector('.st-note.bad').textContent, 'Ubuntu did not answer.');
});

// ---- Codex limits ----------------------------------------------------------------------------------------------------------------
test('Codex limits: the distro\'s own usage line in the Windows Limits chip\'s words; none without limits, none on other agents', async () => {
  const now = Math.floor(Date.now() / 1000);
  const limits = {
    windows: [
      { label: '5h', name: '5-hour', usedPercent: 32, minutes: 300, resetsAt: now + 3600 },
      { label: 'wk', name: 'Weekly', usedPercent: 10, minutes: 10080, resetsAt: now + 86400 },
    ],
    updatedAt: now - 240,
  };
  const t = setup({ agents: () => ({ distro: 'ubuntu', name: 'Ubuntu', agents: [Object.assign({}, CLAUDE, { limits }), Object.assign({}, CODEX, { limits, signin: { state: 'signed_in' } }), OMP] }) });
  await openWsl(t);
  const line = t.rowOf('wsl:ubuntu:codex').querySelector('.wl-limits');
  assert.equal(line.textContent, 'Usage limits of Ubuntu\'s Codex sign-in: 5h 32% · wk 10% (updated 4 min ago). Same ChatGPT account as on Windows means the same limits.');
  assert.equal(line.querySelector('b').textContent, '5h 32% · wk 10%');
  assert.ok(line.title.includes('5-hour: 32% used'));
  assert.equal(t.rowOf('wsl:ubuntu:claude').querySelector('.wl-limits'), null);
  const n = setup({ agents: () => ({ distro: 'ubuntu', name: 'Ubuntu', agents: [Object.assign({}, CODEX, { limits: null })] }) });
  await openWsl(n);
  assert.equal(n.rowOf('wsl:ubuntu:codex').querySelector('.wl-limits'), null);
});

test('update available: the chip says Update available; the sign-in line stays', async () => {
  const t = setup({ agents: () => ({ distro: 'ubuntu', name: 'Ubuntu', agents: [Object.assign({}, CLAUDE, { version: '0.98.1', update: true, signin: { state: 'signed_in' } })] }) });
  await openWsl(t);
  assert.equal(t.rowOf('wsl:ubuntu:claude').querySelector('.st-status').textContent, 'Update available');
  assert.ok(t.rowOf('wsl:ubuntu:claude').textContent.includes('Signed in to Claude Code in Ubuntu.'));
});

// ==== phase 3 (docs/wsl/linking-design.md section 13): "AIB in Ubuntu" and Remove ===============================================
const MB = 1024 * 1024;
const ROOT = '/home/u/.aib-server';
const USAGE = {
  root: ROOT,
  totalBytes: 1489.5 * MB,
  current: '0.1.0-ab12cd34',
  parts: [
    { key: 'versions', label: 'AIB programs (keeper, helper)', bytes: 190 * MB, path: ROOT + '/0.1.0-ab12cd34' },
    { key: 'agents', label: 'Agents installed by AIB', bytes: 861 * MB, path: ROOT + '/agents' },
    { key: 'npmCache', label: 'npm download cache', bytes: 330 * MB, path: ROOT + '/agents/.npm-cache' },
    { key: 'data', label: "This AIB's data folder", bytes: 12 * MB, path: ROOT + '/data-1a2b3c4d' },
    { key: 'worktrees', label: 'Chat copies of this AIB', bytes: 96 * MB, path: ROOT + '/data-1a2b3c4d/worktrees' },
    { key: 'logs', label: 'Logs', bytes: 512 * 1024, path: ROOT + '/data-1a2b3c4d/logs' },
  ],
  versions: ['0.1.0-ab12cd34', '0.0.9-ffee0011'],
  agents: [
    { id: 'claude', versions: ['0.102.0'], bytes: 404 * MB },
    { id: 'codex', versions: ['2.6.0'], bytes: 457 * MB },
  ],
  dataFolders: [
    { name: 'data-1a2b3c4d', mine: true, keeperAlive: true, bytes: 108 * MB },
    { name: 'data-9f8e7d6c', mine: false, keeperAlive: true, bytes: 40 * MB },
    { name: 'data-55aa66bb', mine: false, keeperAlive: false, bytes: 3 * MB },
  ],
  worktrees: { count: 3, dirty: 1 },
  chatsWorking: 0,
};
const aibOf = (usage, distro = 'ubuntu') => ({ distro, name: distro === 'debian' ? 'Debian' : 'Ubuntu', state: 'ready', line: '', usage });
const KEPT = [
  { path: ROOT + '/agents', why: 'Another AIB data folder (data-9f8e7d6c) is in use: its keeper is running.' },
  { path: ROOT + '/0.1.0-ab12cd34', why: 'Another AIB data folder (data-9f8e7d6c) is in use: its keeper is running.' },
];
const CHECK_OK = {
  ok: true,
  mode: 'check',
  blocked: [],
  wouldRemove: [
    { path: ROOT + '/data-1a2b3c4d', what: "This AIB's data folder", bytes: 12 * MB },
    { path: ROOT + '/data-1a2b3c4d/worktrees/app/chat-1', what: 'Chat copies of this AIB', bytes: 64 * MB },
    { path: ROOT + '/data-1a2b3c4d/worktrees/api/chat-2', what: 'Chat copies of this AIB', bytes: 32 * MB },
    { path: ROOT + '/0.0.9-ffee0011', what: 'Old AIB programs', bytes: 95 * MB },
  ],
  kept: KEPT,
  removed: [],
  left: [],
};
const APPLY_OK = { ok: true, mode: 'apply', blocked: [], wouldRemove: [], kept: KEPT, removed: CHECK_OK.wouldRemove.map((x) => x.path), left: [] };
const REMOVED = Object.assign({}, UBUNTU, { state: 'off', helper: null, removed: true });
const dlg = (t) => t.shell.document.querySelector('.wl-remove');
const dlgButton = (t, label) => dlg(t).querySelectorAll('button').find((b) => b.textContent === label && !b.hidden) || null;
const aibButton = (t, label) => t.cardOf('AIB in Ubuntu').querySelectorAll('button').find((b) => b.textContent === label);
async function openRemove(t) {
  aibButton(t, 'Remove AIB from Ubuntu').click();
  await settle();
}

test('AIB in Ubuntu: at the bottom of the group; disk use by part with the agents under theirs and In all, versions, chat copies, chats working, other data folders', async () => {
  const t = setup();
  await openWsl(t);
  const card = t.cardOf('AIB in Ubuntu');
  assert.ok(card, 'drawn for a ready distro');
  const cards = t.content().querySelectorAll('.st-card');
  assert.equal(cards[cards.length - 1], card, 'the last card of the group');
  assert.ok(card.textContent.includes('Everything AIB keeps in Ubuntu, in /home/u/.aib-server on this PC. Your projects, ~/.claude, ~/.codex and anything you installed yourself are not in it.'));
  const dl = card.querySelector('.wl-usage');
  const pairs = dl.querySelectorAll('dt').map((n, i) => [n.textContent, dl.querySelectorAll('dd')[i].textContent]);
  assert.deepEqual(pairs, [
    ['AIB programs (keeper, helper)', '190 MB'],
    ['Agents installed by AIB', '861 MB'],
    ['Claude Code 0.102.0', '404 MB'],
    ['Codex 2.6.0', '457 MB'],
    ['npm download cache', '330 MB'],
    ["This AIB's data folder", '12 MB'],
    ['Chat copies of this AIB', '96 MB'],
    ['Logs', '512 KB'],
    ['In all', '1.5 GB'],
  ]);
  assert.equal(dl.querySelectorAll('dt')[0].title, ROOT + '/0.1.0-ab12cd34', 'the part\'s folder on hover');
  assert.equal(dl.querySelectorAll('dt.wl-sub').length, 2, 'the agents sit under their part');
  const lines = card.querySelectorAll('.wl-line').map((n) => n.textContent);
  assert.deepEqual(lines, ['AIB versions installed: 0.1.0-ab12cd34 (current), 0.0.9-ffee0011', 'Chat copies: 3, 1 with unsaved changes', 'Chats working now: 0']);
  const others = card.querySelector('.wl-others');
  assert.equal(others.querySelector('.wl-others-title').textContent, 'Other AIB data folders in Ubuntu');
  const rows = others.querySelectorAll('li');
  assert.deepEqual(rows.map((r) => r.querySelector('code').textContent), ['data-9f8e7d6c', 'data-55aa66bb'], 'never this AIB\'s own');
  assert.deepEqual(rows.map((r) => r.querySelector('.wl-size').textContent), ['40 MB', '3 MB']);
  assert.equal(rows[0].querySelector('.st-status').textContent, 'in use', 'its keeper is alive');
  assert.equal(rows[1].querySelector('.st-status'), null);
  assert.ok(others.textContent.includes('These belong to another AIB build or data folder. Remove here never touches them.'));
  assert.ok(!buttons(others).length, 'read-only');
  assert.deepEqual(buttons(card), ['Remove AIB from Ubuntu', 'Refresh']);
  assert.equal(aibButton(t, 'Remove AIB from Ubuntu').className, 'st-danger');
});

test('AIB in Ubuntu: no other data folders, no dirty copies, no copies: said plainly; the current version listed even if missing from versions', async () => {
  const usage = Object.assign({}, USAGE, { dataFolders: [USAGE.dataFolders[0]], worktrees: { count: 2, dirty: 0 }, versions: [], chatsWorking: 2 });
  const t = setup({ aib: () => aibOf(usage) });
  await openWsl(t);
  const card = t.cardOf('AIB in Ubuntu');
  assert.equal(card.querySelector('.wl-others'), null);
  assert.deepEqual(card.querySelectorAll('.wl-line').map((n) => n.textContent), ['AIB versions installed: 0.1.0-ab12cd34 (current)', 'Chat copies: 2, none with unsaved changes', 'Chats working now: 2']);
  const n = setup({ aib: () => aibOf(Object.assign({}, USAGE, { worktrees: { count: 0, dirty: 0 } })) });
  await openWsl(n);
  assert.ok(n.cardOf('AIB in Ubuntu').querySelectorAll('.wl-line').some((x) => x.textContent === 'Chat copies: none'));
});

test('AIB in Ubuntu is read with peek=1 only on open (no start, no force); not drawn for a distro that is not running; Refresh adds force=1, never start', async () => {
  const t = setup({ status: status([UBUNTU, DEBIAN]) });
  await openWsl(t);
  assert.deepEqual(t.aibCalls(), [{ distro: 'ubuntu', peek: '1' }]);
  t.UI.close();
  t.UI.open('wsl');
  await settle();
  assert.equal(t.aibCalls().length, 1, 'kept for a minute');
  await t.choose('debian');
  assert.equal(t.cardOf('AIB in Debian'), null, 'Debian is not running: nothing new beyond Start and check');
  assert.ok(buttons(t.cardOf('Debian')).includes('Start Debian and check'));
  assert.ok(t.aibCalls().every((q) => q.distro === 'ubuntu'), 'nothing asked of Debian');
  await t.choose('ubuntu');
  aibButton(t, 'Refresh').click();
  await settle();
  assert.deepEqual(t.aibCalls().pop(), { distro: 'ubuntu', peek: '1', force: '1' });
  assert.ok(t.aibCalls().every((q) => !('start' in q)), 'never start');
  assert.equal(t.removeCalls().length, 0, 'opening the page asks no removal question');
});

test('AIB in Ubuntu while the answer says not ready (usage: null): its line, no Remove; a read error: the reason with Refresh', async () => {
  const t = setup({ aib: () => ({ distro: 'ubuntu', name: 'Ubuntu', state: 'starting', line: 'Starting Ubuntu…', usage: null }) });
  await openWsl(t);
  const card = t.cardOf('AIB in Ubuntu');
  assert.ok(card.textContent.includes('Starting Ubuntu…'));
  assert.deepEqual(buttons(card), []);
  const e = setup({ aib: () => Error('Ubuntu did not answer.') });
  await openWsl(e);
  const ec = e.cardOf('AIB in Ubuntu');
  assert.equal(ec.querySelector('.st-note.bad').textContent, 'What AIB keeps in Ubuntu could not be read: Ubuntu did not answer.');
  assert.deepEqual(buttons(ec), ['Remove AIB from Ubuntu', 'Refresh']);
});

test('Remove: the check (deletes nothing) fills a dialog with what goes grouped with sizes, what is kept and why, and what is never touched; Cancel sends nothing more', async () => {
  const t = setup();
  await openWsl(t);
  await openRemove(t);
  assert.deepEqual(t.removeCalls(), [{ distro: 'ubuntu', mode: 'check' }]);
  const box = dlg(t);
  assert.ok(box, 'an in-page dialog, never window.confirm');
  assert.equal(box.getAttribute('role'), 'alertdialog');
  assert.ok(box.className.includes('dp-dialog'), 'the delete-project dialog look');
  assert.ok(t.shell.document.querySelector('.dp-scrim'));
  assert.equal(box.querySelector('.dp-title').textContent, 'Remove AIB from Ubuntu?');
  const gone = box.querySelector('.wl-rm-gone');
  assert.equal(gone.querySelector('.wl-rm-head').textContent, 'Deleted (203 MB in all):');
  const items = gone.querySelectorAll('.wl-rm-item');
  assert.deepEqual(items.map((li) => li.querySelector('.wl-rm-line').textContent), ["This AIB's data folder12 MB", 'Chat copies of this AIB (2)96 MB', 'Old AIB programs95 MB']);
  assert.deepEqual(items[1].querySelectorAll('.wl-rm-path').map((c) => c.textContent), [ROOT + '/data-1a2b3c4d/worktrees/app/chat-1', ROOT + '/data-1a2b3c4d/worktrees/api/chat-2']);
  const kept = box.querySelector('.wl-rm-kept');
  assert.deepEqual(kept.querySelectorAll('li').map((li) => [li.querySelector('code').textContent, li.querySelector('.wl-rm-why').textContent]), KEPT.map((k) => [k.path, k.why]));
  assert.ok(box.textContent.includes('Your projects, ~/.claude, ~/.codex, nvm and asdf are not touched.'));
  assert.ok(box.textContent.includes('Chat branches stay in your repos.'));
  assert.equal(dlgButton(t, 'Remove AIB from Ubuntu').disabled, false);
  assert.equal(dlgButton(t, 'Remove AIB from Ubuntu').className, 'cg-confirm-yes cg-discard dp-ok');
  assert.equal(dlgButton(t, 'Check again'), null, 'nothing blocks it');
  assert.equal(t.shell.document.activeElement, dlgButton(t, 'Cancel'), 'Cancel has the focus');
  assert.equal(box.querySelector('.dp-disk').hidden, true, 'no tick when no chat works');
  dlgButton(t, 'Cancel').click();
  await settle();
  assert.equal(dlg(t), null);
  assert.equal(t.shell.document.querySelector('.dp-scrim'), null);
  assert.deepEqual(t.removeCalls(), [{ distro: 'ubuntu', mode: 'check' }], 'no apply');
  await openRemove(t);
  dlg(t).dispatch('keydown', { key: 'Escape' });
  assert.equal(dlg(t), null, 'Escape cancels');
});

test('Remove blocked: each reason verbatim on its own line, the button off, only Close and Check again (which checks again)', async () => {
  const reasons = ['A WSL chat is working in Ubuntu (app · Fix login). Wait for it or stop it first.', '1 chat copy has changes that are not committed: api · Add tests. Merge or discard them first.'];
  let reply = Object.assign({}, CHECK_OK, { ok: false, blocked: reasons });
  const t = setup({ remove: () => reply });
  await openWsl(t);
  await openRemove(t);
  const box = dlg(t);
  assert.equal(box.querySelector('.wl-rm-blocked').querySelector('p').textContent, 'AIB cannot be removed from Ubuntu now:');
  assert.deepEqual(box.querySelectorAll('.wl-reason').map((p) => p.textContent), reasons);
  assert.equal(box.querySelector('.wl-rm-head').textContent, 'Remove would delete (203 MB in all):', 'still lists what it would delete');
  const yes = box.querySelectorAll('button').find((b) => b.textContent === 'Remove AIB from Ubuntu');
  assert.equal(yes.disabled, true);
  assert.deepEqual(box.querySelectorAll('button').filter((b) => !b.hidden && !b.disabled).map((b) => b.textContent), ['Close', 'Check again']);
  yes.click();
  yes.click();
  await settle();
  assert.ok(t.removeCalls().every((b) => b.mode === 'check'), 'never an apply');
  reply = CHECK_OK;
  dlgButton(t, 'Check again').click();
  await settle();
  assert.deepEqual(t.removeCalls(), [{ distro: 'ubuntu', mode: 'check' }, { distro: 'ubuntu', mode: 'check' }]);
  assert.equal(dlg(t).querySelectorAll('.wl-reason').length, 0);
  assert.equal(dlgButton(t, 'Remove AIB from Ubuntu').disabled, false, 'on once nothing blocks it');
  assert.equal(dlgButton(t, 'Check again'), null);
});

test('Remove: a second click confirms; while it runs the dialog says Removing… and the card\'s buttons are off; nothing is claimed before the answer; then "AIB is not set up" with Set up again', async () => {
  let release;
  let t;
  t = setup({
    remove: (b) =>
      b.mode === 'check'
        ? CHECK_OK
        : new Promise((r) => {
            release = () => {
              t.set(status([REMOVED]));
              r(APPLY_OK);
            };
          }),
  });
  await openWsl(t);
  await openRemove(t);
  dlgButton(t, 'Remove AIB from Ubuntu').click();
  await settle();
  assert.equal(t.removeCalls().length, 1, 'the first click only asks again');
  assert.equal(dlg(t).querySelector('.dp-warn').textContent, 'Choose Remove AIB from Ubuntu again to delete these. This cannot be undone.');
  dlgButton(t, 'Remove AIB from Ubuntu').click();
  await settle();
  assert.deepEqual(t.removeCalls().pop(), { distro: 'ubuntu', mode: 'apply', confirm: true });
  const yes = dlg(t).querySelectorAll('button').find((b) => b.textContent === 'Removing…');
  assert.ok(yes && yes.disabled, 'Removing…');
  assert.equal(dlgButton(t, 'Cancel').disabled, true);
  dlg(t).dispatch('keydown', { key: 'Escape' });
  assert.ok(dlg(t), 'Escape does not close it while it runs');
  const card = t.cardOf('AIB in Ubuntu');
  assert.ok(card, 'still the ready group: no success claimed yet');
  assert.ok(buttons(card).length === 2 && card.querySelectorAll('button').every((b) => b.disabled), 'the card\'s buttons are off');
  assert.ok(card.textContent.includes('Removing AIB from Ubuntu…'));
  assert.ok(!t.content().textContent.includes('AIB is not set up'));
  release();
  await settle();
  await settle();
  assert.equal(dlg(t), null, 'closed on success');
  assert.deepEqual(t.groups(), ['Ubuntu'], 'the distro stays selectable and shown');
  const st = t.cardOf('Ubuntu');
  assert.equal(st.dataset.removed, '1');
  assert.ok(st.textContent.includes('AIB is not set up in Ubuntu.'));
  assert.deepEqual(buttons(st), ['Set up again']);
  assert.equal(t.cardOf('AIB in Ubuntu'), null);
  assert.equal(t.cardOf('Agents in Ubuntu'), null);
  assert.equal(t.cardOf('What Ubuntu needs'), null);
  assert.equal(t.cardOf('WSL on this PC').querySelector('.st-status').textContent, 'Not set up');
  // Set up again: the Start and check flow (peek=1&start=1); the next status clears the removed state
  const before = t.aibCalls().length;
  st.querySelector('button').click();
  await settle();
  assert.deepEqual(t.agentCalls().pop(), { distro: 'ubuntu', peek: '1', start: '1' });
  t.ctx.AIBWsl._set(status([UBUNTU]));
  await settle();
  assert.ok(t.cardOf('AIB in Ubuntu'), 'set up again: the card is back');
  assert.ok(t.aibCalls().length > before, 'and read again (peek)');
  assert.ok(t.aibCalls().every((q) => !('start' in q)));
  assert.ok(!t.content().textContent.includes('AIB is not set up'));
});

test('Remove while chats work in Ubuntu: the check shows the tick "I understand chats running in Ubuntu will stop"; the button stays off until it is ticked', async () => {
  const t = setup({ aib: () => aibOf(Object.assign({}, USAGE, { chatsWorking: 1 })) });
  await openWsl(t);
  await openRemove(t);
  const row = dlg(t).querySelector('.dp-disk');
  assert.equal(row.hidden, false);
  assert.equal(row.querySelector('span').textContent, 'I understand chats running in Ubuntu will stop');
  assert.equal(dlgButton(t, 'Remove AIB from Ubuntu').disabled, true);
  const tick = row.querySelector('input');
  tick.checked = true;
  tick.dispatch('change');
  assert.equal(dlgButton(t, 'Remove AIB from Ubuntu').disabled, false);
  dlgButton(t, 'Remove AIB from Ubuntu').click();
  await settle();
  assert.deepEqual(t.removeCalls().pop(), { distro: 'ubuntu', mode: 'apply', confirm: true }, 'the tick replaces the second click');
});

test('Remove partly fails: the dialog says the message and the left list verbatim (and what went); the card keeps them after Close', async () => {
  const left = [ROOT + '/data-1a2b3c4d/worktrees/app/chat-1: permission denied'];
  const message = 'AIB could not delete 1 folder in Ubuntu. Delete it yourself, or try again after a restart of Ubuntu.';
  let t;
  t = setup({
    remove: (b) => {
      if (b.mode === 'check') return CHECK_OK;
      t.set(status([REMOVED]));
      return { ok: false, mode: 'apply', blocked: [], wouldRemove: [], kept: KEPT, removed: [ROOT + '/data-1a2b3c4d'], left, message };
    },
  });
  await openWsl(t);
  await openRemove(t);
  dlgButton(t, 'Remove AIB from Ubuntu').click();
  dlgButton(t, 'Remove AIB from Ubuntu').click();
  await settle();
  await settle();
  const box = dlg(t);
  assert.ok(box, 'stays open to say what happened');
  assert.equal(box.querySelector('.dp-main').textContent, 'AIB could not remove everything from Ubuntu.');
  assert.equal(box.querySelector('.wl-rm-message').textContent, message);
  assert.deepEqual(box.querySelector('.wl-rm-left').querySelectorAll('li').map((li) => li.textContent), left);
  assert.deepEqual(box.querySelector('.wl-rm-done').querySelectorAll('li').map((li) => li.textContent), [ROOT + '/data-1a2b3c4d']);
  assert.deepEqual(box.querySelectorAll('button').filter((b) => !b.hidden).map((b) => b.textContent), ['Close']);
  dlgButton(t, 'Close').click();
  await settle();
  const st = t.cardOf('Ubuntu');
  assert.ok(st.textContent.includes('AIB is not set up in Ubuntu.'), 'the host is off with the removed flag');
  assert.ok(st.querySelectorAll('.st-note.bad').some((n) => n.textContent === message));
  assert.deepEqual(st.querySelector('.wl-left').querySelectorAll('li').map((li) => li.textContent), left);
});

test('Remove refused when it runs (apply answers blocked): the reasons, nothing removed, the group as it was; a failed request says its message', async () => {
  const why = 'An install of Codex runs in Ubuntu. Wait for it or cancel it first.';
  let apply = { ok: false, mode: 'apply', blocked: [why], wouldRemove: CHECK_OK.wouldRemove, kept: KEPT, removed: [], left: [] };
  const t = setup({ remove: (b) => (b.mode === 'check' ? CHECK_OK : apply) });
  await openWsl(t);
  await openRemove(t);
  dlgButton(t, 'Remove AIB from Ubuntu').click();
  dlgButton(t, 'Remove AIB from Ubuntu').click();
  await settle();
  assert.deepEqual(dlg(t).querySelectorAll('.wl-reason').map((p) => p.textContent), [why]);
  assert.equal(dlg(t).querySelectorAll('button').find((b) => b.textContent === 'Remove AIB from Ubuntu').disabled, true);
  assert.ok(t.cardOf('AIB in Ubuntu'), 'still set up');
  apply = Error('Ubuntu is not running.');
  dlgButton(t, 'Check again').click();
  await settle();
  dlgButton(t, 'Remove AIB from Ubuntu').click();
  dlgButton(t, 'Remove AIB from Ubuntu').click();
  await settle();
  const err = dlg(t).querySelector('.dp-error');
  assert.equal(err.hidden, false);
  assert.equal(err.textContent, 'Ubuntu is not running.');
  assert.equal(dlgButton(t, 'Remove AIB from Ubuntu').disabled, false, 'can be tried again');
  assert.ok(t.cardOf('AIB in Ubuntu') && !t.content().textContent.includes('AIB is not set up'));
});

test('removed flag after a reload (status removed: true, state off): "AIB is not set up in Ubuntu" with Set up again, not Start and check; nothing asked of the distro', async () => {
  const t = setup({ status: status([REMOVED]) });
  await openWsl(t);
  const st = t.cardOf('Ubuntu');
  assert.ok(st.textContent.includes('AIB is not set up in Ubuntu.'));
  assert.deepEqual(buttons(st), ['Set up again']);
  assert.ok(!st.textContent.includes('Start Ubuntu and check'));
  assert.deepEqual(t.aibCalls(), []);
  assert.deepEqual(t.agentCalls(), []);
  assert.deepEqual(t.picker().querySelectorAll('option').map((o) => o.textContent), ['Ubuntu (WSL default)'], 'still in the drop-down');
});

test('the drop-down: each distro shows its own AIB card and its own Remove', async () => {
  const debianUsage = Object.assign({}, USAGE, { root: '/home/d/.aib-server', totalBytes: 300 * MB, dataFolders: [], worktrees: { count: 0, dirty: 0 } });
  const t = setup({ status: status([UBUNTU, DEBIAN_READY]), agents: listOf, aib: (q) => (q.distro === 'debian' ? aibOf(debianUsage, 'debian') : aibOf(USAGE)) });
  await openWsl(t);
  assert.ok(t.cardOf('AIB in Ubuntu').textContent.includes('/home/u/.aib-server'));
  await t.choose('debian');
  const card = t.cardOf('AIB in Debian');
  assert.ok(card.textContent.includes('in /home/d/.aib-server on this PC'));
  assert.equal(card.querySelector('.wl-others'), null);
  assert.equal(t.cardOf('AIB in Ubuntu'), null);
  assert.deepEqual(t.aibCalls(), [{ distro: 'ubuntu', peek: '1' }, { distro: 'debian', peek: '1' }]);
  card.querySelectorAll('button').find((b) => b.textContent === 'Remove AIB from Debian').click();
  await settle();
  assert.deepEqual(t.removeCalls(), [{ distro: 'debian', mode: 'check' }]);
  assert.equal(dlg(t).querySelector('.dp-title').textContent, 'Remove AIB from Debian?');
});

test('bytesText and groupRemove', () => {
  const t = setup();
  const S = t.ctx.AIBWslSettings;
  assert.equal(S.bytesText(0), '0 bytes');
  assert.equal(S.bytesText(2048), '2 KB');
  assert.equal(S.bytesText(5 * MB), '5 MB');
  assert.equal(S.bytesText(1024 * MB), '1 GB');
  assert.deepEqual(plain(S.groupRemove(CHECK_OK.wouldRemove)).map((g) => [g.what, g.bytes / MB, g.paths.length]), [
    ["This AIB's data folder", 12, 1],
    ['Chat copies of this AIB', 96, 2],
    ['Old AIB programs', 95, 1],
  ]);
});
