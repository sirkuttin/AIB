'use strict';
/* Changes tab (phase 2, read-only): the right column gets "Activity | Changes N" tabs. Changes lists what git sees as uncommitted
   for the chat's folder and shows each file as an accordion row that opens its own unified diff right under it (several can be open). Data comes from GET /api/live/changes and /changes/file
   (changes.py). No polling unless the Changes tab is visible and the agent is working. The pure helpers at the top have node tests. */
(function (root) {
  const TABS = ['activity', 'changes', 'artifacts'];
  const MINUS = '\u2212';
  const num = (v) => Math.max(0, Number(v) || 0);

  /* ---- pure helpers ------------------------------------------------------------------------------------------------- */
  /* "@@ -39,6 +41,8 @@ def f():" -> numbers (a missing count means 1). null when it is not a hunk header. */
  function parseHunkHeader(header) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(String(header || ''));
    if (!m) return null;
    return {
      oldStart: +m[1],
      oldLines: m[2] === undefined ? 1 : +m[2],
      newStart: +m[3],
      newLines: m[4] === undefined ? 1 : +m[4],
      section: m[5] || '',
    };
  }
  /* A hunk {header, lines:[' ctx','+add','-del','\\ No newline']} -> display rows with both line numbers. A broken header numbers from 1. */
  function hunkRows(hunk) {
    const h = parseHunkHeader(hunk && hunk.header) || { oldStart: 1, newStart: 1 };
    let o = h.oldStart,
      n = h.newStart;
    const rows = [];
    for (const raw of (hunk && hunk.lines) || []) {
      const c = raw.charAt(0),
        text = raw.slice(1);
      if (c === '+') rows.push({ type: 'add', text, old: null, new: n++ });
      else if (c === '-') rows.push({ type: 'del', text, old: o++, new: null });
      else if (c === '\\') rows.push({ type: 'note', text: raw.replace(/^\\\s?/, ''), old: null, new: null });
      else rows.push({ type: 'ctx', text, old: o++, new: n++ });
    }
    return rows;
  }
  /* Line to open in the editor for a hunk: the first added line; for a pure deletion the line where the text was removed. */
  function openLine(hunk) {
    const rows = hunkRows(hunk),
      add = rows.find((r) => r.type === 'add');
    if (add) return add.new;
    const del = rows.find((r) => r.type === 'del');
    if (del) {
      const before = rows
        .slice(0, rows.indexOf(del))
        .filter((r) => r.new != null)
        .pop();
      return Math.max(1, before ? before.new + 1 : (parseHunkHeader(hunk.header) || { newStart: 1 }).newStart);
    }
    return Math.max(1, (parseHunkHeader(hunk && hunk.header) || { newStart: 1 }).newStart);
  }
  /* Join the repository root and a git path using the root's own separator. */
  function joinPath(rootPath, rel) {
    const r = String(rootPath || ''),
      sep = r.includes('\\') && !r.includes('/') ? '\\' : r.includes('\\') ? '\\' : '/';
    const parts = String(rel || '')
      .split('/')
      .filter(Boolean);
    return r.replace(/[\\/]+$/, '') + sep + parts.join(sep);
  }
  function splitPath(path) {
    const p = String(path || ''),
      i = p.lastIndexOf('/');
    return i < 0 ? { dir: '', base: p } : { dir: p.slice(0, i + 1), base: p.slice(i + 1) };
  }
  const STATUS = {
    M: { label: 'Modified', cls: 'st-M' },
    A: { label: 'Added', cls: 'st-A' },
    D: { label: 'Deleted', cls: 'st-D' },
    R: { label: 'Renamed', cls: 'st-R' },
    U: { label: 'New, not yet tracked', cls: 'st-U' },
    C: { label: 'Conflict', cls: 'st-C' },
  };
  const statusInfo = (letter) => Object.assign({ letter: STATUS[letter] ? letter : 'M' }, STATUS[letter] || STATUS.M);
  /* "+86" / "−21" counts, with a trailing "+" when the file was only partly read. */
  const addText = (f) => '+' + num(f && f.added) + (f && f.partial ? '+' : '');
  const delText = (f) => MINUS + num(f && f.removed);
  /* The server's totals count every changed file, also those past the listed pages (totals.partial: lines of new files that
     were not read are missing, shown as "+N+"). Without them, or once every file is listed, the listed files are counted. */
  function totalsOf(data) {
    const files = (data && data.files) || [],
      t = data && data.totals;
    if (t && typeof t.files === 'number' && t.files > files.length) {
      const out = { files: num(t.files), added: num(t.added), removed: num(t.removed) };
      if (t.partial) out.partial = true;
      return out;
    }
    return {
      files: files.length,
      added: files.reduce((a, f) => a + num(f.added), 0),
      removed: files.reduce((a, f) => a + num(f.removed), 0),
    };
  }
  /* Files the server has not listed yet (its next pages of 300), and the label of the button that lists them. */
  const PAGE = 300;
  const moreLeft = (data) =>
    data && data.git ? Math.max(0, num(data.filesTotal) - ((data.files || []).length || 0)) : 0;
  const moreText = (left) =>
    left
      ? 'Show ' +
        (left > PAGE ? 'the next ' + PAGE : left === 1 ? 'the last file' : 'the last ' + left) +
        ' (' +
        left +
        ' not listed yet)'
      : '';
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
  /* Header chip pieces: "Changes · 4 files +86 −21" (nothing when there are no changes). */
  function chipParts(totals) {
    const t = totals || {};
    if (!num(t.files)) return null;
    return {
      label: 'Changes',
      files: plural(num(t.files), 'file', 'files'),
      added: '+' + num(t.added) + (t.partial ? '+' : ''),
      removed: MINUS + num(t.removed),
    };
  }
  const chipText = (totals) => {
    const c = chipParts(totals);
    return c ? c.label + ' \u00b7 ' + c.files + ' ' + c.added + ' ' + c.removed : '';
  };
  /* Tab badge: only above zero, the true count up to 999. */
  const badge = (n) => {
    n = num(n);
    return n ? (n > 999 ? '999+' : String(n)) : '';
  };
  /* Local docs: a doc is ONE row, "2 pages changed" (GET /api/live/changes `docs`: {doc, dir, title, pages, paths}); its paths are
     not listed as files. */
  const docPagesText = (n) => Math.max(1, num(n)) + (Math.max(1, num(n)) === 1 ? ' page changed' : ' pages changed');
  const docsOfData = (data) => (data && data.git && Array.isArray(data.docs) ? data.docs.filter((d) => d && Array.isArray(d.paths)) : []);
  function splitDocFiles(data) {
    const docs = docsOfData(data),
      owned = new Set();
    const slash = (p) => String(p).split('\\').join('/');
    for (const d of docs) for (const p of d.paths) owned.add(slash(p));
    const files = ((data && data.git && data.files) || []).filter((f) => !owned.has(slash(f.path)));
    return { files, docs, owned };
  }
  /* What the tab badge counts: the other files plus one per doc. */
  function shownCount(data) {
    const t = totalsOf(data),
      s = splitDocFiles(data);
    if (!s.docs.length) return num(t.files);
    const listed = ((data && data.files) || []).length;
    return Math.max(0, num(t.files) - (listed - s.files.length)) + s.docs.length;
  }
  /* The Changes tab only shows what changed: no Merge, no Discard, for any chat (owner, 2026-11-16: "these buttons will never
     exist for anything anymore"). Chat-first: a chat's work is merged by asking its agent (merge_into_project); a helper's lands on
     its own at the main chat's turn end. A chat that works in the project folder (build plan 1.4) gets one fixed header line and
     one fixed footer line (no condition, so nothing toggles [SF 8]). An old chat that still has its own copy (the server sends
     data.worktree, a studio/chat-* branch) keeps the branch view and gets a footer line that points at its agent. chat.folder comes
     from chat.js (an open chat without live.worktree that is not a helper). */
  const FOLDER_SCOPE = 'Project folder';
  const FOLDER_FOOT =
    "Nothing to merge: edits go straight into the project folder, from any chat. Ask the agent to commit or undo.";
  const COPY_FOOT = 'This chat works in its own copy. To bring its work into the project, ask its agent to merge it.';
  const isFolderView = (chat, data) =>
    !!(chat && chat.folder && !chat.discarded && !(data && (data.worktree || data.git === false || data.unknown)));
  /* An old copy chat (not a helper: a helper's work lands by itself) with changes in its branch view. */
  const isCopyView = (data) =>
    !!(data && data.git && data.worktree && /^studio\/(?!helper-)/.test(data.worktree.branch || '') && (data.files || []).length);
  /* The footer of the Changes tab: one read-only status line (the folder line or the copy line). */
  function footer(doc) {
    const make = (tag, cls) => {
      const n = doc.createElement(tag);
      n.className = cls;
      return n;
    };
    const foot = make('div', 'cg-foot'),
      status = make('div', 'cg-foot-status'),
      note = make('span', 'cg-foot-note'),
      folder = make('span', 'cg-foot-folder');
    foot.hidden = true;
    status.setAttribute('role', 'status');
    folder.hidden = true;
    status.append(note, folder);
    foot.append(status);
    return { foot, status, note, folder };
  }
  /* Which folder a Changes reply is about: two chats with the same key see the same files (two chats in the project folder). A reply
     without a root (an older server) is its own. */
  let anon = 0;
  const folderKey = (data) =>
    data && data.root ? [data.scope || '', String(data.root), data.prefix || ''].join('|') : 'anon:' + ++anon;
  /* Narrow strip chip. */
  const stripText = (n) => (num(n) ? num(n) + ' changed' : '');
  /* Notes shown above a diff when the picture is not the whole story. */
  function diffNotes(detail) {
    const notes = [];
    if (!detail) return notes;
    if (detail.binary) notes.push('Binary file: no preview.');
    else if (detail.truncated) notes.push('This diff is long: showing only the first part.');
    else if (!(detail.hunks || []).length)
      notes.push(detail.status === 'D' ? 'The file is empty.' : 'No line changes (a mode change or an empty file).');
    if (!detail.binary && detail.truncated && !(detail.hunks || []).length)
      notes.push('Nothing could be read within the size limit.');
    return notes;
  }
  /* Same file, same numbers: the diff on screen is still current. */
  const fileSignature = (f) =>
    f ? [f.path, f.status, f.added, f.removed, f.binary ? 1 : 0, f.partial ? 1 : 0, f.oldPath || ''].join('|') : '';
  /* Tab state: {tab, expanded}. Expanding only makes sense on the Changes and Artifacts tabs and ends when you leave them. */
  function tabState(prev, action) {
    const s = Object.assign({ tab: 'activity', expanded: false }, prev);
    if (action && action.type === 'show' && TABS.includes(action.tab)) {
      s.tab = action.tab;
      if (action.tab !== 'changes' && action.tab !== 'artifacts') s.expanded = false;
    } else if (action && action.type === 'toggleExpand' && (s.tab === 'changes' || s.tab === 'artifacts'))
      s.expanded = !s.expanded;
    else if (action && action.type === 'subchat' && action.open) {
      s.tab = 'activity';
      s.expanded = false;
    } else if (action && action.type === 'reset') {
      s.tab = 'activity';
      s.expanded = false;
    }
    return s;
  }
  /* Poll every 10 s only while you are looking at Changes and the agent works, or, for a chat in the project folder (shared: any
     chat's edits land there and show here), while you are looking at Changes at all. */
  const shouldPoll = (o) => !!(o && o.tab === 'changes' && o.visible && (o.busy || o.shared));
  /* A refresh is due when a turn just ended (busy true -> false). */
  const turnEnded = (was, now) => !!was && !now;
  /* Accordion state: the list of open file paths. Toggling adds or removes one; pruning drops files that left the list. */
  const toggleOpen = (open, path) => {
    const o = (open || []).filter((p) => p !== path);
    if (o.length === (open || []).length) o.push(path);
    return o;
  };
  const pruneOpen = (open, files) => {
    const have = new Set((files || []).map((f) => f.path));
    return (open || []).filter((p) => have.has(p));
  };
  const pure = {
    folderKey,
    moreLeft,
    moreText,
    docPagesText,
    splitDocFiles,
    shownCount,
    toggleOpen,
    pruneOpen,
    TABS,
    parseHunkHeader,
    hunkRows,
    openLine,
    joinPath,
    splitPath,
    statusInfo,
    addText,
    delText,
    totalsOf,
    chipParts,
    chipText,
    badge,
    stripText,
    diffNotes,
    fileSignature,
    tabState,
    shouldPoll,
    turnEnded,
  };

  /* ---- page part --------------------------------------------------------------------------------------------------- */
  let live = null;
  function init(win) {
    win = win || root;
    const doc = win.document;
    const pane = doc.getElementById('subagentsPane'),
      body = doc.body;
    if (!pane || pane.dataset.changesUi) return;
    pane.dataset.changesUi = '1';
    const $ = (id) => doc.getElementById(id);
    const el = (tag, cls, txt) => {
      const n = doc.createElement(tag);
      if (cls) n.className = cls;
      if (txt != null) n.textContent = txt;
      return n;
    };
    const store = {
      get(k) {
        try {
          return win.localStorage.getItem(k);
        } catch (e) {
          return null;
        }
      },
    };
    const POLL_MS = 10000,
      MIN_GAP = 1200;
    let state = { tab: 'activity', expanded: false };
    let chat = { id: '', busy: false };
    /* The tab each chat last showed (Activity / Changes / Artifacts), for this run of the app: coming back to a chat shows the tab
       you left it on (owner, 2026-11-15: back from another chat, Artifacts had turned into Activity). */
    const tabOf = new Map();
    let data = null,
      loadedFor = '',
      error = '',
      seq = 0,
      lastFetch = 0,
      timer = 0,
      loading = false;
    let open = [],
      cache = new Map(),
      detailSeq = 0,
      autoOpened = false,
      token = '',
      pages = 1,
      loadingMore = false;
    const editors = () => {
      const e = win.AgentEditors;
      return e && typeof e.open === 'function' ? e : null;
    };

    /* -- tab row -- */
    const tabs = el('div', 'pane-tabs');
    tabs.id = 'paneTabs';
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'Right column');
    const tabBtn = (id, label) => {
      const b = el('button', 'pane-tab');
      b.type = 'button';
      b.id = 'paneTab-' + id;
      b.setAttribute('role', 'tab');
      b.dataset.tab = id;
      b.append(el('span', 'pane-tab-label', label));
      return b;
    };
    const tabActivity = tabBtn('activity', 'Activity'),
      tabChanges = tabBtn('changes', 'Changes'),
      tabArtifacts = tabBtn('artifacts', 'Artifacts');
    const badgeEl = el('span', 'pane-badge');
    badgeEl.hidden = true;
    tabChanges.append(badgeEl);
    const artBadge = el('span', 'pane-badge');
    artBadge.hidden = true;
    tabArtifacts.append(artBadge);
    const expandBtn = el('button', 'pane-expand', '\u21e4');
    expandBtn.type = 'button';
    expandBtn.title = 'Widen this column';
    expandBtn.setAttribute('aria-label', 'Widen this column');
    expandBtn.setAttribute('aria-pressed', 'false');
    expandBtn.hidden = true;
    tabs.append(tabActivity, tabChanges, tabArtifacts, expandBtn);
    pane.insertBefore(tabs, pane.firstChild);

    /* -- changes view -- */
    const view = el('section', 'changes-pane');
    view.id = 'changesPane';
    view.setAttribute('role', 'tabpanel');
    view.setAttribute('aria-labelledby', 'paneTab-changes');
    view.hidden = true;
    const bar = el('div', 'cg-bar');
    const scopeEl = el('span', 'cg-scope', 'Uncommitted'),
      modeEl = el('span', 'cg-mode', 'Unified');
    const refresh = el('button', 'cg-refresh', '\u21bb');
    refresh.type = 'button';
    refresh.title = 'Refresh changes';
    refresh.setAttribute('aria-label', 'Refresh changes');
    const sum = el('span', 'cg-sum');
    bar.append(scopeEl, modeEl, sum, refresh);
    const note = el('p', 'cg-note');
    note.setAttribute('role', 'status');
    note.hidden = true;
    const list = el('div', 'cg-files');
    list.setAttribute('role', 'list');
    /* One footer row: a read-only status line. */
    const parts = footer(doc),
      foot = parts.foot;
    view.append(bar, note, list, foot);
    const bodyEl = $('activityBody');
    bodyEl && bodyEl.nextSibling ? pane.insertBefore(view, bodyEl.nextSibling) : pane.append(view);
    /* Artifacts tab (artifacts-ui.js owns what is inside the panel). */
    const artView = el('section', 'artifacts-pane');
    artView.id = 'artifactsPane';
    artView.setAttribute('role', 'tabpanel');
    artView.setAttribute('aria-labelledby', 'paneTab-artifacts');
    artView.hidden = true;
    pane.insertBefore(artView, view.nextSibling);
    const AR = () =>
      win.AgentArtifactsUI && typeof win.AgentArtifactsUI.mount === 'function' ? win.AgentArtifactsUI : null;

    /* -- header chip and narrow strip chip -- */
    const chip = el('button', 'changes-chip');
    chip.type = 'button';
    chip.id = 'changesChip';
    chip.hidden = true;
    chip.title = 'Show the changes in the project folder';
    const actions = doc.querySelector('.header-actions');
    if (actions) actions.insertBefore(chip, actions.firstChild);
    const stripChip = el('span', 'ac-changed');
    stripChip.setAttribute('role', 'button');
    stripChip.tabIndex = 0;
    stripChip.hidden = true;
    stripChip.title = 'Show changes';
    const strip = $('activityStrip');
    if (strip) {
      const chips = $('activityChips');
      chips && chips.nextSibling ? strip.insertBefore(stripChip, chips.nextSibling) : strip.append(stripChip);
    }

    const narrow = () => {
      try {
        return win.matchMedia('(max-width:1099px)').matches;
      } catch (e) {
        return win.innerWidth < 1100;
      }
    };
    const paneVisible = () => !!pane.offsetParent && (!narrow() || pane.classList.contains('open'));

    /* -- network -- */
    async function getToken(force) {
      if (token && !force) return token;
      const r = await win.fetch('/api/live/bootstrap', win.AIBPageAuth ? win.AIBPageAuth.init() : undefined);
      if (!r.ok) throw new Error('AIB is not reachable');
      token = (await r.json()).token || '';
      return token;
    }
    async function api(path, retry) {
      const t = await getToken(!!retry);
      const r = await win.fetch(path, { headers: { 'X-Studio-Token': t } });
      if (r.status === 403 && !retry) return api(path, true);
      let body = {};
      try {
        body = await r.json();
      } catch (e) {}
      if (!r.ok) {
        const e = new Error(body.error || 'Request failed (' + r.status + ')');
        e.status = r.status;
        throw e;
      }
      return body;
    }
    const q = (o) =>
      Object.entries(o)
        .map(([k, v]) => k + '=' + encodeURIComponent(v))
        .join('&');

    /* "Show the next 300": one more page, appended to what is listed. */
    async function loadMore() {
      if (!chat.id || !data || !moreLeft(data) || loadingMore) return;
      const id = chat.id,
        mine = seq,
        before = data.files.length;
      loadingMore = true;
      paintList(true);
      try {
        const more = await api('/api/live/changes?' + q({ id, scope: 'uncommitted', offset: data.files.length }));
        if (mine !== seq || id !== chat.id || !data) return;
        if (more.git && (more.files || []).length) {
          pages++;
          data = Object.assign({}, data, more, { files: data.files.concat(more.files), offset: 0 });
        }
      } catch (e) {
        if (mine === seq) error = e.message;
      } finally {
        loadingMore = false;
      }
      paintAll();
      const ae = doc.activeElement;
      if (!ae || !list.contains(ae)) {
        const first = list.querySelectorAll('.cg-file')[before]; // the first newly listed file, for the keyboard
        if (first) first.focus({ preventScroll: true });
      }
    }
    async function load(force) {
      if (!chat.id) {
        return;
      }
      if (chat.discarded) {
        data = null;
        paintAll();
        return;
      }
      const now = Date.now();
      if (!force && now - lastFetch < MIN_GAP) return;
      lastFetch = now;
      const mine = ++seq,
        id = chat.id;
      loading = true;
      paintBar();
      try {
        const next = await api('/api/live/changes?' + q({ id, scope: 'uncommitted' }));
        if (mine !== seq || id !== chat.id) return;
        /* The pages you asked for with "Show the next 300" stay listed across refreshes. */
        for (let p = 1; p < pages && next.git && moreLeft(next); p++) {
          const more = await api('/api/live/changes?' + q({ id, scope: 'uncommitted', offset: next.files.length }));
          if (mine !== seq || id !== chat.id) return;
          if (!more.git || !(more.files || []).length) break;
          Object.assign(next, more, { files: next.files.concat(more.files), offset: 0 });
        }
        data = next;
        loadedFor = id;
        error = '';
      } catch (e) {
        if (mine !== seq || id !== chat.id) return;
        error = e.status === 404 ? '' : e.message;
        data = e.status === 404 ? { git: null, unknown: true } : null;
        loadedFor = id;
      } finally {
        if (mine === seq) loading = false;
      }
      paintAll();
      if (state.tab === 'changes') ensureOpen();
    }
    /* Lazy: a file's diff is fetched the first time it is opened, and again when its numbers change while it is open. */
    async function loadDetail(f) {
      const path = f.path,
        sig = fileSignature(f),
        id = chat.id,
        mine = ++detailSeq;
      const prev = cache.get(path);
      cache.set(path, { sig, seq: mine, loading: true, d: (prev && prev.d) || null, err: '' });
      paintList();
      let d = null,
        err = '';
      try {
        d = await api('/api/live/changes/file?' + q({ id, path, scope: 'uncommitted' }));
      } catch (e) {
        err = e.message || 'Request failed';
      }
      const cur = cache.get(path);
      if (!cur || cur.seq !== mine || id !== chat.id) return;
      cache.set(path, { sig, seq: mine, loading: false, d: err ? (prev && prev.d) || null : d, err });
      paintList();
    }
    const files = () => splitDocFiles(data).files;
    const needsLoad = (f) => {
      const c = cache.get(f.path);
      return !c || c.sig !== fileSignature(f);
    };
    function ensureOpen() {
      const fs = files();
      open = pruneOpen(open, fs);
      for (const p of [...cache.keys()]) if (!fs.some((f) => f.path === p)) cache.delete(p);
      if (!autoOpened && fs.length) {
        autoOpened = true;
        if (!open.length) open = [fs[0].path];
      }
      for (const f of fs) if (open.includes(f.path) && needsLoad(f)) loadDetail(f);
      paintList();
    }
    function toggle(f) {
      open = toggleOpen(open, f.path);
      autoOpened = true;
      if (open.includes(f.path) && needsLoad(f)) loadDetail(f);
      paintList();
    }

    /* -- painting -- */
    function paintBar() {
      scopeEl.textContent = isFolderView(chat, data)
        ? FOLDER_SCOPE
        : data && data.scope === 'branch'
          ? "This chat's changes"
          : 'Uncommitted';
      scopeEl.title = scopeEl.textContent;
      const t = data && data.git ? totalsOf(data) : null;
      sum.replaceChildren();
      if (t && t.files) {
        sum.append(
          el('span', '', plural(t.files, 'file', 'files') + ' '),
          el('span', 'cg-add', pure.addText({ added: t.added, partial: t.partial })),
          doc.createTextNode(' '),
          el('span', 'cg-del', MINUS + t.removed),
        );
      }
      refresh.disabled = loading;
      refresh.classList.toggle('spin', loading);
    }
    function paintBadges() {
      const t = data && data.git ? totalsOf(data) : null;
      // split view: the files of both panes' chats (the same whichever has focus). Two chats in the project folder see the same
      // files: those count once (folderKey).
      const n = splitOn()
        ? (() => {
            const seen = new Set();
            return SP.keys.reduce((m, k) => {
              const x = SP.secs.get(k),
                key = x && x.data && x.data.git ? folderKey(x.data) : '';
              if (!key || seen.has(key)) return m;
              seen.add(key);
              return m + shownCount(x.data);
            }, 0);
          })()
        : t
          ? shownCount(data)
          : 0;
      badgeEl.textContent = badge(n);
      badgeEl.hidden = !n;
      tabChanges.setAttribute('aria-label', 'Changes' + (n ? ', ' + plural(n, 'file', 'files') + ' changed' : ''));
      const c = chipParts(t);
      chip.replaceChildren();
      if (c) {
        chip.append(
          el('span', '', c.label + ' \u00b7 ' + c.files + ' '),
          el('span', 'cg-add', c.added),
          doc.createTextNode(' '),
          el('span', 'cg-del', c.removed),
        );
      }
      chip.hidden = !c;
      stripChip.textContent = stripText(n);
      stripChip.hidden = !n;
    }
    function paintFoot() {
      const text = isFolderView(chat, data) ? FOLDER_FOOT : isCopyView(data) ? COPY_FOOT : '';
      parts.folder.textContent = text;
      parts.folder.hidden = !text;
      foot.hidden = parts.status.hidden = !text;
    }
    function paintNote() {
      let msg = '';
      if (!chat.id) msg = 'Open a chat to see what it changed.';
      else if (chat.discarded)
        msg = 'This chat’s changes were discarded with its branch: there is nothing left to show.';
      else if (data && data.git === false) msg = 'No git here: the Changes view needs a git repository.';
      else if (data && data.unknown) msg = 'Changes are not available for this chat yet.';
      else if (error) msg = 'Could not read the changes: ' + error;
      else if (!data) msg = 'Reading changes\u2026';
      else if (data.git && !files().length) msg = 'No uncommitted changes.';
      note.textContent = msg;
      note.hidden = !msg;
      /* More files than listed: the button at the end of the list shows the rest. Only when git's own output was cut is there no way on. */
      if (data && data.git && data.truncated && !moreLeft(data)) {
        note.textContent =
          (msg ? msg + ' ' : '') + 'Git reported more changes than AIB can read; some files are not listed.';
        note.hidden = false;
      }
    }
    function rowFor(f) {
      const info = statusInfo(f.status),
        p = splitPath(f.path),
        isOpen = open.includes(f.path);
      const item = el('div', 'cg-item' + (isOpen ? ' open' : ''));
      item.setAttribute('role', 'listitem');
      item.dataset.path = f.path;
      const b = el('button', 'cg-file' + (isOpen ? ' open' : ''));
      b.type = 'button';
      b.dataset.path = f.path;
      b.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      b.title = f.path + (f.oldPath ? '\n(was ' + f.oldPath + ')' : '') + '\n' + info.label;
      const path = el('span', 'cg-path'),
        inner = el('span', 'cg-path-in');
      inner.append(el('span', 'cg-path-dir', p.dir), el('b', '', p.base)); // the folder part shrinks first, the name stays
      path.append(inner);
      const caret = el('span', 'cg-caret', isOpen ? '\u25be' : '\u25b8');
      caret.setAttribute('aria-hidden', 'true');
      b.append(caret, el('span', 'cg-st ' + info.cls, info.letter), path);
      if (f.binary) b.append(el('span', 'cg-bin', 'binary'));
      else b.append(el('span', 'cg-add', addText(f)), el('span', 'cg-del', delText(f)));
      b.onclick = () => toggle(f);
      item.append(b);
      if (isOpen) item.append(bodyFor(f));
      return item;
    }
    let listSig = '';
    /* A doc: one row, "2 pages changed". Clicked, the doc opens in the Artifacts tab; no diff in v1. */
    function rowForDoc(d) {
      const item = el('div', 'cg-item cg-doc');
      item.setAttribute('role', 'listitem');
      item.dataset.doc = d.doc;
      const b = el('button', 'cg-file cg-doc-btn');
      b.type = 'button';
      b.dataset.path = d.dir;
      b.title = (d.title || d.doc) + ' (doc)\n' + docPagesText(d.pages) + '\nClick: open the doc';
      const path = el('span', 'cg-path'),
        inner = el('span', 'cg-path-in');
      inner.append(el('b', '', d.title || d.doc));
      path.append(inner);
      const caret = el('span', 'cg-caret', '');
      caret.setAttribute('aria-hidden', 'true');
      b.append(caret, el('span', 'cg-st cg-st-doc', 'doc'), path, el('span', 'cg-docpages', docPagesText(d.pages)));
      b.onclick = () => {
        const D = win.AgentDocLinks;
        if (D && D.openDoc) D.openDoc({ name: d.doc, title: d.title, chat: { id: chat.id, key: chat.key || '' }, from: 'chat' });
      };
      item.append(b);
      return item;
    }
    function moreRow() {
      const left = moreLeft(data);
      if (!left) return null;
      const b = el('button', 'cg-more', loadingMore ? 'Listing…' : moreText(left));
      b.type = 'button';
      b.disabled = loadingMore;
      b.addEventListener('click', loadMore);
      return b;
    }
    function paintList(force) {
      const fs = files(),
        ds = docsOfData(data);
      const sig = JSON.stringify([
        ds.map((d) => [d.doc, d.title, d.pages, d.paths.length]),
        force ? Math.random() : 0,
        moreLeft(data),
        loadingMore,
        open,
        fs.map(fileSignature),
        fs.map((f) => {
          const c = cache.get(f.path);
          return c ? [c.sig, c.loading ? 1 : 0, c.err, c.d ? 1 : 0] : 0;
        }),
      ]);
      if (sig === listSig) return;
      listSig = sig;
      const top = list.scrollTop,
        ae = doc.activeElement,
        focus = ae && list.contains(ae) ? ae.dataset.path : null;
      const more = moreRow(),
        moreHad = ae && ae.classList && ae.classList.contains('cg-more');
      list.replaceChildren(...ds.map(rowForDoc), ...fs.map(rowFor), ...(more ? [more] : []));
      list.scrollTop = top;
      if (focus) {
        const n = [...list.querySelectorAll('.cg-file')].find((c) => c.dataset.path === focus);
        if (n) n.focus({ preventScroll: true });
      } else if (moreHad && more) more.focus({ preventScroll: true });
      list.hidden = !fs.length && !ds.length;
    }
    function diffRows(h, f, detail) {
      const frag = doc.createDocumentFragment();
      const head = el('div', 'cg-hunk'),
        ph = parseHunkHeader(h.header);
      head.append(
        el(
          'span',
          'cg-hunk-h',
          ph
            ? '@@ -' +
                ph.oldStart +
                ',' +
                ph.oldLines +
                ' +' +
                ph.newStart +
                ',' +
                ph.newLines +
                ' @@' +
                (ph.section ? ' ' + ph.section : '')
            : h.header,
        ),
      );
      const ed = editors(),
        line = openLine(h);
      if (ed && f.status !== 'D' && detail && detail.abs) {
        const b = el('button', 'cg-open', 'Open at line ' + line + ' \u2197');
        b.type = 'button';
        b.title = 'Open this file at line ' + line + ' in your editor';
        b.onclick = () => {
          try {
            ed.open({ path: detail.abs, line });
          } catch (e) {}
        };
        head.append(b);
      }
      frag.append(head);
      for (const r of hunkRows(h)) {
        const row = el('div', 'cg-row cg-' + r.type);
        row.append(
          el('span', 'cg-no', r.old == null ? '' : String(r.old)),
          el('span', 'cg-no', r.new == null ? '' : String(r.new)),
          el('span', 'cg-sign', r.type === 'add' ? '+' : r.type === 'del' ? MINUS : r.type === 'note' ? '' : ' '),
          el('span', 'cg-text', r.text),
        );
        frag.append(row);
      }
      return frag;
    }
    /* The body under an open row: no heading of its own, the row is the heading. */
    function bodyFor(f) {
      const box = el('div', 'cg-diff'),
        c = cache.get(f.path);
      if (f.oldPath) box.append(el('p', 'cg-was', 'was ' + f.oldPath));
      if (!c || (c.loading && !c.d)) {
        box.append(el('p', 'cg-msg', 'Loading\u2026'));
        return box;
      }
      if (c.err && !c.d) {
        box.append(el('p', 'cg-msg cg-err', 'Could not read this diff: ' + c.err));
        return box;
      }
      const detail = c.d || {};
      if (detail.error) {
        box.append(el('p', 'cg-msg cg-err', 'Could not read this diff: ' + detail.error));
        return box;
      }
      for (const n of diffNotes(detail)) box.append(el('p', 'cg-msg', n));
      const scroll = el('div', 'cg-lines');
      for (const h of detail.hunks || []) scroll.append(diffRows(h, f, detail));
      if ((detail.hunks || []).length) box.append(scroll);
      return box;
    }
    function paintAll() {
      paintBadges();
      paintBar();
      paintNote();
      paintFoot();
      listSig = '';
      paintList();
    }

    /* -- tabs, expand, polling -- */
    function apply() {
      const on = state.tab === 'changes',
        art = state.tab === 'artifacts',
        wide = on || art;
      pane.classList.toggle('tab-changes', on);
      pane.classList.toggle('tab-artifacts', art);
      for (const [b, sel] of [
        [tabActivity, !on && !art],
        [tabChanges, on],
        [tabArtifacts, art],
      ]) {
        b.setAttribute('aria-selected', sel ? 'true' : 'false');
        b.tabIndex = sel ? 0 : -1;
        b.classList.toggle('active', sel);
      }
      view.hidden = !on;
      artView.hidden = !art;
      expandBtn.hidden = !wide || narrow();
      expandBtn.setAttribute('aria-pressed', state.expanded ? 'true' : 'false');
      expandBtn.title = state.expanded ? 'Narrow this column again' : 'Widen this column';
      expandBtn.setAttribute('aria-label', expandBtn.title);
      expandBtn.textContent = state.expanded ? '⇥' : '⇤'; // QA m8: widen pulls the edge left, narrow pushes it back
      body.classList.toggle('changes-wide', wide && state.expanded && !narrow());
      body.classList.toggle('rc-other-tab', wide); // resize-ui.js: an open subagent history no longer widens the column here
      if (AR()) AR().setVisible(art && paneVisible());
      schedule();
      if (SP) spSchedule();
    }
    function show(tab) {
      const was = state.tab;
      state = tabState(state, { type: 'show', tab });
      apply();
      if (tab === 'changes' && was !== 'changes') {
        paintAll();
        load(true);
      }
      if (tab === 'artifacts' && was !== 'artifacts' && AR()) AR().shown();
    }
    function schedule() {
      const poll = () => shouldPoll({ tab: state.tab, visible: paneVisible(), busy: chat.busy, shared: isFolderView(chat, data) });
      const want = poll();
      if (want && !timer)
        timer = win.setInterval(() => {
          if (poll()) load(true);
          else schedule();
        }, POLL_MS);
      else if (!want && timer) {
        win.clearInterval(timer);
        timer = 0;
      }
    }
    /* Make the column and the Changes tab visible from a chip. */
    function reveal(tab) {
      tab = TABS.includes(tab) ? tab : 'changes';
      const A = win.ActivityUI;
      if (A && A.isHidden && A.isHidden()) A.setHidden(false);
      if (narrow()) {
        pane.classList.add('open');
        if (strip) strip.setAttribute('aria-expanded', 'true');
      }
      show(tab);
      ({ activity: tabActivity, changes: tabChanges, artifacts: tabArtifacts })[tab].focus({ preventScroll: true });
    }
    tabActivity.addEventListener('click', () => show('activity'));
    tabChanges.addEventListener('click', () => show('changes'));
    tabArtifacts.addEventListener('click', () => show('artifacts'));
    tabs.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
      const at = TABS.indexOf(state.tab),
        next =
          e.key === 'Home'
            ? TABS[0]
            : e.key === 'End'
              ? TABS[TABS.length - 1]
              : TABS[Math.max(0, Math.min(TABS.length - 1, at + (e.key === 'ArrowLeft' ? -1 : 1)))];
      e.preventDefault();
      show(next);
      ({ activity: tabActivity, changes: tabChanges, artifacts: tabArtifacts })[next].focus();
    });
    expandBtn.addEventListener('click', () => {
      state = tabState(state, { type: 'toggleExpand' });
      apply();
    });
    refresh.addEventListener('click', () => load(true));
    chip.addEventListener('click', () => reveal('changes'));
    stripChip.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      reveal('changes');
    });
    stripChip.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.stopPropagation();
        e.preventDefault();
        reveal();
      }
    });
    /* A subagent history opens inside the Activity tab: opening one shows that tab. Only the moment it opens counts; while it
       stays open you can switch to Changes or Artifacts (CSS hides it there) and come back to it, so later class changes on
       <body> must not pull you back to Activity. chat.js also calls show('activity') when it opens a history. */
    let subchatWas = body.classList.contains('subchat-open');
    if (typeof win.MutationObserver === 'function') {
      new win.MutationObserver(() => {
        const now = body.classList.contains('subchat-open'),
          opened = now && !subchatWas;
        subchatWas = now;
        if (opened && state.tab !== 'activity') {
          state = tabState(state, { type: 'subchat', open: true });
          apply();
        }
      }).observe(body, { attributes: true, attributeFilter: ['class'] });
      const chatEl = $('chat');
      if (chatEl)
        new win.MutationObserver(() => {
          if (chatEl.hidden) sync(null);
        }).observe(chatEl, { attributes: true, attributeFilter: ['hidden'] });
    }
    doc.addEventListener('keydown', (e) => {
      if (
        e.key === 'Escape' &&
        state.expanded &&
        (state.tab === 'changes' || state.tab === 'artifacts') &&
        !e.defaultPrevented &&
        doc.activeElement &&
        pane.contains(doc.activeElement)
      ) {
        state = tabState(state, { type: 'toggleExpand' });
        apply();
      }
    });
    win.addEventListener('resize', () => apply());
    if (win.matchMedia) {
      try {
        win.matchMedia('(max-width:1099px)').addEventListener('change', apply);
      } catch (e) {}
    }

    /* -- chat.js feeds this on every header render: {id, busy} for the open chat, or null -- */
    function sync(ctx) {
      const id = ctx && typeof ctx.id === 'string' ? ctx.id : '',
        busy = !!(ctx && ctx.busy),
        discarded = !!(ctx && ctx.discarded),
        folder = !!(ctx && ctx.folder);
      const prevId = chat.id,
        changed = id !== chat.id,
        ended = turnEnded(chat.busy, busy),
        gone = discarded && !chat.discarded && !changed,
        refiled = folder !== !!chat.folder && !changed;
      chat = { id, busy, discarded, folder };
      if (refiled && !gone) paintAll();
      if (gone) {
        data = null; // the branch is gone: the Changes view says so instead of "not available yet"
        paintAll();
      }
      if (AR()) AR().sync(id ? { id, busy, cwd: ctx && typeof ctx.cwd === 'string' ? ctx.cwd : '' } : null);
      if (changed) {
        seq++;
        detailSeq++;
        data = null;
        loadedFor = '';
        error = '';
        open = [];
        cache = new Map();
        pages = 1;
        autoOpened = false;
        listSig = '';
        lastFetch = 0;
        if (prevId) tabOf.set(prevId, state.tab);
        const back = id ? tabOf.get(id) : '';
        // Split view: moving focus between the panes opens the other chat here, and changes nothing in the panel (owner,
        // 2026-11-15): the tab stays as it is.
        if (!SUI()) {
          state = tabState(state, { type: 'reset' });
          if (back && back !== 'activity') state = tabState(state, { type: 'show', tab: back });
        }
        apply();
        paintAll();
        if (id) load(true);
        if (state.tab === 'artifacts' && AR()) AR().shown();
      } else if (ended && id) load(true);
      schedule();
    }
    /* -- split view: both panes' chats, in pane order, each with its header, its files and a read-only summary line (option B of
       the approved mockup, owner 2026-11-15). Nothing here follows focus: each section reads its own chat's changes. -- */
    var SP = { keys: [], secs: new Map(), timer: 0 }; // var: paintBadges / apply may run before this line
    const spBox = el('div', 'sp-changes');
    spBox.id = 'splitChanges';
    view.append(spBox);
    function SUI() {
      return win.AgentSplitUI && win.AgentSplitUI.active && win.AgentSplitUI.active() ? win.AgentSplitUI : null;
    }
    function splitOn() {
      return !!SP && SP.keys.length > 0;
    }
    function spSection(key) {
      let s = SP.secs.get(key);
      if (s) return s;
      const rootEl = el('section', 'sp-grp sp-cg');
      rootEl.dataset.key = key;
      const head = el('div', 'sp-head'),
        lst = el('div', 'cg-files sp-files'),
        none = el('p', 'sp-none', 'No changes in this chat yet');
      lst.setAttribute('role', 'list');
      const fp = footer(doc);
      fp.foot.classList.add('sp-foot');
      rootEl.append(head, lst, none, fp.foot);
      s = { key, root: rootEl, head, list: lst, none, fp, data: null, err: '', open: [], cache: new Map(), seq: 0, id: '' };
      SP.secs.set(key, s);
      return s;
    }
    const spFiles = (s) => (s.data && s.data.git ? splitDocFiles(s.data).files : []);
    /* A section's count: every changed file, also those past the first page of 300 the section lists (the tab badge's count). */
    const spCount = (s) => (s.data && s.data.git ? shownCount(s.data) : 0);
    function spSumLine(s) {
      const fs = spFiles(s),
        t = totalsOf(s.data);
      let a = 0,
        d = 0;
      for (const f of fs) {
        a += num(f.added);
        d += num(f.removed);
      }
      if (t.files > ((s.data && s.data.files) || []).length) {
        a = num(t.added);
        d = num(t.removed);
      }
      const base = (s.data && s.data.worktree && s.data.worktree.base) || '';
      return plural(spCount(s), 'file', 'files') + ' · +' + a + (t.partial ? '+' : '') + ' ' + MINUS + d + (base ? ' vs ' + base : '');
    }
    function spFoot(s) {
      const fs = spFiles(s),
        fp = s.fp;
      fp.note.textContent = fs.length ? spSumLine(s) : '';
      // No summary row for a chat with nothing changed.
      fp.foot.hidden = fp.status.hidden = !fs.length;
    }
    function spRow(s, f) {
      const info = statusInfo(f.status),
        p = splitPath(f.path),
        isOpen = s.open.includes(f.path);
      const item = el('div', 'cg-item' + (isOpen ? ' open' : ''));
      item.setAttribute('role', 'listitem');
      item.dataset.path = f.path;
      const b = el('button', 'cg-file' + (isOpen ? ' open' : ''));
      b.type = 'button';
      b.dataset.path = f.path;
      b.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      b.title = f.path + (f.oldPath ? '\n(was ' + f.oldPath + ')' : '') + '\n' + info.label;
      const path = el('span', 'cg-path'),
        inner = el('span', 'cg-path-in');
      inner.append(el('span', 'cg-path-dir', p.dir), el('b', '', p.base));
      path.append(inner);
      const caret = el('span', 'cg-caret', isOpen ? '▾' : '▸');
      caret.setAttribute('aria-hidden', 'true');
      b.append(caret, el('span', 'cg-st ' + info.cls, info.letter), path);
      if (f.binary) b.append(el('span', 'cg-bin', 'binary'));
      else b.append(el('span', 'cg-add', addText(f)), el('span', 'cg-del', delText(f)));
      b.onclick = () => {
        s.open = toggleOpen(s.open, f.path);
        if (s.open.includes(f.path)) spDetail(s, f);
        spPaint(s);
      };
      item.append(b);
      if (isOpen) {
        const box = el('div', 'cg-diff'),
          c = s.cache.get(f.path);
        if (!c || (c.loading && !c.d)) box.append(el('p', 'cg-msg', 'Loading…'));
        else if (c.err && !c.d) box.append(el('p', 'cg-msg cg-err', 'Could not read this diff: ' + c.err));
        else {
          for (const n of diffNotes(c.d)) box.append(el('p', 'cg-msg', n));
          const sc = el('div', 'cg-lines');
          for (const h of c.d.hunks || []) sc.append(diffRows(h, f, c.d));
          if ((c.d.hunks || []).length) box.append(sc);
        }
        item.append(box);
      }
      return item;
    }
    /* Fetched when a file opens, and again when its numbers change while it is open (as with one chat): the diff on screen
       stays the one shown until the new one is in, so nothing flashes "Loading…". */
    async function spDetail(s, f) {
      const sig = fileSignature(f),
        id = s.id,
        prev = s.cache.get(f.path),
        mine = (s.dseq = (s.dseq || 0) + 1);
      s.cache.set(f.path, { sig, seq: mine, loading: true, d: (prev && prev.d) || null, err: '' });
      let d = null,
        err = '';
      try {
        d = await api('/api/live/changes/file?' + q({ id, path: f.path, scope: 'uncommitted' }));
      } catch (e) {
        err = e.message || 'Request failed';
      }
      const cur = s.cache.get(f.path);
      if (id !== s.id || !cur || cur.seq !== mine) return;
      s.cache.set(f.path, { sig, seq: mine, loading: false, d: err ? (prev && prev.d) || null : d, err });
      spPaint(s);
    }
    /* Two chats in the same project folder see the same files: the first one's section lists them, a later one only keeps its
       header (a "Project folder" line instead of a second identical list). Only a folder chat (no own copy) can be one. */
    function spDup(s) {
      const key = s.data && s.data.git && !s.data.worktree && s.data.root ? folderKey(s.data) : '';
      if (!key) return false;
      for (const k of SP.keys) {
        if (k === s.key) return false;
        const x = SP.secs.get(k);
        if (x && x.data && x.data.git && !x.data.worktree && x.data.root && folderKey(x.data) === key) return true;
      }
      return false;
    }
    function spPaint(s) {
      const fs = spFiles(s),
        S = SUI();
      const info = S ? S.chatInfo(s.key) : { key: s.key, title: 'Conversation' };
      const A = win.ActivityUI;
      const dup = spDup(s);
      if (A && A.splitHead) A.splitHead(doc, info, dup ? 'Project folder · files listed above' : plural(spCount(s), 'file', 'files'), s.head);
      s.open = pruneOpen(s.open, fs);
      for (const p of [...s.cache.keys()]) if (!fs.some((f) => f.path === p)) s.cache.delete(p);
      for (const f of fs) {
        const c = s.cache.get(f.path);
        if (s.open.includes(f.path) && c && !c.loading && c.sig !== fileSignature(f)) spDetail(s, f);
      }
      const sig = JSON.stringify([
        dup,
        s.open,
        fs.map(fileSignature),
        fs.map((f) => {
          const c = s.cache.get(f.path);
          return c ? [c.sig, c.loading ? 1 : 0, c.err, c.d ? 1 : 0] : 0;
        }),
      ]);
      if (sig !== s.listSig) {
        s.listSig = sig;
        const ae = doc.activeElement,
          focus = ae && s.list.contains(ae) ? ae.dataset.path : null;
        s.list.replaceChildren(...(dup ? [] : fs).map((f) => spRow(s, f))); // a shared folder is listed once
        if (focus) {
          const n = [...s.list.querySelectorAll('.cg-file')].find((c) => c.dataset.path === focus);
          if (n) n.focus({ preventScroll: true });
        }
      }
      s.root.classList.toggle('sp-dup', dup);
      s.list.hidden = dup || !fs.length;
      s.none.hidden = dup || !!fs.length;
      spFoot(s);
      if (dup) s.fp.foot.hidden = s.fp.status.hidden = true;
    }
    async function spLoad(s, force) {
      const S = SUI(),
        info = S ? S.chatInfo(s.key) : null,
        id = info ? info.id : '';
      if (id !== s.id) {
        s.id = id;
        s.data = null;
        s.open = [];
        s.cache = new Map();
        s.listSig = '';
      }
      s.busy = !!(info && info.conv && info.conv.live && info.conv.live.busy);
      if (!id) {
        s.data = null;
        spPaint(s);
        return;
      }
      const now = Date.now();
      if (!force && s.at && now - s.at < MIN_GAP) return;
      s.at = now;
      const mine = ++s.seq;
      try {
        const next = await api('/api/live/changes?' + q({ id, scope: 'uncommitted' }));
        if (mine !== s.seq || id !== s.id) return;
        s.data = next;
        s.err = '';
      } catch (e) {
        if (mine !== s.seq || id !== s.id) return;
        s.data = null;
        s.err = e.status === 404 ? '' : e.message;
      }
      spPaint(s);
      for (const k of SP.keys) {
        const o = SP.secs.get(k);
        if (o && o !== s) spPaint(o); // which section lists the shared folder can change when this one's reply lands
      }
      paintBadges();
    }
    function splitSync(keys) {
      SP.keys = keys.slice();
      for (const k of [...SP.secs.keys()]) if (!SP.keys.includes(k)) SP.secs.delete(k);
      const want = SP.keys.map((k) => spSection(k).root);
      want.forEach((n, i) => {
        if (spBox.children[i] !== n) spBox.insertBefore(n, spBox.children[i] || null);
      });
      while (spBox.children.length > want.length) spBox.lastChild.remove();
      for (const k of SP.keys) spLoad(spSection(k), true);
      paintBadges();
      spSchedule();
    }
    function spSchedule() {
      const want = splitOn() && paneVisible();
      if (want && !SP.timer)
        SP.timer = win.setInterval(() => {
          if (!splitOn() || !paneVisible()) return spSchedule();
          // the Changes tab polls often; the badge (other tabs) every few polls is enough
          if (state.tab !== 'changes' && (SP.tick = (SP.tick || 0) + 1) % 3) return;
          for (const k of SP.keys) spLoad(spSection(k), false);
        }, POLL_MS / 2);
      else if (!want && SP.timer) {
        win.clearInterval(SP.timer);
        SP.timer = 0;
      }
    }
    win.addEventListener('aib-split-chats', (e) => splitSync((e && e.detail && e.detail.keys) || []));
    /* The Files view's change badge: show the Changes tab with this file's diff open and in view. path is repository-relative. */
    function focusFile(path) {
      const f = files().find((x) => x.path === path);
      reveal('changes');
      if (!f) return false;
      if (!open.includes(path)) open = open.concat(path);
      autoOpened = true;
      if (needsLoad(f)) loadDetail(f);
      paintList();
      const row = [...list.querySelectorAll('.cg-file')].find((c) => c.dataset.path === path);
      if (row) {
        if (row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
        if (row.focus) row.focus({ preventScroll: true });
      }
      return true;
    }
    live = {
      sync,
      show,
      reveal,
      state: () => ({ tab: state.tab, expanded: state.expanded }),
      files,
      data: () => data,
      chatId: () => chat.id,
      focusFile,
      open: () => open.slice(),
    };
    if (AR()) AR().mount({ view: artView, badge: artBadge, tab: tabArtifacts, reveal: () => reveal('artifacts'), win });
    apply();
    paintAll();
  }
  const api = {
    ...pure,
    isFolderView,
    isCopyView,
    FOLDER_SCOPE,
    FOLDER_FOOT,
    COPY_FOOT,
    footer,
    init,
    sync: (ctx) => live && live.sync(ctx),
    show: (tab) => live && live.show(tab),
    reveal: (tab) => live && live.reveal(tab),
    _live: () => live,
  };
  root.ChangesUI = api;
  root.AgentChangesUI = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof document !== 'undefined' && root === (typeof window !== 'undefined' ? window : null))
    document.addEventListener('DOMContentLoaded', () => init(root));
})(typeof window !== 'undefined' ? window : globalThis);
