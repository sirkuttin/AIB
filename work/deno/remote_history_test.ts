/**
 * Phone history (the owner: "we can barely see any history of a chat"), through the phone port of an in-process AIB with a fake
 * agent host and real saved transcripts:
 *  - the open page of a live chat is sized by bytes and never starts inside a run, whatever tail the phone asks for (a long streamed
 *    reply is hundreds of chunk events; the phone glues them, so a cut one lost its beginning);
 *  - Load earlier (GET /api/remote/chat?id&before=<seq>&bytes=): pages back whole and contiguous, more true then false; no chat
 *    state in the answer;
 *  - a delta with more new events than asked for starts at a run (gap: true), never inside a reply;
 *  - Show output (GET /api/remote/event?id&seq): one event whole (See chats), 404 when it is not kept;
 *  - a saved chat pages back with before=<seq> (seq = place in the transcript + 1), and a message over the limit is cut and marked.
 */
import { assert, assertEquals } from './_assert.ts';
import { DEVICE_HEADER, REMOTE_ROUTES, ROUTE_SCOPE } from '../../app/server/remote/server.ts';
import { MAX_EVENT_TEXT } from '../../app/server/remote/saved.ts';
import { readRemotePort } from '../../app/server/remote/port.ts';
import { type FakeChat, fakeTailscale, pairPhone, pc, phoneHeaders, raw, type RemoteAib, remoteAib } from './_remote_fixture.ts';
import { serveStatus } from './_remote_fixture.ts';

const OPTS = { sanitizeResources: false, sanitizeOps: false };
// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;

async function phoneOn(): Promise<RemoteAib> {
  const fake = fakeTailscale();
  const s = await remoteAib({ runner: fake.runner }, undefined, { saved: true });
  fake.state.serve = serveStatus(readRemotePort(s.state)!);
  assertEquals((await pc(s, 'POST', '/api/live/devices/access', { on: true }))[0], 200);
  return s;
}

async function get(s: RemoteAib, token: string, path: string): Promise<{ status: number; text: string; json: Json }> {
  const r = await raw(s.phonePort(), 'GET', path, phoneHeaders({ [DEVICE_HEADER]: token }));
  return { status: r.status, text: r.text, json: r.json as Json };
}

/** Turns of a chat: your message, then a reply streamed as `chunks` chunk events of `size` characters (the first says which turn). */
function turns(n: number, chunks: number, size: number): Json[] {
  const out: Json[] = [];
  const ev = (kind: string, data: Json) => out.push({ seq: out.length + 1, kind, time: 1000 + out.length, data });
  for (let t = 0; t < n; t++) {
    ev('user', { text: `question ${t}` });
    for (let c = 0; c < chunks; c++) {
      const text = c === 0 ? `START ${t} ` : c === chunks - 1 ? ` END ${t}` : 'x'.repeat(size);
      ev('update', { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } });
    }
    ev('turn_end', { stopReason: 'end_turn' });
  }
  return out;
}

function chat(id: string, events: Json[]): FakeChat {
  return {
    id,
    provider: 'claude',
    sessionId: 'sess-' + id,
    cwd: 'C:\\work\\shop',
    busy: false,
    closed: false,
    attention: { state: 'idle', needs: 0, turnEndedAt: null, busySince: null },
    subagents: {},
    events,
    permissions: [],
    elicitations: [],
  };
}

/** A run starts here: your message, a turn end, or the first chunk of a reply. */
const runStart = (e: Json) => e.kind === 'user' || e.kind === 'turn_end' || String(e.data?.update?.content?.text ?? '').startsWith('START');

/** The agent's text of a list of events, glued as phone.js glues chunks (one string per reply). */
function replies(events: Json[]): string[] {
  const out: string[] = [];
  let last = false;
  for (const e of events) {
    const u = e.data?.update;
    if (u?.sessionUpdate === 'agent_message_chunk') {
      if (last) out[out.length - 1] += u.content.text;
      else out.push(u.content.text);
      last = true;
    } else last = false;
  }
  return out;
}

