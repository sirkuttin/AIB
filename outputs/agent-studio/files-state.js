(function (root) {
  'use strict';
  // The Files view's pure parts (no DOM, no storage, no clock): the tree rows, change badges, keyboard moves, the scope menu,
  // file tabs with a preview tab, and the link rule for paths in replies. files-ui.js draws them; work/test_files_ui.js tests them.

  const isStr = (v) => typeof v === 'string' && v.length > 0;
  const MINUS = '\u2212';

  // ---- paths --------------------------------------------------------------------------------------------------------------
  const slash = (p) => String(p == null ? '' : p).replace(/\\/g, '/');
  const lowerIf = (p, win) => (win ? p.toLowerCase() : p);
  const isWinPath = (p) => /^[A-Za-z]:/.test(String(p || '')) || String(p || '').includes('\\');
  // parent folder of a relative path ('' at the top)
  const dirOf = (rel) => {
    const s = slash(rel),
      at = s.lastIndexOf('/');
    return at >= 0 ? s.slice(0, at) : '';
  };
  const nameOf = (rel) => {
    const s = slash(rel);
    return s.slice(s.lastIndexOf('/') + 1);
  };
  // A path a reply names -> its path relative to `root` (forward slashes), or null when it is outside root or not a plain path.
  function relTo(path, rootDir) {
    const p = slash(path).trim(),
      r = slash(rootDir).replace(/\/+$/, '');
    if (!p || !r || p.includes('\0')) return null;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) return null; // a URL
    const win = isWinPath(rootDir) || isWinPath(path);
    let rel;
    if (/^([A-Za-z]:\/|\/)/.test(p)) {
      if (!lowerIf(p, win).startsWith(lowerIf(r, win) + '/')) return null;
      rel = p.slice(r.length + 1);
    } else if (p.startsWith('~')) return null;
    else rel = p.replace(/^\.\//, '');
    const parts = rel.split('/').filter((x) => x !== '' && x !== '.');
    if (!parts.length || parts.some((x) => x === '..' || x.includes(':')) || parts[0].toLowerCase() === '.git') return null;
    return parts.join('/');
  }

  // ---- change badges ------------------------------------------------------------------------------------------------------
  // The Changes tab's file list -> {relative path inside the Files root -> file}. Changes paths are relative to the repository
  // top; `prefix` is the chat folder's place in it ('' or 'sub/'). The Files root equals the chat folder, so the prefix is cut.
  function changesMap(files, prefix) {
    const out = new Map(),
      pre = slash(prefix || '');
    for (const f of files || []) {
      if (!f || !isStr(f.path)) continue;
      const p = slash(f.path);
      if (pre && !p.startsWith(pre)) continue;
      out.set(p.slice(pre.length), f);
    }
    return out;
  }
  // "A +86", "M +6 −2", "D −12": the same numbers the Changes tab shows. Untracked (U) counts as added.
  function badgeOf(f) {
    if (!f) return null;
    const st = f.status === 'U' || f.status === '?' ? 'A' : String(f.status || 'M').charAt(0);
    const add = Math.max(0, Number(f.added) || 0),
      del = Math.max(0, Number(f.removed) || 0);
    const parts = [st];
    if (f.binary) parts.push('bin');
    else {
      if (add || st === 'A') parts.push('+' + add);
      if (del || st === 'D') parts.push(MINUS + del);
    }
    return { status: st, added: add, removed: del, text: parts.join(' ') };
  }
  // A status letter from the listing (no numbers) when the Changes data does not have the file.
  const letterBadge = (letter) =>
    letter ? { status: letter === 'U' ? 'A' : letter, added: 0, removed: 0, text: letter === 'U' ? 'A' : letter } : null;
  // How many changed files sit below a folder.
  function changedBelow(map, dir) {
    const pre = dir ? slash(dir) + '/' : '';
    let n = 0;
    for (const k of map.keys()) if (!pre || k.startsWith(pre)) n++;
    return n;
  }

  // ---- docs ---------------------------------------------------------------------------------------------------------------
  // AIB's docs live in aib-docs/<doc>/ (doc.aibdoc + its copies). In the tree aib-docs is a folder like any other; inside it each doc
  // is ONE row (never a folder, never its files) and "+ New doc" is the last row. The project's own docs/ is ordinary files. In
  // the filter and Changed lists a doc's files become its one doc row. `docs`: GET /api/live/docs/list's docs ({name, title, dir,
  // owned, pages, writing}).
  function docIndex(docs) {
    const byDir = new Map(),
      owned = new Map(); // owned path -> doc
    for (const d of docs || []) {
      if (!d || !isStr(d.dir)) continue;
      byDir.set(slash(d.dir), d);
      for (const p of d.owned || []) owned.set(slash(p), d);
    }
    return { byDir, owned };
  }
  // The doc row's change badge: "A" when its doc.aibdoc is new, else "M" when any file it owns changed. From the Changes data
  // when there is some, else from the listing's changed count of the doc's folder.
  function docBadge(d, changes, entry) {
    let st = '';
    if (changes) {
      for (const p of d.owned || []) {
        const f = changes.get(slash(p));
        if (!f) continue;
        const b = badgeOf(f);
        if (/\/doc\.aibdoc$/.test(slash(p))) st = b.status === 'A' ? 'A' : b.status === 'D' ? 'D' : st || 'M';
        else st = st || 'M';
      }
    } else if (entry && (Number(entry.changed) > 0 || entry.status)) st = 'M';
    return st ? { status: st, added: 0, removed: 0, text: st } : null;
  }
  const docRow = (d, depth, changes, entry) => ({
    kind: 'doc',
    path: slash(d.dir),
    name: d.title || d.name,
    doc: d,
    pages: Math.max(1, Number(d.pages) || 1),
    depth,
    ignored: false,
    open: false,
    canOpen: false,
    badge: docBadge(d, changes, entry),
    // the agent writing it right now ({name, page, section}), for the live dot
    writing: Array.isArray(d.writing) && d.writing.length ? d.writing[0] : null,
    changed: 0,
    artifact: false,
  });
  const DOCS_FOLDER = 'aib-docs';
  // How many docs aib-docs holds (its direct sub-folders that are docs), from docIndex().
  const docsIn = (docs) => Array.from(docs.byDir.keys()).filter((d) => d.indexOf(DOCS_FOLDER + '/') === 0 && d.indexOf('/', DOCS_FOLDER.length + 1) < 0).length;
  // The aib-docs row's count: "3 docs", "3 docs · 1 changed", "1 changed" while the docs are not listed yet; '' for nothing.
  function docsFolderCount(docCount, changed) {
    const parts = [];
    if (docCount > 0) parts.push(docCount + (docCount === 1 ? ' doc' : ' docs'));
    if (changed > 0) parts.push(changed + ' changed');
    return parts.join(' · ');
  }
  const NEW_DOC = DOCS_FOLDER + '/+new-doc';

  // ---- the tree -----------------------------------------------------------------------------------------------------------
  // cache: {dir -> entries[] | 'loading' | {error}}, open: Set of open folders. Entries come from /api/live/files/list.
  // Returns the rows on screen, depth-first, with depth. An ignored folder opens only with showIgnored. Folders not listed yet
  // that are open give a "loading" row. changes: changesMap() (badges and counts come from it when given).
  function treeRows(cache, open, opts) {
    const o = opts || {},
      out = [],
      changes = o.changes || null,
      arts = o.artifacts || null,
      docs = o.docs || null; // docIndex()
    const walk = (dir, depth) => {
      const list = cache[dir];
      if (list === 'loading' || list === undefined) {
        if (depth > 0 || list === 'loading') out.push({ kind: 'loading', path: dir + '/…', depth });
        return;
      }
      if (list && list.error) {
        out.push({ kind: 'error', path: dir + '/!', depth, text: list.error });
        return;
      }
      // aib-docs is always the first row of the tree, above every other folder (dot-folders too). No aib-docs folder yet: it shows
      // as an empty folder holding only "+ New doc", first all the same.
      const virt = dir === '' && o.newDoc && !list.some((e) => e.dir && e.path === DOCS_FOLDER);
      const isDocsDir = (e) => dir === '' && e.dir && e.path === DOCS_FOLDER;
      const entries = dir === '' ? list.filter(isDocsDir).concat(list.filter((e) => !isDocsDir(e))) : list;
      let virtDone = !virt;
      const virtRow = () => {
        virtDone = true;
        const isOpen = open.has(DOCS_FOLDER);
        out.push({
          docsFolder: true,
          docCount: docs ? docsIn(docs) : 0,
          kind: 'dir',
          path: DOCS_FOLDER,
          name: DOCS_FOLDER,
          depth,
          ignored: false,
          open: isOpen,
          canOpen: true,
          virtual: true,
          badge: null,
          changed: 0,
          artifact: false,
        });
        if (isOpen) out.push({ kind: 'newdoc', path: NEW_DOC, depth: depth + 1 });
      };
      if (!virtDone) virtRow();
      for (const e of entries) {
        if (docs && docs.owned.has(slash(e.path))) continue;
        // a doc's folder: one doc row, no caret, never expands
        const d = docs && e.dir ? docs.byDir.get(slash(e.path)) : null;
        if (d) {
          out.push(docRow(d, depth, changes, e));
          continue;
        }
        const isOpen = !!e.dir && open.has(e.path) && (!e.ignored || o.showIgnored);
        const row = {
          kind: e.dir ? 'dir' : 'file',
          path: e.path,
          name: e.name,
          depth,
          ignored: !!e.ignored,
          open: isOpen,
          canOpen: !!e.dir && (!e.ignored || !!o.showIgnored),
          badge: null,
          changed: 0,
          artifact: false,
        };
        if (e.dir) row.changed = changes ? changedBelow(changes, e.path) : Number(e.changed) || 0;
        if (isDocsDir(e)) Object.assign(row, { docsFolder: true, docCount: docs ? docsIn(docs) : 0 });
        else {
          row.badge = changes ? badgeOf(changes.get(e.path)) : letterBadge(e.status);
          row.artifact = !!(arts && arts.has(e.path));
        }
        out.push(row);
        if (isOpen) walk(e.path, depth + 1);
      }
      // the last row inside aib-docs
      if (dir === DOCS_FOLDER && o.newDoc) out.push({ kind: 'newdoc', path: NEW_DOC, depth });
    };
    walk('', 0);
    return out;
  }
  // The filter and the Changed toggle turn the tree into a flat list: one row per file with its folder after the name.
  // A doc's files become its one doc row (once); `o.docs`: docIndex().
  function flatRows(paths, opts) {
    const o = opts || {},
      changes = o.changes || null,
      arts = o.artifacts || null,
      docs = o.docs || null,
      seen = new Set(),
      out = [];
    for (const p of paths || []) {
      const path = slash(p),
        d = docs ? docs.owned.get(path) : null;
      if (d) {
        if (!seen.has(d.dir)) out.push(Object.assign(docRow(d, 0, changes, null), { folder: '' }));
        seen.add(d.dir);
        continue;
      }
      out.push(fileRow(path));
    }
    return out;
    function fileRow(path) {
      return {
        kind: 'file',
        path,
        name: nameOf(path),
        folder: dirOf(path),
        depth: 0,
        ignored: false,
        open: false,
        canOpen: false,
        badge: changes ? badgeOf(changes.get(path)) : null,
        changed: 0,
        artifact: !!(arts && arts.has(path)),
      };
    }
  }
  const changedPaths = (map) => Array.from((map || new Map()).keys()).sort((a, b) => a.localeCompare(b));
  // Where a query matches inside a name, for <mark>: [before, hit, after] or null.
  function markHit(name, q) {
    const n = String(name || ''),
      at = q ? n.toLowerCase().indexOf(String(q).toLowerCase().trim()) : -1;
    return at >= 0 && q.trim() ? [n.slice(0, at), n.slice(at, at + q.trim().length), n.slice(at + q.trim().length)] : null;
  }

  // Arrow keys on the tree. rows: treeRows() output; sel: the selected path. Returns {sel, toggle, open, close, activate}.
  function keyMove(rows, sel, key) {
    const list = (rows || []).filter((r) => r.kind === 'dir' || r.kind === 'file' || r.kind === 'doc' || r.kind === 'newdoc');
    if (!list.length) return { sel: '' };
    let i = list.findIndex((r) => r.path === sel);
    const cur = list[i];
    if (key === 'ArrowDown') return { sel: list[Math.min(list.length - 1, i + 1)].path };
    if (key === 'ArrowUp') return { sel: list[Math.max(0, i < 0 ? 0 : i - 1)].path };
    if (key === 'Home') return { sel: list[0].path };
    if (key === 'End') return { sel: list[list.length - 1].path };
    if (!cur) return { sel: list[0].path };
    if (key === 'ArrowRight') {
      if (cur.kind === 'dir' && cur.canOpen && !cur.open) return { sel: cur.path, open: cur.path };
      if (cur.kind === 'dir' && cur.open && list[i + 1] && list[i + 1].depth > cur.depth) return { sel: list[i + 1].path };
      return { sel: cur.path };
    }
    if (key === 'ArrowLeft') {
      if (cur.kind === 'dir' && cur.open) return { sel: cur.path, close: cur.path };
      for (i = i - 1; i >= 0; i--) if (list[i].depth < cur.depth) return { sel: list[i].path };
      return { sel: cur.path };
    }
    if (key === 'Enter') return cur.kind === 'dir' ? { sel: cur.path, toggle: cur.path } : { sel: cur.path, activate: cur.path };
    return { sel: cur.path };
  }

  // ---- scope ---------------------------------------------------------------------------------------------------------------
  // Which folder the tree shows. Following the open chat: its own copy (a worktree) when it has one, else the project folder.
  // A scope is {id: chat id for the routes, root: 'chat' | 'main', label, branch, chatKey}.
  // chat: {key, id, title, branch, cwd} of the open chat (or null); others: the project's other chats with their own copies.
  function followScope(chat, projectPath) {
    if (!chat || !chat.id) return null;
    if (chat.branch) return { id: chat.id, root: 'chat', label: 'Copy', branch: chat.branch, chatKey: chat.key, title: chat.title };
    return { id: chat.id, root: 'main', label: 'Folder', branch: '', chatKey: chat.key, title: chat.title, path: projectPath || chat.cwd || '' };
  }
  // With no chat in the project: its own folder, shown through the project route (no chat id). {id: 'project:<path>', root: 'project', path}.
  function projectScope(projectPath) {
    const p = String(projectPath || '');
    if (!p) return null;
    return { id: 'project:' + p, root: 'project', label: 'Folder', branch: '', chatKey: '', title: '', path: p };
  }
  // The query of a Files request for a scope: a project folder is asked by its path, every other scope by its chat.
  const scopeArgs = (s) => (s.root === 'project' ? { root: 'project', project: s.path } : { id: s.id, root: s.root });
  const scopeId = (s) => (s ? s.id + '|' + s.root : '');
  // The scope menu: this chat's copy, the main folder, other chats' copies, and "Follow the open chat".
  function scopeMenu(chat, projectPath, others, current, following) {
    const out = [];
    const cur = scopeId(current);
    if (chat && chat.id && chat.branch) {
      const s = { id: chat.id, root: 'chat', label: 'Copy', branch: chat.branch, chatKey: chat.key, title: chat.title };
      out.push({ kind: 'scope', text: "This chat's copy", sub: chat.branch, scope: s, on: scopeId(s) === cur });
    }
    const mainChat = chat && chat.id ? chat : (others || [])[0];
    if (!(mainChat && mainChat.id) && projectPath) {
      const s = projectScope(projectPath);
      out.push({ kind: 'scope', text: 'Project folder', sub: projectPath, scope: s, on: scopeId(s) === cur });
    } else if (mainChat && mainChat.id) {
      const s = { id: mainChat.id, root: 'main', label: 'Folder', branch: '', chatKey: mainChat.key, title: mainChat.title, path: projectPath };
      out.push({ kind: 'scope', text: 'Main folder', sub: projectPath || '', scope: s, on: scopeId(s) === cur });
    }
    const copies = (others || []).filter((o) => o && o.id && o.branch && (!chat || o.key !== chat.key));
    if (copies.length) {
      out.push({ kind: 'head', text: "Other chats' copies" });
      for (const o of copies) {
        const s = { id: o.id, root: 'chat', label: 'Copy', branch: o.branch, chatKey: o.key, title: o.title };
        out.push({ kind: 'scope', text: o.title || 'Chat', sub: o.branch, scope: s, on: scopeId(s) === cur });
      }
    }
    out.push({ kind: 'sep' });
    out.push({ kind: 'follow', text: 'Follow the open chat', on: !!following });
    return out;
  }
  // The scope button's text: "Copy ⎇ branch" or "Folder name".
  function scopeLabel(s) {
    if (!s) return { lbl: 'Folder', name: 'No chat open' };
    if (s.branch) return { lbl: 'Copy', name: '\u2387 ' + s.branch };
    const p = slash(s.path || '').replace(/\/+$/, '');
    return { lbl: 'Folder', name: p.slice(p.lastIndexOf('/') + 1) || p || 'Project folder' };
  }

  // ---- file tabs -----------------------------------------------------------------------------------------------------------
  // Per project: {tabs: [{id, path, scope, preview, name}], active: id | ''}. A single click opens a preview tab (italic) that the
  // next single click replaces; a double-click, "Keep open" or opening the same file again keeps it.
  const tabId = (scope, path) => scopeId(scope) + '|' + slash(path);
  function emptyTabs() {
    return { tabs: [], active: '' };
  }
  // A doc tab: one per doc in a project (whichever chat opened it); `doc`: {name, title, page}. path = the doc's folder.
  const docTabId = (name) => 'doc|' + String(name || '');
  function openDocTab(st, scope, d, opts) {
    const o = opts || {},
      id = docTabId(d.name),
      tabs = (st.tabs || []).slice();
    const at = tabs.findIndex((t) => t.id === id);
    if (at >= 0) {
      const t = Object.assign({}, tabs[at], { doc: Object.assign({}, tabs[at].doc, d.page ? { page: d.page } : {}) });
      if (o.keep) t.preview = false;
      tabs[at] = t;
      return { tabs, active: id };
    }
    const tab = {
      id,
      kind: 'doc',
      path: slash(d.dir || DOCS_FOLDER + '/' + d.name),
      name: d.title || d.name,
      scope,
      preview: !o.keep,
      line: 0,
      doc: { name: d.name, title: d.title || d.name, page: d.page || '' },
    };
    const prev = o.keep ? -1 : tabs.findIndex((t) => t.preview);
    if (prev >= 0) tabs[prev] = tab;
    else tabs.push(tab);
    return { tabs, active: id };
  }
  function openTab(st, scope, path, opts) {
    const o = opts || {},
      id = tabId(scope, path),
      tabs = (st.tabs || []).slice();
    const at = tabs.findIndex((t) => t.id === id);
    if (at >= 0) {
      if (o.keep && tabs[at].preview) tabs[at] = Object.assign({}, tabs[at], { preview: false });
      return { tabs, active: id };
    }
    const tab = { id, path: slash(path), name: nameOf(path), scope, preview: !o.keep, line: o.line || 0 };
    const prev = o.keep ? -1 : tabs.findIndex((t) => t.preview);
    if (prev >= 0) tabs[prev] = tab;
    else tabs.push(tab);
    return { tabs, active: id };
  }
  function keepTab(st, id) {
    return { tabs: (st.tabs || []).map((t) => (t.id === id ? Object.assign({}, t, { preview: false }) : t)), active: st.active };
  }
  function closeTab(st, id) {
    const tabs = (st.tabs || []).slice(),
      at = tabs.findIndex((t) => t.id === id);
    if (at < 0) return { state: st, next: st.active };
    tabs.splice(at, 1);
    const next = st.active === id ? (tabs[at] || tabs[at - 1] || { id: '' }).id : st.active;
    return { state: { tabs, active: next }, next };
  }

  // ---- links in replies ----------------------------------------------------------------------------------------------------
  // Path-shaped words in a reply: with a folder (a/b.c, C:\x\y, ./z) or a file name with an extension (notes.md), optionally
  // followed by :line or :line:col. Never inside a URL or a longer word. Returns [{at, len, path, line}].
  const PATH_RE =
    /(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|[\\/])?(?:[\w.\-@+]+[\\/])*[\w\-@+][\w.\-@+]*\.[A-Za-z0-9]{1,12}(?::(\d{1,7})(?::\d{1,5})?)?(?![\w\-\\/])|(?:[A-Za-z]:[\\/]|\.{1,2}[\\/])?(?:[\w.\-@+]+[\\/])+[\w\-@+][\w.\-@+]*(?::(\d{1,7}))?(?![\w\-\\/.])/g;
  function pathCandidates(text) {
    const s = String(text == null ? '' : text),
      out = [];
    PATH_RE.lastIndex = 0;
    let m;
    while ((m = PATH_RE.exec(s))) {
      if (!m[0]) {
        PATH_RE.lastIndex++;
        continue;
      }
      let v = m[0];
      const at = m.index,
        before = s.slice(Math.max(0, at - 200), at);
      if (/[a-z][a-z0-9+.\-]*:\/*\S*$/i.test(before) || /[\w@]$/.test(before)) continue; // in a URL or a longer word
      let line = Number(m[1] || m[2] || 0) || 0;
      const lineAt = v.search(/:\d+(?::\d+)?$/);
      const path = lineAt > 1 ? v.slice(0, lineAt) : v;
      if (lineAt <= 1) line = 0;
      // a trailing dot is the end of the sentence
      if (/\.$/.test(path)) v = v.replace(/\.$/, '');
      if (/^\d+(\.\d+)+$/.test(path)) continue; // a version number
      out.push({ at, len: v.length, text: v, path: path.replace(/\.$/, ''), line });
    }
    return out;
  }
  // The same file named twice in one paragraph is linked once: keep the first of each (case-insensitive on Windows paths).
  function dedupe(cands, rootDir) {
    const seen = new Set(),
      out = [];
    for (const c of cands || []) {
      const rel = relTo(c.path, rootDir);
      const k = rel === null ? null : isWinPath(rootDir) ? rel.toLowerCase() : rel;
      if (k === null || seen.has(k)) continue;
      seen.add(k);
      out.push(Object.assign({}, c, { rel }));
    }
    return out;
  }

  // At window widths of 1280 px and more a clicked path opens beside the chat; below that as a tab.
  const BESIDE_MIN = 1280;
  const opensBeside = (width) => Number(width) >= BESIDE_MIN;
  const MAX_TEXT = 1024 * 1024;

  const api = {
    MINUS,
    BESIDE_MIN,
    MAX_TEXT,
    slash,
    dirOf,
    nameOf,
    relTo,
    changesMap,
    badgeOf,
    letterBadge,
    changedBelow,
    treeRows,
    flatRows,
    changedPaths,
    markHit,
    keyMove,
    followScope,
    projectScope,
    scopeArgs,
    scopeId,
    scopeMenu,
    scopeLabel,
    tabId,
    docIndex,
    docBadge,
    NEW_DOC,
    DOCS_FOLDER,
    docsFolderCount,
    docTabId,
    openDocTab,
    emptyTabs,
    openTab,
    keepTab,
    closeTab,
    pathCandidates,
    dedupe,
    opensBeside,
  };
  root.AgentFilesState = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
