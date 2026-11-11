/**
 * Studio's artifact tool (test_artifact_mcp.py, test_artifact_prompt.py): the Deno stdio MCP server (`main.ts mcp-artifact`) driven
 * over stdio against a fake Studio, a differential run of the same JSON-RPC lines through artifact_mcp.py and the Deno server (the
 * reply lines and the requests Studio receives must be byte-identical), and the mcpServers entry the Deno Studio gives agents.
 */
import { assert, assertEquals } from './_assert.ts';
import { PY_REF_DIR, python } from './_parity.ts';
import { APP_ROOT, TESTS_DIR } from '../../outputs/agent-studio/server/core/app.ts';
import * as artifactKeys from '../../outputs/agent-studio/server/artifacts/keys.ts';
import { artifactToolCommand, OFFLINE_LIBS_NOTE } from '../../outputs/agent-studio/server/artifacts/mcp.ts';
import { Studio } from '../../outputs/agent-studio/server/host/studio.ts';
import { ARTIFACT_URL_FILE } from '../../outputs/agent-studio/server/host/studio.ts';
import { ARTIFACT_PROMPT, Connection } from '../../outputs/agent-studio/server/acp/connection.ts';
import { selectMcpServers, validateMcpServers } from '../../outputs/agent-studio/server/acp/breadth.ts';
import { ArtifactMcpHttp, CONVERSATION_HEADER, KEY_HEADER } from '../../outputs/agent-studio/server/artifacts/mcp_http.ts';

const WIN = Deno.build.os === 'windows';
const SEP = WIN ? '\\' : '/';
const MAIN = `${APP_ROOT}${SEP}server${SEP}main.ts`;
const DENO_TOOL = [Deno.execPath(), 'run', '-A', '--quiet', MAIN, 'mcp-artifact'];
const PY_TOOL = [python(), `${PY_REF_DIR}${SEP}artifact_mcp.py`]; // the Python reference's tool
Deno.env.set('AGENT_STUDIO_TEST', '1');
/** A Deno reply line with the Deno-only part taken out: the bundled-libraries sentence of publish's description (no /_lib/ in Python). */
const masked = (line: string) => line.replace(JSON.stringify(OFFLINE_LIBS_NOTE).slice(1, -1), '');

type Json = Record<string, unknown>;
interface Recorded {
  method: string;
  path: string;
  key: string | null;
  type: string | null;
  body: unknown;
}

/** Records requests and answers like the artifact routes would (test_artifact_mcp.FakeStudio). */
class FakeStudio {
  requests: Recorded[] = [];
  /** [status, body (JSON value, or a raw string when `raw`), extra headers] override for every request. */
  reply: [number, unknown, Record<string, string>?] | null = null;
  raw = false;
  readonly server: Deno.HttpServer<Deno.NetAddr>;
  readonly url: string;

  constructor() {
    this.server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, async (request) => {
      const text = await request.text();
      const body = text ? JSON.parse(text) : null;
      const url = new URL(request.url);
      this.requests.push({
        method: request.method,
        path: url.pathname + url.search,
        key: request.headers.get('X-Studio-Artifact-Key'),
        type: request.headers.get('Content-Type'),
        body,
      });
      let status = 200, payload: unknown, headers: Record<string, string> = {};
      if (this.reply) {
        [status, payload, headers = {}] = this.reply;
      } else if (url.pathname.startsWith('/api/live/artifacts/publish')) {
        payload = body.id
          ? { id: body.id, title: 'T', version: 2, link: 'studio-artifact://' + body.id }
          : { id: 'abc123', title: body.title, version: 1, link: 'studio-artifact://abc123', url: 'http://127.0.0.1:9/a/abc123/v1/x.html' };
      } else if (url.pathname === '/api/live/worktree/tool') {
        payload = { message: 'Merged 2 commits into main', base: 'main', guidance: 'Tell the user.' };
      } else {
        payload = {
          artifacts: [{ id: 'abc123', title: 'T', kind: 'html', version: 3, link: 'studio-artifact://abc123', url: 'u', pinned: false }],
        };
      }
      const data = this.raw ? String(payload) : JSON.stringify(payload);
      return new Response(data, { status, headers: { 'Content-Type': 'application/json', ...headers } });
    });
    this.url = `http://127.0.0.1:${this.server.addr.port}`;
  }

  close(): Promise<void> {
    return this.server.shutdown();
  }
}

/** A port that accepts and immediately hangs up: Studio "not reachable" without Windows' two-second wait on a closed port. */
class HangUp {
  readonly listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
  readonly url = `http://127.0.0.1:${(this.listener.addr as Deno.NetAddr).port}`;
  constructor() {
    (async () => {
      try {
        for await (const conn of this.listener) conn.close();
      } catch { /* closed */ }
    })();
  }
  close(): void {
    try {
      this.listener.close();
    } catch { /* closed */ }
  }
}

class LineReader {
  #buffer = '';
  #reader: ReadableStreamDefaultReader<string>;
  constructor(stream: ReadableStream<Uint8Array>) {
    this.#reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  }
  async line(): Promise<string> {
    while (!this.#buffer.includes('\n')) {
      const { value, done } = await this.#reader.read();
      if (done) throw new Error('the MCP server closed stdout');
      this.#buffer += value;
    }
    const at = this.#buffer.indexOf('\n');
    const line = this.#buffer.slice(0, at);
    this.#buffer = this.#buffer.slice(at + 1);
    return line;
  }
  cancel() {
    return this.#reader.cancel().catch(() => {});
  }
}

class Shim {
  readonly process: Deno.ChildProcess;
  readonly #writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly #lines: LineReader;
  counter = 0;

