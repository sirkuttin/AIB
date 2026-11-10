// Queued messages above the composer: one slim line per message, icon actions on hover/focus, a tiny header line.
// The queue itself (and the rule that editing the next message pauses it) lives in the agent host; this file only draws it and
// holds the edit lease open (renewing it) while an editor is on screen.
(function (root) {
  'use strict';
  const T = {
    edit: 'Edit - pauses the queue while you edit',
    sendNow: 'Send now - interrupts the agent',
    remove: 'Remove from queue',
    resume: 'Resume sending the queued messages',
  };
  const RENEW_MS = 30000;

  // queue: the `queue` object of a connection snapshot.
  function summary(queue, busy) {
    const items = (queue && queue.items) || [];
    const n = items.length;
    if (!n) return { show: false, head: '', note: '', tone: '', resume: false, count: 0 };
    const reason = queue.reason || '';
    if (reason === 'editing')
      return {
        show: true,
        head: 'Paused while you edit',
        note: 'Paused while you edit',
        tone: 'paused',
        resume: false,
        count: n,
      };
    if (reason)
      return {
        show: true,
        head: (queue.message || 'Paused') + ' · ' + n + ' queued',
        note: queue.message || 'Paused',
        tone: 'paused',
        resume: true,
        count: n,
      };
    return {
      show: true,
      head: n + ' queued · ' + (busy ? 'send when this turn ends' : 'sending'),
      note: n + ' queued',
      tone: '',
      resume: false,
      count: n,
    };
  }

  const ui = { editor: null, timer: null, conn: '', sig: '' };

  function el(doc, tag, cls, content) {
    const node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (content != null) node.textContent = content;
    return node;
  }
  function iconButton(doc, glyph, label, onClick) {
    const b = el(doc, 'button', 'q-btn', glyph);
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.onclick = onClick;
    return b;
  }

  function stopEditor() {
    if (ui.timer) {
      root.clearInterval(ui.timer);
      ui.timer = null;
    }
    ui.editor = null;
  }

  async function closeEditor(ctx, action, text) {
    const editor = ui.editor;
    if (!editor) return;
    stopEditor();
    try {
      await ctx.post('queue-edit', { id: editor.conn, messageId: editor.id, action, leaseId: editor.leaseId, text });
    } catch (error) {
      ctx.fail(error);
    }
    ui.sig = '';
    await ctx.refresh();
  }

  async function openEditor(ctx, item) {
    if (ui.editor) await closeEditor(ctx, 'cancel');
    const leaseId = 'lease-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    let reply;
    try {
      reply = await ctx.post('queue-edit', { id: ctx.connection, messageId: item.id, action: 'acquire', leaseId });
    } catch (error) {
      ctx.fail(error);
      await ctx.refresh();
      return;
    }
    const doc = ctx.box.ownerDocument;
    const row = el(doc, 'li', 'q-row q-editing');
    const area = el(doc, 'textarea', 'q-area');
    area.value = reply.text;
    area.rows = Math.min(6, Math.max(1, reply.text.split('\n').length));
    area.setAttribute('aria-label', 'Edit queued message');
    const save = el(doc, 'button', 'q-text-btn q-save', 'Save');
    save.type = 'button';
    const cancel = el(doc, 'button', 'q-text-btn', 'Cancel');
    cancel.type = 'button';
    save.onclick = () => closeEditor(ctx, 'save', area.value);
    cancel.onclick = () => closeEditor(ctx, 'cancel');
    area.onkeydown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancel.onclick();
      } else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        if (area.value.trim()) save.onclick();
      }
    };
    const editActions = el(doc, 'span', 'q-edit-actions');
    editActions.append(save, cancel);
    row.append(area, editActions);
    ui.editor = { id: item.id, conn: ctx.connection, leaseId, row, area };
    ui.timer = root.setInterval(async () => {
      try {
        await ctx.post('queue-edit', { id: ctx.connection, messageId: item.id, action: 'renew', leaseId });
      } catch (error) {
        stopEditor();
        ctx.fail(error);
        ui.sig = '';
        ctx.refresh();
      }
    }, RENEW_MS);
    ui.sig = '';
    await ctx.refresh();
    area.focus();
  }

  // ctx: {box, connection, busy, post(path, body), refresh(), fail(error)}; call it with the snapshot's queue on every render.
  function render(ctx, queue) {
    const box = ctx.box;
    if (!box) return summary(queue, ctx.busy);
    if (ui.conn !== ctx.connection) {
      // another conversation: the open editor belongs to the old one
      if (ui.editor) {
        const old = ui.editor;
        stopEditor();
        ctx
          .post('queue-edit', { id: old.conn, messageId: old.id, action: 'cancel', leaseId: old.leaseId })
          .catch(() => {});
      }
      ui.conn = ctx.connection;
      ui.sig = '';
    }
    const s = summary(queue, ctx.busy);
    const items = (queue && queue.items) || [];
    if (ui.editor && !items.some((i) => i.id === ui.editor.id)) stopEditor(); // it was sent or removed meanwhile
    const sig = JSON.stringify([
      ctx.connection,
      ctx.busy,
      queue && queue.reason,
      queue && queue.message,
      items.map((i) => [i.id, i.text, i.sending, i.note, i.attachments.length]),
      ui.editor && ui.editor.id,
    ]);
    if (sig === ui.sig) return s;
    ui.sig = sig;
    const doc = box.ownerDocument;
    box.hidden = !s.show;
    if (!s.show) {
      box.replaceChildren();
      return s;
    }
    const head = el(doc, 'div', 'q-head' + (s.tone ? ' q-paused' : ''));
    head.append(el(doc, 'span', '', s.head));
    if (s.resume) {
      const resume = el(doc, 'button', 'q-text-btn', 'Resume');
      resume.type = 'button';
      resume.title = T.resume;
      resume.setAttribute('aria-label', T.resume);
      resume.onclick = async () => {
        try {
          await ctx.post('queue-resume', { id: ctx.connection });
        } catch (e) {
          ctx.fail(e);
        }
        ui.sig = '';
        ctx.refresh();
      };
      head.append(resume);
    }
    const list = el(doc, 'ul', 'q-list');
    items.forEach((item, index) => {
      if (ui.editor && ui.editor.id === item.id) {
        list.append(ui.editor.row);
        return;
      }
      const row = el(doc, 'li', 'q-row' + (item.editing ? ' q-held' : ''));
      const extra = item.attachments.length ? ' (+' + item.attachments.length + ' attached)' : '';
      const line = el(doc, 'span', 'q-text', item.text.replace(/\s+/g, ' ').trim() + extra);
      line.title = item.text + (item.note ? '\n\n' + item.note : '');
      row.append(el(doc, 'span', 'q-num', item.sending ? '…' : String(index + 1)), line);
      if (item.note) row.append(el(doc, 'span', 'q-note', '!'));
      const act = el(doc, 'span', 'q-actions');
      act.append(
        iconButton(doc, '✎', T.edit, () => openEditor(ctx, item)),
        iconButton(doc, '↑', T.sendNow, async () => {
          try {
            await ctx.post('queue-send-now', { id: ctx.connection, messageId: item.id });
          } catch (e) {
            ctx.fail(e);
          }
          ui.sig = '';
          ctx.refresh();
        }),
        iconButton(doc, '✕', T.remove, async () => {
          try {
            await ctx.post('queue-remove', { id: ctx.connection, messageId: item.id });
          } catch (e) {
            ctx.fail(e);
          }
          ui.sig = '';
          ctx.refresh();
        }),
      );
      if (item.sending) act.hidden = true;
      row.append(act);
      list.append(row);
    });
    box.replaceChildren(head, list);
    return s;
  }

  const api = { summary, render, TEXT: T, state: ui };
  root.AgentQueueUI = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
