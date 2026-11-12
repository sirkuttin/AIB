/**
 * The docs server for the doc screens (step S): what the page and the entry points rely on. The project's own docs/ is never a doc,
 * opening never re-links, per-chat undo, the socket's epoch (restart without duplicates), a move vs a rename, pasted agent marks,
 * the turn signal (refused notes for a short and a cancelled turn, presence and claims cleared), page delete requests, restore with
 * keystrokes in flight, the Markdown export, owned paths, doc rows for Changes/Merge and the drawing page's own CSP.
 */
import { assert, assertEquals } from './_assert.ts';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { DocStore, docId, DOCS_README, MD_NOTE } from '../../outputs/agent-studio/server/docs/store.ts';
import { ArtifactHistory } from '../../outputs/agent-studio/server/docs/history.ts';
import { ArtifactStore } from '../../outputs/agent-studio/server/artifacts/artifacts.ts';
import { FIELD } from '../../outputs/agent-studio/server/docs/live_doc.ts';
import { schema } from '../../outputs/agent-studio/server/docs/markdown.ts';
import { docRows } from '../../outputs/agent-studio/server/docs/rows.ts';
import { docsRoutes, docsTool } from '../../outputs/agent-studio/server/web/docs_routes.ts';
import { makeContext, type WebContext, WebServer } from '../../outputs/agent-studio/server/web/server.ts';
import { isDocHistory } from '../../outputs/agent-studio/server/artifacts/artifacts.ts';
import type { LiveBackend } from '../../outputs/agent-studio/server/host/backend.ts';
import type { UpdateService } from '../../outputs/agent-studio/server/desktop/updater.ts';
import type { Source } from '../../outputs/agent-studio/server/transcripts/monitor.ts';
import { UserClient } from './_docs.ts';
import { ownGatePost } from '../../outputs/agent-studio/server/web/studio_routes.ts';
import { Gate } from '../../outputs/agent-studio/server/web/security.ts';
import { configure as configureKeys, issue } from '../../outputs/agent-studio/server/artifacts/keys.ts';

type Json = Record<string, unknown>;
const sep = Deno.build.os === 'windows' ? '\\' : '/';
const inline = (content: string, as = 'markdown') => ({ from: { kind: 'inline', content }, as });
const exists = (path: string) => Deno.stat(path).then(() => true, () => false);

async function temp(prefix: string): Promise<string> {
  return Deno.realPathSync(await Deno.makeTempDir({ prefix })).replace(/^\\\\\?\\/, '');
}

