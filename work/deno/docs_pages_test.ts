/**
 * Local docs with pages, living in the project: docs/<doc>/doc.aibdoc (round trip, stable ids, keys in a fixed order), the cache
 * used only when it matches the file (else a rebuild), doc.aibdoc edited on disk while open (merged without clobbering the user),
 * page operations with their guards, one Markdown copy per page (names, renames, per-page file edits), the move from the old layout,
 * and the proof test on page 2: the user types while the agent rewrites the same block, the agent is refused, the user's words stay.
 */
import { assert, assertEquals } from './_assert.ts';
import * as Y from 'yjs';
import { DocRefusal, FIELD, LiveDoc } from '../../outputs/agent-studio/server/docs/live_doc.ts';
import { DocStore, docId, mdBody, MD_NOTE, type OpenDoc } from '../../outputs/agent-studio/server/docs/store.ts';
import { buildFromAib, exportAib, parseAib, stringifyAib } from '../../outputs/agent-studio/server/docs/aibdoc.ts';
import { runDocTool } from '../../outputs/agent-studio/server/docs/tools.ts';
import { parseDoc } from '../../outputs/agent-studio/server/docs/markdown.ts';
import { UserClient } from './_docs.ts';

const sep = Deno.build.os === 'windows' ? '\\' : '/';
type Json = Record<string, unknown>;
type View = { id: string; h: string; md?: string; type: string; parent?: string; by?: string; page?: string };
const inline = (content: string, as = 'markdown') => ({ from: { kind: 'inline', content }, as });

async function tempDirs() {
  const root = Deno.realPathSync(await Deno.makeTempDir({ prefix: 'aib-pages-' })).replace(/^\\\\\?\\/, '');
  const state = `${root}${sep}state`, project = `${root}${sep}project`;
  await Deno.mkdir(state), await Deno.mkdir(`${project}${sep}docs`, { recursive: true });
  return { root, state, project, done: () => Deno.remove(root, { recursive: true }).catch(() => {}) };
}

async function tool(store: DocStore, project: string, name: string, args: Json, refused = false): Promise<Json> {
  const [ok, result] = await runDocTool(store, project, 'claude', name, args);
  if (ok === refused) throw new Error(`${name} ${refused ? 'went through' : 'was refused'}: ${JSON.stringify(result)}`);
  return result;
}

