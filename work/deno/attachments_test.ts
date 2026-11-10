/** server/acp/attachments.ts: the pure cases of work/test_attachments.py and test_studio.py, plus parity with Python. */
import { assert, assertEquals, assertThrows } from './_assert.ts';
import { PyParity } from './_parity.ts';
import {
  eventImageSize,
  type FileRecord,
  formatSize,
  mapFileAttachments,
  MAX_BINARY_FILE_BYTES,
  MAX_EVENT_FILE_PREVIEW_CHARS,
  MAX_EVENT_IMAGE_BYTES,
  MAX_FILE_NAME_CHARS,
  MAX_FILES,
  MAX_IMAGE_BYTES,
  MAX_IMAGES,
  MAX_PROMPT_BODY_BYTES,
  MAX_TEXT_FILE_BYTES,
  MAX_TOTAL_ATTACHMENT_BYTES,
  MAX_TOTAL_IMAGE_BYTES,
  splitAttachments,
  validateAttachmentName,
  validateFileAttachments,
  validateImageAttachments,
} from '../../outputs/agent-studio/server/acp/attachments.ts';
import { pyB64Decode, ValueError } from '../../outputs/agent-studio/server/core/py.ts';

type Dict = Record<string, unknown>;

const enc = new TextEncoder();
const bytes = (value: string | number[] | Uint8Array) =>
  typeof value === 'string' ? Uint8Array.from(value, (c) => c.charCodeAt(0)) : value instanceof Uint8Array ? value : Uint8Array.from(value);
/** base64 of raw bytes; a string is taken as one byte per character (like a Python b'' literal). */
function b64(raw: string | number[] | Uint8Array): string {
  const data = bytes(raw);
  let binary = '';
  for (let i = 0; i < data.length; i += 0x8000) binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
  return btoa(binary);
}
const fileItem = (name: unknown, raw: string | number[] | Uint8Array, mime: unknown = '', extra: Dict = {}) => ({
  type: 'file',
  name,
  mimeType: mime,
  data: b64(raw),
  ...extra,
});
const PNG = b64('\x89PNG\r\n\x1a\nfixture');
const mapped = (items: unknown[], caps: unknown) => mapFileAttachments(validateFileAttachments(items)[0], caps);
const message = (fn: () => unknown) => assertThrows(fn, ValueError).message;

function outcome(fn: () => unknown): unknown {
  try {
    return { ok: JSON.parse(JSON.stringify(fn() ?? null)) };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { error: error instanceof ValueError ? 'ValueError' : error.name, message: error.message };
  }
}

Deno.test('constants match Python', async () => {
  await using py = new PyParity();
  const names = [
    ['MAX_IMAGES', MAX_IMAGES],
    ['MAX_IMAGE_BYTES', MAX_IMAGE_BYTES],
    ['MAX_TOTAL_IMAGE_BYTES', MAX_TOTAL_IMAGE_BYTES],
    ['MAX_EVENT_IMAGE_BYTES', MAX_EVENT_IMAGE_BYTES],
    ['MAX_FILES', MAX_FILES],
    ['MAX_TEXT_FILE_BYTES', MAX_TEXT_FILE_BYTES],
    ['MAX_BINARY_FILE_BYTES', MAX_BINARY_FILE_BYTES],
    ['MAX_TOTAL_ATTACHMENT_BYTES', MAX_TOTAL_ATTACHMENT_BYTES],
    ['MAX_PROMPT_BODY_BYTES', MAX_PROMPT_BODY_BYTES],
    ['MAX_EVENT_FILE_PREVIEW_CHARS', MAX_EVENT_FILE_PREVIEW_CHARS],
    ['MAX_FILE_NAME_CHARS', MAX_FILE_NAME_CHARS],
  ] as const;
  const values = await py.call('builtins', 'eval', ['[' + names.map(([n]) => `__import__('attachments').${n}`).join(', ') + ']']);
  assertEquals(names.map(([, v]) => v), values);
});

