/**
 * The project right panel's Changes tab (design project-right-panel, slice S2; owner 2026-11-18): VS Code Source Control style.
 *
 * chat.html in a real headless Chrome against a Studio in this process (a fake agent host, one project that is a real Git
 * repository). The project folder has uncommitted edits; two running subagents work in real Git worktrees made from a snapshot S
 * (HEAD plus those edits, as AIB makes them); a spare worktree and one that holds work that never landed sit in
 * subagent-worktrees.json too.
 *
 *  1. Main with uncommitted edits plus 2 active subagent worktrees gives 3 sections; main's edits are NOT repeated in the worktree
 *     sections (their diff starts at the snapshot); each head has the name, parent chat, branch, file count and +/- totals; the
 *     header chip, the tab badge and the bar count the project.
 *  2. A spare worktree is hidden. A left-over worktree shows folded under "Left over", with no Merge or Discard anywhere.
 *  3. A file row opens its diff (a worktree's is asked by its record id, never by a path; a raw path is refused by the server).
 *  4. A focus change (opening another chat of the project) moves only the accent: the Changes tab does not change at all.
 *  5. The refresh rule: no reads while the Changes tab is hidden; a read at once on showing it and every 10 s after; a read when
 *     another chat's turn ends, whichever tab shows.
 *  6. A WSL project shows main only, through ONE `changes.many` helper call (a fake helper; no distro needed).
 *
 * Run (from outputs/agent-studio): deno test -A ../../work/deno/project_changes_e2e_test.ts   (the browser tests are ignored without
 * Chrome or Edge)
 */
import { assert, assertEquals } from './_assert.ts';
import { Browser, browserPath, type Page } from './_doc_browser.ts';
import { pc, remoteStudio, type RemoteStudio } from './_remote_fixture.ts';
import { FakeWslHost } from './_wsl_fake.ts';
import { setWslHostResolver } from '../../outputs/agent-studio/server/wsl/access.ts';

type Json = Record<string, unknown>;
const SEP = Deno.build.os === 'windows' ? '\\' : '/';