  constructor(command: string[], url: string, cwd: string, extraEnv: Record<string, string> = {}, key = 'k1', conversation = 'conv1') {
    const env: Record<string, string> = {
      STUDIO_ARTIFACT_URL: url,
      STUDIO_ARTIFACT_KEY: key,
      STUDIO_CONVERSATION_ID: conversation,
      ...extraEnv,
    };
    const parent = Deno.env.toObject();
    for (const name of ['STUDIO_WORKTREE', 'STUDIO_ARTIFACT_URL_FILE']) if (!(name in extraEnv)) delete parent[name];
    this.process = new Deno.Command(command[0], {
      args: command.slice(1),
      cwd,
      env: { ...parent, PYTHONDONTWRITEBYTECODE: '1', ...env },
      clearEnv: true,
      stdin: 'piped',
      stdout: 'piped',
      stderr: 'null',
    }).spawn();
    this.#writer = this.process.stdin.getWriter();
    this.#lines = new LineReader(this.process.stdout);
  }

  async sendRaw(text: string): Promise<void> {
    await this.#writer.write(new TextEncoder().encode(text));
  }

  send(message: unknown): Promise<void> {
    return this.sendRaw(JSON.stringify(message) + '\n');
  }

  line(): Promise<string> {
    return this.#lines.line();
  }

  async request(method: string, params: unknown = {}): Promise<Json> {
    this.counter++;
    await this.send({ jsonrpc: '2.0', id: this.counter, method, params });
    const reply = JSON.parse(await this.line());
    assertEquals(reply.id, this.counter);
    return reply;
  }

  async call(name: string, args: unknown): Promise<Json> {
    return (await this.request('tools/call', { name, arguments: args })).result as Json;
  }

  async close(): Promise<void> {
    await this.#writer.close().catch(() => {});
    const status = await Promise.race([this.process.status, new Promise<null>((r) => setTimeout(() => r(null), 10000))]);
    if (status === null) {
      try {
        this.process.kill('SIGKILL');
      } catch { /* exited */ }
      await this.process.status;
    }
    await this.#lines.cancel();
  }
}

class Lab {
  readonly dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-mcp-test-' }));
  readonly fake = new FakeStudio();
  readonly cleanups: (() => unknown)[] = [];

  shim(url = this.fake.url, extraEnv: Record<string, string> = {}, key = 'k1', conversation = 'conv1', command = DENO_TOOL): Shim {
    const shim = new Shim(command, url, this.dir, extraEnv, key, conversation);
    this.cleanups.push(() => shim.close());
    return shim;
  }

  hangUp(): HangUp {
    const h = new HangUp();
    this.cleanups.push(() => h.close());
    return h;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    for (const c of this.cleanups.reverse()) await c();
    await this.fake.close();
    Deno.removeSync(this.dir, { recursive: true });
  }
}

function payload(result: Json): [string, unknown] {
  const text = (result.content as Json[])[0].text as string;
  const at = text.indexOf('\n');
  return [text.slice(0, at), JSON.parse(text.slice(at + 1))];
}

const firstText = (result: Json) => (result.content as Json[])[0].text as string;

// ---- ShimTests ---------------------------------------------------------------------------------------------------------------

Deno.test('initialize negotiation and tools/list', async () => {
  await using lab = new Lab();
  const shim = lab.shim();
  const reply = await shim.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 't', version: '1' },
  });
  const result = reply.result as Json;
  assertEquals(result.protocolVersion, '2025-06-18');
  assert('tools' in (result.capabilities as Json));
  assertEquals((result.serverInfo as Json).name, 'studio_artifact');
  assertEquals(((await shim.request('initialize', { protocolVersion: '2099-01-01' })).result as Json).protocolVersion, '2025-11-25');
  assertEquals(((await shim.request('initialize', { protocolVersion: '2024-11-05' })).result as Json).protocolVersion, '2024-11-05');
  await shim.send({ jsonrpc: '2.0', method: 'notifications/initialized' }); // no reply expected
  assertEquals((await shim.request('ping')).result, {});
  const tools = ((await shim.request('tools/list')).result as Json).tools as Json[];
  assertEquals(tools.map((t) => t.name), ['publish', 'update', 'list']);
  for (const tool of tools) {
    assertEquals((tool.inputSchema as Json).type, 'object');
    assert((tool.description as string).length > 40);
  }
  assertEquals((tools[0].inputSchema as Json).required, ['title']);
  assert((tools[0].description as string).includes('studio-artifact://<id>'));
  assert((tools[0].description as string).includes('source code'));
  for (const path of ['/_lib/mermaid.min.js', '/_lib/chart.umd.min.js', '/_lib/vega-embed.min.js', 'does not load offline']) {
    assert((tools[0].description as string).includes(path), path); // agents learn the bundled libraries here
  }
  assertEquals((tools[1].inputSchema as Json).required, ['id']);
});

Deno.test('unknown method, unknown tool and garbage', async () => {
  await using lab = new Lab();
  const shim = lab.shim();
  assertEquals(((await shim.request('nope')).error as Json).code, -32601);
  assertEquals(((await shim.request('tools/call', { name: 'zzz', arguments: {} })).error as Json).code, -32602);
  await shim.sendRaw('this is not json\n');
  assertEquals((JSON.parse(await shim.line()).error as Json).code, -32700);
  assertEquals((await shim.request('ping')).result, {}); // still alive
});

Deno.test('publish content', async () => {
  await using lab = new Lab();
  const result = await lab.shim().call('publish', { title: 'Drop rates', content: '<h1>x</h1>', filename: 'drops.html' });
  assert(!('isError' in result));
  const [sentence, data] = payload(result);
  assertEquals(data, { id: 'abc123', version: 1, link: 'studio-artifact://abc123', url: 'http://127.0.0.1:9/a/abc123/v1/x.html' });
  assert(sentence.includes('[Drop rates](studio-artifact://abc123)'));
  const request = lab.fake.requests.at(-1)!;
  assertEquals([request.method, request.path, request.key], ['POST', '/api/live/artifacts/publish', 'k1']);
  assertEquals(request.body, { conversationId: 'conv1', title: 'Drop rates', content: '<h1>x</h1>', filename: 'drops.html' });
});

