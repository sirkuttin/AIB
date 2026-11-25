/**
 * Helpers (swarm builders) in WSL projects, without a distro (owner 2026-11-25: "make AIB helpers work in WSL projects"; the same
 * behaviour as on Windows for start, status, stop, land on end, conflicts, and work_list / work_land / work_diff / work_discard).
 *   - the distro's helper methods (wsl/helper/helpers.ts, and merge.run with held/builder) run natively here over real git on temp
 *     repos, with the real Manager, merge.ts and the subagent landing steps: what the distro's helper does with Linux git;
 *   - the Windows side (swarm/service.ts, wsl/helpers.ts, wsl/worktrees.ts) is the real Swarm over a FakeWslHost whose answers come
 *     from those methods (Linux paths mapped to the temp folders), through the flows shared with the real-distro test
 *     (_wsl_helpers_scenarios.ts: wsl_helpers_e2e_test.ts, AIB_WSL_E2E);
 *   - a distro that cannot answer is a refusal a later try may meet, never a landing in the project folder; the one-landing-per-folder
 *     key is the folder's ref, the same for a Windows-side landing and the distro's.
 * Never a real distro, never the owner's homes. Real distro runs of the same flows: wsl_helpers_e2e_test.ts.
 */
import { assert, assertEquals, assertRejects } from './_assert.ts';
import { commit, exists, read, runGit, Sandbox, write } from './_worktree_fixtures.ts';
import { HAVE_GIT } from './_git_repo.ts';
import { FakeWslHost } from './_wsl_fake.ts';
import * as wt from '../../app/server/worktrees/worktrees.ts';
import { helperMethods } from '../../app/server/wsl/helper/helpers.ts';
import { mergeMethods } from '../../app/server/wsl/helper/merge.ts';
import { worktreeMethods } from '../../app/server/wsl/helper/worktrees.ts';
import { RpcError } from '../../app/server/wsl/helper/rpc.ts';
import { setWslHostResolver } from '../../app/server/wsl/access.ts';
import { WslHelperError } from '../../app/server/wsl/contract.ts';
import * as wh from '../../app/server/wsl/helpers.ts';
import { conflicts, type Env, startAndLand, stopAndUnlandedWork, twoHelpersOneFolder } from './_wsl_helpers_scenarios.ts';

type Json = Record<string, unknown>;
const T = { sanitizeResources: false, sanitizeOps: false, ignore: !HAVE_GIT };

Deno.env.set('AIB_WSL_ROOT', '/tmp/aib-wsl-test-fake');

const LINUX_BASE = '/home/u/lab';

/** A temp repo and data folder standing in for the distro: a FakeWslHost answering from the real helper methods. */
class FakeDistro implements Env {
  readonly distro = 'ubuntu';
  readonly box = new Sandbox();
  readonly host: FakeWslHost;
  readonly helper: ReturnType<typeof helperMethods>;
  readonly wtm: ReturnType<typeof worktreeMethods>;
  readonly mm: ReturnType<typeof mergeMethods>;

  constructor() {
    runGit(this.box.project, 'config', 'core.autocrlf', 'false');
    this.host = new FakeWslHost(this.box.base + '\\unused-keeper');
    this.host.folders.set(LINUX_BASE, this.box.base);
    this.helper = helperMethods(this.box.state);
    this.wtm = worktreeMethods(this.box.state);
    this.mm = mergeMethods(this.box.state);
    const win = (linux: unknown) => this.host.windowsFor(String(linux));
    const lin = (
      w: unknown,
    ) => (typeof w === 'string' && w.startsWith(this.box.base) ? LINUX_BASE + w.slice(this.box.base.length).replaceAll('\\', '/') : w);
    const mapRecord = (r: Json | null) => (r ? { ...r, path: lin(r.path), project: lin(r.project) } : r);
    const states = (s: unknown) =>
      Object.fromEntries(Object.entries((s ?? {}) as Json).map(([k, v]) => [k, { ...(v as Json), cwd: win((v as Json).cwd) }]));
    const h = this.host.handlers;
    h['worktree.plan'] = async (p) => {
      const out = await this.wtm['worktree.plan']({ ...p, project: win(p.project) }) as { plan: Json | null; reason: string };
      return out.plan ? { ...out, plan: { ...out.plan, project: lin(out.plan.project), path: lin(out.plan.path) } } : out;
    };
    h['worktree.create'] = (p) =>
      this.wtm['worktree.create']({
        plan: { ...(p.plan as Json), project: win((p.plan as Json).project), path: win((p.plan as Json).path) },
      });
    h['worktree.find'] = async (p) => ({
      record: mapRecord(
        ((await this.wtm['worktree.find']({ ...p, path: p.path ? win(p.path) : p.path })) as { record: Json | null }).record,
      ),
    });
    h['worktree.remove'] = (p) => this.wtm['worktree.remove'](p);
    h['merge.run'] = (p) => this.mm['merge.run']({ ...p, state: { ...(p.state as Json), cwd: win((p.state as Json).cwd) } });
    h['helper.keep'] = (p) => this.helper['helper.keep'](p);
    h['helper.land'] = (p) => this.helper['helper.land']({ ...p, states: states(p.states) });
    h['helper.facts'] = (p) =>
      this.helper['helper.facts']({ ...p, ...(p.project ? { project: win(p.project) } : {}), ...(p.path ? { path: win(p.path) } : {}) });
    h['helper.work'] = (p) => this.helper['helper.work'](p);
    h['helper.branch'] = (p) => this.helper['helper.branch']({ ...p, project: win(p.project) });
    h['helper.apply'] = (p) => this.helper['helper.apply']({ ...p, project: win(p.project), states: states(p.states) });
    setWslHostResolver((d) => (d === 'ubuntu' ? this.host : null));
  }

