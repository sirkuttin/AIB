/**
 * server/artifacts/origin.ts (artifact_origin.py): the OriginTests of work/test_artifacts.py against the real listener on a random
 * port (never 8767/8768), and the same requests sent to Python's artifact_origin serving the same store folder: status, body and
 * headers must match. Plus the Markdown viewer and the scroll script, compared with Python's output for many inputs.
 *
 * Not ported (needs a whole Studio): the Studio token check (the origin never sees it; here a token header is simply sent and
 * ignored), and the auth gate refusing the artifact origin as a page origin (security_test.ts covers Gate).
 */
import { assert, assertEquals } from './_assert.ts';
import { PyParity } from './_parity.ts';
import { ArtifactStore } from '../../outputs/agent-studio/server/artifacts/artifacts.ts';
import { injectScroll, markdownPage, OriginServer, renderMarkdown } from '../../outputs/agent-studio/server/artifacts/origin.ts';

const WIN = Deno.build.os === 'windows';
const SEP = WIN ? '\\' : '/';
const join = (...parts: string[]) => parts.join(SEP);
const enc = (text: string) => new TextEncoder().encode(text);
const py = new PyParity();

type Reply = { status: number; headers: Record<string, string>; body: Uint8Array };

/** One raw HTTP/1.1 request (a raw target and Host header, which fetch() would normalize). */
async function raw(port: number, target: string, host: string | null, method = 'GET', extra: Record<string, string> = {}): Promise<Reply> {
  const conn = await Deno.connect({ hostname: '127.0.0.1', port });
  let head = `${method} ${target} HTTP/1.1\r\n`;
  if (host !== null) head += `Host: ${host}\r\n`;
  for (const [k, v] of Object.entries(extra)) head += `${k}: ${v}\r\n`;
  await conn.write(enc(head + 'Connection: close\r\n\r\n'));
  const chunks: Uint8Array[] = [];
  const buf = new Uint8Array(65536);
  for (;;) {
    const n = await conn.read(buf).catch(() => null);
    if (n === null) break;
    chunks.push(buf.slice(0, n));
  }
  conn.close();
  const all = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
  let o = 0;
  for (const c of chunks) all.set(c, (o += c.length) - c.length);
  let split = 0;
  while (split + 3 < all.length && !(all[split] === 13 && all[split + 1] === 10 && all[split + 2] === 13 && all[split + 3] === 10)) split++;
  const lines = new TextDecoder('latin1').decode(all.subarray(0, split)).split('\r\n');
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const at = line.indexOf(':');
    headers[line.slice(0, at).toLowerCase()] = line.slice(at + 1).trim();
  }
  let body = all.subarray(split + 4);
  if (headers['content-length'] !== undefined) body = body.subarray(0, Number(headers['content-length']));
  return { status: Number(lines[0].split(' ')[1]), headers, body };
}

function freePort(): number {
  for (;;) {
    const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
    const port = (listener.addr as Deno.NetAddr).port;
    listener.close();
    if (port !== 8767 && port !== 8768 && port !== 8766 && port < 65000) return port;
  }
}

const tmp = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-origin-' })).replace(/^\\\\\?\\/, '');
const store = new ArtifactStore(join(tmp, 'artifacts'));
const studioPort = freePort();
const origin = OriginServer.start(store.root, studioPort);
store.origin = origin.url;
const MD =
  '# Title\n\n<script>alert(1)</script> **bold** [l](https://example.com) [bad](javascript:alert(1))\n\n- a\n- b\n\n```\n<b>code</b>\n```\n';