Deno.test('publish: a relative path is resolved against the session folder', async () => {
  await using lab = new Lab();
  Deno.mkdirSync(`${lab.dir}${SEP}outputs`);
  const page = `${lab.dir}${SEP}outputs${SEP}page.html`;
  Deno.writeTextFileSync(page, '<p>hi</p>');
  const result = await lab.shim().call('publish', { title: 'Page', path: 'outputs/../outputs/page.html', kind: 'html' });
  assert(!('isError' in result));
  const sent = lab.fake.requests.at(-1)!.body as Json;
  assertEquals(sent.path, page);
  assertEquals(sent.kind, 'html');
  assert(!('content' in sent));
});

Deno.test('update and list', async () => {
  await using lab = new Lab();
  const shim = lab.shim();
  let [, data] = payload(await shim.call('update', { id: 'abc123', content: 'new', note: 'fixed colours' }));
  assertEquals(data, { id: 'abc123', version: 2, link: 'studio-artifact://abc123' });
  assertEquals(lab.fake.requests.at(-1)!.body, { conversationId: 'conv1', id: 'abc123', content: 'new', note: 'fixed colours' });
  [, data] = payload(await shim.call('list', {}));
  assertEquals(data, [{ id: 'abc123', title: 'T', kind: 'html', version: 3, link: 'studio-artifact://abc123' }]);
  const request = lab.fake.requests.at(-1)!;
  assertEquals([request.method, request.path, request.key], ['GET', '/api/live/artifacts?conversationId=conv1', 'k1']);
});

const ARGUMENT_CASES: [string, unknown][] = [
  ['publish', {}],
  ['publish', { title: 'x' }],
  ['publish', { title: 'x', path: 'a', content: 'b' }],
  ['publish', { title: 'x', path: 'missing.html' }],
  ['publish', { title: 'x', content: 'c', kind: 'exe' }],
  ['publish', { title: 'x', content: 5 }],
  ['update', { content: 'c' }],
  ['update', { id: 'a' }],
  ['publish', 'nonsense'],
];

Deno.test('argument errors become tool errors and send nothing', async () => {
  await using lab = new Lab();
  const shim = lab.shim();
  for (const [name, args] of ARGUMENT_CASES) {
    const result = await shim.call(name, args);
    assert(result.isError, JSON.stringify([name, args]));
    assert(firstText(result));
  }
  assertEquals(lab.fake.requests.length, 0);
  assert(firstText(await shim.call('publish', { title: 'x', path: 'missing.html' })).includes('File not found'));
});

Deno.test('Studio HTTP errors become tool errors', async () => {
  await using lab = new Lab();
  const shim = lab.shim();
  lab.fake.reply = [403, { error: 'Artifact key not valid for this conversation' }];
  let result = await shim.call('list', {});
  assert(result.isError);
  assert(firstText(result).includes('403') && firstText(result).includes('not valid'));
  lab.fake.reply = [400, { error: 'Path must be inside the project folder' }];
  result = await shim.call('publish', { title: 'x', content: 'y', filename: 'a.html' });
  assert(result.isError && firstText(result).includes('inside the project'));
  lab.fake.reply = [500, {}];
  assert((await shim.call('list', {})).isError);
  assertEquals((await shim.request('ping')).result, {});
});

Deno.test('unreachable Studio and missing configuration', async () => {
  await using lab = new Lab();
  const dead = lab.shim(lab.hangUp().url);
  const result = await dead.call('list', {});
  assert(result.isError && firstText(result).includes('Could not reach AIB'), firstText(result));
  const unconfigured = lab.shim('', {}, '', '');
  assert((await unconfigured.call('list', {})).isError);
});

Deno.test('the URL file is used when the URL is empty or stale', async () => {
  await using lab = new Lab();
  const urlFile = `${lab.dir}${SEP}artifact-web.json`;
  Deno.writeTextFileSync(urlFile, JSON.stringify({ url: lab.fake.url }));
  const hangUp = lab.hangUp();
  for (const envUrl of ['', hangUp.url]) {
    const result = await lab.shim(envUrl, { STUDIO_ARTIFACT_URL_FILE: urlFile }).call('list', {});
    assert(!('isError' in result), envUrl);
  }
});

Deno.test('a non-loopback URL is never called', async () => {
  await using lab = new Lab();
  const port = new URL(lab.fake.url).port;
  for (
    const url of [`http://127.0.0.1:${port}/x`, `http://user@127.0.0.1:${port}`, `https://127.0.0.1:${port}`, `http://127.0.0.2:${port}`]
  ) {
    const result = await lab.shim(url).call('list', {});
    assert(result.isError && firstText(result).includes('did not tell'), url);
  }
  assertEquals(lab.fake.requests.length, 0);
});

Deno.test('worktree tools are offered only to a worktree chat', async () => {
  await using lab = new Lab();
  const plain = lab.shim();
  assertEquals((((await plain.request('tools/list')).result as Json).tools as Json[]).length, 3);
  assertEquals(((await plain.request('tools/call', { name: 'merge_into_project', arguments: {} })).error as Json).code, -32602);
  const shim = lab.shim(lab.fake.url, { STUDIO_WORKTREE: '1' });
  const names = (((await shim.request('tools/list')).result as Json).tools as Json[]).map((t) => t.name);
  assertEquals(names, ['publish', 'update', 'list', 'merge_into_project', 'resolve_edit_clash']);
  const merged = await shim.call('merge_into_project', {});
  assertEquals(firstText(merged), 'Merged 2 commits into main. Your copy now continues from the new main.\nTell the user.');
  assertEquals(lab.fake.requests.at(-1)!.body, { conversationId: 'conv1', action: 'merge' });
  lab.fake.reply = [409, { error: 'The chat is busy' }];
  const refused = await shim.call('merge_into_project', {});
  assertEquals([refused.isError, firstText(refused)], [true, 'Not merged: The chat is busy']);
  assert((await shim.call('resolve_edit_clash', { action: 'nope' })).isError);
});

