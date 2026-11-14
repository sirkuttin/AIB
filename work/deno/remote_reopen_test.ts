/**
 * Chats that are not running, on the phone (owner decisions 2b, 3b, 4), in a Studio in this process with real saved transcripts (a
 * Claude Code folder), a fake agent host and a fake Tailscale CLI:
 *  - home lists the saved chats of added projects that are not running (title, agent, folder, when last active; never the path),
 *    not the running one, not an archived one; GET /api/remote/saved shows one read only, as live events, without picture bytes,
 *    the tail respected;
 *  - Continue this chat: the agent host gets exactly {provider, cwd, resume, background} from the saved chat; a body with anything
 *    else (agent, model, mode, folder, config, picks, continueAnyway) is refused and nothing is started; Send off -> refused;
 *    "open somewhere else" / "may be in use" answers come back with the reason and never with continueAnyway;
 *  - reading on the phone marks the chat read in the read-state store the PC uses (the PC list's readStateRevision moves); the
 *    newest event = now, an older one = its time; writes are throttled; See chats off -> refused; one "read" log line, no text;
 *  - paired phones never expire: a phone last seen years ago (and a device store clock years ahead) still works.
 */
import { assert, assertEquals } from './_assert.ts';
import { DEVICE_HEADER, READ_GAP_MS, REMOTE_ROUTES } from '../../outputs/agent-studio/server/remote/server.ts';
import { DeviceStore } from '../../outputs/agent-studio/server/remote/devices.ts';
import { liveShaped, MAX_HISTORY_BYTES } from '../../outputs/agent-studio/server/remote/saved.ts';
import { readRemotePort } from '../../outputs/agent-studio/server/remote/port.ts';
import { type FakeChat, fakeTailscale, pairPhone, pc, phoneHeaders, raw, type RemoteStudio, remoteStudio } from './_remote_fixture.ts';
import { serveStatus } from './_remote_fixture.ts';

const OPTS = { sanitizeResources: false, sanitizeOps: false };
type Json = Record<string, unknown>;
const SEP = Deno.build.os === 'windows' ? '\\' : '/';

async function phoneOn(): Promise<RemoteStudio> {
  const fake = fakeTailscale();
  const s = await remoteStudio({ runner: fake.runner }, undefined, { saved: true });
  fake.state.serve = serveStatus(readRemotePort(s.state)!);
  assertEquals((await pc(s, 'POST', '/api/live/devices/access', { on: true }))[0], 200);
  return s;
}

function live(s: RemoteStudio, id: string, sessionId: string, over: Partial<FakeChat> = {}): FakeChat {
  return {
    id,
    provider: 'claude',
    sessionId,
    cwd: s.project,
    busy: false,
    closed: false,
    attention: { state: 'idle', needs: 0, turnEndedAt: null, busySince: null },
    subagents: {},
    events: [{ seq: 1, kind: 'user', time: 1000, data: { text: 'first prompt' } }],
    permissions: [],
    elicitations: [],
    ...over,
  };
}

const get = (s: RemoteStudio, token: string, path: string) => raw(s.phonePort(), 'GET', path, phoneHeaders({ [DEVICE_HEADER]: token }));
const post = (s: RemoteStudio, token: string, path: string, body: Json) =>
  raw(s.phonePort(), 'POST', path, phoneHeaders({ [DEVICE_HEADER]: token }, 'POST'), JSON.stringify(body));
const audit = (s: RemoteStudio) =>
  (() => {
    try {
      return Deno.readTextFileSync(s.state + SEP + 'remote-audit.jsonl');
    } catch {
      return '';
    }
  })().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Json);

Deno.test({
  ...OPTS,
  name: 'the not-running routes are listed with the switch they need',
  fn() {
    const listed = REMOTE_ROUTES.filter(([, p]) => /\/api\/remote\/(saved|continue|read)$/.test(p)).map(([m, p, a]) => `${m} ${p} ${a}`);
    assertEquals(listed.sort(), [
      'GET /api/remote/saved device',
      'POST /api/remote/continue continue',
      'POST /api/remote/read read',
    ]);
  },
});

