/**
 * Sync between PCs, slice V6: what you see, end to end. Two in-process AIB servers (_pcsync_fixture.ts) with temp git repos, linked
 * with the aib-shared switch on both PCs.
 *   - server: a sync conflict copy resolved with Keep this and Keep other (the bin gets what was replaced, both PCs end the same),
 *     refusals, the marks data, and ONE Device activity line per received batch (never one per file).
 *   - page (headless Chrome or Edge, ignored without one; own profile, no window): the sidebar mark in each state with its tooltip,
 *     a click opens Settings > Sync at the project, a focus change never changes the mark, a conflict file in Files shows the pill and
 *     the three icons, and Compare, Keep this and Keep other work from those icons.
 */
import process from 'node:process';
import { assert, assertEquals } from './_assert.ts';
import { pc, tempDir } from './_remote_fixture.ts';
import { ensureDefault } from '../../app/server/worktrees/local_only.ts';
import { closeAll, type Json, type Node, paired, TEST_FILES, until } from './_pcsync_fixture.ts';
import { Browser, browserPath, type Page } from './_doc_browser.ts';
import { stamp } from '../../app/server/pcsync/rules.ts';
import { projectKey } from '../../app/server/desktop/project_delete.ts';

const OPTS = { sanitizeResources: false, sanitizeOps: false };
const sep = Deno.build.os === 'windows' ? '\\' : '/';
const WATCH_ONLY = { ...TEST_FILES, rescanMs: 60_000 };
const WAIT = 15_000;
void process;
void WATCH_ONLY;

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


// ---- V6 helpers ----------------------------------------------------------------------------------------------------------------
const copyName = (base: string, ext = 'md') => `${base}.sync-conflict-${stamp()}-ubuntu-pc.${ext}`;
const resolve = (n: Node, sync: string, path: string, action: string) =>
  pc(n.s, 'POST', '/api/live/pcsync/projects/conflict', { sync, path, action });
/** A conflict copy as the engine leaves it: the original, and the copy beside it, on both PCs and counted by the engine. */
async function conflictPair(t: Setup, base: string, mine: string, theirs: string): Promise<string> {
  put(t.aShared, `${base}.md`, mine);
  await until('B has the original', () => hasText(t.bShared, `${base}.md`, mine), WAIT);
  const copy = copyName(base);
  put(t.aShared, copy, theirs);
  await until('the conflict copy is on both PCs', () => exists(t.bShared, copy), WAIT);
  await until('the engine counts the conflict', async () => (await filesOf(t.a)).conflictCount >= 1, WAIT);
  return copy;
}
const activityOf = async (n: Node) => {
  const [, v] = await pc(n.s, 'GET', '/api/live/devices/activity');
  return (v.entries as { name: string; action: string; result: string; device: string }[]).filter((e) => e.action === 'sync');
};

