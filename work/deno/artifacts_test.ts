/**
 * server/artifacts/artifacts.ts (artifacts.py): the cases of work/test_artifacts.py (StoreTests, the RouteTests that only need the
 * Service, WatcherTests, WriteTrackerTests) and work/test_artifacts_followups.py (ChatKeyed), parity with Python through
 * work/parity/artifacts_shim.py, and interop both ways on one store folder (Python and Deno share the state folder).
 *
 * Not ported here (they need a whole Studio): bootstrap's artifactOrigin, the Studio page CSP framing the origin, the Origin-header
 * gate on the routes (security.authorize, covered by security_test.ts), events reaching the conversation event list and
 * /api/live/state, SplitModeTests / InProcessModeTests (real web server + agent host), OwnToolApproval (studio.Connection).
 */
import { assert, assertEquals, assertThrows } from './_assert.ts';
import { PyParity } from './_parity.ts';
import {
  ArtifactError,
  ArtifactStore,
  authorizeToolKey,
  dumpManifest,
  guessTitle,
  kindFor,
  limits,
  type Manifest,
  MAX_SOURCE_BYTES,
  MAX_VERSIONS,
  previewable,
  type QueryArgs,
  type RequestLike,
  safeEntryName,
  Service,
  Watcher,
  WriteTracker,
} from '../../outputs/agent-studio/server/artifacts/artifacts.ts';
import { configure as configureKeys, issue } from '../../outputs/agent-studio/server/artifacts/keys.ts';
import { ArtifactHistory } from '../../outputs/agent-studio/server/docs/history.ts';

const WIN = Deno.build.os === 'windows';
const SEP = WIN ? '\\' : '/';
const enc = (text: string) => new TextEncoder().encode(text);
const join = (...parts: string[]) => parts.join(SEP);
const py = new PyParity();

class Clock {
  constructor(public t = 1000.0) {}
  now = () => this.t;
}

function temp(): { dir: string; [Symbol.dispose](): void } {
  const dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-artifacts-' })).replace(/^\\\\\?\\/, '');
  return {
    dir,
    [Symbol.dispose]() {
      try {
        Deno.removeSync(dir, { recursive: true });
      } catch { /* a Windows reader may still hold it */ }
    },
  };
}

function names(folder: string): string[] {
  return [...Deno.readDirSync(folder)].map((e) => e.name).sort();
}

function storeIn(dir: string, clock = new Clock()): ArtifactStore {
  const store = new ArtifactStore(join(dir, 'artifacts'), clock.now);
  store.origin = 'http://127.0.0.1:1';
  return store;
}

const headers = (values: Record<string, string> = { 'X-Studio-Token': 't' }): RequestLike => ({ headers: new Headers(values) });

// ---- StoreTests --------------------------------------------------------------------------------

function storeFixture() {
  const tmp = temp();
  const clock = new Clock();
  const store = storeIn(tmp.dir, clock);
  const make = (data = '<p>one</p>') => store.create('c1', 'Title', 'html', 'a.html', enc(data), { project: 'P', sourcePath: 'P/a.html' });
  return { tmp, clock, store, make };
}

Deno.test('store: create layout and summary', () => {
  const { tmp, store, make } = storeFixture();
  using _ = tmp;
  const m = make();
  assert(/^[0-9a-f]{16}$/.test(m.id));
  const folder = join(store.root, m.id);
  assertEquals(new TextDecoder().decode(Deno.readFileSync(join(folder, 'v1', 'a.html'))), '<p>one</p>');
  assert(Deno.statSync(join(folder, 'manifest.json')).isFile);
  assertEquals(names(folder).filter((n) => n.startsWith('.')), []);
  const s = store.summary(m);
  assertEquals(
    Object.keys(s).filter((k) => k !== 'viewUrl').sort(),
    ['conversationId', 'id', 'kind', 'link', 'pinned', 'sourcePath', 'title', 'updatedAt', 'url', 'version', 'versions'],
  );
  assertEquals(s.link, 'studio-artifact://' + m.id);
  assertEquals(s.url, `http://127.0.0.1:1/a/${m.id}/v1/a.html`);
});

Deno.test('store: identical hash adds no version', () => {
  const { tmp, clock, store, make } = storeFixture();
  using _ = tmp;
  const m = make();
  clock.t += 100;
  const [m2, changed] = store.addVersion(m.id, enc('<p>one</p>'));
  assertEquals(changed, false);
  assertEquals(m2.versions.length, 1);
});

Deno.test('store: new content adds a version and watch changes fold within 3 s', () => {
  const { tmp, clock, store, make } = storeFixture();
  using _ = tmp;
  let m = make();
  let changed: boolean;
  clock.t += 10;
  [m, changed] = store.addVersion(m.id, enc('two'), { by: 'watch' });
  assert(changed);
  assertEquals(m.versions.map((v) => v.n), [1, 2]);
  clock.t += 2;
  [m, changed] = store.addVersion(m.id, enc('three'), { by: 'watch' });
  assert(changed);
  assertEquals(m.versions.map((v) => v.n), [1, 2]);
  assertEquals(new TextDecoder().decode(Deno.readFileSync(join(store.root, m.id, 'v2', 'a.html'))), 'three');
  clock.t += 2.5;
  [m] = store.addVersion(m.id, enc('four'), { by: 'watch' });
  assertEquals(m.versions.length, 2);
  clock.t += 5;
  [m] = store.addVersion(m.id, enc('five'), { by: 'watch' });
  assertEquals(m.versions.length, 3);
  [m] = store.addVersion(m.id, enc('six'), { by: 'tool' }); // a tool publish never folds
  assertEquals(m.versions.length, 4);
});

Deno.test('store: retention by count keeps v1 and the latest; pinned keeps all', () => {
  const { tmp, clock, store, make } = storeFixture();
  using _ = tmp;
  let m = make();
  for (let i = 0; i < 40; i++) {
    clock.t += 10;
    [m] = store.addVersion(m.id, enc(`v${i}`));
  }
  const numbers = m.versions.map((v) => v.n);
  assertEquals(numbers.length, MAX_VERSIONS);
  assertEquals(numbers[0], 1);
  assertEquals(numbers[numbers.length - 1], 41);
  assertThrows(() => Deno.statSync(join(store.root, m.id, 'v2')));
  assert(Deno.statSync(join(store.root, m.id, 'v41')).isDirectory);
  let p = make('x');
  store.setPinned(p.id, true);
  for (let i = 0; i < 35; i++) {
    clock.t += 10;
    [p] = store.addVersion(p.id, enc(`p${i}`));
  }
  assertEquals(p.versions.length, 36);
});

Deno.test("store: a doc's history keeps every version from the last 30 days plus v1, past the 30-version cap", () => {
  const { tmp, clock, store } = storeFixture();
  using _ = tmp;
  const history = new ArtifactHistory(() => store);
  const doc = { name: 'plan', projectRoot: tmp.dir, artifactId: null as string | null };
  // a snapshot every 10 s for 10 minutes: 61 versions, twice the cap, all kept
  for (let i = 0; i <= 60; i++) {
    history.snapshot(doc, `{"rev":${i}}`, 'user', `rev ${i}`);
    clock.t += 10;
  }
  let m = store.get(doc.artifactId);
  assertEquals(m.versions.length, 61);
  assertEquals(history.list(doc).length, 61);
  // 31 days later: the old ones go, v1 and the new one stay
  clock.t += 31 * 24 * 3600;
  history.snapshot(doc, '{"rev":61}', 'user', 'rev 61');
  m = store.get(doc.artifactId);
  assertEquals(m.versions.map((v) => v.n), [1, 62]);
  assertThrows(() => Deno.statSync(join(store.root, m.id, 'v2')));
  assert(Deno.statSync(join(store.root, m.id, 'v1')).isDirectory);
  // the versions of the last 30 days stay: 40 more over 20 days (one every 12 h)
  for (let i = 0; i < 40; i++) {
    clock.t += 12 * 3600;
    history.snapshot(doc, `{"late":${i}}`, 'user', `rev ${100 + i}`);
  }
  m = store.get(doc.artifactId);
  assertEquals(m.versions.length, 42, 'v1, v62 (20 days old) and all 40');
  // an ordinary artifact still keeps 30
  let a = store.create('chat-1', 'Page', 'html', 'index.html', enc('0'));
  for (let i = 0; i < 40; i++) {
    clock.t += 10;
    [a] = store.addVersion(a.id, enc(`a${i}`));
  }
  assertEquals(a.versions.length, MAX_VERSIONS);
});

