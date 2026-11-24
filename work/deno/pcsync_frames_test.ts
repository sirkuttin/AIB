/**
 * Sync between PCs, slice V2: the frame validator (server/pcsync/frames.ts). Paths in a frame are relative to a project's aib-shared/
 * or aib-docs/ and nothing else: no absolute path, no root, no way out of the folder, no name Windows would turn into another file.
 */
import { assert, assertEquals } from './_assert.ts';
import { checkPath, MAX_FRAME_BYTES, MAX_HELLO_BYTES, MAX_ITEMS, parseFrame } from '../../app/server/pcsync/frames.ts';

const ok = (path: string, area: 'shared' | 'docs' = 'shared') => checkPath(path, area).ok;

Deno.test('frame paths: plain relative paths are accepted', () => {
  for (const p of ['a.md', 'notes/a.md', 'a/b/c/d.txt', 'Plan (v2).md', 'ünïcode/ok.md', '.env.example', 'a.b.c']) assert(ok(p), p);
});

Deno.test('frame paths: absolute paths, drives, backslashes, colons, dots and empty segments are refused', () => {
  const bad = [
    '',
    '/etc/passwd',
    '/a',
    'C:/x',
    'C:x',
    'C:\\x',
    '\\\\server\\share\\x',
    'a\\b',
    'x:stream',
    'a/b:c',
    '../x',
    'a/../../x',
    'a/..',
    '..',
    '.',
    './a',
    'a/./b',
    'a//b',
    'a/',
    'a/b/',
    'a\u0000b',
    'a\nb',
    'a\u007fb',
    'a/' + 'x'.repeat(121),
    'x/'.repeat(300),
  ];
  for (const p of bad) assert(!ok(p), JSON.stringify(p));
  for (const v of [null, undefined, 1, {}, ['a'], true]) assert(!checkPath(v, 'shared').ok);
});

Deno.test('frame paths: names Windows would turn into another file are refused (reserved, trailing dot or space, 8.3 short names)', () => {
  const bad = [
    'CON',
    'con.txt',
    'a/NUL.md',
    'PRN',
    'aux.x',
    'COM1',
    'com9.log',
    'LPT1.txt',
    'a.',
    'a.md.',
    'a/b ',
    'a /b',
    'PROGRA~1',
    'docs/ABCDEF~1.md',
    'a~1',
  ];
  for (const p of bad) assert(!ok(p), p);
  for (const p of ['console.md', 'com10.md', 'nul-x.md', 'a~b.md', 'lpt.md']) assert(ok(p), p);
  for (const p of ['a<b', 'a>b', 'a"b', 'a|b', 'a?b', 'a*b']) assert(!ok(p), p);
});

Deno.test('frame paths: in the docs area only <doc name>/doc.aibdoc and <doc name>/assets/** are accepted', () => {
  for (const p of ['My Doc/doc.aibdoc', 'plan-1/doc.aibdoc', 'plan/assets/a.png', 'plan/assets/sub/b.png']) assert(ok(p, 'docs'), p);
  for (
    const p of [
      'doc.aibdoc',
      'plan/other.md',
      'plan/01-Intro.md',
      'plan/doc.aibdoc/x',
      'plan/assets',
      'plan/assets/',
      '../doc.aibdoc',
      '-bad/doc.aibdoc',
      ' x/doc.aibdoc',
      'a/b/doc.aibdoc',
      'plan/assets/../../x',
      'x'.repeat(81) + '/doc.aibdoc',
    ]
  ) assert(!ok(p, 'docs'), p);
});

