/**
 * Sync between PCs, slice V7: a WSL project is synced by the same engine (server/pcsync/files.ts) through the WSL helper's `pcsync.fs`
 * (server/wsl/helper/pcsync.ts, wsl/pcsync.ts). PC "A" (studio-pc) holds its project behind a FakeWslHost: the real helper methods
 * (`pcsync.fs`, `docs.fs`) run on a temp folder standing in for the distro; PC "B" is an ordinary Windows project. Needs no WSL, no
 * distro and no wsl.exe. Covered: create, edit, delete and rename both ways, Restore from the bin (in the distro's .git/aib-sync/bin),
 * a conflict copy, the mass-delete guard (Allow and Keep files), a doc made on B landing in the distro through the docs store's WSL
 * path and a doc merge, links never followed, the helper refusing paths outside the project, a stopped distro that waits and is never
 * started (and catches up when it runs), and no absolute path in any frame or helper call. The real distro run is
 * pcsync_wsl_real_e2e_test.ts (AIB_WSL_E2E).
 */
import { assert, assertEquals } from './_assert.ts';
import { pc, tempDir } from './_remote_fixture.ts';
import { UserClient } from './_docs.ts';
import { FakeWslHost } from './_wsl_fake.ts';
import { ensureDefault } from '../../outputs/agent-studio/server/worktrees/local_only.ts';
import { setWslHostResolver } from '../../outputs/agent-studio/server/wsl/access.ts';
import { installWslDocFs } from '../../outputs/agent-studio/server/wsl/docs.ts';
import { docsMethods } from '../../outputs/agent-studio/server/wsl/helper/docs.ts';
import { pcsyncMethods } from '../../outputs/agent-studio/server/wsl/helper/pcsync.ts';
import { closeAll, type Json, type Node, paired, TEST_FILES, until } from './_pcsync_fixture.ts';

Deno.env.set('AIB_WSL_ROOT', '/tmp/aib-wsl-test-pcsync');
const OPTS = { sanitizeResources: false, sanitizeOps: false };
const sep = Deno.build.os === 'windows' ? '\\' : '/';
const WAIT = 20_000;
const REF = 'wsl://ubuntu/home/u/shop';
const LINUX = '/home/u/shop';
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
  return (v.peers as Json[])[0].projects as { links: { sync: string; files: FileView | null; docsFiles: FileView | null }[] };
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
const docsOf = async (n: Node): Promise<FileView> => (await projectsOf(n)).links[0].docsFiles!;
const connected = (n: Node) => n.s.ctx.pcsync.links.links().length === 1;

