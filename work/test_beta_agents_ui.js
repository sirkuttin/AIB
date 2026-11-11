'use strict';
// Settings > AIB Linking > Beta agents (settings-ui.js renderAgentsBeta) and the "Beta" group of the agent pickers (agent-choice.js,
// composer-chips.js). Beta agents are untested ACP agents, off until turned on; the heading says Beta, the cards carry no tag.
const test = require('node:test');
const assert = require('node:assert/strict');
const { page, load } = require('./fake_dom.js');

const BETA_NOTE = "These connect the same way but haven't been tested by us yet. Tell us what breaks.";
const flush = () => new Promise((resolve) => setTimeout(resolve, 5));
const plain = (x) => JSON.parse(JSON.stringify(x)); // arrays made inside the page's vm realm
const names = (card) => card.querySelectorAll('.st-agent').map((row) => row.querySelector('strong').textContent);
const inside = (node, outer, inner) => node.querySelector(outer).querySelector(inner);

const builtin = (id, name) => ({
  id,
  name,
  letter: name[0],
  builtin: true,
  enabled: true,
  found: true,
  launcher: name + ' on PATH',
  launcherSource: 'path',
  problem: '',
});
const beta = (id, name, extra = {}) => ({
  id,
  name,
  letter: name[0],
  builtin: false,
  beta: true,
  enabled: false,
  found: false,
  launcher: 'Not installed',
  launcherSource: 'missing',
  problem: 'Not installed. Install it with: npm install -g ' + id,
  installable: false,
  signin: null,
  betaInfo: {
    cost: 'Free CLI · needs an API key',
    note: '',
    installCommand: 'npm install -g ' + id,
    docs: 'https://example.invalid/' + id,
    signin: 'terminal',
    signinCommand: ['login'],
    keyEnv: '',
    keySet: false,
  },
  ...extra,
});
const LIST = () => [
  builtin('omp', 'OMP'),
  builtin('claude', 'Claude Code'),
  builtin('codex', 'Codex'),
  beta('copilot', 'GitHub Copilot CLI', {
    betaInfo: { ...beta('copilot', 'x').betaInfo, cost: 'Needs a GitHub Copilot plan' },
  }),
  beta('opencode', 'OpenCode'),
  beta('gemini', 'Gemini CLI', {
    betaInfo: {
      ...beta('gemini', 'x').betaInfo,
      signin: 'agent',
      keyEnv: 'GEMINI_API_KEY',
      note: 'Free personal Google sign-in moved to Antigravity in June 2026; use an API key or a paid plan.',
    },
  }),
  beta('cursor', 'Cursor CLI', { betaInfo: { ...beta('cursor', 'x').betaInfo, cost: 'Paid plan', signin: 'agent' } }),
];

async function openSettings(list = LIST()) {
  const shell = page();
  shell.document.contains = (n) => shell.body.contains(n); // closePage puts the focus back
  const ctx = load(shell, ['agent-choice.js', 'settings-ui.js']);
  const UI = ctx.AgentSettingsUI;
  const posts = [];
  const gets = [];
  UI.init({
    get: async (path, params) => {
      gets.push([path, params || null]);
      return path === '/api/live/settings'
        ? {
            revision: 'r1',
            warning: '',
            settings: { defaults: { migrated: true, projects: {}, byAgent: {} } },
            agents: list,
          }
        : {};
    },
    post: async (name, body) => {
      posts.push([name, body]);
      return {
        revision: 'r2',
        warning: '',
        settings: { defaults: { migrated: true, projects: {}, byAgent: {} } },
        agents: list,
      };
    },
    registryChanged() {},
  });
  UI.open('agents');
  await flush();
  await flush();
  const cards = shell.body.querySelectorAll('section.st-card');
  const card = (title) => cards.find((c) => (c.querySelector('h3') || {}).textContent === title);
  // The Beta card's row, found again after a repaint.
  const betaRow = (name) =>
    shell.body
      .querySelectorAll('section.st-card')
      .find((c) => (c.querySelector('h3') || {}).textContent === 'Beta agents')
      .querySelectorAll('.st-agent')
      .find((r) => r.querySelector('strong').textContent === name);
  return { shell, ctx, UI, posts, gets, card, betaRow };
}

