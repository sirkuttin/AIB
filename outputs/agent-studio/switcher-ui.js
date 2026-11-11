(function (root) {
  'use strict';
  // Ctrl+K quick switcher and sidebar keyboard shortcuts. Conversation titles are untrusted: text only, never HTML.
  const doc = () => root.document;
  const el = (tag, content, cls) => {
    const n = doc().createElement(tag);
    if (content != null && content !== '') n.textContent = String(content);
    if (cls) n.className = cls;
    return n;
  };
  const MAX_RESULTS = 40;
  const SHORTCUTS = [
    ['Ctrl+K', 'find chats, projects and actions'],
    ['Alt+↑ / Alt+↓', 'previous / next in the sidebar'],
    ['Ctrl+Shift+N', 'new conversation in this project (Alt+N too)'],
    ['?', 'all shortcuts'],
  ];

  let host = null,
    dialog = null,
    input = null,
    list = null,
    results = [],
    active = 0;

  // ---- matching and the action registry live in commands-registry.js (pure) ---------------------
  const C = () => root.AgentCommands;
  const score = (t, x) => C().score(t, x),
    rank = (q, f) => C().rank(q, f),
    search = (i, q) => C().search(i, q);

  // ---- data from the page -------------------------------------------------------------------
  function collect() {
    const S = root.AgentSidebarUI,
      O = root.AgentOrganizeUI,
      out = [];
    for (const c of host.conversations()) {
      const bucket = O && O.bucket ? O.bucket(c) : 'main';
      if (bucket === 'deleted') continue;
      const p = S ? S.projectOf(c) : { name: '', path: c.cwd || '' };
      out.push({
        c,
        key: host.aliasKey(c),
        title: host.titleOf(c),
        original: String(c.title || c.prompt || ''),
        project: p.name,
        path: p.path,
        provider: S ? S.providerName(c.provider) : c.provider,
        archived: bucket === 'archived',
        pinned: bucket === 'pinned',
        hold: bucket === 'hold',
        activity: S ? S.activityOf(c) : Math.max(c.modified || 0, c.created || 0),
        status: S ? S.statusOf(c) : { state: 'saved', needs: 0, label: 'Saved' },
      });
    }
    return out;
  }
  // What the actions can do on this page right now. A function another module has not provided yet is left out, so its action hides.
  function makeCtx() {
    const O = root.AgentOrganizeUI,
      W = root.AgentWorkspaceUI,
      R = root.AgentResizeUI,
      V = root.AgentChatView,
      S = root.AgentSidebarUI;
    const chat = host.getSelected ? host.getSelected() : null;
    const menu = new Set();
    let thinking = null;
    if (chat && O && O.menuModel) {
      thinking =
        V && typeof V.setThinking === 'function' && typeof V.getThinking === 'function' ? !!V.getThinking() : null;
      for (const it of O.menuModel(chat, { thinking, handoff: !!(V && typeof V.startHandoff === 'function') }))
        if (!it.sep) menu.add(it.id);
    }
    const d = {};
    if (chat && O && typeof O.run === 'function') d.chat = (id) => O.run(id, chat, 'header');
    if (W && typeof W.paletteProjects === 'function' && typeof host.newInProject === 'function')
      d.newChat = (p) => {
        const known = host.conversations().find((c) => S && S.projectOf(c).path === p.path);
        const prov = doc().getElementById ? doc().getElementById('provider') : null;
        host.newInProject(known || { cwd: p.path, provider: prov && prov.value });
        if (typeof W.focusNewChatIn === 'function') W.focusNewChatIn(p.key);
      };
    if (W && typeof W.openNewProject === 'function') d.newProject = () => W.openNewProject();
    if (W && typeof W.openProjectMenu === 'function') d.switchProject = () => W.openProjectMenu({ filter: true });
    if (W && typeof W.toggleInbox === 'function') d.openInbox = () => W.toggleInbox(true);
    if (R && typeof R.toggleSide === 'function') d.toggleSide = () => R.toggleSide();
    if (R && typeof R.toggleActivity === 'function') d.toggleActivity = () => R.toggleActivity();
    const T = root.AgentTextSize;
    if (T && typeof T.bigger === 'function') {
      d.chatBigger = () => T.bigger('chat');
      d.chatSmaller = () => T.smaller('chat');
      d.chatReset = () => T.reset('chat');
      d.uiBigger = () => T.bigger('ui');
      d.uiSmaller = () => T.smaller('ui');
      d.uiReset = () => T.reset('ui');
    }
    d.showSheet = () => openSheet();
    if (root.AgentSettingsUI && typeof root.AgentSettingsUI.open === 'function')
      d.openSettings = () => root.AgentSettingsUI.open();
    const projects = W && typeof W.paletteProjects === 'function' ? W.paletteProjects() : [];
    // The project the editor actions work on: the open chat's folder, else the project being viewed.
    const E = root.AgentEditors,
      here = chat && chat.cwd ? chat.cwd : (projects.find((p) => p.active) || {}).path || '';
    let editor = null;
    if (E && E.loaded() && here) {
      editor = { name: E.editorLabel(), explorer: E.hasExplorer(), terminal: E.hasTerminal() };
      const useWs = !!(projects.find((p) => p.path === ((chat && chat.projectRoot) || here)) || {}).useWorkspace;
      d.openProjectEditor = () => E.openProject(here, { useWorkspace: useWs });
      d.showProjectExplorer = () => E.showInExplorer(here);
      d.openProjectTerminal = () => E.openTerminal(here);
    }
    return {
      chat,
      menu,
      thinking,
      projects,
      editor,
      keys: { inbox: W && typeof W.inboxKey === 'string' ? W.inboxKey : '' },
      do: d,
    };
  }

  // ---- dialog -------------------------------------------------------------------------------
  let mode = 'all',
    armed = null,
    prompt = '',
    tabs = null,
    ctx = null;
  function build() {
    dialog = el('dialog', null, 'switcher');
    dialog.id = 'switcher';
    dialog.setAttribute('aria-label', 'Command bar');
    input = el('input', null, 'switcher-input');
    input.type = 'text';
    input.placeholder = 'Find a chat, file, project or action…  (> for actions)';
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-controls', 'switcherList');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-label', 'Find a chat, project or action');
    input.autocomplete = 'off';
    tabs = el('div', null, 'switcher-tabs');
    tabs.setAttribute('role', 'group');
    tabs.setAttribute('aria-label', 'Show');
    list = el('ul', null, 'switcher-list');
    list.id = 'switcherList';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', 'Results');
    const foot = el('p', null, 'switcher-foot');
    SHORTCUTS.forEach(([keys, what], i) => {
      foot.append(el('kbd', keys), el('span', ' ' + what + (i < SHORTCUTS.length - 1 ? '  ·  ' : '')));
    });
    const hint = el(
      'p',
      '↑↓ move, Enter runs, Tab changes the filter, > shows actions only, Esc closes.',
      'switcher-hint',
    );
    dialog.append(input, tabs, list, hint, foot);
    doc().body.appendChild(dialog);
    input.addEventListener('input', () => {
      active = 0;
      armed = null;
      draw();
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        move(1);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        move(-1);
      } else if (event.key === 'Tab') {
        event.preventDefault();
        setMode(C().nextMode(mode, event.shiftKey ? -1 : 1));
      } else if (event.key === 'Home' && results.length) {
        event.preventDefault();
        active = 0;
        armed = null;
        paintActive();
        refreshPrompt();
      } else if (event.key === 'End' && results.length) {
        event.preventDefault();
        active = results.length - 1;
        armed = null;
        paintActive();
        refreshPrompt();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        choose(active);
      }
    });
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) close();
    });
  }
  function setMode(m) {
    mode = m;
    active = 0;
    armed = null;
    draw();
  }
  function drawTabs() {
    const eff = C().parseQuery(input.value, mode).mode,
      frag = doc().createDocumentFragment();
    for (const m of C().MODES) {
      const b = el('button', C().MODE_LABEL[m], 'switcher-tab' + (m === eff ? ' on' : ''));
      b.type = 'button';
      b.tabIndex = -1;
      b.setAttribute('aria-pressed', String(m === eff));
      b.dataset.mode = m;
      b.onclick = () => {
        setMode(m);
        input.focus();
      };
      frag.append(b);
    }
    tabs.replaceChildren(frag);
  }
  function move(step) {
    if (!results.length) return;
    armed = null;
    active = (active + step + results.length) % results.length;
    paintActive();
    refreshPrompt();
  }
  function paintActive() {
    const nodes = list.children || [];
    for (let i = 0; i < nodes.length; i++) {
      const on = i === active;
      nodes[i].setAttribute('aria-selected', String(on));
      nodes[i].className =
        'switcher-item' +
        (on ? ' active' : '') +
        (results[i] && results[i].kind === 'action' && results[i].danger ? ' danger' : '');
      if (on) {
        input.setAttribute('aria-activedescendant', nodes[i].id);
        if (nodes[i].scrollIntoView) nodes[i].scrollIntoView({ block: 'nearest' });
      }
    }
  }
  // The "Press Enter again" line replaces the sub line of the armed row.
  function refreshPrompt() {
    const nodes = list.children || [];
    for (let i = 0; i < nodes.length; i++) {
      const r = results[i];
      if (!r || r.kind !== 'action') continue;
      const sub = nodes[i].querySelector
        ? nodes[i].querySelector('.switcher-sub')
        : nodes[i].find
          ? nodes[i].find('switcher-sub')[0]
          : null;
      if (sub) {
        sub.textContent = armed === r.id ? prompt : r.group;
        sub.className = 'switcher-sub' + (armed === r.id ? ' warn' : '');
      }
    }
  }
  function keysEl(text) {
    const wrap = el('span', null, 'switcher-key');
    String(text)
      .split(' / ')
      .forEach((k, i) => {
        if (i) wrap.append(el('span', ' / '));
        wrap.append(el('kbd', k));
      });
    return wrap;
  }
  function draw() {
    const S = root.AgentSidebarUI;
    ctx = makeCtx();
    const sources = { chats: collect(), projects: ctx.projects, actions: C().buildActions(ctx) };
    results = C().compose(sources, input.value, mode, MAX_RESULTS);
    results = results.concat(fileResults());
    if (active >= results.length) active = Math.max(0, results.length - 1);
    drawTabs();
    const frag = doc().createDocumentFragment();
    results.forEach((r, i) => {
      const li = el('li', null, 'switcher-item');
      li.id = 'switcherItem' + i;
      li.setAttribute('role', 'option');
      const text = el('div', null, 'switcher-text');
      if (r.kind === 'chat') {
        li.append(S ? S.dot(r.status.state, r.status.label, r.status.needs) : el('span'));
        text.append(el('span', r.title, 'switcher-title'));
        const sub = [r.project, r.provider];
        if (r.pinned) sub.push('Pinned');
        if (r.hold) sub.push('On hold');
        if (r.archived) sub.push('Archived');
        text.append(
          el('small', sub.join(' · ') + (r.status.state !== 'saved' ? ' · ' + r.status.label : ''), 'switcher-sub'),
        );
        li.title = r.path || '';
        li.append(text, el('span', 'Chat', 'switcher-kind'));
      } else if (r.kind === 'file') {
        li.append(el('span', '▢', 'switcher-ico'));
        text.append(el('span', r.name, 'switcher-title'));
        text.append(el('small', (r.dir || 'top folder') + (r.branch ? ' · ⎇ ' + r.branch : ''), 'switcher-sub'));
        li.title = r.path;
        li.append(text, el('span', 'File', 'switcher-kind'));
      } else if (r.kind === 'project') {
        li.append(el('span', '▤', 'switcher-ico'));
        text.append(el('span', r.name, 'switcher-title'));
        text.append(
          el('small', (r.path || 'No folder') + (r.waiting ? ' · ' + r.waiting + ' need you' : ''), 'switcher-sub'),
        );
        li.title = r.path || '';
        li.append(text, el('span', 'Project', 'switcher-kind'));
      } else {
        li.append(el('span', '›', 'switcher-ico'));
        text.append(el('span', r.title, 'switcher-title'));
        text.append(el('small', armed === r.id ? prompt : r.group, 'switcher-sub' + (armed === r.id ? ' warn' : '')));
        li.append(text);
        if (r.shortcut) li.append(keysEl(r.shortcut));
        else li.append(el('span', 'Action', 'switcher-kind'));
      }
      li.onclick = () => choose(i);
      li.onmousemove = () => {
        if (active !== i) {
          active = i;
          armed = null;
          paintActive();
          refreshPrompt();
        }
      };
      frag.append(li);
    });
    const q = C().parseQuery(input.value, mode);
    if (!results.length) frag.append(el('li', q.query ? 'Nothing matches.' : 'Nothing to show.', 'switcher-empty'));
    list.replaceChildren(frag);
    paintActive();
  }
  // Files of the current project (files-ui.js search), after the chats: asked once per query, drawn when they arrive.
  const MAX_FILES = 8;
  let fileQ = '',
    fileHits = [];
  function fileResults() {
    const FU = root.AgentFilesUI,
      q = C().parseQuery(input.value, mode);
    if (!FU || !FU.search || q.mode !== 'all' || String(q.query || '').trim().length < 2) return [];
    const text = String(q.query).trim();
    if (text !== fileQ) {
      fileQ = text;
      fileHits = [];
      FU.search(text).then(
        (r) => {
          if (fileQ !== text || !dialog || !dialog.open) return;
          fileHits = (r.matches || []).slice(0, MAX_FILES).map((m) => ({
            kind: 'file',
            path: m.path,
            name: m.name,
            dir: m.dir,
            scope: r.scope,
            branch: r.scope && r.scope.branch,
          }));
          draw();
        },
        () => {},
      );
    }
    return fileHits;
  }
  function choose(i) {
    const r = results[i];
    if (!r) return;
    if (r.kind === 'action') {
      const step = C().confirmStep(armed, r);
      if (!step.run) {
        armed = step.armed;
        prompt = step.prompt;
        refreshPrompt();
        return;
      }
      armed = null;
      close();
      r.run();
      return;
    }
    close();
    if (r.kind === 'file') {
      const FU = root.AgentFilesUI;
      if (FU && FU.openFile) FU.openFile(r.scope, r.path, { keep: true });
      return;
    }
    if (r.kind === 'project') {
      const W = root.AgentWorkspaceUI;
      if (W && W.selectProject) W.selectProject(r.key);
      landFocus();
      return;
    }
    Promise.resolve(host.open(r.c)).then(landFocus, landFocus);
  }
  // The bar closed and the page redrew under it: the element it would hand focus back to is often gone, which leaves focus
  // on the page body. Put it in the message box of the chat you picked, else on its card (QA m9).
  function landFocus() {
    const d = doc(),
      a = d.activeElement;
    if (a && a !== d.body && a.isConnected !== false) return;
    const box = d.getElementById('prompt');
    if (box && !box.disabled && box.offsetParent !== null && box.focus) {
      box.focus();
      return;
    }
    const card = d.querySelector ? d.querySelector('aside .connection.selected') : null;
    if (card && card.focus) card.focus();
  }
  function open() {
    if (!host) return;
    if (!dialog) build();
    if (dialog.open) {
      close();
      return;
    }
    closeSheet();
    input.value = '';
    active = 0;
    mode = 'all';
    armed = null;
    draw();
    dialog.showModal();
    input.focus();
  }
  function close() {
    if (dialog && dialog.open) dialog.close();
  }

  // ---- shortcut sheet ("?") -----------------------------------------------------------------
  let sheet = null;
  function buildSheet() {
    sheet = el('dialog', null, 'switcher sheet');
    sheet.id = 'shortcutSheet';
    sheet.setAttribute('aria-label', 'Keyboard shortcuts');
    doc().body.appendChild(sheet);
    sheet.addEventListener('keydown', (event) => {
      if (event.key === '?') {
        event.preventDefault();
        closeSheet();
      }
    });
    sheet.addEventListener('click', (event) => {
      if (event.target === sheet) closeSheet();
    });
  }
  function openSheet() {
    if (!host) return;
    if (!sheet) buildSheet();
    close();
    if (sheet.open) return;
    const frag = doc().createDocumentFragment();
    frag.append(el('h2', 'Keyboard shortcuts', 'sheet-title'));
    for (const g of C().sheetModel(makeCtx())) {
      const sec = el('section', null, 'sheet-group');
      sec.append(el('h3', g.name));
      const ul = el('ul', null, 'sheet-rows');
      for (const row of g.rows) {
        const li = el('li', null, 'sheet-row');
        li.append(el('span', row.label, 'sheet-label'), keysEl(row.keys));
        ul.append(li);
      }
      sec.append(ul);
      frag.append(sec);
    }
    frag.append(el('p', 'Press ? or Esc to close. Ctrl+K also runs any action by name.', 'switcher-hint'));
    sheet.replaceChildren(frag);
    sheet.showModal();
  }
  function closeSheet() {
    if (sheet && sheet.open) sheet.close();
  }

  // ---- shortcuts ----------------------------------------------------------------------------
  function typing(target) {
    if (!target || !target.tagName) return false;
    const tag = String(target.tagName).toLowerCase();
    return (
      tag === 'input' ||
      tag === 'textarea' ||
      tag === 'select' ||
      !!target.isContentEditable ||
      !!(target.closest && target.closest('dialog[open]'))
    );
  }
  function step(direction) {
    const O = root.AgentOrganizeUI;
    if (!O || !O.visibleKeys) return;
    const keys = O.visibleKeys(),
      selected = host.getSelected();
    const at = selected ? keys.indexOf(host.aliasKey(selected)) : -1;
    let next = at < 0 ? (direction > 0 ? 0 : keys.length - 1) : at + direction;
    if (next < 0 || next >= keys.length) return;
    const c = host.conversations().find((x) => host.aliasKey(x) === keys[next]);
    if (c) host.open(c);
  }
  function onKey(event) {
    const key = String(event.key || '');
    const mod = event.ctrlKey || event.metaKey;
    if (mod && !event.shiftKey && !event.altKey && key.toLowerCase() === 'k') {
      event.preventDefault();
      open();
      return true;
    }
    if (dialog && dialog.open) return false;
    if (sheet && sheet.open) return false;
    if (typing(event.target)) return false;
    if (key === '?' && !mod && !event.altKey) {
      event.preventDefault();
      openSheet();
      return true;
    }
    if (event.altKey && !mod && !event.shiftKey && (key === 'ArrowUp' || key === 'ArrowDown')) {
      event.preventDefault();
      step(key === 'ArrowDown' ? 1 : -1);
      return true;
    }
    const newChat =
      (mod && event.shiftKey && !event.altKey && key.toLowerCase() === 'n') ||
      (event.altKey && !mod && !event.shiftKey && key.toLowerCase() === 'n');
    if (newChat) {
      event.preventDefault();
      host.newInProject(host.getSelected());
      return true;
    }
    return false;
  }

  function init(h) {
    host = h;
    doc().addEventListener('keydown', onKey);
    const hint = doc().getElementById('findChat');
    if (hint) {
      hint.onclick = open;
      hint.title = SHORTCUTS.map((s) => s[0] + '  ' + s[1]).join('\n');
    }
  }

  const api = {
    init,
    open,
    close,
    openSheet,
    closeSheet,
    score,
    rank,
    search,
    collect,
    makeCtx,
    onKey,
    typing,
    SHORTCUTS,
    _results: () => results,
    _mode: () => mode,
    _armed: () => armed,
  };
  root.AgentSwitcherUI = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