/** A Studio context whose chats all work in `project`; `connections` is what the agent host lists (the turn signal reads it). */
async function studio() {
  const root = await temp('aib-screens-');
  const project = `${root}${sep}project`, state = `${root}${sep}state`;
  await Deno.mkdir(`${project}${sep}docs`, { recursive: true });
  await Deno.mkdir(state);
  const connections: Json[] = [];
  const host = {
    liveList: () => Promise.resolve({ connections }),
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
  const tool = async (chat: string, name: string, args: Json): Promise<[boolean, Json]> => {
    const [, reply] = await docsTool(ctx, { conversationId: chat, tool: name, args });
    const r = reply as { ok: boolean; result: Json };
    return [r.ok, r.result];
  };
  /** A chat whose turn is running (busy) or ended at `endedAt`. */
  const chat = (id: string, provider: string, session: string, endedAt: string | null, busy = false) => {
    const i = connections.findIndex((c) => c.id === id);
    const c = { id, provider, sessionId: session, busy, closed: false, attention: { turnEndedAt: endedAt } };
    if (i >= 0) connections[i] = c;
    else connections.push(c);
  };
  return {
    ctx,
    project,
    state,
    connections,
    call,
    tool,
    chat,
    async done() {
      await ctx.docs.close();
      await Deno.remove(root, { recursive: true }).catch(() => {});
    },
  };
}

const presence = (ctx: WebContext, doc: string) =>
  [...ctx.docs.get(doc)!.live.awareness.getStates().values()].map((s) => s.agent as Json).filter(Boolean);

Deno.test("the project's own docs/ is never touched: not listed, not opened, never moved; a doc never goes into a folder it did not make", async () => {
  const s = await studio();
  try {
    await Deno.mkdir(`${s.project}${sep}docs`, { recursive: true });
    const readme = `${s.project}${sep}docs${sep}README.md`;
    await Deno.writeTextFile(readme, '# Read me\n\nThe user wrote this.\n');
    await Deno.mkdir(`${s.project}${sep}docs${sep}notes`);
    // a doc.aibdoc AIB has no state for (a clone, a hand copy) is the project's file too
    await Deno.mkdir(`${s.project}${sep}docs${sep}other`);
    await Deno.writeTextFile(`${s.project}${sep}docs${sep}other${sep}doc.aibdoc`, '{"format":"aibdoc","version":1,"title":"Other","pages":[]}');
    assertEquals(await s.ctx.docs.list(s.project), []);
    assertEquals((await s.call('POST /api/live/docs/open', { id: 'claude:a', name: 'README' }))[1].code, 'no_doc');
    const [status, made] = await s.call('POST /api/live/docs/open', { id: 'claude:a', name: 'README', create: '' });
    assertEquals(status, 200);
    assertEquals(made.dir, 'aib-docs/readme');
    assertEquals(await Deno.readTextFile(readme), '# Read me\n\nThe user wrote this.\n');
    assertEquals(
      [...Deno.readDirSync(`${s.project}${sep}docs`)].map((e) => e.name).sort(),
      ['README.md', 'notes', 'other'],
      'docs/ as the user left it',
    );
    // aib-docs/notes is a folder AIB did not make: no doc goes into it
    await Deno.mkdir(`${s.project}${sep}aib-docs${sep}notes`);
    assertEquals((await s.call('POST /api/live/docs/open', { id: 'claude:a', name: 'notes', create: '' }))[1].code, 'folder_exists');
    // what the doc owns: exactly its files, project-relative
    const listed = await s.ctx.docs.list(s.project);
    assertEquals(listed.map((d) => [d.name, d.dir, d.owned]), [['readme', 'aib-docs/readme', [
      'aib-docs/readme/doc.aibdoc',
      'aib-docs/readme/01-page-1.md',
    ]]]);
    // the Docs tab's footer: what else is in aib-docs/ (not AIB's README)
    assertEquals(await s.ctx.docs.others(s.project), ['aib-docs/notes']);
    // an old-layout doc is one only when AIB wrote it (its note line)
    await Deno.writeTextFile(`${s.project}${sep}docs${sep}old.md`, `${MD_NOTE}\n\nOld words.\n`);
    assertEquals((await s.ctx.docs.list(s.project)).map((d) => [d.name, d.legacy ?? false]), [['old', true], ['readme', false]]);
    assert(await exists(readme));
  } finally {
    await s.done();
  }
});

Deno.test('aib-docs/README.md is written once, with the first doc, and an edit to it stays', async () => {
  const s = await studio();
  try {
    await s.call('POST /api/live/docs/open', { id: 'claude:a', name: 'Plan', create: '' });
    const path = `${s.project}${sep}aib-docs${sep}README.md`;
    assertEquals(await Deno.readTextFile(path), DOCS_README);
    assert(DOCS_README.includes('Edits to the .md copies are overwritten.'));
    await Deno.writeTextFile(path, '# Our docs\n');
    await s.call('POST /api/live/docs/open', { id: 'claude:a', name: 'Spec', create: '' });
    assertEquals(await Deno.readTextFile(path), '# Our docs\n');
    await Deno.remove(path);
    await s.call('POST /api/live/docs/open', { id: 'claude:a', name: 'Notes', create: '' });
    assertEquals(await exists(path), false, 'deleted by the user: not written again');
  } finally {
    await s.done();
  }
});

Deno.test('docs AIB made in docs/ move to aib-docs/ on first use: pages, cache and history kept, the copies follow', async () => {
  const root = Deno.realPathSync(await Deno.makeTempDir({ prefix: 'aib-move-' })).replace(/^\\\\\?\\/, '');
  const dirs = { root, state: `${root}${sep}state`, project: `${root}${sep}project` };
  await Deno.mkdir(dirs.state), await Deno.mkdir(dirs.project);
  try {
    // a doc made while AIB kept docs in docs/
    const history = new ArtifactHistory(() => artifacts);
    const artifacts = new ArtifactStore(`${dirs.state}${sep}artifacts`);
    const old = new DocStore(dirs.state, { idleMs: 60_000, mirrorFolder: 'docs', history });
    const doc = await old.open(dirs.project, 'Release plan', '# Overview\n\nShip it.\n');
    old.userPageOp(doc, 'add', { title: 'Risks' });
    await old.flush(doc);
    const versions = old.history(doc).versions.length;
    await old.close();
    assert(await exists(`${dirs.project}${sep}docs${sep}release-plan${sep}doc.aibdoc`));
    await Deno.writeTextFile(`${dirs.project}${sep}docs${sep}guide.md`, '# The project guide\n');
    // the next AIB: aib-docs/
    const store = new DocStore(dirs.state, { idleMs: 60_000, history });
    const listed = await store.list(dirs.project);
    assertEquals(listed.map((d) => [d.name, d.dir, d.pages]), [['release-plan', 'aib-docs/release-plan', 2]]);
    assertEquals(await exists(`${dirs.project}${sep}docs${sep}release-plan`), false, 'moved, not copied');
    assertEquals(await Deno.readTextFile(`${dirs.project}${sep}docs${sep}guide.md`), '# The project guide\n', "the project's file stays");
    assert(await exists(`${dirs.project}${sep}aib-docs${sep}README.md`));
    const again = await store.open(dirs.project, 'release-plan');
    assertEquals(again.live.pageList().map((p) => p.title), ['Page 1', 'Risks']);
    assertEquals(store.history(again).versions.length >= versions, true, 'the history is the same artifact');
    assertEquals(store.pageMarkdown(again).includes('Ship it.'), true);
    // the cache's copy paths moved with the folder: an edit to the moved copy is taken in
    const copy = `${dirs.project}${sep}aib-docs${sep}release-plan${sep}01-page-1.md`;
    const text = await Deno.readTextFile(copy);
    await Deno.writeTextFile(copy, text.replace('Ship it.', 'Ship it on Monday.'));
    await store.syncMirror(again);
    assertEquals(store.pageMarkdown(again).includes('Ship it on Monday.'), true);
    await store.close();
  } finally {
    await Deno.remove(dirs.root, { recursive: true }).catch(() => {});
  }
});

Deno.test('opening a doc from chat B keeps its link to chat A; the link route moves it', async () => {
  const s = await studio();
  try {
    const [, made] = await s.call('POST /api/live/docs/open', { id: 'claude:a', name: 'Plan', create: '# Plan\n' });
    assertEquals(made.chat, 'claude:a');
    const [, opened] = await s.call('POST /api/live/docs/open', { id: 'claude:b', name: 'plan' });
    assertEquals(opened.chat, 'claude:a');
    await s.tool('claude:b', 'doc_read', { doc: 'plan' }); // an agent's call never takes a linked doc either
    assertEquals(s.ctx.docs.get(String(made.doc))!.chat, 'claude:a');
    assertEquals((await s.call('POST /api/live/docs/link', { doc: made.doc, id: 'claude:b' }))[1].chat, 'claude:b');
  } finally {
    await s.done();
  }
});

Deno.test("two Claude chats in one doc: each doc_undo takes back only its own chat's edit", async () => {
  const s = await studio();
  try {
    await s.tool('claude:a', 'doc_create', { doc: 'plan', markdown: 'Start.\n' });
    const end = (text: string) => ({ doc: 'plan', ops: [{ op: 'insert', target: { kind: 'root' }, side: 'end', source: inline(text) }] });
    assert((await s.tool('claude:a', 'doc_edit', end('From A.')))[0]);
    assert((await s.tool('claude:b', 'doc_edit', end('From B.')))[0]);
    const doc = s.ctx.docs.get(await docId(s.project, 'plan'))!;
    const words = () => doc.live.topBlocks().map((b) => doc.live.markdownOf(b.id));
    assertEquals(words(), ['Start.', 'From A.', 'From B.']);
    assert((await s.tool('claude:a', 'doc_undo', { doc: 'plan' }))[0]);
    assertEquals(words(), ['Start.', 'From B.']);
    assertEquals((await s.tool('claude:a', 'doc_undo', { doc: 'plan' }))[1].code, 'nothing_to_undo');
    assert((await s.tool('claude:b', 'doc_undo', { doc: 'plan' }))[0]);
    assertEquals(words(), ['Start.']);
  } finally {
    await s.done();
  }
});

Deno.test("an agent's page move and the user's rename at the same time: the user's title stays; an agent rename over it is refused", async () => {
  const s = await studio();
  try {
    await s.tool('claude:a', 'doc_create', { doc: 'plan', markdown: 'One.\n', title: 'Overview' });
    await s.tool('claude:a', 'doc_page', { doc: 'plan', action: 'add', title: 'Risks' });
    await s.tool('claude:a', 'doc_page', { doc: 'plan', action: 'add', title: 'Budget' });
    await s.tool('claude:a', 'doc_read', { doc: 'plan', mode: 'outline' });
    const doc = s.ctx.docs.get(await docId(s.project, 'plan'))!;
    const user = new UserClient(doc.live);
    const risks = doc.live.pageList()[1].id;
    user.holdUp = true; // the user's rename is in flight while the agent moves the page
    user.doc.transact(() => {
      const m = user.doc.getArray<Y.Map<unknown>>('pages').toArray().find((p) => p.get('id') === risks)!;
      m.set('title', 'Risks and fixes');
    }, user.typing);
    assert((await s.tool('claude:a', 'doc_page', { doc: 'plan', action: 'move', page: risks, after: 'Budget' }))[0]);
    user.release();
    assertEquals(doc.live.pageList().map((p) => p.title), ['Overview', 'Budget', 'Risks and fixes']);
    const [ok, refused] = await s.tool('claude:a', 'doc_page', { doc: 'plan', action: 'rename', page: risks, title: 'Risks' });
    assertEquals([ok, refused.code], [false, 'user_renamed']);
    assertEquals(doc.live.pageList()[2].title, 'Risks and fixes');
    doc.live.detach(user.link);
  } finally {
    await s.done();
  }
});

Deno.test('pasted or dropped HTML never carries the agent mark; align and column width render as data attributes (no inline style)', () => {
  assertEquals(schema.marks.agentEdit.spec.parseDOM ?? [], []);
  const para = schema.nodes.paragraph.create({ align: 'center' });
  const out = JSON.stringify(schema.nodes.paragraph.spec.toDOM!(para));
  assert(out.includes('"data-align":"center"') && !out.includes('style'), out);
  const column = schema.nodes.column.create({ width: 0.33 }, schema.nodes.paragraph.create());
  const col = JSON.stringify(schema.nodes.column.spec.toDOM!(column));
  assert(col.includes('"data-w":"35"') && !col.includes('style'), col);
});

Deno.test('the Docs tab list: "Claude Code is writing <section>" while it works, then "edited by Claude Code"; most recent first', async () => {
  const s = await studio();
  try {
    s.chat('c1', 'claude', 'a', '2026-11-11T10:00:00Z');
    await s.ctx.artifacts.refresh();
    await s.call('POST /api/live/docs/open', { id: 'claude:a', name: 'Notes', create: 'Mine.\n' });
    await s.tool('c1', 'doc_create', { doc: 'plan', markdown: '# Overview\n\nAlpha.\n\n## Risks\n\nBeta.\n' });
    const [, read] = await s.tool('c1', 'doc_read', { doc: 'plan' });
    const beta = (read.blocks as { id: string; h: string; md?: string }[]).find((b) => b.md === 'Beta.')!;
    assert((await s.tool('c1', 'doc_edit', {
      doc: 'plan',
      ops: [{ op: 'replace', target: { kind: 'blocks', ids: [beta.id] }, ifHash: beta.h, ifRev: read.rev, with: inline('Beta, rewritten.') }],
    }))[0]);
    const [, listed] = await s.call('GET /api/live/docs/list', null, 'id=claude:a');
    const plan = (listed.docs as Json[]).find((d) => d.name === 'plan')!;
    assertEquals(plan.writing, [{ chat: 'claude:a', name: 'Claude Code', page: 'Page 1', section: 'Risks' }]);
    assertEquals(plan.editedBy, 'Claude Code');
    const notes = (listed.docs as Json[]).find((d) => d.name === 'notes')!;
    assertEquals(notes.writing, []);
    assert(Number(plan.editedAt) >= Number(notes.editedAt), 'the times the tab sorts by');
    // the turn ends: the live line goes
    s.chat('c1', 'claude', 'a', '2026-11-11T10:00:01Z');
    await s.ctx.artifacts.refresh();
    const [, after] = await s.call('GET /api/live/docs/list', null, 'id=claude:a');
    assertEquals((after.docs as Json[]).find((d) => d.name === 'plan')!.writing, []);
  } finally {
    await s.done();
  }
});

Deno.test('"Built from <doc › page>": publish with fromDoc keeps the page and its rev; the page changes; Rebuild = update; the doc chip finds it', async () => {
  const s = await studio();
  configureKeys(s.state);
  s.ctx.gate = new Gate(9, () => 'token');
  try {
    s.chat('c1', 'claude', 'a', null, true);
    await s.ctx.artifacts.refresh();
    await s.tool('c1', 'doc_create', { doc: 'Release plan', markdown: '# Overview\n\nShip it.\n' });
    await s.tool('c1', 'doc_page', { doc: 'release-plan', action: 'add', title: 'Rollout' });
    const doc = s.ctx.docs.get(await docId(s.project, 'release-plan'))!;
    const rollout = doc.live.pageList()[1].id;
    const publish = async (body: Json): Promise<[number, Json]> => {
      const text = JSON.stringify({ conversationId: 'c1', ...body });
      const request = new Request('http://127.0.0.1/api/live/artifacts/publish', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(new TextEncoder().encode(text).length),
          'X-Studio-Artifact-Key': issue('c1')!,
          Host: '127.0.0.1:9',
        },
        body: text,
      });
      const [status, payload] = await ownGatePost(s.ctx, request, new URL(request.url));
      return [status, payload as Json];
    };
    const [st, made] = await publish({ title: 'Checkout v2 timeline', filename: 't.html', content: '<p>25 Nov</p>', fromDoc: { doc: 'Release plan', page: 'rollout' } });
    assertEquals(st, 200, JSON.stringify(made));
    const id = String(made.id);
    const m = s.ctx.artifacts.service.store.get(id);
    assertEquals(m.fromDoc, { doc: 'release-plan', title: 'Release plan', page: rollout, pageTitle: 'Rollout', rev: doc.live.pageRev(rollout).rev });
    assertEquals((s.ctx.artifacts.service.store.list(null) as Json[]).find((a) => a.id === id)!.fromDoc, m.fromDoc, 'the list carries it');
    // a caller cannot plant a resolved link
    const [, other] = await publish({ title: 'x', filename: 'x.html', content: 'x', '\u0000fromDoc': { doc: 'evil' } });
    assertEquals(s.ctx.artifacts.service.store.get(String(other.id)).fromDoc, undefined);
    // a doc or page that is not there is refused, with the doc tools' words
    const [bad, why] = await publish({ title: 'y', filename: 'y.html', content: 'y', fromDoc: { doc: 'release-plan', page: 'Metrics' } });
    assertEquals([bad, why.code], [400, 'no_page']);
    const built = async () => (await s.call('GET /api/live/docs/built', null, `id=claude:a&artifact=${id}`))[1].built as Json;
    assertEquals([(await built()).changed, (await built()).edits, (await built()).pageTitle], [false, 0, 'Rollout']);
    // the user edits the Rollout page twice: the artifact is stale, 2 edits
    const user = new UserClient(doc.live);
    const [, read] = await s.tool('c1', 'doc_read', { doc: 'release-plan', page: 'Rollout' });
    const first = (read.blocks as { id: string }[])[0].id;
    await s.tool('c1', 'doc_edit', { doc: 'release-plan', page: 'Rollout', ops: [{ op: 'insert', target: { kind: 'root' }, side: 'end', source: inline('Web 50%: 27 Nov') }] });
    user.type(first, 0, 'Dates: ');
    const now = await built();
    assertEquals([now.changed, now.edits, now.title, now.pageTitle], [true, 2, 'Release plan', 'Rollout']);
    // an edit on another page does not make it stale; the doc chip lists it
    const [, shown] = await s.call('GET /api/live/docs/shown', null, `doc=${doc.id}`);
    assertEquals((shown.artifacts as Json[]).map((a) => [a.id, a.title, a.pageTitle]), [[id, 'Checkout v2 timeline', 'Rollout']]);
    // Rebuild from the doc: the agent reads the page and updates; the update keeps the link at the page's rev now
    const [up] = await publish({ id, content: '<p>27 Nov</p>' });
    assertEquals(up, 200);
    assertEquals((s.ctx.artifacts.service.store.get(id).fromDoc as Json).rev, doc.live.pageRev(rollout).rev);
    assertEquals((await built()).changed, false);
    // the page goes: the banner says so
    s.ctx.docs.userPageOp(doc, 'delete', { page: rollout });
    assertEquals((await built()).gone, 'page');
  } finally {
    configureKeys(null);
    await s.done();
  }
});

