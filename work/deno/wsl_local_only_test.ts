/**
 * Local-only folders of WSL projects without a distro (wsl/helper/local_only.ts, wsl/local_only.ts, files_routes.ts, host/studio.ts):
 *   - the helper's localOnly.* methods over the real modules, run natively here on a temp repo whose own exclude names `/aib-shared/`
 *     (the owner's shape): ensure adds AIB's block, chat answers the main folder's paths and makes aib-shared/, list / search / read
 *     from a chat copy (a git worktree under <data>/worktrees) show the main folder's aib-shared/, exclude writes the repo's
 *     .git/info/exclude and its Undo takes it back, refusals (the project, .git, '..', a tracked file), a root outside AIB's copies is
 *     refused, and the daily backup zips into <data>/local-only-backups;
 *   - Studio with a FakeWslHost: a WSL chat in its own copy is granted the main folder's local-only folders (Linux paths, ACP
 *     additionalDirectories) and told where they are; a test AIB never sets the default up in a project outside /tmp; an older helper
 *     (no localOnly.*) leaves the chat as before;
 *   - files_routes.ts for a WSL chat: the list's localOnly part and the exclude POST go to the helper with the project's Linux main
 *     folder (no more 409 'not available for WSL projects yet'); an older helper gets the phase 1 answer.
 * Never a real distro, never the owner's homes.
 */
import { assert, assertEquals } from './_assert.ts';
import { fake, pause, until } from './_connection.ts';
import { FakeWslHost } from './_wsl_fake.ts';
import { commit, runGit, Sandbox, write } from './_worktree_fixtures.ts';
import { HAVE_GIT } from './_git_repo.ts';
import { localOnlyMethods } from '../../outputs/agent-studio/server/wsl/helper/local_only.ts';
import { RpcError } from '../../outputs/agent-studio/server/wsl/helper/rpc.ts';
import { BLOCK_START } from '../../outputs/agent-studio/server/worktrees/local_only.ts';
import { wslBackupRound, wslDefaultsAllowed } from '../../outputs/agent-studio/server/wsl/local_only.ts';
import { Connection, SHARED_FOLDER_PROMPT } from '../../outputs/agent-studio/server/acp/connection.ts';
import { Studio } from '../../outputs/agent-studio/server/host/studio.ts';
import { KeeperLink } from '../../outputs/agent-studio/server/keeper/link.ts';
import { keeperBinary, KeeperClient, readKeeperInfo } from '../../outputs/agent-studio/server/keeper/client.ts';
import { pidAlive } from '../../outputs/agent-studio/server/host/host_client.ts';
import { setWslHostResolver } from '../../outputs/agent-studio/server/wsl/access.ts';
import { filesRoutes } from '../../outputs/agent-studio/server/web/files_routes.ts';
import type { WebContext } from '../../outputs/agent-studio/server/web/server.ts';

type Json = Record<string, unknown>;
const T = { sanitizeResources: false, sanitizeOps: false };
const SEP = Deno.build.os === 'windows' ? '\\' : '/';
const join = (...parts: string[]) => parts.join(SEP);

Deno.env.set('AIB_WSL_ROOT', '/tmp/aib-wsl-test-fake');

// ---- the helper's methods ------------------------------------------------------------------------------------------------
class Lab {
  readonly box = new Sandbox();
  readonly data = join(this.box.base, 'data');
  readonly copy = join(this.data, 'worktrees', 'h1', 'chat-abcd1234');
  readonly m = localOnlyMethods(this.data);

  constructor() {
    const p = this.box.project;
    commit(p, 'src/a.txt', 'tracked\n');
    // the owner's own exclude line, outside AIB's block
    write(p, '.git/info/exclude', '# git ls-files --others --exclude-from=.git/info/exclude\n\n# Owner-only files\n/aib-shared/\n');
    write(p, 'aib-shared/review/x.png', 'PNG-BYTES');
    Deno.mkdirSync(join(this.data, 'worktrees', 'h1'), { recursive: true });
    runGit(p, 'worktree', 'add', '-q', '-b', 'studio/chat-abcd1234', this.copy);
  }

