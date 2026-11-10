'use strict';
const path = require('path');
const { APP: APP_DIR } = require('./_paths');
// Browser-level failure scenarios for chat.js using a small fake DOM and a scripted fetch.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadChat } = require('./chat_harness.js');
const vm = require('node:vm');

function storage() {
  const data = new Map();
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}
class El {
  constructor(id = '') {
    this.id = id;
    this.children = [];
    this.value = '';
    this.checked = false;
    this.hidden = false;
    this.disabled = false;
    this.textContent = '';
    this.className = '';
    this.dataset = {};
    this.style = {};
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.listeners = {};
    this.classList = { add() {}, remove() {} };
  }
  addEventListener(name, fn) {
    this.listeners[name] = fn;
  }
  setAttribute() {}
  removeAttribute() {}
  append(...items) {
    for (const item of items) this.children.push(item);
  }
  prepend(...items) {
    this.children.unshift(...items);
  }
  replaceChildren(...items) {
    this.children = items;
  }
  insertBefore(node) {
    this.children.push(node);
  }
  remove() {}
  querySelector(selector) {
    const cls = selector.startsWith('.') ? selector.slice(1) : null;
    const walk = (node) => {
      for (const child of node.children || []) {
        if (cls && String(child.className).split(/\s+/).includes(cls)) return child;
        const found = walk(child);
        if (found) return found;
      }
      return null;
    };
    return walk(this);
  }
  querySelectorAll() {
    return [];
  }
  showModal() {}
  select() {}
  focus() {}
}
const flat = (el) => (el.textContent || '') + (el.children || []).map(flat).join('');
function harness(routes, { confirmResult = true } = {}) {
  const elements = new Map(),
    calls = [];
  const element = (id) => {
    if (!elements.has(id)) {
      const el = new El(id);
      if (id === 'providerFilter') el.options = [new El(), new El(), new El()];
      elements.set(id, el);
    }
    return elements.get(id);
  };
  const fetch = async (url, options = {}) => {
    const parsed = new URL(url, 'http://127.0.0.1');
    calls.push({ url: parsed.pathname, query: Object.fromEntries(parsed.searchParams), options });
    const handler =
      routes[parsed.pathname] || (parsed.pathname === '/api/live/bootstrap' ? () => ({ body: { token: 't' } }) : null); // get() fetches the token first
    if (!handler) return { ok: false, status: 404, json: async () => ({ error: 'no route ' + parsed.pathname }) };
    const result = await handler(
      Object.fromEntries(parsed.searchParams),
      options.body ? JSON.parse(options.body) : null,
      options,
    );
    if (result instanceof Error) throw result;
    return {
      ok: result.status === undefined || result.status < 400,
      status: result.status || 200,
      json: async () => result.body,
    };
  };
  const context = vm.createContext({
    AgentChoice: require(path.join(APP_DIR, 'agent-choice.js')),
    localStorage: storage(),
    sessionStorage: storage(),
    document: {
      getElementById: element,
      createElement: () => new El('created'),
      createDocumentFragment: () => new El('fragment'),
      body: { classList: { add() {}, remove() {} } },
    },
    window: { addEventListener() {} },
    fetch,
    setInterval() {},
    clearInterval() {},
    setTimeout: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      timer.unref();
      return timer;
    },
    clearTimeout,
    URLSearchParams,
    AbortController,
    URL,
    console,
    Date,
    Math,
    confirm: () => confirmResult,
  });
  const chat = loadChat(context);
  return { context, calls, element, run: chat.run };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
const savedSession = (over = {}) => ({
  key: 'omp/p/s.jsonl',
  provider: 'omp',
  id: 'sess-1',
  cwd: 'C:/proj',
  title: 'Saved chat',
  hasMessages: true,
  created: 1,
  modified: Date.now() / 1000 - 3600,
  subagentCount: 0,
  ...over,
});
const liveList = (over = {}) => ({ connections: [], recovered: [], instanceId: 'instance-A', ...over });

test('an interrupted request fails once, keeps the draft, and is never replayed', async () => {
  let attempts = 0;
  const h = harness({
    '/api/live/bootstrap': () => ({ body: { token: 't1', instanceId: 'instance-A', features: {} } }),
    '/api/live/prompt': () => {
      attempts++;
      const error = new Error('aborted');
      error.name = 'AbortError';
      return error;
    },
  });
  await h.run('refreshToken()');
  h.run("selected={provider:'omp',id:'sess-1',cwd:'C:/proj',key:'omp/p/s.jsonl'};current='conn-1'");
  h.element('prompt').value = 'important draft';
  await assert.rejects(
    h.run("post('prompt',{id:'conn-1',text:'important draft',clientMessageId:'a1'})"),
    /timed out.*draft is saved/i,
  );
  assert.equal(attempts, 1);
  assert.equal(h.element('prompt').value, 'important draft');
});

