/**
 * Regression tests for the sync code review (aib-shared/reviews/sync-code-review.md): two in-process AIB servers (_pcsync_fixture.ts)
 * with two linked temp git projects, Docs on. Covered: a drawing made on A reaches B and then nothing moves (M1: the per-PC doc key
 * is out of the file), a shape deleted on A stays deleted, a comment (and its reply and resolve) reaches a doc open on the other PC
 * and both reach "up to date" (M2), a synced doc nobody opened is not kept open, a case-only name clash is held without a loop (S1),
 * git awareness (S2: a merge in progress, another branch, autostash), the mass-delete guard on a tiny and on a staggered wipe (S3),
 * Keep files surviving a restart (S4), the bin's size cap and Restore (S6), and the listener's body cap and per-source rate limit (S8).
 */
import { assert, assertEquals } from './_assert.ts';
import { LOGIN, pc, tempDir } from './_remote_fixture.ts';
import { UserClient } from './_docs.ts';
import { runDocTool } from '../../app/server/docs/tools.ts';
import { readModels } from '../../app/server/docs/drawing/model.ts';
import { stamp } from '../../app/server/pcsync/rules.ts';
import { closeAll, type Json, listener, type Node, paired, serveHeaders, TEST_FILES, tokenToA, until } from './_pcsync_fixture.ts';

const OPTS = { sanitizeResources: false, sanitizeOps: false };
const sep = Deno.build.os === 'windows' ? '\\' : '/';
const WAIT = 25_000;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- helpers -------------------------------------------------------------------------------------------------------------------
async function git(cwd: string, ...args: string[]) {
  const out = await new Deno.Command('git', { args, cwd, stdout: 'piped', stderr: 'piped' }).output();
  if (!out.success) throw new Error(`git ${args.join(' ')}: ${new TextDecoder().decode(out.stderr)}`);
  return new TextDecoder().decode(out.stdout).trim();
}
async function repo(parent: string, name: string, remote: string): Promise<string> {
  const top = `${parent}${sep}${name}`;
  await Deno.mkdir(top, { recursive: true });
  await git(top, 'init', '-q');
  await git(top, 'remote', 'add', 'origin', remote);
  return top;
}
function captureFrames(): { frames: string[]; stop: () => void } {
  const frames: string[] = [];
  const original = WebSocket.prototype.send;
  WebSocket.prototype.send = function (this: WebSocket, data: Parameters<WebSocket['send']>[0]) {
    if (typeof data === 'string') frames.push(data);
    return original.call(this, data);
  };
  return { frames, stop: () => (WebSocket.prototype.send = original) };
}
/** Every file item of the captured frames from `from` on: "op:path". */
function fileItems(frames: string[], from = 0): string[] {
  const out: string[] = [];
  for (const f of frames.slice(from)) {
    let frame: { items?: { op: string; path?: string }[] };
    try {
      frame = JSON.parse(f);
    } catch {
      continue;
    }
    for (const i of frame.items ?? []) if (i.op.startsWith('file.')) out.push(`${i.op}:${i.path ?? ''}`);
  }
  return out;
}
interface FileView {
  state: string;
  reason: string;
  pending: number;
  held: { path: string; why: string }[];
  pause: { deletes: number; total: number } | null;
}
const projectsOf = async (n: Node) => {
  const [, v] = await pc(n.s, 'GET', '/api/live/pcsync');
  return (v.peers as Json[])[0].projects as { links: { sync: string; autoStash: string[]; docsFiles: FileView | null }[] };
};
const docsStatus = async (n: Node): Promise<FileView> => (await projectsOf(n)).links[0].docsFiles!;
const connected = (n: Node) => n.s.ctx.pcsync.links.links().length === 1;