  call(method: string, params: Json): Promise<Json> {
    return Promise.resolve(this.m[method](params)) as Promise<Json>;
  }

  exclude(): string {
    return Deno.readTextFileSync(join(this.box.project, '.git', 'info', 'exclude'));
  }

  [Symbol.dispose](): void {
    this.box[Symbol.dispose]();
  }
}

Deno.test({ name: 'wsl helper localOnly: ensure keeps the user line and adds the block; chat answers the main folder paths', ignore: !HAVE_GIT, ...T, async fn() {
  using lab = new Lab();
  const p = lab.box.project;
  const before = lab.exclude();
  assertEquals((await lab.call('localOnly.chat', { project: p, worktree: true })).localOnly, null, 'nothing before the default is set up');
  assertEquals(await lab.call('localOnly.ensure', { project: p }), { state: 'on' });
  const after = lab.exclude();
  assert(after.startsWith(before), 'every line of the user is kept byte for byte');
  assert(after.includes(BLOCK_START) && after.includes('\n/aib-shared\n'), after);
  assertEquals(await lab.call('localOnly.ensure', { project: p }), { state: 'on' });
  assertEquals(lab.exclude(), after, 'idempotent');
  const priv = join(p, 'aib-shared');
  const chat = (await lab.call('localOnly.chat', { project: p, worktree: true })).localOnly;
  assertEquals(chat, { entries: [priv], dirs: [priv], shared: priv });
  assert(!Deno.statSync(join(lab.copy, 'src', 'a.txt')).isDirectory);
  let inCopy = true;
  try {
    Deno.statSync(join(lab.copy, 'aib-shared'));
  } catch {
    inCopy = false;
  }
  assert(!inCopy, "the chat's copy holds no aib-shared/: git never copies it");
  // a project that is not git: nothing
  const plain = join(lab.box.base, 'plain');
  Deno.mkdirSync(plain);
  assertEquals(await lab.call('localOnly.ensure', { project: plain }), { state: 'no-git' });
  assertEquals((await lab.call('localOnly.chat', { project: plain, worktree: true })).localOnly, null);
} });

Deno.test({ name: 'wsl helper localOnly: list, search and read from a chat copy show the main folder aib-shared/', ignore: !HAVE_GIT, ...T, async fn() {
  using lab = new Lab();
  const p = lab.box.project;
  await lab.call('localOnly.ensure', { project: p });
  const top = await lab.call('localOnly.list', { root: lab.copy, main: p });
  const lo = top.localOnly as Json;
  assertEquals([lo.main, lo.entries, lo.defaultState], [p, ['aib-shared'], 'on']);
  const row = (top.entries as Json[]).find((e) => e.name === 'aib-shared')!;
  assert(row && row.local === true, JSON.stringify(top.entries));
  assertEquals(row.noExclude, 'already');
  const srcRow = (top.entries as Json[]).find((e) => e.name === 'src')!;
  assertEquals(srcRow.noExclude, 'tracked');
  const inside = await lab.call('localOnly.list', { root: lab.copy, main: p, dir: 'aib-shared/review' });
  assertEquals((inside.entries as Json[]).map((e) => [e.name, e.from]), [['x.png', 'main']]);
  const found = await lab.call('localOnly.search', { root: lab.copy, main: p, query: 'x.png' });
  assertEquals((found.matches as Json[]).map((m) => m.path), ['aib-shared/review/x.png']);
  const read = await lab.call('localOnly.read', { root: lab.copy, main: p, rel: 'aib-shared/review/x.png' });
  assertEquals([atob(String(read.bytesB64)), read.local, read.from, read.readRoot], ['PNG-BYTES', true, 'main', p]);
  const plain = await lab.call('localOnly.read', { root: lab.copy, main: p, rel: 'src/a.txt' });
  assertEquals([atob(String(plain.bytesB64)), plain.local, plain.readRoot], ['tracked\n', undefined, lab.copy]);
  // the main folder itself
  const own = await lab.call('localOnly.list', { root: p, main: p });
  assert((own.entries as Json[]).some((e) => e.name === 'aib-shared' && e.local === true));
  // a root that is neither the main folder nor one of AIB's chat copies
  for (const root of [lab.box.base, lab.data, join(lab.data, 'worktrees')]) {
    const refused = await lab.call('localOnly.list', { root, main: p }).catch((e) => e);
    assert(refused instanceof RpcError && refused.data?.code === 'bad_root', `${root}: ${refused}`);
  }
} });

