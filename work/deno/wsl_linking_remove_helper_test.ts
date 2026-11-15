/**
 * Remove AIB from a distro, the helper side (helper/aib_remove.ts; docs/wsl/linking-design.md section 13 REMOVE RULES), with no distro:
 * an in-memory Linux file system (MemFs below: folders, files, links that resolve like the kernel's, a second file system for a mount
 * point) stands in for the disk, so every guard runs on any OS and nothing real is ever deleted.
 *   1. rootProblem: '', relative, '/', top-level, `..`, `.`, `//`, trailing `/`, wrong name, /mnt/<drive>, the home folder, a folder
 *      holding the home, a non-string, and the test guard (only /tmp/aib-wsl-test-*, never ~/.aib-server).
 *   2. rootFsProblem / dataProblem: a root that is a link, a root reached through a linked folder, a data folder that is a link or
 *      not data-<12 hex> directly in the root.
 *   3. removeInside: a link inside the root to a folder and to a file OUTSIDE it (the canaries survive, the link goes), a path
 *      through a linked folder (refused, its target untouched), a target outside the root, `..` in a target, the root itself, a
 *      mount point (left), a folder swapped for a link in the middle of the walk (stops, the outside survives).
 *   4. planRemoval / aibRemove: what goes and what stays with another data folder (keeper alive, and stopped), a program running
 *      from agents/, nothing else; refusals (dirty and uncheckable chat copies, a program in a chat copy, an install running, no
 *      process list, the test guard) delete nothing even in 'apply'; 'check' deletes nothing; 'apply' leaves keeper/ and helper/,
 *      prunes each project, never touches ~/.claude, ~/.codex or the project; a second 'apply' and a gone root are fine.
 *   5. aibUsage: parts in order, totals, data folders (mine, keeper alive), agents and their versions, chat copies and dirty ones, a
 *      walk cut short (partial).
 *   6. Processes: parseProcRows, isOurs (only `--data <data>` / the relay's socket), uses; the RPC methods' bad mode.
 * wsl_linking_remove_e2e_test.ts proves the same on a real distro's disk (a canary outside the root, a temp HOME's ~/.claude).
 */
import { assert, assertEquals } from './_assert.ts';
import {
  aibMethods,
  aibRemove,
  aibUsage,
  Budget,
  dataProblem,
  type FsInfo,
  isOurs,
  parseProcRows,
  type ProcRow,
  type RemoveDeps,
  type RemoveFs,
  removeInside,
  rootFsProblem,
  rootProblem,
  uses,
} from '../../outputs/agent-studio/server/wsl/helper/aib_remove.ts';
import { handleLine } from '../../outputs/agent-studio/server/wsl/helper/rpc.ts';

const T = { sanitizeOps: false, sanitizeResources: false };

// ---- an in-memory Linux file system ------------------------------------------------------------------------------------------

type Node = { kind: 'dir' } | { kind: 'file'; size: number } | { kind: 'link'; target: string };

class MemFs implements RemoveFs {
  readonly nodes = new Map<string, Node & { dev: number }>([['/', { kind: 'dir', dev: 1 }]]);
  readonly removedLog: string[] = [];
  /** Called after each readDir (the swap test changes the tree there). */
  afterReadDir: ((path: string) => void) | null = null;

