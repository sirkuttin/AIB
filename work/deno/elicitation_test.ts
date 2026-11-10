/** server/acp/elicitation.ts: the cases of work/test_elicitation.py, plus parity with Python's elicitation.py. */
import { assertEquals, AssertionError } from './_assert.ts';
import { PyParity } from './_parity.ts';
import {
  validateContent,
  validateSchema,
  validateUrl,
  validateUrlRequest,
  ValueError,
} from '../../outputs/agent-studio/server/acp/elicitation.ts';

type Json = Record<string, unknown>;

function outcome(fn: () => unknown) {
  try {
    return { ok: fn() ?? null };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { error: error.name, message: error.message };
  }
}

function throwsValue(fn: () => unknown, message = '') {
  try {
    fn();
  } catch (error) {
    if (error instanceof ValueError) return;
    throw error;
  }
  throw new AssertionError(`no ValueError: ${message}`);
}

Deno.test('accepts a flat schema and optional properties', () => {
  const schema = {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1 },
      email: { type: 'string', format: 'email' },
      age: { type: 'integer', minimum: 0, maximum: 130 },
      active: { type: 'boolean' },
    },
    required: ['name'],
  };
  assertEquals(validateSchema(schema), null);
  assertEquals(validateContent(schema, { name: 'Ada' }), { name: 'Ada' });
});

Deno.test('enum, named choice and multiselect', () => {
  const schema = {
    type: 'object',
    properties: {
      color: { type: 'string', oneOf: [{ const: '#f00', title: 'Red' }, { const: '#00f', title: 'Blue' }] },
      tags: {
        type: 'array',
        minItems: 1,
        maxItems: 2,
        items: { type: 'string', anyOf: [{ const: 'a', title: 'Alpha' }, { const: 'b', title: 'Beta' }] },
      },
    },
    required: ['color'],
  };
  assertEquals(validateContent(schema, { color: '#f00', tags: ['b'] }), { color: '#f00', tags: ['b'] });
});

Deno.test("Claude adapter's named multiselect shape", () => {
  const schema = {
    type: 'object',
    properties: {
      features: {
        type: 'array',
        items: {
          anyOf: [{ const: 'search', title: 'Search', description: 'Find documents' }, {
            const: 'write',
            title: 'Write',
            description: 'Create documents',
          }],
        },
      },
    },
  };
  assertEquals(validateContent(schema, { features: ['search', 'write'] }), { features: ['search', 'write'] });
  throwsValue(() => validateContent(schema, { features: ['unknown'] }));
});

Deno.test('rejects invalid values and unknown payload', () => {
  const schema = { type: 'object', properties: { n: { type: 'number', minimum: 1 }, s: { type: 'string', enum: ['x'] } }, required: ['n'] };
  for (const value of [true, Infinity, 0, '1']) throwsValue(() => validateContent(schema, { n: value }), String(value));
  throwsValue(() => validateContent(schema, { n: 2, credential: 'x' }));
  throwsValue(() => validateContent(schema, {}));
  throwsValue(() => validateContent(schema, { n: 2, s: 'z' }));
});

const invalidSchemas = [
  { type: 'object', properties: { x: { type: 'object', properties: {} } } },
  { type: 'object', properties: { x: { $ref: '#/definitions/x' } } },
  { type: 'object', properties: { x: { type: 'string', format: 'password' } } },
  { type: 'object', properties: { x: { type: 'string', writeOnly: true } } },
  { type: 'object', properties: { x: { type: 'array', items: { type: 'object' } } } },
  { type: 'object', properties: { x: { type: 'string', pattern: '.*' } } },
];

Deno.test('rejects nested objects, refs, unknown keywords and secret markers', () => {
  for (const schema of invalidSchemas) throwsValue(() => validateSchema(schema), JSON.stringify(schema));
});

Deno.test('bool is not a number; array constraints', () => {
  const schema = {
    type: 'object',
    properties: { num: { type: 'number' }, choices: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } } },
  };
  for (const content of [{ num: true }, { num: 3, choices: ['a', 'a'] }, { num: 3, choices: ['c'] }, { num: 3, choices: 'a' }]) {
    throwsValue(() => validateContent(schema, content), JSON.stringify(content));
  }
});

const formatSchema = {
  type: 'object',
  properties: {
    url: { type: 'string', format: 'uri' },
    date: { type: 'string', format: 'date' },
    when: { type: 'string', format: 'date-time' },
  },
};