Deno.test({ name: 'wsl helper localOnly: exclude writes the repo exclude file, Undo takes it back, refusals, backup', ignore: !HAVE_GIT, ...T, async fn() {
  using lab = new Lab();
  const p = lab.box.project;
  await lab.call('localOnly.ensure', { project: p });
  write(p, 'game/review/shot.png', 'S');
  const added = await lab.call('localOnly.exclude', { root: p, main: p, action: 'add', path: 'game/review' });
  assertEquals(added.status, 200);
  const body = added.body as Json;
  assertEquals(body.path, 'game/review');
  assert(lab.exclude().includes('\n/game/review\n'), lab.exclude());
  assertEquals((body.localOnly as Json).entries, ['aib-shared', 'game/review']);
  const undone = await lab.call('localOnly.exclude', { root: p, main: p, action: 'undo', undo: body.undo });
  assertEquals([undone.status, (undone.body as Json).ok], [200, true]);
  assert(!lab.exclude().includes('/game/review'));
  // refusals: the project, .git, a tracked file, a path out of the project, an unknown action
  const code = async (path: unknown) => {
    const r = await lab.call('localOnly.exclude', { root: p, main: p, action: 'add', path });
    return [r.status, (r.body as Json).code];
  };
  assertEquals(await code(''), [409, 'reserved']);
  // .git: the Files path rules refuse it first (FilesError 'hidden', 400 on the page, as for a Windows project)
  const hidden = await code('.git').catch((e) => e);
  assertEquals((hidden as { code?: string }).code, 'hidden');
  assertEquals(await code('src/a.txt'), [409, 'tracked']);
  assertEquals(await code('../outside'), [400, 'bad_path']);
  assertEquals(await code('aib-shared'), [409, 'already']);
  assertEquals((await lab.call('localOnly.exclude', { root: p, main: p, action: 'zap' })).status, 400);
  const outside = await lab.call('localOnly.exclude', { root: lab.box.base, main: p, action: 'add', path: 'x' }).catch((e) => e);
  assert(outside instanceof RpcError, 'a root outside the copies is refused');
  // from a chat copy: its file moves into the main folder first
  write(lab.copy, 'notes/todo.md', 'mine');
  const moved = await lab.call('localOnly.exclude', { root: lab.copy, main: p, action: 'add', path: 'notes' });
  assertEquals(moved.status, 200);
  assertEquals(Deno.readTextFileSync(join(p, 'notes', 'todo.md')), 'mine');
  // the daily backup, into the helper's data folder
  const backup = await lab.call('localOnly.backup', { projects: [p] });
  const result = (backup.results as Record<string, Json>)[p];
  assertEquals(result.status, 'made');
  assert([...Deno.readDirSync(join(lab.data, 'local-only-backups'))].some((e) => e.name.endsWith('.zip')));
  assertEquals(((await lab.call('localOnly.backup', { projects: [p] })).results as Record<string, Json>)[p].status, 'recent');
} });

