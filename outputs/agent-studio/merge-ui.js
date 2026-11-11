'use strict';
/* Worktree per chat, stage E: the "Merge into <base>" button (it asks the chat's agent to merge) in the footer row of the Changes tab (next to Discard). Only a chat that runs in its own
   worktree has it (GET /api/live/worktree says so); every other chat sees nothing. changes-ui.js calls mount() once and update()
   whenever its data or the chat's busy state changes. The server decides what is allowed; this file only shows it. */
(function (root) {
  /* The footer's content from the server status: {show, enabled, label, line, title}. Pure.
     The button no longer merges by itself: it asks the chat's agent to merge (a "Merge requested" message, queued while it works),
     so a busy chat is no reason to wait. ctx.blocked (closed, archived, read only, open in another app; chat.js says which) keeps it
     disabled with that reason, and nothing is sent. */
  function plan(status, ctx) {
    const s = status || {},
      c = ctx || {};
    const hidden = { show: false, enabled: false, label: '', line: '', title: '' };
    if (!(s.worktree || c.worktree) || !c.branchView) return hidden;
    const label = s.label || 'Merge into ' + (s.base || c.base || 'main');
    if (c.blocked) {
      if (!c.files) return Object.assign({}, hidden, { label });
      return { show: true, enabled: false, label, line: c.blocked, title: c.blocked };
    }
    if (!s.worktree) return Object.assign({}, hidden, { label });
    if (c.merging) return { show: true, enabled: false, label, line: 'Asking the chat to merge…', title: '' };
    if (s.state === 'conflicts') return { show: true, enabled: false, label, line: s.message || '', title: s.message || '' };
    if (!c.files && s.state === 'nochanges') return Object.assign({}, hidden, { label });
    if (!c.files && !s.enabled) return Object.assign({}, hidden, { label });
    return {
      show: true,
      enabled: !!s.enabled,
      label,
      line: s.message || '',
      title: s.enabled ? 'Ask this chat to merge its work into ' + (s.base || 'main') : s.message || '',
    };
  }

  function init(opts) {
    const win = opts.win,
      doc = win.document;
    const line = opts.line,
      button = opts.button; // made by changes-ui.js footer(): the status line and the button of the one footer row
    line.setAttribute && line.setAttribute('role', 'status');
    let token = '',
      status = null,
      ctx = { id: '', busy: false, files: 0, branchView: false, worktree: false, blocked: '' },
      merging = false,
      sig = '',
      seq = 0,
      result = '';
    async function call(method, path, body) {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (!token || attempt) {
          const r = await win.fetch('/api/live/bootstrap');
          token = (await r.json()).token || '';
        }
        const r = await win.fetch(path, {
          method,
          headers: Object.assign({ 'X-Studio-Token': token }, body ? { 'Content-Type': 'application/json' } : {}),
          body: body ? JSON.stringify(body) : undefined,
        });
        if (r.status === 403 && !attempt) continue;
        let data = {};
        try {
          data = await r.json();
        } catch (e) {}
        return { ok: r.ok, status: r.status, data };
      }
      return { ok: false, status: 0, data: {} };
    }
    function paint() {
      const p = plan(status, Object.assign({ merging }, ctx));
      button.hidden = !p.show;
      button.textContent = p.label;
      button.disabled = !p.enabled;
      button.title = p.title || '';
      line.textContent = (p.enabled || !p.line ? result : '') || p.line;
      line.hidden = !line.textContent;
      if (opts.onPaint) opts.onPaint();
    }
    async function refresh() {
      const mine = ++seq,
        id = ctx.id;
      if (!id || !ctx.branchView) {
        status = null;
        paint();
        return;
      }
      try {
        const r = await call('GET', '/api/live/worktree?id=' + encodeURIComponent(id));
        if (mine !== seq) return;
        status = r.ok ? r.data : null;
      } catch (e) {
        if (mine !== seq) return;
        status = null;
      }
      paint();
    }
    button.addEventListener('click', async () => {
      /* No confirmation: one click asks the chat (the permission is tied to the chat's work at this click). */
      if (merging || button.disabled) return;
      merging = true;
      result = '';
      paint();
      try {
        /* The server records a one-shot merge permission and sends the chat the fixed merge message (a "Merge requested" chip). */
        const r = await call('POST', '/api/live/worktree/merge-request', { id: ctx.id });
        result = r.ok ? r.data.message || 'Merge requested' : r.data.error || 'Could not ask the chat to merge';
      } catch (e) {
        result = 'Could not ask the chat to merge: ' + e.message;
      }
      merging = false;
      if (opts.reload) opts.reload();
      await refresh();
      paint();
    });
    return {
      /* Files the server names as conflicted (unresolved merge or clash), for the badge on their rows. */
      conflicts: () => (status && status.state === 'conflicts' && Array.isArray(status.files) ? status.files : []),
      update(next) {
        const n = Object.assign({}, ctx, next || {});
        const s = [n.id, n.busy, n.files, n.branchView, n.worktree, n.blocked].join('|');
        const changed = s !== sig;
        sig = s;
        if (n.id !== ctx.id) result = '';
        ctx = n;
        if (changed) refresh();
        else paint();
      },
    };
  }

  const api = { plan, init };
  root.AgentMergeUI = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