// ---- server tests --------------------------------------------------------------------------------------------------------------
Deno.test({
  ...OPTS,
  name:
    'conflict copy: Keep this bins the copy and keeps the file, Keep other puts the copy in place and bins the replaced file (both PCs end the same); bad requests are refused',
  async fn() {
    const t = await setup();
    try {
      await bothOn(t);
      // Keep this
      const one = await conflictPair(t, 'plan', 'mine\n', 'theirs\n');
      let [status, body] = await resolve(t.a, t.sync, one, 'this');
      assertEquals(status, 200, JSON.stringify(body));
      await until('the copy is gone on both PCs', () => !exists(t.aShared, one) && !exists(t.bShared, one), WAIT);
      assertEquals(text(t.aShared, 'plan.md'), 'mine\n');
      assertEquals(text(t.bShared, 'plan.md'), 'mine\n');
      assert(binOf(t.aRepo).some(([p, c]) => p === one && c === 'theirs\n'), 'the conflict copy is in the sync bin');
      await settled(t);
      assertEquals(conflictsIn(t.aShared).concat(conflictsIn(t.bShared)), []);
      // Keep other
      const two = await conflictPair(t, 'todo', 'old todo\n', 'new todo\n');
      [status, body] = await resolve(t.a, t.sync, two, 'other');
      assertEquals(status, 200, JSON.stringify(body));
      await until(
        'the copy replaced the file on both PCs',
        () =>
          hasText(t.aShared, 'todo.md', 'new todo\n') && hasText(t.bShared, 'todo.md', 'new todo\n') && !exists(t.aShared, two) &&
          !exists(t.bShared, two),
        WAIT,
      );
      assert(binOf(t.aRepo).some(([p, c]) => p === 'todo.md' && c === 'old todo\n'), 'the replaced version is in the sync bin');
      await settled(t);
      assertEquals(conflictsIn(t.aShared).concat(conflictsIn(t.bShared)), []);
      // refusals: a plain file, a copy that is already gone, an unknown project, an unknown action
      assertEquals((await resolve(t.a, t.sync, 'plan.md', 'this'))[0], 409);
      assertEquals((await resolve(t.a, t.sync, one, 'this'))[0], 409);
      assertEquals((await resolve(t.a, 'nope', copyName('plan'), 'this'))[0], 409);
      assertEquals((await resolve(t.a, t.sync, copyName('plan'), 'keep'))[0], 400);
      assertEquals(text(t.aShared, 'plan.md'), 'mine\n');
    } finally {
      await closeAll([t.a, t.b]);
    }
  },
});

Deno.test({
  ...OPTS,
  name:
    'marks data: the paired PC with the project, its folder and file states (no Tailscale read); Device activity: one line per received batch, not per file',
  async fn() {
    const t = await setup({ ...TEST_FILES, batchMs: 600 });
    try {
      await bothOn(t);
      const [status, marks] = await pc(t.a.s, 'GET', '/api/live/pcsync/marks');
      assertEquals(status, 200);
      const peers = marks.peers as { name: string; reach: string; projects: { links: { sync: string; folder: string; files: { state: string } }[] } }[];
      assertEquals([peers[0].name, peers[0].reach], ['ubuntu-pc', 'online']);
      assertEquals([peers[0].projects.links[0].sync, peers[0].projects.links[0].folder], [t.sync, t.aRepo]);
      assertEquals(peers[0].projects.links[0].files.state, 'ok');
      // three files in one go on A: B writes ONE line
      assertEquals((await activityOf(t.b)).length, 0);
      put(t.aShared, 'a.md', 'a\n');
      put(t.aShared, 'b.md', 'b\n');
      put(t.aShared, 'sub/c.md', 'c\n');
      await until('B has the three files', () => ['a.md', 'b.md', 'sub/c.md'].every((f) => exists(t.bShared, f)), WAIT);
      await until('B wrote its activity line', async () => (await activityOf(t.b)).length >= 1, WAIT);
      await new Promise((r) => setTimeout(r, 1500)); // no second line follows
      const lines = await activityOf(t.b);
      assertEquals(lines.length, 1, JSON.stringify(lines));
      assertEquals([lines[0].name, lines[0].device, lines[0].result], ['studio-pc', '', '3 files to shop-clone']);
      // and the other way: one file is "1 file"
      put(t.bShared, 'back.md', 'back\n');
      await until('A has it', () => exists(t.aShared, 'back.md'), WAIT);
      await until('A wrote its line', async () => (await activityOf(t.a)).length === 1, WAIT);
      assertEquals((await activityOf(t.a))[0].result, '1 file to shop');
    } finally {
      await closeAll([t.a, t.b]);
    }
  },
});

// ---- page test -----------------------------------------------------------------------------------------------------------------
const fview = (over: Json = {}) => ({ state: 'ok', reason: '', pending: 0, conflicts: [], conflictCount: 0, held: [], pause: null, ...over });
const marksFixture = (sync: string, folder: string, files: Json | null, docsFiles: Json | null) => ({
  on: true,
  peers: [{
    id: 'p1',
    name: 'ubuntu-pc',
    reach: 'online',
    projects: { links: [{ sync, name: 'shop', folder, confirmed: true, missing: false, files, docsFiles }] },
  }],
});
const markState = (page: Page, fixture: unknown) =>
  page.eval<{ state: string; title: string; aria: string; icon: number; n: string }>(
    `(() => { AIBPcSyncUI._take(${JSON.stringify(fixture)}); const b = document.querySelector('.sync-mark');
      return { state: b.dataset.state, title: b.title, aria: b.getAttribute('aria-label'), icon: b.querySelector('svg').getBoundingClientRect().width,
        n: b.querySelector('.sync-mark-n').textContent }; })()`,
  );