  dir(path: string, dev = 1): this {
    this.#parents(path, dev);
    this.nodes.set(path, { kind: 'dir', dev });
    return this;
  }
  file(path: string, size = 100, dev = 1): this {
    this.#parents(path, dev);
    this.nodes.set(path, { kind: 'file', size, dev });
    return this;
  }
  link(path: string, target: string): this {
    this.#parents(path, 1);
    this.nodes.set(path, { kind: 'link', target, dev: 1 });
    return this;
  }
  #parents(path: string, dev: number): void {
    const parts = path.split('/').filter(Boolean);
    for (let i = 1; i < parts.length; i++) {
      const p = '/' + parts.slice(0, i).join('/');
      if (!this.nodes.has(p)) this.nodes.set(p, { kind: 'dir', dev });
    }
  }
  has(path: string): boolean {
    return this.nodes.has(path);
  }
  /** The canonical path of `path` (links followed; the last one only with `followLast`), or null when a part is missing. */
  resolve(path: string, followLast: boolean, depth = 0): string | null {
    if (depth > 40 || !path.startsWith('/')) return null;
    const parts = path.split('/').filter(Boolean);
    let at = '/';
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part === '.') continue;
      if (part === '..') {
        at = at === '/' ? '/' : at.slice(0, at.lastIndexOf('/')) || '/';
        continue;
      }
      const next = at === '/' ? `/${part}` : `${at}/${part}`;
      const node = this.nodes.get(next);
      if (!node) return null;
      const last = i === parts.length - 1;
      if (node.kind === 'link' && (!last || followLast)) {
        const target = node.target.startsWith('/') ? node.target : `${at}/${node.target}`;
        const resolved = this.resolve(target, true, depth + 1);
        if (resolved === null) return null;
        at = resolved;
      } else at = next;
    }
    return at;
  }
  lstat(path: string): Promise<FsInfo | null> {
    const at = this.resolve(path, false);
    const node = at ? this.nodes.get(at) : undefined;
    if (!node) return Promise.resolve(null);
    return Promise.resolve({
      isFile: node.kind === 'file',
      isDirectory: node.kind === 'dir',
      isSymlink: node.kind === 'link',
      size: node.kind === 'file' ? node.size : 10,
      blocks: null,
      dev: node.dev,
    });
  }
  realPath(path: string): Promise<string | null> {
    return Promise.resolve(this.resolve(path, true));
  }
  readDir(path: string): Promise<string[]> {
    const at = this.resolve(path, true);
    if (!at || this.nodes.get(at)?.kind !== 'dir') return Promise.reject(new Error(`not a folder: ${path}`));
    const names = [...this.nodes.keys()].filter((k) => k !== at && (k.slice(0, k.lastIndexOf('/')) || '/') === at).map((k) => k.slice(k.lastIndexOf('/') + 1));
    this.afterReadDir?.(path);
    return Promise.resolve(names);
  }
  remove(path: string): Promise<void> {
    const parent = this.resolve(path.slice(0, path.lastIndexOf('/')) || '/', true);
    if (!parent) return Promise.resolve();
    const at = (parent === '/' ? '' : parent) + '/' + path.slice(path.lastIndexOf('/') + 1);
    const node = this.nodes.get(at);
    if (!node) return Promise.resolve();
    if (node.kind === 'dir' && [...this.nodes.keys()].some((k) => k.startsWith(at + '/'))) return Promise.reject(new Error(`not empty: ${path}`));
    this.nodes.delete(at);
    this.removedLog.push(at);
    return Promise.resolve();
  }
  snapshot(): string[] {
    return [...this.nodes.keys()].sort();
  }
}

// ---- the fixture: a distro with AIB in it ---------------------------------------------------------------------------------------

const HOME = '/home/u';
const ROOT = '/tmp/aib-wsl-test-unit';
const DATA = `${ROOT}/data-0123456789ab`;
const OTHER = `${ROOT}/data-ba9876543210`;
const VER = '0.1.0-beta.10-0123abcd';
const OLD = '0.1.0-beta.9-89abcdef';
const PROJECT = `${HOME}/app`;
const COPY = `${DATA}/worktrees/aaaa1111/chat-abcd1234`;
const OUTSIDE = '/srv/canary';

function distro(o: { other?: boolean } = {}): MemFs {
  const fs = new MemFs()
    .file(`${HOME}/.claude/settings.json`).file(`${HOME}/.codex/auth.json`).file(`${PROJECT}/a.txt`)
    .file(`${OUTSIDE}/keep.txt`).file('/srv/lonely.txt')
    .file(`${ROOT}/${VER}/AIB-keeper`, 5000).file(`${ROOT}/${VER}/AIB-wsl-helper`, 6000)
    .file(`${ROOT}/${OLD}/AIB-keeper`, 5000)
    .file(`${ROOT}/agents/claude/0.102.0/node_modules/x.js`, 700).file(`${ROOT}/agents/claude/install.json`, 10)
    .file(`${ROOT}/agents/.npm-cache/blob`, 300)
    .file(`${DATA}/studio-worktrees.json`, 20).file(`${DATA}/keeper/keeper.log`, 40).file(`${DATA}/keeper/channels.json`, 40)
    .file(`${DATA}/helper/mcp.sock`, 0).file(`${DATA}/wsl-sync-chats.json`, 5)
    .file(`${COPY}/a.txt`, 200)
    // escape attempts: links inside the root pointing outside it
    .link(`${COPY}/to-canary`, OUTSIDE).link(`${DATA}/home-link`, `${HOME}/.claude`).link(`${ROOT}/agents/claude/escape`, '/srv/lonely.txt');
  if (o.other) fs.file(`${OTHER}/keeper/keeper.log`, 30);
  return fs;
}