Deno.test('store: retention by size', () => {
  const { tmp, clock, store, make } = storeFixture();
  using _ = tmp;
  limits.maxBytes = 100;
  let m: Manifest;
  try {
    m = make('a'.repeat(10));
    for (let i = 0; i < 5; i++) {
      clock.t += 10;
      [m] = store.addVersion(m.id, enc(String.fromCharCode(65 + i).repeat(40)));
    }
  } finally {
    limits.maxBytes = 200 * 1024 * 1024;
  }
  const sizes = m.versions.map((v) => v.size);
  assertEquals(m.versions[0].n, 1);
  assert(sizes.reduce((a, b) => a + b, 0) <= 100 + Math.max(...sizes));
  assertEquals(m.versions[m.versions.length - 1].n, 6);
  assert(m.versions.length < 6);
});

Deno.test('store: restore copies forward; source and diff', () => {
  const { tmp, clock, store, make } = storeFixture();
  using _ = tmp;
  let m = make('line1\nline2\n');
  clock.t += 10;
  [m] = store.addVersion(m.id, enc('line1\nchanged\n'));
  let changed: boolean;
  [m, changed] = store.restore(m.id, 1);
  assert(changed);
  assertEquals(m.versions[m.versions.length - 1].n, 3);
  assertEquals(store.source(m.id, 3).text, 'line1\nline2\n');
  const diff = store.diff(m.id, 1, 2).diff;
  assert(diff.includes('--- v1'));
  assert(diff.includes('-line2'));
  assert(diff.includes('+changed'));
  [, changed] = store.restore(m.id, 3);
  assertEquals(changed, false);
});

Deno.test('store: a last line without a line break is its own line with the no-newline marker (QA M3)', () => {
  const { tmp, clock, store, make } = storeFixture();
  using _ = tmp;
  let m = make('<html>\n<p>v1</p>');
  clock.t += 10;
  [m] = store.addVersion(m.id, enc('<html>\n<p>v2</p>'));
  assertEquals(
    store.diff(m.id, 1, 2).diff,
    '--- v1\n+++ v2\n@@ -1,2 +1,2 @@\n <html>\n-<p>v1</p>\n\\ No newline at end of file\n+<p>v2</p>\n\\ No newline at end of file\n',
  );
  clock.t += 10;
  [m] = store.addVersion(m.id, enc('<html>\n<p>v2</p>\n'));
  assertEquals(
    store.diff(m.id, 2, 3).diff,
    '--- v2\n+++ v3\n@@ -1,2 +1,2 @@\n <html>\n-<p>v2</p>\n\\ No newline at end of file\n+<p>v2</p>\n',
  );
  clock.t += 10;
  [m] = store.addVersion(m.id, enc('<head>\n<p>v2</p>'));
  assert(store.diff(m.id, 3, 4).diff.endsWith('+<p>v2</p>\n\\ No newline at end of file\n'));
});

