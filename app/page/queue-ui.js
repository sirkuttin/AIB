// Queued messages above the composer: one slim line per message, icon actions on hover/focus, a tiny header line.
// The queue itself (and the rule that editing the next message pauses it) lives in the agent host; this file only draws it and
// holds the edit lease open (renewing it) while an editor is on screen.
(function (root) {
  'use strict';
  const T = {
    edit: 'Edit - pauses the queue while you edit',
    // The ↑ on a queued row (owner, 2026-11-16): an agent that reads messages mid-turn gets it now and nothing running stops (Claude
    // Code moves a running command or helper to the background); one that can't keeps it first in the queue and sends it when the turn ends (nothing is cancelled).
    sendNow: 'Send now - nothing running stops',
    sendNext: 'Send next - goes first when this turn ends',
    remove: 'Remove from queue',
    resume: 'Resume sending the queued messages',
    held: 'Waits for your answer above · then goes in at once',
    fallback: 'Couldn’t send now: sends when this turn ends',
    sending: 'Sending',
    laneHead: 'Waiting to go in',
  };
  const RENEW_MS = 30000;

  // queue: the `queue` object of a connection snapshot. ctx (optional): {autonomous, steerable, agent} of the chat.
  function summary(queue, busy, ctx) {
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
    // build plan 2.3: a helper's (or copy chat's) work lands in this folder right now; the queue goes on its own after that
    if (queue.landing)
      return {
        show: true,
        head: n + ' queued · ' + (queue.message || 'Sends after “' + queue.landing + '” lands (a few seconds).'),
        note: queue.message || n + ' queued',
        tone: '',
        resume: false,
        count: n,
      };
    const C = root.AgentSendMenu && root.AgentSendMenu.COPY;
    // The agent started this turn itself and cannot take a message in it: say why they wait (owner, 2026-11-17)
    const ownCycle = busy && ctx && ctx.autonomous && !ctx.steerable;
    return {
      show: true,
      head:
        n +
        ' queued · ' +
        (ownCycle
          ? (C ? C.ownCycleQueue(ctx.agent || 'The agent') : 'The agent started this turn itself') + ' · they send then'
          : busy
            ? 'send when this turn ends'
            : 'sending'),
      note: n + ' queued',
      tone: '',
      resume: false,
      count: n,
    };
  }

  const ui = { editor: null, timer: null, conn: '', sig: '', sched: null };

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

  // ---- Send later: the scheduled cards (queue.scheduled). Always-visible ✎ ↑ ✕; editing is a row with the text and a date+time field.
  // No lease: a scheduled message is not in the queue until its time, so editing it never pauses anything.
  function scheduledWords(item) {
    const SM = root.AgentSendMenu;
    return SM ? SM.COPY.scheduledFor(SM.whenWords(item.at, Date.now())) : 'Scheduled for ' + new Date(item.at).toLocaleString();
  }
  function stopSchedEdit(ctx) {
    ui.sched = null;
    ui.sig = '';
    if (ctx) ctx.refresh();
  }
  function openSchedEdit(ctx, item) {
    const doc = ctx.box.ownerDocument,
      SM = root.AgentSendMenu,
      C = SM.COPY;
    const row = el(doc, 'li', 'q-row q-editing q-sched-edit');
    const area = el(doc, 'textarea', 'q-area');
    area.value = item.text;
    area.rows = Math.min(6, Math.max(1, item.text.split('\n').length));
    area.setAttribute('aria-label', 'Edit scheduled message');
    const when = el(doc, 'input', 'q-when');
    when.type = 'datetime-local';
    when.value = SM.localValue(item.at - 150000);
    when.setAttribute('aria-label', C.laterCustom);
    const error = el(doc, 'span', 'q-sched-error');
    error.hidden = true;
    const save = el(doc, 'button', 'q-text-btn q-save', C.scheduleSave);
    save.type = 'button';
    const cancel = el(doc, 'button', 'q-text-btn', C.scheduleKeep);
    cancel.type = 'button';
    save.onclick = async () => {
      const r = SM.customAt(when.value, Date.now());
      if (r.error) {
        error.textContent = r.error;
        error.hidden = false;
        return;
      }
      if (!area.value.trim()) {
        error.textContent = C.laterNeedsText;
        error.hidden = false;
        return;
      }
      try {
        await ctx.post('schedule-edit', { id: ctx.connection, messageId: item.id, text: area.value, at: r.at });
      } catch (e) {
        ctx.fail(e);
      }
      stopSchedEdit(ctx);
    };
    cancel.onclick = () => stopSchedEdit(ctx);
    row.onkeydown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancel.onclick();
      } else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.target === when) {
        e.preventDefault();
        save.onclick();
      }
    };
    const fields = el(doc, 'span', 'q-sched-fields');
    fields.append(area, when, error);
    const actions = el(doc, 'span', 'q-edit-actions');
    actions.append(save, cancel);
    row.append(fields, actions);
    ui.sched = { id: item.id, row, area };
    ui.sig = '';
    ctx.refresh();
    return area;
  }
  function scheduledRow(ctx, item) {
    const doc = ctx.box.ownerDocument;
    const C = root.AgentSendMenu ? root.AgentSendMenu.COPY : null;
    const row = el(doc, 'li', 'q-row q-sched');
    const extra = item.attachments.length ? ' (+' + item.attachments.length + ' attached)' : '';
    const line = el(doc, 'span', 'q-text', item.text.replace(/\s+/g, ' ').trim() + extra);
    const words = scheduledWords(item);
    line.title = item.text + '\n\n' + words;
    row.append(el(doc, 'span', 'q-num', '◷'), line, el(doc, 'span', 'q-lane-note q-when-note', words));
    if (item.error) { // its chat could not be reopened at the time: the card stays, with the reason
      const why = el(doc, 'span', 'q-lane-note q-sched-error', item.error);
      why.title = item.error;
      row.append(why);
    }
    const act = el(doc, 'span', 'q-actions');
    const run = (path) => async () => {
      try {
        await ctx.post(path, { id: ctx.connection, messageId: item.id });
      } catch (e) {
        ctx.fail(e);
      }
      ui.sig = '';
      ctx.refresh();
    };
    act.append(
      iconButton(doc, '✎', C ? C.scheduleEdit : 'Edit text and time', async () => {
        const area = openSchedEdit(ctx, item);
        if (area && area.focus) setTimeout(() => area.focus(), 0);
      }),
      iconButton(
        doc,
        '↑',
        ctx.busy && !ctx.steerable ? T.sendNext : C ? C.scheduleSendNow : 'Send now',
        run('schedule-send-now'),
      ),
      iconButton(doc, '✕', C ? C.scheduleCancel : 'Cancel', run('schedule-cancel')),
    );
    row.append(act);
    return row;
  }

  // What a held row says: the card it waits for, by name ("Held until you answer the approval “npm test” above · ..."), whose card it
  // is when a subagent's (ctx.names: session id -> name), and why it cannot go in now in its tooltip.
  function heldWords(item, ctx) {
    const C = root.AgentSendMenu && root.AgentSendMenu.COPY;
    const f = item && item.heldFor;
    if (!C || !f) return { note: C ? C.held : T.held, why: '' };
    if (f.card === 'command') {
      return { note: C.heldCommand(String(f.title || '').slice(0, 80)), why: 'Claude Code would stop the command if the message went in now.' };
    }
    const sub = f.route !== 'main' && f.sessionId;
    const who = sub ? (ctx.names && ctx.names[f.sessionId]) || 'a subagent' : '';
    const title = String(f.title || '').slice(0, 80);
    return {
      note: C.heldOn(C.heldWhat(f.card, who, title)),
      why: (C.heldWhy && C.heldWhy[ctx.agentId]) || C.heldWhyOther,
    };
  }

  // Messages sent while the agent works that have not gone in yet (the snapshot's steerLane): held for an open approval card,
  // being sent, or fallen back to after the turn. Injected ones are done (the bubble in the chat shows them) and are not listed.
  const HELD = { held: 1, sending: 1, fallback: 1 };
  function laneItems(lane) {
    return (Array.isArray(lane) ? lane : []).filter((i) => i && HELD[i.state]);
  }

  // ctx: {box, connection, busy, post(path, body), refresh(), fail(error)}; call it with the snapshot's queue on every render,
  // and its steerLane as the third argument.
  function render(ctx, queue, lane) {
    const box = ctx.box;
    const held = laneItems(lane),
      C = root.AgentSendMenu && root.AgentSendMenu.COPY,
      W = C ? { held: C.held, fallback: C.fallbackNote, sending: C.sendingHead, laneHead: C.heldHead } : T; // the words live in send-menu-ui.js
    if (!box) return summary(queue, ctx.busy, ctx);
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
      ui.sched = null;
      ui.sig = '';
    }
    const s = summary(queue, ctx.busy, ctx);
    const items = (queue && queue.items) || [];
    const sched = (queue && Array.isArray(queue.scheduled) && queue.scheduled) || [];
    if (ui.editor && !items.some((i) => i.id === ui.editor.id)) stopEditor(); // it was sent or removed meanwhile
    if (ui.sched && !sched.some((i) => i.id === ui.sched.id)) ui.sched = null; // it went out, or was cancelled elsewhere
    const sig = JSON.stringify([
      ctx.connection,
      ctx.busy,
      !!ctx.steerable,
      !!ctx.autonomous,
      ctx.agent,
      ctx.names,
      queue && queue.reason,
      queue && queue.message,
      queue && queue.landing,
      items.map((i) => [i.id, i.text, i.sending, i.note, i.attachments.length]),
      held.map((i) => [i.id, i.text, i.state, i.heldReason, i.heldFor]),
      ui.editor && ui.editor.id,
      sched.map((i) => [i.id, i.text, i.at, i.attachments.length]),
      ui.sched && ui.sched.id,
    ]);
    if (sig === ui.sig) return s;
    ui.sig = sig;
    const doc = box.ownerDocument;
    box.hidden = !s.show && !held.length && !sched.length;
    if (!s.show && !held.length && !sched.length) {
      box.replaceChildren();
      return s;
    }
    const laneRows = held.map((item) => {
      const row = el(doc, 'li', 'q-row q-lane q-lane-' + item.state);
      const words = item.state === 'held' ? heldWords(item, ctx) : null;
      row.append(
        el(doc, 'span', 'q-num', item.state === 'sending' ? '…' : '↓'),
        el(doc, 'span', 'q-text', String(item.text || '').replace(/\s+/g, ' ').trim()),
        el(doc, 'span', 'q-lane-note', words ? words.note : item.state === 'fallback' ? W.fallback : W.sending),
      );
      row.title = String(item.text || '') + (words ? '\n\n' + words.note + (words.why ? '\n' + words.why : '') : '');
      return row;
    });
    const head = el(doc, 'div', 'q-head' + (s.tone ? ' q-paused' : ''));
    const SMC = root.AgentSendMenu && root.AgentSendMenu.COPY;
    head.append(
      el(doc, 'span', '', s.show ? s.head : held.length ? (held.some((i) => i.heldFor && i.heldFor.card === 'command') ? 'Waiting for the running command' : W.laneHead) : SMC ? SMC.scheduledHead(sched.length) : sched.length + ' scheduled'),
    );
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
    list.append(...laneRows);
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
        iconButton(doc, '↑', ctx.busy && !ctx.steerable ? T.sendNext : T.sendNow, async () => {
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
    sched.forEach((item) => {
      if (ui.sched && ui.sched.id === item.id) list.append(ui.sched.row);
      else list.append(scheduledRow(ctx, item));
    });
    box.replaceChildren(head, list);
    return s;
  }

  const api = { summary, render, laneItems, heldWords, TEXT: T, state: ui };
  root.AgentQueueUI = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