const html = store.create('c1', 'P', 'html', 'p.html', enc('<html><body><h1>x</h1></body></html>'));
const md = store.create('c1', 'M', 'md', 'n.md', enc(MD));
const png = store.create('c1', 'I', 'image', 'i.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10]));
const odd = store.create('c1', 'O', 'text', 'we ird é.txt', enc('odd name'));
const pyPort = await py.call('artifacts_shim', 'origin_start', [store.root, studioPort]) as number;
const get = (path: string, host: string | null = `127.0.0.1:${origin.port}`, method = 'GET') => raw(origin.port, path, host, method);

Deno.test('origin: listens on 127.0.0.1, Studio port + 1 when free', () => {
  assertEquals(origin.url, `http://127.0.0.1:${origin.port}`);
  assert(origin.port !== studioPort);
  assert([studioPort + 1, origin.port].includes(origin.port));
});

Deno.test('origin: HTML headers and the exact CSP; the scroll script goes before </body>', async () => {
  const { status, headers: h, body } = await get(`/a/${html.id}/v1/p.html`);
  assertEquals(status, 200);
  assertEquals(h['content-type'], 'text/html; charset=utf-8');
  assertEquals(h['x-content-type-options'], 'nosniff');
  assertEquals(h['referrer-policy'], 'no-referrer');
  assertEquals(h['cache-control'], 'no-store');
  assertEquals(h['access-control-allow-origin'], undefined);
  const expected =
    "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com; " +
    "style-src 'unsafe-inline' https://fonts.googleapis.com; font-src data: https://fonts.gstatic.com; img-src data: blob: 'self'; media-src data: blob: 'self'; " +
    `connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors http://127.0.0.1:${studioPort} http://localhost:${studioPort}; ` +
    'sandbox allow-scripts allow-forms allow-popups allow-downloads';
  assertEquals(h['content-security-policy'], expected);
  const text = new TextDecoder().decode(body);
  assert(text.includes('studio-artifact-scroll'));
  assert(text.indexOf('studio-artifact-scroll') < text.indexOf('</body>'));
});

Deno.test('origin: an image has no CSP but the other headers', async () => {
  const { status, headers: h, body } = await get(`/a/${png.id}/v1/i.png`);
  assertEquals([status, h['content-type'], [...body.subarray(0, 4)]], [200, 'image/png', [0x89, 0x50, 0x4e, 0x47]]);
  assertEquals(h['content-security-policy'], undefined);
  assertEquals(h['x-content-type-options'], 'nosniff');
});

Deno.test('origin: the download flag', async () => {
  const { headers: h } = await get(`/a/${html.id}/v1/p.html?download=1`);
  assert(h['content-disposition'].includes('attachment'));
  assert(h['content-disposition'].includes('p.html'));
  assertEquals((await get(`/a/${html.id}/v1/p.html`)).headers['content-disposition'], undefined);
});

Deno.test('origin: Markdown raw, and the viewer escapes HTML', async () => {
  let reply = await get(`/a/${md.id}/v1/n.md`);
  assert(reply.headers['content-type'].startsWith('text/plain'));
  assert(new TextDecoder().decode(reply.body).includes('<script>alert(1)</script>'));
  reply = await get(`/a/${md.id}/v1/n.md?view=1`);
  assertEquals(reply.status, 200);
  assert(reply.headers['content-type'].startsWith('text/html'));
  assert('content-security-policy' in reply.headers);
  const text = new TextDecoder().decode(reply.body);
  assert(!text.includes('<script>alert(1)</script>'));
  for (
    const part of [
      '&lt;script&gt;alert(1)&lt;/script&gt;',
      '<h1>Title</h1>',
      '<strong>bold</strong>',
      'target="_blank"',
      '&lt;b&gt;code&lt;/b&gt;',
      '<li>a</li>',
    ]
  ) {
    assert(text.includes(part), part);
  }
  assert(!text.includes('javascript:'));
});

const BAD_PATHS = (i: string) => [
  `/a/${i}/v1/../manifest.json`,
  `/a/${i}/v1/%2e%2e/manifest.json`,
  `/a/${i}/v1/..%2fmanifest.json`,
  `/a/${i}/v1/..%5cmanifest.json`,
  `/a/${i}/v1/`,
  `/a/${i}/v1`,
  `/a/${i}/v9/p.html`,
  `/a/${i}/v1/missing.html`,
  '/a/',
  '/a',
  '/',
  '/a/zzzz/v1/p.html',
  `/a/${i}/v1/p.html%00.png`,
  `/a/${i}/v1/.%2e/v1/p.html`,
  '/api/live/bootstrap',
  `/a/${i}/manifest.json`,
  `/a/${i}/v1/./p.html/`,
  `/a/${i}/v1//p.html`,
  `/a/${i}/v01/p.html`,
  `/a/${i}/v1/%2Fetc%2Fpasswd`,
  `/a/${i}/v1/C:%2Fwindows%2Fwin.ini`,
  `/a/${i.toUpperCase()}/v1/p.html`,
];

Deno.test('origin: traversal and bad paths are 404 and show nothing', async () => {
  for (const path of BAD_PATHS(html.id)) {
    const { status, body } = await get(path);
    if (path.includes('/v01/') || path.includes('v1//')) continue; // compared with Python below (both serve or both refuse)
    assertEquals(status, 404, path);
    assert(!new TextDecoder().decode(body).includes('versions'), path);
  }
});

Deno.test('origin: a symlink out of the snapshot is refused', async () => {
  const secret = join(tmp, 'secret.txt');
  Deno.writeTextFileSync(secret, 'top secret');
  const link = join(store.root, html.id, 'v1', 'link.txt');
  try {
    Deno.symlinkSync(secret, link);
  } catch {
    console.log('symlinks not available: skipped');
    return;
  }
  assertEquals((await get(`/a/${html.id}/v1/link.txt`)).status, 404);
  assertEquals((await raw(pyPort, `/a/${html.id}/v1/link.txt`, `127.0.0.1:${pyPort}`)).status, 404);
  Deno.removeSync(link);
});

Deno.test('origin: the Host header must name this origin', async () => {
  const i = html.id;
  assertEquals((await get(`/a/${i}/v1/p.html`, `localhost:${origin.port}`)).status, 200);
  for (const host of ['evil.example', `evil.example:${origin.port}`, '127.0.0.1', `127.0.0.1:${studioPort}`, '', null]) {
    const reply = await get(`/a/${i}/v1/p.html`, host);
    assertEquals([reply.status, new TextDecoder().decode(reply.body)], [403, 'Forbidden'], String(host));
  }
});

Deno.test('origin: GET only', async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']) {
    const reply = await get(`/a/${html.id}/v1/p.html`, undefined, method);
    assertEquals([reply.status, reply.headers.allow], [405, 'GET'], method);
  }
});

