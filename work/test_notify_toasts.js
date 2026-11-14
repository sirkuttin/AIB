'use strict';
// The in-page toast of inbox prototype v3 (notify-ui.js): the inbox's card with one row of actions, answered from the toast;
// risky commands need Review; needs-you toasts step back into the inbox after 15 s (not while you are in one); at most 2 at
// once with "+N more in the inbox"; To review is quiet and goes after 6 s; answering anywhere clears it.
const assert = require('node:assert/strict');
const test = require('node:test');
const { page, load } = require('./fake_dom');

const chat = (key, o = {}) => ({
  key,
  title: 'Chat ' + key,
  state: 'idle',
  phase: 'working',
  needs: 0,
  since: 0,
  yourTurn: false,
  yourTurnAt: 0,
  eligible: true,
  muted: false,
  selected: false,
  ...o,
});
const allowOnce = { id: 'p0', label: 'Allow', tone: 'ok', op: 'permission', reqKey: 'r', optionId: 'a1', kind: 'allow_once' };
const always = { id: 'p1', label: 'Always allow', tone: 'ok', op: 'permission', reqKey: 'r', optionId: 'a2', kind: 'allow_always' };
const deny = { id: 'p2', label: 'Deny', tone: 'no', op: 'permission', reqKey: 'r', optionId: 'd1', kind: 'reject_once' };