function deps(fs: MemFs, o: Partial<RemoveDeps> & { alive?: string[]; rows?: ProcRow[] | null; isDirty?: boolean | null } = {}): RemoveDeps & { pruned: string[] } {
  const pruned: string[] = [];
  return {
    fs,
    root: ROOT,
    data: DATA,
    version: VER,
    home: HOME,
    test: false,
    self: 4242,
    procs: () => Promise.resolve(o.rows === undefined ? [{ pid: 4242, exe: `${ROOT}/${VER}/AIB-wsl-helper`, cwd: HOME, args: ['AIB-wsl-helper', '--data', DATA] }] : o.rows),
    keeperAlive: (dir) => Promise.resolve((o.alive ?? []).includes(dir)),
    dirty: () => Promise.resolve(o.isDirty === undefined ? false : o.isDirty),
    prune: (project) => {
      pruned.push(project);
      return Promise.resolve(true);
    },
    worktrees: () => [{ path: COPY, project: PROJECT, branch: 'studio/chat-abcd1234', session: 'claude:s1' }],
    lockPid: () => undefined,
    budget: () => new Budget(60_000),
    pruned,
    ...o,
  };
}

const outsideIntact = (fs: MemFs) => {
  for (const p of [`${HOME}/.claude/settings.json`, `${HOME}/.codex/auth.json`, `${PROJECT}/a.txt`, `${OUTSIDE}/keep.txt`, '/srv/lonely.txt']) {
    assert(fs.has(p), `${p} must survive`);
  }
};

// ---- 1. rootProblem ---------------------------------------------------------------------------------------------------------

Deno.test('remove guard: rootProblem refuses every unsafe root, and the test guard only allows /tmp/aib-wsl-test-*', () => {
  const bad: [unknown, string, boolean][] = [
    ['', HOME, false],
    ['tmp/aib-wsl-test-x', HOME, false],
    ['/', HOME, false],
    ['/.aib-server', HOME, false],
    ['/tmp', HOME, false],
    [`${HOME}/../u/.aib-server`, HOME, false],
    [`${HOME}/./.aib-server`, HOME, false],
    [`/home//u/.aib-server`, HOME, false],
    [`${HOME}/.aib-server/`, HOME, false],
    [`${HOME}/.aib-server/..`, HOME, false],
    [`${HOME}/projects`, HOME, false],
    [HOME, HOME, false],
    ['/home/.aib-server', '/home/.aib-server/u', false],
    ['/mnt/c/Users/u/.aib-server', HOME, false],
    ['/tmp/aib-wsl-test-x\0y', HOME, false],
    [null, HOME, false],
    [42, HOME, false],
    [`${HOME}/.aib-server`, HOME, true], // the test guard: never the real root
    ['/var/tmp/aib-wsl-test-x', HOME, true],
    ['/tmp/x/aib-wsl-test-y', HOME, true],
  ];
  for (const [root, home, test] of bad) assert(rootProblem(root, home, test) !== '', `must refuse ${JSON.stringify(root)} (test ${test})`);
  assertEquals(rootProblem(`${HOME}/.aib-server`, HOME, false), '');
  assertEquals(rootProblem('/tmp/aib-wsl-test-0123abcd', HOME, true), '');
  assertEquals(rootProblem('/tmp/aib-wsl-test-0123abcd', HOME, false), '');
  assert(/test guard/.test(rootProblem(`${HOME}/.aib-server`, HOME, true)));
});

// ---- 2. the file checks of the root and data folder ---------------------------------------------------------------------------

