/**
 * Local docs (spike), wired into AIB: the doc tools in the studio_artifact MCP server (only with AIB_DOCS on), the tool call going
 * to Studio's /api/live/docs/tool route, and the editor's WebSocket on the real web server (both HTTP implementations): the page's
 * y-protocols client syncs, sees an agent's edit live, and its own typing reaches the server.
 */
import { assert, assertEquals } from './_assert.ts';
import * as Y from '../../outputs/agent-studio/server/docs/vendor/yjs.js';
import { handle, type ToolContext } from '../../outputs/agent-studio/server/artifacts/mcp.ts';
import { DocStore } from '../../outputs/agent-studio/server/docs/store.ts';
import { runDocTool } from '../../outputs/agent-studio/server/docs/tools.ts';
import { FIELD } from '../../outputs/agent-studio/server/docs/live_doc.ts';
import { makeContext, WebServer } from '../../outputs/agent-studio/server/web/server.ts';
import type { LiveBackend } from '../../outputs/agent-studio/server/host/backend.ts';
import type { UpdateService } from '../../outputs/agent-studio/server/desktop/updater.ts';
import type { Source } from '../../outputs/agent-studio/server/transcripts/monitor.ts';

type Json = Record<string, unknown>;
const sep = Deno.build.os === 'windows' ? '\\' : '/';

async function temp(prefix: string): Promise<string> {
  return Deno.realPathSync(await Deno.makeTempDir({ prefix })).replace(/^\\\\\?\\/, '');
}

function ctxFor(url: string, docs: boolean): ToolContext {
  return { key: 'k', conversation: 'claude:s1', worktree: false, docs, cwd: null, roots: () => [url] };
}

Deno.test("the doc tools are offered only with docs on, and a call goes to Studio's doc route", async () => {
  const project = await temp('aib-docs-proj-');
  const state = await temp('aib-docs-state-');
  const store = new DocStore(state, { idleMs: 60_000 });
  const seen: Json[] = [];
  // Studio's side of /api/live/docs/tool (the key and the folder come from the real route; here the folder is fixed).
  const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, async (request) => {
    const body = await request.json();
    seen.push({ path: new URL(request.url).pathname, key: request.headers.get('X-Studio-Artifact-Key'), body });
    const [ok, result] = await runDocTool(store, project, 'claude', body.tool, body.args);
    return Response.json({ ok, result });
  });
  const url = `http://127.0.0.1:${server.addr.port}`;
  try {
    const list = (on: boolean) => handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, ctxFor(url, on));
    const names = (r: Json | null) => ((r!.result as Json).tools as Json[]).map((t) => t.name);
    assertEquals(names(await list(false)), ['publish', 'update', 'list']);
    assertEquals(names(await list(true)), ['publish', 'update', 'list', 'doc_read', 'doc_changes', 'doc_edit']);
    const call = async (name: string, args: Json) => {
      const r = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }, ctxFor(url, true));
      const result = r!.result as { content: { text: string }[]; isError?: boolean };
      return { data: JSON.parse(result.content[0].text) as Json, isError: !!result.isError };
    };
    const ins = await call('doc_edit', {
      doc: 'plan',
      ops: [{
        op: 'insert',
        target: { kind: 'root' },
        side: 'end',
        source: { from: { kind: 'inline', content: '# Plan\n\nShip it in October.' }, as: 'markdown' },
      }],
    });
    assertEquals(ins.isError, false);
    assertEquals(seen[0].path, '/api/live/docs/tool');
    assertEquals(seen[0].key, 'k');
    assertEquals((seen[0].body as Json).conversationId, 'claude:s1');
    const read = await call('doc_read', { doc: 'plan' });
    const blocks = read.data.blocks as { id: string; h: string; md: string; by?: string }[];
    assertEquals(blocks.map((b) => b.md), ['', '# Plan', 'Ship it in October.']);
    assertEquals(blocks[2].by, 'claude');
    assertEquals(read.data.file, `${project}${sep}docs${sep}plan.md`);
    const bare = await call('doc_edit', { doc: 'plan', ops: [{ op: 'delete', target: { kind: 'blocks', ids: [blocks[0].id] } }] });
    assertEquals([bare.isError, bare.data.code], [true, 'missing_guard']);
    const none = await call('doc_edit', {
      doc: 'plan',
      ops: [{ op: 'replace', target: { kind: 'find', text: 'November' }, with: { from: { kind: 'inline', content: 'x' }, as: 'text' } }],
    });
    assertEquals([none.isError, none.data.code], [true, 'find_none']);
    const changes = await call('doc_changes', { doc: 'plan', sinceRev: read.data.rev as number });
    assertEquals([changes.data.changed, changes.data.gone], [[], []]);
  } finally {
    await store.close();
    await server.shutdown();
    await Deno.remove(project, { recursive: true }).catch(() => {});
    await Deno.remove(state, { recursive: true }).catch(() => {});
  }
});