/** The owner's wider shape: game/review/ and .env in a committed .gitignore, a user-excluded scratch/, node_modules, .claude/worktrees. */
function widen(lab: Lab): void {
  const p = lab.box.project;
  commit(p, '.gitignore', 'game/review/\n.env\n.claude/\nnode_modules/\n');
  commit(p, 'game/a.txt', 'tracked in game\n');
  write(p, 'game/review/deep/shot.png', 'SHOT');
  write(p, '.env', 'KEY=1\n');
  write(p, 'node_modules/pkg/index.js', 'x');
  write(p, 'scratch/s.md', 'mine');
  Deno.writeTextFileSync(join(p, '.git', 'info', 'exclude'), lab.exclude() + '/scratch/\n');
  Deno.mkdirSync(join(p, '.claude', 'worktrees'), { recursive: true });
  runGit(p, 'worktree', 'add', '-q', '-b', 'other-wt', join(p, '.claude', 'worktrees', 'wt1'));
  // the chat copy was cut before these commits: bring it to main's tip, as a new copy would be
  runGit(lab.copy, 'merge', '-q', '--ff-only', runGit(p, 'rev-parse', 'HEAD').trim());
}

Deno.test({ name: 'wsl helper localOnly: every ignored or excluded entry of main is listed, traversed and read from a chat copy', ignore: !HAVE_GIT, ...T, async fn() {
  using lab = new Lab();
  const p = lab.box.project;
  await lab.call('localOnly.ensure', { project: p });
  widen(lab);
  const gitignore = Deno.readTextFileSync(join(p, '.gitignore'));
  const row = (l: Json, name: string) => (l.entries as Json[]).find((e) => e.name === name);
  const top = await lab.call('localOnly.list', { root: lab.copy, main: p });
  assertEquals([row(top, 'aib-shared')?.local, row(top, 'aib-shared')?.ignored], [true, false], 'AIB local-only: normal colour, chip');
  assertEquals([row(top, 'scratch')?.from, row(top, 'scratch')?.ignored, row(top, 'scratch')?.excluded], ['main', false, true], 'excluded by the user line: normal colour');
  assertEquals([row(top, '.env')?.from, row(top, '.env')?.ignored], ['main', true], '.gitignore: dimmed');
  assertEquals([row(top, 'node_modules')?.from, row(top, 'node_modules')?.ignored], ['main', true]);
  assertEquals(row(top, 'game')?.from, undefined, "game/ is the copy's own (tracked)");
  const game = await lab.call('localOnly.list', { root: lab.copy, main: p, dir: 'game' });
  assertEquals((game.entries as Json[]).map((e) => [e.name, e.from ?? '', e.ignored]), [['review', 'main', true], ['a.txt', '', false]]);
  const deep = await lab.call('localOnly.list', { root: lab.copy, main: p, dir: 'game/review/deep' });
  assertEquals((deep.entries as Json[]).map((e) => [e.name, e.from, e.ignored]), [['shot.png', 'main', true]]);
  const scratch = await lab.call('localOnly.list', { root: lab.copy, main: p, dir: 'scratch' });
  assertEquals((scratch.entries as Json[]).map((e) => [e.name, e.ignored, e.excluded]), [['s.md', false, true]]);
  const read = await lab.call('localOnly.read', { root: lab.copy, main: p, rel: 'game/review/deep/shot.png' });
  assertEquals([atob(String(read.bytesB64)), read.from, read.readRoot], ['SHOT', 'main', p]);
  assertEquals(atob(String((await lab.call('localOnly.read', { root: lab.copy, main: p, rel: '.env' })).bytesB64)), 'KEY=1\n');
  // a path main does not ignore is never read from main for a copy
  write(p, 'game/untracked.txt', 'not ignored');
  const missing = await lab.call('localOnly.read', { root: lab.copy, main: p, rel: 'game/untracked.txt' }).catch((e) => e);
  assertEquals((missing as { code?: string }).code, 'not_found');
  const missingDir = await lab.call('localOnly.list', { root: lab.copy, main: p, dir: 'nowhere' }).catch((e) => e);
  assertEquals((missingDir as { code?: string }).code, 'not_found');
  // the main folder itself: the user-excluded folder reads in normal colour too
  const own = await lab.call('localOnly.list', { root: p, main: p });
  assertEquals([row(own, 'scratch')?.ignored, row(own, 'scratch')?.excluded, row(own, '.env')?.ignored], [false, true, true]);
  // Git exclude never touches a .gitignore
  await lab.call('localOnly.exclude', { root: p, main: p, action: 'add', path: 'game/review' });
  await lab.call('localOnly.exclude', { root: lab.copy, main: p, action: 'add', path: 'newdir' });
  assertEquals(Deno.readTextFileSync(join(p, '.gitignore')), gitignore, 'the .gitignore is untouched');
  assertEquals(Deno.readTextFileSync(join(lab.copy, '.gitignore')), gitignore, "the copy's (committed) .gitignore is untouched");
  for (const folder of [join(p, 'game'), join(p, 'game', 'review'), join(lab.copy, 'game')]) {
    let made = true;
    try {
      Deno.statSync(join(folder, '.gitignore'));
    } catch {
      made = false;
    }
    assert(!made, `no .gitignore in ${folder}`);
  }
} });

