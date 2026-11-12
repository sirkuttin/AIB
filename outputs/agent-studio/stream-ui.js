'use strict';
/* Message stream helpers: turn-end divider, collapsed cards for injected "user" text (subagent hand-backs, system
   notes) and row windowing. Pure functions first (tested in node), small DOM builders after.
   Only well-known wrappers are recognised and only when the whole message is wrapper; anything else is left as typed. */
(function (root) {
  const WINDOW_ROWS = 150,
    WINDOW_CHUNK = 100;

  /* ---- Row windowing: render only the newest WINDOW_ROWS rows; `extra` grows by a chunk per "Show earlier" click. ---- */
  function windowRows(total, extra, base, chunk) {
    base = base || WINDOW_ROWS;
    chunk = chunk || WINDOW_CHUNK;
    total = Math.max(0, Number(total) || 0);
    extra = Math.max(0, Number(extra) || 0);
    const start = Math.max(0, total - (base + extra));
    return { start, hidden: start, reveal: Math.min(chunk, start), nextExtra: extra + Math.min(chunk, start) };
  }

  /* ---- Side-pane (split view mirror) window: same windowing, plus freezing, older-page and reset rules. ---- */
  const MIRROR_BASE = 80,
    MIRROR_CHUNK = 80;
  /* Not at bottom: the window start never slides forward under the reader (extra grows to compensate); at bottom it slides. */
  function freezeWindow(total, extra, winStart, atBottom) {
    extra = Math.max(0, Number(extra) || 0);
    let win = windowRows(total, extra, MIRROR_BASE, MIRROR_CHUNK);
    if (!atBottom && Number.isInteger(winStart) && win.start > winStart) {
      extra += win.start - winStart;
      win = windowRows(total, extra, MIRROR_BASE, MIRROR_CHUNK);
    }
    return { extra, win };
  }
  /* The drawing window already reaches the first loaded row, saved history has more, and no load is running. */
  function needOlderPage(winStart, histStart, loading) {
    return !loading && Number(winStart) === 0 && Number(histStart) > 0;
  }
  /* After a draw: keep growing while the box does not overflow and older rows exist (drawn or loadable). */
  function needFill(overflows, winStart, histStart, loading) {
    return !overflows && (Number(winStart) > 0 || needOlderPage(0, histStart, loading));
  }
  /* Restart stuck to bottom when the rows are no longer the same history: shrink, Thinking toggle, other history window,
    history window start moved forward (evicted), other chat, and another chat view (Full, Chat, Prompts: the rows drawn differ).
     prev/cur: {total, thinking, hist, histStart, key, view}. */
  function mirrorShouldReset(prev, cur) {
    if (!prev) return true;
    return (
      cur.total < prev.total ||
      cur.thinking !== prev.thinking ||
      cur.view !== prev.view ||
      cur.hist !== prev.hist ||
      cur.key !== prev.key ||
      cur.histStart > prev.histStart
    );
  }

  /* ---- Turn end ---- */
  function shortTime(t) {
    if (t === undefined || t === null || t === '') return '';
    const d = new Date(typeof t === 'number' ? (t < 1e12 ? t * 1000 : t) : t);
    return isNaN(d) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  /* end_turn (or no reason) is just "turn finished"; anything else says why. */
  function turnEndText(reason, time) {
    const r = String(reason || '').trim(),
      when = shortTime(time);
    const head =
      !r || r === 'end_turn' || r === 'Complete' ? 'turn finished' : r === 'cancelled' ? 'cancelled' : 'stopped: ' + r;
    return head + (when ? ' · ' + when : '');
  }

  /* ---- Injected user text ---- */
  const HANDBACK = /^\s*\[Subagent hand-back\]/i;
  // The paragraph Claude Code appends after a relayed message (agent-message: 'That "other Claude session" is an agent…',
  // cross-session-message: 'This came from another Claude session…').
  const TRAILER = /^(?:That\s+[“"']?other Claude session|This came from another Claude session)/i;
  /* Whole user turns the harness writes in plain text (no wrapper tag at the start). Only these exact lead-ins count: a prompt
     that quotes one further down stays a prompt. Kept in step with prompts.ts / prompts.py (wholeWrapper). */
  const SELF_CLOSED = /^(?:<[a-z][\w-]*\s*\/>\s*)+/i;
  const COMPACTED =
    /^(?:<[a-z][\w-]*\s*\/>\s*)*(?:The summarized conversation included Artifact content written by people other than you\b[^\n]*\s*)?This session is being continued from a previous conversation\b/i;
  const SYSTEM_NOTICE = /^\[SYSTEM NOTIFICATION - NOT USER INPUT\]/;
  const HANDBACK_NUDGE = /^\[handback-send-enforce\]/;
  const SKILL_LOAD = /^Base directory for this skill:/i;
  /* The Changes tab's Merge button sends this exact message (merge_request.ts mergeRequestText): a "Merge requested" chip. */
  const MERGE_REQUEST =
    /^Merge this chat's work into (\S+) with AIB's merge tool \(merge_into_project\)\. If \1 has moved and there are conflicts, resolve them in this worktree and call it again\. Then say in one line what landed\.$/;
  const COORDINATOR =
    /^The coordinator sent a message while you were working:\s*([\s\S]*?)\s*Address this before completing your current task\.$/i;
  const attr = (attrs, name) => {
    const m = new RegExp('\\b' + name + '\\s*=\\s*"([^"]*)"', 'i').exec(attrs || '');
    return m ? m[1] : '';
  };
  const unindent = (lines) => lines.map((l) => (l.startsWith('  ') ? l.slice(2) : l));
  function stripHandback(body) {
    const marker = /The report follows:\s*\r?\n?/i.exec(body);
    let rest;
    if (marker) rest = body.slice(marker.index + marker[0].length);
    else {
      const para = body.search(/\r?\n\s*\r?\n/);
      rest = para < 0 ? '' : body.slice(para);
    }
    return unindent(rest.replace(/^\r?\n/, '').split(/\r?\n/))
      .join('\n')
      .trim();
  }
  function taskNotice(inner) {
    const field = (tag) => {
      const m = new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>', 'i').exec(inner);
      return m ? m[1].trim() : '';
    };
    const summary = field('summary'),
      status = field('status'),
      result = field('result'),
      file = field('output-file');
    const body = [
      summary && '**' + summary + '**',
      status && 'Status: ' + status,
      result,
      file && 'Output: `' + file + '`',
    ]
      .filter(Boolean)
      .join('\n\n');
    return { summary, body: body || inner.trim() };
  }
  /* Returns null for anything that is not entirely a known wrapper, else {kind, from, summary, body}.
     kind: 'subagent' (hand-back), 'agent' (other agent/teammate message), 'system'. */
  /* Display only: the desktop app injects <artifact-view-context ...>{json}</artifact-view-context> into user turns.
     Complete blocks and the whitespace around them are dropped; the agent still receives the original text. */
  function stripViewContext(text) {
    if (typeof text !== 'string' || !/<artifact-view-context\b/i.test(text)) return text;
    return text.replace(/\s*<artifact-view-context\b[^>]*>[\s\S]*?<\/artifact-view-context\s*>\s*/gi, ' ').trim();
  }
  function classifyUser(text) {
    if (typeof text !== 'string') return null;
    const s = text.trim();
    if (!s || s.length > 500000) return null;
    const whole = wholeNote(s);
    if (whole) return whole;
    if (INJECTED_START.test(s)) {
      const p = peelInjected(s);
      if (p.blocks.length && !p.rest) return injectedNote(p.blocks);
    }
    return null;
  }
  /* classifyUser without the "only injected blocks" case: `s` (trimmed) is one known wrapper or harness text as a whole. */
  function wholeNote(s) {
    let m =
      /^(?:Another Claude session sent a message:\s*)?<(agent-message|cross-session-message)\b([^>]*)>([\s\S]*?)<\/\1>\s*([\s\S]*)$/i.exec(
        s,
      );
    if (m && (!m[4].trim() || TRAILER.test(m[4].trim()))) {
      const inner = m[3],
        hand = HANDBACK.test(inner),
        name = attr(m[2], 'from-name');
      return {
        kind: hand ? 'subagent' : 'agent',
        from: attr(m[2], 'from'),
        ...(name && !hand ? { fromName: name } : {}),
        body: hand ? stripHandback(inner) : inner.trim(),
      };
    }
    m = COORDINATOR.exec(s);
    if (m) return { kind: 'agent', from: '', fromName: 'coordinator', body: m[1].trim() };
    if (MERGE_REQUEST.test(s)) return { kind: 'merge', from: '', summary: 'Merge requested', body: s };
    if (COMPACTED.test(s))
      return { kind: 'system', from: '', summary: 'Conversation summary', body: s.replace(SELF_CLOSED, '') };
    if (SKILL_LOAD.test(s)) return { kind: 'system', from: '', summary: 'Skill instructions', body: s };
    if (HANDBACK_NUDGE.test(s)) return { kind: 'system', from: '', summary: 'Hand-back reminder', body: s };
    if (SYSTEM_NOTICE.test(s)) {
      const parts = [],
        each = /<task-notification\b[^>]*>([\s\S]*?)<\/task-notification>/gi;
      let one;
      while ((one = each.exec(s))) parts.push(taskNotice(one[1]));
      if (!parts.length) return { kind: 'system', from: '', summary: 'System notification', body: s };
      return {
        kind: 'system',
        from: '',
        summary: parts.length === 1 ? parts[0].summary || 'Background task' : parts.length + ' background tasks',
        body: parts.map((p) => p.body).join('\n\n---\n\n'),
      };
    }
    m = /^<teammate-message\b([^>]*)>([\s\S]*?)<\/teammate-message>$/i.exec(s);
    if (m) return { kind: 'agent', from: attr(m[1], 'teammate_id') || attr(m[1], 'from'), body: m[2].trim() };
    if (HANDBACK.test(s) && /The report follows:/i.test(s))
      return { kind: 'subagent', from: '', body: stripHandback(s) };
    const note = /<task-notification\b[^>]*>([\s\S]*?)<\/task-notification>/gi;
    if (!s.replace(note, '').trim() && /^<task-notification\b/i.test(s)) {
      const parts = [];
      let one;
      while ((one = note.exec(s))) parts.push(taskNotice(one[1]));
      return {
        kind: 'system',
        from: '',
        summary: parts.length === 1 ? parts[0].summary : parts.length + ' background tasks',
        body: parts.map((p) => p.body).join('\n\n---\n\n'),
      };
    }
    return null;
  }
  /* Wrapper blocks the agent's harness injects into a user turn (Claude Code's reminders, linked-session events, hook output,
     IDE context). A turn made only of these is a System note; a turn that also has the person's words shows those words as the
     message and the blocks as a collapsed note. Kept in step with prompts.ts / prompts.py (INJECTED_TAGS, peel). */
  const INJECTED_TAGS =
    'system-reminder|side-sessions-event|user-prompt-submit-hook|hook-output|session-start-hook|post-tool-use-hook|' +
    'pre-tool-use-hook|stop-hook|ide_opened_file|ide_selection|ide_diagnostics|environment_details|system_instruction|' +
    'cross-session-message|local-command-caveat|local-command-stdout|local-command-stderr|fork-boilerplate';
  const INJECTED_START = new RegExp('^<(?:' + INJECTED_TAGS + ')(?![\\w-])', 'i');
  // A body never contains its own closing tag, so a match cannot run across the person's words into a later block.
  const BLOCK = '<(' + INJECTED_TAGS + ')(?![\\w-])[^>]*>((?:(?!</\\1\\s*>)[\\s\\S])*)</\\1\\s*>';
  const INJECTED_LEAD = new RegExp('^\\s*' + BLOCK, 'i');
  const INJECTED_TAIL = new RegExp(BLOCK + '\\s*$', 'i');
  /* Leading and trailing injected blocks off `text`: {rest (trimmed), blocks: [{tag, body}] in order}. Blocks between the
     person's words stay where they are (that is text they wrote or pasted). */
  function peelInjected(text) {
    let s = text,
      m;
    const head = [],
      tail = [];
    while ((m = INJECTED_LEAD.exec(s))) {
      head.push({ tag: m[1].toLowerCase(), body: m[2] });
      s = s.slice(m[0].length);
    }
    while ((m = INJECTED_TAIL.exec(s))) {
      tail.unshift({ tag: m[1].toLowerCase(), body: m[2] });
      s = s.slice(0, m.index);
    }
    return { rest: s.trim(), blocks: head.concat(tail) };
  }
  function injectedNote(blocks) {
    const body = blocks
      .map((b) => b.body.trim())
      .filter(Boolean)
      .join('\n\n---\n\n');
    const has = (re) => blocks.some((b) => re.test(b.body));
    const tags = blocks.map((b) => b.tag);
    let summary = '';
    if (tags.includes('side-sessions-event') || has(/\bfinished a turn\. It reported\b/i))
      summary = 'Linked session report';
    else if (has(/^\s*Linked sessions now\b/i)) summary = 'Linked sessions';
    else if (tags.every((t) => /^ide_/.test(t))) summary = 'IDE context';
    else if (tags.every((t) => /hook/.test(t))) summary = 'Hook output';
    else if (tags.every((t) => /^local-command-/.test(t))) summary = 'Command output';
    else if (tags.every((t) => t === 'fork-boilerplate')) summary = 'Fork instructions';
    return { kind: 'system', from: '', ...(summary ? { summary } : {}), body };
  }
  /* A user turn that mixes the person's words with injected blocks: {text: their words (may be '' when only files remain),
     note} or null when there is nothing to split off. */
  function splitInjected(text) {
    // longer text is left whole, as classifyUser leaves it (it is then the person's message)
    if (typeof text !== 'string' || !/<[a-z]/i.test(text) || text.trim().length > 500000) return null;
    // a relayed message or harness text as a whole is one note (classifyUser), not words with blocks peeled off its ends
    if (wholeNote(text.trim())) return null;
    const p = peelInjected(text);
    return p.blocks.length ? { text: p.rest, note: injectedNote(p.blocks) } : null;
  }
  /* The person's words of a user turn, for search and prompt lists: injected blocks at either end dropped. */
  function stripInjected(text) {
    const split = splitInjected(text);
    return split ? split.text : text;
  }
  const shortId = (id) =>
    String(id || '')
      .replace(/^agent-/, '')
      .slice(0, 8);
  /* Card title. resolve(from) may map an agent id to a friendly name. */
  function noteTitle(note, resolve) {
    if (note.kind === 'merge') return 'Merge requested';
    const name = (resolve && note.from && resolve(note.from)) || '';
    if (note.kind === 'subagent')
      return name
        ? 'Report from subagent "' + name + '"'
        : note.from
          ? 'Report from subagent ' + shortId(note.from)
          : 'Report from subagent';
    if (note.kind === 'agent') {
      const who = name || note.fromName || (note.from && shortId(note.from));
      return who ? 'Message from agent "' + who.replace(/\s+/g, ' ').slice(0, 80) + '"' : 'Message from agent';
    }
    return note.summary ? 'System note · ' + note.summary.replace(/\s+/g, ' ').slice(0, 80) : 'System note';
  }

  /* ---- Change signature: a short string that differs whenever a row would be drawn differently. ----
     Rows are rebuilt on every poll, so each one is summed up by its small fields (a long text by its length and its last few
     characters, which is where streaming appends and edits land) plus `rev`, the count of events folded into the row. A change
     to ANY row, not only the last, changes the signature: a tool call finishing above streaming text, a plan step ticking over. */
  const SIG_TEXT = 200;
  const stampScalar = (v) =>
    typeof v === 'string'
      ? v.length <= SIG_TEXT
        ? v
        : v.length + ':' + v.slice(-24)
      : v == null || typeof v === 'number' || typeof v === 'boolean'
        ? String(v)
        : '';
  const stampObject = (o) => {
    let s = '';
    for (const k in o) s += k + '=' + stampScalar(o[k]) + ';';
    return s;
  };
  function rowStamp(row) {
    let s = '';
    for (const k in row) {
      const v = row[k];
      if (v && typeof v === 'object')
        s +=
          k +
          '[' +
          (Array.isArray(v)
            ? v.map((x) => (x && typeof x === 'object' ? stampObject(x) : stampScalar(x))).join('|')
            : stampObject(v)) +
          ']';
      else s += k + '=' + stampScalar(v) + ';';
    }
    return s;
  }
  function rowsSignature(rows) {
    return rows.length + '#' + rows.map(rowStamp).join('\n');
  }

  /* ---- Screen-reader announcements: only agent messages that are finished (something came after them), and each one once. ----
     `lastKey` is the key of the newest finished message announced before. Returns {announce: [rows], key}. With no `lastKey`
     (null: first paint, another chat) or when that message is gone, the call only sets the baseline and announces nothing. */
  const turnKey = (r) => [r.time, (r.value || '').length, (r.value || '').slice(0, 40)].join('|');
  function newTurns(rows, lastKey) {
    const done = [];
    rows.forEach((r, i) => {
      if (r.role === 'assistant' && r.value && i < rows.length - 1) done.push(r);
    });
    const key = done.length ? turnKey(done[done.length - 1]) : '';
    if (lastKey == null) return { announce: [], key };
    const at = lastKey === '' ? -1 : done.findIndex((r) => turnKey(r) === lastKey);
    if (lastKey !== '' && at < 0) return { announce: [], key };
    return { announce: done.slice(at + 1), key };
  }

  /* ---- DOM ---- */
  const doc = () => root.document || globalThis.document;
  const make = (tag, cls, value) => {
    const n = doc().createElement(tag);
    if (cls) n.className = cls;
    if (value !== undefined) n.textContent = value;
    return n;
  };
  const OPEN = new Set(); // cards the user expanded; rows are rebuilt on every update
  const cardKey = (note, row) =>
    [note.kind, note.from, row && row.time, (note.body || '').length, (note.body || '').slice(0, 40)].join('|');

  function divider(row) {
    const box = make('div', 'turn-divider');
    box.setAttribute('role', 'separator');
    box.append(make('span', 'turn-divider-text', turnEndText(row.value, row.time)));
    return box;
  }
  function noteCard(note, row, resolve) {
    const key = cardKey(note, row),
      card = make('article', 'msg-note msg-note-' + note.kind);
    const btn = make('button', 'msg-note-toggle');
    btn.type = 'button';
    const caret = make('span', 'msg-note-caret', '▸');
    btn.append(
      caret,
      make('span', 'msg-note-title', noteTitle(note, resolve)),
      make('time', '', shortTime(row && row.time)),
    );
    const body = make('div', 'msg-note-body markdown');
    const sync = () => {
      const open = OPEN.has(key);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      caret.textContent = open ? '▾' : '▸';
      body.hidden = !open;
      card.className = 'msg-note msg-note-' + note.kind + (open ? ' open' : '');
      if (open && !body.childNodes.length) {
        if (root.AgentMarkdown) root.AgentMarkdown.render(body, note.body);
        else body.append(make('pre', '', note.body));
        if (root.CopyUI && root.CopyUI.decorateCode) root.CopyUI.decorateCode(body);
      }
    };
    btn.addEventListener('click', () => {
      if (OPEN.has(key)) OPEN.delete(key);
      else OPEN.add(key);
      sync();
    });
    card.append(btn, body);
    sync();
    return card;
  }
  /* ---- Redraw by difference: put the fragment's rows into the list, keeping each row already there that would be drawn the
     same (its markup when it was built matches the new one's). A kept row is not touched, so the browser does not style and lay
     out the whole window again on every update (a chat streaming into a long history spent ~40 ms a poll on that), and what
     the reader did to it stays: a step opened, a long block shown in full, text selected.
     Top-level buttons ("Show earlier") are always replaced: their click handlers hold the rows of the draw that made them.
     Returns the number of rows kept. */
  const printOf = (n) => (n.nodeType === 1 ? n.outerHTML : '#' + n.nodeType + ':' + n.textContent);
  function patchChildren(box, fragment) {
    const fresh = Array.from(fragment.childNodes || []);
    if (!box.childNodes || fresh.some((n) => !(n.nodeType === 3 || (n.nodeType === 1 && typeof n.outerHTML === 'string')))) {
      box.replaceChildren(fragment); // a page without markup to compare (the test pages): draw it all
      return 0;
    }
    const spare = new Map(); // print -> old rows with that print, in order
    for (const old of Array.from(box.childNodes)) {
      if (old._drawPrint == null || old.nodeName === 'BUTTON') continue;
      const list = spare.get(old._drawPrint);
      if (list) list.push(old);
      else spare.set(old._drawPrint, [old]);
    }
    let kept = 0;
    const want = fresh.map((n) => {
      const print = printOf(n);
      const list = spare.get(print);
      if (list && list.length) {
        kept++;
        return list.shift();
      }
      n._drawPrint = print;
      return n;
    });
    const keep = new Set(want);
    for (const old of Array.from(box.childNodes)) if (!keep.has(old)) old.remove();
    for (let i = 0; i < want.length; i++) {
      const at = box.childNodes[i] || null;
      if (at !== want[i]) box.insertBefore(want[i], at);
    }
    return kept;
  }

  function earlierButton(hidden, reveal, onClick) {
    const b = make('button', 'show-earlier', 'Show earlier messages (' + hidden + ' more)');
    b.type = 'button';
    b.title = 'Show ' + reveal + ' earlier messages';
    b.addEventListener('click', onClick);
    return b;
  }

  const api = {
    windowRows,
    freezeWindow,
    needOlderPage,
    needFill,
    mirrorShouldReset,
    MIRROR_BASE,
    MIRROR_CHUNK,
    turnEndText,
    shortTime,
    classifyUser,
    splitInjected,
    stripInjected,
    stripViewContext,
    noteTitle,
    rowsSignature,
    newTurns,
    divider,
    noteCard,
    earlierButton,
    patchChildren,
    WINDOW_ROWS,
    WINDOW_CHUNK,
  };
  root.StreamUI = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
