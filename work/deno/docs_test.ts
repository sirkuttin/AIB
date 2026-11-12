/**
 * Local docs: the live Y.Doc in AIB's server, the guarded agent edits (blocks, containers, placeholders, tables), per-author undo,
 * and the speed of the block index. The user is a second Yjs client talking to the server over the same y-protocols messages the
 * page's editor sends (an in-memory socket here, so a test can hold the user's keystrokes "in flight" while the agent's call lands).
 */
import { assert, assertEquals } from './_assert.ts';
import * as Y from 'yjs';
import { DocRefusal, LiveDoc } from '../../outputs/agent-studio/server/docs/live_doc.ts';
import { diffText } from '../../outputs/agent-studio/server/docs/blocks.ts';
import { markdown, seeded, UserClient } from './_docs.ts';

type Json = Record<string, unknown>;
type View = { id: string; h: string; md?: string; type: string; kids?: string[]; parent?: string; by?: string; attrs?: Json };

function refusal(fn: () => unknown): DocRefusal {
  try {
    fn();
  } catch (error) {
    if (error instanceof DocRefusal) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

const PARA = 'The launch moves to October after the legal review.';
const blocks = (live: LiveDoc): View[] => (live.read() as { blocks: View[] }).blocks;
const top = (live: LiveDoc): View[] => blocks(live).filter((b) => !b.parent);
const inline = (content: string, as = 'markdown') => ({ from: { kind: 'inline', content }, as });

Deno.test("a guarded rewrite from before the user typed is refused with guard_mismatch, and the user's text survives", () => {
  const live = seeded(`# Plan\n\n${PARA}\n\nSecond paragraph.`);
  const user = new UserClient(live);
  const read = live.read() as { rev: number; blocks: View[] };
  const p = read.blocks[1];
  assertEquals(p.md, PARA);
  assertEquals(p.h.length, 8);
  user.type(p.id, PARA.indexOf('October') + 'October'.length, ' 6th');
  assert(live.rev > read.rev);
  const rewrite = {
    op: 'replace',
    target: { kind: 'blocks', ids: [p.id] },
    ifHash: p.h,
    ifRev: read.rev,
    with: inline('Launch is in November.', 'text'),
  };
  const refused = refusal(() => live.edit([rewrite], live.originFor('agent', 'claude')));
  assertEquals(refused.code, 'guard_mismatch');
  assert(refused.message.includes('Their edit wins'), refused.message);
  const shown = (refused.toJSON() as { block: View }).block;
  assertEquals(shown.md, 'The launch moves to October 6th after the legal review.');
  assertEquals(user.text(p.id), 'The launch moves to October 6th after the legal review.');
  const ok = live.edit(
    [{ ...rewrite, ifHash: shown.h, ifRev: (refused.toJSON() as { rev: number }).rev }],
    live.originFor('agent', 'claude'),
  );
  assertEquals(ok.ok, true);
  assertEquals(user.text(p.id), 'Launch is in November.');
});

Deno.test('whole-block replace and delete need both guards (missing_guard), find needs none', () => {
  const live = seeded(`${PARA}\n\nTwo.`);
  const [p] = blocks(live);
  const agent = live.originFor('agent', 'claude');
  const bare = { op: 'delete', target: { kind: 'blocks', ids: [p.id] } };
  assertEquals(refusal(() => live.edit([bare], agent)).code, 'missing_guard');
  assertEquals(refusal(() => live.edit([{ ...bare, ifRev: live.rev }], agent)).code, 'missing_guard');
  assertEquals(refusal(() => live.edit([{ ...bare, ifHash: p.h }], agent)).code, 'missing_guard');
  assertEquals(refusal(() => live.edit([{ ...bare, ifHash: 'deadbeef', ifRev: live.rev }], agent)).code, 'guard_mismatch');
  live.edit([{ op: 'delete', target: { kind: 'find', text: ' after the legal review' } }], agent);
  assertEquals(blocks(live)[0].md, 'The launch moves to October.');
});

Deno.test('an agent find re-word and the user typing elsewhere in the same paragraph at the same moment both survive', () => {
  const live = seeded(PARA);
  const user = new UserClient(live);
  const [p] = blocks(live);
  user.holdUp = true;
  user.type(p.id, 0, 'Update: ');
  user.type(p.id, user.text(p.id).length - 1, ' by counsel');
  const ack = live.edit(
    [{ op: 'replace', target: { kind: 'find', text: 'moves to October' }, with: inline('slips to November', 'text') }],
    live.originFor('agent', 'claude'),
  );
  assertEquals(ack.ok, true);
  user.release();
  const expected = 'Update: The launch slips to November after the legal review by counsel.';
  assertEquals(user.text(p.id), expected);
  assertEquals(blocks(live)[0].md, expected);
  const delta = (user.block(p.id).get(0) as Y.XmlText).toDelta() as { insert: string; attributes?: Json }[];
  assertEquals(delta.filter((d) => d.attributes?.agentEdit).map((d) => d.insert).join(''), 'slipsNovem'); // "ber" of October stays
});

Deno.test('re-word in place keeps bold and links around the changed words', () => {
  const live = seeded('Ship **the beta** on [Friday](https://example.com/plan) at noon.');
  const agent = live.originFor('agent', 'claude');
  const [p] = blocks(live);
  live.edit([{
    op: 'replace',
    target: { kind: 'blocks', ids: [p.id] },
    ifHash: p.h,
    ifRev: live.rev,
    with: inline('Ship the beta on Monday at noon.', 'text'),
  }], agent);
  assertEquals(blocks(live)[0].md, 'Ship **the beta** on [Monday](https://example.com/plan) at noon.');
  // as markdown with the same marks: character edits too (the same block id)
  const q = blocks(live)[0];
  live.edit([{
    op: 'replace',
    target: { kind: 'blocks', ids: [q.id] },
    ifHash: q.h,
    ifRev: live.rev,
    with: inline('Ship **the release** on [Monday](https://example.com/plan) at noon.'),
  }], agent);
  assertEquals(blocks(live)[0].id, p.id);
  assertEquals(blocks(live)[0].md, 'Ship **the release** on [Monday](https://example.com/plan) at noon.');
});

Deno.test('a find whose words the user just changed is refused find_none; words across a line break are refused atom_in_range', () => {
  const live = seeded(`${PARA}\n\nOne\\\nTwo`);
  const user = new UserClient(live);
  const [p, q] = blocks(live);
  user.doc.transact(() => (user.block(p.id).get(0) as Y.XmlText).delete(PARA.indexOf('October'), 3), user.typing);
  const agent = live.originFor('agent', 'a');
  const refused = refusal(() =>
    live.edit([{ op: 'replace', target: { kind: 'find', text: 'October' }, with: inline('Nov', 'text') }], agent)
  );
  assertEquals(refused.code, 'find_none');
  assert(refused.message.includes('search'), refused.message);
  assertEquals(user.text(p.id), 'The launch moves to ober after the legal review.');
  const atom = refusal(() =>
    live.edit([{ op: 'replace', target: { kind: 'find', text: 'One\nTwo' }, with: inline('One Two', 'text') }], agent)
  );
  assertEquals(atom.code, 'atom_in_range');
  assertEquals(blocks(live)[1].md, q.md);
});

Deno.test('a call is atomic: one bad op and nothing changed', () => {
  const live = seeded(`# Plan\n\n${PARA}\n\nTwo.`);
  const user = new UserClient(live);
  const before = { rev: live.rev, md: markdown(live) };
  const b = blocks(live);
  const refused = refusal(() =>
    live.edit([
      { op: 'insert', target: { kind: 'blocks', ids: [b[0].id] }, side: 'after', source: inline('- a\n- b') },
      { op: 'replace', target: { kind: 'find', text: 'October' }, with: inline('November', 'text') },
      { op: 'delete', target: { kind: 'blocks', ids: [b[2].id] }, ifHash: b[2].h, ifRev: live.rev },
      { op: 'replace', target: { kind: 'find', text: 'words that are not there' }, with: inline('x', 'text') },
    ], live.originFor('agent', 'claude'))
  );
  assertEquals(refused.code, 'find_none');
  assertEquals((refused.toJSON() as { op: number }).op, 3);
  assertEquals(live.rev, before.rev);
  assertEquals(markdown(live), before.md);
  assertEquals(user.frag.length, 3);
});

Deno.test('doc_changes returns only the changed blocks, with deleted ones marked gone', () => {
  const live = seeded('# Plan\n\nOne.\n\nTwo.\n\nThree.');
  const user = new UserClient(live);
  const read = live.read() as { rev: number; blocks: View[] };
  const [, one, two, three] = read.blocks;
  user.type(one.id, 3, ' more');
  live.edit(
    [{ op: 'delete', target: { kind: 'blocks', ids: [three.id] }, ifHash: three.h, ifRev: read.rev }],
    live.originFor('agent', 'claude'),
  );
  const delta = live.changes(read.rev) as { rev: number; changed: (View & { after: string })[]; gone: string[] };
  assertEquals(delta.changed.map((b) => [b.id, b.md, b.by]), [[one.id, 'One more.', 'user']]);
  assertEquals(delta.changed[0].after, read.blocks[0].id);
  assertEquals(delta.gone, [three.id]);
  assert(!delta.changed.some((b) => b.id === two.id));
  assertEquals((live.changes(delta.rev) as { changed: unknown[] }).changed.length, 0);
});

Deno.test("the user's undo never takes back the agent's edits; doc_undo takes back only the agent's last call, never over the user", () => {
  const live = seeded(`${PARA}\n\nSecond.`);
  const user = new UserClient(live);
  const [p, s] = blocks(live);
  user.type(p.id, 0, 'Note: ');
  const agent = live.originFor('agent', 'claude');
  live.edit([{ op: 'replace', target: { kind: 'find', text: 'legal review' }, with: inline('security review', 'text') }], agent);
  user.type(p.id, user.text(p.id).length, ' Done.');
  user.undo.undo();
  user.undo.undo();
  assertEquals(user.text(p.id), 'The launch moves to October after the security review.');
  // the agent's call touched p and the user changed p since: refused, nothing undone
  const conflict = refusal(() => live.undo(agent));
  assertEquals(conflict.code, 'undo_conflict');
  assertEquals(user.text(p.id), 'The launch moves to October after the security review.');
  // a later call on another block is undone cleanly
  live.edit([{ op: 'replace', target: { kind: 'find', text: 'Second.' }, with: inline('Second, by the agent.', 'text') }], agent);
  assertEquals(blocks(live).find((b) => b.id === s.id)!.md, 'Second, by the agent.');
  const ack = live.undo(agent);
  assertEquals(ack.undone, true);
  assertEquals(blocks(live).find((b) => b.id === s.id)!.md, 'Second.');
  assertEquals(blocks(live).find((b) => b.id === s.id)!.by, 'claude');
  assertEquals(refusal(() => live.undo(live.originFor('agent', 'other'))).code, 'nothing_to_undo');
});

Deno.test('lists, quotes and tables are containers: their h covers type, attrs and child ids; each item is its own block', () => {
  const live = seeded('- one\n- two\n\n> quoted\n\n| A | B |\n|---|:-:|\n| 1 | 2 |');
  const user = new UserClient(live);
  const all = blocks(live);
  const list = all[0];
  assertEquals(list.type, 'bulletList');
  assertEquals(list.kids!.length, 2);
  const item = all.find((b) => b.id === list.kids![0])!;
  assertEquals([item.type, item.parent], ['listItem', list.id]);
  const para = all.find((b) => b.id === item.kids![0])!;
  assertEquals(para.md, 'one');
  const table = all.find((b) => b.type === 'table')!;
  assert(all.find((b) => b.type === 'tableHeader' && b.attrs?.align === 'center'), 'a header cell with its align');
  assertEquals(table.kids!.length, 2);
  const read = live.rev;
  // typing inside an item: the list's and the item's h stay, the paragraph's changes
  user.type(para.id, 3, ' more');
  const after = blocks(live);
  assertEquals(after.find((b) => b.id === list.id)!.h, list.h);
  assertEquals(after.find((b) => b.id === item.id)!.h, item.h);
  assert(after.find((b) => b.id === para.id)!.h !== para.h);
  // but a guarded delete of the whole list from before the typing is refused (something inside it changed)
  const refused = refusal(() =>
    live.edit([{ op: 'delete', target: { kind: 'blocks', ids: [list.id] }, ifHash: list.h, ifRev: read }], live.originFor('agent', 'a'))
  );
  assertEquals(refused.code, 'guard_mismatch');
  assert(String((refused.toJSON() as { block: { md: string } }).block.md).includes('one more'));
});

Deno.test('insert before/after/inside, items into lists, move, set attrs and list kind', () => {
  const live = seeded('# Plan\n\n- one\n- two\n\nEnd.');
  const agent = live.originFor('agent', 'claude');
  let all = blocks(live);
  const list = all.find((b) => b.type === 'bulletList')!;
  const [i1, i2] = list.kids!;
  live.edit([
    { op: 'insert', target: { kind: 'blocks', ids: [i1] }, side: 'after', source: inline('- one and a half') },
    { op: 'insert', target: { kind: 'blocks', ids: [list.id] }, side: 'end', source: inline('three', 'text') },
  ], agent);
  assertEquals(live.markdownOf(list.id), '- one\n- one and a half\n- two\n- three');
  all = blocks(live);
  assertEquals(all.find((b) => b.id === list.id)!.kids!.filter((k) => k === i1 || k === i2).length, 2);
  const bad = refusal(() =>
    live.edit([{ op: 'insert', target: { kind: 'blocks', ids: [list.id] }, side: 'end', source: inline('## no') }], agent)
  );
  assertEquals(bad.code, 'bad_op');
  assert(bad.message.includes('- item'), bad.message);
  // list kind -> checklist (new ids, reported in "moved"), then tick an item
  const l = all.find((b) => b.id === list.id)!;
  const ack = live.edit(
    [{ op: 'set', target: { kind: 'blocks', ids: [l.id] }, ifHash: l.h, ifRev: live.rev, attrs: { kind: 'check' } }],
    agent,
  ) as {
    moved: Json;
  };
  const task = String(ack.moved[l.id]);
  const t = blocks(live).find((b) => b.id === blocks(live).find((x) => x.id === task)!.kids![0])!;
  live.edit([{ op: 'set', target: { kind: 'blocks', ids: [t.id] }, ifHash: t.h, ifRev: live.rev, attrs: { checked: true } }], agent);
  assertEquals(live.markdownOf(task), '- [x] one\n- [ ] one and a half\n- [ ] two\n- [ ] three');
  const h = blocks(live)[0];
  live.edit([{ op: 'set', target: { kind: 'blocks', ids: [h.id] }, ifHash: h.h, ifRev: live.rev, attrs: { level: 2 } }], agent);
  assertEquals(blocks(live)[0].md, '## Plan');
  assertEquals(
    refusal(() => live.edit([{ op: 'set', target: { kind: 'blocks', ids: [h.id] }, force: true, attrs: { level: 9 } }], agent)).code,
    'bad_op',
  );
  // move End. to the top
  const end = top(live).at(-1)!;
  const moved = live.edit([{
    op: 'move',
    target: { kind: 'blocks', ids: [end.id] },
    ifHash: end.h,
    ifRev: live.rev,
    to: { target: { kind: 'root' }, side: 'start' },
  }], agent) as { moved: Json };
  assertEquals(top(live)[0].md, 'End.');
  assertEquals(top(live)[0].id, moved.moved[end.id]);
  // deleting a list's last item removes the list; the doc keeps one block
  const two = seeded('Text.\n\n- only');
  const li = blocks(two).find((b) => b.type === 'listItem')!;
  two.edit([{ op: 'delete', target: { kind: 'blocks', ids: [li.id] }, ifHash: li.h, ifRev: two.rev }], agent);
  assertEquals(top(two).map((b) => b.type), ['paragraph']);
  assertEquals(
    refusal(() => two.edit([{ op: 'delete', target: { kind: 'blocks', ids: [top(two)[0].id] }, force: true }], agent)).code,
    'last_block',
  );
});

Deno.test('a list replaced as Markdown keeps the ids of the items that did not change', () => {
  const live = seeded('- alpha\n- beta\n- gamma');
  const list = blocks(live)[0];
  live.edit([{
    op: 'replace',
    target: { kind: 'blocks', ids: [list.id] },
    ifHash: list.h,
    ifRev: live.rev,
    with: inline('- alpha\n- BETA\n- gamma\n- delta'),
  }], live.originFor('agent', 'a'));
  const now = blocks(live)[0];
  assertEquals(now.id, list.id);
  assertEquals(now.kids![0], list.kids![0]);
  assertEquals(now.kids![2], list.kids![2]);
  assertEquals(live.markdownOf(list.id), '- alpha\n- BETA\n- gamma\n- delta');
});

Deno.test('table rows and columns: insert and delete, guarded by the rev of the read', () => {
  const live = seeded('| Name | Score |\n|:--|--:|\n| a | 1 |\n| b | 2 |');
  const user = new UserClient(live);
  const agent = live.originFor('agent', 'claude');
  const table = blocks(live)[0];
  const target = { kind: 'blocks', ids: [table.id] };
  live.edit([{ op: 'table_row_insert', target, at: 2, cells: ['c', '**3**'] }], agent);
  live.edit([{ op: 'table_col_insert', target, cells: ['Note', 'x', 'y', 'z'] }], agent);
  assertEquals(
    live.markdownOf(table.id),
    '| Name | Score | Note |\n| :--- | ---: | --- |\n| a | 1 | x |\n| c | **3** | y |\n| b | 2 | z |',
  );
  const rev = live.rev;
  // the user types into the Score column: deleting that column with the older rev is refused; another column goes
  const scoreCell = blocks(live).filter((b) => b.type === 'tableCell')[1];
  user.type(scoreCell.kids![0], 1, '0');
  assertEquals(refusal(() => live.edit([{ op: 'table_col_delete', target, at: 1, ifRev: rev }], agent)).code, 'guard_mismatch');
  assertEquals(refusal(() => live.edit([{ op: 'table_col_delete', target, at: 2 }], agent)).code, 'missing_guard');
  live.edit([{ op: 'table_col_delete', target, at: 2, ifRev: rev }], agent);
  live.edit([{ op: 'table_row_delete', target, at: 2, ifRev: live.rev }], agent);
  assertEquals(live.markdownOf(table.id), '| Name | Score |\n| :--- | ---: |\n| a | 10 |\n| b | 2 |');
  assertEquals(refusal(() => live.edit([{ op: 'table_row_insert', target, cells: ['1', '2', '3'] }], agent)).code, 'cell_count');
  const lastRow = blocks(live).find((b) => b.id === table.id)!.kids!.at(-1)!;
  live.edit([{ op: 'insert', target: { kind: 'blocks', ids: [lastRow] }, side: 'after', source: inline('| d | 4 |') }], agent);
  assertEquals(live.markdownOf(table.id).split('\n').at(-1), '| d | 4 |');
});

Deno.test('placeholders: planted, filled one per call; deleted by the user = block_gone (drop it); typed into = keep their text', () => {
  const live = seeded('# Report');
  const user = new UserClient(live);
  const agent = live.originFor('agent', 'claude');
  const head = blocks(live)[0];
  const plant = live.edit([{
    op: 'insert',
    target: { kind: 'blocks', ids: [head.id] },
    side: 'after',
    source: { from: { kind: 'inline', content: ['Summary', 'Risks', 'Timeline'] }, as: 'pending' },
  }], agent) as { rev: number; created: string[] };
  assertEquals(plant.created.length, 3);
  const [summary, risks, timeline] = plant.created;
  assertEquals(blocks(live)[1].md, '<!-- aib:pending: Summary -->');
  const hOf = (id: string) => blocks(live).find((b) => b.id === id)!.h;
  const filled = live.edit([{
    op: 'replace',
    target: { kind: 'blocks', ids: [summary] },
    ifHash: hOf(summary),
    ifRev: plant.rev,
    with: inline('## Summary\n\nAll good.'),
  }], agent) as { rev: number };
  assertEquals(top(live).map((b) => b.md), [
    '# Report',
    '## Summary',
    'All good.',
    '<!-- aib:pending: Risks -->',
    '<!-- aib:pending: Timeline -->',
  ]);
  const riskH = hOf(risks), timeH = hOf(timeline);
  user.remove(risks);
  user.type(timeline, 0, 'Q3, my call');
  const gone = refusal(() =>
    live.edit([{
      op: 'replace',
      target: { kind: 'blocks', ids: [risks] },
      ifHash: riskH,
      ifRev: filled.rev,
      with: inline('## Risks\n\nMany.'),
    }], agent)
  );
  assertEquals(gone.code, 'block_gone');
  assert(gone.message.includes('never re-create'), gone.message);
  assertEquals((gone.toJSON() as { data: Json }).data, { op: 'remove' });
  const typed = refusal(() =>
    live.edit([{
      op: 'replace',
      target: { kind: 'blocks', ids: [timeline] },
      ifHash: timeH,
      ifRev: filled.rev,
      with: inline('## Timeline\n\nSoon.'),
    }], agent)
  );
  assertEquals(typed.code, 'guard_mismatch');
  assert(typed.message.includes('Keep their text'), typed.message);
  assertEquals(user.text(timeline), 'Q3, my call');
});

Deno.test('doc_read modes: outline, one block in full, search', () => {
  const live = seeded('# Plan\n\nIntro text.\n\n## Risks\n\n- legal review\n- budget\n\nThe legal team signs off.');
  const outline = live.read({ mode: 'outline' }) as {
    outline: { level: number; text: string }[];
    count: number;
    blocks: { preview: string }[];
  };
  assertEquals(outline.outline.map((h) => [h.level, h.text]), [[1, 'Plan'], [2, 'Risks']]);
  assertEquals(outline.count, 5);
  assertEquals(outline.blocks[3].preview, '- legal review\n- budget');
  const list = top(live)[3];
  const one = live.read({ id: list.id }) as { md: string; blocks: View[] };
  assertEquals(one.md, '- legal review\n- budget');
  assertEquals(one.blocks.length, 4);
  const hits = (live.read({ query: 'LEGAL' }) as { hits: (View & { at: number[][] })[] }).hits;
  assertEquals(hits.map((h) => [h.md, h.at]), [['legal review', [[0, 5]]], ['The legal team signs off.', [[4, 9]]]]);
  assertEquals(refusal(() => live.read({ id: '1.2' })).code, 'block_gone');
});

Deno.test('the word diff makes minimal edits', () => {
  const a = 'The quick brown fox jumps.', b = 'The slow brown fox leaps.';
  const edits = diffText(a, b);
  assertEquals(edits.length, 2);
  let out = a;
  for (const e of [...edits].sort((x, y) => y.at - x.at)) out = out.slice(0, e.at) + e.ins + out.slice(e.at + e.del);
  assertEquals(out, b);
});

Deno.test('speed: a 2,000-block doc rehashes only the blocks a change touched', () => {
  const md = Array.from({ length: 2000 }, (_, i) => (i % 50 === 0 ? `## Section ${i}` : `Paragraph ${i} with some words in it.`)).join(
    '\n\n',
  );
  let t = performance.now();
  const live = seeded(md);
  const loadMs = performance.now() - t;
  assertEquals(live.topIds().length, 2000);
  const user = new UserClient(live);
  const ids = live.topIds();
  live.stats.hashed = 0;
  t = performance.now();
  for (let i = 0; i < 200; i++) user.type(ids[1000], i, 'x');
  const typeMs = (performance.now() - t) / 200;
  assertEquals(live.stats.hashed, 200); // one block per keystroke, not 2,000
  const agent = live.originFor('agent', 'claude');
  t = performance.now();
  for (let i = 0; i < 20; i++) {
    live.edit(
      [{ op: 'replace', target: { kind: 'find', text: `Paragraph ${1501 + i} ` }, with: inline(`Para ${1501 + i} `, 'text') }],
      agent,
    );
  }
  const editMs = (performance.now() - t) / 20;
  assertEquals(live.stats.hashed, 220);
  t = performance.now();
  const delta = live.changes(live.rev - 5) as { changed: unknown[] };
  const changesMs = performance.now() - t;
  assertEquals(delta.changed.length, 5);
  console.log(
    `2,000 blocks: load ${loadMs.toFixed(0)} ms, keystroke ${typeMs.toFixed(2)} ms, agent call ${editMs.toFixed(1)} ms, changes ${
      changesMs.toFixed(1)
    } ms`,
  );
  assert(typeMs < 20, `a keystroke took ${typeMs} ms`);
  assert(editMs < 500, `an agent call took ${editMs} ms`);
});