test('AIB Linking has a "Beta agents" card with its one-line note, under the tested agents', async () => {
  const { card, shell } = await openSettings();
  const cards = shell.body.querySelectorAll('section.st-card').map((c) => c.querySelector('h3').textContent);
  assert.ok(cards.indexOf('Agents') >= 0 && cards.indexOf('Beta agents') > cards.indexOf('Agents'), cards.join(', '));
  const betaCard = card('Beta agents');
  assert.equal(betaCard.querySelector('.st-beta-lead').textContent, BETA_NOTE);
  assert.deepEqual(names(betaCard), ['GitHub Copilot CLI', 'OpenCode', 'Gemini CLI', 'Cursor CLI']);
  const tested = names(card('Agents'));
  assert.deepEqual(
    tested,
    ['Claude Code', 'Codex', 'OMP'],
    'the tested agents stay on top, as they are, and no Beta agent is among them',
  );
});

test('Beta agents start Off, and an Off Beta agent is not offered for new chats', async () => {
  const { card, ctx } = await openSettings();
  for (const row of card('Beta agents').querySelectorAll('.st-agent')) {
    assert.ok(row.className.includes('off'), 'drawn as turned off');
    const box = inside(row, '.st-toggle', 'input');
    assert.equal(box.checked, false);
    assert.equal(inside(row, '.st-toggle', 'span').textContent, 'Off');
  }
  const AC = ctx.AgentChoice;
  assert.deepEqual(plain(AC.AGENTS.map((a) => a.id)), ['omp', 'claude', 'codex']);
  assert.ok(
    AC.ALL.some((a) => a.id === 'copilot' && a.beta),
    'known (old chats keep their name), just not offered',
  );
});

test('turning a Beta agent on sends only its switch', async () => {
  const { card, posts } = await openSettings();
  const row = card('Beta agents').querySelectorAll('.st-agent')[0];
  const box = inside(row, '.st-toggle', 'input');
  box.checked = true;
  box.dispatch('change');
  await flush();
  assert.deepEqual(plain(posts.at(-1)), ['settings', { agents: { enabled: { copilot: true } } }]);
});

test('no tag on the Beta cards: the heading says Beta, the cards do not', async () => {
  const { card } = await openSettings();
  const betaCard = card('Beta agents');
  for (const row of betaCard.querySelectorAll('.st-agent')) {
    assert.equal(row.querySelector('.st-tag'), null, 'no "Built in" / "Added by you" / "Beta" tag');
    assert.doesNotMatch(row.textContent, /\bBeta\b/);
  }
  assert.ok(card('Agents').querySelector('.st-tag'), 'the tested agents keep their tag');
});

test('each Beta card has its cost line; a missing one shows the install command with Copy and a docs link', async () => {
  const { card } = await openSettings();
  const rows = card('Beta agents').querySelectorAll('.st-agent');
  assert.equal(rows[0].querySelector('.st-beta-cost').textContent, 'Needs a GitHub Copilot plan');
  assert.equal(rows[3].querySelector('.st-beta-cost').textContent, 'Paid plan');
  assert.equal(rows[1].querySelector('.st-beta-cost').textContent, 'Free CLI · needs an API key');
  const how = rows[1].querySelector('.st-beta-install');
  assert.equal(how.querySelector('code').textContent, 'npm install -g opencode');
  assert.ok(how.querySelectorAll('button').some((b) => b.textContent === 'Copy'));
  const link = how.querySelector('a');
  assert.equal(link.href, 'https://example.invalid/opencode');
  assert.equal(link.rel, 'noopener noreferrer');
  assert.doesNotMatch(
    rows[1].textContent,
    /Not installed\. Install it with/,
    'the command is not repeated as a problem line',
  );
  assert.match(rows[2].textContent, /Antigravity/, "Gemini's plain note");
  assert.ok(inside(rows[2], '.st-beta-key', 'input'), 'an API key box where the agent takes a key');
  assert.equal(inside(rows[2], '.st-beta-key', 'input').type, 'password');
  assert.equal(rows[1].querySelector('.st-beta-key'), null);
});

