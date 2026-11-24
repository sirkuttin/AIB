/**
 * Two AIB installs for the sync-between-PCs tests (server/pcsync/): two in-process servers with their own temp state folders, a
 * fake Tailscale CLI per PC (two tailnet names, the same login, each the other's peer) and a "Serve" stand-in in front of each sync
 * listener. The stand-in adds the Host and Tailscale-User-Login headers Tailscale Serve would, for plain requests and for the sync
 * WebSocket (relayed frame by frame). Ports come from the OS, never 8444. A PC can go down (`up = false`), restart on the same
 * state folder, and show as offline in the other's `tailscale status --json`.
 */
import { assert, assertEquals } from './_assert.ts';
import { readRemotePort } from '../../app/server/remote/port.ts';
import type { Runner } from '../../app/server/remote/tailscale.ts';
import type { LinkTimings } from '../../app/server/pcsync/link.ts';
import type { FileTimings } from '../../app/server/pcsync/files.ts';
import { LOGIN, pc, raw, type RemoteStudio, remoteStudio, tailscaleStatus, tempDir } from './_remote_fixture.ts';

export type Json = Record<string, unknown>;

export interface Node {
  s: RemoteStudio;
  name: string;
  machine: string;
  shared: boolean;
  calls: string[][];
  proxy: Deno.HttpServer;
  front: Deno.Listener;
  up: boolean;
  root: string;
  /** What this PC's `tailscale status --json` says about the other PC. */
  otherOnline: boolean;
  /** Tests: where https 8444 goes in `tailscale serve status` (default: this PC's own listener). */
  serveTo: string | null;
  /** The headers of every WebSocket request that reached the stand-in. */
  upgrades: Headers[];
  /** The sync WebSocket connections through the stand-in (a test closes them to cut the link). */
  sockets: Set<Deno.Conn>;
  restart(): Promise<void>;
}

/** Short link timings so reconnects happen in tests within a second or two. */
export const TEST_LINK: Partial<LinkTimings> = {
  backoffMin: 200,
  backoffMax: 800,
  pollMs: 150,
  pingMs: 400,
  idleMs: 2000,
  helloMs: 1500,
  connectMs: 3000,
  probeMs: 400,
};

/** Quick file-engine timings: a change is seen in a fraction of a second, a stalled pull is retried at once. */
export const TEST_FILES: Partial<FileTimings> = { debounceMs: 80, rescanMs: 400, stallMs: 3000, retryMs: 300 };

/** Two PCs on one tailnet, the same Tailscale login, each with the other as a peer in `tailscale status --json`. */
export async function twoNodes(link: Partial<LinkTimings> = TEST_LINK, files: Partial<FileTimings> = TEST_FILES): Promise<[Node, Node]> {
  const urls = new Map<string, string>();
  const nodes: Node[] = [];
  const spec = [
    ['studio-pc.tail-a1b2.ts.net', 'studio-pc', 'windows'],
    ['ubuntu-pc.tail-a1b2.ts.net', 'ubuntu-pc', 'linux'],
  ];
  for (const [name, machine] of spec) {
    const other = spec.find(([n]) => n !== name)!;
    const node = {
      name,
      machine,
      shared: true,
      calls: [] as string[][],
      up: true,
      otherOnline: true,
      serveTo: null,
      upgrades: [] as Headers[],
      sockets: new Set<Deno.Conn>(),
    } as unknown as Node;
    const runner: Runner = (args) => {
      node.calls.push(args);
      if (args[0] === 'status') {
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify(tailscaleStatus({
            Self: { DNSName: name + '.', HostName: machine, UserID: 42 },
            CertDomains: [name],
            Peer: {
              'nodekey:other': { DNSName: other[0] + '.', HostName: other[1], UserID: 42, Online: node.otherOnline, OS: other[2] },
              'nodekey:friend': { DNSName: 'friend.tail-a1b2.ts.net.', HostName: 'friend', UserID: 99, Online: true, OS: 'linux' },
            },
          })),
        });
      }
      if (args[0] === 'serve' && args[1] === 'status') {
        const web: Json = {};
        const phone = readRemotePort(node.s.state);
        if (phone) web[`${name}:443`] = { Handlers: { '/': { Proxy: `http://127.0.0.1:${phone}` } } };
        if (node.shared) {
          web[`${name}:8444`] = { Handlers: { '/': { Proxy: node.serveTo ?? `http://127.0.0.1:${node.s.ctx.pcsync.port}` } } };
        }
        return Promise.resolve({ code: 0, stdout: JSON.stringify({ Web: web }) });
      }
      if (args[0] === 'serve' && args.includes('--bg')) {
        node.shared = true;
        return Promise.resolve({ code: 0, stdout: '' });
      }
      return Promise.resolve({ code: 1, stdout: '' });
    };
    const start = async (root?: string) => {
      node.s = await remoteStudio({ runner }, root, {
        saved: true,
        pcsync: { runner, port: 0, pollMs: 50, link, files, peerUrl: (host) => urls.get(host) ?? 'http://127.0.0.1:1' },
      });
      node.root = node.s.root;
    };
    await start(await tempDir('aib-pcsync-'));
    node.restart = async () => {
      const root = node.root;
      await node.s.web.close(); // closes the sync listener and every link, like a quit; the state folder stays
      await start(root);
      await node.s.ctx.pcsync.start(); // what main.ts does at startup: listen again and dial when sync was on
    };
    // Tailscale Serve's stand-in: the real listener gets the Host and login Serve would add
    node.proxy = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen: () => {} }, async (request) => {
      if (!node.up) return new Response('down', { status: 503 });
      const url = new URL(request.url);
      const body = request.method === 'GET' ? undefined : await request.text();
      const r = await raw(node.s.ctx.pcsync.port, request.method, url.pathname, { Host: name, 'Tailscale-User-Login': LOGIN }, body);
      return new Response(r.text, { status: r.status, headers: { 'Content-Type': 'application/json' } });
    });
    // In front of it, a TCP forwarder: a WebSocket connection (an Upgrade request) gets the same two headers written into its request
    // line block and is piped straight to the listener (Deno's WebSocket client cannot set Host); everything else goes to the stand-in.
    node.front = Deno.listen({ hostname: '127.0.0.1', port: 0 });
    void (async () => {
      try {
        for await (const conn of node.front) void forward(node, conn, name).catch(() => {});
      } catch { /* closed */ }
    })();
    urls.set(name, `http://127.0.0.1:${(node.front.addr as Deno.NetAddr).port}`);
    nodes.push(node);
  }
  return [nodes[0], nodes[1]];
}