Deno.test('remove guard: a root that is a link or is reached through a link, and a bad data folder, are refused', async () => {
  const fs = distro();
  assertEquals(await rootFsProblem(fs, ROOT), '');
  assertEquals(await rootFsProblem(fs, '/tmp/aib-wsl-test-none'), 'gone');
  fs.link('/tmp/aib-wsl-test-link', ROOT);
  assertEquals(await rootFsProblem(fs, '/tmp/aib-wsl-test-link'), 'it is a link');
  fs.link('/tmp/via', '/tmp').dir('/tmp/aib-wsl-test-unit2');
  assertEquals(await rootFsProblem(fs, '/tmp/via/aib-wsl-test-unit2'), 'its path goes through a link');
  fs.file('/tmp/aib-wsl-test-file');
  assertEquals(await rootFsProblem(fs, '/tmp/aib-wsl-test-file'), 'it is not a folder');
  assertEquals(await dataProblem(fs, ROOT, DATA), '');
  assertEquals(await dataProblem(fs, ROOT, `${ROOT}/data-0123`), 'it is not a data-<id> folder directly in the AIB folder');
  assertEquals(await dataProblem(fs, ROOT, `${ROOT}/x/data-0123456789ab`), 'it is not a data-<id> folder directly in the AIB folder');
  assertEquals(await dataProblem(fs, ROOT, '/tmp/data-0123456789ab'), 'it is not a data-<id> folder directly in the AIB folder');
  assertEquals(await dataProblem(fs, ROOT, ''), 'it is not a data-<id> folder directly in the AIB folder');
  fs.link(`${ROOT}/data-aaaaaaaaaaaa`, OUTSIDE);
  assertEquals(await dataProblem(fs, ROOT, `${ROOT}/data-aaaaaaaaaaaa`), 'it is not a plain folder');

  // the plan refuses them (nothing is deleted, even in apply)
  for (const d of [{ root: '/tmp/aib-wsl-test-link' }, { root: '/tmp/via/aib-wsl-test-unit2', data: '/tmp/via/aib-wsl-test-unit2/data-0123456789ab' }, { data: `${ROOT}/data-aaaaaaaaaaaa` }]) {
    const before = fs.snapshot();
    const out = await aibRemove(deps(fs, d), 'apply');
    assertEquals(out.ok, false);
    assert(out.blocked.length === 1 && /AIB will not delete/.test(out.blocked[0]), JSON.stringify(out.blocked));
    assertEquals(fs.snapshot(), before);
  }
});

// ---- 3. removeInside ----------------------------------------------------------------------------------------------------------

Deno.test('remove guard: links inside the root are unlinked, their targets outside survive', async () => {
  const fs = distro();
  const left: string[] = [];
  assertEquals(await removeInside(fs, ROOT, `${DATA}/worktrees`, left), true);
  assertEquals(left, []);
  assert(!fs.has(`${COPY}/to-canary`) && !fs.has(COPY));
  assertEquals(await removeInside(fs, ROOT, `${DATA}/home-link`, left), true);
  assertEquals(await removeInside(fs, ROOT, `${ROOT}/agents`, left), true);
  outsideIntact(fs);
  assert(fs.removedLog.every((p) => p.startsWith(ROOT + '/')), `only names inside the root went: ${fs.removedLog.filter((p) => !p.startsWith(ROOT + '/'))}`);
});

Deno.test('remove guard: paths outside the root, through a link, with .., or the root itself are refused', async () => {
  const fs = distro();
  fs.link(`${ROOT}/via-link`, '/srv');
  const before = fs.snapshot();
  for (const target of [OUTSIDE, `${ROOT}/../srv/canary`, `${ROOT}/./agents`, ROOT, `${ROOT}/via-link/canary`, `${ROOT}/via-link/canary/keep.txt`, '', 'agents', `${ROOT}//agents`, '/']) {
    const left: string[] = [];
    assertEquals(await removeInside(fs, ROOT, target, left), false, target);
    assertEquals(left.length, 1, target);
  }
  for (const root of ['/', '', '/tmp/aib-wsl-test-unit/', 'relative']) {
    assertEquals(await removeInside(fs, root, `${ROOT}/agents`, []), false, root);
  }
  assertEquals(fs.snapshot(), before);
});

