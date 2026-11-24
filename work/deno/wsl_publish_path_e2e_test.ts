/**
 * Real WSL (AIB_WSL_E2E=<distro>; see _wsl_e2e.ts): publish by `path` from a WSL chat (wsl/artifact_read.ts; WSL.md "Publish a file
 * from the distro").
 *   - An agent inside the distro calls `publish` with a relative Linux path through its real `studio_artifact` entry (the tunnel:
 *     forwarder, relay, helper channel, AIB's MCP endpoint, the tool's HTTP call). The HTTP call lands on a small stand-in for AIB's
 *     /api/live/artifacts/publish that runs the route's real WSL step (attachWslFile: the chat's folder from the live Studio, its
 *     project folder from the helper's worktree registry, the bytes through the real helper's files.readBytes) and the real
 *     artifacts Service. A real 3 MB PNG (uncompressed, so over three helper pieces) arrives byte-identical, as an image.
 *   - Publishing it again makes no new version; after the file changes in the distro, `update` with the path makes version 2.
 *   - Refusals from the real distro: a symlink out of the project (the realpath check in the distro), `..` out, a folder, a file
 *     that is not there; each one line with the Linux path, as the agent's tool result.
 * Everything is inside AIB_WSL_ROOT=/tmp/aib-wsl-test-<random>; the fake agent is work/fake_acp.py; never the owner's homes.
 */
import { deflateSync } from 'node:zlib';
import { assert, assertEquals } from './_assert.ts';
import { cleanRoot, inDistro, KEY, prepareRoot, readyHost, ROOT, T, WSL_E2E } from './_wsl_e2e.ts';
import { Connection } from '../../app/server/acp/connection.ts';
import { Aib } from '../../app/server/host/aib.ts';
import { refOf } from '../../app/server/platform/location.ts';
import { ArtifactStore, Service } from '../../app/server/artifacts/artifacts.ts';
import { attachWslFile } from '../../app/server/web/aib_routes.ts';
import type { WebContext } from '../../app/server/web/server.ts';

type Json = Record<string, unknown>;
type Entry = { command: string; args: string[]; env: { name: string; value: string }[] };

const PROJECT = `${ROOT}/repo`;
const REF = WSL_E2E ? refOf({ kind: 'wsl', distro: KEY, linuxPath: PROJECT }) : '';

function studioIn(state: string): Aib {
  const studio = new Aib({ stateDir: state, port: 0, ownersDir: null }, { keeper: null });
  studio.ownerProbe = () => null;
  studio.connectionFactory = (_command, cwd, provider, options) =>
    new Connection(['python3', `${ROOT}/fake_acp.py`, '--cancel-aware'], cwd, provider, {
      ...options,
      wsl: options?.wsl ? { ...options.wsl, program: '/usr/bin/python3' } : options?.wsl,
    });
  return studio;
}

// ---- a real PNG ---------------------------------------------------------------------------------------------------------------
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
/** A valid width x height RGB PNG, stored without compression (so its size is about 3 bytes a pixel). */
function makePng(width: number, height: number, seed: number): Uint8Array {
  const raw = new Uint8Array((width * 3 + 1) * height);
  for (let y = 0, at = 0; y < height; y++) {
    raw[at++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      raw[at++] = (x + seed) & 0xff;
      raw[at++] = (y * 3 + seed) & 0xff;
      raw[at++] = (x ^ y) & 0xff;
    }
  }
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(raw, { level: 0 }))),
    chunk('IEND', new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) (out.set(p, at), at += p.length);
  return out;
}

/** Run the chat's MCP entry inside the distro as its agent would, with these messages; the answers by id. */
async function runEntry(entry: Entry, headers: string, messages: Json[]): Promise<{ answers: Map<number, Json>; err: string; code: number }> {
  const script = 'IFS= read -r h; export MCP_FORWARD_HEADERS="$h"; exec "$@"';
  const stdin = new TextEncoder().encode([headers, ...messages.map((m) => JSON.stringify(m))].join('\n') + '\n');
  const run = await inDistro(script, [entry.command, ...entry.args], stdin);
  const answers = new Map<number, Json>();
  for (const line of run.out.split('\n').filter((l) => l.trim())) {
    const msg = JSON.parse(line) as Json;
    answers.set(Number(msg.id), msg);
  }
  return { answers, err: run.err, code: run.code };
}

const INIT = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
];
const callMsg = (id: number, name: string, args: Json) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
function toolText(answer: Json | undefined): { text: string; isError: boolean } {
  const result = (answer?.result ?? {}) as { content?: { text: string }[]; isError?: boolean };
  if (!result.content) throw new Error(`no tool result: ${JSON.stringify(answer)}`);
  return { text: result.content[0].text, isError: !!result.isError };
}