// Beta setup (server/agents/beta_setup.ts betaInfo.setup): every card that is not installed has Install; prerequisites first.
const setupOf = (kind, command, prereqs = [], blockedBy = '') => ({
  kind,
  command,
  source: '',
  uninstallDocs: '',
  prereqs,
  blockedBy,
});
const NODE_MISSING = {
  id: 'node',
  name: 'Node.js',
  need: 'Node.js 22 or newer',
  state: 'missing',
  version: '',
  min: '22',
  command: 'winget install -e --id OpenJS.NodeJS.LTS',
  installLabel: 'Install Node.js 26 (LTS)',
  page: 'https://nodejs.org/en/download',
  source: '',
};
const UV = (state, version = '') => ({
  id: 'uv',
  name: 'uv',
  need: 'uv',
  state,
  version,
  min: '',
  command: 'winget install --id=astral-sh.uv -e',
  installLabel: 'Install uv',
  page: 'https://docs.astral.sh/uv/getting-started/installation/',
  source: '',
});
const CURSOR_CMD = "irm 'https://cursor.com/install?win32=true' | iex";
function setupList() {
  const list = LIST();
  const withSetup = (a, setup, extra = {}) => ({
    ...a,
    ...extra,
    betaInfo: {
      ...a.betaInfo,
      installCommand: setup.kind === 'npm' ? a.betaInfo.installCommand : setup.command,
      setup,
    },
  });
  list[4] = withSetup(
    list[4],
    setupOf('npm', 'npm install -g @opencode/cli', [{ ...NODE_MISSING, state: 'found', version: '26.13.1' }]),
    {
      installable: true,
    },
  );
  list[5] = withSetup(
    list[5],
    setupOf('npm', 'npm install -g @google/gemini-cli', [NODE_MISSING], 'Install Node.js first'),
    {
      installable: true,
    },
  );
  list[6] = withSetup(list[6], setupOf('terminal', CURSOR_CMD));
  list.push(
    withSetup(
      beta('vibe', 'Mistral Vibe'),
      setupOf('terminal', 'uv tool install mistral-vibe', [UV('missing')], 'Install uv first'),
    ),
  );
  return list;
}
const buttonOf = (row, text) => row.querySelectorAll('button').find((b) => b.textContent === text);