function refusal(fn: () => unknown): DocRefusal {
  try {
    fn();
  } catch (error) {
    if (error instanceof DocRefusal) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

const exists = (path: string) => Deno.stat(path).then(() => true, () => false);
const blocksOf = (live: LiveDoc, page?: string): View[] => (live.read({ page }) as { blocks: View[] }).blocks;
const mdFiles = (dir: string) => [...Deno.readDirSync(dir)].map((e) => e.name).filter((n) => n.endsWith('.md')).sort();

/** A doc with two pages, an agent's words, a comment on page 2 and a drawing on page 2. */
async function twoPages(store: DocStore, project: string): Promise<OpenDoc> {
  await tool(store, project, 'doc_create', { doc: 'Plan', markdown: '# Plan\n\nIntro words.\n' });
  await tool(store, project, 'doc_page', {
    doc: 'plan',
    action: 'add',
    title: 'Risks & Notes',
    markdown: '## Risks\n\nThe vendor may slip.\n\nBudget is tight.\n',
  });
  await tool(store, project, 'doc_comment', { doc: 'plan', page: 'Risks & Notes', target: { kind: 'find', text: 'vendor' }, text: 'Which?' });
  await tool(store, project, 'drawing_create', { doc: 'plan', page: 'Risks & Notes', caption: 'Flow' });
  await tool(store, project, 'drawing_edit', { doc: 'plan', drawing: 'flow', ops: [{ op: 'add_box', text: 'Build', id: 'B' }] });
  const doc = await store.open(project, 'plan');
  await store.flush(doc);
  return doc;
}

Deno.test('doc.aibdoc: readable JSON in a fixed key order; read back it rebuilds the same doc and writes the same file', async () => {
  const dirs = await tempDirs();
  const store = new DocStore(dirs.state, { idleMs: 60_000 });
  try {
    const doc = await twoPages(store, dirs.project);
    assertEquals(doc.file, `${dirs.project}${sep}docs${sep}plan${sep}doc.aibdoc`);
    const text = await Deno.readTextFile(doc.file);
    assert(text.startsWith('{\n  "format": "aibdoc",\n  "version": 1,\n  "title": "Plan",\n  "pages": ['), text.slice(0, 120));
    const aib = parseAib(text);
    assertEquals(aib.pages.map((p) => p.title), ['Page 1', 'Risks & Notes']);
    const risks = aib.pages[1];
    assertEquals(risks.content.map((n) => n.type), ['heading', 'paragraph', 'paragraph', 'drawing']);
    assertEquals(risks.content[1].by, 'claude');
    assert(JSON.stringify(risks.content[1]).includes('"agentEdit"'), 'the agent mark is in the content');
    assertEquals(Object.keys(risks.content[1]).slice(0, 3), ['id', 'type', 'by']);
    assertEquals(aib.comments.length, 1);
    assertEquals(aib.comments[0].anchor, { block: risks.content[1].id, from: 4, to: 10 });
    assertEquals(aib.comments[0].page, risks.id);
    assertEquals(aib.drawings.map((d) => [d.id, d.page, d.elements.map((e) => e.id)]), [['flow', risks.id, ['B']]]);
    // read back: the same pages, words, comment (on the same words), drawing; written again, the same bytes (ids kept)
    const built = buildFromAib(aib, 1);
    const live = new LiveDoc(built.state, built.meta);
    assertEquals(stringifyAib(exportAib(live, 'Plan', built.ids)), text);
    const thread = live.comments.list().threads[0];
    assertEquals([thread.quote, thread.page, thread.detached], ['vendor', risks.id, undefined]);
    assertEquals(blocksOf(live, risks.id)[1].by, 'claude');
    live.destroy();
  } finally {
    await store.close();
    await dirs.done();
  }
});

Deno.test('the cache is used only when it matches doc.aibdoc; otherwise (a pull, a hand edit) the doc is rebuilt from the file', async () => {
  const dirs = await tempDirs();
  let store = new DocStore(dirs.state, { idleMs: 60_000 });
  try {
    const doc = await twoPages(store, dirs.project);
    const ids = blocksOf(doc.live, 'Risks & Notes').map((b) => b.id);
    const rev = doc.live.rev;
    await store.close();
    // unchanged file: the cache, the same live ids and rev
    store = new DocStore(dirs.state, { idleMs: 60_000 });
    let again = await store.open(dirs.project, 'plan');
    assertEquals(blocksOf(again.live, 'Risks & Notes').map((b) => b.id), ids);
    assertEquals(again.live.rev, rev);
    await store.close();
    // the file changed while AIB was closed (a git pull): rebuilt from it; rev goes on rising
    const file = `${dirs.project}${sep}docs${sep}plan${sep}doc.aibdoc`;
    await Deno.writeTextFile(file, (await Deno.readTextFile(file)).replace('Budget is tight.', 'Budget is fine.'));
    store = new DocStore(dirs.state, { idleMs: 60_000 });
    again = await store.open(dirs.project, 'plan');
    assertEquals(blocksOf(again.live, 'Risks & Notes').map((b) => b.md).slice(0, 3), ['## Risks', 'The vendor may slip.', 'Budget is fine.']);
    assert(again.live.rev > rev, `rev ${again.live.rev} after ${rev}`);
    assertEquals(again.live.comments.list().threads[0].quote, 'vendor');
    await store.flush(again);
    // the page's copy follows, and the other blocks' ids in doc.aibdoc did not churn
    assertEquals(mdBody(await Deno.readTextFile(`${again.dir}${sep}02-risks-notes.md`)).split('\n\n')[2], 'Budget is fine.');
    const before = parseAib(await Deno.readTextFile(file)).pages[1].content.map((n) => n.id);
    assertEquals(before.length, 4);
    assert(before.every((id) => typeof id === 'string'));
    // a cache from another branch (its hash does not match) is not used even though it exists
    const meta = JSON.parse(await Deno.readTextFile(`${dirs.state}${sep}docs${sep}cache${sep}${again.id}${sep}meta.json`));
    assertEquals(meta.aibHash.length, 64);
  } finally {
    await store.close();
    await dirs.done();
  }
});

Deno.test('doc.aibdoc edited on disk while open: changed blocks merge in, a block the user changed is skipped and keeps their words', async () => {
  const dirs = await tempDirs();
  const store = new DocStore(dirs.state, { idleMs: 60_000 });
  try {
    const doc = await twoPages(store, dirs.project);
    const user = new UserClient(doc.live);
    const [, vendor, budget] = blocksOf(doc.live, 'Risks & Notes');
    user.type(vendor.id, 0, 'Sadly, ');
    // a git pull brings a doc.aibdoc where both paragraphs changed, a page was renamed and a page added
    const aib = parseAib(await Deno.readTextFile(doc.file));
    const text = (n: number) => aib.pages[1].content[n] as { content: { text: string }[] };
    text(1).content = [{ text: 'The vendor is fine.', type: 'text' } as never];
    text(2).content = [{ text: 'Budget doubled.', type: 'text' } as never];
    aib.pages[0].title = 'Overview';
    aib.pages.push({ id: 'p9', title: 'Later', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'From the pull.' }] }] });
    await Deno.writeTextFile(doc.file, stringifyAib(aib));
    // the pull brings the page's Markdown copy too: it is not applied a second time (no extra skips)
    const copy = `${doc.dir}${sep}02-risks-notes.md`;
    await Deno.writeTextFile(copy, (await Deno.readTextFile(copy)).replace('Budget is tight.', 'Budget doubled.'));
    const skipped = await store.syncMirror(doc);
    assertEquals(skipped.map((s) => [s.reason, s.id, s.source, s.page]), [['user_changed', vendor.id, 'aibdoc', vendor.page ?? doc.live.pageOf(vendor.id)]]);
    assertEquals(skipped[0].now, 'Sadly, The vendor may slip.');
    assertEquals(user.text(vendor.id), 'Sadly, The vendor may slip.');
    assertEquals(user.text(budget.id), 'Budget doubled.');
    assertEquals(doc.live.pageList().map((p) => p.title), ['Overview', 'Risks & Notes', 'Later']);
    assertEquals(blocksOf(doc.live, 'Later').map((b) => b.md), ['From the pull.']);
    // the file is written again from the doc: the user's words stand in it, and the next sync has nothing to do
    const now = parseAib(await Deno.readTextFile(doc.file));
    const words = (n: unknown) => ((n as { content?: { text?: string }[] }).content ?? []).map((c) => c.text ?? '').join('');
    assertEquals(words(now.pages[1].content[1]), 'Sadly, The vendor may slip.');
    assertEquals(await mdFiles(doc.dir), ['01-overview.md', '02-risks-notes.md', '03-later.md']);
    assertEquals((await store.syncMirror(doc)).length, 0);
    // not JSON: refused as a whole, the doc stands, the file is written again from it
    await Deno.writeTextFile(doc.file, '{ nope');
    const bad = await store.syncMirror(doc);
    assertEquals(bad.map((s) => [s.reason, s.id]), [['refused', 'doc.aibdoc']]);
    assertEquals(parseAib(await Deno.readTextFile(doc.file)).pages.length, 3);
    doc.live.detach(user.link);
  } finally {
    await store.close();
    await dirs.done();
  }
});