Deno.test('store: source is capped and binary kinds are refused', () => {
  const { tmp, store } = storeFixture();
  using _ = tmp;
  const big = store.create('c1', 'Big', 'text', 'b.txt', enc('x'.repeat(MAX_SOURCE_BYTES + 10)));
  const out = store.source(big.id);
  assert(out.truncated);
  assertEquals(out.text.length, MAX_SOURCE_BYTES);
  const img = store.create('c1', 'Pic', 'image', 'p.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  assertThrows(() => store.source(img.id), ArtifactError);
});

Deno.test('store: list order is pinned then newest; bad ids are refused', () => {
  const { tmp, clock, store, make } = storeFixture();
  using _ = tmp;
  const a = make('a');
  clock.t += 5;
  const b = make('b');
  clock.t += 5;
  const c = make('c');
  store.setPinned(a.id, true);
  assertEquals(store.list('c1').map((s) => s.id), [a.id, c.id, b.id]);
  assertEquals(store.list('other'), []);
  for (const bad of ['../x', 'zz', '', null, 'A'.repeat(16)]) assertThrows(() => store.get(bad), ArtifactError);
});

Deno.test('store: the manifest write is atomic and leaves no temp file', () => {
  const { tmp, store, make } = storeFixture();
  using _ = tmp;
  const m = make();
  store.setPinned(m.id, true);
  assertEquals(names(join(store.root, m.id)), ['manifest.json', 'v1']);
});

Deno.test('store: kind derivation', () => {
  const cases: [string, string | null][] = [
    ['a.HTML', 'html'],
    ['a.htm', 'html'],
    ['a.svg', 'svg'],
    ['a.md', 'md'],
    ['a.markdown', 'md'],
    [
      'a.png',
      'image',
    ],
    ['a.jpeg', 'image'],
    ['a.pdf', 'pdf'],
    ['a.csv', 'csv'],
    ['a.json', 'json'],
    ['a.txt', 'text'],
    ['a.log', 'text'],
    ['a.py', null],
  ];
  for (const [name, kind] of cases) assertEquals(kindFor(name), kind, name);
});

// ---- Service routes (RouteTests without a whole Studio) ----------------------------------------------

function serviceFixture(live: Record<string, string> = {}) {
  const tmp = temp();
  const project = join(tmp.dir, 'proj');
  Deno.mkdirSync(join(project, 'outputs'), { recursive: true });
  const page = join(project, 'outputs', 'report.html');
  Deno.writeTextFileSync(page, '<html><head><title>My report</title></head><body>hi</body></html>');
  const clock = new Clock();
  const store = storeIn(tmp.dir, clock);
  const events: [string, Record<string, unknown>][] = [];
  const service = new Service(store, () => 't', (id) => (id.startsWith('nope') ? null : project), {
    emit: (cid, event) => events.push([cid, event]),
    chatOf: (ident) => live[ident] ?? ident,
  });
  const get = (path: string, args: QueryArgs = {}, h = headers()) => service.handleGet(h, path, args) as [number, Record<string, unknown>];
  const post = (path: string, body: unknown, h = headers()) => service.handlePost(h, path, body) as [number, Record<string, unknown>];
  const preview = (path: string, cid = 'conn') => post('/api/live/artifacts/preview', { conversationId: cid, path });
  return { tmp, project, page, clock, store, events, service, get, post, preview, live };
}

Deno.test('routes: the token is required everywhere', () => {
  const { tmp, get, post } = serviceFixture();
  using _ = tmp;
  const gets: [string, QueryArgs][] = [['/api/live/artifacts', { conversationId: ['x'] }], ['/api/live/artifacts/item', { id: ['x'] }], [
    '/api/live/artifacts/source',
    { id: ['x'] },
  ], ['/api/live/artifacts/diff', { id: ['x'] }]];
  for (const [path, args] of gets) {
    assertEquals(get(path, args, headers({}))[0], 403, path);
    assertEquals(get(path, args, headers({ 'X-Studio-Token': 'wrong' }))[0], 403, path);
  }
  for (const path of ['preview', 'publish', 'pin', 'restore'].map((p) => '/api/live/artifacts/' + p)) {
    assertEquals(post(path, {}, headers({}))[0], 403, path);
    assertEquals(post(path, {}, headers({ 'X-Studio-Token': 'wrong' })), [403, { error: 'Invalid local session token' }], path);
  }
});

Deno.test('routes: preview creates, returns the same, adds a version on change', () => {
  const { tmp, page, get, preview } = serviceFixture({ conn: 'claude:sess' });
  using _ = tmp;
  const [status, first] = preview(page);
  assertEquals(status, 200, JSON.stringify(first));
  assertEquals([first.kind, first.title, first.version, first.versions], ['html', 'My report', 1, 1]);
  assertEquals(first.conversationId, 'claude:sess'); // keyed by the chat, not the connection
  assert(String(first.url).startsWith(`http://127.0.0.1:1/a/${first.id}/v1/`));
  const again = preview(page)[1];
  assertEquals([again.id, again.version], [first.id, 1]);
  Deno.writeTextFileSync(page, '<title>My report</title>changed');
  const third = preview('outputs/report.html')[1]; // a relative path works too
  assertEquals([third.id, third.version, third.versions], [first.id, 2, 2]);
  const listed = get('/api/live/artifacts', { conversationId: ['conn'] })[1].artifacts as Record<string, unknown>[];
  assertEquals(listed.map((a) => a.id), [first.id]);
  const item = get('/api/live/artifacts/item', { id: [first.id as string] })[1];
  assertEquals((item.versions as unknown[]).length, 2);
  assert((item.versions as Record<string, unknown>[]).every((v) => 'url' in v));
  assertEquals(item.url, third.url);
});

Deno.test('routes: the preview path must be inside the project', () => {
  const { tmp, project, page, preview, post } = serviceFixture();
  using _ = tmp;
  using other = temp();
  const outside = join(other.dir, 'x.html');
  Deno.writeTextFileSync(outside, '<p>x</p>');
  for (const p of [outside, '..\\..\\x.html', '../x.html']) assert([403, 404].includes(preview(p)[0]), p);
  assertEquals(preview(outside)[1].code, 'outside_project');
  Deno.writeTextFileSync(join(project, 'code.py'), 'print(1)');
  assertEquals(preview(join(project, 'code.py'))[0], 400);
  assertEquals(preview(join(project, 'missing.html'))[0], 404);
  assertEquals(post('/api/live/artifacts/preview', { conversationId: 'nope:none', path: page })[0], 404);
});

Deno.test('routes: publish content, update and validation', () => {
  const { tmp, page, get, post } = serviceFixture();
  using _ = tmp;
  const body = { conversationId: 'conn', title: 'Hello', content: '<h1>Hi</h1>' };
  const [status, s] = post('/api/live/artifacts/publish', body);
  assertEquals([status, s.kind, s.version], [200, 'html', 1]);
  const [status2, s2] = post('/api/live/artifacts/publish', { ...body, id: s.id, content: '<h1>Hi 2</h1>', note: 'n', toolCallId: 't1' });
  assertEquals([status2, s2.id, s2.version], [200, s.id, 2]);
  const item = get('/api/live/artifacts/item', { id: [s.id as string] })[1];
  const v2 = (item.versions as Record<string, unknown>[])[1];
  assertEquals([v2.note, v2.toolCallId, v2.by], ['n', 't1', 'tool']);
  assertEquals(post('/api/live/artifacts/publish', { ...body, id: s.id, content: '<h1>Hi 2</h1>' })[1].version, 2);
  const md = post('/api/live/artifacts/publish', { conversationId: 'conn', title: 'Notes', kind: 'md', content: '# T' })[1];
  assertEquals(md.kind, 'md');
  assert(String(md.viewUrl).endsWith('?view=1'));
  assertEquals(post('/api/live/artifacts/publish', { ...body, path: page })[0], 400); // both
  assertEquals(post('/api/live/artifacts/publish', { conversationId: 'conn', title: 'x' })[0], 400); // neither
  assertEquals(post('/api/live/artifacts/publish', { ...body, id: '0'.repeat(16) })[0], 404);
  assertEquals(post('/api/live/artifacts/publish', { ...body, kind: 'exe' })[0], 400);
  assertEquals(post('/api/live/artifacts/publish', { ...body, id: s.id, conversationId: 'some-other' })[0], 403);
});

Deno.test('routes: publish by path reuses the artifact for the same file', () => {
  const { tmp, page, post, preview } = serviceFixture();
  using _ = tmp;
  const a = preview(page)[1];
  const b = post('/api/live/artifacts/publish', { conversationId: 'conn', title: 'Better title', path: page })[1];
  assertEquals(a.id, b.id);
  assertEquals(b.title, 'Better title');
});

Deno.test('routes: pin, restore, source and diff', () => {
  const { tmp, page, get, post, preview } = serviceFixture();
  using _ = tmp;
  const s = preview(page)[1];
  Deno.writeTextFileSync(page, '<title>My report</title>\nsecond');
  assertEquals(preview(page)[1].version, 2);
  const id = s.id as string;
  assert(post('/api/live/artifacts/pin', { id, pinned: true })[1].pinned);
  assertEquals(post('/api/live/artifacts/pin', { id, pinned: 'yes' })[0], 400);
  const src = get('/api/live/artifacts/source', { id: [id], version: ['1'] })[1];
  assert(String(src.text).includes('hi'));
  assertEquals(src.truncated, false);
  assert(String(get('/api/live/artifacts/diff', { id: [id], from: ['1'], to: ['2'] })[1].diff).includes('+second'));
  assertEquals(post('/api/live/artifacts/restore', { id, version: 1 })[1].version, 3);
  assertEquals(post('/api/live/artifacts/restore', { id, version: 99 })[0], 404);
  assertEquals(get('/api/live/artifacts/source', { id: [id], version: ['77'] })[0], 404);
  assertEquals(get('/api/live/artifacts/source', { id: [id], version: ['x'] }), [400, { error: 'Invalid version', code: 'invalid' }]);
});

Deno.test('routes: events go out once per change', () => {
  const { tmp, page, events, post, preview } = serviceFixture();
  using _ = tmp;
  const s = preview(page)[1];
  assertEquals(events.length, 1);
  const [cid, data] = events[0];
  assertEquals([cid, data.type, data.conversationId, (data.artifact as Record<string, unknown>).id], ['conn', 'artifact', 'conn', s.id]);
  preview(page); // unchanged: no second event
  assertEquals(events.length, 1);
  post('/api/live/artifacts/pin', { id: s.id, pinned: true });
  assertEquals(events.length, 2);
});

Deno.test('routes: the tool key works for publish and list only', () => {
  const { tmp, page, get, post } = serviceFixture();
  using _ = tmp;
  using keys = temp();
  configureKeys(keys.dir);
  try {
    const keyed = headers({ 'X-Studio-Artifact-Key': issue('conn')! });
    const [status, s] = post('/api/live/artifacts/publish', { conversationId: 'conn', title: 'T', content: 'x', kind: 'text' }, keyed);
    assertEquals(status, 200, JSON.stringify(s));
    assertEquals(get('/api/live/artifacts', { conversationId: ['conn'] }, keyed)[0], 200);
    assertEquals(post('/api/live/artifacts/publish', { conversationId: 'other', title: 'T', content: 'x' }, keyed), [403, {
      error: 'Invalid artifact key',
    }]);
    assertEquals(get('/api/live/artifacts', { conversationId: ['other'] }, keyed)[0], 403);
    assertEquals(get('/api/live/artifacts/item', { id: [s.id as string] }, keyed)[0], 403);
    assertEquals(post('/api/live/artifacts/pin', { id: s.id, pinned: true }, keyed)[0], 403);
    assertEquals(post('/api/live/artifacts/preview', { conversationId: 'conn', path: page }, keyed)[0], 403);
    assertEquals(get('/api/live/artifacts/source', { id: [s.id as string] }, keyed)[0], 403);
  } finally {
    configureKeys(null);
  }
});

Deno.test('routes: the key hook denies by default', () => {
  configureKeys(null);
  assertEquals(authorizeToolKey(headers({ 'X-Studio-Artifact-Key': 'anything' }), 'c'), false);
});

// ---- test_artifacts_followups.ChatKeyed ------------------------------------------------------------

Deno.test('chat keyed: stored under the chat and found after a reconnect', () => {
  const live: Record<string, string> = { 'conn-1': 'claude:sess-A' };
  const f = serviceFixture(live);
  using _ = f.tmp;
  const publish = (conn: string, extra: Record<string, unknown> = {}) =>
    f.post('/api/live/artifacts/publish', { conversationId: conn, title: 'Page', content: '<h1>x</h1>', filename: 'p.html', ...extra });
  const [status, summary] = publish('conn-1');
  assertEquals(status, 200);
  assertEquals(summary.conversationId, 'claude:sess-A');
  assertEquals(f.events[f.events.length - 1][0], 'claude:sess-A');
  delete live['conn-1'];
  live['conn-2'] = 'claude:sess-A';
  assertEquals((f.get('/api/live/artifacts', { conversationId: ['conn-2'] })[1].artifacts as Record<string, unknown>[]).map((a) => a.id), [
    summary.id,
  ]);
  const [status2, again] = f.post('/api/live/artifacts/publish', {
    conversationId: 'conn-2',
    id: summary.id,
    content: '<h1>v2</h1>',
    filename: 'p.html',
  });
  assertEquals([status2, again.version], [200, 2]);
  // other chats stay separate
  live['conn-9'] = 'claude:sess-B';
  assertEquals(f.get('/api/live/artifacts', { conversationId: ['conn-9'] })[1].artifacts, []);
  assertEquals(publish('conn-9', { id: summary.id })[0], 403);
  // artifacts saved under an old connection id still list
  f.store.create('conn-1', 'Old', 'html', 'o.html', enc('<p>o</p>'));
  assertEquals(
    (f.get('/api/live/artifacts', { conversationId: ['conn-1'] })[1].artifacts as Record<string, unknown>[]).map((a) => a.title),
    [
      'Old',
    ],
  );
});

// ---- WatcherTests ------------------------------------------------------------------------------------

function watcherFixture() {
  const tmp = temp();
  const project = join(tmp.dir, 'proj');
  Deno.mkdirSync(join(project, 'outputs'), { recursive: true });
  const clock = new Clock();
  const store = storeIn(tmp.dir, clock);
  const events: [string, Record<string, unknown>][] = [];
  const service = new Service(store, () => 't', () => project, { emit: (cid, ev) => events.push([cid, ev]) });
  const writes: Record<string, string[]> = { c1: [], c2: [] };
  const state = { now: 100.0 };
  const watcher = new Watcher(service, () => Object.entries(writes).map(([id, paths]) => ({ id, cwd: project, writes: [...paths] })), {
    clock: () => state.now,
    listEvery: 0,
  });
  const tick = (advance = 1.0) => {
    state.now += advance;
    watcher.tick();
  };
  let stamp = Date.now();
  const write = (name: string, text: string, by: string | null = null) => {
    const path = join(project, 'outputs', name);
    Deno.writeTextFileSync(path, text);
    stamp += 1000;
    Deno.utimeSync(path, new Date(stamp), new Date(stamp));
    if (by && !writes[by].includes(path)) writes[by].push(path);
    return path;
  };
  return { tmp, project, clock, store, events, service, writes, tick, write };
}

Deno.test('watcher: an agent-written file becomes an artifact after settling, and changes add versions', () => {
  const { tmp, clock, store, events, tick, write } = watcherFixture();
  using _ = tmp;
  tick();
  write('page.html', '<title>Page</title>', 'c1');
  tick(0.3);
  assertEquals(store.all(), []); // not settled yet
  tick(0.7);
  assertEquals(store.all().length, 1);
  let manifest = store.all()[0];
  assertEquals([manifest.title, manifest.versions[0].by, manifest.conversationId], ['Page', 'watch', 'c1']);
  assertEquals(events.length, 1);
  assertEquals((events[0][1].artifact as Record<string, unknown>).id, manifest.id);
  clock.t += 20;
  write('page.html', '<title>Page</title>two');
  tick(0.2);
  tick(0.7);
  manifest = store.get(manifest.id);
  assertEquals(manifest.versions.length, 2);
  assertEquals(events.length, 2);
  tick();
  tick();
  assertEquals(events.length, 2);
  clock.t += 1;
  write('page.html', '<title>Page</title>three!');
  tick(0.2);
  tick(0.7);
  assertEquals(store.get(manifest.id).versions.length, 2);
  assertEquals(store.source(manifest.id).text, '<title>Page</title>three!');
});

Deno.test('watcher: a file goes to the chat whose agent wrote it, even in the same folder', () => {
  const { tmp, store, tick, write } = watcherFixture();
  using _ = tmp;
  write('a.html', '<title>A</title>', 'c1');
  write('b.html', '<title>B</title>', 'c2');
  tick(0.1);
  tick(0.8);
  assertEquals(Object.fromEntries(store.all().map((m) => [m.title, m.conversationId])), { A: 'c1', B: 'c2' });
});

Deno.test('watcher: a file changed on disk without an agent write attaches to nobody', () => {
  const { tmp, store, events, tick, write } = watcherFixture();
  using _ = tmp;
  tick();
  write('merge.html', '<title>Merged</title>');
  write('merge2.csv', 'a,b\n1,2');
  tick(0.1);
  tick(0.8);
  tick(5);
  assertEquals(store.all(), []);
  assertEquals(events, []);
});

Deno.test('watcher: agent writes outside outputs or not previewable are ignored', () => {
  const { tmp, project, store, writes, tick, write } = watcherFixture();
  using _ = tmp;
  write('script.py', 'x', 'c1');
  const elsewhere = join(project, 'notes.html');
  Deno.writeTextFileSync(elsewhere, '<title>N</title>');
  writes.c1.push(elsewhere);
  tick(0.1);
  tick(0.8);
  assertEquals(store.all(), []);
});

Deno.test('watcher: writes in progress settle into one snapshot', () => {
  const { tmp, store, tick, write } = watcherFixture();
  using _ = tmp;
  tick();
  write('a.md', '# part', 'c1');
  tick(0.3);
  write('a.md', '# part two longer');
  tick(0.3);
  write('a.md', '# part two longer still');
  tick(0.3);
  assertEquals(store.all(), []);
  tick(0.7);
  const manifest = store.all()[0];
  assertEquals(manifest.versions.length, 1);
  assertEquals(store.source(manifest.id).text, '# part two longer still');
});

Deno.test('watcher: an existing artifact source is tracked, with the missing flag', () => {
  const { tmp, project, clock, store, events, service, tick, write } = watcherFixture();
  using _ = tmp;
  const path = write('r.html', 'v1'); // no agent write: a preview artifact (the user clicked a file link)
  const [, real] = service.resolvePath('c1', path);
  const [manifest] = service.syncFile('c1', real, 'preview', { cwd: project });
  tick();
  assertEquals(events, []);
  clock.t += 30;
  write('r.html', 'v2 changed');
  tick(0.1);
  tick(0.8);
  assertEquals(store.get(manifest.id).versions.length, 2);
  Deno.removeSync(path);
  tick();
  assertEquals(store.get(manifest.id).sourceMissing, true);
  assertEquals(store.get(manifest.id).versions.length, 2); // the artifact stays
  assertEquals((events[events.length - 1][1].artifact as Record<string, unknown>).sourceMissing, true);
  const count = events.length;
  tick();
  assertEquals(events.length, count);
  clock.t += 30;
  write('r.html', 'v3 back');
  tick(0.1);
  tick(0.8);
  assertEquals(store.get(manifest.id).sourceMissing, undefined);
  assertEquals(store.get(manifest.id).versions.length, 3);
});

Deno.test('watcher: the poll loop starts and stops', async () => {
  const { tmp, service } = watcherFixture();
  using _ = tmp;
  let calls = 0;
  const watcher = new Watcher(service, () => (calls++, []), { interval: 0.02 });
  watcher.start();
  assert(watcher.alive);
  await new Promise((resolve) => setTimeout(resolve, 120));
  watcher.stop();
  assertEquals(watcher.alive, false);
  assert(calls >= 1, 'it ticked');
});

// ---- WriteTrackerTests -------------------------------------------------------------------------------

const update = (fields: Record<string, unknown>) => ({
  sessionId: 's',
  update: { sessionUpdate: 'tool_call', toolCallId: 't1', ...fields },
});
const abs = (path: string) => join(Deno.cwd(), ...path.split('/'));

Deno.test('tracker: edit calls with diffs or locations count; relative paths use the cwd', () => {
  const cwd = abs('proj');
  const tracker = new WriteTracker(cwd);
  tracker.observe(update({ kind: 'edit', content: [{ type: 'diff', path: join(cwd, 'outputs', 'a.html'), newText: 'x' }] }));
  tracker.observe(update({ toolCallId: 't2', kind: 'edit', locations: [{ path: 'outputs/b.html' }] }));
  assertEquals(tracker.written().sort(), [join(cwd, 'outputs', 'a.html'), join(cwd, 'outputs', 'b.html')].sort());
});

Deno.test('tracker: reads, searches and commands never count', () => {
  const tracker = new WriteTracker(abs('proj'));
  tracker.observe(update({ kind: 'read', locations: [{ path: abs('x.html') }] }));
  tracker.observe(update({ toolCallId: 't2', kind: 'execute', rawInput: { file_path: abs('y.html') } }));
  tracker.observe(update({ toolCallId: 't3', sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'z' } }));
  tracker.observe(update({ toolCallId: 't4', _meta: { claudeCode: { toolName: 'Read' } }, rawInput: { file_path: abs('w.html') } }));
  assertEquals(tracker.written(), []);
});