test('every Beta card that is not installed has Install: npm ones by AIB, the others run the vendor installer here', async () => {
  const { betaRow } = await openSettings(setupList());
  const hint = (row) => row.querySelector('.st-beta-install').querySelector('.st-hint').textContent;
  const opencode = betaRow('OpenCode');
  assert.ok(buttonOf(opencode, 'Install') && !buttonOf(opencode, 'Install').disabled, 'OpenCode is an npm agent now');
  assert.equal(hint(opencode), 'Or install it yourself:');
  assert.equal(opencode.querySelector('.st-beta-need').textContent, 'Node.js 22 or newer: found 26.13.1');
  const cursor = betaRow('Cursor CLI');
  assert.ok(buttonOf(cursor, 'Install') && !buttonOf(cursor, 'Install').disabled);
  assert.equal(hint(cursor), 'Install runs this in a terminal here:');
  assert.equal(
    cursor.querySelector('.st-beta-install').querySelector('code').textContent,
    CURSOR_CMD,
    'shown before it runs',
  );
  assert.equal(cursor.querySelector('.st-beta-needs'), null, 'nothing needed first');
  assert.doesNotMatch(cursor.textContent, /can't install/);
});

test('a missing prerequisite: "Needs first" with its install command and button; the agent Install is off with the reason', async () => {
  const { betaRow } = await openSettings(setupList());
  const gemini = betaRow('Gemini CLI');
  assert.equal(gemini.querySelector('.st-beta-needs').querySelector('.st-hint').textContent, 'Needs first:');
  const need = gemini.querySelector('.st-beta-need');
  assert.equal(need.querySelector('.st-beta-need-text').textContent, 'Node.js 22 or newer: missing');
  assert.equal(need.querySelector('code').textContent, 'winget install -e --id OpenJS.NodeJS.LTS');
  assert.ok(buttonOf(need, 'Install Node.js 26 (LTS)'));
  assert.equal(buttonOf(gemini, 'Install').disabled, true);
  assert.equal(gemini.querySelector('.st-beta-blocked').textContent, 'Install Node.js first');
  const vibe = betaRow('Mistral Vibe');
  assert.equal(vibe.querySelector('.st-beta-need-text').textContent, 'uv: missing');
  assert.equal(buttonOf(vibe, 'Install').disabled, true);
  assert.equal(vibe.querySelector('.st-beta-blocked').textContent, 'Install uv first');
});

test('Install of a vendor agent runs in the card terminal; exit 0 checks again, a failure keeps the output with one line', async () => {
  const list = setupList();
  const { ctx, betaRow, gets, posts } = await openSettings(list);
  const runs = [];
  let closed = 0;
  ctx.AibTerminal = { runSetup: (view, id, step, h) => (runs.push([id, step, h]), { close: () => closed++ }) };
  buttonOf(betaRow('Cursor CLI'), 'Install').click();
  await flush();
  assert.deepEqual(
    runs.map((r) => [r[0], r[1]]),
    [['cursor', 'install']],
  );
  assert.equal(betaRow('Cursor CLI').querySelector('.st-beta-term-title').textContent, 'Installing: ' + CURSOR_CMD);
  runs[0][2].onExit(1);
  await flush();
  assert.equal(
    betaRow('Cursor CLI').querySelector('.st-beta-term').querySelector('p').textContent,
    'Install failed. See the output above.',
  );
  assert.equal(closed, 0, 'the output stays');

  buttonOf(betaRow('Cursor CLI'), 'Install').click();
  await flush();
  const before = gets.length;
  list[6] = { ...list[6], found: true, launcherSource: 'path', problem: '', launcher: 'cursor-agent.cmd' };
  runs[1][2].onExit(0);
  await flush();
  await flush();
  assert.deepEqual(plain(gets.slice(before)), [['/api/live/settings', { recheck: '1' }]], 'Check again, PATH re-read');
  assert.equal(betaRow('Cursor CLI').querySelector('.st-beta-term'), null, 'found: the panel closes');
  assert.ok(posts.some((p) => p[0] === 'terminal/end' && p[1].key === 'setup:cursor'));
});

test('Install uv runs its installer; after exit 0 the check sees uv and the agent Install turns on', async () => {
  const list = setupList();
  const { ctx, betaRow } = await openSettings(list);
  const runs = [];
  ctx.AibTerminal = { runSetup: (view, id, step, h) => (runs.push([id, step, h]), { close() {} }) };
  buttonOf(betaRow('Mistral Vibe').querySelector('.st-beta-need'), 'Install uv').click();
  await flush();
  assert.deepEqual(
    runs.map((r) => [r[0], r[1]]),
    [['vibe', 'prereq:uv']],
  );
  assert.equal(
    betaRow('Mistral Vibe').querySelector('.st-beta-term-title').textContent,
    'Installing uv: winget install --id=astral-sh.uv -e',
  );
  const vibe = list.length - 1;
  list[vibe] = {
    ...list[vibe],
    betaInfo: {
      ...list[vibe].betaInfo,
      setup: setupOf('terminal', 'uv tool install mistral-vibe', [UV('found', '0.9.9')]),
    },
  };
  runs[0][2].onExit(0);
  await flush();
  await flush();
  const row = betaRow('Mistral Vibe');
  assert.equal(row.querySelector('.st-beta-need-text').textContent, 'uv: found 0.9.9');
  assert.equal(buttonOf(row, 'Install').disabled, false);
  assert.equal(row.querySelector('.st-beta-blocked'), null);
  assert.equal(row.querySelector('.st-beta-term'), null);
});

test('a prerequisite that installed but is not seen yet: the panel says to restart AIB', async () => {
  const { ctx, betaRow } = await openSettings(setupList());
  let hooks = null;
  ctx.AibTerminal = { runSetup: (view, id, step, h) => ((hooks = h), { close() {} }) };
  buttonOf(betaRow('Gemini CLI').querySelector('.st-beta-need'), 'Install Node.js 26 (LTS)').click();
  await flush();
  hooks.onExit(0);
  await flush();
  await flush();
  assert.equal(
    betaRow('Gemini CLI').querySelector('.st-beta-term').querySelector('p').textContent,
    'The install finished, but AIB cannot find Node.js yet. Restart AIB, then choose Check again.',
  );
});

test("a card with an API key box links to the provider's key page, opened in the browser; no key box, no link", async () => {
  const list = LIST();
  list[5] = beta('gemini', 'Gemini CLI', {
    betaInfo: {
      ...beta('gemini', 'x').betaInfo,
      signin: 'agent',
      keyEnv: 'GEMINI_API_KEY',
      keyUrl: 'https://aistudio.google.com/apikey',
    },
  });
  const { card } = await openSettings(list);
  const rows = card('Beta agents').querySelectorAll('.st-agent');
  const link = inside(rows[2], '.st-beta-key', 'a.st-beta-keylink');
  assert.equal(link.textContent, 'Get an API key');
  assert.equal(link.href, 'https://aistudio.google.com/apikey');
  assert.equal(link.target, '_blank', 'the desktop app hands target=_blank links to the system browser');
  assert.equal(link.rel, 'noopener noreferrer');
  assert.equal(rows[1].querySelector('.st-beta-keylink'), null, 'OpenCode has no key box, so no link');
});

test('the New chat agent menu and the composer agent chip list Beta agents last, under a "Beta" group label', async () => {
  const shell = page();
  const ctx = load(shell, ['agent-choice.js', 'composer-chips.js']);
  const AC = ctx.AgentChoice;
  AC.setRegistry(
    LIST().map((a) => (a.id === 'gemini' || a.id === 'cursor' ? { ...a, enabled: true, found: true } : a)),
  );
  assert.deepEqual(
    plain(AC.AGENTS.map((a) => a.id)),
    ['omp', 'claude', 'codex', 'gemini', 'cursor'],
    'only turned-on agents, Beta ones after the tested ones',
  );
  const items = AC.menuItems(AC.AGENTS);
  assert.deepEqual(plain(items.map((i) => i.group)), ['', '', '', 'Beta', 'Beta']);
  const box = shell.document.createElement('div');
  shell.body.append(box);
  ctx.AgentComposerChips.render(
    box,
    {
      id: 'new-chat',
      settings: {},
      agent: 'OMP',
      agentId: 'omp',
      agents: AC.AGENTS.map((a) => ({ id: a.id, name: a.name, group: a.beta ? AC.BETA_GROUP : '' })),
    },
    { onAgent() {} },
  );
  box.querySelector('#chip-agent').click();
  const menu = shell.body.querySelector('.chip-menu');
  assert.ok(menu, 'the agent menu opened');
  const list = menu.querySelector('.chip-menu-list');
  const seq = list.children.map((n) =>
    n._class.has('chip-menu-group') ? '[' + n.textContent + ']' : n.querySelector('.chip-menu-name').textContent,
  );
  assert.deepEqual(plain(seq), ['OMP', 'Claude Code', 'Codex', '[Beta]', 'Gemini CLI', 'Cursor CLI']);
  assert.equal(menu.querySelectorAll('.chip-menu-tag').length, 0, 'no per-agent tag in the menu either');
});

test('with no Beta agent turned on the menus have no Beta label', () => {
  const shell = page();
  const ctx = load(shell, ['agent-choice.js']);
  ctx.AgentChoice.setRegistry(LIST());
  assert.ok(ctx.AgentChoice.menuItems(ctx.AgentChoice.AGENTS).every((i) => !i.group));
});

test("a chat that needs sign-in: a terminal method of a Beta agent gets a Sign in button that runs AIB's terminal sign-in", async () => {
  const shell = page();
  const ctx = load(shell, ['elicitation-ui.js']);
  const box = shell.document.createElement('div');
  shell.body.append(box);
  const auth = {
    message: 'Authentication required',
    methods: [
      {
        id: 'fixture-terminal-login',
        name: 'Sign in in a terminal',
        kind: 'terminal',
        instructions: 'Run `x login` in a terminal',
      },
    ],
  };
  const asked = [];
  ctx.AgentElicitationUI.renderAuth(box, auth, {
    providerName: 'OpenCode',
    onTerminalSignin: async (id) => asked.push(id),
  });
  const go = box.querySelector('.auth-terminal-signin');
  assert.ok(go, 'a Sign in button');
  assert.equal(go.textContent, 'Sign in');
  assert.match(box.textContent, /Opens an AIB terminal for the sign-in\. When it finishes, the chat reconnects\./);
  go.click();
  await flush();
  assert.deepEqual(plain(asked), ['fixture-terminal-login']);

  const other = shell.document.createElement('div');
  shell.body.append(other);
  ctx.AgentElicitationUI.renderAuth(other, auth, { providerName: 'Some agent' });
  assert.equal(
    other.querySelector('.auth-terminal-signin'),
    null,
    'no handler (not a Beta terminal agent): the instructions only',
  );
  assert.match(other.textContent, /Run `x login` in a terminal/);
});

test("signInBeta opens AIB Linking, runs the agent's sign-in in the AIB terminal, checks it, then closes Settings", async () => {
  const list = LIST().map((a) =>
    a.id === 'opencode'
      ? { ...a, enabled: true, found: true, launcherSource: 'path', problem: '', signin: { state: 'signin' } }
      : a,
  );
  const { UI, ctx, posts } = await openSettings(list);
  UI.close();
  let hooks = null;
  let closed = 0;
  ctx.AibTerminal = {
    runSignin: (view, id, h) => {
      hooks = h;
      return { close: () => closed++ };
    },
  };
  const done = UI.signInBeta('opencode');
  await flush();
  await flush();
  assert.ok(UI.isOpen(), 'Settings is open on AIB Linking');
  assert.deepEqual(plain(posts.find((p) => p[0] === 'agents/signin')), ['agents/signin', { agent: 'opencode' }]);
  assert.ok(hooks, 'the AIB terminal runs the sign-in (never a separate window)');
  hooks.onExit(0);
  assert.equal(await done, true);
  assert.deepEqual(plain(posts.find((p) => p[0] === 'agents/signin/check' && p[1].agent)), [
    'agents/signin/check',
    { agent: 'opencode', force: true },
  ]);
  assert.equal(UI.isOpen(), false, 'Settings closes: the chat reconnects');
  assert.equal(closed, 1);
});

test('signInBeta fails plainly for an agent that does not sign in through a terminal, and when the sign-in ends with an error', async () => {
  const list = LIST().map((a) =>
    a.id === 'opencode' ? { ...a, found: true, launcherSource: 'path', problem: '' } : a,
  );
  const { UI, ctx } = await openSettings(list);
  await assert.rejects(() => UI.signInBeta('gemini'), /cannot run a terminal sign-in/);
  let hooks = null;
  ctx.AibTerminal = { runSignin: (v, id, h) => ((hooks = h), { close() {} }) };
  const done = UI.signInBeta('opencode');
  await flush();
  await flush();
  hooks.onExit(1);
  assert.equal(await done, false);
  assert.ok(UI.isOpen(), 'Settings stays open with the reason on the card');
});

test('closing Settings during a sign-in a chat started ends it: the chat button is released and the sign-in program ended', async () => {
  const list = LIST().map((a) =>
    a.id === 'opencode' ? { ...a, enabled: true, found: true, launcherSource: 'path', problem: '' } : a,
  );
  const { UI, ctx, posts } = await openSettings(list);
  UI.close();
  let closed = 0;
  ctx.AibTerminal = { runSignin: () => ({ close: () => closed++ }) };
  const done = UI.signInBeta('opencode');
  await flush();
  await flush();
  assert.ok(UI.isOpen());
  UI.close(); // Esc and the × both close the page this way
  assert.equal(
    await done,
    false,
    'treated as "the sign-in did not finish": the chat shows Try again and its button works again',
  );
  assert.equal(closed, 1, 'the sign-in panel is ended');
  await flush();
  assert.deepEqual(plain(posts.find((p) => p[0] === 'terminal/end')), ['terminal/end', { key: 'signin:opencode' }]);
});

test('Qwen: an optional API address under the key box, saved like the key; empty clears it (Qwen then uses OpenAI)', async () => {
  const HINT = 'https://<workspace ID>.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1';
  const list = LIST();
  list.push(
    beta('qwen', 'Qwen Code', {
      betaInfo: {
        ...beta('qwen', 'x').betaInfo,
        signin: 'key',
        keyEnv: 'OPENAI_API_KEY',
        keyUrl: 'https://modelstudio.console.alibabacloud.com/ap-southeast-1/settings/api-key',
        baseUrlEnv: 'OPENAI_BASE_URL',
        baseUrlHint: HINT,
        baseUrl: '',
      },
    }),
  );
  const { betaRow, posts } = await openSettings(list);
  const row = betaRow('Qwen Code');
  const box = row.querySelector('.st-beta-url');
  assert.equal(box.querySelector('.st-label').textContent, 'API address (OPENAI_BASE_URL, optional)');
  const input = box.querySelector('input');
  assert.equal(input.placeholder, HINT);
  assert.equal(
    box.querySelector('.st-hint').textContent,
    'Leave empty for OpenAI. For an Alibaba Cloud Model Studio key use ' +
      HINT +
      ' (your workspace ID is on the workspace details page in the Model Studio console).',
  );
  assert.equal(
    row.querySelector('.st-beta-keylink').href,
    'https://modelstudio.console.alibabacloud.com/ap-southeast-1/settings/api-key',
    'the key comes from the same (Singapore) Model Studio console',
  );
  input.value = 'https://ws-1.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1';
  input.dispatch('input');
  box
    .querySelectorAll('button')
    .find((b) => b.textContent === 'Save address')
    .click();
  await flush();
  assert.deepEqual(plain(posts.at(-1)), [
    'settings',
    { agents: { betaUrl: { qwen: 'https://ws-1.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1' } } },
  ]);
  const again = betaRow('Qwen Code').querySelector('.st-beta-url');
  again.querySelector('input').value = '';
  again.querySelector('input').dispatch('input');
  again
    .querySelectorAll('button')
    .find((b) => b.textContent === 'Save address')
    .click();
  await flush();
  assert.deepEqual(plain(posts.at(-1)), ['settings', { agents: { betaUrl: { qwen: null } } }]);
  assert.equal(betaRow('Gemini CLI').querySelector('.st-beta-url'), null, 'only agents that take an address');
});

test('"Install … first" is a line under the header, so Install and the badge keep the same place on every card', async () => {
  const { betaRow } = await openSettings(setupList());
  for (const name of ['Gemini CLI', 'Mistral Vibe', 'Cursor CLI']) {
    const row = betaRow(name);
    const head = row.querySelector('.st-agent-head');
    assert.equal(head.querySelector('.st-beta-blocked'), null, name + ': nothing after Install in the header');
    const kids = head.children.map((n) => n.className || n.tagName);
    assert.equal(kids.at(-1), 'st-primary', name + ': Install is the last thing in the header');
  }
  const gemini = betaRow('Gemini CLI');
  const after = gemini.children[gemini.children.indexOf(gemini.querySelector('.st-agent-head')) + 1];
  assert.equal(after.className, 'st-note dim st-beta-blocked');
  assert.equal(after.textContent, 'Install Node.js first');
  assert.equal(betaRow('Cursor CLI').querySelector('.st-beta-blocked'), null);
});

test('the Beta card CSS: the key link is a teal st-link, line-start links sit on the hint edge, disabled Install is readable', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { cssRules, declarationsFor } = require('./css_rules.js');
  const rules = cssRules(fs.readFileSync(path.join(__dirname, '../outputs/agent-studio/settings.css'), 'utf8'));
  const link = declarationsFor(rules, '.st-beta-key .st-link');
  assert.deepEqual([link.color, link['text-decoration']], ['var(--link)', 'underline'], 'same as every other st-link');
  assert.deepEqual(
    declarationsFor(rules, '.st-beta-key .st-link'),
    declarationsFor(rules, '.st-beta-install .st-link'),
  );
  for (const sel of ['.st-beta-key .st-beta-keylink', '.st-beta-install .st-beta-docs', '.st-beta-row .st-link'])
    assert.equal(declarationsFor(rules, sel)['margin-left'], '0', sel);
  const off = declarationsFor(rules, '.st-agent-head .st-primary:disabled');
  assert.deepEqual(
    [off.opacity, off.background, off.color],
    ['1', 'var(--primary-disabled-bg)', 'var(--on-accent-disabled)'],
    "the app's disabled primary (chat.css .primary:disabled), not 50% opacity",
  );
});