  newRepo(): Promise<string> {
    return Promise.resolve(LINUX_BASE + '/proj');
  }

  git(dir: string, ...args: string[]): Promise<string> {
    return Promise.resolve(runGit(this.host.windowsFor(dir), ...args).trim());
  }

  write(dir: string, name: string, text: string): Promise<void> {
    write(this.host.windowsFor(dir), name, text);
    return Promise.resolve();
  }

  read(dir: string, name: string): Promise<string> {
    return Promise.resolve(read(this.host.windowsFor(dir), name));
  }

  exists(linux: string): Promise<boolean> {
    return Promise.resolve(exists(this.host.windowsFor(linux)));
  }

  dispose(): Promise<void> {
    setWslHostResolver(null);
    this.box[Symbol.dispose]();
    return Promise.resolve();
  }
}

async function withDistro(run: (env: FakeDistro) => Promise<void>): Promise<void> {
  const env = new FakeDistro();
  try {
    await run(env);
  } finally {
    await env.dispose();
  }
}

// ---- the flows, through the real Swarm ------------------------------------------------------------------------------------------
Deno.test({
  name: 'wsl helpers (fakes): start, status, report, land on end, and the copy removed once its chat closed',
  ...T,
  fn: () => withDistro(startAndLand),
});
Deno.test({
  name: 'wsl helpers (fakes): conflicts, the helper resolves while open; a closed helper leaves a landable branch',
  ...T,
  fn: () => withDistro(conflicts),
});
Deno.test({
  name: 'wsl helpers (fakes): stop keeps the work; work_list, work_diff, work_land and work_discard on a stopped helper',
  ...T,
  fn: () => withDistro(stopAndUnlandedWork),
});
Deno.test({
  name: 'wsl helpers (fakes): two helpers of one folder land one after the other; Undo and Merge again',
  ...T,
  fn: () => withDistro(twoHelpersOneFolder),
});

// ---- the distro's helper methods, natively ---------------------------------------------------------------------------------------
async function helperBox(box: Sandbox) {
  runGit(box.project, 'config', 'core.autocrlf', 'false');
  const manager = new wt.Manager(box.state);
  const { plan } = await manager.planWithReason(box.project, 'a'.repeat(32), 'helper', { onFolderBranch: true });
  await manager.create(plan!);
  return { path: plan!.path, key: plan!.key, branch: plan!.branch };
}

