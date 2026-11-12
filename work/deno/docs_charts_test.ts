/**
 * Charts (schema.ts `chart`, server/docs/charts.ts): a bar or line chart that owns its numbers in a small table inside the block.
 * doc.aibdoc keeps it exactly (history restore too); the .md copy gets its picture (assets/<chart>.chart.svg, drawn by the server)
 * plus the numbers as a table, flagged lossy, and a .md edit to it is skipped (rich_block). "Make chart from this table" copies once.
 * Every number is a cell with its own guard: the user's number wins over an agent's stale edit of the same cell, while the agent's
 * edits to other cells land, marked as the agent's (the page tints them).
 */
import { assert, assertEquals } from './_assert.ts';
import { DocRefusal, LiveDoc } from '../../outputs/agent-studio/server/docs/live_doc.ts';
import { normalize, parseDoc, type PMJson, writeDoc } from '../../outputs/agent-studio/server/docs/markdown.ts';
import { buildFromAib, contentOf, exportAib, IdMap, parseAib, stringifyAib } from '../../outputs/agent-studio/server/docs/aibdoc.ts';
import { chartData, chartSvg, parseNumber } from '../../outputs/agent-studio/server/docs/charts.ts';
import { jsonOf } from '../../outputs/agent-studio/server/docs/blocks.ts';
import { ArtifactHistory } from '../../outputs/agent-studio/server/docs/history.ts';
import { ArtifactStore } from '../../outputs/agent-studio/server/artifacts/artifacts.ts';
import { DocStore, mdBody, RICH_NOTE } from '../../outputs/agent-studio/server/docs/store.ts';
import { UserClient } from './_docs.ts';

type Json = Record<string, unknown>;
type View = {
  id: string;
  h: string;
  md?: string;
  type: string;
  kids?: string[];
  parent?: string;
  by?: string;
  attrs?: Json;
  data?: string[][];
};
const sep = Deno.build.os === 'windows' ? '\\' : '/';

const t = (text: string): PMJson => ({ type: 'text', text });
const p = (text = ''): PMJson => (text ? { type: 'paragraph', content: [t(text)] } : { type: 'paragraph' });
const cell = (type: string, text: string): PMJson => ({ type, content: [p(text)] });
const table = (rows: string[][]): PMJson => ({
  type: 'table',
  content: rows.map((r, k) => ({ type: 'tableRow', content: r.map((c) => cell(k ? 'tableCell' : 'tableHeader', c)) })),
});
const ROWS = [['Week', 'Old form', 'Checkout v2'], ['Week 1', '3.1', '3.3'], ['Week 2', '3.0', '3.4'], ['Week 3', '3.2', '3.6']];
const CHART: PMJson = {
  type: 'chart',
  attrs: { chart: 'conv', chartType: 'bar', title: 'Conversion by week', caption: 'Staff test, %' },
  content: [table(ROWS)],
};
const DOC: PMJson[] = [
  p('Intro words.'),
  CHART,
  {
    type: 'columns',
    content: [{ type: 'column', content: [p('Left')] }, {
      type: 'column',
      content: [{ ...CHART, attrs: { ...CHART.attrs, chart: 'side', chartType: 'line' } }],
    }],
  },
  p('Budget is tight.'),
];

