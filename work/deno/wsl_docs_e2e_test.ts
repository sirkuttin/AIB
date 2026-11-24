/**
 * Real WSL (AIB_WSL_E2E=<distro>; see _wsl_e2e.ts): docs of a WSL project (docs/wsl/design.md section 4 phase 2; WSL.md "Docs").
 *   - An agent inside the distro calls the doc tools through its real `studio_artifact` entry (the tunnel: forwarder, relay, helper
 *     channel, AIB's MCP endpoint, the doc tool's HTTP call): doc_create, doc_read, doc_edit. The answers name Linux paths. The tool's
 *     HTTP call lands on a small stand-in for AIB's /api/live/docs/tool that runs the real runDocTool on the real store (the route's
 *     own folder lookup is tested elsewhere).
 *   - The files are in the distro: doc.aibdoc is valid JSON there (python3 reads it), the page copy has AIB's note, README.md, no
 *     temp files; a big doc (over one request line) is written whole in chunks.
 *   - The user edits through the doc routes (POST /api/live/docs/edit, /page) and types through the live sync link while an agent's
 *     stale rewrite is refused; a file edit made in the distro is taken in; history lists versions; Changes rows the doc in the distro.
 *   - Restart: a new AIB (new hosts, new store) reopens the doc from its cache; a doc.aibdoc changed in the distro while AIB was away
 *     is rebuilt from the file. A symlink out of aib-docs/ is refused. Move doc to trash: the test's own trash in the distro.
 * Everything is inside AIB_WSL_ROOT=/tmp/aib-wsl-test-<random>; the fake agent is work/fake_acp.py; never the owner's homes.
 */
import { assert, assertEquals } from './_assert.ts';
import { cleanRoot, inDistro, KEY, newAib, prepareRoot, readyHost, ROOT, T, WSL_E2E } from './_wsl_e2e.ts';
import { UserClient } from './_docs.ts';
import { Connection } from '../../app/server/acp/connection.ts';
import { Aib } from '../../app/server/host/aib.ts';
import { refOf } from '../../app/server/platform/location.ts';
import { DocStore, mdBody } from '../../app/server/docs/store.ts';
import { runDocTool } from '../../app/server/docs/tools.ts';
import { ArtifactHistory } from '../../app/server/docs/history.ts';
import { ArtifactStore } from '../../app/server/artifacts/artifacts.ts';
import { installWslDocFs, linuxPaths } from '../../app/server/wsl/docs.ts';
import { docsRoutes } from '../../app/server/web/docs_routes.ts';
import type { WebContext } from '../../app/server/web/server.ts';

type Json = Record<string, unknown>;
type Entry = { command: string; args: string[]; env: { name: string; value: string }[] };

const PROJECT = `${ROOT}/repo`;
// Only built when the distro is there: refOf throws on the empty name the ignored run has.
const REF = WSL_E2E ? refOf({ kind: 'wsl', distro: KEY, linuxPath: PROJECT }) : '';