Deno.test('Edit on a Markdown artifact: a doc named after it (" (2)" when taken), linked; update refused became_doc; the live text; Undo while untouched', async () => {
  const s = await studio();
  configureKeys(s.state);
  s.ctx.gate = new Gate(9, () => 'token');
  try {
    s.chat('c1', 'claude', 'a', null, true);
    await s.ctx.artifacts.refresh();
    const publish = async (body: Json): Promise<[number, Json]> => {
      const text = JSON.stringify({ conversationId: 'c1', ...body });
      const request = new Request('http://127.0.0.1/api/live/artifacts/publish', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(new TextEncoder().encode(text).length),
          'X-Studio-Artifact-Key': issue('c1')!,
          Host: '127.0.0.1:9',
        },
        body: text,
      });
      const [status, payload] = await ownGatePost(s.ctx, request, new URL(request.url));
      return [status, payload as Json];
    };
    // a doc of that name exists already: the new one is "Load test summary (2)"
    await s.call('POST /api/live/docs/open', { id: 'claude:a', name: 'Load test summary', create: 'Older.\n' });
    const [, made] = await publish({ title: 'Load test summary', filename: 'summary.md', content: '# Load test\n\np99 latency 412 ms.\n\nCart saturates first.\n' });
    const id = String(made.id);
    const [st, edited] = await s.call('POST /api/live/docs/from-artifact', { id: 'claude:a', artifact: id });
    assertEquals(st, 200, JSON.stringify(edited));
    assertEquals([edited.name, edited.title, edited.dir], ['load-test-summary-2', 'Load test summary (2)', 'aib-docs/load-test-summary-2']);
    assertEquals((edited.blocks as string[]).length, 3, 'the block ids, for the cursor');
    const doc = s.ctx.docs.get(String(edited.doc))!;
    assertEquals(doc.chat, 'claude:a', 'linked to this chat');
    assertEquals(s.ctx.docs.pageMarkdown(doc), '# Load test\n\np99 latency 412 ms.\n\nCart saturates first.\n');
    const store = s.ctx.artifacts.service.store;
    assertEquals(store.get(id).becameDoc, 'load-test-summary-2');
    assertEquals((store.list(null) as Json[]).find((a) => a.id === id)!.becameDoc, 'load-test-summary-2');
    // Edit again: it is a doc already
    assertEquals((await s.call('POST /api/live/docs/from-artifact', { id: 'claude:a', artifact: id }))[1].code, 'became_doc');
    // the agent's next update is refused, naming the doc and the doc tools
    const [refusedStatus, refused] = await publish({ id, content: '# New\n' });
    assertEquals([refusedStatus, refused.code], [409, 'became_doc']);
    assert(String(refused.error).includes('load-test-summary-2') && String(refused.error).includes('doc_edit'));
    assertEquals(store.get(id).versions.length, 1, 'no new version');
    // the viewer shows the doc's text now, and Undo while nobody has changed it
    let [, b] = await s.call('GET /api/live/docs/became', null, `id=claude:a&artifact=${id}`);
    assertEquals([(b.became as Json).undo, (b.became as Json).title], [true, 'Load test summary (2)']);
    const user = new UserClient(doc.live);
    user.type(doc.live.topIds()[1], 0, 'Measured: ');
    [, b] = await s.call('GET /api/live/docs/became', null, `id=claude:a&artifact=${id}`);
    assert(String((b.became as Json).markdown).includes('Measured: p99 latency'), 'the live text');
    assertEquals((b.became as Json).undo, false, 'typed in: no Undo');
    assertEquals((await s.call('POST /api/live/docs/from-artifact/undo', { id: 'claude:a', artifact: id }))[1].code, 'edited');
    assertEquals(store.get(id).becameDoc, 'load-test-summary-2');
    // a second artifact, untouched after Edit: Undo removes the doc and turns it back
    const [, two] = await publish({ title: 'Notes', filename: 'notes.md', content: 'Just notes.\n' });
    const [, e2] = await s.call('POST /api/live/docs/from-artifact', { id: 'claude:a', artifact: two.id });
    assertEquals(e2.name, 'notes');
    assert(await exists(`${s.project}${sep}aib-docs${sep}notes${sep}doc.aibdoc`));
    const [, undone] = await s.call('POST /api/live/docs/from-artifact/undo', { id: 'claude:a', artifact: two.id });
    assertEquals(undone.undone, true);
    assertEquals(await exists(`${s.project}${sep}aib-docs${sep}notes`), false, 'the doc is gone');
    assertEquals(store.get(String(two.id)).becameDoc, undefined);
    assertEquals((await publish({ id: two.id, content: 'Notes again.\n' }))[0], 200, 'an artifact again: update works');
    // an HTML artifact has no Edit
    const [, page] = await publish({ title: 'Page', filename: 'p.html', content: '<p>x</p>' });
    assertEquals((await s.call('POST /api/live/docs/from-artifact', { id: 'claude:a', artifact: page.id }))[1].code, 'not_markdown');
  } finally {
    configureKeys(null);
    await s.done();
  }
});

