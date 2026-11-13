/**
 * Phase D: artifacts on the phone. A Studio in this process with a fake agent host and a fake Tailscale CLI, its artifact store and
 * PC artifact origin started, phone access on:
 *  - the phone's artifact port (remote/artifact_server.ts) serves an artifact by a link the phone port minted, with a CSP built for
 *    the phone (frame-ancestors https://<name>, /_lib/ of https://<name>:8443, the PC's sandbox flags, never allow-same-origin);
 *  - it refuses a loopback Host, a wrong Host, no login header, another login, a removed phone, an expired, forged or other
 *    artifact's link, the PC page's origin and other sites, page credentials, WebSockets, POST, and every page route;
 *  - the mint route: how each kind is shown, versions, PDFs and a missing artifact port say "Open on your PC";
 *  - chat payloads on the phone point loopback artifact links (live and replayed history) at https://<name>:8443; the PC's are
 *    unchanged, and so is what is stored; the PC's artifact origin still answers loopback only;
 *  - Tailscale: the 8443 entry of `tailscale serve status`, the second command in Devices, Funnel on 8443 refuses phone access;
 *  - the artifact port is fixed: chosen once, busy is reported (never another port), the same port after a restart.
 * In a headless Chrome at 375 px playing Tailscale Serve: an artifact opens full screen in the phone page and runs (its /_lib/
 * script too) with no sideways scroll, Close goes back, a picture shows, a PDF says "Open on your PC", a studio-artifact:// link
 * opens the viewer; and a page on another origin of the same site cannot frame the artifact.
 */
import { assert, assertEquals } from './_assert.ts';
import { ROUTE_LIST } from '../../outputs/agent-studio/server/web/routes.ts';
import { DEVICE_HEADER } from '../../outputs/agent-studio/server/remote/server.ts';
import { ArtifactTickets, remoteCsp } from '../../outputs/agent-studio/server/remote/artifact_server.ts';
import {
  readRemoteArtifactPort,
  readRemotePort,
  remoteArtifactPort,
  saveRemotePort,
} from '../../outputs/agent-studio/server/remote/port.ts';
import { readServe } from '../../outputs/agent-studio/server/remote/tailscale.ts';
import { withArtifactOrigin } from '../../outputs/agent-studio/server/remote/payloads.ts';
import { Browser, browserPath, type Page } from './_doc_browser.ts';
import {
  type FakeChat,
  fakeTailscale,
  LOGIN,
  NAME,
  pairPhone,
  pc,
  phoneHeaders,
  type Raw,
  raw,
  type RemoteStudio,
  remoteStudio,
  serveStatus,
  tempDir,
} from './_remote_fixture.ts';

const OPTS = { sanitizeResources: false, sanitizeOps: false };
type Json = Record<string, unknown>;
const enc = (t: string) => new TextEncoder().encode(t);
const ORIGIN = `https://${NAME}:8443`;
const SANDBOX = 'sandbox allow-scripts allow-forms allow-popups allow-downloads';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

type Studio = RemoteStudio & { fake: ReturnType<typeof fakeTailscale> };

/** Phone access on, with the PC's artifact origin started and Serve sending both 443 and 8443 to AIB. */
async function artifactsOn(over: Parameters<typeof remoteStudio>[0] = {}, root?: string): Promise<Studio> {
  const fake = fakeTailscale();
  const s = await remoteStudio({ runner: fake.runner, ...over }, root);
  s.ctx.artifacts.start(s.port);
  fake.state.serve = serveStatus(readRemotePort(s.state)!, false, readRemoteArtifactPort(s.state)!);
  const [status] = await pc(s, 'POST', '/api/live/devices/access', { on: true });
  assertEquals(status, 200);
  return Object.assign(s, { fake });
}

/** What Tailscale Serve and the phone's Chrome send for the artifact frame (override any of them; null drops one). */
function frameHeaders(extra: Record<string, string | null> = {}): Record<string, string> {
  const base: Record<string, string | null> = {
    Host: `${NAME}:8443`,
    'Tailscale-User-Login': LOGIN,
    'X-Forwarded-For': '100.64.0.7',
    'Sec-Fetch-Site': 'same-site',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Dest': 'iframe',
    ...extra,
  };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== null) out[k] = v;
  return out;
}

async function mint(s: RemoteStudio, token: string, id: string, v = 0): Promise<Raw> {
  return await raw(s.phonePort(), 'GET', `/api/remote/artifact?id=${id}${v ? `&v=${v}` : ''}`, phoneHeaders({ [DEVICE_HEADER]: token }));
}

/** The path of a minted link on the artifact port. */
const pathOf = (url: string) => {
  assert(url.startsWith(ORIGIN + '/r/'), url);
  return url.slice(ORIGIN.length);
};

const HTML = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script></head><body><h1>Sales report</h1>' +
  '<p>A paragraph of text that is long enough to wrap on a phone screen without making the page any wider than it is.</p>' +
  '<script>parent.postMessage({ aib: "loaded", chart: typeof Chart, wide: document.documentElement.scrollWidth, ' +
  'inner: innerWidth }, "*");</script></body></html>';

function chatWith(id: string, events: Json[]): FakeChat {
  return {
    id,
    provider: 'claude',
    sessionId: 'sess-' + id,
    cwd: 'C:\\code\\shop',
    busy: false,
    closed: false,
    attention: { state: 'idle', needs: 0, turnEndedAt: null, busySince: null },
    subagents: {},
    breadth: { sessionInfo: { title: 'Sales report' } },
    events,
    permissions: [],
    elicitations: [],
  };
}