Deno.test('text detection by MIME, extension and content', () => {
  const cases = [
    ['a.txt', 'text/plain', 'text/plain'],
    ['a.md', '', 'text/markdown'],
    ['data.json', 'application/json', 'application/json'],
    ['a.csv', 'text/csv', 'text/csv'],
    ['a.py', '', 'text/x-python'],
    ['a.js', 'application/x-javascript', 'application/x-javascript'],
    ['a.ts', '', 'text/typescript'],
    ['a.log', 'application/octet-stream', 'text/plain'],
    ['c.yaml', '', 'application/yaml'],
    ['a.xml', 'text/xml', 'text/xml'],
    ['a.html', 'text/html; charset=utf-8', 'text/html'],
    ['a.css', '', 'text/css'],
    ['q.sql', '', 'application/sql'],
    ['x.svg', 'image/svg+xml', 'image/svg+xml'],
    ['LICENSE', '', 'text/plain'],
  ];
  for (const [name, mime, expectMime] of cases) {
    const [records] = validateFileAttachments([fileItem(name, enc.encode('héllo\n'), mime)]);
    assertEquals([records[0].kind, records[0].mimeType, records[0].text], ['text', expectMime, 'héllo\n'], name);
  }
});

Deno.test('content overrides a text MIME; PDF is binary; BOM dropped; audio classified', () => {
  for (const raw of ['abc\x00def', '\xff\xfe\x00bad', '\xc3\x28']) {
    assertEquals(validateFileAttachments([fileItem('notes.txt', raw, 'text/plain')])[0][0].kind, 'binary');
  }
  const [pdfs] = validateFileAttachments([fileItem('a.pdf', '%PDF-1.4 plain ascii', 'application/pdf'), fileItem('b.pdf', '%PDF-1.4 x')]);
  assertEquals([pdfs.map((r) => r.kind), pdfs[1].mimeType], [['binary', 'binary'], 'application/pdf']);
  const [records] = validateFileAttachments([
    fileItem('a.txt', '\xef\xbb\xbfhi', 'text/plain'),
    fileItem('s.wav', 'RIFFxxxxWAVE', 'audio/wav'),
    fileItem('s.mp3', 'ID3\x03\x00\x00', ''),
  ]);
  assertEquals([records[0].text, records[1].kind, records[2].kind, records[2].mimeType], ['hi', 'audio', 'audio', 'audio/mpeg']);
});

Deno.test('unsafe names rejected', () => {
  const names = [
    '../x.txt',
    'a/b.txt',
    'a\\b.txt',
    'C:x.txt',
    '..',
    '.',
    ' x.txt',
    'x.txt ',
    'x.',
    'a\x00.txt',
    'a\nb.txt',
    'a\u202etxt.exe',
    'a|b',
    'q?.txt',
    'x'.repeat(201),
    '',
    null,
    5,
  ];
  for (const name of names) assertThrows(() => validateFileAttachments([fileItem(name, 'x')]), ValueError);
  assertEquals(validateFileAttachments([fileItem('résumé (final) v2.txt', 'x')])[0][0].name, 'résumé (final) v2.txt');
});

Deno.test('malformed items rejected', () => {
  const bad: unknown[] = [
    [],
    'x',
    [{ type: 'file', name: 'a.txt' }],
    [fileItem('a.txt', 'x', '', { path: 'C:/x' })],
    [{ ...fileItem('a.txt', 'x'), type: 'image' }],
    [{ ...fileItem('a.txt', 'x'), data: 'not base64!' }],
    [fileItem('a.txt', '')],
    [fileItem('a.txt', 'x', 'text')],
    [fileItem('a.txt', 'x', 5)],
    [fileItem('a.png', 'x', 'image/png')],
    Array.from({ length: 9 }, (_, i) => fileItem(`f${i}.txt`, 'x')),
  ];
  for (const items of bad) assertThrows(() => validateFileAttachments(items), ValueError);
});

