/**
 * T2 (multi-window design section 11): POST /api/live/desktop/windows (K3) against the fake K4 (_fake_desktop_windows.ts).
 * Refused without the page token or with an artifact key; bad shapes, extra fields, long or control-character values refused;
 * the server builds every URL (K0); one project, one window (D1a) even for two quick clicks; cap 8 -> 409; rate -> 429; serve
 * (no desktop) -> 501; titles cleaned; a window closes only itself. F1 F2 F3 I8.
 */
import { assert, assertEquals } from './_assert.ts';
import { FakeDesktopWindows } from './_fake_desktop_windows.ts';
import { makeContext, type WebContext, WebServer } from '../../outputs/agent-studio/server/web/server.ts';
import {
  cleanTitle,
  parseWindowsRequest,
  RateLimit,
  windowPath,
  windowUrl,
} from '../../outputs/agent-studio/server/desktop/windows_contract.ts';
import type { LiveBackend } from '../../outputs/agent-studio/server/host/backend.ts';
import type { UpdateService } from '../../outputs/agent-studio/server/desktop/updater.ts';
import type { Source } from '../../outputs/agent-studio/server/transcripts/monitor.ts';

type Json = Record<string, unknown>;

const PROJECT = { key: 'c:/work/budget-app', name: 'budget-app', path: 'C:\\work\\budget-app' };
const project = (n: number) => ({ key: `c:/work/p${n}`, name: `p${n}`, path: `C:\\work\\p${n}` });

