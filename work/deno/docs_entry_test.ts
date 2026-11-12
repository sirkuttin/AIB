/**
 * The docs' entry points on the server side (builder A): GET /api/live/docs/list, which the Files view, Ctrl+K, page chips and the
 * Artifacts picker read. Docs live in aib-docs/; the project's own docs/ is never a doc folder; each doc lists exactly the paths it owns, its pages
 * with their ids (chips resolve by id) and its linked chat, which opening the doc from another chat never moves.
 */
import { assert, assertEquals } from './_assert.ts';
import { docsRoutes, docsTool } from '../../outputs/agent-studio/server/web/docs_routes.ts';
import { makeContext } from '../../outputs/agent-studio/server/web/server.ts';
import type { LiveBackend } from '../../outputs/agent-studio/server/host/backend.ts';
import type { UpdateService } from '../../outputs/agent-studio/server/desktop/updater.ts';
import type { Source } from '../../outputs/agent-studio/server/transcripts/monitor.ts';

type Json = Record<string, unknown>;
const sep = Deno.build.os === 'windows' ? '\\' : '/';

async function studio() {
  const root = Deno.realPathSync(await Deno.makeTempDir({ prefix: 'aib-entry-' })).replace(/^\\\\\?\\/, '');
  const project = `${root}${sep}project`, state = `${root}${sep}state`;
  await Deno.mkdir(`${project}${sep}docs`, { recursive: true });
  await Deno.mkdir(state);
  const host = {
    liveList: () => Promise.resolve({ connections: [] }),
    liveState: () => Promise.resolve({}),
    liveWrites: () => Promise.resolve({}),
    liveCall: () => Promise.resolve([200, {}]),
    emitArtifact: () => Promise.resolve(true),
  } as unknown as LiveBackend;
  const ctx = makeContext({
    stateDir: state,
    host,
    updates: {} as UpdateService,
    webInstanceId: 'test',
    cliPort: 0,
    transcripts: { sessionCwd: () => Promise.resolve(project) } as unknown as Source,
    claudeProjects: state,
    ompSessions: state,
    shutdown: () => {},
  });
  const routes = docsRoutes();
  const call = async (key: string, body: Json | null, query = ''): Promise<[number, Json]> => {
    const [status, payload] = await routes.get(key)!(ctx, new URL(`http://x${key.split(' ')[1]}?${query}`), body);
    return [status, payload as Json];
  };
  const tool = async (chat: string, name: string, args: Json): Promise<Json> => {
    const [, reply] = await docsTool(ctx, { conversationId: chat, tool: name, args });
    return (reply as { result: Json }).result;
  };
  return {
    ctx,
    project,
    call,
    tool,
    async done() {
      await ctx.docs.close();
      await Deno.remove(root, { recursive: true }).catch(() => {});
    },
  };
}

Deno.test('docs/list: one entry per doc in aib-docs/ with its owned paths, page ids, linked chat and last edit; docs/ is never touched', async () => {
  const s = await studio();
  try {
    await Deno.mkdir(`${s.project}${sep}docs`, { recursive: true });
    await Deno.writeTextFile(`${s.project}${sep}docs${sep}README.md`, '# Read me\n');
    const [, made] = await s.call('POST /api/live/docs/open', { id: 'claude:a', name: 'Release plan', create: '# Overview\n' });
    await s.call('POST /api/live/docs/page', { doc: made.doc, action: 'add', title: 'Risks' });
    const [status, listed] = await s.call('GET /api/live/docs/list', null, 'id=claude:a');
    assertEquals(status, 200);
    const docs = listed.docs as Json[];
    assertEquals(docs.length, 1, 'README.md is a file, not a doc');
    const d = docs[0];
    assertEquals([d.name, d.title, d.dir, d.pages, d.chat], ['release-plan', 'Release plan', 'aib-docs/release-plan', 2, 'claude:a']);
    assertEquals((d.pageList as Json[]).map((p) => p.title), ['Page 1', 'Risks']);
    for (const p of d.owned as string[]) assertEquals(p.startsWith('aib-docs/release-plan/'), true, p);
    assertEquals(typeof d.editedAt, 'number');
    assertEquals(d.editedBy, 'You', 'the user added a page last');
    assertEquals(d.writing, [], 'no agent at work');
    assertEquals(listed.others, [], "aib-docs/README.md is AIB's, not another file");
    // the project's own docs/ is untouched; aib-docs/README.md was written with the first doc
    assertEquals([...Deno.readDirSync(`${s.project}${sep}docs`)].map((e) => e.name), ['README.md']);
    assertEquals(Deno.readTextFileSync(`${s.project}${sep}docs${sep}README.md`), '# Read me\n');
    assert(Deno.readTextFileSync(`${s.project}${sep}aib-docs${sep}README.md`).startsWith('# aib-docs'));
  } finally {
    await s.done();
  }
});

Deno.test('docs/list: opening the doc from chat B leaves it linked to chat A; a renamed page keeps its id', async () => {
  const s = await studio();
  try {
    const [, made] = await s.call('POST /api/live/docs/open', { id: 'claude:a', name: 'Plan', create: '' });
    await s.call('POST /api/live/docs/open', { id: 'claude:b', name: 'plan' });
    await s.tool('claude:b', 'doc_read', { doc: 'plan' });
    const [, listed] = await s.call('GET /api/live/docs/list', null, 'id=claude:b');
    const d = (listed.docs as Json[])[0];
    assertEquals(d.chat, 'claude:a');
    const page = (d.pageList as Json[])[0].id;
    await s.call('POST /api/live/docs/page', { doc: made.doc, action: 'rename', page, title: 'Overview' });
    const [, again] = await s.call('GET /api/live/docs/list', null, 'id=claude:b');
    assertEquals((again.docs as Json[])[0].pageList, [{ id: page, title: 'Overview' }]);
    // a closed doc (after a restart) still lists its pages and its link from the cache
    await s.ctx.docs.close();
    const [, closed] = await s.call('GET /api/live/docs/list', null, 'id=claude:b');
    const c = (closed.docs as Json[])[0];
    assertEquals([c.open, c.chat, (c.pageList as Json[])[0]], [false, 'claude:a', { id: page, title: 'Overview' }]);
  } finally {
    await s.done();
  }
});