// ---- differential: the Python server and the Deno server answer the same lines identically ------------------------------------

/** One script of raw stdin lines; `before` runs before a line is sent (e.g. to change the fake's reply). */
type Step = { line: string; before?: (fake: FakeStudio) => void; noReply?: boolean };

function rpc(id: unknown, method: unknown, params?: unknown): string {
  return JSON.stringify(params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params });
}
const call = (id: number, name: unknown, args?: unknown) =>
  rpc(id, 'tools/call', args === undefined ? { name } : { name, arguments: args });

function script(): Step[] {
  let n = 0;
  const steps: Step[] = [
    { line: rpc(++n, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} }) },
    { line: rpc(++n, 'initialize', { protocolVersion: '2099-01-01' }) },
    { line: rpc(++n, 'initialize', { protocolVersion: ['2024-11-05'] }) },
    { line: rpc(++n, 'initialize', 'not a dict') },
    { line: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), noReply: true },
    { line: JSON.stringify({ jsonrpc: '2.0', id: 77, result: {} }), noReply: true },
    { line: rpc(++n, 'ping') },
    { line: rpc(null, 'ping') },
    { line: rpc(++n, 'tools/list') },
    { line: rpc(++n, 'nope') },
    { line: rpc(++n, 5) },
    { line: rpc(++n, false) },
    { line: call(++n, 'zzz', {}) },
    { line: call(++n, null, {}) },
    { line: call(++n, 1.5, {}) },
    { line: call(++n, ['publish'], {}) },
    { line: call(++n, { a: 1 }, {}) },
    { line: 'this is not json' },
    { line: '﻿' + rpc(++n, 'ping') },
    { line: '   ', noReply: true },
    { line: '[1, 2]' },
    { line: '5' },
    { line: '"text"' },
    { line: 'null' },
    { line: '  ' + rpc(++n, 'ping') + '  \r' },
    { line: call(++n, 'publish', { title: 'Drop rates', content: '<h1>x</h1>', filename: 'drops.html' }) },
    { line: call(++n, 'publish', { title: '  Ünïcødé ✓ 🙂  ', content: '<p>é</p>', filename: 'u.html', kind: 'html' }) },
    { line: call(++n, 'publish', { title: 'Page', path: 'outputs/../outputs/page.html', kind: 'html' }) },
    { line: call(++n, 'publish', { title: 'Page', path: '  outputs\\page.html ', filename: '' }) },
    { line: call(++n, 'publish', { title: 'Page', path: 'outputs' }) },
    { line: call(++n, 'publish', { title: 'Page', path: 0 }) },
    { line: call(++n, 'publish', { title: 'Page', path: '', content: 'x' }) },
    { line: call(++n, 'publish', { title: 'Page', content: null, path: null }) },
    { line: call(++n, 'publish', { title: 'x', content: 'c', filename: 7 }) },
    { line: call(++n, 'publish', { title: '   ', content: 'c' }) },
    { line: call(++n, 'update', { id: 'abc123', content: 'new', note: 'fixed colours' }) },
    { line: call(++n, 'update', { id: 'abc123', content: 'new', note: '' }) },
    { line: call(++n, 'list', {}) },
    { line: call(++n, 'list') },
    { line: call(++n, 'list', [1]) },
    ...ARGUMENT_CASES.map(([name, args]) => ({ line: call(++n, name, args) })),
    { line: call(++n, 'list', {}), before: (f) => (f.reply = [403, { error: 'Artifact key not valid for this conversation' }]) },
    { line: call(++n, 'list', {}), before: (f) => (f.reply = [401, {}]) },
    { line: call(++n, 'list', {}), before: (f) => (f.reply = [401, { error: '' }]) },
    { line: call(++n, 'publish', { title: 'x', content: 'y' }), before: (f) => (f.reply = [400, { error: 'Path must be inside' }]) },
    { line: call(++n, 'list', {}), before: (f) => (f.reply = [500, {}]) },
    { line: call(++n, 'list', {}), before: (f) => (f.reply = [500, ['not', 'a', 'dict']]) },
    { line: call(++n, 'list', {}), before: (f) => (f.reply = [404, { error: { nested: true } }]) },
    { line: call(++n, 'list', {}), before: (f) => (f.reply = [302, {}, { Location: 'http://example.com/' }]) },
    { line: call(++n, 'list', {}), before: (f) => (f.reply = [200, ['a list']]) },
    { line: call(++n, 'list', {}), before: (f) => (f.reply = [200, { artifacts: 5 }]) },
    { line: call(++n, 'list', {}), before: (f) => (f.reply = [200, { artifacts: 'abc' }]) },
    { line: call(++n, 'list', {}), before: (f) => (f.reply = [200, { artifacts: [{ id: 'x' }, 'skip', { title: 'é' }] }]) },
    { line: call(++n, 'list', {}), before: (f) => (f.reply = [200, { artifacts: [] }]) },
    { line: call(++n, 'publish', { title: 'x', content: 'y' }), before: (f) => (f.reply = [200, { id: 7, version: 2.5 }]) },
    { line: call(++n, 'update', { id: 'q', content: 'y' }), before: (f) => (f.reply = [200, { title: '', link: null }]) },
    {
      line: call(++n, 'list', {}),
      before: (f) => {
        f.reply = [200, 'not json'];
        f.raw = true;
      },
    },
    {
      line: call(++n, 'list', {}),
      before: (f) => {
        f.reply = [200, ''];
        f.raw = true;
      },
    },
    {
      line: call(++n, 'list', {}),
      before: (f) => {
        f.reply = [503, 'Service down'];
        f.raw = true;
      },
    },
    {
      line: call(++n, 'merge_into_project', {}),
      before: (f) => {
        f.reply = null;
        f.raw = false;
      },
    },
    {
      line: call(++n, 'merge_into_project', {}),
      before: (f) => (f.reply = [200, { state: 'conflicts', message: 'Resolve a.txt first.' }]),
    },
    { line: call(++n, 'merge_into_project', {}), before: (f) => (f.reply = [200, { state: 'conflicts' }]) },
    { line: call(++n, 'merge_into_project', {}), before: (f) => (f.reply = [409, { error: 'The chat is busy' }]) },
    { line: call(++n, 'merge_into_project', {}), before: (f) => (f.reply = [409, {}]) },
    { line: call(++n, 'merge_into_project', {}), before: (f) => (f.reply = [403, { error: 'no' }]) },
    { line: call(++n, 'resolve_edit_clash', { action: 'check' }), before: (f) => (f.reply = [200, { message: 'No markers left.' }]) },
    { line: call(++n, 'resolve_edit_clash', { action: 'leave' }), before: (f) => (f.reply = [200, {}]) },
    { line: call(++n, 'resolve_edit_clash', { action: 'keep_mine' }), before: (f) => (f.reply = [400, { error: 'Nothing to keep' }]) },
    { line: call(++n, 'resolve_edit_clash', { action: 'nope' }) },
    { line: call(++n, 'resolve_edit_clash', { action: ['check'] }) },
    { line: call(++n, 'resolve_edit_clash', {}) },
  ];
  return steps;
}

