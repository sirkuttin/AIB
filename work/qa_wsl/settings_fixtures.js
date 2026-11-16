/* QA (looks) of Settings > AIB Linking (WSL): runs IN the headless browser, after the real page scripts (wsl-ui.js, terminal-ui.js,
   composer-chips.js, settings-ui.js, wsl-settings-ui.js). Fake routes of the frozen contract shapes (docs/wsl/linking-design.md
   sections 12-13), copied from work/test_wsl_settings.js. The scenario is location.hash; window.__qaDone is set when it is drawn.
   No network: every route answers from here. Terminals are a stand-in panel (xterm loads from the server in the app). */
(function () {
  'use strict';
  const MB = 1024 * 1024;
  const now = Math.floor(Date.now() / 1000);
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const settle = async (n = 6) => {
    for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => requestAnimationFrame(() => r()));
  };

  const UBUNTU = { name: 'Ubuntu', key: 'ubuntu', state: 'ready', line: '', home: '/home/u', helper: '0.1.0-ab12cd34', problem: '', isDefault: true };
  const DEBIAN = { name: 'Debian', key: 'debian', state: 'off', line: '', home: null, helper: null, problem: '', isDefault: false };
  const DEBIAN_READY = Object.assign({}, UBUNTU, { name: 'Debian', key: 'debian', home: '/home/d', isDefault: false });
  const DOCKER = { name: 'docker-desktop', why: "docker-desktop is Docker's own distro; AIB cannot run there." };
  const WSL1 = { name: 'Ubuntu-20.04', why: 'Ubuntu-20.04 runs on WSL 1. AIB needs WSL 2.' };
  const LONGD = { name: 'Ubuntu-24.04-Developer-Workstation-With-A-Very-Long-Distro-Name', key: 'ubuntu-24.04-developer-workstation-with-a-very-long-distro-name', state: 'ready', line: '', home: '/home/someone-with-a-long-user-name', helper: '0.1.0-ab12cd34', problem: '', isDefault: true };
  const status = (distros, extra = {}) => Object.assign({ available: distros.length > 0, distros, openRequests: [], skipped: [], wsl: { exe: true, problem: '' } }, extra);

  const CLAUDE = { id: 'claude', found: true, version: '0.102.0', installable: true, pinned: '0.102.0', managed: true, bundledCli: true, enabled: true, canUninstall: true };
  const CODEX = { id: 'codex', found: true, version: '2.6.0', installable: true, pinned: '2.6.0', managed: false, bundledCli: false, enabled: true };
  const OMP_FOUND = { id: 'omp', found: true, version: '1.2.0', enabled: true };
  const OMP = { id: 'omp', found: false, enabled: true };
  const list = (agents, distro = 'ubuntu', name = 'Ubuntu') => ({ distro, name, agents });
  const signedIn = (a, account) => Object.assign({}, a, { signin: { state: 'signed_in', account } });

  const WIN = [
    { id: 'claude', name: 'Claude Code', letter: 'C', builtin: true, enabled: true, found: true, launcher: 'claude-agent-acp', launcherSource: 'installed', version: '0.102.0' },
    { id: 'codex', name: 'Codex', letter: 'X', builtin: true, enabled: false, found: true, launcher: 'codex-acp', launcherSource: 'installed' },
    { id: 'omp', name: 'OMP', letter: 'O', builtin: true, enabled: true, found: false, launcher: 'Not installed', launcherSource: 'missing' },
  ];

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
  const needsOf = (p, distro = 'ubuntu', name) => ({ distro, name: name || (distro === 'debian' ? 'Debian' : 'Ubuntu'), state: 'ready', line: '', prereqs: p });

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
  const aibOf = (usage, distro = 'ubuntu', name) => ({ distro, name: name || (distro === 'debian' ? 'Debian' : 'Ubuntu'), state: 'ready', line: '', usage });
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
  const BLOCKED = ['A WSL chat is working in Ubuntu (app · Fix login). Wait for it or stop it first.', '1 chat copy has changes that are not committed: api · Add tests. Merge or discard them first.'];
  const LONG_PATH = ROOT + '/data-1a2b3c4d/worktrees/a-project-with-a-rather-long-folder-name/chat-claude-pensive-ritchie-26be75-and-some-more/node_modules/.cache';
  const LIMITS = {
    windows: [
      { label: '5h', name: '5-hour', usedPercent: 32, minutes: 300, resetsAt: now + 3600 },
      { label: 'wk', name: 'Weekly', usedPercent: 10, minutes: 10080, resetsAt: now + 86400 },
    ],
    updatedAt: now - 240,
  };

  // --- scenarios: o = the setup() options of work/test_wsl_settings.js, plus section and after(t) ---------------------------------
  const good = { status: status([UBUNTU], { skipped: [DOCKER] }), agents: () => list([signedIn(CLAUDE, 'me@example.com'), Object.assign({}, CODEX, { signin: { state: 'signed_in' }, limits: LIMITS }), OMP_FOUND]) };
  const S = {
    'good': good,
    'node-missing': {
      status: status([UBUNTU]),
      prereqs: (q) => needsOf(withNode({ state: 'missing' }, { nvm: { present: false } }), q.distro),
      agents: () => list([{ id: 'claude', found: false, installable: true, pinned: '0.102.0', nodeInstall: 'curl … nvm', enabled: true }, { id: 'codex', found: false, installable: true, pinned: '2.6.0', enabled: true }, OMP]),
    },
    'node-old': { status: status([UBUNTU]), prereqs: (q) => needsOf(withNode({ state: 'old', version: '18.19.1', manager: 'system', path: '/usr/bin/node' }), q.distro), agents: () => list([{ id: 'claude', found: false, installable: true, pinned: '0.102.0', enabled: true }, CODEX, OMP]) },
    'asdf': {
      status: status([UBUNTU]),
      prereqs: (q) => needsOf(withNode({ state: 'shim_unset', manager: 'asdf', path: '/home/u/.asdf/shims/node' }, { canInstallNode: false, nodeInstallBlocked: 'Node.js comes from asdf in Ubuntu, so AIB does not install another one.', nvm: { present: false } }), q.distro),
      agents: () => list([{ id: 'claude', found: false, installable: true, pinned: '0.102.0', enabled: true }, CODEX, OMP]),
    },
    'pkg-missing': { status: status([UBUNTU]), prereqs: (q) => needsOf(Object.assign({}, P_OK, { git: { state: 'missing' }, curl: { state: 'missing' }, pkgManager: 'dnf', diskFreeMB: 380, envMode: 'plain', loginShell: '/bin/bash' }), q.distro) },
    'installing': {
      status: status([UBUNTU]),
      agents: () => list([Object.assign({ id: 'claude', found: false, installable: true, pinned: '0.102.0', enabled: true }, { job: { state: 'running', stage: 'downloading', percent: 46 } }), CODEX, OMP]),
      installGet: () => ({ state: 'running', stage: 'downloading', percent: 46 }),
    },
    'update': { status: status([UBUNTU]), agents: () => list([Object.assign({}, CLAUDE, { version: '0.98.1', update: true, signin: { state: 'signed_in' } }), Object.assign({}, CODEX, { managed: true, signin: { state: 'signed_out' } }), OMP]) },
    'error': {
      status: status([UBUNTU]),
      prereqs: (q) => needsOf(Object.assign({}, P_OK, { git: { state: 'missing' } }), q.distro),
      agents: () => list([signedIn(CLAUDE), { id: 'codex', found: false, installable: true, pinned: '2.6.0', job: { state: 'failed', message: 'The install failed: npm could not reach registry.npmjs.org (ETIMEDOUT).' }, enabled: true }, OMP]),
      remove: (b) => Object.assign({}, CHECK_OK, { ok: false, blocked: BLOCKED }),
    },
    'signin': {
      status: status([UBUNTU]),
      agents: () => list([signedIn(CLAUDE, 'me@example.com'), Object.assign({}, CODEX, { signin: { state: 'signed_out' } }), Object.assign({}, OMP_FOUND, { signin: { state: 'unknown', note: 'AIB has no sign-in check for OMP.' } })]),
    },
    'switch-fail': {
      status: status([UBUNTU]),
      agents: () => list([Object.assign({}, CLAUDE, { enabled: false }), Object.assign({}, CODEX, { enabled: true }), OMP]),
      enabled: () => Promise.reject(new Error('The settings file could not be written.')),
      after: async (t) => {
        const box = t.row('wsl:ubuntu:codex').querySelector('.st-actions input');
        box.checked = false;
        box.dispatchEvent(new Event('change', { bubbles: true }));
        await settle(10);
      },
    },
    'stopped': { status: status([Object.assign({}, UBUNTU, { state: 'stopped', line: 'Ubuntu stopped. Reconnect', helper: null })]) },
    'off': { status: status([Object.assign({}, UBUNTU, { state: 'off', helper: null, home: null })]) },
    'starting': { status: status([Object.assign({}, UBUNTU, { state: 'installing', line: 'Setting up AIB in Ubuntu (first time, ~100 MB)', helper: null })]) },
    'problem': { status: status([Object.assign({}, UBUNTU, { state: 'unavailable', problem: 'The AIB helper in Ubuntu failed its checksum.', helper: null })]) },
    'nowsl': { status: status([], { wsl: { exe: false, problem: '' } }) },
    'nodistro': { status: status([], { wsl: { exe: true, problem: '' } }) },
    'two': {
      status: status([DEBIAN, UBUNTU], { skipped: [DOCKER, WSL1] }),
      agents: (q) => list([signedIn(CLAUDE), CODEX, OMP], q.distro, q.distro === 'debian' ? 'Debian' : 'Ubuntu'),
      after: async (t) => {
        // a native <select> drop-down is drawn by the OS, not in a screenshot: show the same element as an open list box (size=n)
        const sel = t.picker();
        sel.dataset.qaSize = '1';
        sel.size = sel.options.length;
        await settle();
      },
    },
    'two-debian': {
      status: status([UBUNTU, DEBIAN_READY]),
      agents: (q) => list([signedIn(CLAUDE), CODEX, OMP], q.distro, q.distro === 'debian' ? 'Debian' : 'Ubuntu'),
      prereqs: (q) => needsOf(P_OK, q.distro),
      aib: (q) => aibOf(USAGE, q.distro),
      store: { 'aib-wsl-distro': 'debian' },
    },
    'aib-clean': { status: status([UBUNTU]), aib: () => aibOf(Object.assign({}, USAGE, { dataFolders: [USAGE.dataFolders[0]], worktrees: { count: 2, dirty: 0 }, versions: [], chatsWorking: 2 })) },
    'aib-notready': { status: status([UBUNTU]), aib: () => ({ distro: 'ubuntu', name: 'Ubuntu', state: 'starting', line: 'Starting Ubuntu…', usage: null }) },
    'aib-error': { status: status([UBUNTU]), aib: () => Promise.reject(new Error('Ubuntu did not answer.')) },
    'rm-check': Object.assign({}, good, { after: (t) => t.openRemove() }),
    'rm-blocked': Object.assign({}, good, { remove: () => Object.assign({}, CHECK_OK, { ok: false, blocked: BLOCKED }), after: (t) => t.openRemove() }),
    'rm-second': Object.assign({}, good, {
      after: async (t) => {
        await t.openRemove();
        t.dlgButton('Remove AIB from Ubuntu').click();
        await settle();
      },
    }),
    'rm-tick': Object.assign({}, good, { aib: () => aibOf(Object.assign({}, USAGE, { chatsWorking: 1 })), after: (t) => t.openRemove() }),
    'rm-removing': Object.assign({}, good, {
      remove: (b) => (b.mode === 'check' ? CHECK_OK : new Promise(() => {})),
      after: async (t) => {
        await t.openRemove();
        t.dlgButton('Remove AIB from Ubuntu').click();
        await settle();
        t.dlgButton('Remove AIB from Ubuntu').click();
        await settle();
      },
    }),
    'rm-done': Object.assign({}, good, {
      remove: (b) => {
        if (b.mode === 'check') return CHECK_OK;
        window.__qaSetStatus(status([REMOVED], { skipped: [DOCKER] }));
        return APPLY_OK;
      },
      after: async (t) => {
        await t.openRemove();
        t.dlgButton('Remove AIB from Ubuntu').click();
        await settle();
        t.dlgButton('Remove AIB from Ubuntu').click();
        await settle(14);
      },
    }),
    'rm-partial': Object.assign({}, good, {
      remove: (b) => {
        if (b.mode === 'check') return CHECK_OK;
        window.__qaSetStatus(status([REMOVED]));
        return { ok: false, mode: 'apply', blocked: [], wouldRemove: [], kept: KEPT, removed: [ROOT + '/data-1a2b3c4d'], left: [ROOT + '/data-1a2b3c4d/worktrees/app/chat-1: permission denied'], message: 'AIB could not delete 1 folder in Ubuntu. Delete it yourself, or try again after a restart of Ubuntu.' };
      },
      after: async (t) => {
        await t.openRemove();
        t.dlgButton('Remove AIB from Ubuntu').click();
        await settle();
        t.dlgButton('Remove AIB from Ubuntu').click();
        await settle(14);
      },
    }),
    'rm-partial-closed': Object.assign({}, good, {
      remove: (b) => {
        if (b.mode === 'check') return CHECK_OK;
        window.__qaSetStatus(status([REMOVED]));
        return { ok: false, mode: 'apply', blocked: [], wouldRemove: [], kept: KEPT, removed: [ROOT + '/data-1a2b3c4d'], left: [ROOT + '/data-1a2b3c4d/worktrees/app/chat-1: permission denied'], message: 'AIB could not delete 1 folder in Ubuntu. Delete it yourself, or try again after a restart of Ubuntu.' };
      },
      after: async (t) => {
        await t.openRemove();
        t.dlgButton('Remove AIB from Ubuntu').click();
        await settle();
        t.dlgButton('Remove AIB from Ubuntu').click();
        await settle(14);
        t.dlgButton('Close').click();
        await settle(10);
      },
    }),
    'rm-long': Object.assign({}, good, {
      remove: () => ({
        ok: false,
        mode: 'check',
        blocked: ['A WSL chat is working in Ubuntu (a-project-with-a-rather-long-folder-name · Refactor the whole authentication layer to use the new session tokens and keep the old ones working). Wait for it or stop it first.'],
        wouldRemove: CHECK_OK.wouldRemove.concat([{ path: LONG_PATH, what: 'Chat copies of this AIB', bytes: 7 * MB }]),
        kept: KEPT.concat([{ path: ROOT + '/agents/claude/0.102.0/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64', why: 'A process of another AIB data folder (data-9f8e7d6c) runs from it: /home/u/.aib-server/agents/claude/0.102.0/node_modules/.bin/claude-agent-acp --stdio.' }]),
        removed: [],
        left: [],
      }),
      after: (t) => t.openRemove(),
    }),
    'uninstall-ask': Object.assign({}, good, {
      after: async (t) => {
        window.confirm = (q) => {
          window.__qaConfirm = q;
          return false;
        };
        t.row('wsl:ubuntu:claude').querySelectorAll('button').forEach((b) => b.textContent === 'Uninstall' && b.click());
        await settle();
      },
    }),
    'uninstall-refused': Object.assign({}, good, {
      uninstall: () => ({ ok: false, removed: [], blocked: 'A chat runs from Claude Code in Ubuntu (app · Fix login). End it first.' }),
      after: async (t) => {
        window.confirm = () => true;
        t.row('wsl:ubuntu:claude').querySelectorAll('button').forEach((b) => b.textContent === 'Uninstall' && b.click());
        await settle(10);
      },
    }),
    'node-term': Object.assign({}, {
      status: status([UBUNTU]),
      prereqs: (q) => needsOf(withNode({ state: 'missing' }, { nvm: { present: false } }), q.distro),
      agents: () => list([{ id: 'claude', found: false, installable: true, pinned: '0.102.0', enabled: true }, CODEX, OMP]),
      after: async (t) => {
        t.card('What Ubuntu needs').querySelectorAll('button').forEach((b) => b.textContent === 'Install Node.js in Ubuntu' && b.click());
        await settle(10);
      },
    }),
    'signin-term': Object.assign({}, {
      status: status([UBUNTU]),
      agents: () => list([signedIn(CLAUDE), Object.assign({}, CODEX, { signin: { state: 'signed_out' } }), OMP]),
      after: async (t) => {
        t.row('wsl:ubuntu:codex').querySelectorAll('button').forEach((b) => b.textContent === 'Sign in' && b.click());
        await settle(10);
      },
    }),
    'long': {
      status: status([LONGD], { skipped: [{ name: 'Some-Other-Distro-With-A-Very-Long-Name-That-Will-Not-Fit', why: 'Some-Other-Distro-With-A-Very-Long-Name-That-Will-Not-Fit runs on WSL 1. AIB needs WSL 2.' }] }),
      agents: (q) => list([signedIn(CLAUDE, 'a.very.long.email.address.for.testing@some-company-with-a-long-domain.example.com'), Object.assign({}, CODEX, { signin: { state: 'signed_out' }, limits: LIMITS }), Object.assign({}, OMP_FOUND, { signin: { state: 'unknown', note: 'AIB has no sign-in check for OMP, and this note is long on purpose to see how a long reason wraps in a narrow window.' } })], q.distro, LONGD.name),
      prereqs: (q) => needsOf(withNode({ state: 'ok', version: '24.11.1', path: '/home/someone-with-a-long-user-name/.local/share/version-managers/nvm/versions/node/v24.11.1/bin/node', manager: 'nvm' }), q.distro, LONGD.name),
      aib: (q) => aibOf(Object.assign({}, USAGE, { root: '/home/someone-with-a-long-user-name/.aib-server' }), q.distro, LONGD.name),
    },
    'many-agents': {
      status: status([UBUNTU]),
      agents: () => list([signedIn(CLAUDE), CODEX, OMP].concat(Array.from({ length: 27 }, (_, i) => ({ id: 'agent' + (i + 1), name: 'Agent number ' + (i + 1), found: i % 3 === 0, version: '1.' + i + '.0', installable: i % 2 === 0, pinned: '1.' + i + '.0', enabled: true })))),
    },
    'about': Object.assign({}, good, { section: 'server' }),
    'win-agents': Object.assign({}, good, { section: 'agents' }),
  };

  // --- the setup() of work/test_wsl_settings.js, in a real page ---------------------------------------------------------------------
  async function run(name) {
    const o = S[name];
    if (!o) throw new Error('no scenario ' + name);
    try {
      localStorage.clear();
    } catch (e) {}
    for (const [k, v] of Object.entries(o.store || {})) localStorage.setItem(k, v);
    let current = o.status || status([UBUNTU]);
    window.__qaSetStatus = (s) => (current = s);
    const calls = { gets: [], posts: [] };
    const answer = (r) => (r instanceof Error ? Promise.reject(r) : r && typeof r.then === 'function' ? r.then(clone) : Promise.resolve(clone(r || {})));
    const wslHost = {
      getJson: (p, params) => {
        calls.gets.push([p, clone(params || {})]);
        if (p === '/api/live/wsl/status') return Promise.resolve(clone(current));
        if (p === '/api/live/wsl/agents') return answer(o.agents ? o.agents(params || {}) : list([signedIn(CLAUDE), CODEX, OMP], (params || {}).distro));
        if (p === '/api/live/wsl/prereqs') return answer(o.prereqs ? o.prereqs(params || {}) : needsOf(P_OK, (params || {}).distro, (params || {}).distro === LONGD.key ? LONGD.name : undefined));
        if (p === '/api/live/wsl/agents/install') return answer(o.installGet ? o.installGet(params) : { state: 'idle' });
        if (p === '/api/live/wsl/aib') return answer(o.aib ? o.aib(params || {}) : aibOf(USAGE, (params || {}).distro));
        return Promise.resolve({});
      },
      postJson: (n, body) => {
        calls.posts.push([n, clone(body)]);
        if (n === 'wsl/agents/enabled') return answer(o.enabled ? o.enabled(body) : { ok: true, enabled: body.enabled });
        if (n === 'wsl/aib/remove') return answer(o.remove ? o.remove(body) : body.mode === 'check' ? CHECK_OK : APPLY_OK);
        if (n === 'wsl/agents/uninstall') return answer(o.uninstall ? o.uninstall(body) : { ok: true, removed: ['~/.aib-server/agents/' + body.id] });
        return answer(o.install ? o.install(n, body) : { state: 'running', stage: 'preparing', percent: 2 });
      },
      currentPath: () => o.currentPath || '',
    };
    // terminal panels: a stand-in that looks like the AIB terminal's frame (xterm itself loads from the server)
    const T = window.AibTerminal;
    const fake = (box, id, hooks) => {
      const h = hooks || {};
      const pane = document.createElement('div');
      pane.className = 'qa-term';
      pane.style.cssText = 'background:var(--term-bg);color:var(--term-fg);font:13px/1.15 Consolas,monospace;padding:6px 8px;height:150px;white-space:pre;overflow:hidden';
      pane.textContent =
        id === 'wsl-node'
          ? '=> Downloading nvm from git to \'/home/u/.nvm\'\n=> Compressing and cleaning up git repository\n=> Appending nvm source string to /home/u/.zshrc\nDownloading and installing node v24.11.1...\nDownloading https://nodejs.org/dist/v24.11.1/node-v24.11.1-linux-x64.tar.xz...\n######################################################      76.4%'
          : 'Opening the sign-in page in your Windows browser…\nIf it does not open, visit:\nhttps://auth.openai.com/oauth/authorize?client_id=…\n█';
      box.append(pane);
      setTimeout(() => h.onReady && h.onReady(), 0);
      return { close() {} };
    };
    if (T) {
      T.runSignin = (box, id, hooks) => fake(box, id, hooks);
      T.runSetup = (box, id, step, hooks) => fake(box, id, Object.assign({}, hooks, { step }));
    }
    window.AIBWsl.init(wslHost);
    const UI = window.AgentSettingsUI;
    UI.init({
      get: async (p) => {
        if (p === '/api/live/settings') return { revision: 'r', settings: { defaults: { migrated: true } }, agents: clone(o.win || WIN) };
        if (p === '/api/live/bootstrap') return { stateDir: 'C:\\Users\\me\\AppData\\Local\\AgentStudio', server: { version: '0.1.0-beta.10' } };
        if (p === '/api/live/agents/install') return { state: 'idle' };
        return {};
      },
      post: async () => ({}),
    });
    await settle();
    UI.open(o.section || 'wsl');
    await settle(10);
    await settle(10);
    const content = () => document.querySelector('.st-content');
    const t = {
      calls,
      content,
      picker: () => content().querySelector('.wl-pick select'),
      row: (key) => [...content().querySelectorAll('.st-agent')].find((r) => r.dataset.agent === key) || null,
      card: (title) => [...content().querySelectorAll('.st-card')].find((c) => (c.querySelector('.st-card-title') || {}).textContent === title) || null,
      dlg: () => document.querySelector('.wl-remove'),
      dlgButton: (label) => [...document.querySelector('.wl-remove').querySelectorAll('button')].find((b) => b.textContent === label && !b.hidden) || null,
      openRemove: async () => {
        const c = [...content().querySelectorAll('.st-card')].find((x) => /^AIB in /.test((x.querySelector('.st-card-title') || {}).textContent || ''));
        [...c.querySelectorAll('button')].find((b) => /^Remove AIB from /.test(b.textContent)).click();
        await settle(10);
      },
    };
    window.__qa = t;
    if (o.after) await o.after(t);
    await settle(6);
    // no blinking caret or focus ring left by the open() call on the search box in the shots (the a11y pass checks focus itself)
    window.__qaDone = true;
  }
  window.__qaScenarios = Object.keys(S);
  run(decodeURIComponent(location.hash.slice(1)) || 'good').catch((e) => {
    window.__qaError = String((e && e.stack) || e);
    window.__qaDone = true;
  });
})();
