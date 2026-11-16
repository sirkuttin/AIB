/**
 * The worktree per chat of WSL projects without a distro (docs/wsl/design.md section 4 phase 2, section 5 item 3):
 *   - the helper's worktree.* methods (wsl/helper/worktrees.ts) over the real Manager, run natively here on a temp repo: plan,
 *     create, find, setSession, hasChanges, remove, isRemoved, ensure; a plan that points anywhere but the root is refused;
 *   - Studio with a FakeWslHost (work/deno/_wsl_fake.ts): a new WSL chat gets its worktree from the helper (cwd = the worktree's
 *     ref, the agent's cwd its Linux folder, projectRoot the project's ref, `loc` in its chat note), a crashed AIB rebuilds it there,
 *     Discard removes it through the helper; a fallback, and a helper without worktrees, keep the chat in the project folder;
 *   - the Changes view of a WSL worktree chat: the branch view against its diff base, Discard and Merge (wsl_merge_test.ts).
 * Never a real distro, never the owner's homes.
 */
import { assert, assertEquals, assertRejects } from './_assert.ts';
import { fake, pause, until } from './_connection.ts';
import { FakeWslHost } from './_wsl_fake.ts';
import { commit, runGit, Sandbox, write } from './_worktree_fixtures.ts';
import { HAVE_GIT } from './_git_repo.ts';
import { onWindowsDrive, worktreeMethods } from '../../outputs/agent-studio/server/wsl/helper/worktrees.ts';
import { RpcError } from '../../outputs/agent-studio/server/wsl/helper/rpc.ts';
import * as wt from '../../outputs/agent-studio/server/worktrees/worktrees.ts';
import { Connection } from '../../outputs/agent-studio/server/acp/connection.ts';
import { Studio } from '../../outputs/agent-studio/server/host/studio.ts';
import { KeeperLink } from '../../outputs/agent-studio/server/keeper/link.ts';
import { KeeperClient, keeperBinary, readKeeperInfo } from '../../outputs/agent-studio/server/keeper/client.ts';
import { pidAlive } from '../../outputs/agent-studio/server/host/host_client.ts';
import { setWslHostResolver } from '../../outputs/agent-studio/server/wsl/access.ts';
import { WslHelperError } from '../../outputs/agent-studio/server/wsl/contract.ts';
import { changesResponse } from '../../outputs/agent-studio/server/worktrees/chat_folders.ts';
import { MOVED_FILE } from '../../outputs/agent-studio/server/state/moved_chats.ts';

type Json = Record<string, unknown>;
const T = { sanitizeResources: false, sanitizeOps: false };
const SEP = Deno.build.os === 'windows' ? '\\' : '/';

Deno.env.set('AIB_WSL_ROOT', '/tmp/aib-wsl-test-fake');

// ---- the helper's methods ------------------------------------------------------------------------------------------------
Deno.test({ name: 'wsl helper worktree.*: plan, create, find, session, changes, remove and isRemoved over the real Manager', ignore: !HAVE_GIT, ...T, async fn() {
  using box = new Sandbox();
  const m = worktreeMethods(box.state);
  const planned = await m['worktree.plan']({ project: box.project }) as { plan: Json; reason: string };
  assertEquals(planned.reason, '');
  const plan = planned.plan;
  assertEquals(plan.base, 'main');
  assert(String(plan.branch).startsWith('studio/chat-'));
  assertEquals(plan.path, [box.state, 'worktrees', wt.repoHash(box.project), plan.slug].join(SEP)); // <data>/worktrees/<hash>/<slug>

  // a plan pointing anywhere else is refused before anything is made
  for (const bad of [{ path: box.project }, { branch: 'main' }, { slug: '../x' }, { key: 'no' }]) {
    await assertRejects(() => Promise.resolve(m['worktree.create']({ plan: { ...plan, ...bad } })), RpcError);
  }
  assertEquals(box.branches(), []);

  await m['worktree.create']({ plan });
  assertEquals(box.branches(), [plan.branch]);
  const found = (await m['worktree.find']({ path: plan.path }) as { record: Json }).record;
  assertEquals([found.key, found.status, found.project, found.branch], [plan.key, 'ready', box.project, plan.branch]);
  assertEquals((await m['worktree.hasChanges']({ key: plan.key }) as Json).changes, false);
  await m['worktree.setSession']({ key: plan.key, provider: 'claude', sessionId: 's-1' });
  assertEquals(((await m['worktree.find']({ session: 'claude:s-1' }) as { record: Json }).record).key, plan.key);
  assertEquals((await m['worktree.isRemoved']({ workspace: String(plan.path), session: 'claude:s-1' }) as Json).removed, false);

  // the chat edits its copy: archive keeps it (changes), Discard (confirmed) removes folder and branch
  write(String(plan.path), 'new.txt', 'chat work\n');
  assertEquals((await m['worktree.hasChanges']({ key: plan.key }) as Json).changes, true);
  assertEquals((await m['worktree.remove']({ key: plan.key, confirmed: true }) as Json).outcome, 'removed');
  assertEquals(box.branches(), []);
  assert(!wt.lexists(String(plan.path)));
  assertEquals((await m['worktree.isRemoved']({ workspace: String(plan.path), session: 'claude:s-1' }) as Json).removed, true);
  assertEquals((await m['worktree.find']({ path: plan.path }) as Json).record, null);
  assertEquals((await m['worktree.remove']({ key: plan.key }) as Json).outcome, 'gone');
} });

