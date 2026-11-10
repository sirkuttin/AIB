(function (root) {
  'use strict';
  // Pure workspace state for Agent Studio: no DOM, no storage, no clock. Everything here is a function of plain data so
  // it can be unit tested in node and reused by other front ends (a project rail + chat tabs today, a mission-control
  // board later) on the same data.
  //
  // Input is a list of "items", one per conversation, already normalised by the page (workspace-ui.js):
  //   { key, title, projectKey, projectName, projectPath, provider, state, needs, unread, activity,
  //     pinned, held, holdNote, archived, deleted, elicitations, auth, yourTurn, yourTurnAt, snippet, projectWorktree, projectScratch }
  //   state is one of needs_you | unread | working | opening | idle | saved (the sidebar's status vocabulary).
  // Workspace state itself is a small JSON-able object:
  //   { v: 1, active: "all" | projectKey, tabs: { projectKey: [chatKey, ...] }, last: { projectKey: chatKey } }
  // Every function returns a new object; nothing mutates its arguments.

  const ALL = 'all';
  const MAX_TABS = 200; // per project; nothing auto-closes, this only bounds what is stored
  const MAX_PROJECTS = 60; // projects remembered in storage
  const RANK = { needs_you: 5, unread: 4, working: 3, opening: 2, idle: 1, saved: 0 };
  const KIND_LABELS = { question: 'Question', permission: 'Permission', auth: 'Sign-in', input: 'Input needed' };

  const isStr = (v) => typeof v === 'string' && v.length > 0;
  const live = (items) => (items || []).filter((i) => i && !i.archived && !i.deleted);

  // ---- state shape --------------------------------------------------------------------------
  function empty() {
    return { v: 1, active: ALL, tabs: {}, last: {}, recent: '' };
  }
  function dedupe(list) {
    const seen = new Set(),
      out = [];
    for (const k of list)
      if (isStr(k) && !seen.has(k)) {
        seen.add(k);
        out.push(k);
      }
    return out;
  }
  // Accepts whatever came out of localStorage and returns a valid state.
  function sanitize(raw) {
    const out = empty();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    if (isStr(raw.active)) out.active = raw.active;
    const tabs = raw.tabs && typeof raw.tabs === 'object' && !Array.isArray(raw.tabs) ? raw.tabs : {};
    for (const pk of Object.keys(tabs).slice(0, MAX_PROJECTS)) {
      if (!Array.isArray(tabs[pk])) continue;
      const list = dedupe(tabs[pk]).slice(0, MAX_TABS);
      if (list.length) out.tabs[pk] = list;
    }
    const last = raw.last && typeof raw.last === 'object' && !Array.isArray(raw.last) ? raw.last : {};
    for (const pk of Object.keys(last))
      if (isStr(last[pk]) && (out.tabs[pk] || []).includes(last[pk])) out.last[pk] = last[pk];
    if (isStr(raw.recent) && raw.recent !== ALL && out.tabs[raw.recent]) out.recent = raw.recent;
    return out;
  }

  // ---- projects and attention ---------------------------------------------------------------
  const worse = (a, b) => (RANK[b] > RANK[a] ? b : a);
  // Attention counts for a set of items. needs = items waiting on you (not question count); needsItems = sum of pending requests.
  function counts(items) {
    const out = { total: 0, needs: 0, needsItems: 0, working: 0, unread: 0, yourTurn: 0, waiting: 0, state: 'saved' };
    for (const i of live(items)) {
      out.total++;
      if (i.yourTurn && i.state !== 'needs_you') out.yourTurn++;
      if (i.state === 'needs_you' || i.yourTurn) out.waiting++; // chats waiting on you: blocked ones and finished ones, each counted once
      out.state = worse(out.state, i.state || 'saved');
      if (i.state === 'needs_you') {
        out.needs++;
        out.needsItems += Math.max(1, Number(i.needs) || 0);
      } else if (i.state === 'working' || i.state === 'opening') out.working++;
      if (i.unread || i.state === 'unread') out.unread++;
    }
    return out;
  }
  // Projects derived from the conversation list, in a stable alphabetical order: the rail is spatial navigation, so a
  // project must not jump around as its chats update (badges carry the urgency). Archived/deleted chats do not count.
  function buildProjects(items) {
    const map = new Map();
    for (const i of live(items)) {
      if (!isStr(i.projectKey)) continue;
      if (!map.has(i.projectKey))
        map.set(i.projectKey, {
          key: i.projectKey,
          name: i.projectName || 'No folder',
          autoName: i.projectAutoName || i.projectName || 'No folder',
          path: i.projectPath || '',
          items: [],
          activity: 0,
          isWorktree: false,
          isScratch: false,
        });
      const p = map.get(i.projectKey);
      p.items.push(i);
      p.activity = Math.max(p.activity, Number(i.activity) || 0);
      if (i.projectWorktree) p.isWorktree = true;
      if (i.projectScratch) p.isScratch = true;
    }
    const out = [];
    for (const p of map.values()) {
      const c = counts(p.items);
      out.push({
        key: p.key,
        name: p.name,
        autoName: p.autoName,
        path: p.path,
        activity: p.activity,
        isWorktree: p.isWorktree,
        isScratch: p.isScratch,
        ...c,
      });
    }
    return out.sort(
      (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.key.localeCompare(b.key),
    );
  }
  const totals = (items) => counts(items);
  // Stable hue (0-359) for a project key, so a project keeps its colour on the rail.
  function hueOf(key) {
    let h = 2166136261;
    for (const ch of String(key)) {
      h ^= ch.charCodeAt(0);
      h = Math.imul(h, 16777619) >>> 0;
    }
    h ^= h >>> 15;
    h = Math.imul(h, 2246822519) >>> 0;
    h ^= h >>> 13;
    return (h >>> 0) % 360;
  }

  // ---- project preferences (display name, colour, hidden, order) ----------------------------------
  // Stored on the server (studio-projects.json) and shared by every window. Shape:
  //   { order: [projectKey, ...], projects: { projectKey: { name, color, hidden } } }
  // A display name is only a label; it never renames a folder. Colour is a palette id ("" = automatic, from the key).
  // Muted on purpose: none of these is the amber / red / green that status uses. s and l are percentages.
  const PALETTE = [
    { id: 'blue', hue: 215, s: 55, l: 62, label: 'Blue' },
    { id: 'sky', hue: 195, s: 55, l: 60, label: 'Sky' },
    { id: 'teal', hue: 172, s: 40, l: 56, label: 'Teal' },
    { id: 'indigo', hue: 240, s: 50, l: 68, label: 'Indigo' },
    { id: 'violet', hue: 268, s: 50, l: 68, label: 'Violet' },
    { id: 'orchid', hue: 295, s: 42, l: 64, label: 'Orchid' },
    { id: 'pink', hue: 328, s: 52, l: 66, label: 'Pink' },
    { id: 'slate', hue: 220, s: 14, l: 60, label: 'Slate' },
  ]; // keep ids in sync with ProjectPrefs.COLORS
  const MAX_NAME = 60;
  const cleanName = (v) =>
    typeof v === 'string'
      ? v
          .replace(/[\u0000-\u001f]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, MAX_NAME)
      : '';
  const colorOk = (id) => PALETTE.some((c) => c.id === id);
  function emptyPrefs() {
    return { order: [], projects: {} };
  }
  function sanitizePrefs(raw) {
    const out = emptyPrefs();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    out.order = dedupe(Array.isArray(raw.order) ? raw.order : []).slice(0, 300);
    const src = raw.projects && typeof raw.projects === 'object' && !Array.isArray(raw.projects) ? raw.projects : {};
    for (const k of Object.keys(src).slice(0, 300)) {
      const v = src[k];
      if (!isStr(k) || !v || typeof v !== 'object') continue;
      const pref = { name: cleanName(v.name), color: colorOk(v.color) ? v.color : '', hidden: v.hidden === true };
      if (v.muted === true) pref.muted = true; // stored only when set
      if (v.useWorkspace === true) pref.useWorkspace = true; // stored only when set
      if (pref.name || pref.color || pref.hidden || pref.muted || pref.useWorkspace) out.projects[k] = pref;
    }
    return out;
  }
  const prefOf = (prefs, key) =>
    (prefs && prefs.projects && prefs.projects[key]) || { name: '', color: '', hidden: false };
  // The one place the project name comes from: the custom name when set, else the folder-derived fallback.
  const displayName = (prefs, key, fallback) => prefOf(prefs, key).name || String(fallback || 'No folder');
  // Automatic colour: a palette index from the project key. Projects next to each other in the saved order never share a colour
  // while the palette has room: a project whose pick equals the previous one's (or the next explicit one's) takes the next free entry.
  const autoIndex = (key) => hueOf(key) % PALETTE.length;
  function autoColorId(key) {
    return PALETTE[autoIndex(key)].id;
  }
  // Effective colour id per project, for an ordered list of {key}: explicit pick from prefs, else automatic with the neighbour rule.
  function assignColors(ordered, prefs) {
    const list = ordered || [],
      out = new Map(),
      n = PALETTE.length;
    const explicit = (i) => (i >= 0 && i < list.length ? prefOf(prefs, list[i].key).color : '');
    for (let i = 0; i < list.length; i++) {
      const key = list[i].key,
        ex = explicit(i);
      if (ex) {
        out.set(key, ex);
        continue;
      }
      const prev = i ? out.get(list[i - 1].key) : '',
        next = explicit(i + 1);
      let at = autoIndex(key);
      for (let tries = 0; tries < n && (PALETTE[at].id === prev || PALETTE[at].id === next); tries++) at = (at + 1) % n;
      out.set(key, PALETTE[at].id);
    }
    return out;
  }
  // CSS colour for a palette id at a lightness offset (the dropdown swatch uses the base lightness).
  function cssColor(id, lightDelta) {
    const c = PALETTE.find((x) => x.id === id) || PALETTE[0];
    return 'hsl(' + c.hue + ' ' + c.s + '% ' + Math.max(0, Math.min(100, c.l + (lightDelta || 0))) + '%)';
  }
  const byName = (a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.key.localeCompare(b.key);
  // Merge saved preferences into buildProjects output: order (saved positions first, the rest alphabetical after them),
  // colour id and hidden flag. Input objects are copied, not changed. The name already carries the custom name when the page
  // resolved it (items' projectName); `name` is re-derived here so the merge is also right on its own.
  function applyPrefs(projects, prefs) {
    const index = new Map(((prefs && prefs.order) || []).map((k, i) => [k, i]));
    const list = (projects || []).map((p) => {
      const pr = prefOf(prefs, p.key),
        auto = p.autoName || p.name;
      return {
        ...p,
        autoName: auto,
        name: pr.name || auto,
        custom: !!pr.name,
        color: pr.color,
        hidden: !!pr.hidden,
        muted: pr.muted === true,
        useWorkspace: pr.useWorkspace === true,
      };
    });
    const ordered = list.filter((p) => index.has(p.key)).sort((a, b) => index.get(a.key) - index.get(b.key));
    const rest = list.filter((p) => !index.has(p.key)).sort(byName);
    const out = ordered.concat(rest),
      colors = assignColors(out, prefs);
    return out.map((p) => ({ ...p, colorId: colors.get(p.key) }));
  }
  // ---- folders the dropdown hides ----------------------------------------------------------------
  // Git worktree folders and Claude desktop scratch folders are not projects you switch to. Their chats stay in "All chats",
  // in Ctrl+K and in the inbox; nothing is deleted. The text rules below work at once; the server adds the one it can only
  // know from disk (a `.git` FILE pointing into a worktrees folder) through /api/live/folders/kinds.
  const pathSegments = (p) =>
    String(p || '')
      .replace(/\\/g, '/')
      .split('/')
      .filter(Boolean);
  const isScratchPath = (p) => pathSegments(p).some((seg) => /^scratch-/i.test(seg));
  const isWorktreePath = (p) => {
    const t = '/' + pathSegments(p).join('/').toLowerCase() + '/';
    return t.includes('/.claude/worktrees/') || t.includes('/.git/worktrees/');
  };
  const hiddenFromDropdown = (p) => !!(p && (p.isWorktree || p.isScratch));
  const dropdownProjects = (list) => (list || []).filter((p) => !hiddenFromDropdown(p));
  const visibleProjects = (list) => (list || []).filter((p) => !p.hidden);
  const hiddenProjects = (list) => (list || []).filter((p) => p.hidden);
  // A copy of prefs with a patch ({name?, color?, hidden?}) applied to one project; empty values clear the field.
  function setPref(prefs, key, patch) {
    if (!isStr(key)) return prefs;
    const cur = { ...prefOf(prefs, key) },
      p = patch || {};
    if ('name' in p) cur.name = cleanName(p.name);
    if ('color' in p) cur.color = colorOk(p.color) ? p.color : '';
    if ('hidden' in p) cur.hidden = p.hidden === true;
    if ('muted' in p) {
      if (p.muted === true) cur.muted = true;
      else delete cur.muted;
    }
    if ('useWorkspace' in p) {
      if (p.useWorkspace === true) cur.useWorkspace = true;
      else delete cur.useWorkspace;
    }
    const projects = { ...((prefs && prefs.projects) || {}) };
    if (cur.name || cur.color || cur.hidden || cur.muted || cur.useWorkspace) projects[key] = cur;
    else delete projects[key];
    return { order: ((prefs && prefs.order) || []).slice(), projects };
  }
  // ---- reorder math ----
  // Move the item at index `from` so it ends up where the insertion slot `slot` (0..n, the gap before item `slot`) is.
  function moveToSlot(keys, from, slot) {
    const list = (keys || []).slice();
    if (!(from >= 0 && from < list.length)) return list;
    const s = Math.max(0, Math.min(list.length, Math.round(Number(slot) || 0)));
    const [k] = list.splice(from, 1);
    list.splice(s > from ? s - 1 : s, 0, k);
    return list;
  }
  // Which gap a pointer is over: `mids` are the centre positions of the rows in order (y for a vertical rail). Returns 0..n.
  function slotAt(mids, pos) {
    let slot = 0;
    for (const m of mids || []) {
      if (pos > m) slot++;
      else break;
    }
    return slot;
  }
  // Does dropping `from` into `slot` change anything? (the gaps just before and after the item are no-ops)
  const slotMoves = (from, slot) => slot !== from && slot !== from + 1;
  // Move one key up (-1) or down (+1) among the visible keys.
  function nudge(keys, key, dir) {
    const at = (keys || []).indexOf(key),
      to = at + (dir < 0 ? -1 : 1);
    if (at < 0 || to < 0 || to >= keys.length) return (keys || []).slice();
    const list = keys.slice();
    [list[at], list[to]] = [list[to], list[at]];
    return list;
  }
  // New full saved order after the visible projects were reordered: hidden projects keep their place in the full list.
  function mergeOrder(allKeys, visibleKeys) {
    const vis = new Set(visibleKeys),
      queue = (visibleKeys || []).slice(),
      out = [];
    for (const k of allKeys || []) out.push(vis.has(k) ? queue.shift() : k);
    return out;
  }

  // Opening a chat from another project (inbox, switcher, a link) moves the project dropdown to that chat's project. "All chats"
  // stays on All: you chose to see everything.
  function activeAfterOpen(st, pk) {
    return st.active !== ALL && isStr(pk) && pk !== ALL && st.active !== pk ? { ...st, active: pk } : st;
  }
  // Dropdown filter: case-insensitive match on display name, original folder name or path.
  function filterProjects(projects, query) {
    const q = String(query || '')
      .trim()
      .toLowerCase();
    if (!q) return (projects || []).slice();
    return (projects || []).filter((p) =>
      [p.name, p.autoName, p.path].some((v) =>
        String(v || '')
          .toLowerCase()
          .includes(q),
      ),
    );
  }

  // ---- list filter --------------------------------------------------------------------------
  // The slim list shows one project's chats (pinned and on-hold ones stay in their project's list too), or everything.
  const inProject = (item, active) => active === ALL || !isStr(active) || item.projectKey === active;
  const filterItems = (items, active) => (items || []).filter((i) => i && inProject(i, active));

  // ---- needs-you inbox ----------------------------------------------------------------------
  // Why is this chat waiting? The server gives one total (attention.needs); the connection says how many of those are
  // elicitation questions and whether sign-in is pending. The rest are tool permission requests.
  function classifyNeeds(n) {
    const needs = Math.max(0, Number(n && n.needs) || 0);
    const elicitations = Math.max(0, Math.min(needs, Number(n && n.elicitations) || 0));
    const auth = n && n.auth ? 1 : 0;
    const permission = Math.max(0, needs - elicitations - Math.min(auth, needs - elicitations));
    const out = [];
    if (elicitations) out.push({ kind: 'question', count: elicitations });
    if (permission) out.push({ kind: 'permission', count: permission });
    if (auth && needs) out.push({ kind: 'auth', count: 1 });
    if (!out.length && needs) out.push({ kind: 'input', count: needs });
    return out;
  }
  const kindLabel = (kind) => KIND_LABELS[kind] || KIND_LABELS.input;
  function describeNeeds(kinds) {
    if (!kinds || !kinds.length) return KIND_LABELS.input;
    return kinds.map((k) => kindLabel(k.kind) + (k.count > 1 ? ' x' + k.count : '')).join(', ');
  }
  // The inbox: ONE flat list, newest first. A chat is in it when it is blocked on you (an approval, a question, a sign-in) or
  // when its agent finished a turn and you have not acted (`yourTurn`, kept on the server until you reply, hold, archive,
  // delete or Mark handled; looking at the chat does not clear it). A blocked chat that is also your-turn is one row.
  // Row: {key, title, projectKey, projectName, provider, kind: "needs" | "yourTurn", needs, kinds, summary, ask, snippet,
  // line, handled (can be marked handled), at (seconds), activity}.
  const SNIPPET_MAX = 120;
  function snippetOf(text) {
    const line =
      String(text || '')
        .split(/\r?\n/)
        .map((x) => x.replace(/^[#>*\-\s`]+/, '').trim())
        .find(Boolean) || '';
    return line.length > SNIPPET_MAX ? line.slice(0, SNIPPET_MAX - 1).trimEnd() + '…' : line;
  }
  function inbox(items) {
    const out = [];
    for (const i of live(items)) {
      const blocked = i.state === 'needs_you';
      if (!blocked && !i.yourTurn) continue;
      const base = {
        key: i.key,
        title: i.title || 'Conversation',
        projectKey: i.projectKey,
        projectName: i.projectName || 'No folder',
        provider: i.provider,
        activity: Number(i.activity) || 0,
      };
      if (blocked) {
        const needs = Math.max(1, Number(i.needs) || 0);
        const kinds = classifyNeeds({ needs, elicitations: i.elicitations, auth: i.auth });
        const ask = String(i.ask || '').trim(),
          summary = describeNeeds(kinds);
        out.push({
          ...base,
          kind: 'needs',
          needs,
          kinds,
          summary,
          ask,
          snippet: '',
          line: 'Needs you: ' + (ask || summary),
          handled: !!i.yourTurn,
          at: base.activity || Number(i.yourTurnAt) || 0,
        });
      } else {
        const snippet = String(i.snippet || '').trim();
        out.push({
          ...base,
          kind: 'yourTurn',
          needs: 0,
          kinds: [],
          summary: 'Your turn',
          ask: '',
          snippet,
          line: 'Your turn' + (snippet ? ': “' + snippet + '”' : ''),
          handled: true,
          at: Number(i.yourTurnAt) || base.activity,
        });
      }
    }
    return out.sort((a, b) => b.at - a.at || a.projectName.localeCompare(b.projectName) || a.key.localeCompare(b.key));
  }

  // The inbox grouped by project (alphabetical), each group's rows keeping the inbox order: [{projectKey, projectName, rows}].
  function groupInbox(rows) {
    const map = new Map();
    for (const r of rows || []) {
      if (!map.has(r.projectKey))
        map.set(r.projectKey, { projectKey: r.projectKey, projectName: r.projectName, rows: [] });
      map.get(r.projectKey).rows.push(r);
    }
    return Array.from(map.values()).sort(
      (a, b) =>
        a.projectName.localeCompare(b.projectName, undefined, { sensitivity: 'base' }) ||
        a.projectKey.localeCompare(b.projectKey),
    );
  }
  // Chats that finished while you were elsewhere and have not been looked at ("Finished, not viewed: N").
  const unviewed = (items) =>
    live(items).filter((i) => i.state === 'unread' || (i.unread && i.state !== 'needs_you')).length;

  // ---- tabs ---------------------------------------------------------------------------------
  // Tabs live under the project they belong to. "all" is only a list filter; the strip then follows the open chat's project.
  function effectiveProject(st, selectedProjectKey) {
    if (st.active !== ALL) return st.active;
    return isStr(selectedProjectKey) ? selectedProjectKey : ALL;
  }
  const tabsOf = (st, pk) => (st.tabs[pk] || []).slice();
  // The project whose tabs the strip shows. A new-chat draft pins it to the project it was started from; otherwise the
  // rail's project, or with "all" the open chat's project, or (nothing open) the project used most recently, so the
  // strip never says "no open chats" while tabs exist.
  function stripProject(st, selectedProjectKey, draftProjectKey) {
    if (isStr(draftProjectKey) && draftProjectKey !== ALL) return draftProjectKey;
    if (st.active !== ALL) return st.active;
    if (isStr(selectedProjectKey)) return selectedProjectKey;
    if (st.recent && (st.tabs[st.recent] || []).length) return st.recent;
    const any = Object.keys(st.tabs).sort()[0];
    return any || ALL;
  }
  // ---- new-chat draft tab ----
  // "+" adds a temporary tab at the end of the strip (never stored): it becomes the real chat tab when the first message
  // is sent, and x throws it away and returns to the tab you came from.
  const DRAFT = '__draft__';
  function withDraftTab(list, hasDraft) {
    const out = (list || []).filter((k) => k !== DRAFT);
    if (hasDraft) out.push(DRAFT);
    return out;
  }
  // Project a new chat starts in: the chat you were on, else the rail's project, else the most recent one.
  function draftProject(st, selectedProjectKey) {
    if (isStr(selectedProjectKey) && selectedProjectKey !== ALL) return selectedProjectKey;
    if (st.active !== ALL) return st.active;
    return st.recent || '';
  }
  // Where to go when the draft tab is closed: the tab it came from if it is still open, else the project's last tab, else nothing.
  function draftExit(st, pk, fromKey) {
    const list = tabsOf(st, pk);
    if (isStr(fromKey) && list.includes(fromKey)) return fromKey;
    if (isStr(st.last[pk]) && list.includes(st.last[pk])) return st.last[pk];
    return list[list.length - 1] || null;
  }
  // Chats to try, best first, to restore after a reload: the rail project's last chat, then the most recent project's,
  // then that project's tabs and every other project's last chat.
  function restoreCandidates(st) {
    const out = [];
    const add = (k) => {
      if (isStr(k) && !out.includes(k)) out.push(k);
    };
    if (st.active !== ALL) add(st.last[st.active]);
    if (st.recent) add(st.last[st.recent]);
    if (st.active !== ALL) for (const k of tabsOf(st, st.active)) add(k);
    for (const pk of Object.keys(st.last)) add(st.last[pk]);
    return out;
  }
  function withTabs(st, pk, list, last) {
    const tabs = { ...st.tabs },
      lastMap = { ...st.last };
    if (list.length) tabs[pk] = list;
    else delete tabs[pk];
    if (last !== undefined) {
      if (isStr(last)) lastMap[pk] = last;
      else delete lastMap[pk];
    }
    if (lastMap[pk] && !list.includes(lastMap[pk])) delete lastMap[pk];
    return { ...st, tabs, last: lastMap };
  }
  // Open (or just focus) a tab for chat `key` in project `pk`. New tabs go to the right of the current one.
  function openTab(st, pk, key, afterKey) {
    if (!isStr(pk) || pk === ALL || !isStr(key)) return st;
    let list = tabsOf(st, pk);
    if (!list.includes(key)) {
      const at = isStr(afterKey) ? list.indexOf(afterKey) : -1;
      if (at >= 0) list.splice(at + 1, 0, key);
      else list.push(key);
      if (list.length > MAX_TABS) {
        const drop = list.find((k) => k !== key && k !== afterKey) || list[0];
        list = list.filter((k) => k !== drop);
      }
    }
    return { ...withTabs(st, pk, list, key), recent: pk };
  }
  // Close a tab; `next` is the tab to show instead (right neighbour, else left) or null when none is left.
  function closeTab(st, pk, key, activeKey) {
    const list = tabsOf(st, pk),
      at = list.indexOf(key);
    if (at < 0) return { state: st, next: null, closed: false };
    list.splice(at, 1);
    let next = null;
    if (activeKey === undefined || activeKey === key) next = list[at] || list[at - 1] || null;
    else next = activeKey;
    return { state: withTabs(st, pk, list, next || ''), next, closed: true };
  }
  // A chat's key changed (a new chat got its session id): keep its tab.
  function renameTab(st, from, to) {
    if (!isStr(from) || !isStr(to) || from === to) return st;
    let out = st;
    for (const pk of Object.keys(st.tabs)) {
      const list = st.tabs[pk];
      if (!list.includes(from)) continue;
      const mapped = dedupe(list.map((k) => (k === from ? to : k)));
      out = withTabs(out, pk, mapped, st.last[pk] === from ? to : undefined);
    }
    return out;
  }
  // Drop tabs whose chat is gone, archived or deleted. `valid` is the set of open-able chat keys.
  function pruneTabs(st, valid) {
    const ok = valid instanceof Set ? valid : new Set(valid || []);
    let out = st;
    for (const pk of Object.keys(st.tabs)) {
      const kept = st.tabs[pk].filter((k) => ok.has(k));
      if (kept.length !== st.tabs[pk].length) out = withTabs(out, pk, kept);
    }
    return out;
  }
  // Put the open tabs of project `pk` in a new order (a split layout shrank back to one pane). Only a reordering of the same tabs counts.
  function orderTabs(st, pk, list) {
    const cur = tabsOf(st, pk),
      want = dedupe(list || []).filter((k) => cur.includes(k));
    if (want.length !== cur.length || want.every((k, i) => k === cur[i])) return st;
    return withTabs(st, pk, want);
  }
  const setActive = (st, active) => (st.active === active || !isStr(active) ? st : { ...st, active });
  const rememberLast = (st, pk, key) =>
    isStr(pk) && pk !== ALL && (st.tabs[pk] || []).includes(key) && st.last[pk] !== key
      ? { ...st, last: { ...st.last, [pk]: key } }
      : st;

  // Drag to reorder: move the tab `key` of project `pk` so it ends up in the gap `slot` (0..n, the gap before tab `slot`).
  function reorderTabs(st, pk, key, slot) {
    const list = tabsOf(st, pk),
      from = list.indexOf(key);
    if (from < 0 || !slotMoves(from, Math.max(0, Math.min(list.length, Math.round(Number(slot) || 0))))) return st;
    return withTabs(st, pk, moveToSlot(list, from, slot));
  }
  // Scroll position that brings a tab fully into view in a horizontally scrolling strip. tab and view are {left, right} in
  // the same coordinates (the tab's offset inside the strip's content, and the strip's scrollLeft .. scrollLeft + width).
  function scrollToReveal(tab, view, pad) {
    const p = Math.max(0, Number(pad) || 0),
      left = Number(view.left) || 0,
      right = Number(view.right) || 0;
    if (tab.left - p < left) return Math.max(0, tab.left - p);
    if (tab.right + p > right) return Math.max(0, Math.round(tab.right + p - (right - left)));
    return left;
  }
  // The mouse wheel scrolls the strip sideways: a plain vertical wheel turn moves it, a trackpad's own sideways turn is left alone.
  function wheelScroll(deltaX, deltaY) {
    const x = Number(deltaX) || 0,
      y = Number(deltaY) || 0;
    return Math.abs(x) >= Math.abs(y) ? 0 : y;
  }
  // The small project label at the start of the strip: only in "All chats", where the strip would otherwise not say whose tabs it shows.
  const stripLabel = (st, projectName) => (st.active === ALL && isStr(projectName) ? projectName : '');

  // Neighbouring tab for Ctrl+Tab: wraps around. With no current tab, forward gives the first and back the last.
  function cycle(list, current, dir) {
    if (!list || !list.length) return null;
    const at = list.indexOf(current);
    if (at < 0) return dir < 0 ? list[list.length - 1] : list[0];
    return list[(at + (dir < 0 ? -1 : 1) + list.length) % list.length];
  }
  // Ctrl+1..8 = that tab, Ctrl+9 = the last tab (browser convention).
  function jump(list, n) {
    if (!list || !list.length || !(n >= 1 && n <= 9)) return null;
    return n === 9 ? list[list.length - 1] : list[n - 1] || null;
  }
  // How many tabs fit: split the list in shown and hidden, keeping the active tab visible. needs: Set of keys waiting on you.
  function overflow(list, activeKey, capacity, needs) {
    const cap = Math.max(1, Math.floor(Number(capacity) || 1));
    if (!list || list.length <= cap) return { shown: (list || []).slice(), hidden: [], hiddenNeeds: 0 };
    let shown = list.slice(0, cap);
    if (isStr(activeKey) && list.includes(activeKey) && !shown.includes(activeKey)) shown[cap - 1] = activeKey;
    const hidden = list.filter((k) => !shown.includes(k));
    shown = list.filter((k) => shown.includes(k)); // keep original order
    const nd = needs instanceof Set ? needs : new Set(needs || []);
    return { shown, hidden, hiddenNeeds: hidden.filter((k) => nd.has(k)).length };
  }

  // Keyboard: a plain description of what a key press means for the tab strip, or null. Ctrl is the primary set; the
  // Alt variants exist because browsers keep Ctrl+Tab, Ctrl+W and Ctrl+1..9 for themselves when Studio runs in a normal tab.
  function shortcutFor(e) {
    if (!e) return null;
    const key = String(e.key || '');
    if (e.metaKey) return null;
    const ctrl = !!e.ctrlKey && !e.altKey,
      alt = !!e.altKey && !e.ctrlKey;
    if (!ctrl && !alt) return null;
    if (ctrl && key === 'Tab') return { action: e.shiftKey ? 'prev' : 'next' };
    if (alt && !e.shiftKey && (key === 'PageDown' || key === 'PageUp'))
      return { action: key === 'PageDown' ? 'next' : 'prev' };
    if (e.shiftKey) return null;
    if (key.toLowerCase() === 'w') return { action: 'close' };
    if (/^[1-9]$/.test(key)) return { action: 'jump', n: Number(key) };
    return null;
  }

  // ---- New project dialog (pure helpers) ---------------------------------------------------------
  // Folder text -> pieces. Both separators are accepted; the folder keeps whichever the text already uses.
  const looksWindows = (p) => /^[a-zA-Z]:/.test(String(p || '')) || String(p || '').indexOf('\\') >= 0;
  const sepOf = (p) => (looksWindows(p) ? '\\' : '/');
  const trimSeps = (p) =>
    String(p || '')
      .trim()
      .replace(/[\\/]+$/, '');
  function withTrailingSep(p) {
    const t = String(p || '').trim();
    if (!t) return '';
    return /[\\/]$/.test(t) ? t : t + sepOf(t);
  }
  const lastSepAt = (t) => Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\'));
  // Last folder name: the default project name and the placeholder of the name box.
  function folderLeaf(p) {
    const t = trimSeps(p),
      leaf = t.slice(lastSepAt(t) + 1);
    return /^[a-zA-Z]:$/.test(leaf) ? '' : leaf;
  }
  function parentOf(p) {
    const t = trimSeps(p),
      i = lastSepAt(t);
    return i > 0 ? t.slice(0, i) : '';
  }
  // The folder the dialog starts with, with a trailing separator: the remembered parent (server says source "last"), else
  // the parent folder that holds the most existing projects, else the home folder. paths: the projects' folder paths.
  function smartStart(server, paths) {
    const srv = server && typeof server === 'object' ? server : {};
    if (srv.source === 'last' && isStr(srv.start)) return withTrailingSep(srv.start);
    const count = new Map();
    for (const raw of paths || []) {
      const parent = parentOf(raw);
      if (!parent || /^[a-zA-Z]:$/.test(parent)) continue;
      const key = looksWindows(parent) ? parent.replace(/\//g, '\\').toLowerCase() : parent;
      const e = count.get(key) || { parent, n: 0 };
      e.n++;
      count.set(key, e);
    }
    let best = null;
    for (const e of count.values())
      if (!best || e.n > best.n || (e.n === best.n && e.parent.toLowerCase() < best.parent.toLowerCase())) best = e;
    if (best) return withTrailingSep(best.parent);
    return withTrailingSep(srv.home || srv.start || '');
  }
  // What the dialog shows for the server's check answer. ctx: {isProject: folder is already a project, checking: answer pending}.
  // Returns {kind, text, tone, primary, canSubmit, showGit, gitEnabled, gitNote}. tone: hint | ok | error.
  function hintState(check, ctx) {
    const c = ctx || {},
      base = {
        kind: 'empty',
        text: 'Type a folder name, or Browse',
        tone: 'hint',
        primary: 'Create project',
        canSubmit: false,
        showGit: false,
        gitEnabled: false,
        gitNote: '',
      };
    if (c.checking || !check)
      return Object.assign(base, {
        kind: c.checking ? 'checking' : 'empty',
        text: c.checking ? 'Checking…' : base.text,
      });
    if (check.valid && check.exists) {
      return Object.assign(
        base,
        c.isProject
          ? {
              kind: 'project',
              text: 'This is already a project. Open switches to it',
              tone: 'ok',
              primary: 'Open project',
              canSubmit: true,
            }
          : {
              kind: 'existing',
              text: 'Existing folder, used as is',
              tone: 'ok',
              primary: 'Open project',
              canSubmit: true,
            },
      );
    }
    if (check.valid) {
      const git = check.gitAvailable !== false;
      return Object.assign(base, {
        kind: 'new',
        text: 'New folder, will be created',
        tone: 'ok',
        primary: 'Create project',
        canSubmit: true,
        showGit: true,
        gitEnabled: git,
        gitNote: git ? '' : 'git not found',
      });
    }
    if (check.reason === 'empty' || check.reason === 'partial' || !check.reason) return base;
    return Object.assign(base, {
      kind: check.reason === 'parent_missing' ? 'parent_missing' : 'invalid',
      text: String(check.message || "That folder can't be used"),
      tone: 'error',
    });
  }
  // Pending projects: a project made with the dialog that has no chat yet, so the dropdown can show it right away.
  // Shape: { projectKey: { key, path, name } }. Dropped once a real project with the same key exists.
  function sanitizePending(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const k of Object.keys(raw).slice(0, 30)) {
      const v = raw[k];
      if (isStr(k) && v && typeof v === 'object' && isStr(v.path))
        out[k] = { key: k, path: String(v.path).slice(0, 512), name: cleanName(v.name) || folderLeaf(v.path) };
    }
    return out;
  }
  const addPending = (pending, key, path) =>
    isStr(key) && isStr(path)
      ? Object.assign({}, pending, { [key]: { key, path, name: folderLeaf(path) } })
      : pending || {};
  function prunePending(pending, realKeys) {
    const real = realKeys instanceof Set ? realKeys : new Set(realKeys || []);
    const out = {};
    for (const k of Object.keys(pending || {})) if (!real.has(k)) out[k] = pending[k];
    return out;
  }
  // buildProjects output + pending entries that have no chat yet (zero counts).
  function withPending(projects, pending) {
    const have = new Set((projects || []).map((p) => p.key)),
      out = (projects || []).slice();
    for (const k of Object.keys(pending || {}))
      if (!have.has(k)) {
        const p = pending[k];
        out.push({
          key: k,
          name: p.name,
          autoName: p.name,
          path: p.path,
          activity: 0,
          total: 0,
          needs: 0,
          needsItems: 0,
          working: 0,
          unread: 0,
          state: 'saved',
          pending: true,
        });
      }
    return out;
  }
  // Does this folder (by project key) match a project the page already has?
  const isKnownProject = (key, keys) =>
    isStr(key) && (keys instanceof Set ? keys.has(key) : (keys || []).includes(key));
  // The chat to open when a project that already has chats is chosen in the dialog: the project's last chat, else its newest.
  function chatToOpen(st, pk, items) {
    const mine = live(items).filter((i) => i.projectKey === pk);
    if (!mine.length) return null;
    if (isStr(st.last[pk]) && mine.some((i) => i.key === st.last[pk])) return st.last[pk];
    return mine.slice().sort((a, b) => b.activity - a.activity || a.key.localeCompare(b.key))[0].key;
  }

  // ---- signature ----------------------------------------------------------------------------
  // Cheap string that changes when anything the rail, strip or inbox shows changes.
  function signature(items, st, selectedKey) {
    const parts = [st.active, selectedKey || ''];
    for (const i of live(items))
      parts.push(
        i.key +
          ':' +
          i.state +
          ':' +
          (i.needs || 0) +
          ':' +
          (i.unread ? 1 : 0) +
          ':' +
          (i.yourTurn ? 1 : 0) +
          ':' +
          (i.projectWorktree ? 1 : 0) +
          (i.projectScratch ? 1 : 0) +
          ':' +
          i.projectKey +
          ':' +
          (i.title || ''),
      );
    for (const pk of Object.keys(st.tabs).sort()) parts.push(pk + '=' + st.tabs[pk].join('|'));
    return parts.join(';');
  }

  const nameToSave = (v, autoName) => {
    const n = cleanName(v);
    return n === cleanName(autoName) ? '' : n;
  }; // empty or equal to the folder name resets the name
  const api = {
    nameToSave,
    looksWindows,
    sepOf,
    withTrailingSep,
    folderLeaf,
    parentOf,
    smartStart,
    hintState,
    sanitizePending,
    addPending,
    prunePending,
    withPending,
    isKnownProject,
    chatToOpen,
    PALETTE,
    autoColorId,
    assignColors,
    cssColor,
    emptyPrefs,
    sanitizePrefs,
    prefOf,
    displayName,
    cleanName,
    applyPrefs,
    visibleProjects,
    hiddenProjects,
    setPref,
    moveToSlot,
    slotAt,
    slotMoves,
    nudge,
    mergeOrder,
    ALL,
    DRAFT,
    MAX_TABS,
    empty,
    sanitize,
    counts,
    totals,
    buildProjects,
    hueOf,
    activeAfterOpen,
    filterProjects,
    stripProject,
    withDraftTab,
    draftProject,
    draftExit,
    restoreCandidates,
    inProject,
    filterItems,
    classifyNeeds,
    kindLabel,
    describeNeeds,
    inbox,
    groupInbox,
    unviewed,
    effectiveProject,
    tabsOf,
    openTab,
    closeTab,
    renameTab,
    pruneTabs,
    orderTabs,
    setActive,
    rememberLast,
    cycle,
    jump,
    overflow,
    shortcutFor,
    signature,
    snippetOf,
    reorderTabs,
    scrollToReveal,
    wheelScroll,
    stripLabel,
    isScratchPath,
    isWorktreePath,
    hiddenFromDropdown,
    dropdownProjects,
  };
  root.AgentWorkspaceState = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
