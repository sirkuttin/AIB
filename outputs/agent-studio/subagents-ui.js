'use strict';
/* Activity pane subagent list: Working vs Finished groups, names, state, and cheap re-render. Pure DOM via textContent. */
(function (root) {
  const RUNNING = /^(running|working|in[-_ ]progress|active|starting|queued|busy|streaming)$/i;
  const GENERIC = /^Subagent [0-9a-f]{8}$/;
  const first = (v) =>
    typeof v === 'string' && v.trim() ? v.trim().split(/\r?\n/)[0].replace(/\s+/g, ' ').slice(0, 120) : '';
  const stateText = (raw) => {
    const v =
      typeof raw === 'string'
        ? raw
        : raw && typeof raw === 'object'
          ? (raw.state ?? raw.status ?? raw.phase ?? raw.name ?? '')
          : '';
    return String(v || '').trim();
  };
  const LABELS = {
    running: 'Working',
    working: 'Working',
    active: 'Working',
    busy: 'Working',
    streaming: 'Working',
    'in-progress': 'Working',
    in_progress: 'Working',
    'in progress': 'Working',
    starting: 'Starting',
    queued: 'Queued',
    idle: 'Idle',
    completed: 'Completed',
    complete: 'Completed',
    failed: 'Failed',
    error: 'Failed',
    cancelled: 'Stopped',
    canceled: 'Stopped',
    stopped: 'Stopped',
    killed: 'Stopped',
  };
  /* kind: working | probable | failed | completed | idle | stopped. group: working | finished. */
  function classify(a) {
    if (a.live) {
      const s = stateText(a.state),
        l = s.toLowerCase();
      if (RUNNING.test(s)) return { group: 'working', kind: 'working', label: LABELS[l] || 'Working' };
      if (/^(failed|error)$/.test(l)) return { group: 'finished', kind: 'failed', label: 'Failed' };
      if (/^(cancelled|canceled|stopped|killed)$/.test(l))
        return { group: 'finished', kind: 'stopped', label: 'Stopped' };
      if (/^(completed|complete)$/.test(l)) return { group: 'finished', kind: 'completed', label: 'Completed' };
      return { group: 'finished', kind: 'idle', label: LABELS[l] || s || 'Idle' };
    }
    if (a.failed) return { group: 'finished', kind: 'failed', label: 'Failed' };
    if (a.finished === true || a.completedMarker) return { group: 'finished', kind: 'completed', label: 'Completed' };
    if (a.active && a.finished !== true) return { group: 'working', kind: 'probable', label: 'Probably running' };
    return { group: 'finished', kind: 'idle', label: a.finished === false ? 'Not marked finished' : 'Ended' };
  }
  function names(a) {
    const id = String(a.agentId || a.key || '')
      .replace(/^.*[\\/]agent-/, '')
      .replace(/\.jsonl$/, '');
    const t = first(a.title) || first(a.name),
      d = first(a.description),
      type = first(a.agentType);
    const typeLike = (s) => !!s && (s === type || /^[\w.-]+$/.test(s));
    let title,
      kind = type;
    if (t && !GENERIC.test(t) && t !== id) {
      if (d && d !== t && typeLike(t)) {
        title = d;
        kind = kind || t;
      } else title = t;
    } else title = d || first(a.firstPrompt) || t || 'Subagent ' + id.slice(0, 8);
    if (kind === title) kind = '';
    return {
      title,
      type: kind,
      id,
      tip: [
        title,
        kind && 'Type: ' + kind,
        id && 'Id: ' + id,
        a.description && first(a.description) !== title && 'Task: ' + String(a.description).trim().slice(0, 300),
        a.result && 'Result: ' + String(a.result).replace(/\s+/g, ' ').slice(0, 200),
      ]
        .filter(Boolean)
        .join('\n'),
    };
  }
  function span(secs) {
    if (!(secs >= 0)) return '';
    if (secs < 60) return '<1m';
    const m = Math.floor(secs / 60);
    if (m < 60) return m + 'm';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : '');
    return Math.floor(h / 24) + 'd';
  }
  function nest(list) {
    const ids = new Map(list.filter((i) => i.agentId).map((i) => [i.agentId, i])),
      kids = new Map(),
      roots = [];
    for (const i of list) {
      const p = i.parentId && i.parentId !== i.agentId ? ids.get(i.parentId) : null;
      if (p) {
        if (!kids.has(p)) kids.set(p, []);
        kids.get(p).push(i);
      } else roots.push(i);
    }
    const out = [],
      seen = new Set();
    const walk = (i, d) => {
      if (seen.has(i)) return;
      seen.add(i);
      i.depth = Math.min(d, 3);
      out.push(i);
      for (const k of kids.get(i) || []) walk(k, d + 1);
    };
    roots.forEach((r) => walk(r, 0));
    list.forEach((i) => walk(i, 0));
    return out;
  }
  function model(rows, now) {
    const items = rows.map((a) => {
      const c = classify(a),
        n = names(a);
      const start = Number(a.created) || 0;
      const end = a.live ? Number(a.since) || Number(a.created) || 0 : Number(a.modified) || 0;
      const ago = end ? span(now - end) : '';
      const when =
        c.group === 'working'
          ? start
            ? 'running ' + span(now - start)
            : ''
          : ago
            ? ago === '<1m'
              ? 'just now'
              : ago + ' ago'
            : '';
      const cmds = Math.max(0, Number(a.runningCommands) || 0);
      return {
        a,
        key: String(a.key),
        agentId: String(a.agentId || ''),
        parentId: String(a.parentAgentId || ''),
        depth: 0,
        cmds,
        group: c.group,
        kind: c.kind,
        label: c.label,
        title: n.title,
        type: n.type,
        tip: n.tip,
        when,
        source: a.live ? 'live' : 'saved',
        end,
        start,
      };
    });
    const by = (x, y) => y.start - x.start || x.key.localeCompare(y.key);
    const fin = items
      .filter((i) => i.group === 'finished')
      .sort((x, y) => (y.kind === 'failed') - (x.kind === 'failed') || y.end - x.end || x.key.localeCompare(y.key));
    /* top = working then failed (the always-visible list); done = the other finished rows (collapsed by default). */
    const top = nest(
      items
        .filter((i) => i.group === 'working')
        .sort(by)
        .concat(fin.filter((i) => i.kind === 'failed')),
    );
    const done = nest(fin.filter((i) => i.kind !== 'failed'));
    const working = top.filter((i) => i.group === 'working'),
      failedRows = top.filter((i) => i.kind === 'failed');
    return {
      top,
      done,
      working,
      finished: failedRows.concat(done),
      failed: failedRows.length,
      cmds: items.reduce((n, i) => n + i.cmds, 0),
    };
  }
  /* Section heading qualifier: "2 working · 1 failed". */
  function sectionHeading(m) {
    return m.working.length + ' working · ' + m.failed + ' failed';
  }
  function heading(m) {
    return m.working.length + ' working · ' + m.finished.length + ' finished';
  }
  /* Slim counts strip: "2 working · 1 failed · 1 cmd". Zero parts are left out. */
  function strip(m, cmdCount) {
    const parts = [];
    if (m.working.length) parts.push(m.working.length + ' working');
    if (m.failed) parts.push(m.failed + ' failed');
    const c = cmdCount == null ? m.cmds : cmdCount;
    if (c) parts.push(c + (c === 1 ? ' cmd' : ' cmds'));
    return parts.length ? parts.join(' · ') : m.finished.length ? m.finished.length + ' finished' : 'No activity';
  }
  /* Drawer header facts for one subagent row: name, type, state and how long it has run. */
  function header(a, now) {
    const c = classify(a),
      n = names(a),
      start = Number(a.created) || 0;
    const end = c.group === 'working' ? now : a.live ? Number(a.since) || now : Number(a.modified) || now;
    const d = start ? span(Math.max(0, end - start)) : '';
    return {
      title: n.title,
      type: n.type,
      state: c.label,
      kind: c.kind,
      group: c.group,
      duration: d,
      cmds: Math.max(0, Number(a.runningCommands) || 0),
    };
  }
  /* Direct children of one agent among all rows (matches parentAgentId to agentId). */
  function childrenOf(rows, a) {
    const id = a && a.agentId;
    return id ? rows.filter((r) => r !== a && r.parentAgentId === id) : [];
  }
  const storeKey = (k) => 'studio-subagents-finished:' + k;
  function expanded(convKey) {
    try {
      return localStorage.getItem(storeKey(convKey)) === '1';
    } catch (e) {
      return false;
    }
  }
  function remember(convKey, open) {
    try {
      localStorage.setItem(storeKey(convKey), open ? '1' : '0');
    } catch (e) {}
  }
  let lastSignature = '',
    lastBox = null;
  function el(tag, cls, txt) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  }
  /* One 28 px row: dot, name, optional "1 cmd" chip (only while a command runs), time. Type and state live in the tooltip. */
  function card(i, ctx) {
    const b = el(
      'button',
      'subagent-card sa-card sa-' + i.group + ' sa-' + i.kind + (ctx.selectedKey === i.key ? ' selected' : ''),
    );
    b.type = 'button';
    b.dataset.key = i.key;
    b.title = i.tip + '\n' + i.label + (i.source === 'saved' ? ' (from saved events)' : '');
    b.onclick = () => ctx.onOpen(i.a);
    if (i.depth) b.style.setProperty('--depth', i.depth);
    b.append(el('span', 'sa-dot'), el('strong', 'sa-title', i.title));
    if (i.cmds) b.append(el('span', 'sa-cmd', i.cmds + (i.cmds === 1 ? ' cmd' : ' cmds')));
    const when = i.kind === 'failed' ? 'failed' + (i.when ? ' ' + i.when : '') : i.when;
    if (when) b.append(el('span', 'sa-when', when));
    return b;
  }
  function render(ctx) {
    const m = model(ctx.rows, ctx.now),
      open = expanded(ctx.convKey);
    if (ctx.countEl) ctx.countEl.textContent = ctx.rows.length ? sectionHeading(m) : '0';
    if (ctx.onModel) ctx.onModel(m);
    const sig = JSON.stringify([
      ctx.convKey,
      ctx.empty,
      ctx.selectedKey,
      open,
      [...m.top, ...m.done].map((i) => [
        i.key,
        i.group,
        i.kind,
        i.label,
        i.title,
        i.type,
        i.when,
        i.tip,
        i.cmds,
        i.depth,
      ]),
    ]);
    if (sig === lastSignature && ctx.box === lastBox && ctx.box.firstChild) return;
    lastSignature = sig;
    lastBox = ctx.box;
    const box = ctx.box,
      focus = document.activeElement && box.contains(document.activeElement) ? document.activeElement : null,
      focusKey = focus?.dataset?.key,
      focusToggle = focus?.classList?.contains('sa-toggle');
    const tops = [...box.querySelectorAll('.sa-scroll')].map((n) => n.scrollTop);
    const frag = document.createDocumentFragment();
    const h = el('h4', 'sa-heading', 'Subagents');
    if (ctx.rows.length) {
      const q = el('span', 'sa-qualifier', m.working.length + ' working · ');
      q.append(el('span', m.failed ? 'sa-failed-count' : '', m.failed + ' failed'));
      h.append(q);
    }
    const hideBtn = document.getElementById('activityHide');
    if (hideBtn) h.append(hideBtn);
    frag.append(h);
    if (!ctx.rows.length) frag.append(el('p', 'empty-state sa-empty', ctx.empty));
    else {
      const list = el('div', 'sa-scroll');
      for (const i of m.top) list.append(card(i, ctx));
      if (!m.top.length && !m.done.length) list.append(el('p', 'sa-none', 'Nothing running right now.'));
      if (m.done.length) {
        const t = el('button', 'sa-toggle sa-card');
        t.type = 'button';
        t.setAttribute('aria-expanded', open ? 'true' : 'false');
        t.setAttribute('aria-label', m.done.length + ' finished subagents, ' + (open ? 'hide' : 'show'));
        t.append(el('span', 'sa-caret', open ? '▾' : '▸'), el('span', 'sa-title', m.done.length + ' finished'));
        t.onclick = () => {
          remember(ctx.convKey, !open);
          lastSignature = '';
          ctx.rerender();
        };
        list.append(t);
        if (open) for (const i of m.done) list.append(card(i, ctx));
      }
      frag.append(list);
    }
    box.replaceChildren(frag);
    box.querySelectorAll('.sa-scroll').forEach((n, k) => {
      if (tops[k]) n.scrollTop = tops[k];
    });
    if (focusToggle) box.querySelector('.sa-toggle')?.focus();
    else if (focusKey)
      for (const n of box.querySelectorAll('.subagent-card'))
        if (n.dataset.key === focusKey) {
          n.focus();
          break;
        }
  }
  /* Live-child bookkeeping used by chat.js collectChildren. */
  function enrich(next, old, child, time) {
    const t = typeof child.title === 'string' && child.title.trim() ? child.title.trim() : '';
    if (t) next.title = t;
    const ty = child.agentType || child.subagentType || child.subagent_type;
    if (typeof ty === 'string' && ty.trim()) next.agentType = ty.trim();
    if (!old || stateText(old.state) !== stateText(next.state) || !next.since) next.since = time;
  }
  function noteEvent(c, e) {
    if (!c || c.firstPrompt) return;
    const u = e.data?.update;
    if (u?.sessionUpdate === 'user_message_chunk' && typeof u.content?.text === 'string' && u.content.text.trim())
      c.firstPrompt = u.content.text.trim().slice(0, 300);
  }
  root.SubagentsUI = {
    classify,
    names,
    model,
    heading,
    sectionHeading,
    strip,
    header,
    childrenOf,
    nest,
    render,
    enrich,
    noteEvent,
    span,
    stateText,
  };
  if (typeof module === 'object' && module.exports) module.exports = root.SubagentsUI;
})(typeof window !== 'undefined' ? window : globalThis);