Deno.test({
  name: 'wsl helper helper.*: keep commits the work, facts read it, land lands, branch and apply work, all by the record',
  ...T,
  async fn() {
    using box = new Sandbox();
    const c = await helperBox(box);
    const h = helperMethods(box.state);
    assertEquals(c.branch.startsWith('studio/helper-'), true);
    write(c.path, 'a.txt', 'the helper wrote this line\n');
    assertEquals(((await h['helper.keep']({ key: c.key, message: 'AIB: helper stopped, work kept' })) as Json).commits, 1);
    assertEquals(runGit(box.project, 'log', '-1', '--format=%s', c.branch).trim(), 'AIB: helper stopped, work kept');
    const facts = await h['helper.facts']({ key: c.key }) as Json;
    assertEquals([facts.projectExists, facts.worktreeExists, facts.target, facts.commits, facts.files, facts.dirty], [
      true,
      true,
      'main',
      1,
      ['a.txt'],
      0,
    ]);
    assertEquals(facts.branchInTarget, false);
    const worked = await h['helper.work']({ key: c.key, op: 'status' }) as Json;
    assertEquals([worked.files, worked.landed], [['a.txt'], false]);
    const landed = await h['helper.land']({ key: c.key, id: 'hx_1', target: 'main', parent: 'p1', title: 'A', held: [], states: {} }) as {
      outcome: Json;
      counted: number;
      branchTip: string;
      journal: Json[];
    };
    assertEquals(landed.outcome.state, 'merged', JSON.stringify(landed.outcome));
    assertEquals([landed.counted, landed.journal.map((j) => j.stage)], [1, ['built', 'moved']]);
    assertEquals(runGit(box.project, 'show', 'main:a.txt'), 'the helper wrote this line\n');
    const after = await h['helper.facts']({
      key: c.key,
      landed: landed.outcome.landed as string,
      tipBefore: landed.outcome.tipBefore as string,
    }) as Json;
    // landed as one squashed commit: the branch tip is not in the target, but its tree is what landed
    assertEquals([after.branchInTarget, after.sameTreeAsLanded, after.landedInTarget, after.changed], [false, true, true, ['a.txt']]);
    // Undo and Merge again, built in the distro
    const undo = await h['helper.apply']({
      project: box.project,
      branch: 'main',
      from: landed.outcome.landed,
      to: landed.outcome.tipBefore,
      message: 'AIB: undo',
      noStash: true,
      held: [],
      states: {},
      title: 'A',
    }) as { outcome: Json };
    assertEquals(undo.outcome.state, 'done', JSON.stringify(undo.outcome));
    assertEquals(exists(box.project + '\\a.txt'), false);
    // the helper's branch goes, and only a helper branch
    assertEquals(
      ((await h['helper.branch']({ project: box.project, branch: c.branch })) as Json).dropped,
      false,
      'a branch a worktree holds is not dropped',
    );
    await assertRejects(() => Promise.resolve(h['helper.branch']({ project: box.project, branch: 'main' })), RpcError);
  },
});

Deno.test({
  name: 'wsl helper helper.*: conflicts leave a landable branch, discard keeps work on studio/discarded, bad params are refused',
  ...T,
  async fn() {
    using box = new Sandbox();
    const c = await helperBox(box);
    const h = helperMethods(box.state);
    commit(c.path, 'tracked.txt', 'helper line\n', 'helper edit');
    commit(box.project, 'tracked.txt', 'main line\n', 'main edit');
    const lost = await h['helper.land']({ key: c.key, id: 'hx_1', target: 'main', parent: 'p1', title: 'A', held: [], states: {} }) as {
      outcome: Json;
    };
    assertEquals([lost.outcome.state, lost.outcome.files, lost.outcome.landable], ['conflicts', ['tracked.txt'], `${c.branch}-landable`]);
    const work = await h['helper.work']({ key: c.key, op: 'status' }) as Json;
    assertEquals(work.landable, `${c.branch}-landable`);
    const kept = await h['helper.work']({ key: c.key, op: 'keep', name: 'hx_1' }) as Json;
    assertEquals(kept.branch, 'studio/discarded/hx_1');
    assertEquals(runGit(box.project, 'show', 'studio/discarded/hx_1:tracked.txt'), 'helper line\n');
    // nothing from the channel can name another worktree, branch or path
    for (const bad of [{ key: '../x' }, { key: 'x' }, { key: 'a'.repeat(70) }]) {
      await assertRejects(() => Promise.resolve(h['helper.keep'](bad as Json)), RpcError);
    }
    await assertRejects(
      () => Promise.resolve(h['helper.land']({ key: c.key, id: 'x', target: '--upload-pack=x', parent: 'p', held: [], states: {} })),
      RpcError,
    );
    await assertRejects(() => Promise.resolve(h['helper.facts']({ project: 'relative/path', branch: 'studio/helper-abc' })), RpcError);
    await assertRejects(
      () => Promise.resolve(h['helper.facts']({ project: '/mnt/c/Users/me/proj', branch: 'studio/helper-abc' })),
      RpcError,
    );
    await assertRejects(() => Promise.resolve(h['helper.facts']({ project: box.project, branch: 'main' })), RpcError);
    const missing = await h['helper.keep']({ key: 'b'.repeat(32) }) as Json;
    assertEquals(missing.commits, 0, 'a key with no record is nothing');
    // a record that is a chat's copy, not a helper's, is refused
    const manager = new wt.Manager(box.state);
    const { plan } = await manager.planWithReason(box.project, 'c'.repeat(32), 'chat');
    await manager.create(plan!);
    await assertRejects(() => Promise.resolve(h['helper.keep']({ key: plan!.key })), RpcError);
  },
});

