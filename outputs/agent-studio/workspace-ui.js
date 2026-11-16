(function (root) {
  'use strict';
  // Project workspace: a rail of projects (left) with the needs-you inbox as its first button, a strip of open-chat tabs
  // (above the chat) and the list header. All state decisions live in workspace-state.js; this file reads the page's
  // conversation list, draws, and forwards clicks to the page. Conversation titles and paths are untrusted: text only,
  // never HTML.
  const doc = () => root.document;
  const St = () => root.AgentWorkspaceState;
  const el = (tag, content, cls) => {
    const n = doc().createElement(tag);
    if (content != null && content !== '') n.textContent = String(content);
    if (cls) n.className = cls;
    return n;
  };
  const btn = (content, cls, title) => {
    const b = el('button', content, cls);
    b.type = 'button';
    if (title) {
      b.title = title;
      b.setAttribute('aria-label', title.split('\n')[0]);
    }
    return b;
  };
  const STORE = 'studio-workspace-v1';

  let host = null,
    ws = null,
    items = [],
    byKey = new Map(),
    projects = [],
    selectedKey = '',
    lastSig = '';
  let strip = null,
    inboxPop = null,
    scrim = null,
    inboxOpen = false;
  const S = () => root.AgentSplitUI;
  const FU = () => root.AgentFilesUI; // files-ui.js: file tabs after the chat tabs, the file view in the middle
  const splitReady = () => !!(S() && S().ready());
  const splitOn = () => splitReady() && S().active();
  // The envelope and the list button live on the first pane's strip when the window is split.
  const findBtn = (sel) => {
    const all = doc().querySelectorAll ? Array.from(doc().querySelectorAll(sel)) : [];
    return (
      all.find((n) => n.offsetParent !== null) ||
      (strip && strip.querySelector ? strip.querySelector(sel) : null) ||
      all[0] ||
      null
    );
  };
  let draft = null; // the temporary "New chat" tab: {pk: project it will start in, from: chat key we came from, blank: add-project} or null
  const liveIds = new Map(); // chat key -> live connection id, to follow a new chat whose key changes once it has a session id
  let blankNext = false; // the next new-chat view is "add a project": no project folder is pre-filled
  let nextPk = ''; // the next new-chat view starts in this project (the "+" on a project heading)

  /* Multi-window (store-merge.js): the workspace blob splits into entries, tabs and last chat per project ('t:'/'l:' + project)
     plus the active project and the recent one. A write reads the stored blob again and changes only the entries this window
     changed and may write (a project window only its own project; the active project only the main window), so another window's
     open tabs are never written over. The saved format is unchanged. */
  const AS = () => root.AibStore || null;
  let wsStore = null;
  const wsEntries = (raw) => {
    const w = St().sanitize(raw),
      o = { _active: w.active, _recent: w.recent };
    for (const pk of Object.keys(w.tabs)) o['t:' + pk] = w.tabs[pk];
    for (const pk of Object.keys(w.last)) o['l:' + pk] = w.last[pk];
    return o;
  };
  const wsBuild = (o) => {
    const w = St().empty();
    if (typeof o._active === 'string') w.active = o._active;
    if (typeof o._recent === 'string') w.recent = o._recent;
    for (const k of Object.keys(o)) {
      if (k.startsWith('t:')) w.tabs[k.slice(2)] = o[k];
      else if (k.startsWith('l:')) w.last[k.slice(2)] = o[k];
    }
    return w;
  };
  function wsMerged() {
    if (!wsStore && AS()) {
      wsStore = AS().map(STORE, {
        entries: wsEntries,
        build: wsBuild,
        writable: (k) => (k[0] === '_' ? AS().ctx.kind === 'main' && AS().layoutWritable() : AS().mayWriteProject(k.slice(2))),
      });
      // another window changed its projects' tabs: take them; this window's active project and the strip it shows stay its own
      wsStore.onChange((obj) => {
        if (!ws) return;
        const mine = activeProjectKey();
        const next = wsBuild(obj);
        next.active = ws.active;
        next.recent = ws.recent;
        if (ws.tabs[mine]) next.tabs[mine] = ws.tabs[mine];
        else delete next.tabs[mine];
        if (ws.last[mine]) next.last[mine] = ws.last[mine];
        else delete next.last[mine];
        ws = St().sanitize(next);
        wsStore.adopt(wsEntries(ws));
      });
    }
    return wsStore;
  }
  function read() {
    try {
      return wsMerged() ? St().sanitize(wsBuild(wsMerged().load())) : St().sanitize(JSON.parse(root.localStorage.getItem(STORE)));
    } catch (e) {
      return St().empty();
    }
  }
  function write() {
    if (wsMerged()) {
      wsMerged().write(wsEntries(ws));
      return;
    }
    try {
      root.localStorage.setItem(STORE, JSON.stringify(ws));
    } catch (e) {
      /* storage may be unavailable */
    }
  }
  function commit(next) {
    if (next !== ws) {
      ws = next;
      write();
    }
  }

  // ---- page data -> items -------------------------------------------------------------------
  const keyOf = (c) => host.aliasKey(c);
  const projectKeyOf = (c) =>
    (root.AgentSidebarUI ? root.AgentSidebarUI.pathKey(root.AgentSidebarUI.rootOf(c)) : '') || 'none';
  // The text of the first pending question, when the list payload carries it (permission bodies are not in the list).
  function askOf(lv) {
    const first = lv && Array.isArray(lv.elicitations) ? lv.elicitations[0] : null;
    const p = first && first.params;
    return p && typeof p === 'object' ? String(p.message || p.title || '') : '';
  }
  // Folder kinds the dropdown filters on (git worktrees, Claude desktop scratch folders). The text rules answer at once; the
  // server adds what only the disk knows (a .git FILE pointing into a worktrees folder) and is asked once per folder.
  const kinds = new Map(),
    askedKinds = new Set();
  /* Folder kinds still on their way. Until they answer, a chat in a worktree of a Claude worktree (an AIB worktree made from
     .claude/worktrees/<name>) is filed under that Claude worktree, which the dropdown does not list, instead of the repository it
     belongs to. Seen with beta.8-test6: the saved project (its only open chat was such a chat) looked gone at the first list, so the
     sidebar moved to the first project in the dropdown and that project's last chat opened. While kinds are pending the saved
     project stays, and chat.js waits for them (settled) before reopening last session's chat. */
  let kindsPending = 0;
  const settledWaiters = [];
  const settling = () => kindsPending > 0;
  function settled(maxMs) {
    if (!settling()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (v) => {
        const i = settledWaiters.indexOf(done);
        if (i >= 0) settledWaiters.splice(i, 1);
        resolve(v);
      };
      settledWaiters.push(done);
      if (maxMs > 0) root.setTimeout(() => done(false), maxMs);
    });
  }
  function kindOfPath(path) {
    const k = kinds.get(path) || {};
    return { worktree: !!k.worktree || St().isWorktreePath(path), scratch: !!k.scratch || St().isScratchPath(path) };
  }
  // Worktree folders whose parent repository the server found: their chats are filed under that project (sidebar-ui rootOf).
  const worktreeParent = (path) => {
    const k = kinds.get(path);
    return k && k.worktreeOf ? { of: k.worktreeOf, branch: k.branch || '' } : null;
  };
  function askKinds() {
    if (!host || !host.getJson) return;
    const need = Array.from(
      new Set(
        items
          .map((i) => i.projectPath)
          .concat((host.conversations() || []).map((c) => c && (c.projectRoot || c.cwd)))
          .filter((p) => p && !askedKinds.has(p)),
      ),
    ).slice(
      0,
      100,
    );
    if (!need.length) return;
    need.forEach((p) => askedKinds.add(p));
    kindsPending++;
    const answered = () => {
      kindsPending--;
      if (settling()) return;
      lastSig = '';
      host.rerender(); // the list files the chats by their final project before anyone waiting goes on
      for (const w of settledWaiters.slice()) w(true);
    };
    Promise.resolve(host.getJson('/api/live/folders/kinds', { paths: JSON.stringify(need), parents: '1' })).then(
      (r) => {
        let changed = false;
        for (const k of Object.keys((r && r.kinds) || {})) {
          const v = r.kinds[k];
          if (v && (v.worktree || v.scratch)) {
            kinds.set(k, v);
            changed = true;
          }
        }
        if (changed && kindsPending > 1) {
          lastSig = '';
          host.rerender();
        }
        answered();
      },
      () => {
        answered(); // the text rules still apply
      },
    );
  }
  // The last thing the agent said, for the inbox's "Your turn" line.
  const lastTextFor = (c) => {
    const l = c && c.last,
      R = root.AgentInboxReply;
    return l && l.kind === 'assistant' && typeof l.text === 'string' && R ? R.contextText(l.text) : '';
  };
  const snippetFor = (c) => {
    const l = c && c.last;
    return l && l.kind === 'assistant' && typeof l.text === 'string' ? St().snippetOf(l.text) : '';
  };
  // When this page first saw each chat blocked on you (seconds). The inbox sorts and ages those rows by it: a blocked chat's
  // `activity` is "now" on every poll, which reshuffled the inbox between openings.
  const blockedSince = new Map();
  function needsSince(key, blocked) {
    if (!blocked) {
      blockedSince.delete(key);
      return 0;
    }
    if (!blockedSince.has(key)) blockedSince.set(key, Date.now() / 1000);
    return blockedSince.get(key);
  }
  // The inbox's phase of a chat (inbox-rules.js, the same rules as the server, the phone and the trays): from the agent host's
  // attention facts and the chat's marks. A chat with no agent running is never blocked and never Finished in the inbox.
  function inboxFacts(lv, e, s) {
    const IR = root.AgentInboxRules;
    // the agent host's facts; a listing without them (an older host) reads the sidebar's state
    const a = lv && lv.attention && typeof lv.attention.state === 'string' ? lv.attention : { state: s.state === 'unread' ? 'idle' : s.state };
    const phase = !lv ? 'idle' : IR ? IR.phaseOf(a, e, Date.now() / 1000) : s.state === 'needs_you' ? 'needs_you' : 'idle';
    const since = IR ? IR.waitingSince(phase, a, 0) : 0;
    return {
      phase,
      since,
      helpers: Number(a.helpers) || 0,
      question: typeof a.question === 'string' ? a.question : '',
      error: typeof a.error === 'string' ? a.error : '',
      failKind: typeof a.failKind === 'string' ? a.failKind : '',
    };
  }
  const agentNameOf = (provider) => {
    const A = root.AgentChoice;
    try {
      return (A && A.nameOf && A.nameOf(provider)) || provider || '';
    } catch (e) {
      return provider || '';
    }
  };
  function normalize(c) {
    const S = root.AgentSidebarUI,
      O = root.AgentOrganizeUI;
    const p = S.projectOf(c),
      s = S.statusOf(c),
      e = O && O.entryOf ? O.entryOf(c) || {} : {};
    const lv = c.live && !c.live.closed ? c.live : null;
    return {
      ...inboxFacts(lv, Object.assign({}, e, { yourTurnAt: Number(c.yourTurnAt) || 0 }), s), // the page's own your-turn reading
      agent: agentNameOf(c.provider),
      key: keyOf(c),
      title: host.titleOf(c),
      projectKey: projectKeyOf(c),
      projectName: p.name,
      projectAutoName: p.autoName || p.name,
      projectPath: p.path || S.rootOf(c) || '',
      provider: c.provider,
      projectWorktree: kindOfPath(p.path || S.rootOf(c) || '').worktree,
      projectScratch: kindOfPath(p.path || S.rootOf(c) || '').scratch,
      state: s.state,
      label: s.label,
      needs: s.needs,
      unread: !!s.unread,
      activity: S.activityOf(c),
      needsAt: needsSince(keyOf(c), s.state === 'needs_you'),
      pinned: !!e.pinnedAt,
      held: !!e.holdAt,
      holdNote: e.holdNote || '',
      archived: !!e.archivedAt,
      deleted: !!e.deletedAt,
      yourTurn: !!c.yourTurn,
      yourTurnAt: Number(c.yourTurnAt) || 0,
      snippet: snippetFor(c),
      elicitations: lv && Array.isArray(lv.elicitations) ? lv.elicitations.length : 0,
      auth: !!(lv && lv.auth),
      liveId: lv ? lv.id : '',
      ask: askOf(lv),
      lastText: lastTextFor(c),
      elicReqs: lv && Array.isArray(lv.elicitations) ? lv.elicitations : [],
    };
  }
  // shown: the chat on screen when the list no longer has it (a new chat whose session was ended and that the agent does not list
  // yet). It keeps its tab while it is shown, so the strip never says "No open chats" over an open chat.
  let shown = null;
  const itemOf = (key) => byKey.get(key) || (shown && key && shown.key === key ? shown : null);
  const convOf = (key) => (host.conversations() || []).find((c) => keyOf(c) === key) || null;
  // The project whose tabs the strip shows (a draft pins it to the project the new chat starts in).
  const activeProjectKey = () => St().stripProject(ws, (itemOf(selectedKey) || {}).projectKey, draft ? draft.pk : '');
  const projectOfKey = (pk) => projects.find((p) => p.key === pk) || null;

  // Projects = those derived from the chats + the projects the user added that have no chat yet (the server's added list; the
  // server lists saved chats of added projects only) + "pending" ones made with the New project dialog whose add the server has
  // not confirmed yet, all with the saved names / order. A pending project leaves the pending list once its first chat exists
  // or the server lists it as added.
  const PENDING_KEY = 'studio-pending-projects-v1';
  let pending = {};
  /* Multi-window: one entry per pending project; a write changes only the projects this window added or dropped. */
  let pendingStore = null;
  function pendingMerged() {
    if (!pendingStore && AS()) {
      pendingStore = AS().map(PENDING_KEY, { entries: (raw) => St().sanitizePending(raw) });
      pendingStore.onChange((obj) => {
        pending = St().sanitizePending(obj);
        pendingStore.adopt(pending);
      });
    }
    return pendingStore;
  }
  function readPending() {
    try {
      return St().sanitizePending(pendingMerged() ? pendingMerged().load() : JSON.parse(root.localStorage.getItem(PENDING_KEY)));
    } catch (e) {
      return {};
    }
  }
  function writePending() {
    if (pendingMerged()) {
      pendingMerged().write(pending);
      return;
    }
    try {
      root.localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
    } catch (e) {
      /* storage may be unavailable */
    }
  }
  function rebuildProjects() {
    const real = St().buildProjects(items.filter((i) => !removedProject(i.projectKey) || i.liveId));
    const added = St().addedAsPending(addedProjects);
    if (items.length || addedProjects) {
      const left = St().prunePending(pending, new Set(real.map((p) => p.key).concat(Object.keys(added))));
      if (Object.keys(left).length !== Object.keys(pending).length) {
        pending = left;
        writePending();
      }
    }
    projects = St().applyPrefs(St().withPending(real, Object.assign({}, added, pending)), prefs);
  }

  // ---- actions ------------------------------------------------------------------------------
  function openKey(key) {
    const c = convOf(key);
    if (!c) return false;
    closeOverlays();
    host.open(c);
    return true;
  }
  /* ---- routeOpen (multi-window D3, A1; design section 9) ----
     Every way of opening a chat or project (the inbox, a toast, a notification, Ctrl+K, a sidebar row, a project switch) asks
     here first. No desktop app (serve): open here, as before. This window may show it (the main window: no other window owns
     its project and it is not popped out, or the windows list is not known yet; a project window: its own project): open here,
     no server call. Else the server's route (K3 op 'route') picks the window: {to:'self'} opens here, {to:w}: that window
     opened it and nothing changes here. A failed route shows the usual notice (this window may not show it). */
  const pinnedProject = () => {
    const W = Win();
    return W && W.pinned() ? W.pinnedProject() : '';
  };
  function mayShowHere(t) {
    const W = Win();
    if (popoutKey()) return !!t && t.chat === popoutKey(); // a chat pop-out shows only its own chat, whatever is known
    if (t && t.chat && popped(t.chat)) return false; // popped out of this window: its window shows it (even before presence knows)
    if (!W || !W.canRoute()) return true;
    if (W.pinned()) return W.mayShowHere(t);
    return !W.known() || W.mayShowHere(t);
  }
  const mayShowProject = (pk) => mayShowHere({ project: pk });
  // target {chat?, project}; openHere() opens it in this window. Returns true when it was opened here or handed on.
  function routeOpen(target, openHere) {
    const W = Win(),
      t = Object.assign({}, target || {});
    if (popoutKey() && !t.project) t.project = (t.chat && (itemOf(t.chat) || {}).projectKey) || (W ? W.pinnedProject() : '');
    if (mayShowHere(t)) return openHere() !== false;
    // a pop-out never replaces its chat: without the desktop app's routing there is nowhere else to open it
    if (popoutKey() && (!W || !W.canRoute() || !host || !host.postJson || !t.project)) return false;
    if (!host || !host.postJson || !t.project) return openHere() !== false;
    W.route(t, (path, body) => host.postJson(path, body)).then(
      (r) => {
        if (r.to === 'self') openHere();
        else closeOverlays();
      },
      () => {
        if (host && host.notice) host.notice('That chat could not be opened in its window. Try again in a moment.');
      },
    );
    return true;
  }
  function routeKey(key) {
    const it = itemOf(key);
    if (!it) return openKey(key);
    return routeOpen({ chat: key, project: it.projectKey }, () => openKey(key));
  }
  // For other modules (Ctrl+K, a sidebar row): a conversation, opened by openHere() when it belongs here.
  function routeConversation(c, openHere) {
    if (!c || !host) return openHere ? openHere() : false;
    const key = keyOf(c);
    const it = itemOf(key);
    return routeOpen({ chat: key, project: it ? it.projectKey : projectKeyOf(c) }, openHere);
  }

  /* ---- a project in its own window (multi-window Phase 2B; design section 3, K3; owner decision 1a) ----
     "Open in new window" (the project menu), Ctrl+K "Open <project> in new window" and Ctrl+click on a project row all send
     K3 op 'open'. A project that already has a window: the server brings that window forward ({existed: true}). Only in the
     desktop app (window-context.js app()); in a browser (serve) the entry points are not offered, and a 501 {browser} from the
     server says why. At the cap (409) a quiet note says so. In the project list, the row of a project with its own window
     shows a small ↗; clicking the row brings that window forward (selectProject's route, K3 op 'route'; focusProjectWindow
     sends op 'focus' directly). One window: nothing changes on screen. */
  const canOpenWindows = () => {
    const W = Win();
    return !!(W && W.app() && host && host.postJson);
  };
  // The window (not this one) pinned to project pk, or ''.
  function windowOfProject(pk) {
    const W = Win();
    if (!W || !pk || !W.app()) return '';
    const w = W.others().find((x) => x.kind === 'project' && x.project === pk);
    return w ? w.w : '';
  }
  // The menu item and Ctrl+K action: not for the project this window is already pinned to, and only with a folder.
  function offersProjectWindow(pk) {
    const p = projectOfKey(pk);
    return canOpenWindows() && !!p && !!p.path && pinnedProject() !== pk;
  }
  let windowNote = null;
  function closeWindowNote() {
    if (!windowNote) return;
    clearTimeout(windowNote._t);
    windowNote.remove();
    windowNote = null;
  }
  // A quiet note in the menu's own look, where the menu was (or beside the project list); it goes after a few seconds.
  function showWindowNote(text, at) {
    closeWindowNote();
    const n = el('div', null, 'ws-menu ws-window-note');
    n.setAttribute('role', 'status');
    n.append(el('div', text, 'ws-menu-head'));
    doc().body.append(n);
    let x = at && typeof at.x === 'number' ? at.x : 0,
      y = at && typeof at.y === 'number' ? at.y : 0;
    if (!at) {
      const b = projBtn();
      const r = b && b.getBoundingClientRect ? b.getBoundingClientRect() : { left: 8, bottom: 48 };
      x = r.left;
      y = r.bottom + 4;
    }
    placeFixed(n, x, y);
    n.onclick = closeWindowNote;
    n._t = setTimeout(closeWindowNote, 5000);
    windowNote = n;
    return n;
  }
  const BROWSER_NOTE = 'Opening a project in its own window needs the AIB desktop app.';
  // at: {x, y} for the note, if one is needed. Resolves {w, existed} or null.
  function openProjectWindow(pk, at) {
    const W = Win(),
      p = projectOfKey(pk);
    if (!p || !p.path || !host || !host.postJson) return Promise.resolve(null);
    if (!W || !W.app()) {
      showWindowNote(BROWSER_NOTE, at);
      return Promise.resolve(null);
    }
    closeCtx(false);
    const body = {
      op: 'open',
      from: W.id(),
      project: { key: pk, name: String(p.name || '').slice(0, 80), path: p.path },
    };
    return Promise.resolve(host.postJson('desktop/windows', body)).then(
      (r) => {
        closeWindowNote();
        refresh(); // the ↗ mark follows once that window reports itself
        return r && typeof r === 'object' ? r : null;
      },
      (e) => {
        const status = e && e.status;
        if (status === 409) showWindowNote('AIB has 8 windows open, the most it can. Close one to open another.', at);
        else if (status === 501) showWindowNote(BROWSER_NOTE, at);
        else if (host.notice) host.notice('That project could not be opened in a new window. Try again in a moment.');
        return null;
      },
    );
  }
  // The ↗ mark's click: bring the project's window forward.
  function focusProjectWindow(pk) {
    const w = windowOfProject(pk);
    if (!w || !canOpenWindows()) return Promise.resolve(false);
    return Promise.resolve(host.postJson('desktop/windows', { op: 'focus', w })).then(
      () => true,
      () => {
        refresh(); // that window is gone: the mark goes with the next presence answer
        return false;
      },
    );
  }
  // Ctrl+click (Cmd+click) on a project row, in the desktop app: open it in its own window instead. True when it did.
  function projectClickOpensWindow(e, pk) {
    if (!e || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || !offersProjectWindow(pk)) return false;
    if (e.preventDefault) e.preventDefault();
    if (e.stopPropagation) e.stopPropagation();
    openProjectWindow(pk, { x: e.clientX || 0, y: (e.clientY || 0) + 8 });
    return true;
  }
  /* ---- a chat in its own small window (multi-window Phase 2.5A; design section 8; owner decision 4: popping out MOVES it) ----
     The pop-out page (?w=&kind=chat&mode=chat&chat=<lasting key>&project=) shows one chat: header, transcript, composer
     (body.aib-mode-chat hides the sidebar, tabs, split, Activity column, right panel and start page). It writes no layout
     (store-merge.js layoutWritable is false there); Ctrl+Shift+N, Ctrl+P, the tab keys and the split keys do nothing; Ctrl+K and
     every link go through routeOpen, so another chat opens in its own window, never over this one. Its chat gone (deleted, or
     no longer listed) closes the window (K3 op 'close').
     In the window it came from: "Pop out" in the chat's menus asks for the window (K3 op 'popout', by the chat's lasting key),
     and the tab closes here. This window remembers what it moved (sessionStorage, per window): the sidebar row shows ↗ and
     opening the chat from anywhere brings the pop-out forward (routeOpen sends it there). When the pop-out goes (its pagehide
     'bye', or it is gone from the presence answer), the tab comes back here as a background tab. */
  const popoutKey = () => {
    const W = Win();
    const c = W && W.context ? W.context() : null;
    return c && c.kind === 'chat' && c.chat ? c.chat : '';
  };
  const POPS_KEY = 'aib-chat-popouts';
  let pops = null; // [{key, project, title, w, seen, at}]
  const popListOf = () => {
    if (pops) return pops;
    try {
      const v = JSON.parse(root.sessionStorage.getItem(POPS_KEY) || '[]');
      pops = Array.isArray(v) ? v.filter((p) => p && typeof p.key === 'string' && typeof p.project === 'string') : [];
    } catch (e) {
      pops = [];
    }
    return pops;
  };
  function savePops() {
    try {
      root.sessionStorage.setItem(POPS_KEY, JSON.stringify(popListOf().slice(-8)));
    } catch (e) {
      /* private window */
    }
  }
  // The window (not this one) showing chat key, from the presence answer, or ''.
  function windowOfChat(key) {
    const W = Win();
    if (!W || !key) return '';
    const w = W.others().find((x) => x.kind === 'chat' && x.chat === key);
    return w ? w.w : '';
  }
  // Is chat key popped out (moved from this window, or shown in a pop-out the presence answer lists)?
  const popped = (key) => !!key && !popoutKey() && (popListOf().some((p) => p.key === key) || !!windowOfChat(key));
  // The chat menus' items (organize-ui.js host.menuExtras): "Pop out" in the desktop app, never inside a pop-out.
  function chatMenuItems(c) {
    if (!c || popoutKey() || !canOpenWindows()) return [];
    const key = keyOf(c);
    if (!key || popped(key)) return [];
    return [{ id: 'popout', label: 'Pop out', run: () => popOutChat(key) }];
  }
  // Resolves true when the chat's window opened (or was brought forward); its tab then closes here.
  function popOutChat(key) {
    const W = Win(),
      c = convOf(key),
      it = itemOf(key);
    const pk = (it && it.projectKey) || (c ? projectKeyOf(c) : '');
    if (!c || !pk || !W || !W.app() || !host || !host.postJson) return Promise.resolve(false);
    closeCtx(false);
    const title = String((it && it.title) || (host.titleOf ? host.titleOf(c) : '') || 'Chat').slice(0, 80);
    const body = { op: 'popout', from: W.id(), chat: { key, project: pk, title } };
    return Promise.resolve(host.postJson('desktop/windows', body)).then(
      (r) => {
        pops = popListOf().filter((p) => p.key !== key);
        pops.push({ key, project: pk, title, w: (r && typeof r.w === 'string' && r.w) || '', seen: false, at: Date.now() });
        savePops();
        if (!closeTabKey(key)) refresh();
        return true;
      },
      (e) => {
        const status = e && e.status;
        if (status === 409) showWindowNote('AIB has 8 windows open, the most it can. Close one to open another.');
        else if (status === 501) showWindowNote('Popping out a chat needs the AIB desktop app.');
        else if (host.notice) host.notice('That chat could not be popped out. Try again in a moment.');
        return false;
      },
    );
  }
  // The pop-out closed: its tab comes back in its project here, in the background (the active tab and project stay).
  function restorePopped(key) {
    const p = popListOf().find((x) => x.key === key);
    if (!p) return;
    pops = popListOf().filter((x) => x !== p);
    savePops();
    if (convOf(key) && ws) {
      const before = ws;
      const next = St().openTab(ws, p.project, key);
      commit(Object.assign({}, next, { last: before.last, recent: before.recent, active: before.active }));
    }
    refresh();
  }
  // A moved chat whose window was listed and is gone now comes back (window-context.js onChange: a new answer, or a 'bye').
  function checkPops() {
    const W = Win();
    if (!W || !W.known() || popoutKey()) return;
    let changed = false;
    /* After a restart this window's own record of the move is gone (sessionStorage is per window and per run), but the app
       restores the pop-out with the window it was moved out of (desktop-windows.json `from`, in the presence answer): this
       window takes it back as its own, so closing the pop-out still puts the tab back here. */
    const self = W.id();
    for (const o of W.others()) {
      if (!o || o.kind !== 'chat' || typeof o.chat !== 'string' || !o.chat || o.from !== self) continue;
      if (popListOf().some((p) => p.key === o.chat)) continue;
      const project = (typeof o.project === 'string' && o.project) || (itemOf(o.chat) || {}).projectKey || '';
      if (!project || !mayShowProject(project)) continue;
      popListOf().push({ key: o.chat, project, title: '', w: o.w, seen: true, at: Date.now(), adopted: true });
      changed = true;
    }
    for (const p of popListOf().slice()) {
      const w = windowOfChat(p.key);
      if (w) {
        if (!p.seen || p.w !== w) {
          p.seen = true;
          p.w = w;
          changed = true;
        }
      } else if (p.seen) restorePopped(p.key);
    }
    if (changed) savePops();
  }
  // The pop-out's chat is not there (deleted, or gone from the list): its window closes itself.
  let popGoneSeen = 0;
  function closePopout() {
    const W = Win();
    if (!W || !host || !host.postJson || !W.canRoute()) {
      try {
        root.close();
      } catch (e) {
        /* not a window the page opened */
      }
      return;
    }
    Promise.resolve(host.postJson('desktop/windows', { op: 'close', from: W.id(), w: W.id() })).catch(() => {});
  }
  function checkPopoutChat() {
    const key = popoutKey();
    if (!key || !host || !items.length) return; // an empty list is a list still loading, not proof
    const it = byKey.get(key);
    const gone = !it || !!it.deleted;
    popGoneSeen = gone ? popGoneSeen + 1 : 0;
    if (popGoneSeen === 2) closePopout(); // twice in a row: one list without it is not proof
  }
  // Keys with no meaning in a pop-out (E3): new chat, the project dropdown, the tab keys and the split keys.
  function popoutKeyOff(e) {
    if (!e || !popoutKey()) return false;
    const k = String(e.key || '').toLowerCase(),
      mod = e.ctrlKey || e.metaKey;
    const off =
      (mod && e.shiftKey && !e.altKey && k === 'n') ||
      (e.altKey && !mod && !e.shiftKey && k === 'n') ||
      ((e.ctrlKey || e.altKey) && !e.metaKey && !e.shiftKey && k === 'p') ||
      (e.ctrlKey && !e.altKey && !e.shiftKey && (k === '\\' || /^[1-9]$/.test(k))) ||
      (e.ctrlKey && e.altKey && (k === 'arrowright' || k === 'arrowleft')) ||
      !!St().shortcutFor(e);
    if (!off) return false;
    e.preventDefault();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    return true;
  }
  function initPopout() {
    const d = doc();
    if (d.body) d.body.classList.add('aib-mode-chat');
    if (root.addEventListener) root.addEventListener('keydown', popoutKeyOff, true);
  }
  /* The desktop app's routed opens (K3 route, K6 answers): a project switches this window to it, a doc opens here. False ('no')
     when this window may not show it: a pop-out, or another window owns that project. */
  function openProjectFromDesktop(pk) {
    if (!pk || popoutKey() || !mayShowProject(pk) || !projectOfKey(pk)) return false;
    if (!ws || ws.active !== pk) selectProject(pk);
    return true;
  }
  function openDocFromDesktop(project, name) {
    if (!project || !name || popoutKey() || !mayShowProject(project) || !projectOfKey(project)) return false;
    if (!ws || ws.active !== project) selectProject(project);
    const U = FU();
    if (!U || !U.openDoc || !U.currentScope) return false;
    U.openDoc(U.currentScope(), { name, title: name, where: 'tab' });
    return true;
  }
  // While a project switch opens that project's chat: its files come back as they were (files-ui.js projectShown), instead of
  // the chat being forced to the front as when you open a chat.
  let switchingProject = false;
  function selectProject(pk) {
    // a project another window owns (or, in a project window, any other project) opens there (A1, D3)
    if (pk && pk !== St().ALL && !mayShowProject(pk)) {
      routeOpen({ project: pk }, () => {
        switchingProject = true;
        try {
          selectProjectNow(pk);
        } finally {
          switchingProject = false;
        }
      });
      return;
    }
    switchingProject = true;
    try {
      selectProjectNow(pk);
    } finally {
      switchingProject = false;
    }
    if (FU() && FU().projectShown) FU().projectShown();
  }
  function selectProjectNow(pk) {
    commit(St().setActive(ws, pk));
    // A split project opens on the chat of its focused pane.
    const paneKey = splitReady() ? S().focusTarget(pk) : '';
    if (pk !== St().ALL) {
      const tabs = St().tabsOf(ws, pk),
        target =
          paneKey && tabs.includes(paneKey)
            ? paneKey
            : ws.last[pk] && tabs.includes(ws.last[pk])
              ? ws.last[pk]
              : tabs[0];
      if (target && openKey(target)) return;
      // A project with no open chat shows the new-chat view in it, never the chat of the project we came from.
      if (!target && selectedKey && (itemOf(selectedKey) || {}).projectKey !== pk && newChatIn(pk)) return;
      if (draft) draft.pk = pk;
    } else if (paneKey && openKey(paneKey)) return;
    lastSig = '';
    host.rerender();
  }
  function closeTabKey(key) {
    const it = itemOf(key),
      pk = (it && it.projectKey) || activeProjectKey();
    // With panes, the tab that takes over is the one next to it in its own pane (or the neighbouring pane's), not the project's.
    const sp = splitReady() ? S().closeTab(key) : null;
    const result = St().closeTab(ws, pk, key, sp ? sp.next : selectedKey);
    if (!result.closed && !sp) return false;
    commit(result.state);
    if (sp && sp.order && ws.active !== St().ALL) commit(St().orderTabs(ws, pk, sp.order));
    if (key === selectedKey) {
      const next = sp ? sp.next : result.next;
      if (next && openKey(next)) return true;
      host.showStart();
    }
    host.rerender();
    return true;
  }
  // x on the temporary New chat tab: throw it away and go back to the tab we came from.
  function discardDraft() {
    if (!draft) return false;
    const pk = draft.pk || activeProjectKey(),
      exit = St().draftExit(ws, pk, draft.from);
    if (!exit) return false;
    draft = null;
    lastSig = '';
    if (!openKey(exit)) host.rerender();
    return true;
  }
  function tabShortcut(e) {
    const act = St().shortcutFor(e);
    if (!act) return false;
    if (doc().querySelector && doc().querySelector('dialog[open]')) return false;
    const pk = activeProjectKey(),
      tabs = (splitOn() && S().focusTabs()) || St().tabsOf(ws, pk);
    let handled = false;
    if (act.action === 'next' || act.action === 'prev') {
      const to = St().cycle(tabs, selectedKey, act.action === 'next' ? 1 : -1);
      if (to && to !== selectedKey) openKey(to);
      handled = tabs.length > 0;
    } else if (act.action === 'jump') {
      const to = St().jump(tabs, act.n);
      if (to) {
        if (to !== selectedKey) openKey(to);
        handled = true;
      }
    } else if (act.action === 'close') {
      if (FU() && FU().showingFile && FU().showingFile()) handled = FU().closeActive();
      else handled = selectedKey ? closeTabKey(selectedKey) : discardDraft();
    }
    if (handled) {
      e.preventDefault();
      if (e.stopPropagation) e.stopPropagation();
    }
    return handled;
  }

  // ---- overlays -----------------------------------------------------------------------------
  function closeOverlays(keepList) {
    inboxOpen = false;
    if (!keepList) setListOpen(false);
    closeProjMenu(false);
    closeCtx(false);
    closeRename(false);
    if (inboxPop) inboxPop.hidden = true;
    syncExpanded();
  }
  function syncExpanded() {
    const env = findBtn('.ws-inbox-btn');
    if (env) env.setAttribute('aria-expanded', String(inboxOpen));
  }
  // The narrow-window drawer (under 1100 px) is modal: focus moves into it, Tab stays inside (the rest of the page is inert),
  // and closing it puts focus back on the list button when focus was in the drawer (or nowhere).
  const drawerEl = () => doc().getElementById('wsAsideMain');
  const mainEl = () => (doc().querySelector ? doc().querySelector('main') : null);
  function setListOpen(on) {
    const d = doc();
    if (!d.body) return;
    const was = d.body.classList.contains('ws-list-open');
    d.body.classList.toggle('ws-list-open', !!on);
    if (scrim) scrim.hidden = !on;
    const t = findBtn('.ws-list-toggle');
    if (t) t.setAttribute('aria-expanded', String(!!on));
    const m = mainEl(),
      drawer = drawerEl();
    if (m) m.inert = !!on;
    if (on && !was && drawer) {
      const a = d.activeElement;
      if (!(a && drawer.contains && drawer.contains(a))) {
        const first =
          drawer.querySelector('.connection.selected') ||
          d.getElementById('findChat') ||
          drawer.querySelector('button:not([hidden]):not(:disabled)');
        if (first && first.focus) first.focus();
      }
    } else if (!on && was) {
      const a = d.activeElement;
      if (!a || a === d.body || (drawer && drawer.contains && drawer.contains(a))) {
        const back = findBtn('.ws-list-toggle');
        if (back && back.focus) back.focus();
      }
    }
  }
  function place(pop, anchor, width) {
    if (!anchor || !anchor.getBoundingClientRect) return;
    const r = anchor.getBoundingClientRect(),
      vw = root.innerWidth || 1200;
    pop.style.top = Math.round(r.bottom + 4) + 'px';
    pop.style.left = Math.max(8, Math.min(vw - width - 8, Math.round(r.right - width))) + 'px';
    if (root.AgentTextSize) root.AgentTextSize.fitPopup(pop);
  }
  // The inbox opens just under its envelope button at the left end of the tab strip.
  function placeBelow(pop, anchor, width) {
    if (!anchor || !anchor.getBoundingClientRect) return;
    const r = anchor.getBoundingClientRect(),
      vw = root.innerWidth || 1200;
    pop.style.top = Math.round(r.bottom + 4) + 'px';
    pop.style.left = Math.max(8, Math.min(vw - width - 8, Math.round(r.left))) + 'px';
    if (root.AgentTextSize) root.AgentTextSize.fitPopup(pop);
  }
  function toggleInbox(open) {
    inboxOpen = open === undefined ? !inboxOpen : !!open;
    if (inboxOpen) closeProjMenu(false);
    drawInbox();
    inboxPop.hidden = !inboxOpen;
    if (inboxOpen) {
      placeBelow(inboxPop, findBtn('.ws-inbox-btn'), 360);
      const first = inboxPop.querySelector('.ws-inbox-row');
      if (first && first.focus) first.focus();
    }
    syncExpanded();
  }
  // ---- drawing ------------------------------------------------------------------------------
  // The dot comes from the same status words as the header and the cards (statusOf().dotClass).
  function dotFor(item) {
    const S = root.AgentSidebarUI,
      c = convOf(item.key),
      ph = c && S.phrase ? S.phrase(c) : null;
    return S.dot(item.state, ph ? ph.text : item.label, 0, ph && ph.dotClass);
  }
  function svgIcon(paths) {
    const NS = 'http://www.w3.org/2000/svg',
      d = doc();
    if (!d.createElementNS) return el('span', '☰', 'ws-glyph');
    const svg = d.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 20 20');
    svg.setAttribute('width', '20');
    svg.setAttribute('height', '20');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.5');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    const path = d.createElementNS(NS, 'path');
    path.setAttribute('d', paths);
    svg.append(path);
    return svg;
  }
  const ENVELOPE = 'M3 5.5h14v9H3zM3.5 6l6.5 5 6.5-5';
  // Project = folder, as on the project headings: one folder for a project, stacked folders for "All chats".
  const FOLDER = 'M2.5 5.5a1 1 0 0 1 1-1h4l1.5 2h7.5a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1z';
  const FOLDERS =
    'M2 8a1 1 0 0 1 1-1h3.5l1.5 1.8h6a1 1 0 0 1 1 1V16a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1zM5 4.8V4a1 1 0 0 1 1-1h3l1.5 1.8H17a1 1 0 0 1 1 1V13';
  function projIcon(all) {
    const cls = 'ws-proj-ico ' + (all ? 'all' : 'one');
    if (!doc().createElementNS) {
      const sp = el('span', null, cls);
      sp.setAttribute('aria-hidden', 'true');
      return sp;
    }
    const ic = svgIcon(all ? FOLDERS : FOLDER);
    ic.setAttribute('class', cls);
    return ic;
  }

  // The window's project colour: a 3 px stripe across the very top and the active tab's top edge follow the project the strip shows.
  // With "All chats" and no open chat there is no single project, so the stripe is neutral.
  function applyAccent() {
    const d = doc();
    if (!d.body || !d.body.style) return;
    const pk = ws.active === St().ALL ? (itemOf(selectedKey) || {}).projectKey : activeProjectKey();
    const p = pk && pk !== St().ALL ? projectOfKey(pk) : null;
    d.body.classList.toggle('ws-has-proj', !!p); // project colours were removed (owner decision); no stripe or tint
  }

  // A project folder for display: a WSL one as "Ubuntu · ~/app" (wsl-ui.js), a Windows one as it is.
  const pathText = (path) => (root.AIBWsl ? root.AIBWsl.displayPath(path) : String(path || ''));
  function drawListHead() {
    if (root.AIBWsl) root.AIBWsl.redraw(); // the distro state line follows the project on screen
    const name = doc().getElementById('wsListName'),
      trigger = projBtn();
    const p = ws.active === St().ALL ? null : projectOfKey(ws.active);
    if (name) name.textContent = p ? p.name : 'No project yet';
    if (name && name.parentNode && name.parentNode.insertBefore) {
      const old = name.parentNode.querySelector ? name.parentNode.querySelector('.ws-proj-ico') : null;
      if (old && old.remove) old.remove();
      name.parentNode.insertBefore(projIcon(!p), name);
    }
    if (trigger) {
      trigger.title =
        (p ? p.name + '\n' + (p.path ? pathText(p.path) : 'No folder') + '\n' : '') + 'Switch project (Ctrl+P)';
      trigger.setAttribute('aria-label', 'Project: ' + (p ? p.name : 'none yet') + '. Switch project (Ctrl+P)');
    }
    const pen = doc().getElementById('wsRenameProj');
    if (pen) pen.hidden = !p || !!projEdit;
    const add = doc().getElementById('new');
    if (add) {
      const t = 'New chat' + (p ? ' in ' + p.name : '') + ' (Ctrl+Shift+N)';
      add.title = t;
      add.setAttribute('aria-label', t.split(' (')[0]);
    }
    doc().body.classList.toggle('ws-project-active', !!p);
    applyAccent();
    if (projOpen) drawProjList();
  }

  // Needs-you inbox: the envelope sits at the left end of the tab strip, which is visible at every width (the project list
  // is a slide-over when narrow), with the amber count of chats waiting on you in all projects.
  /* The chat you are looking at never counts toward the inbox, and a "your turn" that arrived while you were looking at it
     stays seen after you switch away (its card keeps the Your turn mark). Remembered per browser. */
  const SEEN_TURNS_KEY = 'studio-seen-turns';
  /* Multi-window: a seen turn is one entry; marking one reads the stored list again and adds only it (the newest 400 kept), so
     a turn seen in another window stays seen. */
  let seenStore = null;
  const seenMerged = () => {
    if (!seenStore && AS()) {
      seenStore = AS().map(SEEN_TURNS_KEY, { cap: 400 });
      seenStore.onChange((obj) => {
        for (const k of Object.keys(obj)) if ((seenTurns[k] || 0) < obj[k]) seenTurns[k] = obj[k];
      });
    }
    return seenStore;
  };
  let seenTurns = (() => {
    try {
      const v = seenMerged() ? seenMerged().load() : JSON.parse(root.localStorage.getItem(SEEN_TURNS_KEY) || '{}');
      return v && typeof v === 'object' ? v : {};
    } catch (e) {
      return {};
    }
  })();
  const watching = () => {
    const d = doc();
    return !!d && d.visibilityState !== 'hidden' && (typeof d.hasFocus !== 'function' || d.hasFocus());
  };
  function noteSeenTurn(item) {
    if (!item || !item.yourTurn || !watching() || (seenTurns[item.key] || 0) >= item.yourTurnAt) return;
    seenTurns[item.key] = item.yourTurnAt;
    const keys = Object.keys(seenTurns);
    if (keys.length > 400) for (const k of keys.slice(0, keys.length - 400)) delete seenTurns[k];
    if (seenMerged()) {
      seenMerged().set(item.key, item.yourTurnAt);
      return;
    }
    try {
      root.localStorage.setItem(SEEN_TURNS_KEY, JSON.stringify(seenTurns));
    } catch (e) {
      /* private window */
    }
  }
  // The chats open in this window (inbox-rules.js openKeys): the active tab's chat (not while a file tab shows) and the chat of
  // every split pane, while the window is visible (focused or not). They are in front of you: the inbox, its badge, the window
  // title, the desktop notifications and (through the presence report, notify-ui.js) the trays and the taskbar dot leave them out.
  function openChatKeys() {
    const IR = root.AgentInboxRules,
      d = doc();
    if (!IR || !IR.openKeys) return selectedKey ? [selectedKey] : [];
    const fileShown = !!(FU() && FU().showingFile && FU().showingFile());
    const panes = splitOn()
      ? S()
          .panes()
          .map((p) => p.group && p.group.active)
          .filter((k) => k && k !== St().DRAFT && itemOf(k))
      : [];
    return IR.openKeys({
      selected: fileShown && !panes.length ? '' : selectedKey,
      panes,
      visible: !d || d.visibilityState !== 'hidden',
    });
  }
  /* Several AIB windows (window-context.js, D2): a chat open in ANY window is in front of you, so this window's inbox, badge,
     title and toasts leave it out too. One window (or no fresh presence answer): the chats open here, as before. */
  const Win = () => root.AibWindow || null;
  function frontKeys() {
    const mine = openChatKeys(),
      W = Win();
    if (!W) return mine;
    const more = W.othersOpen().filter((k) => mine.indexOf(k) < 0);
    return more.length ? mine.concat(more) : mine;
  }
  function inboxView() {
    const IR = root.AgentInboxRules,
      open = frontKeys();
    return St()
      .inbox(items)
      .filter((r) => {
        // The chat open in the window is in front of you: no row and no count, in Needs you or Finished (inbox-rules.js isOpen).
        // When you switch to another chat, a chat still waiting comes back.
        if (IR && IR.isOpen ? IR.isOpen(r.key, open) : open.indexOf(r.key) >= 0) return false;
        // a Finished chat you are looking at is seen (seenTurns below).
        // The chat you have open is never Finished, even while AIB is in the background: it is the chat you're on.
        if (r.section === 'finished') {
          if (r.key === selectedKey) return false;
          const it = itemOf(r.key);
          if (it && (seenTurns[r.key] || 0) >= it.yourTurnAt) return false;
        }
        return true;
      });
  }
  // The one number: chats blocked on you in every project (inbox-rules.js countOf). The badge, the window title, the trays and
  // the phone all show it; Finished chats never count (the envelope gets a small teal dot for them).
  const blockedOf = (rows) => rows.filter((r) => r.section === 'needs').length;
  function inboxButton() {
    const inbox = inboxView(),
      n = blockedOf(inbox),
      finished = inbox.length - n;
    const env = btn(
      null,
      'ws-inbox-btn' + (n ? ' has' : '') + (finished && !n ? ' done' : ''),
      n
        ? 'Inbox: ' + n + ' chat' + (n === 1 ? '' : 's') + ' need you (all projects)' + (finished ? ', ' + finished + ' to review' : '')
        : finished
          ? 'Inbox: nothing needs you; ' + finished + ' to review'
          : 'Inbox: nothing needs you',
    );
    env.setAttribute('aria-haspopup', 'dialog');
    env.setAttribute('aria-expanded', String(inboxOpen));
    env.append(svgIcon(ENVELOPE));
    if (n) {
      const b = el('span', n > 99 ? '99+' : n, 'ws-badge');
      b.setAttribute('aria-hidden', 'true');
      env.append(b);
    } else if (finished) env.append(el('span', null, 'ws-inbox-dot'));
    env.onclick = () => toggleInbox();
    return env;
  }

  function tabNode(key, activeKey) {
    const item = itemOf(key);
    if (!item) return null;
    const turn = item.yourTurn && item.state !== 'needs_you';
    const wrap = el(
      'div',
      null,
      'ws-tab' +
        (key === activeKey ? ' on' : '') +
        (item.state === 'needs_you' ? ' needs' : '') +
        (turn ? ' turn' : '') +
        (item.archived ? ' ws-tab-archived' : ''),
    );
    wrap.dataset.key = key;
    const main = btn(null, 'ws-tab-main');
    main.setAttribute('role', 'tab');
    main.setAttribute('aria-selected', String(key === activeKey));
    main.title =
      item.title +
      '\n' +
      item.projectName +
      ' \u00B7 ' +
      (turn ? 'Your turn' : item.label) +
      (item.archived ? '\nArchived: this tab closes when you open another chat' : '') +
      '\nClose: Alt+W';
    main.append(dotFor(item), el('span', item.title, 'ws-tab-title'));
    if (item.archived) main.append(el('span', 'Archived', 'ws-tab-flag'));
    main.onclick = () => {
      if (tabSuppress) {
        tabSuppress = false;
        return;
      }
      if (FU() && FU().showChat) FU().showChat(); // a file was showing: back to the chat
      if (key !== selectedKey) openKey(key);
    };
    const x = btn('\u00D7', 'ws-tab-x', 'Close tab: ' + item.title + ' (Alt+W)');
    x.onclick = (e) => {
      if (e && e.stopPropagation) e.stopPropagation();
      closeTabKey(key);
    };
    // Middle-click closes (and must not start the browser's autoscroll). Right-click / the ContextMenu key open the chat menu.
    wrap.addEventListener('mousedown', (e) => {
      if (e.button === 1) e.preventDefault();
    });
    wrap.addEventListener('auxclick', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        closeTabKey(key);
      }
    });
    const O = () => root.AgentOrganizeUI;
    const extras = () => (splitReady() ? S().menuItems(key) : []);
    wrap.addEventListener('contextmenu', (e) => {
      const c = convOf(key);
      if (!c || !O()) return;
      e.preventDefault();
      O().openContextMenu(c, e.clientX, e.clientY, main, extras());
    });
    main.addEventListener('keydown', (e) => {
      if (e.key !== 'ContextMenu' && !(e.key === 'F10' && e.shiftKey)) return;
      const c = convOf(key);
      if (!c || !O()) return;
      e.preventDefault();
      const r = main.getBoundingClientRect();
      O().openContextMenu(c, r.left + 16, r.bottom, main, extras());
    });
    main.addEventListener('pointerdown', (e) => startTabDrag(e, wrap, key));
    wrap.append(main, x);
    return wrap;
  }
  // The temporary tab: always the last one, active while the new-chat view is showing.
  function draftNode() {
    const wrap = el('div', null, 'ws-tab on ws-tab-draft');
    wrap.dataset.key = St().DRAFT;
    const main = btn(null, 'ws-tab-main');
    main.setAttribute('role', 'tab');
    main.setAttribute('aria-selected', 'true');
    main.title = 'New chat (not started yet)\nClose: Ctrl+W discards it';
    main.append(el('span', '+', 'ws-tab-plus'), el('span', 'New chat', 'ws-tab-title'));
    const x = btn('×', 'ws-tab-x', 'Discard the new chat tab');
    x.onclick = (e) => {
      if (e && e.stopPropagation) e.stopPropagation();
      discardDraft();
    };
    wrap.append(main, x);
    return wrap;
  }

  // ---- the tab strip --------------------------------------------------------------------------------------
  // Like VS Code and Devin: each tab is as wide as its title (CSS: 90 to 220 px, ellipsis beyond), the strip scrolls sideways
  // when the tabs do not fit (the wheel scrolls it, the active tab is brought into view), nothing auto-closes, tabs drag to
  // reorder (the order is saved) and close with x, middle-click or Alt+W.
  let tabSuppress = false;
  const revealed = new WeakMap(); // strip -> what was last brought into view there
  function revealActive(list, owner) {
    const on = list.querySelector ? list.querySelector('.ws-tab.on') : null;
    if (!on) return;
    const id = on.dataset.key + '|' + list.children.length;
    if (id === revealed.get(owner)) return;
    revealed.set(owner, id);
    const to = St().scrollToReveal(
      { left: on.offsetLeft, right: on.offsetLeft + on.offsetWidth },
      { left: list.scrollLeft, right: list.scrollLeft + list.clientWidth },
      8,
    );
    if (to !== list.scrollLeft) list.scrollLeft = to;
  }
  // One pane: the strip above the chat, as it always was. Split: one strip per pane, each with only that pane's tabs; the
  // chat-list button and the inbox sit on the first pane's strip.
  function drawStrip() {
    if (!strip) return;
    const U = root.AibUpdates;
    if (splitOn()) {
      const strips = [];
      for (const pane of S().panes())
        if (pane.strip) {
          drawStripInto(pane.strip, pane);
          strips.push(pane.strip);
        }
      // The Update button (updates-ui.js) sits at the right end of the strip at the window's top right.
      if (U && U.place) U.place(strips);
      return;
    }
    drawStripInto(strip, null);
    if (U && U.attach) U.attach(strip);
  }
  function drawStripInto(node, pane) {
    const pk = activeProjectKey(),
      hasDraft = !pane && !!draft && !selectedKey;
    const tabs = pane
      ? pane.group.tabs.filter((k) => k === St().DRAFT || itemOf(k))
      : St()
          .tabsOf(ws, pk)
          .filter((k) => itemOf(k));
    // While a file tab is showing, no chat tab is the active one.
    const fileShown = !!(FU() && FU().showingFile && FU().showingFile());
    const activeKey = pane ? pane.group.active : fileShown ? '' : selectedKey;
    const p = projectOfKey(pk);
    const before = node.querySelector ? node.querySelector('.ws-tablist') : null,
      keep = before ? before.scrollLeft : 0;
    const frag = doc().createDocumentFragment();
    if (!pane || pane.first) {
      const toggle = btn('\u2630', 'ws-list-toggle', 'Chat list');
      toggle.setAttribute('aria-controls', 'wsAsideMain');
      toggle.setAttribute('aria-expanded', String(doc().body.classList.contains('ws-list-open')));
      toggle.onclick = () => setListOpen(!doc().body.classList.contains('ws-list-open'));
      frag.append(toggle, inboxButton());
    }
    // In "All chats" the strip shows the tabs of one project; say whose.
    const label = pane ? '' : St().stripLabel(ws, p ? p.name : '');
    if (label) {
      const l = el('span', label, 'ws-strip-proj');
      l.title =
        'These are the open chats of ' +
        label +
        '. Opening a chat from another project switches the strip to that project.';
      frag.append(l);
    }
    const list = el('div', null, 'ws-tablist');
    list.setAttribute('role', 'tablist');
    list.setAttribute('aria-label', 'Open chats' + (p ? ' in ' + p.name : ''));
    for (const key of pane ? tabs : St().withDraftTab(tabs, hasDraft)) {
      const n = key === St().DRAFT ? draftNode() : tabNode(key, activeKey);
      if (n) list.append(n);
    }
    const fileTabs = (!pane || pane.first) && FU() && FU().stripNodes ? FU().stripNodes() : [];
    if (!tabs.length && !hasDraft && !fileTabs.length)
      list.append(el('span', p ? 'No open chats in ' + p.name : 'No open chats', 'ws-tabs-empty'));
    for (const n of fileTabs) list.append(n);
    list.addEventListener(
      'wheel',
      (e) => {
        const d = St().wheelScroll(e.deltaX, e.deltaY);
        if (d && list.scrollWidth > list.clientWidth) {
          list.scrollLeft += d;
          e.preventDefault();
        }
      },
      { passive: false },
    );
    // More tabs than fit: arrows at both ends and a fade on the side that hides tabs (wheel and drag still scroll).
    const back = btn('‹', 'ws-tab-scroll ws-tab-scroll-l', 'Scroll tabs left'),
      fwd = btn('›', 'ws-tab-scroll ws-tab-scroll-r', 'Scroll tabs right');
    back.hidden = fwd.hidden = true;
    back.tabIndex = fwd.tabIndex = -1; // the tabs themselves are reachable; these are for the pointer
    const page = (dir) => {
      list.scrollLeft += dir * Math.max(80, Math.round(list.clientWidth * 0.8));
      overflowMarks(list, back, fwd);
    };
    back.onclick = () => page(-1);
    fwd.onclick = () => page(1);
    list.addEventListener('scroll', () => overflowMarks(list, back, fwd), { passive: true });
    frag.append(back, list, fwd);
    const add = btn('+', 'ws-tab-new', 'New chat' + (p ? ' in ' + p.name : '') + ' (Ctrl+Shift+N)');
    add.onclick = () => {
      closeOverlays();
      if (pane) S().newChatIn(pane.id);
      const b = doc().getElementById('new');
      if (b) b.click();
    };
    frag.append(add);
    frag.append(el('span', null, 'ws-spacer'));
    // Redrawing replaces every button: a focused one (the list button after the drawer closes, a tab) hands focus to its
    // new copy instead of dropping it on the page body.
    const had = doc().activeElement,
      refocus = had && node.contains && node.contains(had) ? focusSpec(had) : null;
    node.replaceChildren(frag);
    node.dataset.tabs = String(tabs.length);
    list.scrollLeft = keep;
    revealActive(list, node);
    overflowMarks(list, back, fwd);
    if (refocus) {
      const again = node.querySelector ? node.querySelector(refocus) : null;
      if (again && again.focus) again.focus();
    }
  }
  function focusSpec(n) {
    for (const cls of ['ws-list-toggle', 'ws-inbox-btn', 'ws-tab-new', 'ws-tab-x', 'ws-tab-main']) {
      if (!(n.classList && n.classList.contains(cls))) continue;
      const tab = n.closest ? n.closest('.ws-tab') : null;
      return tab && tab.dataset && tab.dataset.key
        ? '.ws-tab[data-key="' + String(tab.dataset.key).replace(/["\\]/g, '\\$&') + '"] .' + cls
        : '.' + cls;
    }
    return null;
  }
  // Show the arrows only while the tabs overflow, disable the one at the end you are at, and fade the hidden side.
  function overflowMarks(list, back, fwd) {
    if (!list || !back || !fwd) return;
    const over = list.scrollWidth > list.clientWidth + 1,
      atStart = list.scrollLeft <= 1,
      atEnd = list.scrollLeft + list.clientWidth >= list.scrollWidth - 1;
    back.hidden = fwd.hidden = !over;
    back.disabled = !over || atStart;
    fwd.disabled = !over || atEnd;
    list.classList.toggle('fade-l', over && !atStart);
    list.classList.toggle('fade-r', over && !atEnd);
  }
  // Window or panel resizes change what fits: re-check every strip's arrows.
  function remarkOverflow() {
    const d = doc();
    if (!d.querySelectorAll) return;
    for (const list of d.querySelectorAll('.ws-tablist')) {
      const strip0 = list.parentNode;
      overflowMarks(list, strip0.querySelector('.ws-tab-scroll-l'), strip0.querySelector('.ws-tab-scroll-r'));
    }
  }

  // ---- drag a tab to reorder ---------------------------------------------------------------------------------
  let tdrag = null,
    tdropLine = null;
  function startTabDrag(e, wrap, key) {
    if (e.button !== 0 || e.pointerType === 'touch' || key === St().DRAFT) return;
    if (splitOn()) {
      S().startTabDrag(e, key, wrap);
      return;
    } // panes: the split code does reordering and moving
    tdrag = { key, wrap, x: e.clientX, on: false, dead: false, wraps: [], rects: [], scroll0: 0, from: -1, slot: -1 };
  }
  function tabDragMove(e) {
    if (!tdrag || tdrag.dead) return;
    const list = strip && strip.querySelector ? strip.querySelector('.ws-tablist') : null;
    if (!list) {
      tdrag = null;
      return;
    }
    if (!tdrag.on) {
      if (Math.abs(e.clientX - tdrag.x) < 6) return;
      tdrag.wraps = Array.from(list.querySelectorAll('.ws-tab:not(.ws-tab-draft)'));
      tdrag.from = tdrag.wraps.indexOf(tdrag.wrap);
      if (tdrag.from < 0) {
        tdrag = null;
        return;
      }
      tdrag.rects = tdrag.wraps.map((w) => w.getBoundingClientRect());
      tdrag.scroll0 = list.scrollLeft;
      tdrag.on = true;
      closeOverlays(true);
      doc().body.classList.add('ws-dragging');
      tdrag.wrap.classList.add('drag-src');
      tdropLine = el('div', null, 'ws-tab-drop');
      doc().body.append(tdropLine);
    }
    // Pulled out of the strip (down into the chat, or up): it is no longer a reorder but a move or a split.
    if (splitReady()) {
      const sr = strip.getBoundingClientRect();
      if (e.clientY > sr.bottom + 12 || e.clientY < sr.top - 12) {
        const k = tdrag.key;
        tdrag.dead = true;
        endTabDrag(false);
        S().adoptDrag(e, k);
        return;
      }
    }
    const lr = list.getBoundingClientRect();
    if (e.clientX < lr.left + 28) list.scrollLeft -= 10;
    else if (e.clientX > lr.right - 28) list.scrollLeft += 10;
    const shift = list.scrollLeft - tdrag.scroll0;
    tdrag.wrap.style.transform = 'translateX(' + Math.round(e.clientX - tdrag.x) + 'px)';
    const mids = tdrag.rects.map((r) => r.left - shift + r.width / 2),
      n = tdrag.rects.length;
    tdrag.slot = St().slotAt(mids, e.clientX);
    const moves = St().slotMoves(tdrag.from, tdrag.slot);
    tdropLine.hidden = !moves;
    if (moves) {
      const ref = tdrag.slot < n ? tdrag.rects[tdrag.slot] : tdrag.rects[n - 1],
        left = (tdrag.slot < n ? ref.left : ref.right) - shift;
      tdropLine.style.left = Math.round(left - 1) + 'px';
      tdropLine.style.top = Math.round(ref.top) + 'px';
      tdropLine.style.height = Math.round(ref.height) + 'px';
    }
  }
  function endTabDrag(commitIt) {
    if (!tdrag) return;
    const d = tdrag;
    tdrag = null;
    if (!d.on) return;
    d.wrap.classList.remove('drag-src');
    d.wrap.style.transform = '';
    doc().body.classList.remove('ws-dragging');
    if (tdropLine) {
      tdropLine.remove();
      tdropLine = null;
    }
    tabSuppress = true;
    (root.setTimeout || setTimeout)(() => {
      tabSuppress = false;
    }, 0);
    if (commitIt && !d.dead && St().slotMoves(d.from, d.slot)) {
      commit(St().reorderTabs(ws, activeProjectKey(), d.key, d.slot));
      lastSig = '';
      host.rerender();
    }
  }
  function cancelTabDrag() {
    if (!tdrag) return false;
    const had = tdrag.on;
    tdrag.dead = true;
    endTabDrag(false);
    if (!had) tdrag = null;
    return had;
  }

  // Seconds since a time, in the card's short form: now, 5m, 3h, 2d.
  function ageOf(at) {
    const n = Math.max(0, Math.floor(Date.now() / 1000 - (Number(at) || 0)));
    return !at || n < 60
      ? 'now'
      : n < 3600
        ? Math.floor(n / 60) + 'm'
        : n < 86400
          ? Math.floor(n / 3600) + 'h'
          : Math.floor(n / 86400) + 'd';
  }
  // ---- quick reply -------------------------------------------------------------------------------
  // Per-row state that survives redraws: the open reply box and its text, a send in flight, an error, "more" expanded.
  const quick = new Map();
  const qs = (key) => {
    let s = quick.get(key);
    if (!s) {
      s = { replying: false, text: '', busy: false, error: '', expanded: false };
      quick.set(key, s);
    }
    return s;
  };
  const detail = new Map(); // live id -> {needs, at, permissions: [...], loading} for approval rows (their bodies are not in the list)
  const RP = () => root.AgentInboxReply;
  const detailFor = (item) => {
    const d = item && item.liveId ? detail.get(item.liveId) : null;
    return {
      elicitations: item ? item.elicReqs || [] : [],
      permissions: d && !d.loading && d.needs === item.needs ? d.permissions : null,
    };
  };
  // Permission bodies are only in the full state of a connection; fetch it once per chat while its approval row is shown.
  function wantDetail(item, row) {
    if (!item || !item.liveId || row.kind !== 'needs' || item.elicitations || !host || !host.getJson) return;
    const d = detail.get(item.liveId);
    if (d && (d.loading || (d.needs === item.needs && Date.now() - d.at < 15000))) return;
    const rec = { needs: item.needs, at: Date.now(), permissions: [], loading: true };
    detail.set(item.liveId, rec);
    Promise.resolve(host.getJson('/api/live/state', { id: item.liveId, after: 2147483647 })).then(
      (r) => {
        rec.permissions = r && Array.isArray(r.permissions) ? r.permissions : [];
        rec.loading = false;
        rec.at = Date.now();
        if (inboxOpen) drawInbox();
      },
      () => {
        rec.loading = false;
        rec.at = Date.now();
        rec.permissions = [];
        if (inboxOpen) drawInbox();
      },
    );
  }
  const rowKeys = () => inboxView().map((r) => r.key);
  function rowEl(key) {
    return inboxPop
      ? Array.from(inboxPop.querySelectorAll('.ws-inbox-item')).find((n) => n.dataset.key === key) || null
      : null;
  }
  function focusRow(key) {
    const w = rowEl(key),
      b = w && w.querySelector('.ws-inbox-row');
    if (b && b.focus) b.focus();
    return !!b;
  }
  // After a row leaves, focus goes to its neighbour (or the envelope when the inbox is empty).
  function focusNeighbour(keys, key) {
    const i = keys.indexOf(key),
      now = rowKeys();
    const pick = now.includes(keys[i + 1]) ? keys[i + 1] : now.includes(keys[i - 1]) ? keys[i - 1] : now[0];
    if (pick && focusRow(pick)) return;
    const env = findBtn('.ws-inbox-btn');
    if (env && env.focus) env.focus();
  }
  async function sendQuick(key) {
    const s = qs(key),
      text = s.text.trim(),
      c = convOf(key);
    if (s.busy || !text) return;
    if (!c || !host.quickPrompt) {
      s.error = 'This chat is not available. Use Open chat.';
      drawInbox();
      return;
    }
    const keys = rowKeys();
    s.busy = true;
    s.error = '';
    drawInbox();
    try {
      const res = await host.quickPrompt(c, text);
      if (res && res.queued) {
        // the agent is busy: the message waits in the chat's queue; say so in the row
        s.busy = false;
        s.replying = false;
        s.text = '';
        s.queued = true;
        drawInbox();
        focusRow(key);
        return;
      }
      quick.delete(key);
      drawInbox();
      focusNeighbour(keys, key);
    } catch (e) {
      s.busy = false;
      s.error = (e && e.message) || 'The message could not be sent.';
      drawInbox();
      const w = rowEl(key),
        ta = w && w.querySelector('textarea');
      if (ta && ta.focus) ta.focus();
    }
  }
  // Retry on a Failed row: your last message again (text only), by the quick-reply route; the row goes once it is sent.
  async function retryQuick(key) {
    const s = qs(key),
      c = convOf(key);
    if (s.busy) return;
    if (!c || !host.retryLast) {
      s.error = 'This chat is not available. Use Open chat.';
      drawInbox();
      return;
    }
    const keys = rowKeys();
    s.busy = true;
    s.error = '';
    drawInbox();
    try {
      const res = await host.retryLast(c);
      if (res && res.attachments && host.notice) host.notice('Sent your last message again, without its attachments.');
      quick.delete(key);
      drawInbox();
      focusNeighbour(keys, key);
    } catch (e) {
      s.busy = false;
      s.error = (e && e.message) || 'The message could not be sent.';
      drawInbox();
    }
  }
  async function answerQuick(key, item, b) {
    const s = qs(key);
    if (s.busy || !item || !item.liveId || !host.postJson) return;
    const keys = rowKeys();
    s.busy = true;
    s.error = '';
    drawInbox();
    try {
      if (b.op === 'permission')
        await host.postJson('permission', { id: item.liveId, key: b.reqKey, option: b.optionId });
      else
        await host.postJson('elicitation', {
          id: item.liveId,
          key: b.reqKey,
          action: 'accept',
          content: { [b.field]: b.value },
        });
      detail.delete(item.liveId);
      quick.delete(key);
      if (host.reload) await host.reload();
      drawInbox();
      focusNeighbour(keys, key);
    } catch (e) {
      s.busy = false;
      s.error = (e && e.message) || 'The answer could not be sent.';
      detail.delete(item.liveId);
      drawInbox();
    }
  }
  // ---- the in-page toast's card (notify-ui.js): the same row, read the same way, answered the same way ----
  // {reason, line1 (the command, file, question or error), title, project, since, buttons (the agent's options, with their
  // kind), reply, retry, loading, openOnly, more, full (the whole command)}; null when the chat is not in the inbox.
  function toastCard(key) {
    const Rp = RP(),
      r = St()
        .inbox(items)
        .find((x) => x.key === key);
    if (!r || !Rp) return null;
    const item = itemOf(key);
    if (item) wantDetail(item, r);
    const d = detailFor(item),
      act = Rp.rowActions(r, d);
    const perm = !r.ask && d.permissions && d.permissions.length ? d.permissions[0] : null,
      permLine = perm && Rp.permissionTitle ? Rp.permissionTitle(perm) : '';
    const opts = perm && perm.params && Array.isArray(perm.params.options) ? perm.params.options : [];
    const tc = perm && perm.params && perm.params.toolCall,
      cmd = tc && tc.rawInput && typeof tc.rawInput.command === 'string' ? tc.rawInput.command.trim() : '';
    const line1 =
      r.reason === 'failed'
        ? r.ask || (item && item.lastText) || 'The last turn ended with an error.'
        : r.reason === 'asks'
          ? r.ask || (item && item.lastText) || r.summary
          : r.kind === 'yourTurn'
            ? (item && item.lastText) || r.snippet || r.title
            : r.ask || permLine || r.summary;
    return {
      reason: r.reason,
      line1: String(line1 || '').replace(/\s+/g, ' ').trim(),
      title: r.title,
      project: r.projectName || '',
      since: r.since || 0,
      buttons: act.buttons.map((b) => {
        const o = b.op === 'permission' ? opts.find((x) => x && x.optionId === b.optionId) : null;
        return Object.assign({}, b, o && o.kind ? { kind: String(o.kind) } : {});
      }),
      reply: !!act.reply,
      retry: !!act.retry,
      loading: !!act.loading,
      openOnly: !!act.openOnly,
      more: act.more || 0,
      full: cmd || permLine,
    };
  }
  // The toast's answers go the inbox row's way (answerQuick, sendQuick, retryQuick) and reject on failure.
  function toastSend(key, run) {
    return Promise.resolve(run()).then(() => {
      const s = quick.get(key);
      if (s && s.error) {
        const msg = s.error;
        s.error = '';
        throw new Error(msg);
      }
    });
  }
  const toastAnswer = (key, b) => toastSend(key, () => answerQuick(key, itemOf(key), b));
  const toastReply = (key, text) =>
    toastSend(key, () => {
      qs(key).text = text;
      return sendQuick(key);
    });
  const toastRetry = (key) => toastSend(key, () => retryQuick(key));
  // A desktop notification was clicked: the inbox opens on that chat's request, highlighted; the chat on screen stays.
  function openInboxOn(key) {
    if (!inboxOpen) toggleInbox(true);
    if (!key) return;
    const w = rowEl(key);
    if (!w) return;
    focusRow(key);
    w.classList.add('ws-inbox-flash');
    if (w.scrollIntoView) w.scrollIntoView({ block: 'nearest' });
    root.setTimeout(() => w.classList.remove('ws-inbox-flash'), 2400);
  }
  function startReply(key) {
    const s = qs(key);
    s.replying = true;
    drawInbox();
    const w = rowEl(key),
      ta = w && w.querySelector('textarea');
    if (ta && ta.focus) ta.focus();
  }
  function stopReply(key) {
    const s = qs(key);
    s.replying = false;
    s.error = '';
    drawInbox();
    focusRow(key);
  }
  function markDone(key) {
    const c = convOf(key);
    if (!c || !root.AgentOrganizeUI) return;
    const keys = rowKeys();
    Promise.resolve(root.AgentOrganizeUI.markHandled(c)).then(() => {
      quick.delete(key);
      drawInbox();
      focusNeighbour(keys, key);
    });
  }

  // The row the keyboard is on: the one holding focus.
  function focusedKey() {
    const a = doc().activeElement,
      w = a && a.closest ? a.closest('.ws-inbox-item') : null;
    return w ? w.dataset.key : '';
  }
  function onInboxKey(e) {
    const Rp = RP();
    if (!Rp || !inboxOpen) return;
    const rows = inboxView(),
      key = focusedKey(),
      tag = e.target && e.target.tagName,
      typing = tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT';
    const ctxRows = rows.map((r) => ({
      reply: Rp.rowActions(r, detailFor(itemOf(r.key))).reply,
      handled: !!r.handled,
    }));
    const idx = Math.max(
      0,
      rows.findIndex((r) => r.key === key),
    );
    const res = Rp.step(
      { open: true, index: idx, replying: !!(key && tag === 'TEXTAREA') },
      {
        key: e.key,
        alt: e.altKey,
        ctrl: e.ctrlKey,
        meta: e.metaKey,
        shift: e.shiftKey,
        typing,
        composing: e.isComposing,
      },
      { rows: ctxRows },
    );
    const row = rows[res.index];
    switch (res.effect) {
      case 'move':
        e.preventDefault();
        if (row) focusRow(row.key);
        break;
      case 'start-reply':
        e.preventDefault();
        if (row) startReply(row.key);
        break;
      case 'close-reply':
        e.preventDefault();
        e.stopPropagation();
        if (key) stopReply(key);
        break;
      case 'send':
        e.preventDefault();
        if (key) sendQuick(key);
        break;
      case 'mark-handled':
        e.preventDefault();
        if (row) markDone(row.key);
        break;
      case 'open-chat':
        e.preventDefault();
        if (row) routeKey(row.key);
        break;
      case 'close-inbox': {
        e.preventDefault();
        e.stopPropagation();
        closeOverlays();
        const env = findBtn('.ws-inbox-btn');
        if (env && env.focus) env.focus();
        break;
      }
      default:
        break;
    }
  }

  const actBtn = (label, cls, title) => btn(label, 'ws-qa ' + (cls || ''), title);
  // "Working: 5 chats in 3 projects": what still runs, at the foot of the inbox (working chats are not rows). No subagent count.
  function workingLine() {
    const busy = items.filter((i) => i.phase === 'working' && !i.archived && !i.deleted);
    if (!busy.length) return '';
    const projects = new Set(busy.map((i) => i.projectKey)).size;
    return 'Working: ' + busy.length + (busy.length === 1 ? ' chat' : ' chats') + (projects > 1 ? ' in ' + projects + ' projects' : '');
  }
  const oneLine = (t) => String(t == null ? '' : t).replace(/\s+/g, ' ').trim();
  // Line 1 of a row: the request itself (the command, the file, the question, the error, the agent's last words). Never a
  // reason word. Returns the node and its plain text (for the tooltip).
  function whatOf(r, item, pa) {
    const w = el('span', null, 'ws-inbox-what');
    const turn = r.reason === 'finished';
    if (r.reason === 'approval' && pa && (pa.target || pa.line)) {
      if (pa.verb && pa.target && pa.code) {
        w.append(doc().createTextNode(pa.verb + ' '), el('code', pa.target));
        if (pa.diff && (pa.diff.add || pa.diff.del))
          w.append(el('span', '  +' + pa.diff.add + ' −' + pa.diff.del, 'ws-inbox-q'));
      } else w.textContent = pa.line || pa.target;
    } else if (r.reason === 'question') {
      const q = item && item.elicReqs && item.elicReqs[0] && item.elicReqs[0].params;
      w.textContent = oneLine((q && q.message) || r.ask || r.summary);
    } else if (r.reason === 'signin') w.textContent = 'Sign in to the agent again to continue';
    else if (r.reason === 'failed') w.textContent = oneLine(r.ask) || 'The last turn ended with an error.';
    else if (r.reason === 'asks') w.textContent = oneLine(r.ask);
    else if (turn) w.textContent = oneLine((item && item.lastText) || r.snippet) || 'Done.';
    else w.textContent = oneLine(r.ask || r.summary);
    return w;
  }
  // The inbox (approved prototype v3): a "Needs you" section (approvals, questions, sign-ins, failed turns and questions in a
  // reply; the longest wait first; "Nothing blocked" when empty) and a "To review" section (finished turns, newest first; never
  // counted). One row = line 1 what it wants + the wait, line 2 chat title · project, at most one row of actions. Clicking a row
  // opens its chat. The keys (↑↓ R E O Esc) work without a hint row.
  function drawInbox() {
    if (!inboxPop) return;
    const Rp = RP(),
      IR = root.AgentInboxRules;
    const a = doc().activeElement,
      inPop = !!(a && inboxPop.contains && inboxPop.contains(a));
    const keep = inPop
      ? {
          key: focusedKey(),
          ta: a.tagName === 'TEXTAREA',
          start: a.selectionStart,
          end: a.selectionEnd,
          row: !!(a.classList && a.classList.contains('ws-inbox-row')),
        }
      : null;
    const rows = inboxView(),
      frag = doc().createDocumentFragment(),
      blockedN = blockedOf(rows),
      working = workingLine();
    for (const k of Array.from(quick.keys())) if (!rows.some((r) => r.key === k)) quick.delete(k);
    const NEEDS = (IR && IR.NEEDS_LABEL) || 'Needs you',
      REVIEW = (IR && IR.REVIEW_LABEL) || 'To review';
    frag.append(el('div', NEEDS, 'ws-inbox-section'));
    if (!blockedN) frag.append(el('div', (IR && IR.NOTHING_BLOCKED) || 'Nothing blocked', 'ws-inbox-none'));
    let reviewHead = false;
    const nowS = Date.now() / 1000;
    for (const r of rows) {
      const item = itemOf(r.key),
        turn = r.reason === 'finished',
        s = qs(r.key);
      if (r.section !== 'needs' && !reviewHead) {
        reviewHead = true;
        frag.append(el('div', REVIEW, 'ws-inbox-section'));
      }
      if (item) wantDetail(item, r);
      const act = Rp
        ? Rp.rowActions(r, detailFor(item))
        : { reply: false, buttons: [], handled: !!r.handled, open: true, loading: false, openOnly: false, more: 0 };
      const perms = r.reason === 'approval' && Rp ? detailFor(item).permissions : null,
        pa = perms && perms.length && Rp.permissionAction ? Rp.permissionAction(perms[0]) : null;
      const wrap = el(
        'div',
        null,
        'ws-inbox-item' + (turn ? ' turn' : '') + ' ws-s-' + r.section + ' ws-r-' + r.reason + (s.replying ? ' replying' : ''),
      );
      wrap.dataset.key = r.key;
      wrap.dataset.reason = r.reason;
      const b = btn(null, 'ws-inbox-row');
      b.dataset.key = r.key;
      // Line 1: what it wants, and the wait alone ("4m"; orange after 15 min) or how long ago it finished.
      const l1 = el('span', null, 'ws-inbox-l1');
      const what = whatOf(r, item, pa);
      const wait = IR ? IR.waitText(turn ? r.at : r.since, nowS) : { text: ageOf(r.at), long: false };
      l1.append(what, el('span', wait.text, 'ws-inbox-age' + (!turn && wait.long ? ' long' : '')));
      // Line 2: the chat title · project, quiet. A 6 px dot only on Failed and To review rows.
      const l2 = el('span', null, 'ws-inbox-l2');
      if (r.reason === 'failed') l2.append(el('span', null, 'ws-inbox-idot fail'));
      else if (turn) l2.append(el('span', null, 'ws-inbox-idot done'));
      l2.append(el('span', r.title + ' · ' + r.projectName, 'ws-inbox-where'));
      b.append(l1, l2);
      b.title = what.textContent + '\n' + r.title + ' · ' + r.projectName;
      b.setAttribute('aria-label', what.textContent + ', ' + r.title + ', ' + r.projectName + ', ' + wait.text);
      b.onclick = () => routeKey(r.key);
      wrap.append(b);
      // Clicking anywhere on the card that is not a control opens the chat too.
      wrap.onclick = (e) => {
        const t = e && e.target;
        if (t && t.closest && t.closest('button, textarea, .ws-inbox-detail')) return;
        routeKey(r.key);
      };
      // The read-only detail under line 1: the diff, the full command, or (risky) the command and what it does.
      const diff = pa && pa.diff,
        cmd = pa && pa.command;
      if (s.expanded && (diff || cmd)) {
        const d = el('div', null, 'ws-inbox-detail');
        if (diff && diff.lines.length) for (const [k, line] of diff.lines) d.append(el('span', line, 'ws-d-' + k));
        else d.textContent = '$ ' + cmd + (act.risk && act.risk.note ? '\n' + act.risk.note : '');
        wrap.append(d);
      }
      const acts = el('div', null, 'ws-inbox-acts');
      const quietBtn = (label, cls, title, fn) => {
        const q = actBtn(label, 'ws-qa-quiet ' + (cls || ''), title);
        q.onclick = (e) => {
          if (e && e.stopPropagation) e.stopPropagation();
          fn();
        };
        return q;
      };
      const toggleDetail = () => {
        s.expanded = !s.expanded;
        drawInbox();
      };
      const replyBtn = (def) => {
        const rb = actBtn('Reply', 'ws-qa-reply' + (def ? ' def' : ''), 'Reply without opening the chat (R)');
        rb.disabled = s.busy;
        rb.onclick = (e) => {
          if (e && e.stopPropagation) e.stopPropagation();
          startReply(r.key);
        };
        return rb;
      };
      const handledBtn = () => {
        const h = quietBtn('Mark handled', 'ws-inbox-handled push', 'Mark handled (E)', () => markDone(r.key));
        h.disabled = s.busy;
        return h;
      };
      if (act.reply && s.replying) {
        // the reply box takes the action row's place; Send beside it; Esc closes it
        if (r.reason === 'asks') {
          const full = Rp && Rp.contextText ? Rp.contextText((item && item.lastText) || r.ask) : r.ask;
          if (full) acts.append(el('div', full, 'ws-inbox-askfull'));
        }
        const box = el('div', null, 'ws-reply');
        const ta = doc().createElement('textarea');
        ta.className = 'ws-reply-box';
        ta.rows = 2;
        ta.value = s.text;
        ta.disabled = s.busy;
        ta.placeholder = 'Reply. Enter sends, Esc closes.';
        ta.setAttribute('aria-label', 'Reply to ' + r.title);
        const send = actBtn(s.busy ? 'Sending…' : 'Send', 'ws-qa-send def', 'Send this reply (Enter)');
        send.disabled = s.busy || !s.text.trim();
        send.onclick = (e) => {
          if (e && e.stopPropagation) e.stopPropagation();
          sendQuick(r.key);
        };
        ta.addEventListener('input', () => {
          s.text = ta.value;
          send.disabled = s.busy || !ta.value.trim();
        });
        box.append(ta, send);
        acts.append(box);
      } else if (turn) {
        // To review: Reply, and a plain × that marks it read (E does the same)
        if (s.queued) acts.append(el('span', 'Queued', 'ws-qa-note ws-qa-queued'));
        acts.append(replyBtn(false));
        acts.append(quietBtn('×', 'ws-qa-read push', 'Mark as read (E)', () => markDone(r.key)));
      } else if (r.reason === 'failed') {
        // Retry / Reply / Mark handled; another agent stays reachable in the chat itself
        const rt = actBtn(s.busy ? 'Sending…' : 'Retry', 'ws-qa-retry def', 'Send your last message again (text only; attachments are not resent)');
        rt.disabled = s.busy;
        rt.onclick = (e) => {
          if (e && e.stopPropagation) e.stopPropagation();
          retryQuick(r.key);
        };
        acts.append(rt, replyBtn(false), handledBtn());
      } else if (r.reason === 'asks') {
        if (s.queued) acts.append(el('span', 'Queued', 'ws-qa-note ws-qa-queued'));
        acts.append(replyBtn(true), handledBtn());
      } else if (act.buttons.length) {
        const deny = act.buttons.find((x) => x.tone === 'no');
        const answer = (ab, def) => {
          const x = actBtn(ab.label, 'ws-qa-choice' + (def ? ' def' : ''));
          x.disabled = s.busy;
          x.onclick = (e) => {
            if (e && e.stopPropagation) e.stopPropagation();
            answerQuick(r.key, item, ab);
          };
          return x;
        };
        if (act.review && !s.expanded) {
          // risky (push, force push, delete): never one tap; Review shows the full command and what it does first
          const rv = actBtn('Review', 'ws-qa-review def', 'See exactly what it will do before allowing');
          rv.onclick = (e) => {
            if (e && e.stopPropagation) e.stopPropagation();
            toggleDetail();
          };
          acts.append(rv);
          if (deny) acts.append(answer(deny, false));
        } else {
          const def = act.buttons.find((x) => x.tone === 'ok') || act.buttons[0];
          for (const ab of act.buttons) acts.append(answer(ab, ab === def));
          if (act.more) acts.append(el('span', '+' + act.more + ' more', 'ws-qa-note'));
          if (!act.review && diff)
            acts.append(quietBtn(s.expanded ? 'Hide diff' : 'Show diff', 'ws-qa-diff push', 'The change, read-only', toggleDetail));
          else if (!act.review && cmd && Rp.isLongCommand && Rp.isLongCommand(cmd))
            acts.append(quietBtn(s.expanded ? 'Hide command' : 'Full command', 'ws-qa-full push', 'The whole command, read-only', toggleDetail));
        }
      } else if (act.loading) {
        acts.append(el('span', 'Loading the request…', 'ws-qa-note'));
      } else if (act.handled) {
        // a sign-in or a complex question: no button; clicking the card opens the chat, where it is answered
        acts.append(handledBtn());
      }
      if (s.error) {
        const er = el('div', s.error, 'ws-inbox-err');
        er.setAttribute('role', 'alert');
        acts.append(er);
      }
      wrap.append(acts);
      frag.append(wrap);
    }
    // The foot: what still works and the way to the notification settings, on one quiet line.
    const foot = el('div', null, 'ws-inbox-foot');
    foot.append(el('span', working, 'ws-inbox-working'));
    if (root.AgentSettingsUI && root.AgentSettingsUI.open) {
      const notes = el('button', 'Notification settings…', 'ws-notify-link');
      notes.type = 'button';
      notes.addEventListener('click', () => {
        toggleInbox(false);
        root.AgentSettingsUI.open('notifications');
      });
      foot.append(notes);
    }
    frag.append(foot);
    inboxPop.replaceChildren(frag);
    if (keep && keep.key) {
      const w = rowEl(keep.key);
      if (w) {
        const t = keep.ta ? w.querySelector('textarea') : null,
          target = t || (keep.row ? w.querySelector('.ws-inbox-row') : null);
        if (target && target.focus) {
          target.focus();
          if (t && t.setSelectionRange && keep.start != null) {
            try {
              t.setSelectionRange(keep.start, keep.end);
            } catch (e) {
              /* not selectable */
            }
          }
        }
      }
    }
  }

  /* The text's height, measured on a hidden copy of the composer outside the page flow. Measuring the composer itself (height 'auto',
     read, set back) made it 2 lines tall for a moment: the chat history above grew, the browser pulled its scroll position up to
     the shorter end, and the scroll controller, which sees no size change once the composer is back, took that for you scrolling
     up (follow off, "↓ Latest" while at the bottom). It also laid the whole page out twice per key. */
  let measurer = null;
  function textHeight(box) {
    const d = box.ownerDocument || doc();
    if (!measurer || measurer.ownerDocument !== d || !measurer.isConnected) {
      measurer = d.createElement('textarea');
      measurer.setAttribute('aria-hidden', 'true');
      measurer.tabIndex = -1;
      d.body.append(measurer);
    }
    const cs = root.getComputedStyle(box);
    measurer.style.cssText =
      'position:absolute;top:0;left:-10000px;visibility:hidden;pointer-events:none;overflow:hidden;height:auto;min-height:0;max-height:none;' +
      'box-sizing:' + cs.boxSizing + ';width:' + box.getBoundingClientRect().width + 'px;';
    for (const p of ['font', 'letterSpacing', 'wordSpacing', 'lineHeight', 'textTransform', 'textIndent', 'tabSize', 'whiteSpace', 'overflowWrap', 'wordBreak', 'padding', 'borderWidth', 'borderStyle'])
      measurer.style[p] = cs[p];
    measurer.rows = box.rows || 2;
    measurer.value = box.value;
    return measurer.scrollHeight;
  }
  function autosize() {
    const box = doc().getElementById('prompt');
    if (!box || !box.style) return;
    /* A one-line composer whose text still fits stays as it is (no layout read at all). The height comes from textHeight(), a hidden
       copy that holds the text only, never the placeholder (the longer one while the agent works must not make an empty box taller). */
    if (parseFloat(box.style.height) <= 56 && box.scrollHeight <= box.clientHeight) return;
    const cap = root.ResizeUI && root.ResizeUI.composerCap ? root.ResizeUI.composerCap(root) : 200;
    const h = Math.min(cap, Math.max(56, (root.getComputedStyle ? textHeight(box) : box.scrollHeight) || 0));
    if (box.style.height !== h + 'px') box.style.height = h + 'px';
  }

  // ---- project preferences (shared via the server) --------------------------------------------
  // order, display name, colour and hidden live in studio-projects.json next to the other Studio state, so every window sees
  // the same rail. localStorage only keeps edits whose save failed, and pushes them when the server answers again.
  const PREFS_LOCAL = 'studio-project-prefs-v1';
  let prefs = null,
    prefsRev = '',
    prefsVer = 0,
    pendingSaves = 0,
    saveChain = Promise.resolve(),
    loadingPrefs = null;
  let hiddenOpen = false; // the "Hidden (n)" group in the dropdown is expanded
  // Projects removed from AIB ("Delete project…"), from the server with the preferences: their chats stay out of every list
  // until a new chat starts in the folder or one of its chats is restored (the server then forgets the removal).
  let removedKeys = new Set();
  const removedProject = (pk) => !!pk && removedKeys.has(pk);
  // The projects the user added ({key: {path, at}}), from the server with the preferences; null from a server without the list.
  let addedProjects = null;
  // A project-add answer: the added and removed lists only (a name or colour save still on its way keeps its own answer).
  function adoptAdded(r) {
    if (!pendingSaves) return adoptPrefs(r);
    const ad = r && r.added && typeof r.added === 'object' && !Array.isArray(r.added) ? r.added : null;
    const rm = r && r.removed && typeof r.removed === 'object' && !Array.isArray(r.removed) ? r.removed : null;
    if (ad) addedProjects = ad;
    if (rm) removedKeys = new Set(Object.keys(rm));
    if (host) {
      rebuildProjects();
      lastSig = '';
      host.rerender();
    }
  }
  function readLocalPrefs() {
    try {
      const raw = root.localStorage.getItem(PREFS_LOCAL);
      return raw ? St().sanitizePrefs(JSON.parse(raw)) : null;
    } catch (e) {
      return null;
    }
  }
  function writeLocalPrefs() {
    try {
      root.localStorage.setItem(PREFS_LOCAL, JSON.stringify(prefs));
    } catch (e) {
      /* storage may be unavailable */
    }
  }
  function clearLocalPrefs() {
    try {
      root.localStorage.removeItem(PREFS_LOCAL);
    } catch (e) {
      /* ignore */
    }
  }
  function adoptPrefs(r) {
    prefs = St().sanitizePrefs(r);
    const rm = r && r.removed && typeof r.removed === 'object' && !Array.isArray(r.removed) ? r.removed : null;
    if (rm) removedKeys = new Set(Object.keys(rm));
    const ad = r && r.added && typeof r.added === 'object' && !Array.isArray(r.added) ? r.added : null;
    if (ad) addedProjects = ad;
    prefsRev = (r && r.revision) || prefsRev;
    prefsVer++;
    if (host) {
      lastSig = '';
      host.rerender();
    }
  }
  // Called from the page with the revision the list route reports; fetches when another window (or the first load) changed it.
  function syncPrefs(revision) {
    if (!host || !host.getJson || pendingSaves || (revision && revision === prefsRev)) return loadingPrefs;
    if (loadingPrefs) return loadingPrefs;
    loadingPrefs = host
      .getJson('/api/live/project-prefs')
      .then(
        (r) => {
          const local = readLocalPrefs();
          adoptPrefs(r);
          if (local && (local.order.length || Object.keys(local.projects).length)) {
            // edits that could not be saved earlier
            const set = {};
            for (const k of Object.keys(local.projects)) set[k] = local.projects[k];
            saveChain = saveChain
              .then(() => host.postJson('project-prefs', { set, order: local.order }))
              .then(
                (res) => {
                  clearLocalPrefs();
                  adoptPrefs(res);
                },
                () => {},
              );
          }
        },
        () => {
          /* server unavailable: keep what we have */
        },
      )
      .finally(() => {
        loadingPrefs = null;
      });
    return loadingPrefs;
  }
  function changePrefs(next, body) {
    prefs = next;
    prefsVer++;
    lastSig = '';
    pendingSaves++;
    saveChain = saveChain
      .then(() => host.postJson('project-prefs', body))
      .then(
        (res) => {
          pendingSaves--;
          if (!pendingSaves) {
            clearLocalPrefs();
            adoptPrefs(res);
          }
        },
        () => {
          pendingSaves--;
          writeLocalPrefs();
        },
      );
    host.rerender();
  }
  const customNameFor = (cwd) => {
    const S = root.AgentSidebarUI;
    return prefs && S ? St().prefOf(prefs, S.pathKey(cwd)).name : '';
  };
  const allKeys = () => projects.map((p) => p.key);
  const visibleKeys = () =>
    St()
      .visibleProjects(projects)
      .map((p) => p.key);
  function setPrefOf(pk, patch) {
    changePrefs(St().setPref(prefs, pk, patch), { set: { [pk]: patch } });
  }
  function reorderTo(newVisible) {
    const order = St().mergeOrder(allKeys(), newVisible);
    changePrefs({ ...prefs, order }, { order });
  }
  function nudgeProject(pk, dir) {
    const keys = visibleKeys(),
      next = St().nudge(keys, pk, dir);
    if (next.join('\n') !== keys.join('\n')) reorderTo(next);
  }
  // "Delete project…": the in-page question (delete-project-ui.js), then stop its chats, remove it on the server (and its folder
  // when ticked), and move its chats to Recently deleted (organize-ui.js deleteMany).
  function deleteProject(pk, returnTo) {
    const p = projectOfKey(pk),
      D = root.AgentDeleteProjectUI,
      O = root.AgentOrganizeUI;
    if (!p || !D || !host) return null;
    const chats = items
      .filter((i) => i.projectKey === pk && !i.deleted)
      .map((i) => convOf(i.key))
      .filter(Boolean);
    const running = chats.filter((c) => c.live && !c.live.closed).length;
    const others = projects.filter((q) => q.key !== pk && q.path).map((q) => q.path);
    // the chats' titles name their copies in the "never merged" list (decision 6)
    const titles = {};
    for (const c of chats) {
      const sid = c.id || (c.live && c.live.sessionId);
      if (c.provider && sid) titles[c.provider + ':' + sid] = host.titleOf(c);
    }
    const post = (body) =>
      Promise.resolve(host.postJson('project-remove', Object.assign({ path: p.path, projects: others, titles }, body)));
    return D.show({
      name: p.name,
      path: p.path,
      chats: chats.length,
      running,
      returnTo,
      check: () => post({ check: true }),
      confirm: async (choice) => {
        const remove = () => post({ disk: !!choice.disk, expect: choice.expect || '', cleanup: choice.cleanup || { remove: [] } });
        if (O && O.deleteMany) await O.deleteMany(chats, remove);
        else await remove();
        removedKeys.add(pk);
        if (addedProjects && addedProjects[pk]) {
          addedProjects = Object.assign({}, addedProjects);
          delete addedProjects[pk];
        }
        if (pending[pk]) {
          pending = Object.assign({}, pending);
          delete pending[pk];
          writePending();
        }
        if (ws.active === pk) commit(St().setActive(ws, otherProject(pk)));
        rebuildProjects();
        lastSig = '';
        prefsRev = '';
        syncPrefs('');
        host.rerender();
      },
    });
  }
  // The project to show when the one on screen goes away (hidden, deleted): the next visible one in dropdown order.
  function otherProject(pk) {
    const vis = St()
      .visibleProjects(St().dropdownProjects(projects))
      .map((p) => p.key)
      .filter((k) => k !== pk);
    return vis[0] || St().ALL;
  }
  function hideProject(pk, hidden) {
    if (hidden && ws.active === pk) commit(St().setActive(ws, otherProject(pk)));
    setPrefOf(pk, { hidden: !!hidden });
  }
  function copyText(text) {
    try {
      if (root.navigator && root.navigator.clipboard && root.navigator.clipboard.writeText)
        return root.navigator.clipboard.writeText(text).catch(() => legacyCopy(text));
    } catch (e) {
      /* fall through */
    }
    return legacyCopy(text);
  }
  function legacyCopy(text) {
    const d = doc(),
      t = d.createElement('textarea');
    t.value = text;
    t.style.position = 'fixed';
    t.style.opacity = '0';
    d.body.append(t);
    t.select();
    try {
      d.execCommand('copy');
    } catch (e) {
      /* ignore */
    }
    t.remove();
  }

  // ---- project dropdown ---------------------------------------------------------------------
  let projPop = null,
    projFilter = null,
    projList = null,
    projOpen = false,
    projForceFilter = false,
    projQuery = '';
  const projBtn = () => doc().getElementById('wsProjectBtn');
  const FILTER_AT = 8; // the filter box shows above this many projects
  function badgeFor(needs, working, unread) {
    if (needs) return el('span', needs > 99 ? '99+' : needs, 'ws-badge');
    if (working) return el('span', null, 'ws-working');
    if (unread) return el('span', null, 'ws-unread');
    return null;
  }
  // "Need you" counts follow the inbox: the chat you're looking at and "Your turn" chats you've already seen don't count.
  function waitingFor(pk) {
    // the one number (inbox-rules.js): chats blocked on you; finished chats never count
    const keys = new Set(inboxView().filter((r) => r.section === 'needs').map((r) => r.key));
    return items.filter((i) => keys.has(i.key) && (pk == null || i.projectKey === pk)).length;
  }
  function counts(p) {
    return p.total + ' chats, ' + waitingFor(p.key) + ' need you, ' + p.working + ' working';
  }
  function projectRow(p, hiddenRow, canMove) {
    const W = root.AIBWsl,
      wsl = !!(W && W.isWsl(p.path));
    p = Object.assign({}, p, { waiting: waitingFor(p.key) });
    const row = el('div', null, 'ws-prow' + (ws.active === p.key ? ' cur' : '') + (hiddenRow ? ' hidden-row' : ''));
    row.dataset.project = p.key;
    const main = btn(
      null,
      'ws-prow-main',
      p.name +
        '\n' +
        (p.path ? (wsl ? W.tooltip(p.path) : p.path) : 'No folder') +
        (p.custom ? '\nFolder name: ' + p.autoName : '') +
        '\n' +
        counts(p),
    );
    main.setAttribute(
      'aria-label',
      p.name + (p.waiting ? ', ' + p.waiting + ' need you' : '') + (hiddenRow ? ', hidden' : ''),
    );
    main.setAttribute('aria-pressed', String(ws.active === p.key));
    main.append(projIcon(false), el('span', p.name, 'ws-prow-name'));
    // A WSL project: its distro as a chip after the name ("Ubuntu"), the agent chip's look (.vend).
    if (wsl) {
      const chip = el('span', W.distroName(W.parse(p.path).key), 'vend ws-distro');
      chip.setAttribute('aria-hidden', 'true');
      main.append(chip);
    }
    const b = badgeFor(p.waiting, p.working, p.unread);
    if (b) {
      b.setAttribute('aria-hidden', 'true');
      main.append(b);
    }
    // its own AIB window: a small ↗ (clicking the row brings that window forward through the route)
    if (windowOfProject(p.key)) {
      const mark = el('span', '↗', 'ws-prow-win');
      mark.title = 'Open in another window';
      mark.setAttribute('aria-hidden', 'true');
      main.append(mark);
      main.setAttribute('aria-label', main.getAttribute('aria-label') + ', open in another window');
    }
    main.onclick = (e) => {
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      closeProjMenu(false);
      if (projectClickOpensWindow(e, p.key)) return;
      selectProject(p.key);
    };
    main.addEventListener('pointerdown', (e) => startDrag(e, row, p.key, canMove));
    main.addEventListener('keydown', (e) => rowKey(e, p, row, canMove));
    const more = btn('\u22EF', 'ws-prow-more', 'Project options: ' + p.name);
    more.setAttribute('aria-haspopup', 'menu');
    more.onclick = (e) => {
      if (e.stopPropagation) e.stopPropagation();
      const r = more.getBoundingClientRect();
      openCtxMenu(p.key, r.right + 4, r.top, more);
    };
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openCtxMenu(p.key, e.clientX, e.clientY, main);
    });
    row.append(main, more);
    return row;
  }
  function drawProjList() {
    if (!projList) return;
    const q = projQuery,
      all = St().dropdownProjects(projects); // git worktree and scratch folders are not listed
    const vis = St().filterProjects(St().visibleProjects(all), q),
      hid = St().filterProjects(St().hiddenProjects(all), q);
    const frag = doc().createDocumentFragment(),
      canMove = !q.trim() && vis.length > 1;
    for (const p of vis) frag.append(projectRow(p, false, canMove));
    if (!vis.length && !hid.length) frag.append(el('p', 'No project matches.', 'ws-pempty'));
    if (hid.length) {
      const open = hiddenOpen || !!q.trim();
      const t = btn(null, 'ws-phidden');
      t.setAttribute('aria-expanded', String(open));
      t.append(el('span', open ? '\u25BE' : '\u25B8'), el('span', 'Hidden (' + hid.length + ')'));
      t.onclick = () => {
        hiddenOpen = !hiddenOpen;
        drawProjList();
        const again = projList.querySelector('.ws-phidden');
        if (again) again.focus();
      };
      t.addEventListener('keydown', (e) => rowKey(e, null, null, false));
      frag.append(t);
      if (open) for (const p of hid) frag.append(projectRow(p, true, false));
    }
    projList.replaceChildren(frag);
    drawProjFoot();
  }
  // The dropdown's last line: every project's chats that need you, and the way to the inbox (which lists them all).
  let projFoot = null;
  function drawProjFoot() {
    if (!projFoot) return;
    const n = waitingFor(null);
    const text = el(
      'span',
      n ? n + (n === 1 ? ' chat needs' : ' chats need') + ' you in all projects' : 'Nothing needs you in any project',
      'ws-pfoot-text',
    );
    const open = btn('Open inbox', 'ws-pfoot-inbox', 'Open the inbox: every chat that needs you (Alt+I)');
    open.onclick = () => {
      closeProjMenu(false);
      toggleInbox(true);
    };
    open.addEventListener('keydown', (e) => rowKey(e, null, null, false));
    projFoot.classList.toggle('has', !!n);
    projFoot.replaceChildren(text, open);
  }
  const focusables = () =>
    Array.from(projPop ? projPop.querySelectorAll('input:not([hidden]),.ws-prow-main,.ws-phidden,.ws-pfoot-inbox') : []);
  function stepFocus(from, dir) {
    const list = focusables(),
      at = list.indexOf(from),
      to = list[at + dir];
    if (to && to.focus) to.focus();
  }
  function rowKey(e, p, row, canMove) {
    const k = e.key;
    if (k === 'ArrowDown' || k === 'ArrowUp') {
      if (e.altKey) return;
      e.preventDefault();
      stepFocus(e.target, k === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (!p) return;
    if (k === 'ContextMenu' || (k === 'F10' && e.shiftKey)) {
      e.preventDefault();
      const r = e.target.getBoundingClientRect();
      openCtxMenu(p.key, r.left + 24, r.bottom, e.target);
      return;
    }
    if (k === 'F2') {
      e.preventDefault();
      openRename(p.key, e.target);
      return;
    }
    // Alt+Up/Down is the chat switcher's, so moving a project with the keyboard is Alt+Shift+Up/Down (or the menu).
    if (e.altKey && e.shiftKey && (k === 'ArrowUp' || k === 'ArrowDown') && canMove) {
      e.preventDefault();
      nudgeProject(p.key, k === 'ArrowUp' ? -1 : 1);
      const again = projList && projList.querySelector('.ws-prow[data-project="' + cssEsc(p.key) + '"] .ws-prow-main');
      if (again) again.focus();
    }
  }
  const cssEsc = (s) => String(s).replace(/["\\]/g, '\\$&');
  function placeFixed(node, x, y) {
    node.style.left = '0px';
    node.style.top = '0px';
    const w = node.offsetWidth || 240,
      h = node.offsetHeight || 200,
      vw = root.innerWidth || 1200,
      vh = root.innerHeight || 800;
    node.style.left = Math.max(8, Math.min(vw - w - 8, x)) + 'px';
    node.style.top = Math.max(8, Math.min(vh - h - 8, y)) + 'px';
    if (root.AgentTextSize) root.AgentTextSize.fitPopup(node);
  }
  function openProjMenu(opts) {
    if (!projPop || !host) return;
    const o = opts || {};
    closeOverlays(true);
    const narrowHidden =
      !doc().body.classList.contains('ws-list-open') &&
      root.matchMedia &&
      root.matchMedia('(max-width:1100px)').matches;
    if (narrowHidden) setListOpen(true);
    projOpen = true;
    projForceFilter = !!o.filter;
    projQuery = '';
    projFilter.value = '';
    projFilter.hidden = !(projForceFilter || St().dropdownProjects(projects).length > FILTER_AT);
    drawProjList();
    projPop.hidden = false;
    const t = projBtn(),
      r = t && t.getBoundingClientRect ? t.getBoundingClientRect() : null;
    if (narrowHidden || !r || !r.width) placeFixed(projPop, 8, 56);
    else placeFixed(projPop, r.left, r.bottom + 4);
    if (t) t.setAttribute('aria-expanded', 'true');
    const cur = projPop.querySelector('.ws-prow.cur .ws-prow-main') || projPop.querySelector('.ws-prow-main');
    const target = !projFilter.hidden && o.filter ? projFilter : cur;
    if (target && target.focus) target.focus();
  }
  function closeProjMenu(refocus) {
    if (!projOpen && (!projPop || projPop.hidden)) return;
    projOpen = false;
    if (projPop) projPop.hidden = true;
    const t = projBtn();
    if (t) {
      t.setAttribute('aria-expanded', 'false');
      if (refocus && t.focus) t.focus();
    }
  }
  function toggleProjMenu(opts) {
    if (projOpen) closeProjMenu(true);
    else openProjMenu(opts);
  }

  // ---- per-project menu and rename ------------------------------------------------------------
  let ctx = null,
    ctxReturn = null,
    renameBox = null;
  function closeCtx(refocus) {
    if (!ctx) return;
    ctx.remove();
    ctx = null;
    if (refocus && ctxReturn && ctxReturn.focus && ctxReturn.isConnected) ctxReturn.focus();
    ctxReturn = null;
  }
  // "Open in <editor>", workspace choices, Explorer and terminal (editors-ui.js). Needs the project's folder; the workspace list
  // arrives a moment after the menu opens, and then the menu is drawn again.
  function addEditorItems(m, p, pk, item, redraw) {
    const E = root.AgentEditors;
    if (!E || !p.path || !E.loaded()) return;
    const cached = E.workspacesCached(p.path);
    if (cached === null)
      E.loadWorkspaces(p.path).then((list) => {
        if (list.length) redraw();
      });
    const list = E.projectItems(E.menuModelFor(p.path, p.useWorkspace));
    if (!list.length) return;
    for (const it of list) {
      if (it.sep) {
        const d = el('div', null, 'ws-menu-sep');
        d.setAttribute('role', 'separator');
        m.append(d);
        continue;
      }
      const b = item(it.label, () => E.runProjectItem(it, p.path, { setPref: (patch) => setPrefOf(pk, patch) }));
      if (it.checked !== undefined) {
        b.setAttribute('role', 'menuitemcheckbox');
        b.setAttribute('aria-checked', String(it.checked));
      }
    }
  }
  function openCtxMenu(pk, x, y, returnTo) {
    const p = projectOfKey(pk);
    if (!p) return;
    closeCtx(false);
    closeRename(false);
    ctxReturn = returnTo || null;
    const m = el('div', null, 'ws-menu');
    m.setAttribute('role', 'menu');
    m.setAttribute('aria-label', 'Project: ' + p.name);
    m.append(el('div', p.name, 'ws-menu-head'));
    const item = (label, fn, disabled) => {
      const b = btn(label, 'ws-menu-item');
      b.setAttribute('role', 'menuitem');
      if (disabled) b.disabled = true;
      b.onclick = () => {
        closeCtx(false);
        fn();
      };
      m.append(b);
      return b;
    };
    const vis = visibleKeys(),
      at = vis.indexOf(pk);
    item('Rename\u2026', () => openRename(pk, returnTo));
    item('Reset name', () => setPrefOf(pk, { name: '' }), !p.custom);
    item('Move up', () => nudgeProject(pk, -1), p.hidden || at <= 0);
    item('Move down', () => nudgeProject(pk, 1), p.hidden || at < 0 || at >= vis.length - 1);
    item(p.hidden ? 'Show in list' : 'Hide from list', () => hideProject(pk, !p.hidden));
    item(mutedProject(pk) ? 'Unmute notifications' : 'Mute notifications', () =>
      setPrefOf(pk, { muted: !mutedProject(pk) }),
    );
    item('Copy folder path', () => copyText(p.path || ''), !p.path);
    if (offersProjectWindow(pk)) item('Open in new window', () => openProjectWindow(pk, { x, y }));
    addEditorItems(m, p, pk, item, () => ctx === m && openCtxMenu(pk, x, y, returnTo));
    if (root.AgentDeleteProjectUI && p.path) {
      const sep = el('div', null, 'ws-menu-sep');
      sep.setAttribute('role', 'separator');
      m.append(sep);
      item('Delete project…', () => deleteProject(pk, returnTo)).classList.add('ws-menu-danger');
    }
    m.addEventListener('keydown', (e) => {
      const items = Array.from(m.querySelectorAll('button:not(:disabled)')),
        at2 = items.indexOf(doc().activeElement);
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        e.preventDefault();
        items[(at2 + 1) % items.length].focus();
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        e.preventDefault();
        items[(at2 - 1 + items.length) % items.length].focus();
      } else if (e.key === 'Home') {
        e.preventDefault();
        items[0].focus();
      } else if (e.key === 'End') {
        e.preventDefault();
        items[items.length - 1].focus();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        closeCtx(true);
      }
    });
    doc().body.append(m);
    ctx = m;
    placeFixed(m, x, y);
    const first = m.querySelector('button:not(:disabled)');
    if (first) first.focus();
  }
  function closeRename(refocus) {
    if (!renameBox) return;
    const back = renameBox._return;
    renameBox.remove();
    renameBox = null;
    if (refocus && back && back.focus && back.isConnected) back.focus();
  }
  // Inline rename in the list header: the trigger is swapped for a text field (same look as the chat-name editor).
  let projEdit = null;
  function beginProjRename() {
    const trigger = projBtn(),
      pen = doc().getElementById('wsRenameProj');
    const p = ws.active === St().ALL ? null : projectOfKey(ws.active);
    if (!trigger || !p || projEdit) return false;
    closeProjMenu && closeProjMenu(false);
    const pk = p.key,
      input = doc().createElement('input');
    input.type = 'text';
    input.className = 'ws-proj-input';
    input.maxLength = 60;
    input.value = p.name;
    input.autocomplete = 'off';
    input.setAttribute('aria-label', 'Project name');
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      projEdit = null;
      const v = input.value;
      input.remove();
      trigger.hidden = false;
      if (pen) pen.hidden = false;
      if (save) {
        const cur = projectOfKey(pk);
        if (cur) {
          const n = St().nameToSave(v, cur.autoName);
          if (n !== (cur.custom ? cur.name : '')) setPrefOf(pk, { name: n });
        }
      }
      if (trigger.focus) trigger.focus();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        finish(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));
    projEdit = { input };
    trigger.hidden = true;
    if (pen) pen.hidden = true;
    trigger.parentNode.insertBefore(input, trigger);
    input.focus();
    input.select();
    return true;
  }
  function openRename(pk, returnTo) {
    const p = projectOfKey(pk);
    if (!p) return;
    closeCtx(false);
    closeRename(false);
    const f = el('form', null, 'ws-rename');
    f.setAttribute('role', 'dialog');
    f.setAttribute('aria-label', 'Rename project');
    f._return = returnTo || null;
    const label = el('label', 'Display name');
    const input = doc().createElement('input');
    input.type = 'text';
    input.maxLength = 60;
    input.value = p.name;
    input.autocomplete = 'off';
    input.id = 'wsRenameInput';
    label.htmlFor = 'wsRenameInput';
    const note = el(
      'p',
      'Only the name shown in AIB changes. The folder is not renamed. Leave empty to use the folder name (' +
        p.autoName +
        ').',
    );
    const row = el('div', null, 'row'),
      save = btn('Save'),
      cancel = btn('Cancel');
    save.type = 'submit';
    cancel.onclick = () => closeRename(true);
    row.append(cancel, save);
    f.append(label, input, note, row);
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = St().cleanName(input.value);
      closeRename(true);
      setPrefOf(pk, { name: name === p.autoName ? '' : name });
    });
    f.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeRename(true);
      }
    });
    doc().body.append(f);
    renameBox = f;
    const r = returnTo && returnTo.getBoundingClientRect ? returnTo.getBoundingClientRect() : { left: 24, bottom: 80 };
    placeFixed(f, r.left, r.bottom + 4);
    input.focus();
    input.select();
  }

  // ---- drag to reorder inside the dropdown ----------------------------------------------------
  let drag = null,
    suppressClick = false,
    dropLine = null;
  function startDrag(e, row, key, canMove) {
    if (!canMove || e.button !== 0 || e.pointerType === 'touch') return;
    drag = {
      key,
      row,
      x: e.clientX,
      y: e.clientY,
      on: false,
      dead: false,
      rows: [],
      rects: [],
      scroll0: 0,
      slot: -1,
      from: -1,
    };
  }
  function dragMove(e) {
    if (!drag || drag.dead) return;
    if (!drag.on) {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 5) return;
      drag.rows = Array.from(projList.querySelectorAll('.ws-prow[data-project]:not(.hidden-row)')).filter(
        (r) => r.dataset.project !== St().ALL,
      );
      drag.from = drag.rows.indexOf(drag.row);
      if (drag.from < 0) {
        drag = null;
        return;
      }
      drag.rects = drag.rows.map((r) => r.getBoundingClientRect());
      drag.scroll0 = projList.scrollTop;
      drag.on = true;
      closeCtx(false);
      doc().body.classList.add('ws-dragging');
      drag.row.classList.add('drag-src');
      dropLine = el('div', null, 'ws-drop');
      doc().body.append(dropLine);
    }
    const lr = projList.getBoundingClientRect();
    if (e.clientY < lr.top + 24) projList.scrollTop -= 8;
    else if (e.clientY > lr.bottom - 24) projList.scrollTop += 8;
    const shift = projList.scrollTop - drag.scroll0;
    drag.row.style.transform = 'translateY(' + Math.round(e.clientY - drag.y) + 'px)';
    const mids = drag.rects.map((r) => r.top - shift + r.height / 2);
    drag.slot = St().slotAt(mids, e.clientY);
    const moves = St().slotMoves(drag.from, drag.slot),
      n = drag.rects.length;
    dropLine.hidden = !moves;
    if (moves) {
      const ref = drag.slot < n ? drag.rects[drag.slot] : drag.rects[n - 1],
        top = (drag.slot < n ? ref.top : ref.bottom) - shift;
      dropLine.style.left = ref.left + 'px';
      dropLine.style.width = ref.width + 'px';
      dropLine.style.top = Math.round(top - 1) + 'px';
    }
  }
  function endDrag(commitIt) {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.on) {
      d.row.classList.remove('drag-src');
      d.row.style.transform = '';
      doc().body.classList.remove('ws-dragging');
      if (dropLine) {
        dropLine.remove();
        dropLine = null;
      }
      suppressClick = true;
      (root.setTimeout || setTimeout)(() => {
        suppressClick = false;
      }, 0);
      if (commitIt && !d.dead && St().slotMoves(d.from, d.slot))
        reorderTo(
          St().moveToSlot(
            d.rows.map((r) => r.dataset.project),
            d.from,
            d.slot,
          ),
        );
    }
  }
  // Escape while dragging cancels: the row snaps back and the release changes nothing.
  function cancelDrag() {
    if (!drag) return false;
    const had = drag.on;
    drag.dead = true;
    endDrag(false);
    if (!had) drag = null;
    return had;
  }

  // ---- page hooks ---------------------------------------------------------------------------
  // Desktop notifications and sounds follow the same rules as the list: chats of hidden projects and worktree / scratch
  // folders never notify, and neither do archived or deleted ones or muted projects (the inbox still lists those).
  const mutedProject = (pk) => !!(prefs && pk && St().prefOf(prefs, pk).muted);
  function notifyChats() {
    const N = root.AgentNotifyUI;
    if (!N || !N.observeItems || !root.AgentNotifyRules) return;
    const R = root.AgentNotifyRules; // the same rules as the server's notifications (notify-rules.js)
    const open = frontKeys();
    N.observeItems(
      items.map((i) => {
        const f = R.flags(
          {
            archived: i.archived,
            deleted: i.deleted,
            held: i.held,
            projectKey: i.projectKey,
            worktree: i.projectWorktree,
            scratch: i.projectScratch,
          },
          prefs,
        );
        return {
          key: i.key,
          title: i.title,
          state: i.state,
          phase: i.phase,
          since: i.since,
          needs: i.needs,
          yourTurn: i.yourTurn,
          yourTurnAt: i.yourTurnAt,
          eligible: f.eligible,
          muted: f.muted,
          selected: open.indexOf(i.key) >= 0, // open in a window: no toast, desktop notification or sound for it
        };
      }),
    );
    if (N.reportPresence) N.reportPresence(false); // the open chat changed: the server's trays and notifications follow at once
  }
  // Called by the page every time the conversation list is drawn.
  let lastSyncArgs = null;
  /* Coming back to AIB (focus or the window shown again): redraw at once, so the inbox badge and its list agree. The badge
     used to keep a count from while AIB was in the background until the next update, and the list it opened was empty. */
  if (typeof root.addEventListener === 'function') {
    const again = () => lastSyncArgs && sync(...lastSyncArgs);
    root.addEventListener('focus', again);
    const d = doc();
    if (d && typeof d.addEventListener === 'function') d.addEventListener('visibilitychange', again);
  }
  function sync(conversations, selected) {
    if (!host || !root.AgentSidebarUI) return;
    lastSyncArgs = [conversations, selected];
    items = (conversations || []).filter((c) => c && c.provider).map(normalize);
    byKey = new Map(items.map((i) => [i.key, i]));
    if (popoutKey()) checkPopoutChat();
    rebuildProjects();
    askKinds();
    // A new chat gets its session id after it opens, which changes its key: keep its tab.
    for (const i of items) {
      if (i.liveId) {
        for (const [k, id] of liveIds)
          if (id === i.liveId && k !== i.key && !byKey.has(k)) {
            commit(St().renameTab(ws, k, i.key));
            if (splitReady()) S().renameTab(k, i.key);
            liveIds.delete(k);
          }
        liveIds.set(i.key, i.liveId);
      }
    }
    selectedKey = selected ? keyOf(selected) : '';
    if (selectedKey) draft = null;
    shown = selectedKey && !byKey.has(selectedKey) && selected.provider ? normalize(selected) : null;
    const sel = itemOf(selectedKey);
    noteSeenTurn(sel);
    // An archived chat you open to look at gets a tab while it is open (marked Archived); it goes when you move on.
    if (items.length)
      commit(
        St().pruneTabs(
          ws,
          new Set(
            items
              .filter((i) => (!i.archived || i.key === selectedKey) && !i.deleted)
              .map((i) => i.key)
              .concat(shown ? [shown.key] : []),
          ),
        ),
      );
    // Once every chat is filed under its final project, a chat's tab is only in that project (older keys of it are dropped).
    if (items.length && !settling()) commit(St().dropStrayTabs(ws, new Map(items.map((i) => [i.key, i.projectKey]))));
    // One project at a time: "All chats" (kept by older versions) and projects that are gone move to the open chat's project,
    // else the most recent one, else the first in the dropdown. While folder kinds are pending, a saved project with open tabs
    // stays: its chats may only be filed under it once they answer.
    // A project window (A1, G6) stays on its own project: it never falls back through pickActive (also not while the list loads).
    const pin = pinnedProject();
    if (pin) {
      if (ws.active !== pin) commit(St().setActive(ws, pin));
    } else if ((items.length || projects.length) && !(settling() && St().tabsOf(ws, ws.active).length))
      commit(
        St().pickActive(
          ws,
          St()
            .dropdownProjects(projects)
            .map((p) => p.key),
          sel ? sel.projectKey : '',
        ),
      );
    notifyChats();
    if (sel && !sel.deleted) {
      commit(St().openTab(ws, sel.projectKey, sel.key));
      if (!sel.archived) commit(St().rememberLast(ws, sel.projectKey, sel.key));
    }
    if (root.AgentSidebarUI.setFlat) root.AgentSidebarUI.setFlat(true); // one project: no project headings in the list
    syncSplit();
    const sig =
      St().signature(items, ws, selectedKey) +
      '|' +
      (splitReady() ? S().signature() : '') +
      '|' +
      watching() +
      '|' +
      Object.keys(seenTurns).length +
      '|' +
      inboxOpen +
      '|' +
      (draft ? draft.pk + '>' + draft.from : '') +
      '|' +
      ws.recent +
      '|' +
      prefsVer +
      '|' +
      items.map((i) => (i.yourTurnAt || 0) + i.phase + (i.helpers || 0) + (i.since || 0)).join(',') +
      '|' +
      (inboxOpen ? Math.floor(Date.now() / 60000) : ''); // the inbox's phases, helpers and waits ("waited 12m" moves each minute)
    if (sig === lastSig) return;
    if (drag && drag.on) return; // do not rebuild the dropdown under a drag; the next sync redraws
    lastSig = sig;
    drawListHead();
    drawStrip();
    drawAhead();
    if (inboxOpen) drawInbox();
    if (FU() && FU().paint) FU().paint(); // the amber count on the Chats half
    autosize();
  }
  // Keep the split layout of the active project (or of "All chats") in step with the tabs, the open chat and the New chat view.
  function syncSplit() {
    if (!splitReady()) return;
    const A = ws.active,
      ALLK = St().ALL,
      ready = items.length > 0,
      sel = itemOf(selectedKey);
    const tabsK =
      A !== ALLK
        ? St()
            .tabsOf(ws, A)
            .filter((k) => itemOf(k))
        : [];
    const valid = ready
      ? new Set(items.filter((i) => (!i.archived || i.key === selectedKey) && !i.deleted).map((i) => i.key))
      : null;
    // The open chat belongs in this layout only when it is this project's (or the layout is the "All chats" one).
    const mine = sel && (A === ALLK || sel.projectKey === A) ? selectedKey : '';
    const r = S().sync({
      key: A,
      selectedKey: mine,
      valid,
      allowed: ready && A !== ALLK ? new Set(tabsK) : null,
      add: ready ? tabsK : [],
      wantDraft: !!draft && !selectedKey,
    });
    if (r && r.collapsed && A !== ALLK) commit(St().orderTabs(ws, A, r.collapsed));
  }
  // The Activity column's first row: which chat it is about (the open chat of the focused pane) and its status dot.
  function drawAhead() {
    const a = doc().getElementById('activityHead');
    if (!a) return;
    const it = itemOf(selectedKey),
      isDraft = !it && !selectedKey && !!draft;
    if (!it && !isDraft) {
      a.hidden = true;
      a.replaceChildren();
      a.title = '';
      return;
    }
    a.hidden = false;
    a.title = (it ? it.title : 'New chat') + ' \u00B7 Activity of the open chat';
    a.replaceChildren(
      it ? dotFor(it) : el('span', '+', 'ws-tab-plus'),
      el('span', it ? it.title : 'New chat', 'ahead-name'),
    );
  }
  /* The chat the page reopens at start (keepProjectFor): it opens without moving the sidebar off the project you had. You can
     pick a project with no open tabs while another project's chat stays in the middle; reopening that chat used to switch the
     sidebar to the chat's project, so AIB seemed to forget the project you had open. */
  let keepFor = '';
  function keepProjectFor(c) {
    keepFor = c && ws && ws.active !== St().ALL ? keyOf(c) : '';
  }
  // Called when the page starts showing a chat: it joins the tab set of its project, next to the one you came from.
  function noteOpened(c) {
    if (!host || !c) return;
    const pk = projectKeyOf(c),
      key = keyOf(c),
      prev = host.getSelected();
    const keep =
      keepFor &&
      keepFor === key &&
      ws.active !== St().ALL &&
      (!!projectOfKey(ws.active) || (settling() && St().tabsOf(ws, ws.active).length > 0));
    keepFor = '';
    draft = null;
    commit(St().openTab(ws, pk, key, prev && projectKeyOf(prev) === pk ? keyOf(prev) : undefined));
    commit(St().rememberLast(ws, pk, key));
    if (!keep && !pinnedProject()) commit(St().activeAfterOpen(ws, pk)); // a project window never moves off its project (A1)
    if (splitReady()) S().noteOpened(key, ws.active);
    if (switchingProject) {
      if (FU() && FU().projectShown) FU().projectShown();
    } else if (FU() && FU().showChat) FU().showChat();
    lastSig = '';
    // The narrow drawer closes when you go to another chat. The page also starts the chat it already shows again (its live
    // connection came up, a reconnect): that is not navigation, and it must not take the drawer away from a Files action in it.
    if (!(prev && keyOf(prev) === key)) setListOpen(false);
  }
  // Called when the new-chat view opens (prev = the chat we were on, if any). "+" keeps every tab and adds a temporary
  // "New chat" tab; the new chat starts in the project of the tab we were on.
  function noteNewChat(prev) {
    if (!host || !ws) return;
    const prevPk = nextPk || (prev ? projectKeyOf(prev) : (draft && draft.pk) || '');
    const from = prev ? keyOf(prev) : draft ? draft.from : '';
    if (blankNext) {
      blankNext = false;
      draft = { pk: St().draftProject(ws, prevPk), from, blank: true };
    } else draft = { pk: St().draftProject(ws, prevPk), from, blank: false };
    if (splitReady()) S().noteDraft(ws.active);
    lastSig = '';
  }
  // "+" on a project heading (or on the Chats row): the New chat view with that project's folder. pk '' (the Chats row in
  // "All chats") is the plain New chat: the project of the chat you were on, else the last one. The rail stays where it is.
  function newChatIn(pk) {
    const nb = host ? doc().getElementById('new') : null;
    if (!nb) return false;
    closeOverlays();
    nextPk = pk && pk !== St().ALL ? pk : '';
    try {
      nb.click();
    } finally {
      nextPk = '';
    }
    return true;
  }
  // "+" in the list header: the New project dialog. When it finishes the project is added (pending until its first chat
  // exists), given its display name, selected in the dropdown, and either its last chat opens or a new chat starts in it.
  function openNewProject(returnTo) {
    if (!host || !root.AgentNewProjectUI) return addProject();
    closeOverlays(true); // keep the list open (narrow screens): the "+" must stay visible to get focus back
    root.AgentNewProjectUI.open(returnTo || doc().getElementById('wsNewProject'));
  }
  function finishNewProject(res) {
    const S = root.AgentSidebarUI,
      pk = S.pathKey(res.path),
      d = doc();
    if (!items.some((i) => i.projectKey === pk && !i.archived && !i.deleted)) {
      pending = St().addPending(pending, pk, res.path);
      writePending();
    }
    // The project is added on the server (it stays pending here until the server lists it).
    if (host.postJson)
      Promise.resolve(host.postJson('project-add', { path: res.path })).then(
        (r) => adoptAdded(r),
        () => {},
      );
    const patch = {};
    if (res.name) patch.name = res.name;
    if (prefs && St().prefOf(prefs, pk).hidden) patch.hidden = false;
    if (Object.keys(patch).length) setPrefOf(pk, patch);
    rebuildProjects();
    commit(St().setActive(ws, pk));
    const target = St().chatToOpen(ws, pk, items),
      conv = target ? convOf(target) : null;
    const focusComposer = () => {
      const pr = d.getElementById('prompt');
      if (pr && pr.focus) pr.focus();
    };
    if (res.gitError && host.notice) host.notice('Folder created, but git init failed: ' + res.gitError);
    lastSig = '';
    if (conv) {
      closeOverlays();
      Promise.resolve(host.open(conv)).then(focusComposer, focusComposer);
      return;
    }
    closeOverlays();
    if (host.showStart) host.showStart();
    if (draft) draft.pk = pk;
    lastSig = '';
    host.rerender();
    focusComposer();
  }
  // Add project (older flow, used when the dialog is not available): the new-chat view with the folder box (More options) open and empty, ready for a new path.
  function addProject() {
    if (!host) return;
    closeOverlays();
    const d = doc(),
      nb = d.getElementById('new');
    blankNext = true;
    if (nb) nb.click();
    blankNext = false;
    const more = d.getElementById('newChatMore'),
      setup = d.getElementById('setup'),
      cwd = d.getElementById('cwd');
    if (more && setup && setup.hidden) more.click();
    if (cwd) {
      cwd.value = '';
      if (cwd.dispatchEvent && root.Event) cwd.dispatchEvent(new root.Event('input'));
      if (cwd.focus) cwd.focus();
    }
  }
  // Which chat to show after a reload: the rail project's last chat, else the most recent project's, matched against the
  // loaded conversation list by key or session id. Null when nothing matches (the page then shows the new-chat view).
  function restoreTarget() {
    if (!host || !ws) return null;
    const list = host.conversations() || [],
      O = root.AgentOrganizeUI;
    const usable = (c) => {
      const e = O && O.entryOf ? O.entryOf(c) || {} : {};
      return !e.archivedAt && !(e.deletedAt && !(c.live && !c.live.closed));
    };
    const paneKey = splitReady() ? S().restoreKey(ws.active) : '';
    for (const k of (paneKey ? [paneKey] : []).concat(St().restoreCandidates(ws))) {
      const sid = k.indexOf(':') >= 0 ? k.slice(k.indexOf(':') + 1) : k;
      const hit =
        list.find((c) => keyOf(c) === k && usable(c)) ||
        list.find((c) => (c.id === sid || (c.live && c.live.sessionId === sid)) && usable(c));
      if (hit) return hit;
    }
    return null;
  }
  // Make the rail show the project of this chat (used by a hand-off so the new chat sits beside the one it continues).
  const focusProjectOf = (c) => {
    if (!host || !c || !ws) return;
    const pk = projectKeyOf(c);
    if (ws.active !== pk && projectOfKey(pk)) {
      commit(St().setActive(ws, pk));
      lastSig = '';
    }
  };
  // "All chats" leaves out chats of projects you hid (they stay reachable through Ctrl+K and the inbox).
  const hiddenProject = (pk) => !!(prefs && pk && St().prefOf(prefs, pk).hidden);
  const inProject = (c) => {
    const active = ws ? ws.active : St().ALL,
      pk = projectKeyOf(c);
    if (removedProject(pk) && !(c.live && !c.live.closed)) return false;
    if (active === St().ALL && hiddenProject(pk)) return false;
    // Worktree and scratch folders are hidden from "All chats" too (same rule as the dropdown); Ctrl+K and the inbox still reach them.
    if (active === St().ALL) {
      const proj = projectOfKey(pk),
        SB = root.AgentSidebarUI,
        k = kindOfPath((proj && proj.path) || (SB ? SB.rootOf(c) : c.cwd) || ''); // S() is the split view, not the sidebar
      if (k.worktree || k.scratch) return false;
    }
    return St().inProject({ projectKey: pk }, active);
  };
  const listSignature = () => (ws ? ws.active : 'all') + '|' + prefsVer + '|' + kinds.size;
  const hasWorkspace = () => !!host;
  // The project a new chat starts in ({key, name, path}) or null: the rail's project, else (rail on "all") the project of
  // the tab we came from. Null for "add project" so the typed folder wins.
  const activeProject = () => {
    if (!ws || (draft && draft.blank)) return null;
    const pk = draft && draft.pk && draft.pk !== St().ALL ? draft.pk : ws.active !== St().ALL ? ws.active : '';
    const p = pk ? projectOfKey(pk) : null;
    return p ? { key: p.key, name: p.name, path: p.path || '' } : null;
  };

  function init(h) {
    host = h;
    if (popoutKey()) initPopout();
    ws = read();
    prefs = readLocalPrefs() || St().emptyPrefs();
    if (root.AgentSidebarUI && root.AgentSidebarUI.setNameHook)
      root.AgentSidebarUI.setNameHook((key) => (prefs ? St().prefOf(prefs, key).name : ''));
    if (root.AgentSidebarUI && root.AgentSidebarUI.setWorktreeHook) root.AgentSidebarUI.setWorktreeHook(worktreeParent);
    const d = doc();
    strip = d.getElementById('chatTabs');
    if (root.addEventListener)
      root.addEventListener('resize', () => {
        remarkOverflow();
        // The drawer (and the inert page behind it) only exists under 1100 px: widening the window closes it.
        const narrow = root.matchMedia && root.matchMedia('(max-width:1100px)').matches;
        if (!narrow && d.body && d.body.classList.contains('ws-list-open')) setListOpen(false);
      });
    if (strip && typeof root.ResizeObserver === 'function') new root.ResizeObserver(remarkOverflow).observe(strip);
    inboxPop = el('div', null, 'ws-pop ws-inbox');
    inboxPop.id = 'wsInbox';
    inboxPop.setAttribute('role', 'dialog');
    inboxPop.setAttribute('aria-label', 'Needs you across projects');
    inboxPop.hidden = true;
    projPop = el('div', null, 'ws-pmenu');
    projPop.id = 'wsProjMenu';
    projPop.setAttribute('role', 'dialog');
    projPop.setAttribute('aria-label', 'Projects');
    projPop.hidden = true;
    projFilter = d.createElement('input');
    projFilter.type = 'search';
    projFilter.className = 'ws-pfilter';
    projFilter.placeholder = 'Filter projects\u2026';
    projFilter.setAttribute('aria-label', 'Filter projects');
    projFilter.autocomplete = 'off';
    projFilter.hidden = true;
    projList = el('div', null, 'ws-plist');
    projFoot = el('div', null, 'ws-pfoot');
    projPop.append(projFilter, projList, projFoot);
    projFilter.addEventListener('input', () => {
      projQuery = projFilter.value;
      drawProjList();
    });
    projFilter.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        stepFocus(projFilter, 1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const first = projList.querySelector('.ws-prow-main');
        if (first) first.click();
      }
    });
    scrim = el('div', null, 'ws-scrim');
    scrim.hidden = true;
    scrim.onclick = () => setListOpen(false);
    inboxPop.addEventListener('keydown', onInboxKey);
    if (d.body) d.body.append(inboxPop, projPop, scrim);
    const trigger = projBtn();
    if (trigger) {
      trigger.onclick = () => toggleProjMenu();
      trigger.addEventListener('keydown', (e) => {
        if (e.key === 'F2' && beginProjRename()) e.preventDefault();
      });
    }
    const pen = d.getElementById('wsRenameProj');
    if (pen) pen.onclick = () => beginProjRename();
    pending = readPending();
    if (root.AgentNewProjectUI)
      root.AgentNewProjectUI.init({
        getJson: (p, q) => host.getJson(p, q),
        postJson: (n, b) => host.postJson(n, b),
        projects: () => projects.map((p) => ({ key: p.key, path: p.path })),
        keyOf: (path) => (root.AgentSidebarUI ? root.AgentSidebarUI.pathKey(path) : ''),
        done: finishNewProject,
      });
    const np = d.getElementById('wsNewProject');
    if (np) np.onclick = () => openNewProject(np);
    d.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Escape') {
          if (tdrag) {
            if (cancelTabDrag()) {
              e.preventDefault();
              e.stopPropagation();
            }
            return;
          }
          if (drag) {
            if (cancelDrag()) {
              e.preventDefault();
              e.stopPropagation();
            }
            return;
          }
          if (renameBox) return; // the rename form handles its own Escape
          if (ctx) {
            e.preventDefault();
            e.stopPropagation();
            closeCtx(true);
            return;
          }
          if (projOpen) {
            e.preventDefault();
            e.stopPropagation();
            closeProjMenu(true);
            return;
          }
          if (inboxOpen && e.target && e.target.tagName === 'TEXTAREA' && inboxPop.contains(e.target)) return; // Esc closes the reply box first (onInboxKey)
          if (inboxOpen || (d.body && d.body.classList.contains('ws-list-open'))) {
            const wasInbox = inboxOpen;
            closeOverlays();
            if (wasInbox) {
              const env = findBtn('.ws-inbox-btn');
              if (env && env.focus) env.focus();
            }
          }
          return;
        }
        // Alt+I opens (and closes) the inbox from anywhere.
        if (RP() && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.altKey && String(e.key).toLowerCase() === 'i') {
          if (d.querySelector && d.querySelector('dialog[open]')) return;
          e.preventDefault();
          e.stopPropagation();
          const wasOpen = inboxOpen;
          toggleInbox();
          if (wasOpen) {
            const env = findBtn('.ws-inbox-btn');
            if (env && env.focus) env.focus();
          }
          return;
        }
        // Ctrl+P opens the project dropdown with the filter focused (we cancel the browser's print dialog); Alt+P is the same
        // for browsers that do not let a page take Ctrl+P.
        if (
          host &&
          (e.ctrlKey || e.altKey) &&
          !e.metaKey &&
          !e.shiftKey &&
          String(e.key).toLowerCase() === 'p' &&
          !(e.ctrlKey && e.altKey)
        ) {
          if (d.querySelector && d.querySelector('dialog[open]')) return;
          e.preventDefault();
          e.stopPropagation();
          if (projOpen) closeProjMenu(true);
          else openProjMenu({ filter: true });
          return;
        }
        if (splitReady() && S().handleKey(e)) return; // Ctrl+\, Ctrl+1..9 with panes, Ctrl+Alt+arrows
        tabShortcut(e);
      },
      true,
    );
    d.addEventListener('pointermove', (e) => {
      dragMove(e);
      tabDragMove(e);
    });
    d.addEventListener('pointerup', () => {
      endDrag(true);
      endTabDrag(true);
    });
    d.addEventListener('pointercancel', () => {
      cancelDrag();
      cancelTabDrag();
    });
    d.addEventListener('pointerdown', (e) => {
      const t = e.target,
        within = (sel) => !!(t && t.closest && t.closest(sel));
      if (ctx && !within('.ws-menu')) closeCtx(false);
      if (renameBox && !within('.ws-rename')) closeRename(false);
      if (projOpen && !within('#wsProjMenu') && !within('.ws-menu') && !within('#wsProjectBtn')) closeProjMenu(false);
      if (!inboxOpen) return;
      if (within('#wsInbox') || within('.ws-inbox-btn')) return;
      inboxOpen = false;
      inboxPop.hidden = true;
      syncExpanded();
    });
    const prompt = d.getElementById('prompt');
    if (prompt) prompt.addEventListener('input', autosize);
    const help = d.getElementById('composerHelp');
    if (help)
      help.onclick = () => {
        const on = d.body.classList.toggle('show-composer-help');
        help.setAttribute('aria-pressed', String(on));
      };
    drawListHead();
    drawStrip();
    if (root.AgentNotifyUI && root.AgentNotifyUI.init)
      root.AgentNotifyUI.init({
        openChat: (key) => routeKey(key),
        // K6: a chat whose project another window owns (or that is popped out) is not this window's to open
        mayOpen: (key) => {
          const W = Win(),
            it = itemOf(key);
          return !W || !W.canRoute() || !it || W.mayShowHere({ chat: key, project: it.projectKey });
        },
        windowProject: () => {
          const pk = pinnedProject() || (ws && ws.active !== St().ALL ? ws.active : '');
          const p = pk ? projectOfKey(pk) : null;
          return pk ? { key: pk, name: p ? p.name : '' } : null;
        },
        openInbox: (key) => openInboxOn(key),
        // K3 route's other targets (K6): a project switches this window to it, a doc opens here; false: not this window's
        openProject: openProjectFromDesktop,
        openDoc: openDocFromDesktop,
        // the toast's card and its answers (notify-ui.js): the same row and the same routes as the inbox
        toastCard,
        toastAnswer,
        toastReply,
        toastRetry,
        mutedProjects: () =>
          Object.keys((prefs && prefs.projects) || {})
            .filter((k) => prefs.projects[k].muted)
            .map((k) => {
              const p = projectOfKey(k);
              return { key: k, name: p ? p.name : k };
            }),
        unmute: (key) => setPrefOf(key, { muted: false }),
        // whether AIB is in front and when you last used it: the server's notifications and phone pushes skip you then
        openKeys: openChatKeys, // this window's own: the server makes the union (K2 openAll)
        // resolves with the server's answer (K2: soundOwner, openAll, windows), or false when it was not delivered
        presence: (body) =>
          host.postJson
            ? Promise.resolve(host.postJson('presence', body)).then((a) => (a && typeof a === 'object' ? a : true), () => false)
            : false,
      });
    const W = Win();
    if (W) {
      // what the other windows show changed (their open chats, a window came or went): the badge, inbox, title and toasts follow
      W.onChange(() => {
        checkPops(); // a chat popped out of this window and its window closed: the tab comes back
        refresh();
      });
      // A sidebar row of a chat another window owns (its project's window, or popped out) opens there, not here (A1, D3).
      d.addEventListener(
        'click',
        (e) => {
          const t = e.target,
            row = t && t.closest ? t.closest('button.connection[data-key]') : null;
          if (!row || e.button !== 0) return;
          const key = row.dataset.key,
            it = itemOf(key);
          if (!it || mayShowHere({ chat: key, project: it.projectKey })) return;
          e.preventDefault();
          e.stopPropagation();
          routeKey(key);
        },
        true,
      );
    }
  }

  // Saved project order (dropdown order, hidden ones included) and the per-project menu, for the "All chats" groups.
  const projectOrder = () => (projects || []).map((p) => p.key);
  const openProjectCtx = (pk, x, y, returnTo) => openCtxMenu(pk, x, y, returnTo);

  // Command bar (Ctrl+K): the projects the dropdown lists (not hidden, no worktree or scratch folders), in dropdown order.
  const paletteProjects = () =>
    St()
      .visibleProjects(St().dropdownProjects(projects))
      .map((p) => ({
        key: p.key,
        name: p.name,
        path: p.path,
        waiting: waitingFor(p.key),
        working: p.working || 0,
        active: ws ? ws.active === p.key : false,
        useWorkspace: p.useWorkspace === true,
      }));
  // After the new-chat view opened from the command bar: put its tab in project pk.
  function focusNewChatIn(pk) {
    if (!host || !ws || !pk) return false;
    commit(St().setActive(ws, pk));
    if (draft) draft.pk = pk;
    lastSig = '';
    host.rerender();
    return true;
  }
  // For the split code: redraw the strips, the tabs of the one pane, put them in order, a chat's dot and status words.
  const singleTabs = () =>
    ws
      ? St()
          .tabsOf(ws, activeProjectKey())
          .filter((k) => itemOf(k))
      : [];
  const orderTabs = (list) => {
    if (ws) commit(St().orderTabs(ws, activeProjectKey(), list));
  };
  const dotForKey = (key) => {
    const it = itemOf(key);
    return it ? dotFor(it) : null;
  };
  const statusTextOf = (c) => {
    const SB = root.AgentSidebarUI,
      ph = SB && SB.phrase ? SB.phrase(c) : null;
    if (ph) return { text: ph.text, tone: ph.tone };
    const it = itemOf(keyOf(c));
    return it ? { text: it.label, tone: 'idle' } : null;
  };
  const refresh = () => {
    lastSig = '';
    if (host) host.rerender();
  };
  const api = {
    singleTabs,
    orderTabs,
    dotForKey,
    statusTextOf,
    refresh,
    paletteProjects,
    focusNewChatIn,
    newChatIn,
    deleteProject,
    projectOrder,
    openProjectCtx,
    // multi-window Phase 2B: a project in its own window
    canOpenWindows,
    offersProjectWindow,
    openProjectWindow,
    windowOfProject,
    focusProjectWindow,
    projectClickOpensWindow,
    // multi-window Phase 2.5A: a chat in its own window
    popoutKey,
    popoutMissing: () => closePopout(),
    chatMenuItems,
    popOutChat,
    chatPoppedOut: popped,
    _pops: () => popListOf().slice(),
    init,
    sync,
    syncPrefs,
    customNameFor,
    openProjectMenu: openProjMenu,
    noteOpened,
    noteNewChat,
    addProject,
    openNewProject,
    restoreTarget,
    keepProjectFor,
    settled,
    inProject,
    listSignature,
    hasWorkspace,
    // No project at all (a new user): the chat list then says how to add one.
    noProjects: () => !!host && !projects.length,
    activeProject,
    focusProjectOf,
    selectProject,
    closeTab: closeTabKey,
    toggleInbox,
    inboxKey: 'Alt+I',
    onKey: tabShortcut,
    markHandled: (c) =>
      root.AgentOrganizeUI && root.AgentOrganizeUI.markHandled
        ? root.AgentOrganizeUI.markHandled(c)
        : Promise.resolve(),
    // For files-ui.js: the project on screen, its name, its chats that need you, and the narrow-window drawer.
    currentProject: () => (ws && ws.active !== St().ALL ? ws.active : ''),
    currentProjectPath: () => {
      const p = ws && ws.active !== St().ALL ? projectOfKey(ws.active) : null;
      return p ? p.path || '' : '';
    },
    currentProjectName: () => {
      const p = ws && ws.active !== St().ALL ? projectOfKey(ws.active) : null;
      return p ? p.name : '';
    },
    waitingIn: (pk) => (pk ? waitingFor(pk) : 0),
    closeDrawer: () => setListOpen(false),
    openDrawer: () => {
      if (root.matchMedia && root.matchMedia('(max-width:1100px)').matches) setListOpen(true);
    },
    // The chats in front of you (inbox-rules.js openKeys): this window's, plus those open in another AIB window; the window title
    // leaves them out. The presence report sends this window's own (openChatKeys).
    openKeys: frontKeys,
    // One router for every way of opening a chat or project (design section 9): here, or in the window that owns it.
    routeOpen,
    routeConversation,
    mayShowProject,
    _state: () => ws,
    _items: () => items,
    _draft: () => draft,
    _inboxKeys: () => rowKeys(), // tests (split_focus_e2e_test.ts): the chats the inbox lists now
    // Tests (steer_e2e_test.ts P9): a typed quick reply to the chat with this key, through the inbox row's own send (sendQuick).
    _sendQuick: async (key, text) => {
      qs(key).text = String(text || '');
      await sendQuick(key);
      const s = quick.get(key);
      return s ? { error: s.error, queued: !!s.queued } : { error: '', queued: false };
    },
  };
  root.AgentWorkspaceUI = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