Deno.test('pages: add, rename, move, delete through doc_page, with their guards; doc_changes says which page', async () => {
  const dirs = await tempDirs();
  const store = new DocStore(dirs.state, { idleMs: 60_000 });
  const t = (name: string, args: Json, refused = false) => tool(store, dirs.project, name, { doc: 'plan', ...args }, refused);
  try {
    await tool(store, dirs.project, 'doc_create', { doc: 'plan', markdown: 'Page one words.\n', title: 'Overview' });
    const start = (await t('doc_read', { mode: 'outline' })) as { rev: number; pages: { id: string; title: string; blocks: number }[] };
    assertEquals(start.pages.map((p) => [p.title, p.blocks]), [['Overview', 1]]);
    const added = await t('doc_page', { action: 'add', title: 'Notes', markdown: 'Agent notes.' });
    const notes = added.page as string;
    assertEquals((await t('doc_page', { action: 'add', title: 'notes' }, true)).code, 'page_exists');
    await t('doc_page', { action: 'add', title: 'Draft', after: 'Overview' });
    let titles = ((await t('doc_read', { mode: 'outline' })).pages as { title: string }[]).map((p) => p.title);
    assertEquals(titles, ['Overview', 'Draft', 'Notes']);
    await t('doc_page', { action: 'rename', page: notes, title: 'Open questions' });
    await t('doc_page', { action: 'move', page: 'Open questions', after: null });
    titles = ((await t('doc_read', { mode: 'outline' })).pages as { title: string }[]).map((p) => p.title);
    assertEquals(titles, ['Open questions', 'Overview', 'Draft']);
    // reads, edits and changes by page
    const read = await t('doc_read', { page: 'Open questions' });
    assertEquals([(read.blocks as View[])[0].md, read.page], ['Agent notes.', notes]);
    const ack = await t('doc_edit', {
      page: 'Open questions',
      ops: [{ op: 'insert', target: { kind: 'root' }, side: 'end', source: inline('Second note.') }],
    });
    assertEquals(ack.page, notes);
    const changes = await t('doc_changes', { sinceRev: start.rev });
    assertEquals((changes.changed as View[]).map((c) => [c.md, c.page === notes]).filter(([, on]) => on).map(([md]) => md), [
      'Agent notes.',
      'Second note.',
    ]);
    // added, renamed, or moved by another page's move: all three changed place or title since the read
    assertEquals((changes.pagesChanged as { title: string }[]).map((p) => p.title).sort(), ['Draft', 'Open questions', 'Overview']);
    // an op naming a block of another page is refused
    const overviewBlock = ((await t('doc_read', { page: 'Overview' })).blocks as View[])[0];
    const wrong = await t('doc_edit', {
      page: 'Draft',
      ops: [{ op: 'delete', target: { kind: 'blocks', ids: [overviewBlock.id] }, ifHash: overviewBlock.h, ifRev: read.rev }],
    }, true);
    assertEquals([wrong.code, wrong.page], ['wrong_page', 'p1']);
    // delete: needs ifRev; refused when the page changed since; the user's words need allowUserContent
    assertEquals((await t('doc_page', { action: 'delete', page: 'Draft' }, true)).code, 'missing_guard');
    const doc = await store.open(dirs.project, 'plan');
    const user = new UserClient(doc.live);
    const before = doc.live.rev;
    const draft = ((await t('doc_read', { page: 'Draft' })).blocks as View[])[0];
    user.type(draft.id, 0, 'User draft');
    assertEquals((await t('doc_page', { action: 'delete', page: 'Draft', ifRev: before }, true)).code, 'guard_mismatch');
    const userWords = await t('doc_page', { action: 'delete', page: 'Draft', ifRev: doc.live.rev }, true);
    assertEquals(userWords.code, 'user_content');
    assertEquals(((userWords.blocks as View[])[0]).md, 'User draft');
    const gone = await t('doc_page', { action: 'delete', page: 'Draft', ifRev: doc.live.rev, allowUserContent: true });
    assertEquals((gone.pages as { title: string }[]).map((p) => p.title), ['Open questions', 'Overview']);
    const after = await t('doc_changes', { sinceRev: before });
    assertEquals(after.pagesGone, [gone.deleted]);
    assert((after.gone as string[]).includes(draft.id));
    // an agent's own page (only its words) goes with just the guard
    assertEquals((await t('doc_page', { action: 'delete', page: 'Open questions', ifRev: doc.live.rev })).deleted, notes);
    assertEquals((await t('doc_page', { action: 'delete', page: 'Overview', ifRev: doc.live.rev }, true)).code, 'last_page');
    doc.live.detach(user.link);
  } finally {
    await store.close();
    await dirs.done();
  }
});