Deno.test('remove guard: another file system mounted inside is left; a folder swapped for a link mid-walk stops the walk', async () => {
  const fs = distro();
  fs.dir(`${DATA}/worktrees/mnt`, 2).file(`${DATA}/worktrees/mnt/usb.txt`, 10, 2);
  const left: string[] = [];
  assertEquals(await removeInside(fs, ROOT, `${DATA}/worktrees`, left), false);
  assert(fs.has(`${DATA}/worktrees/mnt/usb.txt`) && left.some((l) => /another file system/.test(l)), left.join('\n'));

  const swap = distro();
  swap.file(`${ROOT}/agents/claude/0.102.0/node_modules/y.js`, 1);
  let swapped = false;
  swap.afterReadDir = (path) => {
    if (path === `${ROOT}/agents/claude/0.102.0/node_modules` && !swapped) { // replaced by a link to the canary folder
      swapped = true;
      for (const k of [...swap.nodes.keys()]) if (k.startsWith(path + '/')) swap.nodes.delete(k);
      swap.nodes.delete(path);
      swap.link(path, OUTSIDE);
      swap.file(`${OUTSIDE}/x.js`).file(`${OUTSIDE}/y.js`);
    }
  };
  const left2: string[] = [];
  assertEquals(await removeInside(swap, ROOT, `${ROOT}/agents`, left2), false);
  assert(swapped && swap.has(`${OUTSIDE}/x.js`) && swap.has(`${OUTSIDE}/y.js`) && swap.has(`${OUTSIDE}/keep.txt`), left2.join('\n'));
});

// ---- 4. the plan and the removal -----------------------------------------------------------------------------------------------

Deno.test('remove: another AIB data folder (keeper alive or not) keeps every shared part and the root', async () => {
  for (const alive of [true, false]) {
    const fs = distro({ other: true });
    const d = deps(fs, { alive: alive ? [OTHER] : [] });
    const check = await aibRemove(d, 'check');
    assertEquals(check.ok, true);
    assertEquals(check.wouldRemove.map((w) => w.path), [`${DATA}/worktrees`, DATA]);
    const kept = Object.fromEntries(check.kept.map((k) => [k.path, k.why]));
    for (const p of [OTHER, `${ROOT}/agents`, `${ROOT}/${VER}`, `${ROOT}/${OLD}`, ROOT, `${HOME}/.claude`, `${HOME}/.codex`, PROJECT]) assert(kept[p], `kept ${p}`);
    assert(alive ? /keeper is running/.test(kept[`${ROOT}/agents`]) : /another AIB data folder/.test(kept[`${ROOT}/agents`]), kept[`${ROOT}/agents`]);
    const out = await aibRemove(d, 'apply');
    assertEquals(out.ok, true, JSON.stringify(out));
    assertEquals(out.final?.version, null);
    assertEquals(out.final?.root, false);
    assertEquals(out.final?.data, 'data-0123456789ab');
    assertEquals(out.final?.copies, [{ path: COPY, project: PROJECT, branch: 'studio/chat-abcd1234', session: 'claude:s1' }]);
    // this AIB's data folder but keeper/ and helper/ (the running keeper and helper use them) is gone; the shared parts stay
    assert(!fs.has(`${DATA}/worktrees`) && !fs.has(`${DATA}/studio-worktrees.json`) && !fs.has(`${DATA}/home-link`));
    assert(fs.has(`${DATA}/keeper/keeper.log`) && fs.has(`${DATA}/helper/mcp.sock`));
    assert(fs.has(`${OTHER}/keeper/keeper.log`) && fs.has(`${ROOT}/agents/claude/0.102.0/node_modules/x.js`) && fs.has(`${ROOT}/${OLD}/AIB-keeper`));
    assertEquals(d.pruned, [PROJECT]);
    outsideIntact(fs);
  }
});