function chartDoc(): LiveDoc {
  const live = new LiveDoc();
  live.replaceAll(DOC, live.system);
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
/** The paragraph inside a chart's cell [row, col]. */
function cellPara(live: LiveDoc, chartId: string, r: number, c: number): View {
  const all = blocks(live);
  const byId = new Map(all.map((b) => [b.id, b]));
  const chart = byId.get(chartId)!;
  const tbl = byId.get(chart.kids![0])!;
  const row = byId.get(tbl.kids![r])!;
  const cl = byId.get(row.kids![c])!;
  return byId.get(cl.kids![0])!;
}
const chartOf = (live: LiveDoc, chart = 'conv') => blocks(live).find((b) => b.type === 'chart' && b.attrs?.chart === chart)!;

Deno.test('doc.aibdoc round-trips a chart exactly (cells with ids), and the page bundle reads it as the server has it', async () => {
  const live = chartDoc();
  assertEquals(contentOf(live, live.firstPage), DOC.map(normalize));
  const text = stringifyAib(exportAib(live, 'Charts', new IdMap()));
  const built = buildFromAib(parseAib(text), 1);
  const back = new LiveDoc(built.state, built.meta);
  assertEquals(contentOf(back, back.firstPage), DOC.map(normalize));
  assertEquals(stringifyAib(exportAib(back, 'Charts', built.ids)), text, 'the same file again');
  const chart = parseAib(text).pages[0].content[1] as {
    id?: string;
    attrs?: Json;
    content?: { id?: string; content?: { id?: string }[] }[];
  };
  assertEquals(chart.attrs, { chart: 'conv', chartType: 'bar', title: 'Conversion by week', caption: 'Staff test, %' });
  assert(chart.id && chart.content![0].id && chart.content![0].content![1].id, 'the chart, its table and its rows carry ids');
  await import(new URL('../../outputs/agent-studio/vendor/docs/editor.js', import.meta.url).href);
  const page = (globalThis as unknown as { AIBDocEditor: { docJSON(u: Uint8Array): PMJson; encode(j: PMJson): Uint8Array } }).AIBDocEditor;
  const server = { type: 'doc', content: contentOf(live, live.firstPage) };
  assertEquals(page.docJSON(live.encode()), server);
  assertEquals(contentOf(new LiveDoc(page.encode(server)), 'p1'), server.content);
});

Deno.test('the Markdown copy: the chart picture plus its numbers as a table, lossy; that pair reads back as a chart', () => {
  const live = chartDoc();
  const w = writeDoc(live.topBlocks(), {}, '\n', '\n');
  const md = '![Conversion by week](assets/conv.chart.svg "Staff test, %")\n\n' +
    '| Week | Old form | Checkout v2 |\n| --- | --- | --- |\n| Week 1 | 3.1 | 3.3 |\n| Week 2 | 3.0 | 3.4 |\n| Week 3 | 3.2 | 3.6 |';
  assert(w.text.startsWith('Intro words.\n\n' + md + '\n\n'), w.text);
  assertEquals(w.lossy, live.topIds().slice(1, 3), 'the chart and the columns holding one');
  const parsed = parseDoc(md + '\n\nAfter.\n').blocks;
  assertEquals(parsed.map((b) => b.node.type), ['chart', 'paragraph']);
  assertEquals(parsed[0].raw, md);
  assertEquals(chartData(parsed[0].node), chartData(CHART));
  assertEquals(parsed[0].node.attrs, { chart: 'conv', chartType: 'bar', title: 'Conversion by week', caption: 'Staff test, %' });
});

Deno.test('the server draws the picture: plain SVG on white, title, series, a bar per number, a gap for a non-number', () => {
  assertEquals(
    [parseNumber('3.1'), parseNumber('1,250'), parseNumber('45%'), parseNumber('$12.50'), parseNumber('-2'), parseNumber('n/a')],
    [3.1, 1250, 45, 12.5, -2, null],
  );
  const svg = chartSvg(CHART);
  assert(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'));
  assert(svg.includes('<rect width="640" height="360" fill="#ffffff"/>'), 'a white background');
  assert(!svg.includes('var(--'), 'no theme tokens');
  for (const s of ['Conversion by week', 'Staff test, %', 'Old form', 'Checkout v2', 'Week 3']) assert(svg.includes(s), s);
  assertEquals((svg.match(/<rect x=[^>]*><title>/g) ?? []).length, 6, 'six bars');
  const gap = { ...CHART, content: [table([ROWS[0], ['Week 1', '3.1', ''], ['Week 2', 'x', '3.4']])] };
  assertEquals((chartSvg(gap).match(/<rect x=[^>]*><title>/g) ?? []).length, 2);
  const line = chartSvg({ ...CHART, attrs: { ...CHART.attrs, chartType: 'line' } });
  assertEquals((line.match(/<path /g) ?? []).length, 2, 'a line per series');
  assertEquals((line.match(/<circle /g) ?? []).length, 6);
});

Deno.test('agents make a chart from data, set its type and title, add rows and series; doc_read shows its data with cell guards', () => {
  const live = new LiveDoc();
  live.replaceAll([p('Start.')], live.system);
  const claude = live.originFor('agent', 'claude');
  const ack = live.edit([{
    op: 'insert',
    target: { kind: 'root' },
    side: 'end',
    source: {
      from: {
        kind: 'blocks',
        content: [{
          type: 'chart',
          attrs: { title: 'Signups', chartType: 'line' },
          data: [['Month', 'Web', 'App'], ['Jan', 10, 4], ['Feb', 12.5, null]],
        }],
      },
      as: 'blocks',
    },
  }], claude) as Json;
  const chart = blocks(live).find((b) => b.type === 'chart')!;
  assert((ack.created as string[]).includes(chart.id));
  assert(/^chart-[0-9a-f]{8}$/.test(String(chart.attrs!.chart)), 'AIB gave it an id');
  assertEquals(chart.attrs!.chartType, 'line');
  assertEquals(chart.data, [['Month', 'Web', 'App'], ['Jan', '10', '4'], ['Feb', '12.5', '']]);
  assertEquals(chart.by, 'claude');
  const num = cellPara(live, chart.id, 1, 1);
  assertEquals([num.md, typeof num.h], ['10', 'string']);
  const r = live.read() as { rev: number };
  const tableId = chart.kids![0];
  live.edit([
    {
      op: 'set',
      target: { kind: 'blocks', ids: [chart.id] },
      ifHash: chart.h,
      ifRev: r.rev,
      attrs: { chartType: 'bar', title: 'Signups by month' },
    },
    { op: 'table_row_insert', target: { kind: 'blocks', ids: [tableId] }, cells: ['Mar', '14', '6'] },
    { op: 'table_col_insert', target: { kind: 'blocks', ids: [tableId] }, cells: ['Email', '1', '2', '3'] },
  ], claude);
  const now = blocks(live).find((b) => b.type === 'chart')!;
  assertEquals([now.attrs!.chartType, now.attrs!.title], ['bar', 'Signups by month']);
  assertEquals(now.data, [['Month', 'Web', 'App', 'Email'], ['Jan', '10', '4', '1'], ['Feb', '12.5', '', '2'], ['Mar', '14', '6', '3']]);
  // what is not a chart is refused: a word in a number cell, a 7th series, merged cells, a made-up type, the chart's id
  const r2 = live.read() as { rev: number };
  const feb = cellPara(live, now.id, 2, 1);
  assertEquals(
    refusal(() =>
      live.edit(
        [{ op: 'replace', target: { kind: 'blocks', ids: [feb.id] }, ifHash: feb.h, ifRev: r2.rev, with: inline('lots', 'text') }],
        claude,
      )
    ).code,
    'bad_chart',
  );
  const cols = ['A', 'B', 'C', 'D'].map((h) => ({ op: 'table_col_insert', target: { kind: 'blocks', ids: [tableId] }, cells: [h, '1'] }));
  assertEquals(refusal(() => live.edit(cols, claude)).code, 'bad_chart');
  assertEquals(
    refusal(() =>
      live.edit([{ op: 'table_merge', target: { kind: 'blocks', ids: [tableId] }, cells: [[1, 1], [1, 2]], ifRev: r2.rev }], claude)
    ).code,
    'bad_chart',
  );
  const c2 = blocks(live).find((b) => b.type === 'chart')!;
  assertEquals(
    refusal(() =>
      live.edit([{ op: 'set', target: { kind: 'blocks', ids: [c2.id] }, ifHash: c2.h, ifRev: r2.rev, attrs: { chartType: 'pie' } }], claude)
    ).code,
    'bad_op',
  );
  assertEquals(
    refusal(() =>
      live.edit([{ op: 'set', target: { kind: 'blocks', ids: [c2.id] }, ifHash: c2.h, ifRev: r2.rev, attrs: { chart: 'mine' } }], claude)
    ).code,
    'bad_op',
  );
  assertEquals(blocks(live).find((b) => b.type === 'chart')!.data, now.data, 'nothing changed');
  // the user may type anything in a cell (mid-typing "3." or a word): never refused
  const user = new UserClient(live);
  user.type(feb.id, 4, ' approx');
  assertEquals(cellPara(live, now.id, 2, 1).md, '12.5 approx');
  live.detach(user.link);
});

Deno.test('make chart from this table copies the numbers once: later table edits leave the chart alone', () => {
  const live = new LiveDoc();
  live.replaceAll([p('Numbers:'), table(ROWS), p('End.')], live.system);
  const claude = live.originFor('agent', 'claude');
  const tbl = blocks(live).find((b) => b.type === 'table' && !b.parent)!;
  live.edit([{ op: 'chart_from_table', target: { kind: 'blocks', ids: [tbl.id] }, attrs: { title: 'Copied', chartType: 'line' } }], claude);
  assertEquals(live.topBlocks().map((b) => b.node.type), ['paragraph', 'table', 'chart', 'paragraph'], 'right after the table');
  const chart = blocks(live).find((b) => b.type === 'chart')!;
  assertEquals(chart.data, ROWS);
  assertEquals([chart.attrs!.title, chart.attrs!.chartType], ['Copied', 'line']);
  // the copied numbers are the agent's (tinted)
  assert(JSON.stringify(jsonOf(live.fragOf(live.firstPage).get(2) as never)).includes('"agentEdit"'));
  // the table changes; the chart keeps its own numbers
  live.edit([{ op: 'replace', target: { kind: 'find', text: '3.4' }, with: inline('9.9', 'text') }], claude);
  const r = live.read() as { rev: number; blocks: View[] };
  live.edit([{ op: 'table_row_delete', target: { kind: 'blocks', ids: [tbl.id] }, at: 1, ifRev: r.rev }], claude);
  const tableNow = live.topBlocks()[1].node;
  assertEquals(tableNow.content!.length, 3);
  assert(live.markdownOf(live.topIds()[1]).includes('| Week 2 | 3.0 | 9.9 |'));
  assertEquals(blocks(live).find((b) => b.type === 'chart')!.data, ROWS, 'the chart is as copied');
  // the user's "Make chart from this table" (a user origin): same copy, no agent mark
  live.edit([{ op: 'chart_from_table', target: { kind: 'blocks', ids: [tbl.id] } }], { kind: 'user', name: 'user' });
  const mine = live.topBlocks()[2];
  assertEquals(mine.node.type, 'chart');
  assert(!JSON.stringify(mine.node).includes('agentEdit'));
  const ids = blocks(live).filter((b) => b.type === 'chart').map((b) => b.attrs!.chart);
  assertEquals(new Set(ids).size, 2, 'each chart has its own id');
  // a table too wide for a chart is refused
  const wide = table([['L', 'a', 'b', 'c', 'd', 'e', 'f', 'g'], ['x', '1', '2', '3', '4', '5', '6', '7']]);
  live.replaceAll([wide], live.system);
  const w = blocks(live)[0];
  assertEquals(refusal(() => live.edit([{ op: 'chart_from_table', target: { kind: 'blocks', ids: [w.id] } }], claude)).code, 'bad_chart');
});

Deno.test("the user edits a number while the agent rewrites the same number: refused, the user's number stays; other cells land, attributed", () => {
  const live = chartDoc();
  const user = new UserClient(live);
  const claude = live.originFor('agent', 'claude');
  const read = live.read() as { rev: number };
  const chart = chartOf(live);
  const w2 = cellPara(live, chart.id, 2, 2); // Week 2, Checkout v2: 3.4
  const w3 = cellPara(live, chart.id, 3, 1); // Week 3, Old form: 3.2
  // the user is typing in that number when the agent's call lands
  user.holdUp = true;
  user.type(w2.id, 3, '5'); // 3.4 -> 3.45
  user.release();
  const refused = refusal(() =>
    live.edit([
      { op: 'replace', target: { kind: 'blocks', ids: [w3.id] }, ifHash: w3.h, ifRev: read.rev, with: inline('3.3', 'text') },
      { op: 'replace', target: { kind: 'blocks', ids: [w2.id] }, ifHash: w2.h, ifRev: read.rev, with: inline('3.5', 'text') },
    ], claude)
  );
  assertEquals(refused.code, 'guard_mismatch');
  assertEquals((refused.toJSON().block as View).md, '3.45');
  assertEquals(user.text(w2.id), '3.45');
  assertEquals(cellPara(live, chart.id, 3, 1).md, '3.2', 'all or nothing: the other cell of that call did not change either');
  // a rewrite of the whole chart (set its title on the old read) is refused too
  assertEquals(
    refusal(() =>
      live.edit(
        [{ op: 'set', target: { kind: 'blocks', ids: [chart.id] }, ifHash: chart.h, ifRev: read.rev, attrs: { title: 'X' } }],
        claude,
      )
    ).code,
    'guard_mismatch',
  );
  // the agent's edit of another cell lands, marked as the agent's
  live.edit(
    [{ op: 'replace', target: { kind: 'blocks', ids: [w3.id] }, ifHash: w3.h, ifRev: read.rev, with: inline('3.3', 'text') }],
    claude,
  );
  const after = cellPara(live, chart.id, 3, 1);
  assertEquals([after.md, after.by], ['3.3', 'claude']);
  assertEquals(cellPara(live, chart.id, 2, 2).by, 'user');
  const json = JSON.stringify(jsonOf(user.block(after.id)));
  assert(json.includes('"agentEdit"') && json.includes('"by":"claude"'), "the page sees the agent's mark on the number");
  assert(!JSON.stringify(jsonOf(user.block(w2.id))).includes('agentEdit'), "the user's number carries no agent mark");
  assertEquals(chartOf(live).data![3], ['Week 3', '3.3', '3.6']);
  assertEquals(chartOf(live).data![2], ['Week 2', '3.0', '3.45']);
  live.detach(user.link);
});

async function chartStore() {
  const root = Deno.realPathSync(await Deno.makeTempDir({ prefix: 'aib-chart-' })).replace(/^\\\\\?\\/, '');
  const artifacts = new ArtifactStore(`${root}${sep}artifacts`);
  const history = new ArtifactHistory(() => artifacts);
  const store = new DocStore(`${root}${sep}state`, { idleMs: 60_000, snapshotIdleMs: 60_000, history });
  const project = `${root}${sep}project`;
  await Deno.mkdir(`${project}${sep}docs`, { recursive: true });
  return { store, project, done: async () => (await store.close(), await Deno.remove(root, { recursive: true }).catch(() => {})) };
}

const exists = async (path: string) => {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
};

Deno.test('the store writes each chart picture to assets/, skips .md edits to a chart (rich_block) and takes plain ones', async () => {
  const s = await chartStore();
  try {
    const doc = await s.store.open(s.project, 'plan', 'Start.\n');
    const claude = doc.live.originFor('agent', 'claude');
    doc.live.replaceAll([p('Intro words.'), CHART, p('Budget is tight.')], claude);
    await s.store.flush(doc);
    const svgPath = `${doc.dir}${sep}assets${sep}conv.chart.svg`;
    assertEquals(await Deno.readTextFile(svgPath), chartSvg(jsonOf(doc.live.fragOf(doc.live.firstPage).get(1) as never)));
    const path = `${doc.dir}${sep}01-page-1.md`;
    const text = await Deno.readTextFile(path);
    assert(mdBody(text).includes('![Conversion by week](assets/conv.chart.svg "Staff test, %")\n\n| Week | Old form | Checkout v2 |'));
    assertEquals(doc.lossy, [doc.live.topIds()[1]]);
    // a number changed in the .md: skipped (edit charts with the doc tools); the plain edit applies
    await Deno.writeTextFile(
      path,
      text.replace('| Week 2 | 3.0 | 3.4 |', '| Week 2 | 3.0 | 9.9 |').replace('Budget is tight.', 'Budget is fine.'),
    );
    const skipped = await s.store.syncMirror(doc);
    assertEquals(skipped.map((x) => [x.reason, x.id]), [['rich_block', doc.live.topIds()[1]]]);
    assertEquals(skipped[0].note, RICH_NOTE);
    assertEquals(doc.live.markdownOf(doc.live.topIds()[2]), 'Budget is fine.');
    assertEquals(chartOf(doc.live).data![2], ['Week 2', '3.0', '3.4']);
    assert(!(await Deno.readTextFile(path)).includes('9.9'), 'the copy is written back from the doc');
    // a number changed with the doc tools: the picture follows
    const w2 = cellPara(doc.live, chartOf(doc.live).id, 2, 2);
    doc.live.edit([{
      op: 'replace',
      target: { kind: 'blocks', ids: [w2.id] },
      ifHash: w2.h,
      ifRev: doc.live.rev,
      with: inline('4.4', 'text'),
    }], claude);
    await s.store.flush(doc);
    assert((await Deno.readTextFile(svgPath)).includes('Checkout v2 · Week 2: 4.4'));
    // a chart without an id (made in the page) gets one, and its picture
    doc.live.edit([{
      op: 'insert',
      target: { kind: 'root' },
      side: 'end',
      source: { from: { kind: 'blocks', content: [{ type: 'chart', data: [['L', 'S'], ['a', 1]] }] }, as: 'blocks' },
    }], claude);
    const made = blocks(doc.live).filter((b) => b.type === 'chart')[1];
    await s.store.flush(doc);
    assert(await exists(`${doc.dir}${sep}assets${sep}${made.attrs!.chart}.chart.svg`));
    // the chart deleted: its picture goes
    const c = chartOf(doc.live);
    doc.live.edit([{ op: 'delete', target: { kind: 'blocks', ids: [c.id] }, ifHash: c.h, ifRev: doc.live.rev }], claude);
    await s.store.flush(doc);
    assert(!(await exists(svgPath)));
  } finally {
    await s.done();
  }
});

Deno.test('history keeps charts: a version restores its chart exactly', async () => {
  const s = await chartStore();
  try {
    const doc = await s.store.open(s.project, 'plan', 'Start.\n');
    const live = doc.live;
    const claude = live.originFor('agent', 'claude');
    live.replaceAll(DOC, claude);
    await s.store.flush(doc);
    const n = s.store.snapshot(doc)!;
    const want = contentOf(live, live.firstPage);
    assert(s.store.readVersion(doc, n).includes('assets/conv.chart.svg'), 'agents read the version as Markdown');
    const chart = chartOf(live);
    const cellId = cellPara(live, chart.id, 1, 1).id;
    const c = blocks(live).find((b) => b.id === cellId)!;
    live.edit([
      { op: 'replace', target: { kind: 'blocks', ids: [cellId] }, ifHash: c.h, ifRev: live.rev, with: inline('7', 'text') },
      { op: 'set', target: { kind: 'blocks', ids: [chart.id] }, force: true, attrs: { chartType: 'line' } },
    ], claude);
    assert(JSON.stringify(contentOf(live, live.firstPage)) !== JSON.stringify(want));
    await s.store.restore(doc, n, live.rev, claude);
    assertEquals(contentOf(live, live.firstPage), want);
    assertEquals(chartOf(live).data, ROWS);
  } finally {
    await s.done();
  }
});