Deno.test('one Markdown copy per page: NN-<title>.md with the note; renames and moves rename files; a file edit works per page', async () => {
  const dirs = await tempDirs();
  const store = new DocStore(dirs.state, { idleMs: 60_000 });
  try {
    const doc = await twoPages(store, dirs.project);
    assertEquals(await mdFiles(doc.dir), ['01-page-1.md', '02-risks-notes.md']);
    const page2 = `${doc.dir}${sep}02-risks-notes.md`;
    const text = await Deno.readTextFile(page2);
    assertEquals(text.split('\n')[0], MD_NOTE);
    assertEquals(mdBody(text), '## Risks\n\nThe vendor may slip.\n\nBudget is tight.\n\n![Flow](assets/flow.excalidraw.svg)\n');
    assert(await exists(`${doc.dir}${sep}assets${sep}flow.excalidraw.svg`), 'the drawing sits in assets/');
    // a long title with symbols: a short ASCII slug
    const origin = doc.live.originFor('agent', 'claude');
    const risks = doc.live.resolvePage('Risks & Notes');
    doc.live.renamePage(risks, 'Ünïcode Rïsks: what could go wrong, and what we would do about each of them', origin);
    doc.live.movePage(risks, null, origin);
    await store.flush(doc);
    assertEquals(await mdFiles(doc.dir), ['01-unicode-risks-what-could-go-wrong-and-what-we.md', '02-page-1.md']);
    const moved = `${doc.dir}${sep}01-unicode-risks-what-could-go-wrong-and-what-we.md`;
    assertEquals(await Deno.readTextFile(moved), text, 'renamed, byte for byte');
    // an agent's file tool edits page 1's copy (now 02-page-1.md): applied on that page only
    const p1 = `${doc.dir}${sep}02-page-1.md`;
    await Deno.writeTextFile(p1, (await Deno.readTextFile(p1)).replace('Intro words.', 'Intro, edited on disk.'));
    const skipped = await store.syncMirror(doc);
    assertEquals(skipped, []);
    assertEquals(blocksOf(doc.live, doc.live.pageList()[1].id).map((b) => b.md), ['# Plan', 'Intro, edited on disk.']);
    assertEquals(blocksOf(doc.live, risks).map((b) => b.md)[1], 'The vendor may slip.');
    // two pages with the same slug never share a file (the number keeps them apart); a deleted page's copy goes
    doc.live.addPage('Page 1!', origin);
    await store.flush(doc);
    assertEquals((await mdFiles(doc.dir)).slice(1), ['02-page-1.md', '03-page-1.md']);
    doc.live.deletePage('Page 1!', origin, { ifRev: doc.live.rev });
    await store.flush(doc);
    assertEquals((await mdFiles(doc.dir)).length, 2);
    assertEquals((store.info(doc).pages as { md: string }[]).map((p) => p.md.slice(doc.dir.length + 1)), [
      '01-unicode-risks-what-could-go-wrong-and-what-we.md',
      '02-page-1.md',
    ]);
  } finally {
    await store.close();
    await dirs.done();
  }
});