function git(cwd: string, ...args: string[]): string {
  const o = new Deno.Command('git', { args: ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...args], cwd, stdout: 'piped', stderr: 'piped' })
    .outputSync();
  if (!o.success) throw new Error(`git ${args.join(' ')}: ${new TextDecoder().decode(o.stderr)}`);
  return new TextDecoder().decode(o.stdout).trim();
}
function write(path: string, text: string) {
  Deno.mkdirSync(path.replace(/[\\/][^\\/]+$/, ''), { recursive: true });
  Deno.writeTextFileSync(path, text);
}
const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`).join('\n') + '\n';

interface Fixture {
  s: RemoteStudio;
  repo: string;
  /** Worktree folders by record id. */
  trees: Record<string, string>;
}

/**
 * The project: a repository with one commit and two uncommitted edits (main-edit.txt new, app.txt changed). A worktree per record
 * is made from the snapshot S (HEAD + those edits, committed on the worktree's own branch), then the subagent's own edits are added
 * in it. Records: sub-a and sub-b running (2 and 1 files), sub-spare (a spare), sub-left (stopped, 1 file, never landed).
 */
async function project(): Promise<Fixture> {
  const s = await remoteStudio();
  const repo = `${s.root}${SEP}projects${SEP}app`;
  Deno.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  write(`${repo}/app.txt`, lines(10, 'app'));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  // main's uncommitted edits: they are in every snapshot
  write(`${repo}/app.txt`, lines(10, 'app') + 'main edit\n');
  write(`${repo}/main-edit.txt`, 'edited in the project folder\n');
  const trees: Record<string, string> = {};
  const records: Record<string, Json> = {};
  const make = (id: string, state: string, edits: Record<string, string>, over: Json = {}) => {
    const path = `${s.root}${SEP}worktrees${SEP}${id}`;
    git(repo, 'worktree', 'add', '-q', '-b', `studio/${id}`, path, 'HEAD');
    write(`${path}/app.txt`, lines(10, 'app') + 'main edit\n'); // S carries main's edits
    write(`${path}/main-edit.txt`, 'edited in the project folder\n');
    git(path, 'add', '-A');
    git(path, 'commit', '-q', '-m', 'snapshot S');
    const snapshot = git(path, 'rev-parse', 'HEAD');
    for (const [name, text] of Object.entries(edits)) write(`${path}/${name}`, text); // the subagent's own, uncommitted work
    trees[id] = path;
    records[id] = {
      id, kind: 'subagent', chat: 'c1', lasting: 'claude:sess-1', project: repo, folder: repo, slug: id, branch: `studio/${id}`, path,
      snapshot, tree: '', state, toolUseId: 't-' + id, agentId: 'a-' + id, agentType: 'general-purpose', description: id, createdAt: Date.now() / 1000, ...over,
    };
  };
  make('sub-a', 'running', { 'pkg/parser.ts': lines(5, 'parser'), 'pkg/lexer.ts': lines(3, 'lexer') }, { description: 'Port the parser', createdAt: 1 });
  make('sub-b', 'running', { 'docs/notes.md': lines(2, 'notes') }, { description: 'Check the docs', createdAt: 2 });
  make('sub-spare', 'spare', { 'ignored.txt': 'a spare holds no work\n' }, { description: '', createdAt: 3 });
  // its chat is not open (so nothing here adopts or removes it): a worktree whose work never landed
  make('sub-left', 'stopped', { 'old/refactor.ts': lines(4, 'old') }, { description: 'Old refactor', chat: 'ghost', lasting: 'claude:ghost', createdAt: 4, stoppedWhy: 'the turn was stopped' });
  Deno.writeTextFileSync(`${s.state}${SEP}subagent-worktrees.json`, JSON.stringify({ version: 1, subagents: records }));
  return { s, repo, trees };
}

const attention = (state: string, busySince: string | null = null, turnEndedAt: string | null = null) => ({ state, needs: 0, turnEndedAt, busySince });
function addChat(s: RemoteStudio, n: number, title: string, cwd: string, working: boolean) {
  s.chats.push({
    id: 'c' + n, provider: 'claude', sessionId: 'sess-' + n, cwd, busy: working, closed: false,
    attention: working ? attention('working', new Date(Date.now() - n * 60_000).toISOString()) : attention('idle'),
    subagents: {}, breadth: { sessionInfo: { title } },
    events: [{ seq: 1, kind: 'user', time: 1, data: { text: 'work on ' + title } }], permissions: [], elicitations: [],
  });
}
async function openChat(page: Page, key: string) {
  const sel = `button.connection[data-key="${key}"]`;
  await page.waitFor(`!!document.querySelector(${JSON.stringify(sel)})`, 20000, `sidebar row ${key}`);
  await page.click(sel);
  await page.waitFor(`document.querySelector(${JSON.stringify(sel)})?.classList.contains('selected')`, 20000, `${key} open`);
}
const SECS = `[...document.querySelectorAll('#projectChanges > .cg-sec')].map((n) => n.dataset.sec)`;
const names = (page: Page, sec: string) =>
  page.eval<string[]>(`[...document.querySelectorAll('#projectChanges > .cg-sec[data-sec="${sec}"] .cg-file')].map((b) => b.dataset.path).sort()`);
const reads = (page: Page, what = '/api/live/project/changes?') =>
  page.eval<number>(`performance.getEntriesByType('resource').filter((e) => e.name.includes(${JSON.stringify(what)})).length`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withPanel(fn: (page: Page, fx: Fixture) => Promise<void>) {
  const fx = await project();
  // no saved transcripts: the chats are live only (the page lists them from the agent host)
  fx.s.ctx.transcripts = {
    root: fx.s.state,
    sessions: () => Promise.resolve([]),
    agents: () => Promise.resolve([]),
    sessionCwd: () => Promise.resolve(null),
  } as unknown as typeof fx.s.ctx.transcripts;
  addChat(fx.s, 1, 'Fix login', fx.repo, true);
  addChat(fx.s, 2, 'Write docs', fx.repo, true);
  const browser = await Browser.launch();
  try {
    const page = await browser.open('about:blank', 1600, 900);
    await page.goto(`http://127.0.0.1:${fx.s.port}/chat.html`);
    await openChat(page, 'claude:sess-1');
    await fn(page, fx);
    assertEquals(page.errors, [], 'console errors');
    await page.close();
  } finally {
    await browser.close();
    await fx.s.close();
  }
}

