/**
 * Doc tools and doc routes in a chat that works in its own git worktree: they resolve to the MAIN checkout's aib-docs/ (brief, step S
 * item 13), whether the chat is named by its live connection id or by its lasting provider:session id; and every row shows the
 * doc's title (the slug only when there is none).
 */
import { assert, assertEquals } from './_assert.ts';
import { docsRoutes, docsTool } from '../../outputs/agent-studio/server/web/docs_routes.ts';
import { makeContext } from '../../outputs/agent-studio/server/web/server.ts';
import type { LiveBackend } from '../../outputs/agent-studio/server/host/backend.ts';
import type { UpdateService } from '../../outputs/agent-studio/server/desktop/updater.ts';
import type { Source } from '../../outputs/agent-studio/server/transcripts/monitor.ts';

type Json = Record<string, unknown>;
const sep = Deno.build.os === 'windows' ? '\\' : '/';
const exists = (path: string) => Deno.stat(path).then(() => true, () => false);

async function git(cwd: string, ...args: string[]) {
  const out = await new Deno.Command('git', { args: ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], cwd, stdout: 'null', stderr: 'piped' }).output();
  if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
}

Deno.test('a worktree chat\'s doc tools and routes use the main checkout\'s aib-docs/, by connection id or lasting id', async () => {
  const root = Deno.realPathSync(await Deno.makeTempDir({ prefix: 'aib-wtdocs-' })).replace(/^\\\\\?\\/, '');
  const main = `${root}${sep}main`, wt = `${root}${sep}wt`, state = `${root}${sep}state`;
  await Deno.mkdir(main);
  await Deno.mkdir(state);
  await git(main, 'init', '-q');
  await Deno.writeTextFile(`${main}${sep}a.txt`, 'a');
  await git(main, 'add', '.');
  await git(main, 'commit', '-q', '-m', 'init');
  await git(main, 'worktree', 'add', '-q', '-b', 'feat', wt);
  // The host knows the live connection's folder; asked by the lasting id it knows nothing (as in the real Studio).
  const connections: Json[] = [{ id: 'c1', provider: 'claude', sessionId: 's1', cwd: wt, projectRoot: main, busy: false, closed: false }];
  const host = {
    liveList: () => Promise.resolve({ connections }),
    liveState: (id: string) => Promise.resolve(id === 'c1' ? { cwd: wt } : null),
    liveWrites: () => Promise.resolve({}),
    liveCall: () => Promise.resolve([200, {}]),
    emitArtifact: () => Promise.resolve(true),
  } as unknown as LiveBackend;
  const ctx = makeContext({
    stateDir: state, host, updates: {} as UpdateService, webInstanceId: 'test', cliPort: 0,
    transcripts: { sessionCwd: () => Promise.resolve('') } as unknown as Source,
    claudeProjects: state, ompSessions: state, shutdown: () => {},
  });
  try {
    await ctx.artifacts.refresh();
    const tool = async (chat: string, name: string, args: Json) => {
      const [, reply] = await docsTool(ctx, { conversationId: chat, tool: name, args });
      return (reply as { ok: boolean; result: Json });
    };
    const routes = docsRoutes();
    for (const id of ['c1', 'claude:s1']) {
      const name = id === 'c1' ? 'by-conn' : 'by-chat';
      const made = await tool(id, 'doc_create', { doc: name, markdown: '# Hello\n\nBody\n', title: 'Overview' });
      assert(made.ok, JSON.stringify(made.result));
      assert(await exists(`${main}${sep}aib-docs${sep}${name}${sep}doc.aibdoc`), `${name} is in the main checkout`);
      assert(!(await exists(`${wt}${sep}aib-docs${sep}${name}`)), `${name} is not in the worktree`);
      const read = await tool(id, 'doc_read', { doc: name });
      assert(read.ok, JSON.stringify(read.result));
      const first = (read.result.blocks as Json[])[0].id;
      const edit = await tool(id, 'doc_edit', { doc: name, ops: [{ op: 'insert', target: { kind: 'blocks', ids: [first] }, side: 'after', source: { from: { kind: 'inline', content: 'More' }, as: 'markdown' } }] });
      assert(edit.ok, JSON.stringify(edit.result));
      const listed = await tool(id, 'doc_list', {});
      assert(listed.ok);
      assert((listed.result.docs as Json[]).some((d) => d.name === name));
      const [status, tab] = await routes.get('GET /api/live/docs/list')!(ctx, new URL(`http://x/api/live/docs/list?id=${encodeURIComponent(id)}`), null) as [number, Json];
      assertEquals(status, 200, JSON.stringify(tab));
      assert((tab.docs as Json[]).some((d) => d.name === name));
    }
  } finally {
    await ctx.docs.close();
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test('doc_create: docTitle, else the first # heading of a slug-named doc, else the name, is the title Files lists', async () => {
  const root = Deno.realPathSync(await Deno.makeTempDir({ prefix: 'aib-doctitle-' })).replace(/^\\\\\?\\/, '');
  const state = `${root}${sep}state`, project = `${root}${sep}project`;
  await Deno.mkdir(state);
  await Deno.mkdir(project);
  const host = {
    liveList: () => Promise.resolve({ connections: [] }), liveState: () => Promise.resolve({}), liveWrites: () => Promise.resolve({}),
    liveCall: () => Promise.resolve([200, {}]), emitArtifact: () => Promise.resolve(true),
  } as unknown as LiveBackend;
  const ctx = makeContext({
    stateDir: state, host, updates: {} as UpdateService, webInstanceId: 'test', cliPort: 0,
    transcripts: { sessionCwd: () => Promise.resolve(project) } as unknown as Source,
    claudeProjects: state, ompSessions: state, shutdown: () => {},
  });
  try {
    const tool = async (name: string, args: Json) => {
      const [, reply] = await docsTool(ctx, { conversationId: 'claude:a', tool: name, args });
      return (reply as { ok: boolean; result: Json }).result;
    };
    const a = await tool('doc_create', { doc: 'checkout-rounding-release', docTitle: 'Checkout rounding fix: release plan', markdown: '# Summary\n\nx\n' });
    assertEquals(a.docTitle, 'Checkout rounding fix: release plan');
    const b = await tool('doc_create', { doc: 'launch-notes', markdown: '# Launch notes for May\n\nx\n' });
    assertEquals(b.docTitle, 'Launch notes for May');
    const c = await tool('doc_create', { doc: 'bare-doc', markdown: 'no heading\n' });
    assertEquals(c.docTitle, 'bare-doc');
    const d = await tool('doc_create', { doc: 'Release plan', markdown: '# Something else\n' });
    assertEquals(d.docTitle, 'Release plan', 'a doc named with a real title keeps it');
    assertEquals((await tool('doc_read', { doc: 'checkout-rounding-release' })).docTitle, 'Checkout rounding fix: release plan');
    const listed = (await tool('doc_list', {})).docs as Json[];
    assertEquals(listed.map((x) => [x.name, x.title]).sort(), [
      ['bare-doc', 'bare-doc'], ['checkout-rounding-release', 'Checkout rounding fix: release plan'],
      ['launch-notes', 'Launch notes for May'], ['release-plan', 'Release plan'],
    ]);
    // the title is saved with the doc: a fresh store reads it back
    const text = await Deno.readTextFile(`${project}${sep}aib-docs${sep}checkout-rounding-release${sep}doc.aibdoc`);
    assert(text.includes('Checkout rounding fix: release plan'), text.slice(0, 300));
  } finally {
    await ctx.docs.close();
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});
