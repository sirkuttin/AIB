(function (root) {
  'use strict';
  /* The file editor in file tabs (private/designs/file-editor/file-editor-design-v2.md; architect review 2026-11-16). files-ui.js
     draws the tab (head, tools row, body, footer) and asks this module for the editable parts:

       handles(tab)               a file in the project folder (scope 'main' or 'project'): it opens editable at once
       body(where, tab)           the tab's body: ONE persistent element per tab and pane ('main' | 'beside') holding the editor in a
                                  shadow root (CodeMirror's styles need one under the page's CSP). Redraws re-attach the same node, so
                                  undo, caret, scroll and IME survive; only the head, tools and footer are rebuilt.
       tools(where, tab, width)   the tools row: Save, Save all, the overlap state with Compare, the disk's state (deleted, a form AIB
                                  can't edit), Back to the editor while comparing. One row that never wraps (44 px).
       alert(where, tab)          the save-failed row (red tint), with Retry; or the landing-busy line (retries by itself)
       foot(where, tab)           line ending, encoding, indent, and Unsaved / Saved 14:02 / Updated by … / Restored …
       readOnly(tab, d)           a read-only file's reason and its one button ("Edit in project folder", "Open in Docs")
       dirty(tab) / dirtyCount()  the tab's text differs from the disk version it took in (the dirty dot in the tab's × box)
       beforeClose(where, tab, anchor, go)   closing a tab: unsaved text asks Save / Don't save / Cancel in a small popover by the
                                  tab (never a modal, never on quit); "Don't save" drops the text only where no other view shows it
       save(tab) / saveAll()

     The live text is the server's (server/files/live_files.ts), synced over the file socket by the bundle's liveClient (the page's
     token, or on another computer with Files its device key): one client per file per window, shared by the tab and the beside pane;
     the PC and another computer on one file share its live text like two windows. A disk change merges in on the server; an overlap shows
     as a gutter marker plus "1 overlap · Compare" (never a block that pushes code down); Compare opens in the same pane at the same
     width. Nothing here asks "Save changes?" on quit: unsaved text is kept by the server (hot exit). */
  const doc = () => root.document;
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
  const F = () => root.AgentFilesState;
  let host = null; // {getJson, post, token, redraw(where), loadEditor(), keepTab(tab), closeTab(where, tab), openProjectFile(tab), openDoc(tab)}
  const VIEW = 'v' + Math.random().toString(36).slice(2, 10); // this window's view id (the server tells windows apart by it)
  const states = new Map(); // tab id -> {opening, info, error, readOnly, client, saving, fail, note, force, retries}
  const panes = new Map(); // where|tab id -> {body, host, shadow, ed, compare, scroll}
  const clients = new Map(); // file id -> {client, tabs: Set<tab id>}

  const time = (ms) => {
    try {
      return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (e) {
      return '';
    }
  };
  const editableScope = (s) => !!s && (s.root === 'main' || s.root === 'project');
  function handles(tab) {
    // Another computer (remote-auth.js sets AIBRemote): it edits with the PC's editor and rules only with the Files switch (owner
    // decision 2026-11-16, 1a; the server decides anyway: pc_routes.ts). Without it, the tab stays the read-only view with Download.
    const R = root.AIBRemote;
    if (R && !(R.kind === 'pc' && typeof R.can === 'function' && R.can('pc.files'))) return false;
    return !!tab && !tab.kind && editableScope(tab.scope) && !(tab.scope && tab.scope.wsl);
  }
  const stateOf = (tab) => {
    let st = states.get(tab.id);
    if (!st) {
      st = { opening: false, info: null, error: '', readOnly: null, client: null, saving: false, fail: null, note: '', force: false, retries: 0 };
      states.set(tab.id, st);
    }
    return st;
  };
  const redrawAll = (tabId) => {
    for (const key of panes.keys()) if (key.endsWith('|' + tabId)) host.redraw(key.slice(0, key.indexOf('|')));
  };

  // ---- opening -------------------------------------------------------------------------------------------------------------------
  function ensureOpen(tab) {
    const st = stateOf(tab);
    if (st.info || st.opening || st.readOnly || st.error) return st;
    st.opening = true;
    Promise.resolve()
      .then(() => host.post('files/open', Object.assign({}, F().scopeArgs(tab.scope), { path: tab.path })))
      .then(async (info) => {
        if (!info || !info.editable) {
          st.readOnly = info || { reason: 'unknown', reasonText: 'Read-only' };
          return;
        }
        st.info = info;
        st.client = await clientFor(info, tab);
      })
      .catch((e) => {
        st.error = (e && e.message) || 'Could not open this file for editing';
      })
      .then(() => {
        st.opening = false;
        redrawAll(tab.id);
      });
    return st;
  }
  async function clientFor(info, tab) {
    let c = clients.get(info.file);
    if (c) {
      c.tabs.add(tab.id);
      return c.client;
    }
    const CE = await host.loadEditor();
    const proto = (root.location && root.location.protocol === 'https:') ? 'wss:' : 'ws:';
    let fileId = info.file;
    const client = CE.liveClient({
      url: () => proto + '//' + root.location.host + '/api/live/files/socket?file=' + encodeURIComponent(fileId) + '&view=' + VIEW,
      // another computer: no page token; remote-auth.js adds its device key (aib-device.<key>) to every socket
      protocols: async () => (root.AIBRemote ? ['aib-file'] : ['aib-file', 'aib-token.' + (await host.token())]),
      onReopen: () => {
        // the server restarted with nothing unsaved of this file: open it again; the client rebases our text on the new one
        host.post('files/open', Object.assign({}, F().scopeArgs(tab.scope), { path: tab.path })).then((again) => {
          if (again && again.editable) {
            if (again.file !== fileId) {
              clients.delete(fileId);
              fileId = again.file;
              clients.set(fileId, c);
            }
            for (const id of c.tabs) {
              const s = states.get(id);
              if (s) s.info = again;
            }
            client.reconnect();
          }
        }, () => setTimeout(() => client.reconnect(), 2000));
      },
      onSwap: () => {
        if (c && c.rebind) c.rebind();
        // a new lineage: bind every editor of this file to the new text (the text the page had is already on top of it)
        for (const [key, p] of panes) {
          if (!c.tabs.has(key.slice(key.indexOf('|') + 1)) || !p.ed) continue;
          const t = p.tab;
          p.ed.destroy();
          p.ed = null;
          mountEditor(key.slice(0, key.indexOf('|')), t, p);
        }
      },
      onStatus: () => redrawAll(tab.id),
    });
    c = { client, tabs: new Set([tab.id]) };
    clients.set(info.file, c);
    let pending = 0;
    const later = () => {
      if (pending) return;
      pending = setTimeout(() => {
        pending = 0;
        for (const id of c.tabs) redrawAll(id);
      }, 60);
    };
    // the footer and tools follow the server's state (saved, updated by, overlaps), from every window
    // meta.checked moves after every typing pause: redraw only when what the tab shows changed (the dirty dot, the footer)
    let shown = null;
    const dirtyNow = () => client.meta.get('dirty') === true || client.localDirty;
    const onMeta = (ev) => {
      if ([...ev.keysChanged].some((k) => k !== 'checked') || dirtyNow() !== shown) {
        shown = dirtyNow();
        later();
      }
    };
    const watch = (d) => {
      d.getMap('meta').observe(onMeta);
      d.getArray('overlaps').observe(later);
    };
    watch(client.doc);
    let seenDoc = client.doc;
    const keepPreview = () => {
      if (!client.localDirty || shown === true) return; // only the first keystroke after a clean state redraws
      shown = true;
      for (const id of c.tabs) {
        const s = states.get(id);
        if (s && s.tab && s.tab.preview && host.keepTab) host.keepTab(s.tab); // typing keeps a preview tab
      }
      later();
    };
    // a new lineage (the client swapped its Y.Doc): watch the new one
    c.rebind = () => {
      if (client.doc === seenDoc) return;
      seenDoc = client.doc;
      watch(seenDoc);
      seenDoc.on('update', keepPreview);
    };
    client.doc.on('update', keepPreview);
    client.connect();
    return client;
  }

  // ---- the body: one persistent editor per tab and pane --------------------------------------------------------------------------
  function paneOf(where, tab) {
    const key = where + '|' + tab.id;
    let p = panes.get(key);
    if (!p) {
      const body = el('div', null, 'sf-fv-body sf-ed-body');
      p = { key, body, host: null, shadow: null, ed: null, compare: null, scroll: 0, tab };
      panes.set(key, p);
    }
    p.tab = tab;
    return p;
  }
  function mountEditor(where, tab, p) {
    const st = stateOf(tab), CE = root.AIBCodeEditor;
    if (!CE || !st.client || !st.client.synced) return;
    if (!p.host) {
      p.host = el('div', null, 'sf-code-host');
      p.shadow = p.host.attachShadow({ mode: 'open', delegatesFocus: true });
      p.host._aibFocus = () => p.ed && p.ed.focus();
    }
    const c = st.client;
    p.undo = new CE.cm.Y.UndoManager(c.text);
    p.ed = CE.create({
      parent: p.shadow,
      root: p.shadow,
      name: tab.name,
      live: { ytext: c.text, undo: p.undo, overlaps: c.overlaps, doc: c.doc },
      onSave: () => save(tab),
      onSaveAll: () => saveAll(),
      onOverlapClick: () => openCompare(where, tab),
    });
    p.ed.view.scrollDOM.addEventListener('scroll', () => (p.scroll = p.ed ? p.ed.view.scrollDOM.scrollTop : 0), { passive: true });
    if (tab.line) {
      try {
        const line = p.ed.view.state.doc.line(Math.min(tab.line, p.ed.view.state.doc.lines));
        p.ed.view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
      } catch (e) {
        /* a line past the end */
      }
    }
  }
  /** The tab's body for files-ui's renderView (the same node every time). */
  function body(where, tab) {
    const p = paneOf(where, tab), st = ensureOpen(tab);
    st.tab = tab;
    if (p.compare) return p.body;
    if (!p.ed && st.client && st.client.synced) mountEditor(where, tab, p);
    if (p.ed) {
      if (p.host.parentNode !== p.body) p.body.replaceChildren(p.host);
      if (!p.body.isConnected) {
        // put the scroll back once it is on screen again (a detached scroller forgets it)
        const back = p.scroll;
        (root.requestAnimationFrame || setTimeout)(() => {
          if (p.ed && back) p.ed.view.scrollDOM.scrollTop = back;
          if (p.ed) p.ed.view.requestMeasure();
        });
      }
    } else {
      const msg = st.error ? st.error : st.client && !st.client.synced && st.info ? 'Connecting…' : 'Opening…';
      if (!p.body.firstChild || !p.body.firstChild.classList || !p.body.firstChild.classList.contains('fx-note')) p.body.replaceChildren(el('p', msg, 'fx-note'));
      else p.body.firstChild.textContent = msg;
      if (st.client && !st.client.synced) st.client.whenSynced().then(() => redrawAll(tab.id));
    }
    return p.body;
  }

  // ---- state for the tools row and footer -----------------------------------------------------------------------------------------
  function dirty(tab) {
    const st = states.get(tab.id);
    const c = st && st.client;
    if (!c) return false;
    return c.meta.get('dirty') === true || c.localDirty;
  }
  function dirtyTabs() {
    const out = [];
    for (const st of states.values()) if (st.tab && dirty(st.tab)) out.push(st.tab);
    return out;
  }
  const dirtyCount = () => dirtyTabs().length;
  const who = (c) => String(c.meta.get('updatedBy') || '');

  function tools(where, tab, width) {
    const st = stateOf(tab), p = paneOf(where, tab);
    st.tab = tab;
    const out = [];
    if (!st.client) return out;
    const c = st.client, narrowRow = (width || 0) && width < 560;
    if (p.compare) {
      const back = btn('Back to editing', 'fx-btn sf-ed-back', 'Close Compare and go back to your text');
      back.onclick = () => closeCompare(where, tab);
      out.push(back, el('span', narrowRow ? 'Disk · Yours' : 'Left: the file on disk · Right: your text', 'sf-ed-state'));
      return out;
    }
    const isDirty = dirty(tab), disk = c.meta.get('disk');
    const save_ = btn(st.saving ? 'Saving…' : st.force ? 'Save overwrites' : disk === 'deleted' ? 'Save again' : 'Save', 'fx-btn sf-ed-save', 'Save (Ctrl+S)');
    save_.disabled = st.saving || (!isDirty && disk !== 'deleted' && !st.force);
    save_.onclick = () => save(tab);
    out.push(save_);
    if (dirtyCount() > 1) {
      const all = btn('Save all', 'fx-btn sf-ed-saveall', 'Save every file with unsaved changes (Ctrl+Shift+S)');
      all.onclick = () => saveAll();
      out.push(all);
    }
    const n = c.overlaps.length;
    if (disk === 'deleted') {
      out.push(el('span', 'This file was deleted on disk', 'sf-ed-state warn'));
      const x = btn('Close tab', 'fx-btn', 'Close this tab (your text stays until you choose)');
      x.onclick = () => host.closeTab(where, tab);
      out.push(x);
    } else if (disk === 'unmergeable') {
      out.push(el('span', narrowRow ? 'Changed on disk' : "Changed on disk to a form AIB can't edit · Compare is read-only", 'sf-ed-state warn'));
      out.push(compareBtn(where, tab));
    } else if (n) {
      const name = who(c) || 'The disk';
      const rewrite = c.meta.get('rewrite') === true;
      const long = rewrite
        ? name + ' rewrote this file · ' + n + ' overlap' + (n === 1 ? '' : 's')
        : name + ' changed lines you edited · ' + n + ' overlap' + (n === 1 ? '' : 's');
      const s = el('span', narrowRow ? n + ' overlap' + (n === 1 ? '' : 's') : long, 'sf-ed-state warn');
      s.title = long + '\nYour text stays. Save keeps your lines; Compare shows the disk version.';
      out.push(s, compareBtn(where, tab));
    }
    return out;
  }
  function compareBtn(where, tab) {
    const b = btn('Compare', 'fx-btn sf-ed-compare', 'Compare your text with the file on disk, here in this pane');
    b.onclick = () => openCompare(where, tab);
    return b;
  }
  function alert(where, tab) {
    const st = states.get(tab.id);
    if (!st || (!st.fail && !st.note)) return null;
    const row = el('div', null, 'sf-fv-alert sf-ed-alert' + (st.fail && st.fail.auto ? ' auto' : ''));
    row.setAttribute('role', 'alert');
    row.append(el('span', st.fail ? st.fail.text : st.note));
    if (st.fail && !st.fail.auto) {
      const r = btn('Retry', 'fx-btn sf-ed-retry', 'Try the save again');
      r.onclick = () => save(tab);
      row.append(r);
    }
    return row;
  }
  function foot(where, tab) {
    const st = states.get(tab.id);
    const out = [];
    if (!st || !st.client) return out;
    const c = st.client, m = c.meta;
    const eol = { lf: 'LF', crlf: 'CRLF', mixed: 'Mixed line endings (saves ' + ((st.info && st.info.eol === 'mixed') ? 'the more common' : '') + ')', none: 'LF' }[m.get('eol')] || 'LF';
    out.push(el('span', eol, 'sf-ed-eol'));
    out.push(el('span', m.get('bom') ? 'UTF-8 with BOM' : 'UTF-8', 'sf-ed-enc'));
    const p = panes.get(where + '|' + tab.id);
    if (p && p.ed) {
      const ind = p.ed.indent();
      out.push(el('span', ind === '\t' ? 'Tabs' : 'Spaces: ' + ind.length, 'sf-ed-indent'));
    }
    let status = '';
    const savedAt = Number(m.get('savedAt')) || 0, updatedAt = Number(m.get('updatedAt')) || 0, restored = Number(m.get('restoredAt')) || 0;
    if (dirty(tab) && restored && restored > savedAt) {
      status = m.get('changedWhileClosed') ? 'Restored unsaved edits from ' + time(restored) + ' · changed on disk while AIB was closed' : 'Restored unsaved edits from ' + time(restored);
    } else if (dirty(tab)) status = 'Unsaved';
    else if (updatedAt > savedAt) status = (who(c) ? 'Updated by ' + who(c) : 'Changed on disk') + ' · ' + time(updatedAt);
    else if (savedAt) status = 'Saved ' + time(savedAt);
    if (!c.synced) status = (status ? status + ' · ' : '') + 'reconnecting';
    out.push(el('span', null, 'fx-spacer'), el('span', status, 'sf-ed-status'));
    return out;
  }

  // ---- read-only files: the reason and one button ----------------------------------------------------------------------------------
  function readOnly(tab, d) {
    const s = tab.scope || {};
    if (handles(tab)) {
      // the project folder: the server decides (binary, not UTF-8, over 5 MB, aib-docs...); a 1-5 MB file is editable here
      const st = ensureOpen(tab);
      st.tab = tab;
      if (!st.readOnly) return null;
    }
    const st = handles(tab) ? states.get(tab.id) : null;
    if (st && st.readOnly) {
      const r = st.readOnly;
      const out = { text: r.reasonText || 'Read-only', button: null };
      if (r.reason === 'docs' && host.openDoc) {
        out.button = btn('Open in Docs', 'fx-btn sf-ed-docs', 'Docs are edited in the Docs tab: open this doc there');
        out.button.onclick = () => host.openDoc(tab);
      }
      return out;
    }
    if (s.root === 'chat' && s.branch) {
      const b = btn('Edit in project folder', 'fx-btn sf-ed-inproject', 'This copy is a helper\'s or subagent\'s: open the same file in the project folder to edit it');
      b.onclick = () => {
        b.disabled = true;
        Promise.resolve(host.openProjectFile(tab)).then((ok) => {
          if (ok === false) {
            b.textContent = 'Not in the project folder yet';
            b.title = 'The project folder has no ' + tab.path + ' yet (it comes with the next landing)';
          } else b.disabled = false;
        });
      };
      return { text: "Read-only · a helper's or subagent's copy", button: b };
    }
    if (s.root === 'outside') return { text: 'Read-only · outside this project', button: null };
    if (d && (d.binary || d.tooBig)) return { text: 'Read-only', button: null };
    return null;
  }

  // ---- saving ---------------------------------------------------------------------------------------------------------------------
  async function save(tab) {
    const st = stateOf(tab), c = st.client;
    if (!c || st.saving) return false;
    st.saving = true;
    redrawAll(tab.id);
    let ok = false;
    try {
      await c.whenSynced();
      await host.post('files/save', { file: st.info.file, sv: c.sv(), force: !!st.force });
      st.fail = null;
      st.note = '';
      st.force = false;
      st.retries = 0;
      ok = true;
    } catch (e) {
      const code = (e && e.code) || '', b = (e && e.body) || {};
      st.fail = null;
      st.note = '';
      if (code === 'landing_busy') {
        st.fail = { code, auto: true, text: 'Landing ' + (b.who || 'a helper') + ' · saving when it ends' };
        setTimeout(() => save(tab), 1000);
      } else if ((code === 'behind' || code === 'disk_busy') && st.retries++ < 8) {
        setTimeout(() => save(tab), 300);
      } else if (code === 'merged') {
        st.note = ''; // the overlap row says what happened; Save again keeps your lines
      } else if (code === 'unmergeable') {
        st.force = true;
        st.note = "The file changed on disk to a form AIB can't edit. Save again to overwrite it with your text.";
      } else if (code === 'deleted') {
        st.note = 'This file was deleted on disk. Save again writes it back.';
      } else {
        st.fail = { code, auto: false, text: b.error || (e && e.message) || 'Could not save' };
      }
    } finally {
      st.saving = false;
      redrawAll(tab.id);
    }
    return ok;
  }
  async function saveAll() {
    for (const t of dirtyTabs()) await save(t);
  }

  // ---- Compare: in the same pane, at the same width --------------------------------------------------------------------------------
  async function openCompare(where, tab) {
    const st = stateOf(tab), p = paneOf(where, tab), CE = root.AIBCodeEditor;
    if (!st.client || !CE || p.compare) return;
    let disk = '';
    try {
      const r = await host.getJson('/api/live/files/compare', { file: st.info.file });
      disk = r && typeof r.disk === 'string' ? r.disk : '';
    } catch (e) {
      disk = '';
    }
    const wrap = el('div', null, 'sf-code-host sf-ed-cmp');
    const shadow = wrap.attachShadow({ mode: 'open', delegatesFocus: true });
    const width = p.body.clientWidth || 0;
    p.compare = CE.compare({
      parent: shadow,
      root: shadow,
      disk,
      name: tab.name,
      live: { ytext: st.client.text, undo: p.undo || new CE.cm.Y.UndoManager(st.client.text) },
      narrow: width > 0 && width < 640,
      readOnly: st.client.meta.get('disk') === 'unmergeable',
    });
    p.compareHost = wrap;
    p.body.replaceChildren(wrap); // the editor's node is kept (detached) with its undo and caret
    host.redraw(where);
  }
  function closeCompare(where, tab) {
    const p = panes.get(where + '|' + tab.id);
    if (!p || !p.compare) return;
    p.compare.destroy();
    p.compare = null;
    p.compareHost = null;
    if (p.ed) p.body.replaceChildren(p.host);
    host.redraw(where);
    if (p.ed) p.ed.focus();
  }

  // ---- closing --------------------------------------------------------------------------------------------------------------------
  /** Whether another pane of this window shows the same tab's file. */
  function otherPane(where, tab) {
    const st = states.get(tab.id);
    if (!st || !st.info) return false;
    for (const [key, p] of panes) {
      if (key === where + '|' + tab.id || !p.tab) continue;
      const o = states.get(p.tab.id);
      if (o && o.info && o.info.file === st.info.file && (p.ed || p.compare)) return true;
    }
    return false;
  }
  function release(where, tab) {
    const key = where + '|' + tab.id, p = panes.get(key);
    if (p) {
      if (p.compare) p.compare.destroy();
      if (p.ed) p.ed.destroy();
      if (p.undo) p.undo.destroy();
      panes.delete(key);
    }
    const st = states.get(tab.id);
    if (!st || !st.info) return void states.delete(tab.id);
    const still = [...panes.keys()].some((k) => k.endsWith('|' + tab.id));
    if (still) return;
    const c = clients.get(st.info.file);
    if (c) {
      c.tabs.delete(tab.id);
      if (!c.tabs.size) {
        c.client.close();
        clients.delete(st.info.file);
      }
    }
    states.delete(tab.id);
  }
  /** The tabs of a pane now: editors of tabs that are gone (a replaced preview, a tab closed elsewhere) let go, without asking. */
  function prune(where, tabs) {
    const ids = new Set((tabs || []).map((t) => t.id));
    for (const [key, p] of [...panes]) {
      if (!key.startsWith(where + '|') || ids.has(key.slice(where.length + 1))) continue;
      const st = states.get(p.tab.id);
      if (st && st.info && !otherPane(where, p.tab)) host.post('files/close', { file: st.info.file, view: VIEW, discard: false }).catch(() => {});
      release(where, p.tab);
    }
  }
  let pop = null;
  function closePop(refocus) {
    if (!pop) return;
    pop.remove();
    pop = null;
    if (refocus && root.AgentFocusReturn) root.AgentFocusReturn.back();
  }
  /** Closing a tab: go() closes it. Unsaved text (with no other pane of this window on it) asks first, by the tab. */
  function beforeClose(where, tab, anchor, go) {
    const st = states.get(tab.id);
    const finish = (discard) => {
      if (st && st.info && !otherPane(where, tab)) {
        host.post('files/close', { file: st.info.file, view: VIEW, discard: !!discard }).catch(() => {});
      }
      release(where, tab);
      go();
    };
    if (!handles(tab) || !st || !st.client || !dirty(tab) || otherPane(where, tab)) return finish(false);
    closePop(false);
    const box = el('div', null, 'sf-close-pop');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'Unsaved changes in ' + tab.name);
    box.append(el('p', tab.name + ' has unsaved changes.', 'sf-close-msg'));
    const row = el('div', null, 'sf-close-row');
    const s = btn('Save', 'fx-btn primary', 'Save, then close the tab');
    const d = btn("Don't save", 'fx-btn', 'Close the tab and drop the unsaved changes');
    const x = btn('Cancel', 'fx-btn', 'Keep the tab open');
    s.onclick = () => {
      closePop(false);
      save(tab).then((ok) => (ok ? finish(false) : host.redraw(where)));
    };
    d.onclick = () => {
      closePop(false);
      finish(true);
    };
    x.onclick = () => closePop(true);
    row.append(s, d, x);
    box.append(row);
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closePop(true);
      }
    });
    doc().body.append(box);
    pop = box;
    const r = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: 80, bottom: 80 };
    const w = root.innerWidth || 1280;
    box.style.left = Math.max(8, Math.min(r.left, w - 300)) + 'px';
    box.style.top = Math.round(r.bottom + 4) + 'px';
    s.focus();
  }

  function init(h) {
    host = h;
    const d = doc();
    if (d && d.addEventListener) {
      d.addEventListener('pointerdown', (e) => {
        if (pop && !(e.target && e.target.closest && e.target.closest('.sf-close-pop'))) closePop(false);
      });
    }
  }

  const api = {
    init,
    handles,
    body,
    tools,
    alert,
    foot,
    readOnly,
    dirty,
    dirtyCount,
    beforeClose,
    release,
    prune,
    save,
    saveAll,
    openCompare,
    closeCompare,
    _states: states,
    _panes: panes,
    _clients: clients,
    VIEW,
  };
  root.AgentFileEditor = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