Deno.test({
  name: 'project Changes: main plus two active worktrees give 3 sections, main\'s edits are not repeated, spares are hidden, left-over work is folded',
  ignore: !browserPath,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await withPanel(async (page) => {
      await page.eval(`document.getElementById('paneTab-changes').click()`);
      await page.waitFor(`(${SECS}).length === 3`, 30000, 'three sections').catch(async (e) => {
        throw new Error(`${e.message}: ${await page.eval<string>(`document.getElementById('changesPane').innerText`)}`);
      });
      assertEquals(await page.eval<string[]>(SECS), ['main', 'sub-a', 'sub-b'], 'main first, then the worktrees in the order they started');
      // main: its uncommitted edits; the worktree sections: only what the subagent itself did since S
      assertEquals(await names(page, 'main'), ['app.txt', 'main-edit.txt']);
      assertEquals(await names(page, 'sub-a'), ['pkg/lexer.ts', 'pkg/parser.ts']);
      assertEquals(await names(page, 'sub-b'), ['docs/notes.md']);
      const all = await page.eval<string[]>(`[...document.querySelectorAll('#projectChanges > .cg-sec:not([data-sec="main"]) .cg-file')].map((b) => b.dataset.path)`);
      assert(!all.includes('main-edit.txt') && !all.includes('app.txt'), `main's edits repeated in a worktree section: ${all}`);
      // heads: name, parent chat, branch, counts
      const heads = await page.eval<string[][]>(`[...document.querySelectorAll('#projectChanges > .cg-sec')].map((s) => [
        s.querySelector('.cg-sec-name').textContent, s.querySelector('.cg-sec-sub').textContent, s.querySelector('.cg-sec-sum').innerText.replace(/\\s+/g, ' ').trim()])`);
      assertEquals(heads[0], ['Project folder', 'Branch main', '2 files +2 −0']);
      assertEquals(heads[1], ['Port the parser', 'Subagent of “Fix login” · studio/sub-a', '2 files +8 −0']);
      assertEquals(heads[2], ['Check the docs', 'Subagent of “Fix login” · studio/sub-b', '1 file +2 −0']);
      // the project's count: the bar, the tab badge and the header chip
      assertEquals(await page.eval<string>(`document.querySelector('#changesPane .cg-sum').innerText.replace(/\\s+/g, ' ').trim()`), '5 files +12 −0');
      assertEquals(await page.eval<string>(`document.querySelector('#paneTab-changes .pane-badge').textContent`), '5');
      assertEquals(await page.eval<string>(`document.getElementById('changesChip').innerText.replace(/\\s+/g, ' ').trim()`), 'Changes · 5 files +12 −0');
      // the spare worktree is not listed anywhere
      assert(!(await page.eval<boolean>(`/ignored\\.txt|spare/i.test(document.getElementById('projectChanges').innerText)`)), 'a spare worktree is hidden');
      // left over: one folded group, its section folded too, never counted in the project's numbers
      const left = await page.eval<{ head: string; open: string; below: number }>(`(() => {
        const g = document.querySelector('#projectChanges > .cg-left'), h = g.querySelector('.cg-left-head');
        return { head: h.textContent, open: h.getAttribute('aria-expanded'), below: g.querySelectorAll('.cg-sec').length };
      })()`);
      assertEquals(left, { head: '▸Left over (1)', open: 'false', below: 0 });
      await page.click('#projectChanges > .cg-left .cg-left-head');
      await page.waitFor(`!!document.querySelector('#projectChanges > .cg-left .cg-sec[data-sec="sub-left"]')`, 10000, 'the left-over section');
      const sec = await page.eval<{ head: string; sub: string; expanded: string; files: number }>(`(() => {
        const s = document.querySelector('#projectChanges > .cg-left .cg-sec'), h = s.querySelector('.cg-sec-head');
        return { head: h.innerText.replace(/\\s+/g, ' ').trim(), sub: s.querySelector('.cg-sec-sub').textContent, expanded: h.getAttribute('aria-expanded'), files: s.querySelectorAll('.cg-file').length };
      })()`);
      assertEquals(sec, { head: '▸ Old refactor 1 file +4 −0', sub: 'Subagent · studio/sub-left · Stopped before its work landed' /* its chat is not open: no parent title */, expanded: 'false', files: 0 });
      // unfolding it reads its files (they were counted only until now)
      await page.click('#projectChanges > .cg-left .cg-sec .cg-sec-head');
      await page.waitFor(`document.querySelectorAll('#projectChanges > .cg-left .cg-file').length === 1`, 20000, 'its file after unfolding');
      assertEquals(
        await page.eval<number>(`[...document.querySelectorAll('#changesPane button')].filter((b) => /merge|discard|commit|undo/i.test(b.textContent + b.title)).length`),
        0,
        'no Merge, Discard or Commit button',
      );
      assertEquals(await page.eval<string>(`document.querySelector('#paneTab-changes .pane-badge').textContent`), '5', 'left-over work is not in the count');
    });
  },
});

