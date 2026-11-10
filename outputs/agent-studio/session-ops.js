(function (root) {
  'use strict';
  // Header status strip (usage, session title, notices, compaction), session operations in the
  // ••• menu, and wiring of slash-command completion. All agent-supplied text uses textContent.
  const doc = () => root.document;
  const $ = (id) => doc().getElementById(id);
  const el = (tag, text, cls) => {
    const n = doc().createElement(tag);
    if (text != null) n.textContent = String(text);
    if (cls) n.className = cls;
    return n;
  };
  const num = (n) => Number(n).toLocaleString('en-US');

  function formatUsage(usage) {
    // Only values the agent reported; nothing is estimated.
    if (!usage) return [];
    const parts = [];
    if (usage.used != null && usage.size)
      parts.push(
        'Context ' +
          num(usage.used) +
          ' / ' +
          num(usage.size) +
          ' tokens (' +
          Math.round((usage.used / usage.size) * 100) +
          '%)',
      );
    else if (usage.used != null) parts.push('Context ' + num(usage.used) + ' tokens');
    else if (usage.size != null) parts.push('Context window ' + num(usage.size) + ' tokens');
    if (usage.cost) parts.push('Cost ' + usage.cost.amount + ' ' + usage.cost.currency);
    return parts;
  }

  const COMPACTION_LABEL = {
    in_progress: 'Compacting context…',
    completed: 'Context compacted',
    failed: 'Compaction failed',
    cancelled: 'Compaction cancelled',
    other: 'Compaction update',
  };

  function stripSummary(b) {
    const out = { title: '', updated: '', usage: formatUsage(b && b.usage), compaction: [], notices: [] };
    if (!b) return out;
    const info = b.sessionInfo || {};
    out.title = info.title || '';
    out.updated = info.updatedAt || '';
    out.compaction = (b.compaction || []).slice(-3);
    out.notices = (b.notices || []).slice(-3);
    return out;
  }

  function localTime(iso) {
    const t = Date.parse(iso);
    return Number.isNaN(t) ? iso : new Date(t).toLocaleString();
  }

  let ctx = null,
    controller = null,
    stripSig = '',
    opsSig = '',
    dialog = null,
    dismissed = new Set();

  function renderStrip(b) {
    const strip = $('sessionStrip');
    if (!strip) return;
    const s = stripSummary(b);
    const visibleNotices = s.notices.filter((n) => !dismissed.has(n.id));
    const sig = JSON.stringify([s.title, s.updated, s.usage, s.compaction, visibleNotices]);
    if (sig === stripSig) return;
    stripSig = sig;
    strip.replaceChildren();
    if (s.title) strip.appendChild(el('span', 'Session: ' + s.title, 'strip-item strip-title'));
    if (s.updated) strip.appendChild(el('span', 'Updated ' + localTime(s.updated), 'strip-item'));
    for (const text of s.usage) strip.appendChild(el('span', text, 'strip-item'));
    for (const c of s.compaction) {
      const item = el(
        'span',
        COMPACTION_LABEL[c.status] || COMPACTION_LABEL.other,
        'strip-item strip-compaction status-' + c.status,
      );
      if (c.error) item.title = c.error;
      strip.appendChild(item);
      if (c.summary) {
        const details = el('details', null, 'strip-item');
        details.appendChild(el('summary', 'Compaction summary'));
        details.appendChild(el('pre', c.summary, 'strip-summary'));
        strip.appendChild(details);
      }
    }
    for (const n of visibleNotices) {
      const item = el('span', null, 'strip-item strip-notice severity-' + String(n.severity).replace(/[^a-z_-]/gi, ''));
      item.appendChild(el('strong', n.title));
      if (n.description) item.appendChild(el('span', ' — ' + n.description));
      const close = el('button', '×', 'strip-dismiss');
      close.type = 'button';
      close.title = 'Dismiss notice';
      close.setAttribute('aria-label', 'Dismiss notice');
      close.addEventListener('click', () => {
        dismissed.add(n.id);
        stripSig = '';
        renderStrip(lastBreadth);
      });
      item.appendChild(close);
      strip.appendChild(item);
    }
    strip.hidden = !strip.children.length;
  }

  function ensureDialog() {
    if (dialog) return dialog;
    dialog = el('dialog', null, 'session-op-dialog');
    dialog.id = 'sessionOpDialog';
    doc().body.appendChild(dialog);
    return dialog;
  }

  function openConfirm(op, snapshot) {
    const d = ensureDialog();
    d.replaceChildren();
    const delta =
      op === 'delete'
        ? {
            title: 'Delete this session?',
            text: 'This asks the agent to permanently delete the session and its saved history. It cannot be undone from AIB. AIB will disconnect.',
            action: 'Delete session',
          }
        : {
            title: 'Close this session on the agent?',
            text: 'This tells the agent to release the session. AIB will disconnect; you can continue it later if the agent keeps its history.',
            action: 'Close session',
          };
    d.appendChild(el('h2', delta.title));
    d.appendChild(el('p', delta.text, 'note'));
    d.appendChild(el('p', 'Session ID: ' + snapshot.sessionId, 'note'));
    const row = el('div', null, 'rename-actions'),
      cancel = el('button', 'Cancel'),
      go = el('button', delta.action, 'primary danger');
    cancel.type = go.type = 'button';
    cancel.addEventListener('click', () => d.close());
    go.addEventListener('click', async () => {
      go.disabled = true;
      try {
        await ctx.post('session-op', { id: snapshot.id, op, confirm: op + ':' + snapshot.sessionId });
        d.close();
        await ctx.afterEnd();
      } catch (e) {
        d.close();
        ctx.fail(e);
      }
    });
    row.append(cancel, go);
    d.appendChild(row);
    d.showModal();
  }

  async function openList(snapshot, cursor, list) {
    const d = ensureDialog();
    if (!list) {
      d.replaceChildren();
      d.appendChild(el('h2', 'Agent sessions'));
      list = el('div', null, 'session-list');
      d.appendChild(list);
      d.appendChild(el('p', 'Read-only list reported by the agent. Open a conversation from the sidebar.', 'note'));
      const close = el('button', 'Close');
      close.type = 'button';
      close.addEventListener('click', () => d.close());
      d.appendChild(close);
      d.showModal();
    }
    try {
      const result = await ctx.post(
        'session-op',
        Object.assign({ id: snapshot.id, op: 'list' }, cursor ? { cursor } : {}),
      );
      for (const s of result.sessions || []) {
        const row = el('div', null, 'session-row');
        row.appendChild(el('strong', s.title || '(untitled)'));
        row.appendChild(
          el('small', [s.cwd, s.updatedAt && localTime(s.updatedAt), s.sessionId].filter(Boolean).join(' · ')),
        );
        list.appendChild(row);
      }
      list.querySelectorAll('.more').forEach((n) => n.remove());
      if (!list.children.length) list.appendChild(el('p', 'The agent reported no sessions.', 'note'));
      if (result.nextCursor) {
        const more = el('button', 'Load more', 'more');
        more.type = 'button';
        more.addEventListener('click', () => openList(snapshot, result.nextCursor, list));
        list.appendChild(more);
      }
    } catch (e) {
      d.close();
      ctx.fail(e);
    }
  }

  const OP_LABEL = { list: 'List agent sessions…', close: 'Close session on agent…' }; // no permanent delete in the UI; the server route stays

  function renderOps(snapshot, b) {
    const box = $('sessionOps');
    if (!box) return;
    const ops = snapshot && b && !snapshot.closed && snapshot.ready ? b.ops || [] : [];
    const sig = JSON.stringify([ops, snapshot && snapshot.id, snapshot && snapshot.busy]);
    if (sig === opsSig) return;
    opsSig = sig;
    box.replaceChildren();
    for (const op of ops) {
      if (!OP_LABEL[op]) continue;
      const button = el('button', OP_LABEL[op]);
      button.type = 'button';
      button.disabled = op !== 'list' && !!snapshot.busy;
      button.title = button.disabled ? 'Wait for the current turn to finish' : '';
      button.addEventListener('click', () => {
        const menu = $('connectionMenu');
        if (menu) menu.open = false;
        if (op === 'list') openList(snapshot);
        else openConfirm(op, snapshot);
      });
      box.appendChild(button);
    }
  }

  let lastBreadth = null;

  function ensureController() {
    if (controller || !$('prompt') || !$('promptForm')) return controller;
    const form = $('promptForm'),
      popup = el('div', null, 'slash-popup'),
      hint = el('div', null, 'slash-hint');
    popup.id = 'slashPopup';
    popup.setAttribute('role', 'listbox');
    popup.hidden = true;
    hint.hidden = true;
    hint.id = 'slashHint';
    form.parentNode.insertBefore(popup, form);
    form.insertBefore(hint, $('prompt'));
    const prompt = $('prompt');
    prompt.setAttribute('aria-controls', 'slashPopup');
    prompt.setAttribute('aria-autocomplete', 'list');
    controller = root.AgentSlashCommands.createController({
      textarea: prompt,
      popup,
      hintBox: hint,
      document: doc(),
      onChange: () => prompt.dispatchEvent(new root.Event('input', { bubbles: true })),
    });
    prompt.addEventListener('input', () => controller.refresh());
    return controller;
  }

  function sync(snapshot, context) {
    ctx = context || ctx;
    const b = (snapshot && snapshot.breadth) || null;
    if (b !== lastBreadth) {
      lastBreadth = b;
    }
    renderStrip(b);
    renderOps(snapshot, b);
    if (root.AgentSlashCommands && ensureController())
      controller.setCommands(snapshot && !snapshot.closed && b ? b.commands : []);
  }

  const api = { formatUsage, stripSummary, sync, handleKey: (e) => !!(controller && controller.handleKey(e)) };
  root.AgentBreadth = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