Deno.test({
  name: 'wsl e2e publish by path: a 3 MB PNG from inside the distro arrives byte-identical through the real tunnel and helper; refusals',
  ...T,
  async fn() {
    const state = Deno.makeTempDirSync({ prefix: 'aib-wsl-publish-e2e-' });
    await prepareRoot();
    const store = new ArtifactStore(`${state}\\artifacts`);
    const service = new Service(store, () => 't', () => null, { rootFor: () => REF });
    const studios: Aib[] = [];
    let studio: Aib | null = null;
    const seen: Json[] = [];
    // AIB's /api/live/artifacts/publish for this test: the route's WSL step and the real Service (key checks are tested elsewhere)
    const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, async (request) => {
      const body = await request.json() as Json;
      seen.push({ path: new URL(request.url).pathname, file: body.path ?? null });
      const ctx = {
        artifacts: {
          service,
          chatStudio: () => studio!,
          connectionOf: (id: string) => id,
          projectRootOf: () => null,
        },
      } as unknown as WebContext;
      const refused = await attachWslFile(ctx, body);
      const [status, reply] = refused ?? service.handlePost({ headers: new Headers({ 'X-Studio-Token': 't' }) }, '/api/live/artifacts/publish', body);
      return Response.json(reply, { status });
    });
    try {
      const host = await readyHost();
      assert(host.mcpTunnel, 'the helper runs the tunnel');
      studio = studioIn(state);
      studios.push(studio);
      studio.artifactUrlProvider = () => `http://127.0.0.1:${server.addr.port}`;
      const c = await studio.connect('claude', REF);
      const entry = c.mcpServers[0] as unknown as Entry;
      const headers = entry.env.find((e) => e.name === 'MCP_FORWARD_HEADERS')!.value;

      // the PNG: in the project's main folder, untracked (a chat in its own copy reaches it there, as a local-only file)
      const data = makePng(1024, 1000, 5);
      assert(data.length > 3 * 1000 * 1000, `${data.length}`);
      const rel = 'aib-shared/review/leveldesign/dw26-family.png';
      const put = (bytes: Uint8Array) => inDistro('mkdir -p "$(dirname "$1")" && cat > "$1"', [`${PROJECT}/${rel}`], bytes);
      assertEquals((await put(data)).code, 0);
      const outside = await inDistro('mkdir -p "$1/outside" && printf secret > "$1/outside/s.png" && ln -s "$1/outside/s.png" "$2/link.png" && mkdir -p "$2/pics"', [ROOT, PROJECT]);
      assertEquals(outside.code, 0, outside.err);

      const run = await runEntry(entry, headers, [...INIT, callMsg(2, 'publish', { title: 'DW26 family', path: rel })]);
      assertEquals(run.code, 0, run.err);
      const published = toolText(run.answers.get(2));
      assertEquals(published.isError, false, published.text);
      const out = JSON.parse(published.text.slice(published.text.indexOf('\n') + 1)) as Json;
      const id = String(out.id);
      const manifest = store.get(id);
      assertEquals([manifest.kind, manifest.entry, manifest.versions.length, manifest.sourcePath], ['image', 'dw26-family.png', 1, null]);
      assertEquals(manifest.wslSource, refOf({ kind: 'wsl', distro: KEY, linuxPath: `${PROJECT}/${rel}` }));
      assertEquals(store.summary(manifest).wslSource, manifest.wslSource, 'the list entry carries the ref path links match');
      const got = Deno.readFileSync(store.versionFile(manifest, 1));
      assertEquals(got.length, data.length);
      assert(got.every((b, i) => b === data[i]), 'byte-identical');
      assertEquals(seen.at(-1), { path: '/api/live/artifacts/publish', file: rel }, 'only the path travelled through the tunnel');

      // again: no new version; changed in the distro: update with the path is version 2
      const again = await runEntry(entry, headers, [...INIT, callMsg(3, 'publish', { title: 'DW26 family', path: rel })]);
      assert(toolText(again.answers.get(3)).text.includes(`artifact ${id} (v1)`), toolText(again.answers.get(3)).text);
      const changed = makePng(1024, 1000, 77);
      assertEquals((await put(changed)).code, 0);
      const updated = await runEntry(entry, headers, [...INIT, callMsg(4, 'update', { id, path: rel, note: 'new colours' })]);
      assert(toolText(updated.answers.get(4)).text.includes('now v2'), toolText(updated.answers.get(4)).text);
      const v2 = Deno.readFileSync(store.versionFile(store.get(id), 2));
      assert(v2.length === changed.length && v2.every((b, i) => b === changed[i]), 'v2 is the changed file');

      // refusals from the real distro, as the agent reads them
      const where = c.cwd && c.cwd !== REF ? 'a chat in its own copy' : 'a chat in the project folder';
      const refusals: [Json, string][] = [
        [{ title: 'x', path: 'link.png' }, 'through a link'],
        [{ title: 'x', path: `${PROJECT}/../outside/s.png` }, `Refused: ${ROOT}/outside/s.png is outside`],
        [{ title: 'x', path: '/etc/hostname' }, 'Refused: /etc/hostname is outside'],
        [{ title: 'x', path: `${PROJECT}/pics` }, `${PROJECT}/pics is a folder, not a file`],
        [{ title: 'x', path: 'nope/none.png' }, 'File not found in'],
      ];
      for (const [i, [args, words]] of refusals.entries()) {
        const r = await runEntry(entry, headers, [...INIT, callMsg(10 + i, 'publish', args)]);
        const answer = toolText(r.answers.get(10 + i));
        assert(answer.isError && answer.text.includes(words) && !answer.text.includes('\n'), `${where}: ${answer.text}`);
      }
      const leaked = store.all().filter((m) => m.title === 'x');
      assertEquals(leaked.length, 0, 'nothing published by a refusal');
    } finally {
      for (const s of studios) await s.close().catch(() => {});
      await server.shutdown();
      await cleanRoot();
      Deno.removeSync(state, { recursive: true });
    }
  },
});