Deno.test({ name: 'wsl helper worktree.*: ensure remakes a deleted folder from its branch, says gone without it; not-git works in place', ignore: !HAVE_GIT, ...T, async fn() {
  using box = new Sandbox();
  const m = worktreeMethods(box.state);
  const plan = (await m['worktree.plan']({ project: box.project }) as { plan: Json }).plan;
  await m['worktree.create']({ plan });
  commit(String(plan.path), 'kept.txt', 'kept\n', 'chat commit');
  Deno.removeSync(String(plan.path), { recursive: true });
  assertEquals((await m['worktree.ensure']({ key: plan.key }) as Json).path, plan.path);
  assert(wt.lexists([String(plan.path), 'kept.txt'].join(SEP)), 'made again from its branch');
  Deno.removeSync(String(plan.path), { recursive: true });
  runGit(box.project, 'worktree', 'prune');
  runGit(box.project, 'branch', '-D', String(plan.branch));
  const gone = await Promise.resolve(m['worktree.ensure']({ key: plan.key })).catch((e) => e);
  assert(gone instanceof RpcError && gone.data?.code === 'gone', String(gone));

  using plain = new Sandbox(false);
  Deno.mkdirSync(plain.project, { recursive: true });
  const none = await m['worktree.plan']({ project: plain.project }) as { plan: Json | null; reason: string };
  assertEquals([none.plan, none.reason], [null, 'not a git repository']);
  assertEquals(onWindowsDrive('/mnt/c/Users/u/app'), true);
  assertEquals(onWindowsDrive('/home/u/mnt/c'), false);
  await assertRejects(() => Promise.resolve(m['worktree.plan']({ project: 'relative/path' })), RpcError);
} });

// ---- Studio with a FakeWslHost -------------------------------------------------------------------------------------------
const REF = 'wsl://ubuntu/home/u/app';
const DATA = '/home/u/.aib-server/data-000000000000';

/** A distro helper with worktrees, kept in memory; the worktree folders are Windows temp folders through the fake's mapping. */
class WorktreeLab {
  readonly dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-wsl-wt-' }));
  readonly state = this.dir + SEP + 'state';
  readonly host: FakeWslHost;
  readonly studios: Studio[] = [];
  readonly records = new Map<string, Json>();
  fallback = '';

  constructor(withWorktrees = true) {
    Deno.mkdirSync(this.dir + SEP + 'app', { recursive: true });
    this.host = new FakeWslHost(this.dir + SEP + 'linux-keeper');
    this.host.folders.set('/home/u', this.dir);
    setWslHostResolver((d) => (d === 'ubuntu' ? this.host : null));
    if (withWorktrees) this.#worktrees();
  }