async function lab(dw: FakeDesktopWindows | null) {
  const stateDir = await Deno.makeTempDir({ prefix: 'aib-windows-route-' });
  const ctx: WebContext = makeContext({
    stateDir,
    host: {} as LiveBackend,
    updates: {} as UpdateService,
    webInstanceId: 'test',
    cliPort: 0,
    transcripts: {} as Source,
    claudeProjects: stateDir,
    ompSessions: stateDir,
    shutdown: () => {},
    keepAwakeBackend: null,
  });
  ctx.desktopWindows = dw;
  const server = new WebServer(ctx);
  const port = await server.listen(0); // a free port the OS picks
  const origin = `http://127.0.0.1:${port}`;
  const send = async (body: unknown, headers: Record<string, string> = { 'X-Studio-Token': ctx.token, Origin: origin }) => {
    const r = await fetch(`${origin}/api/live/desktop/windows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    return [r.status, await r.json()] as [number, Json];
  };
  return {
    ctx,
    server,
    origin,
    send,
    /** The rate limit off for tests that make many calls (its own test turns it back on). */
    unlimited() {
      (server.windows as { rate: RateLimit }).rate = new RateLimit(1_000_000);
    },
    async [Symbol.asyncDispose]() {
      await server.close();
      await Deno.remove(stateDir, { recursive: true }).catch(() => {});
    },
  };
}

Deno.test('T2: the route needs the page token; an artifact key or another origin is refused (F1)', async () => {
  await using t = await lab(new FakeDesktopWindows());
  const body = { op: 'open', from: 'm', project: PROJECT };
  assertEquals((await t.send(body, { Origin: t.origin }))[0], 403, 'no token');
  assertEquals((await t.send(body, { 'X-Studio-Token': 'nope', Origin: t.origin }))[0], 403, 'wrong token');
  assertEquals((await t.send(body, { 'X-Studio-Token': t.ctx.token, Origin: 'http://evil.example' }))[0], 403, 'another origin');
  assertEquals((await t.send(body, { 'X-Studio-Artifact-Key': 'k' }))[0], 403, 'an agent key is never enough');
  assertEquals((t.ctx.desktopWindows as FakeDesktopWindows).made, 0);
  const [status, made] = await t.send(body);
  assertEquals([status, made], [200, { w: 'w2', existed: false }]);
});

Deno.test('T2: only the listed shapes; extra fields, URLs, long and control-character values are refused (F2)', async () => {
  await using t = await lab(new FakeDesktopWindows());
  t.unlimited();
  const bad: unknown[] = [
    {},
    { op: 'nope' },
    { op: 'open', from: 'm' },
    { op: 'open', from: 'm', project: PROJECT, url: 'http://evil.example/' }, // the page never sends a URL
    { op: 'open', from: 'm', project: { ...PROJECT, url: 'x' } },
    { op: 'open', from: 'w9', project: PROJECT },
    { op: 'open', from: 'm', project: { ...PROJECT, key: '' } },
    { op: 'open', from: 'm', project: { ...PROJECT, key: 'k'.repeat(401) } },
    { op: 'open', from: 'm', project: { ...PROJECT, key: 'a\u0000b' } },
    { op: 'open', from: 'm', project: { ...PROJECT, path: 'C:\\x\ny' } },
    { op: 'open', from: 'm', project: { ...PROJECT, name: 5 } },
    { op: 'open', from: 'm', project: { key: 'k', name: 'n' } },
    { op: 'popout', from: 'm', chat: { key: 'claude:s', project: 'p' } },
    { op: 'popout', from: 'm', chat: { key: 'claude:s\u001b', project: 'p', title: 't' } },
    { op: 'popout', from: 'm', doc: { project: 'p', name: '' } },
    { op: 'popout', from: 'm', doc: { project: 'p', name: 'a\u0007b' } },
    { op: 'popout', from: 'm', doc: { project: 'p', name: 'n'.repeat(201) } },
    { op: 'route', from: 'm', target: { chat: 'claude:s' } },
    { op: 'route', from: 'm', target: { project: 'p', chat: 'c', doc: { project: 'p', name: 'd' } } },
    { op: 'route', from: 'm', target: { project: 'p', extra: 1 } },
    { op: 'focus', w: 'x' },
    { op: 'focus', w: 'w3', from: 'm', more: 1 },
    { op: 'close', from: 'm' },
    '[1,2]',
  ];
  for (const body of bad) assertEquals((await t.send(body))[0], 400, JSON.stringify(body));
  // a body over 2 KB is refused before it is parsed
  const big = { op: 'open', from: 'm', project: { ...PROJECT, path: 'C:\\' + 'x'.repeat(2100) } };
  assertEquals((await t.send(big))[0], 400, 'over 2 KB');
  const fine = JSON.stringify({ op: 'open', from: 'm', project: PROJECT });
  assertEquals((await t.send(fine + ' '.repeat(2100)))[0], 400, 'over 2 KB: a valid body padded with spaces');
  assertEquals((t.ctx.desktopWindows as FakeDesktopWindows).made, 0, 'nothing was opened');
});

Deno.test('T2: the server builds every URL (K0); titles are cleaned and cut to 80', async () => {
  const dw = new FakeDesktopWindows('http://127.0.0.1:9', 'K&y #1');
  await using t = await lab(dw);
  t.unlimited();
  const evil = { key: 'c:/a b&kind=main#x', name: 'bud\u0007get\n' + 'z'.repeat(100), path: 'C:\\a b' };
  let [status, a] = await t.send({ op: 'open', from: 'm', project: evil });
  assertEquals([status, a.w], [200, 'w2']);
  [status, a] = await t.send({ op: 'popout', from: 'w2', chat: { key: 'claude:s1', project: evil.key, title: 'CSV\u0000 import' } });
  assertEquals([status, a.w], [200, 'w3']);
  [status, a] = await t.send({ op: 'popout', from: 'w2', doc: { project: evil.key, name: 'Release plan?' } });
  assertEquals([status, a.w], [200, 'w4']);
  const byId = Object.fromEntries(dw.windows.map((x) => [x.w, x]));
  const q = (w: string) => new URL(byId[w].url);
  assertEquals([q('w2').pathname, q('w2').searchParams.get('w'), q('w2').searchParams.get('kind')], ['/', 'w2', 'project']);
  assertEquals(q('w2').searchParams.get('project'), evil.key, 'escaped by URLSearchParams, read back exactly');
  assertEquals(q('w2').hash, '', 'never a launch key in a window URL (it would land in the browser history)');
  assertEquals(
    [
      q('w3').searchParams.get('kind'),
      q('w3').searchParams.get('mode'),
      q('w3').searchParams.get('chat'),
      q('w3').searchParams.get('project'),
    ],
    ['chat', 'chat', 'claude:s1', evil.key],
  );
  assertEquals([q('w4').pathname, q('w4').searchParams.get('kind'), q('w4').searchParams.get('name')], [
    '/doc.html',
    'doc',
    'Release plan?',
  ]);
  assertEquals(byId.w2.title, 'AIB · ' + ('bud get ' + 'z'.repeat(100)).slice(0, 80));
  assertEquals(byId.w3.title, 'CSV import · AIB');
  assertEquals(cleanTitle('a\u0085b\u009f  c'), 'a b c', 'C1 controls too');
  assertEquals(windowPath({ w: 'm', kind: 'main' }), '/?w=m');
  assertEquals(
    windowUrl('http://127.0.0.1:5/', { w: 'w5', kind: 'project', project: 'p' }),
    'http://127.0.0.1:5/?w=w5&kind=project&project=p',
  );
  let threw = false;
  try {
    windowPath({ w: 'w9', kind: 'main' });
  } catch {
    threw = true;
  }
  assert(threw, 'a bad id never makes a URL');
  // the answer never carries the key or a URL
  for (const v of Object.values(a)) assert(!String(v).includes('K&y') && !String(v).includes('http'));
});

Deno.test('T2: one project, one window (D1a); two quick clicks make one window (F3); the same chat popped out twice is one pop-out', async () => {
  const dw = new FakeDesktopWindows(undefined, undefined, 40); // making a window takes 40 ms
  await using t = await lab(dw);
  t.unlimited();
  const body = { op: 'open', from: 'm', project: PROJECT };
  const [one, two] = await Promise.all([t.send(body), t.send(body)]);
  const both = (x: [number, Json][]) => x.map(([s, a]) => `${s} ${a.w} ${a.existed}`).sort();
  assertEquals(both([one, two]), ['200 w2 false', '200 w2 true'], 'one made it, the other found it (either order)');
  assertEquals(dw.made, 1);
  assertEquals((await t.send(body))[1], { w: 'w2', existed: true }, 'a third time: brought forward');
  assertEquals(dw.focused.at(-1), 'w2');
  const chat = { op: 'popout', from: 'w2', chat: { key: 'claude:s1', project: PROJECT.key, title: 'CSV import' } };
  const [c1, c2] = await Promise.all([t.send(chat), t.send(chat)]);
  assertEquals(both([c1, c2]), ['200 w3 false', '200 w3 true']);
  const doc = { op: 'popout', from: 'w2', doc: { project: PROJECT.key, name: 'Release plan' } };
  assertEquals((await t.send(doc))[1], { w: 'w4', existed: false });
  assertEquals((await t.send(doc))[1], { w: 'w4', existed: true });
  assertEquals(dw.made, 3);
});

Deno.test('T2: at most 8 windows -> 409 {cap: 8}; closing one frees a slot (lowest free id again)', async () => {
  const dw = new FakeDesktopWindows();
  await using t = await lab(dw);
  t.unlimited();
  for (let n = 2; n <= 8; n++) {
    assertEquals((await t.send({ op: 'open', from: 'm', project: project(n) }))[1], { w: `w${n}`, existed: false });
  }
  const [status, full] = await t.send({ op: 'open', from: 'm', project: project(9) });
  assertEquals([status, full.cap], [409, 8]);
  assertEquals(
    (await t.send({ op: 'open', from: 'm', project: project(4) }))[1],
    { w: 'w4', existed: true },
    'an open project is still focused at the cap',
  );
  assertEquals((await t.send({ op: 'close', from: 'w5', w: 'w5' }))[0], 200);
  assertEquals((await t.send({ op: 'open', from: 'm', project: project(9) }))[1], { w: 'w5', existed: false });
});

Deno.test('T2: at most 10 calls per 10 s -> 429', async () => {
  let now = 1_000_000;
  const dw = new FakeDesktopWindows();
  await using t = await lab(dw);
  (t.server.windows as { rate: RateLimit }).rate = new RateLimit(10, 10_000, () => now);
  for (let i = 0; i < 10; i++) assertEquals((await t.send({ op: 'focus', w: 'm' }))[0], 200, `call ${i + 1}`);
  const [status, a] = await t.send({ op: 'focus', w: 'm' });
  assertEquals([status, a.code], [429, 'rate']);
  assertEquals((await t.send({ op: 'open', from: 'm', project: PROJECT }))[0], 429, 'opens too');
  now += 10_001;
  assertEquals((await t.send({ op: 'focus', w: 'm' }))[0], 200, 'the window moved on');
});

Deno.test('T2: serve mode (no desktop app) -> 501 {browser: true}; the shape is still checked', async () => {
  await using t = await lab(null);
  t.unlimited();
  const [status, a] = await t.send({ op: 'open', from: 'm', project: PROJECT });
  assertEquals([status, a.browser], [501, true]);
  assertEquals((await t.send({ op: 'route', from: 'm', target: { project: 'p' } }))[0], 501);
  assertEquals((await t.send({ op: 'open', from: 'm' }))[0], 400);
});

Deno.test('T2: route answers self or the window that opened it; focus; a window closes only itself and leaves presence (B8)', async () => {
  const dw = new FakeDesktopWindows();
  await using t = await lab(dw);
  t.unlimited();
  await t.send({ op: 'open', from: 'm', project: PROJECT });
  await t.send({ op: 'popout', from: 'w2', chat: { key: 'claude:s1', project: PROJECT.key, title: 'CSV import' } });
  // the main window asks for a budget-app chat: budget-app's window opens it
  assertEquals((await t.send({ op: 'route', from: 'm', target: { project: PROJECT.key, chat: 'claude:s9' } }))[1], { to: 'w2' });
  assertEquals(dw.delivered.at(-1), ['w2', { project: PROJECT.key, chat: 'claude:s9' }]);
  // the popped-out chat goes to its pop-out, even from its project's window
  assertEquals((await t.send({ op: 'route', from: 'w2', target: { project: PROJECT.key, chat: 'claude:s1' } }))[1], { to: 'w3' });
  // budget-app's window asks for one of its own chats: open it here
  assertEquals((await t.send({ op: 'route', from: 'w2', target: { project: PROJECT.key, chat: 'claude:s2' } }))[1], { to: 'self' });
  // another project, no window of its own: the main window
  assertEquals((await t.send({ op: 'route', from: 'w2', target: { project: 'c:/other' } }))[1], { to: 'm' });
  assertEquals((await t.send({ op: 'focus', w: 'w3' }))[1], { ok: true });
  assertEquals((await t.send({ op: 'focus', w: 'w7' }))[0], 404);
  // close: only itself
  t.ctx.presence.reportWindow({ w: 'w3', kind: 'chat', chat: 'claude:s1', focused: true, open: ['claude:s1'] });
  assertEquals((await t.send({ op: 'close', from: 'w2', w: 'w3' }))[0], 403);
  assertEquals(dw.windows.length, 3);
  assertEquals((await t.send({ op: 'close', from: 'w3', w: 'w3' }))[1], { ok: true });
  assertEquals(dw.windows.map((x) => x.w), ['m', 'w2']);
  assertEquals([t.ctx.presence.focused(), t.ctx.presence.openOnPc()], [false, []], 'its presence slot went at once');
  assertEquals((await t.send({ op: 'close', from: 'w3', w: 'w3' }))[0], 404);
});

Deno.test('T2: parseWindowsRequest returns the cleaned request the K4 gets', () => {
  assertEquals(parseWindowsRequest({ op: 'open', from: 'm', project: { key: 'k', name: ' a\tb ', path: '/p' } }), {
    op: 'open',
    from: 'm',
    req: { project: { key: 'k', name: 'a b', path: '/p' } },
  });
  assertEquals(parseWindowsRequest({ op: 'route', from: 'w8', target: { project: 'k', doc: { project: 'k', name: 'D' } } }), {
    op: 'route',
    from: 'w8',
    target: { project: 'k', doc: { project: 'k', name: 'D' } },
  });
});