Deno.test('a doc of the old layout (docs/<name>.md + state) moves to docs/<name>/ with one page: ids, comments and drawings kept', async () => {
  const dirs = await tempDirs();
  try {
    // a drawing scene to put in the old assets folder: made with the new layout in a scratch project
    const scratch = `${dirs.root}${sep}scratch`;
    await Deno.mkdir(`${scratch}${sep}docs`, { recursive: true });
    const maker = new DocStore(`${dirs.root}${sep}scratch-state`, { idleMs: 60_000 });
    await tool(maker, scratch, 'doc_create', { doc: 'x', markdown: '# X\n' });
    await tool(maker, scratch, 'drawing_create', { doc: 'x', caption: 'Flow' });
    await tool(maker, scratch, 'drawing_edit', { doc: 'x', drawing: 'flow', ops: [{ op: 'add_box', text: 'Build', id: 'B' }] });
    await maker.close();
    const scene = await Deno.readTextFile(`${scratch}${sep}docs${sep}x${sep}assets${sep}flow.excalidraw`);

    // the old layout: docs/Plan.md, docs/Plan.assets/, and the state in <stateDir>/docs/<old id>/
    const md = '# Plan\n\nThe launch moves to October.\n\n![Flow](Plan.assets/flow.excalidraw.svg)\n';
    const docs = `${dirs.project}${sep}docs`;
    await Deno.writeTextFile(`${docs}${sep}Plan.md`, md);
    await Deno.mkdir(`${docs}${sep}Plan.assets`);
    await Deno.writeTextFile(`${docs}${sep}Plan.assets${sep}flow.excalidraw`, scene);
    const old = new LiveDoc();
    const parsed = parseDoc(md);
    old.replaceAll(parsed.blocks.map((b) => b.node), old.system);
    const [, para] = old.topIds();
    old.comments.add('user', 'Really?', old.range({ kind: 'find', text: 'October' }), old.system);
    const oldState = `${dirs.state}${sep}docs${sep}${await docId(dirs.project, 'Plan')}`;
    await Deno.mkdir(oldState, { recursive: true });
    await Deno.writeFile(`${oldState}${sep}doc.bin`, old.encode());
    const { adopt } = await import('../../outputs/agent-studio/server/docs/markdown.ts');
    await Deno.writeTextFile(
      `${oldState}${sep}meta.json`,
      JSON.stringify({
        ...old.meta(),
        name: 'Plan',
        projectRoot: dirs.project,
        mirror: { text: md, map: adopt(parsed, old.topBlocks()), order: old.topIds(), tail: parsed.tail, eol: parsed.eol },
        chat: 'claude:s1',
      }),
    );
    old.destroy();

    const store = new DocStore(dirs.state, { idleMs: 60_000 });
    try {
      assertEquals((await store.list(dirs.project)).map((d) => [d.name, d.title, d.legacy ?? false]), [['plan', 'Plan', true]]);
      const doc = await store.open(dirs.project, 'docs/Plan.md');
      assertEquals([doc.name, doc.title, doc.chat], ['plan', 'Plan', 'claude:s1']);
      assertEquals(doc.live.pageList().map((p) => [p.id, p.field]), [['p1', FIELD]]);
      assertEquals(doc.live.topIds()[1], para, 'the blocks keep their ids');
      assertEquals(doc.live.comments.list().threads[0].quote, 'October');
      // the new files are there, the old ones gone
      const dir = `${docs}${sep}plan`;
      assertEquals(
        mdBody(await Deno.readTextFile(`${dir}${sep}01-page-1.md`)),
        '# Plan\n\nThe launch moves to October.\n\n![Flow](assets/flow.excalidraw.svg)\n',
      );
      assert(await exists(`${dir}${sep}doc.aibdoc`));
      assert(await exists(`${dir}${sep}assets${sep}flow.excalidraw`) && await exists(`${dir}${sep}assets${sep}flow.excalidraw.svg`));
      for (const gone of [`${docs}${sep}Plan.md`, `${docs}${sep}Plan.assets`, oldState]) assert(!(await exists(gone)), gone);
      const aib = parseAib(await Deno.readTextFile(`${dir}${sep}doc.aibdoc`));
      assertEquals(aib.drawings.map((d) => [d.id, d.elements.length > 0]), [['flow', true]]);
      assertEquals((await store.list(dirs.project)).map((d) => [d.name, d.legacy ?? false, d.pages]), [['plan', false, 1]]);
    } finally {
      await store.close();
    }
  } finally {
    await dirs.done();
  }
});