Deno.test('the turn signal: a turn under 2 s and a cancelled turn both leave the refused note; one made good leaves none; presence and claims go', async () => {
  const s = await studio();
  try {
    s.chat('c1', 'claude', 'a', '2026-11-11T10:00:00Z');
    s.chat('c2', 'codex', 'b', '2026-11-11T10:00:00Z');
    await s.ctx.artifacts.refresh();
    await s.tool('c1', 'doc_create', { doc: 'plan', markdown: 'Alpha.\n\nBeta.\n\nGamma.\n' });
    const doc = s.ctx.docs.get(await docId(s.project, 'plan'))!;
    const user = new UserClient(doc.live);
    const [, read] = await s.tool('c1', 'doc_read', { doc: 'plan' });
    const [alpha, beta, gamma] = read.blocks as { id: string; h: string }[];
    user.type(beta.id, 0, 'User ');
    // claude's guarded rewrite of Beta is refused (the user typed there); its rewrite of Gamma goes through
    const rewrite = (b: { id: string; h: string }, text: string) => ({
      doc: 'plan',
      ops: [{ op: 'replace', target: { kind: 'blocks', ids: [b.id] }, ifHash: b.h, ifRev: read.rev, with: inline(text) }],
    });
    assertEquals((await s.tool('c1', 'doc_edit', rewrite(beta, 'Beta from Claude.')))[1].code, 'guard_mismatch');
    assert((await s.tool('c1', 'doc_edit', rewrite(gamma, 'Gamma from Claude.')))[0]);
    // codex: refused on Alpha, then made good with a find target
    user.type(alpha.id, 0, 'Typed ');
    assertEquals((await s.tool('c2', 'doc_edit', rewrite(alpha, 'Alpha from Codex.')))[1].code, 'guard_mismatch');
    assert((await s.tool('c2', 'doc_edit', { doc: 'plan', ops: [{ op: 'replace', target: { kind: 'blocks', ids: [alpha.id] }, force: true, with: inline('Alpha from Codex.') }] }))[0]);
    assertEquals(presence(s.ctx, doc.id).map((p) => p.name).sort(), ['Claude Code', 'Codex']);
    // claude's turn ended within one poll (its turnEndedAt moved, busy never seen): the refused note goes to the page
    s.chat('c1', 'claude', 'a', '2026-11-11T10:00:01Z');
    await s.ctx.artifacts.refresh();
    const notes = user.control.filter((m) => m.type === 'refused');
    assertEquals(notes.length, 1);
    const note = (notes[0].notes as Json[])[0];
    assertEquals([notes[0].name, note.code, note.wrote, note.blocks], ['Claude Code', 'guard_mismatch', 'Beta from Claude.', [beta.id]]);
    assertEquals(presence(s.ctx, doc.id).map((p) => p.name), ['Codex']);
    assert(user.control.some((m) => m.type === 'history'), 'a history mark for the turn');
    // codex's turn is cancelled (busy, then its turnEndedAt moves): no note, its refusal was made good; its presence goes
    s.chat('c2', 'codex', 'b', '2026-11-11T10:00:00Z', true);
    await s.ctx.artifacts.refresh();
    s.chat('c2', 'codex', 'b', '2026-11-11T10:00:02Z', false);
    await s.ctx.artifacts.refresh();
    assertEquals(user.control.filter((m) => m.type === 'refused').length, 1);
    assertEquals(presence(s.ctx, doc.id), []);
    // a cancelled turn with a refusal still undone: the connection went (closed) before the next poll
    assertEquals((await s.tool('c2', 'doc_edit', rewrite(beta, 'Beta from Codex.')))[1].code, 'guard_mismatch');
    s.connections.splice(1, 1);
    await s.ctx.artifacts.refresh();
    const last = user.control.filter((m) => m.type === 'refused').at(-1)!;
    assertEquals([last.name, (last.notes as Json[])[0].wrote], ['Codex', 'Beta from Codex.']);
    assertEquals((s.ctx.docs.info(doc).notes as Json[]).length, 2);
    assertEquals((await s.call('POST /api/live/docs/notes/dismiss', { doc: doc.id, note: 'all' }))[1].notes, []);
    doc.live.detach(user.link);
  } finally {
    await s.done();
  }
});