Deno.test({
  name: 'project Changes: a file row opens its diff; a worktree file is asked by its record id, a raw path is refused',
  ignore: !browserPath,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await withPanel(async (page, fx) => {
      await page.eval(`document.getElementById('paneTab-changes').click()`);
      await page.waitFor(`(${SECS}).length === 3`, 30000, 'three sections');
      // main's first file opens by itself, as before
      await page.waitFor(`/main edit/.test(document.querySelector('#projectChanges > .cg-sec[data-sec="main"] .cg-diff')?.innerText || '')`, 20000, 'main\'s first diff');
      // a worktree's file: click its row, the diff opens right under it
      const ROW = '#projectChanges > .cg-sec[data-sec="sub-a"] .cg-file[data-path="pkg/parser.ts"]';
      await page.click(ROW);
      await page.waitFor(`/parser 1/.test(document.querySelector('#projectChanges > .cg-sec[data-sec="sub-a"] .cg-diff')?.innerText || '')`, 20000, 'the worktree diff')
        .catch(async (e) => {
          throw new Error(`${e.message}: ${await page.eval<string>(`document.getElementById('projectChanges').innerText.slice(0, 800)`)}`);
        });
      assertEquals(await page.eval<string>(`document.querySelector('${ROW}').getAttribute('aria-expanded')`), 'true');
      const asked = await page.eval<string[]>(`performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.includes('/api/live/project/changes/file'))`);
      assertEquals(asked.length, 1);
      assert(/section=sub-a/.test(asked[0]) && /path=pkg%2Fparser\.ts/.test(asked[0]), asked[0]);
      assert(!asked[0].includes(encodeURIComponent(fx.trees['sub-a'])) && !/worktrees/.test(asked[0]), `the worktree's own path was sent: ${asked[0]}`);
      // a click again folds the diff
      await page.click(ROW);
      await page.waitFor(`!document.querySelector('#projectChanges > .cg-sec[data-sec="sub-a"] .cg-diff')`, 10000, 'the diff closed');
      // the server: by record id only. A raw path as the section, a path outside the worktree, another project's id: all refused
      const ask = (q: string) => pc(fx.s, 'GET', `/api/live/project/changes/file?id=c1&${q}`);
      const [ok, good] = await ask('section=sub-a&path=pkg%2Fparser.ts');
      assertEquals(ok, 200);
      assertEquals((good as Json).git, true);
      assertEquals((await ask(`section=${encodeURIComponent(fx.trees['sub-a'])}&path=pkg%2Fparser.ts`))[0], 404, 'a raw path is not an id');
      assertEquals((await ask('section=..%2F..%2Fsub-a&path=pkg%2Fparser.ts'))[0], 404);
      assertEquals((await ask('section=sub-spare&path=ignored.txt'))[0], 404, 'a spare is not a section');
      assertEquals((await ask('section=sub-a&path=..%2F..%2Fsecret.txt'))[0], 400, 'a path outside the repository');
      assertEquals((await ask('section=sub-a&path=app.txt'))[1].code, 'not_changed', 'main\'s edit is not a change of the worktree');
    });
  },
});