Deno.test({
  name: "wsl helper merge.run: held and builder run the helper landing, the journal comes back, and the chat's own merge is unchanged",
  ...T,
  async fn() {
    using box = new Sandbox();
    const c = await helperBox(box);
    const mm = mergeMethods(box.state);
    commit(c.path, 'h.txt', 'h\n', 'helper work');
    const state = { state: 'ready', busy: false, cwd: c.path, provider: 'codex' };
    const out = await mm['merge.run']({ chat: 'helperchat1', state, title: 'A', held: ['parent1'], builder: true }) as {
      result: Json;
      journal: { stage: string; data: Json }[];
    };
    assertEquals(out.result.state, 'merged', JSON.stringify(out.result));
    assertEquals(out.journal.map((j) => j.stage), ['built', 'moved']);
    assertEquals(typeof out.journal[0].data.tipBefore, 'string');
    assertEquals(runGit(box.project, 'show', 'main:h.txt'), 'h\n');
    const plain = await mm['merge.run']({ chat: 'helperchat1', state, title: 'A' }) as Json;
    assertEquals('journal' in plain, false, 'a plain merge has no journal');
  },
});

// ---- the Windows side, answers that cannot be had ---------------------------------------------------------------------------------
Deno.test({
  name: 'wsl helpers (Windows side): a distro that cannot answer is a refusal or no facts, never a guess',
  ...T,
  async fn() {
    using box = new Sandbox();
    const host = new FakeWslHost(box.base + '\\unused-keeper');
    setWslHostResolver((d) => (d === 'ubuntu' ? host : null));
    try {
      host.handlers['helper.land'] = () => {
        throw new WslHelperError('the distro stopped', 'stopped');
      };
      const aib = { stateDir: box.state, liveState: () => null, liveCall: () => [200, {}] as [number, unknown] };
      const out = await wh.wslHelperLand(aib, {
        distro: 'ubuntu',
        key: 'k'.repeat(10),
        id: 'hx',
        target: 'main',
        parent: 'p',
        title: 'T',
        held: [],
      }, () => {});
      assertEquals([out.outcome.state, out.outcome.code], ['refused', 'wsl_unavailable']);
      host.handlers['helper.land'] = () => {
        throw new WslHelperError('no such method', 'no_method');
      };
      const old = await wh.wslHelperLand(aib, {
        distro: 'ubuntu',
        key: 'k'.repeat(10),
        id: 'hx',
        target: 'main',
        parent: 'p',
        title: 'T',
        held: [],
      }, () => {});
      assertEquals(old.outcome.message, "this distro's AIB helper is too old to land helpers");
      host.handlers['helper.facts'] = () => {
        throw new WslHelperError('the distro stopped', 'stopped');
      };
      assertEquals(await wh.wslHelperFacts('ubuntu', { project: '/p', branch: 'studio/helper-a' }), null);
      host.handlers['helper.work'] = () => {
        throw new WslHelperError('no such method', 'no_method');
      };
      assert((await wh.wslHelpersAvailable('ubuntu')).includes('too old'));
      host.handlers['helper.work'] = () => ({ files: [], landed: false, target: '' });
      assertEquals(await wh.wslHelpersAvailable('ubuntu'), '');
      host.handlers['helper.keep'] = () => {
        throw new WslHelperError('the distro stopped', 'stopped');
      };
      assertEquals(await wh.wslHelperKeep('ubuntu', 'k'.repeat(10), 'm'), 0);
      host.handlers['worktree.remove'] = () => {
        throw new WslHelperError('the distro stopped', 'stopped');
      };
      assertEquals(await wh.wslHelperRemove('ubuntu', 'k'.repeat(10)), 'gone');
      assertEquals(runGit(box.project, 'status', '--porcelain').trim(), '', 'the project folder was never touched');
    } finally {
      setWslHostResolver(null);
    }
  },
});
