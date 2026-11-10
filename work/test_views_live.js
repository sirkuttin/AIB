'use strict';
/* Condensed views, stage 3: the live line in Chat. While the AI works on your newest prompt, one line shows
   the spinner, "Working", the current step and "step N · m:ss"; the step and the clock update in place, never by drawing the
   pane again; the final reply replaces it; a chat running in another app reads "working elsewhere" with no step number. */
const assert = require('node:assert/strict');
const test = require('node:test');
const { makePage, byClass, flat } = require('./chat_harness.js');

const SCRIPTS = ['stream-ui.js', 'tool-views.js', 'plan-ui.js', 'views.js', 'views-ui.js'];
const live = (kind, data, time, sessionId = 's') => ({ kind, time, data: { sessionId, ...data } });
const say = (text, time) => live('user', { text }, time);
const reply = (text, time) =>
  live('update', { update: { sessionUpdate: 'agent_message_chunk', content: { text } } }, time);
const think = (time, sessionId) =>
  live('update', { update: { sessionUpdate: 'agent_thought_chunk', content: { text: 'hm' } } }, time, sessionId);
const call = (id, command, time, sessionId) =>
  live(
    'update',
    {
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: id,
        title: 'Bash',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { command },
      },
    },
    time,
    sessionId,
  );
const nowS = () => Date.now() / 1000;

function livePage(view = 'chat') {
  const page = makePage({ scripts: SCRIPTS });
  page.run("selected={provider:'claude',id:'a',key:'a'};current='c1'");
  page.hook.setView(view);
  const box = page.element('messages');
  const lines = () => byClass(box, 'view-live');
  const meta = () => byClass(box, 'vl-meta')[0]?.textContent;
  const set = (evs, state = {}) => {
    page.run('snapshot=' + JSON.stringify({ sessionId: 's', busy: true, unknownReceipts: [], ...state }));
    page.run('events=' + JSON.stringify(evs));
    page.hook.repaintMain();
  };
  /* what the pane did: how many times it was drawn again */
  let draws = 0;
  const replace = box.replaceChildren.bind(box);
  box.replaceChildren = (...items) => {
    draws++;
    return replace(...items);
  };
  return { page, box, lines, meta, set, draws: () => draws };
}

