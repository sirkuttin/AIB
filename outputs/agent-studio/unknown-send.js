'use strict';
/* "Studio restarted while this was being sent": a quiet warning under a message whose delivery receipt is unknown.
   plan() is pure (tested in node); build() is the small DOM builder. The server keeps only a fingerprint of each message,
   so the text comes from this browser's own record of what it sent (pending-sends in localStorage). */
(function (root) {
  const GRACE_SECONDS = 5;
  const toSeconds = (t) => {
    if (typeof t === 'number') return t > 1e12 ? t / 1000 : t;
    const parsed = Date.parse(t);
    return Number.isFinite(parsed) ? parsed / 1000 : null;
  };
  /* unknown: [{clientMessageId, at}] from the server (already without dismissed ones)
     records: {id: {text, attachments}} this browser remembers; userRows: [{value, time}]; seenIds: Set of clientMessageIds
     the agent's live events already carry. Returns what to show: [{id, text|null, attachments}].
     A message is "received" (warning cleared) when a live user event carries its id, or a user row with the same text
     appears at or after the receipt time. */
  function plan(unknown, records, userRows, seenIds) {
    const out = [];
    for (const item of Array.isArray(unknown) ? unknown : []) {
      const id = item && item.clientMessageId;
      if (!id) continue;
      if (seenIds && seenIds.has(id)) continue;
      const record = records && records[id],
        text = record && typeof record.text === 'string' ? record.text : null;
      if (text !== null && text.trim()) {
        const at = Number(item.at) || 0;
        const arrived = (userRows || []).some((r) => {
          if (!r || typeof r.value !== 'string' || r.value.trim() !== text.trim()) return false;
          const t = toSeconds(r.time);
          return t !== null && t >= at - GRACE_SECONDS;
        });
        if (arrived) continue;
      }
      out.push({ id, text, attachments: record && Array.isArray(record.attachments) ? record.attachments : [] });
    }
    return out;
  }
  const WARNING = '⚠ AIB restarted while this was being sent. The agent may not have received it.';
  function make(tag, cls, label) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (label !== undefined) n.textContent = label;
    return n;
  }
  function build(item, handlers) {
    const wrap = make('div', 'unknown-send');
    if (item.text !== null) {
      const article = make('article', 'bubble user');
      const head = make('div', 'bubble-head');
      head.append(make('strong', '', 'You'));
      article.append(head, make('pre', '', item.text));
      wrap.append(article);
    }
    const line = make('div', 'unknown-send-line');
    line.setAttribute('role', 'status');
    line.append(make('span', '', WARNING));
    if (item.text !== null) {
      const again = make('button', 'unknown-send-btn', 'Send again');
      again.type = 'button';
      again.onclick = () => handlers.again(item);
      line.append(again);
    }
    const dismiss = make('button', 'unknown-send-btn', 'It arrived, dismiss');
    dismiss.type = 'button';
    dismiss.onclick = () => handlers.dismiss(item);
    line.append(dismiss);
    wrap.append(line);
    return wrap;
  }
  function newId() {
    return (
      (root.crypto && root.crypto.randomUUID && root.crypto.randomUUID()) ||
      'studio-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2)
    );
  }
  const api = { plan, build, newId, WARNING };
  root.UnknownSend = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
