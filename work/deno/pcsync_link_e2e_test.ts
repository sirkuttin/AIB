/**
 * Sync between PCs, slice V2: the link (server/pcsync/link.ts, frames.ts). Two in-process AIB servers (_pcsync_fixture.ts: temp
 * state folders, fake Tailscale CLI, a Serve stand-in that adds Host and login and relays the sync WebSocket), ports from the OS.
 * Covered: connect (token in the first frame, no Origin, keep-alive pings, a batch frame), refusals (wrong Host, any Origin, a phone
 * token, no token, a first frame that is not a hello, a silent socket), an oversized frame closes the link, both PCs dialing at once
 * leave exactly one link, a restart comes back within 10 s, a removed peer's link drops at once, a peer shown online by Tailscale is
 * dialed at once whatever the backoff, one owner per state folder.
 */
import { assert, assertEquals } from './_assert.ts';
import { pairPhone, pc, raw } from './_remote_fixture.ts';
import { PcSync } from '../../app/server/pcsync/service.ts';
import {
  approveAndWait,
  closeAll,
  type Json,
  linked,
  type Node,
  pair,
  paired,
  reach,
  serveHeaders,
  TEST_LINK,
  tokenToA,
  tokenToB,
  twoNodes,
  until,
} from './_pcsync_fixture.ts';

const OPTS = { sanitizeResources: false, sanitizeOps: false };

/** A WebSocket to a PC's sync address, through its Serve stand-in (which adds Host and the login), as another program on the tailnet. */
function socket(n: Node) {
  const ws = new WebSocket(`ws://127.0.0.1:${(n.front.addr as Deno.NetAddr).port}/pcsync/sync`);
  const messages: string[] = [];
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.onclose = (e) => resolve({ code: e.code, reason: e.reason });
    ws.onerror = () => {};
  });
  const opened = new Promise<boolean>((resolve) => {
    ws.onopen = () => resolve(true);
    ws.addEventListener('close', () => resolve(false));
  });
  ws.onmessage = (e) => messages.push(String(e.data));
  return { ws, messages, closed, opened };
}

/** The status line of a WebSocket upgrade request (raw(): a refused upgrade keeps its connection open, so read only the head). */
async function upgradeStatus(port: number, headers: Record<string, string>): Promise<number> {
  const conn = await Deno.connect({ hostname: '127.0.0.1', port });
  try {
    const lines = Object.entries(headers).map(([k, v]) => `${k}: ${v}`);
    const head = ['GET /pcsync/sync HTTP/1.1', ...lines, '', ''].join('\r\n');
    await conn.write(new TextEncoder().encode(head));
    const buf = new Uint8Array(4096);
    const n = await conn.read(buf);
    return Number(new TextDecoder().decode(buf.subarray(0, n ?? 0)).match(/^HTTP\/1\.1 (\d+)/)?.[1] ?? 0);
  } finally {
    conn.close();
  }
}

const hello = (token?: string, host = 'ubuntu-pc.tail-a1b2.ts.net') =>
  JSON.stringify({ t: 'hello', v: 1, ...(token ? { token } : {}), name: 'ubuntu-pc', host });

/** B's link to A is stopped, so a program playing B can take B's place on A's listener. */
function silenceB(b: Node) {
  b.s.ctx.pcsync.links.stop();
}

Deno.test({
  ...OPTS,
  name: 'connect: both PCs show Connected, the token travels in the first frame only, no Origin, pings keep it up, a batch frame arrives',
  async fn() {
    const [a, b] = await paired();
    try {
      await until('both ends connected', async () => (await reach(a)) === 'online' && (await reach(b)) === 'online');
      assertEquals(linked(a).length, 1);
      assertEquals(linked(b).length, 1);
      // the stand-ins saw upgrade requests: no Origin, no token in the address or in any header
      const seen = [...a.upgrades, ...b.upgrades];
      assert(seen.length > 0);
      const tokens = [tokenToA(b), tokenToB(a)];
      for (const h of seen) {
        assert(!h.has('origin'), 'a sync socket carries no Origin');
        for (const [, v] of h) for (const t of tokens) assert(!v.includes(t), 'the token is not in a header');
      }
      // pings keep a quiet link up longer than the idle limit (2 s here)
      const first = linked(a)[0];
      await new Promise((r) => setTimeout(r, 2600));
      assertEquals(linked(a).length, 1);
      assertEquals(linked(b).length, 1);
      assertEquals(first.peerId, linked(a)[0].peerId);
      // the Sync card says Connected, and the card is shown by the page route
      const [, view] = await pc(a.s, 'GET', '/api/live/pcsync');
      assertEquals((view.peers as Json[])[0].reach, 'online');
      // a batch frame goes across and is handed on (later slices fill it); a bad one is not
      const got: Json[] = [];
      (b.s.ctx.pcsync.options as { onBatch?: (p: unknown, batch: Json) => void }).onBatch = (_p, batch) => got.push(batch as Json);
      assert(
        a.s.ctx.pcsync.links.sendBatch(a.s.ctx.pcsync.peers.list()[0].id, {
          id: 'b1',
          items: [{ op: 'stat', area: 'shared', path: 'notes/a.md' }],
        }),
      );
      await until('the batch arrives', () => got.length === 1);
      assertEquals(got[0].id, 'b1');
    } finally {
      await closeAll([a, b]);
    }
  },
});