test('liveStatus reads raw events: the newest tool call, else Thinking, with the step number and the prompt time', () => {
  const { page } = livePage();
  const CV = page.context.window.ChatViews;
  const since = 1700000000;
  const evs = [
    say('earlier prompt', since - 500),
    call('old', 'ls', since - 400),
    say('deploy it', since),
    think(since + 1),
    call('t1', 'python deploy.py --host', since + 2),
  ];
  const a = CV.liveStatus(evs, 'live', 's');
  assert.deepEqual(
    { ...a.step },
    {
      kind: 'tool',
      label: 'run',
      text: 'python deploy.py --host',
      title: 'python deploy.py --host',
    },
  );
  assert.equal(a.n, 1, 'tool calls since the newest prompt only');
  assert.equal(a.since, since * 1000, 'the clock starts at the prompt, so it survives a Studio restart');
  /* thinking after the tool call is the current step (the step being worked on is number 2) */
  const b = CV.liveStatus([...evs, think(since + 3)], 'live', 's');
  assert.deepEqual({ ...b.step }, { kind: 'thinking' });
  assert.equal(b.n, 2);
  /* Thinking is read from the events, not from rows: it needs no Show thinking */
  assert.equal(CV.liveStatus([say('hi', since), think(since + 1)], 'live', 's').step.kind, 'thinking');
  assert.equal(CV.liveStatus([say('hi', since)], 'live', 's').n, 1, 'nothing yet: thinking, step 1');
  /* a subagent's events are not this chat's steps */
  const c = CV.liveStatus([...evs, call('sub', 'rm -rf build', since + 4, 'child')], 'live', 's');
  assert.equal(c.step.text, 'python deploy.py --host');
  /* a tool that updates itself is still one step */
  const d = CV.liveStatus(
    [
      ...evs,
      live(
        'update',
        { update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' } },
        since + 5,
      ),
    ],
    'live',
    's',
  );
  assert.equal(d.n, 1);
  assert.equal(d.step.text, 'python deploy.py --host');
  assert.equal(CV.liveStatus([], 'live'), null);
  assert.equal(CV.liveStatus([reply('no prompt at all', 1)], 'live'), null);
  /* an injected note is not a prompt: the clock still starts at what you said */
  const e = CV.liveStatus(
    [say('real', since), live('user', { text: '<system-reminder>x</system-reminder>' }, since + 9)],
    'live',
    's',
  );
  assert.equal(e.since, since * 1000);
  assert.equal(CV.clock(42000), '0:42');
  assert.equal(CV.clock(725000), '12:05');
  assert.equal(CV.clock(3723000), '1:02:03');
});

test('Chat shows one live line for the newest prompt, in place of its newest run of steps: spinner, Working, the step, step N · time', () => {
  for (const view of ['chat']) {
    const t = livePage(view);
    t.set([
      say('older', 1),
      reply('older reply', 2),
      say('and restart Studio', nowS() - 42),
      call('t1', 'python deploy.py --host', nowS() - 40),
    ]);
    assert.equal(t.lines().length, 1, view);
    const line = flat(t.lines()[0]);
    assert.match(line, /Working/);
    assert.equal(byClass(t.box, 'tool-line-kind')[0].textContent, 'run', 'styled like the tool row badge');
    assert.equal(byClass(t.box, 'tool-line-text')[0].textContent, 'python deploy.py --host');
    assert.match(t.meta(), /^step 1 · 0:4[2-4]$/);
    assert.equal(byClass(t.lines()[0], 'view-spin').length, 1, "the plan card's spinner");
    assert.doesNotMatch(flat(t.box), /Working…/, 'the placeholder is replaced');
    assert.match(flat(t.box), /older reply/, 'older prompts are untouched');
    assert.doesNotMatch(flat(t.box), /Show steps/, 'the newest run of steps is the live line, not a fold');
  }
});

test('the step and the clock update in place: no repaint, and the signature does not change', () => {
  const t = livePage('chat');
  const since = nowS() - 42;
  const evs = [say('go', since), call('t1', 'npm test', since + 1)];
  t.set(evs);
  const sig = t.page.run('mainSignature'),
    draws = t.draws(),
    node = t.lines()[0];
  assert.match(t.meta(), /^step 1 · 0:4[2-4]$/);
  /* the clock: once a second, only the text */
  t.page.document.querySelectorAll = () => byClass(t.box, 'view-live');
  const ctx = t.page.context.window.ChatViewsUI;
  assert.equal(ctx.tickLive(Date.now() + 10000), 1);
  assert.match(t.meta(), /^step 1 · 0:5[2-4]$/);
  assert.equal(t.page.run('mainSignature'), sig, 'the signature does not carry the clock');
  assert.equal(t.draws(), draws, 'the pane was not drawn again');
  assert.equal(t.lines()[0], node, 'the very same line');
  /* a thought chunk changes the step but adds no row (Show thinking is off): updated in place too */
  t.set([...evs, think(since + 5)]);
  assert.equal(t.page.run('mainSignature'), sig);
  assert.equal(t.draws(), draws, 'still not drawn again');
  assert.equal(byClass(t.box, 'vl-thinking')[0].textContent, 'Thinking…');
  assert.match(t.meta(), /^step 2 · /);
  assert.equal(byClass(t.box, 'tool-line-kind').length, 0, 'the tool badge is gone while thinking');
  /* a new tool call is a new row: that repaints, and the line shows the newest call */
  t.set([...evs, think(since + 5), call('t2', 'git status', since + 6)]);
  assert.notEqual(t.page.run('mainSignature'), sig);
  assert.equal(byClass(t.box, 'tool-line-text')[0].textContent, 'git status');
});

test('the signature carries neither the step text nor the clock', () => {
  const t = livePage('chat');
  const since = nowS() - 5;
  t.set([say('go', since), call('t1', 'a', since)]);
  const sig = t.page.run('mainSignature');
  t.set([say('go', since), call('t1', 'a', since)], { busy: true });
  assert.equal(t.page.run('mainSignature'), sig);
  assert.doesNotMatch(sig, /step|0:0/);
});

test('when the turn ends the line is replaced by the final reply, and it never shows once the turn is over', () => {
  const t = livePage('chat');
  const since = nowS() - 30;
  const evs = [say('go', since), call('t1', 'npm test', since + 1)];
  t.set(evs);
  assert.equal(t.lines().length, 1);
  t.set([...evs, reply('All tests pass.', since + 20)], { busy: false });
  assert.equal(t.lines().length, 0, 'gone');
  assert.match(flat(t.box), /All tests pass\./);
  assert.match(flat(t.box), /Show steps \(1 tool call\)/, 'the run of steps is a closed fold again');
  assert.doesNotMatch(flat(t.box), /Working/);
  /* a turn that ended with no reply at all: its steps as a fold, not a live line */
  t.set(evs, { busy: false });
  assert.equal(t.lines().length, 0);
  assert.match(flat(t.box), /Show steps \(1 tool call\)/);
  /* the clock tick finds nothing to update once the line is gone */
  t.page.document.querySelectorAll = () => byClass(t.box, 'view-live');
  assert.equal(t.page.context.window.ChatViewsUI.tickLive(), 0);
});

test('a stale "working" after a crash or lost connection shows no live line; an open question reads Waiting for you', () => {
  const t = livePage('chat');
  const since = nowS() - 30;
  const evs = [say('go', since), call('t1', 'npm test', since + 1)];
  t.set(evs, { busy: true, closed: true });
  assert.equal(t.lines().length, 0, 'the connection is closed: not working');
  assert.doesNotMatch(flat(t.box), /Working/);
  t.page.run('connectionIssue=true');
  t.set(evs, { busy: true });
  assert.equal(t.lines().length, 0, 'the connection is lost: not working');
  t.page.run('connectionIssue=false');
  t.set(evs, { busy: true, permissions: [{ id: 1 }] });
  assert.equal(t.lines().length, 1);
  assert.match(flat(t.lines()[0]), /Waiting for you/);
  assert.doesNotMatch(flat(t.lines()[0]), /Working/);
});

test('a chat running in another app reads its step from the saved transcript: "working elsewhere", no step number', () => {
  const t = livePage('chat');
  t.page.run('current=""');
  t.page.run("conversations=[{key:'a',provider:'claude',id:'a',elsewhere:{working:true,verdict:'owned_elsewhere'}}]");
  const since = new Date(Date.now() - 65000).toISOString();
  const w = {
    loaded: true,
    start: 0,
    end: 4,
    total: 4,
    thinking: '0',
    context: [],
    events: [
      { kind: 'user', text: 'run the build', time: since },
      { kind: 'assistant', text: 'ok', time: since },
      { kind: 'tool', label: 'Bash', text: JSON.stringify({ command: 'npm run build' }), callId: 'c1', time: since },
    ],
  };
  t.page.state.historyWindows.set('a', w);
  t.page.hook.showRows(
    t.box,
    t.page.hook.normalized({ events: w.events, context: [] }, 'a', true),
    'main',
    t.page.hook.savedExtra('a', w),
  );
  assert.equal(t.lines().length, 1);
  assert.equal(byClass(t.box, 'tool-line-text')[0].textContent, 'npm run build');
  assert.match(t.meta(), /^working elsewhere · 1:0[5-7]$/);
  assert.doesNotMatch(t.meta(), /step/);
  /* the other app finishes: no live line */
  t.page.run("conversations=[{key:'a',provider:'claude',id:'a',elsewhere:{working:false,verdict:'owned_elsewhere'}}]");
  assert.equal(t.page.hook.savedExtra('a', w).working, false);
});

test('in Chat the AI text renders while it streams; the live line shows only while there is no text yet for the step', () => {
  const t = livePage('chat');
  const since = nowS() - 20;
  const base = [say('go', since), think(since + 1), call('t1', 'npm test', since + 2)];
  t.set(base);
  assert.equal(t.lines().length, 1, 'tool call, no text: the live line');
  /* text starts streaming: the text shows, the live line goes */
  t.set([...base, reply('Tests are', since + 3)]);
  assert.match(flat(t.box), /Tests are/);
  assert.equal(t.lines().length, 0);
  t.set([...base, reply('Tests are passing now', since + 4)]);
  assert.match(flat(t.box), /Tests are passing now/, 'each chunk is drawn as it arrives');
  assert.equal(t.lines().length, 0);
  assert.match(flat(t.box), /Show steps \(1 tool call\)/, 'the run before the text is a closed fold');
  /* a thought chunk after the text (no row, Show thinking is off): the line is back without waiting for a new row */
  t.set([...base, reply('Tests are passing now', since + 4), think(since + 5)]);
  assert.equal(t.lines().length, 1);
  assert.match(byClass(t.box, 'vl-thinking')[0].textContent, /Thinking/);
  assert.match(flat(t.box), /Tests are passing now/);
});
