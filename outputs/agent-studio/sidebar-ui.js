(function (root) {
  'use strict';
  // Projects and status for the conversation sidebar. Groups conversations by workspace folder, works out what
  // each conversation is doing (working / needs you / finished and unread / idle / saved), remembers when you last
  // looked at each one, and mirrors "needs you" in the browser tab title. Titles and paths are untrusted:
  // everything is set with textContent, never as HTML.
  const doc = () => root.document;
  const el = (tag, content, cls) => {
    const n = doc().createElement(tag);
    if (content != null && content !== '') n.textContent = String(content);
    if (cls) n.className = cls;
    return n;
  };
  const KEYS = {
    collapsed: 'studio-sidebar-collapsed',
    group: 'studio-sidebar-group',
    viewed: 'studio-last-viewed-v1',
    epoch: 'studio-sidebar-epoch',
  };
  const MAX_VIEWED = 600;
  const PROVIDERS = { omp: 'OMP', claude: 'Claude Code', codex: 'Codex' };
  const providerName = (p) =>
    PROVIDERS[p] ||
    (root.AgentChoice && root.AgentChoice.ALL.some((a) => a.id === p)
      ? root.AgentChoice.nameOf(p)
      : String(p || 'Agent'));

  let host = null;
  let collapsed = new Set(),
    viewed = {},
    epoch = Date.now();
  let names = new Map(); // project key -> {key, name, path}
  const busySince = new Map(); // conversation key -> when this page first saw it working (for "Working · 4m")
  const prevConn = new Map(); // conversation key -> live connection id seen at the last look
  const prevBusy = new Map(); // conversation key -> was busy at the last look
  const derivedEnded = new Map(); // conversation key -> when this page saw a turn end (fallback without server attention)
  let baseTitle = 'AIB',
    saveTimer = null;

  function read(name, fallback) {
    try {
      const raw = root.localStorage.getItem(KEYS[name]);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }
  function write(name, value) {
    try {
      root.localStorage.setItem(KEYS[name], JSON.stringify(value));
    } catch (e) {
      /* storage may be unavailable */
    }
  }
  const keyOf = (c) =>
    host && host.aliasKey ? host.aliasKey(c) : String(c.provider) + ':' + (c.sessionId || c.id || c.key);

  // ---- projects -----------------------------------------------------------------------------
  // "C:\Repos\App\", "c:/repos/app" and "C:\\Repos\\\\App" are the same folder on Windows; POSIX paths keep their case.
  function splitPath(cwd) {
    let p = String(cwd == null ? '' : cwd).trim();
    const raw = p;
    p = p.replace(/^\\\\\?\\/, '').replace(/\\/g, '/');
    const unc = p.startsWith('//');
    p = p.replace(/\/{2,}/g, '/');
    const segments = p.split('/').filter(Boolean);
    const windows = /^[a-zA-Z]:/.test(p) || unc || raw.indexOf('\\') >= 0;
    return { segments, windows };
  }
  // The folder a chat belongs to for grouping, naming and filtering: its projectRoot. A worktree chat's cwd differs from it;
  // records that carry no projectRoot (older ones, saved transcripts, agent-listed sessions) fall back to cwd.
  function rootOf(c) {
    if (!c) return '';
    return c.projectRoot || (c.live && c.live.projectRoot) || (c.recovered && c.recovered.projectRoot) || c.cwd || '';
  }
  // The branch of a chat that runs in its own Studio worktree ('' for every other chat): a live chat reports it, a saved one carries it from the server.
  function branchOf(c) {
    if (!c) return '';
    const w = c.worktree || (c.live && c.live.worktree) || (c.recovered && c.recovered.worktree);
    return w && typeof w.branch === 'string' ? w.branch : '';
  }
  function pathKey(cwd) {
    const { segments, windows } = splitPath(cwd);
    if (!segments.length) return '';
    const joined = segments.join('/');
    return windows ? 'w:' + joined.toLowerCase() : 'p:' + joined;
  }
  // cwds: array of folder strings. Returns Map(key -> {key, name, path}). Equal last segments get parent segments added.
  function projectNames(cwds) {
    const seen = new Map();
    for (const cwd of cwds) {
      const key = pathKey(cwd);
      if (!seen.has(key)) seen.set(key, { key, path: String(cwd || ''), segs: splitPath(cwd).segments });
    }
    const byLast = new Map();
    for (const item of seen.values()) {
      item.name = item.segs.length ? item.segs[item.segs.length - 1] : 'No folder';
      const bucket = item.name.toLowerCase();
      if (!byLast.has(bucket)) byLast.set(bucket, []);
      byLast.get(bucket).push(item);
    }
    for (const list of byLast.values()) {
      if (list.length < 2) continue;
      const deepest = Math.max(...list.map((i) => i.segs.length));
      let chosen = null;
      for (let depth = 2; depth <= deepest && !chosen; depth++) {
        const candidate = list.map((i) => i.segs.slice(-depth).join('/'));
        if (new Set(candidate.map((s) => s.toLowerCase())).size === list.length) chosen = candidate;
      }
      list.forEach((item, i) => {
        item.name = chosen ? chosen[i] : item.segs.join('/') || item.name;
      });
    }
    const out = new Map();
    for (const item of seen.values()) out.set(item.key, { key: item.key, name: item.name, path: item.path });
    return out;
  }
  // A custom project name (set from the rail's menu) replaces the folder-derived one everywhere projectOf is used.
  let nameHook = null;
  function setNameHook(fn) {
    nameHook = typeof fn === 'function' ? fn : null;
  }
  function projectOf(c) {
    const root = rootOf(c);
    const key = pathKey(root);
    const base = names.get(key) || projectNames([root]).get(key);
    const custom = nameHook ? String(nameHook(base.key) || '') : '';
    return { key: base.key, name: custom || base.name, autoName: base.name, path: base.path };
  }

  // ---- status -------------------------------------------------------------------------------
  const RANK = { needs_you: 5, unread: 4, working: 3, opening: 2, idle: 1, saved: 0 };
  const LABELS = {
    needs_you: 'Needs you',
    unread: 'Finished, not viewed yet',
    working: 'Working',
    opening: 'Opening',
    idle: 'Idle',
    saved: 'Not running',
  };
  // The same dot classes as the card phrase (status-words.js dotClass), so a project heading and its cards agree.
  const STATE_DOT = { needs_you: 'd-need', unread: 'd-turn', working: 'd-work', opening: 'd-idle', idle: 'd-idle' };
  const parseTime = (v) => {
    if (!v) return 0;
    const t = typeof v === 'number' ? v : Date.parse(v);
    return isNaN(t) ? 0 : t;
  };
  const liveOf = (c) => (c && c.live && !c.live.closed ? c.live : null);

  // The server's attention object when present; otherwise what the connection itself reports.
  function attentionOf(c) {
    const live = liveOf(c);
    if (!live) return null;
    const a = live.attention;
    if (a && typeof a === 'object' && typeof a.state === 'string') {
      return { state: a.state, needs: Math.max(0, Number(a.needs) || 0), endedAt: parseTime(a.turnEndedAt) };
    }
    const pending = (Array.isArray(live.elicitations) ? live.elicitations.length : 0) + (live.auth ? 1 : 0);
    const state =
      live.state === 'input_needed' || pending
        ? 'needs_you'
        : live.busy || live.state === 'working'
          ? 'working'
          : live.state === 'opening'
            ? 'opening'
            : 'idle';
    return { state, needs: state === 'needs_you' ? Math.max(1, pending) : 0, endedAt: 0 };
  }
  function statusOf(c) {
    const a = attentionOf(c);
    if (!a || a.state === 'closed') return { state: 'saved', needs: 0, unread: false, label: LABELS.saved };
    const key = keyOf(c);
    const ended = Math.max(a.endedAt, derivedEnded.get(key) || 0);
    const stored = root.AgentReadState ? root.AgentReadState.seenAt(key) : viewed[key];
    const seen = stored ? stored : epoch;
    const unread = ended > seen;
    let state = ['needs_you', 'working', 'opening', 'idle'].indexOf(a.state) >= 0 ? a.state : 'idle';
    if (state === 'idle' && unread) state = 'unread';
    const needs = state === 'needs_you' ? Math.max(1, a.needs) : 0;
    const label = state === 'needs_you' ? 'Needs you' + (needs > 1 ? ' (' + needs + ' items)' : '') : LABELS[state];
    return { state, needs, unread, label };
  }
  const rowSig = (c) => {
    const s = statusOf(c),
      p = phrase(c);
    return (
      s.state +
      ':' +
      s.needs +
      (s.unread ? 'u' : '') +
      '|' +
      p.kind +
      p.text +
      '|' +
      subagentsOf(c) +
      '|' +
      previewOf(c)
    );
  };
  // The most urgent state among several rows, with counts for the badge.
  function summarize(rows) {
    const out = { state: 'saved', needs: 0, unread: 0, working: 0, live: 0 };
    for (const c of rows) {
      const s = statusOf(c);
      if (RANK[s.state] > RANK[out.state]) out.state = s.state;
      out.needs += s.needs;
      if (s.unread) out.unread++;
      if (s.state === 'working') out.working++;
      if (s.state !== 'saved') out.live++;
    }
    if (out.unread && RANK[out.state] < RANK.unread) out.state = 'unread';
    const parts = [];
    if (out.needs) parts.push(out.needs + (out.needs === 1 ? ' item needs you' : ' items need you'));
    if (out.unread) parts.push(out.unread + ' finished, not viewed yet');
    if (out.working) parts.push(out.working + ' working');
    out.label = parts.join(', ') || (out.live ? LABELS.idle : LABELS.saved);
    return out;
  }
  // countClass: an extra class for the count badge (the project heading's unread count is not amber: amber means Needs you).
  function dot(state, label, count, dotClass, countClass) {
    const wrap = el('span', null, 'status-mark');
    if (state !== 'saved') {
      const d = el('span', null, 'status-dot ' + (dotClass || 'st-' + state));
      d.setAttribute('role', 'img');
      d.setAttribute('aria-label', label);
      d.title = label;
      wrap.append(d);
    }
    if (count > 0) {
      const n = el('span', count > 99 ? '99+' : count, 'status-count' + (countClass ? ' ' + countClass : ''));
      n.setAttribute('aria-hidden', 'true');
      wrap.append(n);
    }
    return wrap;
  }

  // ---- last viewed --------------------------------------------------------------------------
  // The server keeps it (AgentReadState); the in-chat unread line reads the same stored value for the same chat key.
  function markViewed(c, when) {
    if (!c) return;
    if (!when && host && host.holdSeen && host.holdSeen(c)) return;
    const key = keyOf(c),
      at = when || Date.now();
    if (root.AgentReadState) root.AgentReadState.mark(key, at);
    else viewed[key] = at;
  }
  const looking = () => {
    const d = doc();
    return !d || d.visibilityState !== 'hidden';
  };

  // Called whenever the list is (re)drawn: refresh names, notice turns that ended, mark the open chat as seen, retitle the tab.
  function sync(list, selected) {
    const all = (list || []).filter((c) => c && c.provider);
    names = projectNames(all.map(rootOf));
    for (const c of all) {
      const live = liveOf(c);
      if (!live) continue;
      const key = keyOf(c),
        busy = !!live.busy;
      // A turn that ended while this page was watching the same connection. A different connection (the chat reconnected after a
      // restart) is not new output.
      if (prevBusy.get(key) === true && !busy && prevConn.get(key) === live.id) derivedEnded.set(key, Date.now());
      prevBusy.set(key, busy);
      prevConn.set(key, live.id);
      // The server's turn start when it sends one (a reload keeps "Working · 12m"); else when this page first saw it busy.
      const since = parseTime(live.attention && live.attention.busySince);
      if (busy) {
        if (since) busySince.set(key, since);
        else if (!busySince.has(key)) busySince.set(key, Date.now());
      } else busySince.delete(key);
    }
    if (selected && looking()) markViewed(selected);
    updateTitle(all);
  }
  // The page owns the base tab title (the open conversation's name); this adds the "(n) " prefix.
  let lastList = [];
  function setBase(title) {
    baseTitle = String(title || 'AIB');
    updateTitle(lastList);
  }
  function updateTitle(list) {
    lastList = list;
    const d = doc();
    if (!d) return;
    let n = 0;
    for (const c of list) {
      const s = statusOf(c);
      if (s.state === 'needs_you') n += Math.max(1, s.needs);
      else if (c.yourTurn) n += 1;
    }
    const next = (n ? '(' + n + ') ' : '') + baseTitle;
    if (d.title !== next) d.title = next;
  }

  // ---- grouping -----------------------------------------------------------------------------
  let flat = false; // the workspace shows one project: a project heading would only repeat its name
  const isGrouping = () => !flat; // grouped by project in the all-chats view, flat inside one project
  function setFlat(on) {
    flat = !!on;
  }
  const isCollapsed = (key) => collapsed.has(key);
  function setCollapsed(key, value) {
    if (value) collapsed.add(key);
    else collapsed.delete(key);
    write('collapsed', Array.from(collapsed));
  }
  // Open the group holding c, e.g. before jumping to it from the switcher. True when something changed.
  function reveal(c) {
    const p = projectOf(c);
    if (p && collapsed.has(p.key)) {
      setCollapsed(p.key, false);
      return true;
    }
    return false;
  }
  const activityOf = (c, now) => {
    const s = statusOf(c);
    return s.state === 'working' || s.state === 'needs_you' || s.state === 'opening'
      ? (now || Date.now()) / 1000
      : Math.max(c.modified || 0, c.created || 0);
  };
  // rows keep the order they arrived in (live first, then newest). Returns [{key, name, path, rows, activity}] newest project first.
  function groupRows(rows) {
    const map = new Map(),
      now = Date.now();
    for (const c of rows) {
      const p = projectOf(c);
      if (!map.has(p.key)) map.set(p.key, { key: p.key, name: p.name, path: p.path, rows: [], activity: 0, rank: 0 });
      const g = map.get(p.key);
      g.rows.push(c);
      g.activity = Math.max(g.activity, activityOf(c, now));
      g.rank = Math.max(g.rank, RANK[statusOf(c).state]);
    }
    // Follow the project order you set in the dropdown; projects it doesn't know yet go after, most active first.
    const W = typeof window !== 'undefined' ? window.AgentWorkspaceUI : null;
    const order = W && W.projectOrder ? W.projectOrder() : [];
    const pos = (k) => {
      const i = order.indexOf(k);
      return i < 0 ? Infinity : i;
    };
    return Array.from(map.values()).sort(
      (a, b) =>
        pos(a.key) - pos(b.key) ||
        b.activity - a.activity ||
        b.rank - a.rank ||
        a.name.localeCompare(b.name) ||
        a.key.localeCompare(b.key),
    );
  }
  // makeRow(c, visible) -> node; visible() says whether the rows can currently be seen (for keyboard focus).
  function projectGroups(rows, makeRow, opts) {
    const forceOpen = !!(opts && opts.forceOpen);
    // Held chats live inside their own project: opts.held are the held rows, opts.holdBlock({key, rows, visible}) builds the sub-group.
    const heldBy = new Map();
    for (const c of (opts && opts.held) || []) {
      const k = projectOf(c).key;
      if (!heldBy.has(k)) heldBy.set(k, []);
      heldBy.get(k).push(c);
    }
    const seen = new Set(rows.map((c) => projectOf(c).key));
    const all = groupRows(rows.concat(((opts && opts.held) || []).filter((c) => !seen.has(projectOf(c).key))));
    return all.map((g) => {
      const heldRows = heldBy.get(g.key) || [];
      if (heldRows.length) g.rows = g.rows.filter((c) => heldRows.indexOf(c) < 0);
      const wrap = el('div', null, 'list-group project-group');
      wrap.setAttribute('role', 'group');
      wrap.dataset.project = g.key;
      const id = 'project-' + (g.key.replace(/[^a-z0-9]+/gi, '-').slice(-40) || 'none') + '-' + groupId(g.key);
      const open = () => forceOpen || !collapsed.has(g.key);
      const head = el('button', null, 'project-head');
      head.type = 'button';
      head.id = id;
      head.setAttribute('aria-expanded', String(open()));
      head.title = g.path || 'No folder';
      const caret = el('span', open() ? '\u25BE' : '\u25B8', 'project-caret');
      caret.setAttribute('aria-hidden', 'true');
      const sum = summarize(g.rows);
      const folder = el('span', '\uD83D\uDCC1', 'project-folder');
      folder.setAttribute('aria-hidden', 'true');
      head.append(
        caret,
        folder,
        el('span', g.name, 'project-name'),
        el('span', String(g.rows.length), 'project-count'),
      );
      const badge = dot(
        sum.state,
        sum.label,
        sum.needs || sum.unread,
        STATE_DOT[sum.state],
        sum.needs ? '' : 'count-turn',
      );
      // The badge sits beside the toggle (not in it) so the "+" can follow the count; the toggle still names it.
      badge.id = id + '-state';
      head.setAttribute('aria-describedby', badge.id);
      badge.onclick = () => head.onclick && head.onclick(); // the mark keeps its tooltip and still toggles
      wrap.setAttribute('aria-labelledby', id);
      const body = el('div', null, 'project-rows');
      for (const c of g.rows) body.append(makeRow(c, open));
      if (heldRows.length && opts && opts.holdBlock)
        body.append(opts.holdBlock({ key: g.key, rows: heldRows, visible: open }));
      body.hidden = !open();
      head.onclick = () => {
        if (forceOpen) return;
        const now = !collapsed.has(g.key);
        setCollapsed(g.key, now);
        body.hidden = now;
        head.setAttribute('aria-expanded', String(!now));
        caret.textContent = now ? '\u25B8' : '\u25BE';
      };
      // The same project menu as the dropdown (Rename, Move up/down, Hide, Copy folder path): ⋯ on hover, or right-click.
      const W2 = typeof window !== 'undefined' ? window.AgentWorkspaceUI : null;
      const headRow = el('div', null, 'project-head-row');
      headRow.append(head);
      // "+" right after the count: a new chat in this project (its folder pre-filled). The toggle's hit area covers the
      // whole row (CSS ::after); the "+" sits above it, so clicking it never opens or closes the project.
      if (W2 && W2.newChatIn && g.key) {
        const add = el('button', '+', 'project-add');
        add.type = 'button';
        add.title = 'New chat in ' + g.name;
        add.setAttribute('aria-label', 'New chat in ' + g.name);
        add.onclick = (e) => {
          if (e && e.stopPropagation) e.stopPropagation();
          W2.newChatIn(g.key);
        };
        headRow.append(add);
      }
      headRow.append(badge);
      if (W2 && W2.openProjectCtx && g.key) {
        const more = el('button', '⋯', 'project-more');
        more.type = 'button';
        more.setAttribute('aria-label', 'Project options: ' + g.name);
        more.setAttribute('aria-haspopup', 'menu');
        more.onclick = (e) => {
          e.stopPropagation();
          const r = more.getBoundingClientRect ? more.getBoundingClientRect() : { left: 0, bottom: 0 };
          W2.openProjectCtx(g.key, r.left, r.bottom, more);
        };
        head.addEventListener &&
          head.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            W2.openProjectCtx(g.key, e.clientX, e.clientY, head);
          });
        headRow.append(more);
      }
      wrap.append(headRow, body);
      return wrap;
    });
  }
  const ids = new Map();
  function groupId(key) {
    if (!ids.has(key)) ids.set(key, ids.size + 1);
    return ids.get(key);
  }

  // ---- status phrase -----------------------------------------------------------------------
  // One plain-words description of a conversation for the list card. It reuses the sources the header uses: the
  // server attention object (statusOf), the ownership verdict (AgentOwnershipUI labels) and the live connection.
  // opts: {hint: ownership hint, issue: the open chat lost its connection, now}. Returns {kind, text, tone, title}.
  const ownershipReason = (hint) => {
    const o = root.AgentOwnershipUI;
    return o && o.reasonTexts && hint ? o.reasonTexts(hint)[0] || '' : '';
  };
  // Which kind of request is waiting: sign-in beats a question beats a permission (the header's order).
  function waitingKinds(c) {
    const live = liveOf(c);
    if (!live) return { kinds: [], total: 0 };
    const total = statusOf(c).needs;
    const questions = Array.isArray(live.elicitations) ? live.elicitations.length : 0,
      signIn = live.auth ? 1 : 0;
    const permissions = Math.max(0, total - questions - signIn);
    const kinds = [];
    if (signIn) kinds.push('sign-in');
    if (questions) kinds.push('question');
    if (permissions || !kinds.length) kinds.push('permission');
    return { kinds, total };
  }
  // The words come from status-words.js (one vocabulary for header, card, tab and inbox). yourTurn: the conversation
  // object's own flag (c.yourTurn or c.live.yourTurn, see status-words.js) when present, else "finished, not viewed".
  function phrase(c, opts) {
    const o = opts || {},
      now = o.now || Date.now(),
      live = liveOf(c),
      W = root.AgentStatusWords;
    const hint = o.hint !== undefined ? o.hint : host && host.ownershipOf ? host.ownershipOf(c) : null;
    const facts = {
      now,
      connected: !!live,
      issue: !!live && (o.issue !== undefined ? o.issue : !!(host && host.issueFor && host.issueFor(c))),
      recovered: !!(c && c.recovered),
      reconnecting: !!((c && c.recovered && c.recovered.reconnecting) || (live && live.reconnecting)),
      agentList: !!(c && c.source === 'agent'),
      verdict: hint && hint.verdict,
      elsewhereWorking: W.elsewhereWorking(hint),
      elsewhere: c && c.elsewhere,
      recent: !!(c && Number(c.modified) && now / 1000 - Number(c.modified) < 90),
    };
    if (live) {
      const s = statusOf(c),
        w = waitingKinds(c),
        flag =
          typeof (c && c.yourTurn) === 'boolean'
            ? c.yourTurn
            : typeof live.yourTurn === 'boolean'
              ? live.yourTurn
              : null;
      Object.assign(facts, {
        failed: !!live.error && s.state !== 'needs_you',
        error: live.error,
        needs: s.state === 'needs_you' ? Math.max(1, w.total) : 0,
        needsKind: w.kinds[0],
        opening: s.state === 'opening',
        busy: s.state === 'working',
        busySince: busySince.get(keyOf(c)),
        yourTurn: flag === null ? s.state === 'unread' : flag,
      });
    }
    const st = W.statusOf(facts);
    const evidence = /^elsewhere/.test(st.kind) ? ownershipReason(hint) : '';
    return {
      kind: st.kind,
      text: st.label,
      tone: st.tone,
      title: evidence || (st.detail ? st.title + ' (' + st.detail + ')' : st.title),
      dotClass: st.dotClass,
      status: st,
    };
  }
  // Last message for the card's third line, from what the lists already carry (no extra server work).
  function previewOf(c) {
    const last = c && c.last;
    if (!last || (last.kind !== 'user' && last.kind !== 'assistant') || typeof last.text !== 'string') return '';
    const line =
      last.text
        .split(/\r?\n/)
        .map((x) => x.replace(/^[#>*\-\s`]+/, '').trim())
        .find(Boolean) || '';
    return line ? (last.kind === 'user' ? 'You: ' : '') + line.slice(0, 160) : '';
  }
  function subagentsOf(c) {
    const live = liveOf(c);
    if (live && live.subagents && typeof live.subagents === 'object') return Object.keys(live.subagents).length;
    return Math.max(0, Number(c && c.subagentCount) || 0);
  }

  // ---- rows ---------------------------------------------------------------------------------
  // node = the row wrapper made by the page: [button.connection [small.connection-workspace, span.title, small.state], menu button].
  // Card: line 1 = dot, title, age; line 2 = status phrase + agent (+ subagent chip); line 3 = hold note, else last message.
  // inProject: the row sits under its project heading, so the project name is not repeated.
  // opts.hold: the on-hold text. Returns true when it built the hold-note line itself.
  function decorateRow(node, c, inProject, opts) {
    const main = node && node.children && node.children[0];
    const first = main && main.children && main.children[0];
    if (!first || !first.append) return false;
    const p = projectOf(c),
      s = statusOf(c),
      ph = phrase(c);
    first.textContent = '';
    first.className =
      (first.className || '').replace(/\bconnection-workspace\b/, '').trim() + ' connection-workspace row-meta';
    const label = inProject ? providerName(c.provider) : p.name + ' · ' + providerName(c.provider);
    first.append(dot(s.state, ph.text || s.label, s.needs, ph.dotClass), el('span', label, 'row-meta-text'));
    first.title = (p.path || 'No folder') + '\n' + providerName(c.provider);
    if (s.state === 'needs_you' || s.state === 'unread') main.className = (main.className || '') + ' attn-' + s.state;
    let held = false;
    if (main.append) {
      main.append(el('span', shortAge(c, s), 'row-age'));
      // Tooltip: the full title (the card cuts it), the status in the same words as the card, then what was there (folder, id).
      const t = Array.from(main.children || []).find((n) => /(^|\s)connection-title(\s|$)/.test(n.className || '')),
        full = t ? String(t.textContent || '') : '';
      main.title = [full, ph.text || s.label, main.title || ''].filter(Boolean).join(String.fromCharCode(10));
      // Line 2: the phrase in words, the agent muted, and a small subagent chip.
      const line = el('span', null, 'row-status tone-' + ph.tone);
      line.dataset.kind = ph.kind;
      line.title = ph.title;
      line.append(el('span', ph.text, 'row-phrase'), el('span', ' · ' + providerName(c.provider), 'row-agent'));
      main.append(line);
      // Line 3: hold note, else the last message; the project name leads it when the list mixes projects.
      const project = !flat && !inProject && p && p.name ? p.name : '';
      const hold = opts && opts.hold ? opts : null;
      const body = hold ? hold.hold : previewOf(c);
      if (body || project) {
        const third = el('small', null, (hold ? 'hold-note ' : '') + 'row-line3');
        if (project) third.append(el('span', project + (body ? ' · ' : ''), 'row-project'));
        // On hold: the note shortens, "· held 10m" always stays; the whole line is the tooltip.
        if (hold && hold.holdAge) {
          third.append(el('span', hold.holdNote || '', 'hold-text'), el('span', ' · ' + hold.holdAge, 'hold-age'));
          third.title = body;
        } else if (body) third.append(el('span', body, 'row-preview'));
        main.append(third);
        held = !!hold;
      }
      const branch = branchOf(c);
      if (branch) {
        const chip = el('small', null, 'row-line3 row-branch');
        chip.append(el('span', '⎇ ' + branch, 'row-branch-name'));
        chip.title = 'This chat works on its own branch';
        main.append(chip);
      }
    }
    return held;
  }

  // "now" while it is doing something, otherwise how long ago it last changed: 5m, 3h, 2d, 6w.
  function shortAge(c, s, now) {
    if (s && (s.state === 'working' || s.state === 'needs_you' || s.state === 'opening')) return 'now';
    const t = Math.max(Number(c && c.modified) || 0, Number(c && c.created) || 0);
    if (!t) return '';
    const n = Math.max(0, Math.floor((now || Date.now()) / 1000 - t));
    return n < 60
      ? 'now'
      : n < 3600
        ? Math.floor(n / 60) + 'm'
        : n < 86400
          ? Math.floor(n / 3600) + 'h'
          : n < 7 * 86400
            ? Math.floor(n / 86400) + 'd'
            : Math.floor(n / (7 * 86400)) + 'w';
  }

  const signature = () =>
    (flat ? 'f' : 'g') +
    '|' +
    Math.floor(Date.now() / 60000) +
    '|' +
    Array.from(collapsed).sort().join(',') +
    '|' +
    Array.from(names.values())
      .map((n) => n.key + '=' + n.name)
      .sort()
      .join(';');

  function init(h) {
    host = h;
    collapsed = new Set(
      Array.isArray(read('collapsed', [])) ? read('collapsed', []).filter((x) => typeof x === 'string') : [],
    );
    const first = Number(read('epoch', 0));
    epoch = first > 0 ? first : Date.now();
    if (!(first > 0)) write('epoch', epoch);
    const d = doc();
    if (d) {
      baseTitle = String(d.title || 'AIB').replace(/^\(\d+\)\s*/, '') || 'AIB';
      const seen = () => {
        if (host && looking()) {
          const s = host.getSelected && host.getSelected();
          if (s) {
            markViewed(s);
            if (host.rerender) host.rerender();
          }
        }
      };
      d.addEventListener('visibilitychange', seen);
      if (root.addEventListener) root.addEventListener('focus', seen);
    }
  }

  const api = {
    init,
    sync,
    signature,
    setNameHook,
    pathKey,
    rootOf,
    branchOf,
    projectNames,
    projectOf,
    statusOf,
    summarize,
    rowSig,
    dot,
    decorateRow,
    setBase,
    projectGroups,
    groupRows,
    isGrouping,
    setFlat,
    shortAge,
    phrase,
    previewOf,
    subagentsOf,
    isCollapsed,
    setCollapsed,
    reveal,
    markViewed,
    providerName,
    activityOf,
    _viewed: () => viewed,
    _names: () => names,
  };
  root.AgentSidebarUI = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