Deno.test({
  ...OPTS,
  name: 'home lists saved chats that are not running (no paths); a saved chat reads as live events, no picture bytes, tail kept',
  async fn() {
    const s = await phoneOn();
    try {
      const phone = await pairPhone(s);
      s.saveChat({ sessionId: 's-old', prompt: 'Fix the checkout page', reply: 'Fixed it.', ageSeconds: 7200 });
      s.saveChat({ sessionId: 's-new', prompt: 'Write the release notes', ageSeconds: 600 });
      s.saveChat({ sessionId: 's-live', prompt: 'Running one', ageSeconds: 60 });
      s.saveChat({ sessionId: 's-archived', prompt: 'Archived one', ageSeconds: 60 });
      await s.ctx.conversations.apply('archive', 'claude', 's-archived', 'Archived one', '', true);
      s.chats.push(live(s, 'c-live', 's-live', { breadth: { sessionInfo: { title: 'Running one' } } }));
      const home = await get(s, phone.token, '/api/remote/home');
      assertEquals(home.status, 200, home.text);
      const saved = home.json.saved as Json[];
      assertEquals(saved.map((c) => c.key), ['claude:s-new', 'claude:s-old']);
      assertEquals(saved[1].title, 'Fix the checkout page');
      assertEquals(saved[1].agent, 'Claude Code');
      assertEquals(saved[1].folder, 'shop');
      assert(Math.abs(Date.parse(saved[1].lastActive as string) - (Date.now() - 7200_000)) < 120_000, String(saved[1].lastActive));
      assert(
        !home.text.includes(s.project.replaceAll('\\', '\\\\')) && !home.text.includes(s.claudeDir.replaceAll('\\', '\\\\')),
        'no paths',
      );
      // the same answer again: 304
      const again = await get(s, phone.token, `/api/remote/home?rev=${home.json.revision}`);
      assertEquals(again.status, 304);

      const one = await get(s, phone.token, '/api/remote/saved?key=claude:s-old&tail=50');
      assertEquals(one.status, 200, one.text);
      assertEquals([one.json.title, one.json.history, one.json.live], ['Fix the checkout page', true, null]);
      const events = one.json.events as Json[];
      assertEquals(events.map((e) => e.kind), ['user', 'update']);
      assertEquals((events[0].data as Json).text, 'Fix the checkout page');
      assert(JSON.stringify(events[1]).includes('Fixed it.'));
      // a chat not in the list, and a running one (the phone opens it live)
      assertEquals((await get(s, phone.token, '/api/remote/saved?key=claude:nope')).status, 404);
      const running = await get(s, phone.token, '/api/remote/saved?key=claude:s-live');
      assertEquals(running.json.live, 'c-live');

      // pictures and long chats: a pasted picture is a note, never bytes; the tail and the size budget hold
      const rows: Json[] = [];
      const stamp = new Date(Date.now() - 3600_000).toISOString();
      const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      rows.push({
        type: 'user',
        sessionId: 's-big',
        cwd: s.project,
        timestamp: stamp,
        message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }] },
      });
      for (let i = 0; i < 120; i++) {
        rows.push({
          type: i % 2 ? 'assistant' : 'user',
          sessionId: 's-big',
          cwd: s.project,
          timestamp: stamp,
          message: { role: i % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: `message ${i} ` + 'x'.repeat(7000) }] },
        });
      }
      s.saveChat({ sessionId: 's-big', rows });
      s.ctx.phone.saved.invalidate();
      const big = await get(s, phone.token, '/api/remote/saved?key=claude:s-big&tail=500');
      assertEquals(big.status, 200, big.text);
      assert(!big.text.includes(PNG), 'no picture bytes');
      assert(big.json.truncated === true);
      assert(big.bytes.byteLength < MAX_HISTORY_BYTES + 64 * 1024, `${big.bytes.byteLength} bytes`);
      assert(JSON.stringify(big.json.events).includes('message 119'), 'the newest kept');
      const tail = await get(s, phone.token, '/api/remote/saved?key=claude:s-big&tail=10');
      assert((tail.json.events as Json[]).length <= 10);
    } finally {
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'saved events in the shape phone.js draws: pictures as a note, steps, thinking left out',
  fn() {
    const out = liveShaped([
      { kind: 'user', text: '', images: [{ n: 1, i: 0, mediaType: 'image/png' }], time: '2026-11-12T10:00:00Z' },
      { kind: 'assistant', text: 'one' },
      { kind: 'assistant', text: 'two' },
      { kind: 'tool', label: 'Bash', callId: 't1', intent: 'Run the tests' },
      { kind: 'result', callId: 't1', text: 'ok' },
      { kind: 'thinking', text: 'secret thoughts' },
    ]);
    assertEquals(out.map((e) => e.kind), ['user', 'update', 'update', 'update', 'update']);
    assertEquals((out[0].data as Json).text, '[A picture: it is on your PC.]');
    assertEquals(out[0].time, Date.parse('2026-11-12T10:00:00Z') / 1000);
    assertEquals(((out[2].data as Json).update as Json).content, { type: 'text', text: '\n\ntwo' });
    assertEquals(((out[3].data as Json).update as Json).title, 'Run the tests');
    assert(!JSON.stringify(out).includes('secret thoughts'));
  },
});