Deno.test('string formats and date-time', () => {
  const good = { url: 'https://example.org/path', date: '2026-11-07', when: '2026-11-07T12:00:00Z' };
  assertEquals(validateContent(formatSchema, good), good);
  throwsValue(() => validateContent(formatSchema, { ...good, date: 'yesterday' }));
});

const goodUrls = ['https://example.com/a?b=1#c', 'http://localhost:8080/x', 'https://xn--e1afmkfd.example/'];
const badUrls: unknown[] = [
  'javascript:alert(1)',
  'file:///c:/x',
  'ftp://example.com',
  'https://u:p@example.com',
  'https://example.com@evil.test/',
  'https:///x',
  'https://exa mple.com',
  'https://example.com:99999/',
  '//example.com',
  '',
  null,
  5,
  'https://example.com/' + 'a'.repeat(2100),
];

Deno.test('URL mode accepts only plain http destinations', () => {
  for (const ok of goodUrls) assertEquals(validateUrl(ok), ok);
  for (const bad of badUrls) throwsValue(() => validateUrl(bad), String(bad));
});

Deno.test('URL request requires an elicitationId and no schema', () => {
  const good = { mode: 'url', message: 'm', url: 'https://example.com', elicitationId: 'id-1' };
  assertEquals(validateUrlRequest(good), 'https://example.com');
  const { elicitationId: _, ...withoutId } = good;
  for (
    const bad of [{ ...good, elicitationId: '' }, { ...good, elicitationId: 7 }, withoutId, {
      ...good,
      requestedSchema: { type: 'object', properties: {} },
    }]
  ) {
    throwsValue(() => validateUrlRequest(bad), JSON.stringify(bad));
  }
});

// ---- parity ------------------------------------------------------------------