/** Every mark on the page: what it says and where it is. */
const snapshot = (page: Page, withRects: boolean) =>
  page.eval<string>(
    `JSON.stringify(Array.from(document.querySelectorAll('.sync-mark')).map((b) => { const r = b.getBoundingClientRect();
      return { html: b.outerHTML, ${withRects ? 'x: r.x, y: r.y, w: r.width, h: r.height, px: b.parentNode.getBoundingClientRect().x' : 'k: 1'} }; }))`,
  );

Deno.test({
  ...OPTS,
  ignore: !browserPath,
  name:
    'page: the sidebar sync mark shows each state with its tooltip, a click opens Settings > Sync at the project, a focus change changes nothing; a conflict file in Files has the pill and Compare, Keep this and Keep other work',
  async fn() {
    const t = await setup();
    const browser = await Browser.launch();
    try {
      await bothOn(t);
      // a chat in A's project, so the project shows in the sidebar
      t.a.s.chats.push({
        id: 'c1',
        provider: 'claude',
        sessionId: 'sess-1',
        cwd: t.aRepo,
        busy: false,
        closed: false,
        attention: { state: 'idle', needs: 0, turnEndedAt: null, busySince: null },
        subagents: {},
        breadth: { sessionInfo: { title: 'Shop chat' } },
        events: [{ seq: 1, kind: 'user', time: 1, data: { text: 'hello' } }],
        permissions: [],
        elicitations: [],
      } as never);
      // two conflict copies, made before the page lists the folder
      const keepThis = await conflictPair(t, 'plan', 'mine\n', 'theirs\n');
      const keepOther = await conflictPair(t, 'todo', 'old todo\n', 'new todo\n');
      // the window shows this project with its chat open
      const ALPHA = projectKey(t.aRepo);
      const ws = { v: 1, active: ALPHA, tabs: { [ALPHA]: ['claude:sess-1'] }, last: { [ALPHA]: 'claude:sess-1' }, recent: ALPHA };
      await t.a.s.ctx.viewPrefs.update({ set: { 'studio-workspace-v1': JSON.stringify(ws) } });
      const page = await browser.open('about:blank', 1600, 900);
      await page.goto(`http://127.0.0.1:${t.a.s.port}/chat.html`);
      try {
        await page.waitFor(`!!document.querySelector('.sync-mark')`, 30_000, 'the sync mark on the synced project');
      } catch (error) {
        const info = await page.eval(
          `(async () => { let m; try { m = await AgentStudioGet('/api/live/pcsync/marks'); } catch (e) { m = 'ERR ' + e.message; }
            let c; try { c = await AgentStudioGet('/api/live/connections'); } catch (e) { c = 'ERR ' + e.message; }
            return JSON.stringify({ path: AgentWorkspaceUI.currentProjectPath && AgentWorkspaceUI.currentProjectPath(), has: !!AIBPcSyncUI.markFor(AgentWorkspaceUI.currentProjectPath()),
              pen: !!document.getElementById('wsRenameProj'), penHidden: document.getElementById('wsRenameProj').hidden, ui: typeof AIBPcSyncUI, heads: document.querySelectorAll('.project-head-row').length, top: document.getElementById('wsListName').textContent,
            conns: document.querySelectorAll('button.connection').length, errors: window.__csp }); })()`,
        );
        throw new Error(`${error instanceof Error ? error.message : error}: ${info} ${page.errors.join(' | ')} ${page.logs.join(' | ')}`);
      }

      // each state, with its tooltip (a fixture in the page, replaced by the real data afterwards)
      const folder = t.aRepo;
      const state = (files: Json | null, docs: Json | null = null) => markState(page, marksFixture(t.sync, folder, files, docs));
      let m = await state(fview());
      assertEquals([m.state, m.title], ['ok', 'Up to date with ubuntu-pc. PC to PC over Tailscale, no cloud.']);
      assertEquals(m.icon, 14, 'the mark is 14 px');
      assert(m.aria.startsWith('Sync with ubuntu-pc'), m.aria);
      m = await state(fview({ pending: 3 }));
      assertEquals([m.state, m.title], ['syncing', 'Syncing 3 files with ubuntu-pc. PC to PC, no cloud.']);
      m = await state(fview({ state: 'offline' }));
      assertEquals([m.state, m.title], ['waiting', 'ubuntu-pc is off or not reachable. Changes wait here.']);
      m = await state(fview({ conflictCount: 2, conflicts: ['a', 'b'] }));
      assertEquals([m.state, m.n, m.title], ['conflict', '2', '2 sync conflicts with ubuntu-pc. Click to open Sync settings.']);
      m = await state(fview({ pause: { deletes: 340, total: 400 } }));
      assertEquals([m.state, m.title], ['paused', 'Sync paused: 340 of 400 files were deleted on ubuntu-pc. Click to choose.']);
      m = await state(fview({ state: 'off' }), fview({ state: 'off' }));
      assertEquals([m.state, m.title], ['off', 'Sync is off for this project. Click to open Sync settings.']);
      // aib-shared and docs are one mark: the state that needs you most wins
      m = await state(fview(), fview({ conflictCount: 1 }));
      assertEquals(m.state, 'conflict');
      m = await state(fview({ pending: 1 }), fview({ pause: { deletes: 5, total: 9 } }));
      assertEquals(m.state, 'paused');
      m = await state(fview({ state: 'offline' }), fview({ pending: 2 }));
      assertEquals(m.state, 'waiting');
      m = await state(fview(), fview({ pending: 2 }));
      assertEquals(m.state, 'syncing');
      // the real data comes back: both PCs are up to date except the two conflict copies
      await page.eval(`AIBPcSyncUI._poll()`);
      await page.waitFor(`document.querySelector('.sync-mark').dataset.state === 'conflict'`, 10_000, 'the real conflict state');
      assertEquals(
        await page.eval(`document.querySelector('.sync-mark').title`),
        '2 sync conflicts with ubuntu-pc. Click to open Sync settings.',
      );

      // a focus change moves, shows and hides nothing
      const before = await snapshot(page, true);
      assert(JSON.parse(before).length >= 1);
      await page.eval(`document.getElementById('findChat').focus()`);
      await page.eval(`window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange'))`);
      await page.key('Tab');
      await page.eval(`document.activeElement && document.activeElement.blur()`);
      assertEquals(await snapshot(page, true), before, 'the mark is the same after focus moves');
      // opening a chat of the project keeps the mark (it may be drawn by the other header, but says the same)
      await page.click('button.connection[data-key="claude:sess-1"]');
      await page.waitFor(`document.querySelector('button.connection[data-key="claude:sess-1"]')?.classList.contains('selected')`, 20_000, 'the chat open');
      const after = JSON.parse(await snapshot(page, false)) as { html: string }[];
      assert(after.length >= 1 && after.every((x) => x.html.includes('data-state="conflict"') && x.html.includes('ubuntu-pc')), 'the mark stays');

      // a click opens Settings > Sync, scrolled to the project's row
      await page.click('.sync-mark');
      await page.waitFor(`document.body.classList.contains('settings-open')`, 10_000, 'Settings open');
      await page.waitFor(
        `(() => { const r = document.querySelector('.ps-project[data-sync=${JSON.stringify(t.sync)}]'); if (!r) return false; const b = r.getBoundingClientRect();
          return b.top >= 0 && b.bottom <= window.innerHeight; })()`,
        15_000,
        "the project's row in view",
      );
      assert(await page.eval<boolean>(`!!document.querySelector('.ps-files[data-area="shared"]')`), 'the Sync card is the one shown');
      await page.key('Escape');
      await page.waitFor(`!document.body.classList.contains('settings-open')`, 10_000, 'Settings closed');

      // Files: the conflict files have the pill and three icons; the original does not
      await page.eval(`AgentFilesUI.setMode('files')`);
      await page.waitFor(`!!document.querySelector('.fx-row[data-path="aib-shared"]')`, 20_000, 'aib-shared listed');
      await page.eval(`document.querySelector('.fx-row[data-path="aib-shared"]').click()`);
      const row = (p: string) => `.fx-row[data-path=${JSON.stringify('aib-shared/' + p)}]`;
      await page.waitFor(`!!document.querySelector(${JSON.stringify(row(keepThis))})`, 20_000, 'the conflict copy listed');
      const look = (p: string) =>
        page.eval<{ pill: string; acts: string[]; labels: string[] }>(
          `(() => { const n = document.querySelector(${JSON.stringify(row(p))}); return { pill: (n.querySelector('.fx-conflict') || {}).textContent || '',
            acts: Array.from(n.querySelectorAll('.fx-cf')).map((b) => b.dataset.act), labels: Array.from(n.querySelectorAll('.fx-cf')).map((b) => b.title) }; })()`,
        );
      const looked = await look(keepThis);
      assertEquals([looked.pill, looked.acts], ['sync conflict', ['compare', 'keep-this', 'keep-other']]);
      assert(looked.labels[1].startsWith('Keep this') && looked.labels[2].startsWith('Keep other'), looked.labels.join(' | '));
      assertEquals(await look('plan.md'), { pill: '', acts: [], labels: [] }, 'the original has no pill and no icons');

      // Compare opens the compare view of the original against the copy
      await page.eval(`document.querySelector(${JSON.stringify(row(keepThis) + ' .fx-cf[data-act="compare"]')}).click()`);
      await page.waitFor(`!!document.querySelector('.sf-ed-back')`, 30_000, 'the Compare view');
      assertEquals(await page.eval(`document.querySelector('.sf-ed-back').textContent`), 'Back to editing');
      await page.eval(`document.querySelector('.sf-ed-back').click()`);

      // Keep this: the row goes, the file stays, the copy is in the sync bin on this PC
      await page.eval(`document.querySelector(${JSON.stringify(row(keepThis) + ' .fx-cf[data-act="keep-this"]')}).click()`);
      await page.waitFor(`!document.querySelector(${JSON.stringify(row(keepThis))})`, 20_000, 'the copy row gone');
      await until('the copy is gone on both PCs', () => !exists(t.aShared, keepThis) && !exists(t.bShared, keepThis), WAIT);
      assertEquals([text(t.aShared, 'plan.md'), text(t.bShared, 'plan.md')], ['mine\n', 'mine\n']);
      assert(binOf(t.aRepo).some(([p, c]) => p === keepThis && c === 'theirs\n'), 'the copy is in the sync bin');

      // Keep other: the copy replaces the file on both PCs, the replaced one is in the bin
      await page.eval(`document.querySelector(${JSON.stringify(row(keepOther) + ' .fx-cf[data-act="keep-other"]')}).click()`);
      await page.waitFor(`!document.querySelector(${JSON.stringify(row(keepOther))})`, 20_000, 'the second copy row gone');
      await until(
        'the copy replaced the file on both PCs',
        () => hasText(t.aShared, 'todo.md', 'new todo\n') && hasText(t.bShared, 'todo.md', 'new todo\n') && !exists(t.bShared, keepOther),
        WAIT,
      );
      assert(binOf(t.aRepo).some(([p, c]) => p === 'todo.md' && c === 'old todo\n'), 'the replaced file is in the sync bin');
      await page.waitFor(`document.querySelector('.sync-mark').dataset.state === 'ok'`, 15_000, 'the mark is quiet again');
      assertEquals(page.errors.length, 0, `console errors: ${page.errors.join(' | ')}`);
      assertEquals(page.csp.length, 0, `CSP: ${page.csp.join(' | ')}`);
    } finally {
      await browser.close();
      await closeAll([t.a, t.b]);
    }
  },
});
