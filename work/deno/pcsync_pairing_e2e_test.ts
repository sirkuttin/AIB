/**
 * Sync between PCs, slice V1: peer pairing (server/pcsync/). Two in-process AIB servers with their own temp state folders, a fake
 * Tailscale CLI per PC (two tailnet names, the same login) and a "Serve" stand-in in front of each sync listener (it adds the Host
 * and Tailscale-User-Login headers, as _remote_fixture.ts does for the phone port). Covered:
 *   - the full pairing: six words on A, B picks A from its Tailscale devices, both show the same two check words, Approve on A
 *   - wrong words refused (three wrong end the code; a second claimer is refused and A says so), Reject, nothing trusted before Approve
 *   - the peer lives only in pcsync/peers.json (its dialing token sealed on Windows); devices.json never has it
 *   - a peer token is refused on every page route, phone route and remote-PC bridge route and socket; the listener's own gate
 *   - Remove revokes the token at once, on both sides when reachable
 */
import { assert, assertEquals } from './_assert.ts';
import { ROUTE_LIST } from '../../outputs/agent-studio/server/web/routes.ts';
import { ROUTE_SCOPE } from '../../outputs/agent-studio/server/remote/server.ts';
import { readRemotePort } from '../../outputs/agent-studio/server/remote/port.ts';
import { DEVICE_HEADER, DEVICE_PROTOCOL_PREFIX, RateLimit } from '../../outputs/agent-studio/server/remote/pc_bridge.ts';
import { PeerStore } from '../../outputs/agent-studio/server/pcsync/peers.ts';
import type { Runner } from '../../outputs/agent-studio/server/remote/tailscale.ts';
import { LOGIN, nonce, pairPhone, pc, phoneHeaders, raw, type RemoteStudio, remoteStudio, tailscaleStatus } from './_remote_fixture.ts';

const OPTS = { sanitizeResources: false, sanitizeOps: false };
type Json = Record<string, unknown>;
const WIN = Deno.build.os === 'windows';
const sep = WIN ? '\\' : '/';

interface Node {
  s: RemoteStudio;
  name: string;
  machine: string;
  shared: boolean;
  calls: string[][];
  proxy: Deno.HttpServer;
  up: boolean;
}

/** Two PCs on one tailnet, the same Tailscale login, each with the other as a peer in `tailscale status --json`. */
async function twoNodes(): Promise<[Node, Node]> {
  const urls = new Map<string, string>();
  const nodes: Node[] = [];
  const spec = [
    ['studio-pc.tail-a1b2.ts.net', 'studio-pc', 'windows'],
    ['ubuntu-pc.tail-a1b2.ts.net', 'ubuntu-pc', 'linux'],
  ];
  for (const [name, machine] of spec) {
    const other = spec.find(([n]) => n !== name)!;
    const node = { name, machine, shared: true, calls: [] as string[][], up: true } as Node;
    const runner: Runner = (args) => {
      node.calls.push(args);
      if (args[0] === 'status') {
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify(tailscaleStatus({
            Self: { DNSName: name + '.', HostName: machine, UserID: 42 },
            CertDomains: [name],
            Peer: {
              'nodekey:other': { DNSName: other[0] + '.', HostName: other[1], UserID: 42, Online: true, OS: other[2] },
              'nodekey:friend': { DNSName: 'friend.tail-a1b2.ts.net.', HostName: 'friend', UserID: 99, Online: true, OS: 'linux' },
            },
          })),
        });
      }
      if (args[0] === 'serve' && args[1] === 'status') {
        const web: Json = {};
        const phone = readRemotePort(node.s.state);
        if (phone) web[`${name}:443`] = { Handlers: { '/': { Proxy: `http://127.0.0.1:${phone}` } } };
        if (node.shared) web[`${name}:8444`] = { Handlers: { '/': { Proxy: `http://127.0.0.1:${node.s.ctx.pcsync.port}` } } };
        return Promise.resolve({ code: 0, stdout: JSON.stringify({ Web: web }) });
      }
      if (args[0] === 'serve' && args.includes('--bg')) {
        node.shared = true;
        return Promise.resolve({ code: 0, stdout: '' });
      }
      return Promise.resolve({ code: 1, stdout: '' });
    };
    node.s = await remoteStudio({ runner }, undefined, {
      saved: true,
      pcsync: { runner, port: 0, pollMs: 50, reachMs: 100, peerUrl: (host) => urls.get(host) ?? 'http://127.0.0.1:1' },
    });
    // Tailscale Serve's stand-in: the real listener gets the Host and login Serve would add
    node.proxy = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen: () => {} }, async (request) => {
      if (!node.up) return new Response('down', { status: 503 });
      const url = new URL(request.url);
      const body = request.method === 'GET' ? undefined : await request.text();
      const r = await raw(node.s.ctx.pcsync.port, request.method, url.pathname, { Host: name, 'Tailscale-User-Login': LOGIN }, body);
      return new Response(r.text, { status: r.status, headers: { 'Content-Type': 'application/json' } });
    });
    urls.set(name, `http://127.0.0.1:${(node.proxy.addr as Deno.NetAddr).port}`);
    nodes.push(node);
  }
  return [nodes[0], nodes[1]];
}