Deno.test({
  name: 'project Changes: opening another chat of the project moves only the accent; the Changes tab does not change',
  ignore: !browserPath,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await withPanel(async (page) => {
      const accent = () => page.eval<string[]>(`[...document.querySelectorAll('#projectActivity .sp-grp.sp-focus')].map((g) => g.dataset.key)`);
      await page.waitFor(`document.querySelectorAll('#projectActivity .sp-grp').length === 2`, 20000, 'both working chats on Activity');
      assertEquals(await accent(), ['claude:sess-1']);
      const order = await page.eval<string[]>(`[...document.querySelectorAll('#projectActivity .sp-grp')].map((g) => g.dataset.key)`);
      const panel = () =>
        page.eval<string>(`JSON.stringify([Math.round(document.getElementById('subagentsPane').getBoundingClientRect().width),
          document.getElementById('projectChanges').innerHTML, document.querySelector('#paneTab-changes .pane-badge')?.textContent])`);
      await page.eval(`document.getElementById('paneTab-changes').click()`);
      await page.waitFor(`(${SECS}).length === 3`, 30000, 'three sections');
      await sleep(1500);
      const before = await panel();
      await openChat(page, 'claude:sess-2');
      await sleep(2500);
      assertEquals(await page.eval<string>(`document.querySelector('#paneTabs [aria-selected="true"]').dataset.tab`), 'changes', 'the tab stays');
      assertEquals(await panel(), before, 'Changes did not change at all: same sections, same rows, same width');
      await page.eval(`document.getElementById('paneTab-activity').click()`);
      await page.waitFor(`document.querySelector('#projectActivity .sp-grp.sp-focus')?.dataset.key === 'claude:sess-2'`, 15000, 'the accent moved');
      assertEquals(await page.eval<string[]>(`[...document.querySelectorAll('#projectActivity .sp-grp')].map((g) => g.dataset.key)`), order, 'no reorder');
    });
  },
});