Deno.test('remove: a program running from agents/ keeps agents/ only; with nothing else, every shared part goes', async () => {
  const fs = distro();
  const agent: ProcRow = { pid: 77, exe: `${ROOT}/agents/claude/0.102.0/node`, cwd: '/home/u/other', args: ['node', 'x.js'] };
  const d = deps(fs, { rows: [agent] });
  const out = await aibRemove(d, 'apply');
  assertEquals(out.ok, true, JSON.stringify(out));
  assert(out.kept.some((k) => k.path === `${ROOT}/agents` && /process 77/.test(k.why)));
  assert(fs.has(`${ROOT}/agents/claude/0.102.0/node_modules/x.js`) && !fs.has(`${ROOT}/${OLD}`));
  assert(fs.has(`${ROOT}/${VER}/AIB-keeper`), 'the current <ver> is the last step\'s');
  assertEquals(out.final?.version, VER);
  assertEquals(out.final?.root, false);

  const fs2 = distro();
  const d2 = deps(fs2);
  const check = await aibRemove(d2, 'check');
  assertEquals(check.wouldRemove.map((w) => w.path), [`${DATA}/worktrees`, DATA, `${ROOT}/${VER}`, `${ROOT}/${OLD}`, `${ROOT}/agents`, ROOT]);
  assert(check.wouldRemove.every((w) => typeof w.bytes === 'number' && w.what));
  const all = await aibRemove(d2, 'apply');
  assertEquals(all.ok, true);
  assertEquals(all.final, { data: 'data-0123456789ab', version: VER, root: true, copies: [{ path: COPY, project: PROJECT, branch: 'studio/chat-abcd1234', session: 'claude:s1' }] });
  assert(!fs2.has(`${ROOT}/agents`) && !fs2.has(`${ROOT}/${OLD}`));
  assertEquals([...fs2.nodes.keys()].filter((k) => k.startsWith(ROOT + '/')).sort(), [
    `${DATA}`,
    `${DATA}/helper`,
    `${DATA}/helper/mcp.sock`,
    `${DATA}/keeper`,
    `${DATA}/keeper/channels.json`,
    `${DATA}/keeper/keeper.log`,
    `${ROOT}/${VER}`,
    `${ROOT}/${VER}/AIB-keeper`,
    `${ROOT}/${VER}/AIB-wsl-helper`,
  ].sort());
  outsideIntact(fs2);
  // a second apply finds only what the last step removes; a root that is gone is fine
  const again = await aibRemove(d2, 'apply');
  assertEquals(again.ok, true);
  assertEquals(again.removed, []);
  const gone = await aibRemove(deps(new MemFs()), 'apply');
  assertEquals(gone.ok, true);
  assert(/nothing to remove/.test(gone.message ?? ''));
});

Deno.test('remove: an item AIB did not make keeps the root (and is kept)', async () => {
  const fs = distro().file(`${ROOT}/notes.txt`).link(`${ROOT}/mine`, '/srv');
  const out = await aibRemove(deps(fs), 'apply');
  assertEquals(out.ok, true);
  assertEquals(out.final?.root, false);
  assert(fs.has(`${ROOT}/notes.txt`) && fs.has(`${ROOT}/mine`));
  assert(out.kept.some((k) => k.path === `${ROOT}/mine` && /link/.test(k.why)));
});