const obj = (properties: Json, extra: Json = {}) => ({ type: 'object', properties, ...extra });
const schemas: unknown[] = [
  ...invalidSchemas,
  obj({}),
  obj({}, { title: 't', description: 'd', required: [] }),
  obj({}, { title: 5 }),
  obj({}, { description: 'x'.repeat(100001) }),
  obj({}, { $ref: '#' }),
  obj({}, { extra: 1 }),
  obj({}, { required: ['a'] }),
  obj({ a: { type: 'string' } }, { required: ['a', 'a'] }),
  obj({ a: { type: 'string' } }, { required: null }),
  obj({ a: { type: 'string' } }, { required: [1] }),
  { type: 'array', properties: {} },
  { properties: {} },
  { type: 'object' },
  { type: 'object', properties: [] },
  null,
  [],
  'x',
  obj({ '': { type: 'string' } }),
  obj({ a: 5 }),
  obj({ a: [] }),
  obj({ a: {} }),
  obj({ a: { type: ['string'] } }),
  obj({ a: { type: { t: 1 } } }),
  obj({ a: { type: 'string', format: ['email'] } }),
  obj({ a: { type: 'string', format: 'phone' } }),
  obj({ a: { type: 'string', format: 'email', enum: ['a@b.c'] } }),
  obj({ a: { type: 'string', minLength: -1 } }),
  obj({ a: { type: 'string', minLength: true } }),
  obj({ a: { type: 'string', minLength: 1.5 } }),
  obj({ a: { type: 'string', maxLength: 100001 } }),
  obj({ a: { type: 'string', minLength: 5, maxLength: 4 } }),
  obj({ a: { type: 'string', minLength: 2, default: 'x' } }),
  obj({ a: { type: 'string', default: 'x', enum: ['x', 'y'] } }),
  obj({ a: { type: 'string', default: 'z', enum: ['x', 'y'] } }),
  obj({ a: { type: 'string', enum: [] } }),
  obj({ a: { type: 'string', enum: ['x', 'x'] } }),
  obj({ a: { type: 'string', enum: ['x', 1] } }),
  obj({ a: { type: 'string', enum: ['x'], oneOf: [{ const: 'x' }] } }),
  obj({ a: { type: 'string', oneOf: [] } }),
  obj({ a: { type: 'string', oneOf: [{ const: 'x', extra: 1 }] } }),
  obj({ a: { type: 'string', oneOf: [{ title: 'x' }] } }),
  obj({ a: { type: 'string', oneOf: [{ const: 1 }] } }),
  obj({ a: { type: 'string', oneOf: [{ const: 'x', title: 2 }] } }),
  obj({ a: { type: 'string', oneOf: [{ const: 'x', description: [] }] } }),
  obj({ a: { type: 'string', oneOf: ['x'] } }),
  obj({ a: { type: 'string', enum: Array.from({ length: 257 }, (_, i) => `v${i}`) } }),
  obj({ a: { type: 'string', title: 3 } }),
  obj({ a: { type: 'string', description: null } }),
  obj({ a: { type: 'string', writeOnly: 'no' } }),
  obj({ a: { type: 'string', writeOnly: false } }),
  obj({ a: { type: 'number', format: 'password' } }),
  obj({ a: { type: 'number', minimum: 'x' } }),
  obj({ a: { type: 'number', minimum: true } }),
  obj({ a: { type: 'number', minimum: 5, maximum: 1 } }),
  obj({ a: { type: 'integer', minimum: 1, maximum: 5, default: 7 } }),
  obj({ a: { type: 'integer', default: 2.5 } }),
  obj({ a: { type: 'number', default: 2.5, maximum: 3 } }),
  obj({ a: { type: 'number', minLength: 1 } }),
  obj({ a: { type: 'boolean', default: 1 } }),
  obj({ a: { type: 'boolean', default: true, enum: ['x'] } }),
  obj({ a: { type: 'boolean', zeta: 1, alpha: 2, 'é': 3, '😀': 4, '\uff01': 5 } }),
  obj({ a: { type: 'string', format: 'date', default: '2026-02-30' } }),
  obj({ a: { type: 'string', format: 'email', default: 'a@b.co' } }),
  obj({ a: { type: 'array' } }),
  obj({ a: { type: 'array', items: 5 } }),
  obj({ a: { type: 'array', items: {} } }),
  obj({ a: { type: 'array', items: { type: 'string' } } }),
  obj({ a: { type: 'array', items: { type: null, anyOf: [{ const: 'x' }] } } }),
  obj({ a: { type: 'array', items: { type: 'string', enum: ['x'], extra: 1 } } }),
  obj({ a: { type: 'array', items: { type: 'string', enum: ['x'] }, uniqueItems: true } }),
  obj({ a: { type: 'array', items: { enum: ['x'] } } }),
  obj({ a: { type: 'array', items: { type: 'string', enum: ['x'] }, minItems: 2, maxItems: 1 } }),
  obj({ a: { type: 'array', items: { type: 'string', enum: ['x'] }, maxItems: 257 } }),
  obj({ a: { type: 'array', items: { type: 'string', enum: ['x'] }, minItems: -1 } }),
  obj({ a: { type: 'array', items: { type: 'string', enum: ['x', 'y'] }, default: ['y'] } }),
  obj({ a: { type: 'array', items: { type: 'string', enum: ['x', 'y'] }, default: ['z'] } }),
  obj({ a: { type: 'array', items: { type: 'string', enum: ['x', 'y'] }, default: 'x' } }),
  obj({ a: { type: 'array', items: { type: 'string', enum: ['x', 'y'] }, default: ['x', 'x'] } }),
  obj({ a: { type: 'array', items: { type: 'string', enum: ['x'] }, writeOnly: true } }),
  obj({ a: { type: 'array', items: { type: 'string', anyOf: [{ const: 'x' }, { const: 'x' }] } } }),
  obj(Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`p${i}`, { type: 'boolean' }]))),
  obj({ ['k'.repeat(100001)]: { type: 'string' } }),
  // the 64 KiB repr limit, around its edge (repr quoting, unicode, numbers)
  ...[60000, 64000, 65400, 65500].flatMap((n) => [
    obj({ a: { type: 'string', description: 'd'.repeat(n) } }),
    obj({ a: { type: 'string', description: "it's".repeat(n / 4) } }),
    obj({ a: { type: 'string', description: 'é\n\\\u0000\u200b'.repeat(n / 10) } }),
    obj({ a: { type: 'string', description: '😀'.repeat(n / 4) } }),
    obj({ a: { type: 'number', minimum: -1.5e-7, maximum: 12345678901234567, default: 0.1, title: 'x'.repeat(n) } }),
  ]),
];

Deno.test('validateSchema matches Python', async () => {
  await using py = new PyParity();
  for (const schema of schemas) {
    assertEquals(
      outcome(() => validateSchema(schema)),
      await py.raw('elicitation', 'validate_schema', [schema]),
      JSON.stringify(schema).slice(0, 150),
    );
  }
});

