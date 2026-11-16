/**
 * Local-only folders of WSL projects without a distro (wsl/helper/local_only.ts, wsl/local_only.ts, files_routes.ts, host/studio.ts):
 *   - the helper's localOnly.* methods over the real modules, run natively here on a temp repo whose own exclude names `/private/`
 *     (the owner's shape): ensure adds AIB's block, chat answers the main folder's paths and makes private/, list / search / read
 *     from a chat copy (a git worktree under <data>/worktrees) show the main folder's private/, exclude writes the repo's
 *     .git/info/exclude and its Undo takes it back, refusals (the project, .git, '..', a tracked file), a root outside AIB's copies is
 *     refused, strays move, and the daily backup zips into <data>/local-only-backups;
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
import { wslDefaultsAllowed } from '../../outputs/agent-studio/server/wsl/local_only.ts';
import { Connection } from '../../outputs/agent-studio/server/acp/connection.ts';
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
    write(p, '.git/info/exclude', '# git ls-files --others --exclude-from=.git/info/exclude\n\n# Owner-only files\n/private/\n');
    write(p, 'private/review/x.png', 'PNG-BYTES');
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
  assert(after.includes(BLOCK_START) && after.includes('\n/private\n'), after);
  assertEquals(await lab.call('localOnly.ensure', { project: p }), { state: 'on' });
  assertEquals(lab.exclude(), after, 'idempotent');
  const priv = join(p, 'private');
  const chat = (await lab.call('localOnly.chat', { project: p, worktree: true })).localOnly;
  assertEquals(chat, { entries: [priv], dirs: [priv], private: priv });
  assert(!Deno.statSync(join(lab.copy, 'src', 'a.txt')).isDirectory);
  let inCopy = true;
  try {
    Deno.statSync(join(lab.copy, 'private'));
  } catch {
    inCopy = false;
  }
  assert(!inCopy, "the chat's copy holds no private/: git never copies it");
  // a project that is not git: nothing
  const plain = join(lab.box.base, 'plain');
  Deno.mkdirSync(plain);
  assertEquals(await lab.call('localOnly.ensure', { project: plain }), { state: 'no-git' });
  assertEquals((await lab.call('localOnly.chat', { project: plain, worktree: true })).localOnly, null);
} });

Deno.test({ name: 'wsl helper localOnly: list, search and read from a chat copy show the main folder private/', ignore: !HAVE_GIT, ...T, async fn() {
  using lab = new Lab();
  const p = lab.box.project;
  await lab.call('localOnly.ensure', { project: p });
  const top = await lab.call('localOnly.list', { root: lab.copy, main: p });
  const lo = top.localOnly as Json;
  assertEquals([lo.main, lo.entries, lo.defaultState], [p, ['private'], 'on']);
  const row = (top.entries as Json[]).find((e) => e.name === 'private')!;
  assert(row && row.local === true, JSON.stringify(top.entries));
  assertEquals(row.noExclude, 'already');
  const srcRow = (top.entries as Json[]).find((e) => e.name === 'src')!;
  assertEquals(srcRow.noExclude, 'tracked');
  const inside = await lab.call('localOnly.list', { root: lab.copy, main: p, dir: 'private/review' });
  assertEquals((inside.entries as Json[]).map((e) => [e.name, e.from]), [['x.png', 'main']]);
  const found = await lab.call('localOnly.search', { root: lab.copy, main: p, query: 'x.png' });
  assertEquals((found.matches as Json[]).map((m) => m.path), ['private/review/x.png']);
  const read = await lab.call('localOnly.read', { root: lab.copy, main: p, rel: 'private/review/x.png' });
  assertEquals([atob(String(read.bytesB64)), read.local, read.from, read.readRoot], ['PNG-BYTES', true, 'main', p]);
  const plain = await lab.call('localOnly.read', { root: lab.copy, main: p, rel: 'src/a.txt' });
  assertEquals([atob(String(plain.bytesB64)), plain.local, plain.readRoot], ['tracked\n', undefined, lab.copy]);
  // the main folder itself
  const own = await lab.call('localOnly.list', { root: p, main: p });
  assert((own.entries as Json[]).some((e) => e.name === 'private' && e.local === true));
  // a root that is neither the main folder nor one of AIB's chat copies
  for (const root of [lab.box.base, lab.data, join(lab.data, 'worktrees')]) {
    const refused = await lab.call('localOnly.list', { root, main: p }).catch((e) => e);
    assert(refused instanceof RpcError && refused.data?.code === 'bad_root', `${root}: ${refused}`);
  }
} });

Deno.test({ name: 'wsl helper localOnly: exclude writes the repo exclude file, Undo takes it back, refusals, strays, backup', ignore: !HAVE_GIT, ...T, async fn() {
  using lab = new Lab();
  const p = lab.box.project;
  await lab.call('localOnly.ensure', { project: p });
  write(p, 'game/review/shot.png', 'S');
  const added = await lab.call('localOnly.exclude', { root: p, main: p, action: 'add', path: 'game/review' });
  assertEquals(added.status, 200);
  const body = added.body as Json;
  assertEquals(body.path, 'game/review');
  assert(lab.exclude().includes('\n/game/review\n'), lab.exclude());
  assertEquals((body.localOnly as Json).entries, ['private', 'game/review']);
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
  assertEquals(await code('private'), [409, 'already']);
  assertEquals((await lab.call('localOnly.exclude', { root: p, main: p, action: 'zap' })).status, 400);
  const outside = await lab.call('localOnly.exclude', { root: lab.box.base, main: p, action: 'add', path: 'x' }).catch((e) => e);
  assert(outside instanceof RpcError, 'a root outside the copies is refused');
  // from a chat copy: its file moves into the main folder first
  write(lab.copy, 'notes/todo.md', 'mine');
  const moved = await lab.call('localOnly.exclude', { root: lab.copy, main: p, action: 'add', path: 'notes' });
  assertEquals(moved.status, 200);
  assertEquals(Deno.readTextFileSync(join(p, 'notes', 'todo.md')), 'mine');
  // a stray: the copy has a file under private/ the main folder lacks
  write(lab.copy, 'private/stray.md', 'stray');
  const strays = await lab.call('localOnly.moveStrays', { root: lab.copy, main: p });
  assertEquals(strays.moved, [['private/stray.md', 'private/stray.md']]);
  assertEquals(Deno.readTextFileSync(join(p, 'private', 'stray.md')), 'stray');
  // the daily backup, into the helper's data folder
  const backup = await lab.call('localOnly.backup', { projects: [p] });
  const result = (backup.results as Record<string, Json>)[p];
  assertEquals(result.status, 'made');
  assert([...Deno.readDirSync(join(lab.data, 'local-only-backups'))].some((e) => e.name.endsWith('.zip')));
  assertEquals(((await lab.call('localOnly.backup', { projects: [p] })).results as Record<string, Json>)[p].status, 'recent');
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
const PRIV = '/home/u/app/private';

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
      h['localOnly.chat'] = (p) => ({ localOnly: p.project === '/home/u/app' ? { entries: [PRIV], dirs: [PRIV], private: PRIV } : null });
      h['localOnly.list'] = (p) => ({ root: p.root, dir: '', git: true, entries: [], truncated: false, localOnly: { main: p.main, entries: ['private'], defaultState: 'on', sig: '1' } });
      h['localOnly.exclude'] = (p) => ({ status: 200, body: { ok: true, undo: '{}', path: p.path, localOnly: { main: p.main, entries: ['private', String(p.path)], defaultState: 'on', sig: '' } } });
    }
  }

  studio(): Studio {
    const keeper = new KeeperLink({ dataDir: this.state, orphan: null, extraArgs: ['--exit-after', '2s', '--orphan-after', '30s'] });
    const studio = new Studio({ ompCommand: 'unused', stateDir: this.state, port: 0, ownersDir: null, noArtifactTool: true }, { keeper });
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

Deno.test({ name: 'wsl studio local-only: a chat in its own copy is granted and told the main folder private/ (Linux paths)', ...T, async fn() {
  await keeperBinary();
  await using lab = new StudioLab();
  const c = await lab.studio().connect('claude', REF);
  await until(() => c.ready, 'ready', 30);
  assertEquals([c.cwd, c.agentCwd, c.projectRoot], [WT_REF, WT_LINUX, REF]);
  assertEquals(c.localOnly, { entries: [PRIV], dirs: [PRIV], private: PRIV });
  assertEquals(lab.called('localOnly.chat'), [{ project: '/home/u/app', worktree: true }]);
  assertEquals(lab.called('localOnly.ensure'), [], 'a test AIB never writes the default into a project outside /tmp');
  const made = lab.received('session/new');
  assertEquals(made.length, 1);
  assertEquals(made[0].additionalDirectories, [PRIV], 'the Linux path of the main folder private/ (no Windows scratch folder)');
  assertEquals(made[0].cwd, WT_LINUX);
  const note = systemTexts(made[0]).find((t) => t.includes('Local-only files'))!;
  assert(note && note.includes(PRIV) && note.includes('not in this') && note.includes(`You may create and use ${PRIV}`), note);
} });

Deno.test({ name: 'wsl studio local-only: a project under /tmp gets the default first; an older helper leaves the chat as before', ...T, async fn() {
  await keeperBinary();
  {
    await using lab = new StudioLab();
    lab.host.folders.set('/tmp/aib-wsl-test-fake', lab.dir);
    const c = await lab.studio().connect('claude', 'wsl://ubuntu/tmp/aib-wsl-test-fake/app');
    await until(() => c.ready, 'ready', 30);
    assertEquals(lab.called('localOnly.ensure'), [{ project: '/tmp/aib-wsl-test-fake/app' }]);
    const ensureAt = lab.host.calls.findIndex(([m]) => m === 'localOnly.ensure');
    const createAt = lab.host.calls.findIndex(([m]) => m === 'worktree.create');
    assert(ensureAt >= 0 && ensureAt < createAt, 'the exclude is in force before the copy is made');
  }
  {
    await using lab = new StudioLab(false); // the fake helper answers localOnly.* with no_method
    const c = await lab.studio().connect('claude', REF);
    await until(() => c.ready, 'ready', 30);
    assertEquals([c.cwd, c.localOnly], [WT_REF, null]);
    assert(!('additionalDirectories' in lab.received('session/new')[0]));
  }
} });

Deno.test({ name: 'wsl files local-only: list and exclude of a WSL chat copy go to the helper with the project main folder', ...T, async fn() {
  await keeperBinary();
  await using lab = new StudioLab();
  const studio = lab.studio();
  const c = await studio.connect('claude', REF);
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
  assertEquals(list.localOnly, { main: '/home/u/app', entries: ['private'], defaultState: 'on', sig: '1' });
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
