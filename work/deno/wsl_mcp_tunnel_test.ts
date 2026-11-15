/**
 * The WSL MCP tunnel without a distro (docs/wsl/design.md sections 4, 6, 11): the helper's end (helper/mcp_tunnel.ts) against a fake
 * relay and against the real `AIB-keeper mcp-relay` with a real `mcp-forward --helper-socket` client (Go unix sockets work on Windows
 * too); AIB's end (wsl/mcp_tunnel.ts gate, mcp_http.ts tunneled); the one tool switchboard (mcp.ts WSL_TOOL_GROUPS) and the chat's
 * line worded from it. wsl_tunnel_e2e_test.ts runs the same chain inside a real distro.
 */
import { assert, assertEquals } from './_assert.ts';
import { ACK_MS, McpTunnel, type RelayProcess, spawnKeeperRelay } from '../../outputs/agent-studio/server/wsl/helper/mcp_tunnel.ts';
import { McpTunnelGate, MAX_REPLY } from '../../outputs/agent-studio/server/wsl/mcp_tunnel.ts';
import { ArtifactMcpHttp, isOwnForwardEntry, tunnelEntry } from '../../outputs/agent-studio/server/artifacts/mcp_http.ts';
import { WSL_TOOL_GROUPS } from '../../outputs/agent-studio/server/artifacts/mcp.ts';
import { WSL_TOOLS_NOTICE, wslToolsNotice } from '../../outputs/agent-studio/server/wsl/access.ts';
import { tunnelSocket } from '../../outputs/agent-studio/server/wsl/hosts.ts';
import { keeperBinary } from '../../outputs/agent-studio/server/keeper/client.ts';

type Json = Record<string, unknown>;