// The page scroll: a repaint replaces every node, which used to drop the scroll position (the page is empty for a moment) and the
// focus (the clicked button is gone), so the window jumped away from the card you clicked. The fake DOM has no layout, so this one
// simulates it: rows are 150px tall from y=100, the content scrolls, and replacing its children clamps the scroll to 0.
test('Install on a card that is not the first keeps the scroll position, the card where it was, and the focus on the card', async () => {
  const list = setupList();
  const { shell, ctx, betaRow } = await openSettings(list);
  const content = shell.body.querySelector('.st-content');
  const proto = Object.getPrototypeOf(content);
  const realRect = proto.getBoundingClientRect;
  const realReplace = content.replaceChildren;
  const scrolled = [];
  try {
    content.scrollTop = 400;
    content.replaceChildren = function (...n) {
      this.scrollTop = 0; // the empty page clamps the scroll
      return realReplace.apply(this, n);
    };
    proto.getBoundingClientRect = function () {
      if (this === content) return { top: 0, bottom: 700, left: 0, right: 800, width: 800, height: 700 };
      const rows = content.querySelectorAll('.st-agent');
      const i = rows.indexOf(this);
      if (i >= 0) {
        const top = 100 + i * 150 - content.scrollTop;
        return { top, bottom: top + 150, left: 0, right: 800, width: 800, height: 150 };
      }
      const row = this.closest && this.closest('.st-agent');
      if (row && this.matches('.st-beta-term')) {
        const top = row.getBoundingClientRect().top + 30;
        return { top, bottom: top + 50, left: 0, right: 800, width: 800, height: 50 };
      }
      return realRect.call(this);
    };
    ctx.AibTerminal = { runSetup: () => ({ close() {} }) };
    const row = betaRow('Cursor CLI');
    const topBefore = row.getBoundingClientRect().top;
    const install = buttonOf(row, 'Install');
    install.focus();
    // Anything that scrolls an element into view or focuses something else is a jump.
    for (const n of shell.body.all()) n.scrollIntoView = () => scrolled.push(n);
    install.click();
    await flush();
    const after = betaRow('Cursor CLI');
    assert.ok(after.querySelector('.st-beta-term'), 'the panel opened on the card');
    assert.equal(content.scrollTop, 400, 'the scroll position is kept');
    assert.equal(after.getBoundingClientRect().top, topBefore, 'the clicked card is where it was on screen');
    assert.ok(after.contains(shell.document.activeElement), 'focus is still on the card');
    assert.equal(scrolled.length, 0, 'nothing was scrolled into view');
    // Cancel/Close on the same card: same again.
    buttonOf(after.querySelector('.st-beta-term'), 'Close').click();
    await flush();
    assert.equal(content.scrollTop, 400);
    assert.equal(betaRow('Cursor CLI').getBoundingClientRect().top, topBefore);
    assert.ok(betaRow('Cursor CLI').contains(shell.document.activeElement), 'focus stays on the card after Close');
  } finally {
    proto.getBoundingClientRect = realRect;
  }
});