Deno.test("tracker: Claude Code's tool names, and later updates without a kind", () => {
  const target = abs('outputs/c.html');
  const tracker = new WriteTracker(Deno.cwd());
  tracker.observe(update({ _meta: { claudeCode: { toolName: 'Write' } }, rawInput: { file_path: target } }));
  assertEquals(tracker.written(), [target]);
  tracker.observe(
    update({ toolCallId: 't9', _meta: { claudeCode: { toolName: 'mcp__x__NotebookEdit' } }, rawInput: { notebook_path: target + '2' } }),
  );
  tracker.observe(update({ toolCallId: 't1', sessionUpdate: 'tool_call_update', locations: [{ path: target + '3' }] })); // t1 was a write
  tracker.observe(update({ toolCallId: 'other', sessionUpdate: 'tool_call_update', locations: [{ path: target + '4' }] })); // unknown: ignored
  assertEquals(tracker.written(), ['', '2', '3'].map((s) => target + s));
});

// ---- parity with Python ------------------------------------------------------------------------------

type Step = { call?: string; args?: unknown[]; kwargs?: Record<string, unknown>; clock?: number; limits?: Record<string, number> };
type Result = { ok?: unknown; error?: string; message?: string; status?: number | null; code?: string | null };

const CAMEL: Record<string, string> = { source_path: 'sourcePath', tool_call_id: 'toolCallId', conversation_id: 'conversationId' };