Deno.test('claims: shown in the doc state, released by the replacing edit or the turn end; the user takes one back; two chats never share a block', async () => {
  const s = await studio();
  try {
    s.chat('c1', 'claude', 'a', null);
    s.chat('c2', 'codex', 'b', null);
    await s.ctx.artifacts.refresh();
    await s.tool('c1', 'doc_create', { doc: 'plan', markdown: 'Alpha.\n\nBeta.\n\nGamma.\n' });
    const doc = s.ctx.docs.get(await docId(s.project, 'plan'))!;
    const [, read] = await s.tool('c1', 'doc_read', { doc: 'plan' });
    const [alpha, beta, gamma] = read.blocks as { id: string; h: string }[];
    const [ok, claimed] = await s.tool('c1', 'doc_claim', { doc: 'plan', ids: [alpha.id, beta.id], intent: 'tightening the intro', ifRev: read.rev });
    assert(ok, JSON.stringify(claimed));
    // in the Y.Doc (every viewer and a reload see it) and in info, and in the agent's own read
    const claims = () => [...doc.live.doc.getMap('claims').values()] as Json[];
    assertEquals(claims().map((c) => [c.chat, c.name, c.ids, c.intent]), [['claude:a', 'Claude Code', [alpha.id, beta.id], 'tightening the intro']]);
    assertEquals((s.ctx.docs.info(doc).claims as Json[]).length, 1);
    assertEquals(((await s.tool('c1', 'doc_read', { doc: 'plan' }))[1].claims as Json[]).length, 1);
    assertEquals((await s.tool('c2', 'doc_claim', { doc: 'plan', ids: [beta.id, gamma.id], ifRev: read.rev }))[1].code, 'claimed');
    // the replacing edit swaps Alpha in and lets go of it; Beta stays claimed
    const replace = (b: { id: string; h: string }, text: string) => ({
      doc: 'plan',
      ops: [{ op: 'replace', target: { kind: 'blocks', ids: [b.id] }, ifHash: b.h, ifRev: read.rev, with: inline(text) }],
    });
    assert((await s.tool('c1', 'doc_edit', replace(alpha, 'Alpha, tighter.')))[0]);
    assertEquals(claims().map((c) => c.ids), [[beta.id]]);
    // the user: "Stop and keep the text"; the agent's next edit of Beta is refused with the reason, and told once
    assertEquals((await s.call('POST /api/live/docs/claim/release', { doc: doc.id, chat: 'claude:a' }))[0], 200);
    assertEquals(claims(), []);
    const [no, took] = await s.tool('c1', 'doc_edit', replace(beta, 'Beta, tighter.'));
    assertEquals([no, took.code], [false, 'user_took_back']);
    assert(String((took.userNotes as string[])[0]).startsWith('The user stopped your rewrite'));
    assertEquals(doc.live.markdownOf(beta.id), 'Beta.');
    // the turn's end forgets the take-back and drops a claim left standing
    assert((await s.tool('c2', 'doc_claim', { doc: 'plan', ids: [gamma.id], ifRev: read.rev }))[0]);
    s.chat('c2', 'codex', 'b', '2026-11-11T10:00:00Z');
    s.chat('c1', 'claude', 'a', '2026-11-11T10:00:00Z');
    await s.ctx.artifacts.refresh();
    assertEquals(claims(), []);
    assertEquals(presence(s.ctx, doc.id), []);
  } finally {
    await s.done();
  }
});

