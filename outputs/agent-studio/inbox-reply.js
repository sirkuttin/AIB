(function (root) {
  'use strict';
  // Quick reply from the inbox: the pure parts. What a row offers (reply box, approval buttons, choice buttons, or only
  // "Open chat"), how its context text is clamped, and the keyboard state machine. No DOM here; workspace-ui.js draws.
  const isStr = (v) => typeof v === 'string';
  const MAX_CONTEXT = 1200; // characters of the agent's last message kept per row
  const CLAMP_LINES = 3;
  const PER_LINE = 50; // about how many characters of the 11px row text fit on one line of the popover

  // ---- context text --------------------------------------------------------------------------------------
  // The agent's last message (or its question) as one tidy block: blank lines squeezed, length capped.
  function contextText(text) {
    const t = String(text == null ? '' : text)
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return t.length > MAX_CONTEXT ? t.slice(0, MAX_CONTEXT - 1).trimEnd() + '…' : t;
  }
  // How many lines the text takes when wrapped at `perLine` characters (hard newlines count).
  function estimateLines(text, perLine) {
    const per = Math.max(10, Number(perLine) || PER_LINE);
    return String(text || '')
      .split('\n')
      .reduce((n, line) => n + Math.max(1, Math.ceil(line.length / per)), 0);
  }
  // Does the text need a "more" control when clamped to `lines` lines?
  const isLong = (text, lines, perLine) => estimateLines(text, perLine) > (lines || CLAMP_LINES);

  // ---- choices: a multiple-choice elicitation as buttons -------------------------------------------------
  // One form field with a fixed list of answers (enum / oneOf strings) is a choice. Anything else (free text, several
  // fields, numbers, checkboxes, links) is complex: the row says "Open chat".
  function choiceOf(req) {
    const p = req && req.params;
    if (!p || p.mode !== 'form' || req.key == null) return null;
    const s = p.requestedSchema;
    if (!s || s.type !== 'object' || !s.properties || typeof s.properties !== 'object' || Array.isArray(s.properties))
      return null;
    const names = Object.keys(s.properties);
    if (names.length !== 1) return null;
    const f = s.properties[names[0]];
    if (!f || f.type !== 'string') return null;
    let options = null;
    if (Array.isArray(f.oneOf))
      options = f.oneOf.map((x) =>
        x && x.const !== undefined ? { value: x.const, label: String(x.title || x.const) } : null,
      );
    else if (Array.isArray(f.enum)) options = f.enum.map((x) => ({ value: x, label: String(x) }));
    if (!options || !options.length || options.length > 8 || options.some((o) => !o || !isStr(o.value))) return null;
    return { key: String(req.key), field: names[0], message: isStr(p.message) ? p.message : '', options };
  }

  // ---- what a row offers ---------------------------------------------------------------------------------
  // row: an inbox row from workspace-state.inbox(). detail: {elicitations: [{key, params}], permissions: [{key, params}]}
  // (permissions are fetched per chat; null/absent while loading). Returns the set of actions:
  //   reply:   a typed reply (only for "your turn" rows: a blocked agent cannot take a new message)
  //   buttons: one-click answers [{id, label, tone, op: "permission"|"elicitation", reqKey, optionId|value|field}]
  //   handled: Mark handled; open: Open chat (always); openOnly: nothing but Open chat can answer this row
  //   loading: approval buttons are still being fetched; more: how many other requests wait behind this one
  function rowActions(row, detail) {
    const out = { reply: false, buttons: [], handled: false, open: true, openOnly: false, loading: false, more: 0 };
    if (!row) return out;
    out.handled = !!row.handled;
    if (row.kind === 'yourTurn') {
      out.reply = true;
      return out;
    }
    const d = detail || {};
    const elics = Array.isArray(d.elicitations) ? d.elicitations : [];
    const perms = Array.isArray(d.permissions) ? d.permissions : null;
    const kinds = (row.kinds || []).map((k) => k.kind);
    if (elics.length) {
      out.more = Math.max(0, elics.length - 1);
      const c = choiceOf(elics[0]);
      if (c)
        out.buttons = c.options.map((o, i) => ({
          id: 'c' + i,
          label: o.label,
          tone: i === 0 ? 'ok' : '',
          op: 'elicitation',
          reqKey: c.key,
          field: c.field,
          value: o.value,
        }));
      else out.openOnly = true;
      return out;
    }
    if (kinds.includes('permission')) {
      if (!perms) {
        out.loading = true;
        return out;
      }
      const first = perms[0],
        options =
          first && first.params && Array.isArray(first.params.options)
            ? first.params.options.filter((o) => o && isStr(o.optionId))
            : [];
      out.more = Math.max(0, perms.length - 1);
      if (!first || !options.length) {
        out.openOnly = true;
        return out;
      }
      out.buttons = options.map((o, i) => ({
        id: 'p' + i,
        label: String(o.name || o.optionId),
        tone: toneOf(o.kind),
        op: 'permission',
        reqKey: String(first.key),
        optionId: o.optionId,
      }));
      return out;
    }
    out.openOnly = true; // sign-in, unknown input: the chat knows how
    return out;
  }
  const toneOf = (kind) =>
    /^allow/.test(String(kind || '')) ? 'ok' : /^reject|deny/.test(String(kind || '')) ? 'no' : '';
  // The body of the request that is waiting, for the row text: what the approval would do, in the words the approval card
  // uses ("Run npm install stripe@18.0.0", "Edit src/cart.ts"; ToolViews.actionOf), else the tool's title.
  function permissionTitle(req) {
    const p = req && req.params,
      tc = p && p.toolCall,
      TV = root.ToolViews;
    if (tc && TV && typeof TV.actionOf === 'function') {
      try {
        const line = String(TV.actionOf(tc).line || '').replace(/\s+/g, ' ').trim();
        if (line) return line;
      } catch {
        /* fall back to the title */
      }
    }
    return String((tc && (tc.title || tc.kind)) || (p && p.title) || '').trim();
  }

  // ---- send route ----------------------------------------------------------------------------------------
  // A reply to a chat whose agent is working (or that already has queued messages, which must go first) joins the queue,
  // exactly like the composer does; an idle chat takes it as a normal prompt. snap: a live state / listing entry.
  function sendRoute(snap) {
    const q = snap && snap.queue,
      waiting = !!(q && Array.isArray(q.items) && q.items.length);
    return snap && (snap.busy || waiting) ? 'queue' : 'prompt';
  }

  // ---- keyboard ------------------------------------------------------------------------------------------
  // A small state machine: state {open, index, replying}; ctx {rows: [{reply, handled}] (the rows in view)}.
  // key: {key, alt, ctrl, meta, shift, typing (focus is in a text box), composing}. Returns {state, effect, index}:
  // effect is one of none | open-inbox | close-inbox | move | start-reply | close-reply | send | mark-handled | open-chat.
  const initial = () => ({ open: false, index: 0, replying: false });
  function clampIndex(i, n) {
    return n > 0 ? Math.max(0, Math.min(n - 1, i | 0)) : 0;
  }
  function step(state, k, ctx) {
    const st = Object.assign(initial(), state),
      rows = (ctx && ctx.rows) || [],
      n = rows.length,
      key = String((k && k.key) || ''),
      low = key.toLowerCase();
    const same = (effect, extra) => Object.assign({ state: st, effect, index: st.index }, extra);
    const next = (patch, effect) => {
      const s = Object.assign({}, st, patch);
      return { state: s, effect, index: s.index };
    };
    if (!k || k.composing) return same('none');
    if (k.alt && !k.ctrl && !k.meta && !k.shift && low === 'i')
      return st.open
        ? next({ open: false, replying: false }, 'close-inbox')
        : next({ open: true, index: 0, replying: false }, 'open-inbox');
    if (!st.open) return same('none');
    if (k.ctrl || k.meta || k.alt) return same('none');
    if (st.replying) {
      if (key === 'Escape') return next({ replying: false }, 'close-reply');
      if (key === 'Enter' && !k.shift) return same('send');
      return same('none'); // everything else is typing
    }
    if (key === 'Escape') return next({ open: false, replying: false }, 'close-inbox');
    if (k.typing) return same('none'); // a text box outside a reply (the notification settings) keeps its keys
    const i = clampIndex(st.index, n),
      row = rows[i];
    if (key === 'ArrowDown' || key === 'ArrowUp')
      return next({ index: clampIndex(i + (key === 'ArrowDown' ? 1 : -1), n) }, 'move');
    if (k.shift) return same('none');
    if (!row) return same('none');
    if (low === 'r') return row.reply ? next({ replying: true, index: i }, 'start-reply') : same('none');
    if (low === 'e') return row.handled ? same('mark-handled', { index: i }) : same('none');
    if (low === 'o') return same('open-chat', { index: i });
    return same('none');
  }

  const api = {
    MAX_CONTEXT,
    CLAMP_LINES,
    PER_LINE,
    contextText,
    estimateLines,
    isLong,
    choiceOf,
    rowActions,
    permissionTitle,
    sendRoute,
    initial,
    step,
    clampIndex,
  };
  root.AgentInboxReply = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