function denoArg(value: unknown, results: Result[]): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const v = value as Record<string, unknown>;
    if ('ref' in v) {
      const found = results[v.ref as number].ok;
      return ((Array.isArray(found) ? found[0] : found) as Record<string, unknown>).id;
    }
    if ('bytes' in v) return enc(v.bytes as string);
    if ('hex' in v) return Uint8Array.from((v.hex as string).match(/../g) ?? [], (h) => parseInt(h, 16));
  }
  return value;
}

/** artifacts_shim.store_run for the Deno store. */
function storeRun(root: string, steps: Step[], clockAt = 1000.0): Result[] {
  const clock = new Clock(clockAt);
  const store = new ArtifactStore(root, clock.now);
  store.origin = 'http://127.0.0.1:1';
  const results: Result[] = [];
  const saved = { ...limits };
  try {
    for (const step of steps) {
      if (step.clock !== undefined) {
        clock.t = step.clock;
        results.push({ ok: null });
        continue;
      }
      if (step.limits) {
        if (step.limits.MAX_BYTES !== undefined) limits.maxBytes = step.limits.MAX_BYTES;
        if (step.limits.MAX_VERSIONS !== undefined) limits.maxVersions = step.limits.MAX_VERSIONS;
        results.push({ ok: null });
        continue;
      }
      const args = (step.args ?? []).map((a) => denoArg(a, results));
      const options = Object.fromEntries(Object.entries(step.kwargs ?? {}).map(([k, v]) => [CAMEL[k] ?? k, denoArg(v, results)]));
      const s = store as unknown as Record<string, (...a: unknown[]) => unknown>;
      const method = step.call!.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
      try {
        const value = ['create', 'addVersion'].includes(method)
          ? s[method](...args, options)
          : s[method](...args, ...Object.values(options));
        results.push({ ok: JSON.parse(JSON.stringify(value ?? null)) });
      } catch (error) {
        const e = error as ArtifactError;
        results.push({ error: e.name, message: e.message, status: e.status ?? null, code: e.code ?? null });
      }
    }
  } finally {
    Object.assign(limits, saved);
  }
  return results;
}

/** Replace ids (16 hex) by their order of appearance and the store roots by <root>, so two runs compare. */
function normalize(value: unknown, roots: string[]): unknown {
  let text = JSON.stringify(value);
  for (const root of roots) text = text.replaceAll(JSON.stringify(root).slice(1, -1), '<root>');
  const ids = new Map<string, string>();
  text = text.replace(/(?<![0-9a-f])[0-9a-f]{16}(?![0-9a-f])/g, (id) => {
    if (!ids.has(id)) ids.set(id, `<id${ids.size}>`);
    return ids.get(id)!;
  });
  return untie(JSON.parse(text));
}

/**
 * Lists order by (pinned, newest); artifacts saved in the same second come in folder order, which follows their random ids, so
 * two runs can differ there. Break those ties by the normalized id on both sides.
 */
function untie(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(untie) as Record<string, unknown>[];
    if (items.length && items.every((x) => x && typeof x === 'object' && 'link' in x && 'updatedAt' in x)) {
      items.sort((x, y) =>
        Number(!x.pinned) - Number(!y.pinned) || (y.updatedAt as number) - (x.updatedAt as number) ||
        String(x.id).localeCompare(String(y.id))
      );
    }
    return items;
  }
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, untie(v)]));
  return value;
}

/** Python's results normalized like ours (Python errors are ArtifactError / FileNotFoundError...). */
function errorKinds(results: Result[]): Result[] {
  return results.map((
    r,
  ) => (r.error ? { error: r.error === 'ArtifactError' ? 'ArtifactError' : 'OSError', status: r.status, code: r.code } : r));
}

async function sameStoreRun(steps: Step[]): Promise<{ deno: string; python: string }> {
  using a = temp();
  using b = temp();
  const denoRoot = join(a.dir, 'artifacts');
  const pyRoot = join(b.dir, 'artifacts');
  const mine = storeRun(denoRoot, steps);
  const theirs = await py.call('artifacts_shim', 'store_run', [pyRoot, steps]) as Result[];
  assertSame(normalize(errorKinds(mine), [denoRoot]), normalize(errorKinds(theirs), [pyRoot]));
  for (const [i, r] of theirs.entries()) if (r.error) assertEquals(mine[i].message, r.message, `message of step ${i}`);
  // the manifests on disk are byte-identical (ids aside)
  const text = (root: string) =>
    [...Deno.readDirSync(root)].filter((e) => e.isDirectory).map((e) => Deno.readTextFileSync(join(root, e.name, 'manifest.json')));
  const order = (root: string, texts: string[]) => texts.map((t) => normalize(t, [root]) as string).sort();
  assertEquals(order(denoRoot, text(denoRoot)), order(pyRoot, text(pyRoot)));
  return { deno: denoRoot, python: pyRoot };
}

/** assertEquals that names the first differing path (the values here are long). */
function assertSame(actual: unknown, expected: unknown, path = '$'): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) return;
  if (actual && expected && typeof actual === 'object' && typeof expected === 'object') {
    const keys = new Set([...Object.keys(actual), ...Object.keys(expected)]);
    for (const key of keys) {
      const a = (actual as Record<string, unknown>)[key], e = (expected as Record<string, unknown>)[key];
      if (JSON.stringify(a) !== JSON.stringify(e)) return assertSame(a, e, `${path}.${key}`);
    }
  }
  assertEquals(actual, expected, path);
}

const b = (text: string) => ({ bytes: text });