async function closeAll(nodes: Node[]) {
  for (const n of nodes) {
    await n.proxy.shutdown().catch(() => {});
    await n.s.close();
  }
}

/** The headers Tailscale Serve puts on a request to the sync listener. */
const serveHeaders = (n: Node, extra: Record<string, string | null> = {}) => {
  const out: Record<string, string> = { Host: n.name, 'Tailscale-User-Login': LOGIN };
  for (const [k, v] of Object.entries(extra)) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
};
const listener = (n: Node, path: string, body: Json, extra: Record<string, string | null> = {}) =>
  raw(n.s.ctx.pcsync.port, 'POST', path, serveHeaders(n, extra), JSON.stringify(body));

async function until(what: string, fn: () => boolean | Promise<boolean>, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`timed out: ${what}`);
}

/** The full pairing through the page routes of both PCs. Returns the words, the check words and each side's dialing token. */
async function pair(a: Node, b: Node) {
  const [startStatus, start] = await pc(a.s, 'POST', '/api/live/pcsync/start', {});
  assertEquals(startStatus, 200, JSON.stringify(start));
  const words = (start.words as string[]).join(' ');
  const [, list] = await pc(b.s, 'GET', '/api/live/pcsync/devices');
  const devices = list.devices as Json[];
  assertEquals(devices.map((d) => d.host), [a.name], "only this Tailscale user's other PCs are offered, not a friend's");
  const [joinStatus, join] = await pc(b.s, 'POST', '/api/live/pcsync/join', { host: a.name, code: words });
  assertEquals(joinStatus, 200, JSON.stringify(join));
  const [, view] = await pc(a.s, 'GET', '/api/live/pcsync');
  const pending = (view.pairing as Json).pending as Json[];
  assertEquals(pending.length, 1);
  const [, bView] = await pc(b.s, 'GET', '/api/live/pcsync');
  return {
    words,
    aCheck: pending[0].checkWords as string[],
    bCheck: (bView.join as Json).checkWords as string[],
    claim: pending[0].id as string,
  };
}

async function approveAndWait(a: Node, b: Node, claim: string) {
  const [status, approved] = await pc(a.s, 'POST', '/api/live/pcsync/approve', { claim });
  assertEquals(status, 200, JSON.stringify(approved));
  await until('B holds A as a peer', () => b.s.ctx.pcsync.peers.list().length === 1);
}

const tokenToA = (b: Node) => b.s.ctx.pcsync.peers.outToken(b.s.ctx.pcsync.peers.list()[0])!;
const tokenToB = (a: Node) => a.s.ctx.pcsync.peers.outToken(a.s.ctx.pcsync.peers.list()[0])!;