Deno.test('size limits', () => {
  validateFileAttachments([fileItem('ok.txt', new Uint8Array(MAX_TEXT_FILE_BYTES).fill(97))]);
  assert(message(() => validateFileAttachments([fileItem('big.txt', new Uint8Array(MAX_TEXT_FILE_BYTES + 1).fill(97))])).includes('2 MiB'));
  validateFileAttachments([fileItem('ok.pdf', new Uint8Array(MAX_BINARY_FILE_BYTES).fill(37), 'application/pdf')]);
  assert(
    message(() => validateFileAttachments([fileItem('big.pdf', new Uint8Array(MAX_BINARY_FILE_BYTES + 1).fill(37), 'application/pdf')]))
      .includes('10 MiB'),
  );
  const eight = new Uint8Array(8 * 1024 * 1024).fill(37);
  const three = [0, 1, 2].map((i) => fileItem(`${i}.pdf`, eight, 'application/pdf'));
  assert(message(() => validateFileAttachments(three)).includes('20 MiB total'));
  validateFileAttachments(Array.from({ length: 8 }, (_, i) => fileItem(`${i}.txt`, 'x')));
  assert(MAX_PROMPT_BODY_BYTES > 4 * Math.floor((MAX_TOTAL_ATTACHMENT_BYTES + 2) / 3) + 1024 * 1024, 'body cap covers 20 MiB of base64');
});

Deno.test('splitAttachments and the image validator', () => {
  const [images, files] = splitAttachments([{ mimeType: 'image/png', data: PNG }, fileItem('a.txt', 'x')]);
  assertEquals([images.length, files.length], [1, 1]);
  assertThrows(() => splitAttachments([{ type: 'video' }]), ValueError);
  assertThrows(() => splitAttachments(['x']), ValueError);
  const [blocks, total] = validateImageAttachments([{ mimeType: 'image/png', data: PNG }]);
  assertEquals(blocks[0].type, 'image');
  assert(total > 0);
  // test_studio.py: invalid image attachments
  const valid = { mimeType: 'image/png', data: b64('\x89PNG\r\n\x1a\nbytes') };
  const invalid = [
    [{ mimeType: 'image/png', data: 'not base64!' }],
    [{ mimeType: 'image/svg+xml', data: 'PHN2Zz4=' }],
    [{ mimeType: 'image/jpeg', data: valid.data }],
    [{ mimeType: 'image/png', data: valid.data + 'junk' }],
    Array(5).fill(valid),
    [{
      mimeType: 'image/png',
      data: b64(new Uint8Array([...bytes('\x89PNG\r\n\x1a\n'), ...new Uint8Array(MAX_IMAGE_BYTES + 1).fill(120)])),
    }],
  ];
  for (const items of invalid) assertThrows(() => validateImageAttachments(items), ValueError);
});

Deno.test('mapping: embedded, inline with fence, URIs, binary, audio, refusals, bounded preview', () => {
  let [blocks, summaries] = mapped([fileItem('notes.md', '# Title\n', 'text/markdown')], { embeddedContext: true });
  assertEquals(blocks, [{ type: 'resource', resource: { uri: 'attachment:///1/notes.md', mimeType: 'text/markdown', text: '# Title\n' } }]);
  assertEquals(summaries[0].mode, 'embedded');
  [blocks, summaries] = mapped([fileItem('a.py', 'print(1)', 'text/x-python')], {});
  assertEquals(blocks, [{ type: 'text', text: 'Attached file: a.py (text/x-python, 8 B)\n```\nprint(1)\n```' }]);
  assertEquals(summaries[0].mode, 'inline');
  assert(
    String(mapped([fileItem('r.md', '```py\nx\n```\n', 'text/markdown')], { embeddedContext: false })[0][0].text).includes(
      '\n````\n```py\nx\n```\n````',
    ),
  );
  [blocks] = mapped([fileItem('a b#1.txt', 'x'), fileItem('é.txt', 'y')], { embeddedContext: true });
  assertEquals(blocks.map((b) => (b.resource as Dict).uri), ['attachment:///1/a%20b%231.txt', 'attachment:///2/%C3%A9.txt']);
  [blocks, summaries] = mapped([fileItem('a.pdf', '%PDF-1', 'application/pdf')], { embeddedContext: true });
  assertEquals(blocks[0].resource, { uri: 'attachment:///1/a.pdf', mimeType: 'application/pdf', blob: b64('%PDF-1') });
  assert(!('preview' in summaries[0]));
  assert(
    /a\.pdf.*embeddedContext.*binary file/.test(
      message(() => mapped([fileItem('a.pdf', '%PDF-1', 'application/pdf')], { image: true, audio: true })),
    ),
  );
  const wav = fileItem('s.wav', 'RIFFxxxxWAVE', 'audio/wav');
  [blocks, summaries] = mapped([wav], { audio: true });
  assertEquals([blocks, summaries[0].mode], [[{ type: 'audio', mimeType: 'audio/wav', data: wav.data }], 'audio']);
  assertEquals(mapped([wav], { embeddedContext: true })[0][0].type, 'resource');
  assert(/s\.wav.*promptCapabilities\.audio.*audio file/.test(message(() => mapped([wav], {}))));
  const refused = message(() =>
    mapped([fileItem('a.pdf', '%PDF', 'application/pdf'), fileItem('ok.txt', 'x'), fileItem('b.zip', 'PK', 'application/zip')], {})
  );
  assert(refused.includes('a.pdf') && refused.includes('b.zip'));
  assertEquals(mapped([fileItem('ok.txt', 'x'), fileItem('a.pdf', '%PDF', 'application/pdf')], { embeddedContext: true })[0].length, 2);
  [, summaries] = mapped([fileItem('huge.log', new Uint8Array(500000).fill(120))], { embeddedContext: true });
  assertEquals([summaries[0].preview!.length, summaries[0].truncated, summaries[0].size], [MAX_EVENT_FILE_PREVIEW_CHARS, true, 500000]);
});