test('Install that works turns the agent On at once, even if it had been turned Off before; a Ready one nobody turned off needs no click', async () => {
  const list = setupList();
  const cursor = list.findIndex((a) => a.id === 'cursor');
  list[cursor] = { ...list[cursor], userOff: true };
  const { ctx, betaRow, posts } = await openSettings(list);
  const runs = [];
  ctx.AibTerminal = { runSetup: (view, id, step, h) => (runs.push(h), { close() {} }) };
  buttonOf(betaRow('Cursor CLI'), 'Install').click();
  await flush();
  list[cursor] = { ...list[cursor], found: true, launcherSource: 'path', problem: '', launcher: 'cursor-agent.cmd' };
  runs[0].onExit(0);
  await flush();
  await flush();
  assert.ok(
    posts.some((p) => p[0] === 'settings' && JSON.stringify(p[1]) === JSON.stringify({ agents: { enabled: { cursor: true } } })),
    'the Off is cleared by the install',
  );
  // An agent that is Ready and was never turned off: no settings change is needed, nothing is posted for it.
  const before = posts.length;
  const { posts: other } = await openSettings(setupList());
  assert.equal(other.filter((p) => p[0] === 'settings').length, 0);
  assert.equal(before > 0, true);
});

test('"Set up in Settings" (UI.openAgent) opens AIB Linking and brings that card into view', async () => {
  const { shell, UI, betaRow } = await openSettings(setupList());
  UI.close && UI.close();
  const seen = [];
  const proto = Object.getPrototypeOf(shell.body);
  const real = proto.scrollIntoView;
  proto.scrollIntoView = function () {
    seen.push(this.dataset && this.dataset.agent);
  };
  try {
    await UI.openAgent('cursor');
  } finally {
    proto.scrollIntoView = real;
  }
  assert.ok(seen.includes('cursor'), 'the card of that agent is scrolled into view');
  assert.ok(betaRow('Cursor CLI'));
});
