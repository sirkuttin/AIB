'use strict';
/* Condensed chat views, the page part: the switch in the chat header (Full · Chat · Prompts), the DOM of a projected
   list (views.js) and the scroll anchor used when the view changes. chat.js owns the state and calls in here. */
(function (root) {
  const V = () => root.ChatViews;
  const doc = () => root.document || globalThis.document;
  const make = (tag, cls, value) => {
    const n = doc().createElement(tag);
    if (cls) n.className = cls;
    if (value !== undefined) n.textContent = value;
    return n;
  };

  /* ---- the switch: a radiogroup (roving tabindex, arrow keys); a <select> takes over on narrow headers (CSS) ---- */
  let sw = null;
  const COMPACT = 820,
    NARROW = 680;
  function mount(host, api) {
    if (!host || !V()) return null;
    const { VIEWS, LABELS, AVAILABLE } = V();
    const group = make('div', 'vs-group');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', 'Chat view');
    const select = make('select', 'vs-select');
    select.setAttribute('aria-label', 'Chat view');
    const buttons = {};
    for (const view of VIEWS) {
      const b = make('button', 'vs-opt', LABELS[view]);
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-label', 'View: ' + LABELS[view]);
      b.dataset.view = view;
      if (!AVAILABLE[view]) {
        b.setAttribute('aria-disabled', 'true');
        b.title = LABELS[view] + ': coming next';
      }
      buttons[view] = b;
      group.append(b);
      const o = make('option', '', LABELS[view] + (AVAILABLE[view] ? '' : ' (coming next)'));
      o.value = view;
      o.disabled = !AVAILABLE[view];
      select.append(o);
    }
    const choose = (view, focus) => {
      if (!AVAILABLE[view]) return;
      api.set(view);
      sync();
      if (focus && buttons[view].focus) buttons[view].focus();
    };
    const enabled = VIEWS.filter((v) => AVAILABLE[v]);
    group.addEventListener('keydown', (e) => {
      const here = enabled.indexOf(api.get());
      let next = -1;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (here + 1) % enabled.length;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (here - 1 + enabled.length) % enabled.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = enabled.length - 1;
      else return;
      if (e.preventDefault) e.preventDefault();
      choose(enabled[next], true);
    });
    for (const view of VIEWS) buttons[view].addEventListener('click', () => choose(view, false));
    select.addEventListener('change', () => choose(select.value, false));
    host.replaceChildren(group, select);
    function sync() {
      host.hidden = api.visible ? !api.visible() : false;
      const now = api.get();
      for (const view of VIEWS) {
        const on = view === now;
        buttons[view].setAttribute('aria-checked', on ? 'true' : 'false');
        buttons[view].tabIndex = on ? 0 : -1;
        buttons[view].className = 'vs-opt' + (on ? ' on' : '');
      }
      select.value = now;
    }
    /* collapse by the header's own width (a split pane is narrow in a wide window), not the window's */
    const head = host.closest ? host.closest('header') : null;
    const fit = (width) => {
      if (!head || !head.classList) return;
      head.classList.toggle('vs-compact', width <= COMPACT);
      head.classList.toggle('vs-narrow', width <= NARROW);
    };
    if (head && typeof root.ResizeObserver === 'function') {
      new root.ResizeObserver((entries) => {
        const e = entries && entries[0];
        fit(e && e.contentRect ? e.contentRect.width : head.clientWidth);
      }).observe(head);
    }
    sw = { host, group, select, buttons, sync, choose, fit };
    sync();
    return sw;
  }
  const sync = () => {
    if (sw) sw.sync();
    syncFind();
  };

  /* ---- DOM of a projected list ---- */
  const OPEN = new Set(); // folds whose "Show steps" is open: keyed by the first row's time plus the prompt, so it survives new turns and rebuilds
  const isOpen = (key) => OPEN.has(key);

  function stepsBlock(fold, ctx) {
    const wrap = make('div', 'steps-block'),
      btn = make('button', 'steps-toggle'),
      list = make('div', 'group-steps');
    btn.type = 'button';
    const label = V().stepsLabel(fold.counts);
    const paint = () => {
      const open = OPEN.has(fold.key);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      const text = (open ? '▾ Hide steps (' : '▸ Show steps (') + label + ')';
      if (fold.counts.failed) {
        /* a failure inside the fold must not go unnoticed: a ✗ before the words and "N failed" in the error colour; the row stays folded */
        btn.className = 'steps-toggle has-failed';
        const bits = text.split(/(\d+ failed)/);
        btn.replaceChildren(
          make('span', 'sf-x', '✗ '),
          ...bits.map((b) => (/^\d+ failed$/.test(b) ? make('span', 'sf-failed', b) : make('span', '', b))),
        );
        btn.title = 'A step in this run failed';
      } else btn.textContent = text;
      list.hidden = !open;
      /* The fold is the only fold: its rows are drawn one by one, never through groupRows (that would put a second
         "steps · N steps" fold inside this one whenever more than 3 tool rows sit side by side, e.g. when a note between
         them is dropped from the fold or a saved transcript has no thinking rows to break the run). */
      if (open && !list.children.length) list.append(...fold.rows.map((r) => ctx.bubble(r)));
    };
    btn.addEventListener('click', () => {
      if (OPEN.has(fold.key)) OPEN.delete(fold.key);
      else OPEN.add(fold.key);
      paint();
    });
    wrap.append(btn, list);
    paint();
    return wrap;
  }

  /* ---- the live line: spinner, "Working", the current step, and "step N · m:ss" on the right ----
     live = {step: {kind:'tool', label, text, title} | {kind:'thinking'}, n, since (ms), elsewhere, waiting}.
     Only the step and the clock change after it is drawn, and they change in place (paintLive), never by drawing the pane again. */
  const stepKey = (s) => (s && s.kind === 'tool' ? 'tool|' + s.label + '|' + s.text : 'thinking');
  function metaText(live, now) {
    const t = live.since ? V().clock((now || Date.now()) - live.since) : '';
    if (live.elsewhere) return 'working elsewhere' + (t ? ' · ' + t : '');
    return (live.n ? 'step ' + live.n : '') + (live.n && t ? ' · ' : '') + t;
  }
  function paintLive(line, live, now) {
    const parts = line._parts,
      state = live.waiting ? 'Waiting for you' : 'Working',
      key = stepKey(live.step),
      meta = metaText(live, now);
    line._live = live;
    if (parts.state.textContent !== state) parts.state.textContent = state;
    if (parts.key !== key) {
      parts.key = key;
      const s = live.step;
      if (s && s.kind === 'tool') {
        const text = make('span', 'tool-line-text', s.text);
        text.title = s.title || s.text;
        parts.step.replaceChildren(make('span', 'tool-line-kind', s.label), text);
        parts.step.className = 'vl-step vl-tool';
      } else {
        parts.step.replaceChildren(make('span', 'vl-thinking', 'Thinking…'));
        parts.step.className = 'vl-step';
      }
    }
    if (parts.meta.textContent !== meta) parts.meta.textContent = meta;
  }
  function liveLine(live) {
    const line = make('div', 'view-line view-line-working view-live');
    line.setAttribute('role', 'note');
    const spin = make('span', 'plan-spin view-spin'),
      state = make('span', 'vl-state'),
      step = make('span', 'vl-step'),
      meta = make('span', 'vl-meta');
    line._parts = { state, step, meta, key: null };
    line.append(spin, state, step, meta);
    paintLive(line, live);
    return line;
  }
  /* New step or number from a poll: update the line that is already drawn (true when there was one). */
  function refreshLive(box, live) {
    const line = box && box.querySelector && live ? box.querySelector('.view-live') : null;
    if (!line || !line._parts) return false;
    paintLive(line, live);
    return true;
  }
  /* The once-a-second clock: every drawn live line (main pane and split panes) updates its text, nothing else. */
  function tickLive(now) {
    const lines = doc().querySelectorAll ? doc().querySelectorAll('.view-live') : [];
    for (const line of lines) if (line._live && line._parts) paintLive(line, line._live, now);
    return lines.length;
  }

  /* ---- Prompts: each prompt of yours is an accordion holding every reply up to your next prompt ---- */
  const POPEN = new Set(); // opened prompts, keyed by prompt (time + text hash): they stay open across new turns and rebuilds
  const plainName = (a) => {
    const n = a && (a.name || a.title || a.uri || a.url || '');
    return String(n).split(/[\\/]/).filter(Boolean).pop() || (a && a.type === 'image' ? 'image' : 'file');
  };
  const idOf = (key) => 'pvb-' + String(key).replace(/[^A-Za-z0-9_-]/g, '_');
  const repliesText = (n) => n + (n === 1 ? ' reply' : ' replies');
  function promptHead(unit, ctx) {
    const SU = root.StreamUI,
      row = unit.prompt,
      open = POPEN.has(unit.key),
      head = make('button', 'pv-head');
    head.type = 'button';
    head.setAttribute('aria-expanded', open ? 'true' : 'false');
    head.setAttribute('aria-controls', idOf(unit.key));
    const arrow = make('span', 'pv-arrow', open ? '▾' : '▸');
    arrow.setAttribute('aria-hidden', 'true');
    const text = make(
      'span',
      'pv-text',
      String(V().promptText ? V().promptText(row) : row.value || '')
        .replace(/\s+/g, ' ')
        .trim(),
    );
    head._arrow = arrow;
    head.append(arrow, text);
    const files = (row.attachments || []).filter(Boolean);
    if (files.length) {
      const chips = make('span', 'pv-chips');
      for (const a of files.slice(0, 3)) chips.append(make('span', 'pv-chip', plainName(a)));
      if (files.length > 3) chips.append(make('span', 'pv-chip', '+' + (files.length - 3)));
      head.append(chips);
    }
    if (unit.error) {
      const err = make('span', 'pv-err', 'error');
      err.title = 'A reply in this prompt had an error';
      head.append(err);
    }
    const when = SU && SU.shortTime ? SU.shortTime(unit.time) : '';
    const meta = make('span', 'pv-meta');
    if (unit.working) {
      meta.className = 'pv-meta pv-working';
      meta.append(make('span', 'plan-spin view-spin'), make('span', '', 'working' + (when ? ' · ' + when : '')));
    } else meta.textContent = repliesText(unit.replies) + (when ? ' · ' + when : '');
    head.append(meta);
    return head;
  }
  function promptItem(unit, ctx) {
    const item = make('div', 'pv-item'),
      head = promptHead(unit, ctx),
      body = make('div', 'pv-body');
    item.dataset.pk = unit.key;
    body.id = idOf(unit.key);
    const paint = () => {
      const open = POPEN.has(unit.key);
      head.setAttribute('aria-expanded', open ? 'true' : 'false');
      head._arrow.textContent = open ? '▾' : '▸';
      item.className = 'pv-item' + (open ? ' open' : '');
      body.hidden = !open;
      if (open && !body.children.length) body.append(...ctx.groupRows(unit.rows, ctx.bubble));
    };
    head.addEventListener('click', () => {
      if (POPEN.has(unit.key)) POPEN.delete(unit.key);
      else POPEN.add(unit.key);
      paint();
      if (POPEN.has(unit.key) && ctx.onOpen) ctx.onOpen(unit); // the replies inside are seen now
    });
    item.append(head, body);
    paint();
    return item;
  }
  /* A hit from the find box that lies on an older, unloaded page: a closed header; clicking loads that page and opens the prompt. */
  function promptStub(hit, ctx) {
    const SU = root.StreamUI,
      b = make('button', 'pv-head pv-stub');
    b.type = 'button';
    b.dataset.index = String(hit.index);
    const arrow = make('span', 'pv-arrow', '▸');
    arrow.setAttribute('aria-hidden', 'true');
    const when = SU && SU.shortTime ? SU.shortTime(hit.time) : '';
    b.append(
      arrow,
      make(
        'span',
        'pv-text',
        String(hit.text || '')
          .replace(/\s+/g, ' ')
          .trim(),
      ),
      make('span', 'pv-meta', 'older' + (when ? ' · ' + when : '')),
    );
    b.title = 'Load the older messages and open this prompt';
    b.addEventListener('click', () => ctx.openHit(hit));
    return b;
  }
  /* ctx: {bubble, groupRows, stubs?: hits on unloaded pages, openHit(hit), query}. */
  function promptNodes(proj, start, ctx) {
    const out = [];
    for (const hit of ctx.stubs || []) out.push(promptStub(hit, ctx));
    for (const unit of proj.units.slice(start || 0)) out.push(promptItem(unit, ctx));
    if (!out.length) out.push(make('p', 'empty-state', ctx.query ? 'No prompts match.' : 'No prompts yet.'));
    return out;
  }
  function openPrompt(key) {
    POPEN.add(key);
  }

  /* The find box (above the list, outside it, so drawing the list never takes its focus away). api: {query(), set(q), visible(), note()} */
  let find = null;
  function mountFind(host, api) {
    if (!host) return null;
    const label = make('label', 'pf-box'),
      input = make('input', 'pf-input'),
      note = make('span', 'pf-note');
    input.type = 'search';
    input.autocomplete = 'off';
    input.placeholder = 'Find in your messages';
    input.setAttribute('aria-label', 'Find in your messages');
    note.setAttribute('role', 'status');
    label.append(input);
    host.replaceChildren(label, note);
    input.addEventListener('input', () => api.set(input.value));
    find = {
      host,
      input,
      note,
      sync() {
        host.hidden = api.visible ? !api.visible() : false;
        if (input.value !== api.query()) input.value = api.query();
        note.textContent = api.note ? api.note() : '';
      },
    };
    find.sync();
    return find;
  }
  const syncFind = () => find && find.sync();

  /* ctx: {bubble(row), groupRows(rows, bubble)} from chat.js. Returns the top-level nodes of one unit, in order.
     (A "Show steps" fold draws its rows flat; groupRows is for Full and the Prompts accordion, where it is the only fold.) */
  function unitNodes(unit, ctx) {
    const out = [];
    if (!unit.prompt && unit.earlier) {
      const head = make('div', 'group-earlier', 'Earlier prompt (load to see)');
      head.dataset.pk = unit.key;
      out.push(head);
    }
    if (unit.prompt) {
      const el = ctx.bubble(unit.prompt);
      if (el.dataset) el.dataset.pk = unit.key;
      out.push(el);
    }
    for (const item of unit.body) {
      if (item.fold) {
        out.push(stepsBlock(item.fold, ctx));
        continue;
      }
      if (item.line === 'working' && item.live) {
        out.push(liveLine(item.live));
        continue;
      }
      if (item.line) {
        const line = make('div', 'view-line view-line-' + item.line, item.text);
        line.setAttribute('role', 'note');
        if (item.line === 'working') line.prepend(make('span', 'plan-spin view-spin'));
        out.push(line);
        continue;
      }
      if (item.after) out.push(make('div', 'bg-tag', 'after background task'));
      out.push(ctx.bubble(item.row));
    }
    return out;
  }
  function listNodes(proj, start, ctx) {
    const out = [];
    for (const unit of proj.units.slice(start || 0)) out.push(...unitNodes(unit, ctx));
    if (proj.tail) out.push(ctx.bubble(proj.tail));
    return out;
  }
  /* The rows drawn as top-level bubbles for the units from `start` on (what chat.js counts for the "new" marker). */
  function flatFrom(proj, start) {
    const out = [];
    for (const unit of proj.units.slice(start || 0)) {
      if (unit.prompt) out.push(unit.prompt);
      for (const b of unit.body || []) if (b.row) out.push(b.row);
    }
    if (proj.tail) out.push(proj.tail);
    return out;
  }
  function earlierButton(hidden, reveal, onClick) {
    const b = make('button', 'show-earlier', 'Show earlier prompts (' + hidden + ' more)');
    b.type = 'button';
    b.title = 'Show ' + reveal + ' earlier prompts';
    b.addEventListener('click', onClick);
    return b;
  }

  /* ---- scroll anchor across a view change: the topmost visible group, found by its prompt ---- */
  function anchorOf(box) {
    const top = box.getBoundingClientRect().top;
    let owner = null;
    for (const el of box.children) {
      if (el.dataset && el.dataset.pk) owner = el;
      const r = el.getBoundingClientRect();
      if (r.bottom > top + 1) {
        if (!owner) return null;
        return { pk: owner.dataset.pk, off: owner === el ? r.top - top : 0 };
      }
    }
    return null;
  }
  function restoreAnchor(box, anchor) {
    if (!anchor) return false;
    const top = box.getBoundingClientRect().top;
    for (const el of box.children)
      if (el.dataset && el.dataset.pk === anchor.pk) {
        box.scrollTop += el.getBoundingClientRect().top - top - anchor.off;
        return true;
      }
    return false;
  }

  root.ChatViewsUI = {
    mount,
    sync,
    listNodes,
    unitNodes,
    flatFrom,
    earlierButton,
    anchorOf,
    restoreAnchor,
    isOpen,
    OPEN,
    POPEN,
    liveLine,
    refreshLive,
    tickLive,
    promptNodes,
    openPrompt,
    mountFind,
    syncFind,
  };
  if (typeof module === 'object' && module.exports) module.exports = root.ChatViewsUI;
})(typeof window !== 'undefined' ? window : globalThis);
