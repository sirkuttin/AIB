(function (root) {
  'use strict';
  // The project's files, in the left sidebar (direction A of the "project files" design).
  //  - A Chats | Files switch under Find (Ctrl+Shift+E). The Chats half carries the amber count of this project's chats that
  //    need you.
  //  - Files mode: the scope button (which copy of the project: follows the open chat by default), a filter (Ctrl+Shift+F) and a
  //    "Changed n" toggle, a lazy tree (one folder at a time; .git never, ignored entries as one dimmed row), change badges from the
  //    chat's Changes data (a click opens that file's diff), "n changed" on folders, ⧉ on files that are artifacts.
  //  - Files open as tabs in the chat tab strip (a single click opens an italic preview tab that the next click replaces) and show
  //    in the middle, read only. From a reply, at 1280 px and wider, a file opens beside the chat instead.
  //  - Paths in replies that name an existing file in the chat's folder become file links (never artifacts).
  // Pure decisions live in files-state.js. Paths and names from disk are untrusted: text only, never HTML.
  const doc = () => root.document;
  const F = () => root.AgentFilesState;
  const W = () => root.AgentWorkspaceUI;
  const SB = () => root.AgentSidebarUI;
  const CH = () => (root.AgentChangesUI && root.AgentChangesUI._live ? root.AgentChangesUI._live() : null);
  const AR = () => root.AgentArtifactsUI;
  const ED = () => root.AgentEditors;
  const TV = () => root.ToolViews;
  const el = (tag, text, cls) => {
    const n = doc().createElement(tag);
    if (text != null && text !== '') n.textContent = String(text);
    if (cls) n.className = cls;
    return n;
  };
  const btn = (text, cls, title) => {
    const b = el('button', text, cls);
    b.type = 'button';
    if (title) {
      b.title = title;
      b.setAttribute('aria-label', title.split('\n')[0]);
    }
    return b;
  };
  const NS = 'http://www.w3.org/2000/svg';
  function icon(d, cls) {
    const D = doc();
    if (!D.createElementNS) return el('span', null, cls);
    const svg = D.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.3');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('class', cls || '');
    const p = D.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    svg.append(p);
    return svg;
  }
  const FILE_D = 'M4 1.5h5l3.5 3.5v9.5h-8.5zM9 1.5V5h3.5';
  const DIR_D = 'M1.5 3.5h4.5l1.5 1.5h7v8.5h-13z';
  const IMG_D = 'M2 3h12v10H2zM2 11l3.5-3.5 3 3 2-2L14 12';
  const CODE_D = 'M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5';
  const CODE_EXT = /\.(js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|c|h|cpp|cs|php|sh|ps1|css|scss|json|ya?ml|toml|sql|kt|swift|lua)$/i;
  const IMG_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i;
  const fileIcon = (name) => icon(IMG_EXT.test(name) ? IMG_D : CODE_EXT.test(name) ? CODE_D : FILE_D, 'fx-ico');

  // ---- state -------------------------------------------------------------------------------------------------------------
  const MODE_KEY = 'aib-sidebar-mode';
  const TABS_KEY = 'aib-file-tabs-v1';
  let host = null,
    mode = 'chats',
    chat = null, // {id, key, cwd, title, branch, projectKey, projectPath} of the open chat
    following = true,
    pinned = null, // the scope chosen in the menu while not following
    query = '',
    changedOnly = false,
    showIgnored = false,
    sel = '',
    results = null, // {q, matches, total} of the filter
    searchSeq = 0;
  const trees = new Map(); // scope id -> {cache: {dir: entries|'loading'|{error}}, open: Set, root: '', git}
  let tabsByProject = {}, // project key -> {tabs, active}
    beside = F() ? F().emptyTabs() : { tabs: [], active: '' },
    view = 'chat'; // what the middle shows: 'chat' or 'file'
  const reads = new Map(); // tab id -> {loading, data, error, mode, gutter: Set|null}
  let els = null;

  const store = {
    get(k, d) {
      try {
        const v = root.localStorage.getItem(k);
        return v == null ? d : v;
      } catch (e) {
        return d;
      }
    },
    set(k, v) {
      try {
        root.localStorage.setItem(k, v);
      } catch (e) {
        /* private window */
      }
    },
  };
  function saveTabs() {
    const out = {};
    for (const pk of Object.keys(tabsByProject)) {
      const t = tabsByProject[pk];
      if (t && t.tabs.length) out[pk] = { tabs: t.tabs.filter((x) => !x.preview).slice(0, 40), active: '' };
    }
    store.set(TABS_KEY, JSON.stringify(out));
  }
  function loadTabs() {
    try {
      const raw = JSON.parse(store.get(TABS_KEY, '{}'));
      if (raw && typeof raw === 'object') {
        for (const pk of Object.keys(raw)) {
          const t = raw[pk];
          if (t && Array.isArray(t.tabs))
            tabsByProject[pk] = {
              tabs: t.tabs.filter((x) => x && typeof x.path === 'string' && x.scope && typeof x.scope.id === 'string'),
              active: '',
            };
        }
      }
    } catch (e) {
      tabsByProject = {};
    }
  }
  const projectKey = () => (W() && W().currentProject ? W().currentProject() : '') || (chat && chat.projectKey) || '';
  const tabsHere = () => tabsByProject[projectKey()] || F().emptyTabs();
  function setTabsHere(next) {
    tabsByProject[projectKey()] = next;
    saveTabs();
  }

  // ---- data ------------------------------------------------------------------------------------------------------------
  const chatIdOf = (c) =>
    c ? (c.live && !c.live.closed && c.live.id ? c.live.id : c.provider + ':' + (c.id || c.sessionId || '')) : '';
  function chatInfo(c) {
    if (!c || !host) return null;
    const S = SB(),
      p = S ? S.projectOf(c) : { key: '', path: '' };
    return {
      id: chatIdOf(c),
      key: host.aliasKey(c),
      cwd: c.cwd || '',
      title: host.titleOf(c),
      branch: S ? S.branchOf(c) : '',
      projectKey: p.key,
      projectPath: p.path || '',
    };
  }
  // The project's chats (for the scope menu), newest first.
  function projectChats() {
    const pk = projectKey();
    if (!host || !SB()) return [];
    return (host.conversations() || [])
      .filter((c) => c && c.provider && SB().projectOf(c).key === pk)
      .map(chatInfo)
      .filter(Boolean);
  }
  function currentScope() {
    if (!following && pinned) return pinned;
    const c = chat && chat.projectKey === projectKey() ? chat : null;
    if (c) return F().followScope(c, c.projectPath);
    const any = projectChats()[0];
    return any ? F().followScope(Object.assign({}, any, { branch: '' }), any.projectPath) : null;
  }
  function treeOf(scope) {
    const id = F().scopeId(scope);
    let t = trees.get(id);
    if (!t) {
      t = { cache: {}, open: new Set(), root: '', git: false };
      trees.set(id, t);
      while (trees.size > 12) trees.delete(trees.keys().next().value);
    }
    return t;
  }
  async function listDir(scope, dir) {
    const t = treeOf(scope);
    if (t.cache[dir] === 'loading') return;
    t.cache[dir] = 'loading';
    try {
      const r = await host.getJson('/api/live/files/list', { id: scope.id, root: scope.root, dir });
      t.cache[dir] = (r && r.entries) || [];
      t.root = (r && r.root) || t.root;
      t.git = !!(r && r.git);
    } catch (e) {
      t.cache[dir] = { error: (e && e.message) || 'Could not list this folder' };
    }
    paint();
  }
  // The scope's folder is the open chat's own folder: then the Changes tab's data is the source of the badges.
  function changesFor(scope) {
    const live = CH();
    if (!scope || !live || !live.data || !chat || scope.chatKey !== chat.key || live.chatId() !== chat.id) return null;
    const d = live.data();
    if (!d || !d.git) return null;
    return { map: F().changesMap(d.files || [], d.prefix || ''), prefix: d.prefix || '' };
  }
  function artifactSet(rootDir) {
    const out = new Set();
    const A = AR();
    const st = A && A.state ? A.state() : null;
    if (!st || !rootDir) return out;
    for (const a of st.list || []) {
      const rel = a && a.sourcePath ? F().relTo(a.sourcePath, rootDir) : null;
      if (rel) out.add(rel);
    }
    return out;
  }
  const artifactFor = (rootDir, rel) => {
    const A = AR(),
      st = A && A.state ? A.state() : null;
    return ((st && st.list) || []).find((a) => a && a.sourcePath && F().relTo(a.sourcePath, rootDir) === rel) || null;
  };
  async function runSearch() {
    const scope = currentScope(),
      q = query.trim(),
      mine = ++searchSeq;
    if (!q || !scope) {
      results = null;
      paint();
      return;
    }
    try {
      const r = await host.getJson('/api/live/files/search', { id: scope.id, root: scope.root, q });
      if (mine !== searchSeq) return;
      results = { q, matches: (r && r.matches) || [], total: (r && r.total) || 0 };
    } catch (e) {
      if (mine !== searchSeq) return;
      results = { q, matches: [], total: 0, error: (e && e.message) || 'Search failed' };
    }
    paint();
  }

  // ---- sidebar: the switch and the Files pane ---------------------------------------------------------------------------
  function waitingHere() {
    const w = W();
    return w && w.waitingIn ? w.waitingIn(projectKey()) : 0;
  }
  function setMode(next, focus) {
    mode = next === 'files' ? 'files' : 'chats';
    store.set(MODE_KEY, mode);
    const b = doc().body;
    if (b) b.classList.toggle('sf-files-mode', mode === 'files');
    if (mode === 'files') ensureRoot();
    paint();
    if (focus && els) {
      const target = mode === 'files' ? els.tree.querySelector('.fx-row[tabindex="0"]') || els.filter : els.chatsBtn;
      if (target && target.focus) target.focus();
    }
  }
  function ensureRoot() {
    const scope = currentScope();
    if (!scope || !host) return;
    const t = treeOf(scope);
    if (t.cache[''] === undefined) listDir(scope, '');
  }
  function mount() {
    const d = doc(),
      find = d.getElementById('findChat'),
      list = d.getElementById('connections');
    if (!find || !list || els) return;
    const sw = el('div', null, 'sf-mode');
    sw.setAttribute('role', 'group');
    sw.setAttribute('aria-label', 'Show chats or files');
    const chatsBtn = btn(null, 'sf-mode-chats');
    chatsBtn.append(el('span', 'Chats'));
    const chatsN = el('span', '', 'ws-badge');
    chatsN.hidden = true;
    chatsBtn.append(chatsN);
    const filesBtn = btn(null, 'sf-mode-files');
    filesBtn.append(el('span', 'Files'));
    chatsBtn.title = 'Chats of this project (Ctrl+Shift+E)';
    filesBtn.title = 'Files of this project (Ctrl+Shift+E)';
    chatsBtn.onclick = () => setMode('chats');
    filesBtn.onclick = () => setMode('files');
    sw.append(chatsBtn, filesBtn);
    find.after(sw);
    const pane = el('div', null, 'sf-files');
    pane.id = 'filesPane';
    pane.setAttribute('aria-label', 'Files');
    const scopeRow = el('div', null, 'sf-scoperow');
    const scopeBtn = btn(null, 'fx-scope');
    scopeBtn.setAttribute('aria-haspopup', 'menu');
    scopeBtn.setAttribute('aria-expanded', 'false');
    scopeBtn.onclick = () => openScopeMenu();
    scopeRow.append(scopeBtn);
    const filterRow = el('div', null, 'fx-filter');
    const filter = el('input', null, 'fx-search');
    filter.type = 'search';
    filter.placeholder = 'Filter files';
    filter.setAttribute('aria-label', 'Filter files (Ctrl+Shift+F)');
    filter.autocomplete = 'off';
    let timer = 0;
    filter.addEventListener('input', () => {
      query = filter.value;
      (root.clearTimeout || clearTimeout)(timer);
      timer = (root.setTimeout || setTimeout)(runSearch, 120);
      if (!query.trim()) {
        results = null;
        paint();
      }
    });
    filter.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && filter.value) {
        e.preventDefault();
        e.stopPropagation();
        filter.value = '';
        query = '';
        results = null;
        paint();
      } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
        const first = els.tree.querySelector('.fx-row');
        if (first) {
          e.preventDefault();
          if (e.key === 'Enter') activateRow(first.dataset.path, { keep: false, beside: e.ctrlKey });
          else focusRow(first.dataset.path);
        }
      }
    });
    const changed = btn('Changed', 'fx-toggle', 'Show only changed files');
    changed.setAttribute('aria-pressed', 'false');
    changed.onclick = () => {
      changedOnly = !changedOnly;
      paint();
    };
    filterRow.append(filter, changed);
    const tree = el('div', null, 'fx-tree');
    tree.setAttribute('role', 'tree');
    tree.setAttribute('aria-label', 'Project files');
    tree.addEventListener('keydown', onTreeKey);
    const foot = el('div', null, 'fx-foot');
    const footText = el('span', '', 'fx-foot-t');
    const ignoredBtn = btn('Show ignored', 'fx-foot-link');
    ignoredBtn.onclick = () => {
      showIgnored = !showIgnored;
      paint();
    };
    foot.append(footText, ignoredBtn);
    pane.append(scopeRow, filterRow, tree, foot);
    list.after(pane);
    els = { sw, chatsBtn, chatsN, filesBtn, pane, scopeBtn, filter, changed, tree, footText, ignoredBtn };
    const span = find.querySelector('span');
    if (span) span.textContent = 'Find chat or file…';
    find.setAttribute('aria-label', 'Find chat or file, Ctrl+K');
  }

  // ---- drawing the pane --------------------------------------------------------------------------------------------------
  function rowsNow() {
    const scope = currentScope();
    if (!scope) return { rows: [], scope: null, tree: null, changes: null };
    const t = treeOf(scope),
      ch = changesFor(scope),
      arts = artifactSet(t.root);
    const changes = ch ? ch.map : null;
    let rows;
    if (query.trim() && results) rows = F().flatRows(results.matches.map((m) => m.path), { changes, artifacts: arts });
    else if (changedOnly) rows = F().flatRows(changes ? F().changedPaths(changes) : changedFromListing(t), { changes, artifacts: arts });
    else rows = F().treeRows(t.cache, t.open, { changes, artifacts: arts, showIgnored });
    return { rows, scope, tree: t, changes };
  }
  // Without the Changes data (another chat's copy), the Changed list comes from what the listings already showed.
  function changedFromListing(t) {
    const out = [];
    for (const dir of Object.keys(t.cache)) {
      const list = t.cache[dir];
      if (Array.isArray(list)) for (const e of list) if (!e.dir && e.status) out.push(e.path);
    }
    return out.sort();
  }
  function paintSwitch() {
    if (!els) return;
    const n = waitingHere();
    els.chatsN.hidden = !n;
    els.chatsN.textContent = n > 99 ? '99+' : String(n || '');
    els.chatsBtn.setAttribute('aria-pressed', String(mode === 'chats'));
    els.filesBtn.setAttribute('aria-pressed', String(mode === 'files'));
    els.chatsBtn.setAttribute('aria-label', 'Chats' + (n ? ', ' + n + ' need you' : ''));
  }
  function paint() {
    if (!els) return;
    paintSwitch();
    els.pane.hidden = mode !== 'files';
    if (mode !== 'files') return;
    const { rows, scope, tree, changes } = rowsNow();
    const lab = F().scopeLabel(scope);
    els.scopeBtn.replaceChildren(el('span', lab.lbl, 'lbl'), el('b', lab.name), el('span', '▾', 'fx-caretdown'));
    els.scopeBtn.title =
      (scope ? (scope.branch ? "This chat's own copy on branch " + scope.branch : 'The project folder') : 'No chat open') +
      (tree && tree.root ? '\n' + tree.root : '') +
      '\nChoose which copy of the project to show';
    els.scopeBtn.setAttribute('aria-label', 'Showing files of: ' + lab.lbl + ' ' + lab.name + '. Change');
    const nChanged = changes ? changes.size : tree ? changedFromListing(tree).length : 0;
    els.changed.textContent = 'Changed ' + nChanged;
    els.changed.setAttribute('aria-pressed', String(changedOnly));
    els.ignoredBtn.textContent = showIgnored ? 'Hide ignored' : 'Show ignored';
    els.ignoredBtn.hidden = !!query.trim() || changedOnly;
    const frag = doc().createDocumentFragment();
    if (!scope) frag.append(el('p', 'Open a chat in this project to see its files.', 'fx-empty'));
    else if (query.trim() && !results) frag.append(el('p', 'Searching…', 'fx-empty'));
    else if (query.trim() && results && !rows.length) frag.append(el('p', results.error || 'No file matches.', 'fx-empty'));
    else if (changedOnly && !rows.length) frag.append(el('p', 'Nothing changed here.', 'fx-empty'));
    const files = rows.filter((r) => r.kind === 'file' || r.kind === 'dir');
    if (files.length && !files.some((r) => r.path === sel)) sel = files[0].path;
    for (const r of rows) frag.append(rowNode(r, scope));
    els.tree.replaceChildren(frag);
    const hadFocus = doc().activeElement && els.tree.contains(doc().activeElement);
    if (hadFocus) focusRow(sel);
    const items = rows.filter((r) => r.kind === 'file' || r.kind === 'dir').length;
    els.footText.textContent =
      query.trim() && results
        ? results.total + (results.total === 1 ? ' match' : ' matches') + ' · Enter opens'
        : items + (items === 1 ? ' item' : ' items');
  }
  function rowNode(r, scope) {
    if (r.kind === 'loading' || r.kind === 'error') {
      const n = el('div', r.kind === 'loading' ? 'Loading…' : r.text, 'fx-row fx-note-row');
      n.style.setProperty('--d', String(r.depth));
      return n;
    }
    const n = el('div', null, 'fx-row' + (r.kind === 'dir' ? ' dir' : '') + (r.ignored ? ' ignored' : '') + (r.path === sel ? ' sel' : ''));
    n.dataset.path = r.path;
    n.dataset.kind = r.kind;
    n.setAttribute('role', 'treeitem');
    n.tabIndex = r.path === sel ? 0 : -1;
    n.style.setProperty('--d', String(r.depth));
    if (r.kind === 'dir') n.setAttribute('aria-expanded', String(!!r.open));
    const caret = el('span', r.kind === 'dir' && r.canOpen ? (r.open ? '▾' : '▸') : '', 'fx-caret');
    caret.setAttribute('aria-hidden', 'true');
    n.append(caret, r.kind === 'dir' ? icon(DIR_D, 'fx-ico') : fileIcon(r.name));
    const name = el('span', null, 'fx-name');
    const hit = query.trim() && results ? F().markHit(r.name, query) : null;
    if (hit) name.append(doc().createTextNode(hit[0]), el('mark', hit[1]), doc().createTextNode(hit[2]));
    else name.textContent = r.name;
    n.append(name);
    if (r.folder) n.append(el('span', r.folder, 'fx-dirpath'));
    n.title = r.path + (r.ignored ? '\nIgnored (.gitignore)' : '');
    if (r.ignored) n.append(el('span', 'ignored', 'fx-tag'));
    if (r.kind === 'dir' && r.changed && !r.ignored) n.append(el('span', r.changed + ' changed', 'fx-dirchg'));
    if (r.artifact) {
      const a = btn(null, 'fx-art', 'Open in Artifacts');
      a.append(el('span', '⧉'));
      a.tabIndex = -1;
      a.onclick = (e) => {
        e.stopPropagation();
        openArtifactOf(scope, r.path);
      };
      n.append(a);
    }
    if (r.badge) {
      const b = btn(null, 'fx-chg ' + r.badge.status, 'Show the change: ' + r.badge.text);
      b.tabIndex = -1;
      const parts = r.badge.text.split(' ');
      b.append(el('span', parts[0], 'st'));
      for (const p of parts.slice(1)) b.append(el('span', p, p.charAt(0) === '+' ? 'add' : p === 'bin' ? '' : 'del'));
      b.onclick = (e) => {
        e.stopPropagation();
        showChange(scope, r.path);
      };
      n.append(b);
    }
    n.addEventListener('click', (e) => {
      sel = r.path;
      if (r.kind === 'dir') {
        if (r.canOpen) toggleDir(r.path);
        else focusRow(r.path);
      } else activateRow(r.path, { keep: false, beside: e.ctrlKey || e.metaKey });
    });
    n.addEventListener('dblclick', () => {
      if (r.kind === 'file') activateRow(r.path, { keep: true });
    });
    return n;
  }
  function focusRow(path) {
    if (!els) return;
    const rows = els.tree.querySelectorAll('.fx-row[data-path]');
    for (const n of rows) n.tabIndex = n.dataset.path === path ? 0 : -1;
    const hit = Array.from(rows).find((n) => n.dataset.path === path);
    sel = path;
    if (hit) {
      for (const n of rows) n.classList.toggle('sel', n === hit);
      if (hit.focus) hit.focus();
      if (hit.scrollIntoView) hit.scrollIntoView({ block: 'nearest' });
    }
  }
  function toggleDir(path, force) {
    const scope = currentScope();
    if (!scope) return;
    const t = treeOf(scope);
    const opening = force === undefined ? !t.open.has(path) : !!force;
    if (opening) {
      t.open.add(path);
      if (t.cache[path] === undefined || (t.cache[path] && t.cache[path].error)) listDir(scope, path);
    } else t.open.delete(path);
    paint();
    if (els && els.tree.contains(doc().activeElement)) focusRow(path);
  }
  function onTreeKey(e) {
    const { rows } = rowsNow();
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      const r = rows.find((x) => x.path === sel);
      if (r && r.kind === 'file') activateRow(r.path, { keep: true, beside: true });
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Enter', 'Home', 'End'].includes(e.key)) return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    const m = F().keyMove(rows, sel, e.key);
    if (m.open) toggleDir(m.open, true);
    else if (m.close) toggleDir(m.close, false);
    else if (m.toggle) toggleDir(m.toggle);
    else if (m.activate) activateRow(m.activate, { keep: false });
    if (m.sel) focusRow(m.sel);
  }

  // ---- the scope menu ----------------------------------------------------------------------------------------------------
  let menu = null;
  function closeMenu(refocus) {
    if (!menu) return;
    const back = menu._back;
    menu.remove();
    menu = null;
    if (els) els.scopeBtn.setAttribute('aria-expanded', 'false');
    if (refocus && back && back.focus) back.focus();
  }
  function placeMenu(m, anchor) {
    const r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: 8, bottom: 80 };
    m.style.left = Math.max(8, Math.round(r.left)) + 'px';
    m.style.top = Math.round(r.bottom + 4) + 'px';
  }
  function menuShell(label, anchor) {
    closeMenu(false);
    const m = el('div', null, 'ws-menu fx-menu');
    m.setAttribute('role', 'menu');
    m.setAttribute('aria-label', label);
    m._back = anchor;
    m.addEventListener('keydown', (e) => {
      const items = Array.from(m.querySelectorAll('button:not(:disabled)')),
        at = items.indexOf(doc().activeElement);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        items[(at + 1) % items.length].focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        items[(at - 1 + items.length) % items.length].focus();
      } else if (e.key === 'Escape' || e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        closeMenu(true);
      }
    });
    return m;
  }
  function openScopeMenu() {
    if (menu) return closeMenu(true);
    const scope = currentScope(),
      others = projectChats().filter((c) => !chat || c.key !== chat.key);
    const c = chat && chat.projectKey === projectKey() ? chat : null;
    const model = F().scopeMenu(c, (c && c.projectPath) || (others[0] && others[0].projectPath) || '', others, scope, following);
    const m = menuShell('Show files of', els.scopeBtn);
    m.append(el('div', 'Show files of', 'fx-menu-head'));
    for (const it of model) {
      if (it.kind === 'head') m.append(el('div', it.text, 'fx-menu-head'));
      else if (it.kind === 'sep') {
        const s = el('div', null, 'ws-menu-sep');
        s.setAttribute('role', 'separator');
        m.append(s);
      } else {
        const b = btn(null, 'ws-menu-item fx-menu-it' + (it.on ? ' on' : ''));
        b.setAttribute('role', it.kind === 'follow' ? 'menuitemcheckbox' : 'menuitemradio');
        b.setAttribute('aria-checked', String(!!it.on));
        b.append(el('span', it.on ? '✓' : '', 'fx-check'), el('span', it.text));
        if (it.sub) b.append(el('span', it.sub, 'sub'));
        b.onclick = () => {
          closeMenu(true);
          if (it.kind === 'follow') {
            following = !following;
            pinned = following ? null : currentScopeSnapshot(scope);
          } else {
            following = false;
            pinned = it.scope;
          }
          results = null;
          ensureRoot();
          if (query.trim()) runSearch();
          paint();
        };
        m.append(b);
      }
    }
    doc().body.append(m);
    menu = m;
    els.scopeBtn.setAttribute('aria-expanded', 'true');
    placeMenu(m, els.scopeBtn);
    const first = m.querySelector('.fx-menu-it.on') || m.querySelector('button');
    if (first) first.focus();
  }
  const currentScopeSnapshot = (s) => (s ? Object.assign({}, s) : null);

  // ---- opening files -----------------------------------------------------------------------------------------------------
  // A row in the tree: a tab (preview unless keep), or beside the chat (Ctrl+Enter, Ctrl+click).
  function activateRow(path, o) {
    const scope = currentScope();
    if (!scope) return;
    if (o && o.beside) openFile(scope, path, { keep: true, beside: true });
    else openFile(scope, path, { keep: !!(o && o.keep) });
  }
  function openFile(scope, path, opts) {
    const o = opts || {};
    if (o.beside) {
      beside = F().openTab(beside, scope, path, { keep: true, line: o.line });
      setBeside(true);
      const t = beside.tabs.find((x) => x.id === beside.active);
      if (t && o.line) t.line = o.line;
      drawBeside();
    } else {
      const next = F().openTab(tabsHere(), scope, path, { keep: !!o.keep, line: o.line });
      const t = next.tabs.find((x) => x.id === next.active);
      if (t && o.line) t.line = o.line;
      setTabsHere(next);
      showFile();
    }
    if (W() && W().closeDrawer && !o.keepDrawer) W().closeDrawer();
  }
  function showFile() {
    view = tabsHere().active ? 'file' : 'chat';
    const b = doc().body;
    if (b) b.classList.toggle('sf-file-on', view === 'file');
    drawMain();
    if (W() && W().refresh) W().refresh();
  }
  function showChat() {
    if (view === 'chat') return false;
    view = 'chat';
    const b = doc().body;
    if (b) b.classList.remove('sf-file-on');
    drawMain();
    if (W() && W().refresh) W().refresh();
    return true;
  }
  function activateTab(id) {
    const t = tabsHere();
    if (!t.tabs.some((x) => x.id === id)) return;
    setTabsHere({ tabs: t.tabs, active: id });
    showFile();
  }
  function closeFileTab(id) {
    const r = F().closeTab(tabsHere(), id);
    setTabsHere(r.state);
    reads.delete(id);
    if (!r.next) showChat();
    else showFile();
  }
  function keepTab(id) {
    setTabsHere(F().keepTab(tabsHere(), id));
    drawMain();
    if (W() && W().refresh) W().refresh();
  }
  function setBeside(on) {
    const b = doc().body;
    if (b) b.classList.toggle('sf-beside-on', !!on);
    if (!on) beside = F().emptyTabs();
    if (els && els.beside) els.beside.hidden = !on;
    if (root.ResizeUI && root.ResizeUI.layout) root.ResizeUI.layout();
  }

  // ---- the tab strip (workspace-ui.js asks for these nodes) -----------------------------------------------------------
  const tabTitle = (t) => t.path + (t.scope && t.scope.branch ? '\n⎇ ' + t.scope.branch : '') + (t.preview ? '\nPreview: the next file you open replaces it. Double-click to keep it.' : '');
  function tabNode(t, active, onSelect, onClose, onKeep) {
    const wrap = el('div', null, 'ws-tab sf-ftab' + (t.preview ? ' preview' : '') + (active ? ' on' : ''));
    wrap.dataset.key = 'file:' + t.id;
    const main = btn(null, 'ws-tab-main');
    main.setAttribute('role', 'tab');
    main.setAttribute('aria-selected', String(!!active));
    main.title = tabTitle(t);
    main.append(icon(FILE_D, 'sf-fico'), el('span', t.name, 'ws-tab-title'));
    main.onclick = () => onSelect(t.id);
    main.ondblclick = () => onKeep(t.id);
    const x = btn('×', 'ws-tab-x', 'Close tab: ' + t.name);
    x.onclick = (e) => {
      e.stopPropagation();
      onClose(t.id);
    };
    wrap.addEventListener('auxclick', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        onClose(t.id);
      }
    });
    wrap.append(main, x);
    return wrap;
  }
  // File tabs for the main strip, after the chat tabs.
  function stripNodes() {
    const t = tabsHere();
    if (!t.tabs.length) return [];
    const out = [el('span', null, 'sf-tabsep')];
    for (const tab of t.tabs) out.push(tabNode(tab, view === 'file' && t.active === tab.id, activateTab, closeFileTab, keepTab));
    return out;
  }
  const showingFile = () => view === 'file' && !!tabsHere().active;
  function closeActive() {
    const t = tabsHere();
    if (!t.active) return false;
    closeFileTab(t.active);
    return true;
  }

  // ---- the file view ---------------------------------------------------------------------------------------------------
  function ensureRead(tab, redraw) {
    let r = reads.get(tab.id);
    if (r) return r;
    r = { loading: true, data: null, error: '', mode: 'source', gutter: null };
    reads.set(tab.id, r);
    host
      .getJson('/api/live/files/read', { id: tab.scope.id, root: tab.scope.root, path: tab.path })
      .then(
        (d) => {
          r.data = d;
          r.loading = false;
          loadGutter(tab, r, redraw);
        },
        (e) => {
          r.error = (e && e.message) || 'Could not read this file';
          r.loading = false;
        },
      )
      .then(redraw);
    return r;
  }
  // The changed lines of the file (a bar in the gutter), from the same diff the Changes tab shows.
  function loadGutter(tab, r, redraw) {
    const ch = changesFor(tab.scope),
      f = ch ? ch.map.get(tab.path) : null;
    if (!f) return;
    if (f.status === 'U' || f.status === 'A') {
      r.gutter = 'all';
      return;
    }
    host.getJson('/api/live/changes/file', { id: tab.scope.id, path: ch.prefix + tab.path, scope: 'uncommitted' }).then(
      (d) => {
        const C = root.AgentChangesUI,
          set = new Set();
        for (const h of (d && d.hunks) || [])
          for (const row of C && C.hunkRows ? C.hunkRows(h) : []) if (row.type === 'add' && row.new) set.add(row.new);
        r.gutter = set;
        redraw();
      },
      () => {},
    );
  }
  const kb = (n) => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB');
  function chipFor(tab) {
    const s = tab.scope || {},
      c = projectChats().find((x) => x.key === s.chatKey);
    const chip = el('span', null, 'sf-fv-from');
    chip.append(el('span', s.branch ? '⎇ ' + s.branch : 'Project folder'));
    if (c) chip.append(el('span', '· ' + c.title, 'sf-fv-chat'));
    chip.title = s.branch ? "This file is in a chat's own copy (branch " + s.branch + ')' : 'This file is in the project folder';
    return chip;
  }
  function moreMenu(anchor, abs) {
    if (menu) return closeMenu(true);
    const m = menuShell('More', anchor);
    const add = (label, fn) => {
      const b = btn(label, 'ws-menu-item fx-menu-it');
      b.setAttribute('role', 'menuitem');
      b.onclick = () => {
        closeMenu(true);
        fn();
      };
      m.append(b);
    };
    if (ED() && ED().showInExplorer) add('Show in Explorer', () => ED().showInExplorer(dirAbs(abs)));
    add('Copy path', () => copyText(abs));
    doc().body.append(m);
    menu = m;
    placeMenu(m, anchor);
    const first = m.querySelector('button');
    if (first) first.focus();
  }
  const dirAbs = (abs) => String(abs || '').replace(/[\\/][^\\/]*$/, '');
  function copyText(text) {
    try {
      if (root.navigator && root.navigator.clipboard) root.navigator.clipboard.writeText(String(text));
    } catch (e) {
      /* no clipboard */
    }
  }
  function editorBtn(abs, line, cls) {
    const E = ED(),
      e = E && E.fileEditor ? E.fileEditor() : null;
    const b = btn('Open in ' + (e ? e.name : 'editor') + ' ↗', 'fx-btn ' + (cls || ''));
    b.disabled = !e || !abs;
    b.title = e ? 'Open this file in ' + e.name + (line ? ' at line ' + line : '') : 'No editor found on this PC';
    b.onclick = () => E.openFile(abs, line || 0, dirAbs(abs));
    return b;
  }
  // One file, read only: header (breadcrumb, change badge, which copy and chat), tools, the code or picture, a footer.
  function renderView(box, tab, where) {
    const redraw = () => (where === 'beside' ? drawBeside() : drawMain());
    const r = ensureRead(tab, redraw),
      d = r.data;
    const head = el('div', null, 'sf-fv-head');
    const crumb = el('div', null, 'sf-fv-crumb');
    const proj = (W() && W().currentProjectName && W().currentProjectName()) || '';
    const dirs = F().dirOf(tab.path);
    crumb.append(doc().createTextNode((proj ? proj + ' / ' : '') + (dirs ? dirs.split('/').join(' / ') + ' / ' : '')), el('b', tab.name));
    crumb.title = (d && d.abs) || tab.path;
    head.append(crumb);
    const ch = changesFor(tab.scope),
      badge = ch ? F().badgeOf(ch.map.get(tab.path)) : null;
    if (badge) {
      const b = btn(null, 'fx-chg ' + badge.status, 'Show the change in the Changes tab');
      const parts = badge.text.split(' ');
      b.append(el('span', parts[0], 'st'));
      for (const p of parts.slice(1)) b.append(el('span', p, p.charAt(0) === '+' ? 'add' : 'del'));
      b.onclick = () => showChange(tab.scope, tab.path);
      head.append(b);
    }
    head.append(el('span', null, 'fx-spacer'), chipFor(tab));
    const tools = el('div', null, 'sf-fv-tools');
    const canPage = !!(d && d.page && d.viewUrl);
    if (canPage) {
      const seg = el('div', null, 'fx-seg');
      seg.setAttribute('role', 'group');
      seg.setAttribute('aria-label', 'Show');
      for (const [m, label] of [
        ['source', 'Source'],
        ['page', 'Page'],
      ]) {
        const b = btn(label);
        b.setAttribute('aria-pressed', String(r.mode === m));
        b.title = m === 'page' ? 'The rendered page, view only' : 'The file as text';
        b.onclick = () => {
          r.mode = m;
          redraw();
        };
        seg.append(b);
      }
      tools.append(seg);
    }
    if (tab.preview && where !== 'beside') {
      const k = btn('Keep open', 'fx-btn', 'Keep this tab (a preview tab is replaced by the next file you open)');
      k.onclick = () => keepTab(tab.id);
      tools.append(k);
    }
    const art = d ? artifactFor(treeOf(tab.scope).root || (d && d.root) || '', tab.path) || artifactFor(d.root, tab.path) : null;
    if (art) {
      const a = btn('⧉ Open in Artifacts', 'fx-btn link', 'Open this artifact in the Artifacts viewer');
      a.onclick = () => AR().open(art.id);
      tools.append(a);
    }
    tools.append(el('span', null, 'fx-spacer'));
    tools.append(editorBtn(d && d.abs, tab.line));
    const more = btn('⋯', 'fx-icobtn', 'More: Show in Explorer, Copy path');
    more.setAttribute('aria-haspopup', 'menu');
    more.disabled = !(d && d.abs);
    more.onclick = () => moreMenu(more, d.abs);
    tools.append(more);
    const body = el('div', null, 'sf-fv-body');
    if (r.loading) body.append(el('p', 'Opening…', 'fx-note'));
    else if (r.error) body.append(el('p', r.error, 'fx-note'));
    else if (d.image && d.viewUrl && !(r.mode === 'source' && d.text != null && !canPage)) {
      if (r.mode === 'page' || !canPage || d.text == null) {
        const img = el('img', null, 'sf-fv-img');
        img.src = d.viewUrl;
        img.alt = d.name;
        body.append(img);
      } else body.append(codeView(d.text, tab, r));
    } else if (r.mode === 'page' && canPage) {
      const f = el('iframe', null, 'sf-fv-page');
      f.setAttribute('sandbox', 'allow-scripts allow-popups');
      f.setAttribute('referrerpolicy', 'no-referrer');
      f.title = 'Page view of ' + d.name + ' (view only)';
      f.src = d.viewUrl;
      body.append(f);
    } else if (d.tooBig || d.binary || d.text == null) {
      const note = el('div', null, 'fx-note');
      note.append(
        el('p', d.tooBig ? 'This file is ' + kb(d.size) + ': too big to show here (over 1 MB).' : 'This is a binary file: it cannot be shown as text.'),
        editorBtn(d.abs, 0),
      );
      body.append(note);
    } else body.append(codeView(d.text, tab, r));
    const foot = el('div', null, 'fx-pv-foot');
    if (d) {
      const ext = (/\.([^.]+)$/.exec(d.name) || [])[1] || '';
      foot.append(
        el('span', [ext.toUpperCase() || 'File', d.text != null ? d.lines + (d.lines === 1 ? ' line' : ' lines') : '', kb(d.size)].filter(Boolean).join(' · ')),
      );
      if (badge) foot.append(el('span', badge.status === 'A' ? 'New, not committed' : badge.status === 'D' ? 'Deleted' : 'Changed, not committed'));
    }
    foot.append(el('span', null, 'fx-spacer'), el('span', 'Read-only'));
    box.replaceChildren(head, tools, body, foot);
  }
  function codeView(text, tab, r) {
    const pre = el('div', null, 'fx-code');
    pre.setAttribute('role', 'region');
    pre.setAttribute('aria-label', tab.name + ', read only');
    pre.tabIndex = 0;
    const lang = TV() && TV().langFromPath ? TV().langFromPath(tab.name) : '';
    const lines = String(text).replace(/\r\n/g, '\n').split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    // Highlight the whole text once, then cut the tokens into lines (a token can span lines, like a block comment).
    const toks = TV() && TV().tokenize ? TV().tokenize(lines.join('\n'), lang) : [{ text: lines.join('\n'), cls: '' }];
    let ln = el('div', null, 'fx-ln'),
      n = 1;
    const start = (k) => {
      ln = el('div', null, 'fx-ln' + (gutterHas(r, k) ? ' add' : '') + (tab.line === k ? ' hl' : ''));
      ln.dataset.line = String(k);
      ln.append(el('span', String(k), 'fx-no'));
      ln.append(el('span', null, 'fx-tx'));
      pre.append(ln);
    };
    start(1);
    for (const t of toks) {
      const parts = String(t.text).split('\n');
      parts.forEach((p, i) => {
        if (i > 0) start(++n);
        if (p) ln.lastChild.append(t.cls ? el('span', p, t.cls) : doc().createTextNode(p));
      });
    }
    if (tab.line) {
      const go = () => {
        const hit = pre.querySelector('.fx-ln[data-line="' + tab.line + '"]');
        if (hit && hit.scrollIntoView) hit.scrollIntoView({ block: 'center' });
      };
      (root.setTimeout || setTimeout)(go, 0);
    }
    return pre;
  }
  const gutterHas = (r, k) => (r.gutter === 'all' ? true : !!(r.gutter && r.gutter.has && r.gutter.has(k)));

  function mainBox() {
    const d = doc();
    let box = d.getElementById('fileView');
    if (!box) {
      const strip = d.getElementById('chatTabs');
      if (!strip) return null;
      box = el('section', null, 'sf-fileview');
      box.id = 'fileView';
      box.setAttribute('aria-label', 'File');
      box.hidden = true;
      strip.after(box);
    }
    return box;
  }
  function drawMain() {
    const box = mainBox();
    if (!box) return;
    const t = tabsHere(),
      tab = view === 'file' ? t.tabs.find((x) => x.id === t.active) : null;
    box.hidden = !tab;
    if (!tab) {
      box.replaceChildren();
      const b = doc().body;
      if (b) b.classList.remove('sf-file-on');
      view = 'chat';
      return;
    }
    renderView(box, tab, 'main');
  }
  // Beside the chat: its own small tab strip and a file view, at the right of the chat.
  function besideBox() {
    const d = doc();
    let box = d.getElementById('fileBeside');
    if (!box) {
      const main = d.querySelector('main');
      if (!main) return null;
      box = el('section', null, 'sf-beside');
      box.id = 'fileBeside';
      box.setAttribute('aria-label', 'File beside the chat');
      box.hidden = true;
      const strip = el('div', null, 'ws-tabs sf-beside-strip');
      const view_ = el('div', null, 'sf-fileview');
      box.append(strip, view_);
      main.append(box);
      if (els) els.beside = box;
    }
    return box;
  }
  function drawBeside() {
    const box = besideBox();
    if (!box) return;
    const tab = beside.tabs.find((x) => x.id === beside.active);
    box.hidden = !tab;
    if (!tab) {
      setBeside(false);
      return;
    }
    const strip = box.children[0],
      v = box.children[1];
    const list = el('div', null, 'ws-tablist');
    list.setAttribute('role', 'tablist');
    list.setAttribute('aria-label', 'Files beside the chat');
    for (const t of beside.tabs)
      list.append(
        tabNode(
          t,
          t.id === beside.active,
          (id) => {
            beside = { tabs: beside.tabs, active: id };
            drawBeside();
          },
          (id) => {
            const r = F().closeTab(beside, id);
            beside = r.state;
            reads.delete(id);
            drawBeside();
          },
          () => {},
        ),
      );
    const close = btn('×', 'ws-tab-new sf-beside-close', 'Close the files beside the chat');
    close.onclick = () => {
      beside = F().emptyTabs();
      drawBeside();
    };
    strip.replaceChildren(list, el('span', null, 'ws-spacer'), close);
    renderView(v, tab, 'beside');
  }

  function showChange(scope, rel) {
    const ch = changesFor(scope);
    const go = () => {
      const live = CH(),
        c2 = changesFor(scope);
      if (live) live.focusFile((c2 ? c2.prefix : '') + rel);
    };
    if (ch) return go();
    // Another chat's copy: open that chat, then its Changes tab.
    const c = (host.conversations() || []).find((x) => host.aliasKey(x) === scope.chatKey);
    if (c) Promise.resolve(host.open(c)).then(() => (root.setTimeout || setTimeout)(go, 400));
  }
  function openArtifactOf(scope, rel) {
    const t = treeOf(scope),
      a = artifactFor(t.root, rel);
    if (a && AR()) AR().open(a.id);
  }

  // ---- paths in replies ----------------------------------------------------------------------------------------------------
  // A path that names an existing file inside the chat's folder becomes a link (file icon, code font) that opens it; anything
  // missing or outside stays plain text. The same file twice in one paragraph is linked once. Never registers an artifact.
  const exists = new Map(); // scope id + dir -> {at, names: Set|null, promise}
  function dirNames(scope, dir) {
    const k = F().scopeId(scope) + '|' + dir,
      hit = exists.get(k);
    if (hit && Date.now() - hit.at < 20000) return hit.promise;
    const rec = { at: Date.now(), promise: null };
    rec.promise = host.getJson('/api/live/files/list', { id: scope.id, root: scope.root, dir }).then(
      (r) => {
        const names = new Map();
        for (const e of (r && r.entries) || []) names.set(e.name.toLowerCase(), e);
        return { names, root: (r && r.root) || '' };
      },
      () => ({ names: new Map(), root: '' }),
    );
    exists.set(k, rec);
    while (exists.size > 300) exists.delete(exists.keys().next().value);
    return rec.promise;
  }
  const BLOCKS = 'p,li,td,th,blockquote,h1,h2,h3,h4,h5,h6,dd,dt';
  function textNodes(container) {
    const D = doc(),
      out = [];
    if (!D.createTreeWalker) return out;
    const w = D.createTreeWalker(container, 4);
    let n;
    while ((n = w.nextNode())) {
      if (!n.nodeValue || n.nodeValue.length < 3) continue;
      const p = n.parentElement;
      if (!p || (p.closest && p.closest('a,pre,button,.fx-path'))) continue;
      out.push(n);
    }
    return out;
  }
  function linkPaths(container, ctx) {
    const c = ctx || chat;
    if (!container || !c || !c.id || !host) return Promise.resolve(0);
    const scope = F().followScope(c, c.projectPath),
      folder = c.cwd || c.projectPath;
    if (!scope || !folder) return Promise.resolve(0);
    const nodes = textNodes(container);
    const seenIn = new Map(); // paragraph -> Set of rel paths already linked
    const jobs = [];
    for (const t of nodes) {
      const block = (t.parentElement.closest && t.parentElement.closest(BLOCKS)) || container;
      if (!seenIn.has(block)) seenIn.set(block, new Set());
      const seen = seenIn.get(block);
      const cands = F()
        .dedupe(F().pathCandidates(t.nodeValue), folder)
        .filter((x) => !seen.has(x.rel.toLowerCase()));
      for (const x of cands) seen.add(x.rel.toLowerCase());
      if (!cands.length) continue;
      jobs.push(
        Promise.all(cands.map((x) => dirNames(scope, F().dirOf(x.rel)).then((d) => ({ x, e: d.names.get(F().nameOf(x.rel).toLowerCase()), root: d.root })))).then(
          (found) => {
            const ok = found.filter((f) => f.e && !f.e.dir);
            if (!ok.length || !t.parentNode) return 0;
            const frag = doc().createDocumentFragment(),
              s = t.nodeValue;
            let pos = 0;
            for (const f of ok.sort((a, b) => a.x.at - b.x.at)) {
              if (f.x.at < pos) continue;
              if (f.x.at > pos) frag.append(doc().createTextNode(s.slice(pos, f.x.at)));
              frag.append(pathLink(f.x.text, f.x.rel, f.x.line, scope, f.root, t.parentElement));
              pos = f.x.at + f.x.len;
            }
            if (pos < s.length) frag.append(doc().createTextNode(s.slice(pos)));
            const p = t.parentElement;
            // `path` alone in inline code: the link wraps the code element
            if (p && p.tagName === 'CODE' && ok.length === 1 && s.trim() === ok[0].x.text && p.parentNode) {
              const a = frag.querySelector ? frag.querySelector('a.fx-path') : null;
              if (a) {
                a.lastChild.remove();
                p.replaceWith(a);
                a.append(p);
                return 1;
              }
            }
            t.replaceWith(frag);
            return ok.length;
          },
        ),
      );
    }
    return Promise.all(jobs).then((n) => n.reduce((a, b) => a + b, 0));
  }
  function pathLink(text, rel, line, scope, rootDir, parent) {
    const a = el('a', null, 'fx-path');
    a.href = '#';
    a.dataset.filePath = rel;
    if (line) a.dataset.line = String(line);
    a.dataset.scope = JSON.stringify(scope);
    a.dataset.abs = rootDir ? rootDir.replace(/[\\/]+$/, '') + (rootDir.includes('\\') ? '\\' : '/') + rel.split('/').join(rootDir.includes('\\') ? '\\' : '/') : '';
    a.title = rel + (line ? ':' + line : '') + '\nClick: open the file. Ctrl+click: open in your editor. Right-click: more';
    a.append(icon(FILE_D, 'fx-pico'));
    if (!(parent && parent.tagName === 'CODE')) a.append(el('code', text, 'fx-ptext'));
    else a.append(doc().createTextNode(text));
    return a;
  }
  function scopeOfLink(a) {
    try {
      return JSON.parse(a.dataset.scope || 'null');
    } catch (e) {
      return null;
    }
  }
  function openLink(a, how) {
    const scope = scopeOfLink(a),
      rel = a.dataset.filePath,
      line = Number(a.dataset.line) || 0;
    if (!scope || !rel) return;
    if (how === 'editor') {
      if (ED() && a.dataset.abs) ED().openFile(a.dataset.abs, line, dirAbs(a.dataset.abs));
      return;
    }
    const wide = F().opensBeside(root.innerWidth || 0);
    if (how === 'beside' || (how !== 'tab' && wide)) openFile(scope, rel, { keep: true, beside: true, line, keepDrawer: true });
    else openFile(scope, rel, { keep: true, line });
  }
  function linkMenu(a, x, y) {
    if (menu) closeMenu(false);
    const m = menuShell('File', a);
    const add = (label, fn) => {
      const b = btn(label, 'ws-menu-item fx-menu-it');
      b.setAttribute('role', 'menuitem');
      b.onclick = () => {
        closeMenu(false);
        fn();
      };
      m.append(b);
    };
    add('Open to the side', () => openLink(a, 'beside'));
    add('Show in Files', () => showInFiles(scopeOfLink(a), a.dataset.filePath));
    add('Copy path', () => copyText(a.dataset.abs || a.dataset.filePath));
    if (ED() && ED().showInExplorer && a.dataset.abs) add('Show in Explorer', () => ED().showInExplorer(dirAbs(a.dataset.abs)));
    doc().body.append(m);
    menu = m;
    m.style.left = Math.max(8, Math.round(x)) + 'px';
    m.style.top = Math.max(8, Math.round(y)) + 'px';
    const first = m.querySelector('button');
    if (first) first.focus();
  }
  // "Show in Files": the sidebar switches to Files, the file's folders open and the row is selected (asked for, never automatic).
  function showInFiles(scope, rel) {
    if (!scope || !rel) return;
    following = true;
    const cur = currentScope();
    if (F().scopeId(cur) !== F().scopeId(scope)) {
      following = false;
      pinned = scope;
    }
    query = '';
    results = null;
    changedOnly = false;
    if (els) els.filter.value = '';
    const t = treeOf(scope);
    const parts = rel.split('/');
    let dir = '';
    if (t.cache[''] === undefined) listDir(scope, '');
    for (const p of parts.slice(0, -1)) {
      dir = dir ? dir + '/' + p : p;
      t.open.add(dir);
      if (t.cache[dir] === undefined) listDir(scope, dir);
    }
    sel = rel;
    setMode('files');
    if (W() && W().openDrawer) W().openDrawer();
    (root.setTimeout || setTimeout)(() => focusRow(rel), 50);
  }

  // ---- hooks ---------------------------------------------------------------------------------------------------------------
  // chat.js calls this whenever the header is drawn (the open chat changed, or its state).
  let lastChatKey = '',
    lastChangeSig = '';
  function sync(selected) {
    if (!host) return;
    const info = selected ? chatInfo(selected) : null;
    const changedChat = (info ? info.key : '') !== lastChatKey;
    chat = info;
    lastChatKey = info ? info.key : '';
    if (changedChat && following) {
      results = null;
      if (query.trim()) runSearch();
    }
    // A file the agent wrote shows up: when the Changes data moves on, the open folders are listed again.
    const live = CH(),
      dd = live && live.data ? live.data() : null;
    const sig = dd && dd.files ? dd.files.map((f) => f.path + ':' + f.added + ':' + f.removed).join('|') : '';
    if (sig !== lastChangeSig) {
      lastChangeSig = sig;
      const scope = currentScope();
      if (scope && !changedChat) {
        const t = treeOf(scope);
        for (const dir of Object.keys(t.cache)) if (dir === '' || t.open.has(dir)) listDir(scope, dir);
        exists.clear();
      }
    }
    if (mode === 'files') ensureRoot();
    paint();
  }
  function onKey(e) {
    if (!host || e.altKey || e.metaKey || !e.ctrlKey || !e.shiftKey) return;
    const k = String(e.key || '').toLowerCase();
    if (doc().querySelector && doc().querySelector('dialog[open]')) return;
    if (k === 'e') {
      e.preventDefault();
      e.stopPropagation();
      setMode(mode === 'files' ? 'chats' : 'files', true);
      if (mode === 'files' && W() && W().openDrawer) W().openDrawer();
    } else if (k === 'f') {
      e.preventDefault();
      e.stopPropagation();
      if (mode !== 'files') setMode('files');
      if (W() && W().openDrawer) W().openDrawer();
      if (els && els.filter.focus) {
        els.filter.focus();
        if (els.filter.select) els.filter.select();
      }
    }
  }
  function init(h) {
    host = h;
    loadTabs();
    mount();
    mode = store.get(MODE_KEY, 'chats') === 'files' ? 'files' : 'chats';
    const d = doc();
    if (d.body) d.body.classList.toggle('sf-files-mode', mode === 'files');
    besideBox();
    d.addEventListener('keydown', onKey, true);
    d.addEventListener('pointerdown', (e) => {
      if (menu && !(e.target && e.target.closest && (e.target.closest('.fx-menu') || e.target === menu._back))) closeMenu(false);
    });
    d.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && menu) {
        e.preventDefault();
        e.stopPropagation();
        closeMenu(true);
      }
    }, true);
    // Links to files in replies: click opens, Ctrl+click opens the editor, right-click offers more.
    d.addEventListener('click', (e) => {
      const a = e.target && e.target.closest ? e.target.closest('a.fx-path') : null;
      if (!a) return;
      e.preventDefault();
      openLink(a, e.ctrlKey || e.metaKey ? 'editor' : '');
    });
    d.addEventListener('contextmenu', (e) => {
      const a = e.target && e.target.closest ? e.target.closest('a.fx-path') : null;
      if (!a) return;
      e.preventDefault();
      linkMenu(a, e.clientX, e.clientY);
    });
    paint();
  }

  const api = {
    init,
    sync,
    paint,
    setMode,
    mode: () => mode,
    stripNodes,
    showingFile,
    showChat,
    closeActive,
    linkPaths,
    openFile,
    showInFiles,
    openLink,
    currentScope,
    search: (q) => {
      const scope = currentScope();
      return scope && q
        ? host.getJson('/api/live/files/search', { id: scope.id, root: scope.root, q }).then((r) => ({ scope, matches: (r && r.matches) || [] }))
        : Promise.resolve({ scope, matches: [] });
    },
    _state: () => ({ mode, chat, following, pinned, query, changedOnly, showIgnored, sel, results, view, tabs: tabsHere(), beside, trees }),
    _reset: () => {
      trees.clear();
      reads.clear();
      exists.clear();
      tabsByProject = {};
      beside = F().emptyTabs();
      view = 'chat';
      following = true;
      pinned = null;
      query = '';
      changedOnly = false;
      showIgnored = false;
      results = null;
      sel = '';
      els = null;
      host = null;
      menu = null;
    },
  };
  root.AgentFilesUI = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