Deno.test('frames: hello, ping, pong and batch validate; everything else is refused', () => {
  const hello = { t: 'hello', v: 1, token: 'a'.repeat(43), name: 'studio-pc', host: 'studio-pc.tail-a1b2.ts.net' };
  assertEquals(parseFrame(JSON.stringify(hello), true).ok, true);
  const noToken = { ...hello, token: undefined };
  assertEquals(parseFrame(JSON.stringify(noToken), true).ok, true);
  assertEquals(parseFrame('{"t":"ping"}').ok, true);
  assertEquals(parseFrame('{"t":"pong"}').ok, true);
  assertEquals(parseFrame('{"t":"ping"}', true).ok, false, 'the first frame must be a hello');
  const batch = {
    t: 'batch',
    id: 'b-1',
    project: 'proj_12345678',
    items: [{ op: 'stat', area: 'docs', path: 'plan/doc.aibdoc' }, { op: 'list', area: 'shared' }],
  };
  assertEquals(parseFrame(JSON.stringify(batch)).ok, true);
  for (
    const frame of [
      { ...hello, v: 2 },
      { ...hello, token: 'short' },
      { ...hello, token: 'a b'.repeat(10) },
      { ...hello, host: 'Bad Host!' },
      { ...hello, host: 5 },
      { t: 'other' },
      {},
      { t: 'batch', id: '', items: [] },
      { t: 'batch', id: 'ok', items: 'x' },
      { t: 'batch', id: 'ok', project: 'no', items: [] },
      { t: 'batch', id: 'ok', items: [5] },
      { t: 'batch', id: 'ok', items: [{ op: 'put', area: 'elsewhere' }] },
      { t: 'batch', id: 'ok', items: [{ op: 'Put!', area: 'shared' }] },
      { t: 'batch', id: 'ok', items: [{ op: 'put', area: 'shared', path: '/abs' }] },
      { t: 'batch', id: 'ok', items: [{ op: 'put', area: 'docs', path: 'x/notes.md' }] },
      { t: 'batch', id: 'ok', items: Array.from({ length: MAX_ITEMS + 1 }, () => ({ op: 'stat', area: 'shared' })) },
    ]
  ) assertEquals(parseFrame(JSON.stringify(frame)).ok, false, JSON.stringify(frame).slice(0, 80));
  for (const text of ['', 'nope', '[]', '5', 'null', '"x"', undefined, null, 7]) assertEquals(parseFrame(text).ok, false);
});

Deno.test('frames: a frame never carries a root or an absolute place, whatever it is called', () => {
  for (const key of ['root', 'Root', 'abs', 'absolute', 'cwd', 'dir', 'base', 'folder', 'drive']) {
    const frame = { t: 'batch', id: 'x', items: [{ op: 'put', area: 'shared', path: 'a.md', [key]: 'C:\\Users' }] };
    assertEquals(parseFrame(JSON.stringify(frame)).ok, false, key);
  }
});

Deno.test('frames: size caps (4 KB for the first frame, 1 MB after) count bytes, not characters', () => {
  const pad = (n: number) => JSON.stringify({ t: 'batch', id: 'x', items: [], pad: 'x'.repeat(n) });
  assertEquals(parseFrame(pad(1000)).ok, true);
  assertEquals(parseFrame(pad(MAX_FRAME_BYTES)).ok, false);
  const wide = JSON.stringify({ t: 'batch', id: 'x', items: [], pad: '\u00e9'.repeat(MAX_FRAME_BYTES / 2 - 100 + 200) }); // 2 bytes each
  assertEquals(parseFrame(wide).ok, false, 'over the cap in bytes though under it in characters');
  const first = (n: number) => JSON.stringify({ t: 'hello', v: 1, name: 'x', host: 'a.b', pad: 'x'.repeat(n) });
  assertEquals(parseFrame(first(100), true).ok, true);
  assertEquals(parseFrame(first(MAX_HELLO_BYTES), true).ok, false);
});

// ---- slice V3: project matching items ------------------------------------------------------------------------------------------
const batchOf = (project: string | undefined, ...items: unknown[]) =>
  JSON.stringify({ t: 'batch', id: 'b1', ...(project ? { project } : {}), items });
const offer = (over: Record<string, unknown> = {}) => ({
  op: 'project.offer',
  id: 'oid-12345678',
  name: 'shop',
  remote: 'github.com/acme/shop',
  prefix: 'packages/api',
  wsl: false,
  ...over,
});