Deno.test('parity: store operations give the same results and the same manifest bytes', async () => {
  await sameStoreRun([
    { call: 'create', args: ['c1', 'Title', 'html', 'a.html', b('<p>one</p>')], kwargs: { project: 'P', source_path: 'P/a.html' } },
    { clock: 1010.25 },
    { call: 'add_version', args: [{ ref: 0 }, b('two')], kwargs: { by: 'watch' } },
    { clock: 1012.5 },
    { call: 'add_version', args: [{ ref: 0 }, b('three')], kwargs: { by: 'watch', note: 'folded' } },
    { clock: 1030.125 },
    { call: 'add_version', args: [{ ref: 0 }, b('four é 😀')], kwargs: { title: 'New title ✓', tool_call_id: 'tc-1', note: 'n' } },
    { call: 'add_version', args: [{ ref: 0 }, b('four é 😀')] },
    { call: 'set_pinned', args: [{ ref: 0 }, true] },
    { call: 'set_pinned', args: [{ ref: 0 }, true] },
    { call: 'set_source_missing', args: [{ ref: 0 }, true] },
    { call: 'get', args: [{ ref: 0 }] },
    { call: 'set_source_missing', args: [{ ref: 0 }, false] },
    { call: 'restore', args: [{ ref: 0 }, 1] },
    { call: 'restore', args: [{ ref: 0 }, 99] },
    { call: 'item', args: [{ ref: 0 }] },
    { call: 'list', args: ['c1'] },
    { call: 'list', args: [] },
    { call: 'source', args: [{ ref: 0 }, 2] },
    { call: 'source', args: [{ ref: 0 }, 77] },
    { call: 'diff', args: [{ ref: 0 }, 1, 4] },
    { call: 'create', args: ['c2', null, 'md', 'n o.md', b('# x')], kwargs: { by: 'preview' } },
    { call: 'create', args: ['c2', 'x', 'exe', 'n.exe', b('x')] },
    { call: 'get', args: ['../x'] },
    { call: 'get', args: ['0123456789abcdef'] },
    { call: 'create', args: ['c3', 'Pic', 'image', 'p.png', { hex: '89504e470d0a' }] },
    { call: 'source', args: [{ ref: 25 }] },
    { call: 'list', args: ['c3', ['c2']] },
  ]);
});

Deno.test('parity: retention by count and by size', async () => {
  const steps: Step[] = [{ call: 'create', args: ['c1', 'T', 'text', 't.txt', b('start')] }];
  for (let i = 0; i < 35; i++) steps.push({ clock: 1000 + 10 * (i + 1) }, { call: 'add_version', args: [{ ref: 0 }, b(`v${i}`)] });
  steps.push({ limits: { MAX_BYTES: 100 } });
  steps.push({ call: 'create', args: ['c1', 'S', 'text', 's.txt', b('a'.repeat(10))] });
  const sized = steps.length - 1;
  for (let i = 0; i < 5; i++) {
    steps.push({ clock: 2000 + 10 * i }, { call: 'add_version', args: [{ ref: sized }, b(String.fromCharCode(65 + i).repeat(40))] });
  }
  steps.push({ call: 'get', args: [{ ref: 0 }] }, { call: 'get', args: [{ ref: sized }] });
  await sameStoreRun(steps);
});

Deno.test('parity: unified diffs match difflib', async () => {
  const many = Array.from({ length: 260 }, (_, i) => (i % 3 === 0 ? 'same\n' : `line ${i}\n`)).join('');
  const manyChanged = many.replace('line 100\n', 'LINE 100\n').replace('line 250\n', '') + 'tail';
  const pairs: [string, string][] = [
    ['line1\nline2\n', 'line1\nchanged\n'],
    ['', 'new\n'],
    ['a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\n', 'a\nB\nc\nd\ne\nf\ng\nh\ni\nJ\nk\n'],
    ['no newline', 'no newline at all'],
    ['crlf\r\nline\r\n', 'crlf\r\nLINE\r\nmore\r\n'],
    ['sep x y\x0bz\x0cw\x1cv\x85u\n', 'sep X y\x0bz\x0cw\x1cv\x85u\n'],
    ['same\n', 'same\n'],
    [many, manyChanged],
    ['x\n'.repeat(300), 'x\n'.repeat(150) + 'y\n' + 'x\n'.repeat(150)],
  ];
  const steps: Step[] = [];
  for (const [x, y] of pairs) {
    const at = steps.length;
    steps.push({ call: 'create', args: ['c', 'D', 'text', 'd.txt', b(x)] }, { call: 'add_version', args: [{ ref: at }, b(y)] }, {
      call: 'diff',
      args: [{ ref: at }, 1, 2],
    }, { call: 'diff', args: [{ ref: at }, 2, 1] });
  }
  steps.push({ call: 'create', args: ['c', 'Bad', 'text', 'bad.txt', { hex: 'e9ff41c3' }] }, {
    call: 'source',
    args: [{ ref: steps.length }],
  });
  await sameStoreRun(steps);
});

Deno.test('parity: names, kinds and titles', async () => {
  await py.same(
    'artifacts',
    'kind_for',
    ['a.HTML', 'x/y.md', 'a.', '.html', 'C:x.svg', 'dir\\a.json', 'a.tar.gz', 'noext', 'a.Markdown', 'a.htm/', 'é.PNG'].map((n) => [n]),
    kindFor,
  );
  await py.same('artifacts', 'previewable', [['a.pdf'], ['a.exe']], previewable);
  const names = [
    'report.html',
    '../../etc/passwd',
    'a\\b\\c.md',
    'we ird*name?.html',
    ' .hidden. ',
    '',
    'é😀 (1) [x].txt',
    'x'.repeat(200) + '.html',
    'C:evil.html',
    '...',
  ];
  await py.same('artifacts', 'safe_entry_name', names.map((n) => [n]), (n: string) => safeEntryName(n));
  await py.same('artifacts', 'safe_entry_name', [[null, 'fallback'], ['***', 'f']], (n: string, f: string) => safeEntryName(n, f));
  const titles: [string, string, string][] = [
    ['my_report-v2.html', 'html', '<html><TITLE lang="x">  A\n\t title   </title>'],
    ['x.html', 'html', '<title></title>'],
    ['x-y_z.md', 'md', '<title>ignored</title>'],
    ['  .html', 'html', 'none'],
    ['t.html', 'html', '<title>é ✓ ' + 'x'.repeat(300) + '</title>'],
  ];
  await py.same('artifacts_shim', 'guess_title', titles, (p: string, k: string, t: string) => guessTitle(p, k, enc(t)));
});

/** artifacts_shim.service_run for the Deno service. */
function serviceRun(root: string, project: string, steps: Record<string, unknown>[], live: Record<string, string> = {}) {
  const clock = new Clock();
  const store = new ArtifactStore(root, clock.now);
  store.origin = 'http://127.0.0.1:1';
  const events: unknown[] = [];
  const service = new Service(store, () => 't', (id) => (id.startsWith('nope') ? null : project), {
    emit: (cid, event) => events.push([cid, event]),
    chatOf: (ident) => live[ident] ?? ident,
  });
  const results: [number, unknown][] = [];
  const refs = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(refs);
    if (value && typeof value === 'object') {
      const v = value as Record<string, unknown>;
      if (Object.keys(v).length === 1 && 'ref' in v) return (results[v.ref as number][1] as Record<string, unknown>).id;
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, refs(x)]));
    }
    return value;
  };
  for (const step of steps) {
    if ('clock' in step) {
      clock.t = step.clock as number;
      continue;
    }
    if ('write' in step) {
      const [rel, text] = step.write as [string, string];
      const path = join(project, ...rel.split('/'));
      Deno.mkdirSync(path.slice(0, path.lastIndexOf(SEP)), { recursive: true });
      Deno.writeTextFileSync(path, text);
      continue;
    }
    const h = headers((step.headers as Record<string, string>) ?? { 'X-Studio-Token': 't' });
    const reply = 'get' in step
      ? service.handleGet(h, step.get as string, refs(step.args ?? {}) as QueryArgs)
      : service.handlePost(h, step.post as string, refs(step.body));
    results.push(JSON.parse(JSON.stringify(reply)));
  }
  return { results, events };
}