async function startServer(impl: 'deno' | 'node') {
  const previous = Deno.env.get('AIB_HTTP_IMPL');
  Deno.env.set('AIB_HTTP_IMPL', impl);
  const stateDir = await temp('aib-docs-web-');
  const ctx = makeContext({
    stateDir,
    host: {} as LiveBackend,
    updates: {} as UpdateService,
    webInstanceId: 'test',
    cliPort: 0,
    transcripts: {} as Source,
    claudeProjects: stateDir,
    ompSessions: stateDir,
    shutdown: () => {},
  });
  const server = new WebServer(ctx);
  const port = await server.listen(0);
  if (previous === undefined) Deno.env.delete('AIB_HTTP_IMPL');
  else Deno.env.set('AIB_HTTP_IMPL', previous);
  return {
    ctx,
    port,
    origin: `http://127.0.0.1:${port}`,
    async close() {
      await server.close();
      await Deno.remove(stateDir, { recursive: true }).catch(() => {});
    },
  };
}

/** The page's client, as vendor/docs/editor.js runs it: y-protocols sync over the doc socket. */
function connect(origin: string, port: number, doc: string, protocols: string[]) {
  const ydoc = new Y.Doc();
  // @ts-ignore: Deno's WebSocket takes headers
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/live/docs/socket?doc=${doc}`, { protocols, headers: { Origin: origin } });
  ws.binaryType = 'arraybuffer';
  const send = (build: (e: Y.encoding.Encoder) => void) => {
    const e = Y.encoding.createEncoder();
    Y.encoding.writeVarUint(e, 0);
    build(e);
    if (ws.readyState === 1) ws.send(Y.encoding.toUint8Array(e));
  };
  ydoc.on('update', (update, origin) => {
    if (origin !== ws) send((e) => Y.sync.writeUpdate(e, update));
  });
  ws.onopen = () => send((e) => Y.sync.writeSyncStep1(e, ydoc));
  ws.onmessage = (event) => {
    const d = Y.decoding.createDecoder(new Uint8Array(event.data as ArrayBuffer));
    if (Y.decoding.readVarUint(d) !== 0) return;
    const e = Y.encoding.createEncoder();
    Y.encoding.writeVarUint(e, 0);
    Y.sync.readSyncMessage(d, e, ydoc, ws);
    if (Y.encoding.length(e) > 1) ws.send(Y.encoding.toUint8Array(e));
  };
  const closed = new Promise<CloseEvent>((r) => ws.addEventListener('close', (e) => r(e as CloseEvent)));
  return { ydoc, ws, closed, text: () => ydoc.getXmlFragment(FIELD).toString().replace(/<[^>]+>/g, '|') };
}

async function until(check: () => boolean, what: string): Promise<void> {
  const end = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

for (const impl of ['deno', 'node'] as const) {
  Deno.test(`the editor socket syncs live both ways (${impl} server)`, async () => {
    const server = await startServer(impl);
    const project = await temp('aib-docs-proj-');
    try {
      const doc = await server.ctx.docs.open(project, 'live');
      // Without the page token: refused before any upgrade.
      const refused = connect(server.origin, server.port, doc.id, ['aib-docs']);
      await refused.closed;
      const page = connect(server.origin, server.port, doc.id, ['aib-docs', 'aib-token.' + server.ctx.token]);
      await until(() => page.ydoc.getXmlFragment(FIELD).length === 1, 'the first sync');
      const [ok] = await runDocTool(server.ctx.docs, project, 'claude', 'doc_edit', {
        doc: 'live',
        ops: [{
          op: 'insert',
          target: { kind: 'root' },
          side: 'end',
          source: { from: { kind: 'inline', content: 'From the agent.' }, as: 'markdown' },
        }],
      });
      assert(ok);
      await until(() => page.text().includes('From the agent.'), 'the agent edit on the page');
      const para = page.ydoc.getXmlFragment(FIELD).get(1) as Y.XmlElement;
      page.ydoc.transact(() => (para.get(0) as Y.XmlText).insert(0, 'Typed. '));
      await until(
        () => (doc.live.read() as { blocks: { md: string }[] }).blocks[1]?.md === 'Typed. From the agent.',
        'the typing on the server',
      );
      assertEquals(doc.live.socketCount, 1);
      page.ws.close();
      await page.closed;
      await until(() => doc.live.socketCount === 0, 'the socket to detach');
    } finally {
      await server.close();
      await Deno.remove(project, { recursive: true }).catch(() => {});
    }
  });
}
