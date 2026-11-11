/**
 * Local docs (spike): the live Y.Doc in AIB's server, the guarded agent edits, the Markdown copy and per-author undo. The user is a
 * second Yjs client talking to the server over the same y-protocols messages the page's editor sends (an in-memory socket here, so
 * a test can hold the user's keystrokes "in flight" while the agent's call lands).
 */
import { assert, assertEquals } from './_assert.ts';
import * as Y from '../../outputs/agent-studio/server/docs/vendor/yjs.js';
import { DocRefusal, FIELD, LiveDoc } from '../../outputs/agent-studio/server/docs/live_doc.ts';
import { diffText, docToMarkdown, elementToSpec, parseMarkdown, specToElement, specToMarkdown } from '../../outputs/agent-studio/server/docs/blocks.ts';
import { DocStore } from '../../outputs/agent-studio/server/docs/store.ts';
import type { WsLink } from '../../outputs/agent-studio/server/platform/websocket.ts';

const sep = Deno.build.os === 'windows' ? '\\' : '/';
type Json = Record<string, unknown>;
type View = { id: string; h: string; md: string; type: string };

/** The page's side: a Y.Doc synced with the server through y-protocols over a socket whose two directions can be held. */
class UserClient {
  readonly doc = new Y.Doc();
  readonly frag: Y.XmlFragment;
  /** The origin of the user's own keystrokes (what y-prosemirror's undo tracks in the page). */
  readonly typing = { kind: 'typing' };
  readonly undo: Y.UndoManager;
  holdUp = false;
  #up: Uint8Array[] = [];
  readonly link: WsLink;

  constructor(readonly live: LiveDoc) {
    this.frag = this.doc.getXmlFragment(FIELD);
    this.undo = new Y.UndoManager(this.frag, { trackedOrigins: new Set([this.typing]), captureTimeout: 0 });
    const client = this;
    this.link = {
      onmessage: null,
      onclose: null,
      isOpen: true,
      send: (data) => client.#receive(data as Uint8Array),
      close: () => {},
    };
    this.doc.on('update', (update, origin) => {
      if (origin === this) return;
      const e = Y.encoding.createEncoder();
      Y.encoding.writeVarUint(e, 0);
      Y.sync.writeUpdate(e, update);
      this.#send(Y.encoding.toUint8Array(e));
    });
    live.attach(this.link);
    const e = Y.encoding.createEncoder();
    Y.encoding.writeVarUint(e, 0);
    Y.sync.writeSyncStep1(e, this.doc);
    this.#send(Y.encoding.toUint8Array(e));
  }

  #send(data: Uint8Array): void {
    if (this.holdUp) this.#up.push(data);
    else this.link.onmessage!(data);
  }

  /** Deliver the held keystrokes to the server. */
  release(): void {
    this.holdUp = false;
    for (const data of this.#up.splice(0)) this.link.onmessage!(data);
  }

  #receive(data: Uint8Array): void {
    const d = Y.decoding.createDecoder(data);
    if (Y.decoding.readVarUint(d) !== 0) return;
    const e = Y.encoding.createEncoder();
    Y.encoding.writeVarUint(e, 0);
    Y.sync.readSyncMessage(d, e, this.doc, this);
    if (Y.encoding.length(e) > 1) this.#send(Y.encoding.toUint8Array(e));
  }

  /** The block element with this server id. */
  block(id: string): Y.XmlElement {
    const el = this.frag.toArray().find((e) => e instanceof Y.XmlElement && `${e._item!.id.client}.${e._item!.id.clock}` === id);
    assert(el, `no block ${id} in the user's copy`);
    return el as Y.XmlElement;
  }

  /** Type `text` at `offset` in a paragraph, as the editor would (one local transaction). */
  type(id: string, offset: number, text: string): void {
    this.doc.transact(() => (this.block(id).get(0) as Y.XmlText).insert(offset, text), this.typing);
  }

  text(id: string): string {
    return (this.block(id).get(0) as Y.XmlText).toString().replace(/<[^>]+>/g, '');
  }

  markdown(): string {
    return docToMarkdown(this.frag.toArray().map((e) => elementToSpec(e as Y.XmlElement)));
  }
}