Deno.test('parity: the routes answer as Python does', async () => {
  using a = temp();
  using c = temp();
  const steps: Record<string, unknown>[] = [
    { write: ['outputs/report.html', '<html><head><title>My report</title></head><body>hi</body></html>'] },
    { write: ['outputs/notes.md', '# Notes\n'] },
    { write: ['code.py', 'print(1)'] },
    { post: '/api/live/artifacts/preview', body: { conversationId: 'conn', path: 'outputs/report.html' } },
    { post: '/api/live/artifacts/preview', body: { conversationId: 'conn', path: 'outputs/report.html' } },
    { clock: 1050.5 },
    { write: ['outputs/report.html', '<title>My report</title>\nsecond'] },
    { post: '/api/live/artifacts/preview', body: { conversationId: 'conn', path: 'outputs/report.html' } },
    { post: '/api/live/artifacts/preview', body: { conversationId: 'conn', path: 'code.py' } },
    { post: '/api/live/artifacts/preview', body: { conversationId: 'conn', path: 'missing.html' } },
    { post: '/api/live/artifacts/preview', body: { conversationId: 'conn', path: '../outside.html' } },
    { post: '/api/live/artifacts/preview', body: { conversationId: 'nope', path: 'outputs/report.html' } },
    { post: '/api/live/artifacts/preview', body: { conversationId: 'conn', path: '' } },
    { post: '/api/live/artifacts/preview', body: { conversationId: '', path: 'x' } },
    { post: '/api/live/artifacts/preview', body: ['not', 'a', 'dict'] },
    { post: '/api/live/artifacts/publish', body: { conversationId: 'conn', title: 'Hello World', content: '<h1>Hi</h1>' } },
    {
      post: '/api/live/artifacts/publish',
      body: { conversationId: 'conn', id: { ref: 10 }, content: '<h1>Hi 2</h1>', note: 'n', toolCallId: 't1' },
    },
    { post: '/api/live/artifacts/publish', body: { conversationId: 'conn', title: 'Data', kind: 'json', content: '{}' } },
    { post: '/api/live/artifacts/publish', body: { conversationId: 'conn', content: 'x', filename: 'table.csv' } },
    { post: '/api/live/artifacts/publish', body: { conversationId: 'conn', content: 'x', filename: 'pic.png' } },
    { post: '/api/live/artifacts/publish', body: { conversationId: 'conn', content: 'x', filename: 'prog.exe' } },
    { post: '/api/live/artifacts/publish', body: { conversationId: 'conn', content: 'x', kind: 'md', filename: 'n.txt' } },
    { post: '/api/live/artifacts/publish', body: { conversationId: 'conn', content: 'x', kind: 'image' } },
    { post: '/api/live/artifacts/publish', body: { conversationId: 'conn', content: 5 } },
    { post: '/api/live/artifacts/publish', body: { conversationId: 'conn', content: 'x', title: 7 } },
    { post: '/api/live/artifacts/publish', body: { conversationId: 'conn', title: 'Better', path: 'outputs/notes.md' } },
    { post: '/api/live/artifacts/publish', body: { conversationId: 'other', id: { ref: 10 }, content: 'x' } },
    { post: '/api/live/artifacts/publish', body: { conversationId: 'conn', id: 'zz', content: 'x' } },
    { post: '/api/live/artifacts/pin', body: { id: { ref: 0 }, pinned: true } },
    { post: '/api/live/artifacts/pin', body: { id: { ref: 0 }, pinned: true } },
    { post: '/api/live/artifacts/pin', body: { id: { ref: 0 }, pinned: 1 } },
    { post: '/api/live/artifacts/restore', body: { id: { ref: 0 }, version: 1 } },
    { post: '/api/live/artifacts/restore', body: { id: { ref: 0 }, version: true } },
    { post: '/api/live/artifacts/restore', body: { id: { ref: 0 }, version: 42 } },
    { post: '/api/live/artifacts/nothing', body: {} },
    { get: '/api/live/artifacts', args: { conversationId: ['conn'] } },
    { get: '/api/live/artifacts', args: {} },
    { get: '/api/live/artifacts/item', args: { id: [{ ref: 0 }] } },
    { get: '/api/live/artifacts/source', args: { id: [{ ref: 0 }], version: ['1'] } },
    { get: '/api/live/artifacts/source', args: { id: [{ ref: 0 }], version: [' 2 '] } },
    { get: '/api/live/artifacts/diff', args: { id: [{ ref: 0 }] } },
    { get: '/api/live/artifacts/diff', args: { id: [{ ref: 0 }], from: ['1'], to: ['3'] } },
    { get: '/api/live/artifacts/diff', args: { id: [{ ref: 0 }], from: ['x'] } },
    { get: '/api/live/artifacts/item', args: { id: ['0000000000000000'] } },
    { get: '/api/live/artifacts/nothing', args: {} },
    { get: '/api/live/artifacts/item', args: {}, headers: {} },
    { post: '/api/live/artifacts/publish', body: {}, headers: { 'X-Studio-Artifact-Key': 'k' } },
  ];
  const denoProject = join(a.dir, 'proj'), pyProject = join(c.dir, 'proj');
  const live = { conn: 'claude:S' };
  const mine = serviceRun(join(a.dir, 'artifacts'), denoProject, steps, live);
  const theirs = await py.call('artifacts_shim', 'service_run', [join(c.dir, 'artifacts'), pyProject, steps, live]);
  assertSame(normalize(mine, [a.dir]), normalize(theirs, [c.dir]));
});

/** artifacts_shim.watcher_run for the Deno watcher. */
function watcherRun(root: string, project: string, steps: Record<string, unknown>[]) {
  const clock = new Clock();
  const store = new ArtifactStore(root, clock.now);
  store.origin = 'http://127.0.0.1:1';
  const events: unknown[] = [];
  const service = new Service(store, () => 't', () => project, { emit: (cid, event) => events.push([cid, event]) });
  const writes: Record<string, string[]> = { c1: [], c2: [] };
  let now = 100.0;
  const watcher = new Watcher(service, () => Object.entries(writes).map(([id, paths]) => ({ id, cwd: project, writes: [...paths] })), {
    clock: () => now,
    listEvery: 0,
  });
  const outputs = join(project, 'outputs');
  Deno.mkdirSync(outputs, { recursive: true });
  for (const step of steps) {
    if ('tick' in step) {
      now += step.tick as number;
      watcher.tick();
    } else if ('clock' in step) clock.t += step.clock as number;
    else if ('write' in step) {
      const [name, text, by, stamp] = step.write as [string, string, string | null, number];
      const path = join(outputs, name);
      Deno.writeTextFileSync(path, text);
      Deno.utimeSync(path, new Date(stamp / 1e6), new Date(stamp / 1e6));
      if (by && !writes[by].includes(path)) writes[by].push(path);
    } else if ('unlink' in step) Deno.removeSync(join(outputs, step.unlink as string));
    else if ('preview' in step) {
      const [cid, name] = step.preview as [string, string];
      const [, real] = service.resolvePath(cid, join(outputs, name));
      service.syncFile(cid, real, 'preview', { cwd: project });
    }
  }
  const manifests = store.all().sort((x, y) => (x.createdAt as number) - (y.createdAt as number));
  return { events, store: JSON.parse(JSON.stringify(manifests.map((m) => ({ ...store.summary(m), byes: m.versions.map((v) => v.by) })))) };
}

Deno.test('parity: the watcher does what Python does for the same writes', async () => {
  using a = temp();
  using c = temp();
  const base = 1_700_000_000_000_000_000;
  let n = 0;
  const at = () => base + 1_000_000_000 * ++n;
  const steps: Record<string, unknown>[] = [
    { tick: 1 },
    { write: ['page.html', '<title>Page</title>', 'c1', at()] },
    { write: ['other.html', '<title>Other</title>', 'c2', at()] },
    { write: ['merged.html', '<title>Merged</title>', null, at()] },
    { write: ['.hidden.html', 'h', 'c1', at()] },
    { write: ['script.py', 'x', 'c1', at()] },
    { tick: 0.3 },
    { tick: 0.7 },
    { clock: 20 },
    { write: ['page.html', '<title>Page</title>two', null, at()] },
    { tick: 0.2 },
    { tick: 0.7 },
    { clock: 1 },
    { write: ['page.html', '<title>Page</title>three!', null, at()] },
    { tick: 0.2 },
    { tick: 0.7 },
    { write: ['r.html', 'v1', null, at()] },
    { preview: ['c1', 'r.html'] },
    { tick: 1 },
    { unlink: 'r.html' },
    { tick: 1 },
    { tick: 1 },
    { clock: 30 },
    { write: ['r.html', 'v3 back', null, at()] },
    { tick: 0.1 },
    { tick: 0.8 },
  ];
  const mine = watcherRun(join(a.dir, 'artifacts'), join(a.dir, 'proj'), steps);
  const theirs = await py.call('artifacts_shim', 'watcher_run', [join(c.dir, 'artifacts'), join(c.dir, 'proj'), steps]);
  assertSame(normalize(mine, [a.dir]), normalize(theirs, [c.dir]));
});

