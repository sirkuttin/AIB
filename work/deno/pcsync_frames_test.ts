/**
 * Sync between PCs, slice V2: the frame validator (server/pcsync/frames.ts). Paths in a frame are relative to a project's aib-shared/
 * or aib-docs/ and nothing else: no absolute path, no root, no way out of the folder, no name Windows would turn into another file.
 */
import { assert, assertEquals } from './_assert.ts';
import { checkPath, MAX_FRAME_BYTES, MAX_HELLO_BYTES, MAX_ITEMS, parseFrame } from '../../outputs/agent-studio/server/pcsync/frames.ts';

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