/** Wait for ok() (no _connection.ts: it marks the whole process as a test run, which other files' tests read). */
async function until(ok: () => boolean, what: string, seconds: number): Promise<void> {
  for (const end = Date.now() + seconds * 1000; !ok();) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const T = { sanitizeResources: false, sanitizeOps: false };

/** A relay that is just two queues: what the tunnel wrote (answers), and lines the test pushes (requests). */
class FakeRelay implements RelayProcess {
  readonly written: Json[] = [];
  #push: (() => void) | null = null;
  #queue: string[] = [];
  #end: () => void = () => {};
  readonly done = new Promise<void>((resolve) => (this.#end = resolve));
  readonly lines: AsyncIterable<string> = this.#lines();
  async *#lines(): AsyncGenerator<string> {
    for (;;) {
      while (this.#queue.length) yield this.#queue.shift()!;
      const more = await new Promise<boolean>((resolve) => {
        this.#push = () => resolve(true);
        void this.done.then(() => resolve(false));
      });
      this.#push = null;
      if (!more) return;
    }
  }
  send(msg: Json): void {
    this.#queue.push(JSON.stringify(msg));
    this.#push?.();
  }
  write(line: string): Promise<void> {
    this.written.push(JSON.parse(line));
    return Promise.resolve();
  }
  kill(): void {
    this.#end();
  }
}

function lab(options: { ackMs?: number; runMs?: number } = {}) {
  const relay = new FakeRelay();
  const notes: Json[] = [];
  const tunnel = new McpTunnel({
    socket: '/tmp/x/helper/mcp.sock',
    notify: (method, params) => notes.push({ method, ...params }),
    spawnRelay: () => relay,
    ...options,
  });
  return { relay, notes, tunnel, m: tunnel.methods() };
}

const req = (c: number, body = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}', headers: unknown = { 'X-Studio-Artifact-Key': 'k' }) => ({
  c,
  req: { headers, body },
});

Deno.test({
  name: 'helper tunnel: a request goes to AIB as mcp.request; accept, then the reply reaches the forwarder; a second accept is refused',
  ...T,
  async fn() {
    const { relay, notes, tunnel, m } = lab();
    const started = tunnel.start();
    relay.send({ ready: true, socket: '/tmp/x/helper/mcp.sock' });
    assertEquals(await started, '/tmp/x/helper/mcp.sock');
    relay.send(req(1));
    await until(() => notes.length === 1, 'the notification', 5);
    const rid = String(notes[0].rid);
    assertEquals([notes[0].method, (notes[0].headers as Json)['X-Studio-Artifact-Key']], ['mcp.request', 'k']);
    assertEquals(await m['mcp.accept']({ rid }), { ok: true });
    assertEquals(await m['mcp.accept']({ rid }), { ok: false }, 'taken once');
    assertEquals(await m['mcp.reply']({ rid, status: 200, body: '{"ok":1}' }), { ok: true });
    assertEquals(relay.written, [{ c: 1, res: { status: 200, body: '{"ok":1}' } }]);
    assertEquals(await m['mcp.reply']({ rid, status: 200, body: 'x' }), { ok: false }, 'answered once');
    tunnel.stop();
  },
});

Deno.test({
  name: 'helper tunnel: no accept in time answers "AIB is not running" and a late accept is refused; closed answers at once',
  ...T,
  async fn() {
    const { relay, notes, tunnel, m } = lab({ ackMs: 150 });
    const started = tunnel.start();
    relay.send({ ready: true, socket: '/s' });
    await started;
    relay.send(req(1));
    await until(() => relay.written.length === 1, 'the timeout answer', 5);
    const res = relay.written[0].res as Json;
    assertEquals(res.status, 503);
    assert(String(res.error).includes('AIB is not running'), String(res.error));
    assertEquals(await m['mcp.accept']({ rid: String(notes[0].rid) }), { ok: false }, 'never runs after the forwarder was told');
    // AIB quit on purpose: answered at once, nothing sent to AIB
    await m['mcp.closed']({ closed: true });
    relay.send(req(2));
    await until(() => relay.written.length === 2, 'the closed answer', 5);
    assert(String((relay.written[1].res as Json).error).includes('AIB is closed'));
    assertEquals(notes.length, 1);
    tunnel.touch(); // any call from a new AIB
    relay.send(req(3));
    await until(() => notes.length === 2, 'sent again once an AIB talks to the helper', 5);
    assert(ACK_MS >= 10_000, 'the real wait matches the forwarder\'s 15 s retry');
    tunnel.stop();
  },
});

Deno.test({
  name: 'helper tunnel: a forwarder gone before accept is never run; after accept its reply is dropped; a run past its limit is answered',
  ...T,
  async fn() {
    const { relay, notes, tunnel, m } = lab({ runMs: 150 });
    const started = tunnel.start();
    relay.send({ ready: true, socket: '/s' });
    await started;
    relay.send(req(1));
    await until(() => notes.length === 1, 'first', 5);
    relay.send({ c: 1, gone: true });
    await new Promise((r) => setTimeout(r, 50));
    assertEquals(await m['mcp.accept']({ rid: String(notes[0].rid) }), { ok: false });
    relay.send(req(2));
    await until(() => notes.length === 2, 'second', 5);
    assertEquals(await m['mcp.accept']({ rid: String(notes[1].rid) }), { ok: true });
    relay.send({ c: 2, gone: true });
    await new Promise((r) => setTimeout(r, 50));
    assertEquals(await m['mcp.reply']({ rid: String(notes[1].rid), status: 200, body: 'x' }), { ok: true });
    assertEquals(relay.written, [], 'nobody to answer');
    relay.send(req(3));
    await until(() => notes.length === 3, 'third', 5);
    await m['mcp.accept']({ rid: String(notes[2].rid) });
    await until(() => relay.written.length === 1, 'the run limit', 5);
    assertEquals((relay.written[0].res as Json).status, 504);
    // shapes the helper refuses itself
    relay.send(req(4, '{}', { k: 1 }));
    relay.send(req(5, '   '));
    await until(() => relay.written.length === 3, `refusals (${JSON.stringify(relay.written)})`, 5);
    assertEquals(relay.written.slice(1).map((w) => (w.res as Json).status), [400, 400]);
    tunnel.stop();
  },
});

Deno.test({
  name: 'AIB gate: accept, serve with the key and conversation (any header case), reply; no server: 503 without accept; huge answer: an error',
  ...T,
  async fn() {
    const calls: [string, Json][] = [];
    let accept = true;
    const host = {
      distro: 'Ubuntu',
      call: (method: string, params: Json) => {
        calls.push([method, params]);
        return Promise.resolve(method === 'mcp.accept' ? { ok: accept } : { ok: true });
      },
    } as never;
    const gate = new McpTunnelGate();
    await gate.handle(host, { rid: 'a', headers: {}, body: '{}' });
    assertEquals(calls.map((c) => c[0]), ['mcp.reply']);
    assertEquals([calls[0][1].status, typeof calls[0][1].error], [503, 'string']);
    calls.length = 0;
    const seen: Json[] = [];
    const unset = gate.set((r) => (seen.push(r), Promise.resolve({ status: 200, body: '{"ok":true}' })));
    await gate.handle(host, { rid: 'b', headers: { 'x-studio-artifact-key': 'K', 'X-STUDIO-CONVERSATION-ID': 'C' }, body: '{"id":1}' });
    assertEquals(calls.map((c) => c[0]), ['mcp.accept', 'mcp.reply']);
    assertEquals(seen[0], { distro: 'Ubuntu', key: 'K', conversation: 'C', body: '{"id":1}' });
    assertEquals(calls[1][1], { rid: 'b', status: 200, body: '{"ok":true}' });
    accept = false;
    calls.length = 0;
    await gate.handle(host, { rid: 'c', headers: {}, body: '{}' });
    assertEquals(calls.map((c) => c[0]), ['mcp.accept'], 'the helper gave up on it: not run, not answered');
    assertEquals(seen.length, 1);
    accept = true;
    unset();
    gate.set(() => Promise.resolve({ status: 200, body: 'x'.repeat(MAX_REPLY + 1) }));
    calls.length = 0;
    await gate.handle(host, { rid: 'd', headers: {}, body: '{"jsonrpc":"2.0","id":9}' });
    const big = JSON.parse(String(calls[1][1].body));
    assertEquals(big.id, 9);
    assert(String(big.error.message).includes('larger than the WSL tunnel'));
  },
});

Deno.test({
  name: 'mcp_http tunneled: the key check and reply of a POST; the tunnel entry is Studio\'s own forwarder entry',
  ...T,
  async fn() {
    const server = new ArtifactMcpHttp({
      conversation: (id) => (id === 'c1' ? { cwd: '/x', worktree: false, restricted: true } : null),
      baseUrl: () => '',
      urlFile: '',
      check: (key, conversation) => key === 'good' && conversation === 'c1',
    });
    const list = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const refused = await server.tunneled('bad', 'c1', list);
    assertEquals(refused.status, 401);
    assert(refused.body.includes('refused the artifact key'));
    const ok = await server.tunneled('good', 'c1', list);
    assertEquals(ok.status, 200);
    const names = ((JSON.parse(ok.body).result as Json).tools as Json[]).map((t) => t.name);
    assertEquals(names.slice(0, 4), ['publish', 'update', 'list', 'archive']);
    for (const name of ['doc_create', 'doc_list', 'doc_read', 'doc_edit', 'doc_history', 'drawing_create']) assert(names.includes(name), name);
    assert(!names.includes('start_helper') && !names.includes('merge_into_project'), 'no swarm tools; merge only in its own copy');
    assertEquals(await server.tunneled('good', 'c1', '{"jsonrpc":"2.0","method":"notifications/initialized"}'), { status: 202, body: '' });
    const entry = tunnelEntry('/r/v/AIB-keeper', '/r/data-x/helper/mcp.sock', 'good', 'c1');
    assert(isOwnForwardEntry(entry.command, entry.args as string[]));
    assert(!isOwnForwardEntry('/r/v/AIB-keeper', ['mcp-forward', '--helper-socket', '/elsewhere.sock']));
    await server.close();
  },
});

Deno.test('wsl tools: the chat line is worded from WSL_TOOL_GROUPS; the ready line\'s socket must be a plain absolute path', () => {
  assertEquals(
    wslToolsNotice(),
    "In WSL projects, AIB tools cover artifacts (publish and update by content only: no file paths, so no PNG or other binary files yet; list, archive), docs and merging a chat's own copy; helper chats are not available yet.",
  );
  assertEquals(wslToolsNotice({ ...WSL_TOOL_GROUPS, swarm: true }).endsWith("merging a chat's own copy and helper chats."), true);
  assertEquals(
    wslToolsNotice({ ...WSL_TOOL_GROUPS, merge: false, swarm: true }),
    "In WSL projects, AIB tools cover artifacts (publish and update by content only: no file paths, so no PNG or other binary files yet; list, archive), docs and helper chats; merging a chat's own copy is not available yet.",
  );
  assertEquals(wslToolsNotice({ artifacts: false, merge: false, swarm: false, docs: false }), WSL_TOOLS_NOTICE);
  assertEquals([WSL_TOOL_GROUPS.docs, WSL_TOOL_GROUPS.swarm], [true, false], 'docs work in WSL projects; helper chats stay off until they do');
  assertEquals(tunnelSocket({ socket: '/home/u/.aib-server/data-1/helper/mcp.sock' }), '/home/u/.aib-server/data-1/helper/mcp.sock');
  for (const bad of [null, {}, { socket: 'rel/mcp.sock' }, { socket: '/a\nb' }, { socket: '/' + 'x'.repeat(120) }, { socket: 3 }]) {
    assertEquals(tunnelSocket(bad), '', JSON.stringify(bad));
  }
});

Deno.test({
  name: 'helper tunnel over the real relay: mcp-forward --helper-socket in, the reply out, a refusal passed on, the socket removed at the end',
  ...T,
  async fn() {
    const keeper = await keeperBinary();
    const dir = Deno.makeTempDirSync({ prefix: 'aibmt' });
    const socket = `${dir}${Deno.build.os === 'windows' ? '\\' : '/'}mcp.sock`;
    const notes: Json[] = [];
    const tunnel = new McpTunnel({ socket, notify: (_m, p) => notes.push(p), spawnRelay: spawnKeeperRelay(keeper) });
    const m = tunnel.methods();
    try {
      const got = await tunnel.start();
      if (!got) {
        console.log('no unix socket relay on this machine; skipped');
        return;
      }
      // AIB's side, in this test: accept, then answer tools/list with the key it saw, or refuse a wrong key
      const answering = (async () => {
        for (let done = 0; done < 2;) {
          await until(() => notes.length > done, 'a request', 20);
          const n = notes[done++];
          await m['mcp.accept']({ rid: n.rid });
          const key = (n.headers as Json)['X-Studio-Artifact-Key'];
          const id = JSON.parse(String(n.body)).id;
          await m['mcp.reply'](key === 'good'
            ? { rid: n.rid, status: 200, body: JSON.stringify({ jsonrpc: '2.0', id, result: { tools: [{ name: 'publish' }] } }) }
            : { rid: n.rid, status: 401, body: '{"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"AIB refused the artifact key for this conversation"}}' });
        }
      })();
      const forward = async (key: string) => {
        const child = new Deno.Command(keeper, {
          args: ['mcp-forward', '--helper-socket', socket],
          env: { MCP_FORWARD_HEADERS: JSON.stringify({ 'X-Studio-Artifact-Key': key, 'X-Studio-Conversation-Id': 'c1' }) },
          stdin: 'piped',
          stdout: 'piped',
          stderr: 'piped',
        }).spawn();
        const w = child.stdin.getWriter();
        await w.write(new TextEncoder().encode('{"jsonrpc":"2.0","id":4,"method":"tools/list"}\n'));
        await w.close();
        return new TextDecoder().decode((await child.output()).stdout).trim();
      };
      const good = JSON.parse(await forward('good'));
      assertEquals([good.id, good.result.tools[0].name], [4, 'publish']);
      const bad = JSON.parse(await forward('bad'));
      assertEquals(bad.id, 4);
      assert(String(bad.error.message).includes('HTTP 401') && String(bad.error.message).includes('refused the artifact key'), bad.error.message);
      await answering;
    } finally {
      tunnel.stop();
      await until(() => {
        try {
          Deno.lstatSync(socket);
          return false;
        } catch {
          return true;
        }
      }, 'the relay removed its socket', 10);
      Deno.removeSync(dir, { recursive: true });
    }
  },
});