Deno.test({
  name: 'project Changes: no reads while the tab is hidden; a read on showing it and every 10 s; a read when another chat\'s turn ends',
  ignore: !browserPath,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await withPanel(async (page, fx) => {
      // Activity is showing: the first read (the chips count the project) came with the chat; then nothing, for longer than a poll
      await page.waitFor(`(${`performance.getEntriesByType('resource').filter((e) => e.name.includes('/api/live/project/changes?')).length`}) >= 1`, 30000, 'the first read');
      await sleep(1500);
      const hidden = await reads(page);
      await sleep(12500);
      assertEquals(await reads(page), hidden, 'no read in 12 s while the Changes tab is hidden');
      // showing the tab reads at once, then every 10 s
      await page.eval(`document.getElementById('paneTab-changes').click()`);
      await page.waitFor(`(${`performance.getEntriesByType('resource').filter((e) => e.name.includes('/api/live/project/changes?')).length`}) > ${hidden}`, 15000, 'a read on showing');
      await sleep(1500);
      const shown = await reads(page);
      await page.waitFor(`(${`performance.getEntriesByType('resource').filter((e) => e.name.includes('/api/live/project/changes?')).length`}) > ${shown}`, 14000, 'the 10 s read');
      // back to Activity: it stops again
      await page.eval(`document.getElementById('paneTab-activity').click()`);
      await sleep(1500);
      const stopped = await reads(page);
      await sleep(11500);
      assertEquals(await reads(page), stopped, 'no read after leaving the tab');
      // another chat of the project ends its turn: the numbers are read at once, on whichever tab
      const other = fx.s.chats.find((c) => c.id === 'c2')!;
      other.busy = false;
      other.attention = attention('idle', null, new Date().toISOString());
      await page.waitFor(`(${`performance.getEntriesByType('resource').filter((e) => e.name.includes('/api/live/project/changes?')).length`}) > ${stopped}`, 20000, 'a read at the turn end');
    });
  },
});

Deno.test({
  name: 'project Changes, WSL project: main only, read through ONE changes.many helper call',
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const s = await remoteStudio();
    const dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-pc-wsl-' }));
    const host = new FakeWslHost(dir + SEP + 'linux-keeper', 'Ubuntu', {});
    setWslHostResolver((d) => (d === 'ubuntu' ? host : null));
    try {
      const REF = 'wsl://ubuntu/home/u/app';
      addChat(s, 1, 'Linux chat', REF, false);
      (s.chats[0] as unknown as Json).wsl = { distro: 'ubuntu', name: 'Ubuntu', linuxPath: '/home/u/app' };
      const files = [{ path: 'src/main.rs', status: 'M', added: 3, removed: 1, binary: false }, { path: 'new.txt', status: 'U', added: 2, removed: 0, binary: false }];
      host.handlers['changes.many'] = (p) => {
        const list = p.folders as Json[];
        return {
          results: list.map(() => ({ git: true, scope: 'uncommitted', root: '/home/u/app', prefix: '', files, filesTotal: 2, offset: 0, truncated: false, totals: { files: 2, added: 5, removed: 1 } })),
        };
      };
      host.handlers['chat.repoBranch'] = () => ({ repo: '/home/u/app', branch: 'main' });
      const [status, reply] = await pc(s, 'GET', '/api/live/project/changes?id=c1');
      assertEquals(status, 200, JSON.stringify(reply));
      const main = reply.main as Json;
      assertEquals([reply.git, (reply.sections as unknown[]).length, (reply.left as unknown[]).length], [true, 0, 0], 'main only');
      assertEquals([main.id, main.name, main.branch, (main.counts as Json).files], ['main', 'Project folder', 'main', 2]);
      assertEquals(((main.changes as Json).files as Json[]).map((f) => f.path), ['src/main.rs', 'new.txt']);
      const calls = host.calls.map((c) => c[0]);
      assertEquals(calls.filter((c) => c === 'changes.many').length, 1, `one batched call: ${calls}`);
      assertEquals(calls.filter((c) => c === 'changes.get').length, 0, 'never one call per folder');
      assertEquals((host.calls.find((c) => c[0] === 'changes.many')![1].folders as Json[]).map((f) => f.folder), ['/home/u/app']);
      // a worktree section cannot be asked for in a WSL project: no such record
      assertEquals((await pc(s, 'GET', '/api/live/project/changes/file?id=c1&section=sub-a&path=x'))[0], 404);
    } finally {
      setWslHostResolver(null);
      await host.stopKeeper().catch(() => {});
      await s.close();
      try {
        Deno.removeSync(dir, { recursive: true });
      } catch { /* a temp folder */ }
    }
  },
});
