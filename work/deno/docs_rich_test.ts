/**
 * Rich blocks Markdown can't hold (schema.ts): callouts, columns, toggles, text colour and highlight, alignment, merged cells and
 * header columns. doc.aibdoc keeps every one exactly; the .md copy gets a readable fallback and is flagged lossy; a .md edit to a rich
 * block is skipped and flagged (edit it with the doc tools) while plain blocks still take file edits; agents read nested blocks with
 * their own ids and edit them with the same guards: the user typing in a callout, or in a cell, wins over an agent's stale call.
 */
import { assert, assertEquals } from './_assert.ts';
import { DocRefusal, LiveDoc } from '../../outputs/agent-studio/server/docs/live_doc.ts';
import { normalize, type PMJson, richOf, writeDoc } from '../../outputs/agent-studio/server/docs/markdown.ts';
import { buildFromAib, contentOf, exportAib, IdMap, parseAib, stringifyAib, versionAib } from '../../outputs/agent-studio/server/docs/aibdoc.ts';
import { ArtifactHistory } from '../../outputs/agent-studio/server/docs/history.ts';
import { ArtifactStore } from '../../outputs/agent-studio/server/artifacts/artifacts.ts';
import { DocStore, mdBody, RICH_NOTE } from '../../outputs/agent-studio/server/docs/store.ts';
import { runDocTool } from '../../outputs/agent-studio/server/docs/tools.ts';
import { UserClient } from './_docs.ts';

type Json = Record<string, unknown>;
type View = { id: string; h: string; md?: string; type: string; kids?: string[]; parent?: string; by?: string; attrs?: Json; styles?: Json[] };
const sep = Deno.build.os === 'windows' ? '\\' : '/';

const t = (text: string, ...marks: PMJson['marks'] & unknown[]): PMJson => ({ type: 'text', text, ...(marks.length ? { marks } : {}) });
const p = (...content: PMJson[]): PMJson => (content.length ? { type: 'paragraph', content } : { type: 'paragraph' });
const cell = (type: string, text: string, attrs: Json = {}): PMJson => ({ type, attrs, content: [p(t(text))] });
const bold = { type: 'bold' };

/** One of each: aligned heading and paragraph, colour and highlight, three callouts, columns, a toggle, a merged table. */
const RICH: PMJson[] = [
  { type: 'heading', attrs: { level: 1, align: 'center' }, content: [t('Risks')] },
  {
    type: 'paragraph',
    attrs: { align: 'right' },
    content: [t('Plain '), t('red', { type: 'textColor', attrs: { color: 'red' } }), t(' and '), t('marked', { type: 'highlight', attrs: { color: 'pink' } })],
  },
  { type: 'callout', attrs: { variant: 'info' }, content: [p(t('Everything ships behind the flag.'))] },
  {
    type: 'callout',
    attrs: { variant: 'warning' },
    content: [
      p(t('Apple Pay shows the old total.')),
      { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('Check on a device'))] }] },
      { type: 'codeBlock', attrs: { language: 'sh' }, content: [t('make test')] },
    ],
  },
  { type: 'callout', attrs: { variant: 'success' }, content: [p(t('Load test passed.'))] },
  {
    type: 'columns',
    content: [
      { type: 'column', attrs: { width: 0.4 }, content: [p(t('Old form', bold)), p(t('Card errors 0.6%'))] },
      { type: 'column', attrs: { width: 0.6 }, content: [p(t('Checkout v2', bold)), { type: 'callout', attrs: { variant: 'info' }, content: [p(t('Staff only'))] }] },
    ],
  },
  {
    type: 'toggle',
    content: [
      p(t('Rollback steps')),
      { type: 'orderedList', attrs: { start: 1 }, content: [{ type: 'listItem', content: [p(t('Turn it off'))] }] },
      p(t('Keep the dashboard open.')),
    ],
  },
  {
    type: 'table',
    content: [
      { type: 'tableRow', content: [cell('tableHeader', 'Stage'), cell('tableHeader', 'Traffic', { colspan: 2 })] },
      { type: 'tableRow', content: [cell('tableHeader', 'Staff'), cell('tableCell', '100%', { align: 'center' }), cell('tableCell', 'staff')] },
      { type: 'tableRow', content: [cell('tableHeader', 'Payments', { rowspan: 2 }), cell('tableCell', '5%'), cell('tableCell', 'random')] },
      { type: 'tableRow', content: [cell('tableCell', '50%'), cell('tableCell', 'everyone')] },
    ],
  },
];