interface Setup {
  a: Node;
  b: Node;
  /** The temp folder that stands in for the WSL project's folder in the distro. */
  aRepo: string;
  bRepo: string;
  aShared: string;
  bShared: string;
  aDocs: string;
  bDocs: string;
  sync: string;
  host: FakeWslHost;
  /** Every `pcsync.fs` call the helper took: its ops. */
  helperOps: Json[];
}
async function setup(): Promise<Setup> {
  const [a, b] = await paired(TEST_FILES);
  try {
    const aRepo = await repo(await tempDir('aib-v7-a-'), 'shop', 'git@github.com:Acme/Shop.git');
    const bRepo = await repo(await tempDir('aib-v7-b-'), 'shop-clone', 'https://github.com/acme/shop');
    // PC A's project is in the distro: the real helper methods answer, on the temp folder
    const host = new FakeWslHost('unused', 'Ubuntu');
    host.folders.set(LINUX, aRepo);
    const resolve = (p: string) => host.windowsFor(p);
    const sync = pcsyncMethods({ resolve });
    const docs = docsMethods({ env: () => Promise.resolve({ env: { HOME: '/home/u' }, shell: '/bin/bash', home: '/home/u', arch: 'x86_64' }) }, { resolve });
    const helperOps: Json[] = [];
    host.handlers['pcsync.fs'] = (p: unknown) => {
      helperOps.push(...((p as Json).ops as Json[]));
      return sync['pcsync.fs'](p as never);
    };
    host.handlers['docs.fs'] = (p: unknown) => docs['docs.fs'](p as never);
    host.handlers['git.identity'] = () => ({ git: true, url: 'git@github.com:Acme/Shop.git', prefix: '' });
    setWslHostResolver((d: string) => (d === 'ubuntu' ? host : null));
    installWslDocFs();
    await a.s.ctx.addedProjects.add(REF);
    await b.s.ctx.addedProjects.add(bRepo);
    await until('both links up', () => connected(a) && connected(b));
    await a.s.ctx.pcsync.projects.refresh(true);
    await b.s.ctx.pcsync.projects.refresh(true);
    await until('linked on both PCs', async () => (await projectsOf(a)).links.length === 1 && (await projectsOf(b)).links.length === 1, WAIT);
    return {
      a,
      b,
      aRepo,
      bRepo,
      aShared: `${aRepo}${sep}aib-shared`,
      bShared: `${bRepo}${sep}aib-shared`,
      aDocs: `${aRepo}${sep}aib-docs`,
      bDocs: `${bRepo}${sep}aib-docs`,
      sync: (await projectsOf(a)).links[0].sync,
      host,
      helperOps,
    };
  } catch (error) {
    setWslHostResolver(null);
    await closeAll([a, b]);
    throw error;
  }
}
async function finish(t: Setup) {
  setWslHostResolver(null);
  await closeAll([t.a, t.b]);
}
async function setSwitch(n: Node, sync: string, which: 'shared' | 'docs', on: boolean) {
  const [status, body] = await pc(n.s, 'POST', '/api/live/pcsync/projects/switch', { sync, which, on });
  assertEquals(status, 200, JSON.stringify(body));
}
async function bothOn(t: Setup, which: 'shared' | 'docs' = 'shared') {
  await setSwitch(t.a, t.sync, which, true);
  await setSwitch(t.b, t.sync, which, true);
  const view = which === 'shared' ? filesOf : docsOf;
  await until('both PCs are up to date', async () => (await view(t.a)).state === 'ok' && (await view(t.b)).state === 'ok', WAIT);
}
async function settled(t: Setup, view = filesOf) {
  try {
    await until('both PCs are up to date', async () => {
      const [x, y] = [await view(t.a), await view(t.b)];
      return x.state === 'ok' && y.state === 'ok' && x.pending === 0 && y.pending === 0;
    }, WAIT);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : error}: A ${JSON.stringify(await view(t.a))} B ${JSON.stringify(await view(t.b))}`);
  }
}
const path = (dir: string, rel: string) => `${dir}${sep}${rel.split('/').join(sep)}`;
const put = (dir: string, rel: string, data: string | Uint8Array) => {
  const file = path(dir, rel);
  Deno.mkdirSync(file.slice(0, file.lastIndexOf(sep)), { recursive: true });
  if (typeof data === 'string') Deno.writeTextFileSync(file, data);
  else Deno.writeFileSync(file, data);
};
const text = (dir: string, rel: string): string | null => {
  try {
    return Deno.readTextFileSync(path(dir, rel));
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
      for (const f of listAll(`${bin}${sep}${d.name}`)) out.push([f.replace(/\.\d+$/, ''), Deno.readTextFileSync(`${bin}${sep}${d.name}${sep}${f}`)]);
    }
  } catch { /* no bin */ }
  return out;
}
const setTime = (dir: string, rel: string, ago: number) => {
  const d = new Date(Date.now() - ago);
  Deno.utimeSync(path(dir, rel), d, d);
};
const conflictsIn = (dir: string) => listAll(dir).filter((f) => f.includes('.sync-conflict-'));
const wipe = (dir: string) => {
  for (const f of listAll(dir)) Deno.removeSync(path(dir, f));
};
async function twelveFiles(t: Setup) {
  for (let i = 1; i <= 12; i++) put(t.bShared, `big/f${i}.md`, `file ${i}\n`);
  await until('A (in the distro) has all twelve', () => listAll(t.aShared).length === 12, WAIT);
  await settled(t);
}

// ---- the tests -----------------------------------------------------------------------------------------------------------------
Deno.test({
  ...OPTS,
  name:
    'WSL project: create, edit, delete and rename reach the other PC both ways, the bin is in the distro’s .git, Restore brings a file back, and no absolute path is in any frame or helper call',
  async fn() {
    const cap = captureFrames();
    const t = await setup();
    try {
      await bothOn(t);
      // create in the distro -> B, nested
      put(t.aShared, 'notes/plan.md', 'v1\n');
      put(t.aShared, 'top.txt', 'top\n');
      await until('B has the new files', () => hasText(t.bShared, 'notes/plan.md', 'v1\n') && hasText(t.bShared, 'top.txt', 'top\n'), WAIT);
      // create on B -> the distro (written by the helper)
      put(t.bShared, 'from-b/x.md', 'bee\n');
      await until('the distro has B’s file', () => hasText(t.aShared, 'from-b/x.md', 'bee\n'), WAIT);
      await settled(t);
      assertEquals(t.a.s.ctx.pcsync.files.baseOf(t.sync, 'notes/plan.md'), t.b.s.ctx.pcsync.files.baseOf(t.sync, 'notes/plan.md'));
      // edit on B -> the distro; the distro's old version is in its bin
      put(t.bShared, 'from-b/x.md', 'bee 2\n');
      await until('the distro has the edit', () => hasText(t.aShared, 'from-b/x.md', 'bee 2\n'), WAIT);
      assert(binOf(t.aRepo).some(([p, c]) => p === 'from-b/x.md' && c === 'bee\n'), 'the distro binned the version it replaced');
      // edit in the distro -> B
      put(t.aShared, 'top.txt', 'top 2\n');
      await until('B has the edit', () => hasText(t.bShared, 'top.txt', 'top 2\n'), WAIT);
      // rename on B
      Deno.renameSync(path(t.bShared, 'from-b/x.md'), path(t.bShared, 'from-b/y.md'));
      await until('the distro has the renamed file', () => hasText(t.aShared, 'from-b/y.md', 'bee 2\n') && !exists(t.aShared, 'from-b/x.md'), WAIT);
      // delete on B -> the distro: the file goes to the distro's bin (under .git, never inside aib-shared)
      Deno.removeSync(path(t.bShared, 'notes/plan.md'));
      await until('the distro lost the file', () => !exists(t.aShared, 'notes/plan.md'), WAIT);
      await settled(t);
      assert(binOf(t.aRepo).some(([p, c]) => p === 'notes/plan.md' && c === 'v1\n'), 'the deleted file is in the distro’s bin');
      assertEquals(listAll(t.aShared), listAll(t.bShared), 'the two folders are the same');
      for (const f of listAll(t.aShared)) assert(!f.includes('aib-sync'), 'no sync file inside aib-shared: ' + f);
      // Restore from the distro's bin: the file is back in the distro and travels to B
      const entries = await t.a.s.ctx.pcsync.files.binEntries(t.sync);
      const entry = entries.find((e) => e.path === 'notes/plan.md');
      assert(entry, 'the bin lists it: ' + JSON.stringify(entries));
      await t.a.s.ctx.pcsync.files.restore(t.sync, entry!.id);
      assert(hasText(t.aShared, 'notes/plan.md', 'v1\n'), 'restored in the distro');
      await until('B gets the restored file', () => hasText(t.bShared, 'notes/plan.md', 'v1\n'), WAIT);
      await settled(t);
      // the status of a WSL project is a real state, never the old "later update" note
      assertEquals((await filesOf(t.a)).state, 'ok');
      // no frame holds an absolute path or a folder of either PC (file data is left out: it is the files' own content)
      assert(cap.frames.some((f) => f.includes('"file.state"')) && cap.frames.some((f) => f.includes('"file.data"')));
      for (const frame of cap.frames) {
        const parsed = JSON.parse(frame);
        for (const item of parsed.items ?? []) delete item.data;
        const body = JSON.stringify(parsed);
        for (const root of [t.a.root, t.b.root, t.aRepo, t.bRepo, LINUX]) {
          assert(!body.includes(root) && !body.includes(JSON.stringify(root).slice(1, -1)), `a folder path is in a frame: ${body.slice(0, 200)}`);
        }
        assert(!/"[A-Za-z]:|"\/|"\\\\/.test(body), `an absolute path is in a frame: ${body.slice(0, 200)}`);
      }
      // ...and none in what the helper was asked: every path of every op is relative to aib-shared (no `..`, no drive, no root)
      assert(t.helperOps.length > 20, 'the helper did the file work');
      for (const op of t.helperOps) {
        for (const key of ['rel', 'to']) {
          const v = op[key];
          if (typeof v === 'string') assert(!/^([A-Za-z]:|\/|\\)|\.\.|\\/.test(v), `an op path is not relative: ${JSON.stringify(op)}`);
        }
      }
      // a scan is one helper call: a `walk` op arrives alone or with a `git` look, never one call per file
      assert(t.host.calls.filter(([m]) => m === 'pcsync.fs').length < t.helperOps.length, 'ops are batched');
    } finally {
      cap.stop();
      await finish(t);
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'WSL project: a binary changed on both PCs keeps the newer one and a conflict copy of the other, in the distro and on B',
  async fn() {
    const t = await setup();
    try {
      await bothOn(t);
      const bytes = (n: number) => new Uint8Array(3000).map((_, i) => (i * 7 + n) % 256);
      put(t.aShared, 'img/pic.bin', bytes(0));
      await until('B has it', () => exists(t.bShared, 'img/pic.bin'), WAIT);
      await settled(t);
      await setSwitch(t.b, t.sync, 'shared', false);
      await until('A sees B off', async () => (await filesOf(t.a)).state === 'other_off', WAIT);
      put(t.aShared, 'img/pic.bin', bytes(1));
      put(t.bShared, 'img/pic.bin', bytes(2));
      setTime(t.aShared, 'img/pic.bin', 30_000); // B's is newer this time: the distro resolves
      setTime(t.bShared, 'img/pic.bin', 1_000);
      await setSwitch(t.b, t.sync, 'shared', true);
      await until('the copy is on both PCs', () => conflictsIn(t.aShared).length === 1 && conflictsIn(t.bShared).length === 1, WAIT);
      await settled(t);
      const read = (dir: string, rel: string) => Deno.readFileSync(path(dir, rel));
      assertEquals([...read(t.aShared, 'img/pic.bin')], [...bytes(2)], 'B’s newer version won in the distro');
      const [name] = conflictsIn(t.aShared);
      assert(/^img\/pic\.sync-conflict-\d{8}-\d{6}-studio-pc\.bin$/.test(name), name); // the distro's PC lost
      assertEquals([...read(t.aShared, name)], [...bytes(1)]);
      assertEquals([...read(t.bShared, name)], [...bytes(1)], 'the copy reached the other PC too');
      assertEquals((await filesOf(t.a)).conflictCount, 1, 'the card counts it');
    } finally {
      await finish(t);
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'WSL project, mass-delete guard: a wipe on B pauses in the distro (files stay); Allow applies it and bins the files; Keep files sends them back',
  async fn() {
    const t = await setup();
    try {
      await bothOn(t);
      await twelveFiles(t);
      wipe(t.bShared);
      await until('the distro pauses', async () => (await filesOf(t.a)).pause !== null, WAIT);
      assertEquals((await filesOf(t.a)).pause, { deletes: 12, total: 12 });
      await wait(500);
      assertEquals(listAll(t.aShared).length, 12, 'nothing was deleted while paused');
      const [ok] = await pc(t.a.s, 'POST', '/api/live/pcsync/projects/files', { sync: t.sync, action: 'allow' });
      assertEquals(ok, 200);
      await until('the distro deleted them', () => listAll(t.aShared).length === 0, WAIT);
      assertEquals((await filesOf(t.a)).pause, null);
      assertEquals(binOf(t.aRepo).filter(([p]) => p.startsWith('big/')).length, 12, 'all twelve are in the distro’s bin');
      // again, and this time Keep files
      for (let i = 1; i <= 12; i++) put(t.bShared, `big2/f${i}.md`, `file ${i}\n`);
      await until('the distro has them', () => listAll(t.aShared).length === 12, WAIT);
      await settled(t);
      wipe(t.bShared);
      await until('the distro pauses again', async () => (await filesOf(t.a)).pause !== null, WAIT);
      const [keep] = await pc(t.a.s, 'POST', '/api/live/pcsync/projects/files', { sync: t.sync, action: 'keep' });
      assertEquals(keep, 200);
      await until('B has the files back', () => listAll(t.bShared).length === 12, WAIT);
      await settled(t);
      assertEquals(listAll(t.aShared).length, 12);
    } finally {
      await finish(t);
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'WSL project, aib-docs: a doc made on B lands in the distro through the docs store’s WSL path; edits to different blocks on both PCs merge',
  async fn() {
    const t = await setup();
    try {
      await bothOn(t, 'docs');
      const BASE = 'Title one\n\nSecond block\n\nThird block\n';
      const doc = await t.b.s.ctx.docs.open(t.bRepo, 'plan', BASE, 'user');
      await t.b.s.ctx.docs.flush(doc);
      await until('the distro has the doc', () => exists(t.aDocs, 'plan/doc.aibdoc'), WAIT);
      // the distro's docs store rendered it through the WSL path (the Markdown copy is in the distro)
      await until('the distro renders the page copy', () => (text(t.aDocs, 'plan/01-page-1.md') ?? '').includes('Second block'), WAIT);
      const blocks = (dir: string) => {
        const raw = text(dir, 'plan/doc.aibdoc');
        type N = { content?: N[]; text?: string };
        const textOf = (n: N): string => n.text ?? (n.content ?? []).map(textOf).join('');
        return raw === null ? [] : (JSON.parse(raw).pages as { content: N[] }[]).flatMap((p) => p.content.map(textOf));
      };
      assertEquals(blocks(t.aDocs), ['Title one', 'Second block', 'Third block']);
      await settled(t, docsOf);
      // both PCs edit a different block while the link is down
      for (const n of [t.a, t.b]) {
        n.up = false;
        n.otherOnline = false;
      }
      for (const c of [...t.a.sockets, ...t.b.sockets]) c.close();
      await until('the link is down', () => !connected(t.a) && !connected(t.b), WAIT);
      const type = async (n: Node, root: string, index: number, add: string) => {
        const d = await n.s.ctx.docs.open(root, 'plan');
        const user = new UserClient(d.live);
        const id = d.live.topIds()[index];
        user.type(id, user.text(id).length, add);
        await n.s.ctx.docs.flush(d);
      };
      await type(t.a, REF, 0, ' (A edit)');
      await type(t.b, t.bRepo, 2, ' (B edit)');
      for (const n of [t.a, t.b]) {
        n.up = true;
        n.otherOnline = true;
      }
      const want = ['Title one (A edit)', 'Second block', 'Third block (B edit)'];
      await until(
        'both PCs hold both edits',
        () => JSON.stringify(blocks(t.aDocs)) === JSON.stringify(want) && JSON.stringify(blocks(t.bDocs)) === JSON.stringify(want),
        WAIT,
      );
      await settled(t, docsOf);
    } finally {
      await finish(t);
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'WSL project: a stopped distro waits ("Waiting: Ubuntu is not running."), is never started or called, and catches up when it runs again',
  async fn() {
    const t = await setup();
    try {
      await bothOn(t);
      put(t.bShared, 'one.md', 'one\n');
      put(t.bShared, 'keep.md', 'kept\n'); // a second file: deleting one of two is not a wipe (the guard would pause it)
      await until('the distro has it', () => hasText(t.aShared, 'one.md', 'one\n'), WAIT);
      await settled(t);
      // the distro stops
      t.host.state = 'stopped';
      t.host.note = '';
      await until('A shows waiting', async () => (await filesOf(t.a)).state === 'waiting', WAIT);
      assertEquals((await filesOf(t.a)).reason, 'Waiting: Ubuntu is not running.');
      // it stays that way, and nothing calls (or starts) the distro while it is stopped
      const callsBefore = t.host.calls.length;
      put(t.bShared, 'two.md', 'made while the distro was stopped\n');
      Deno.removeSync(path(t.bShared, 'one.md'));
      await wait(1500);
      assertEquals((await filesOf(t.a)).state, 'waiting');
      assertEquals(t.host.calls.length, callsBefore, 'no helper call while the distro is stopped');
      assertEquals(t.host.reconnects, 0, 'the distro was never started');
      assert(!exists(t.aShared, 'two.md') && hasText(t.aShared, 'one.md', 'one\n'), 'nothing was written in the distro');
      // the docs side waits too
      await setSwitch(t.a, t.sync, 'docs', true);
      await setSwitch(t.b, t.sync, 'docs', true);
      await until('docs waits as well', async () => (await docsOf(t.a)).state === 'waiting', WAIT);
      assertEquals(t.host.calls.length, callsBefore, 'still no helper call');
      // the distro runs again: it catches up
      t.host.state = 'ready';
      await until('the distro caught up', () => hasText(t.aShared, 'two.md', 'made while the distro was stopped\n') && !exists(t.aShared, 'one.md'), WAIT)
        .catch(async (error) => {
          throw new Error(
            `${error.message}: A ${JSON.stringify(await filesOf(t.a))} dbg ${JSON.stringify(t.a.s.ctx.pcsync.files.debug(t.sync))} files ${listAll(t.aShared)}`,
          );
        });
      await settled(t);
      await until('docs is ok again', async () => (await docsOf(t.a)).state === 'ok', WAIT);
    } finally {
      await finish(t);
    }
  },
});

Deno.test({
  ...OPTS,
  name:
    'WSL project path safety: a link in the distro’s aib-shared is never followed or written through; the helper refuses paths outside the project (.., absolute, a link out)',
  async fn() {
    const t = await setup();
    const outside = await tempDir('aib-v7-out-');
    Deno.writeTextFileSync(`${outside}${sep}outside-secret.txt`, 'outside\n');
    Deno.mkdirSync(t.aShared, { recursive: true });
    const outB = await tempDir('aib-v7-outb-');
    try {
      Deno.symlinkSync(outside, path(t.aShared, 'ja'), { type: 'junction' }); // a link inside the distro's folder, to a folder with a file
      await bothOn(t);
      put(t.bShared, 'real.md', 'real\n');
      put(t.bShared, 'ja/inside.md', 'B wants this in the distro’s ja\n');
      await until('the real file crosses', () => hasText(t.aShared, 'real.md', 'real\n'), WAIT);
      await until('the distro holds the file that would go through its link', async () => (await filesOf(t.a)).held.some((h) => h.path === 'ja/inside.md'), WAIT);
      await wait(400);
      assertEquals(listAll(outside), ['outside-secret.txt'], 'nothing was written through the link in the distro');
      assert(!exists(t.bShared, 'ja/outside-secret.txt'), 'the link was not followed');
      assert(Deno.lstatSync(path(t.aShared, 'ja')).isSymlink, 'the link is still there');
      assertEquals((await filesOf(t.a)).held.some((h) => h.path.startsWith('ja/outside')), false, 'a file behind a link is not listed');

      // the helper itself: every path is checked, whatever AIB sends
      const helper = pcsyncMethods({ resolve: (p: string) => t.host.windowsFor(p) })['pcsync.fs'];
      const base = { project: LINUX, area: 'shared', sync: 'abcdefgh1' };
      const run = async (ops: Json[]) => ((await helper({ ...base, ops } as never)) as { results: Json[] }).results;
      for (const rel of ['../x.md', '/etc/passwd', 'C:\\x', 'a/../../x', 'a\\b', '.', '']) {
        const [r] = await run([{ op: 'read', rel }]);
        assertEquals([r.ok, r.code], [false, 'bad_path'], `read ${rel}`);
        const [w] = await run([{ op: 'safe', rel, create: true }]);
        assertEquals(w.ok, false, `safe ${rel}`);
      }
      const [bad1, bad2] = await run([{ op: 'tmpWrite', t: '../../evil', bytes: new Uint8Array([1]), first: true }, { op: 'copy', rel: 'real.md', to: '../out.md' }]);
      assertEquals([bad1.ok, bad2.ok], [false, false]);
      // through the junction: refused, nothing read
      const [through] = await run([{ op: 'read', rel: 'ja/outside-secret.txt' }]);
      assertEquals(through.ok, false);
      assert(!JSON.stringify(through).includes('outside\\n') && through.bytesB64 === undefined);
      // an install must not land outside either
      const [put1] = await run([{ op: 'tmpWrite', t: 'x1', bytes: new TextEncoder().encode('evil'), first: true }]);
      assertEquals(put1.ok, true);
      const [inst] = await run([{ op: 'install', t: 'x1', rel: 'ja/evil.md' }]);
      assertEquals(inst.ok, false);
      assertEquals(listAll(outside), ['outside-secret.txt'], 'nothing went through the link');
      // a project path that is not absolute or has `..` is a bad request; a project that is not there is refused
      for (const project of ['relative/shop', '/home/u/../shop', '/home/u/shop\\x']) {
        await Promise.resolve(helper({ ...base, project, ops: [{ op: 'rootKind' }] } as never)).then(() => assert(false, project), (e: Error) => assert(e instanceof Error));
      }
      await Promise.resolve(helper({ ...base, project: '/home/u/other', ops: [{ op: 'rootKind' }] } as never)).then(() => assert(false, 'missing project'), (e: Error) => assert(/not there/.test(e.message)));
      // a folder in the distro whose aib-shared is a link out of the project: nothing is read or written there
      const linked = await tempDir('aib-v7-linked-');
      Deno.symlinkSync(outB, `${linked}${sep}aib-shared`, { type: 'junction' });
      t.host.folders.set('/home/u/linked', linked);
      const [kind] = await ((await helper({ ...base, project: '/home/u/linked', ops: [{ op: 'rootKind' }, { op: 'walk' }, { op: 'mkRoot' }] } as never)) as { results: Json[] }).results;
      assertEquals(kind.kind, 'link');
    } finally {
      await finish(t);
    }
  },
});