Deno.test("an agent's page delete waits for the user: Delete snapshots then deletes the page as it stands, Keep tells the chat", async () => {
  const s = await studio();
  try {
    await s.tool('claude:a', 'doc_create', { doc: 'plan', markdown: 'One.\n', title: 'Overview' });
    await s.tool('claude:a', 'doc_page', { doc: 'plan', action: 'add', title: 'Metrics', markdown: 'Agent numbers.' });
    await s.tool('claude:a', 'doc_page', { doc: 'plan', action: 'add', title: 'Scratch', markdown: 'Agent scratch.' });
    const doc = s.ctx.docs.get(await docId(s.project, 'plan'))!;
    const ask = async (page: string) => {
      const [ok, r] = await s.tool('claude:a', 'doc_page', { doc: 'plan', action: 'delete', page, ifRev: doc.live.rev });
      assert(ok && r.pending === true, JSON.stringify(r));
      return r.page as string;
    };
    const metrics = await ask('Metrics');
    const requests = () => [...doc.live.doc.getMap('pageRequests').values()] as Json[];
    assertEquals(requests().map((r) => [r.page, r.chat, r.name, r.title]), [[metrics, 'claude:a', 'Claude Code', 'Metrics']]);
    assertEquals(doc.live.pageList().length, 3);
    // the user typed on the page since: Delete deletes it as it stands, after a history version that has it
    const user = new UserClient(doc.live);
    const block = doc.live.topIds(metrics)[0];
    user.type(block, 0, 'User ');
    const versions = () => (s.ctx.docs.history(doc).versions as Json[]).length;
    const before = versions();
    const [status, done] = await s.call('POST /api/live/docs/page/request', { doc: doc.id, page: metrics, decision: 'delete' });
    assertEquals([status, (done.pages as Json[]).map((p) => p.title)], [200, ['Overview', 'Scratch']]);
    assertEquals(versions(), before + 1);
    const last = s.ctx.docs.readVersion(doc, before + 1);
    assert(last.includes('User Agent numbers.'), 'the snapshot holds the page with the user\'s words');
    assertEquals(requests(), []);
    // Keep: the page stays, the chat hears it in its next doc result
    const scratch = await ask('Scratch');
    assertEquals((await s.call('POST /api/live/docs/page/request', { doc: doc.id, page: scratch, decision: 'keep' }))[0], 200);
    const [, next] = await s.tool('claude:a', 'doc_read', { doc: 'plan', mode: 'outline' });
    assertEquals(next.userNotes, ['The user kept page "Scratch": do not delete it.']);
    assertEquals(doc.live.pageList().map((p) => p.title), ['Overview', 'Scratch']);
    doc.live.detach(user.link);
  } finally {
    await s.done();
  }
});