test('a polling failure marks the connection as lost and recovers without losing the selection', async () => {
  let fail = true;
  const h = harness({
    '/api/live/bootstrap': () => ({ body: { token: 't', instanceId: 'A' } }),
    '/api/live/state': () =>
      fail
        ? new TypeError('network down')
        : {
            body: {
              sessionId: 'sess-1',
              events: [],
              cursor: 0,
              permissions: [],
              elicitations: [],
              busy: false,
              closed: false,
              settings: {},
            },
          },
  });
  h.run("selected={provider:'omp',id:'sess-1',cwd:'C:/proj',key:'live:conn-1',title:'T'};current='conn-1'");
  await h.run('refresh()');
  assert.equal(h.run('connectionIssue'), true);
  assert.equal(h.run('current'), 'conn-1');
  fail = false;
  await h.run('refresh()');
  assert.equal(h.run('connectionIssue'), false);
  assert.equal(h.run('current'), 'conn-1');
});

test('server restart: new instance refreshes the token, voids old connections, lists recovered chats and never resends', async () => {
  const state = { instance: 'instance-A', token: 'old-token' };
  const h = harness({
    '/api/live/bootstrap': () => ({
      body: { token: state.token, instanceId: state.instance, features: { sessionDiscovery: true } },
    }),
    '/api/sessions': () => ({ body: { sessions: [savedSession()] } }),
    '/api/live/list': () => ({
      body: liveList({
        instanceId: state.instance,
        recovered:
          state.instance === 'instance-B'
            ? [
                {
                  provider: 'omp',
                  sessionId: 'sess-1',
                  cwd: 'C:/proj',
                  title: '',
                  openedAt: 1,
                  lastSeen: 2,
                  unknownMessages: 1,
                },
                {
                  provider: 'claude',
                  sessionId: 'gone-1',
                  cwd: 'C:/other',
                  title: 'Lost transcript',
                  openedAt: 1,
                  lastSeen: 2,
                  unknownMessages: 0,
                },
              ]
            : [],
      }),
    }),
    '/api/live/prompt': () => ({
      status: 409,
      body: { error: 'cannot tell if it was received', code: 'prompt_state_unknown' },
    }),
  });
  await h.run('refreshToken()');
  await h.run('listConversations()');
  assert.equal(h.run('instanceId'), 'instance-A');
  h.run("current='conn-before-restart';snapshot={};selected=conversations[0]");
  state.instance = 'instance-B';
  state.token = 'new-token';
  await h.run('listConversations()');
  assert.equal(h.run('instanceId'), 'instance-B');
  assert.equal(h.run('token'), 'new-token');
  assert.equal(h.run('current'), '');
  assert.match(h.element('error').textContent, /restarted/i);
  const conversations = h.run('conversations.map(c=>({key:c.key,recovered:!!c.recovered,live:!!c.live}))');
  assert.deepEqual(
    [...conversations].map((c) => ({ ...c })),
    [
      { key: 'omp/p/s.jsonl', recovered: true, live: false },
      { key: 'recovered:claude:claude:gone-1'.replace('claude:claude', 'claude'), recovered: true, live: false },
    ].map((c) => ({ ...c })),
  );
  // There is no banner any more: nothing in the page offers Reconnect or Forget, and nothing was sent.
  assert.equal(h.run('typeof renderRecoveryBanner'), 'undefined');
  assert.equal(h.run('typeof forgetRecovered'), 'undefined');
  assert.equal(h.element('recoveryBanner').textContent, '');
  // A retried prompt whose delivery is unknown: the retry id is forgotten so a deliberate second Send gets a new id.
  h.run('selected.recovered=undefined');
  const first = h.run("attemptId('omp:sess-1','hello')");
  await assert.rejects(
    h.run(`post('prompt',{id:'x',text:'hello',clientMessageId:${JSON.stringify(first)}})`),
    /cannot tell/,
  );
  assert.notEqual(h.run("attemptId('omp:sess-1','hello')"), first);
  assert.equal(h.calls.filter((c) => c.url === '/api/live/prompt').length, 1);
});

