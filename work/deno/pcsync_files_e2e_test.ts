/**
 * Sync between PCs, slice V4: the aib-shared file engine (server/pcsync/files.ts, rules.ts). Two in-process AIB servers
 * (_pcsync_fixture.ts) with temp git repos, linked and with the aib-shared switch on or off. Covered: create, edit, delete and rename
 * both ways, the both-switches rule, a line merge of an .md edited on both PCs, a conflict copy for the same lines and for a binary
 * (newest wins), an edit beating a delete, the bin, the mass-delete guard (Allow and Keep files), a held big file, names that look like
 * secrets, links that are never followed or written through, a PC that was offline catching up, a frame for an unknown project, no
 * absolute path in any frame, and an idle folder costing nothing.
 */
import process from 'node:process';
import { assert, assertEquals } from './_assert.ts';
import { pc, tempDir } from './_remote_fixture.ts';
import { ensureDefault } from '../../app/server/worktrees/local_only.ts';
import { conflictName, isSecretPath, stamp } from '../../app/server/pcsync/rules.ts';
import { closeAll, type Json, type Node, paired, TEST_FILES, until } from './_pcsync_fixture.ts';

const OPTS = { sanitizeResources: false, sanitizeOps: false };
const sep = Deno.build.os === 'windows' ? '\\' : '/';
const WATCH_ONLY = { ...TEST_FILES, rescanMs: 60_000 };
const WAIT = 15_000;