Deno.test('history for the page: authors by name, pages changed; restore is refused while keystrokes are in flight or an agent writes', async () => {
  const s = await studio();
  try {
    s.chat('c1', 'claude', 'a', null);
    await s.ctx.artifacts.refresh();
    await s.tool('c1', 'doc_create', { doc: 'plan', markdown: 'First words.\n' });
    const doc = s.ctx.docs.get(await docId(s.project, 'plan'))!;
    await s.tool('c1', 'doc_edit', { doc: 'plan', ops: [{ op: 'insert', target: { kind: 'root' }, side: 'end', source: inline('Agent words.') }] });
    s.ctx.docs.snapshot(doc);
    const [, history] = await s.call('GET /api/live/docs/history', null, `doc=${doc.id}`);
    const newest = (history.versions as Json[])[0];
    assertEquals([newest.authors, (newest.pages as Json[]).map((p) => p.change)], [['Claude Code'], ['changed']]);
    const [, version] = await s.call('GET /api/live/docs/history/version', null, `doc=${doc.id}&n=1`);
    assertEquals(((version.pages as Json[])[0].nodes as Json[]).length, 1);
    // an agent is writing (its presence is up): refused, with its name
    const [busy, writing] = await s.call('POST /api/live/docs/history/restore', { doc: doc.id, version: 1 });
    assertEquals([busy, writing.code, writing.error], [409, 'agent_writing', 'Claude Code is still writing: nothing was restored. Restore once it stops.']);
    s.chat('c1', 'claude', 'a', '2026-11-11T10:00:00Z');
    await s.ctx.artifacts.refresh();
    // the user's keystrokes have not reached the server yet: refused
    const user = new UserClient(doc.live);
    user.holdUp = true;
    user.type(doc.live.topIds()[0], 0, 'Held ');
    const clock = Y.decodeStateVector(Y.encodeStateVector(user.doc)).get(user.doc.clientID)!;
    const body = { doc: doc.id, version: 1, client: user.doc.clientID, clock };
    assertEquals((await s.call('POST /api/live/docs/history/restore', body))[1].code, 'in_flight');
    user.release();
    const [ok, restored] = await s.call('POST /api/live/docs/history/restore', body);
    assertEquals([ok, restored.restored], [200, 1]);
    assertEquals(doc.live.topBlocks().map((b) => doc.live.markdownOf(b.id)), ['First words.']);
    doc.live.detach(user.link);
  } finally {
    await s.done();
  }
});

Deno.test('the user through the server: page add/rename/move/duplicate, comments, chart from a table; Markdown export never overwrites', async () => {
  const s = await studio();
  const downloads = await temp('aib-downloads-');
  Deno.env.set('AIB_DOWNLOADS_DIR', downloads);
  try {
    const [, made] = await s.call('POST /api/live/docs/open', { id: 'claude:a', name: 'Plan', create: 'Intro.\n\n| Q | Sales |\n| --- | --- |\n| Q1 | 3 |\n' });
    const doc = s.ctx.docs.get(String(made.doc))!;
    const page = (body: Json) => s.call('POST /api/live/docs/page', { doc: doc.id, ...body });
    const added = (await page({ action: 'add', title: 'Risks' }))[1];
    await page({ action: 'rename', page: added.page, title: 'Open risks' });
    await page({ action: 'move', page: added.page, index: 0 });
    await page({ action: 'duplicate', page: 'p1' });
    assertEquals(doc.live.pageList().map((p) => p.title), ['Open risks', 'Page 1', 'Page 1 (copy)']);
    const [, thread] = await s.call('POST /api/live/docs/comment', { doc: doc.id, action: 'add', text: 'Why?', block: doc.live.topIds('p1')[0], from: 0, to: 5 });
    assertEquals([thread.quote, thread.by], ['Intro', 'user']);
    await s.call('POST /api/live/docs/comment', { doc: doc.id, action: 'resolve', thread: thread.thread });
    assertEquals((await s.call('POST /api/live/docs/comment', { doc: doc.id, action: 'reopen', thread: thread.thread }))[1].resolved, false);
    const table = doc.live.topIds('p1')[1];
    const [status, chart] = await s.call('POST /api/live/docs/edit', { doc: doc.id, page: 'p1', ops: [{ op: 'chart_from_table', target: { kind: 'blocks', ids: [table] } }] });
    assertEquals(status, 200, JSON.stringify(chart));
    assertEquals(doc.live.topBlocks('p1').map((b) => b.node.type), ['paragraph', 'table', 'chart']);
    const first = (await s.call('POST /api/live/docs/export', { doc: doc.id, scope: 'all' }))[1];
    const second = (await s.call('POST /api/live/docs/export', { doc: doc.id, scope: 'all' }))[1];
    const one = (await s.call('POST /api/live/docs/export', { doc: doc.id, scope: 'page', page: 'Open risks' }))[1];
    assertEquals([first.name, second.name, one.name], ['Plan.md', 'Plan (2).md', 'Plan - Open risks.md']);
    assertEquals(first.path, `${downloads}${sep}Plan.md`);
    assert((await Deno.readTextFile(String(first.path))).startsWith('# Open risks'));
  } finally {
    Deno.env.delete('AIB_DOWNLOADS_DIR');
    await Deno.remove(downloads, { recursive: true }).catch(() => {});
    await s.done();
  }
});