Deno.test('artifact links: signed for one phone and one artifact, they expire and cannot be forged', () => {
  let now = 1000;
  const tickets = new ArtifactTickets(() => now);
  const t = tickets.mint('dev1', '0123456789abcdef');
  const [device, artifact, expires, mac] = t.split('.');
  assertEquals([device, artifact, Number(expires)], ['dev1', '0123456789abcdef', 1000 + 15 * 60]);
  assertEquals(tickets.check(device, artifact, expires, mac, artifact), 'dev1');
  assertEquals(tickets.check(device, artifact, expires, mac, 'fedcba9876543210'), null, 'another artifact');
  assertEquals(tickets.check('dev2', artifact, expires, mac, artifact), null, 'another phone');
  assertEquals(tickets.check(device, artifact, String(Number(expires) + 60), mac, artifact), null, 'a later expiry');
  assertEquals(tickets.check(device, artifact, expires, mac.slice(0, -1) + (mac.endsWith('A') ? 'B' : 'A'), artifact), null, 'forged');
  assertEquals(new ArtifactTickets(() => now).check(device, artifact, expires, mac, artifact), null, 'another AIB run');
  now += 15 * 60;
  assertEquals(tickets.check(device, artifact, expires, mac, artifact), null, 'expired');
});

Deno.test('the phone CSP for artifacts: only the phone page may frame them, /_lib/ of the artifact origin, the same sandbox', () => {
  const policy = remoteCsp(NAME);
  assert(policy.includes(`frame-ancestors https://${NAME};`), policy);
  assert(policy.includes(`https://unpkg.com ${ORIGIN}/_lib/;`), policy);
  assert(policy.endsWith(SANDBOX), policy);
  assert(!policy.includes('allow-same-origin') && !policy.includes('127.0.0.1') && !policy.includes('localhost'), policy);
});