function seeded(md: string): LiveDoc {
  const live = new LiveDoc();
  live.doc.transact(() => live.frag.insert(0, parseMarkdown(md).map((s) => specToElement(s))), live.system);
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

const PARA = 'The launch moves to October after the legal review.';

function paragraphs(live: LiveDoc): View[] {
  return (live.read() as { blocks: View[] }).blocks;
}

Deno.test('a guarded rewrite from before the user typed is refused with guard_mismatch, and the user\'s text survives', () => {
  const live = seeded(`# Plan\n\n${PARA}\n\nSecond paragraph.`);
  const user = new UserClient(live);
  const read = live.read() as { rev: number; blocks: View[] };
  const p = read.blocks[1];
  assertEquals(p.md, PARA);
  assertEquals(p.h.length, 8);
  // The user types into P after the agent's read.
  user.type(p.id, PARA.indexOf('October') + 'October'.length, ' 6th');
  assert(live.rev > read.rev);
  const rewrite = {
    op: 'replace',
    target: { kind: 'blocks', ids: [p.id] },
    ifHash: p.h,
    ifRev: read.rev,
    with: { from: { kind: 'inline', content: 'Launch is in November.' }, as: 'text' },
  };
  const refused = refusal(() => live.edit([rewrite], live.originFor('agent', 'claude')));
  assertEquals(refused.code, 'guard_mismatch');
  const shown = (refused.toJSON() as { block: View }).block;
  assertEquals(shown.md, 'The launch moves to October 6th after the legal review.');
  assertEquals(shown.id, p.id);
  assertEquals(user.text(p.id), 'The launch moves to October 6th after the legal review.');
  assertEquals((live.read([p.id]) as { blocks: View[] }).blocks[0].md, 'The launch moves to October 6th after the legal review.');
  // Redone from what stands (the refusal's h and rev), it goes through.
  const ok = live.edit([{ ...rewrite, ifHash: shown.h, ifRev: (refused.toJSON() as { rev: number }).rev }], live.originFor('agent', 'claude'));
  assertEquals(ok.ok, true);
  assertEquals(user.text(p.id), 'Launch is in November.');
});

Deno.test('whole-block replace and delete need both guards (missing_guard), find needs none', () => {
  const live = seeded(`${PARA}\n\nTwo.`);
  const [p] = paragraphs(live);
  const agent = live.originFor('agent', 'claude');
  const bare = { op: 'delete', target: { kind: 'blocks', ids: [p.id] } };
  assertEquals(refusal(() => live.edit([bare], agent)).code, 'missing_guard');
  assertEquals(refusal(() => live.edit([{ ...bare, ifRev: live.rev }], agent)).code, 'missing_guard');
  assertEquals(refusal(() => live.edit([{ ...bare, ifHash: p.h }], agent)).code, 'missing_guard');
  assertEquals(refusal(() => live.edit([{ ...bare, ifHash: 'deadbeef', ifRev: live.rev }], agent)).code, 'guard_mismatch');
  live.edit([{ op: 'delete', target: { kind: 'find', text: ' after the legal review' } }], agent);
  assertEquals(paragraphs(live)[0].md, 'The launch moves to October.');
});

Deno.test('an agent find re-word in P and the user typing elsewhere in P at the same moment both survive', () => {
  const live = seeded(PARA);
  const user = new UserClient(live);
  const [p] = paragraphs(live);
  // The user's keystrokes are in flight (typed against the older state) when the agent's call lands.
  user.holdUp = true;
  user.type(p.id, 0, 'Update: ');
  user.type(p.id, user.text(p.id).length - 1, ' by counsel');
  const ack = live.edit([{
    op: 'replace',
    target: { kind: 'find', text: 'moves to October' },
    with: { from: { kind: 'inline', content: 'slips to November' }, as: 'text' },
  }], live.originFor('agent', 'claude'));
  assertEquals(ack.ok, true);
  user.release();
  const expected = 'Update: The launch slips to November after the legal review by counsel.';
  assertEquals(user.text(p.id), expected);
  assertEquals(paragraphs(live)[0].md, expected);
  // The agent's words carry its mark; the user's do not.
  const delta = (live.elements()[0].get(0) as Y.XmlText).toDelta();
  const marked = delta.filter((d) => d.attributes?.agentEdit).map((d) => d.insert).join('');
  assertEquals(marked, 'slipsNovem'); // minimal character edits: "ber" of October stays
});

Deno.test('a find whose words the user just changed is refused find_none', () => {
  const live = seeded(PARA);
  const user = new UserClient(live);
  const [p] = paragraphs(live);
  user.doc.transact(() => (user.block(p.id).get(0) as Y.XmlText).delete(PARA.indexOf('October'), 3), user.typing);
  const refused = refusal(() =>
    live.edit([{ op: 'replace', target: { kind: 'find', text: 'October' }, with: { from: { kind: 'inline', content: 'Nov' }, as: 'text' } }], live.originFor('agent', 'a'))
  );
  assertEquals(refused.code, 'find_none');
  assertEquals(user.text(p.id), 'The launch moves to ober after the legal review.');
});

Deno.test('a call is atomic: one bad op and nothing changed', () => {
  const live = seeded(`# Plan\n\n${PARA}\n\nTwo.`);
  const user = new UserClient(live);
  const before = { rev: live.rev, md: docToMarkdown(live.specs()), user: user.markdown() };
  const blocks = paragraphs(live);
  const refused = refusal(() =>
    live.edit([
      { op: 'insert', target: { kind: 'blocks', ids: [blocks[0].id] }, side: 'after', source: { from: { kind: 'inline', content: '- a\n- b' }, as: 'markdown' } },
      { op: 'replace', target: { kind: 'find', text: 'October' }, with: { from: { kind: 'inline', content: 'November' }, as: 'text' } },
      { op: 'delete', target: { kind: 'blocks', ids: [blocks[2].id] }, ifHash: blocks[2].h, ifRev: live.rev },
      { op: 'replace', target: { kind: 'find', text: 'words that are not there' }, with: { from: { kind: 'inline', content: 'x' }, as: 'text' } },
    ], live.originFor('agent', 'claude'))
  );
  assertEquals(refused.code, 'find_none');
  assertEquals((refused.toJSON() as { op: number }).op, 3);
  assertEquals(live.rev, before.rev);
  assertEquals(docToMarkdown(live.specs()), before.md);
  assertEquals(user.markdown(), before.user);
  // A stale guard on a later op refuses the whole call too.
  const stale = refusal(() =>
    live.edit([
      { op: 'replace', target: { kind: 'find', text: 'October' }, with: { from: { kind: 'inline', content: 'November' }, as: 'text' } },
      { op: 'delete', target: { kind: 'blocks', ids: [blocks[2].id] }, ifHash: 'ffffffff', ifRev: live.rev },
    ], live.originFor('agent', 'claude'))
  );
  assertEquals(stale.code, 'guard_mismatch');
  assertEquals(docToMarkdown(live.specs()), before.md);
});

Deno.test('doc_changes returns only the changed blocks, with deleted ones marked gone', () => {
  const live = seeded('# Plan\n\nOne.\n\nTwo.\n\nThree.');
  const user = new UserClient(live);
  const read = live.read() as { rev: number; blocks: View[] };
  const [, one, two, three] = read.blocks;
  user.type(one.id, 3, ' more');
  live.edit([{ op: 'delete', target: { kind: 'blocks', ids: [three.id] }, ifHash: three.h, ifRev: read.rev }], live.originFor('agent', 'claude'));
  const delta = live.changes(read.rev) as { rev: number; changed: (View & { by: string; after: string })[]; gone: string[] };
  assertEquals(delta.changed.map((b) => [b.id, b.md, b.by]), [[one.id, 'One more.', 'user']]);
  assertEquals(delta.changed[0].after, read.blocks[0].id);
  assertEquals(delta.gone, [three.id]);
  assert(!delta.changed.some((b) => b.id === two.id));
  assertEquals((live.changes(delta.rev) as { changed: unknown[]; gone: unknown[] }).changed.length, 0);
});

Deno.test('the user\'s undo never takes back the agent\'s edits; the agent\'s undo only its own', () => {
  const live = seeded(PARA);
  const user = new UserClient(live);
  const [p] = paragraphs(live);
  user.type(p.id, 0, 'Note: ');
  const agent = live.originFor('agent', 'claude');
  const agentUndo = live.undoFor(agent);
  live.edit([{ op: 'replace', target: { kind: 'find', text: 'legal review' }, with: { from: { kind: 'inline', content: 'security review' }, as: 'text' } }], agent);
  user.type(p.id, user.text(p.id).length, ' Done.');
  assertEquals(user.text(p.id), 'Note: The launch moves to October after the security review. Done.');
  user.undo.undo();
  user.undo.undo();
  assertEquals(user.text(p.id), 'The launch moves to October after the security review.');
  assertEquals(paragraphs(live)[0].md, 'The launch moves to October after the security review.');
  user.type(p.id, 0, 'Again: ');
  agentUndo.undo();
  assertEquals(user.text(p.id), 'Again: The launch moves to October after the legal review.');
});

Deno.test('Markdown round trip and the word diff', () => {
  const md = '# Title\n\nSome **bold** and *italic* and `code` text.\n\n- one\n- two\n\n1. first\n2. second\n\n> quoted\n\n```ts\nconst x = 1;\n```\n\n---\n';
  assertEquals(docToMarkdown(parseMarkdown(md)), md);
  const live = seeded(md);
  assertEquals(docToMarkdown(live.specs()), md);
  const a = 'The quick brown fox jumps.', b = 'The slow brown fox leaps.';
  const edits = diffText(a, b);
  assertEquals(edits.length, 2);
  let out = a;
  for (const e of [...edits].sort((x, y) => y.at - x.at)) out = out.slice(0, e.at) + e.ins + out.slice(e.at + e.del);
  assertEquals(out, b);
  assertEquals(specToMarkdown(parseMarkdown('## Head *it*')[0]), '## Head *it*');
});

async function tempDirs(): Promise<{ state: string; project: string; done: () => Promise<void> }> {
  const root = Deno.realPathSync(await Deno.makeTempDir({ prefix: 'aib-docs-' })).replace(/^\\\\\?\\/, '');
  const state = `${root}${sep}state`, project = `${root}${sep}project`;
  await Deno.mkdir(state), await Deno.mkdir(project);
  return { state, project, done: () => Deno.remove(root, { recursive: true }) };
}

Deno.test('the Markdown copy is written into the project; a file-tool edit to an untouched block is applied, one to a block the user changed is skipped and flagged', async () => {
  const dirs = await tempDirs();
  const store = new DocStore(dirs.state, { idleMs: 60_000 });
  try {
    await Deno.mkdir(`${dirs.project}${sep}docs`);
    await Deno.writeTextFile(`${dirs.project}${sep}docs${sep}plan.md`, '# Plan\n\nAlpha paragraph.\n\nBeta paragraph.\n\nGamma paragraph.\n');
    const doc = await store.open(dirs.project, 'plan');
    assertEquals(doc.mirrorPath, `${dirs.project}${sep}docs${sep}plan.md`);
    const user = new UserClient(doc.live);
    const [, alpha, beta, gamma] = paragraphs(doc.live);
    doc.live.edit([{ op: 'insert', target: { kind: 'root' }, side: 'end', source: { from: { kind: 'inline', content: 'Delta from the agent.' }, as: 'markdown' } }], doc.live.originFor('agent', 'claude'));
    await store.flush(doc);
    const mirrored = await Deno.readTextFile(doc.mirrorPath);
    assertEquals(mirrored, '# Plan\n\nAlpha paragraph.\n\nBeta paragraph.\n\nGamma paragraph.\n\nDelta from the agent.\n');
    // The user types into Beta (not yet mirrored); then an agent's file tool edits Alpha, Beta and Gamma's neighbour on disk.
    user.type(beta.id, 4, ' (user)');
    await Deno.writeTextFile(
      doc.mirrorPath,
      '# Plan\n\nAlpha paragraph, edited on disk.\n\nBeta paragraph from the file tool.\n\nGamma paragraph.\n\nNew block from the file.\n\nDelta from the agent.\n',
    );
    const skipped = await store.syncMirror(doc);
    assertEquals(skipped.map((s) => [s.reason, s.id, s.now, s.file]), [['user_changed', beta.id, 'Beta (user) paragraph.', 'Beta paragraph from the file tool.']]);
    const blocks = paragraphs(doc.live);
    assertEquals(blocks.map((b) => b.md), [
      '# Plan',
      'Alpha paragraph, edited on disk.',
      'Beta (user) paragraph.',
      'Gamma paragraph.',
      'New block from the file.',
      'Delta from the agent.',
    ]);
    assertEquals(blocks[1].id, alpha.id); // re-worded in place: same block
    assertEquals(blocks[3].id, gamma.id);
    assertEquals(user.text(beta.id), 'Beta (user) paragraph.');
    assertEquals(user.text(alpha.id), 'Alpha paragraph, edited on disk.');
    assertEquals(doc.skipped.length, 1);
    // The copy on disk is rewritten from the doc.
    assertEquals(await Deno.readTextFile(doc.mirrorPath), docToMarkdown(doc.live.specs()));
    // Saved state: a reopened store has the same blocks, ids and rev.
    const rev = doc.live.rev;
    await store.close();
    const again = new DocStore(dirs.state, { idleMs: 60_000 });
    const reopened = await again.open(dirs.project, 'docs/plan.md');
    assertEquals(paragraphs(reopened.live).map((b) => [b.id, b.md]), blocks.map((b) => [b.id, b.md]));
    assertEquals(reopened.live.rev, rev);
    await again.close();
  } finally {
    await store.close();
    await dirs.done();
  }
});

Deno.test('the saved state is compacted (one update, not the keystroke log)', async () => {
  const dirs = await tempDirs();
  const store = new DocStore(dirs.state, { idleMs: 60_000 });
  try {
    const doc = await store.open(dirs.project, 'notes');
    const user = new UserClient(doc.live);
    const [p] = paragraphs(doc.live);
    user.doc.transact(() => user.block(p.id).insert(0, [new Y.XmlText()]), user.typing);
    for (let i = 0; i < 300; i++) user.type(p.id, i, 'x');
    for (let i = 0; i < 250; i++) user.doc.transact(() => (user.block(p.id).get(0) as Y.XmlText).delete(0, 1), user.typing);
    await store.flush(doc);
    const size = (await Deno.stat(`${dirs.state}${sep}docs${sep}${doc.id}${sep}doc.bin`)).size;
    assert(size < 2000, `state is ${size} bytes`);
    assertEquals(await Deno.readTextFile(doc.mirrorPath), 'x'.repeat(50) + '\n');
  } finally {
    await store.close();
    await dirs.done();
  }
});

export type { Json };