Deno.test('Changes and Merge: a doc is one row; doc histories stay out of the Artifacts list', async () => {
  const root = await temp('aib-rows-');
  try {
    await Deno.mkdir(`${root}${sep}aib-docs${sep}plan`, { recursive: true });
    await Deno.writeTextFile(`${root}${sep}aib-docs${sep}plan${sep}doc.aibdoc`, JSON.stringify({ title: 'Release plan' }));
    const rows = docRows(root, [
      'aib-docs/plan/doc.aibdoc',
      'aib-docs/plan/01-overview.md',
      'aib-docs/plan/02-risks.md',
      'aib-docs/README.md',
      'docs/plan/01-overview.md',
      'src/a.ts',
    ]);
    assertEquals(rows, [{
      doc: 'plan',
      dir: 'aib-docs/plan',
      title: 'Release plan',
      pages: 2,
      paths: ['aib-docs/plan/doc.aibdoc', 'aib-docs/plan/01-overview.md', 'aib-docs/plan/02-risks.md'],
    }]);
    assert(isDocHistory({ conversationId: null, sourcePath: null, entry: 'plan.aibdoc.json', versions: [] }));
    assert(isDocHistory({ conversationId: null, sourcePath: null, entry: 'plan.md', versions: [{ note: 'rev 3' }] }));
    assert(!isDocHistory({ conversationId: 'claude:a', sourcePath: null, entry: 'x.aibdoc.json', versions: [] }));
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

/** The page's socket client: y-protocols sync, AIB's control messages kept. */
function connect(port: number, doc: string, token: string, epoch?: string) {
  const ydoc = new Y.Doc();
  const q = epoch ? `&epoch=${epoch}` : '';
  // @ts-ignore: Deno's WebSocket takes headers
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/live/docs/socket?doc=${doc}${q}`, {
    protocols: ['aib-docs', 'aib-token.' + token],
    headers: { Origin: `http://127.0.0.1:${port}` },
  });
  ws.binaryType = 'arraybuffer';
  const control: Json[] = [];
  const send = (build: (e: encoding.Encoder) => void) => {
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, 0);
    build(e);
    if (ws.readyState === 1) ws.send(encoding.toUint8Array(e));
  };
  ydoc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== ws) send((e) => syncProtocol.writeUpdate(e, update));
  });
  ws.onopen = () => send((e) => syncProtocol.writeSyncStep1(e, ydoc));
  ws.onmessage = (event) => {
    if (typeof event.data === 'string') return void control.push(JSON.parse(event.data));
    const d = decoding.createDecoder(new Uint8Array(event.data as ArrayBuffer));
    if (decoding.readVarUint(d) !== 0) return;
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, 0);
    syncProtocol.readSyncMessage(d, e, ydoc, ws);
    if (encoding.length(e) > 1) ws.send(encoding.toUint8Array(e));
  };
  const closed = new Promise<CloseEvent>((r) => ws.addEventListener('close', (e) => r(e as CloseEvent)));
  return { ydoc, ws, control, closed, blocks: () => ydoc.getXmlFragment(FIELD).length };
}

async function until(check: () => boolean, what: string): Promise<void> {
  const end = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function server(stateDir: string) {
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
  const web = new WebServer(ctx);
  const port = await web.listen(0);
  return { ctx, port, web };
}

Deno.test('the socket epoch: after a restart with the cache gone the old page is told to re-open, and the doc has no duplicate blocks', async () => {
  const root = await temp('aib-epoch-');
  const project = `${root}${sep}project`;
  await Deno.mkdir(project);
  let one: Awaited<ReturnType<typeof server>> | null = await server(`${root}${sep}state1`);
  let two: Awaited<ReturnType<typeof server>> | null = null;
  try {
    const doc = await one.ctx.docs.open(project, 'plan', 'One.\n\nTwo.\n');
    const page = connect(one.port, doc.id, one.ctx.token, doc.epoch);
    await until(() => page.blocks() === 2, 'the first sync');
    assertEquals(page.control[0], { type: 'hello', epoch: doc.epoch, rev: doc.live.rev, doc: doc.id });
    // a doc that is not open: told on the socket, not a 404 loop
    const stray = connect(one.port, 'nope', one.ctx.token);
    await stray.closed;
    assertEquals(stray.control, [{ type: 'reopen', reason: 'doc_not_open' }]);
    await one.web.close();
    await page.closed;
    one = null;
    // AIB restarts with another state folder (the cache is gone): the doc is rebuilt from doc.aibdoc, a new epoch
    two = await server(`${root}${sep}state2`);
    const again = await two.ctx.docs.open(project, 'plan');
    assert(again.epoch !== doc.epoch);
    const old = connect(two.port, again.id, two.ctx.token, doc.epoch);
    await old.closed;
    assertEquals(old.control, [{ type: 'reopen', reason: 'epoch', epoch: again.epoch }]);
    const fresh = connect(two.port, again.id, two.ctx.token, again.epoch);
    await until(() => fresh.blocks() === 2, 'the fresh sync');
    await new Promise((r) => setTimeout(r, 50));
    assertEquals(again.live.topBlocks().map((b) => again.live.markdownOf(b.id)), ['One.', 'Two.']);
    fresh.ws.close();
    await fresh.closed;
  } finally {
    await one?.web.close();
    await two?.web.close();
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test('the drawing page has its own route and CSP; every other page keeps the strict one', async () => {
  const root = await temp('aib-drawing-');
  const s = await server(root);
  try {
    const get = (path: string) => fetch(`http://127.0.0.1:${s.port}${path}`);
    const page = await get('/doc-drawing.html');
    const html = await page.text();
    const csp = page.headers.get('Content-Security-Policy')!;
    assert(csp.includes("'wasm-unsafe-eval'") && csp.includes('worker-src') && csp.includes('blob:'), csp);
    assert(!/<script>/.test(html) && html.includes('/doc-drawing-boot.js'), 'no inline script');
    const boot = await get('/doc-drawing-boot.js');
    assert((await boot.text()).includes('EXCALIDRAW_ASSET_PATH'));
    const docPage = await get('/doc.html');
    await docPage.body?.cancel();
    const strict = docPage.headers.get('Content-Security-Policy')!;
    assert(!strict.includes('wasm-unsafe-eval') && !strict.includes('worker-src') && strict.includes("script-src 'self';"), strict);
  } finally {
    await s.web.close();
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});