Deno.test({
  ...OPTS,
  name: 'Continue this chat: saved settings only (extra fields refused), Send off refused, "open elsewhere" refused with the reason',
  async fn() {
    const s = await phoneOn();
    try {
      const phone = await pairPhone(s);
      s.saveChat({ sessionId: 's-1', prompt: 'Fix the checkout page' });
      let answer: [number, unknown] = [200, { id: 'conn-9', provider: 'claude', sessionId: 's-1' }];
      s.answerLive((name) => (name === 'connect' ? answer : [200, { ok: true }]));
      const connects = () => s.liveCalls.filter(([n]) => n === 'connect');

      // anything besides the key: refused, nothing started
      for (
        const extra of [
          { provider: 'codex' },
          { cwd: 'C:\\elsewhere' },
          { model: 'opus' },
          { mode: 'bypassPermissions' },
          { picks: { model: 'x' } },
          { config: { a: 1 } },
          { continueAnyway: true },
          { resume: 'other' },
        ]
      ) {
        const r = await post(s, phone.token, '/api/remote/continue', { key: 'claude:s-1', ...extra });
        assertEquals([r.status, r.json.code], [403, 'pc_only'], JSON.stringify(extra));
      }
      assertEquals(connects().length, 0);

      // Send off: refused (and logged), nothing started
      await pc(s, 'POST', '/api/live/devices/scopes', { id: phone.id, scopes: ['phone.read', 'phone.answer'] });
      const off = await post(s, phone.token, '/api/remote/continue', { key: 'claude:s-1' });
      assertEquals([off.status, off.json.code], [403, 'scope']);
      assert(String(off.json.error).includes('continue chats'));
      assertEquals(connects().length, 0);
      await pc(s, 'POST', '/api/live/devices/scopes', { id: phone.id, scopes: ['phone.read', 'phone.prompt'] });

      // open in another app / another AIB copy: refused with its reason, never continueAnyway
      answer = [409, {
        error:
          'AIB (PID 4242) announced that it is running this conversation (heartbeat 3 s ago). Stop it in its current client before continuing here.',
        code: 'session_in_use',
      }];
      const busy = await post(s, phone.token, '/api/remote/continue', { key: 'claude:s-1' });
      assertEquals([busy.status, busy.json.code], [409, 'session_in_use']);
      assert(String(busy.json.error).includes('AIB (PID 4242) announced'), busy.text);
      assert(String(busy.json.error).startsWith('Not continued: this chat is open somewhere else.'));
      answer = [409, { error: 'Another app may be using this conversation: Transcript was written 3 s ago.', code: 'possibly_active' }];
      const maybe = await post(s, phone.token, '/api/remote/continue', { key: 'claude:s-1' });
      assertEquals([maybe.status, maybe.json.code], [409, 'possibly_active']);
      assert(String(maybe.json.error).includes('Transcript was written 3 s ago.'), maybe.text);
      assert(String(maybe.json.error).includes('continue it in AIB on your PC'));

      // continued: exactly the saved chat's agent, folder and session
      answer = [200, { id: 'conn-9', provider: 'claude', sessionId: 's-1' }];
      const ok = await post(s, phone.token, '/api/remote/continue', { key: 'claude:s-1' });
      assertEquals([ok.status, ok.json.id], [200, 'conn-9'], ok.text);
      for (const [, body] of connects()) {
        assertEquals(body, { provider: 'claude', cwd: s.project, resume: 's-1', background: true });
      }
      assertEquals(connects().length, 3);
      // not listed: refused
      assertEquals((await post(s, phone.token, '/api/remote/continue', { key: 'claude:nope' })).status, 404);

      const lines = audit(s).filter((l) => l.action === 'continue').map((l) => [l.chat, l.result]);
      assertEquals(lines.slice(0, 8).every(([, r]) => r === 'refused: settings'), true);
      assertEquals(lines.slice(8), [
        ['claude:s-1', 'refused: switched off'],
        ['claude:s-1', 'refused: session_in_use'],
        ['claude:s-1', 'refused: possibly_active'],
        ['conn-9', 'started on the PC'],
        ['claude:nope', 'refused: not_found'],
      ]);
      assert(!JSON.stringify(audit(s)).includes('checkout'), 'no chat text in the log');
    } finally {
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'reading on the phone marks the chat read on the PC (same read-state store), throttled; See chats off -> refused',
  async fn() {
    const s = await phoneOn();
    try {
      const phone = await pairPhone(s);
      const ended = new Date(Date.now() - 5000).toISOString();
      s.chats.push(live(s, 'c1', 's-read', {
        attention: { state: 'idle', needs: 0, turnEndedAt: ended, busySince: null },
        events: [
          { seq: 1, kind: 'user', time: (Date.now() - 60_000) / 1000, data: { text: 'hi' } },
          { seq: 2, kind: 'turn_end', time: Date.parse(ended) / 1000, data: {} },
        ],
      }));
      const [, before] = await pc(s, 'GET', '/api/live/list');
      // an older event: read up to that event's time (still unread on the PC: the turn ended later)
      const older = await post(s, phone.token, '/api/remote/read', { id: 'c1', seq: 1 });
      assertEquals([older.status, older.json.marked], [200, true], older.text);
      const first = (await pc(s, 'GET', '/api/live/read-state'))[1].chats as Record<string, Json>;
      assert((first['claude:s-read'].seenAt as number) < Date.parse(ended));
      // within READ_GAP_MS: not written again
      const quick = await post(s, phone.token, '/api/remote/read', { id: 'c1', seq: 2 });
      assertEquals(quick.json.throttled, true);
      await new Promise((r) => setTimeout(r, READ_GAP_MS + 100));
      const newest = await post(s, phone.token, '/api/remote/read', { id: 'c1', seq: 2 });
      assertEquals([newest.status, newest.json.marked], [200, true], newest.text);
      const seen = ((await pc(s, 'GET', '/api/live/read-state'))[1].chats as Record<string, Json>)['claude:s-read'];
      assert((seen.seenAt as number) >= Date.parse(ended), 'read past the end of the turn: the PC dot clears');
      const [, after] = await pc(s, 'GET', '/api/live/list');
      assert(after.readStateRevision !== before.readStateRevision, 'the PC list tells the page to fetch read positions again');
      // a chat that is not running: nothing to mark
      assertEquals((await post(s, phone.token, '/api/remote/read', { id: 'gone', seq: 1 })).json.code, 'not_live');
      assertEquals((await post(s, phone.token, '/api/remote/read', { id: 'c1' })).status, 400);
      // one log line per chat, no text
      const reads = audit(s).filter((l) => l.action === 'read');
      assertEquals(reads.map((l) => [l.chat, l.result]), [['c1', 'marked read on the PC']]);
      // See chats off (the PC never offers it, so the phone's record is edited here): refused
      s.ctx.phone.devices.devices.get(phone.id)!.scopes = ['phone.prompt'];
      const refused = await post(s, phone.token, '/api/remote/read', { id: 'c1', seq: 2 });
      assertEquals([refused.status, refused.json.code], [403, 'scope']);
      assertEquals((await get(s, phone.token, '/api/remote/saved?key=claude:s-read')).status, 403);
    } finally {
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'paired phones never expire: last seen years ago still works; a device store clock years ahead still finds it',
  async fn() {
    const s = await phoneOn();
    try {
      const phone = await pairPhone(s);
      const file = s.state + SEP + 'devices.json';
      const data = JSON.parse(Deno.readTextFileSync(file));
      for (const d of data.devices) {
        d.created = 1;
        d.lastSeen = 1; // 1970
      }
      Deno.writeTextFileSync(file, JSON.stringify(data));
      // read fresh from the file (as after a restart): seen in 1970, still paired
      const fresh = new DeviceStore(s.state);
      assertEquals(fresh.byToken(phone.token)?.lastSeen, 1);
      const home = await get(s, phone.token, '/api/remote/home');
      assertEquals(home.status, 200, home.text);

      const later = new DeviceStore(s.state, () => Date.now() / 1000 + 5 * 365 * 86400);
      assert(later.byToken(phone.token) !== null, 'found five years later');
      assert(later.byCookie(phone.cookie) !== null, 'its picture cookie too');
    } finally {
      await s.close();
    }
  },
});