Deno.test({ name: 'wsl helper localOnly.chat ignored: top-level ignored folders and files of main, never .git, other worktrees or AIB data', ignore: !HAVE_GIT, ...T, async fn() {
  using lab = new Lab();
  const p = lab.box.project;
  await lab.call('localOnly.ensure', { project: p });
  widen(lab);
  const lo = (await lab.call('localOnly.chat', { project: p, worktree: true, ignored: true })).localOnly as Json;
  const priv = join(p, 'aib-shared');
  assertEquals([lo.entries, lo.dirs, lo.shared], [[priv], [priv], priv]);
  const ignored = lo.ignored as { dirs: string[]; files: string[] };
  assertEquals(ignored.dirs.sort(), [join(p, 'game', 'review'), join(p, 'node_modules'), join(p, 'scratch')].sort());
  assertEquals(ignored.files, [join(p, '.env')]);
  assert(!ignored.dirs.some((d) => d.includes('.claude')), '.claude/ holds another worktree: left out');
  // without `ignored`: only AIB's local-only answer (a Windows-shaped one)
  assertEquals(((await lab.call('localOnly.chat', { project: p, worktree: true })).localOnly as Json).ignored, undefined);
} });

Deno.test('wsl local-only: a test AIB sets the default up only in projects under /tmp; a real one anywhere', () => {
  const temp = Deno.makeTempDirSync({ prefix: 'aib-wsl-lo-' });
  try {
    assertEquals(wslDefaultsAllowed(temp, 'wsl://ubuntu/home/kirk/REPOS/app'), false);
    assertEquals(wslDefaultsAllowed('', 'wsl://ubuntu/home/kirk/REPOS/app'), false);
    assertEquals(wslDefaultsAllowed(temp, 'wsl://ubuntu/tmp/aib-wsl-test-x/repo'), true);
    assertEquals(wslDefaultsAllowed(temp, 'C:\\app'), false);
    const real = Deno.build.os === 'windows' ? 'C:\\Users\\nobody\\AppData\\Local\\AgentStudio' : '/home/nobody/.local/aib';
    assertEquals(wslDefaultsAllowed(real, 'wsl://ubuntu/home/u/app'), true);
  } finally {
    Deno.removeSync(temp, { recursive: true });
  }
});

// ---- Studio and Files with a fake distro --------------------------------------------------------------------------------
const REF = 'wsl://ubuntu/home/u/app';
const DATA = '/home/u/.aib-server/data-000000000000';
const WT_LINUX = `${DATA}/worktrees/h1/chat-abcd1234`;
const WT_REF = `wsl://ubuntu${WT_LINUX}`;
const PRIV = '/home/u/app/aib-shared';
const GAME = '/home/u/app/game/review';
const ENV = '/home/u/app/.env';