test('a recovered chat that is being reconnected carries the reconnecting fact; the page never offers Forget', async () => {
  const h = harness({
    '/api/live/bootstrap': () => ({ body: { token: 't', instanceId: 'A' } }),
    '/api/sessions': () => ({ body: { sessions: [] } }),
    '/api/live/list': () => ({
      body: liveList({
        instanceId: 'A',
        autoReconnect: true,
        recovered: [
          {
            provider: 'claude',
            sessionId: 'c1',
            cwd: 'C:/x',
            title: 'T',
            openedAt: 1,
            lastSeen: 2,
            unknownMessages: 0,
            reconnecting: true,
          },
        ],
      }),
    }),
  });
  await h.run('refreshToken()');
  await h.run('listConversations()');
  assert.equal(h.run('conversations.length'), 1);
  assert.equal(h.run('conversations[0].recovered.reconnecting'), true);
  assert.match(flat(h.run('rowStatus(conversations[0])')), /Reconnecting/);
  assert.match(h.run('pseudoNote(conversations[0])'), /is reconnecting/);
  h.run('conversations[0].recovered.reconnecting=false');
  assert.match(flat(h.run('rowStatus(conversations[0])')), /Not running/);
  assert.doesNotMatch(h.run('pseudoNote(conversations[0])'), /Nothing is sent automatically|Reconnect to load/);
});

test('switching conversations while connecting does not redirect or send the draft anywhere', async () => {
  let releaseConnect;
  const gate = new Promise((resolve) => {
    releaseConnect = resolve;
  });
  const h = harness({
    '/api/live/bootstrap': () => ({ body: { token: 't', instanceId: 'A' } }),
    '/api/sessions': () => ({
      body: { sessions: [savedSession(), savedSession({ key: 'omp/p/other.jsonl', id: 'sess-2', title: 'Other' })] },
    }),
    '/api/live/list': () => ({
      body: liveList({
        instanceId: 'A',
        connections: [
          {
            id: 'conn-1',
            provider: 'omp',
            sessionId: 'sess-1',
            cwd: 'C:/proj',
            closed: false,
            busy: false,
            ready: true,
          },
        ],
      }),
    }),
    '/api/live/connect': async () => {
      await gate;
      return { body: { id: 'conn-1', ready: true } };
    },
    '/api/live/prompt': () => ({ body: { ok: true } }),
    '/api/transcript': () => ({ body: { events: [], before: 0, end: 0, total: 0 } }),
    '/api/agents': () => ({ body: { agents: [] } }),
    '/api/commands': () => ({ body: { commands: [] } }),
  });
  await h.run('refreshToken()');
  await h.run('listConversations()');
  h.run('openConversation(conversations[0])');
  await tick();
  h.element('prompt').value = 'draft for the first chat';
  const pending = h.run('continueConversation()');
  await tick();
  assert.equal(h.run('continuingKey'), 'omp:sess-1');
  // The user selects a different conversation while the first is still opening.
  h.run('openConversation(conversations[1])');
  await tick();
  assert.equal(h.run('selected.id'), 'sess-2');
  releaseConnect();
  await pending;
  await tick();
  assert.equal(h.run('selected.id'), 'sess-2', 'the late connection must not steal the selection');
  assert.equal(h.run('current'), '', 'the other chat must not become connected');
  assert.equal(
    h.calls.filter((c) => c.url === '/api/live/prompt').length,
    0,
    'nothing may be sent into the newly selected chat',
  );
  assert.equal(h.run("drafts.get('omp:sess-1')"), 'draft for the first chat');
});