Deno.test('rules: conflict names follow Syncthing, secret names are recognised, the stamp has a fixed shape', () => {
  const when = new Date(2026, 10, 23, 14, 5, 9);
  assertEquals(stamp(when), '20261123-140509');
  assertEquals(conflictName('notes/plan.md', 'studio-pc', when), 'notes/plan.sync-conflict-20261123-140509-studio-pc.md');
  assertEquals(conflictName('a.b.txt', 'ubuntu pc', when), 'a.b.sync-conflict-20261123-140509-ubuntu-pc.txt');
  assertEquals(conflictName('LICENSE', 'x', when), 'LICENSE.sync-conflict-20261123-140509-x');
  assertEquals(conflictName('.hidden', 'x', when), '.hidden.sync-conflict-20261123-140509-x');
  for (
    const p of [
      '.env',
      '.env.local',
      'a/.env.production',
      'k.pem',
      'a/b/server.KEY',
      'id_rsa',
      'id_rsa.pub',
      'credentials.json',
      '.credentials',
      'x.pfx',
    ]
  ) {
    assert(isSecretPath(p), p);
  }
  for (const p of ['environment.md', 'keys.md', 'notes/env.txt', 'monkey.md', 'rsa.md', 'credits.md']) assert(!isSecretPath(p), p);
});

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
  await ensureDefault(top); // aib-shared is local-only here: the folder the engine syncs
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
const projectsOf = async (n: Node) => {
  const [, v] = await pc(n.s, 'GET', '/api/live/pcsync');
  return (v.peers as Json[])[0].projects as { links: { sync: string; shared: boolean; files: FileView | null }[]; known: boolean };
};
interface FileView {
  state: string;
  reason: string;
  pending: number;
  conflicts: string[];
  conflictCount: number;
  held: { path: string; why: string }[];
  pause: { deletes: number; total: number } | null;
}
const filesOf = async (n: Node): Promise<FileView> => (await projectsOf(n)).links[0].files!;
const connected = (n: Node) => n.s.ctx.pcsync.links.links().length === 1;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Setup {
  a: Node;
  b: Node;
  aRepo: string;
  bRepo: string;
  aShared: string;
  bShared: string;
  sync: string;
}
async function setup(files = TEST_FILES): Promise<Setup> {
  const [a, b] = await paired(files);
  try {
    const aDir = await tempDir('aib-v4-a-'), bDir = await tempDir('aib-v4-b-');
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
      aShared: `${aRepo}${sep}aib-shared`,
      bShared: `${bRepo}${sep}aib-shared`,
      sync: (await projectsOf(a)).links[0].sync,
    };
  } catch (error) {
    await closeAll([a, b]);
    throw error;
  }
}
async function setSwitch(n: Node, sync: string, on: boolean) {
  const [status, body] = await pc(n.s, 'POST', '/api/live/pcsync/projects/switch', { sync, which: 'shared', on });
  assertEquals(status, 200, JSON.stringify(body));
}
async function bothOn(t: Setup) {
  await setSwitch(t.a, t.sync, true);
  await setSwitch(t.b, t.sync, true);
  await until('both PCs are up to date', async () => (await filesOf(t.a)).state === 'ok' && (await filesOf(t.b)).state === 'ok', WAIT);
}
/** Every engine has caught up: no file differs and nothing is queued. */
async function settled(t: Setup) {
  try {
    await until('both PCs are up to date', async () => {
      const [x, y] = [await filesOf(t.a), await filesOf(t.b)];
      return x.state === 'ok' && y.state === 'ok' && x.pending === 0 && y.pending === 0;
    }, WAIT);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : error}: A ${JSON.stringify(await filesOf(t.a))} B ${JSON.stringify(await filesOf(t.b))}`,
    );
  }
}
const put = (dir: string, rel: string, data: string | Uint8Array) => {
  const file = `${dir}${sep}${rel.split('/').join(sep)}`;
  Deno.mkdirSync(file.slice(0, file.lastIndexOf(sep)), { recursive: true });
  if (typeof data === 'string') Deno.writeTextFileSync(file, data);
  else Deno.writeFileSync(file, data);
};
const text = (dir: string, rel: string): string | null => {
  try {
    return Deno.readTextFileSync(`${dir}${sep}${rel.split('/').join(sep)}`);
  } catch {
    return null;
  }
};
const exists = (dir: string, rel: string) => text(dir, rel) !== null;
const hasText = (dir: string, rel: string, want: string) => text(dir, rel) === want;
function listAll(dir: string, rel = ''): string[] {
  const out: string[] = [];
  try {
    for (const e of Deno.readDirSync(dir)) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory) out.push(...listAll(`${dir}${sep}${e.name}`, r));
      else out.push(r);
    }
  } catch { /* none */ }
  return out.sort();
}
/** The bin of a project: [path, content] of every file in <repo>/.git/aib-sync/bin/<stamp>/<path>. */
function binOf(repoDir: string): [string, string][] {
  const bin = `${repoDir}${sep}.git${sep}aib-sync${sep}bin`;
  const out: [string, string][] = [];
  try {
    for (const d of Deno.readDirSync(bin)) {
      for (const f of listAll(`${bin}${sep}${d.name}`)) {
        out.push([f.replace(/\.\d+$/, ''), Deno.readTextFileSync(`${bin}${sep}${d.name}${sep}${f}`)]);
      }
    }
  } catch { /* no bin */ }
  return out;
}
const setTime = (dir: string, rel: string, ago: number) => {
  const d = new Date(Date.now() - ago);
  Deno.utimeSync(`${dir}${sep}${rel.split('/').join(sep)}`, d, d);
};
const conflictsIn = (dir: string) => listAll(dir).filter((f) => f.includes('.sync-conflict-'));

// ---- the tests -----------------------------------------------------------------------------------------------------------------
Deno.test({
  ...OPTS,
  name:
    'create, edit, delete and rename reach the other PC both ways (the watcher alone), the replaced version is in the bin, never in aib-shared',
  async fn() {
    const cap = captureFrames();
    const t = await setup(WATCH_ONLY);
    try {
      await bothOn(t);
      // create A -> B, nested
      put(t.aShared, 'notes/plan.md', 'v1\n');
      put(t.aShared, 'top.txt', 'top\n');
      await until('B has the new files', () => hasText(t.bShared, 'notes/plan.md', 'v1\n') && hasText(t.bShared, 'top.txt', 'top\n'), WAIT);
      // create B -> A
      put(t.bShared, 'from-b/x.md', 'bee\n');
      await until("A has B's file", () => hasText(t.aShared, 'from-b/x.md', 'bee\n'), WAIT);
      await settled(t);
      assert(t.a.s.ctx.pcsync.files.baseOf(t.sync, 'notes/plan.md'), 'A keeps the last-synced hash');
      assertEquals(t.a.s.ctx.pcsync.files.baseOf(t.sync, 'notes/plan.md'), t.b.s.ctx.pcsync.files.baseOf(t.sync, 'notes/plan.md'));
      // edit A -> B; B's old version goes to its bin
      put(t.aShared, 'notes/plan.md', 'v2\n');
      await until('B has the edit', () => hasText(t.bShared, 'notes/plan.md', 'v2\n'), WAIT);
      assert(binOf(t.bRepo).some(([p, c]) => p === 'notes/plan.md' && c === 'v1\n'), 'B binned the version it replaced');
      // edit B -> A
      put(t.bShared, 'top.txt', 'top 2\n');
      await until('A has the edit', () => hasText(t.aShared, 'top.txt', 'top 2\n'), WAIT);
      // rename on B reaches A (a delete and a create)
      Deno.renameSync(`${t.bShared}${sep}from-b${sep}x.md`, `${t.bShared}${sep}from-b${sep}y.md`);
      await until('A has the renamed file', () => hasText(t.aShared, 'from-b/y.md', 'bee\n') && !exists(t.aShared, 'from-b/x.md'), WAIT);
      // delete on A reaches B; B's copy is in its bin
      Deno.removeSync(`${t.aShared}${sep}top.txt`);
      await until('B lost the file', () => !exists(t.bShared, 'top.txt'), WAIT);
      assert(binOf(t.bRepo).some(([p, c]) => p === 'top.txt' && c === 'top 2\n'), 'the deleted file is in the bin');
      await settled(t);
      assertEquals(listAll(t.aShared), listAll(t.bShared), 'the two folders are the same');
      for (const f of listAll(t.aShared)) assert(!f.includes('.aib') && !f.includes('aib-sync'), 'no sync file inside aib-shared: ' + f);
      // the bin is under .git, never in the folder
      assert(listAll(`${t.bRepo}${sep}.git${sep}aib-sync${sep}bin`).length >= 2);

      // no frame holds an absolute path or a folder of either PC (file data is left out: it is the files' own content)
      assert(cap.frames.some((f) => f.includes('"file.state"')) && cap.frames.some((f) => f.includes('"file.data"')));
      for (const frame of cap.frames) {
        const parsed = JSON.parse(frame);
        for (const item of parsed.items ?? []) delete item.data;
        const body = JSON.stringify(parsed);
        for (const root of [t.a.root, t.b.root, t.aRepo, t.bRepo]) {
          assert(
            !body.includes(root) && !body.includes(JSON.stringify(root).slice(1, -1)),
            `a folder path is in a frame: ${body.slice(0, 200)}`,
          );
        }
        assert(!/"[A-Za-z]:|"\/|"\\\\/.test(body), `an absolute path is in a frame: ${body.slice(0, 200)}`);
      }
    } finally {
      cap.stop();
      await closeAll([t.a, t.b]);
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'both-switches rule: nothing moves (and no file frame is sent) until both PCs have aib-shared on; turning one off stops it again',
  async fn() {
    const cap = captureFrames();
    const t = await setup();
    try {
      put(t.aShared, 'early.md', 'early\n');
      await setSwitch(t.a, t.sync, true);
      await until("A waits for B's switch", async () => (await filesOf(t.a)).state === 'other_off', WAIT);
      await wait(700);
      assert(!exists(t.bShared, 'early.md'), 'B has nothing while its own switch is off');
      assert(!cap.frames.some((f) => f.includes('file.')), 'no file frame was sent');
      assertEquals((await filesOf(t.b)).state, 'off');
      await setSwitch(t.b, t.sync, true);
      await until('the file crosses', () => hasText(t.bShared, 'early.md', 'early\n'), WAIT);
      await settled(t);
      // B turns it off: A's later change stays on A
      await setSwitch(t.b, t.sync, false);
      await until('A sees B off', async () => (await filesOf(t.a)).state === 'other_off', WAIT);
      put(t.aShared, 'later.md', 'later\n');
      await wait(700);
      assert(!exists(t.bShared, 'later.md'));
      await setSwitch(t.b, t.sync, true);
      await until('it catches up when B turns it on', () => hasText(t.bShared, 'later.md', 'later\n'), WAIT);
    } finally {
      cap.stop();
      await closeAll([t.a, t.b]);
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'a .md edited on both PCs in different lines is line-merged (3-way, base = last synced): no conflict copy, both edits on both PCs',
  async fn() {
    const t = await setup();
    try {
      await bothOn(t);
      put(t.aShared, 'plan.md', 'one\ntwo\nthree\nfour\nfive\n');
      await until('B has it', () => hasText(t.bShared, 'plan.md', 'one\ntwo\nthree\nfour\nfive\n'), WAIT);
      await settled(t);
      await setSwitch(t.b, t.sync, false); // B is cut off: both PCs edit meanwhile
      await until('A sees B off', async () => (await filesOf(t.a)).state === 'other_off', WAIT);
      put(t.aShared, 'plan.md', 'ONE\ntwo\nthree\nfour\nfive\n');
      put(t.bShared, 'plan.md', 'one\ntwo\nthree\nfour\nFIVE\n');
      await setSwitch(t.b, t.sync, true);
      const merged = 'ONE\ntwo\nthree\nfour\nFIVE\n';
      await until('both PCs hold the merge', () => hasText(t.aShared, 'plan.md', merged) && hasText(t.bShared, 'plan.md', merged), WAIT);
      await settled(t);
      assertEquals(conflictsIn(t.aShared), []);
      assertEquals(conflictsIn(t.bShared), []);
    } finally {
      await closeAll([t.a, t.b]);
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'a .md changed on the same line on both PCs: the newer one wins and the older stays beside it as a sync-conflict copy, on both PCs',
  async fn() {
    const t = await setup();
    try {
      await bothOn(t);
      put(t.aShared, 'plan.md', 'one\ntwo\nthree\n');
      await until('B has it', () => hasText(t.bShared, 'plan.md', 'one\ntwo\nthree\n'), WAIT);
      await settled(t);
      await setSwitch(t.b, t.sync, false);
      await until('A sees B off', async () => (await filesOf(t.a)).state === 'other_off', WAIT);
      put(t.aShared, 'plan.md', 'one\nA says\nthree\n');
      put(t.bShared, 'plan.md', 'one\nB says\nthree\n');
      setTime(t.aShared, 'plan.md', 20_000); // A's edit is older
      setTime(t.bShared, 'plan.md', 1_000);
      await setSwitch(t.b, t.sync, true);
      await until(
        'the conflict copy is on both PCs',
        () => conflictsIn(t.aShared).length === 1 && conflictsIn(t.bShared).length === 1,
        WAIT,
      );
      await settled(t);
      assert(
        hasText(t.aShared, 'plan.md', 'one\nB says\nthree\n') && hasText(t.bShared, 'plan.md', 'one\nB says\nthree\n'),
        'the newer edit won',
      );
      const [name] = conflictsIn(t.aShared);
      assert(/^plan\.sync-conflict-\d{8}-\d{6}-studio-pc\.md$/.test(name), name); // the losing PC is A, "studio-pc"
      assertEquals(conflictsIn(t.bShared), [name]);
      assert(
        hasText(t.aShared, name, 'one\nA says\nthree\n') && hasText(t.bShared, name, 'one\nA says\nthree\n'),
        'the older version is kept',
      );
      const view = await filesOf(t.b);
      assertEquals([view.conflictCount, view.conflicts], [1, [name]]);
    } finally {
      await closeAll([t.a, t.b]);
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'a binary file changed on both PCs: newest wins by mtime, the other version is kept as a conflict copy',
  async fn() {
    const t = await setup();
    try {
      await bothOn(t);
      const bytes = (n: number) => new Uint8Array(3000).map((_, i) => (i * 7 + n) % 256);
      put(t.aShared, 'img/pic.bin', bytes(0));
      await until('B has it', () => exists(t.bShared, 'img/pic.bin'), WAIT);
      await settled(t);
      await setSwitch(t.b, t.sync, false);
      await until('A sees B off', async () => (await filesOf(t.a)).state === 'other_off', WAIT);
      put(t.aShared, 'img/pic.bin', bytes(1));
      put(t.bShared, 'img/pic.bin', bytes(2));
      setTime(t.aShared, 'img/pic.bin', 1_000); // A's is newer this time
      setTime(t.bShared, 'img/pic.bin', 30_000);
      await setSwitch(t.b, t.sync, true);
      await until('the copy is on both PCs', () => conflictsIn(t.aShared).length === 1 && conflictsIn(t.bShared).length === 1, WAIT);
      await settled(t);
      const read = (dir: string, rel: string) => Deno.readFileSync(`${dir}${sep}${rel.split('/').join(sep)}`);
      assertEquals([...read(t.bShared, 'img/pic.bin')], [...bytes(1)], "A's newer version won on B");
      assertEquals([...read(t.aShared, 'img/pic.bin')], [...bytes(1)]);
      const [name] = conflictsIn(t.bShared);
      assert(/^img\/pic\.sync-conflict-\d{8}-\d{6}-ubuntu-pc\.bin$/.test(name), name); // B lost
      assertEquals([...read(t.bShared, name)], [...bytes(2)]);
      assertEquals([...read(t.aShared, name)], [...bytes(2)], 'the copy reached the other PC too');
    } finally {
      await closeAll([t.a, t.b]);
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'an edit beats a delete: the file deleted on one PC and edited on the other stays, with the edit, on both',
  async fn() {
    const t = await setup();
    try {
      await bothOn(t);
      put(t.aShared, 'keep.md', 'original\n');
      await until('B has it', () => hasText(t.bShared, 'keep.md', 'original\n'), WAIT);
      await settled(t);
      await setSwitch(t.b, t.sync, false);
      await until('A sees B off', async () => (await filesOf(t.a)).state === 'other_off', WAIT);
      Deno.removeSync(`${t.aShared}${sep}keep.md`);
      put(t.bShared, 'keep.md', 'edited on B\n');
      await setSwitch(t.b, t.sync, true);
      await until('A has the edit back', () => hasText(t.aShared, 'keep.md', 'edited on B\n'), WAIT);
      await settled(t);
      assert(hasText(t.bShared, 'keep.md', 'edited on B\n'));
      assertEquals(conflictsIn(t.aShared).concat(conflictsIn(t.bShared)), []);
    } finally {
      await closeAll([t.a, t.b]);
    }
  },
});

async function twelveFiles(t: Setup) {
  for (let i = 1; i <= 12; i++) put(t.aShared, `big/f${i}.md`, `file ${i}\n`);
  await until('B has all twelve', () => listAll(t.bShared).length === 12, WAIT);
  await settled(t);
}
const wipe = (dir: string) => {
  for (const f of listAll(dir)) Deno.removeSync(`${dir}${sep}${f.split('/').join(sep)}`);
};

Deno.test({
  ...OPTS,
  name:
    'mass-delete guard: a wipe of the folder on one PC pauses on the other (files stay, shown as paused); Allow applies it and bins the files',
  async fn() {
    const t = await setup();
    try {
      await bothOn(t);
      await twelveFiles(t);
      wipe(t.aShared);
      await until('B pauses', async () => (await filesOf(t.b)).pause !== null, WAIT);
      assertEquals((await filesOf(t.b)).pause, { deletes: 12, total: 12 });
      await wait(500);
      assertEquals(listAll(t.bShared).length, 12, 'nothing was deleted while paused');
      const [none, err] = await pc(t.a.s, 'POST', '/api/live/pcsync/projects/files', { sync: t.sync, action: 'allow' });
      assertEquals(none, 409, JSON.stringify(err));
      const [bad] = await pc(t.b.s, 'POST', '/api/live/pcsync/projects/files', { sync: t.sync, action: 'burn' });
      assertEquals(bad, 400);
      const [ok] = await pc(t.b.s, 'POST', '/api/live/pcsync/projects/files', { sync: t.sync, action: 'allow' });
      assertEquals(ok, 200);
      await until('B deleted them', () => listAll(t.bShared).length === 0, WAIT);
      assertEquals((await filesOf(t.b)).pause, null);
      assertEquals(binOf(t.bRepo).filter(([p]) => p.startsWith('big/')).length, 12, 'all twelve are in the bin');
    } finally {
      await closeAll([t.a, t.b]);
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'mass-delete guard: Keep files keeps them on the paused PC and sends them back to the PC that deleted them',
  async fn() {
    const t = await setup();
    try {
      await bothOn(t);
      await twelveFiles(t);
      wipe(t.aShared);
      await until('B pauses', async () => (await filesOf(t.b)).pause !== null, WAIT);
      const [ok] = await pc(t.b.s, 'POST', '/api/live/pcsync/projects/files', { sync: t.sync, action: 'keep' });
      assertEquals(ok, 200);
      await until('A has the files back', () => listAll(t.aShared).length === 12, WAIT);
      await settled(t);
      assertEquals(listAll(t.bShared).length, 12);
      assertEquals((await filesOf(t.b)).pause, null);
      assert(hasText(t.aShared, 'big/f7.md', 'file 7\n'));
    } finally {
      await closeAll([t.a, t.b]);
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'limits and names: a file over 100 MB is held and listed, secret names are never sent, a normal file next to them is',
  async fn() {
    const cap = captureFrames();
    const t = await setup();
    try {
      await bothOn(t);
      // a sparse 101 MB file: size is read from the folder listing, the file is never hashed or sent
      const big = `${t.aShared}${sep}huge.bin`;
      const f = Deno.openSync(big, { write: true, create: true });
      f.truncateSync(101 * 1024 * 1024);
      f.close();
      for (const name of ['.env', '.env.local', 'server.pem', 'api.key', 'id_rsa', 'credentials.json', 'deep/.env']) {
        put(t.aShared, name, 'SECRET=1\n');
      }
      put(t.aShared, 'ok.md', 'fine\n');
      await until('the normal file crosses', () => hasText(t.bShared, 'ok.md', 'fine\n'), WAIT);
      await until('A lists what it holds', async () => (await filesOf(t.a)).held.some((h) => h.path === 'huge.bin'), WAIT);
      const held = (await filesOf(t.a)).held;
      assert(held.find((h) => h.path === 'huge.bin')!.why.includes('100 MB'));
      assert(held.some((h) => h.path === '.env'), 'secret names are listed as not synced');
      await settled(t);
      assertEquals(listAll(t.bShared), ['ok.md'], 'B has only the normal file');
      const wire = cap.frames.join('\n');
      for (const name of ['huge.bin', '.env', 'server.pem', 'api.key', 'id_rsa', 'credentials.json', 'SECRET']) {
        assert(!wire.includes(name), `${name} was named in a frame`);
      }
    } finally {
      cap.stop();
      await closeAll([t.a, t.b]);
    }
  },
});

Deno.test({
  ...OPTS,
  name:
    'links: a junction or symlink inside aib-shared is never followed, listed or synced, and sync never writes through one on the receiving PC',
  async fn() {
    const cap = captureFrames();
    const t = await setup();
    const outsideA = await tempDir('aib-v4-out-a-'), outsideB = await tempDir('aib-v4-out-b-');
    Deno.mkdirSync(t.aShared, { recursive: true });
    Deno.writeTextFileSync(`${outsideA}${sep}outside-secret.txt`, 'outside A\n');
    Deno.symlinkSync(outsideA, `${t.aShared}${sep}ja`, { type: 'junction' }); // a link inside A's folder, to a folder with a file
    try {
      Deno.mkdirSync(t.bShared, { recursive: true });
      Deno.symlinkSync(outsideB, `${t.bShared}${sep}jb`, { type: 'junction' }); // B has a link where A has a real folder
      await bothOn(t);
      put(t.aShared, 'real.md', 'real\n');
      put(t.aShared, 'jb/inside.md', 'A wants this in jb\n');
      await until('the real file crosses', () => hasText(t.bShared, 'real.md', 'real\n'), WAIT);
      await until(
        'B holds the file that would go through its link',
        async () => (await filesOf(t.b)).held.some((h) => h.path === 'jb/inside.md'),
        WAIT,
      );
      await wait(500);
      assertEquals(listAll(outsideB), [], "nothing was written through B's link");
      assertEquals(listAll(outsideA), ['outside-secret.txt'], "A's link target is as it was");
      assert(!exists(t.bShared, 'ja/outside-secret.txt'), "A's link was not followed");
      assert(!cap.frames.join('\n').includes('outside-secret'), 'a file behind a link was never named in a frame');
      assertEquals((await filesOf(t.a)).held.some((h) => h.path.startsWith('ja')), false, 'a link is not listed');
      assert(Deno.lstatSync(`${t.aShared}${sep}ja`).isSymlink, 'the link is still there');
      assert(Deno.lstatSync(`${t.bShared}${sep}jb`).isSymlink);
      // a delete on the other PC does not run through the link either
      assert(exists(outsideA, 'outside-secret.txt'));
    } finally {
      cap.stop();
      await closeAll([t.a, t.b]);
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'a PC that was offline catches up when it is back (edits, new files and deletes made meanwhile)',
  async fn() {
    const t = await setup();
    try {
      await bothOn(t);
      put(t.aShared, 'one.md', 'one\n');
      put(t.aShared, 'two.md', 'two\n');
      await until('B has them', () => hasText(t.bShared, 'one.md', 'one\n') && hasText(t.bShared, 'two.md', 'two\n'), WAIT);
      await settled(t);
      t.a.up = false;
      t.b.up = false;
      t.b.otherOnline = false;
      t.a.otherOnline = false;
      for (const c of [...t.a.sockets, ...t.b.sockets]) c.close();
      await until('the link is down', () => !connected(t.a) && !connected(t.b), WAIT);
      put(t.aShared, 'one.md', 'one edited\n');
      Deno.removeSync(`${t.aShared}${sep}two.md`);
      put(t.aShared, 'three.md', 'three\n');
      put(t.bShared, 'b-only.md', 'made on B while offline\n');
      await wait(400);
      assert(hasText(t.bShared, 'one.md', 'one\n'), 'B did not see the edit yet');
      t.a.up = true;
      t.b.up = true;
      t.b.otherOnline = true;
      t.a.otherOnline = true;
      await until(
        "B caught up and A got B's file",
        () =>
          hasText(t.bShared, 'one.md', 'one edited\n') && !exists(t.bShared, 'two.md') && hasText(t.bShared, 'three.md', 'three\n') &&
          hasText(t.aShared, 'b-only.md', 'made on B while offline\n'),
        20_000,
      ).catch(async (error) => {
        throw new Error(
          `${error.message}: conn ${connected(t.a)} ${connected(t.b)} A ${JSON.stringify(await filesOf(t.a))} B ${
            JSON.stringify(await filesOf(t.b))
          } A: ${listAll(t.aShared)} B: ${listAll(t.bShared)} dbgA ${JSON.stringify(t.a.s.ctx.pcsync.files.debug(t.sync))} dbgB ${
            JSON.stringify(t.b.s.ctx.pcsync.files.debug(t.sync))
          }`,
        );
      });
      await settled(t);
    } finally {
      await closeAll([t.a, t.b]);
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'a frame for a project this peer is not linked to is dropped: nothing is written, whatever the path says',
  async fn() {
    const t = await setup();
    try {
      await bothOn(t);
      const peerOfB = t.a.s.ctx.pcsync.peers.list()[0].id;
      assertEquals(t.b.s.ctx.pcsync.files.stats.rejected, 0, 'a real project is never refused');
      const hash = 'a'.repeat(64);
      const item = { op: 'file.state', area: 'shared' as const, path: 'evil.md', hash, size: 4, mtime: Date.now(), sup: [] };
      const was = t.b.s.ctx.pcsync.files.stats.rejected;
      assert(
        t.a.s.ctx.pcsync.links.sendBatch(peerOfB, {
          id: 'x1',
          project: 'unknownproject1',
          items: [{ op: 'file.begin', area: 'shared' }, item, { op: 'file.end', area: 'shared' }],
        }),
      );
      assert(
        t.a.s.ctx.pcsync.links.sendBatch(peerOfB, {
          id: 'x2',
          project: 'unknownproject1',
          items: [{ op: 'project.switch', shared: true, docs: true }],
        }),
      );
      await until('B rejected both', () => t.b.s.ctx.pcsync.files.stats.rejected === was + 2, WAIT);
      await wait(300);
      assert(!exists(t.bShared, 'evil.md'));
      assertEquals((await filesOf(t.b)).state, 'ok', 'the real project is unaffected');
    } finally {
      await closeAll([t.a, t.b]);
    }
  },
});

Deno.test({
  ...OPTS,
  name:
    'idle: a settled folder costs nothing (no scan, no hashing, no watcher event, almost no CPU) and the watcher alone still sees a change',
  async fn() {
    const t = await setup(WATCH_ONLY);
    try {
      await bothOn(t);
      put(t.aShared, 'idle.md', 'idle\n');
      await until('B has it', () => hasText(t.bShared, 'idle.md', 'idle\n'), WAIT);
      await settled(t);
      await wait(500); // the last events of our own writes
      await t.a.s.ctx.pcsync.files.idle();
      await t.b.s.ctx.pcsync.files.idle();
      const before = [t.a, t.b].map((n) => ({ ...n.s.ctx.pcsync.files.stats }));
      const cpu = process.cpuUsage();
      const start = performance.now();
      await wait(3000);
      const spent = (process.cpuUsage().user - cpu.user + process.cpuUsage().system - cpu.system) / 1000;
      const after = [t.a, t.b].map((n) => ({ ...n.s.ctx.pcsync.files.stats }));
      for (let i = 0; i < 2; i++) {
        assertEquals(
          [after[i].scans, after[i].hashed, after[i].events],
          [before[i].scans, before[i].hashed, before[i].events],
          'node ' + i,
        );
      }
      const wall = performance.now() - start;
      assert(spent < wall * 0.5, `the idle folders used ${Math.round(spent)} ms of CPU in ${Math.round(wall)} ms`);
    } finally {
      await closeAll([t.a, t.b]);
    }
  },
});

Deno.test({
  ...OPTS,
  name:
    'transfer: a file bigger than one chunk arrives intact in 512 KB chunks, every frame under 1 MB, and no temp file is left in the folder',
  async fn() {
    const cap = captureFrames();
    const t = await setup();
    try {
      await bothOn(t);
      const bytes = new Uint8Array(1_700_000);
      for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + (i >> 8)) % 256;
      put(t.aShared, 'data/blob.bin', bytes);
      await until('B has the whole file', () => {
        try {
          return Deno.statSync(`${t.bShared}${sep}data${sep}blob.bin`).size === bytes.length;
        } catch {
          return false;
        }
      }, WAIT);
      await settled(t);
      assertEquals(
        [...Deno.readFileSync(`${t.bShared}${sep}data${sep}blob.bin`)].join(',') === [...bytes].join(','),
        true,
        'the bytes are the same',
      );
      const data = cap.frames.filter((f) => f.includes('"file.data"'));
      assert(data.length >= 4, `chunked: ${data.length} data frames`);
      for (const f of cap.frames) assert(new TextEncoder().encode(f).length < 1024 * 1024, 'a frame is over the cap');
      assertEquals(listAll(t.bShared), ['data/blob.bin']);
      assertEquals(listAll(`${t.bRepo}${sep}.git${sep}aib-sync${sep}tmp`), [], 'no half-written file is left');
    } finally {
      cap.stop();
      await closeAll([t.a, t.b]);
    }
  },
});

Deno.test({
  ...OPTS,
  name:
    'the last-synced hashes survive a restart (an edit made on the other PC meanwhile is not a conflict), and the bin keeps 30 days only',
  async fn() {
    const t = await setup();
    try {
      // a bin folder from 40 days ago and one from yesterday, made before sync starts
      const bin = `${t.bRepo}${sep}.git${sep}aib-sync${sep}bin`;
      const [old, yesterday] = [40, 1].map((ago) => stamp(new Date(Date.now() - ago * 86_400_000)));
      for (const d of [old, yesterday]) {
        Deno.mkdirSync(`${bin}${sep}${d}`, { recursive: true });
        Deno.writeTextFileSync(`${bin}${sep}${d}${sep}old.md`, 'old\n');
      }
      await bothOn(t);
      put(t.aShared, 'doc.md', 'one\ntwo\nthree\n');
      await until('B has it', () => hasText(t.bShared, 'doc.md', 'one\ntwo\nthree\n'), WAIT);
      await settled(t);
      const dirs = [...Deno.readDirSync(bin)].map((e) => e.name);
      assertEquals(dirs, [yesterday], "the 40 day old bin folder was removed, yesterday's stays");
      const was = t.b.s.ctx.pcsync.files.baseOf(t.sync, 'doc.md');
      assert(was);
      await t.b.restart();
      put(t.aShared, 'doc.md', 'ONE\ntwo\nthree\n');
      await until('B has the edit after its restart', () => hasText(t.bShared, 'doc.md', 'ONE\ntwo\nthree\n'), 20_000);
      assertEquals(conflictsIn(t.bShared), [], 'no conflict: B still knew the last-synced version');
      assertEquals(conflictsIn(t.aShared), []);
    } finally {
      await closeAll([t.a, t.b]);
    }
  },
});