const FALLBACK = [
  '# Risks',
  'Plain red and marked',
  '> **Note:** Everything ships behind the flag.',
  '> **Warning:** Apple Pay shows the old total.\n>\n> - Check on a device\n>\n> ```sh\n> make test\n> ```',
  '> **Done:** Load test passed.',
  '**Old form**\n\nCard errors 0.6%\n\n**Checkout v2**\n\n> **Note:** Staff only',
  '**Rollback steps**\n\n1. Turn it off\n\nKeep the dashboard open.',
  '| Stage | Traffic | Traffic |\n| --- | --- | --- |\n| Staff | 100% | staff |\n| Payments | 5% | random |\n| Payments | 50% | everyone |',
];

function richDoc(): LiveDoc {
  const live = new LiveDoc();
  live.replaceAll(RICH, live.system);
  return live;
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

const blocks = (live: LiveDoc): View[] => (live.read() as { blocks: View[] }).blocks;
const inline = (content: unknown, as = 'markdown') => ({ from: { kind: 'inline', content }, as });

Deno.test('doc.aibdoc round-trips every rich block and mark exactly, nested block ids included', () => {
  const live = richDoc();
  assertEquals(contentOf(live, live.firstPage), RICH.map(normalize));
  const ids = new IdMap();
  const text = stringifyAib(exportAib(live, 'Rich', ids));
  const built = buildFromAib(parseAib(text), 1);
  const back = new LiveDoc(built.state, built.meta);
  assertEquals(contentOf(back, back.firstPage), RICH.map(normalize));
  assertEquals(stringifyAib(exportAib(back, 'Rich', built.ids)), text, 'the same file again, ids and all');
  // a block inside a column inside columns has its own id in the file
  const file = parseAib(text).pages[0].content;
  const column = (file[5].content as { id?: string; content?: { id?: string }[] }[])[1];
  assert(column.id && column.content![1].id, 'columns, a column and the callout in it carry ids');
  // and the open/closed state of a toggle is nowhere in the doc
  assert(!text.includes('"open"'), 'no open/closed in the file');
});

Deno.test('the Markdown copy is a readable fallback for each rich block, and every rich block is flagged lossy', () => {
  const live = richDoc();
  const w = writeDoc(live.topBlocks(), {}, '\n', '\n');
  assertEquals(w.text, FALLBACK.join('\n\n') + '\n');
  assertEquals(w.lossy, live.topIds(), 'all eight are lossy');
  // written again from that map: still flagged (the copy keeps its text)
  assertEquals(writeDoc(live.topBlocks(), w.map, '\n', '\n').lossy, live.topIds());
  // a plain block is not
  const plain = new LiveDoc();
  plain.replaceAll([p(t('Just words.')), { type: 'heading', attrs: { level: 2 }, content: [t('Head')] }], plain.system);
  assertEquals(writeDoc(plain.topBlocks(), {}, '\n', '\n').lossy, []);
});

Deno.test('the page bundle reads a rich doc exactly as the server has it', async () => {
  await import(new URL('../../outputs/agent-studio/vendor/docs/editor.js', import.meta.url).href);
  const page = (globalThis as unknown as { AIBDocEditor: { docJSON(u: Uint8Array): PMJson; encode(j: PMJson): Uint8Array } }).AIBDocEditor;
  const live = richDoc();
  const server = { type: 'doc', content: contentOf(live, live.firstPage) };
  assertEquals(page.docJSON(live.encode()), server);
  const back = new LiveDoc(page.encode(server));
  assertEquals(contentOf(back, back.firstPage), server.content);
});

Deno.test('doc_read: nested blocks with ids, callout variant, column widths, cell spans, alignment and colours', () => {
  const live = richDoc();
  const all = blocks(live);
  const callout = all.find((b) => b.type === 'callout' && b.attrs?.variant === 'warning')!;
  assertEquals(callout.kids!.length, 3);
  const inside = all.filter((b) => b.parent === callout.id).map((b) => b.type);
  assertEquals(inside, ['paragraph', 'bulletList', 'codeBlock']);
  assertEquals(all.filter((b) => b.type === 'column').map((b) => b.attrs?.width), [0.4, 0.6]);
  assertEquals(all.find((b) => b.type === 'tableHeader' && b.attrs?.colspan)!.attrs, { colspan: 2 });
  assertEquals(all.find((b) => b.type === 'heading')!.attrs, { align: 'center' });
  const para = all[1];
  assertEquals(para.attrs, { align: 'right' });
  assertEquals(para.styles, [{ from: 6, to: 9, color: 'red' }, { from: 14, to: 20, highlight: 'pink' }]);
  const block = live.read({ mode: 'block', id: callout.id }) as { md: string; blocks: View[] };
  assertEquals(block.md, FALLBACK[3]);
  assertEquals(block.blocks.length, 5); // paragraph, list, item, its paragraph, code
  // find works inside a toggle and a column
  assertEquals((live.read({ query: 'dashboard' }) as { hits: View[] }).hits.length, 1);
});

Deno.test('agents insert callouts (alert Markdown), toggles and columns (blocks with md), restyle words, align, with guards', () => {
  const live = new LiveDoc();
  const claude = live.originFor('agent', 'claude');
  live.replaceAll([p(t('Intro.'))], live.system);
  const intro = blocks(live)[0];
  const ack = live.edit([
    { op: 'insert', target: { kind: 'blocks', ids: [intro.id] }, side: 'after', source: inline('> [!WARNING]\n> Apple Pay shows the old total.') },
    {
      op: 'insert',
      target: { kind: 'root' },
      side: 'end',
      source: inline([
        { type: 'toggle', summary: 'Rollback steps', md: '1. Turn it off\n2. Post in #payments' },
        { type: 'columns', content: [{ type: 'column', md: '**Old**\n\n- slow' }, { type: 'column', md: '> [!SUCCESS]\n> Fast' }] },
      ], 'blocks'),
    },
  ], claude) as { created: string[] };
  assertEquals(ack.created.length, 3);
  const top = live.topBlocks().map((b) => b.node);
  assertEquals(top[1].type, 'callout');
  assertEquals(top[1].attrs?.variant, 'warning');
  assertEquals(top[1].content![0].content![0].marks, [{ type: 'agentEdit', attrs: { by: 'claude' } }], "the agent's words carry its mark");
  assertEquals(top[2].type, 'toggle');
  assertEquals(top[3].content![1].content![0].type, 'callout');
  // colour on words (find, no guard), on a block (guarded), alignment by set
  live.edit([{ op: 'style', target: { kind: 'find', text: 'old total' }, color: 'red', highlight: 'yellow' }], claude);
  const para = blocks(live).find((b) => b.md === 'Apple Pay shows the old total.')!;
  assertEquals(para.styles, [{ from: 20, to: 29, color: 'red', highlight: 'yellow' }]);
  assertEquals(para.md, 'Apple Pay shows the old total.', 'the words did not change');
  assertEquals(refusal(() => live.edit([{ op: 'style', target: { kind: 'blocks', ids: [intro.id] }, color: 'red' }], claude)).code, 'missing_guard');
  assertEquals(refusal(() => live.edit([{ op: 'style', target: { kind: 'find', text: 'Intro' }, color: 'teal' }], claude)).code, 'bad_op');
  assertEquals(refusal(() => live.edit([{ op: 'style', target: { kind: 'find', text: 'Intro' }, highlight: 'blue' }], claude)).code, 'bad_op');
  const r = live.read() as { rev: number; blocks: View[] };
  const i0 = r.blocks[0];
  live.edit([
    { op: 'style', target: { kind: 'blocks', ids: [i0.id] }, ifHash: i0.h, ifRev: r.rev, color: 'grey' },
    { op: 'set', target: { kind: 'blocks', ids: [i0.id] }, ifHash: i0.h, ifRev: r.rev, attrs: { align: 'center' } },
  ], claude);
  assertEquals(blocks(live)[0].attrs, { align: 'center' });
  assertEquals(blocks(live)[0].styles, [{ from: 0, to: 6, color: 'grey' }]);
  // callout type by set; a callout in a callout is refused; columns only at the top
  const r2 = live.read() as { rev: number; blocks: View[] };
  const c = r2.blocks.find((b) => b.type === 'callout' && !b.parent)!;
  live.edit([{ op: 'set', target: { kind: 'blocks', ids: [c.id] }, ifHash: c.h, ifRev: r2.rev, attrs: { variant: 'success' } }], claude);
  assertEquals(live.topBlocks()[1].node.attrs?.variant, 'success');
  const nested = refusal(() =>
    live.edit([{ op: 'insert', target: { kind: 'blocks', ids: [c.id] }, side: 'end', source: inline('> [!NOTE]\n> inner') }], claude)
  );
  assertEquals(nested.code, 'bad_op');
  const viaList = refusal(() =>
    live.edit([{ op: 'insert', target: { kind: 'blocks', ids: [c.id] }, side: 'end', source: inline([{ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph' }, { type: 'callout', md: 'x' }] }] }], 'blocks') }], claude)
  );
  assert(viaList.message.includes('callout'), viaList.message);
  const toggle = live.topIds()[2];
  assertEquals(
    refusal(() => live.edit([{ op: 'insert', target: { kind: 'blocks', ids: [toggle] }, side: 'end', source: inline([{ type: 'columns', content: [{ type: 'column', md: 'a' }, { type: 'column', md: 'b' }] }], 'blocks') }], claude)).code,
    'bad_op',
  );
  // "start" in a toggle goes under its line
  live.edit([{ op: 'insert', target: { kind: 'blocks', ids: [toggle] }, side: 'start', source: inline('First, warn on-call.') }], claude);
  assertEquals(live.topBlocks()[2].node.content!.map((n) => n.type), ['paragraph', 'paragraph', 'orderedList']);
  // a third column; a fourth is refused
  const cols = live.topIds()[3];
  live.edit([{ op: 'insert', target: { kind: 'blocks', ids: [cols] }, side: 'end', source: inline('Third') }], claude);
  assertEquals(live.topBlocks()[3].node.content!.length, 3);
  assertEquals(refusal(() => live.edit([{ op: 'insert', target: { kind: 'blocks', ids: [cols] }, side: 'end', source: inline('Fourth') }], claude)).code, 'bad_op');
  // doc_undo takes back the agent's last call
  live.undo(claude);
  assertEquals(live.topBlocks()[3].node.content!.length, 2);
});

Deno.test("the user types inside a callout while the agent rewrites the same callout: refused, and the user's text survives", () => {
  const live = richDoc();
  const user = new UserClient(live);
  const claude = live.originFor('agent', 'claude');
  const read = live.read() as { rev: number; blocks: View[] };
  const callout = read.blocks.find((b) => b.type === 'callout' && b.attrs?.variant === 'warning')!;
  const para = read.blocks.find((b) => b.parent === callout.id && b.type === 'paragraph')!;
  user.holdUp = true;
  user.type(para.id, 'Apple Pay'.length, ' (iOS 17)');
  user.release();
  const rewrite = {
    op: 'replace',
    target: { kind: 'blocks', ids: [callout.id] },
    ifHash: callout.h,
    ifRev: read.rev,
    with: inline('> [!WARNING]\n> Apple Pay is fine now.'),
  };
  const refused = refusal(() => live.edit([rewrite], claude));
  assertEquals(refused.code, 'guard_mismatch');
  assert(String((refused.toJSON().block as View).md).includes('Apple Pay (iOS 17) shows the old total.'));
  assertEquals(user.text(para.id), 'Apple Pay (iOS 17) shows the old total.');
  // the inner paragraph's own guard too; delete of the callout as well
  assertEquals(refusal(() => live.edit([{ ...rewrite, target: { kind: 'blocks', ids: [para.id] }, ifHash: para.h, with: inline('x', 'text') }], claude)).code, 'guard_mismatch');
  assertEquals(refusal(() => live.edit([{ op: 'delete', target: { kind: 'blocks', ids: [callout.id] }, ifHash: callout.h, ifRev: read.rev }], claude)).code, 'guard_mismatch');
  // from what stands, the rewrite goes through and keeps the callout (in place: the list and the code keep their ids)
  const now = live.read() as { rev: number; blocks: View[] };
  const c2 = now.blocks.find((b) => b.id === callout.id)!;
  live.edit([{ ...rewrite, ifHash: c2.h, ifRev: now.rev, with: inline('> [!WARNING]\n> Apple Pay (iOS 17) is fine now.\n>\n> - Check on a device\n>\n> ```sh\n> make test\n> ```') }], claude);
  const after = blocks(live).find((b) => b.id === callout.id)!;
  assertEquals(after.kids!.slice(1), c2.kids!.slice(1));
  assertEquals(blocks(live).find((b) => b.id === after.kids![0])!.md, 'Apple Pay (iOS 17) is fine now.');
  // re-wording words inside a column with a find target needs no guard
  live.edit([{ op: 'replace', target: { kind: 'find', text: 'Card errors 0.6%' }, with: inline('Card errors 0.5%', 'text') }], claude);
  assert(blocks(live).some((b) => b.md === 'Card errors 0.5%'));
  live.detach(user.link);
});

Deno.test('merge and split cells, header row and column; merging cells the user is editing is refused', () => {
  const live = new LiveDoc();
  const claude = live.originFor('agent', 'claude');
  live.replaceAll([{
    type: 'table',
    content: [
      { type: 'tableRow', content: [cell('tableHeader', 'A'), cell('tableHeader', 'B'), cell('tableHeader', 'C')] },
      { type: 'tableRow', content: [cell('tableCell', 'a1'), cell('tableCell', 'b1'), cell('tableCell', 'c1')] },
      { type: 'tableRow', content: [cell('tableCell', 'a2'), cell('tableCell', 'b2'), cell('tableCell', 'c2')] },
    ],
  }], live.system);
  const user = new UserClient(live);
  const read = live.read() as { rev: number; blocks: View[] };
  const table = read.blocks[0];
  const b1 = read.blocks.find((b) => b.md === 'b1')!;
  user.type(b1.id, 2, ' (edited)');
  const merge = { op: 'table_merge', target: { kind: 'blocks', ids: [table.id] }, cells: [[1, 1], [2, 2]], ifRev: read.rev };
  const refused = refusal(() => live.edit([merge], claude));
  assertEquals(refused.code, 'guard_mismatch');
  assertEquals(user.text(b1.id), 'b1 (edited)');
  assertEquals(refusal(() => live.edit([{ ...merge, ifRev: undefined }], claude)).code, 'missing_guard');
  // cells away from the user's edit merge on the same stale read
  live.edit([{ ...merge, cells: [[1, 0], [2, 0]] }], claude);
  let node = live.topBlocks()[0].node;
  assertEquals(node.content![1].content![0].attrs?.rowspan, 2);
  assertEquals(node.content![1].content![0].content!.map((n) => n.content![0].text), ['a1', 'a2'], 'both values kept');
  assertEquals(node.content![2].content!.length, 2);
  assertEquals(
    writeDoc(live.topBlocks(), {}, '\n', '\n').text,
    '| A | B | C |\n| --- | --- | --- |\n| a1 a2 | b1 (edited) | c1 |\n| a1 a2 | b2 | c2 |\n',
  );
  assertEquals(user.text(b1.id), 'b1 (edited)', "the user's cell kept its words (and its id)");
  // a box that cuts a merged cell, row/col ops on a merged table: refused
  const r2 = live.read() as { rev: number };
  assertEquals(refusal(() => live.edit([{ ...merge, cells: [[2, 0], [2, 1]], ifRev: r2.rev }], claude)).code, 'bad_op');
  assertEquals(refusal(() => live.edit([{ op: 'table_row_insert', target: { kind: 'blocks', ids: [table.id] }, cells: ['x'] }], claude)).code, 'bad_op');
  // split it back: the second square is empty
  live.edit([{ op: 'table_split', target: { kind: 'blocks', ids: [table.id] }, at: [2, 0], ifRev: r2.rev }], claude);
  node = live.topBlocks()[0].node;
  assertEquals(node.content!.map((r) => r.content!.length), [3, 3, 3]);
  assertEquals(node.content![2].content![0].content, [{ type: 'paragraph', attrs: { align: null } }]);
  // header column on, header row off
  const r3 = live.read() as { rev: number };
  live.edit([{ op: 'table_header', target: { kind: 'blocks', ids: [table.id] }, row: false, col: true, ifRev: r3.rev }], claude);
  node = live.topBlocks()[0].node;
  assertEquals(node.content!.map((r) => r.content!.map((c) => c.type === 'tableHeader' ? 'H' : 'c').join('')), ['Hcc', 'Hcc', 'Hcc']);
  assertEquals(user.text(b1.id), 'b1 (edited)');
  live.detach(user.link);
});

Deno.test('a .md edit to a callout is skipped and flagged (use the doc tools), while a plain paragraph edit applies', async () => {
  const root = Deno.realPathSync(await Deno.makeTempDir({ prefix: 'aib-rich-' })).replace(/^\\\\\?\\/, '');
  const store = new DocStore(`${root}${sep}state`, { idleMs: 60_000 });
  const project = `${root}${sep}project`;
  await Deno.mkdir(`${project}${sep}docs`, { recursive: true });
  try {
    const [ok] = await runDocTool(store, project, 'claude', 'doc_create', {
      doc: 'plan',
      markdown: 'Intro words.\n\n> [!WARNING]\n> Apple Pay shows the old total.\n\nBudget is tight.\n',
    });
    assert(ok);
    const doc = await store.open(project, 'plan');
    await store.flush(doc);
    const path = `${doc.dir}${sep}01-page-1.md`;
    const text = await Deno.readTextFile(path);
    assertEquals(mdBody(text), 'Intro words.\n\n> **Warning:** Apple Pay shows the old total.\n\nBudget is tight.\n');
    assertEquals(doc.lossy, [doc.live.topIds()[1]]);
    await Deno.writeTextFile(path, text.replace('shows the old total', 'is fixed').replace('Budget is tight.', 'Budget is fine.'));
    const skipped = await store.syncMirror(doc);
    assertEquals(skipped.map((s) => [s.reason, s.id, s.source]), [['rich_block', doc.live.topIds()[1], 'md']]);
    assertEquals(skipped[0].note, RICH_NOTE);
    assertEquals(skipped[0].file, '> **Warning:** Apple Pay is fixed.');
    assertEquals(doc.live.topBlocks().map((b) => b.node.type), ['paragraph', 'callout', 'paragraph']);
    assertEquals(doc.live.markdownOf(doc.live.topIds()[2]), 'Budget is fine.');
    assertEquals(doc.live.markdownOf(doc.live.topIds()[1]), '> **Warning:** Apple Pay shows the old total.');
    // the copy is written back from the doc: the callout's fallback as it stands, the plain edit kept
    assertEquals(mdBody(await Deno.readTextFile(path)), 'Intro words.\n\n> **Warning:** Apple Pay shows the old total.\n\nBudget is fine.\n');
    // the agent sees it on its next call
    const [, read] = await runDocTool(store, project, 'claude', 'doc_read', { doc: 'plan' });
    assertEquals((read.fileEditsSkipped as { reason: string }[]).map((s) => s.reason), ['rich_block']);
    // deleting the callout in the .md is skipped too
    await Deno.writeTextFile(path, (await Deno.readTextFile(path)).replace('> **Warning:** Apple Pay shows the old total.\n\n', ''));
    assertEquals((await store.syncMirror(doc)).map((s) => s.reason), ['rich_block']);
    assertEquals(doc.live.topBlocks().length, 3);
  } finally {
    await store.close();
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

async function richStore() {
  const root = Deno.realPathSync(await Deno.makeTempDir({ prefix: 'aib-rich-' })).replace(/^\\\\\?\\/, '');
  const artifacts = new ArtifactStore(`${root}${sep}artifacts`);
  const history = new ArtifactHistory(() => artifacts);
  const store = new DocStore(`${root}${sep}state`, { idleMs: 60_000, snapshotIdleMs: 60_000, history });
  const project = `${root}${sep}project`;
  await Deno.mkdir(`${project}${sep}docs`, { recursive: true });
  return { store, project, history, done: async () => (await store.close(), await Deno.remove(root, { recursive: true }).catch(() => {})) };
}

const pagesOf = (text: string) => parseAib(text).pages;
const blocksOf = (live: LiveDoc, page?: string): View[] => (live.read({ page }) as { blocks: View[] }).blocks;

async function refusedRestore(store: DocStore, doc: Awaited<ReturnType<DocStore['open']>>, n: number, page: string): Promise<DocRefusal> {
  try {
    await store.restore(doc, n, doc.live.rev, doc.live.originFor('agent', 'claude'), page);
  } catch (error) {
    if (error instanceof DocRefusal) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

Deno.test('history keeps the whole doc.aibdoc: a version with a callout, colours and a merged table restores exactly, whole doc and one page', async () => {
  const s = await richStore();
  try {
    const doc = await s.store.open(s.project, 'plan', 'Start.\n');
    const live = doc.live;
    const claude = live.originFor('agent', 'claude');
    live.replaceAll(RICH, claude);
    const notes = live.addPage('Notes', claude, { markdown: 'A note.' }).page as string;
    live.comments.add('user', 'Which device?', live.range({ kind: 'find', text: 'old total' }), live.system);
    await s.store.flush(doc);
    const n = s.store.snapshot(doc)!;
    const version = s.store.versionText(doc, n);
    assertEquals(version, await Deno.readTextFile(doc.file), 'the version is the doc.aibdoc as written');
    assert(versionAib(version) !== null);
    const want = contentOf(live, live.firstPage);
    assert(JSON.stringify(want).includes('"textColor"') && JSON.stringify(want).includes('"colspan":2'));
    assert(s.store.readVersion(doc, n).includes('> **Warning:** Apple Pay shows the old total.'), 'agents read it as Markdown');
    // everything changes: callout words, colours off, the merged cell split, page 2
    const change = () => {
      const r = live.read() as { rev: number; blocks: View[] };
      const table = r.blocks.find((b) => b.type === 'table')!;
      live.edit([
        { op: 'replace', target: { kind: 'find', text: 'Apple Pay shows the old total.' }, with: inline('Fixed.', 'text'), allowDetach: true },
        { op: 'style', target: { kind: 'find', text: 'red' }, color: null },
        { op: 'table_split', target: { kind: 'blocks', ids: [table.id] }, at: [0, 1], ifRev: r.rev },
      ], claude);
      live.edit([{ op: 'replace', target: { kind: 'find', text: 'A note.' }, with: inline('Changed note.', 'text') }], claude, notes);
    };
    change();
    assert(JSON.stringify(contentOf(live, live.firstPage)) !== JSON.stringify(want));
    // the whole doc
    await s.store.restore(doc, n, live.rev, claude);
    assertEquals(contentOf(live, live.firstPage), want);
    assertEquals(blocksOf(live, notes).map((b) => b.md), ['A note.']);
    const thread = live.comments.list().threads[0] as { quote?: string; detached?: boolean };
    assertEquals([thread.quote, thread.detached], ['old total', undefined]);
    assertEquals(pagesOf(await Deno.readTextFile(doc.file)), pagesOf(version), 'doc.aibdoc pages exactly as in the version, block ids too');
    // one page: page 1 comes back, page 2 keeps what it has now
    change();
    await s.store.restore(doc, n, live.rev, claude, 'Page 1');
    assertEquals(contentOf(live, live.firstPage), want);
    assertEquals(blocksOf(live, notes).map((b) => b.md), ['Changed note.']);
    assertEquals(pagesOf(await Deno.readTextFile(doc.file))[0], pagesOf(version)[0]);
    // a page deleted since comes back where it stood
    live.deletePage(notes, claude, { ifRev: live.rev, allowUserContent: true });
    const back = await s.store.restore(doc, n, live.rev, claude, 'Notes');
    assertEquals(live.pageList().map((p) => p.title), ['Page 1', 'Notes']);
    assertEquals(blocksOf(live, back.page).map((b) => b.md), ['A note.']);
    assertEquals((await refusedRestore(s.store, doc, n, 'Nope')).code, 'no_page');
  } finally {
    await s.done();
  }
});

Deno.test('an old Markdown history version still restores (whole doc and one page)', async () => {
  const s = await richStore();
  try {
    const doc = await s.store.open(s.project, 'plan', '# Plan\n\nFirst.\n');
    const live = doc.live;
    const claude = live.originFor('agent', 'claude');
    s.store.snapshot(doc);
    const notes = live.addPage('Notes', claude, { markdown: 'Note.' }).page as string;
    const md = `<!-- aib:page {"id":"p1","title":"Page 1"} -->\n\n# Plan\n\nOld words.\n\n<!-- aib:page {"id":"${notes}","title":"Notes"} -->\n\nOld note.\n`;
    const n = s.history.snapshot(doc, md, 'user', `rev ${live.rev}`, 'md')!;
    assertEquals(s.store.readVersion(doc, n), md);
    await s.store.restore(doc, n, live.rev, claude, 'Notes');
    assertEquals(blocksOf(live, notes).map((b) => b.md), ['Old note.']);
    assertEquals(blocksOf(live).map((b) => b.md), ['# Plan', 'First.']);
    await s.store.restore(doc, n, live.rev, claude);
    assertEquals(blocksOf(live).map((b) => b.md), ['# Plan', 'Old words.']);
  } finally {
    await s.done();
  }
});

Deno.test('a plain table (header row, column alignment) is not rich: .md edits to it apply; one without a header row is skipped', async () => {
  const s = await richStore();
  try {
    await runDocTool(s.store, s.project, 'claude', 'doc_create', { doc: 'plan', markdown: '| A | B |\n| :--- | ---: |\n| 1 | 2 |\n' });
    const doc = await s.store.open(s.project, 'plan');
    const live = doc.live;
    await s.store.flush(doc);
    assertEquals(doc.lossy, []);
    const path = `${doc.dir}${sep}01-page-1.md`;
    await Deno.writeTextFile(path, (await Deno.readTextFile(path)).replace('| 1 | 2 |', '| 1 | 3 |\n| 4 | 5 |'));
    assertEquals(await s.store.syncMirror(doc), []);
    assertEquals(live.markdownOf(live.topIds()[0]), '| A | B |\n| :--- | ---: |\n| 1 | 3 |\n| 4 | 5 |');
    // header row off: Markdown can't say that, so the table is rich and a .md edit to it is skipped
    const r = live.read() as { rev: number };
    live.edit([{ op: 'table_header', target: { kind: 'blocks', ids: [live.topIds()[0]] }, row: false, ifRev: r.rev }], live.originFor('agent', 'claude'));
    await s.store.flush(doc);
    assertEquals(doc.lossy, live.topIds());
    await Deno.writeTextFile(path, (await Deno.readTextFile(path)).replace('| 4 | 5 |', '| 4 | 6 |'));
    assertEquals((await s.store.syncMirror(doc)).map((x) => x.reason), ['rich_block']);
    assert(live.markdownOf(live.topIds()[0]).includes('| 4 | 5 |'));
    // a single cell aligned apart from its column is rich too
    const table = live.topBlocks()[0].node;
    const withHeader = (t: PMJson): PMJson => ({
      ...t,
      content: t.content!.map((row, k) => (k ? row : { ...row, content: row.content!.map((c) => ({ ...c, type: 'tableHeader' })) })),
    });
    const lone: PMJson = {
      ...table,
      content: table.content!.map((row, k) =>
        k !== 1 ? row : { ...row, content: row.content!.map((c, i) => (i ? c : { ...c, attrs: { ...c.attrs, align: 'center' } })) }
      ),
    };
    assertEquals([richOf(withHeader(table)), richOf(withHeader(lone))], [false, true]);
  } finally {
    await s.done();
  }
});