Deno.test('project items: an offer, a link and an unlink validate and keep only their own keys', () => {
  const parsed = parseFrame(batchOf(undefined, { op: 'project.begin', x: 1 }, offer({ junk: 'extra' }), { op: 'project.end' }));
  assert(parsed.ok);
  const items = (parsed as { ok: true; value: { items: Record<string, unknown>[] } }).value.items;
  assertEquals(items[0], { op: 'project.begin' });
  assertEquals(items[1], offer(), 'unknown keys are dropped');
  assertEquals(parseFrame(batchOf('sync-12345678', { op: 'project.link', mine: 'oid-12345678', theirs: 'oid-87654321', how: 'manual' })).ok, true);
  assertEquals(parseFrame(batchOf('sync-12345678', { op: 'project.unlink' })).ok, true);
  assertEquals(parseFrame(batchOf(undefined, offer({ remote: null, prefix: '' }))).ok, true);
});

Deno.test('project items: a name, remote or place that could be a folder path is refused', () => {
  const bad: Record<string, unknown>[] = [
    { name: 'C:\\Users\\x\\shop' },
    { name: '/home/u/shop' },
    { name: 'a/b' },
    { name: '' },
    { name: 'x'.repeat(81) },
    { prefix: '/home/u/shop' },
    { prefix: 'C:/x' },
    { prefix: '../x' },
    { prefix: 'a//b' },
    { prefix: 'a\\b' },
    { remote: 'C:\\repos\\shop' },
    { remote: '/srv/git/shop.git' },
    { remote: 'github.com' },
    { id: 'short' },
    { id: 'has space 123' },
    { wsl: 'yes' },
  ];
  for (const over of bad) assertEquals(parseFrame(batchOf(undefined, offer(over))).ok, false, JSON.stringify(over));
  for (const key of ['root', 'folder', 'dir', 'abs']) assertEquals(parseFrame(batchOf(undefined, offer({ [key]: 'x' }))).ok, false, key);
  assertEquals(parseFrame(batchOf('sync-12345678', { op: 'project.link', mine: 'oid-12345678', theirs: 'oid-87654321', how: 'folder' })).ok, false);
  assertEquals(parseFrame(batchOf('sync-12345678', { op: 'project.link', mine: 'short', theirs: 'oid-87654321', how: 'remote' })).ok, false);
  assertEquals(parseFrame(batchOf('sync-12345678', { op: 'project.other' })).ok, false);
});

// ---- slice V4: file items and the switch --------------------------------------------------------------------------------------------
const H = 'a'.repeat(64);
const state = (over: Record<string, unknown> = {}) => ({ op: 'file.state', area: 'shared', path: 'notes/a.md', hash: H, size: 5, mtime: 1700000000000, sup: [], ...over });

Deno.test('file items: begin, end, state, get, data and gone validate and keep only their own keys', () => {
  const frame = batchOf(
    'sync-12345678',
    { op: 'file.begin', area: 'shared', x: 1 },
    state({ junk: 'extra', sup: [H, 'del'] }),
    state({ hash: null, size: 0 }),
    { op: 'file.get', area: 'shared', path: 'a.md', hash: H, offset: 524288 },
    { op: 'file.data', area: 'shared', path: 'a.md', hash: H, offset: 0, size: 3, last: true, data: 'YWJj', extra: 1 },
    { op: 'file.gone', area: 'shared', path: 'a.md', hash: H },
    { op: 'file.end', area: 'shared' },
    { op: 'project.switch', shared: true, docs: false, junk: 1 },
  );
  const parsed = parseFrame(frame);
  assert(parsed.ok);
  const items = (parsed as { ok: true; value: { items: Record<string, unknown>[] } }).value.items;
  assertEquals(items[0], { op: 'file.begin', area: 'shared' });
  assertEquals(items[1], state({ sup: [H, 'del'] }), 'unknown keys are dropped');
  assertEquals(items[4], { op: 'file.data', area: 'shared', path: 'a.md', hash: H, offset: 0, size: 3, last: true, data: 'YWJj' });
  assertEquals(items[7], { op: 'project.switch', shared: true, docs: false });
});