test('history windows page backwards and forwards without refetching the whole transcript', async () => {
  const total = 1000;
  let size = total;
  const ask = [];
  const slice = (from, to) =>
    Array.from({ length: Math.max(0, to - from) }, (_, i) => ({
      id: 'e' + (from + i),
      kind: 'user',
      label: 'User',
      text: 'm' + (from + i),
      time: 't',
    }));
  const h = harness({
    '/api/transcript': (q) => {
      ask.push(q);
      const limit = Number(q.limit);
      let start, end;
      if (q.after !== undefined) {
        start = Number(q.after);
        end = Math.min(size, start + limit);
      } else {
        end = Math.min(size, q.before !== undefined ? Number(q.before) : size);
        start = Math.max(0, end - limit);
      }
      return { body: { events: slice(start, end), before: start, end, total: size } };
    },
  });
  h.run("selected={key:'omp/p/s.jsonl',provider:'omp',id:'s',cwd:'c'}");
  let w = await h.run("pollHistory('omp/p/s.jsonl')");
  assert.deepEqual([w.start, w.end, w.events.length], [880, 1000, 120]);
  size = 1003;
  w = await h.run("pollHistory('omp/p/s.jsonl')");
  assert.deepEqual([w.start, w.end, w.events.length], [880, 1003, 123]);
  assert.equal(ask.at(-1).after, '1000');
  h.run("selected.key='omp/p/s.jsonl'");
  await h.run("loadEarlier('omp/p/s.jsonl','main')");
  w = h.run("historyWindows.get('omp/p/s.jsonl')");
  assert.deepEqual([w.start, w.end, w.events.length], [760, 1003, 243]);
  assert.equal(w.events[0].text, 'm760');
  assert.equal(
    Math.max(...ask.filter((q) => q.after === undefined).map((q) => Number(q.limit))),
    120,
    'initial and earlier pages are bounded',
  );
  assert.ok(
    ask.every((q) => Number(q.limit) <= 500),
    'no request may ask for the whole file',
  );
  for (let i = 0; i < 10; i++) await h.run("loadEarlier('omp/p/s.jsonl','main')");
  w = h.run("historyWindows.get('omp/p/s.jsonl')");
  assert.equal(w.start, 0);
  assert.equal(w.events.length, 1003);
  const ids = new Set([...w.events].map((e) => e.id));
  assert.equal(ids.size, 1003, 'pages are contiguous with no duplicates');
  assert.equal(h.element('messages').querySelector('.load-history'), null, 'no button once the beginning is reached');
});

test('a truncated or rewritten transcript resets its history window', async () => {
  let size = 50;
  const slice = (from, to) =>
    Array.from({ length: Math.max(0, to - from) }, (_, i) => ({
      id: 'e' + (from + i),
      kind: 'user',
      label: 'U',
      text: 'm' + (from + i),
      time: 't',
    }));
  const h = harness({
    '/api/transcript': (q) => {
      const limit = Number(q.limit);
      let start, end;
      if (q.after !== undefined) {
        start = Number(q.after);
        end = Math.min(size, start + limit);
      } else {
        end = size;
        start = Math.max(0, end - limit);
      }
      return { body: { events: slice(start, end), before: start, end, total: size } };
    },
  });
  let w = await h.run("pollHistory('k')");
  assert.equal(w.end, 50);
  size = 10;
  w = await h.run("pollHistory('k')");
  assert.deepEqual([w.start, w.end, w.events.length], [0, 10, 10]);
});

test('saved rows say Saved and never claim a running agent; live rows say Live in AIB', () => {
  const h = harness({});
  const saved = flat(h.run("rowStatus({key:'k',provider:'omp',modified:Date.now()/1000-5})"));
  assert.match(saved, /Saved/);
  assert.match(saved, /not confirmed running/);
  assert.doesNotMatch(saved, /Live/);
  const live = flat(h.run('rowStatus({live:{busy:true}})'));
  assert.match(live, /Live in AIB/);
  assert.match(live, /Working/);
  assert.match(flat(h.run('rowStatus({recovered:{}})')), /Was open in AIB before restart/);
  assert.match(flat(h.run('rowStatus({recovered:{reconnecting:true}})')), /Reconnecting/);
  assert.match(flat(h.run("rowStatus({source:'agent'})")), /Not read locally/);
  assert.equal(h.run('agentStateLabel({live:false,active:true})'), 'Written recently · not confirmed running');
  assert.equal(h.run('agentStateLabel({live:false,active:false,finished:true})'), 'Finished');
  assert.match(
    h.run("commandState({status:'running',transcriptIdleSeconds:1800})"),
    /Last reported running \(saved\).*idle 30m/,
  );
  assert.doesNotMatch(h.run("commandState({status:'unknown'})"), /Running/);
});

test('subagent titles prefer adapter titles then descriptions and keep earlier good names', () => {
  const h = harness({});
  assert.equal(h.run("subagentTitle({title:'Review'},undefined,'abcdef123456')"), 'Review');
  assert.equal(
    h.run("subagentTitle({description:'Reads the code\\nand reports'},undefined,'abcdef123456')"),
    'Reads the code',
  );
  assert.equal(h.run("subagentTitle({},{name:'Earlier title'},'abcdef123456')"), 'Earlier title');
  assert.equal(h.run("subagentTitle({},{name:'Subagent abcdef12'},'abcdef123456')"), 'Subagent abcdef12');
});