function aibIn(state: string): Aib {
  const aib = new Aib({ stateDir: state, port: 0, ownersDir: null }, { keeper: null });
  aib.ownerProbe = () => null;
  aib.connectionFactory = (_command, cwd, provider, options) =>
    new Connection(['python3', `${ROOT}/fake_acp.py`, '--cancel-aware'], cwd, provider, {
      ...options,
      wsl: options?.wsl ? { ...options.wsl, program: '/usr/bin/python3' } : options?.wsl,
    });
  return aib;
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
/** A tools/call answer: the tool's JSON and whether it is an error. */
function toolResult(answer: Json | undefined): { data: Json; isError: boolean } {
  const result = (answer?.result ?? {}) as { content?: { text: string }[]; isError?: boolean };
  if (!result.content) throw new Error(`no tool result: ${JSON.stringify(answer)}`);
  return { data: JSON.parse(result.content[0].text) as Json, isError: !!result.isError };
}
const inline = (content: string, as = 'markdown') => ({ from: { kind: 'inline', content }, as });
const readIn = async (path: string) => {
  const r = await inDistro('cat -- "$1"', [path]);
  if (r.code !== 0) throw new Error(`cat ${path}: ${r.err}`);
  return r.out;
};

Deno.test({
  name: 'wsl e2e docs: doc tools from inside the distro, files in the distro, user and agent edits, history, restart, trash',
  ...T,
  async fn() {
    const state = Deno.makeTempDirSync({ prefix: 'aib-wsl-docs-e2e-' });
    await prepareRoot();
    installWslDocFs();
    const artifacts = new ArtifactStore(`${state}\\artifacts`);
    const newStore = () => new DocStore(`${state}\\docs-state`, { idleMs: 60_000, snapshotIdleMs: 60_000, history: new ArtifactHistory(() => artifacts) });
    let store = newStore();
    const aibs: Aib[] = [];
    const seen: Json[] = [];
    // AIB's /api/live/docs/tool for this test: the real doc tools on the real store, the answer as the route gives it (Linux paths)
    const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, async (request) => {
      const body = await request.json() as Json;
      seen.push({ path: new URL(request.url).pathname, tool: body.tool });
      const chat = String(body.conversationId ?? '');
      const [ok, result] = await runDocTool(store, REF, 'claude', String(body.tool), (body.args ?? {}) as Json, chat);
      return Response.json({ ok, result: linuxPaths(result) });
    });
    try {
      const host = await readyHost();
      assert(host.mcpTunnel, 'the helper runs the tunnel');
      const aib = aibIn(state);
      aibs.push(aib);
      aib.artifactUrlProvider = () => `http://127.0.0.1:${server.addr.port}`;
      const c = await aib.connect('claude', REF);
      const entry = c.mcpServers[0] as unknown as Entry;
      const headers = entry.env.find((e) => e.name === 'MCP_FORWARD_HEADERS')!.value;

      // ---- 1. the agent in the distro makes, reads and edits a doc ----
      const run = await runEntry(entry, headers, [
        ...INIT,
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        callMsg(3, 'doc_create', { doc: 'plan', markdown: '# Plan\n\nThe launch moves to October.\n\nSecond paragraph.\n' }),
      ]);
      assertEquals(run.code, 0, run.err);
      const names = (((run.answers.get(2)?.result as Json)?.tools as Json[]) ?? []).map((t) => String(t.name));
      assert(names.includes('doc_create') && names.includes('drawing_create'), names.join());
      const created = toolResult(run.answers.get(3));
      assertEquals(created.isError, false, JSON.stringify(created.data));
      assertEquals(created.data.file, `${PROJECT}/aib-docs/plan/doc.aibdoc`, 'the agent reads a Linux path');
      // the forwarder sends each message on its own connection, at once: a call that needs the one before goes in its own run
      const readRun = await runEntry(entry, headers, [...INIT, callMsg(4, 'doc_read', { doc: 'plan' })]);
      const read = toolResult(readRun.answers.get(4)).data;
      const blocks = read.blocks as { id: string; h: string; md: string }[];
      assertEquals(blocks.map((b) => b.md), ['# Plan', 'The launch moves to October.', 'Second paragraph.']);
      assert(seen.every((s) => s.path === '/api/live/docs/tool'), JSON.stringify(seen));

      const doc = await store.open(REF, 'plan');
      await store.flush(doc);
      // the files, in the distro: valid JSON, the page copy with AIB's note, README, no temp file
      const check = await inDistro(
        'python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(d[\'format\'], len(d[\'pages\']))" "$1/aib-docs/plan/doc.aibdoc" && ' +
          'head -1 "$1/aib-docs/plan/01-page-1.md" && test -f "$1/aib-docs/README.md" && ls -a "$1/aib-docs/plan"',
        [PROJECT],
      );
      assertEquals(check.code, 0, check.err);
      const lines = check.out.trim().split('\n');
      assertEquals(lines[0], 'aibdoc 1');
      assert(lines[1].startsWith('<!-- Generated by AIB'), lines[1]);
      assert(!lines.some((l) => l.endsWith('.tmp')), check.out);

      // ---- 2. the user (live sync link and the routes) and the agent at once ----
      const user = new UserClient(doc.live);
      user.type(blocks[1].id, 'The launch moves to October'.length, ' 6th');
      const routes = docsRoutes();
      const ctx = { docs: store } as unknown as WebContext;
      const [editStatus] = await routes.get('POST /api/live/docs/edit')!(ctx, new URL('http://x/'), {
        doc: doc.id,
        ops: [{ op: 'insert', target: { kind: 'root' }, side: 'end', source: inline('Added by the user through the route.') }],
      });
      assertEquals(editStatus, 200);
      const stale = await runEntry(entry, headers, [
        ...INIT,
        callMsg(5, 'doc_edit', {
          doc: 'plan',
          ops: [{ op: 'replace', target: { kind: 'blocks', ids: [blocks[1].id] }, ifHash: blocks[1].h, ifRev: read.rev, with: inline('Launch is in November.', 'text') }],
        }),
        callMsg(6, 'doc_edit', { doc: 'plan', ops: [{ op: 'insert', target: { kind: 'root' }, side: 'end', source: inline('Agent words from the distro.') }] }),
      ]);
      const refused = toolResult(stale.answers.get(5));
      assertEquals([refused.isError, refused.data.code], [true, 'guard_mismatch'], 'the user typed after the agent read: their edit wins');
      assertEquals(toolResult(stale.answers.get(6)).isError, false);
      const [pageStatus] = await routes.get('POST /api/live/docs/page')!(ctx, new URL('http://x/'), { doc: doc.id, action: 'add', title: 'Risks' });
      assertEquals(pageStatus, 200);
      await store.flush(doc);
      const page1 = mdBody(await readIn(`${PROJECT}/aib-docs/plan/01-page-1.md`));
      for (const words of ['October 6th', 'Added by the user through the route.', 'Agent words from the distro.']) assert(page1.includes(words), page1);
      assert(!page1.includes('November'), page1);
      assertEquals((await inDistro('ls "$1/aib-docs/plan"', [PROJECT])).out.trim().split('\n').filter((n) => n.endsWith('.md')), ['01-page-1.md', '02-risks.md']);

      // ---- 3. an edit made in the distro (an agent's file tool, or the user's editor there) is taken in ----
      const sed = await inDistro('sed -i "s/Second paragraph\\./Second paragraph, edited in the distro./" "$1/aib-docs/plan/01-page-1.md"', [PROJECT]);
      assertEquals(sed.code, 0, sed.err);
      await store.syncMirror(doc);
      assert(store.pageMarkdown(doc).includes('Second paragraph, edited in the distro.'), store.pageMarkdown(doc));

      // ---- 4. history; Changes shows the doc as one row (the helper's changes.get) ----
      const [, hist] = await routes.get('GET /api/live/docs/history')!(ctx, new URL(`http://x/?doc=${doc.id}`), null);
      assert(((hist as Json).versions as Json[]).length >= 2, JSON.stringify(hist));
      const changes = await host.call('changes.get', { folder: PROJECT }) as Json;
      const rows = (changes.docs ?? []) as Json[];
      assertEquals(rows.map((r) => [r.doc, r.dir, r.title]), [['plan', 'aib-docs/plan', 'Plan']]);

      // ---- 5. a big doc goes over in chunks and lands whole ----
      const big = '# Big\n\n' + Array.from({ length: 9000 }, (_, i) => `Paragraph ${i} ${'x'.repeat(60)}.`).join('\n\n') + '\n';
      const bigDoc = await store.open(REF, 'big', big, 'user');
      await store.flush(bigDoc);
      const size = await inDistro('python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(len(d[\'pages\'][0][\'content\']))" "$1/aib-docs/big/doc.aibdoc"', [PROJECT]);
      assertEquals([size.code, size.out.trim()], [0, '9001'], size.err);
      assert(bigDoc.aib.text.length > 512 * 1024, `the doc.aibdoc is ${bigDoc.aib.text.length} characters: more than one chunk`);

      // ---- 6. no way out of aib-docs/ through a symlink ----
      const ln = await inDistro('mkdir -p "$1/outside" && echo secret > "$1/outside/doc.aibdoc" && ln -s "$1/outside" "$2/aib-docs/evil"', [ROOT, PROJECT]);
      assertEquals(ln.code, 0, ln.err);
      const escaped = await host.call('docs.fs', { ops: [{ op: 'read', path: `${PROJECT}/aib-docs/evil/doc.aibdoc` }] });
      assertEquals([escaped.results[0].ok, escaped.results[0].code], [false, 'outside_docs']);
      await inDistro('rm -f -- "$1/aib-docs/evil"', [PROJECT]);

      // ---- 7. a restart: a new AIB reopens the doc from its cache ----
      const text = store.pageMarkdown(doc);
      const rev = doc.live.rev;
      await store.close();
      for (const s of aibs.splice(0)) await s.close().catch(() => {});
      newAib();
      await readyHost();
      store = newStore();
      let again = await store.open(REF, 'plan');
      assertEquals([again.live.rev, store.pageMarkdown(again)], [rev, text]);
      await store.close();
      // changed in the distro while AIB was away (a git pull): rebuilt from the file
      const edit = await inDistro('sed -i "s/Agent words from the distro\\./Pulled in the distro./" "$1/aib-docs/plan/doc.aibdoc"', [PROJECT]);
      assertEquals(edit.code, 0, edit.err);
      store = newStore();
      again = await store.open(REF, 'plan');
      assert(store.pageMarkdown(again).includes('Pulled in the distro.'), store.pageMarkdown(again));
      await store.flush(again);
      assert((await readIn(`${PROJECT}/aib-docs/plan/01-page-1.md`)).includes('Pulled in the distro.'), 'the copy follows');

      // ---- 8. Move doc to trash: the doc folder goes to the test's own trash in the distro (never gio, never the owner's) ----
      const [trashStatus, trashed] = await docsRoutes().get('POST /api/live/docs/trash')!({ docs: store } as unknown as WebContext, new URL('http://x/'), { doc: again.id });
      assertEquals([trashStatus, (trashed as Json).trashed], [200, 'plan'], JSON.stringify(trashed));
      const where = await inDistro('test ! -e "$1/aib-docs/plan" && ls "$2/home/.local/share/Trash/files" && cat "$2/home/.local/share/Trash/info/plan.trashinfo"', [PROJECT, ROOT]);
      assertEquals(where.code, 0, where.err + where.out);
      assert(where.out.includes('plan') && where.out.includes(`Path=${PROJECT}/aib-docs/plan`), where.out);
    } finally {
      await store.close().catch(() => {});
      for (const s of aibs) await s.close().catch(() => {});
      await server.shutdown();
      await cleanRoot();
      for (let i = 0; i < 20; i++) {
        try {
          Deno.removeSync(state, { recursive: true });
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 250));
        }
      }
    }
  },
});
