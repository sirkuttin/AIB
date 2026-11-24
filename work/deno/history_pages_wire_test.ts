/**
 * History loading phase 1B, the wire: GET /api/live/events and /api/live/event through the web server's routes, HostProxy's
 * fallback to the full state when the agent host is older (no 'events' op), Studio's own page call, and the phone's chat payload
 * reading one tail page (no helper events, tool output clipped). The page rules themselves: work/test_history_pages.js.
 */
import { assert, assertEquals } from './_assert.ts';
import { HostProxy, olderHost } from '../../app/server/host/host_proxy.ts';
import { HostUnavailable } from '../../app/server/host/host_client.ts';
import { chatPayload, TitleCache } from '../../app/server/remote/payloads.ts';
import { type FakeChat, pc, remoteStudio } from './_remote_fixture.ts';

type Json = Record<string, any>;
const MAIN = 'sess-1';

function events(): Json[] {
  const out: Json[] = [];
  const ev = (kind: string, data: Json) => out.push({ seq: out.length + 1, kind, time: 1000 + out.length, data: { sessionId: MAIN, ...data } });
  for (let i = 0; i < 60; i++) {
    ev('user', { text: `question ${i} ` + 'q'.repeat(400) });
    ev('update', { sessionId: 'helper-1', update: { sessionUpdate: 'agent_message_chunk', content: { text: 'h'.repeat(2000) } } });
    ev('update', { update: { sessionUpdate: 'agent_message_chunk', content: { text: `answer ${i}` } } });
  }
  ev('update', { update: { sessionUpdate: 'tool_call', toolCallId: 'big', title: 'Bash', status: 'in_progress' } });
  ev('update', { update: { sessionUpdate: 'tool_call_update', toolCallId: 'big', status: 'completed', rawOutput: 'o'.repeat(300_000) } });
  return out;
}

function proxyWith(call: (op: string, args: Json) => unknown): HostProxy {
  const proxy = Object.create(HostProxy.prototype) as HostProxy;
  (proxy as unknown as { call: unknown }).call = (op: string, args: Json) => Promise.resolve().then(() => call(op, args));
  return proxy;
}

Deno.test('host proxy: an older agent host (no events op) gets the full state and the same page rules', async () => {
  const all = events();
  const ops: string[] = [];
  const proxy = proxyWith((op, args) => {
    ops.push(op);
    if (op === 'events' || op === 'event') throw new Error('Unknown operation');
    if (op === 'state') return { sessionId: MAIN, eventsId: 'e9', cursor: all.length, events: all.filter((e) => e.seq > args.after) };
    throw new Error('unexpected ' + op);
  });
  const pg = await proxy.liveEvents('c1', { bytes: 8192 }) as Json;
  assertEquals(ops, ['events', 'state']);
  assertEquals(pg.oldHost, true);
  assertEquals(pg.eventsId, 'e9');
  assertEquals(pg.stable, 0, 'an older host: no seq is trusted across a restart');
  assert(pg.events.every((e: Json) => e.data.sessionId === MAIN), 'no helper events');
  assertEquals(pg.events.at(-1).clipped, true);
  assert(pg.bytes <= 8192 + 50_000, 'one page by bytes: ' + pg.bytes);
  assertEquals(pg.helpers['helper-1'].events, 60);
  const back = await proxy.liveEvents('c1', { before: pg.from, bytes: 4096 }) as Json;
  assert(back.to < pg.from && back.events.length > 0);
  const full = await proxy.liveEvent('c1', all.length) as Json;
  assertEquals(full.data.update.rawOutput.length, 300_000);
});

Deno.test('host proxy: a new agent host answers the events op itself; other errors are not hidden', async () => {
  const proxy = proxyWith((op, args) => (op === 'events' ? { from: 1, events: [], asked: args } : null));
  const pg = await proxy.liveEvents('c1', { after: 5 }) as Json;
  assertEquals(pg.asked, { id: 'c1', query: { after: 5 } });
  assert(!olderHost(new HostUnavailable('down', 'host_unreachable')), 'a host that is down is not an older host');
  assert(olderHost(new Error('Unknown operation')));
  const failing = proxyWith(() => {
    throw new Error('boom');
  });
  let threw = false;
  await failing.liveEvents('c1', {}).catch(() => (threw = true));
  assert(threw);
});

function chat(): FakeChat {
  return {
    id: 'conn-1', provider: 'claude', sessionId: MAIN, cwd: 'C:\\work\\shop', busy: false, closed: false,
    attention: { state: 'idle' }, subagents: {}, events: events(), permissions: [], elicitations: [],
  };
}

Deno.test('routes and phone: /api/live/events pages, /api/live/event gives the whole event, the phone opens on one tail page', async () => {
  const s = await remoteStudio();
  try {
    s.chats.push(chat());
    const get = (path: string) => pc(s, 'GET', path) as Promise<[number, Json]>;
    let [status, body] = await get('/api/live/events?id=conn-1&bytes=8192');
    assertEquals(status, 200, JSON.stringify(body));
    assert(body.events.length > 0 && body.events.every((e: Json) => e.data.sessionId === MAIN));
    assertEquals(body.more, true);
    const from = body.from;
    [status, body] = await get(`/api/live/events?id=conn-1&before=${from}&bytes=4096`);
    assertEquals(status, 200, JSON.stringify(body).slice(0, 300));
    assert(body.to < from);
    [status, body] = await get('/api/live/events?id=conn-1&session=helper-1&bytes=4096');
    assert(body.events.every((e: Json) => e.data.sessionId === 'helper-1') && body.events.length > 0);
    [status, body] = await get('/api/live/event?id=conn-1&seq=182');
    assertEquals(status, 200, JSON.stringify(body).slice(0, 300));
    assertEquals(body.data.update.rawOutput.length, 300_000);
    [status] = await get('/api/live/events?id=nope');
    assertEquals(status, 404);

    const phone = await chatPayload(s.ctx, 'conn-1', 1000, 0, new TitleCache());
    assert(phone);
    const evs = phone!.events as Json[];
    assert(evs.every((e) => e.data.sessionId === MAIN), 'no helper events on the phone');
    assertEquals(evs.at(-1)!.clipped, true, 'tool output clipped');
    assert(JSON.stringify(evs).length < 300 * 1024, 'one page by bytes');
    assertEquals(phone!.truncated, false, 'the whole chat fits one phone page');
    assertEquals(phone!.firstSeq, 1);
    assertEquals(phone!.cursor, 182);
    const delta = await chatPayload(s.ctx, 'conn-1', 1000, 170, new TitleCache());
    assertEquals((delta!.events as Json[]).map((e) => e.seq), [171, 172, 174, 175, 177, 178, 180, 181, 182]);
  } finally {
    await s.close();
  }
});
