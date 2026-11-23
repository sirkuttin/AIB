/**
 * Sync between PCs, slice V5: aib-docs (server/pcsync/files.ts with area 'docs', aibmerge.ts, DocStore.landSynced). Two in-process AIB
 * servers (_pcsync_fixture.ts) with two linked temp git projects and the Docs switch on or off. Covered: a doc made on A appears on B
 * rendered by the docs store (Markdown copies written there, never sent), the page copies are never in a frame, edits to different blocks
 * on both PCs while offline merge, the same block edited on both keeps both with a "from <pc>" line, an open doc on B takes the change
 * through the store's merge without losing its unsaved typing, a doc.aibdoc that does not parse is never written, a doc deleted on one
 * PC while edited on the other stays, a plain delete closes the other PC's open doc, and the Docs switch off on one side stops it all.
 */
import { assert, assertEquals } from './_assert.ts';
import { pc, tempDir } from './_remote_fixture.ts';
import { UserClient } from './_docs.ts';
import { closeAll, type Json, type Node, paired, TEST_FILES, until } from './_pcsync_fixture.ts';

const OPTS = { sanitizeResources: false, sanitizeOps: false };
const sep = Deno.build.os === 'windows' ? '\\' : '/';
const WAIT = 20_000;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- helpers -------------------------------------------------------------------------------------------------------------------
async function git(cwd: string, ...args: string[]) {
  const out = await new Deno.Command('git', { args, cwd, stdout: 'piped', stderr: 'piped' }).output();
  if (!out.success) throw new Error(`git ${args.join(' ')}: ${new TextDecoder().decode(out.stderr)}`);
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
/** Every file item of every captured frame: [op, area, path]. */
function fileItems(frames: string[]): [string, string, string][] {
  const out: [string, string, string][] = [];
  for (const f of frames) {
    let frame: { t?: string; items?: { op: string; area?: string; path?: string }[] };
    try {
      frame = JSON.parse(f);
    } catch {
      continue;
    }
    for (const i of frame.items ?? []) if (i.op.startsWith('file.')) out.push([i.op, i.area ?? '', i.path ?? '']);
  }
  return out;
}
const projectsOf = async (n: Node) => {
  const [, v] = await pc(n.s, 'GET', '/api/live/pcsync');
  return (v.peers as Json[])[0].projects as { links: { sync: string; docs: boolean; docsFiles: FileView | null }[] };
};
interface FileView {
  state: string;
  pending: number;
  conflictCount: number;
  held: { path: string; why: string }[];
}
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
async function setup(): Promise<Setup> {
  const [a, b] = await paired(TEST_FILES);
  try {
    const aDir = await tempDir('aib-v5-a-'), bDir = await tempDir('aib-v5-b-');
    const aRepo = await repo(aDir, 'shop', 'git@github.com:Acme/Shop.git');
    const bRepo = await repo(bDir, 'shop-clone', 'https://github.com/acme/shop');
    await a.s.ctx.addedProjects.add(aRepo);
    await b.s.ctx.addedProjects.add(bRepo);
    await until('both links up', () => connected(a) && connected(b));
    await a.s.ctx.pcsync.projects.refresh(true);
    await b.s.ctx.pcsync.projects.refresh(true);
    await until(
      'linked on both PCs',
      async () => (await projectsOf(a)).links.length === 1 && (await projectsOf(b)).links.length === 1,
      WAIT,
    );
    return {
      a,
      b,
      aRepo,
      bRepo,
      aDocs: `${aRepo}${sep}aib-docs`,
      bDocs: `${bRepo}${sep}aib-docs`,
      sync: (await projectsOf(a)).links[0].sync,
    };
  } catch (error) {
    await closeAll([a, b]);
    throw error;
  }
}
async function setDocs(n: Node, sync: string, on: boolean) {
  const [status, body] = await pc(n.s, 'POST', '/api/live/pcsync/projects/switch', { sync, which: 'docs', on });
  assertEquals(status, 200, JSON.stringify(body));
}
async function bothOn(t: Setup) {
  await setDocs(t.a, t.sync, true);
  await setDocs(t.b, t.sync, true);
  await until('both PCs are up to date', async () => (await docsStatus(t.a)).state === 'ok' && (await docsStatus(t.b)).state === 'ok', WAIT);
}
/** Both engines have caught up, and both docs hold the same blocks (each store writes who typed what its own way: the bytes can differ). */
async function settled(t: Setup, ...names: string[]) {
  try {
    await until('both PCs are up to date', async () => {
      const [x, y] = [await docsStatus(t.a), await docsStatus(t.b)];
      return x.state === 'ok' && y.state === 'ok' && x.pending === 0 && y.pending === 0 &&
        names.every((n) => JSON.stringify(blocksOf(t.aDocs, n)) === JSON.stringify(blocksOf(t.bDocs, n)));
    }, WAIT);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : error}: A ${JSON.stringify(await docsStatus(t.a))} B ${JSON.stringify(await docsStatus(t.b))}`);
  }
}
const path = (dir: string, rel: string) => `${dir}${sep}${rel.split('/').join(sep)}`;
const read = (dir: string, rel: string): string | null => {
  try {
    return Deno.readTextFileSync(path(dir, rel));
  } catch {
    return null;
  }
};
const has = (dir: string, rel: string) => read(dir, rel) !== null;

type Node2 = { content?: Node2[]; text?: string };
const textOf = (n: Node2): string => n.text ?? (n.content ?? []).map(textOf).join('');
/** The text of every top-level block of the doc's first page, in order. */
function blocksOf(dir: string, name: string): string[] {
  const raw = read(dir, `${name}/doc.aibdoc`);
  if (raw === null) return [];
  return (JSON.parse(raw).pages as { content: Node2[] }[]).flatMap((p) => p.content.map(textOf));
}
/** Make a doc through the docs store (as the Docs tab does) and write it out. */
async function makeDoc(n: Node, root: string, name: string, md: string) {
  const doc = await n.s.ctx.docs.open(root, name, md, 'user');
  await n.s.ctx.docs.flush(doc);
  return doc;
}
/** Type at the end of block `index` as a user in the page would; `flush` writes the file (no flush: the typing stays unsaved). */
async function type(n: Node, root: string, name: string, index: number, add: string, flush = true) {
  const doc = await n.s.ctx.docs.open(root, name);
  const user = new UserClient(doc.live);
  const id = doc.live.topIds()[index];
  user.type(id, user.text(id).length, add);
  if (flush) await n.s.ctx.docs.flush(doc);
  return { doc, user, id };
}
async function offline(t: Setup) {
  for (const n of [t.a, t.b]) {
    n.up = false;
    n.otherOnline = false;
  }
  for (const c of [...t.a.sockets, ...t.b.sockets]) c.close();
  await until('the link is down', () => !connected(t.a) && !connected(t.b), WAIT);
}
function online(t: Setup) {
  for (const n of [t.a, t.b]) {
    n.up = true;
    n.otherOnline = true;
  }
}
const BASE = 'Title one\n\nSecond block\n\nThird block\n';

// ---- the tests -----------------------------------------------------------------------------------------------------------------
Deno.test({
  ...OPTS,
  name:
    'a doc made on A appears on B and is rendered by B’s docs store; the page copies and anything but doc.aibdoc and assets are never sent; nothing is echoed back',
  async fn() {
    const cap = captureFrames();
    const t = await setup();
    try {
      await bothOn(t);
      await makeDoc(t.a, t.aRepo, 'plan', BASE);
      // an asset next to it, a stray file in the doc folder and a README in aib-docs: not synced
      Deno.mkdirSync(path(t.aDocs, 'plan/assets'), { recursive: true });
      Deno.writeFileSync(path(t.aDocs, 'plan/assets/pic.png'), new Uint8Array([1, 2, 3, 4, 5]));
      Deno.writeTextFileSync(path(t.aDocs, 'plan/notes.txt'), 'not a doc file');
      Deno.writeTextFileSync(path(t.aDocs, 'loose.md'), 'loose');
      await until('B has the doc and its asset', () => has(t.bDocs, 'plan/doc.aibdoc') && has(t.bDocs, 'plan/assets/pic.png'), WAIT);
      assertEquals(blocksOf(t.bDocs, 'plan'), ['Title one', 'Second block', 'Third block']);
      // rendered: the store on B opened the doc and wrote its Markdown copy
      await until('B renders the page copy', () => (read(t.bDocs, 'plan/01-page-1.md') ?? '').includes('Second block'), WAIT);
      const listed = (await t.b.s.ctx.docs.list(t.bRepo)).find((d) => d.name === 'plan')!;
      assert(listed, 'the doc is listed on B');
      assertEquals((listed as Record<string, unknown>).editedBy,'Sync from studio-pc', 'the Docs tab shows who changed it');
      await settled(t, 'plan');
      assert(!has(t.bDocs, 'plan/notes.txt') && !has(t.bDocs, 'loose.md'), 'only doc.aibdoc and assets/ travel');
      // frames: only doc.aibdoc and assets, never an NN-*.md copy
      const paths = new Set(fileItems(cap.frames).filter(([, area]) => area === 'docs').map(([, , p]) => p).filter(Boolean));
      assert(paths.has('plan/doc.aibdoc') && paths.has('plan/assets/pic.png'), [...paths].join());
      for (const p of paths) assert(p === 'plan/doc.aibdoc' || p.startsWith('plan/assets/'), `unexpected path in a frame: ${p}`);
      assertEquals(blocksOf(t.aDocs, 'plan'), blocksOf(t.bDocs, 'plan'));
      // a fixed point: no more file frames while nothing changes
      const quiet = fileItems(cap.frames).length;
      await wait(1800);
      assertEquals(fileItems(cap.frames).length, quiet, 'no file frames once both PCs agree');
    } finally {
      cap.stop();
      await closeAll([t.a, t.b]);
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'edits to different blocks on both PCs while the link is down merge into both edits, on both PCs',
  async fn() {
    const t = await setup();
    try {
      await bothOn(t);
      await makeDoc(t.a, t.aRepo, 'plan', BASE);
      await until('B has the doc', () => has(t.bDocs, 'plan/doc.aibdoc'), WAIT);
      await settled(t, 'plan');
      await offline(t);
      await type(t.a, t.aRepo, 'plan', 0, ' (A edit)');
      await type(t.b, t.bRepo, 'plan', 2, ' (B edit)');
      assertEquals(blocksOf(t.aDocs, 'plan')[0], 'Title one (A edit)');
      assertEquals(blocksOf(t.bDocs, 'plan')[2], 'Third block (B edit)');
      online(t);
      const want = ['Title one (A edit)', 'Second block', 'Third block (B edit)'];
      await until('both PCs hold both edits', () => JSON.stringify(blocksOf(t.aDocs, 'plan')) === JSON.stringify(want) && JSON.stringify(blocksOf(t.bDocs, 'plan')) === JSON.stringify(want), WAIT);
      await settled(t, 'plan');
      // the open docs show them too (the store merged, not just the files)
      const [da, db] = [t.a.s.ctx.docs.docs.values().next().value!, t.b.s.ctx.docs.docs.values().next().value!];
      assertEquals(da.live.topIds().map((id) => da.live.markdownOf(id).trim()), want);
      assertEquals(db.live.topIds().map((id) => db.live.markdownOf(id).trim()), want);
    } finally {
      await closeAll([t.a, t.b]);
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'the same block edited on both PCs keeps both: the local text stays and the other PC’s is right below it, marked "from <pc>"',
  async fn() {
    const t = await setup();
    try {
      await bothOn(t);
      await makeDoc(t.a, t.aRepo, 'plan', BASE);
      await until('B has the doc', () => has(t.bDocs, 'plan/doc.aibdoc'), WAIT);
      await settled(t, 'plan');
      await offline(t);
      await type(t.a, t.aRepo, 'plan', 1, ' ALPHA');
      await wait(30);
      await type(t.b, t.bRepo, 'plan', 1, ' BRAVO'); // the newer edit: A (older) resolves
      online(t);
      await until('the block is kept twice, on both PCs', () => {
        const [x, y] = [blocksOf(t.aDocs, 'plan'), blocksOf(t.bDocs, 'plan')];
        return x.length === 5 && x.join('|') === y.join('|');
      }, WAIT).catch((error) => {
        throw new Error(`${error.message}: A ${JSON.stringify(blocksOf(t.aDocs, 'plan'))} B ${JSON.stringify(blocksOf(t.bDocs, 'plan'))}`);
      });
      await settled(t, 'plan');
      const blocks = blocksOf(t.aDocs, 'plan');
      const at = blocks.indexOf('Second block ALPHA');
      assert(at >= 0, blocks.join(' / '));
      assertEquals(blocks[at + 1], 'from ubuntu-pc', 'the marker names the PC the other version came from');
      assertEquals(blocks[at + 2], 'Second block BRAVO');
      assert(blocks.includes('Title one') && blocks.includes('Third block'), 'the other blocks are untouched');
    } finally {
      await closeAll([t.a, t.b]);
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'a doc open on B takes A’s change through the store’s merge and keeps B’s unsaved typing',
  async fn() {
    const t = await setup();
    try {
      await bothOn(t);
      await makeDoc(t.a, t.aRepo, 'plan', BASE);
      await until('B has the doc', () => has(t.bDocs, 'plan/doc.aibdoc'), WAIT);
      await settled(t, 'plan');
      // B has the doc open (a page is on it) and a user is typing: not saved yet
      const typed = await type(t.b, t.bRepo, 'plan', 2, ' (typing on B)', false);
      assertEquals(typed.user.text(typed.id), 'Third block (typing on B)');
      await type(t.a, t.aRepo, 'plan', 0, ' (edited on A)');
      await until('the change is in B’s open doc', () => typed.doc.live.markdownOf(typed.doc.live.topIds()[0]).includes('(edited on A)'), WAIT);
      assertEquals(typed.user.text(typed.id), 'Third block (typing on B)', 'the page still has what the user typed');
      assert(typed.doc.live.markdownOf(typed.id).includes('(typing on B)'));
      // and both ends settle on both edits
      const want = ['Title one (edited on A)', 'Second block', 'Third block (typing on B)'];
      await until('both files hold both', () => JSON.stringify(blocksOf(t.aDocs, 'plan')) === JSON.stringify(want) && JSON.stringify(blocksOf(t.bDocs, 'plan')) === JSON.stringify(want), WAIT);
      await settled(t, 'plan');
      assertEquals(typed.doc.edited?.by !== undefined, true);
    } finally {
      await closeAll([t.a, t.b]);
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'a doc.aibdoc that does not parse (conflict markers, or blocks the schema refuses) is never written on the other PC',
  async fn() {
    const t = await setup();
    try {
      await bothOn(t);
      const markers = '<<<<<<< HEAD\n{"format":"aibdoc"}\n=======\n{}\n>>>>>>> origin\n';
      const schema = JSON.stringify({ format: 'aibdoc', version: 1, title: 'x', pages: [{ id: 'p1', title: 'x', content: [{ type: 'nope' }] }] });
      for (const [name, body] of [['broken-a', markers], ['broken-b', schema]]) {
        Deno.mkdirSync(path(t.aDocs, name), { recursive: true });
        Deno.writeTextFileSync(path(t.aDocs, `${name}/doc.aibdoc`), body);
      }
      await makeDoc(t.a, t.aRepo, 'good', 'fine\n'); // a good doc next to them still crosses
      await until('the good doc crosses', () => has(t.bDocs, 'good/doc.aibdoc'), WAIT);
      await until('B lists both files as not written', async () => {
        const held = (await docsStatus(t.b)).held.map((h) => h.path);
        return held.includes('broken-a/doc.aibdoc') && held.includes('broken-b/doc.aibdoc');
      }, WAIT);
      await wait(600);
      assert(!has(t.bDocs, 'broken-a/doc.aibdoc') && !has(t.bDocs, 'broken-b/doc.aibdoc'), 'nothing was written');
      const why = (await docsStatus(t.b)).held.find((h) => h.path === 'broken-a/doc.aibdoc')!.why;
      assert(why.startsWith('Not written:'), why);
      // the version that is valid later does cross
      Deno.writeTextFileSync(path(t.aDocs, 'broken-a/doc.aibdoc'), read(t.aDocs, 'good/doc.aibdoc')!);
      await until('the fixed file crosses', () => has(t.bDocs, 'broken-a/doc.aibdoc'), WAIT);
    } finally {
      await closeAll([t.a, t.b]);
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'a doc deleted on A while it was edited on B stays (an edit beats a delete); a plain delete reaches B, closes its open doc and bins the file',
  async fn() {
    const t = await setup();
    try {
      await bothOn(t);
      await makeDoc(t.a, t.aRepo, 'keep', BASE);
      await makeDoc(t.a, t.aRepo, 'gone', BASE);
      await until('B has both', () => has(t.bDocs, 'keep/doc.aibdoc') && has(t.bDocs, 'gone/doc.aibdoc'), WAIT);
      await settled(t, 'keep', 'gone');
      await offline(t);
      // A moves both docs out (as "Move doc to trash" does); B edits one of them
      for (const d of [...t.a.s.ctx.docs.docs.values()]) await t.a.s.ctx.docs.discard(d);
      assert(!has(t.aDocs, 'keep/doc.aibdoc') && !has(t.aDocs, 'gone/doc.aibdoc'));
      await type(t.b, t.bRepo, 'keep', 1, ' (edited on B)');
      online(t);
      await until('the edited doc is back on A, edit included', () => blocksOf(t.aDocs, 'keep')[1] === 'Second block (edited on B)', WAIT);
      await until('the other doc is gone on B', () => !has(t.bDocs, 'gone/doc.aibdoc'), WAIT);
      await settled(t, 'keep');
      assert(has(t.bDocs, 'keep/doc.aibdoc'), 'the edited doc stays on B');
      assert(![...t.b.s.ctx.docs.docs.values()].some((d) => d.name === 'gone'), 'B’s open copy of the deleted doc is closed');
      assert(!has(t.bDocs, 'gone/01-page-1.md'), 'its page copy went with it');
      // the deleted file is in B's bin, under .git
      const bin = `${t.bRepo}${sep}.git${sep}aib-sync${sep}bin`;
      let found = false;
      for (const d of Deno.readDirSync(bin)) if (has(`${bin}${sep}${d.name}`, 'gone/doc.aibdoc')) found = true;
      assert(found, 'the deleted doc.aibdoc is in the bin');
    } finally {
      await closeAll([t.a, t.b]);
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'the Docs switch off on one side means nothing syncs (no file frame), and it catches up when the switch is on',
  async fn() {
    const cap = captureFrames();
    const t = await setup();
    try {
      await setDocs(t.a, t.sync, true);
      await until('A waits for B’s switch', async () => (await docsStatus(t.a)).state === 'other_off', WAIT);
      assertEquals((await docsStatus(t.b)).state, 'off');
      await makeDoc(t.a, t.aRepo, 'plan', BASE);
      await wait(900);
      assert(!has(t.bDocs, 'plan/doc.aibdoc'), 'B has nothing while its own switch is off');
      assert(fileItems(cap.frames).every(([, area]) => area !== 'docs'), 'no docs frame was sent');
      await setDocs(t.b, t.sync, true);
      await until('the doc crosses once both are on', () => has(t.bDocs, 'plan/doc.aibdoc'), WAIT);
      await settled(t, 'plan');
      // and off again on A: a later edit stays on B
      await setDocs(t.a, t.sync, false);
      await until('B sees A off', async () => (await docsStatus(t.b)).state === 'other_off', WAIT);
      await type(t.b, t.bRepo, 'plan', 0, ' (later on B)');
      await wait(900);
      assertEquals(blocksOf(t.aDocs, 'plan')[0], 'Title one');
    } finally {
      cap.stop();
      await closeAll([t.a, t.b]);
    }
  },
});
