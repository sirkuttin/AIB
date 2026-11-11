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
  UI.init({
    get: async (path) =>
      path === '/api/live/settings'
        ? {
            revision: 'r1',
            warning: '',
            settings: { defaults: { migrated: true, projects: {}, byAgent: {} } },
            agents: list,
          }
        : {},
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
  return { shell, ctx, UI, posts, card };
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