class StudioLab {
  readonly dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-wsl-lo-' }));
  readonly state = this.dir + SEP + 'state';
  readonly log = this.dir + SEP + 'acp.log';
  readonly host: FakeWslHost;
  readonly studios: Studio[] = [];
  readonly records = new Map<string, Json>();

  constructor(localOnly = true) {
    Deno.mkdirSync(this.dir + SEP + 'app', { recursive: true });
    this.host = new FakeWslHost(this.dir + SEP + 'linux-keeper', 'Ubuntu', { FAKE_ACP_LOG: this.log });
    this.host.folders.set('/home/u', this.dir);
    setWslHostResolver((d) => (d === 'ubuntu' ? this.host : null));
    const h = this.host.handlers;
    h['worktree.plan'] = (p) => ({
      plan: { project: p.project, base: 'main', key: 'abcd1234abcd1234', slug: 'chat-abcd1234', branch: 'studio/chat-abcd1234', path: WT_LINUX, folderBranch: 'main', note: '' },
      reason: '',
    });
    h['worktree.create'] = (p) => {
      const plan = p.plan as Json;
      Deno.mkdirSync(this.host.windowsFor(String(plan.path)), { recursive: true });
      this.records.set(String(plan.key), { ...plan, status: 'ready', diffBase: 'u0' });
      return { note: '' };
    };
    h['worktree.find'] = (p) => {
      for (const [key, r] of this.records) if (r.path === p.path || (p.session && r.session === p.session)) return { record: { ...r, key } };
      return { record: null };
    };
    h['worktree.isRemoved'] = () => ({ removed: false });
    h['worktree.setSession'] = (p) => {
      const r = this.records.get(String(p.key));
      if (r) r.session = `${p.provider}:${p.sessionId}`;
      return { ok: true };
    };
    h['worktree.discard'] = () => ({ ok: true });
    if (localOnly) {
      h['localOnly.ensure'] = () => ({ state: 'on' });
      h['localOnly.chat'] = (p) => ({ localOnly: p.project === '/home/u/app' ? { entries: [PRIV], dirs: [PRIV], shared: PRIV, ...(p.ignored ? { ignored: { dirs: [GAME], files: [ENV] } } : {}) } : null });
      h['localOnly.list'] = (p) => ({ root: p.root, dir: '', git: true, entries: [], truncated: false, localOnly: { main: p.main, entries: ['aib-shared'], defaultState: 'on', sig: '1' } });
      h['localOnly.exclude'] = (p) => ({ status: 200, body: { ok: true, undo: '{}', path: p.path, localOnly: { main: p.main, entries: ['aib-shared', String(p.path)], defaultState: 'on', sig: '' } } });
    }
  }

  studio(): Studio {
    const keeper = new KeeperLink({ dataDir: this.state, orphan: null, extraArgs: ['--exit-after', '2s', '--orphan-after', '30s'] });
    const studio = new Studio({ stateDir: this.state, port: 0, ownersDir: null, noArtifactTool: true }, { keeper });
    studio.ownerProbe = () => null;
    studio.connectionFactory = (_command, cwd, provider, options) => {
      const wsl = options?.wsl ? { ...options.wsl, program: undefined } : options?.wsl;
      return new Connection(fake('--cancel-aware', '--extra-dirs'), cwd, provider, { ...options, wsl });
    };
    this.studios.push(studio);
    return studio;
  }

  called(method: string): Json[] {
    return this.host.calls.filter(([m]) => m === method).map(([, p]) => p);
  }