interface Setup {
  a: Node;
  b: Node;
  aRepo: string;
  bRepo: string;
  aDocs: string;
  bDocs: string;
  sync: string;
}
async function setup(files = TEST_FILES, beforeOn?: (t: Setup) => Promise<void> | void, on = true): Promise<Setup> {
  const [a, b] = await paired(files);
  try {
    const aRepo = await repo(await tempDir('aib-rev-a-'), 'shop', 'git@github.com:Acme/Shop.git');
    const bRepo = await repo(await tempDir('aib-rev-b-'), 'shop-clone', 'https://github.com/acme/shop');
    await a.s.ctx.addedProjects.add(aRepo);
    await b.s.ctx.addedProjects.add(bRepo);
    await until('both links up', () => connected(a) && connected(b));
    await a.s.ctx.pcsync.projects.refresh(true);
    await b.s.ctx.pcsync.projects.refresh(true);
    await until('linked', async () => (await projectsOf(a)).links.length === 1 && (await projectsOf(b)).links.length === 1, WAIT);
    const t: Setup = {
      a,
      b,
      aRepo,
      bRepo,
      aDocs: `${aRepo}${sep}aib-docs`,
      bDocs: `${bRepo}${sep}aib-docs`,
      sync: (await projectsOf(a)).links[0].sync,
    };
    await beforeOn?.(t);
    if (on) await bothOn(t);
    return t;
  } catch (error) {
    await closeAll([a, b]);
    throw error;
  }
}
async function setDocs(n: Node, sync: string, on: boolean) {
  const [status, body] = await pc(n.s, 'POST', '/api/live/pcsync/projects/switch', { sync, which: 'docs', on });
  assertEquals(status, 200, JSON.stringify(body));
  return body;
}
async function bothOn(t: Setup) {
  await setDocs(t.a, t.sync, true);
  await setDocs(t.b, t.sync, true);
  await until('both PCs are up to date', async () => (await docsStatus(t.a)).state === 'ok' && (await docsStatus(t.b)).state === 'ok', WAIT);
}
const calm = async (t: Setup) => {
  const [x, y] = [await docsStatus(t.a), await docsStatus(t.b)];
  return x.state === 'ok' && y.state === 'ok' && x.pending === 0 && y.pending === 0;
};
const settled = (t: Setup, what = 'both PCs are up to date') => until(what, () => calm(t), WAIT);
const path = (dir: string, rel: string) => `${dir}${sep}${rel.split('/').join(sep)}`;
const read = (dir: string, rel: string): string | null => {
  try {
    return Deno.readTextFileSync(path(dir, rel));
  } catch {
    return null;
  }
};
const has = (dir: string, rel: string) => read(dir, rel) !== null;
/** A minimal valid doc.aibdoc, written straight to disk. */
const miniDoc = (word: string) =>
  JSON.stringify({
    format: 'aibdoc',
    version: 1,
    title: word,
    pages: [{ id: 'p1', title: word, content: [{ type: 'paragraph', id: 'b1', content: [{ type: 'text', text: word }] }] }],
    comments: [],
    drawings: [],
  });
function putDoc(dir: string, name: string) {
  Deno.mkdirSync(path(dir, name), { recursive: true });
  Deno.writeTextFileSync(path(dir, `${name}/doc.aibdoc`), miniDoc(name));
}
const rmDoc = (dir: string, name: string) => Deno.removeSync(path(dir, name), { recursive: true });
const runTool = (n: Node, root: string, name: string, args: Record<string, unknown>) => runDocTool(n.s.ctx.docs, root, 'claude', name, args);
const aibOf = (dir: string, name: string) => JSON.parse(read(dir, `${name}/doc.aibdoc`) ?? '{"comments":[],"drawings":[]}');
const shapes = (dir: string, name: string) =>
  ((aibOf(dir, name).drawings ?? []) as { elements: { id: string }[] }[]).flatMap((d) => d.elements.map((e) => e.id)).sort().join(',');
const assetShapes = (dir: string, name: string, file: string): string => {
  try {
    return ((JSON.parse(read(dir, `${name}/assets/${file}`)!).elements ?? []) as { id: string }[])  .map((e) => e.id).filter((id) => !id.endsWith('-label')).sort().join(',');
  } catch {
    return '?';
  }
};