const contentSchema = obj({
  s: { type: 'string', minLength: 1, maxLength: 3 },
  e: { type: 'string', enum: ['x', 'y'] },
  n: { type: 'number', minimum: 0, maximum: 10 },
  i: { type: 'integer' },
  b: { type: 'boolean' },
  m: { type: 'array', items: { type: 'string', enum: ['a', 'b', 'c'] }, minItems: 1, maxItems: 2 },
  c: { type: 'array', items: { anyOf: [{ const: 'p' }, { const: 'q' }] } },
}, { required: ['s', 'b'] });

const contents: unknown[] = [
  { s: 'ab', b: true },
  { s: '😀😀😀', b: false },
  { s: '😀😀😀😀', b: false },
  { s: '', b: true },
  { s: 5, b: true },
  { b: true },
  {},
  { s: 'a', b: 1 },
  { s: 'a', b: true, e: 'z' },
  { s: 'a', b: true, e: 'y', n: 10, i: -3 },
  { s: 'a', b: true, n: 10.5 },
  { s: 'a', b: true, n: '1' },
  { s: 'a', b: true, n: null },
  { s: 'a', b: true, i: 1.5 },
  { s: 'a', b: true, m: [] },
  { s: 'a', b: true, m: ['a', 'b', 'c'] },
  { s: 'a', b: true, m: ['a', 'a'] },
  { s: 'a', b: true, m: ['a', 1] },
  { s: 'a', b: true, c: ['q', 'p'] },
  { s: 'a', b: true, c: ['r'] },
  { s: 'a', b: true, zz: 1, aa: 2, 'é': 3 },
  { b: true, zz: 1 },
  [],
  null,
];

Deno.test('validateContent matches Python', async () => {
  await using py = new PyParity();
  for (const content of contents) {
    const expected = await py.raw('elicitation', 'validate_content', [contentSchema, content]);
    assertEquals(outcome(() => validateContent(contentSchema, content)), expected, JSON.stringify(content));
  }
  assertEquals(outcome(() => validateContent(null, {})), await py.raw('elicitation', 'validate_content', [null, {}]));
});

/** Deterministic pseudo-random strings, for fuzzing the format checks against Python. */
function* fuzz(seed: number, count: number, templates: string[], alphabet: string[]): Generator<string> {
  let state = seed;
  const rand = (n: number) => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state % n;
  };
  for (let i = 0; i < count; i++) {
    const chars = Array.from(templates[rand(templates.length)]);
    for (let edits = rand(4); edits > 0; edits--) {
      const at = rand(chars.length + 1);
      const op = rand(3);
      const ch = alphabet[rand(alphabet.length)];
      if (op === 0) chars.splice(at, 1, ch);
      else if (op === 1) chars.splice(at, 0, ch);
      else chars.splice(at, 1);
    }
    yield chars.join('');
  }
}

const dateTemplates = [
  '2026-11-07',
  '20261107',
  '2026-W45',
  '2026W45',
  '2026-W45-6',
  '2026W456',
  '2020-W53-1',
  '2026-W53-1',
  '2024-02-29',
  '2023-02-29',
  '0000-01-01',
  '9999-12-31',
  '0000-W01-1',
  '9999-W52-5',
  '20261107xy',
  '2026W011xy',
  '2026-11-0é',
];
const dateTimeTemplates = [
  '2026-11-07T12:00:00Z',
  '2026-11-07T12:00:00+01:00',
  '2026-11-07T12:00:00-05:30',
  '2026-11-07T12:00:00.123456Z',
  '2026-11-07T12:00:00,5+00:00',
  '2026-11-07T12Z',
  '2026-11-07T1200Z',
  '2026-11-07T120000Z',
  '2026-11-07T12:00:00:5Z',
  '2026-11-07T12:00:00.1234567Z',
  '20261107T120000Z',
  '2026-W45-6T12:00Z',
  '2026W45T12:00Z',
  '2026W456T12+01',
  '2026-11-07T12:00:00+23:59:59.999999',
  '2026-11-07T12:00:00+24:00',
  '2026-11-07T24:00:00Z',
  '2026-11-07 12:00:00Z',
  '2026-11-07T12:00:00+0130',
  '2026-11-07T12:00:00.Z',
  '2026-11-07T12:00:00+00:00:00.5',
  '2026-11-07T12:60Z',
  '2026-11-07T12:00:00',
  '2026-11-07',
  '2026-W01-T12Z',
  '2026-W011T12Z',
  '2026-11-07\ud80012:00Z',
  '2026-11-07T12:00Z\u0000',
];
const uriTemplates = [
  'https://example.org/path',
  'http://x',
  'ftp://host/file',
  'mailto:a@b.c',
  'urn:isbn:123',
  'https:/x',
  'https://',
  'http://[::1]:80/',
  'http://[::1/',
  'http://]x[/',
  'ftp:',
  'a+b.c-d:rest',
  '1abc:x',
  ':x',
  'https://ex\u2100ample/',
  'https://exämple.org',
  'HTTPS://X',
  'ht\ttp://x',
];
const emailTemplates = [
  'a@b.co',
  'a.b@c.d.e',
  'a@b',
  '@b.c',
  'a@.c',
  'a@b.',
  'a b@c.d',
  'a<b@c.d',
  'é@ü.ß',
  'a@b@c.d',
  'a@b.c\u0085',
  'a\u3000@b.c',
  'a\ufeff@b.c',
];
const alphabet = [...'0123456789-:T+Z.,W @/?#[]Ze\u0000\t', 'é', '😀', '\u3000', '\ud800', '\u0661'];