  received(method: string): Json[] {
    let text = '';
    try {
      text = Deno.readTextFileSync(this.log);
    } catch { /* nothing yet */ }
    return text.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((m) => m.method === method).map((m) => m.params);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    for (const s of this.studios.reverse()) await s.close().catch(() => {});
    setWslHostResolver(null);
    await this.host.stopKeeper();
    const info = readKeeperInfo(this.state);
    if (info && pidAlive(info.pid)) {
      try {
        const client = await KeeperClient.connect(info);
        await client.shutdown(true).catch(() => {});
        client.close();
      } catch { /* gone */ }
      await until(() => !pidAlive(info.pid), 'keeper exit', 5).catch(() => Deno.kill(info.pid, 'SIGKILL'));
    }
    for (let i = 0; i < 20; i++) {
      try {
        Deno.removeSync(this.dir, { recursive: true });
        return;
      } catch {
        await pause(200);
      }
    }
  }
}

const systemTexts = (params: Json) =>
  (((params.systemPrompt as Json | undefined)?.content as Json[] | undefined) ?? []).map((c) => String(c.text ?? ''));

Deno.test({ name: 'wsl studio local-only: a chat in its own copy is granted and told the main folder aib-shared/ (Linux paths)', ...T, async fn() {
  await keeperBinary();
  await using lab = new StudioLab();
  const c = await lab.studio().connect('claude', REF, null, { ownCopy: true });
  await until(() => c.ready, 'ready', 30);
  assertEquals([c.cwd, c.agentCwd, c.projectRoot], [WT_REF, WT_LINUX, REF]);
  assertEquals(c.localOnly, { entries: [PRIV], dirs: [PRIV], shared: PRIV, ignored: { dirs: [GAME], files: [ENV] } });
  assertEquals(lab.called('localOnly.chat'), [{ project: '/home/u/app', worktree: true, ignored: true }]);
  assertEquals(lab.called('localOnly.ensure'), [], 'a test AIB never writes the default into a project outside /tmp');
  const made = lab.received('session/new');
  assertEquals(made.length, 1);
  assertEquals(made[0].additionalDirectories, [PRIV, GAME], 'Linux paths of the main folder aib-shared/ and its other ignored folders (no Windows scratch folder)');
  assertEquals(made[0].cwd, WT_LINUX);
  const note = systemTexts(made[0]).find((t) => t.includes('aib-shared/ in the project folder'))!;
  assert(note && note.startsWith(SHARED_FOLDER_PROMPT) && !note.includes('Local-only files'), note); // aib-shared/ comes through the copy's link
  assert(note.includes(`${GAME}, ${ENV}`) && note.includes('shared with the main folder'), note);
} });

Deno.test({ name: 'wsl studio local-only: a project under /tmp gets the default first; an older helper leaves the chat as before', ...T, async fn() {
  await keeperBinary();
  {
    await using lab = new StudioLab();
    lab.host.folders.set('/tmp/aib-wsl-test-fake', lab.dir);
    const c = await lab.studio().connect('claude', 'wsl://ubuntu/tmp/aib-wsl-test-fake/app', null, { ownCopy: true });
    await until(() => c.ready, 'ready', 30);
    assertEquals(lab.called('localOnly.ensure'), [{ project: '/tmp/aib-wsl-test-fake/app' }]);
    const ensureAt = lab.host.calls.findIndex(([m]) => m === 'localOnly.ensure');
    const createAt = lab.host.calls.findIndex(([m]) => m === 'worktree.create');
    assert(ensureAt >= 0 && ensureAt < createAt, 'the exclude is in force before the copy is made');
  }
  {
    await using lab = new StudioLab(false); // the fake helper answers localOnly.* with no_method
    const c = await lab.studio().connect('claude', REF, null, { ownCopy: true });
    await until(() => c.ready, 'ready', 30);
    assertEquals([c.cwd, c.localOnly], [WT_REF, null]);
    assert(!('additionalDirectories' in lab.received('session/new')[0]));
  }
} });