Deno.test('parity: the write tracker records the same paths', async () => {
  const cwd = abs('proj');
  const updates = [
    update({ kind: 'edit', content: [{ type: 'diff', path: join(cwd, 'outputs', 'a.html') }] }),
    update({
      toolCallId: 't2',
      kind: 'edit',
      locations: [{ path: 'outputs/./x/../b.html' }, { path: '' }, { path: '  ' }, 'bad', { path: 5 }],
    }),
    update({
      toolCallId: 't3',
      _meta: { claudeCode: { toolName: 'mcp__studio__MultiEdit' } },
      rawInput: { filePath: 'c.md', filename: '/abs/d.md' },
    }),
    update({ toolCallId: 't3', sessionUpdate: 'tool_call_update', kind: '', locations: [{ path: 'outputs/c.md' }] }),
    update({ toolCallId: 't4', sessionUpdate: 'tool_call_update', kind: 'read', locations: [{ path: 'e.md' }] }),
    update({ toolCallId: 7, toolName: 'Edit', rawInput: { path: 'outputs\\win.md' } }),
    update({ toolCallId: 't2', kind: 'edit', locations: [{ path: 'outputs/./x/../b.html' }] }),
    { update: 'nope' },
    update({ sessionUpdate: 'plan' }),
  ];
  const mine = new WriteTracker(cwd);
  const recorded = updates.map((u) => mine.observe(u, 5));
  assertEquals({ recorded, written: mine.written() }, await py.call('artifacts_shim', 'tracker_run', [cwd, updates]));
});

// ---- interop: one store folder, both servers ----------------------------------------------------------

Deno.test('interop: Python writes, Deno reads and extends; Python reads that back', async () => {
  using tmp = temp();
  const root = join(tmp.dir, 'artifacts');
  const made = await py.call('artifacts_shim', 'store_run', [root, [
    {
      call: 'create',
      args: ['c1', 'From Python é', 'html', 'p.html', b('<p>py</p>\n')],
      kwargs: { project: 'P', source_path: 'P/p.html' },
    },
    { clock: 1010.5 },
    { call: 'add_version', args: [{ ref: 0 }, b('<p>py two</p>\n')], kwargs: { note: 'second' } },
    { call: 'set_pinned', args: [{ ref: 0 }, true] },
    { call: 'create', args: ['c1', 'Notes', 'md', 'n.md', b('# n')] },
  ]]) as Result[];
  const id = (made[0].ok as Manifest).id;
  const clock = new Clock(1020.75);
  const store = new ArtifactStore(root, clock.now);
  store.origin = 'http://127.0.0.1:1';
  const pyView = await py.call('artifacts_shim', 'store_run', [root, [{ call: 'item', args: [id] }, { call: 'list', args: ['c1'] }, {
    call: 'diff',
    args: [id, 1, 2],
  }]]) as Result[];
  assertEquals(JSON.parse(JSON.stringify(store.item(id))), pyView[0].ok);
  assertEquals(store.list('c1'), pyView[1].ok);
  assertEquals(store.diff(id, 1, 2), pyView[2].ok);
  const before = Deno.readTextFileSync(join(root, id, 'manifest.json'));
  store.setPinned(id, false);
  store.setPinned(id, true);
  assertEquals(Deno.readTextFileSync(join(root, id, 'manifest.json')), before, 'a Deno save of an unchanged manifest is byte-identical');
  const [m] = store.addVersion(id, enc('<p>deno three</p>\n'), { by: 'tool', toolCallId: 'd1', note: 'from deno' });
  assertEquals(m.versions.map((v) => v.n), [1, 2, 3]);
  const mine = JSON.parse(JSON.stringify(store.get(id)));
  const back = await py.call('artifacts_shim', 'store_run', [root, [
    { call: 'get', args: [id] },
    { call: 'source', args: [id, 3] },
    { clock: 1030.0 },
    { call: 'add_version', args: [id, b('<p>py four</p>\n')], kwargs: { by: 'watch' } },
    { call: 'diff', args: [id, 3, 4] },
  ]]) as Result[];
  assertEquals(back[0].ok, mine);
  assertEquals(back[1].ok, { text: '<p>deno three</p>\n', truncated: false });
  assertEquals(back[4].ok, store.diff(id, 3, 4));
  const final = store.get(id);
  assertEquals(final.versions.map((v) => [v.n, v.by]), [[1, 'tool'], [2, 'tool'], [3, 'tool'], [4, 'watch']]);
  assertEquals(dumpManifest(final), Deno.readTextFileSync(join(root, id, 'manifest.json')), 'Python file == our serialization of it');
});

Deno.test('interop: Deno writes, Python reads and extends; Deno reads that back', async () => {
  using tmp = temp();
  const root = join(tmp.dir, 'artifacts');
  const clock = new Clock(1000.0);
  const store = new ArtifactStore(root, clock.now);
  store.origin = 'http://127.0.0.1:1';
  const m = store.create('c1', 'From Deno ✓', 'text', 'd.txt', enc('one\n'), { project: 'P', sourcePath: join(tmp.dir, 'd.txt') });
  clock.t = 1004.5;
  store.addVersion(m.id, enc('two\n'), { by: 'watch', note: 'w' });
  store.setSourceMissing(m.id, true);
  const denoItem = JSON.parse(JSON.stringify(store.item(m.id)));
  const denoList = store.list();
  const result = await py.call('artifacts_shim', 'store_run', [root, [
    { call: 'item', args: [m.id] },
    { call: 'list', args: [] },
    { call: 'find_by_source', args: ['c1', join(tmp.dir, 'D.TXT')] },
    { clock: 1006.0 },
    { call: 'add_version', args: [m.id, b('three\n')], kwargs: { by: 'watch' } },
    { call: 'restore', args: [m.id, 1] },
  ], 1006.0]) as Result[];
  assertEquals(result[0].ok, denoItem);
  assertEquals(result[1].ok, denoList);
  assertEquals((result[2].ok as Manifest | null)?.id ?? null, WIN ? m.id : null, 'paths compare case-insensitively on Windows only');
  const after = store.get(m.id);
  assertEquals(after.versions.map((v) => [v.n, v.note]), [[1, ''], [2, 'w'], [3, 'Restored from v1']]);
  assertEquals(after.sourceMissing, undefined, 'a new version clears the flag');
  assertEquals(store.source(m.id, 2).text, 'three\n');
  assertEquals(store.source(m.id, 3).text, 'one\n');
});

Deno.test('interop: a "built from" link (fromDoc) and becameDoc (Deno only) survive Python rewriting the manifest', async () => {
  using tmp = temp();
  const root = join(tmp.dir, 'artifacts');
  const clock = new Clock(1000.0);
  const store = new ArtifactStore(root, clock.now);
  store.origin = 'http://127.0.0.1:1';
  const m = store.create('c1', 'Timeline', 'html', 't.html', enc('<p>one</p>'), { project: 'P' });
  const fromDoc = { doc: 'release-plan', title: 'Release plan', page: 'p2', pageTitle: 'Rollout', rev: 7 };
  store.setFromDoc(m.id, fromDoc);
  store.setBecameDoc(m.id, 'timeline', 3);
  await py.call('artifacts_shim', 'store_run', [root, [
    { call: 'add_version', args: [m.id, b('<p>two</p>')], kwargs: { by: 'tool', title: 'Timeline v2' } },
    { call: 'set_pinned', args: [m.id, true] },
  ], 1006.0]);
  const after = store.get(m.id);
  assertEquals(after.versions.length, 2);
  assertEquals(after.title, 'Timeline v2');
  assertEquals(after.fromDoc, fromDoc);
  assertEquals(store.summary(after).fromDoc, fromDoc);
  assertEquals([after.becameDoc, after.becameDocRev, store.summary(after).becameDoc], ['timeline', 3, 'timeline'], 'Edit made it a doc: kept too');
});

Deno.test('parity teardown', async () => {
  await py.close();
});
