/**
 * Phone actions (phase B, server/remote/actions.ts) in a Studio in this process with a fake agent host and a fake Tailscale CLI:
 *  - every new phone route is listed explicitly with the switch it needs; authenticate is always refused;
 *  - approve: only allow_once / reject_once options; allow_always, reject_always, plan-exit mode switches (acceptEdits,
 *    bypassPermissions, default), an option named "always", an unknown option and AIB's merge tool are refused; the agent host gets
 *    exactly {id, key, option};
 *  - answer: form questions only (a link question is refused), a withdrawn question is refused;
 *  - send: plain text only (attachments and "/" commands refused); a chat that is not running, closed or not ready is refused with
 *    "Open it in AIB on your PC";
 *  - queue: edit / remove / send now only for a message queued in that chat right now;
 *  - switches: Answer / Send / Approve off for a phone -> those routes refused; turned on again on the PC -> allowed;
 *  - the phone activity log: one line per action with the chat, never the message text or the command.
 */
import { assert, assertEquals } from './_assert.ts';
import { DEVICE_HEADER, REMOTE_ROUTES } from '../../outputs/agent-studio/server/remote/server.ts';
import { readRemotePort } from '../../outputs/agent-studio/server/remote/port.ts';
import {
  type FakeChat,
  fakeTailscale,
  pairPhone,
  pc,
  phoneHeaders,
  raw,
  type RemoteStudio,
  remoteStudio,
  serveStatus,
} from './_remote_fixture.ts';

const OPTS = { sanitizeResources: false, sanitizeOps: false };
type Json = Record<string, unknown>;
const SEP = Deno.build.os === 'windows' ? '\\' : '/';

async function phoneOn(): Promise<RemoteStudio> {
  const fake = fakeTailscale();
  const s = await remoteStudio({ runner: fake.runner });
  fake.state.serve = serveStatus(readRemotePort(s.state)!);
  assertEquals((await pc(s, 'POST', '/api/live/devices/access', { on: true }))[0], 200);
  return s;
}

function chat(id: string, over: Partial<FakeChat> = {}): FakeChat {
  return {
    id,
    provider: 'claude',
    sessionId: 'sess-' + id,
    cwd: 'C:\\code\\shop',
    busy: false,
    closed: false,
    attention: { state: 'idle', needs: 0, turnEndedAt: null, busySince: null },
    subagents: {},
    events: [{ seq: 1, kind: 'user', data: { text: 'first prompt' } }],
    permissions: [],
    elicitations: [],
    ...over,
  };
}

const post = (s: RemoteStudio, token: string, path: string, body: Json) =>
  raw(s.phonePort(), 'POST', path, phoneHeaders({ [DEVICE_HEADER]: token }, 'POST'), JSON.stringify(body));

const OPTIONS = [
  { optionId: 'yes', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'no', name: 'Reject', kind: 'reject_once' },
  { optionId: 'always', name: 'Allow always', kind: 'allow_always' },
  { optionId: 'never', name: 'Reject always', kind: 'reject_always' },
  { optionId: 'acceptEdits', name: 'Yes, and auto-accept edits', kind: 'allow_always' },
  { optionId: 'bypassPermissions', name: 'Yes, and bypass permissions', kind: 'allow_once' },
  { optionId: 'default', name: 'Yes, and manually approve edits', kind: 'allow_once' },
  { optionId: 'yes-session', name: "Yes, and don't ask again this session", kind: 'allow_once' },
];