Deno.test({
  ...OPTS,
  name:
    '/pcsync/sync refuses: a wrong Host, any Origin, no login, another login, page credentials, a plain GET; accepts the upgrade otherwise',
  async fn() {
    const [a, b] = await paired();
    try {
      silenceB(b);
      const upgrade = (extra: Record<string, string | null>) =>
        upgradeStatus(a.s.ctx.pcsync.port, {
          ...serveHeaders(a, extra),
          Upgrade: 'websocket',
          Connection: 'Upgrade',
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version': '13',
        });
      assertEquals(await upgrade({ Host: 'evil.example' }), 403, 'a wrong Host');
      assertEquals(await upgrade({ Host: `127.0.0.1:${a.s.ctx.pcsync.port}` }), 403, 'a loopback Host');
      assertEquals(await upgrade({ Origin: `https://${a.name}` }), 403, 'an Origin of this PC');
      assertEquals(await upgrade({ Origin: 'https://evil.example' }), 403, 'an Origin of a web page');
      assertEquals(await upgrade({ Origin: 'null' }), 403, 'a null Origin');
      assertEquals(await upgrade({ 'Tailscale-User-Login': null }), 403, 'no login');
      assertEquals(await upgrade({ 'Tailscale-User-Login': 'someone@else.example' }), 403, 'another login');
      for (const header of ['X-Studio-Token', 'X-AIB-Page-Key', 'X-Studio-Artifact-Key', 'X-Studio-Hook-Key']) {
        assertEquals(await upgrade({ [header]: 'x' }), 403, header);
      }
      const plain = await raw(a.s.ctx.pcsync.port, 'GET', '/pcsync/sync', serveHeaders(a));
      assertEquals(plain.status, 426, 'a GET that is not an upgrade');
      const through = socket(a);
      assert(await through.opened, 'the right headers are let through to the socket');
      through.ws.close(1000);
      // the token in the address or a header is no way in: only the first frame counts
      const { ws, closed } = socket(a);
      await new Promise((r) => (ws.onopen = r));
      ws.send(hello());
      assertEquals((await closed).code, 4401);
    } finally {
      await closeAll([a, b]);
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'the first frame: a phone token, a computer token, a wrong token, no token, a frame that is not a hello, silence, a hello too big',
  async fn() {
    const [a, b] = await paired();
    try {
      const [accessStatus] = await pc(a.s, 'POST', '/api/live/devices/access', { on: true });
      assertEquals(accessStatus, 200);
      const phone = await pairPhone(a.s, 'Pixel');
      const computer = await pairPhone(a.s, 'Laptop', undefined, 'computer');
      silenceB(b);
      const closeCode = async (first: string | null) => {
        const s = socket(a);
        assert(await s.opened, 'the upgrade is accepted; the first frame decides');
        if (first !== null) s.ws.send(first);
        return (await s.closed).code;
      };
      assertEquals(await closeCode(hello(phone.token)), 4401, 'a phone token');
      assertEquals(await closeCode(hello(computer.token)), 4401, 'a computer token');
      assertEquals(await closeCode(hello('x'.repeat(43))), 4401, 'a wrong token');
      assertEquals(await closeCode(hello()), 4401, 'no token');
      assertEquals(await closeCode(hello(tokenToA(b), 'friend.tail-a1b2.ts.net')), 4401, 'a good token from another PC name');
      assertEquals(await closeCode(JSON.stringify({ t: 'ping' })), 4400, 'a first frame that is not hello');
      assertEquals(await closeCode('not json'), 4400, 'not JSON');
      assertEquals(await closeCode(hello(tokenToA(b)) + ' '.repeat(5000)), 4413, 'a first frame over 4 KB');
      assertEquals(await closeCode(null), 4408, 'silence: no first frame in time');
      assertEquals(linked(a).length, 0, 'none of them became a link');
      // the right token from the right PC does become one
      const ok = socket(a);
      await ok.opened;
      ok.ws.send(hello(tokenToA(b)));
      await until('a hello answers', () => ok.messages.length >= 1);
      assertEquals(JSON.parse(ok.messages[0]).t, 'hello');
      assertEquals(linked(a).length, 1);
      ok.ws.close(1000);
    } finally {
      await closeAll([a, b]);
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'a frame over the cap, a binary frame and a frame that does not validate close the link',
  async fn() {
    const [a, b] = await paired();
    try {
      silenceB(b);
      const open = async () => {
        const s = socket(a);
        await s.opened;
        s.ws.send(hello(tokenToA(b)));
        await until('linked', () => s.messages.length >= 1 && linked(a).length === 1);
        return s;
      };
      let s = await open();
      s.ws.send(JSON.stringify({ t: 'batch', id: 'big', items: [], pad: 'x'.repeat(1024 * 1024 + 10) }));
      assertEquals((await s.closed).code, 4413, 'over 1 MB');
      await until('A shows the link gone', () => linked(a).length === 0);
      s = await open();
      s.ws.send(new Uint8Array([1, 2, 3]));
      assertEquals((await s.closed).code, 4415, 'binary');
      await until('gone', () => linked(a).length === 0);
      s = await open();
      s.ws.send(JSON.stringify({ t: 'batch', id: 'x', items: [{ op: 'put', area: 'shared', path: '../../x' }] }));
      assertEquals((await s.closed).code, 4400, 'a path outside the project');
      await until('gone', () => linked(a).length === 0);
      s = await open();
      s.ws.send(JSON.stringify({ t: 'batch', id: 'x', items: [{ op: 'put', area: 'shared', root: 'C:\\' }] }));
      assertEquals((await s.closed).code, 4400, 'a root in an item');
      await until('gone', () => linked(a).length === 0);
      // a good frame keeps the link open
      s = await open();
      s.ws.send(JSON.stringify({ t: 'ping' }));
      await until('pong', () => s.messages.some((m) => JSON.parse(m).t === 'pong'));
      assertEquals(linked(a).length, 1);
      s.ws.close(1000);
    } finally {
      await closeAll([a, b]);
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'both PCs dial at once: exactly one link remains, the one the lower tailnet name dialed, and it stays',
  async fn() {
    const [a, b] = await paired();
    try {
      for (let round = 0; round < 4; round++) {
        a.s.ctx.pcsync.links.stop();
        b.s.ctx.pcsync.links.stop();
        await until('both idle', () => linked(a).length === 0 && linked(b).length === 0);
        a.s.ctx.pcsync.links.start();
        b.s.ctx.pcsync.links.start(); // both dial in the same moment
        await until(`round ${round}: one link each`, () => linked(a).length === 1 && linked(b).length === 1);
        await new Promise((r) => setTimeout(r, 700)); // the losing dial's close arrives; the survivor is not disturbed
        assertEquals(linked(a).length, 1, `round ${round}`);
        assertEquals(linked(b).length, 1, `round ${round}`);
        assertEquals([linked(a)[0].dir, linked(b)[0].dir], ['out', 'in'], 'the PC with the lower name dialed the kept link');
        assertEquals(await reach(a), 'online');
        assertEquals(await reach(b), 'online');
      }
    } finally {
      await closeAll([a, b]);
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'B restarts: the link comes back within 10 s; a PC that is down shows Offline and comes back when it is up',
  async fn() {
    const [a, b] = await paired();
    try {
      await until('connected', async () => (await reach(a)) === 'online' && (await reach(b)) === 'online');
      const t0 = Date.now();
      await b.restart();
      await until('A sees B again', async () => (await reach(a)) === 'online' && linked(b).length === 1, 10_000);
      assert(Date.now() - t0 < 10_000, `back after ${Date.now() - t0} ms`);
      assertEquals(await reach(b), 'online');
      // the other way: A restarts
      await a.restart();
      await until('B sees A again', async () => (await reach(b)) === 'online' && linked(a).length === 1, 10_000);
      // B goes down (not answering): A shows Offline; when B is up again the link returns by itself
      b.up = false;
      for (const c of [...b.sockets, ...a.sockets]) c.close();
      await until('A shows B offline', async () => ['offline', 'connecting'].includes(await reach(a)));
      b.up = true;
      await until('connected again', async () => (await reach(a)) === 'online', 10_000);
    } finally {
      await closeAll([a, b]);
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'a removed peer: its link drops at once on both PCs and it cannot connect again',
  async fn() {
    const [a, b] = await paired();
    try {
      await until('connected', async () => (await reach(a)) === 'online' && (await reach(b)) === 'online');
      const peerId = a.s.ctx.pcsync.peers.list()[0].id;
      const t0 = Date.now();
      const [status, removed] = await pc(a.s, 'POST', '/api/live/pcsync/remove', { id: peerId });
      assertEquals(status, 200);
      assertEquals(linked(a).length, 0, 'A dropped the link before the answer came back');
      await until('B dropped it too', () => linked(b).length === 0, 1000);
      assert(Date.now() - t0 < 1000, 'within a second');
      assertEquals(removed.notified, true);
      // neither PC dials the other any more: no peer, no link
      await new Promise((r) => setTimeout(r, 700));
      assertEquals(linked(a).length + linked(b).length, 0);
      // a removal B was not told about: B's token is dead, B shows that it is refused, and A stops it at once
      const again = await pair(a, b);
      await approveAndWait(a, b, again.claim);
      await until('linked again', async () => (await reach(a)) === 'online' && (await reach(b)) === 'online');
      b.up = false;
      const id2 = a.s.ctx.pcsync.peers.list()[0].id;
      const [, gone] = await pc(a.s, 'POST', '/api/live/pcsync/remove', { id: id2 });
      assertEquals(gone.notified, false);
      assertEquals(linked(a).length, 0, 'A drops its link at once');
      b.up = true;
      await until('B shows it is refused', async () => (await reach(b)) === 'refused', 6000);
      assertEquals(linked(a).length + linked(b).length, 0);
    } finally {
      await closeAll([a, b]);
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'a peer that Tailscale shows online is dialed at once, whatever the backoff says',
  async fn() {
    const [a, b] = await twoNodes({ ...TEST_LINK, backoffMin: 60_000, backoffMax: 300_000 });
    try {
      const { claim } = await pair(a, b);
      await approveAndWait(a, b, claim);
      await until('connected', async () => (await reach(a)) === 'online' && (await reach(b)) === 'online');
      // both PCs go dark: the link is cut and every dial fails, so each backs off for a minute
      a.up = false;
      b.up = false;
      a.otherOnline = false;
      b.otherOnline = false;
      for (const c of [...a.sockets, ...b.sockets]) c.close();
      await until('both Offline', async () => (await reach(a)) !== 'online' && (await reach(b)) !== 'online');
      await new Promise((r) => setTimeout(r, 700)); // the poll sees them offline
      const t0 = Date.now();
      a.up = true;
      b.up = true;
      a.otherOnline = true;
      b.otherOnline = true;
      await until(
        'connected within seconds, not a minute',
        async () => (await reach(a)) === 'online' && (await reach(b)) === 'online',
        5000,
      );
      assert(Date.now() - t0 < 5000);
    } finally {
      await closeAll([a, b]);
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'one owner per state folder: a second AIB on the same state refuses, and Share sync does not take over another AIB on this PC',
  async fn() {
    const [a, b] = await paired();
    const dummy = Deno.listen({ hostname: '127.0.0.1', port: 0 });
    try {
      // a second AIB on this state folder and the same sync port
      const second = new PcSync(a.s.state, { runner: a.s.ctx.pcsync.options.runner, port: a.s.ctx.pcsync.port });
      await second.start();
      assertEquals(second.listening, false);
      assertEquals(second.problem, 'Sync runs in another AIB on this PC.');
      assertEquals(second.links.running, false, 'and it does not dial');
      await second.close();
      assertEquals(linked(a).length <= 1, true);
      // https 8444 already goes to another AIB's live listener on this PC: Share sync refuses and leaves it
      a.serveTo = `http://127.0.0.1:${(dummy.addr as Deno.NetAddr).port}`;
      const before = a.calls.length;
      const [status, r] = await pc(a.s, 'POST', '/api/live/pcsync/share', {});
      assertEquals([status, r.code], [409, 'another_aib']);
      assert(String(r.error).startsWith('Sync runs in another AIB on this PC.'));
      assert(!a.calls.slice(before).some((c) => c[0] === 'serve' && c.includes('--bg')), 'AIB did not change the share');
      // a stale share to a dead port is not an owner: it is replaced
      dummy.close();
      const [status2] = await pc(a.s, 'POST', '/api/live/pcsync/share', {});
      assertEquals(status2, 200);
    } finally {
      try {
        dummy.close();
      } catch { /* closed */ }
      await closeAll([a, b]);
    }
  },
});