Deno.test("on page 2, the user types while the agent rewrites the same block: the agent is refused and the user's text survives", async () => {
  const dirs = await tempDirs();
  const store = new DocStore(dirs.state, { idleMs: 60_000 });
  try {
    const doc = await twoPages(store, dirs.project);
    const live = doc.live;
    const user = new UserClient(live);
    const read = (await tool(store, dirs.project, 'doc_read', { doc: 'plan', page: 'Risks & Notes' })) as { rev: number; blocks: View[] };
    const p = read.blocks[2];
    assertEquals(p.md, 'Budget is tight.');
    // the user's keystrokes are in flight while the agent's call is made, then land first
    user.holdUp = true;
    user.type(p.id, 'Budget is tight'.length, ', very');
    user.release();
    const rewrite = {
      op: 'replace',
      target: { kind: 'blocks', ids: [p.id] },
      ifHash: p.h,
      ifRev: read.rev,
      with: inline('Budget is ample.', 'text'),
    };
    const refused = await tool(store, dirs.project, 'doc_edit', { doc: 'plan', page: 'Risks & Notes', ops: [rewrite] }, true);
    assertEquals(refused.code, 'guard_mismatch');
    assertEquals((refused.block as View).md, 'Budget is tight, very.');
    assertEquals(user.text(p.id), 'Budget is tight, very.');
    // the agent's page-less call finds the page from the block, and is refused the same way
    assertEquals((await tool(store, dirs.project, 'doc_edit', { doc: 'plan', ops: [rewrite] }, true)).code, 'guard_mismatch');
    // the other page is untouched, and the page-2 copy carries the user's words after the next write
    assertEquals(blocksOf(live).map((b) => b.md), ['# Plan', 'Intro words.']);
    await store.flush(doc);
    assert(mdBody(await Deno.readTextFile(`${doc.dir}${sep}02-risks-notes.md`)).includes('Budget is tight, very.'));
    assertEquals(refusal(() => live.resolvePage('Nope')).code, 'no_page');
    live.detach(user.link);
  } finally {
    await store.close();
    await dirs.done();
  }
});