Deno.test({
  ...OPTS,
  name:
    'pairing: six words on A, B picks A and types them, both show the same two check words, Approve on A; the peers are only in pcsync/peers.json',
  async fn() {
    const [a, b] = await twoNodes();
    try {
      // before anything: sync is off, nothing listens, nothing is paired
      const [, off] = await pc(a.s, 'GET', '/api/live/pcsync');
      assertEquals(off.on, false);
      assertEquals(off.listening, false);
      const { aCheck, bCheck, claim } = await pair(a, b);
      assertEquals(aCheck.length, 2);
      assertEquals(aCheck, bCheck, 'both screens show the same two check words');
      // nothing is trusted before Approve
      assertEquals(a.s.ctx.pcsync.peers.list().length, 0);
      assertEquals(b.s.ctx.pcsync.peers.list().length, 0);
      await approveAndWait(a, b, claim);
      assertEquals(a.s.ctx.pcsync.peers.list().length, 1);
      const [, aView] = await pc(a.s, 'GET', '/api/live/pcsync');
      const [, bView] = await pc(b.s, 'GET', '/api/live/pcsync');
      assertEquals((aView.peers as Json[])[0].name, 'ubuntu-pc');
      assertEquals((aView.peers as Json[])[0].host, b.name);
      assertEquals((bView.peers as Json[])[0].name, 'studio-pc');
      assertEquals(aView.pairing as Json | null, null, 'the code is used up');
      // the two tokens work each way on the sync listener (hello)
      const toA = await listener(a, '/pcsync/hello', { token: tokenToA(b) });
      assertEquals(toA.status, 200, toA.text);
      const toB = await listener(b, '/pcsync/hello', { token: tokenToB(a) });
      assertEquals(toB.status, 200, toB.text);
      // the peer is stored in pcsync/peers.json only, with only a hash of what it presents and its dialing token sealed
      for (const n of [a, b]) {
        const file = `${n.s.state}${sep}pcsync${sep}peers.json`;
        const text = Deno.readTextFileSync(file);
        const saved = JSON.parse(text);
        assertEquals(saved.peers.length, 1);
        const other = n === a ? b : a;
        const plain = n === a ? tokenToB(a) : tokenToA(b);
        assert(!text.includes(plain) || !WIN, 'the dialing token is not in the file in plain text (Windows seals it)');
        if (WIN) assert(String(saved.peers[0].out).startsWith('dpapi:v1:'), 'sealed with DPAPI');
        assertEquals(saved.peers[0].host, other.name);
        assert(/^[0-9a-f]{64}$/.test(saved.peers[0].inHash));
        // devices.json (phones and computers) never has the peer
        assertEquals(n.s.ctx.phone.devices.list().length, 0);
        let devices = '';
        try {
          devices = Deno.readTextFileSync(`${n.s.state}${sep}remote${sep}devices.json`);
        } catch { /* never written */ }
        try {
          devices += Deno.readTextFileSync(`${n.s.state}${sep}devices.json`);
        } catch { /* never written */ }
        assert(!devices.includes(other.name) && !devices.includes(saved.peers[0].id), 'devices.json never contains the peer');
        // a restart reads the same peers
        const again = new PeerStore(n.s.state);
        assertEquals(again.list().length, 1);
        assert(again.on);
      }
      // the same file reloaded accepts the token (a restart keeps the pairing)
      assert(new PeerStore(a.s.state).byToken(tokenToA(b)) !== null);
    } finally {
      await closeAll([a, b]);
    }
  },
});