Deno.test({
  ...OPTS,
  name: 'phone history: open page by bytes from a run start; Load earlier pages back whole and contiguous; a delta never cuts a reply',
  async fn() {
    const s = await phoneOn();
    try {
      const phone = await pairPhone(s);
      // 6 turns, each a reply of 402 chunks (~80 KB): the phone's open page (256 KB) holds about 3; the old 300-event tail cut one
      const all = turns(6, 402, 200);
      s.chats.push(chat('c-long', all));
      const open = await get(s, phone.token, '/api/remote/chat?id=c-long&tail=300');
      assertEquals(open.status, 200, open.text.slice(0, 300));
      const first: Json[] = open.json.events;
      assert(runStart(first[0]), 'the open page starts at a run, not inside the reply: ' + JSON.stringify(first[0]).slice(0, 120));
      assert(first.length > 300, `no count cuts the open page: ${first.length}`);
      for (const r of replies(first)) assert(/^START \d+ x+ END \d+$/.test(r), 'every reply whole: ' + r.slice(0, 40));
      assertEquals(open.json.truncated, true);
      assertEquals(open.json.firstSeq, first[0].seq);
      assertEquals(first.at(-1)!.seq, all.length);

      // Load earlier: whole runs, contiguous, until the first event; no chat state in the answer
      let shown = first;
      let before = open.json.firstSeq as number;
      let pages = 0;
      for (;;) {
        const older = await get(s, phone.token, `/api/remote/chat?id=c-long&before=${before}&bytes=65536`);
        assertEquals(older.status, 200, older.text.slice(0, 300));
        assertEquals(Object.keys(older.json).sort(), ['events', 'firstSeq', 'id', 'more']);
        const evs: Json[] = older.json.events;
        assert(evs.length > 0);
        assertEquals(evs.at(-1)!.seq, before - 1, 'contiguous with what the phone shows');
        assertEquals(older.json.firstSeq, evs[0].seq);
        assert(runStart(evs[0]), 'a run start');
        shown = [...evs, ...shown];
        before = older.json.firstSeq;
        pages++;
        if (!older.json.more) break;
        assert(pages < 50, 'ends');
      }
      assert(pages > 1, 'more than one page back: more was true, then false');
      assertEquals(shown.map((e) => e.seq), all.map((e) => e.seq), 'the whole chat, once, in order');
      assertEquals(replies(shown).length, 6);
      for (const r of replies(shown)) assert(/^START \d+ x+ END \d+$/.test(r));
      // before the first event: an empty last page
      const none = await get(s, phone.token, '/api/remote/chat?id=c-long&before=1');
      assertEquals([none.status, none.json.events.length, none.json.more], [200, 0, false]);
      assertEquals((await get(s, phone.token, '/api/remote/chat?id=nope&before=5')).status, 404);

      // a delta with more new events than the phone asked for: the newest whole runs, from a run start, and it says so
      const cursor = all.length;
      const more = turns(2, 402, 10).map((e, i) => ({ ...e, seq: cursor + i + 1 }));
      s.chats[0].events = [...all, ...more];
      const delta = await get(s, phone.token, `/api/remote/chat?id=c-long&after=${cursor}&tail=300`);
      assertEquals(delta.status, 200);
      const d: Json[] = delta.json.events;
      assertEquals(delta.json.gap, true);
      assertEquals(delta.json.truncated, true);
      assert(runStart(d[0]), 'a delta starts at a run, never inside the reply: ' + JSON.stringify(d[0]).slice(0, 120));
      for (const r of replies(d)) assert(/^START \d+ x+ END \d+$/.test(r));
      // a small delta: as before
      const small = await get(s, phone.token, `/api/remote/chat?id=c-long&after=${s.chats[0].events.length - 3}&tail=300`);
      assertEquals([small.json.events.length, small.json.gap], [3, undefined]);
    } finally {
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'phone history: Show output gives one event whole (See chats); the route is listed with its switch',
  async fn() {
    assert(REMOTE_ROUTES.some(([m, p, a]) => m === 'GET' && p === '/api/remote/event' && a === 'device'));
    assertEquals(ROUTE_SCOPE['GET /api/remote/event'], 'phone.read');
    const s = await phoneOn();
    try {
      const phone = await pairPhone(s);
      const events: Json[] = [
        { seq: 1, kind: 'user', data: { text: 'run it' } },
        { seq: 2, kind: 'update', data: { update: { sessionUpdate: 'tool_call', toolCallId: 'b', title: 'Bash', status: 'in_progress' } } },
        {
          seq: 3,
          kind: 'update',
          data: { update: { sessionUpdate: 'tool_call_update', toolCallId: 'b', status: 'completed', rawOutput: 'o'.repeat(300_000) } },
        },
      ];
      s.chats.push(chat('c-tool', events));
      const open = await get(s, phone.token, '/api/remote/chat?id=c-tool');
      const step = (open.json.events as Json[]).find((e) => e.seq === 3)!;
      assertEquals(step.clipped, true, 'the chat page clips a big output');
      assert(step.data.update.rawOutput.length < 50_000);
      const whole = await get(s, phone.token, '/api/remote/event?id=c-tool&seq=3');
      assertEquals(whole.status, 200, whole.text.slice(0, 200));
      assertEquals(whole.json.event.data.update.rawOutput.length, 300_000);
      assertEquals(whole.json.event.clipped, undefined);
      assertEquals((await get(s, phone.token, '/api/remote/event?id=c-tool&seq=99')).status, 404);
      assertEquals((await get(s, phone.token, '/api/remote/event?id=c-tool&seq=x')).status, 404);
      assertEquals((await get(s, phone.token, '/api/remote/event?id=nope&seq=3')).status, 404);
      // See chats off: refused
      s.ctx.phone.devices.devices.get(phone.id)!.scopes = ['phone.prompt'];
      assertEquals((await get(s, phone.token, '/api/remote/event?id=c-tool&seq=3')).status, 403);
    } finally {
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'phone history: a saved chat pages back with before=; seqs are transcript places; a message over the limit is cut and marked',
  async fn() {
    const s = await phoneOn();
    try {
      const phone = await pairPhone(s);
      const stamp = new Date(Date.now() - 3600_000).toISOString();
      const rows: Json[] = [];
      for (let i = 0; i < 30; i++) {
        const who = i % 2 ? 'assistant' : 'user';
        // row 27: 20,000 characters (more than the old 8,000 limit) comes whole; row 29: past the transcript's own 32,000
        const text = i === 29 ? 'long ' + 'y'.repeat(40_000) : i === 27 ? 'z'.repeat(20_000) : `message ${i}`;
        const message = { role: who, content: [{ type: 'text', text }] };
        rows.push({ type: who, sessionId: 's-pages', cwd: s.project, timestamp: stamp, message });
      }
      // two replies in a row across a page boundary (rows 9 and 10 both from the agent): the second still starts on a new paragraph
      rows[10] = { ...rows[10], type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'message 10' }] } };
      s.saveChat({ sessionId: 's-pages', rows });
      s.ctx.phone.saved.invalidate();
      const last = await get(s, phone.token, '/api/remote/saved?key=claude:s-pages&tail=10');
      assertEquals(last.status, 200, last.text.slice(0, 300));
      const a: Json[] = last.json.events;
      assertEquals(a.map((e) => e.seq), [21, 22, 23, 24, 25, 26, 27, 28, 29, 30]);
      assertEquals([last.json.firstSeq, last.json.truncated], [21, true]);
      const cut = a.at(-1)!;
      assertEquals(cut.clipped, true, 'the long message is marked');
      const kept = String(cut.data.update.content.text);
      assert(kept.length >= 32_000 && kept.length <= MAX_EVENT_TEXT && !kept.includes('[Display shortened'), `${kept.length}: no PC note`);
      const whole = a.find((e) => e.seq === 28)!;
      assertEquals([whole.clipped, String(whole.data.update.content.text).length], [undefined, 20_000]);
      assertEquals(a[0].clipped, undefined);

      const mid = await get(s, phone.token, '/api/remote/saved?key=claude:s-pages&tail=10&before=21');
      const b: Json[] = mid.json.events;
      assertEquals(b.map((e) => e.seq), [11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
      assertEquals([mid.json.firstSeq, mid.json.truncated], [11, true]);
      assertEquals(b[0].data.update.content.text, '\n\nmessage 10', 'a reply after a reply on the page before');
      const head = await get(s, phone.token, '/api/remote/saved?key=claude:s-pages&tail=10&before=11');
      assertEquals(head.json.events.map((e: Json) => e.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      assertEquals([head.json.firstSeq, head.json.truncated], [1, false]);
      assertEquals(head.json.events[0].data.text, 'message 0');
      const none = await get(s, phone.token, '/api/remote/saved?key=claude:s-pages&tail=10&before=1');
      assertEquals([none.json.events.length, none.json.truncated], [0, false]);
    } finally {
      await s.close();
    }
  },
});