async function runScript(
  command: string[],
  dir: string,
  fake: FakeStudio,
  extraEnv: Record<string, string>,
): Promise<[string[], Recorded[]]> {
  fake.requests = [];
  fake.reply = null;
  fake.raw = false;
  const shim = new Shim(command, fake.url, dir, extraEnv);
  const lines: string[] = [];
  try {
    for (const step of script()) {
      step.before?.(fake);
      await shim.sendRaw(step.line + '\n');
      if (!step.noReply) lines.push(await shim.line());
    }
  } finally {
    await shim.close();
  }
  return [lines, fake.requests];
}

Deno.test('differential: artifact_mcp.py and the Deno server give the same replies and send the same requests', async () => {
  await using lab = new Lab();
  Deno.mkdirSync(`${lab.dir}${SEP}outputs`);
  Deno.writeTextFileSync(`${lab.dir}${SEP}outputs${SEP}page.html`, '<p>hi</p>');
  const env = { STUDIO_WORKTREE: '1' };
  const [pyLines, pyRequests] = await runScript(PY_TOOL, lab.dir, lab.fake, env);
  const [denoLines, denoRequests] = await runScript(DENO_TOOL, lab.dir, lab.fake, env);
  assertEquals(denoLines.length, pyLines.length);
  for (let i = 0; i < pyLines.length; i++) assertEquals(masked(denoLines[i]), pyLines[i], `reply ${i + 1}`);
  assertEquals(denoRequests, pyRequests);
  assert(pyRequests.length > 30, 'the script reached the fake Studio');
});

Deno.test('differential: tools/list without a worktree, unreachable Studio, URL file, missing configuration', async () => {
  await using lab = new Lab();
  const hangUp = lab.hangUp();
  const refused = (() => { // a port nothing listens on
    const l = Deno.listen({ hostname: '127.0.0.1', port: 0 });
    const port = (l.addr as Deno.NetAddr).port;
    l.close();
    return `http://127.0.0.1:${port}`;
  })();
  const urlFile = `${lab.dir}${SEP}artifact-web.json`;
  Deno.writeTextFileSync(urlFile, JSON.stringify({ url: lab.fake.url + '/' }));
  const badFile = `${lab.dir}${SEP}bad.json`;
  Deno.writeTextFileSync(badFile, '[1]');
  const cases: [string, Record<string, string>, string, string][] = [
    [lab.fake.url, {}, 'k1', 'conv1'],
    [hangUp.url, {}, 'k1', 'conv1'],
    [refused, {}, 'k1', 'conv1'],
    ['', { STUDIO_ARTIFACT_URL_FILE: urlFile }, 'k1', 'conv1'],
    [hangUp.url, { STUDIO_ARTIFACT_URL_FILE: urlFile }, 'k1', 'conv1'],
    ['', { STUDIO_ARTIFACT_URL_FILE: badFile }, 'k1', 'conv1'],
    ['', { STUDIO_ARTIFACT_URL_FILE: `${lab.dir}${SEP}missing.json` }, 'k1', 'conv1'],
    [` http://localhost:${new URL(lab.fake.url).port}/ `, {}, 'k1', 'conv1'],
    ['http://localhost:0', {}, 'k1', 'conv1'],
    ['http://localhost:65536', {}, 'k1', 'conv1'],
    [lab.fake.url, {}, '', 'conv1'],
    [lab.fake.url, {}, 'k1', ''],
  ];
  for (const [url, extra, key, conversation] of cases) {
    const replies: string[][] = [];
    for (const command of [PY_TOOL, DENO_TOOL]) {
      const shim = new Shim(command, url, lab.dir, extra, key, conversation);
      try {
        await shim.sendRaw(rpc(1, 'tools/list') + '\n' + call(2, 'list', {}) + '\n');
        replies.push([await shim.line(), await shim.line()]);
      } finally {
        await shim.close();
      }
    }
    assertEquals(replies[1].map(masked), replies[0], JSON.stringify([url, extra, key, conversation]));
  }
});