Deno.test({
  ...OPTS,
  name: 'every phone action route is listed with the switch it needs; authenticate is always refused',
  async fn() {
    const actions = REMOTE_ROUTES.filter(([, , a]) => a === 'action').map(([m, p]) => `${m} ${p}`).sort();
    assertEquals(actions, [
      'POST /api/remote/authenticate',
      'POST /api/remote/cancel',
      'POST /api/remote/dismiss-unknown',
      'POST /api/remote/elicitation',
      'POST /api/remote/permission',
      'POST /api/remote/prompt',
      'POST /api/remote/queue',
      'POST /api/remote/queue-edit',
      'POST /api/remote/queue-remove',
      'POST /api/remote/queue-send-now',
    ]);
    const s = await phoneOn();
    try {
      s.chats.push(chat('c1', { auth: { methods: [{ id: 'login' }] } }));
      const phone = await pairPhone(s);
      const r = await post(s, phone.token, '/api/remote/authenticate', { id: 'c1', action: 'select', methodId: 'login' });
      assertEquals([r.status, r.json.code], [403, 'pc_only']);
      assertEquals(s.liveCalls.length, 0);
      const page = await raw(s.phonePort(), 'GET', '/api/remote/chat?id=c1', phoneHeaders({ [DEVICE_HEADER]: phone.token }));
      assertEquals((page.json.waiting as Json[]).map((w) => [w.kind, w.pcOnly]), [['sign-in', true]]);
      // the phone's own switches go with each answer
      assertEquals(page.json.scopes, ['phone.read', 'phone.answer', 'phone.prompt', 'phone.approve', 'phone.push']);
    } finally {
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'approve once: allow_once / reject_once pass; always, mode switches, "session", unknown and the merge tool are refused',
  async fn() {
    const s = await phoneOn();
    try {
      s.chats.push(chat('c1', {
        attention: { state: 'needs_you', needs: 2 },
        permissions: [
          { key: 'k1', params: { toolCall: { title: 'Run npm test', rawInput: { command: 'npm test -- --update' } }, options: OPTIONS } },
          {
            key: 'merge',
            params: {
              toolCall: {
                title: 'mcp__studio_artifact__merge_into_project',
                _meta: { claudeCode: { toolName: 'mcp__studio_artifact__merge_into_project' } },
              },
              options: [{ optionId: 'yes', name: 'Allow once', kind: 'allow_once' }],
            },
          },
        ],
      }));
      const phone = await pairPhone(s);
      const page = await raw(s.phonePort(), 'GET', '/api/remote/chat?id=c1', phoneHeaders({ [DEVICE_HEADER]: phone.token }));
      const [w1, w2] = page.json.waiting as Json[];
      assertEquals((w1.options as Json[]).map((o) => o.optionId), ['yes', 'no'], 'the sheet gets only the once options');
      assertEquals([w1.hidden, w1.pcOnly, w1.detail], [6, false, 'npm test -- --update']);
      assertEquals([w2.pcOnly, (w2.options as Json[]).length], [true, 0], "AIB's merge request stays on the PC");
      for (const option of ['always', 'never', 'acceptEdits', 'bypassPermissions', 'default', 'yes-session', 'nope']) {
        const r = await post(s, phone.token, '/api/remote/permission', { id: 'c1', key: 'k1', option });
        assertEquals([r.status, r.json.code], [403, 'pc_only'], option);
      }
      const merge = await post(s, phone.token, '/api/remote/permission', { id: 'c1', key: 'merge', option: 'yes' });
      assertEquals([merge.status, merge.json.code], [403, 'pc_only'], 'merge');
      assertEquals(s.liveCalls.length, 0, 'nothing refused reached the agent host');
      // cancel (no option) is not a phone choice either
      assertEquals((await post(s, phone.token, '/api/remote/permission', { id: 'c1', key: 'k1', option: null })).status, 400);
      const ok = await post(s, phone.token, '/api/remote/permission', { id: 'c1', key: 'k1', option: 'yes', extra: 'dropped' });
      assertEquals([ok.status, ok.json], [200, { ok: true }]);
      assertEquals(s.liveCalls, [['permission', { id: 'c1', key: 'k1', option: 'yes' }]]);
      const deny = await post(s, phone.token, '/api/remote/permission', { id: 'c1', key: 'k1', option: 'no' });
      assertEquals(deny.status, 200);
      const gone = await post(s, phone.token, '/api/remote/permission', { id: 'c1', key: 'old', option: 'yes' });
      assertEquals([gone.status, gone.json.code], [409, 'gone']);
    } finally {
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'answer: form questions only; a link question is finished on the PC; the agent host gets only id, key, action, content',
  async fn() {
    const s = await phoneOn();
    try {
      const schema = { type: 'object', properties: { plan: { type: 'string', enum: ['basic', 'pro'] } }, required: ['plan'] };
      s.chats.push(chat('c1', {
        elicitations: [
          { key: 'form1', params: { mode: 'form', message: 'Which plan?', requestedSchema: schema } },
          { key: 'url1', params: { mode: 'url', message: 'Sign in', url: 'https://accounts.example.com/x', elicitationId: 'e' } },
        ],
      }));
      const phone = await pairPhone(s);
      const page = await raw(s.phonePort(), 'GET', '/api/remote/chat?id=c1', phoneHeaders({ [DEVICE_HEADER]: phone.token }));
      const [f, u] = page.json.waiting as Json[];
      assertEquals([f.kind, f.pcOnly, f.schema], ['question', false, schema]);
      assertEquals([u.pcOnly, 'schema' in u], [true, false]);
      const url = await post(s, phone.token, '/api/remote/elicitation', { id: 'c1', key: 'url1', action: 'accept' });
      assertEquals([url.status, url.json.code], [403, 'pc_only']);
      assert(String(url.json.error).includes('Finish this on your PC'));
      const bad = await post(s, phone.token, '/api/remote/elicitation', { id: 'c1', key: 'form1', action: 'submit' });
      assertEquals(bad.status, 400);
      const ok = await post(s, phone.token, '/api/remote/elicitation', {
        id: 'c1',
        key: 'form1',
        action: 'accept',
        content: { plan: 'pro' },
        x: 1,
      });
      assertEquals(ok.status, 200);
      const no = await post(s, phone.token, '/api/remote/elicitation', { id: 'c1', key: 'form1', action: 'decline' });
      assertEquals(no.status, 200);
      assertEquals(s.liveCalls, [
        ['elicitation', { id: 'c1', key: 'form1', action: 'accept', content: { plan: 'pro' } }],
        ['elicitation', { id: 'c1', key: 'form1', action: 'decline' }],
      ]);
    } finally {
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'send: plain text is delivered; attachments and "/" commands are refused; a chat not running gets "Open it in AIB on your PC"',
  async fn() {
    const s = await phoneOn();
    try {
      s.chats.push(chat('c1'), chat('shut', { closed: true }), chat('opening', { ready: false }));
      const phone = await pairPhone(s);
      const send = (body: Json, path = '/api/remote/prompt') => post(s, phone.token, path, body);
      const png = 'iVBORw0KGgo=';
      for (
        const body of [
          { id: 'c1', text: 'look', clientMessageId: 'm1', attachments: [{ type: 'image', mimeType: 'image/png', data: png }] },
          { id: 'c1', text: 'look', clientMessageId: 'm1', files: [{ name: 'a.txt' }] },
        ]
      ) {
        const r = await send(body);
        assertEquals([r.status, r.json.code], [403, 'text_only']);
      }
      for (const text of ['/doc release plan: add dates', '  /compact', '/clear']) {
        const r = await send({ id: 'c1', text, clientMessageId: 'm2' });
        assertEquals([r.status, r.json.code], [403, 'text_only'], text);
        const q = await send({ id: 'c1', text, clientMessageId: 'm2' }, '/api/remote/queue');
        assertEquals(q.status, 403, 'queue ' + text);
      }
      assertEquals((await send({ id: 'c1', text: '   ', clientMessageId: 'm3' })).status, 400);
      for (const id of ['nope', 'shut']) {
        const r = await send({ id, text: 'hello', clientMessageId: 'm4' });
        assertEquals([r.status, r.json.code], [409, 'not_live'], id);
        assert(String(r.json.error).includes('Open it in AIB on your PC'));
      }
      assertEquals((await send({ id: 'opening', text: 'hello', clientMessageId: 'm4' })).json.code, 'not_ready');
      assertEquals(s.liveCalls.length, 0);
      s.answerLive(
        () => [200, { ok: true, accepted: true, duplicate: false, clientMessageId: 'm5', turnState: 'working', queue: { items: [] } }],
      );
      const ok = await send({ id: 'c1', text: 'Fix the failing test, please', clientMessageId: 'm5', attachments: [] });
      assertEquals([ok.status, ok.json], [200, {
        ok: true,
        accepted: true,
        duplicate: false,
        turnState: 'working',
        clientMessageId: 'm5',
      }]);
      const q = await send({ id: 'c1', text: 'then run lint', clientMessageId: 'm6' }, '/api/remote/queue');
      assertEquals(q.status, 200);
      const stop = await post(s, phone.token, '/api/remote/cancel', { id: 'c1', subagentSessionId: 'x' });
      assertEquals(stop.status, 200);
      assertEquals(s.liveCalls, [
        ['prompt', { id: 'c1', text: 'Fix the failing test, please', clientMessageId: 'm5' }],
        ['queue', { id: 'c1', text: 'then run lint', clientMessageId: 'm6' }],
        ['cancel', { id: 'c1' }],
      ]);
      // an agent host refusal comes back with its own words
      s.answerLive(() => [400, { error: 'Wait for the current turn, or interrupt it before sending another prompt' }]);
      const busy = await send({ id: 'c1', text: 'again', clientMessageId: 'm7' });
      assertEquals([busy.status, busy.json.error], [400, 'Wait for the current turn, or interrupt it before sending another prompt']);
    } finally {
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: "queue: edit, remove and send now only for a message queued in that chat right now; dismiss only that chat's receipt",
  async fn() {
    const s = await phoneOn();
    try {
      const item = (id: string, sending = false) => ({ id, text: 'queued ' + id, attachments: [], sending, editing: false });
      s.chats.push(
        chat('c1', { busy: true, queue: { items: [item('q-sending', true), item('q1')], paused: false, message: '' } }),
        chat('c2', { queue: { items: [item('q2')], paused: false, message: '' }, unknownReceipts: [{ clientMessageId: 'u2', at: 1 }] }),
      );
      const phone = await pairPhone(s);
      const p = (path: string, body: Json) => post(s, phone.token, path, body);
      for (
        const [path, body] of [
          ['/api/remote/queue-remove', { id: 'c1', messageId: 'q2' }],
          ['/api/remote/queue-send-now', { id: 'c1', messageId: 'q2' }],
          ['/api/remote/queue-edit', { id: 'c1', messageId: 'q2', action: 'acquire' }],
          ['/api/remote/queue-remove', { id: 'c1', messageId: 'q-sending' }],
          ['/api/remote/queue-edit', { id: 'c1', messageId: 'q-sending', action: 'acquire' }],
          ['/api/remote/queue-remove', { id: 'c1', messageId: 'never-queued' }],
        ] as [string, Json][]
      ) {
        const r = await p(path, body);
        assertEquals([r.status, r.json.code], [409, 'not_queued'], `${path} ${JSON.stringify(body)}`);
      }
      const slash = await p('/api/remote/queue-edit', { id: 'c1', messageId: 'q1', action: 'save', leaseId: 'L', text: '/doc x' });
      assertEquals(slash.status, 403);
      const dismissOther = await p('/api/remote/dismiss-unknown', { id: 'c1', clientMessageId: 'u2' });
      assertEquals(dismissOther.status, 409);
      assertEquals(s.liveCalls.length, 0);
      s.answerLive((
        name,
      ) => [200, name === 'queue-edit' ? { ok: true, leaseId: 'L1', text: 'queued q1', queue: { items: [] } } : { ok: true }]);
      const acquire = await p('/api/remote/queue-edit', { id: 'c1', messageId: 'q1', action: 'acquire' });
      assertEquals(acquire.json, { ok: true, leaseId: 'L1', text: 'queued q1' });
      assertEquals(
        (await p('/api/remote/queue-edit', { id: 'c1', messageId: 'q1', action: 'save', leaseId: 'L1', text: 'new words' })).status,
        200,
      );
      assertEquals((await p('/api/remote/queue-send-now', { id: 'c1', messageId: 'q1' })).status, 200);
      assertEquals((await p('/api/remote/queue-remove', { id: 'c2', messageId: 'q2' })).status, 200);
      assertEquals((await p('/api/remote/dismiss-unknown', { id: 'c2', clientMessageId: 'u2' })).status, 200);
      assertEquals(s.liveCalls, [
        ['queue-edit', { id: 'c1', messageId: 'q1', action: 'acquire', leaseId: null }],
        ['queue-edit', { id: 'c1', messageId: 'q1', action: 'save', leaseId: 'L1', text: 'new words' }],
        ['queue-send-now', { id: 'c1', messageId: 'q1' }],
        ['queue-remove', { id: 'c2', messageId: 'q2' }],
        ['dismiss-unknown', { id: 'c2', clientMessageId: 'u2' }],
      ]);
      const page = await raw(s.phonePort(), 'GET', '/api/remote/chat?id=c1', phoneHeaders({ [DEVICE_HEADER]: phone.token }));
      assertEquals((page.json.queue as Json).items, [
        { id: 'q-sending', text: 'queued q-sending', files: 0, sending: true, editing: false },
        { id: 'q1', text: 'queued q1', files: 0, sending: false, editing: false },
      ]);
    } finally {
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'switches: Answer, Send and Approve off for a phone -> refused; turned on in Settings > Devices -> allowed on the next request',
  async fn() {
    const s = await phoneOn();
    try {
      s.chats.push(chat('c1', {
        permissions: [{ key: 'k1', params: { toolCall: { title: 'Run' }, options: OPTIONS.slice(0, 2) } }],
        elicitations: [{ key: 'f1', params: { mode: 'form', message: 'Name?', requestedSchema: { type: 'object', properties: {} } } }],
      }));
      const phone = await pairPhone(s, 'Pixel 9', ['phone.read']);
      const tries: [string, Json][] = [
        ['/api/remote/elicitation', { id: 'c1', key: 'f1', action: 'accept', content: {} }],
        ['/api/remote/permission', { id: 'c1', key: 'k1', option: 'yes' }],
        ['/api/remote/prompt', { id: 'c1', text: 'hi', clientMessageId: 'm1' }],
        ['/api/remote/cancel', { id: 'c1' }],
        ['/api/remote/queue', { id: 'c1', text: 'hi', clientMessageId: 'm2' }],
      ];
      for (const [path, body] of tries) {
        const r = await post(s, phone.token, path, body);
        assertEquals([r.status, r.json.code], [403, 'scope'], path);
        assert(String(r.json.error).includes('Settings → Devices'), path);
      }
      assertEquals(s.liveCalls.length, 0);
      const home = await raw(s.phonePort(), 'GET', '/api/remote/home', phoneHeaders({ [DEVICE_HEADER]: phone.token }));
      assertEquals(home.json.scopes, ['phone.read']);
      const [st, changed] = await pc(s, 'POST', '/api/live/devices/scopes', { id: phone.id, scopes: ['phone.answer', 'phone.approve'] });
      assertEquals([st, (changed.device as Json).scopes], [200, ['phone.read', 'phone.answer', 'phone.approve']]);
      // the home revision changes with the switches (a phone holding the old revision gets the new answer, not 304)
      const again = await raw(
        s.phonePort(),
        'GET',
        `/api/remote/home?rev=${home.json.revision}`,
        phoneHeaders({ [DEVICE_HEADER]: phone.token }),
      );
      assertEquals([again.status, again.json.scopes], [200, ['phone.read', 'phone.answer', 'phone.approve']]);
      assertEquals((await post(s, phone.token, ...tries[0])).status, 200);
      assertEquals((await post(s, phone.token, ...tries[1])).status, 200);
      assertEquals((await post(s, phone.token, ...tries[2])).json.code, 'scope');
      assertEquals((await pc(s, 'POST', '/api/live/devices/scopes', { id: 'gone', scopes: [] }))[0], 404);
    } finally {
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'phone activity: one line per action with the phone, the action, the chat and the result; never the message or the command',
  async fn() {
    const s = await phoneOn();
    try {
      s.chats.push(chat('c1', {
        breadth: { sessionInfo: { title: 'Checkout redesign' } },
        permissions: [{
          key: 'k1',
          params: { toolCall: { title: 'Run SECRET-TITLE', rawInput: { command: 'rm -rf SECRET-COMMAND' } }, options: OPTIONS },
        }],
      }));
      const phone = await pairPhone(s);
      await post(s, phone.token, '/api/remote/prompt', { id: 'c1', text: 'SECRET-PROMPT-TEXT', clientMessageId: 'm1' });
      await post(s, phone.token, '/api/remote/prompt', { id: 'c1', text: '/doc SECRET-REFUSED-TEXT', clientMessageId: 'm2' });
      await post(s, phone.token, '/api/remote/permission', { id: 'c1', key: 'k1', option: 'always' });
      await post(s, phone.token, '/api/remote/permission', { id: 'c1', key: 'k1', option: 'yes' });
      await post(s, phone.token, '/api/remote/cancel', { id: 'c1' });
      await post(s, phone.token, '/api/remote/authenticate', { id: 'c1' });
      const file = Deno.readTextFileSync(s.state + SEP + 'remote-audit.jsonl');
      for (const secret of ['SECRET-PROMPT-TEXT', 'SECRET-REFUSED-TEXT', 'SECRET-COMMAND', 'SECRET-TITLE', phone.token]) {
        assert(!file.includes(secret), `the log holds ${secret}`);
      }
      const lines = file.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.chat);
      assertEquals(lines.map((l) => [l.name, l.action, l.chat, l.result]), [
        ['Pixel 9', 'send', 'c1', 'done'],
        ['Pixel 9', 'send', 'c1', 'refused: text_only'],
        ['Pixel 9', 'approve', 'c1', 'refused: pc_only'],
        ['Pixel 9', 'approve', 'c1', 'done'],
        ['Pixel 9', 'stop', 'c1', 'done'],
        ['Pixel 9', 'sign in', 'c1', 'refused: pc_only'],
      ]);
      for (const l of lines) assert(typeof l.time === 'number' && l.device === phone.id);
      const [, activity] = await pc(s, 'GET', '/api/live/devices/activity');
      const first = (activity.entries as Json[]).find((e) => e.action === 'stop')!;
      assertEquals([first.chat, first.chatTitle], ['c1', 'Checkout redesign']);
    } finally {
      await s.close();
    }
  },
});