Deno.test('origin: the Studio token means nothing here', async () => {
  const reply = await raw(origin.port, '/api/live/bootstrap', `127.0.0.1:${origin.port}`, 'GET', { 'X-Studio-Token': 'secret-token' });
  assertEquals(reply.status, 404);
  assert(!new TextDecoder().decode(reply.body).includes('secret-token'));
});

Deno.test('origin: a busy port + 1 falls back to a free port', async () => {
  const taken = OriginServer.start(store.root, origin.port - 1); // port + 1 is our origin: busy
  try {
    assert(taken.port !== origin.port);
    assertEquals((await raw(taken.port, `/a/${html.id}/v1/p.html`, `127.0.0.1:${taken.port}`)).status, 200);
  } finally {
    await taken.stop();
  }
});

// ---- parity with Python's listener on the same store ---------------------------------------------------

const COMPARED = [
  'content-type',
  'content-length',
  'x-content-type-options',
  'referrer-policy',
  'cache-control',
  'content-disposition',
  'allow',
];

async function compare(target: string, method = 'GET', host?: (port: number) => string | null) {
  const mine = await raw(origin.port, target, host ? host(origin.port) : `127.0.0.1:${origin.port}`, method);
  const theirs = await raw(pyPort, target, host ? host(pyPort) : `127.0.0.1:${pyPort}`, method);
  const pick = (r: Reply) => Object.fromEntries(COMPARED.filter((k) => k in r.headers).map((k) => [k, r.headers[k]]));
  assertEquals(mine.status, theirs.status, `${method} ${target}: status`);
  assertEquals(pick(mine), pick(theirs), `${method} ${target}: headers`);
  assertEquals(mine.headers['content-security-policy'], theirs.headers['content-security-policy'], `${method} ${target}: CSP`);
  if (method !== 'HEAD') assertEquals([...mine.body].join(), [...theirs.body].join(), `${method} ${target}: body`);
}

Deno.test('parity: the same answers as Python for the same store', async () => {
  const targets = [
    `/a/${html.id}/v1/p.html`,
    `/a/${html.id}/v1/p.html?download=1`,
    `/a/${html.id}/v1/p.html?download=1&download=1`,
    `/a/${html.id}/v1/p.html?download=0`,
    `/a/${html.id}/v1/p.html?x=1#frag`,
    `/a/${md.id}/v1/n.md`,
    `/a/${md.id}/v1/n.md?view=1`,
    `/a/${md.id}/v1/n.md?view=1&download=1`,
    `/a/${md.id}/v1/n.md?view=%31`,
    `/a/${png.id}/v1/i.png`,
    `/a/${png.id}/v1/i.png?download=1`,
    `/a/${odd.id}/v1/we%20ird%20%C3%A9.txt`,
    `/a/${odd.id}/v1/we%20ird%20%C3%A9.txt?download=1`,
    `/a/${html.id}/v1/P.HTML`,
    `/a/${html.id}/v1/p.html.`,
    `/a/${html.id}/v1/p.html%0A`,
    `http://127.0.0.1/a/${html.id}/v1/p.html`,
    ...BAD_PATHS(html.id),
  ];
  for (const target of targets) await compare(target);
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) await compare(`/a/${html.id}/v1/p.html`, method);
  for (const host of [(p: number) => `localhost:${p}`, () => 'evil.example', () => '', (p: number) => `127.0.0.1:${p + 1}`]) {
    await compare(`/a/${html.id}/v1/p.html`, 'GET', host);
  }
});