async function forward(node: Node, conn: Deno.Conn, name: string): Promise<void> {
  const decoder = new TextDecoder();
  let head = new Uint8Array();
  const buf = new Uint8Array(16384);
  let end = -1;
  while (end < 0 && head.length < 65536) {
    const n = await conn.read(buf);
    if (n === null) return conn.close();
    const next = new Uint8Array(head.length + n);
    next.set(head);
    next.set(buf.subarray(0, n), head.length);
    head = next;
    end = decoder.decode(head).indexOf('\r\n\r\n');
  }
  const text = decoder.decode(head);
  const isSocket = /\r\nupgrade:\s*websocket/i.test(text);
  let out = head;
  let port = (node.proxy.addr as Deno.NetAddr).port;
  if (isSocket) {
    if (!node.up) return conn.close();
    const lines = text.slice(0, end).split('\r\n');
    node.upgrades.push(new Headers(lines.slice(1).map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1).trim()])));
    const kept = lines.filter((l, i) => i === 0 || !/^(host|tailscale-user-login):/i.test(l));
    kept.push(`Host: ${name}`, `Tailscale-User-Login: ${LOGIN}`);
    out = new TextEncoder().encode(kept.join('\r\n') + text.slice(end));
    port = node.s.ctx.pcsync.port;
    node.sockets.add(conn);
  }
  const upstream = await Deno.connect({ hostname: '127.0.0.1', port });
  const closeBoth = () => {
    node.sockets.delete(conn);
    for (const c of [conn, upstream]) {
      try {
        c.close();
      } catch { /* closed */ }
    }
  };
  await upstream.write(out);
  void conn.readable.pipeTo(upstream.writable).catch(() => {}).finally(closeBoth);
  void upstream.readable.pipeTo(conn.writable).catch(() => {}).finally(closeBoth);
}

export async function closeAll(nodes: Node[]) {
  for (const n of nodes) {
    for (const c of [...n.sockets]) {
      try {
        c.close();
      } catch { /* closed */ }
    }
    try {
      n.front.close();
    } catch { /* closed */ }
    await n.proxy.shutdown().catch(() => {});
    await n.s.close();
  }
}

/** The headers Tailscale Serve puts on a request to the sync listener. */
export const serveHeaders = (n: Node, extra: Record<string, string | null> = {}) => {
  const out: Record<string, string> = { Host: n.name, 'Tailscale-User-Login': LOGIN };
  for (const [k, v] of Object.entries(extra)) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
};
export const listener = (n: Node, path: string, body: Json, extra: Record<string, string | null> = {}) =>
  raw(n.s.ctx.pcsync.port, 'POST', path, serveHeaders(n, extra), JSON.stringify(body));

export async function until(what: string, fn: () => boolean | Promise<boolean>, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`timed out: ${what}`);
}

/** The full pairing through the page routes of both PCs. Returns the words, the check words and each side's dialing token. */
export async function pair(a: Node, b: Node) {
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

export async function approveAndWait(a: Node, b: Node, claim: string) {
  const [status, approved] = await pc(a.s, 'POST', '/api/live/pcsync/approve', { claim });
  assertEquals(status, 200, JSON.stringify(approved));
  await until('B holds A as a peer', () => b.s.ctx.pcsync.peers.list().length === 1);
}

/** Pair the two PCs completely (no assertions about the words). */
export async function paired(files: Partial<FileTimings> = TEST_FILES): Promise<[Node, Node]> {
  const [a, b] = await twoNodes(TEST_LINK, files);
  try {
    const { claim } = await pair(a, b);
    await approveAndWait(a, b, claim);
  } catch (error) {
    await closeAll([a, b]);
    throw error;
  }
  return [a, b];
}

export const tokenToA = (b: Node) => b.s.ctx.pcsync.peers.outToken(b.s.ctx.pcsync.peers.list()[0])!;
export const tokenToB = (a: Node) => a.s.ctx.pcsync.peers.outToken(a.s.ctx.pcsync.peers.list()[0])!;

/** The state of this PC's link to the other, as Settings > Sync shows it ('online' = Connected). */
export async function reach(n: Node): Promise<string> {
  const [, v] = await pc(n.s, 'GET', '/api/live/pcsync');
  return String((v.peers as Json[])[0]?.reach ?? 'none');
}

export const linked = (n: Node) => n.s.ctx.pcsync.links.links();

export { assert };