Deno.test('eventImageSize counts stored image data (test_image_history_event_budget)', () => {
  assertEquals(eventImageSize({ data: { attachments: [{ data: 'x'.repeat(10) }, { data: 5 }, 'x', { data: '😀' }] } }), 11);
  assertEquals(eventImageSize({ data: 'x' }), 0);
  assertEquals(eventImageSize({}), 0);
});

// ---- parity with Python -----------------------------------------------------------------------

Deno.test('pyB64Decode accepts and refuses exactly what base64.b64decode(validate=True) does', async () => {
  await using py = new PyParity();
  const inputs = [
    '',
    '=',
    '==',
    '===',
    'QQ',
    'QQ=',
    'QQ==',
    'QUI',
    'QUI=',
    'QUI==',
    'QUJD',
    'QUJD=',
    'QUJD==',
    'Q',
    'Q=',
    'Q==',
    'QUJDRA',
    'QR==',
    'QUJ=D',
    'QU JD',
    'QUJD\n',
    'é',
    '-_',
    '+/+/',
    'QQ==QQ==',
    'QUI==',
    'QQ===',
    'QUJD===',
    'QUJD=====',
    'QUJD=QUJD',
    'Q===',
    'QUJDRAB=',
    'QUJDRAB==',
  ];
  for (const input of inputs) {
    const reply = await py.raw('base64', 'b64decode', [input], { validate: true });
    const ours = pyB64Decode(input);
    if ('error' in reply) assertEquals(ours, null, input);
    else {
      assert(ours !== null, input);
      const hexed = await py.call('builtins', 'eval', [`__import__('base64').b64decode(${JSON.stringify(input)}, validate=True).hex()`]);
      assertEquals([...ours].map((b) => b.toString(16).padStart(2, '0')).join(''), hexed, input);
    }
  }
});

const NAMES: unknown[] = [
  'ok.txt',
  "it's.txt",
  'say "hi".txt',
  `both ' and ".txt`,
  'tab\there',
  'a\x00.txt',
  'x\x7f',
  'é😀.txt',
  'a\u202etxt.exe',
  'zero\u200bwidth',
  'nbsp\xa0in',
  'line\u2028sep',
  '\ud800lone',
  'private\ue000',
  'unassigned\u0378',
  '\x1cx',
  'x'.repeat(201),
  '😀'.repeat(200),
  '😀'.repeat(201),
  ' x',
  'x ',
  '\ufeffx',
  '...',
  'a.',
  'a/b',
  'a:b',
  'back\\slash',
  "back\\'slash",
  'q?.txt',
  '',
  '   ',
  null,
  5,
  ['x'],
  'x\x85',
  'ab\x9fcd',
  'ab\u00adcd',
  "very long name with a quote ' that is longer than forty characters.txt\n",
];

