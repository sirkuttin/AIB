/* QA (looks) of the other WSL screens, IN the headless browser after the real page scripts. Each scenario draws one screen with the
   real module (wsl-ui.js, new-project-ui.js, delete-project-ui.js, workspace-ui.js, artifacts-ui.js, status-words.js) and fake
   hosts of the shapes work/test_wsl_ui.js uses. Two screens are drawn from chat.js's own markup (chat.js is not loadable alone):
   the new-chat WSL box (chat.js renderWslAgentNote, lines 3664-3760, with the real AIBWsl.installBox inside) and the chat-list
   status line (chat.js rowStatus 4752-4790 + status-words.js statusOf). window.__qaDone is set when drawn. No network. */
(function () {
  'use strict';
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const settle = async (n = 6) => {
    for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => requestAnimationFrame(() => r()));
  };
  const $ = (id) => document.getElementById(id);
  const el = (tag, text, cls) => {
    const n = document.createElement(tag);
    if (text != null && text !== '') n.textContent = String(text);
    if (cls) n.className = cls;
    return n;
  };
  const UBUNTU = { name: 'Ubuntu', key: 'ubuntu', state: 'ready', line: '', home: '/home/u', helper: '0.1.0-ab12cd34', problem: '', alwaysAllow: false, isDefault: true };
  const DEBIAN = { name: 'Debian', key: 'debian', state: 'ready', line: '', home: '/home/d', helper: '0.1.0-ab12cd34', problem: '', isDefault: false };
  const STATUS = { available: true, distros: [UBUNTU, DEBIAN], openRequests: [], skipped: [], wsl: { exe: true, problem: '' } };
  const DIRS = (p) =>
    p === '/home/u/app'
      ? { path: '/home/u/app', parent: '/home/u', dirs: [], truncated: false }
      : { path: '/home/u', parent: '/home', dirs: [{ name: 'app', isGit: true }, { name: 'notes', isGit: false }, { name: 'a-project-folder-with-a-really-long-name-to-check-wrapping', isGit: true }, { name: 'scratch', isGit: false }], truncated: false };

  function wsl(status, currentPath, agents) {
    let cur = status;
    window.AIBWsl.init({
      getJson: (p, params) => {
        if (p === '/api/live/wsl/status') return Promise.resolve(clone(cur));
        if (p === '/api/live/wsl/dirs') return Promise.resolve(DIRS((params || {}).path));
        if (p === '/api/live/wsl/agents') return Promise.resolve(clone(agents || { distro: 'ubuntu', name: 'Ubuntu', agents: [] }));
        if (p === '/api/live/wsl/agents/install') return Promise.resolve({ state: 'running', stage: 'downloading', percent: 30 });
        return Promise.resolve({});
      },
      postJson: () => Promise.resolve({ state: 'running', stage: 'downloading', percent: 30 }),
      currentPath: () => currentPath || '',
    });
    return (s) => {
      cur = s;
      window.AIBWsl._set(s);
    };
  }

  // ---- the new-chat WSL box, as chat.js renderWslAgentNote builds it ------------------------------------------------------------
  function newChatBox(row, agentName, provider) {
    const W = window.AIBWsl;
    document.body.classList.add('new-chat');
    $('chat').hidden = false;
    $('title').textContent = 'New chat';
    const sel = $('ncAgent');
    sel.replaceChildren(el('option', agentName));
    $('ncModel').replaceChildren(el('option', 'Default'));
    $('ncMode').replaceChildren(el('option', 'Default'));
    $('ncFolder').textContent = 'Ubuntu · ~/app';
    const anchor = $('ncFolder');
    const box = el('div', null, 'nc-wsl');
    box.id = 'ncWsl';
    anchor.after(box);
    const name = 'Ubuntu';
    const line = el('p', null, 'st-note' + (row.found ? '' : ' bad'));
    const actions = el('p', null, 'st-note');
    const link = (label, title) => {
      const b = el('button', label, 'st-link');
      b.type = 'button';
      if (title) b.title = title;
      actions.append(b);
    };
    if (!row.found) {
      line.textContent = agentName + ' is not installed in ' + name + '.' + (row.installable ? '' : row.note ? ' ' + row.note : '');
      box.append(line);
      if (row.installable) box.append(W.installBox({ key: 'ubuntu', id: provider, agentName, row, done: () => {} }));
      if (row.install) {
        const cmd = el('code', row.install, 'nc-wsl-cmd');
        const copyLine = el('p', null, 'st-note' + (row.installable ? ' dim' : ''));
        copyLine.append((row.installable ? 'Or install it yourself in ' : 'Install it in ') + name + ': ', cmd, ' ');
        const copy = el('button', 'Copy', 'st-link');
        copy.type = 'button';
        copyLine.append(copy);
        box.append(copyLine);
      }
      link('Open ' + name + ' terminal', 'A terminal in ' + name + ' to install ' + agentName);
      link('Set up ' + name + ' in Settings', 'Settings > AIB Linking (WSL): the agents in ' + name + ', their installs and updates');
    } else {
      line.textContent = agentName + ' in ' + name + (row.version ? ' (' + row.version + ')' : '') + (row.managed ? ', installed by AIB' : '') + '.';
      box.append(line);
      if (row.update) box.append(W.installBox({ key: 'ubuntu', id: provider, agentName, row, done: () => {} }));
      link('Sign in', 'Run ' + agentName + "'s own sign-in in a " + name + ' terminal');
    }
    box.append(actions);
  }

  // ---- chat list rows: chat.js rowStatus markup + status-words.js phrases ------------------------------------------------------------
  function rowStatusNode(kind) {
    const box = el('small', '', 'connection-state');
    if (kind === 'live-idle' || kind === 'live-busy') {
      box.className += ' owned-status';
      box.append(el('span', '● ' + (kind === 'live-busy' ? 'Working' : 'Ready'), 'badge badge-live'), el('span', ' Live in AIB', 'status-detail'));
    } else if (kind === 'couldnt') {
      box.append(el('span', "Couldn't reopen", 'badge badge-recovered'), el('span', ' Could not reopen after the restart', 'status-detail'));
    } else if (kind === 'recovered') {
      box.append(el('span', 'Ready', 'badge badge-recovered'), el('span', ' Was open in AIB before restart', 'status-detail'));
    } else box.append(el('span', 'Saved', 'badge badge-saved'), el('span', ' 2h ago', 'status-detail'));
    return box;
  }
  function chatRows() {
    const SW = window.AgentStatusWords;
    const now = Date.now();
    const rows = [
      ['Live, idle', 'live-idle', { connected: true }, 'Ubuntu'],
      ['Live, your turn', 'live-idle', { connected: true, yourTurn: true }, ''],
      ['Live, working', 'live-busy', { connected: true, busy: true, busySince: now - 3 * 60000 }, 'Ubuntu'],
      ['Saved (not running)', 'saved', {}, ''],
      ['Recovered after restart', 'recovered', { recovered: true }, ''],
      ["Couldn't reopen", 'couldnt', { reconnectError: 'Ubuntu did not start' }, 'Ubuntu'],
    ];
    const list = el('div', null, 'list-group project-group');
    const inner = el('div', null, 'project-rows');
    list.append(inner);
    for (const [label, kind, facts, distro] of rows) {
      const s = SW.statusOf(Object.assign({ now }, facts));
      const wrap = el('div', null, 'conversation-row');
      const b = el('button', null, 'connection');
      b.type = 'button';
      b.dataset.qa = label;
      const meta = el('small', null, ' connection-workspace row-meta');
      const mark = el('span', null, 'status-mark');
      mark.append(Object.assign(el('span', null, 'status-dot ' + s.dotClass), {}));
      meta.append(mark, el('span', distro ? 'Claude Code · ' + distro : 'Claude Code', 'row-meta-text'));
      b.append(meta, el('span', label + ': fix the login form', 'connection-title'), rowStatusNode(kind), el('span', '1h', 'row-age'));
      const st = el('span', null, 'row-status tone-' + s.tone);
      st.append(el('span', s.label, 'row-phrase'), el('span', ' · Claude Code', 'row-agent'));
      b.append(st);
      wrap.append(b);
      inner.append(wrap);
    }
    $('connections').replaceChildren(list);
    $('chat').hidden = false;
    // the header chip of the open chat (header-ui reads the same statusOf): Ready vs Couldn't reopen
    $('title').textContent = 'Fix the login form';
    const sub = $('subtitle');
    sub.hidden = false;
    sub.textContent = window.AIBWsl.headerPath('wsl://ubuntu/home/u/app');
    $('status').textContent = SW.statusOf({ connected: true }).label;
  }

  const S = {
    'state-starting': () => {
      wsl({ available: true, distros: [Object.assign({}, UBUNTU, { state: 'starting', line: 'Starting Ubuntu…' })], openRequests: [] }, 'wsl://ubuntu/home/u/app');
    },
    'state-setup': () => {
      wsl({ available: true, distros: [Object.assign({}, UBUNTU, { state: 'installing', line: 'Setting up AIB in Ubuntu (first time, ~100 MB)' })], openRequests: [] }, 'wsl://ubuntu/home/u/app');
    },
    'state-stopped': () => {
      wsl({ available: true, distros: [Object.assign({}, UBUNTU, { state: 'stopped', line: 'Ubuntu stopped. Reconnect' })], openRequests: [] }, 'wsl://ubuntu/home/u/app');
    },
    'open-url': () => {
      wsl(Object.assign({}, STATUS, { openRequests: [{ id: 'r1', distro: 'ubuntu', name: 'Ubuntu', url: 'https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_EMoamEEZ73f0CkXaXp7hrann&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid+profile+email', at: 1 }] }), 'wsl://ubuntu/home/u/app');
    },
    'np-wsl': async () => {
      await newProject(false);
    },
    'np-browse': async () => {
      await newProject(true);
    },
    'del-wsl': async () => del(false, null),
    'del-wsl-ticked': async () => del(true, null),
    'del-wsl-refused': async () => del(false, 'This distro has no trash AIB can use for this folder'),
    'nc-missing': async () => {
      wsl(STATUS, '');
      await settle();
      newChatBox({ id: 'claude', found: false, installable: true, pinned: '0.102.0', install: 'npm i -g @agentclientprotocol/claude-agent-acp' }, 'Claude Code', 'claude');
    },
    'nc-node': async () => {
      wsl(STATUS, '');
      await settle();
      newChatBox({ id: 'claude', found: false, installable: true, pinned: '0.102.0', install: 'npm i -g @agentclientprotocol/claude-agent-acp', installBlock: 'Node.js 22 or newer is needed in Ubuntu to install Claude Code, and Ubuntu has no Node.js.', nodeInstall: 'curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.41.0/install.sh | bash && nvm install --lts' }, 'Claude Code', 'claude');
    },
    'nc-installing': async () => {
      wsl(STATUS, '');
      await settle();
      newChatBox({ id: 'codex', found: false, installable: true, pinned: '2.6.0', install: 'npm i -g @agentclientprotocol/codex-acp', job: { state: 'running', stage: 'downloading', percent: 30 } }, 'Codex', 'codex');
    },
    'nc-found': async () => {
      wsl(STATUS, '');
      await settle();
      newChatBox({ id: 'codex', found: true, version: '2.6.0', managed: true }, 'Codex', 'codex');
    },
    'nc-update': async () => {
      wsl(STATUS, '');
      await settle();
      newChatBox({ id: 'claude', found: true, managed: true, update: true, version: '0.101.0', pinned: '0.102.0', installable: true }, 'Claude Code', 'claude');
    },
    'status-words': async () => {
      wsl(STATUS, 'wsl://ubuntu/home/u/app');
      await settle();
      chatRows();
    },
    'project-menu': async () => {
      wsl(STATUS, 'wsl://ubuntu/home/u/app');
      await settle();
      const list = [
        { provider: 'claude', id: 'a', key: 'k-a', title: 'Fix the login form', cwd: 'wsl://ubuntu/home/u/app', created: 100, modified: 100 },
        { provider: 'codex', id: 'c', key: 'k-c', title: 'Add tests', cwd: 'wsl://debian/home/d/api', created: 95, modified: 95 },
        { provider: 'claude', id: 'b', key: 'k-b', title: 'Landing page', cwd: 'C:\\work\\site', created: 90, modified: 90 },
      ];
      const Wu = window.AgentWorkspaceUI;
      Wu.init({ aliasKey: (c) => c.provider + ':' + c.id, titleOf: (c) => c.title, conversations: () => list, rerender() {}, getJson: async () => ({}), postJson: async () => ({}), open: () => true, showStart() {}, notice() {}, reload() {}, quickPrompt() {} });
      Wu.sync(list, null);
      const item = Wu._items().find((i) => String(i.projectPath).startsWith('wsl://ubuntu'));
      if (item) Wu.selectProject(item.projectKey);
      Wu.sync(list, null);
      Wu.openProjectMenu();
      await settle();
    },
    'publish-failed': async () => {
      const A = window.ArtifactsUI;
      const reason = 'In a WSL project, publish by `content`: AIB cannot open files inside the distro. In this WSL project only `content` works: pass the text itself (HTML, SVG, Markdown, CSV, JSON or plain text); `path` is not supported, because AIB runs on Windows and cannot open files inside the distro.';
      const m = A.cardModel({ op: 'publish', input: { title: '' }, result: null, status: 'failed', error: reason }, []);
      const card = el('div', null, 'art-card');
      card.setAttribute('role', 'group');
      card.setAttribute('aria-label', 'Artifact');
      // paintCard (artifacts-ui.js 2613-2681), for this model
      const ic = el('span', null, 'art-card-ic art-card-win');
      ic.append(document.createTextNode(m.badge || ''));
      const body = el('div', null, 'art-card-body');
      body.append(el('div', m.title, 'art-card-title'), el('div', A.cardLine(m), 'art-card-sub'));
      if (m.error) {
        const err = el('div', m.error, 'art-card-err');
        err.title = m.error;
        body.append(err);
      }
      const acts = el('div', null, 'art-card-actions');
      const open = el('button', 'View', 'art-btn');
      open.type = 'button';
      open.disabled = !m.canOpen;
      acts.append(open);
      card.append(ic, body, acts);
      $('chat').hidden = false;
      const msgs = $('messages');
      const holder = el('div', null, 'qa-card-holder');
      holder.style.cssText = 'max-width:720px;margin:24px';
      holder.append(card);
      msgs.prepend(holder);
      window.__qaCardModel = m;
    },
  };

  async function newProject(browse) {
    const st = STATUS;
    wsl(st, '');
    window.AgentNewProjectUI.init({
      getJson: (p, params) => {
        if (p === '/api/live/folders/start') return Promise.resolve({ start: 'C:\\REPOS', home: 'C:\\Users\\me', source: 'last' });
        if (p === '/api/live/wsl/dirs') return Promise.resolve(DIRS(params.path));
        return Promise.resolve({ valid: true, exists: true, isDir: true, path: params.path, reason: 'existing', gitAvailable: true });
      },
      postJson: () => Promise.resolve({ ok: true }),
      projects: () => [],
      keyOf: (p) => String(p),
      done: () => {},
    });
    await settle();
    window.AgentNewProjectUI.open(null);
    await settle(10);
    const ui = window.AgentNewProjectUI._ui();
    ui.location.value = 'ubuntu';
    ui.location.dispatchEvent(new Event('change', { bubbles: true }));
    await settle(10);
    if (browse) {
      ui.browseWsl.click();
      await settle(10);
    }
  }
  async function del(tick, refusal) {
    wsl(STATUS, '');
    await settle();
    const ui = window.AgentDeleteProjectUI.show({
      name: 'app',
      path: 'wsl://ubuntu/home/u/app',
      chats: 2,
      running: 1,
      check: () => Promise.resolve({ exists: true, refusal: refusal || '', trash: refusal ? 'permanent' : 'gio', worktreeOf: '' }),
      confirm: () => new Promise(() => {}),
    });
    await settle(10);
    if (tick) {
      const d = ui.box.querySelector('#dpDisk');
      d.checked = true;
      d.dispatchEvent(new Event('change', { bubbles: true }));
      await settle();
    }
  }

  const name = decodeURIComponent(location.hash.slice(1));
  window.__qaScenarios = Object.keys(S);
  Promise.resolve()
    .then(() => S[name]())
    .then(() => settle(8))
    .then(
      () => (window.__qaDone = true),
      (e) => {
        window.__qaError = String((e && e.stack) || e);
        window.__qaDone = true;
      },
    );
})();
