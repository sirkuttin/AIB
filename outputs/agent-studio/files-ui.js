(function (root) {
  'use strict';
  // The project's files, in the left sidebar (direction A of the "project files" design).
  //  - A Chats | Files switch under Find (Ctrl+Shift+E). The Chats half carries the amber count of this project's chats that
  //    need you.
  //  - Files mode: the scope button (which copy of the project: follows the open chat by default), a filter (Ctrl+Shift+F) and a
  //    "Changed n" toggle, a lazy tree (one folder at a time; .git never, ignored entries as one dimmed row; aib-docs always first,
  //    with the doc icon and "3 docs"), change badges from the chat's Changes data (a click opens that file's diff), "n changed"
  //    on folders, ⧉ on files that are artifacts.
  //  - Files and docs open as tabs in the chat tab strip (a single click opens an italic preview tab that the next click
  //    replaces) and show in the middle. From a reply, at 1280 px and wider, a file opens beside the chat instead (a pane with a
  //    draggable divider); a doc from a chat opens in the right column's Artifacts viewer (artifacts-ui.js).
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
  // A doc: the docs' own icon (doc-icons.js) when the page has it, else a page with lines; in the accent colour.
  const DOC_D = 'M3.5 1.5h6l3 3v10h-9zM5.5 7h5M5.5 9.5h5M5.5 12h3';
  const docIcon = (cls) => {
    const I = root.AIBDocIcons;
    try {
      if (I && I.icon) return I.icon('doc', cls);
    } catch (e) {
      /* fall back */
    }
    return icon(DOC_D, cls);
  };
  const DL = () => root.AgentDocLinks;

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
  // "What's new in AIB <version>" tabs (updates-ui.js, once after an update): tab id -> {version, releases}. Not saved: the notes
  // come from the server once, so the tab is gone after a reload.
  const notesData = new Map();
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
      if (t && t.tabs.length) out[pk] = { tabs: t.tabs.filter((x) => !x.preview && x.kind !== 'notes').slice(0, 40), active: '' };
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
  const projectPathNow = () => (W() && W().currentProjectPath ? W().currentProjectPath() : '');
  function currentScope() {
    if (!following && pinned) return pinned;
    const c = chat && chat.projectKey === projectKey() ? chat : null;
    if (c) return F().followScope(c, c.projectPath);
    const any = projectChats()[0];
    if (any) return F().followScope(Object.assign({}, any, { branch: '' }), any.projectPath);
    // No chat in this project: its own folder (the server shows only folders the user added).
    return F().projectScope(projectPathNow());
  }
  // Open folders are remembered per project and per tree: the chat's own copy is one tree (its chat id), the main folder another.
  const OPEN_KEY = 'aib-files-open-v1',
    OPEN_CAP = 200;
  function openKey(scope) {
    return projectKey() + '\n' + (scope.root === 'main' ? 'main' : F().scopeId(scope));
  }
  function readOpen() {
    try {
      const raw = JSON.parse(store.get(OPEN_KEY, '{}'));
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    } catch (e) {
      return {};
    }
  }
  class OpenSet extends Set {
    constructor(key) {
      super();
      this.key = key;
      const saved = readOpen()[key];
      if (Array.isArray(saved)) for (const p of saved.slice(-OPEN_CAP)) if (typeof p === 'string' && p) super.add(p);
      this.ready = true;
    }
    save() {
      if (!this.ready) return;
      const all = readOpen();
      if (this.size) all[this.key] = [...this];
      else delete all[this.key];
      store.set(OPEN_KEY, JSON.stringify(all));
    }
    add(p) {
      const had = super.has(p);
      super.add(p);
      while (this.size > OPEN_CAP) super.delete(this.values().next().value);
      if (!had) this.save();
      return this;
    }
    delete(p) {
      const r = super.delete(p);
      if (r) this.save();
      return r;
    }
  }
  function treeOf(scope) {
    const id = F().scopeId(scope);
    let t = trees.get(id);
    if (!t) {
      const key = openKey(scope);
      t = { cache: {}, open: new OpenSet(key), root: '', git: false, restored: new Set() };
      for (const p of t.open) t.restored.add(p);
      trees.set(id, t);
      while (trees.size > 12) trees.delete(trees.keys().next().value);
    }
    return t;
  }
  // The docs of the scope's folder (doc-links.js keeps the lists): one row each, their files hidden. Asked again whenever the top
  // folder or docs/ is listed again.
  function docsOf(scope) {
    const D = DL();
    if (!D || !scope || scope.root === 'outside' || scope.root === 'project') return null;
    const now = D.cached(scope.id, scope.root);
    if (!now) loadDocs(scope, false);
    if (!now || scope.root !== 'chat') return now;
    // A worktree chat's copy: its doc rows are the main checkout's docs (where the doc lives and opens): their names and pages.
    const main = D.cached(scope.id, 'main');
    if (!main) {
      loadDocs(Object.assign({}, scope, { root: 'main' }), false);
      return now;
    }
    return now.map((d) => {
      const m = main.find((x) => x.name === d.name);
      return m ? Object.assign({}, d, { title: m.title, pages: m.pages, pageList: m.pageList, chat: m.chat }) : d;
    });
  }
  function loadDocs(scope, force) {
    const D = DL();
    if (!D || !scope || scope.root === 'outside' || scope.root === 'project') return Promise.resolve([]);
    return D.listFor(scope.id, scope.root, force).then((docs) => {
      paint();
      return docs;
    });
  }
  const docIndexOf = (scope) => {
    const docs = docsOf(scope);
    return docs ? F().docIndex(docs) : null;
  };
  async function listDir(scope, dir) {
    const t = treeOf(scope);
    if (t.cache[dir] === 'loading') return;
    t.cache[dir] = 'loading';
    if (dir === '' || dir === F().DOCS_FOLDER) loadDocs(scope, true);
    try {
      const r = await host.getJson('/api/live/files/list', Object.assign(F().scopeArgs(scope), { dir }));
      t.cache[dir] = (r && r.entries) || [];
      t.root = (r && r.root) || t.root;
      t.git = !!(r && r.git);
      t.restored.delete(dir);
      if (dir === '')
        for (const p of t.open) if (t.restored.has(p) && t.cache[p] === undefined) listDir(scope, p);
    } catch (e) {
      // A remembered folder that is gone is dropped without a word.
      if (dir !== '' && t.restored.has(dir)) {
        t.restored.delete(dir);
        delete t.cache[dir];
        t.open.delete(dir);
      } else t.cache[dir] = { error: (e && e.message) || 'Could not list this folder' };
    }
    paint();
  }
  // The scope's folder is the open chat's own folder: then the Changes tab's data is the source of the badges.
  function changesFor(scope) {
    const live = CH();
    if (!scope || scope.root === 'outside' || !live || !live.data || !chat || scope.chatKey !== chat.key || live.chatId() !== chat.id) return null;
    const d = live.data();
    if (!d || !d.git) return null;
    return { map: F().changesMap(d.files || [], d.prefix || ''), prefix: d.prefix || '' };
  }
  // Files is a project view: a file is an artifact when ANY chat of the project registered it. The Artifacts viewer only lists the
  // open chat's artifacts (GET /api/live/artifacts is per chat), so the other chats' lists are fetched here too, at most every 30 s.
  const ART_TTL = 30000;
  const projectArts = new Map(); // chat id -> {at, list, loading}
  function loadProjectArtifacts(force) {
    if (!host) return;
    const now = Date.now();
    for (const c of projectChats().slice(0, 40)) {
      const id = c.key; // artifacts are kept under the chat's lasting key (provider:sessionId)
      const rec = projectArts.get(id);
      if (rec && (rec.loading || (!force && now - rec.at < ART_TTL))) continue;
      const next = { at: now, list: rec ? rec.list : [], loading: true };
      projectArts.set(id, next);
      Promise.resolve(host.getJson('/api/live/artifacts', { conversationId: id })).then(
        (r) => {
          next.list = (r && Array.isArray(r.artifacts) ? r.artifacts : []).map((a) => Object.assign({}, a, { ownerKey: c.key }));
          next.loading = false;
          next.at = Date.now();
          paint();
          if (view === 'file') drawMain();
          if (beside.active) drawBeside();
        },
        () => {
          next.loading = false;
        },
      );
    }
  }
  function projectArtifactList() {
    const A = AR(),
      st = A && A.state ? A.state() : null,
      seen = new Set(),
      out = [];
    for (const a of ((st && st.list) || []).concat(...Array.from(projectArts.values()).map((r) => r.list)))
      if (a && a.id && !seen.has(a.id)) {
        seen.add(a.id);
        out.push(a);
      }
    return out;
  }
  function artifactSet(rootDir) {
    const out = new Set();
    if (!rootDir) return out;
    for (const a of projectArtifactList()) {
      const rel = a.sourcePath ? F().relTo(a.sourcePath, rootDir) : null;
      if (rel) out.add(rel);
    }
    return out;
  }
  const artifactFor = (rootDir, rel) =>
    (rootDir && projectArtifactList().find((a) => a.sourcePath && F().relTo(a.sourcePath, rootDir) === rel)) || null;
  // "Open in Artifacts": an artifact of any chat opens in the right column's Artifacts tab, beside whatever is in the middle (the
  // viewer shows another chat's artifact by id, so a file tab stays open and you keep your place). A page file no chat registered yet
  // is registered first, which is the deliberate action, in the chat that can hold it: the chat whose copy the file is in, else the
  // open chat, else any chat of the project working in that folder (the server only takes files inside the chat's own folder).
  // say(msg): where a failure is shown; it is never silent.
  function artChatFor(scope, abs) {
    if (!abs || !scope || scope.root === 'outside') return null;
    const all = projectChats(),
      own = all.find((c) => c.key === scope.chatKey),
      inside = (c) => !!(c && c.id && c.cwd && F().relTo(abs, c.cwd));
    return (scope.root === 'chat' ? [own, chat] : [chat, own]).concat(all).find(inside) || null;
  }
  function openInArtifacts(art, abs, target, say) {
    const A = AR(),
      fail = (m) => {
        if (say) say(m);
        else if (host && host.notice) host.notice(m);
        return false;
      };
    const shown = (ok) => ok || fail('Could not open in Artifacts: the Artifacts viewer could not show it.');
    const failed = (e) => fail('Could not open in Artifacts: ' + ((e && e.message) || 'request failed'));
    if (!A || !A.open) return Promise.resolve(fail('Could not open in Artifacts: the Artifacts viewer is not loaded.'));
    if (art) return Promise.resolve(A.open(art.id)).then(shown, failed);
    if (!A.registerFile || !abs) return Promise.resolve(fail('Could not open in Artifacts: this file has no path.'));
    if (!target) return Promise.resolve(fail('Could not open in Artifacts: no chat works in this folder.'));
    return Promise.resolve(A.registerFile(abs, target.id)).then((s) => {
      projectArts.delete(target.key);
      loadProjectArtifacts(true);
      paint();
      return s ? true : fail('Could not open in Artifacts: AIB did not add it.');
    }, failed);
  }
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
      const r = await host.getJson('/api/live/files/search', Object.assign(F().scopeArgs(scope), { q }));
      if (mine !== searchSeq) return;
      const all = (r && r.matches) || [],
        matches = withoutDocFiles(scope, all);
      results = { q, matches, total: Math.max(0, ((r && r.total) || 0) - (all.length - matches.length)) };
    } catch (e) {
      if (mine !== searchSeq) return;
      results = { q, matches: [], total: 0, error: (e && e.message) || 'Search failed' };
    }
    paint();
  }

  // A search's hits without the files a doc owns (the doc itself is found by its title: docHits).
  function withoutDocFiles(scope, matches) {
    const idx = docIndexOf(scope);
    return idx ? matches.filter((m) => !idx.owned.has(F().slash(m.path))) : matches;
  }
  function docHits(scope, q) {
    const docs = docsOf(scope),
      D = DL();
    if (!docs || !D) return [];
    return docs.filter((d) => D.looseScore(d.title, q) >= 40 || D.looseScore(d.name, q) >= 40);
  }

  // ---- sidebar: the switch and the Files pane ---------------------------------------------------------------------------
  function waitingHere() {
    const w = W();
    return w && w.waitingIn ? w.waitingIn(projectKey()) : 0;
  }
  // The sidebar shows Chats or Files. A "docs" value saved while beta.8 had a Docs tab opens Files (the docs live there now).
  const asMode = (m) => (m === 'files' || m === 'docs' ? 'files' : 'chats');
  function applyMode(next) {
    mode = asMode(next);
    const b = doc().body;
    if (b) b.classList.toggle('sf-files-mode', mode === 'files');
    if (mode === 'files') {
      ensureRoot();
      pollDocs();
    }
  }
  function setMode(next, focus) {
    applyMode(next);
    store.set(MODE_KEY, mode);
    paint();
    if (focus && els) {
      const target = mode === 'files' ? els.tree.querySelector('.fx-row[tabindex="0"]') || els.filter : els.chatsBtn;
      if (target && target.focus) target.focus();
    }
  }
  // While Files shows an open aib-docs folder, the docs are asked again every few seconds: the live dot on a doc row comes and goes
  // with the agents writing it.
  let docsTimer = null;
  function pollDocs() {
    if (docsTimer || !host) return;
    const tick = () => {
      docsTimer = null;
      if (mode !== 'files') return;
      const scope = currentScope(),
        hidden = doc().hidden;
      if (scope && !hidden && treeOf(scope).open.has(F().DOCS_FOLDER)) loadDocs(scope, true);
      docsTimer = (root.setTimeout || setTimeout)(tick, DOCS_POLL_MS);
      if (docsTimer && docsTimer.unref) docsTimer.unref(); // never keeps a test process alive
    };
    docsTimer = (root.setTimeout || setTimeout)(tick, DOCS_POLL_MS);
    if (docsTimer && docsTimer.unref) docsTimer.unref();
  }
  const DOCS_POLL_MS = 3000;
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
      arts = artifactSet(t.root),
      docs = docIndexOf(scope);
    const changes = ch ? ch.map : null;
    let rows;
    if (query.trim() && results) {
      rows = F().flatRows(results.matches.map((m) => m.path), { changes, artifacts: arts, docs });
      const hits = docHits(scope, query.trim())
        .map((d) => F().flatRows([F().slash(d.dir) + '/doc.aibdoc'], { changes, docs })[0])
        .filter((r) => r && r.kind === 'doc');
      rows = hits.concat(rows.filter((r) => !hits.some((h) => h.path === r.path)));
    } else if (changedOnly)
      rows = F().flatRows(changes ? F().changedPaths(changes) : changedFromListing(t), { changes, artifacts: arts, docs });
    else rows = F().treeRows(t.cache, t.open, { changes, artifacts: arts, showIgnored, docs, newDoc: !!DL() && scope.root !== 'outside' && scope.root !== 'project' });
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
    loadProjectArtifacts(false);
    const { rows, scope, tree, changes } = rowsNow();
    // a copy is named after its chat; the name is read fresh so a renamed chat shows its new name
    const live = scope && scope.branch ? projectChats().find((c) => c.key === scope.chatKey) : null;
    const lab = F().scopeLabel(live ? Object.assign({}, scope, { title: live.title }) : scope);
    els.scopeBtn.replaceChildren(el('span', lab.lbl, 'lbl'), el('b', lab.name), el('span', '▾', 'fx-caretdown'));
    els.scopeBtn.title =
      (scope ? (scope.branch ? "This chat's own copy on branch " + scope.branch : 'The project folder') : 'No project folder') +
      (tree && tree.root ? '\n' + tree.root : '') +
      '\nChoose which copy of the project to show';
    els.scopeBtn.setAttribute('aria-label', 'Showing files of: ' + lab.lbl + ' ' + lab.name + '. Change');
    const nChanged = changes ? changes.size : tree ? changedFromListing(tree).length : 0;
    els.changed.textContent = 'Changed ' + nChanged;
    els.changed.setAttribute('aria-pressed', String(changedOnly));
    els.ignoredBtn.textContent = showIgnored ? 'Hide ignored' : 'Show ignored';
    els.ignoredBtn.hidden = !!query.trim() || changedOnly;
    const frag = doc().createDocumentFragment();
    if (!scope) frag.append(el('p', 'This project has no folder to show.', 'fx-empty'));
    else if (query.trim() && !results) frag.append(el('p', 'Searching…', 'fx-empty'));
    else if (query.trim() && results && !rows.length) frag.append(el('p', results.error || 'No file matches.', 'fx-empty'));
    else if (changedOnly && !rows.length) frag.append(el('p', 'Nothing changed here.', 'fx-empty'));
    const files = rows.filter((r) => r.kind === 'file' || r.kind === 'dir' || r.kind === 'doc' || r.kind === 'newdoc');
    if (files.length && !files.some((r) => r.path === sel)) sel = files[0].path;
    for (const r of rows) frag.append(rowNode(r, scope));
    els.tree.replaceChildren(frag);
    const hadFocus = doc().activeElement && els.tree.contains(doc().activeElement);
    if (hadFocus) focusRow(sel);
    const items = rows.filter((r) => r.kind === 'file' || r.kind === 'dir' || r.kind === 'doc').length;
    els.footText.textContent =
      query.trim() && results
        ? results.total + (results.total === 1 ? ' match' : ' matches') + ' · Enter opens'
        : items + (items === 1 ? ' item' : ' items');
  }
  function rowNode(r, scope) {
    if (r.kind === 'doc') return docRowNode(r, scope);
    if (r.kind === 'newdoc') return newDocNode(r, scope);
    if (r.kind === 'loading' || r.kind === 'error') {
      const n = el('div', r.kind === 'loading' ? 'Loading…' : r.text, 'fx-row fx-note-row');
      n.style.setProperty('--d', String(r.depth));
      return n;
    }
    const n = el('div', null, 'fx-row' + (r.kind === 'dir' ? ' dir' : '') + (r.docsFolder ? ' fx-docsdir' : '') + (r.ignored ? ' ignored' : '') + (r.path === sel ? ' sel' : ''));
    n.dataset.path = r.path;
    n.dataset.kind = r.kind;
    n.setAttribute('role', 'treeitem');
    n.tabIndex = r.path === sel ? 0 : -1;
    n.style.setProperty('--d', String(r.depth));
    if (r.kind === 'dir') n.setAttribute('aria-expanded', String(!!r.open));
    const caret = el('span', r.kind === 'dir' && r.canOpen ? (r.open ? '▾' : '▸') : '', 'fx-caret');
    caret.setAttribute('aria-hidden', 'true');
    // aib-docs: the docs' own accent icon instead of the folder outline
    n.append(caret, r.docsFolder ? docIcon('fx-ico fx-docico') : r.kind === 'dir' ? icon(DIR_D, 'fx-ico') : fileIcon(r.name));
    const name = el('span', null, 'fx-name');
    const hit = query.trim() && results ? F().markHit(r.name, query) : null;
    if (hit) name.append(doc().createTextNode(hit[0]), el('mark', hit[1]), doc().createTextNode(hit[2]));
    else name.textContent = r.name;
    n.append(name);
    if (r.folder) n.append(el('span', r.folder, 'fx-dirpath'));
    n.title = r.path + (r.ignored ? '\nIgnored by git' : '');
    if (r.ignored) n.append(el('span', 'ignored', 'fx-tag'));
    if (r.docsFolder && (r.docCount || r.changed)) {
      // "3 docs · 1 changed": the doc count muted, the changed part in the usual colour
      const c = el('span', null, 'fx-docscount');
      if (r.docCount) c.append(el('span', F().docsFolderCount(r.docCount, 0), 'fx-docsn'));
      if (r.docCount && r.changed) c.append(el('span', ' · ', 'fx-docsn'));
      if (r.changed) c.append(el('span', r.changed + ' changed', 'fx-dirchg'));
      n.append(c);
    } else if (r.kind === 'dir' && r.changed && !r.ignored) n.append(el('span', r.changed + ' changed', 'fx-dirchg'));
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
    if (r.kind === 'dir')
      n.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        folderMenu(n, e.clientX, e.clientY);
      });
    return n;
  }
  const pagesText = (n) => n + (n === 1 ? ' page' : ' pages');
  // A doc: one row, no caret, never expands. Its name, its page count and a change badge.
  function docRowNode(r, scope) {
    const n = el('div', null, 'fx-row fx-doc' + (r.path === sel ? ' sel' : ''));
    n.dataset.path = r.path;
    n.dataset.kind = 'doc';
    n.setAttribute('role', 'treeitem');
    n.tabIndex = r.path === sel ? 0 : -1;
    n.style.setProperty('--d', String(r.depth));
    const caret = el('span', '', 'fx-caret');
    caret.setAttribute('aria-hidden', 'true');
    n.append(caret, docIcon('fx-ico fx-docico'));
    const name = el('span', null, 'fx-name');
    const hit = query.trim() && results ? F().markHit(r.name, query) : null;
    if (hit) name.append(doc().createTextNode(hit[0]), el('mark', hit[1]), doc().createTextNode(hit[2]));
    else name.textContent = r.name;
    n.append(name);
    // an agent writing it right now: a pulsing dot after the title (what it writes is in the tooltip)
    const w = r.writing;
    const live = w ? (w.name || 'An agent') + ' is writing ' + (w.section || w.page || 'this doc') : '';
    if (w) {
      const dot = el('span', '', 'fx-docdot');
      dot.setAttribute('role', 'img');
      dot.setAttribute('aria-label', live);
      n.append(dot);
    }
    n.append(el('span', pagesText(r.pages), 'fx-docpages'));
    n.title = r.name + ' · doc, ' + pagesText(r.pages) + (live ? '\n' + live : '') + '\nClick: open. Double-click: keep the tab open';
    if (r.badge) {
      const b = btn(null, 'fx-chg ' + r.badge.status, 'Changed: show the Changes tab');
      b.tabIndex = -1;
      b.append(el('span', r.badge.text, 'st'));
      b.onclick = (e) => {
        e.stopPropagation();
        const live = CH();
        if (live && live.reveal) live.reveal('changes');
      };
      n.append(b);
    }
    n.addEventListener('click', () => {
      sel = r.path;
      openDocRow(scope, r.doc, false);
    });
    n.addEventListener('dblclick', () => openDocRow(scope, r.doc, true));
    n.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      folderMenu(n, e.clientX, e.clientY);
    });
    return n;
  }
  function openDocRow(scope, d, keep) {
    openDoc(scope, { name: d.name, title: d.title || d.name, dir: d.dir, where: 'tab', preview: !keep });
  }
  // "+ New doc": the last row inside aib-docs (while no doc exists yet, an empty aib-docs folder row holds only it). Clicked, it
  // turns into a name field reading "Untitled doc" with the name selected; Enter makes the doc with one page and opens it.
  let newDoc = null; // {value, error, busy, focus} while the name field shows
  function newDocNode(r, scope) {
    const n = el('div', null, 'fx-row fx-newdoc' + (r.path === sel ? ' sel' : ''));
    n.dataset.path = r.path;
    n.dataset.kind = 'newdoc';
    n.setAttribute('role', 'treeitem');
    n.tabIndex = r.path === sel && !newDoc ? 0 : -1;
    n.style.setProperty('--d', String(r.depth));
    n.append(el('span', '', 'fx-caret'));
    if (!newDoc) {
      n.append(el('span', '+', 'fx-newdoc-plus'), el('span', 'New doc', 'fx-name'));
      n.title = 'Make a new doc in this project (saved in aib-docs/)';
      n.addEventListener('click', () => startNewDoc());
      return n;
    }
    n.classList.add('editing');
    // A repaint builds a new field: when the old one had the focus, the new one takes it (same selection), so editing survives.
    const prev = doc().activeElement;
    const hadFocus = !!(prev && prev.classList && prev.classList.contains('fx-newdoc-in'));
    const caret = hadFocus ? [prev.selectionStart, prev.selectionEnd] : null;
    const input = el('input', null, 'fx-newdoc-in');
    input.type = 'text';
    input.value = newDoc.value;
    input.setAttribute('aria-label', 'Name of the new doc');
    input.maxLength = 60;
    input.disabled = !!newDoc.busy;
    input.addEventListener('input', () => {
      newDoc.value = input.value;
      newDoc.error = '';
    });
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        createDoc(scope, input.value);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        newDoc = null;
        paint();
      }
    });
    input.addEventListener('blur', () => {
      (root.setTimeout || setTimeout)(() => {
        if (input.isConnected === false) return; // replaced by a repaint, not left by the user
        if (newDoc && !newDoc.busy && !newDoc.error && els && !els.tree.contains(doc().activeElement)) {
          newDoc = null;
          paint();
        }
      }, 150);
    });
    n.append(input);
    if (newDoc.error) n.append(el('span', newDoc.error, 'fx-newdoc-err'));
    if (newDoc.focus) {
      newDoc.focus = false;
      (root.setTimeout || setTimeout)(() => {
        if (input.focus) input.focus();
        if (input.select) input.select();
      }, 0);
    } else if (hadFocus) {
      (root.setTimeout || setTimeout)(() => {
        if (input.focus) input.focus();
        try {
          const n = input.value.length;
          input.setSelectionRange(Math.min(caret[0] == null ? n : caret[0], n), Math.min(caret[1] == null ? n : caret[1], n));
        } catch (e) {
          /* not a text field in this environment */
        }
      }, 0);
    }
    return n;
  }
  // New doc from Files, a folder's right-click menu or Ctrl+K: Files opens aib-docs and shows the name field as its last row.
  async function startNewDoc() {
    if (!host) return;
    if (mode !== 'files') setMode('files');
    if (W() && W().openDrawer) W().openDrawer();
    const scope = currentScope();
    if (!scope) return;
    query = '';
    results = null;
    changedOnly = false;
    if (els) els.filter.value = '';
    const t = treeOf(scope),
      DF = F().DOCS_FOLDER;
    if (t.cache[''] === undefined) await listDir(scope, '');
    t.open.add(DF);
    if (docsFolderOnDisk(t) && t.cache[DF] === undefined) listDir(scope, DF);
    const names = (docsOf(scope) || []).map((d) => String(d.title || '').toLowerCase());
    let value = 'Untitled doc',
      k = 2;
    while (names.includes(value.toLowerCase())) value = 'Untitled doc ' + k++;
    newDoc = { value, error: '', busy: false, focus: true };
    sel = F().NEW_DOC;
    paint();
  }
  // Enter in the name field: POST /api/live/docs/open with create (the doc is linked to the chat the Files view follows).
  async function createDoc(scope, value) {
    const name = String(value || '').trim();
    if (!newDoc || newDoc.busy) return;
    if (!name) {
      newDoc.error = 'Type a name';
      newDoc.focus = true;
      paint();
      return;
    }
    newDoc.busy = true;
    paint();
    try {
      const r = await host.post('docs/open', { id: scope.id, name, create: '' });
      newDoc = null;
      await loadDocs(scope, true);
      const t = treeOf(scope),
        DF = F().DOCS_FOLDER;
      listDir(scope, '');
      if (t.open.has(DF) || t.cache[DF] !== undefined) {
        t.open.add(DF);
        delete t.cache[DF];
        listDir(scope, DF);
      }
      openDoc(scope, { name: r.name, title: r.title || r.name, dir: r.dir, page: '', where: 'tab', preview: false });
    } catch (e) {
      if (!newDoc) return;
      newDoc.busy = false;
      newDoc.focus = true;
      newDoc.error =
        e && (e.code === 'doc_exists' || e.code === 'folder_exists')
          ? 'That name is taken: choose another'
          : (e && e.message) || 'Could not make the doc';
      paint();
    }
  }
  function folderMenu(anchor, x, y) {
    if (menu) closeMenu(false);
    const m = menuShell('Folder', anchor);
    const b = btn('New doc', 'ws-menu-item fx-menu-it');
    b.setAttribute('role', 'menuitem');
    b.onclick = () => {
      closeMenu(false);
      startNewDoc();
    };
    m.append(b);
    doc().body.append(m);
    menu = m;
    m.style.left = Math.max(8, Math.round(x)) + 'px';
    m.style.top = Math.max(8, Math.round(y)) + 'px';
    if (b.focus) b.focus();
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
  // aib-docs is on disk once the first doc is made; before that its row is an empty folder holding "+ New doc".
  const docsFolderOnDisk = (t) => Array.isArray(t.cache['']) && t.cache[''].some((e) => e.dir && e.path === F().DOCS_FOLDER);
  function toggleDir(path, force) {
    const scope = currentScope();
    if (!scope) return;
    const t = treeOf(scope);
    const opening = force === undefined ? !t.open.has(path) : !!force;
    if (opening) {
      t.open.add(path);
      const notMade = path === F().DOCS_FOLDER && !docsFolderOnDisk(t);
      if (!notMade && (t.cache[path] === undefined || (t.cache[path] && t.cache[path].error))) listDir(scope, path);
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
    const model = F().scopeMenu(c, (c && c.projectPath) || (others[0] && others[0].projectPath) || projectPathNow(), others, scope, following);
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
    if (path === F().NEW_DOC) return startNewDoc();
    const idx = docIndexOf(scope),
      d = idx ? idx.byDir.get(path) : null;
    if (d) return openDocRow(scope, d, !!(o && o.keep));
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
  // ---- doc tabs -------------------------------------------------------------------------------------------------------------
  // A doc shows in the doc page (doc.html) in a frame, by the doc-tab contract: a tab in the strip (from Files, New doc, Ctrl+K; a
  // preview tab on a single click). Docs from a chat open in the right column's Artifacts viewer instead (artifacts-ui.js owns
  // that frame and hands it here with attachDocFrame, so its messages are answered the same way). Docs never open beside the
  // chat. A doc already open is re-used: its frame is told to go to the page. Frames stay alive while their tab exists.
  const frames = new Map(); // 'main|' or 'artifacts|' + tab id -> {frame, tab, where, hooks}
  function openDoc(scope, d) {
    if (!scope || !d || !d.name) return;
    setTabsHere(F().openDocTab(tabsHere(), scope, d, { keep: !d.preview }));
    gotoIfOpen('main', d);
    showFile();
    if (W() && W().closeDrawer) W().closeDrawer();
  }
  // The Artifacts viewer's doc frame. hooks: {open(d), title(t), closed()}. Returns {detach()}.
  function attachDocFrame(frame, scope, d, hooks) {
    const tab = {
      id: F().docTabId(d.name),
      kind: 'doc',
      path: d.dir || F().DOCS_FOLDER + '/' + d.name,
      name: d.title || d.name,
      scope,
      preview: false,
      line: 0,
      doc: { name: d.name, title: d.title || d.name, page: d.page || '' },
    };
    const key = 'artifacts|' + tab.id;
    for (const [k, r] of Array.from(frames)) if (r.where === 'artifacts' && r.frame !== frame) frames.delete(k);
    const rec = { frame, tab, where: 'artifacts', hooks: hooks || {} };
    frames.set(key, rec);
    return {
      detach() {
        if (frames.get(key) === rec) frames.delete(key);
      },
    };
  }
  function gotoIfOpen(where, d) {
    const rec = frames.get(where + '|' + F().docTabId(d.name));
    if (!rec || !(d.page || d.block || d.thread)) return;
    try {
      if (rec.frame.contentWindow)
        rec.frame.contentWindow.postMessage({ type: 'aib-doc:goto', page: d.page || '', block: d.block || '', thread: d.thread || '' }, originOf());
    } catch (e) {
      /* the frame is still loading */
    }
  }
  const originOf = () => (root.location && root.location.origin) || '*';
  // Where doc frames live: #docView right after #fileView (box).
  let docViewEl = null;
  function docHolder(where, box) {
    if (docViewEl && docViewEl.parentNode) return docViewEl;
    if (!box || !box.parentNode) return null;
    docViewEl = el('section', null, 'sf-docview');
    docViewEl.id = 'docView';
    docViewEl.setAttribute('aria-label', 'Doc');
    docViewEl.hidden = true;
    box.after(docViewEl);
    return docViewEl;
  }
  function showDocFrame(holder, tab, where) {
    const key = where + '|' + tab.id;
    let rec = frames.get(key);
    if (!rec) {
      const f = el('iframe', null, 'sf-docframe');
      f.title = 'Doc: ' + tab.name;
      f.src = DL()
        ? DL().docUrl({ chat: tab.scope.id, name: tab.doc.name, page: tab.doc.page, preview: !!tab.preview, where: 'tab' })
        : 'about:blank';
      rec = { frame: f, tab, where };
      frames.set(key, rec);
    }
    rec.tab = tab;
    if (rec.frame.parentNode !== holder) holder.append(rec.frame);
    for (const r of frames.values()) if (r.where === where) r.frame.hidden = r !== rec;
  }
  function pruneFrames(where, tabs) {
    for (const [k, r] of Array.from(frames)) {
      if (r.where !== where || (tabs || []).some((t) => t.id === r.tab.id)) continue;
      if (r.frame.remove) r.frame.remove();
      frames.delete(k);
    }
  }
  // Messages from a doc frame (contract section 2): the frame is found by e.source, never by what the message says.
  function onFrameMessage(e) {
    if (!e || e.origin !== originOf()) return;
    const data = e.data;
    if (!data || typeof data.type !== 'string' || data.type.indexOf('aib-doc:') !== 0) return;
    let rec = null;
    for (const r of frames.values()) if (r.frame.contentWindow && r.frame.contentWindow === e.source) rec = r;
    if (!rec) return;
    const tab = rec.tab,
      str = (v) => (typeof v === 'string' ? v : '');
    if (data.type === 'aib-doc:open') {
      const name = str(data.name) || tab.doc.name;
      const d = { name, title: name === tab.doc.name ? tab.doc.title : name, page: str(data.page), block: str(data.block), preview: false };
      // from the Artifacts viewer a doc stays there unless the page asks for a tab
      if (rec.where === 'artifacts' && data.where !== 'tab' && rec.hooks.open) rec.hooks.open(d);
      else openDoc(tab.scope, d);
    } else if (data.type === 'aib-doc:show-in-files') {
      showInFiles(currentScope() || tab.scope, str(data.dir) || tab.path);
    } else if (data.type === 'aib-doc:pick-chat') {
      const src = e.source;
      Promise.resolve(DL() && DL().pickChat ? DL().pickChat(rec.frame, str(data.purpose)) : null).then((chatId) => {
        try {
          src.postMessage({ type: 'aib-doc:picked', requestId: data.requestId, chat: chatId || null }, originOf());
        } catch (err) {
          /* the frame is gone */
        }
      });
    } else if (data.type === 'aib-doc:pin') {
      if (rec.where === 'main' && tab.preview) keepTab(tab.id);
    } else if (data.type === 'aib-doc:title') {
      if (rec.where === 'artifacts') {
        tab.name = str(data.title) || tab.name;
        if (rec.hooks.title) rec.hooks.title({ title: str(data.title), page: str(data.page), pageTitle: str(data.pageTitle) });
        return;
      }
      const patch = (t) =>
        t.id === tab.id
          ? Object.assign({}, t, {
              name: str(data.title) || t.name,
              pageTitle: str(data.pageTitle),
              doc: Object.assign({}, t.doc, { title: str(data.title) || t.doc.title, page: str(data.page) || t.doc.page }),
            })
          : t;
      {
        const h = tabsHere();
        setTabsHere({ tabs: h.tabs.map(patch), active: h.active });
        if (W() && W().refresh) W().refresh();
      }
    } else if (data.type === 'aib-doc:closed') {
      if (rec.where === 'artifacts') {
        frames.delete('artifacts|' + tab.id);
        if (rec.hooks.closed) rec.hooks.closed();
      } else closeFileTab(tab.id);
      refreshDocs(tab.scope);
    } else if (data.type === 'aib-doc:show-artifact') {
      // the doc header's "Shown in 1 artifact" chip: that artifact in the right column
      const A = AR();
      if (A && A.open && str(data.id)) A.open(str(data.id));
    } else if (data.type === 'aib-doc:docs-changed') {
      // "Duplicate doc" made a new doc: Files, Ctrl+K and the picker list it without a reload
      refreshDocs(tab.scope);
    }
  }
  // The project's docs changed (a doc duplicated or moved to the trash): list them again, and the docs folder if it was listed.
  function refreshDocs(scope) {
    if (!scope) return;
    const t = treeOf(scope),
      DF = F().DOCS_FOLDER;
    if (t.cache[''] !== undefined && t.cache[''] !== 'loading') listDir(scope, '');
    if (t.cache[DF] !== undefined && t.cache[DF] !== 'loading') {
      delete t.cache[DF];
      listDir(scope, DF);
    } else loadDocs(scope, true);
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
    notesData.delete(id);
    pruneFrames('main', r.state.tabs);
    if (!r.next) showChat();
    else showFile();
  }
  function keepTab(id) {
    setTabsHere(F().keepTab(tabsHere(), id));
    drawMain();
    if (W() && W().refresh) W().refresh();
  }
  // The width beside the chat. The room is the space between the chat list and the right column; the pane takes a fraction of
  // it (45 % until you drag the divider; the fraction is remembered, so it fits every window size), the pane keeps at least
  // 360 px and the chat at least 420 px (the pane's minimum wins when there is room for neither).
  const BESIDE_KEY = 'aib-beside-frac-v1',
    BESIDE_DEF = 0.45,
    BESIDE_MIN = 360,
    BESIDE_CHAT_MIN = 420;
  let besideW = 0,
    besideFrac = null; // null: the default
  function readFrac() {
    const v = Number(store.get(BESIDE_KEY, null));
    return v > 0 && v < 1 ? v : null;
  }
  const cssPx = (name) => {
    try {
      return parseFloat(root.getComputedStyle(doc().documentElement).getPropertyValue(name)) || 0;
    } catch (e) {
      return 0;
    }
  };
  // The room in screen px: main's width less the chat list and (when it shows) the right column.
  function besideRoom() {
    const d = doc(),
      main = d.querySelector('main');
    if (!main || !main.getBoundingClientRect) return 0;
    const w = main.getBoundingClientRect().width,
      b = d.body,
      side = b.classList.contains('side-off') ? 0 : cssPx('--side-w'),
      act = b.classList.contains('activity-off') || (root.innerWidth || 0) < 1100 ? 0 : cssPx('--activity-w');
    return Math.max(0, w - side - act);
  }
  const besideBounds = (room) => ({ min: BESIDE_MIN, max: Math.max(BESIDE_MIN, Math.round(room - BESIDE_CHAT_MIN)) });
  function paneWidth(room, frac) {
    const bd = besideBounds(room);
    return Math.round(Math.min(Math.max(room * (frac == null ? BESIDE_DEF : frac), bd.min), bd.max));
  }
  function layoutBeside() {
    const d = doc(),
      b = d.body,
      main = d.querySelector('main');
    if (!b || !main || !b.classList.contains('sf-beside-on')) return;
    const room = besideRoom();
    if (!(room > 0)) return;
    const w = paneWidth(room, besideFrac);
    const h = d.getElementById('fileBesideDivider');
    if (h) {
      const bd = besideBounds(room);
      h.setAttribute('aria-valuemin', String(bd.min));
      h.setAttribute('aria-valuemax', String(bd.max));
      h.setAttribute('aria-valuenow', String(w));
    }
    if (w === besideW) return;
    besideW = w;
    if (main.style && main.style.setProperty) main.style.setProperty('--sf-bw', w + 'px');
  }
  function setBesideFrac(frac, save) {
    besideFrac = frac == null ? null : Math.min(0.95, Math.max(0.05, frac));
    if (save) store.set(BESIDE_KEY, besideFrac == null ? '' : String(besideFrac));
    layoutBeside();
  }
  // The divider on the pane's left edge: drag it, arrow keys on it (Shift: bigger steps), Home / End, double-click or Enter
  // resets to 45 %. The look and the step sizes are the resize handles' (resize-ui.js).
  function besideDivider() {
    const h = el('div', null, 'rs-handle rs-v sf-beside-div');
    h.id = 'fileBesideDivider';
    h.setAttribute('role', 'separator');
    h.setAttribute('aria-orientation', 'vertical');
    h.setAttribute('aria-label', 'Resize the files beside the chat');
    h.title = 'Resize the files beside the chat (double-click to reset)';
    h.tabIndex = 0;
    const RU = () => root.ResizeUI || {};
    let drag = null;
    const right = () => {
      const box = doc().getElementById('fileBeside');
      return box && box.getBoundingClientRect ? box.getBoundingClientRect().right : 0;
    };
    const end = (cancel) => {
      if (!drag) return;
      try {
        h.releasePointerCapture(drag.id);
      } catch (e) {
        /* already released */
      }
      if (cancel) setBesideFrac(drag.frac, false);
      else store.set(BESIDE_KEY, besideFrac == null ? '' : String(besideFrac));
      drag = null;
      h.classList.remove('rs-active');
      doc().body.classList.remove('rs-dragging');
    };
    h.addEventListener('pointerdown', (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      try {
        h.setPointerCapture(e.pointerId);
      } catch (err) {
        /* no capture */
      }
      drag = { id: e.pointerId, frac: besideFrac, grab: right() - e.clientX - besideW };
      h.classList.add('rs-active');
      doc().body.classList.add('rs-dragging');
    });
    h.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const room = besideRoom();
      if (!(room > 0)) return;
      const bd = besideBounds(room),
        w = Math.min(Math.max(right() - e.clientX - drag.grab, bd.min), bd.max);
      setBesideFrac(w / room, false);
    });
    h.addEventListener('pointerup', (e) => {
      if (drag && e.pointerId === drag.id) end(false);
    });
    h.addEventListener('pointercancel', () => end(true));
    h.addEventListener('lostpointercapture', () => end(false));
    h.addEventListener('dblclick', (e) => {
      e.preventDefault();
      setBesideFrac(null, true);
    });
    h.addEventListener('keydown', (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === 'Escape' && drag) {
        e.preventDefault();
        end(true);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        setBesideFrac(null, true);
        return;
      }
      const room = besideRoom();
      if (!(room > 0) || !RU().keyStep) return;
      const bd = besideBounds(room);
      const next = RU().keyStep(e.key, { value: besideW, min: bd.min, max: bd.max, def: paneWidth(room, null), shift: e.shiftKey, inverted: true, axis: 'x' });
      if (next == null) return;
      e.preventDefault();
      setBesideFrac(next / room, true);
    });
    return h;
  }
  function setBeside(on) {
    const b = doc().body;
    const was = !!(b && b.classList.contains('sf-beside-on'));
    if (b) b.classList.toggle('sf-beside-on', !!on);
    if (on && !was) {
      besideW = 0;
      besideFrac = readFrac();
    }
    if (on) layoutBeside();
    if (!on) beside = F().emptyTabs();
    if (els && els.beside) els.beside.hidden = !on;
    if (root.ResizeUI && root.ResizeUI.layout) root.ResizeUI.layout();
  }

  // ---- the tab strip (workspace-ui.js asks for these nodes) -----------------------------------------------------------
  const tabTitle = (t) =>
    t.kind === 'notes'
      ? t.name + '\nRelease notes, read only'
      : t.kind === 'doc'
      ? t.name + (t.pageTitle ? ' › ' + t.pageTitle : '') + ' (doc)' + (t.preview ? '\nPreview: the next file or doc you open replaces it. Double-click to keep it.' : '')
      : (t.scope && t.scope.root === 'outside' ? (t.scope.abs || t.path) + '\n' + outsideText(t.scope.where) : t.path) +
    (t.scope && t.scope.branch ? '\n⎇ ' + t.scope.branch : '') + (t.preview ? '\nPreview: the next file you open replaces it. Double-click to keep it.' : '');
  function tabNode(t, active, onSelect, onClose, onKeep) {
    const wrap = el('div', null, 'ws-tab sf-ftab' + (t.preview ? ' preview' : '') + (active ? ' on' : ''));
    wrap.dataset.key = 'file:' + t.id;
    const main = btn(null, 'ws-tab-main');
    main.setAttribute('role', 'tab');
    main.setAttribute('aria-selected', String(!!active));
    main.title = tabTitle(t);
    if (t.kind === 'notes') {
      wrap.classList.add('sf-notestab');
      main.append(icon(FILE_D, 'sf-fico'), el('span', t.name, 'ws-tab-title'));
    } else if (t.kind === 'doc') {
      wrap.classList.add('sf-doctab');
      main.append(docIcon('sf-fico sf-docico'), el('span', t.name + (t.pageTitle ? ' › ' + t.pageTitle : ''), 'ws-tab-title'));
    } else main.append(icon(FILE_D, 'sf-fico'), el('span', t.name, 'ws-tab-title'));
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
  const outsideText = (where) => 'Outside this project' + (where ? ' · ' + where : '');
  function ensureRead(tab, redraw) {
    let r = reads.get(tab.id);
    if (r) return r;
    r = { loading: true, data: null, error: '', mode: 'source', gutter: null };
    reads.set(tab.id, r);
    const outside = tab.scope.root === 'outside';
    host
      .getJson(
        outside ? '/api/live/files/outside' : '/api/live/files/read',
        outside ? { id: tab.scope.id, path: tab.scope.abs || tab.path } : Object.assign(F().scopeArgs(tab.scope), { path: tab.path }),
      )
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
  // A file outside the chat's folder: "Outside this project" and what AIB can tell about its folder (branch, worktree of which repo).
  function chipFor(tab, d) {
    const s = tab.scope || {};
    if (s.root === 'outside') {
      const where = (d && d.outside && d.outside.text) || s.where || '',
        chip = el('span', null, 'sf-fv-from sf-fv-outside');
      chip.append(el('span', 'Outside this project', 'sf-fv-out'));
      if (where) chip.append(el('span', '· ' + where, 'sf-fv-chat'));
      chip.title = outsideText(where) + "\nRead-only. This file is not in the chat's folder; the chat named it.";
      return chip;
    }
    const
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
    loadProjectArtifacts(false);
    const r = ensureRead(tab, redraw),
      d = r.data;
    const head = el('div', null, 'sf-fv-head');
    const crumb = el('div', null, 'sf-fv-crumb');
    const proj = (W() && W().currentProjectName && W().currentProjectName()) || '';
    const dirs = F().dirOf(tab.path);
    if (tab.scope && tab.scope.root === 'outside') crumb.append(doc().createTextNode(dirs ? dirs + '/' : ''), el('b', tab.name));
    else crumb.append(doc().createTextNode((proj ? proj + ' / ' : '') + (dirs ? dirs.split('/').join(' / ') + ' / ' : '')), el('b', tab.name));
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
    head.append(el('span', null, 'fx-spacer'), chipFor(tab, d));
    const tools = el('div', null, 'sf-fv-tools');
    const canPage = !!(d && d.page && d.viewUrl);
    if (canPage) {
      const seg = el('div', null, 'fx-seg');
      seg.setAttribute('role', 'group');
      seg.setAttribute('aria-label', 'Show');
      for (const [m, label] of [
        ['source', 'Source'],
        ['page', 'Preview'],
      ]) {
        const b = btn(label);
        b.setAttribute('aria-pressed', String(r.mode === m));
        b.title = m === 'page' ? 'Preview of the file, view only' : 'The file as text';
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
    const art = d && tab.scope.root !== 'outside' ? artifactFor(treeOf(tab.scope).root || d.root || '', tab.path) || artifactFor(d.root, tab.path) : null;
    // Every page file (html, svg, md) can open in Artifacts; one no chat registered yet is registered on click in the chat that can
    // hold it (artChatFor). With no such chat the button stays, disabled, and its tooltip says why.
    if (art || (d && tab.scope.root !== 'outside' && d.page && !d.binary && !d.tooBig)) {
      const target = art ? null : artChatFor(tab.scope, d.abs);
      const a = btn(
        '⧉ Open in Artifacts',
        'fx-btn link',
        art
          ? 'Open this artifact in the Artifacts tab on the right'
          : target
            ? 'Add this file to the artifacts of "' + target.title + '" and show it in the Artifacts tab on the right'
            : 'No chat works in this folder, so none can keep this file as an artifact. Start a chat in this folder first.',
      );
      a.disabled = !art && !target;
      a.onclick = () => {
        r.artNote = '';
        openInArtifacts(art, d.abs, target, (m) => {
          r.artNote = m;
          redraw();
        });
      };
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
      f.title = 'Preview of ' + d.name + ' (view only)';
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
    // A failed "Open in Artifacts" says so right under the toolbar you clicked (the page's own error line is hidden while a file shows).
    const alert = r.artNote ? el('p', null, 'sf-fv-alert') : null;
    if (alert) {
      alert.setAttribute('role', 'alert');
      const x = btn('×', 'sf-fv-alert-x', 'Dismiss');
      x.onclick = () => {
        r.artNote = '';
        redraw();
      };
      alert.append(el('span', r.artNote), x);
    }
    box.replaceChildren(...[head, tools, alert, body, foot].filter(Boolean));
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
    const dv = docHolder('main', box);
    pruneFrames('main', t.tabs);
    if (tab && tab.kind === 'doc' && dv) {
      box.hidden = true;
      box.replaceChildren();
      dv.hidden = false;
      showDocFrame(dv, tab, 'main');
      return;
    }
    if (dv) dv.hidden = true;
    box.hidden = !tab;
    if (!tab) {
      box.replaceChildren();
      const b = doc().body;
      if (b) b.classList.remove('sf-file-on');
      view = 'chat';
      return;
    }
    if (tab.kind === 'notes') return renderNotes(box, tab);
    renderView(box, tab, 'main');
  }

  // ---- "What's new in AIB <version>": the release notes, once after an update (updates-ui.js) ------------------------------
  // notes: {version, releases: [{version, date, page, body}]} newest first (the version just installed on top). Opens a read-only
  // tab in the strip and shows it. Returns true when it opened.
  function openNotes(notes) {
    if (!notes || typeof notes.version !== 'string' || !Array.isArray(notes.releases) || !notes.releases.length) return false;
    if (!F() || !doc().getElementById('chatTabs')) return false;
    const id = 'notes:' + notes.version;
    notesData.set(id, notes);
    const tab = { id, kind: 'notes', path: '', name: "What's new in AIB " + notes.version, scope: { id: 'aib-notes', root: 'notes' }, preview: false };
    const h = tabsHere();
    setTabsHere({ tabs: h.tabs.filter((x) => x.id !== id).concat([tab]), active: id });
    showFile();
    const body = doc().querySelector && doc().querySelector('#fileView .sf-notes');
    if (body) body.scrollTop = 0;
    if (W() && W().closeDrawer) W().closeDrawer();
    return true;
  }
  // A date from the release ("2026-11-12T10:00:00Z") as the person's local date; '' when there is none.
  function noteDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    try {
      return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    } catch (e) {
      return iso.slice(0, 10);
    }
  }
  function renderNotes(box, tab) {
    const notes = notesData.get(tab.id);
    const head = el('div', null, 'sf-fv-head');
    const crumb = el('div', null, 'sf-fv-crumb');
    crumb.append(doc().createTextNode('AIB / '), el('b', tab.name));
    head.append(crumb);
    const body = el('div', null, 'sf-fv-body sf-notes');
    body.setAttribute('role', 'region');
    body.setAttribute('aria-label', tab.name + ', read only');
    body.tabIndex = 0;
    if (!notes) body.append(el('p', 'These release notes are no longer here. They show once after an update.', 'fx-note'));
    else
      for (const r of notes.releases) {
        const sec = el('section', null, 'sf-note-rel' + (r.version === notes.version ? ' current' : ''));
        sec.dataset.version = r.version;
        const h = el('h2', 'AIB ' + r.version, 'sf-note-ver');
        const meta = el('p', null, 'sf-note-meta');
        const when = noteDate(r.date);
        meta.append(doc().createTextNode((r.version === notes.version ? 'Installed now' : 'Earlier release') + (when ? ' · ' + when : '')));
        const md = el('div', null, 'markdown sf-note-body');
        if (root.AgentMarkdown && root.AgentMarkdown.render) root.AgentMarkdown.render(md, r.body);
        else md.textContent = r.body;
        sec.append(h, meta, md);
        body.append(sec);
      }
    const foot = el('div', null, 'fx-pv-foot');
    foot.append(
      el('span', notes ? notes.releases.length + (notes.releases.length === 1 ? ' release' : ' releases') + ' · newest first' : ''),
      el('span', null, 'fx-spacer'),
      el('span', 'Read-only'),
    );
    box.replaceChildren(head, body, foot);
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
      box.append(strip, view_, besideDivider());
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
    v.hidden = false;
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
    if (a) openInArtifacts(a, '');
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
    rec.promise = host.getJson('/api/live/files/list', Object.assign(F().scopeArgs(scope), { dir })).then(
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
    openTarget({ scope: scopeOfLink(a), rel: a.dataset.filePath, line: Number(a.dataset.line) || 0, abs: a.dataset.abs || '' }, how);
  }
  // t: {scope, rel, line, abs}. how: '' (the width rule), 'beside', 'tab' or 'editor'.
  function openTarget(t, how) {
    const scope = t && t.scope,
      rel = t && t.rel,
      line = (t && t.line) || 0;
    if (!scope || !rel) return;
    if (how === 'editor') {
      if (ED() && t.abs) ED().openFile(t.abs, line, dirAbs(t.abs));
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
    const sc = scopeOfLink(a);
    if (!(sc && sc.root === 'outside')) add('Show in Files', () => showInFiles(sc, a.dataset.filePath));
    add('Copy path', () => copyText(a.dataset.abs || a.dataset.filePath));
    if (ED() && ED().showInExplorer && a.dataset.abs) add('Show in Explorer', () => ED().showInExplorer(dirAbs(a.dataset.abs)));
    doc().body.append(m);
    menu = m;
    m.style.left = Math.max(8, Math.round(x)) + 'px';
    m.style.top = Math.max(8, Math.round(y)) + 'px';
    const first = m.querySelector('button');
    if (first) first.focus();
  }
  // ---- write / edit rows ----------------------------------------------------------------------------------------------------
  // tool-views.js calls toolFile(box, path) for a write or edit row. When the file exists on this computer (inside the chat's
  // folder, or outside it when the chat named it: GET /api/live/files/outside), the row gets an "open file" icon button and the
  // path in its detail becomes a file link (same click, Ctrl+click and right-click as paths in replies). A missing file gets
  // neither. The chat is the one the row is drawn for: a split pane's own chat, else the open chat (main view, subagent history).
  const outsideSeen = new Map(); // chat id + path -> {at, promise}
  function outsidePeek(c, path) {
    const k = c.id + '|' + path,
      hit = outsideSeen.get(k);
    if (hit && Date.now() - hit.at < 20000) return hit.promise;
    const rec = { at: Date.now(), promise: null };
    rec.promise = host.getJson('/api/live/files/outside', { id: c.id, path, peek: 1 }).then(
      (r) => (r && r.abs ? r : null),
      () => null,
    );
    outsideSeen.set(k, rec);
    while (outsideSeen.size > 300) outsideSeen.delete(outsideSeen.keys().next().value);
    return rec.promise;
  }
  function chatOfNode(node) {
    const m = node && node.closest ? node.closest('.mirror-msgs') : null,
      key = m && m.dataset ? m.dataset.mirror : '';
    if (key && host && host.conversations) {
      const c = (host.conversations() || []).find((x) => host.aliasKey(x) === key);
      return c ? chatInfo(c) : null;
    }
    return chat;
  }
  const isAbs = (p) => /^([A-Za-z]:[\\/]|\/)/.test(String(p || ''));
  function toolFileInfo(c, path) {
    const scope = F().followScope(c, c.projectPath),
      folder = c.cwd || c.projectPath,
      rel = scope && folder ? F().relTo(path, folder) : null;
    if (rel !== null) {
      return dirNames(scope, F().dirOf(rel)).then((d) => {
        const e = d.names.get(F().nameOf(rel).toLowerCase());
        if (!e || e.dir) return null;
        return { scope, rel, root: d.root, line: 0, abs: '' };
      });
    }
    if (!isAbs(path)) return Promise.resolve(null);
    return outsidePeek(c, path).then((r) => {
      if (!r) return null;
      const where = (r.outside && r.outside.text) || '';
      const scope = { id: c.id, root: 'outside', label: 'Outside', branch: '', chatKey: c.key, title: c.title, abs: path, where };
      return { scope, rel: F().slash(path), root: '', line: 0, abs: path, outside: true, where };
    });
  }
  function toolLink(text, info, parent) {
    const a = pathLink(text, info.rel, info.line, info.scope, info.root, parent);
    if (info.abs) a.dataset.abs = info.abs;
    if (info.outside)
      a.title =
        (info.abs || info.rel) +
        '\n' +
        outsideText(info.where) +
        '\nClick: open the file (read only). Ctrl+click: open in your editor. Right-click: more';
    return a;
  }
  const samePath = (a, b) => {
    const n = (p) =>
      F()
        .slash(String(p || '').trim())
        .replace(/\/+$/, '');
    return /^[A-Za-z]:/.test(String(a).trim()) ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
  };
  // The written file's path in an opened detail (the path box, and the locations list) becomes a file link.
  function linkToolDetail(panel, info, path) {
    if (!panel || !panel.querySelectorAll) return 0;
    let n = 0;
    for (const code of panel.querySelectorAll('code.tool-path-text')) {
      if (!code.parentNode || (code.closest && code.closest('a.fx-path')) || !samePath(code.textContent, path)) continue;
      const a = toolLink(code.textContent, info, code);
      a.lastChild.remove();
      code.replaceWith(a);
      a.append(code);
      n++;
    }
    for (const li of Array.from(panel.querySelectorAll('.tool-locations')).flatMap((ul) => Array.from(ul.querySelectorAll('li')))) {
      const t = String(li.textContent || ''),
        m = /^(.*?)(?::(\d+))?$/.exec(t);
      if (!m || !samePath(m[1], path) || li.querySelector('a.fx-path')) continue;
      li.replaceChildren(toolLink(t, Object.assign({}, info, { line: Number(m[2]) || 0 }), null));
      n++;
    }
    return n;
  }
  function toolButton(info) {
    const name = F().nameOf(info.rel);
    const b = btn(null, 'tool-file', 'Open ' + name + '\n' + (info.outside ? outsideText(info.where) + ', read only' : 'Opens in the file view'));
    b.append(icon(FILE_D, 'tool-file-ico'));
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      openTarget(info, '');
    });
    return b;
  }
  function toolFile(box, path) {
    if (!host || !box || !path) return Promise.resolve(false);
    return Promise.resolve()
      .then(() => {
        const c = chatOfNode(box);
        return c && c.id ? toolFileInfo(c, path) : null;
      })
      .then((info) => {
        if (!info) return false;
        const kids = Array.from(box.children || []);
        let acts = kids.find((k) => k.classList && k.classList.contains('tool-acts'));
        const panel = kids.find((k) => k.classList && k.classList.contains('tool-detail'));
        if (!acts) {
          acts = el('span', null, 'tool-acts');
          if (panel) box.insertBefore(acts, panel);
          else box.append(acts);
        }
        if (!acts.querySelector('.tool-file')) acts.insertBefore(toolButton(info), acts.firstChild || null);
        box.onDetail = (p) => linkToolDetail(p, info, path);
        if (panel) linkToolDetail(panel, info, path);
        return true;
      })
      .catch(() => false);
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
    const d = doc();
    applyMode(store.get(MODE_KEY, 'chats'));
    besideBox();
    d.addEventListener('keydown', onKey, true);
    if (root.addEventListener) root.addEventListener('resize', () => layoutBeside());
    // the chat list or the right column changed width (resize-ui.js sets --side-w / --activity-w on <html>): fit the pane again
    if (typeof root.MutationObserver === 'function' && d.documentElement && d.body) {
      const mo = new root.MutationObserver(() => layoutBeside());
      mo.observe(d.documentElement, { attributes: true, attributeFilter: ['style'] });
      mo.observe(d.body, { attributes: true, attributeFilter: ['class'] });
    }
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
    if (root.addEventListener) root.addEventListener('message', onFrameMessage);
    paint();
  }
  // The search Ctrl+K uses: a doc's files are never hits.
  function searchFiles(q) {
    const scope = currentScope();
    if (!scope || !q) return Promise.resolve({ scope, matches: [] });
    return Promise.all([
      host.getJson('/api/live/files/search', Object.assign(F().scopeArgs(scope), { q })),
      DL() && scope.root !== 'project' ? DL().listFor(scope.id, scope.root) : Promise.resolve([]),
    ]).then(([r]) => ({ scope, matches: withoutDocFiles(scope, (r && r.matches) || []) }));
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
    toolFile,
    currentScope,
    search: searchFiles,
    openDoc,
    openNotes,
    attachDocFrame,
    startNewDoc,
    chatOfNode,
    currentChat: () => chat,
    projectChats,
    onFrameMessage,
    _state: () => ({ mode, chat, following, pinned, query, changedOnly, showIgnored, sel, results, view, tabs: tabsHere(), beside, trees, newDoc, frames }),
    _reset: () => {
      trees.clear();
      reads.clear();
      notesData.clear();
      projectArts.clear();
      exists.clear();
      outsideSeen.clear();
      frames.clear();
      newDoc = null;
      docViewEl = null;
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