Deno.test('validateAttachmentName matches Python, repr in messages included', async () => {
  await using py = new PyParity();
  for (const name of NAMES) {
    assertEquals(
      outcome(() => validateAttachmentName(name)),
      await py.raw('attachments', 'validate_attachment_name', [name]),
      JSON.stringify(name),
    );
  }
});

const FILE_CASES: unknown[] = [
  [fileItem('a.txt', 'hello')],
  [fileItem('a.md', 'x', 'TEXT/Markdown ; charset=utf-8')],
  [fileItem('a.bin', 'x', ' Application/Octet-Stream ')],
  [fileItem('a.bin', 'x', 'bad mime')],
  [fileItem('a.bin', 'x', 'é/x')],
  [fileItem('a.bin', 'x', "it's/" + 'x'.repeat(80))],
  [fileItem('a.bin', 'x', null)],
  [fileItem('a.bin', 'x', ['x'])],
  [fileItem('a.json', '{"a": 1}', 'application/ld+json')],
  [fileItem('a.xml', '<a/>', 'application/atom+xml')],
  [fileItem('font.woff', 'abc', 'font/woff')],
  [fileItem('video.txt', 'abc', 'video/mp4')],
  [fileItem('pic.svg', '<svg/>', '')],
  [fileItem('pic.svg', '<svg/>', 'image/svg+xml')],
  [fileItem('pic.svg', '\xff', 'image/svg+xml')],
  [fileItem('a.zip', 'PK', '')],
  [fileItem('a.docx', 'PK', '')],
  [fileItem('a.docx', 'text', '')],
  [fileItem('a.zip', 'text', 'text/plain')],
  [fileItem('a.wav', 'text', '')],
  [fileItem('a.txt', 'RIFF', 'audio/x-weird')],
  [fileItem('noext', '\xff\xfe', '')],
  [fileItem('.env', 'K=V', '')],
  [fileItem('..env', 'K=V', '')],
  [fileItem('archive.tar.GZ', 'x', '')],
  [fileItem('a.PY', 'print(1)', '')],
  [fileItem('a.txt', '\xef\xbb\xbf\xef\xbb\xbfdouble bom', '')],
  [fileItem('a.txt', '\xed\xa0\x80', '')],
  [fileItem('a.txt', '\xc0\xaf', '')],
  [fileItem('a.txt', '\xf4\x90\x80\x80', '')],
  [fileItem('a.txt', '\xe2\x82', '')],
  [fileItem('a.txt', 'x', 'image/jpeg')],
  [fileItem('a.txt', 'x', 'IMAGE/PNG')],
  [{ ...fileItem('a.txt', 'x'), data: 'QQ' }],
  [{ ...fileItem('a.txt', 'x'), data: 'QUJD=' }],
  [{ ...fileItem('a.txt', 'x'), data: '=' }],
  [{ ...fileItem('a.txt', 'x'), data: '' }],
  [{ ...fileItem('a.txt', 'x'), data: 5 }],
  [{ ...fileItem('a.txt', 'x'), data: 'é' }],
  [{ ...fileItem('a.txt', 'x'), type: undefined }],
  [{ name: 'a.txt', type: 'file', data: b64('x') }],
  [{ ...fileItem('a.txt', 'x'), extra: 1 }],
  [fileItem('a b.txt', 'x'), fileItem('a b.txt', 'y')],
  ['x'],
  {},
  null,
];

Deno.test('validateFileAttachments matches Python (records, sha256, errors)', async () => {
  await using py = new PyParity();
  for (const items of FILE_CASES) {
    const clean = JSON.parse(JSON.stringify(items ?? null));
    assertEquals(
      outcome(() => validateFileAttachments(clean)),
      await py.raw('attachments', 'validate_file_attachments', [clean]),
      JSON.stringify(clean).slice(0, 100),
    );
  }
});

