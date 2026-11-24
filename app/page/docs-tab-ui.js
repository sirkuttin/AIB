/* Docs tab (design project-right-panel, slice S4): the right column's fourth tab. A doc ALWAYS opens here (owner decision 2a, 2026-11-18),
   from Files, Ctrl+K, a link or card in a chat reply and "+ New doc": in the full doc editor (doc.html in a frame, comments and history
   as in a tab), at the panel's width, with ← Docs back to the list and ⤢ to move it to a middle tab for wide editing.
   The list is the project's aib-docs/ (doc-links.js keeps it), newest edited first, a live "agent writing" chip on a row while an
   agent writes that doc, and a "+ New doc" row. The open doc and the list scroll are remembered per project and per window; another
   chat of the project moves only the accent and never touches the open doc. */
(function (root) {
  'use strict';
  const KEY = 'studio-docs-tab-v1';
  const POLL_MS = 4000; // the Docs tab is showing: the writing chips come and go with the agents
  const HIDDEN_MS = 10000; // another tab is showing: only the tab's own dot needs the list (plus a read at every turn end and on window focus)

  /* -- pure helpers (tested in node) -- */
  const num = (n) => (Number.isFinite(Number(n)) ? Number(n) : 0);
  /* Newest edited first; a doc with no edit time goes last, in title order. */
  function sortDocs(docs) {
    return (Array.isArray(docs) ? docs : [])
      .filter((d) => d && d.name)
      .slice()
      .sort((a, b) => num(b.editedAt) - num(a.editedAt) || String(a.title || a.name).localeCompare(String(b.title || b.name)));
  }
  function ago(at, now) {
    const s = Math.max(0, Math.round((num(now) - num(at)) / 1000));
    if (!num(at)) return '';
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    return Math.floor(s / 86400) + ' d ago';
  }
  const pagesText = (n) => Math.max(1, num(n)) + (Math.max(1, num(n)) === 1 ? ' page' : ' pages');
  /* "2 pages · edited by Claude Code · 5 min ago" */
  function metaText(d, now) {
    const parts = [pagesText(d.pages)];
    const when = ago(d.editedAt, now);
    if (d.editedAt) parts.push((d.editedBy ? 'edited by ' + d.editedBy : 'edited') + ' · ' + when);
    return parts.join(' · ');
  }
  const writingOf = (d) => (d && Array.isArray(d.writing) && d.writing.length ? d.writing[0] : null);
  const writingText = (w) => (w ? (w.name || 'An agent') + ' writing' : '');
  const anyWriting = (docs) => (Array.isArray(docs) ? docs : []).some((d) => !!writingOf(d));
  const pure = { sortDocs, ago, pagesText, metaText, writingOf, writingText, anyWriting };

  let live = null;
  function mount(o) {
    const win = o.win,
      doc = win.document;
    const el = (tag, cls, txt) => {
      const n = doc.createElement(tag);
      if (cls) n.className = cls;
      if (txt != null) n.textContent = txt;
      return n;
    };
    const DL = () => win.AgentDocLinks;
    const FU = () => win.AgentFilesUI;
    const view = o.view,
      dot = o.dot;
    let chatId = '',
      project = '',
      tagFor = null,
      visible = false,
      cur = null, // the open doc: {name, title, page, block, thread}
      listScroll = 0,
      frame = null,
      rec = null,
      timer = 0,
      naming = null, // {value, error, busy} while the "+ New doc" name field shows
      restore = true; // the list's remembered scroll is put back once its rows are drawn
    const fresh = new Set(); // docs an agent made while you were not looking
    const origin = () => (win.location && win.location.origin) || '*';

    /* -- remembered per project and window -- */
    const storeKey = () => (win.AibStore ? win.AibStore.winKey(KEY) : KEY);
    const saved = () => {
      try {
        const v = JSON.parse(win.localStorage.getItem(storeKey()) || '{}');
        return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
      } catch (e) {
        return {};
      }
    };
    function remember() {
      if (!project || (win.AibStore && !win.AibStore.layoutWritable())) return; // a pop-out writes no layout
      const all = saved();
      delete all[project];
      all[project] = { doc: cur ? { name: cur.name, title: cur.title, page: cur.page || '' } : null, scroll: Math.round(listScroll) };
      const keys = Object.keys(all);
      for (const k of keys.slice(0, Math.max(0, keys.length - 60))) delete all[k];
      try {
        win.localStorage.setItem(storeKey(), JSON.stringify(all));
      } catch (e) {}
    }

    /* -- the panel -- */
    view.classList.add('docs-pane');
    const bar = el('div', 'dt-bar');
    const back = el('button', 'dt-back', '← Docs');
    back.type = 'button';
    back.title = 'Back to the doc list';
    back.setAttribute('aria-label', 'Back to the doc list');
    const title = el('span', 'dt-title');
    const wide = el('button', 'dt-wide', '⤢');
    wide.type = 'button';
    wide.title = 'Open this doc as a tab in the middle';
    wide.setAttribute('aria-label', 'Open this doc as a tab in the middle');
    const pop = el('button', 'dt-pop', '↗');
    pop.type = 'button';
    pop.title = 'Pop out this doc into its own window';
    pop.setAttribute('aria-label', 'Pop out this doc into its own window');
    bar.append(back, title, pop, wide);
    const list = el('div', 'dt-list');
    list.setAttribute('role', 'list');
    const stage = el('div', 'dt-stage');
    view.append(bar, list, stage);

    /* What the docs are asked with: the open chat of THIS project (the server maps a worktree chat to the project's main folder), else
       the project's own folder ('project:<folder>', as a doc pop-out does) so the New chat page of a project lists that project's docs. */
    const docsId = () => {
      if (chatId) return chatId;
      const W = win.AgentWorkspaceUI,
        path = project && W && typeof W.projectPathOf === 'function' ? W.projectPathOf(project) : '';
      return path ? 'project:' + path : '';
    };
    let askedFor = '';
    const docs = () => {
      const D = DL();
      return (D && docsId() && D.cached(docsId(), 'main')) || [];
    };
    const titleOf = (name) => {
      const hit = docs().find((d) => d.name === name);
      return (hit && (hit.title || hit.name)) || (cur && cur.name === name ? cur.title : '') || name;
    };
    function refresh(force) {
      const D = DL();
      if (!D || !docsId()) return Promise.resolve([]);
      return D.listFor(docsId(), 'main', !!force).then((r) => {
        paintList();
        return r;
      });
    }

    function paintDot() {
      const w = anyWriting(docs());
      dot.hidden = !w;
      o.tab.classList.toggle('pane-writing', w);
      const first = docs().map(writingOf).find(Boolean);
      dot.title = w ? writingText(first) : '';
    }

    function row(d) {
      const b = el('button', 'dt-row' + (fresh.has(d.name) ? ' dt-new' : '') + (cur && cur.name === d.name ? ' on' : ''));
      b.type = 'button';
      b.setAttribute('role', 'listitem');
      b.dataset.doc = d.name;
      const head = el('span', 'dt-row-head');
      head.append(el('span', 'dt-row-title', d.title || d.name));
      const w = writingOf(d);
      if (w) {
        const chip = el('span', 'dt-writing', writingText(w));
        chip.title = writingText(w) + (w.section || w.page ? ': ' + (w.section || w.page) : '');
        head.append(chip);
      }
      if (fresh.has(d.name)) {
        const nd = el('span', 'dt-newdot');
        nd.title = 'New';
        head.append(nd);
      }
      b.append(head);
      const meta = el('span', 'dt-row-meta', metaText(d, Date.now()));
      b.append(meta);
      const t = d.chat && typeof tagFor === 'function' ? tagFor(d.chat) : null;
      if (t && t.title) b.append(el('span', 'dt-chat', t.title));
      b.setAttribute('aria-label', (d.title || d.name) + ', ' + metaText(d, Date.now()) + (w ? ', ' + writingText(w) : ''));
      b.addEventListener('click', () => open({ name: d.name, title: d.title || d.name }));
      return b;
    }
    function newRow() {
      if (!naming) {
        const b = el('button', 'dt-newrow', '+ New doc');
        b.type = 'button';
        b.addEventListener('click', startNaming);
        return b;
      }
      const box = el('div', 'dt-namebox');
      const input = el('input', 'dt-name');
      input.type = 'text';
      input.value = naming.value;
      input.disabled = !!naming.busy;
      input.setAttribute('aria-label', 'Name of the new doc');
      input.addEventListener('input', () => (naming.value = input.value));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          createDoc();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          naming = null;
          paintList();
        }
      });
      box.append(input);
      if (naming.error) {
        const er = el('span', 'dt-error', naming.error);
        er.setAttribute('role', 'alert');
        box.append(er);
      }
      win.setTimeout(() => {
        if (input.isConnected && naming && !naming.busy) {
          input.focus({ preventScroll: true });
          input.select();
        }
      }, 0);
      return box;
    }
    function startNaming() {
      const names = docs().map((d) => String(d.title || '').toLowerCase());
      let value = 'Untitled doc',
        k = 2;
      while (names.includes(value.toLowerCase())) value = 'Untitled doc ' + k++;
      naming = { value, error: '', busy: false };
      paintList();
    }
    async function createDoc() {
      const D = DL();
      if (!naming || naming.busy || !D || !D.createDoc) return;
      const name = String(naming.value || '').trim();
      if (!name) {
        naming.error = 'Type a name';
        paintList();
        return;
      }
      naming.busy = true;
      paintList();
      try {
        const r = await D.createDoc(docsId(), name, chatId);
        naming = null;
        await refresh(true);
        open({ name: r.name, title: r.title || r.name });
      } catch (e) {
        if (!naming) return;
        naming.busy = false;
        naming.error = e && e.code === 'doc_exists' ? 'That name is taken: choose another' : 'The doc could not be made. Try again.';
        paintList();
      }
    }

    function paintList() {
      const top = list.scrollTop;
      const items = sortDocs(docs());
      const kids = [newRow()];
      if (!items.length) kids.push(el('p', 'dt-empty', docsId() ? 'No docs in this project yet. Docs you and agents write together show here.' : 'Open a chat to see the project’s docs.'));
      for (const d of items) kids.push(row(d));
      list.replaceChildren(...kids);
      list.scrollTop = top;
      if (restore && items.length && !list.hidden) {
        list.scrollTop = listScroll;
        restore = false;
      }
      paintDot();
    }

    /* -- the open doc -- */
    function dropFrame() {
      if (rec) rec.detach();
      rec = null;
      if (frame && frame.parentNode) frame.remove();
      frame = null;
    }
    function ensureFrame() {
      if (!cur || !docsId() || frame) return;
      const D = DL(),
        d = cur;
      const f = el('iframe', 'dt-frame');
      f.title = 'Doc: ' + (d.title || d.name);
      const W = win.AgentWorkspaceUI;
      f.src = D && D.docUrl ? D.docUrl({ chat: docsId(), project: (W && W.currentProjectPath && W.currentProjectPath()) || '', name: d.name, page: d.page, block: d.block, thread: d.thread, where: 'docs' }) : 'about:blank';
      frame = f;
      stage.replaceChildren(f);
      const U = FU();
      if (U && U.attachDocFrame)
        rec = U.attachDocFrame(f, { id: docsId(), root: 'main', label: 'Folder', branch: '', chatKey: '', title: '' }, d, {
          open: (n) => open(n),
          title: (t) => {
            if (!cur || cur.name !== d.name) return;
            if (t.title) cur.title = t.title;
            if (t.page) cur.page = t.page;
            f.title = 'Doc: ' + cur.title;
            title.textContent = cur.title;
            remember();
          },
          closed: () => {
            if (!cur || cur.name !== d.name) return;
            closeDoc();
            if (DL() && DL().forget) DL().forget();
            refresh(true);
          },
        });
    }
    function paint() {
      const showDoc = !!cur;
      bar.hidden = !showDoc;
      list.hidden = showDoc;
      stage.hidden = !showDoc;
      if (showDoc) {
        title.textContent = cur.title || cur.name;
        title.title = cur.title || cur.name;
        if (visible) ensureFrame();
      } else paintList();
      paintDot();
      // body.dt-viewing: a doc shows in the visible Docs tab (like body.ar-viewing for the Artifacts viewer; no style uses it)
      const b = doc.body;
      if (b) b.classList.toggle('dt-viewing', showDoc && visible);
    }
    /* Open a doc here. opts.background: an agent made it while you watch: it is marked new in the list, never opened, nothing moves. */
    function open(d, opts) {
      opts = opts || {};
      if (!d || !d.name) return false;
      if (opts.background) {
        if (!(cur && cur.name === d.name)) fresh.add(d.name);
        refresh(true);
        return true;
      }
      const same = !!(cur && cur.name === d.name && frame);
      cur = { name: d.name, title: d.title || titleOf(d.name), page: d.page || '', block: d.block || '', thread: d.thread || '' };
      fresh.delete(d.name);
      naming = null;
      if (same) {
        if (d.page || d.block || d.thread)
          try {
            frame.contentWindow.postMessage({ type: 'aib-doc:goto', page: d.page || '', block: d.block || '', thread: d.thread || '' }, origin());
          } catch (e) {
            /* still loading */
          }
      } else dropFrame();
      remember();
      if (o.reveal) o.reveal();
      paint();
      return true;
    }
    function closeDoc() {
      cur = null;
      dropFrame();
      remember();
      restore = true;
      paint();
    }
    back.addEventListener('click', () => {
      closeDoc();
      refresh(true);
    });
    wide.addEventListener('click', () => {
      if (!cur) return;
      const d = { name: cur.name, title: cur.title, page: cur.page, block: '', thread: '' };
      const D = DL();
      closeDoc();
      if (D && D.openDoc) D.openDoc(Object.assign({}, d, { where: 'tab', from: 'chat', chat: { id: docsId() } }));
    });
    // Same move as "Pop out this doc" on a middle tab (doc-links popOut): the doc goes to its own window and leaves this panel.
    pop.addEventListener('click', () => {
      const D = DL();
      if (!cur || !project || !D || !D.popOut) return;
      const d = cur;
      D.popOut({
        project,
        name: d.name,
        title: d.title || d.name,
        scope: null, // worked out again when the window closes (files-ui docScopeFor)
        closeHere: () => {
          if (cur && cur.name === d.name) closeDoc();
          refresh(true);
        },
      });
    });
    list.addEventListener('scroll', () => {
      if (cur || restore) return; // a repaint that clamps the scroll is not the owner's scroll
      listScroll = list.scrollTop;
      remember();
    });

    /* -- the project's docs, asked again while the page is in view: the writing chip and the tab's dot come and go with the agents -- */
    /* Every 4 s while the Docs tab is showing. With another tab showing, the list is still needed for the tab's own "writing" dot:
       read at most every 10 s, and at once when any chat of the project ends a turn (changes-ui turns() -> refresh()) and when
       the window gets focus. (Chosen over riding doc_edit tool events: those only reach the chat on screen, while the dot must
       also show an agent writing in another chat of the project.) */
    function tick() {
      timer = 0;
      if (docsId() && !doc.hidden) refresh(true);
      arm();
    }
    function arm() {
      if (timer || !docsId()) return;
      timer = win.setTimeout(tick, visible ? POLL_MS : HIDDEN_MS);
      if (timer && timer.unref) timer.unref();
    }
    if (win.addEventListener)
      win.addEventListener('focus', () => {
        if (docsId()) refresh(true);
      });

    /* chat.js feeds this on every header render (through changes-ui): {id, project, tagFor} for the open chat. Another chat of the
       same project changes nothing here; another project puts its own open doc and scroll back. */
    function sync(ctx) {
      const id = ctx && typeof ctx.id === 'string' ? ctx.id : '';
      const pk = ctx && typeof ctx.project === 'string' ? ctx.project : '';
      tagFor = ctx && typeof ctx.tagFor === 'function' ? ctx.tagFor : tagFor;
      if (pk && pk !== project) {
        if (project) remember();
        project = pk;
        chatId = ''; // the previous project's chat is never used for the new project's docs (a New chat page names no chat)
        dropFrame();
        const s = saved()[pk];
        cur = s && s.doc && s.doc.name ? { name: s.doc.name, title: s.doc.title || s.doc.name, page: s.doc.page || '', block: '', thread: '' } : null;
        listScroll = s ? num(s.scroll) : 0;
        naming = null;
        restore = true;
        paint();
      }
      if (id) chatId = id;
      const did = docsId();
      if (did) {
        // a new docs address (first chat, another project): its list now; the same address: only when nothing is known yet
        if (did !== askedFor || !DL() || !DL().cached(did, 'main')) refresh(false);
        askedFor = did;
        arm();
        if (cur && visible) ensureFrame();
      }
    }
    function setVisible(v) {
      const was = visible;
      visible = !!v;
      if (visible !== was && timer) {
        win.clearTimeout(timer);
        timer = 0;
        arm();
      }
      if (!visible && doc.body) doc.body.classList.remove('dt-viewing');
      if (visible) {
        paint();
        refresh(true);
      }
    }
    if (DL() && DL().onList) DL().onList(() => paintList());
    paint();
    live = {
      sync,
      setVisible,
      open,
      refresh: () => refresh(true),
      state: () => ({ project, doc: cur ? Object.assign({}, cur) : null, listScroll, writing: anyWriting(docs()) }),
    };
  }
  const api = Object.assign({}, pure, {
    mount,
    sync: (c) => live && live.sync(c),
    setVisible: (v) => live && live.setVisible(v),
    open: (d, opts) => (live ? live.open(d, opts) : false),
    refresh: () => live && live.refresh(),
    state: () => (live ? live.state() : null),
  });
  root.AgentDocsTabUI = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