Deno.test('string formats match Python (fuzzed)', async () => {
  await using py = new PyParity();
  const cases: [string, string[]][] = [
    ['date', [...dateTemplates, ...fuzz(1, 600, dateTemplates, alphabet)]],
    ['date-time', [...dateTimeTemplates, ...fuzz(2, 1200, dateTimeTemplates, alphabet)]],
    ['uri', [...uriTemplates, ...fuzz(3, 400, uriTemplates, alphabet)]],
    ['email', [
      ...emailTemplates,
      ...'x'.repeat(0),
      'a@b.' + 'c'.repeat(250),
      'a@b.' + 'c'.repeat(251),
      ...fuzz(4, 300, emailTemplates, alphabet),
    ]],
  ];
  for (const [format, values] of cases) {
    const schema = obj({ v: { type: 'string', format } });
    for (const value of values) {
      const expected = await py.raw('elicitation', 'validate_content', [schema, { v: value }]);
      assertEquals(outcome(() => validateContent(schema, { v: value })), expected, `${format} ${JSON.stringify(value)}`);
    }
  }
});

const urlTemplates = [
  ...goodUrls,
  'https://example.com:+80/',
  'https://example.com:٨٠/',
  'https://example.com:8_0/',
  'https://example.com:-0/',
  'https://example.com:\u3000/',
  'https://example.com:65535',
  'https://example.com:65536',
  'https://example.com:/',
  'https://[::1]:8080/',
  'https://[::1/',
  'https://]x/',
  'HTTPS://X.COM',
  'https://ex\u2100ample.com/',
  'https://exämple.com/',
  'https://:80/',
  'https://@x/',
  'https://x?@y',
  'https://x#@y',
  'http:x',
  'https://x:1:2/',
  'https://[::1]x:99999/',
  'https://example.com:𝟠𝟘/',
  'https://a\u00a0b/',
  'mailto:x@y',
  'https://x\u007f/',
];

Deno.test('validateUrl and validateUrlRequest match Python', async () => {
  await using py = new PyParity();
  const urls: unknown[] = [...urlTemplates, ...badUrls, ...fuzz(5, 400, urlTemplates, [...alphabet, ':', '%', 'é'])];
  for (const url of urls) {
    assertEquals(outcome(() => validateUrl(url)), await py.raw('elicitation', 'validate_url', [url]), JSON.stringify(url));
  }
  const good = { mode: 'url', message: 'm', url: 'https://example.com', elicitationId: 'id-1' };
  const requests: unknown[] = [
    good,
    { ...good, elicitationId: '' },
    { ...good, elicitationId: 7 },
    { ...good, elicitationId: '😀'.repeat(256) },
    { ...good, elicitationId: '😀'.repeat(257) },
    { ...good, requestedSchema: null },
    { ...good, url: 'ftp://x' },
    { elicitationId: 'x' },
    [],
    null,
  ];
  for (const params of requests) {
    assertEquals(
      outcome(() => validateUrlRequest(params)),
      await py.raw('elicitation', 'validate_url_request', [params]),
      JSON.stringify(params),
    );
  }
});