function setup(cards) {
  const shell = page();
  shell.document.hasFocus = () => true; // AIB in front: toasts, no desktop notification
  shell.document.hidden = false;
  shell.document.visibilityState = 'visible';
  const ctx = load(shell, ['notify-rules.js', 'notify-ui.js']);
  const N = ctx.AgentNotifyUI;
  const calls = [];
  N._state.host = {
    openChat: (k) => calls.push(['open', k]),
    openInbox: (k) => calls.push(['inbox', k]),
    toastCard: (k) => (cards[k] ? { title: 'Chat ' + k, project: 'shopfront', ...cards[k] } : null),
    toastAnswer: (k, b) => (calls.push(['answer', k, b.optionId]), Promise.resolve()),
    toastReply: (k, text) => (calls.push(['reply', k, text]), Promise.resolve()),
    toastRetry: (k) => (calls.push(['retry', k]), Promise.resolve()),
  };
  const stackEl = () => shell.body.querySelector('.toast-stack');
  const toasts = () => (stackEl() ? stackEl().children.filter((n) => n.classList.contains('toast')) : []);
  const labels = (t) => t.querySelectorAll('button.toast-btn').map((b) => b.textContent);
  return { shell, N, calls, toasts, labels, stackEl };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

test('the toast is the inbox card: line 1 the request, line 2 chat · project, one row: Allow / Deny (no Always allow)', () => {
  const t = setup({ a: { reason: 'approval', line1: 'Run npm install stripe@18.0.0', buttons: [allowOnce, always, deny], full: 'npm install stripe@18.0.0' } });
  t.N.observeItems([chat('a')], 0);
  t.N.observeItems([chat('a', { state: 'needs_you', phase: 'needs_you', needs: 1, since: 10 })], 1000);
  const [toast] = t.toasts();
  assert.ok(toast, 'a toast for a chat other than the one on screen');
  assert.equal(toast.querySelector('.toast-l1').textContent, 'Run npm install stripe@18.0.0');
  assert.equal(toast.querySelector('.toast-l2').textContent, 'Chat a · shopfront');
  assert.deepEqual(t.labels(toast), ['Allow', 'Deny']);
  assert.equal(toast.querySelectorAll('.toast-acts').length, 1, 'one row of actions');
  assert.ok(!toast.textContent.includes('Open'), 'no Open button');
  assert.equal(toast.querySelector('button.toast-link').textContent, 'Full command', 'the full command is a quiet link');
});

test('answering from the toast sends the agent option and clears the toast; the chat on screen stays', async () => {
  const t = setup({ a: { reason: 'approval', line1: 'Run npm test', buttons: [allowOnce, deny] } });
  t.N.observeItems([chat('a')], 0);
  t.N.observeItems([chat('a', { state: 'needs_you', phase: 'needs_you', needs: 1 })], 1000);
  t.toasts()[0].querySelector('button.toast-btn.def').click();
  await flush();
  assert.deepEqual(t.calls, [['answer', 'a', 'a1']]);
  assert.equal(t.toasts().length, 0);
});

test('risky commands show Review, then the full command and Allow / Deny: never one tap, no Always allow', () => {
  const t = setup({ a: { reason: 'approval', line1: 'Run git push origin main', buttons: [allowOnce, always, deny], full: 'git push origin main' } });
  t.N.observeItems([chat('a')], 0);
  t.N.observeItems([chat('a', { state: 'needs_you', phase: 'needs_you', needs: 1 })], 1000);
  let toast = t.toasts()[0];
  assert.deepEqual(t.labels(toast), ['Review', 'Deny']);
  assert.equal(toast.querySelector('.toast-detail'), null);
  toast.querySelector('button.toast-btn.def').click();
  toast = t.toasts()[0];
  assert.deepEqual(t.labels(toast), ['Allow', 'Deny']);
  assert.equal(toast.querySelector('.toast-detail').textContent, '$ git push origin main');
  assert.deepEqual(t.calls, [], 'Review sends nothing');
});

test('a question in the reply gets Reply with the box in place; a failed turn Retry / Reply', async () => {
  const t = setup({ q: { reason: 'asks', line1: 'Ship it to staging first?', reply: true }, f: { reason: 'failed', line1: 'Rate limited', reply: true, retry: true } });
  t.N.observeItems([chat('q'), chat('f')], 0);
  t.N.observeItems([chat('q', { phase: 'asks', since: 5 }), chat('f', { phase: 'failed', since: 6 })], 1000);
  const [q, f] = t.toasts();
  assert.deepEqual(t.labels(q), ['Reply']);
  assert.deepEqual(t.labels(f), ['Retry', 'Reply']);
  q.querySelector('button.toast-btn').click();
  const ta = t.toasts()[0].querySelector('textarea');
  assert.ok(ta, 'the reply box opens in the toast');
  ta.value = 'yes, staging';
  ta.dispatch('input');
  ta.dispatch('keydown', { key: 'Enter', shiftKey: false });
  await flush();
  assert.deepEqual(t.calls, [['reply', 'q', 'yes, staging']]);
  assert.equal(t.toasts().length, 1);
});

test('a needs-you toast steps back into the inbox after 15 s, not while hovered; × sends it there too', () => {
  const t = setup({ a: { reason: 'approval', line1: 'Run a', buttons: [allowOnce, deny] }, b: { reason: 'approval', line1: 'Run b', buttons: [allowOnce, deny] } });
  t.N.observeItems([chat('a'), chat('b')], 0);
  t.N.observeItems([chat('a', { state: 'needs_you', phase: 'needs_you', needs: 1, since: 1 }), chat('b', { state: 'needs_you', phase: 'needs_you', needs: 1, since: 2 })], 1000);
  const [a] = t.toasts();
  a.dispatch('mouseenter');
  t.N.tickToasts(1000 + t.N.NEEDS_MS + 1);
  assert.deepEqual(t.toasts().map((n) => n.dataset.chat), ['a'], 'hovered: a waits; b stepped back into the inbox');
  a.dispatch('mouseleave');
  t.N.tickToasts(1000 + 2 * t.N.NEEDS_MS + 2);
  assert.equal(t.toasts().length, 0);
  // ×
  const u = setup({ c: { reason: 'approval', line1: 'Run c', buttons: [allowOnce, deny] } });
  u.N.observeItems([chat('c')], 0);
  u.N.observeItems([chat('c', { state: 'needs_you', phase: 'needs_you', needs: 1 })], 1000);
  u.toasts()[0].querySelector('button.toast-close').click();
  assert.equal(u.toasts().length, 0);
  assert.deepEqual(u.calls, [], '× answers nothing: it stays in the inbox');
});

test('at most 2 toasts, the oldest wait first, then "+N more in the inbox"', () => {
  const cards = {};
  for (const k of ['a', 'b', 'c', 'd']) cards[k] = { reason: 'approval', line1: 'Run ' + k, buttons: [allowOnce, deny] };
  const t = setup(cards);
  t.N.observeItems(['a', 'b', 'c', 'd'].map((k) => chat(k)), 0);
  t.N.observeItems(
    [chat('a', { since: 40 }), chat('b', { since: 10 }), chat('c', { since: 30 }), chat('d', { since: 20 })].map((c) => ({ ...c, state: 'needs_you', phase: 'needs_you', needs: 1 })),
    1000,
  );
  assert.deepEqual(t.toasts().map((n) => n.dataset.chat), ['b', 'd']);
  const more = t.stackEl().querySelector('button.toast-more');
  assert.equal(more.textContent, '+2 more in the inbox');
  more.click();
  assert.deepEqual(t.calls, [['inbox', undefined]]);
});

test('To review is quiet: a small toast with no buttons that goes after 6 s', () => {
  const t = setup({ a: { reason: 'finished', line1: 'Done: 3 files', reply: true } });
  t.N.observeItems([chat('a')], 0);
  t.N.observeItems([chat('a', { phase: 'your_turn', yourTurn: true, yourTurnAt: 5 })], 1000);
  const [toast] = t.toasts();
  assert.ok(toast.classList.contains('toast-turn'));
  assert.equal(toast.querySelector('.toast-l2').textContent, 'To review · shopfront');
  assert.deepEqual(t.labels(toast), [], 'no buttons');
  t.N.tickToasts(1000 + t.N.TURN_MS + 1);
  assert.equal(t.toasts().length, 0);
});

test('answered anywhere else (inbox, chat, phone): the next list refresh clears the toast; the chat on screen never toasts', () => {
  const t = setup({ a: { reason: 'approval', line1: 'Run a', buttons: [allowOnce, deny] }, q: { reason: 'asks', line1: 'Q?', reply: true } });
  t.N.observeItems([chat('a'), chat('q'), chat('s')], 0);
  t.N.observeItems(
    [chat('a', { state: 'needs_you', phase: 'needs_you', needs: 1 }), chat('q', { phase: 'asks', since: 3 }), chat('s', { selected: true, state: 'needs_you', phase: 'needs_you', needs: 1 })],
    1000,
  );
  assert.deepEqual(t.toasts().map((n) => n.dataset.chat).sort(), ['a', 'q'], 'no toast for the chat on screen; a question stays (it is blocked, not needs_you)');
  t.N.observeItems([chat('a', { phase: 'working', state: 'working' }), chat('q', { phase: 'asks', since: 3 }), chat('s', { selected: true })], 2000);
  assert.deepEqual(t.toasts().map((n) => n.dataset.chat), ['q']);
});

test('a desktop notification click opens the inbox on that request without switching the chat', () => {
  const t = setup({});
  assert.equal(t.N.openFromDesktop({ type: 'inbox', key: 'claude:x' }), true);
  assert.deepEqual(t.calls, [['inbox', 'claude:x']]);
});