// ---- M1: drawings --------------------------------------------------------------------------------------------------------------
Deno.test({
  ...OPTS,
  name:
    'a drawing made on A reaches B (doc open there) and then no file frame moves; a shape deleted on A stays deleted on both PCs (review M1)',
  async fn() {
    const cap = captureFrames();
    const t = await setup();
    try {
      const doc = await t.a.s.ctx.docs.open(t.aRepo, 'plan', 'Intro\n', 'user');
      await t.a.s.ctx.docs.flush(doc);
      await runTool(t.a, t.aRepo, 'drawing_create', { doc: 'plan', caption: 'Flow' });
      await runTool(t.a, t.aRepo, 'drawing_edit', {
        doc: 'plan',
        drawing: 'flow',
        ops: [{ op: 'add_box', text: 'Build', id: 'B' }, { op: 'add_box', text: 'Test', near: 'B', id: 'T' }],
      });
      await t.a.s.ctx.docs.flush(doc);
      await until('B has the drawing files and the doc', () => has(t.bDocs, 'plan/assets/flow.excalidraw') && has(t.bDocs, 'plan/doc.aibdoc'), WAIT);
      const bdoc = await t.b.s.ctx.docs.open(t.bRepo, 'plan'); // open on B: the path that used to bounce
      await until('B holds both shapes', () => shapes(t.bDocs, 'plan') === 'B,T' && readModels(bdoc.live.doc, 'flow').length === 2, WAIT);
      await settled(t);
      // a fixed point: the doc keys in the files are the same on both PCs, so nobody rewrites anything
      assertEquals(read(t.aDocs, 'plan/assets/flow.excalidraw'), read(t.bDocs, 'plan/assets/flow.excalidraw'), 'the drawing file is the same bytes');
      const n0 = cap.frames.length;
      await wait(3500);
      assertEquals(fileItems(cap.frames, n0), [], 'an idle pair sends no file frame');
      assert((await calm(t)), 'and nothing is pending');
      // a shape deleted on A
      await runTool(t.a, t.aRepo, 'drawing_edit', { doc: 'plan', drawing: 'flow', ops: [{ op: 'delete', id: 'T', ifV: 1 }] });
      await t.a.s.ctx.docs.flush(doc);
      await until(
        'T is gone on B (file and open doc)',
        () => assetShapes(t.bDocs, 'plan', 'flow.excalidraw') === 'B' && shapes(t.bDocs, 'plan') === 'B' && readModels(bdoc.live.doc, 'flow').length === 1,
        WAIT,
      );
      await settled(t);
      await wait(1500); // the last file.state echoes (a rewrite with the same content only moves its mtime) are over
      const n1 = cap.frames.length;
      await wait(3500);
      assertEquals(fileItems(cap.frames, n1), [], 'quiet again after the delete');
      for (const [dir, who] of [[t.aDocs, 'A'], [t.bDocs, 'B']]) {
        assertEquals(assetShapes(dir, 'plan', 'flow.excalidraw'), 'B', `T stays deleted in ${who}'s drawing file`);
        assertEquals(shapes(dir, 'plan'), 'B', `T stays deleted in ${who}'s doc.aibdoc`);
      }
      assertEquals(readModels(doc.live.doc, 'flow').map((m) => m.id), ['B'], 'and in A’s open doc');
    } finally {
      cap.stop();
      await closeAll([t.a, t.b]);
    }
  },
});

