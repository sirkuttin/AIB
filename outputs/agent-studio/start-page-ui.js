(function (root) {
  'use strict';
  // First-run start page: shown in place of the empty New chat form while no enabled agent is ready (not installed, or "Needs sign-in";
  // "Not checked" counts as ready). It draws the agent rows with Settings' own agentRow (Install, progress, Sign in) and swaps back
  // to the normal New chat form the moment one agent becomes ready. It decides only after /api/live/settings has returned.
  const doc = () => root.document;
  const el = (tag, text, cls) => {
    const n = doc().createElement(tag);
    if (text != null && text !== '') n.textContent = String(text);
    if (cls) n.className = cls;
    return n;
  };
  const settings = () => root.AgentSettingsUI;
  const OWN_INSTALL = [
    'npm i -g @agentclientprotocol/claude-agent-acp', // Claude Code
    'npm i -g @agentclientprotocol/codex-acp', // Codex
  ];
  let wasShown = false;

  // The built-in agents, in Settings' order (Claude Code, Codex, OMP). Custom agents are added from Settings.
  const builtinRows = (list) => settings().orderAgents((Array.isArray(list) ? list : []).filter((a) => a && a.builtin));
  // True when every agent row is stuck (see AgentSettingsUI.trouble): the page then offers a way out that needs no Install button.
  const allStuck = (rows, trouble) => rows.length > 0 && rows.every((a) => !!trouble(a));

  function link(text, onClick) {
    const b = el('button', text, 'sp-link');
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }
  function stuckPanel(rows, S) {
    const box = el('div', null, 'sp-stuck');
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', 'Nothing could be installed');
    const own = el('p', null, 'sp-note');
    own.append(
      el('strong', 'Use my own install'),
      ' If you install an adapter yourself, Studio finds it. Run one of these in a terminal, then choose Check again in ',
      link('Settings', () => S.open('agents')),
      '.',
    );
    box.append(own);
    for (const command of OWN_INSTALL) box.append(el('code', command, 'sp-command'));
    const add = el('p', null, 'sp-note');
    add.append(
      'Or ',
      link('add an agent by hand', () => S.openAddAgent()),
      ' with its own command.',
    );
    box.append(add);
    return box;
  }
  function render(page, list) {
    const S = settings();
    const rows = builtinRows(list);
    const frag = doc().createDocumentFragment();
    frag.append(
      el('h2', 'Set up an agent to start chatting', 'sp-title'),
      el('p', 'Every good administration starts with a cabinet.', 'sp-subtitle'),
      el(
        'p',
        "Studio talks to coding agents you already use. Pick one: Studio installs what it needs, then you sign in with that agent's own account.",
        'sp-lead',
      ),
    );
    const box = el('div', null, 'sp-agents');
    for (const a of rows) box.append(S.agentRow(a, { sharedBlock: true }));
    frag.append(box);
    const node = rows.find((a) => S.trouble(a) === 'node'); // the Node.js line, once for the whole page
    if (node) {
      const line = el('p', node.installBlock + ' Install Node.js from nodejs.org, then ', 'sp-note');
      line.append(
        link('Check again', () => S.recheck()),
        '.',
      );
      frag.append(line);
    }
    if (allStuck(rows, S.trouble)) frag.append(stuckPanel(rows, S));
    const more = el('p', null, 'sp-more');
    more.append(link('See more agents', () => S.open('agents')));
    frag.append(
      more,
      el(
        'p',
        'Once one agent is ready, this page is replaced by the normal new-chat screen. You can add more agents any time in Settings → AIB linking.',
        'sp-foot',
      ),
    );
    page.replaceChildren(frag);
  }
  // Decide again from the latest settings: show, redraw or hand over to the New chat form. Safe to call at any time.
  function update() {
    const body = doc().body,
      page = doc().getElementById('startPage'),
      S = settings(),
      AC = root.AgentChoice;
    if (!body || !page || !S || !AC) return false;
    const list = S.loaded() ? S.agentList() : null; // nothing is decided before the settings have returned
    const on = !!list && !AC.anyReady(list);
    body.classList.toggle('start-page', on);
    page.hidden = !on;
    if (on && body.classList.contains('new-chat')) render(page, list);
    else if (!on) page.replaceChildren();
    if (wasShown && !on && body.classList.contains('new-chat')) {
      const prompt = doc().getElementById('prompt');
      if (prompt && prompt.focus) prompt.focus(); // handed over: the box is ready to type in
    }
    wasShown = on;
    return on;
  }
  function init() {
    if (settings() && settings().onChange) settings().onChange(update);
    update();
  }
  root.StartPageUI = { init, update, builtinRows, allStuck, OWN_INSTALL };
  if (typeof module === 'object' && module.exports) module.exports = root.StartPageUI;
})(typeof window !== 'undefined' ? window : globalThis);