Deno.test('file items: a bad path, hash, size, offset, chunk or switch is refused; the docs area takes only doc.aibdoc and assets', () => {
  const bad: unknown[] = [
    state({ path: '/etc/passwd' }),
    state({ path: '../x' }),
    state({ path: 'C:/x' }),
    state({ path: 'CON.md' }),
    state({ hash: 'short' }),
    state({ hash: 'A'.repeat(64) }),
    state({ hash: undefined }),
    state({ size: -1 }),
    state({ size: 1.5 }),
    state({ mtime: 'now' }),
    state({ sup: 'x' }),
    state({ sup: ['nothash'] }),
    state({ sup: [H, H, H, H, H] }),
    state({ area: 'docs', path: 'plan/01-page-1.md' }),
    state({ area: 'docs', path: 'plan/notes.txt' }),
    state({ area: 'docs', path: 'doc.aibdoc' }),
    state({ area: 'docs', path: 'plan/sub/doc.aibdoc' }),
    state({ area: 'docs', path: '.bad/doc.aibdoc' }),
    state({ area: 'docs', path: 'plan/assets' }),
    state({ area: 'other', path: 'a.md' }),
    state({ area: undefined }),
    { op: 'file.get', area: 'shared', path: 'a.md', hash: H, offset: -1 },
    { op: 'file.get', area: 'shared', path: 'a.md', hash: 'x', offset: 0 },
    { op: 'file.data', area: 'shared', path: 'a.md', hash: H, offset: 0, size: 3, last: 'yes', data: 'YWJj' },
    { op: 'file.data', area: 'shared', path: 'a.md', hash: H, offset: 0, size: 3, last: true, data: 'not base64!' },
    { op: 'file.data', area: 'shared', path: 'a.md', hash: H, offset: 0, size: 3, last: true, data: 'A'.repeat(760_001) },
    { op: 'file.data', area: 'shared', path: 'a.md', hash: H, offset: 0, size: 3, last: true },
    { op: 'file.gone', area: 'shared', path: 'a.md' },
    { op: 'file.other', area: 'shared', path: 'a.md' },
    { op: 'file.get', area: 'shared', offset: 0, hash: H },
    { op: 'project.switch', shared: 'yes', docs: false },
    { op: 'project.switch', shared: true },
  ];
  for (const item of bad) assertEquals(parseFrame(batchOf('sync-12345678', item)).ok, false, JSON.stringify(item).slice(0, 120));
  for (const key of ['root', 'folder', 'dir', 'abs']) assertEquals(parseFrame(batchOf('sync-12345678', state({ [key]: 'x' }))).ok, false, key);
  // the docs area (slice V5): a doc's doc.aibdoc and its assets, in every file op
  for (const path of ['plan/doc.aibdoc', 'My Doc (2)/doc.aibdoc', 'plan/assets/pic.png', 'plan/assets/sub/a.json']) {
    assert(parseFrame(batchOf('sync-12345678', state({ area: 'docs', path }))).ok, path);
    assert(parseFrame(batchOf('sync-12345678', { op: 'file.get', area: 'docs', path, hash: H, offset: 0 })).ok, path);
  }
  assert(parseFrame(batchOf('sync-12345678', { op: 'file.begin', area: 'docs' })).ok);
  // a full 512 KB chunk (699,052 base64 characters) fits one frame
  const chunk = 'A'.repeat(699_052);
  const full = parseFrame(batchOf('sync-12345678', { op: 'file.data', area: 'shared', path: 'a.bin', hash: H, offset: 0, size: 524288, last: false, data: chunk }));
  assert(full.ok, 'a full chunk fits under the frame cap');
});