// ---- InjectionTests: the mcpServers entry the Deno Studio gives agents -------------------------------------------------------

class StudioLab {
  readonly dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-mcp-studio-' }));
  readonly studios: Studio[] = [];
  make(extra: Record<string, unknown> = {}): Studio {
    const studio = new Studio({ ompCommand: 'unused', stateDir: `${this.dir}${SEP}state`, port: 8123, ...extra } as never);
    this.studios.push(studio);
    return studio;
  }
  async [Symbol.asyncDispose]() {
    for (const s of this.studios) await s.close().catch(() => {});
    artifactKeys.configure(null);
    for (let i = 0; i < 20; i++) {
      try {
        Deno.removeSync(this.dir, { recursive: true });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }
}

const envOf = (entry: Json) => Object.fromEntries((entry.env as { name: string; value: string }[]).map((e) => [e.name, e.value]));

Deno.test('the Deno Studio gives agents the Deno tool: entry shape and key', async () => {
  await using lab = new StudioLab();
  const studio = lab.make();
  const servers = studio.artifactMcpServers('conv-1') as unknown as Json[];
  assertEquals(servers.length, 1);
  const entry = servers[0];
  assertEquals(Object.keys(entry), ['name', 'command', 'args', 'env']);
  assertEquals(entry.name, 'studio_artifact');
  assertEquals(entry.command, Deno.execPath());
  assertEquals(entry.args, ['run', '-A', '--quiet', MAIN, 'mcp-artifact']);
  assertEquals(artifactToolCommand(), { command: Deno.execPath(), args: ['run', '-A', '--quiet', MAIN, 'mcp-artifact'] });
  const env = envOf(entry);
  assertEquals(Object.keys(env), ['STUDIO_ARTIFACT_URL', 'STUDIO_ARTIFACT_URL_FILE', 'STUDIO_ARTIFACT_KEY', 'STUDIO_CONVERSATION_ID']);
  assertEquals(env.STUDIO_ARTIFACT_URL, 'http://127.0.0.1:8123');
  assertEquals(env.STUDIO_CONVERSATION_ID, 'conv-1');
  assert(env.STUDIO_ARTIFACT_URL_FILE.endsWith(ARTIFACT_URL_FILE));
  assert(artifactKeys.check(env.STUDIO_ARTIFACT_KEY, 'conv-1'));
  assert(!artifactKeys.check(env.STUDIO_ARTIFACT_KEY, 'conv-2'));
  assertEquals(validateMcpServers([entry])[0].name, 'studio_artifact'); // same shape --mcp-config entries have
  assertEquals(envOf((studio.artifactMcpServers('c', true) as unknown as Json[])[0]).STUDIO_WORKTREE, '1');
});

Deno.test('the injected entry runs: an agent starting it gets the studio_artifact server', async () => {
  await using lab = new Lab();
  await using studios = new StudioLab();
  const entry = (studios.make().artifactMcpServers('conv-1') as unknown as Json[])[0];
  const env = envOf(entry);
  const shim = lab.shim(lab.fake.url, {}, env.STUDIO_ARTIFACT_KEY, 'conv-1', [entry.command as string, ...(entry.args as string[])]);
  const result = (await shim.request('initialize', { protocolVersion: '2025-06-18' })).result as Json;
  assertEquals((result.serverInfo as Json).name, 'studio_artifact');
  assert(!('isError' in (await shim.call('list', {}))));
  assertEquals(lab.fake.requests.at(-1)!.key, env.STUDIO_ARTIFACT_KEY);
});

Deno.test('host URL provider wins and can fail; the tool can be turned off', async () => {
  await using lab = new StudioLab();
  const studio = lab.make();
  studio.artifactUrlProvider = () => 'http://127.0.0.1:9999';
  assertEquals(envOf((studio.artifactMcpServers('c') as unknown as Json[])[0]).STUDIO_ARTIFACT_URL, 'http://127.0.0.1:9999');
  studio.artifactUrlProvider = () => {
    throw new Error('boom');
  };
  assertEquals(envOf((studio.artifactMcpServers('c') as unknown as Json[])[0]).STUDIO_ARTIFACT_URL, 'http://127.0.0.1:8123');
  assertEquals(lab.make({ noArtifactTool: true }).artifactMcpServers('c'), []);
});

// ---- test_artifact_prompt.py: the system prompt goes only with Studio's own tool ----------------------------------------------

const ADVERTISED = { agentCapabilities: { sessionCapabilities: { systemPrompt: { mode: { override: {} } } } } };

function connection(initial: unknown): Connection {
  const c = new Connection([`${TESTS_DIR}${SEP}combined-fixture${SEP}agent.py`], Deno.cwd(), 'omp', { start: false } as never);
  c.initial = initial;
  return c;
}

Deno.test("artifact prompt: sent when Studio's own tool is given and the agent advertises system prompts", () => {
  const own = [{ name: 'studio_artifact', ...artifactToolCommand() }];
  const out = connection(ADVERTISED).artifactPrompt(own) as Json;
  assertEquals((out.systemPrompt as Json).mode, 'append');
  assertEquals(((out.systemPrompt as Json).content as Json[])[0].text, ARTIFACT_PROMPT);
  assert(ARTIFACT_PROMPT.includes('studio_artifact'));
});

Deno.test('artifact prompt: not sent otherwise', () => {
  const own = [{ name: 'studio_artifact', ...artifactToolCommand() }];
  assertEquals(connection({ agentCapabilities: {} }).artifactPrompt(own), {}); // agent does not support it
  assertEquals(connection(ADVERTISED).artifactPrompt([]), {}); // --no-artifact-tool
  for (
    const impostor of [
      { name: 'studio_artifact', command: 'node', args: ['x.js'] },
      { name: 'studio_artifact', command: 'node', args: artifactToolCommand().args },
      { name: 'studio_artifact', command: Deno.execPath(), args: ['run', '-A', 'evil.ts', 'mcp-artifact'] },
      { name: 'other', ...artifactToolCommand() },
    ]
  ) assertEquals(connection(ADVERTISED).artifactPrompt([impostor]), {}, JSON.stringify(impostor));
});

Deno.test("own studio_artifact permission requests: the Deno entry counts as Studio's own", () => {
  const c = connection(ADVERTISED);
  const ask = (name: string) => ({ toolCall: { toolCallId: 't', _meta: { claudeCode: { toolName: name } } } });
  c.mcpServers = [{ name: 'studio_artifact', ...artifactToolCommand(), env: [] }] as never;
  assert(c.ownArtifactTool(ask('mcp__studio_artifact__publish')));
  assert(!c.ownArtifactTool(ask('mcp__studio_artifact__delete')));
  c.mcpServers = [{ name: 'studio_artifact', command: 'node', args: ['x.js'], env: [] }] as never;
  assert(!c.ownArtifactTool(ask('mcp__studio_artifact__publish')));
});

// ---- the HTTP artifact tool (artifacts/mcp_http.ts): same replies as the stdio tool, and who may call it ---------------------------

/** An HTTP artifact server over the lab's fake Studio, keyed k1 / conv1, its conversation open in lab.dir (a worktree chat). */
function httpTool(lab: Lab, open: { cwd: string; worktree: boolean } | null = { cwd: lab.dir, worktree: true }): ArtifactMcpHttp {
  const server = new ArtifactMcpHttp({
    conversation: (id) => (id === 'conv1' ? open : null),
    baseUrl: () => lab.fake.url,
    urlFile: '',
    check: (key, id) => key === 'k1' && id === 'conv1',
  });
  server.start();
  lab.cleanups.push(() => server.close());
  return server;
}

function post(url: string, body: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    body,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      [KEY_HEADER]: 'k1',
      [CONVERSATION_HEADER]: 'conv1',
      ...headers,
    },
  });
}