Deno.test('the artifact port is chosen once, never the phone port, and kept even when busy', async () => {
  const dir = await tempDir('aib-remote-artifact-port-');
  try {
    saveRemotePort(dir, 8779); // port-guard: not bound
    const free = (p: number) => p !== 8780; // port-guard: not bound
    assertEquals(remoteArtifactPort(dir, 8779, free, [8781]), 8782); // port-guard: not bound
    assertEquals([readRemotePort(dir), readRemoteArtifactPort(dir)], [8779, 8782]); // port-guard: not bound
    assertEquals(remoteArtifactPort(dir, 8779, () => false), 8782, 'saved: kept even when busy'); // port-guard: not bound
    saveRemotePort(dir, 8790); // port-guard: not bound
    assertEquals(readRemoteArtifactPort(dir), 8782, 'saving the phone port keeps the artifact port'); // port-guard: not bound
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('Tailscale: the 8443 entry of serve status, and Funnel on 8443 counts as Funnel on', () => {
  const status = serveStatus(5001, false, 5002);
  assertEquals(readServe(status, NAME, 5001, 5002), {
    serving: true,
    servingOther: '',
    artifactServing: true,
    artifactServingOther: '',
    funnel: false,
    funnelPorts: [],
    otherNames: [],
  });
  const other = readServe(serveStatus(5001, false, 6000), NAME, 5001, 5002);
  assertEquals([other.artifactServing, other.artifactServingOther], [false, 'http://127.0.0.1:6000']);
  assertEquals(readServe(serveStatus(5001), NAME, 5001, 5002).artifactServing, false);
  assertEquals(readServe(serveStatus(5001, '8443', 5002), NAME, 5001, 5002).funnel, true);
});

Deno.test({
  ...OPTS,
  name: 'artifact port: a minted link loads with the phone CSP; every other way in is refused; removed phone: its links stop',
  async fn() {
    const s = await artifactsOn();
    try {
      const store = s.ctx.artifacts.store;
      const page = store.create('claude:sess-c', 'Sales report', 'html', 'report.html', enc(HTML));
      const other = store.create('claude:sess-c', 'Notes', 'md', 'notes.md', enc('# Notes'));
      const phone = await pairPhone(s);
      const port = s.artifactPort();
      assert(port > 0 && port === readRemoteArtifactPort(s.state), `artifact port ${port}`);
      const minted = await mint(s, phone.token, page.id);
      assertEquals([minted.status, minted.json.view, minted.json.kind, minted.json.title], [200, 'page', 'html', 'Sales report']);
      const path = pathOf(minted.json.url as string);
      assert(path.endsWith(`/a/${page.id}/v1/report.html`), path);
      const ok = await raw(port, 'GET', path, frameHeaders());
      assertEquals(ok.status, 200, ok.text);
      const csp = ok.headers.get('content-security-policy') ?? '';
      assertEquals(csp, remoteCsp(NAME));
      assert(ok.text.includes('/_lib/chart.umd.min.js') && ok.text.includes('studio-artifact-scroll'), 'libraries local, scroll kept');
      assertEquals(ok.headers.get('cross-origin-resource-policy'), 'same-site');
      const lib = await raw(
        port,
        'GET',
        '/_lib/chart.umd.min.js',
        frameHeaders({ 'Sec-Fetch-Dest': 'script', 'Sec-Fetch-Mode': 'no-cors' }),
      );
      assertEquals([lib.status, lib.headers.get('content-type')], [200, 'text/javascript; charset=utf-8']);
      // a module load from the sandboxed frame says Origin: null
      assertEquals(
        (await raw(port, 'GET', '/_lib/mermaid.esm.min.mjs', frameHeaders({ Origin: 'null', 'Sec-Fetch-Mode': 'cors' }))).status,
        200,
      );

      const [device, art, expires, mac] = path.split('/')[2].split('.');
      const expired = s.ctx.phone.tickets.mint(phone.id, page.id, -1);
      const refused: [string, string, Record<string, string>, number][] = [
        ['loopback Host', path, frameHeaders({ Host: `127.0.0.1:${port}` }), 403],
        ['localhost Host', path, frameHeaders({ Host: `localhost:${port}` }), 403],
        ['the phone page Host (443)', path, frameHeaders({ Host: NAME }), 403],
        ['another name', path, frameHeaders({ Host: `other-pc.tail-a1b2.ts.net:8443` }), 403],
        ['no login header (Funnel)', path, frameHeaders({ 'Tailscale-User-Login': null }), 403],
        ['another login', path, frameHeaders({ 'Tailscale-User-Login': 'someone@else.com' }), 403],
        ['the PC page', path, frameHeaders({ Origin: `http://127.0.0.1:${s.port}`, 'Sec-Fetch-Site': 'cross-site' }), 403],
        ['the PC page, no Fetch Metadata', path, frameHeaders({ Origin: `http://127.0.0.1:${s.port}`, 'Sec-Fetch-Site': null }), 403],
        ['another site', path, frameHeaders({ 'Sec-Fetch-Site': 'cross-site' }), 403],
        ['another origin', path, frameHeaders({ Origin: 'https://evil.example' }), 403],
        ['the page token', path, frameHeaders({ 'X-Studio-Token': s.token }), 403],
        ['an agent key', path, frameHeaders({ 'X-Studio-Artifact-Key': 'k' }), 403],
        ['the device token', path, frameHeaders({ [DEVICE_HEADER]: phone.token }), 403],
        [
          'a WebSocket',
          path,
          frameHeaders({ Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' }),
          403,
        ],
        ['expired', `/r/${expired}/a/${page.id}/v1/report.html`, frameHeaders(), 403],
        ['forged', `/r/${device}.${art}.${expires}.${mac.slice(0, -2)}AA/a/${page.id}/v1/report.html`, frameHeaders(), 403],
        ['a later expiry', `/r/${device}.${art}.${Number(expires) + 3600}.${mac}/a/${page.id}/v1/report.html`, frameHeaders(), 403],
        ['another artifact', `/r/${device}.${art}.${expires}.${mac}/a/${other.id}/v1/notes.md`, frameHeaders(), 403],
        ['no link', `/a/${page.id}/v1/report.html`, frameHeaders(), 404],
        ['the image cookie only', `/a/${page.id}/v1/report.html`, frameHeaders({ Cookie: `__Host-aib-phone=${phone.cookie}` }), 404],
        ['a PC Files ticket', '/t/abcdefabcdefabcdefabcdef/x.html', frameHeaders(), 404],
      ];
      for (const [why, p, h, status] of refused) {
        const r = await raw(port, 'GET', p, h);
        assertEquals(r.status, status, `${why}: ${r.status} ${r.text}`);
        assert(!r.text.includes('Sales report'), why);
        assert((r.headers.get('content-security-policy') ?? '').includes(`frame-ancestors https://${NAME}`), `${why}: may not be framed`);
      }
      assertEquals((await raw(port, 'POST', path, frameHeaders(), '{}')).status, 405, 'POST');
      assertEquals((await raw(port, 'GET', '/_lib/chart.umd.min.js', frameHeaders({ 'Tailscale-User-Login': 'x@y.z' }))).status, 403);
      // every page route is refused here too, and none of these answers carries the page token
      for (const [m, p] of ROUTE_LIST) {
        const r = await raw(port, m, p, frameHeaders({ 'X-AIB-Device': null }), m === 'POST' ? '{}' : undefined);
        assert(r.status === 403 || r.status === 404 || r.status === 405, `${m} ${p} -> ${r.status}`);
        assert(!r.text.includes(s.token), `${m} ${p} leaks the page token`);
      }
      // the PC's artifact origin is unchanged: loopback only, framed by the PC page only
      const pcPort = Number(new URL(store.origin).port);
      const pcPath = `/a/${page.id}/v1/report.html`;
      const pcOk = await raw(pcPort, 'GET', pcPath, { Host: `127.0.0.1:${pcPort}` });
      assertEquals(pcOk.status, 200);
      assert(
        (pcOk.headers.get('content-security-policy') ?? '').includes(
          `frame-ancestors http://127.0.0.1:${s.port} http://localhost:${s.port};`,
        ),
      );
      assertEquals((await raw(pcPort, 'GET', pcPath, frameHeaders({ Host: `${NAME}:8443` }))).status, 403, 'PC origin: tailnet Host');
      // removed on the PC: its links stop working at once
      await pc(s, 'POST', '/api/live/devices/remove', { id: phone.id });
      assertEquals((await raw(port, 'GET', path, frameHeaders())).status, 403, 'removed phone');
      assertEquals((await raw(port, 'GET', '/_lib/chart.umd.min.js', frameHeaders())).status, 403, 'no paired phone with this login');
    } finally {
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'mint: how each kind shows on the phone, versions, PDFs and a missing artifact port say "Open on your PC"',
  async fn() {
    const s = await artifactsOn();
    try {
      const store = s.ctx.artifacts.store;
      const md = store.create('c', 'Plan', 'md', 'plan.md', enc('# Plan'));
      store.addVersion(md.id, enc('# Plan v2'));
      const img = store.create('c', 'Logo', 'image', 'logo.png', Uint8Array.from(atob(PNG), (c) => c.charCodeAt(0)));
      const csv = store.create('c', 'Table', 'csv', 't.csv', enc('a,b\n1,2'));
      const pdf = store.create('c', 'Paper', 'pdf', 'p.pdf', enc('%PDF-1.4'));
      const phone = await pairPhone(s);
      const latest = await mint(s, phone.token, md.id);
      assertEquals([latest.json.view, latest.json.version, latest.json.latest], ['page', 2, 2]);
      assert((latest.json.url as string).endsWith(`/a/${md.id}/v2/plan.md?view=1`), String(latest.json.url));
      const first = await mint(s, phone.token, md.id, 1);
      assert((first.json.url as string).endsWith(`/a/${md.id}/v1/plan.md?view=1`), String(first.json.url));
      const page = await raw(s.artifactPort(), 'GET', pathOf(first.json.url as string), frameHeaders());
      assertEquals([page.status, page.headers.get('content-type')], [200, 'text/html; charset=utf-8']);
      assert(page.text.includes('<h1>Plan</h1>'), 'markdown drawn as on the PC');
      const picture = await mint(s, phone.token, img.id);
      assertEquals(picture.json.view, 'image');
      const bytes = await raw(
        s.artifactPort(),
        'GET',
        pathOf(picture.json.url as string),
        frameHeaders({ 'Sec-Fetch-Dest': 'image', 'Sec-Fetch-Mode': 'no-cors' }),
      );
      assertEquals([bytes.status, bytes.headers.get('content-type')], [200, 'image/png']);
      // a CSV is a table page (the artifact origin draws it with ?view=1), every cell escaped text
      const table = await mint(s, phone.token, csv.id);
      assertEquals(table.json.view, 'page');
      assert(String(table.json.url).endsWith('?view=1'), String(table.json.url));
      const drawn = await raw(s.artifactPort(), 'GET', pathOf(table.json.url as string), frameHeaders());
      assertEquals([drawn.status, drawn.headers.get('content-type')], [200, 'text/html; charset=utf-8']);
      assert(drawn.text.includes('<thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody>'), drawn.text);
      assert(drawn.headers.get('content-security-policy'), 'the page CSP');
      const paper = await mint(s, phone.token, pdf.id);
      assertEquals([paper.json.view, paper.json.url, paper.json.why], ['pc', undefined, 'PDFs open on your PC.']);
      assertEquals((await mint(s, phone.token, 'ffffffffffffffff')).status, 404);
      assertEquals((await mint(s, phone.token, '../etc')).status, 400);
      assertEquals((await raw(s.phonePort(), 'GET', `/api/remote/artifact?id=${md.id}`, phoneHeaders())).status, 401, 'no device token');
      // bootstrap names the artifact origin; the phone page may frame it and load its pictures, nothing else
      const boot = await raw(s.phonePort(), 'GET', '/api/remote/bootstrap', phoneHeaders({ [DEVICE_HEADER]: phone.token }));
      assertEquals(boot.json.artifacts, ORIGIN);
      const html = await raw(s.phonePort(), 'GET', '/phone.html', phoneHeaders({ 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate' }));
      const policy = html.headers.get('content-security-policy') ?? '';
      assert(policy.includes(`img-src 'self' data: ${ORIGIN};`) && policy.includes(`frame-src ${ORIGIN};`), policy);
      assert(policy.includes("frame-ancestors 'none'") && html.headers.get('x-frame-options') === 'DENY', 'the phone page is never framed');
      // no artifact port (it stopped): artifacts say "Open on your PC", the phone page frames nothing
      await s.ctx.phone.artifactServer!.close();
      const off = await mint(s, phone.token, md.id);
      assertEquals([off.json.view, off.json.url], ['pc', undefined]);
      const boot2 = await raw(s.phonePort(), 'GET', '/api/remote/bootstrap', phoneHeaders({ [DEVICE_HEADER]: phone.token }));
      assertEquals(boot2.json.artifacts, '');
      const html2 = await raw(
        s.phonePort(),
        'GET',
        '/phone.html',
        phoneHeaders({ 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate' }),
      );
      assert((html2.headers.get('content-security-policy') ?? '').includes("frame-src 'none'"));
    } finally {
      await s.close();
    }
  },
});

Deno.test('rewrite: loopback artifact links (any port) move to the phone origin; other loopback links stay', () => {
  const id = '0123456789abcdef';
  const value = {
    url: `http://127.0.0.1:8768/a/${id}/v1/report.html`, // port-guard: not bound
    text: `See http://localhost:51234/a/${id}/v3/notes.md?view=1 and http://localhost:3000/a/page and http://127.0.0.1:5173/`,
    nested: [{ raw: `{"url": "http://127.0.0.1:40001/a/${id}/v2/x.svg"}` }, 7, null],
    lib: 'http://127.0.0.1:40001/_lib/chart.umd.min.js',
  };
  assertEquals(withArtifactOrigin(value, ORIGIN), {
    url: `${ORIGIN}/a/${id}/v1/report.html`,
    text: `See ${ORIGIN}/a/${id}/v3/notes.md?view=1 and http://localhost:3000/a/page and http://127.0.0.1:5173/`,
    nested: [{ raw: `{"url": "${ORIGIN}/a/${id}/v2/x.svg"}` }, 7, null],
    lib: `${ORIGIN}/_lib/chart.umd.min.js`,
  });
  assertEquals(value.url, `http://127.0.0.1:8768/a/${id}/v1/report.html`, 'the input is not changed'); // port-guard: not bound
});

Deno.test({
  ...OPTS,
  name: 'chat on the phone: artifact links in live events and replayed history point at https://<name>:8443; PC payloads unchanged',
  async fn() {
    const s = await artifactsOn();
    try {
      const store = s.ctx.artifacts.store;
      const a = store.create('claude:sess-c', 'Sales report', 'html', 'report.html', enc(HTML));
      const summary = store.summary(a);
      const loop = store.origin;
      assert(loop.startsWith('http://127.0.0.1:'), loop);
      const events: Json[] = [
        { seq: 1, kind: 'user', data: { text: 'Make the report' } },
        {
          seq: 2,
          kind: 'update',
          data: {
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 't1',
              status: 'completed',
              rawOutput: { content: [{ type: 'text', text: 'Published.\n' + JSON.stringify(summary) }] },
            },
          },
        },
        { seq: 3, kind: 'artifact', data: { type: 'artifact', conversationId: 'c', artifact: summary } },
        {
          seq: 4,
          kind: 'update',
          data: {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `Open ${summary.url} or the old http://127.0.0.1:41000/a/${a.id}/v1/report.html` },
            },
          },
        },
      ];
      s.chats.push(chatWith('c', events));
      const phone = await pairPhone(s);
      const chat = await raw(s.phonePort(), 'GET', '/api/remote/chat?id=c&tail=50', phoneHeaders({ [DEVICE_HEADER]: phone.token }));
      assertEquals(chat.status, 200);
      assert(!chat.text.includes('127.0.0.1') && !chat.text.includes(loop), 'no loopback link on the phone');
      const got = chat.json.events as Json[];
      assertEquals(((got[2].data as Json).artifact as Json).url, `${ORIGIN}/a/${a.id}/v1/report.html`);
      assert(JSON.stringify(got[1]).includes(`${ORIGIN}/a/${a.id}/v1/report.html`), 'the tool answer');
      assert(JSON.stringify(got[3]).includes(`the old ${ORIGIN}/a/${a.id}/v1/report.html`), 'history from an earlier port');
      // the next poll (after a cursor) too
      events.push({ seq: 5, kind: 'artifact', data: { type: 'artifact', conversationId: 'c', artifact: { ...summary, version: 2 } } });
      const next = await raw(s.phonePort(), 'GET', '/api/remote/chat?id=c&after=4', phoneHeaders({ [DEVICE_HEADER]: phone.token }));
      assertEquals(((next.json.events as Json[])[0].data as Json).artifact, {
        ...summary,
        version: 2,
        url: `${ORIGIN}/a/${a.id}/v1/report.html`,
      });
      // the PC page and what is stored keep the loopback links
      const [, state] = await pc(s, 'GET', '/api/live/state?id=c&after=0');
      assert(JSON.stringify(state).includes(`${loop}/a/${a.id}/v1/report.html`), 'PC payload unchanged');
      assert(!JSON.stringify(state).includes(ORIGIN), 'no phone origin on the PC');
      assertEquals(((events[2].data as Json).artifact as Json).url, summary.url, 'stored events unchanged');
    } finally {
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'Devices: the second serve command and its check; Funnel on 8443 stops phone access, both ports',
  async fn() {
    const s = await artifactsOn();
    try {
      const phonePort = readRemotePort(s.state)!;
      const artifactPort = readRemoteArtifactPort(s.state)!;
      let [, view] = await pc(s, 'GET', '/api/live/devices');
      assertEquals(
        [view.artifactCommand, view.artifactListening, view.artifactPort, (view.tailscale as Json).artifactServing],
        [`tailscale serve --bg --https=8443 http://127.0.0.1:${artifactPort}`, true, artifactPort, true],
      );
      s.fake.state.serve = serveStatus(phonePort);
      await pc(s, 'POST', '/api/live/devices/check', {});
      [, view] = await pc(s, 'GET', '/api/live/devices');
      assertEquals((view.tailscale as Json).artifactServing, false, 'Check again reads the 8443 entry');
      s.fake.state.serve = serveStatus(phonePort, '8443', artifactPort);
      await pc(s, 'POST', '/api/live/devices/check', {});
      [, view] = await pc(s, 'GET', '/api/live/devices');
      assertEquals([view.listening, view.artifactListening, (view.problem as Json).code], [false, false, 'funnel']);
      for (const port of [phonePort, artifactPort]) {
        const refused = await Deno.connect({ hostname: '127.0.0.1', port }).then((c) => (c.close(), false), () => true);
        assert(refused, `nothing listens on ${port}`);
      }
      assert(s.fake.calls.every((c) => c[0] === 'status' || (c[0] === 'serve' && c[1] === 'status')), 'AIB only reads Tailscale');
    } finally {
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'a busy artifact port: reported, the saved port kept (never another), Check again takes it; the same port after a restart',
  async fn() {
    const held = Deno.listen({ hostname: '127.0.0.1', port: 0 });
    const busy = (held.addr as Deno.NetAddr).port;
    const fake = fakeTailscale();
    let s = await remoteStudio({ runner: fake.runner, bindRetryMs: 1000 });
    const root = s.root;
    try {
      s.ctx.artifacts.start(s.port);
      saveRemotePort(s.state, readRemotePort(s.state)!, busy);
      fake.state.serve = serveStatus(readRemotePort(s.state)!, false, busy);
      await pc(s, 'POST', '/api/live/devices/access', { on: true });
      let [, view] = await pc(s, 'GET', '/api/live/devices');
      assertEquals([view.listening, view.artifactListening, view.artifactPort], [true, false, busy], 'the phone page still works');
      assertEquals((view.artifactProblem as Json).code, 'artifact_port_busy');
      assert(String((view.artifactProblem as Json).message).startsWith(`Port ${busy} is busy`));
      assertEquals(readRemoteArtifactPort(s.state), busy, 'not swapped for another port');
      const phone = await pairPhone(s);
      const a = s.ctx.artifacts.store.create('c', 'Report', 'html', 'r.html', enc(HTML));
      assertEquals((await mint(s, phone.token, a.id)).json.view, 'pc', 'meanwhile: Open on your PC');
      held.close();
      await pc(s, 'POST', '/api/live/devices/check', {});
      [, view] = await pc(s, 'GET', '/api/live/devices');
      assertEquals([view.artifactListening, view.artifactPort, view.artifactProblem], [true, busy, null]);
      assertEquals(s.artifactPort(), busy);
      // restart (same data folder): the same artifact port, listening again, and a link minted now works
      await s.ctx.phone.close();
      await s.ctx.artifacts.stop();
      await s.web.close();
      s = await remoteStudio({ runner: fake.runner, bindRetryMs: 1000 }, root);
      s.ctx.artifacts.start(s.port);
      await s.ctx.phone.start();
      assertEquals([readRemoteArtifactPort(s.state), s.artifactPort()], [busy, busy]);
      const again = await mint(s, phone.token, a.id);
      assertEquals((await raw(busy, 'GET', pathOf(again.json.url as string), frameHeaders())).status, 200);
    } finally {
      try {
        held.close();
      } catch { /* closed */ }
      await s.close();
    }
  },
});

// ---- the phone page in a headless browser --------------------------------------------------------------------------------------

/**
 * This test plays Tailscale Serve for https://<NAME> (the phone port) and https://<NAME>:8443 (the artifact port), and serves a
 * page of its own at https://<NAME>:9443 (another program shared on the same name: same site, another origin).
 */
async function serveFor(page: Page, s: Studio, other: { html: string }): Promise<void> {
  await page.send('Network.enable');
  await page.send('Fetch.enable', { patterns: [{ urlPattern: `https://${NAME}*`, requestStage: 'Request' }] });
  page.listeners.set('Fetch.requestPaused', (p) => {
    void (async () => {
      const request = p.request as Json;
      const url = new URL(request.url as string);
      const method = request.method as string;
      const kind = p.resourceType as string;
      if (url.port === '9443') {
        await page.send('Fetch.fulfillRequest', {
          requestId: p.requestId,
          responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
          body: btoa(other.html),
        });
        return;
      }
      const artifacts = url.port === '8443';
      const sent = request.headers as Record<string, string>;
      const headers: Record<string, string> = { Host: url.host, 'Tailscale-User-Login': LOGIN, 'X-Forwarded-For': '100.64.0.7' };
      for (const [k, v] of Object.entries(sent)) if (/^(content-type|x-aib-device|accept|origin)$/i.test(k)) headers[k] = v;
      if (method === 'POST' && !Object.keys(headers).some((k) => k.toLowerCase() === 'origin')) headers.Origin = `https://${NAME}`;
      const site = artifacts ? 'same-site' : 'same-origin';
      if (kind === 'Document') {
        Object.assign(headers, {
          'Sec-Fetch-Site': artifacts ? 'same-site' : 'none',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Dest': artifacts ? 'iframe' : 'document',
        });
      } else if (kind === 'Fetch' || kind === 'XHR') {
        Object.assign(headers, { 'Sec-Fetch-Site': site, 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' });
      } else Object.assign(headers, { 'Sec-Fetch-Site': site, 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': kind.toLowerCase() });
      if (!artifacts) {
        const jar = await page.send('Network.getCookies', { urls: [url.href] });
        const cookies = (jar.cookies as Json[]).map((c) => `${c.name}=${c.value}`).join('; ');
        if (cookies) headers.Cookie = cookies;
      }
      let answer: Raw | null = null;
      try {
        answer = await raw(
          artifacts ? s.artifactPort() : s.phonePort(),
          method,
          url.pathname + url.search,
          headers,
          request.postData as string | undefined,
        );
      } catch { /* nothing listens: Serve answers 502 */ }
      if (!answer) {
        await page.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 502, responseHeaders: [], body: '' });
        return;
      }
      const responseHeaders: Json[] = [];
      answer.headers.forEach((value, name) => {
        if (!/^(transfer-encoding|connection|content-length|keep-alive)$/i.test(name)) responseHeaders.push({ name, value });
      });
      let bin = '';
      for (let i = 0; i < answer.bytes.length; i += 0x8000) bin += String.fromCharCode(...answer.bytes.subarray(i, i + 0x8000));
      await page.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: answer.status, responseHeaders, body: btoa(bin) });
    })().catch(() => {});
  });
}

/** Sandboxed frames stay in the page's process, so this test's Serve (request interception on the page) also answers what the
 * artifact itself loads (its /_lib/ script). A phone's Chrome needs no such thing: Serve is really there. */
const KEEP_FRAMES = ['--disable-features=IsolateSandboxedIframes'];

const NO_SIDEWAYS =
  `(() => { const d = document.documentElement; return d.scrollWidth <= d.clientWidth && document.body.scrollWidth <= d.clientWidth; })()`;
const WIDTHS = `(() => { const d = document.documentElement; return [d.scrollWidth, d.clientWidth]; })()`;

async function signInPage(page: Page, token: string, id: string): Promise<void> {
  await page.goto(`https://${NAME}/phone.html`);
  await page.waitFor('!!document.getElementById("app").dataset.screen', 15000, 'the phone page');
  await page.eval(`new Promise((resolve, reject) => {
    const req = indexedDB.open('aib-phone', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => {
      const tx = req.result.transaction('kv', 'readwrite');
      tx.objectStore('kv').put({ token: ${JSON.stringify(token)}, device: { id: ${JSON.stringify(id)} } }, 'device');
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  })`);
  await page.goto(`https://${NAME}/phone.html`);
  await page.waitFor('document.getElementById("app").dataset.screen === "home" && !!document.querySelector(".ph-card")', 15000, 'home');
}

Deno.test({
  ...OPTS,
  name: 'phone page at 375 px: an artifact opens full screen and runs (its /_lib/ script too), no sideways scroll; Close; picture; PDF',
  ignore: !browserPath,
  async fn() {
    const s = await artifactsOn();
    const browser = await Browser.launch(KEEP_FRAMES);
    try {
      const store = s.ctx.artifacts.store;
      const report = store.create(
        'claude:sess-c',
        'Quarterly sales report with a title long enough to need cutting short',
        'html',
        'report.html',
        enc(HTML),
      );
      const logo = store.create('claude:sess-c', 'Logo', 'image', 'logo.png', Uint8Array.from(atob(PNG), (c) => c.charCodeAt(0)));
      const paper = store.create('claude:sess-c', 'Paper', 'pdf', 'paper.pdf', enc('%PDF-1.4'));
      const art = (seq: number, m: typeof report) => ({ seq, kind: 'artifact', data: { type: 'artifact', artifact: store.summary(m) } });
      s.chats.push(chatWith('c', [
        { seq: 1, kind: 'user', data: { text: 'Make the report' } },
        art(2, report),
        art(3, logo),
        art(4, paper),
        {
          seq: 5,
          kind: 'update',
          data: {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `Done: [the report](studio-artifact://${report.id}).` },
            },
          },
        },
      ]));
      const phone = await pairPhone(s);
      const page = await browser.open('about:blank', 375, 812);
      await page.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
      await serveFor(page, s, { html: '' });
      await signInPage(page, phone.token, phone.id);
      await page.eval('window.__msgs = []; addEventListener("message", (e) => window.__msgs.push(e.data))');
      await page.click('.ph-card');
      await page.waitFor('document.querySelectorAll(".ph-art").length === 3', 15000, 'three artifact cards');
      assertEquals(
        await page.eval(
          '[...document.querySelectorAll(".ph-art")].map((c) => c.matches("button[data-open-artifact]") ? "Open" : c.querySelector(".ph-art-kind").textContent.endsWith("open on your PC") ? "Open on your PC" : "?")',
        ),
        ['Open', 'Open', 'Open on your PC'],
      );
      assert(await page.eval(NO_SIDEWAYS), `chat: sideways scroll ${await page.eval(WIDTHS)}`);
      await page.shot('phone-artifact-cards');
      // Open: full screen, the page in a sandboxed frame on the artifact origin
      await page.click(`[data-open-artifact="${report.id}"]`);
      await page.waitFor('document.querySelector(".ph-viewer")?.dataset.state === "open"', 15000, 'the viewer');
      const frame = await page.eval<Json>(
        `(() => { const f = document.querySelector('.ph-viewer-frame'); const r = f.getBoundingClientRect();
        const v = document.querySelector('.ph-viewer').getBoundingClientRect();
        return { sandbox: f.getAttribute('sandbox'), src: f.src, w: r.width, h: r.height, vw: v.width, vh: v.height }; })()`,
      );
      assertEquals([frame.sandbox, frame.vw, frame.vh, frame.w], ['allow-scripts allow-forms allow-popups allow-downloads', 375, 812, 375]);
      assert(String(frame.src).startsWith(`${ORIGIN}/r/`), String(frame.src));
      assert((frame.h as number) > 600, `frame height ${frame.h}`);
      const loaded = await page.waitFor('window.__msgs.find((m) => m && m.aib === "loaded")', 15000, 'the artifact ran') as Json;
      assertEquals(loaded.chart, 'function', 'Chart.js from /_lib/ on the artifact origin');
      assert((loaded.wide as number) <= (loaded.inner as number), `the artifact is wider than the phone: ${JSON.stringify(loaded)}`);
      assert(await page.eval(NO_SIDEWAYS), `viewer: sideways scroll ${await page.eval(WIDTHS)}`);
      await page.shot('phone-artifact-viewer');
      assert(await page.eval('getComputedStyle(document.documentElement).overflow === "hidden"'), 'the chat does not scroll behind');
      const close = await page.eval<number[]>(
        '(() => { const r = document.getElementById("viewerClose").getBoundingClientRect(); return [r.height, r.right]; })()',
      );
      assert(close[0] >= 44 && close[1] <= 375, `Close: ${close}`);
      // the chat keeps polling behind it, and the frame is not loaded again
      await new Promise((r) => setTimeout(r, 3500));
      assertEquals(await page.eval('window.__msgs.filter((m) => m && m.aib === "loaded").length'), 1, 'one load');
      await page.click('#viewerClose');
      await page.waitFor(
        '!document.querySelector(".ph-viewer") && document.getElementById("app").dataset.screen === "chat"',
        15000,
        'back to the chat',
      );
      // a picture
      await page.click(`[data-open-artifact="${logo.id}"]`);
      await page.waitFor(
        '(() => { const i = document.querySelector(".ph-viewer-img"); return i && i.complete && i.naturalWidth > 0; })()',
        15000,
        'the picture',
      );
      await page.click('#viewerClose');
      // a studio-artifact:// link in a reply opens the viewer too
      await page.click('.artifact-link');
      await page.waitFor('document.querySelector(".ph-viewer")?.dataset.state === "open"', 15000, 'the viewer from a link');
      assert(String(await page.eval('document.querySelector(".ph-viewer-frame").src')).includes(`/a/${report.id}/v1/report.html`));
      await page.click('#viewerClose');
      assertEquals(page.errors, [], 'console errors');
      assertEquals(await page.violations(), [], 'CSP violations');
      await page.close();
    } finally {
      await browser.close();
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'another origin of the same site (https://<name>:9443) cannot frame an artifact, even with a fresh link',
  ignore: !browserPath,
  async fn() {
    const s = await artifactsOn();
    const browser = await Browser.launch(KEEP_FRAMES);
    try {
      const report = s.ctx.artifacts.store.create('c', 'Report', 'html', 'report.html', enc(HTML));
      const phone = await pairPhone(s);
      const minted = await mint(s, phone.token, report.id);
      const other = {
        html: `<!doctype html><html><body><iframe id="f" sandbox="allow-scripts" src="${minted.json.url}"></iframe>` +
          '<script>window.__msgs = []; addEventListener("message", (e) => window.__msgs.push(e.data));</script></body></html>',
      };
      const page = await browser.open('about:blank', 375, 812);
      await serveFor(page, s, other);
      await page.goto(`https://${NAME}:9443/`);
      await page.waitFor('document.readyState === "complete" && !!document.getElementById("f")', 15000, 'the other page');
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline && !page.csp.some((t) => /frame-ancestors/.test(t))) await new Promise((r) => setTimeout(r, 100));
      assert(page.csp.some((t) => /frame-ancestors/.test(t)), `refused by frame-ancestors: ${JSON.stringify(page.csp)}`);
      await new Promise((r) => setTimeout(r, 500));
      assertEquals(await page.eval('window.__msgs.length'), 0, 'the artifact never ran there');
      await page.close();
    } finally {
      await browser.close();
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'phone page: a phone that just paired (no reload) gets the artifact origin, so artifact cards say Open, not "Open on your PC"',
  ignore: !browserPath,
  async fn() {
    const s = await artifactsOn();
    const browser = await Browser.launch(KEEP_FRAMES);
    try {
      const [, code] = await pc(s, 'POST', '/api/live/devices/pair', {});
      const secret = /#p=([0-9a-f]{12})$/.exec(code.url as string)![1];
      const page = await browser.open('about:blank', 375, 812);
      await serveFor(page, s, { html: '' });
      await page.goto(`https://${NAME}/phone.html#p=${secret}`);
      await page.waitFor('document.getElementById("app").dataset.screen === "pair" && !!document.getElementById("pairGo")', 15000, 'pair');
      await page.click('#pairGo');
      await page.waitFor('!!document.getElementById("checkWords")', 15000, 'check words');
      const [, view] = await pc(s, 'GET', '/api/live/devices');
      const pending = ((view.pairing as Json).pending as Json[])[0];
      const [ok] = await pc(s, 'POST', '/api/live/devices/approve', { claim: pending.id });
      assertEquals(ok, 200);
      await page.waitFor('document.getElementById("app").dataset.screen === "setup"', 15000, 'paired');
      assertEquals(await page.eval('window.__aibPhone.artifacts'), ORIGIN, 'the artifact origin is known without a reload');
      await page.close();
    } finally {
      await browser.close();
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'phone page at 375 px: Subagents card padded, Live chip green dot, subagent state dots, inline artifact link 44 px to tap',
  ignore: !browserPath,
  async fn() {
    const s = await artifactsOn();
    const browser = await Browser.launch(KEEP_FRAMES);
    try {
      const report = s.ctx.artifacts.store.create('claude:sess-c', 'Report', 'html', 'report.html', enc(HTML));
      const chat = chatWith('c', [
        { seq: 1, kind: 'user', data: { text: 'Make the report' } },
        {
          seq: 2,
          kind: 'update',
          data: {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `Done: [the report](studio-artifact://${report.id}) is ready.` },
            },
          },
        },
      ]);
      chat.subagents = {
        a: { title: 'Codex tests', state: 'running' },
        b: { title: 'Claude api', state: 'completed' },
        c: { title: 'Gemini docs', state: 'needs_you' },
        d: { title: 'Idle one', state: 'weird' },
      };
      s.chats.push(chat);
      const phone = await pairPhone(s);
      const page = await browser.open('about:blank', 375, 812);
      await page.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
      await serveFor(page, s, { html: '' });
      await signInPage(page, phone.token, phone.id);
      // the chip: muted text, a green dot (not the warning colour)
      const chip = await page.eval<Json>(`(() => {
        const c = document.querySelector('.ph-chip.live'); const cs = getComputedStyle(c); const d = getComputedStyle(c, '::before');
        const probe = document.createElement('i'); document.body.append(probe);
        const rgb = (name) => { probe.style.color = getComputedStyle(document.documentElement).getPropertyValue(name); return getComputedStyle(probe).color; };
        const out = { text: cs.color, dot: d.backgroundColor, muted: rgb('--muted'), ok: rgb('--ok'), need: rgb('--hd-need'), accent: rgb('--accent') };
        probe.remove(); return out; })()`);
      assertEquals(chip.text, chip.muted, 'Live chip text is muted');
      assertEquals(chip.dot, chip.ok, 'Live chip dot is the good colour');
      assert(chip.dot !== chip.need);
      // the chat: the Subagents card (title and state only), a dot per subagent by state
      const expected = [chip.accent, chip.ok, chip.need, chip.muted];
      await page.click('.ph-card');
      await page.waitFor('document.getElementById("phSubsGo") && document.querySelector(".ph-msg a")', 15000, 'the chat');
      await page.eval('document.getElementById("phSubsGo").click(), true');
      await page.waitFor('document.querySelectorAll("#phSubs li .ph-dot").length === 4', 15000, 'the Subagents card');
      const box = await page.eval<number[]>(`(() => {
        const card = document.getElementById('phSubs'); const b = card.getBoundingClientRect(); const li = card.querySelector('li .ph-sub');
        const first = li.firstElementChild.getBoundingClientRect(); const last = li.lastElementChild.getBoundingClientRect();
        return [first.left - b.left, b.right - last.right]; })()`);
      assert(box[0] >= 12 && box[1] >= 12, `Subagents card inner padding ${box}`);
      const chatDots = await page.eval<string[]>(`[...document.querySelectorAll('#phSubs li .ph-dot')].map((d) => getComputedStyle(d).backgroundColor)`);
      assertEquals(chatDots, expected, 'working = accent, done = good, needs you = warning, idle = muted');
      // the inline link: at least 44 px tall, the paragraph has not grown
      const link = await page.eval<number[]>(`(() => { const a = document.querySelector('.ph-msg a'); const r = a.getBoundingClientRect();
        const p = a.parentElement.getBoundingClientRect(); return [r.height, p.height]; })()`);
      assert(link[0] >= 44, `inline artifact link height ${link[0]}`);
      assert(link[1] < 40, `the paragraph kept its line height ${link[1]}`);
      await page.shot('phone-qa-chat');
      assertEquals(page.errors, [], 'console errors');
      await page.close();
    } finally {
      await browser.close();
      await s.close();
    }
  },
});