Deno.test({ name: 'wsl files local-only: list and exclude of a WSL chat copy go to the helper with the project main folder', ...T, async fn() {
  await keeperBinary();
  await using lab = new StudioLab();
  const studio = lab.studio();
  const c = await studio.connect('claude', REF, null, { ownCopy: true });
  await until(() => c.ready, 'ready', 30);
  const routes = filesRoutes();
  const ctx = {
    token: 't',
    stateDir: lab.state,
    host: studio,
    artifacts: { connectionOf: () => '', conversations: () => [], store: { origin: '' } },
    transcripts: { stores: new Map() },
  } as unknown as WebContext;
  const headers = { 'X-Studio-Token': 't' };
  const [status, list] = await routes.get('GET /api/live/files/list')!(ctx, new URL(`http://x/api/live/files/list?id=${c.id}&root=chat`), null, new Request('http://x', { headers })) as [number, Json];
  assertEquals(status, 200, JSON.stringify(list));
  assertEquals(list.root, WT_REF);
  assertEquals(list.localOnly, { main: '/home/u/app', entries: ['aib-shared'], defaultState: 'on', sig: '1' });
  assertEquals(lab.called('localOnly.list').at(-1), { root: WT_LINUX, main: '/home/u/app', dir: '' });
  const [code, body] = await routes.get('POST /api/live/files/exclude')!(ctx, new URL('http://x/api/live/files/exclude'), { id: c.id, root: 'chat', action: 'add', path: 'game/review' }, new Request('http://x', { headers })) as [number, Json];
  assertEquals([code, body.ok, body.path], [200, true, 'game/review']);
  assertEquals(lab.called('localOnly.exclude').at(-1), { root: WT_LINUX, main: '/home/u/app', action: 'add', path: 'game/review' });
  // an older helper: the phase 1 list answer, and the POST says the helper is too old
  delete lab.host.handlers['localOnly.list'];
  delete lab.host.handlers['localOnly.exclude'];
  lab.host.handlers['files.list'] = () => ({ dir: '', git: true, entries: [], truncated: false, sig: 'x' });
  const [, old] = await routes.get('GET /api/live/files/list')!(ctx, new URL(`http://x/api/live/files/list?id=${c.id}&root=chat`), null, new Request('http://x', { headers })) as [number, Json];
  assertEquals((old.localOnly as Json).defaultState, 'no-git');
  const [refused] = await routes.get('POST /api/live/files/exclude')!(ctx, new URL('http://x/api/live/files/exclude'), { id: c.id, root: 'chat', action: 'add', path: 'x' }, new Request('http://x', { headers })) as [number, Json];
  assertEquals(refused, 409);
} });

Deno.test('wsl local-only backup round (audit F12): WSL projects go to their running distro\'s helper; a stopped distro and Windows projects are not asked', async () => {
  const calls: [string, string, Json][] = [];
  const host = (name: string, state: string) => ({
    state,
    call(method: string, params: Json) {
      calls.push([name, method, params]);
      const results: Record<string, Json> = {};
      for (const p of params.projects as string[]) results[p] = { status: 'done' };
      return Promise.resolve({ results });
    },
  });
  const hosts: Record<string, unknown> = { ubuntu: host('ubuntu', 'ready'), debian: host('debian', 'stopped') };
  setWslHostResolver(((d: string) => hosts[d] ?? null) as Parameters<typeof setWslHostResolver>[0]);
  try {
    const done = await wslBackupRound([
      'wsl://ubuntu/home/u/app',
      'wsl://Ubuntu/home/u/app', // the same project (distro folded): asked once
      'wsl://ubuntu/home/u/web',
      'wsl://debian/home/u/other', // not running: never started for a backup
      'C:\\repo\\app', // Windows: local_backup.ts does it
    ]);
    assertEquals(calls, [['ubuntu', 'localOnly.backup', { projects: ['/home/u/app', '/home/u/web'] }]]);
    assertEquals([...done.keys()], ['ubuntu']);
    assertEquals(done.get('ubuntu')!['/home/u/app'].status, 'done');
  } finally {
    setWslHostResolver(null);
  }
});