Deno.test('remove: every refusal deletes nothing, in check and in apply', async () => {
  const cases: [string, Partial<RemoveDeps> & { rows?: ProcRow[] | null; isDirty?: boolean | null }, RegExp][] = [
    ['dirty chat copy', { isDirty: true }, /has changes that are not committed/],
    ['uncheckable chat copy', { isDirty: null }, /could not check the chat copy/],
    ['no process list', { rows: null }, /could not list the programs/],
    ['a shell in a chat copy', { rows: [{ pid: 9, exe: '/usr/bin/bash', cwd: COPY, args: ['bash'] }] }, /works in this AIB's data folder \(process 9 bash\)/],
    ['an install running', { rows: [{ pid: 31, exe: '/usr/bin/node', cwd: HOME, args: ['node'] }], lockPid: (p: string) => (p.includes('/claude/') ? 31 : undefined) }, /Claude Code is being installed/],
    ['the test guard', { test: true, root: `${HOME}/.aib-server`, data: `${HOME}/.aib-server/data-0123456789ab` }, /test guard/],
  ];
  for (const [label, o, line] of cases) {
    const fs = distro();
    if (label === 'the test guard') fs.file(`${HOME}/.aib-server/data-0123456789ab/x`);
    const before = fs.snapshot();
    for (const mode of ['check', 'apply'] as const) {
      const out = await aibRemove(deps(fs, o), mode);
      assertEquals(out.ok, false, label);
      assert(out.blocked.some((b) => line.test(b)), `${label}: ${out.blocked.join(' | ')}`);
      assertEquals(out.removed, []);
      assertEquals(fs.snapshot(), before, label);
    }
  }
  // this AIB's own processes (keeper, bridges, relay) never count
  const fs = distro();
  const ours: ProcRow[] = [
    { pid: 1, exe: `${ROOT}/${VER}/AIB-keeper`, cwd: HOME, args: [`${ROOT}/${VER}/AIB-keeper`, 'serve', '--data', DATA, '--unix-only'] },
    { pid: 2, exe: `${ROOT}/${VER}/AIB-keeper`, cwd: HOME, args: [`${ROOT}/${VER}/AIB-keeper`, 'bridge', '--data', DATA, '--hold'] },
    { pid: 3, exe: `${ROOT}/${VER}/AIB-keeper`, cwd: HOME, args: [`${ROOT}/${VER}/AIB-keeper`, 'mcp-relay', '--socket', `${DATA}/helper/mcp.sock`] },
  ];
  const out = await aibRemove(deps(fs, { rows: ours }), 'check');
  assertEquals(out.blocked, []);
  assert(out.wouldRemove.some((w) => w.path === `${ROOT}/${VER}`));
});

Deno.test('remove: check deletes nothing and lists this AIB first, then what is shared, with what stays', async () => {
  const fs = distro();
  const before = fs.snapshot();
  const out = await aibRemove(deps(fs), 'check');
  assertEquals(fs.snapshot(), before);
  assertEquals(out.mode, 'check');
  assertEquals(out.removed, []);
  assertEquals(out.left, []);
  assertEquals(out.final, undefined);
  assertEquals(out.wouldRemove[0].path, `${DATA}/worktrees`);
  assert(/1 worktree/.test(out.wouldRemove[0].what) && out.wouldRemove[0].bytes > 0);
  assert(out.kept.some((k) => k.path === `${HOME}/.claude`) && out.kept.some((k) => k.path === `${HOME}/.codex`) && out.kept.some((k) => k.path === PROJECT));
});

// ---- 5. usage ------------------------------------------------------------------------------------------------------------------

Deno.test('usage: parts, data folders, agents, chat copies; a cut walk is partial', async () => {
  const fs = distro({ other: true });
  const u = await aibUsage(deps(fs, { alive: [OTHER, DATA], isDirty: true }));
  assertEquals(u.root, ROOT);
  assertEquals(u.current, VER);
  assertEquals(u.parts.map((p) => p.key), ['versions', 'agents', 'npmCache', 'data', 'worktrees', 'logs', 'other']);
  assertEquals(u.totalBytes, u.parts.reduce((a, p) => a + p.bytes, 0));
  const part = Object.fromEntries(u.parts.map((p) => [p.key, p]));
  assert(part.versions.bytes >= 16000 && part.npmCache.bytes >= 300 && part.agents.bytes >= 700 && part.worktrees.bytes >= 200 && part.logs.bytes >= 80);
  assert(part.other.bytes >= 30, 'the other data folder');
  assertEquals(part.npmCache.path, `${ROOT}/agents/.npm-cache`);
  assertEquals(u.versions.sort(), [OLD, VER].sort());
  assertEquals(u.agents.map((a) => [a.id, a.versions]), [['claude', ['0.102.0']]]);
  assertEquals(u.dataFolders.map((f) => [f.name, f.mine, f.keeperAlive]), [['data-0123456789ab', true, true], ['data-ba9876543210', false, true]]);
  assertEquals(u.worktrees, { count: 1, dirty: 1 });
  assertEquals(u.chatsWorking, 0);
  assertEquals(u.partial, undefined);
  const cut = await aibUsage(deps(distro(), { budget: () => new Budget(60_000, 5) }));
  assertEquals(cut.partial, true);
  const none = await aibUsage(deps(new MemFs()));
  assertEquals([none.totalBytes, none.parts.length], [0, 0]);
});

// ---- 6. processes and the RPC methods --------------------------------------------------------------------------------------

Deno.test('remove: process rows, isOurs and uses', async () => {
  const rows = parseProcRows(`1\t/usr/bin/sh\t/\tsh\x01-c\x01x\n12\t${ROOT}/${VER}/AIB-keeper\t${HOME}\t${ROOT}/${VER}/AIB-keeper\x01serve\x01--data\x01${DATA}\nnot a row\n`);
  assertEquals(rows.length, 2);
  assertEquals(rows[1].args, [`${ROOT}/${VER}/AIB-keeper`, 'serve', '--data', DATA]);
  assert(isOurs(rows[1], DATA, 0) && !isOurs(rows[0], DATA, 0) && isOurs(rows[0], DATA, 1));
  assert(!isOurs({ pid: 5, exe: '/x', cwd: '/', args: ['claude', '--cwd', `${DATA}/worktrees/x`] }, DATA, 0), 'naming a chat copy is not ours');
  assert(!isOurs({ pid: 5, exe: '/x', cwd: '/', args: ['x', '--data', OTHER] }, DATA, 0), "another AIB's keeper is not ours");
  assert(uses(rows[1], `${ROOT}/${VER}`) && !uses(rows[0], `${ROOT}/${VER}`));
  assert(uses({ pid: 6, exe: '/usr/bin/bash', cwd: `${ROOT}/agents/claude`, args: [] }, `${ROOT}/agents`));
  assert(!uses({ pid: 6, exe: `${ROOT}/agents-old/x`, cwd: '/', args: [] }, `${ROOT}/agents`));

  const handlers = aibMethods({ root: ROOT, data: DATA, env: () => Promise.resolve({ home: HOME, env: {} }), deps: deps(distro()) });
  const reply = await handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'aib.remove', params: { mode: 'all' } }), handlers) as { error?: { code: number } };
  assertEquals(reply.error?.code, -32602);
  const ok = await handleLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'aib.remove', params: { mode: 'check' } }), handlers) as { result?: { ok: boolean } };
  assertEquals(ok.result?.ok, true);
  const usage = await handleLine(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'aib.usage', params: {} }), handlers) as { result?: { root: string } };
  assertEquals(usage.result?.root, ROOT);
});