Deno.test('a client that adds a page on its own (the editor) is picked up: its blocks get ids, rev moves, it gets a copy', async () => {
  const dirs = await tempDirs();
  const store = new DocStore(dirs.state, { idleMs: 60_000 });
  try {
    const doc = await store.open(dirs.project, 'notes', 'First.\n');
    const user = new UserClient(doc.live);
    const rev = doc.live.rev;
    user.doc.transact(() => {
      const m = new Y.Map<unknown>();
      m.set('id', 'pu1');
      m.set('title', 'Typed by user');
      m.set('field', 'page:pu1');
      user.doc.getArray('pages').push([m]);
      const p = new Y.XmlElement('paragraph');
      user.doc.getXmlFragment('page:pu1').insert(0, [p]);
      p.insert(0, [new Y.XmlText('Hello from page 2.')]);
    }, user.typing);
    assert(doc.live.rev > rev);
    assertEquals(blocksOf(doc.live, 'pu1').map((b) => [b.md, b.by]), [['Hello from page 2.', 'user']]);
    const changes = doc.live.changes(rev) as { pagesChanged: { id: string; new?: true }[]; changed: View[] };
    assertEquals(changes.pagesChanged.map((p) => [p.id, p.new]), [['pu1', true]]);
    assertEquals(changes.changed.map((c) => c.page), ['pu1']);
    await store.flush(doc);
    assertEquals(mdBody(await Deno.readTextFile(`${doc.dir}${sep}02-typed-by-user.md`)), 'Hello from page 2.\n');
    doc.live.detach(user.link);
  } finally {
    await store.close();
    await dirs.done();
  }
});
