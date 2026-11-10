'use strict';
/* Worktree per chat, stage E: the "Merge into <base>" button in the footer row of the Changes tab (next to Discard). Only a chat that runs in its own
   worktree has it (GET /api/live/worktree says so); every other chat sees nothing. changes-ui.js calls mount() once and update()
   whenever its data or the chat's busy state changes. The server decides what is allowed; this file only shows it. */
(function (root) {
  /* The footer's content from the server status: {show, enabled, label, line}. Pure. */
  function plan(status, ctx) {
    const s = status || {},
      c = ctx || {};
    if (!s.worktree || !c.branchView) return { show: false, enabled: false, label: '', line: '' };
    const label = s.label || 'Merge into ' + (s.base || 'main');
    if (c.merging) return { show: true, enabled: false, label, line: 'Merging…' };
    if (s.state === 'conflicts') return { show: true, enabled: false, label, line: s.message || '' };
    if (!c.files && s.state === 'nochanges') return { show: false, enabled: false, label, line: '' };
    if (!c.files && !s.enabled) return { show: false, enabled: false, label, line: '' };
    return {
      show: true,
      enabled: !!s.enabled && !c.busy,
      label,
      line: c.busy ? 'Wait for the chat to finish its turn' : s.message || '',
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
      ctx = { id: '', busy: false, files: 0, branchView: false },
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
      line.textContent = result || p.line;
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
      if (merging || button.disabled) return;
      merging = true;
      result = '';
      paint();
      const titleEl = doc.getElementById('title');
      try {
        const r = await call('POST', '/api/live/worktree/merge', {
          id: ctx.id,
          title: titleEl ? titleEl.textContent : '',
        });
        result = r.ok ? (r.data.state === 'merged' ? '' : r.data.message || '') : r.data.error || 'Merge failed';
      } catch (e) {
        result = 'Merge failed: ' + e.message;
      }
      merging = false;
      if (opts.reload) opts.reload();
      await refresh();
      paint();
    });
    return {
      update(next) {
        const n = Object.assign({}, ctx, next || {});
        const s = [n.id, n.busy, n.files, n.branchView].join('|');
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