Deno.test("remove: the test guard and the <ver> come from the helper's start environment, not the login one it swaps in", async () => {
  // helper_main.ts replaces the process environment with the login shell's: AIB_WSL_TEST must still hold (a real-WSL e2e found it lost)
  const real = `${HOME}/.aib-server`;
  const fs = distro().file(`${real}/data-0123456789ab/x`).file(`${real}/${VER}/AIB-keeper`);
  const { test: _test, version: _version, ...rest } = deps(fs, { root: real, data: `${real}/data-0123456789ab` });
  const before = fs.snapshot();
  const env = () => Promise.resolve({ home: HOME, env: {} });
  const handlers = aibMethods({ root: real, data: `${real}/data-0123456789ab`, env, start: { test: true, version: VER }, deps: rest });
  const reply = await handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'aib.remove', params: { mode: 'apply' } }), handlers) as {
    result: { ok: boolean; blocked: string[] };
  };
  assertEquals(reply.result.ok, false);
  assert(/test guard/.test(reply.result.blocked[0]), reply.result.blocked[0]);
  assertEquals(fs.snapshot(), before);
  const usage = await handleLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'aib.usage', params: {} }), handlers) as { result: { current: string } };
  assertEquals(usage.result.current, VER);
});

Deno.test('remove: the helper offers aib.* only with both its root and its data folder', T, async () => {
  const { makeMethods } = await import('../../outputs/agent-studio/server/wsl/helper/methods.ts');
  const env = () => Promise.resolve({ env: {}, shell: '/bin/sh', home: HOME, arch: 'amd64' });
  assert('aib.remove' in makeMethods({ env, root: ROOT, data: DATA }) && 'aib.usage' in makeMethods({ env, root: ROOT, data: DATA }));
  assert(!('aib.remove' in makeMethods({ env, root: ROOT })) && !('aib.remove' in makeMethods({ env, data: DATA })));
});
