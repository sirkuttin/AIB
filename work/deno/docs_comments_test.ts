/**
 * Local docs' comments: threads anchored to words with Yjs relative positions (they follow the text through everyone's edits),
 * whole-doc notes, an agent edit that would remove anchored words refused with anchors_affected (allowDetach lets it through and
 * detaches the thread), the user deleting anchored words detaching the thread, who may resolve, `since`, a restart, no comments in
 * the Markdown copy, and "Send to agent" queueing the thread to the doc's chat.
 */
import { assert, assertEquals } from './_assert.ts';
import * as Y from 'yjs';
import { DocRefusal, type LiveDoc } from '../../outputs/agent-studio/server/docs/live_doc.ts';
import { DocStore } from '../../outputs/agent-studio/server/docs/store.ts';
import { runDocTool } from '../../outputs/agent-studio/server/docs/tools.ts';
import type { ThreadView } from '../../outputs/agent-studio/server/docs/comments.ts';
import { sendComment } from '../../outputs/agent-studio/server/web/docs_routes.ts';
import type { WebContext } from '../../outputs/agent-studio/server/web/server.ts';
import { seeded, UserClient } from './_docs.ts';

type Json = Record<string, unknown>;
const sep = Deno.build.os === 'windows' ? '\\' : '/';
const PARA = 'The launch moves to October after the legal review.';
const inline = (content: string, as = 'text') => ({ from: { kind: 'inline', content }, as });
const firstId = (live: LiveDoc) => (live.read() as { blocks: { id: string }[] }).blocks[0].id;