async function statusOf(response: Promise<Response>): Promise<number> {
  const r = await response;
  await r.body?.cancel();
  return r.status;
}

Deno.test('HTTP tool: the stdio script gets the same replies and Studio gets the same requests', async () => {
  await using lab = new Lab();
  Deno.mkdirSync(`${lab.dir}${SEP}outputs`);
  Deno.writeTextFileSync(`${lab.dir}${SEP}outputs${SEP}page.html`, '<p>hi</p>');
  const [stdioLines, stdioRequests] = await runScript(DENO_TOOL, lab.dir, lab.fake, { STUDIO_WORKTREE: '1' });
  const server = httpTool(lab);
  lab.fake.requests = [];
  lab.fake.reply = null;
  lab.fake.raw = false;
  const lines: string[] = [];
  for (const step of script()) {
    step.before?.(lab.fake);
    const response = await post(server.url, step.line);
    const text = await response.text();
    if (step.noReply) {
      assert([202, 400].includes(response.status), `${response.status} for ${JSON.stringify(step.line)}`);
      if (response.status === 202) assertEquals(text, '');
      continue;
    }
    assertEquals(response.status, 200, step.line);
    assertEquals(response.headers.get('content-type'), 'application/json');
    lines.push(text);
  }
  assertEquals(lines.length, stdioLines.length);
  for (let i = 0; i < lines.length; i++) assertEquals(lines[i], stdioLines[i], `reply ${i + 1}`);
  assertEquals(lab.fake.requests, stdioRequests);
});

Deno.test('HTTP tool: initialize, tools/list without a worktree, relative paths need an open conversation', async () => {
  await using lab = new Lab();
  const plain = httpTool(lab, { cwd: lab.dir, worktree: false });
  const init = await (await post(plain.url, rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} }))).json();
  assertEquals([init.result.protocolVersion, init.result.serverInfo.name], ['2025-06-18', 'studio_artifact']);
  const notified = await post(plain.url, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  assertEquals([notified.status, await notified.text()], [202, '']);
  const tools = (await (await post(plain.url, rpc(2, 'tools/list'))).json()).result.tools as Json[];
  assertEquals(tools.map((t) => t.name), ['publish', 'update', 'list']);
  const closed = httpTool(lab, null); // the conversation is not open here: no session folder, no worktree tools
  const listed = (await (await post(closed.url, rpc(3, 'tools/list'))).json()).result.tools as Json[];
  assertEquals(listed.length, 3);
  const relative = (await (await post(closed.url, call(4, 'publish', { title: 'x', path: 'page.html' }))).json()).result;
  assertEquals(relative.isError, true);
  assert(firstText(relative).includes('absolute'), firstText(relative));
  assertEquals(lab.fake.requests.length, 0);
});