  #worktrees(): void {
    const h = this.host.handlers;
    h['worktree.plan'] = (p) => {
      const slug = 'chat-abcd1234';
      return {
        plan: { project: p.project, base: 'main', key: 'abcd1234abcd1234', slug, branch: `studio/${slug}`, path: `${DATA}/worktrees/h1/${slug}`, folderBranch: 'main', note: '' },
        reason: '',
      };
    };
    h['worktree.create'] = (p) => {
      const plan = p.plan as Json;
      if (this.fallback) throw new WslHelperError(this.fallback, 'fallback');
      Deno.mkdirSync(this.host.windowsFor(String(plan.path)), { recursive: true });
      this.records.set(String(plan.key), { ...plan, status: 'ready', diffBase: 'u0' });
      return { note: '' };
    };
    h['worktree.find'] = (p) => {
      for (const [key, r] of this.records) {
        if (r.path === p.path || (p.session && r.session === p.session)) return { record: { ...r, key } };
      }
      return { record: null };
    };
    h['worktree.isRemoved'] = () => ({ removed: false });
    h['worktree.ensure'] = (p) => ({ path: String(this.records.get(String(p.key))?.path) });
    h['worktree.setSession'] = (p) => {
      const r = this.records.get(String(p.key));
      if (r) r.session = `${p.provider}:${p.sessionId}`;
      return { ok: true };
    };
    h['worktree.discard'] = (p) => (this.records.delete(String(p.key)), { ok: true });
    h['worktree.remove'] = (p) => ({ outcome: this.records.delete(String(p.key)) ? 'removed' : 'gone' });
    h['worktree.hasChanges'] = () => ({ changes: false });
  }

  studio(): Studio {
    const keeper = new KeeperLink({ dataDir: this.state, orphan: null, extraArgs: ['--exit-after', '2s', '--orphan-after', '30s'] });
    const studio = new Studio({ ompCommand: 'unused', stateDir: this.state, port: 0, ownersDir: null, noArtifactTool: true }, { keeper });
    studio.ownerProbe = () => null;
    studio.connectionFactory = (_command, cwd, provider, options) => {
      const wsl = options?.wsl ? { ...options.wsl, program: undefined } : options?.wsl;
      return new Connection(fake('--cancel-aware'), cwd, provider, { ...options, wsl });
    };
    this.studios.push(studio);
    return studio;
  }

  crash(studio: Studio): void {
    studio.keeper!.disconnect();
    this.host.link.disconnect();
    for (const c of studio.connections.values()) c.sessionLease?.release();
    studio.reconnectStop.set();
    this.studios.splice(this.studios.indexOf(studio), 1);
    this.host.renewLink();
  }

  called(method: string): Json[] {
    return this.host.calls.filter(([m]) => m === method).map(([, p]) => p);
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

const WT_LINUX = `${DATA}/worktrees/h1/chat-abcd1234`;
const WT_REF = `wsl://ubuntu${WT_LINUX}`;

// Owner decision 2026-11-16: new chats work in the project folder; a WSL chat in its own copy is one made before that (it keeps
// its copy until merged or discarded). The test-only ownCopy makes one.
Deno.test({ name: 'wsl studio: a WSL chat in its own worktree made by the helper; a restarted AIB rebuilds it there; Discard removes it', ...T, async fn() {
  await keeperBinary();
  await using lab = new WorktreeLab();
  const a = lab.studio();
  const c = await a.connect('claude', REF, null, { ownCopy: true });
  assertEquals([c.cwd, c.agentCwd, c.projectRoot], [WT_REF, WT_LINUX, REF]);
  assertEquals(c.worktree, { branch: 'studio/chat-abcd1234', base: 'main' });
  assertEquals(c.wsl?.linuxPath, WT_LINUX);
  assertEquals(c.swarm, null); // no swarm tools in a WSL chat
  assertEquals(lab.called('worktree.plan'), [{ project: '/home/u/app', kind: 'chat' }]);
  const spec = lab.host.link.spawned.find((s) => String(s.channel).startsWith('chat-'))!;
  assertEquals(spec.cwd, WT_LINUX);
  assertEquals(lab.called('worktree.setSession').map((p) => [p.key, p.provider, !!p.sessionId]), [['abcd1234abcd1234', 'claude', true]]);
  const reader = await KeeperClient.connect(readKeeperInfo(lab.host.dataDir)!);
  try {
    const note = await lab.host.link.firstNote(reader, `chat-${c.id}`);
    assertEquals(note?.loc, { kind: 'wsl', distro: 'ubuntu', linuxPath: WT_LINUX });
    assertEquals([note?.cwd, note?.projectRoot], [WT_REF, REF]);
    assertEquals(note?.worktree, { branch: 'studio/chat-abcd1234', base: 'main' });
  } finally {
    reader.close();
  }
  // a crashed AIB: the next one rebuilds the chat in its worktree, under its project
  lab.crash(a);
  const b = lab.studio();
  assertEquals(await b.adoptKeeper(), 1);
  const r = b.connections.get(c.id)!;
  assert(r && r.ready && !r.closed);
  assertEquals([r.cwd, r.agentCwd, r.projectRoot], [WT_REF, WT_LINUX, REF]);
  assertEquals(r.worktree, { branch: 'studio/chat-abcd1234', base: 'main' });
  // Discard: the agent stops, the helper removes the worktree (confirmed: --force)
  const [status, body] = await b.liveCall('worktree-discard', { id: r.id, confirm: true });
  assertEquals(status, 200);
  assertEquals((body as Json).removed, true);
  assertEquals(lab.called('worktree.remove'), [{ key: 'abcd1234abcd1234', confirmed: true }]);
  assert(r.closed);
  // no re-filing in the app (the owner's one-off migration script does that inside the distro)
  assertEquals((body as Json).movedToFolder, undefined);
  assertEquals(lab.called('transcripts.refile'), []);
  // once the script mapped the chat to the project (studio-moved-chats.json, read only in the app), Continue from a page that
  // still sends the copy's ref opens it in the project folder, with no worktree lookups in the distro
  Deno.writeTextFileSync(`${lab.state}/${MOVED_FILE}`, JSON.stringify({ version: 1, chats: { [`claude:${r.sessionId}`]: { project: REF, from: WT_REF } } }));
  const finds = lab.called('worktree.find').length;
  const again = await b.connect('claude', WT_REF, r.sessionId);
  assertEquals([again.cwd, again.agentCwd, again.worktree], [REF, '/home/u/app', null]);
  assertEquals(lab.called('worktree.find').length, finds);
} });

Deno.test({ name: 'wsl studio: a worktree that cannot be made, or a helper without worktrees, keeps the chat in the project folder', ...T, async fn() {
  await keeperBinary();
  {
    await using lab = new WorktreeLab();
    lab.fallback = 'too much uncommitted work to copy (6000 untracked files, 1 MB)';
    const c = await lab.studio().connect('claude', REF);
    assertEquals([c.cwd, c.agentCwd, c.projectRoot, c.worktree], [REF, '/home/u/app', REF, null]);
    assertEquals(lab.host.link.spawned.find((s) => String(s.channel).startsWith('chat-'))!.cwd, '/home/u/app');
    assertEquals(lab.called('worktree.setSession'), []);
  }
  {
    await using lab = new WorktreeLab(false); // the fake helper answers worktree.* with no_method
    const c = await lab.studio().connect('claude', REF);
    assertEquals([c.cwd, c.agentCwd, c.worktree], [REF, '/home/u/app', null]);
  }
} });

Deno.test({ name: 'wsl changes: a worktree chat gets the branch view against its diff base, Discard and Merge', ...T, async fn() {
  const host = new FakeWslHost(Deno.makeTempDirSync({ prefix: 'aib-wsl-wt-changes-' }));
  host.handlers['worktree.find'] = (p) => ({ record: p.path === WT_LINUX ? { key: 'k1', path: WT_LINUX, project: '/home/u/app', branch: 'studio/chat-abcd1234', diffBase: 'u0' } : null });
  host.handlers['changes.get'] = (p) => ({ git: true, root: p.folder, scope: p.base ? 'branch' : 'uncommitted', files: [] });
  setWslHostResolver(() => host);
  try {
    const studio = { token: 't', liveState: (id: string) => ({ cwd: id === 'wt' ? WT_REF : REF }) };
    const [s1, own] = await changesResponse(studio, '/api/live/changes', { id: ['wt'] }, { 'X-Studio-Token': 't' }) as [number, Json];
    assertEquals(s1, 200);
    assertEquals(own.scope, 'branch');
    assertEquals(own.worktree, { branch: 'studio/chat-abcd1234' }); // Discard and Merge, as on Windows
    assertEquals(host.calls.find(([m]) => m === 'changes.get')![1].base, 'u0');
    const [, plain] = await changesResponse(studio, '/api/live/changes', { id: ['main'] }, { 'X-Studio-Token': 't' }) as [number, Json];
    assertEquals([plain.scope, plain.worktree], ['uncommitted', undefined]);
    const [s3] = await changesResponse(studio, '/api/live/changes', { id: ['main'], scope: ['branch'] }, { 'X-Studio-Token': 't' });
    assertEquals(s3, 400);
  } finally {
    setWslHostResolver(null);
    Deno.removeSync(host.dataDir, { recursive: true });
  }
} });