Deno.test({
  ...OPTS,
  name:
    'pairing: wrong words are refused (three end the code), a second claimer is refused, Reject ends the join, bad requests are refused',
  async fn() {
    const [a, b] = await twoNodes();
    try {
      const [, start] = await pc(a.s, 'POST', '/api/live/pcsync/start', {});
      const words = (start.words as string[]).join(' ');
      const wrong = ['amber', 'anchor', 'apple', 'april', 'arrow', 'atlas'].join(' ');
      assert(wrong !== words);
      let [status, r] = await pc(b.s, 'POST', '/api/live/pcsync/join', { host: a.name, code: wrong });
      assertEquals([status, r.code], [403, 'wrong_code']);
      [status, r] = await pc(b.s, 'POST', '/api/live/pcsync/join', { host: a.name, code: 'not six words' });
      assertEquals([status, r.code], [400, 'bad_code']);
      [status, r] = await pc(b.s, 'POST', '/api/live/pcsync/join', { host: 'friend.tail-a1b2.ts.net', code: words });
      assertEquals([status, r.code], [404, 'no_such_pc'], 'a device of another Tailscale user is not offered or accepted');
      [status, r] = await pc(b.s, 'POST', '/api/live/pcsync/join', { host: a.name, code: wrong });
      assertEquals(status, 403);
      [status, r] = await pc(b.s, 'POST', '/api/live/pcsync/join', { host: a.name, code: wrong });
      assertEquals([status, r.code], [403, 'wrong_code']);
      assert(String(r.error).includes('three times'), String(r.error));
      // the right words no longer work
      [status, r] = await pc(b.s, 'POST', '/api/live/pcsync/join', { host: a.name, code: words });
      assertEquals([status, r.code], [410, 'expired']);
      assertEquals(b.s.ctx.pcsync.peers.list().length, 0);
      assertEquals(a.s.ctx.pcsync.peers.list().length, 0);

      // a fresh code: the first right claim wins, a second claimer is refused and A says so
      const [, start2] = await pc(a.s, 'POST', '/api/live/pcsync/start', {});
      const words2 = (start2.words as string[]).join(' ');
      [status, r] = await pc(b.s, 'POST', '/api/live/pcsync/join', { host: a.name, code: words2 });
      assertEquals(status, 200, JSON.stringify(r));
      const second = await listener(a, '/pcsync/pair/claim', {
        code: words2,
        name: 'intruder',
        nonce: nonce(),
        host: b.name,
        token: 'x'.repeat(43),
      });
      assertEquals([second.status, second.json.code], [409, 'already_used']);
      const [, view] = await pc(a.s, 'GET', '/api/live/pcsync');
      assertEquals((view.pairing as Json).anotherTried, true);
      // Reject: B's join ends, nothing is paired
      const claim = ((view.pairing as Json).pending as Json[])[0].id;
      await pc(a.s, 'POST', '/api/live/pcsync/reject', { claim });
      await until('B sees the rejection', async () => {
        const [, v] = await pc(b.s, 'GET', '/api/live/pcsync');
        return (v.join as Json | null)?.state === 'rejected';
      });
      assertEquals(a.s.ctx.pcsync.peers.list().length + b.s.ctx.pcsync.peers.list().length, 0);
      // approving a claim that is gone is refused
      [status, r] = await pc(a.s, 'POST', '/api/live/pcsync/approve', { claim });
      assertEquals([status, r.code], [404, 'no_claim']);
    } finally {
      await closeAll([a, b]);
    }
  },
});