Deno.test('HTTP tool: refuses callers without the key, browsers, other hosts, other methods and paths', async () => {
  await using lab = new Lab();
  const server = httpTool(lab);
  const list = call(1, 'list', {});
  assertEquals(await statusOf(post(server.url, list, { [KEY_HEADER]: 'wrong' })), 401);
  assertEquals(await statusOf(post(server.url, list, { [KEY_HEADER]: '' })), 401);
  assertEquals(await statusOf(post(server.url, list, { [CONVERSATION_HEADER]: 'conv2' })), 401); // a key only works for its chat
  assertEquals(await statusOf(post(server.url, list, { [CONVERSATION_HEADER]: '' })), 401);
  assertEquals(await statusOf(post(server.url, list, { Origin: `http://127.0.0.1:${server.port}` })), 403); // even same-origin
  assertEquals(await statusOf(post(server.url, list, { Origin: 'null' })), 403); // the sandboxed artifact frame
  assertEquals(await statusOf(post(server.url, list, { 'Sec-Fetch-Site': 'same-site' })), 403);
  assertEquals(await statusOf(post(server.url, list, { 'Content-Type': 'text/plain' })), 415); // no CORS-simple requests
  assertEquals(await statusOf(post(server.url.replace('/mcp', '/other'), list)), 404);
  assertEquals(await statusOf(post(server.url, '   ')), 400);
  for (const method of ['GET', 'DELETE', 'PUT', 'OPTIONS']) {
    const r = await fetch(server.url, { method, headers: { [KEY_HEADER]: 'k1', [CONVERSATION_HEADER]: 'conv1' } });
    await r.body?.cancel();
    assertEquals(r.status, 405, method);
    assertEquals(r.headers.get('allow'), 'POST');
  }
  // Host and peer, through handle(): DNS rebinding (another Host) and a non-loopback peer are refused.
  const make = (host: string) =>
    new Request(server.url, {
      method: 'POST',
      body: list,
      headers: { Host: host, 'Content-Type': 'application/json', [KEY_HEADER]: 'k1', [CONVERSATION_HEADER]: 'conv1' },
    });
  const loopback = { remoteAddr: { hostname: '127.0.0.1' } };
  assertEquals((await server.handle(make(`evil.example:${server.port}`), loopback)).status, 403);
  assertEquals((await server.handle(make(`127.0.0.1:${server.port + 1}`), loopback)).status, 403);
  assertEquals((await server.handle(make(`127.0.0.1:${server.port}`), { remoteAddr: { hostname: '192.168.1.5' } })).status, 403);
  const accepted = await server.handle(make(`localhost:${server.port}`), loopback);
  await accepted.body?.cancel();
  assertEquals(accepted.status, 200);
  assertEquals(lab.fake.requests.length, 1); // only the accepted call reached Studio
});

Deno.test('HTTP tool: the real per-conversation key from artifacts/keys.ts is required', async () => {
  await using lab = new Lab();
  await using studios = new StudioLab();
  const studio = studios.make({ artifactTransport: 'http' });
  studio.artifactUrlProvider = () => lab.fake.url;
  const [entry, fallback] = studio.artifactMcpServers('conv-1') as unknown as Json[];
  const headers = Object.fromEntries((entry.headers as { name: string; value: string }[]).map((h) => [h.name, h.value]));
  const ok = await post(entry.url as string, call(1, 'list', {}), headers);
  assertEquals(ok.status, 200);
  assert(!('isError' in (await ok.json()).result));
  assertEquals(lab.fake.requests.at(-1)!.key, headers[KEY_HEADER]);
  assertEquals(await statusOf(post(entry.url as string, call(2, 'list', {}), { ...headers, [CONVERSATION_HEADER]: 'conv-2' })), 401);
  assertEquals(fallback.name, 'studio_artifact');
  assertEquals(fallback.command, artifactToolCommand().command);
});

Deno.test('built-binary Studio: an http entry first, the stdio entry as fallback; agents get the one they support', async () => {
  await using studios = new StudioLab();
  const studio = studios.make({ artifactTransport: 'http' });
  assertEquals(studio.artifactTransport(), 'http');
  assertEquals(studios.make().artifactTransport(), 'stdio'); // deno run (these tests): stdio, like the Python Studio
  const servers = studio.artifactMcpServers('conv-1', true) as unknown as Json[];
  assertEquals(servers.map((s) => s.type ?? 'stdio'), ['http', 'stdio']);
  const entry = servers[0];
  assertEquals(Object.keys(entry), ['type', 'name', 'url', 'headers']);
  assert(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(entry.url as string), entry.url as string);
  assertEquals(validateMcpServers([entry])[0], entry as never); // the ACP McpServerHttp shape
  const headers = Object.fromEntries((entry.headers as { name: string; value: string }[]).map((h) => [h.name, h.value]));
  assertEquals(headers[CONVERSATION_HEADER], 'conv-1');
  assert(artifactKeys.check(headers[KEY_HEADER], 'conv-1'));
  assertEquals(envOf(servers[1]).STUDIO_WORKTREE, '1');
  assertEquals((studio.artifactMcpServers('conv-2') as unknown as Json[])[0].url, entry.url); // one server per Studio
  const kinds = (list: unknown) => (list as Json[]).map((s) => s.type ?? 'stdio');
  let [given, skipped] = selectMcpServers(servers as never, { agentCapabilities: { mcpCapabilities: { http: true } } });
  assertEquals([kinds(given), skipped], [['http'], []]);
  [given, skipped] = selectMcpServers(servers as never, { agentCapabilities: {} });
  assertEquals([kinds(given), skipped], [['stdio'], []]);
  const user = { type: 'http', name: 'remote', url: 'https://example.com/mcp', headers: [] };
  [, skipped] = selectMcpServers([user, ...servers] as never, { agentCapabilities: {} });
  assertEquals(skipped, ['remote']);
  // Studio's own http entry gets the artifact prompt and the own-tool permission rule; another http server of that name does not.
  assert('systemPrompt' in (connection(ADVERTISED).artifactPrompt([entry]) as Json));
  assertEquals(connection(ADVERTISED).artifactPrompt([{ ...entry, url: 'http://127.0.0.1:1/mcp' }]), {});
  const c = connection(ADVERTISED);
  c.mcpServers = [entry] as never;
  assert(c.ownArtifactTool({ toolCall: { toolCallId: 't', _meta: { claudeCode: { toolName: 'mcp__studio_artifact__publish' } } } }));
  await studio.close();
  const after = await fetch(entry.url as string, { method: 'POST', body: '{}' }).then(async (r) => {
    await r.body?.cancel();
    return 'answered';
  }, () => 'closed');
  assertEquals(after, 'closed'); // the listener stops with the Studio
});