Deno.test('validateImageAttachments and splitAttachments match Python', async () => {
  await using py = new PyParity();
  const gif = b64('GIF89a....');
  const webp = b64('RIFF\x00\x00\x00\x00WEBPVP8 ');
  const cases: unknown[] = [
    [{ mimeType: 'image/png', data: PNG }],
    [{ type: 'image', mimeType: 'image/gif', data: gif }, { mimeType: 'image/webp', data: webp }],
    [{ mimeType: 'image/webp', data: b64('RIFF\x00\x00\x00\x00WEBX') }],
    [{ mimeType: 'image/webp', data: b64('RIFF\x00\x00') }],
    [{ mimeType: 'image/jpeg', data: b64('\xff\xd8\xff\xe0') }],
    [{ mimeType: 'image/jpeg', data: b64('\xff\xd8') }],
    [{ mimeType: 'image/png', data: '' }],
    [{ mimeType: 'image/png', data: '=' }],
    [{ mimeType: 'image/png', data: 'é' }],
    [{ mimeType: 'image/png', data: 5 }],
    [{ mimeType: ['image/png'], data: PNG }],
    [{ mimeType: { a: 1 }, data: PNG }],
    [{ mimeType: 5, data: PNG }],
    [{ mimeType: 'image/png', data: PNG, type: 'file' }],
    [{ mimeType: 'image/png', data: PNG, type: null }],
    [{ mimeType: 'image/png', data: PNG, name: 'x' }],
    [],
    'x',
    Array(5).fill({ mimeType: 'image/png', data: PNG }),
  ];
  for (const items of cases) {
    assertEquals(
      outcome(() => validateImageAttachments(items)),
      await py.raw('attachments', 'validate_image_attachments', [items]),
      JSON.stringify(items).slice(0, 100),
    );
  }
  for (const items of [[{ type: 'image' }, { type: 'file' }, {}], [{ type: null }], [5], 'x', [[]], null]) {
    assertEquals(outcome(() => splitAttachments(items)), await py.raw('attachments', 'split_attachments', [items]));
  }
});

Deno.test('formatSize matches Python, half-way cases included', async () => {
  await using py = new PyParity();
  const counts = [
    0,
    1,
    1023,
    1024,
    1075,
    1076,
    1126,
    1127,
    1280,
    1331,
    1332,
    1536,
    2304,
    10188,
    10189,
    1048575,
    1048576,
    1310720,
    1153434,
    2621440,
    3670016,
    99999999,
  ];
  await py.same('attachments', 'format_size', counts.map((c) => [c]), formatSize);
  for (let c = 1024; c < 1024 * 40; c += 51) assertEquals(formatSize(c), await py.call('attachments', 'format_size', [c]), String(c));
});

Deno.test('mapFileAttachments matches Python for every capability set', async () => {
  await using py = new PyParity();
  const items = [
    fileItem('notes.md', '# Title\n', 'text/markdown'),
    fileItem("it's (1) !~ [x].txt", 'line\n````\nx', ''),
    fileItem('é😀 #&%;.txt', 'y'.repeat(5000), ''),
    fileItem('a.pdf', '%PDF-1', 'application/pdf'),
    fileItem('s.wav', 'RIFFxxxxWAVE', 'audio/wav'),
    fileItem('big.txt', new Uint8Array(1300).fill(97)),
  ];
  const records = (await py.call('attachments', 'validate_file_attachments', [items]) as [FileRecord[], number])[0];
  assertEquals(validateFileAttachments(items)[0], records);
  const capsList: unknown[] = [{}, null, 'x', { embeddedContext: true }, { audio: true }, { audio: true, embeddedContext: true }, {
    embeddedContext: 1,
  }];
  const subsets = [records, records.slice(0, 3), [records[4]], [records[3], records[4]], []];
  for (const caps of capsList) {
    for (const subset of subsets) {
      assertEquals(
        outcome(() => mapFileAttachments(subset, caps)),
        await py.raw('attachments', 'map_file_attachments', [subset, caps]),
        JSON.stringify(caps),
      );
    }
  }
});

Deno.test('eventImageSize matches Python', async () => {
  await using py = new PyParity();
  const events: Dict[] = [
    { data: { attachments: [{ data: 'x'.repeat(10) }, { data: 5 }, 'x', { data: '😀é' }] } },
    { data: 'x' },
    {},
    { data: { attachments: 'abc' } },
    { data: { attachments: { a: 1 } } },
    { data: { attachments: null } },
    { data: { attachments: 5 } },
  ];
  for (const event of events) {
    assertEquals(outcome(() => eventImageSize(event)), await py.raw('attachments', '_event_image_size', [event]), JSON.stringify(event));
  }
});