function refusal(fn: () => unknown): DocRefusal {
  try {
    fn();
  } catch (error) {
    if (error instanceof DocRefusal) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

/** The user deletes characters of a textblock in their copy, as the editor would. */
function userDelete(user: UserClient, id: string, at: number, length: number): void {
  user.doc.transact(() => (user.block(id).get(0) as Y.XmlText).delete(at, length), user.typing);
}

Deno.test('an anchor follows its words through inserts before them and inside them (not right after them)', () => {
  const live = seeded(PARA);
  const user = new UserClient(live);
  const id = firstId(live);
  const t = live.comments.add('user', 'Which day?', live.range({ kind: 'find', text: 'October' }), live.system);
  assertEquals([t.thread, t.on, t.quote, t.block, t.from], ['t1', 'words', 'October', id, PARA.indexOf('October')]);
  user.type(id, 0, 'Update: ');
  assertEquals(live.comments.get('t1').quote, 'October');
  user.type(id, user.text(id).indexOf('October') + 3, '-');
  user.type(id, user.text(id).indexOf('Oct-ober') + 'Oct-ober'.length, ' 6th');
  user.type(id, user.text(id).indexOf('Oct-ober'), 'early ');
  const now = live.comments.get('t1');
  assertEquals([now.quote, now.quoted, now.detached], ['Oct-ober', 'October', undefined]);
  assertEquals(user.text(id).slice(now.from, now.to), 'Oct-ober');
  // an agent's re-word elsewhere in the same paragraph is fine: the anchor moves with it
  const ack = live.edit(
    [{ op: 'replace', target: { kind: 'find', text: 'legal review' }, with: inline('board review') }],
    live.originFor('agent', 'claude'),
  );
  assertEquals([ack.ok, ack.detached], [true, undefined]);
  assertEquals(live.comments.get('t1').quote, 'Oct-ober');
  // a whole-block comment and a whole-doc note
  const whole = live.comments.add('claude', 'Is this the final wording?', live.range({ kind: 'blocks', ids: [id] }), live.system);
  assertEquals(whole.quote, user.text(id));
  const note = live.comments.add('user', 'Needs a timeline section.', null, live.system);
  assertEquals([note.on, note.quote, note.anchor], ['doc', undefined, undefined]);
  assertEquals(refusal(() => live.range({ kind: 'find', text: 'November' })).code, 'find_none');
});

Deno.test('an agent edit over anchored words is refused with anchors_affected; with allowDetach it lands and the thread is detached', () => {
  const live = seeded(`${PARA}\n\nSecond paragraph.`);
  const id = firstId(live);
  const agent = live.originFor('agent', 'claude');
  live.comments.add('user', 'Which day?', live.range({ kind: 'find', text: 'October' }), live.system);
  const resolved = live.comments.add('user', 'old', live.range({ kind: 'find', text: 'Second' }), live.system);
  live.comments.resolve('user', resolved.thread, { agent: false }, live.system);
  const before = live.rev;
  const reword = { op: 'replace', target: { kind: 'find', text: 'to October after' }, with: inline('to November after') };
  const refused = refusal(() => live.edit([reword], agent));
  assertEquals(refused.code, 'anchors_affected');
  const data = refused.toJSON() as { threads: Json[]; op: number };
  assertEquals(data.threads, [{ thread: 't1', quote: 'October', by: 'user', op: 0 }]);
  assert(refused.message.includes('allowDetach'), refused.message);
  assertEquals([live.rev, live.comments.get('t1').quote], [before, 'October']); // nothing changed
  // a whole-block delete of that paragraph, guarded, is refused too (second op of the call)
  const p = live.read() as { rev: number; blocks: { id: string; h: string }[] };
  const del = { op: 'delete', target: { kind: 'blocks', ids: [id] }, ifHash: p.blocks[0].h, ifRev: p.rev };
  const harmless = { op: 'replace', target: { kind: 'find', text: 'paragraph' }, with: inline('part') };
  assertEquals((refusal(() => live.edit([harmless, del], agent)).toJSON() as { op: number }).op, 1);
  // a resolved thread's words are not guarded
  assertEquals(live.edit([harmless], agent).ok, true);
  // allowDetach: the edit lands, the thread stays, detached
  const ack = live.edit([{ ...reword, allowDetach: true }], agent);
  assertEquals([ack.ok, ack.detached], [true, ['t1']]);
  assertEquals((live.read() as { blocks: { md: string }[] }).blocks[0].md, 'The launch moves to November after the legal review.');
  const t = live.comments.get('t1');
  assertEquals([t.detached, t.note, t.detachedBy, t.quote, t.resolved], [true, 'Text removed', 'claude', 'October', false]);
  assert(t.seq > 2);
});

Deno.test('the user deleting the anchored words detaches the thread (it stays); their undo attaches it again', () => {
  const live = seeded(`${PARA}\n\nSecond paragraph.`);
  const user = new UserClient(live);
  const id = firstId(live);
  live.comments.add('user', 'Which day?', live.range({ kind: 'find', text: 'October' }), live.system);
  const at = PARA.indexOf('October');
  userDelete(user, id, at, 3); // part of the words: the anchor shrinks, still attached
  assertEquals([live.comments.get('t1').quote, live.comments.get('t1').detached], ['ober', undefined]);
  userDelete(user, id, at - 1, 6); // " ober " : all of them gone
  let t = live.comments.get('t1');
  assertEquals([t.detached, t.note, t.quote, t.detachedBy], [true, 'Text removed', 'October', 'user']);
  assertEquals(live.comments.list().threads.length, 1);
  user.undo.undo();
  t = live.comments.get('t1');
  assertEquals([t.detached, t.quote?.trim()], [undefined, 'ober']); // back on the restored words
  // the whole block deleted: detached as well
  user.remove(id);
  assertEquals(live.comments.get('t1').detached, true);
});

async function tempDirs() {
  const root = Deno.realPathSync(await Deno.makeTempDir({ prefix: 'aib-docs-c-' })).replace(/^\\\\\?\\/, '');
  const state = `${root}${sep}state`, project = `${root}${sep}project`;
  await Deno.mkdir(state), await Deno.mkdir(project);
  return { state, project, done: () => Deno.remove(root, { recursive: true }).catch(() => {}) };
}

Deno.test('the comment tools: who may resolve, since, and the comments survive a restart but never reach the Markdown copy', async () => {
  const dirs = await tempDirs();
  let store = new DocStore(dirs.state, { idleMs: 60_000 });
  const tool = async (agent: string, name: string, args: Json) =>
    await runDocTool(store, dirs.project, agent, name, { doc: 'plan', ...args }, `${agent}:s1`);
  try {
    assert((await tool('claude', 'doc_create', { markdown: `# Plan\n\n${PARA}\n` }))[0]);
    const doc = await store.open(dirs.project, 'plan');
    assertEquals(doc.chat, 'claude:s1');
    const user = live(doc).comments.add('user', 'Which day exactly?', live(doc).range({ kind: 'find', text: 'October' }), live(doc).system);
    const [ok, mine] = await tool('claude', 'doc_comment', { target: { kind: 'find', text: 'legal review' }, text: 'Who signs it off?' });
    assertEquals([ok, mine.thread, mine.by, mine.quote], [true, 't2', 'claude', 'legal review']);
    const [, note] = await tool('claude', 'doc_comment', { text: 'I drafted this from the kickoff notes.' });
    assertEquals(note.on, 'doc');
    const [, all] = await tool('claude', 'doc_comments', {});
    assertEquals((all.threads as ThreadView[]).map((t) => t.thread), ['t1', 't2', 't3']);
    const seq = all.seq as number;
    assertEquals((await tool('claude', 'doc_comments', { since: seq }))[1].threads, []);
    // an agent may not resolve the user's thread unless the user asked; it may resolve its own
    const [no, refused] = await tool('claude', 'doc_resolve', { thread: user.thread });
    assertEquals([no, refused.code], [false, 'not_yours']);
    assertEquals((await tool('codex', 'doc_resolve', { thread: 't2' }))[1].code, 'not_yours'); // another agent's thread
    assertEquals((await tool('claude', 'doc_resolve', { thread: 't2' }))[1].resolved, true);
    const [, reply] = await tool('claude', 'doc_reply', { thread: user.thread, text: 'The 6th: see the launch calendar.' });
    assertEquals((reply.replies as { by: string }[]).map((r) => r.by), ['user', 'claude']);
    const [, newer] = await tool('claude', 'doc_comments', { since: seq });
    assertEquals((newer.threads as ThreadView[]).map((t) => t.thread), ['t1', 't2']);
    assertEquals((await tool('claude', 'doc_resolve', { thread: user.thread, userAsked: true }))[1].resolvedBy, 'claude');
    assertEquals((await tool('claude', 'doc_reply', { thread: 't9', text: 'x' }))[1].code, 'no_thread');
    assertEquals((await tool('claude', 'doc_comment', { text: '' }))[1].code, 'bad_op');
    const info = store.info(doc) as { comments: ThreadView[]; commentSeq: number; chat: string };
    assertEquals([info.comments.length, info.chat, info.commentSeq > seq], [3, 'claude:s1', true]);
    await store.close();
    const md = await Deno.readTextFile(`${dirs.project}${sep}docs${sep}plan.md`);
    assertEquals(md, `# Plan\n\n${PARA}\n`);
    // a restart: the threads, their anchors and the linked chat come back from the saved state
    store = new DocStore(dirs.state, { idleMs: 60_000 });
    const again = await store.open(dirs.project, 'plan');
    assertEquals(again.chat, 'claude:s1');
    const threads = again.live.comments.list().threads;
    assertEquals(threads.map((t) => [t.thread, t.quote ?? null, t.resolved, t.replies.length]), [
      ['t1', 'October', true, 2],
      ['t2', 'legal review', true, 1],
      ['t3', null, false, 1],
    ]);
    // the anchor still follows its words, and still guards them (t3 is a note; t1/t2 resolved: reopen t1 first)
    again.live.comments.reopen('user', 't1', again.live.system);
    const [no2, guarded] = await tool('claude', 'doc_edit', {
      ops: [{ op: 'replace', target: { kind: 'find', text: 'October' }, with: inline('November') }],
    });
    assertEquals([no2, guarded.code], [false, 'anchors_affected']);
  } finally {
    await store.close();
    await dirs.done();
  }
});

function live(doc: { live: LiveDoc }): LiveDoc {
  return doc.live;
}

Deno.test('"Send to agent" queues the thread as a user message to the linked chat (once per thread state)', async () => {
  const dirs = await tempDirs();
  const store = new DocStore(dirs.state, { idleMs: 60_000 });
  const calls: [string, Json][] = [];
  const connections = [{ id: 'conn-7', provider: 'claude', sessionId: 's1' }];
  const ctx = {
    docs: store,
    artifacts: {
      refresh: () => Promise.resolve(),
      connectionOf: (ident: string) => connections.find((c) => c.id === ident || `${c.provider}:${c.sessionId}` === ident)?.id ?? null,
      chatOf: (ident: string) => {
        const c = connections.find((c) => c.id === ident);
        return c ? `${c.provider}:${c.sessionId}` : ident;
      },
    },
    host: {
      liveCall: (name: string, body: Json) => {
        calls.push([name, body]);
        return Promise.resolve([200, { ok: true, accepted: true, duplicate: calls.length > 1 }] as [number, unknown]);
      },
    },
  } as unknown as WebContext;
  try {
    const doc = await store.open(dirs.project, 'plan', PARA);
    store.link(doc, 'claude:s1', true);
    const t = doc.live.comments.add('user', 'Make it the 6th.', doc.live.range({ kind: 'find', text: 'October' }), doc.live.system);
    const [status, sent] = await sendComment(ctx, doc, t.thread, doc.chat!);
    assertEquals(status, 200);
    assertEquals(calls[0][0], 'queue');
    assertEquals(calls[0][1].id, 'conn-7');
    const text = String(calls[0][1].text);
    assert(text.includes('"October"') && text.includes('Make it the 6th.') && text.includes('doc_reply'), text);
    assertEquals((sent as Json).chat, 'claude:s1');
    assertEquals((doc.live.comments.get(t.thread).sent as Json).chat, 'claude:s1');
    await sendComment(ctx, doc, t.thread, 'claude:s1');
    assertEquals(calls[1][1].clientMessageId, calls[0][1].clientMessageId); // the same thread state: one message
    assertEquals((await sendComment(ctx, doc, t.thread, 'codex:gone'))[0], 409);
    assertEquals((await sendComment(ctx, doc, 't99', 'claude:s1'))[0], 404);
  } finally {
    await store.close();
    await dirs.done();
  }
});