Deno.test({
  ...OPTS,
  name: "the sync listener's gate: Host, login, Origin, page credentials, sockets, other paths, bad bodies and tokens",
  async fn() {
    const [a, b] = await twoNodes();
    try {
      const { claim } = await pair(a, b);
      await approveAndWait(a, b, claim);
      const token = tokenToA(b);
      const ok = await listener(a, '/pcsync/hello', { token });
      assertEquals(ok.status, 200);
      const refused = async (what: string, r: Promise<{ status: number; json: Json }>, status = 403) => {
        const got = await r;
        assertEquals(got.status, status, `${what}: ${JSON.stringify(got.json)}`);
      };
      await refused('wrong Host', listener(a, '/pcsync/hello', { token }, { Host: 'evil.example' }));
      await refused('loopback Host', listener(a, '/pcsync/hello', { token }, { Host: `127.0.0.1:${a.s.ctx.pcsync.port}` }));
      await refused('no login', listener(a, '/pcsync/hello', { token }, { 'Tailscale-User-Login': null }));
      await refused('another login', listener(a, '/pcsync/hello', { token }, { 'Tailscale-User-Login': 'someone@else.example' }));
      await refused('an Origin (a web page)', listener(a, '/pcsync/hello', { token }, { Origin: `https://${a.name}` }));
      for (const header of ['X-Studio-Token', 'X-AIB-Page-Key', 'X-Studio-Artifact-Key', 'X-Studio-Hook-Key']) {
        await refused(header, listener(a, '/pcsync/hello', { token }, { [header]: 'x' }));
      }
      const socket = await listener(a, '/pcsync/hello', { token }, {
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
      });
      assert(socket.status === 400 || socket.status === 403, `a WebSocket: ${socket.status}`);
      await refused('a GET', raw(a.s.ctx.pcsync.port, 'GET', '/pcsync/hello', serveHeaders(a)), 405);
      for (const path of ['/', '/api/live/list', '/api/remote/home', '/mcp', '/pcsync', '/pcsync/sync', '/pcsync/../api/live/list']) {
        await refused('path ' + path, listener(a, path, { token }), 404);
      }
      await refused('no token', listener(a, '/pcsync/hello', {}), 401);
      await refused('a wrong token', listener(a, '/pcsync/hello', { token: 'x'.repeat(43) }), 401);
      await refused('a body that is not JSON', raw(a.s.ctx.pcsync.port, 'POST', '/pcsync/hello', serveHeaders(a), '[1]'), 400);
      await refused('a body that is too big', listener(a, '/pcsync/hello', { token, pad: 'x'.repeat(5000) }), 413);
      // a flood of wrong tokens is answered 429 for a minute (only failures are counted)
      for (let i = 0; i < 25; i++) await listener(a, '/pcsync/hello', { token: 'y'.repeat(43) });
      await refused('a flood of wrong tokens', listener(a, '/pcsync/hello', { token: 'z'.repeat(43) }), 429);
    } finally {
      await closeAll([a, b]);
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'a sync peer token is refused on every page route, every phone route, every remote-PC bridge route and the sockets',
  async fn() {
    const [a, b] = await twoNodes();
    try {
      const [status] = await pc(a.s, 'POST', '/api/live/devices/access', { on: true });
      assertEquals(status, 200);
      (a.s.ctx.phone.server!.bridge as unknown as { limit: RateLimit }).limit = new RateLimit(1e6, 1e6);
      const { claim } = await pair(a, b);
      await approveAndWait(a, b, claim);
      const token = tokenToA(b); // the token B holds for A: what a sync peer presents to A
      const phonePort = a.s.phonePort();
      assert(phonePort > 0, 'the phone port listens');
      const computer = await pairPhone(a.s, 'Laptop', undefined, 'computer');
      const bad = (r: { status: number }) => r.status === 401 || r.status === 403;
      let swept = 0;

      // page port: every /api route that refuses a call with no token refuses the peer token as the page token too
      const page = async (method: string, path: string, headers: Record<string, string>) => {
        const r = await fetch(`http://127.0.0.1:${a.s.port}${path}`, {
          method,
          headers: { Origin: `http://127.0.0.1:${a.s.port}`, 'Content-Type': 'application/json', ...headers },
          body: method === 'POST' ? '{}' : undefined,
        });
        await r.body?.cancel();
        return r.status;
      };
      for (const [method, path] of ROUTE_LIST) {
        if (!path.startsWith('/api/')) continue;
        const none = await page(method, path, {});
        if (none !== 401 && none !== 403) continue; // a route open to anyone is open to the peer too, and no more
        for (
          const headers of [{ 'X-Studio-Token': token } as Record<string, string>, { 'X-AIB-Device': token }, {
            Authorization: `Bearer ${token}`,
          }]
        ) {
          const got = await page(method, path, headers);
          assert(got === 401 || got === 403, `page ${method} ${path} with the peer token: ${got}`);
        }
        swept++;
      }
      assert(swept > 100, `the page sweep covered ${swept} routes`);
      // for contrast: the real page token is let in on a plain read
      assertEquals(await page('GET', '/api/live/devices', { 'X-Studio-Token': a.s.token }), 200);

      // phone port: every device route
      let phoneSwept = 0;
      for (const key of Object.keys(ROUTE_SCOPE)) {
        const [method, path] = key.split(' ');
        const r = await raw(
          phonePort,
          method,
          path,
          phoneHeaders({ [DEVICE_HEADER]: token }, method),
          method === 'POST' ? '{}' : undefined,
        );
        assert(bad(r), `phone ${key} with the peer token: ${r.status} ${r.text.slice(0, 80)}`);
        assertEquals(r.json.code, 'not_paired', key);
        phoneSwept++;
      }
      assert(phoneSwept > 30);

      // the remote-PC bridge: every page route, as a computer would call it
      let bridgeSwept = 0;
      for (const [method, path] of ROUTE_LIST) {
        if (!path.startsWith('/api/')) continue;
        const r = await raw(
          phonePort,
          method,
          path,
          phoneHeaders({ [DEVICE_HEADER]: token }, method),
          method === 'POST' ? '{}' : undefined,
        );
        assert(bad(r), `bridge ${method} ${path} with the peer token: ${r.status} ${r.text.slice(0, 80)}`);
        bridgeSwept++;
        // for contrast, a real computer is let in on a plain read (checked once below)
      }
      assert(bridgeSwept > 100);
      const real = await raw(phonePort, 'GET', '/api/live/list', phoneHeaders({ [DEVICE_HEADER]: computer.token }));
      assertEquals(real.status, 200, real.text);

      // the remote PC's sockets: terminal, docs, files
      const socket = (path: string, protocols: string) =>
        raw(
          phonePort,
          'GET',
          path,
          phoneHeaders({
            Origin: `https://studio-pc.tail-a1b2.ts.net`,
            Upgrade: 'websocket',
            Connection: 'Upgrade',
            'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
            'Sec-WebSocket-Version': '13',
            'Sec-WebSocket-Protocol': protocols,
            'Sec-Fetch-Mode': 'websocket',
          }),
        );
      for (
        const [path, proto] of [
          ['/api/live/terminal?key=claude%3Asess-x', 'aib-terminal'],
          ['/api/live/docs/socket?doc=x', 'aib-docs'],
          ['/api/live/files/socket?file=abc&view=v1', 'aib-file'],
        ]
      ) {
        const r = await socket(path, `${proto}, ${DEVICE_PROTOCOL_PREFIX}${token}`);
        assert(bad(r), `${path} socket with the peer token: ${r.status}`);
      }
      // the other direction: a phone or computer token means nothing on the sync listener (checked in the gate test), and the
      // peer token is not a device
      // and a phone's or computer's token means nothing on the sync listener
      for (const device of [computer, await pairPhone(a.s, 'Pixel')]) {
        assertEquals((await listener(a, '/pcsync/hello', { token: device.token })).status, 401);
      }
      assertEquals(a.s.ctx.devices.byToken(token), null);
      assertEquals(a.s.ctx.devices.byCookie(token), null);
    } finally {
      await closeAll([a, b]);
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'Remove revokes at once on this PC, and on the other PC when it is reachable; the row Remove works from the page',
  async fn() {
    const [a, b] = await twoNodes();
    try {
      const { claim } = await pair(a, b);
      await approveAndWait(a, b, claim);
      const toA = tokenToA(b);
      const toB = tokenToB(a);
      assertEquals((await listener(a, '/pcsync/hello', { token: toA })).status, 200);
      const peerId = a.s.ctx.pcsync.peers.list()[0].id;
      const [status, removed] = await pc(a.s, 'POST', '/api/live/pcsync/remove', { id: peerId });
      assertEquals(status, 200);
      assertEquals([removed.removed, removed.notified], [true, true]);
      // both sides forgot each other; both tokens are dead
      assertEquals(a.s.ctx.pcsync.peers.list().length, 0);
      assertEquals(b.s.ctx.pcsync.peers.list().length, 0);
      assertEquals((await listener(a, '/pcsync/hello', { token: toA })).status, 401);
      assertEquals((await listener(b, '/pcsync/hello', { token: toB })).status, 401);
      assertEquals(JSON.parse(Deno.readTextFileSync(`${a.s.state}${sep}pcsync${sep}peers.json`)).peers.length, 0);
      assertEquals(JSON.parse(Deno.readTextFileSync(`${b.s.state}${sep}pcsync${sep}peers.json`)).peers.length, 0);
      // removing again is a no-op
      const [, again] = await pc(a.s, 'POST', '/api/live/pcsync/remove', { id: peerId });
      assertEquals(again.removed, false);

      // pair again, then remove while B is unreachable: A's token for B is dead at once; B is told it must remove A itself
      const second = await pair(a, b);
      await approveAndWait(a, b, second.claim);
      const toA2 = tokenToA(b);
      b.up = false;
      const [, gone] = await pc(a.s, 'POST', '/api/live/pcsync/remove', { id: a.s.ctx.pcsync.peers.list()[0].id });
      assertEquals([gone.removed, gone.notified], [true, false]);
      assertEquals((await listener(a, '/pcsync/hello', { token: toA2 })).status, 401, 'A no longer accepts B, though B was not told');
      // B's view says A no longer trusts it
      b.up = true;
      await until('B sees it is refused', async () => {
        const [, v] = await pc(b.s, 'GET', '/api/live/pcsync');
        return ((v.peers as Json[])[0]?.reach as string) === 'refused';
      });
      // B removes A (A is not reachable-by-token any more: the call is refused, B still forgets A at once)
      const [, bRemoved] = await pc(b.s, 'POST', '/api/live/pcsync/remove', { id: b.s.ctx.pcsync.peers.list()[0].id });
      assertEquals(bRemoved.removed, true);
      assertEquals(b.s.ctx.pcsync.peers.list().length, 0);
    } finally {
      await closeAll([a, b]);
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'Share sync runs the one tailscale serve command for https 8444; Funnel on 8444 is refused; turning sync off closes the listener',
  async fn() {
    const [a, b] = await twoNodes();
    try {
      a.shared = false;
      const [, start] = await pc(a.s, 'POST', '/api/live/pcsync/start', {});
      assert(Array.isArray(start.words));
      const [, before] = await pc(a.s, 'GET', '/api/live/pcsync');
      assertEquals((before.serve as Json).shared, false);
      assert(String((before.serve as Json).command).startsWith('tailscale serve --bg --https=8444 http://127.0.0.1:'));
      const [shareStatus] = await pc(a.s, 'POST', '/api/live/pcsync/share', {});
      assertEquals(shareStatus, 200);
      assert(a.calls.some((c) => c[0] === 'serve' && c.includes('--bg') && c.includes('--https=8444')));
      assert(!a.calls.some((c) => c.some((x) => /funnel/i.test(x))), 'Funnel is never turned on');
      const [, after] = await pc(a.s, 'GET', '/api/live/pcsync');
      assertEquals((after.serve as Json).shared, true);
      // off: the listener closes and the pairing code is gone
      const port = a.s.ctx.pcsync.port;
      const [offStatus, off] = await pc(a.s, 'POST', '/api/live/pcsync/on', { on: false });
      assertEquals(offStatus, 200);
      assertEquals(off.on, false);
      assertEquals(off.listening, false);
      let refused = false;
      try {
        (await Deno.connect({ hostname: '127.0.0.1', port })).close();
      } catch {
        refused = true;
      }
      assert(refused, 'the sync listener is closed while sync is off');
    } finally {
      await closeAll([a, b]);
    }
  },
});