test('subagent Stop appears only when the agent advertised cancel and the child is still running', async () => {
  const h = harness({
    '/api/live/bootstrap': () => ({ body: { token: 't' } }),
    '/api/live/cancel': () => ({ body: { ok: true } }),
    '/api/live/state': () => ({
      body: {
        sessionId: 'm',
        events: [],
        cursor: 0,
        permissions: [],
        elicitations: [],
        busy: true,
        closed: false,
        settings: {},
      },
    }),
  });
  await h.run('refreshToken()');
  h.run(
    "current='conn';subSelection={key:'child-1',live:true};snapshot={subagents:{'child-1':{capabilities:{cancel:{}},state:'running'}}}",
  );
  h.run('renderSubagentControls()');
  assert.equal(h.element('stopSubagent').hidden, false);
  h.run("snapshot.subagents['child-1'].state='idle'");
  h.run('renderSubagentControls()');
  assert.equal(h.element('stopSubagent').hidden, true);
  h.run("snapshot.subagents['child-1']={capabilities:{},state:'running'}");
  h.run('renderSubagentControls()');
  assert.equal(h.element('stopSubagent').hidden, true, 'no capability means read-only');
  h.run("snapshot.subagents['child-1']={capabilities:{cancel:{}},state:'running'}");
  h.run('renderSubagentControls()');
  await h.element('stopSubagent').onclick();
  const sent = h.calls.find((c) => c.url === '/api/live/cancel');
  assert.deepEqual(JSON.parse(sent.options.body), { id: 'conn', subagentSessionId: 'child-1' });
});

test('agent-listed sessions merge by session ID, paginate, and skip saved or live duplicates', async () => {
  const pages = [
    {
      supported: true,
      sessions: [
        { sessionId: 'sess-1', cwd: 'C:/proj', title: 'dup of saved', updatedAt: '2026-11-01T00:00:00Z' },
        { sessionId: 'only-agent-1', cwd: 'C:/p2', title: 'Agent only', updatedAt: '2026-11-02T00:00:00Z' },
      ],
      nextCursor: 'offset:2',
    },
    {
      supported: true,
      sessions: [{ sessionId: 'only-agent-2', cwd: 'C:/p3', title: 'Second page', updatedAt: '' }],
      nextCursor: null,
    },
  ];
  const cursors = [];
  const h = harness({
    '/api/live/bootstrap': () => ({ body: { token: 't', instanceId: 'A', features: { sessionDiscovery: true } } }),
    '/api/sessions': () => ({ body: { sessions: [savedSession()] } }),
    '/api/live/list': () => ({ body: liveList({ instanceId: 'A' }) }),
    '/api/live/discover': (q, body) => {
      cursors.push(body.cursor);
      return { body: pages[cursors.length - 1] };
    },
  });
  await h.run('refreshToken()');
  h.run('discoveryEnabled=true');
  h.run("provider='omp'");
  await h.run('listConversations()');
  await h.run('discoverSessions()');
  let keys = [...h.run('conversations.map(c=>c.key)')];
  assert.deepEqual(keys, ['omp/p/s.jsonl', 'agent:omp:only-agent-1']);
  assert.equal(h.element('discoverSessions').textContent, 'Load more from agent');
  await h.run('discoverSessions()');
  keys = [...h.run('conversations.map(c=>c.key)')];
  assert.deepEqual(keys, ['omp/p/s.jsonl', 'agent:omp:only-agent-1', 'agent:omp:only-agent-2']);
  assert.deepEqual(cursors, [undefined, 'offset:2']);
  assert.equal(h.element('discoverSessions').disabled, true);
  await h.run('discoverSessions()');
  assert.equal(cursors.length, 2, 'a finished list is not requested again');
});

test('selecting an agent-listed chat without a transcript shows an explanation instead of querying transcripts', async () => {
  const h = harness({
    '/api/live/bootstrap': () => ({ body: { token: 't', instanceId: 'A' } }),
    '/api/sessions': () => ({ body: { sessions: [] } }),
    '/api/live/list': () => ({ body: liveList({ instanceId: 'A' }) }),
  });
  h.run("selected={key:'agent:omp:x',provider:'omp',id:'x',cwd:'C:/p',source:'agent',title:'T'};current=''");
  await h.run('refresh()');
  assert.match(flat(h.element('messages')), /no local transcript/i);
  assert.equal(h.calls.filter((c) => c.url === '/api/transcript').length, 0);
});