// ---- M2: comments --------------------------------------------------------------------------------------------------------------
Deno.test({
  ...OPTS,
  name: 'a comment, its reply and its resolve made on A reach the doc open on B, and both PCs reach "up to date" (review M2)',
  async fn() {
    const t = await setup();
    try {
      const doc = await t.a.s.ctx.docs.open(t.aRepo, 'plan', 'One\n\nTwo\n', 'user');
      await t.a.s.ctx.docs.flush(doc);
      await until('B has the doc', () => has(t.bDocs, 'plan/doc.aibdoc'), WAIT);
      const bdoc = await t.b.s.ctx.docs.open(t.bRepo, 'plan'); // open on B
      await settled(t);
      const thread = doc.live.comments.add('user', 'A comment made on A', null, doc.live.system);
      await t.a.s.ctx.docs.flush(doc);
      await until('B’s file and open doc have the comment', () => aibOf(t.bDocs, 'plan').comments.length === 1 && bdoc.live.comments.list().threads.length === 1, WAIT);
      await settled(t, 'both PCs reach up to date (not "syncing" for good)');
      // a reply and a resolve on A
      doc.live.comments.reply('user', thread.thread, 'A reply', doc.live.system);
      await t.a.s.ctx.docs.flush(doc);
      await until('the reply reaches B’s open doc', () => bdoc.live.comments.list().threads[0].replies.length === 2, WAIT);
      doc.live.comments.resolve('user', thread.thread, { agent: false }, doc.live.system);
      await t.a.s.ctx.docs.flush(doc);
      await until('the resolve reaches B’s open doc', () => bdoc.live.comments.list().threads[0].resolved === true, WAIT);
      await settled(t);
      assertEquals(aibOf(t.aDocs, 'plan').comments.length, 1, 'A keeps it');
      assertEquals(aibOf(t.bDocs, 'plan').comments.length, 1);
      // a later block edit on A still reaches B, and the comment is still on both
      const user = new UserClient(doc.live);
      const id = doc.live.topIds()[0];
      user.type(id, user.text(id).length, ' (A edit)');
      await t.a.s.ctx.docs.flush(doc);
      await until('the edit reaches B', () => bdoc.live.markdownOf(bdoc.live.topIds()[0]).includes('(A edit)'), WAIT);
      await settled(t);
      assertEquals(bdoc.live.comments.list().threads.length, 1);
      doc.live.detach(user.link);
    } finally {
      await closeAll([t.a, t.b]);
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'a synced doc nobody opened is not kept open on the receiving PC (its page copies are still rendered); a doc someone has open stays open',
  async fn() {
    const t = await setup();
    try {
      for (const n of ['one', 'two', 'three']) {
        const doc = await t.a.s.ctx.docs.open(t.aRepo, n, `${n} words\n`, 'user');
        await t.a.s.ctx.docs.flush(doc);
      }
      await until('B has all three', () => ['one', 'two', 'three'].every((n) => has(t.bDocs, `${n}/doc.aibdoc`)), WAIT);
      await settled(t);
      await until('B rendered the page copies', () => ['one', 'two', 'three'].every((n) => (read(t.bDocs, `${n}/01-page-1.md`) ?? '').includes(`${n} words`)), WAIT);
      await until('B keeps none of them open', () => t.b.s.ctx.docs.docs.size === 0, WAIT);
      // an edit on A lands again, still not kept open
      const one = await t.a.s.ctx.docs.open(t.aRepo, 'one');
      const user = new UserClient(one.live);
      const id = one.live.topIds()[0];
      user.type(id, user.text(id).length, ' more');
      await t.a.s.ctx.docs.flush(one);
      await until('B has the edit', () => (read(t.bDocs, 'one/01-page-1.md') ?? '').includes('one words more'), WAIT);
      await until('still none open on B', () => t.b.s.ctx.docs.docs.size === 0, WAIT);
      // a doc open on B (a page is on it) stays open through a landing
      const bone = await t.b.s.ctx.docs.open(t.bRepo, 'one');
      user.type(id, user.text(id).length, ' again');
      await t.a.s.ctx.docs.flush(one);
      await until('B’s open doc has it', () => bone.live.markdownOf(bone.live.topIds()[0]).includes('again'), WAIT);
      assert(t.b.s.ctx.docs.docs.has(bone.id), 'the open doc is still open');
      one.live.detach(user.link);
    } finally {
      await closeAll([t.a, t.b]);
    }
  },
});

// ---- S1: case-only clash -------------------------------------------------------------------------------------------------------
Deno.test({
  ...OPTS,
  name: 'a file whose name differs only in case from one this PC has is held with a plain reason and not pulled again and again (review S1)',
  async fn() {
    const cap = captureFrames();
    const t = await setup();
    try {
      const insensitive = Deno.build.os !== 'linux';
      await makeAssetDoc(t);
      Deno.writeTextFileSync(path(t.aDocs, 'plan/assets/notes.md'), 'lower\n');
      await until('B has notes.md', () => has(t.bDocs, 'plan/assets/notes.md'), WAIT);
      await settled(t);
      // the other PC (Linux) also holds Notes.md: its state arrives on B
      const peer = t.b.s.ctx.pcsync.peers.list()[0];
      t.b.s.ctx.pcsync.docsSync.onBatch(peer, {
        id: 'case-test',
        project: t.sync,
        items: [{ op: 'file.state', area: 'docs', path: 'plan/assets/Notes.md', hash: 'c'.repeat(64), size: 6, mtime: Date.now(), sup: [] }],
      });
      if (!insensitive) {
        await wait(300);
        return; // a case-sensitive disk holds both names: nothing to hold
      }
      await until('B holds it with a reason', async () => (await docsStatus(t.b)).held.some((h) => h.path === 'plan/assets/Notes.md'), WAIT);
      const why = (await docsStatus(t.b)).held.find((h) => h.path === 'plan/assets/Notes.md')!.why;
      assert(why.includes('differs only in case'), why);
      const n0 = cap.frames.length;
      await wait(2500);
      assertEquals(fileItems(cap.frames, n0).filter((i) => i.startsWith('file.get:')), [], 'it is not asked for again (no re-download loop)');
      assertEquals(read(t.bDocs, 'plan/assets/notes.md'), 'lower\n', 'the file B has is untouched');
    } finally {
      cap.stop();
      await closeAll([t.a, t.b]);
    }
  },
});
async function makeAssetDoc(t: Setup) {
  const doc = await t.a.s.ctx.docs.open(t.aRepo, 'plan', 'Intro\n', 'user');
  await t.a.s.ctx.docs.flush(doc);
  await until('B has the doc', () => has(t.bDocs, 'plan/doc.aibdoc'), WAIT);
  Deno.mkdirSync(path(t.aDocs, 'plan/assets'), { recursive: true });
}

// ---- S2: git awareness ---------------------------------------------------------------------------------------------------------
Deno.test({
  ...OPTS,
  name: 'docs sync waits while a merge is in progress here (MERGE_HEAD), says so on the card, and carries on when it is over (review S2)',
  async fn() {
    const t = await setup();
    try {
      const mergeHead = `${t.bRepo}${sep}.git${sep}MERGE_HEAD`;
      Deno.writeTextFileSync(mergeHead, 'a'.repeat(40) + '\n');
      await t.b.s.ctx.pcsync.docsSync.rescanNow();
      await until('B shows waiting', async () => (await docsStatus(t.b)).state === 'waiting', WAIT);
      assert((await docsStatus(t.b)).reason.includes('merge'), (await docsStatus(t.b)).reason);
      const doc = await t.a.s.ctx.docs.open(t.aRepo, 'plan', 'Made on A\n', 'user');
      await t.a.s.ctx.docs.flush(doc);
      await wait(2000);
      assert(!has(t.bDocs, 'plan/doc.aibdoc'), 'nothing arrives while the merge runs');
      Deno.removeSync(mergeHead);
      await until('the doc arrives when the merge is over', () => has(t.bDocs, 'plan/doc.aibdoc'), WAIT);
      await settled(t);
      // a rebase in progress waits the same way, on A, and nothing of A's travels
      const rebase = `${t.aRepo}${sep}.git${sep}rebase-merge`;
      Deno.mkdirSync(rebase);
      await t.a.s.ctx.pcsync.docsSync.rescanNow();
      await until('A shows waiting', async () => (await docsStatus(t.a)).state === 'waiting', WAIT);
      assert((await docsStatus(t.a)).reason.includes('rebase'), (await docsStatus(t.a)).reason);
      const second = await t.a.s.ctx.docs.open(t.aRepo, 'later', 'Second\n', 'user');
      await t.a.s.ctx.docs.flush(second);
      await wait(1800);
      assert(!has(t.bDocs, 'later/doc.aibdoc'), 'a rebase on A holds A’s changes back');
      Deno.removeSync(rebase, { recursive: true });
      await until('it arrives after the rebase', () => has(t.bDocs, 'later/doc.aibdoc'), WAIT);
    } finally {
      await closeAll([t.a, t.b]);
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'docs sync only while both PCs are on the same branch: otherwise "waiting: <pc> is on branch X" and nothing travels (review S2)',
  async fn() {
    const t = await setup();
    try {
      const headFile = `${t.bRepo}${sep}.git${sep}HEAD`;
      const was = Deno.readTextFileSync(headFile);
      Deno.writeTextFileSync(headFile, 'ref: refs/heads/other\n'); // B switched branch
      await t.b.s.ctx.pcsync.docsSync.rescanNow();
      await until('A waits', async () => (await docsStatus(t.a)).state === 'waiting', WAIT);
      const reason = (await docsStatus(t.a)).reason;
      assert(reason.includes('ubuntu-pc is on branch other'), reason);
      await until('B waits too', async () => (await docsStatus(t.b)).state === 'waiting', WAIT);
      assert((await docsStatus(t.b)).reason.includes('studio-pc is on branch'), (await docsStatus(t.b)).reason);
      const doc = await t.a.s.ctx.docs.open(t.aRepo, 'plan', 'Made on A\n', 'user');
      await t.a.s.ctx.docs.flush(doc);
      await wait(2200);
      assert(!has(t.bDocs, 'plan/doc.aibdoc'), 'nothing crosses to another branch');
      Deno.writeTextFileSync(headFile, was);
      await t.b.s.ctx.pcsync.docsSync.rescanNow();
      await until('the doc arrives when the branches match again', () => has(t.bDocs, 'plan/doc.aibdoc'), WAIT);
      await settled(t);
    } finally {
      await closeAll([t.a, t.b]);
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'ticking Docs on a repo that tracks aib-docs turns on repo-local merge.autoStash and rebase.autoStash and the card says so (review S2)',
  async fn() {
    const t = await setup(TEST_FILES, async (s) => {
      // A tracks aib-docs; the owner already set rebase.autoStash to false there: it is left as it is
      Deno.mkdirSync(path(s.aDocs, 'old'), { recursive: true });
      Deno.writeTextFileSync(path(s.aDocs, 'old/doc.aibdoc'), miniDoc('old'));
      await git(s.aRepo, 'add', 'aib-docs');
      await git(s.aRepo, 'config', '--local', 'rebase.autoStash', 'false');
    }, false);
    try {
      const body = await setDocs(t.a, t.sync, true);
      assertEquals(body.autoStash, ['merge.autoStash']);
      assertEquals(await git(t.aRepo, 'config', '--local', '--get', 'merge.autoStash'), 'true');
      assertEquals(await git(t.aRepo, 'config', '--local', '--get', 'rebase.autoStash'), 'false', "the owner's choice stays");
      assertEquals((await projectsOf(t.a)).links[0].autoStash, ['merge.autoStash'], 'the card has it');
      // B does not track aib-docs: nothing is touched there
      const other = await setDocs(t.b, t.sync, true);
      assertEquals(other.autoStash, []);
      const [, , code] = await new Deno.Command('git', { args: ['config', '--local', '--get', 'merge.autoStash'], cwd: t.bRepo, stdout: 'null', stderr: 'null' })
        .output().then((o) => [0, 0, o.code]);
      assertEquals(code, 1, 'no setting in B’s repo');
      assertEquals((await projectsOf(t.b)).links[0].autoStash, []);
    } finally {
      await closeAll([t.a, t.b]);
    }
  },
});

// ---- S3 and S4: the mass-delete guard, and Keep files across a restart --------------------------------------------------------------
Deno.test({
  ...OPTS,
  name: 'a wipe of a small folder (3 files, all of them) pauses on the other PC whatever the count; Keep files brings them back (review S3)',
  async fn() {
    const t = await setup();
    try {
      for (const n of ['d1', 'd2', 'd3']) putDoc(t.aDocs, n);
      await until('B has all three', () => ['d1', 'd2', 'd3'].every((n) => has(t.bDocs, `${n}/doc.aibdoc`)), WAIT);
      await settled(t);
      for (const n of ['d1', 'd2', 'd3']) rmDoc(t.aDocs, n);
      await until('B pauses', async () => (await docsStatus(t.b)).pause !== null, WAIT);
      assertEquals((await docsStatus(t.b)).pause, { deletes: 3, total: 3 });
      assert(['d1', 'd2', 'd3'].every((n) => has(t.bDocs, `${n}/doc.aibdoc`)), 'the files stay on B');
      const [status] = await pc(t.b.s, 'POST', '/api/live/pcsync/projects/files', { sync: t.sync, which: 'docs', action: 'keep' });
      assertEquals(status, 200);
      await until('A has them back', () => ['d1', 'd2', 'd3'].every((n) => has(t.aDocs, `${n}/doc.aibdoc`)), WAIT);
      await settled(t);
    } finally {
      await closeAll([t.a, t.b]);
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'a wipe that arrives in two halves (8 then 8 of 20 files, over two scans) pauses at the second half (review S3)',
  async fn() {
    const t = await setup();
    try {
      const names = Array.from({ length: 20 }, (_, i) => `n${String(i + 1).padStart(2, '0')}`);
      for (const n of names) putDoc(t.aDocs, n);
      await until('B has all 20', () => names.every((n) => has(t.bDocs, `${n}/doc.aibdoc`)), WAIT * 2);
      await settled(t);
      for (const n of names.slice(0, 8)) rmDoc(t.aDocs, n);
      await until('B applied the first half', () => names.slice(0, 8).every((n) => !has(t.bDocs, `${n}/doc.aibdoc`)), WAIT);
      assertEquals((await docsStatus(t.b)).pause, null, 'a delete of 8 of 20 alone is not paused');
      for (const n of names.slice(8, 16)) rmDoc(t.aDocs, n);
      await until('B pauses at the second half', async () => (await docsStatus(t.b)).pause !== null, WAIT);
      assert(names.slice(8).every((n) => has(t.bDocs, `${n}/doc.aibdoc`)), 'the second half stays on B');
    } finally {
      await closeAll([t.a, t.b]);
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'Keep files survives a restart of the PC that chose it before the other PC pulled: the files come back and both settle (review S4)',
  async fn() {
    const t = await setup();
    try {
      for (const n of ['d1', 'd2', 'd3']) putDoc(t.aDocs, n);
      await until('B has all three', () => ['d1', 'd2', 'd3'].every((n) => has(t.bDocs, `${n}/doc.aibdoc`)), WAIT);
      await settled(t);
      for (const n of ['d1', 'd2', 'd3']) rmDoc(t.aDocs, n);
      await until('B pauses', async () => (await docsStatus(t.b)).pause !== null, WAIT);
      // B keeps its files while A is not listening, and B restarts before A could pull them
      t.a.s.ctx.pcsync.docsSync.stop();
      const [status] = await pc(t.b.s, 'POST', '/api/live/pcsync/projects/files', { sync: t.sync, which: 'docs', action: 'keep' });
      assertEquals(status, 200);
      await wait(300);
      await t.b.restart();
      t.a.s.ctx.pcsync.docsSync.start();
      await until('A has the files back', () => ['d1', 'd2', 'd3'].every((n) => has(t.aDocs, `${n}/doc.aibdoc`)), WAIT * 2);
      await settled(t);
    } finally {
      await closeAll([t.a, t.b]);
    }
  },
});

// ---- S6: the bin's size cap and Restore ------------------------------------------------------------------------------------------
Deno.test({
  ...OPTS,
  name: 'the sync bin of a project is kept under its size cap, oldest folders first (review S6)',
  async fn() {
    const hour = 3600_000;
    const names: string[] = [];
    const t = await setup({ ...TEST_FILES, binMaxBytes: 100_000 }, (s) => {
      const bin = `${s.bRepo}${sep}.git${sep}aib-sync${sep}bin`;
      for (let k = 4; k >= 1; k--) {
        const name = stamp(new Date(Date.now() - k * hour));
        names.push(name);
        Deno.mkdirSync(`${bin}${sep}${name}`, { recursive: true });
        Deno.writeFileSync(`${bin}${sep}${name}${sep}big.bin`, new Uint8Array(60_000));
      }
    });
    try {
      const bin = `${t.bRepo}${sep}.git${sep}aib-sync${sep}bin`;
      await until('the bin is under the cap', () => [...Deno.readDirSync(bin)].length === 1, WAIT);
      assertEquals([...Deno.readDirSync(bin)].map((e) => e.name), [names[3]], 'the newest folder stays, the older ones went first');
    } finally {
      await closeAll([t.a, t.b]);
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'the Sync card lists a project’s recent bin entries, and Restore puts one back (and it reaches the other PC); a bad entry is refused (review S6)',
  async fn() {
    const t = await setup();
    try {
      for (const n of ['keep', 'gone']) putDoc(t.aDocs, n);
      await until('B has both', () => ['keep', 'gone'].every((n) => has(t.bDocs, `${n}/doc.aibdoc`)), WAIT);
      await settled(t);
      rmDoc(t.aDocs, 'gone'); // 1 of 2 deleted: not a wipe
      await until('B deleted it', () => !has(t.bDocs, 'gone/doc.aibdoc'), WAIT);
      await settled(t);
      const [status, listed] = await pc(t.b.s, 'POST', '/api/live/pcsync/projects/bin', { sync: t.sync });
      assertEquals(status, 200);
      const entries = listed.entries as { id: string; area: string; path: string; at: string }[];
      const entry = entries.find((e) => e.path === 'gone/doc.aibdoc');
      assert(entry && entry.area === 'docs', JSON.stringify(entries));
      const [bad] = await pc(t.b.s, 'POST', '/api/live/pcsync/projects/restore', { sync: t.sync, entry: '20200101-000000-docs/../../x' });
      assertEquals(bad, 409, 'a path out of the bin is refused');
      const [nope] = await pc(t.b.s, 'POST', '/api/live/pcsync/projects/restore', { sync: t.sync, entry: '20200101-000000-docs/zzz/doc.aibdoc' });
      assertEquals(nope, 409, 'an entry that is not there is refused');
      const [ok] = await pc(t.b.s, 'POST', '/api/live/pcsync/projects/restore', { sync: t.sync, entry: entry.id });
      assertEquals(ok, 200);
      assert(has(t.bDocs, 'gone/doc.aibdoc'), 'it is back on B');
      await until('and on A', () => has(t.aDocs, 'gone/doc.aibdoc'), WAIT);
      await settled(t);
    } finally {
      await closeAll([t.a, t.b]);
    }
  },
});

// ---- S8: the listener -----------------------------------------------------------------------------------------------------------
Deno.test({
  ...OPTS,
  name: 'the listener reads at most 4 KB of a body even when it is chunked, and one source’s wrong tokens never lock out the real peer (review S8)',
  async fn() {
    const [a, b] = await paired(TEST_FILES);
    try {
      // a chunked body with no Content-Length: refused 413 as soon as it is over the cap, without waiting for its end
      const conn = await Deno.connect({ hostname: '127.0.0.1', port: a.s.ctx.pcsync.port });
      try {
        const head = Object.entries({ ...serveHeaders(a), 'Transfer-Encoding': 'chunked', 'Content-Type': 'application/json', Connection: 'close' })
          .map(([k, v]) => `${k}: ${v}`).join('\r\n');
        await conn.write(new TextEncoder().encode(`POST /pcsync/hello HTTP/1.1\r\n${head}\r\n\r\n`));
        const chunk = new TextEncoder().encode(`1000\r\n${'x'.repeat(4096)}\r\n`);
        void (async () => {
          for (let i = 0; i < 4; i++) await conn.write(chunk).catch(() => {});
        })();
        const buf = new Uint8Array(2048);
        const got = await Promise.race([conn.read(buf), wait(8000).then(() => -1)]);
        assert(got !== -1 && got !== null, 'the listener answered without waiting for the end of the body');
        assert(new TextDecoder().decode(buf.subarray(0, got as number)).startsWith('HTTP/1.1 413'), 'with 413');
      } finally {
        try {
          conn.close();
        } catch { /* closed */ }
      }
      // a flood of wrong tokens from one source ...
      const token = tokenToA(b);
      const from = (ip: string) => ({ 'X-Forwarded-For': ip });
      let last = 0;
      for (let i = 0; i < 25; i++) last = (await listener(a, '/pcsync/hello', { token: 'y'.repeat(43) }, from('10.0.0.9'))).status;
      assertEquals(last, 429, 'that source is slowed down');
      // ... does not stop the real peer, from its own address or from the flooding one
      assertEquals((await listener(a, '/pcsync/hello', { token }, from('100.64.0.2'))).status, 200, 'the real peer’s own address');
      assertEquals((await listener(a, '/pcsync/hello', { token }, from('10.0.0.9'))).status, 200, 'a right token is never refused for guessing');
      assertEquals((await listener(a, '/pcsync/hello', { token: 'q'.repeat(43) }, from('100.64.0.2'))).status, 401, 'a wrong one from another source is still just refused');
      assert(LOGIN.length > 0);
    } finally {
      await closeAll([a, b]);
    }
  },
});