Deno.test('parity: other snapshot file types', async () => {
  const folder = join(store.root, html.id, 'v1');
  const names = [
    's.css',
    'm.js',
    'd.json',
    'v.svg',
    'x.xml',
    'z.zip',
    'w.wasm',
    'b.bin',
    'a.mp3',
    'i.ico',
    'p.py',
    'q.weird-ext',
    'noext',
    'a.markdown',
    'h.htm',
    'u.HTM',
  ];
  for (const name of names) Deno.writeTextFileSync(join(folder, name), `<body>${name}</body>`);
  for (const name of names) {
    await compare(`/a/${html.id}/v1/${name}`);
    if (name.endsWith('.markdown')) await compare(`/a/${html.id}/v1/${name}?view=1`);
  }
  Deno.mkdirSync(join(folder, 'sub'));
  Deno.writeTextFileSync(join(folder, 'sub', 'in.html'), '<p>in</p>');
  for (const t of ['sub/in.html', 'sub/../sub/in.html', 'sub//in.html', 'sub/./in.html', 'sub', 'sub/']) {
    await compare(`/a/${html.id}/v1/${t}`);
  }
});

const MARKDOWN = [
  MD,
  '',
  'plain text\nsecond line',
  '## Heading ##\n### h3\n####### seven',
  '---\n***\n_ _ _\n- - -',
  '> quote **b**\n> more\n>> nested\n\nafter',
  '| a | b |\n|---|:--:|\n| 1 | *2* |\n| 3 |\n\ntext',
  'a | b\n-- | --\nc | d',
  '- [ ] todo\n- [x] done\n- [X] Done\n* star\n+ plus\n  continued line\n- next',
  '1. one\n2) two\n10. ten\n٣. arabic',
  '```js\nconst x = "<y>";\n```\n~~~\nunclosed',
  '![alt <x>](https://x/y.png "t") ![m](mailto:a@b) ![j](javascript:x) ![r](rel/pic.png)',
  '[a](https://a.b/c?d=e&f=g) [b](#top) [c](/x) [d](./y) [e](../z) [f](data:text/html,x) [g](vbscript:x) [h](foo:bar) [i](mailto:x@y)',
  '[t](https://x "title") [u](<bad>) [v](a&amp;b)',
  'auto https://example.com/path?q=1. and (https://x.y/z) and "https://q.r" =https://s.t',
  '**bold** __under__ *em* _em_ ~~del~~ snake_case_word 2*3*4 ** not ** `code *x*` `a`b`',
  'tabs\tand nbsp line sep　ideographic',
  '\r\nwindows\r\nlines\rold mac',
  'emoji 😀 **é** [ü](https://ü.example)',
  '<div onclick="x">raw & < > " \' </div>',
  '\x00stash\x00 1 \x00',
  '  indented paragraph\n    more indented',
  '#nospace\n# \n#',
];

Deno.test('parity: the Markdown viewer renders as Python does', async () => {
  for (const source of MARKDOWN) {
    let expected: unknown;
    try {
      expected = await py.call('artifacts_shim', 'markdown_page', [source, 'T <&> "q"']);
    } catch (error) {
      let threw = false;
      try {
        renderMarkdown(source);
      } catch {
        threw = true;
      }
      assert(threw, `Python raised (${error}) but Deno rendered ${JSON.stringify(source)}`);
      continue;
    }
    assertEquals(new TextDecoder('utf-8', { ignoreBOM: true }).decode(markdownPage(source, 'T <&> "q"')), expected, JSON.stringify(source));
  }
});

Deno.test('parity: the scroll script is injected as Python does', async () => {
  const pages = ['<html><body>x</body></html>', 'no body', '<BODY>a</Body >b</body\n>c', '﻿bom</body>', '</body></body>', 'é😀</body>'];
  for (const page of pages) {
    assertEquals(
      new TextDecoder('utf-8', { ignoreBOM: true }).decode(injectScroll(enc(page))),
      await py.call('artifacts_shim', 'inject_scroll', [page]),
      JSON.stringify(page),
    );
  }
});

Deno.test('origin teardown', async () => {
  await py.call('artifacts_shim', 'origin_stop', [pyPort]);
  await origin.stop();
  await py.close();
  Deno.removeSync(tmp, { recursive: true });
});
