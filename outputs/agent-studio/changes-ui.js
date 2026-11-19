'use strict';
/* Changes tab: the right column's "Activity | Changes N | Artifacts N | Docs" tabs. Changes is the PROJECT's (design project-right-panel, slice S2):
   VS Code Source Control style, the project folder first, then one section per worktree of an active subagent or helper, then a
   folded "Left over" group. Each file is an accordion row that opens its own unified diff right under it (several can be open).
   Data comes from GET /api/live/project/changes (one read) and /changes/file (changes.ts). The pure helpers have node tests. */
(function (root) {
  const TABS = ['activity', 'changes', 'artifacts', 'docs'];
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
  /* The panel is the project's (owner, 2026-11-18): Changes shows the project folder first, then one section per worktree an
     ACTIVE subagent or helper of any chat of the project works in, and a folded "Left over" group for worktrees whose work never
     landed. No Merge, no Discard, no Commit (owner, 2026-11-16: "these buttons will never exist for anything anymore"): the agent
     lands or undoes work when asked in chat. One server read gives all of it (GET /api/live/project/changes). */
  const FOLDER_FOOT =
    'Nothing to merge: edits go straight into the project folder, from any chat. Ask the agent to commit or undo.';
  const WHY = {
    stopped: 'Stopped before its work landed',
    refused: 'Its work did not land',
    kept: 'Files kept in its worktree',
  };
  const LEFT_HINT = 'Work these agents left that never reached the project folder. Ask the agent in chat to land or undo it.';
  /* Poll every 10 s, only while you are looking at the Changes tab (the badge and chips refresh when a turn ends instead). */
  const shouldPoll = (o) => !!(o && o.tab === 'changes' && o.visible);
  /* The files of the project: main's (a doc counts once) plus those of each active worktree section. Left-over work is not counted:
     it is not changing the project. Lines of new files that were not read show as "+N+" (partial). */
  function projectTotals(r) {
    const out = { files: 0, added: 0, removed: 0 };
    if (!r || !r.main || !r.main.git) return out;
    const add = (sec, files) => {
      const c = sec.counts || {};
      out.files += files;
      out.added += num(c.added);
      out.removed += num(c.removed);
      if (c.partial) out.partial = true;
    };
    add(r.main, r.main.changes ? shownCount(r.main.changes) : num((r.main.counts || {}).files));
    for (const s of r.sections || []) add(s, num((s.counts || {}).files));
    return out;
  }
  /* "3 files +12 −4" parts of a section head. */
  function sectionSum(sec) {
    const c = (sec && sec.counts) || {},
      files = sec && sec.changes ? shownCount(sec.changes) : num(c.files);
    return { files: plural(files, 'file', 'files'), added: '+' + num(c.added) + (c.partial ? '+' : ''), removed: MINUS + num(c.removed), n: files };
  }
  /* The sub-line of a worktree section: who works there ("Subagent of “Chat”"), its branch, and why it was left over. */
  function sectionSub(sec, parentTitle) {
    if (!sec || sec.kind === 'main') return sec && sec.branch ? 'Branch ' + sec.branch : '';
    const who = sec.kind === 'helper' ? 'Helper' + (sec.provider ? ' (' + sec.provider + ')' : '') : 'Subagent';
    const bits = [who + (parentTitle ? ' of “' + parentTitle + '”' : '')];
    if (sec.branch) bits.push(sec.branch);
    if (sec.state === 'left' && WHY[sec.why]) bits.push(WHY[sec.why]);
    return bits.join(' · ');
  }
  /* Query of a read: the sections the user folded (default open) and the left-over ones unfolded (default folded). */
  const foldQuery = (fold, unfold) => ({ fold: [...(fold || [])].sort().join(','), unfold: [...(unfold || [])].sort().join(',') });
  /* A section shows its files unless the user folded it; a left-over one only when the user unfolded it. */
  const wantOpen = (sec, fold, unfold) =>
    sec && sec.state === 'left' ? !!unfold && unfold.has(sec.id) : !(fold && fold.has(sec && sec.id));
  /* Section ids to keep after a read: ids of folds the reply no longer has are dropped. */
  const keepIds = (set, resp) => {
    const ids = new Set(['main', ...((resp && resp.sections) || []).concat((resp && resp.left) || []).map((s) => s.id)]);
    return new Set([...(set || [])].filter((id) => ids.has(id)));
  };
  /* Stamp of the turns that ended in the project: it changes when any chat's turn ends. */
  const turnStamp = (chats) =>
    (chats || [])
      .filter((c) => c && c.turnEndedAt)
      .map((c) => c.key + '=' + c.turnEndedAt)
      .sort()
      .join(';');
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
    projectTotals,
    sectionSum,
    sectionSub,
    foldQuery,
    wantOpen,
    keepIds,
    turnStamp,
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
    const POLL_MS = 10000,
      MIN_GAP = 1200;
    let state = { tab: 'activity', expanded: false };
    let chat = { id: '', busy: false, titleFor: null };
    /* The panel is the project's (owner, 2026-11-18): the tab it shows (Activity / Changes / Artifacts) is remembered per project
       and per window, kept over a restart, and never changes when you open another chat of the same project or move split focus.
       tabProject: the project the panel shows now. */
    const TAB_KEY = 'studio-panel-tab-v1';
    const tabKey = () => (win.AibStore ? win.AibStore.winKey(TAB_KEY) : TAB_KEY);
    let tabProject = null;
    function savedTabs() {
      try {
        const o = JSON.parse(win.localStorage.getItem(tabKey()) || '{}');
        return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
      } catch (e) {
        return {};
      }
    }
    function rememberTab(pk, tab) {
      if (!pk || (win.AibStore && !win.AibStore.layoutWritable())) return; // a pop-out writes no layout
      const o = savedTabs();
      if (o[pk] === tab) return;
      delete o[pk];
      o[pk] = tab; // newest last; the oldest projects drop off past 60
      const keys = Object.keys(o);
      for (const k of keys.slice(0, Math.max(0, keys.length - 60))) delete o[k];
      try {
        win.localStorage.setItem(tabKey(), JSON.stringify(o));
      } catch (e) {}
    }
    const panelProjectKey = () => {
      const W = win.AgentWorkspaceUI;
      try {
        return (W && W.panelProject && W.panelProject().key) || '';
      } catch (e) {
        return '';
      }
    };
    /* What the project's Changes holds: the last reply, which sections the user folded, which left-over ones they unfolded, the
       open diffs per section and their cache. All of it is the project's: another chat of the project changes none of it. */
    let resp = null,
      error = '',
      seq = 0,
      lastFetch = 0,
      timer = 0,
      loading = false;
    let fold = new Set(),
      unfold = new Set(),
      leftOpen = false,
      open = new Map(),
      cache = new Map(),
      detailSeq = 0,
      autoOpened = false,
      token = '',
      pages = 1,
      loadingMore = false,
      turnProject = '',
      turnSeen = '';
    const editors = () => {
      const e = win.AgentEditors;
      return e && typeof e.open === 'function' ? e : null;
    };

    /* -- tab row -- */
    const tabs = el('div', 'pane-tabs');
    tabs.id = 'paneTabs';
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'Right column');
    /* Below 320 px of panel the tabs show an icon and their count, the label in the tooltip and aria label (changes.css draws the
       icons). */
    const tabBtn = (id, label) => {
      const b = el('button', 'pane-tab');
      b.type = 'button';
      b.id = 'paneTab-' + id;
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-label', label);
      b.title = label;
      b.dataset.tab = id;
      const ico = el('span', 'pane-tab-ico pane-ico-' + id);
      ico.setAttribute('aria-hidden', 'true');
      b.append(ico, el('span', 'pane-tab-label', label));
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
    /* Docs has no count, only a live dot while an agent writes a doc (docs-tab-ui.js). */
    const tabDocs = tabBtn('docs', 'Docs');
    const docsDot = el('span', 'pane-dot');
    docsDot.hidden = true;
    docsDot.setAttribute('role', 'img');
    docsDot.setAttribute('aria-label', 'An agent is writing a doc');
    tabDocs.append(docsDot);
    const expandBtn = el('button', 'pane-expand', '⇤');
    expandBtn.type = 'button';
    expandBtn.title = 'Widen this column';
    expandBtn.setAttribute('aria-label', 'Widen this column');
    expandBtn.setAttribute('aria-pressed', 'false');
    expandBtn.hidden = true;
    tabs.append(tabActivity, tabChanges, tabArtifacts, tabDocs, expandBtn);
    pane.insertBefore(tabs, pane.firstChild);

    /* -- changes view -- */
    const view = el('section', 'changes-pane');
    view.id = 'changesPane';
    view.setAttribute('role', 'tabpanel');
    view.setAttribute('aria-labelledby', 'paneTab-changes');
    view.hidden = true;
    const bar = el('div', 'cg-bar');
    const scopeEl = el('span', 'cg-scope', 'Project'),
      modeEl = el('span', 'cg-mode', 'Unified');
    scopeEl.title = 'The project folder and the worktrees of its running subagents and helpers';
    const refresh = el('button', 'cg-refresh', '↻');
    refresh.type = 'button';
    refresh.title = 'Refresh changes';
    refresh.setAttribute('aria-label', 'Refresh changes');
    const sum = el('span', 'cg-sum');
    bar.append(scopeEl, modeEl, sum, refresh);
    const note = el('p', 'cg-note');
    note.setAttribute('role', 'status');
    note.hidden = true;
    /* The one scroll area: the project folder, the worktree sections, the "Left over" group. */
    const box = el('div', 'cg-project');
    box.id = 'projectChanges';
    box.setAttribute('role', 'list');
    box.hidden = true;
    /* One footer row: a read-only status line, the same for every chat. */
    const parts = footer(doc),
      foot = parts.foot;
    parts.folder.textContent = FOLDER_FOOT;
    view.append(bar, note, box, foot);
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
    /* Docs tab (docs-tab-ui.js owns what is inside). */
    const docsView = el('section', 'docs-tab-pane');
    docsView.id = 'docsPane';
    docsView.setAttribute('role', 'tabpanel');
    docsView.setAttribute('aria-labelledby', 'paneTab-docs');
    docsView.hidden = true;
    pane.insertBefore(docsView, artView.nextSibling);
    const DT = () => (win.AgentDocsTabUI && typeof win.AgentDocsTabUI.mount === 'function' ? win.AgentDocsTabUI : null);

    /* -- header chip and narrow strip chip: both count the project (its folder and its running worktrees) -- */
    const chip = el('button', 'changes-chip');
    chip.type = 'button';
    chip.id = 'changesChip';
    chip.hidden = true;
    chip.title = 'Show the changes in the project';
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

    const mainSec = () => (resp && resp.main) || null;
    /* main's data in the shape the Files view reads (git, files, prefix, root); null before the first read */
    const mainData = () => {
      const m = mainSec();
      return m && m.changes ? m.changes : m && m.git === false ? { git: false } : null;
    };
    const secsOf = (r) => (r ? [r.main, ...(r.sections || []), ...(r.left || [])].filter(Boolean) : []);
    const secById = (id) => secsOf(resp).find((s) => s.id === id) || null;
    const filesOf = (sec) => (sec && sec.changes && sec.changes.git ? splitDocFiles(sec.changes).files : []);
    const files = () => filesOf(mainSec());
    const openOf = (id) => open.get(id) || [];
    const keyOf = (id, path) => id + '\n' + path;

    /* "Show the next 300": one more page of the project folder's files, appended to what is listed. */
    async function loadMore() {
      const m = mainSec(),
        id = chat.id;
      if (!id || !m || !m.changes || !moreLeft(m.changes) || loadingMore) return;
      const mine = seq,
        before = m.changes.files.length;
      loadingMore = true;
      paintList(true);
      try {
        const more = await api('/api/live/changes?' + q({ id, scope: 'uncommitted', offset: m.changes.files.length }));
        const cur = mainSec();
        if (mine !== seq || id !== chat.id || !cur || !cur.changes) return;
        if (more.git && (more.files || []).length) {
          pages++;
          cur.changes = Object.assign({}, cur.changes, more, { files: cur.changes.files.concat(more.files), offset: 0 });
        }
      } catch (e) {
        if (mine === seq) error = e.message;
      } finally {
        loadingMore = false;
      }
      paintAll();
      const ae = doc.activeElement;
      if (!ae || !box.contains(ae)) {
        const first = box.querySelectorAll('[data-sec="main"] .cg-file')[before]; // the first newly listed file, for the keyboard
        if (first) first.focus({ preventScroll: true });
      }
    }
    async function load(force) {
      if (!chat.id) return;
      const now = Date.now();
      if (!force && now - lastFetch < MIN_GAP) return;
      lastFetch = now;
      const mine = ++seq,
        id = chat.id;
      loading = true;
      paintBar();
      try {
        const next = await api('/api/live/project/changes?' + q(Object.assign({ id }, foldQuery(fold, unfold))));
        if (mine !== seq || id !== chat.id) return;
        /* The pages you asked for with "Show the next 300" stay listed across refreshes. */
        const m = next.main;
        for (let p = 1; p < pages && m && m.changes && moreLeft(m.changes); p++) {
          const more = await api('/api/live/changes?' + q({ id, scope: 'uncommitted', offset: m.changes.files.length }));
          if (mine !== seq || id !== chat.id) return;
          if (!more.git || !(more.files || []).length) break;
          m.changes = Object.assign({}, m.changes, more, { files: m.changes.files.concat(more.files), offset: 0 });
        }
        resp = next;
        fold = keepIds(fold, next);
        unfold = keepIds(unfold, next);
        error = '';
      } catch (e) {
        if (mine !== seq || id !== chat.id) return;
        error = e.status === 404 ? '' : e.message;
        resp = e.status === 404 ? { unknown: true, main: { git: null, counts: {} }, sections: [], left: [] } : null;
      } finally {
        if (mine === seq) loading = false;
      }
      paintAll();
      ensureOpen();
      // a section the user unfolded while this read ran, or one that is new: its files come with the next read
      if (resp && secsOf(resp).some((s) => s.git && wantOpen(s, fold, unfold) && !s.changes && s.id !== 'main')) load(true);
    }
    /* Lazy: a file's diff is fetched the first time it is opened, and again when its numbers change while it is open. A worktree's
       file is asked by its section id (a record id), never by a path of the worktree. */
    async function loadDetail(sec, f) {
      const path = f.path,
        sig = fileSignature(f),
        id = chat.id,
        k = keyOf(sec.id, path),
        mine = ++detailSeq;
      const prev = cache.get(k);
      cache.set(k, { sig, seq: mine, loading: true, d: (prev && prev.d) || null, err: '' });
      paintList();
      let d = null,
        err = '';
      try {
        d = await api(
          sec.id === 'main'
            ? '/api/live/changes/file?' + q({ id, path, scope: 'uncommitted' })
            : '/api/live/project/changes/file?' + q({ id, section: sec.id, path }),
        );
      } catch (e) {
        err = e.message || 'Request failed';
      }
      const cur = cache.get(k);
      if (!cur || cur.seq !== mine || id !== chat.id) return;
      cache.set(k, { sig, seq: mine, loading: false, d: err ? (prev && prev.d) || null : d, err });
      paintList();
    }
    const needsLoad = (sec, f) => {
      const c = cache.get(keyOf(sec.id, f.path));
      return !c || c.sig !== fileSignature(f);
    };
    function ensureOpen() {
      if (!resp) return;
      for (const sec of secsOf(resp)) {
        const fs = filesOf(sec);
        open.set(sec.id, pruneOpen(openOf(sec.id), fs));
        for (const k of [...cache.keys()]) if (k.startsWith(sec.id + '\n') && !fs.some((f) => keyOf(sec.id, f.path) === k)) cache.delete(k);
        if (sec.id === 'main' && !autoOpened && fs.length) {
          autoOpened = true;
          if (!openOf('main').length) open.set('main', [fs[0].path]);
        }
        for (const f of fs) if (openOf(sec.id).includes(f.path) && needsLoad(sec, f)) loadDetail(sec, f);
      }
      paintList();
    }
    function toggleFile(sec, f) {
      open.set(sec.id, toggleOpen(openOf(sec.id), f.path));
      if (sec.id === 'main') autoOpened = true;
      if (openOf(sec.id).includes(f.path) && needsLoad(sec, f)) loadDetail(sec, f);
      paintList();
    }
    /* The fold caret of a section (and of the Left over group): a visible button, never a menu. */
    function toggleSection(sec) {
      const set = sec.state === 'left' ? unfold : fold,
        was = wantOpen(sec, fold, unfold);
      if (set.has(sec.id)) set.delete(sec.id);
      else set.add(sec.id);
      paintList();
      if (!was && sec.id !== 'main' && !sec.changes) load(true); // unfolded: its files are read now
    }

    /* -- painting -- */
    function paintBar() {
      const t = projectTotals(resp);
      sum.replaceChildren();
      if (t.files) {
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
      const t = projectTotals(resp),
        n = t.files;
      badgeEl.textContent = badge(n);
      badgeEl.hidden = !n;
      tabChanges.setAttribute('aria-label', 'Changes' + (n ? ', ' + plural(n, 'file', 'files') + ' changed' : ''));
      const c = chipParts(t);
      chip.replaceChildren();
      if (c) {
        chip.append(
          el('span', '', c.label + ' · ' + c.files + ' '),
          el('span', 'cg-add', c.added),
          doc.createTextNode(' '),
          el('span', 'cg-del', c.removed),
        );
      }
      chip.hidden = !c;
      stripChip.textContent = stripText(n);
      stripChip.hidden = !n;
    }
    function paintNote() {
      const m = mainSec();
      let msg = '';
      if (!chat.id) msg = 'Open a chat to see what changed in its project.';
      else if (m && m.git === false) msg = 'No git here: the Changes view needs a git repository.';
      else if (resp && resp.unknown) msg = 'Changes are not available for this project yet.';
      else if (error) msg = 'Could not read the changes: ' + error;
      else if (!resp) msg = 'Reading changes…';
      note.textContent = msg;
      note.hidden = !msg;
      /* More files than listed: the button at the end of the list shows the rest. Only when git's own output was cut is there no way on. */
      const d = mainData();
      if (d && d.git && d.truncated && !moreLeft(d)) {
        note.textContent = (msg ? msg + ' ' : '') + 'Git reported more changes than AIB can read; some files are not listed.';
        note.hidden = false;
      }
      foot.hidden = parts.status.hidden = parts.folder.hidden = !(m && m.git);
    }
    function rowFor(sec, f) {
      const info = statusInfo(f.status),
        p = splitPath(f.path),
        isOpen = openOf(sec.id).includes(f.path);
      const item = el('div', 'cg-item' + (isOpen ? ' open' : ''));
      item.setAttribute('role', 'listitem');
      item.dataset.path = f.path;
      const b = el('button', 'cg-file' + (isOpen ? ' open' : ''));
      b.type = 'button';
      b.dataset.path = f.path;
      b.dataset.fk = 'f:' + keyOf(sec.id, f.path);
      b.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      b.title = f.path + (f.oldPath ? '\n(was ' + f.oldPath + ')' : '') + '\n' + info.label;
      const path = el('span', 'cg-path'),
        inner = el('span', 'cg-path-in');
      inner.append(el('span', 'cg-path-dir', p.dir), el('b', '', p.base)); // the folder part shrinks first, the name stays
      path.append(inner);
      const caret = el('span', 'cg-caret', isOpen ? '▾' : '▸');
      caret.setAttribute('aria-hidden', 'true');
      b.append(caret, el('span', 'cg-st ' + info.cls, info.letter), path);
      if (f.binary) b.append(el('span', 'cg-bin', 'binary'));
      else b.append(el('span', 'cg-add', addText(f)), el('span', 'cg-del', delText(f)));
      b.onclick = () => toggleFile(sec, f);
      item.append(b);
      if (isOpen) item.append(bodyFor(sec, f));
      return item;
    }
    /* A doc: one row, "2 pages changed". Clicked, the doc opens in the Docs view; no diff in v1. */
    function rowForDoc(d) {
      const item = el('div', 'cg-item cg-doc');
      item.setAttribute('role', 'listitem');
      item.dataset.doc = d.doc;
      const b = el('button', 'cg-file cg-doc-btn');
      b.type = 'button';
      b.dataset.path = d.dir;
      b.dataset.fk = 'd:' + d.doc;
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
      const d = mainData(),
        left = d ? moreLeft(d) : 0;
      if (!left) return null;
      const b = el('button', 'cg-more', loadingMore ? 'Listing…' : moreText(left));
      b.type = 'button';
      b.disabled = loadingMore;
      b.dataset.fk = 'more';
      b.addEventListener('click', loadMore);
      return b;
    }
    /* One section: a visible fold button as its head (caret, name, counts), the sub-line, then its files. */
    function sectionNode(sec) {
      const want = wantOpen(sec, fold, unfold),
        s = sectionSum(sec);
      const root_ = el('section', 'cg-sec' + (sec.id === 'main' ? ' cg-main' : '') + (sec.state === 'left' ? ' cg-leftsec' : ''));
      root_.dataset.sec = sec.id;
      root_.dataset.kind = sec.kind;
      root_.setAttribute('role', 'listitem');
      const head = el('button', 'cg-sec-head');
      head.type = 'button';
      head.dataset.fk = 'h:' + sec.id;
      head.setAttribute('aria-expanded', want ? 'true' : 'false');
      head.title = (want ? 'Fold ' : 'Unfold ') + sec.name;
      const caret = el('span', 'cg-caret', want ? '▾' : '▸');
      caret.setAttribute('aria-hidden', 'true');
      const nums = el('span', 'cg-sec-sum');
      if (sec.git) nums.append(el('span', '', s.files + ' '), el('span', 'cg-add', s.added), doc.createTextNode(' '), el('span', 'cg-del', s.removed));
      head.append(caret, el('span', 'cg-sec-name', sec.name), nums);
      head.onclick = () => toggleSection(sec);
      root_.append(head);
      let who = '';
      try {
        who = sec.parent && chat.titleFor ? chat.titleFor(sec.parent.live || sec.parent.lasting) || chat.titleFor(sec.parent.lasting) || '' : '';
      } catch (e) {}
      const subline = sectionSub(sec, who);
      if (subline) root_.append(el('div', 'cg-sec-sub', subline));
      if (!want) return root_;
      const c = sec.changes;
      if (!sec.git) {
        root_.append(el('p', 'cg-sec-none', 'Could not read this worktree.'));
        return root_;
      }
      if (!c) {
        root_.append(el('p', 'cg-sec-none', 'Reading…'));
        return root_;
      }
      const fs = filesOf(sec),
        ds = sec.id === 'main' ? docsOfData(c) : [];
      if (!fs.length && !ds.length) {
        root_.append(el('p', 'cg-sec-none', sec.id === 'main' ? 'No uncommitted changes.' : 'No changes yet.'));
        return root_;
      }
      const lst = el('div', 'cg-files');
      lst.setAttribute('role', 'list');
      lst.append(...ds.map(rowForDoc), ...fs.map((f) => rowFor(sec, f)));
      root_.append(lst);
      if (sec.id !== 'main' && moreLeft(c)) root_.append(el('p', 'cg-sec-none', 'Showing the first ' + fs.length + ' of ' + num(c.filesTotal) + ' files.'));
      if (sec.id === 'main') {
        const more = moreRow();
        if (more) root_.append(more);
      }
      return root_;
    }
    function leftNode(list) {
      const g = el('section', 'cg-left');
      g.dataset.sec = 'left';
      g.setAttribute('role', 'listitem');
      const head = el('button', 'cg-sec-head cg-left-head');
      head.type = 'button';
      head.dataset.fk = 'h:left';
      head.setAttribute('aria-expanded', leftOpen ? 'true' : 'false');
      head.title = (leftOpen ? 'Fold' : 'Unfold') + ' Left over';
      const caret = el('span', 'cg-caret', leftOpen ? '▾' : '▸');
      caret.setAttribute('aria-hidden', 'true');
      head.append(caret, el('span', 'cg-sec-name', 'Left over (' + list.length + ')'));
      head.onclick = () => {
        leftOpen = !leftOpen;
        paintList();
      };
      g.append(head);
      if (leftOpen) {
        g.append(el('div', 'cg-sec-sub', LEFT_HINT));
        for (const sec of list) g.append(sectionNode(sec));
      }
      return g;
    }
    let listSig = '';
    function paintList(force) {
      const m = mainSec(),
        sig = JSON.stringify([
          resp,
          [...fold],
          [...unfold],
          leftOpen,
          [...open.entries()],
          [...cache.entries()].map(([k, c]) => [k, c.sig, c.loading ? 1 : 0, c.err, c.d ? 1 : 0]),
          loadingMore,
          force ? Math.random() : 0,
          !!chat.titleFor,
        ]);
      if (sig === listSig) return;
      listSig = sig;
      const top = box.scrollTop,
        ae = doc.activeElement,
        focus = ae && box.contains(ae) ? ae.dataset.fk : null;
      const nodes = [];
      if (resp && m && m.git) {
        nodes.push(sectionNode(m));
        for (const sec of resp.sections || []) nodes.push(sectionNode(sec));
        if ((resp.left || []).length) nodes.push(leftNode(resp.left));
      }
      box.replaceChildren(...nodes);
      box.scrollTop = top;
      if (focus) {
        const n = [...box.querySelectorAll('[data-fk]')].find((c) => c.dataset.fk === focus);
        if (n) n.focus({ preventScroll: true });
      }
      box.hidden = !nodes.length;
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
        const b = el('button', 'cg-open', 'Open at line ' + line + ' ↗');
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
    function bodyFor(sec, f) {
      const diff = el('div', 'cg-diff'),
        c = cache.get(keyOf(sec.id, f.path));
      if (f.oldPath) diff.append(el('p', 'cg-was', 'was ' + f.oldPath));
      if (!c || (c.loading && !c.d)) {
        diff.append(el('p', 'cg-msg', 'Loading…'));
        return diff;
      }
      if (c.err && !c.d) {
        diff.append(el('p', 'cg-msg cg-err', 'Could not read this diff: ' + c.err));
        return diff;
      }
      const detail = c.d || {};
      if (detail.error) {
        diff.append(el('p', 'cg-msg cg-err', 'Could not read this diff: ' + detail.error));
        return diff;
      }
      for (const n of diffNotes(detail)) diff.append(el('p', 'cg-msg', n));
      const scroll = el('div', 'cg-lines');
      for (const h of detail.hunks || []) scroll.append(diffRows(h, f, detail));
      if ((detail.hunks || []).length) diff.append(scroll);
      return diff;
    }
    function paintAll() {
      paintBadges();
      paintBar();
      paintNote();
      listSig = '';
      paintList();
    }

    /* -- tabs, expand, polling -- */
    function apply() {
      const on = state.tab === 'changes',
        art = state.tab === 'artifacts',
        docs = state.tab === 'docs',
        wide = on || art;
      pane.classList.toggle('tab-changes', on);
      pane.classList.toggle('tab-artifacts', art);
      pane.classList.toggle('tab-docs', docs);
      for (const [b, sel] of [
        [tabActivity, !on && !art && !docs],
        [tabChanges, on],
        [tabArtifacts, art],
        [tabDocs, docs],
      ]) {
        b.setAttribute('aria-selected', sel ? 'true' : 'false');
        b.tabIndex = sel ? 0 : -1;
        b.classList.toggle('active', sel);
      }
      view.hidden = !on;
      artView.hidden = !art;
      docsView.hidden = !docs;
      expandBtn.hidden = !wide || narrow();
      expandBtn.setAttribute('aria-pressed', state.expanded ? 'true' : 'false');
      expandBtn.title = state.expanded ? 'Narrow this column again' : 'Widen this column';
      expandBtn.setAttribute('aria-label', expandBtn.title);
      expandBtn.textContent = state.expanded ? '⇥' : '⇤'; // QA m8: widen pulls the edge left, narrow pushes it back
      body.classList.toggle('changes-wide', wide && state.expanded && !narrow());
      if (AR()) AR().setVisible(art && paneVisible());
      if (DT()) DT().setVisible(docs && paneVisible());
      schedule();
    }
    function show(tab) {
      const was = state.tab;
      state = tabState(state, { type: 'show', tab });
      if (tabProject) rememberTab(tabProject, state.tab);
      apply();
      if (tab === 'changes' && was !== 'changes') {
        paintAll();
        load(true);
      }
      if (tab === 'artifacts' && was !== 'artifacts' && AR()) AR().shown();
    }
    /* Refresh rule: every 10 s while the Changes tab is on screen, and nothing while it is not (the badge and chips are refreshed
       when a chat's turn ends, see turns() and sync()). */
    function schedule() {
      const poll = () => shouldPoll({ tab: state.tab, visible: paneVisible() });
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
    function reveal(tab, opts) {
      tab = TABS.includes(tab) ? tab : 'changes';
      const A = win.ActivityUI;
      if (A && A.isHidden && A.isHidden()) A.setHidden(false);
      if (narrow()) {
        pane.classList.add('open');
        if (strip) strip.setAttribute('aria-expanded', 'true');
      }
      show(tab);
      // opening a doc moves nothing but the tab: the focus stays where it is (owner rule: focus changes only the accent)
      if (!(opts && opts.focus === false)) ({ activity: tabActivity, changes: tabChanges, artifacts: tabArtifacts, docs: tabDocs })[tab].focus({ preventScroll: true });
    }
    tabActivity.addEventListener('click', () => show('activity'));
    tabChanges.addEventListener('click', () => show('changes'));
    tabArtifacts.addEventListener('click', () => show('artifacts'));
    tabDocs.addEventListener('click', () => show('docs'));
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
      ({ activity: tabActivity, changes: tabChanges, artifacts: tabArtifacts, docs: tabDocs })[next].focus();
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
          if (tabProject) rememberTab(tabProject, state.tab);
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

    /* Everything that is the project's goes when another project is on screen (never for another chat of the same project). */
    function resetProject() {
      seq++;
      detailSeq++;
      resp = null;
      error = '';
      fold = new Set();
      unfold = new Set();
      leftOpen = false;
      open = new Map();
      cache = new Map();
      pages = 1;
      autoOpened = false;
      listSig = '';
      lastFetch = 0;
      turnSeen = '';
      turnProject = '';
    }
    /* -- chat.js feeds this on every header render: {id, busy, cwd, titleFor} for the open chat, or null -- */
    function sync(ctx) {
      const id = ctx && typeof ctx.id === 'string' ? ctx.id : '',
        busy = !!(ctx && ctx.busy);
      const changed = id !== chat.id,
        ended = turnEnded(chat.busy, busy);
      chat = { id, busy, key: ctx && ctx.key ? ctx.key : '', titleFor: ctx && typeof ctx.titleFor === 'function' ? ctx.titleFor : null };
      // Artifacts is the project's: it gets the project key (another chat of the same project moves only its accent) and the chat lookup for its row chips
      if (AR())
        AR().sync(
          id
            ? { id, busy, cwd: ctx && typeof ctx.cwd === 'string' ? ctx.cwd : '', project: panelProjectKey(), tagFor: ctx && typeof ctx.tagFor === 'function' ? ctx.tagFor : null }
            : null,
        );
      // Docs is the project's too: the open doc stays when another chat of the project opens
      if (DT()) DT().sync({ id, project: panelProjectKey(), tagFor: ctx && typeof ctx.tagFor === 'function' ? ctx.tagFor : null });
      // Another project on screen: its own remembered tab and its own Changes. Another chat of the same project, or split focus:
      // the tab and the Changes stay as they are.
      const pk = panelProjectKey();
      let moved = false;
      if (pk !== tabProject) {
        tabProject = pk;
        moved = true;
        resetProject();
        const back = pk ? savedTabs()[pk] : '';
        state = tabState(state, { type: 'reset' });
        if (back && back !== 'activity') state = tabState(state, { type: 'show', tab: back });
        apply();
        if (state.tab === 'artifacts' && AR() && !changed) AR().shown();
      }
      if (changed && !id) {
        seq++;
        resp = null;
        listSig = '';
        paintAll();
      }
      if (changed) {
        if (state.tab === 'artifacts' && AR()) AR().shown();
        paintAll();
        if (id && (moved || !resp)) load(true);
        else if (id && resp) load(false); // the same project's data stays on screen; a quiet re-read
      } else if (ended && id) load(true);
      schedule();
    }
    /* chat.js feeds this on every chat-list render: a stamp of the project's turn ends. A turn that ended in any chat of the project
       refreshes the numbers at once, whichever tab is showing (the chips count the project). */
    function turns(pk, stamp) {
      if (pk !== turnProject) {
        turnProject = pk;
        turnSeen = stamp;
        return;
      }
      if (stamp !== turnSeen) {
        turnSeen = stamp;
        if (chat.id) load(true);
        if (AR()) AR().refresh();
      }
    }
    /* The Files view's change badge: show the Changes tab with this file's diff open and in view. path is repository-relative. */
    function focusFile(path) {
      const f = files().find((x) => x.path === path);
      reveal('changes');
      fold.delete('main');
      if (!f) return false;
      const m = mainSec();
      if (!openOf('main').includes(path)) open.set('main', openOf('main').concat(path));
      autoOpened = true;
      if (needsLoad(m, f)) loadDetail(m, f);
      listSig = '';
      paintList();
      const row = [...box.querySelectorAll('[data-sec="main"] .cg-file')].find((c) => c.dataset.path === path);
      if (row) {
        if (row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
        if (row.focus) row.focus({ preventScroll: true });
      }
      return true;
    }
    live = {
      sync,
      turns,
      show,
      reveal,
      state: () => ({ tab: state.tab, expanded: state.expanded }),
      files,
      data: mainData,
      project: () => resp,
      chatId: () => chat.id,
      focusFile,
      open: () => openOf('main').slice(),
    };
    if (AR()) AR().mount({ view: artView, badge: artBadge, tab: tabArtifacts, reveal: () => reveal('artifacts'), win });
    if (DT()) DT().mount({ view: docsView, dot: docsDot, tab: tabDocs, reveal: () => reveal('docs', { focus: false }), win });
    apply();
    paintAll();
  }
  const api = {
    ...pure,
    FOLDER_FOOT,
    footer,
    init,
    sync: (ctx) => live && live.sync(ctx),
    turns: (pk, stamp) => live && live.turns(pk, stamp),
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
