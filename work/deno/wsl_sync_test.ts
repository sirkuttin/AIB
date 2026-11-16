/**
 * Live sync for WSL chats' worktrees without a distro (docs/wsl/design.md section 4 phase 2, section 5 item 1):
 *   - the helper's sync.* methods (wsl/helper/sync.ts) over the real Manager, sync.ts and merge.ts, run natively here on a temp repo:
 *     a user edit reaches the chat's copy, an edit both sides made is merged at the turn boundary, a clash is kept with its markers
 *     and shows as the clash line, the note for the next prompt, the set of open chats is kept in a file and a new helper watches the
 *     same chats again and catches up, the storm pause shows on the amber line and Resume ends it, bad params are refused;
 *   - the Windows side (wsl/sync.ts) over a FakeWslHost whose sync.* answers come from those real methods (Linux paths mapped to the
 *     temp folders): a WSL chat's open/close sends the set, the turn hooks carry the chat's state with its Linux folder (no message
 *     text), the note comes back for the prompt, the periodic set brings a restarted helper back, a distro that is not ready or a helper
 *     without sync.* is skipped quietly, the Resume route goes to the helper, and a Windows chat never comes here.
 * Never a real distro, never the owner's homes.
 */
import { assert, assertEquals, assertRejects } from './_assert.ts';
import { commit, read, runGit, Sandbox, write } from './_worktree_fixtures.ts';
import { HAVE_GIT } from './_git_repo.ts';
import { FakeWslHost } from './_wsl_fake.ts';
import * as wt from '../../outputs/agent-studio/server/worktrees/worktrees.ts';
import { CHATS_FILE, HelperSync, syncMethods } from '../../outputs/agent-studio/server/wsl/helper/sync.ts';
import { mergeMethods } from '../../outputs/agent-studio/server/wsl/helper/merge.ts';
import { RpcError } from '../../outputs/agent-studio/server/wsl/helper/rpc.ts';
import { WslSync, wslSyncChat, wslSyncSettings } from '../../outputs/agent-studio/server/wsl/sync.ts';
import { setWslHostResolver } from '../../outputs/agent-studio/server/wsl/access.ts';
import { WslHelperError } from '../../outputs/agent-studio/server/wsl/contract.ts';
import { studioRoutes } from '../../outputs/agent-studio/server/web/studio_routes.ts';
import { syncPoll } from '../../outputs/agent-studio/server/wsl/helper_main.ts';
import { pathOf } from '../../outputs/agent-studio/server/state/paths.ts';

type Json = Record<string, unknown>;
const T = { sanitizeResources: false, sanitizeOps: false, ignore: !HAVE_GIT };
const LINES = 'a\nb\nc\nd\ne\nf\n';

Deno.env.set('AIB_WSL_ROOT', '/tmp/aib-wsl-test-fake');

async function until(check: () => unknown | Promise<unknown>, what: string, seconds = 20): Promise<void> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

function text(folder: string, name: string): string | null {
  try {
    return read(folder, name);
  } catch {
    return null;
  }
}

/** A temp repo with f.txt and one worktree chat made by the real Manager, as the helper makes it in the distro. */
async function chatBox(box: Sandbox, key = 'b'.repeat(32)): Promise<{ wt: string; key: string }> {
  runGit(box.project, 'config', 'core.autocrlf', 'false');
  commit(box.project, 'f.txt', LINES, 'add f');
  const manager = new wt.Manager(box.state);
  const plan = (await manager.plan(box.project, key))!;
  await manager.create(plan);
  return { wt: plan.path, key: plan.key };
}

const ready = (cwd: string, extra: Json = {}) => ({ state: 'ready', busy: false, cwd, provider: 'claude', ...extra });
const fast = (data: string, watch = false) => new HelperSync(data, { settle: 0.05, poll: 0.2, watch });

// ---- the helper's methods ------------------------------------------------------------------------------------------------
Deno.test({ name: 'wsl helper sync.*: a user edit reaches the chat\'s copy; the note for the next prompt; sent once', ...T, async fn() {
  using box = new Sandbox();
  const c = await chatBox(box);
  const sync = fast(box.state);
  const h = syncMethods(sync);
  try {
    assertEquals(await h['sync.chats']({ chats: [{ chat: 'c1', cwd: c.wt }] }), { chats: 1, added: ['c1'], removed: [] });
    await until(() => sync.live.projects.size === 1, 'the project is watched');
    await new Promise((r) => setTimeout(r, 400)); // the baseline scan
    write(box.project, 'f.txt', 'A-user\nb\nc\nd\ne\nf\n');
    write(box.project, 'new.txt', 'new from the user\n');
    await until(() => text(c.wt, 'f.txt') === 'A-user\nb\nc\nd\ne\nf\n' && text(c.wt, 'new.txt') !== null, 'the edits reach the copy');
    await until(() => (new wt.Registry(box.state).get(c.key)?.syncedPaths as string[] | undefined)?.length === 2, 'U moved');
    const record = new wt.Registry(box.state).get(c.key)!;
    assertEquals(await wt.touchedPaths(c.wt, wt.diffBase(record)), [], "the chat's Changes stay empty: U moved with them");
    const context = (await h['sync.contextFor']({ chat: 'c1', state: ready(c.wt) }) as Json).context as [string, Json];
    assert(context[0].startsWith('<studio-context>The user changed these files since your last turn: '), context[0]);
    assert(context[0].includes('f.txt') && context[0].includes('new.txt'), context[0]);
    await h['sync.contextSent']({ chat: 'c1', state: ready(c.wt), token: context[1] });
    assertEquals((await h['sync.contextFor']({ chat: 'c1', state: ready(c.wt) }) as Json).context, null, 'the note goes once');
    const status = sync.status() as { chats: Json[]; projects: Json[] };
    assertEquals(status.chats, [{ chat: 'c1', cwd: c.wt }]);
    assertEquals(status.projects.map((p) => p.project), [box.project]);
    // the chat goes: nothing is watched, the file says so
    assertEquals(await h['sync.chats']({ chats: [] }), { chats: 0, added: [], removed: ['c1'] });
    await until(() => sync.live.projects.size === 0, 'the watcher stops');
    assertEquals(sync.saved(), []);
  } finally {
    await sync.live.stopAll();
  }
} });

Deno.test({ name: 'wsl helper sync.*: an edit both made is merged at the turn end; a clash keeps its markers and shows as the clash line', ...T, async fn() {
  using box = new Sandbox();
  const c = await chatBox(box);
  const sync = fast(box.state);
  const h = syncMethods(sync);
  const merge = mergeMethods(box.state);
  try {
    // the chat edits the last line in its copy (a turn running), the user the first line in the main checkout
    await h['sync.turnStarted']({ chat: 'c1', state: ready(c.wt) }); // an unknown chat is added (a helper restarted meanwhile)
    assertEquals(sync.status().chats, [{ chat: 'c1', cwd: c.wt }]);
    await new Promise((r) => setTimeout(r, 400));
    write(c.wt, 'f.txt', 'a\nb\nc\nd\ne\nf-chat\n');
    write(box.project, 'f.txt', 'A-user\nb\nc\nd\ne\nf\n');
    await until(() => (new wt.Registry(box.state).get(c.key)?.pendingSync as string[] | undefined)?.includes('f.txt'), 'pending');
    assertEquals(text(c.wt, 'f.txt'), 'a\nb\nc\nd\ne\nf-chat\n', "the chat's edit is never overwritten");
    await h['sync.turnEnded']({ chat: 'c1', state: ready(c.wt) });
    assertEquals(text(c.wt, 'f.txt'), 'A-user\nb\nc\nd\ne\nf-chat\n', 'both edits, merged in the copy');
    // the same line on both sides: conflict markers in the copy, the user's file untouched, Merge waits with the clash line
    write(c.wt, 'f.txt', 'A-chat\nb\nc\nd\ne\nf-chat\n');
    write(box.project, 'f.txt', 'A-user2\nb\nc\nd\ne\nf\n');
    await until(() => (new wt.Registry(box.state).get(c.key)?.pendingSync as string[] | undefined)?.includes('f.txt'), 'pending again');
    await h['sync.turnEnded']({ chat: 'c1', state: ready(c.wt) });
    const merged = text(c.wt, 'f.txt')!;
    assert(merged.includes('<<<<<<< chat (your copy)') && merged.includes('A-user2'), merged);
    assertEquals(read(box.project, 'f.txt'), 'A-user2\nb\nc\nd\ne\nf\n', "the user's edit is untouched");
    assertEquals(new wt.Registry(box.state).get(c.key)?.syncConflicts, ['f.txt']);
    const status = (await merge['merge.status']({ chat: 'c1', state: ready(c.wt) }) as Json).result as Json;
    assertEquals([status.state, status.files], ['conflicts', ['f.txt']]);
    assert(String(status.message).startsWith('Waiting for the chat to resolve a clash with your edits in f.txt'), String(status.message));
    const note = (await h['sync.contextFor']({ chat: 'c1', state: ready(c.wt) }) as Json).context as [string, Json];
    assert(note[0].includes("These files have a clash between your edit and the user's: f.txt"), note[0]);
    // a busy chat: the turn-end merge waits (as on Windows)
    write(box.project, 'g.txt', 'g\n');
    await h['sync.turnEnded']({ chat: 'c1', state: ready(c.wt, { busy: true, clientCaps: { terminals: [{ id: 't', status: 'running' }] } }) });
  } finally {
    await sync.live.stopAll();
  }
} });

Deno.test({ name: 'wsl helper sync.*: a new helper watches the saved chats again and catches up on what changed while none ran', ...T, async fn() {
  using box = new Sandbox();
  const c = await chatBox(box);
  const first = fast(box.state);
  await syncMethods(first)['sync.chats']({ chats: [{ chat: 'c1', cwd: c.wt }, { chat: 'gone', cwd: pathOf(box.base, 'no-such-worktree') }] });
  await first.live.stopAll(); // the helper ends (killed, or replaced by a new version)
  const saved = JSON.parse(Deno.readTextFileSync(pathOf(box.state, CHATS_FILE)));
  assertEquals(Object.keys(saved.chats), ['c1', 'gone']);
  write(box.project, 'f.txt', 'while-down\nb\nc\nd\ne\nf\n'); // saved while no helper ran
  const second = fast(box.state);
  try {
    assertEquals(await second.resumeSaved(), 1, 'only the chat whose worktree is there');
    await until(() => text(c.wt, 'f.txt') === 'while-down\nb\nc\nd\ne\nf\n', 'the catch-up');
    // the catch-up has moved U (a save racing it waits for the turn's merge, as on Windows)
    await until(() => (new wt.Registry(box.state).get(c.key)?.syncedPaths as string[] | undefined)?.includes('f.txt'), 'U moved');
    assertEquals(second.status().chats, [{ chat: 'c1', cwd: c.wt }]);
    assertEquals(Object.keys(JSON.parse(Deno.readTextFileSync(pathOf(box.state, CHATS_FILE))).chats), ['c1']);
    write(box.project, 'f.txt', 'after\nb\nc\nd\ne\nf\n');
    await until(() => text(c.wt, 'f.txt') === 'after\nb\nc\nd\ne\nf\n', 'watched again');
  } finally {
    await second.live.stopAll();
  }
  const none = fast(pathOf(box.base, 'empty-data'));
  assertEquals(await none.resumeSaved(), 0);
} });

Deno.test({ name: 'wsl helper sync.*: a storm pauses the project, the amber line says so, sync.resume ends it; bad params refused', ...T, async fn() {
  using box = new Sandbox();
  const c = await chatBox(box);
  const sync = fast(box.state, true); // the folder watcher too (ReadDirectoryChangesW here, inotify in the distro)
  sync.live.storm = 2;
  const h = syncMethods(sync);
  const merge = mergeMethods(box.state);
  try {
    await h['sync.chats']({ chats: [{ chat: 'c1', cwd: c.wt }] });
    await new Promise((r) => setTimeout(r, 500));
    // three new files at once: made in a folder outside the project, then moved in with one rename (no scan can see only some)
    const stage = pathOf(box.base, 'stage');
    for (const n of [1, 2, 3]) write(stage, `s${n}.txt`, `${n}\n`);
    Deno.renameSync(stage, pathOf(box.project, 'storm'));
    await until(async () => ((await merge['merge.clashStatus']({ project: box.project }) as Json).result as Json).syncPaused === true, 'paused');
    const line = (await merge['merge.clashStatus']({ project: box.project }) as Json).result as Json;
    assertEquals(line.syncLine, 'Lots of files changed in proj; live sync paused. Resume?');
    assertEquals(text(c.wt, 'storm/s1.txt'), null, 'nothing copied while paused');
    assertEquals(await h['sync.resume']({ project: box.project }), { resumed: true });
    await until(() => text(c.wt, 'storm/s3.txt') === '3\n', 'caught up after Resume');
    assertEquals(await h['sync.resume']({ project: box.project }), { resumed: false });
    const watched = (sync.status().projects as Json[])[0];
    assertEquals(watched.watching, true);
    assert(Number(watched.events) > 0, 'the watcher saw the writes');
  } finally {
    await sync.live.stopAll();
  }
  for (const bad of [{ chats: 'x' }, { chats: [{ chat: '', cwd: '/a' }] }, { chats: [{ chat: 'c', cwd: 'relative' }] }]) {
    await assertRejects(() => Promise.resolve(h['sync.chats'](bad as Json)), RpcError);
  }
  await assertRejects(() => Promise.resolve(h['sync.turnStarted']({ chat: 'c1', state: { cwd: 'rel' } })), RpcError);
  await assertRejects(() => Promise.resolve(h['sync.resume']({ project: 'rel' })), RpcError);
  assertEquals(syncPoll('120'), { poll: 120 });
  assertEquals([syncPoll(undefined), syncPoll('0'), syncPoll('x'), syncPoll('99999')], [{}, {}, {}, {}]);
} });

// ---- the Windows side, over a FakeWslHost answering from the real helper methods ------------------------------------------
const LINUX_BASE = '/home/u/lab';

class Conn {
  closed = false;
  worktree: unknown = { branch: 'studio/chat-b', base: 'main' };
  state: Json = { state: 'ready', busy: false, provider: 'claude', queue: { items: [{ text: 'secret message' }] } };
  constructor(readonly id: string, readonly cwd: string) {}
  public(): unknown {
    return { ...this.state, cwd: this.cwd };
  }
}

class SyncLab {
  readonly host: FakeWslHost;
  sync: HelperSync;
  helper: ReturnType<typeof syncMethods>;
  readonly conns = new Map<string, Conn>();
  readonly win: WslSync;
  on = true;

  constructor(readonly box: Sandbox) {
    this.host = new FakeWslHost(box.base + '\\unused-keeper');
    this.host.folders.set(LINUX_BASE, box.base);
    this.sync = fast(box.state);
    this.helper = syncMethods(this.sync);
    const map = (p: string) => this.host.windowsFor(p);
    const withState = (p: Json) => ({ ...p, state: { ...(p.state as Json), cwd: map(String((p.state as Json).cwd)) } });
    this.host.handlers['sync.chats'] = (p) => this.helper['sync.chats']({ chats: (p.chats as Json[]).map((c) => ({ ...c, cwd: map(String(c.cwd)) })) });
    for (const name of ['sync.turnStarted', 'sync.turnEnded', 'sync.contextFor', 'sync.contextSent'] as const) {
      this.host.handlers[name] = (p) => this.helper[name](withState(p));
    }
    this.host.handlers['sync.resume'] = (p) => this.helper['sync.resume']({ project: map(String(p.project)) });
    setWslHostResolver((d) => (d === 'ubuntu' ? this.host : null));
    this.win = new WslSync({ connections: this.conns, settings: { worktreePerChat: () => this.on } });
  }

  ref(windows: string): string {
    return 'wsl://ubuntu' + LINUX_BASE + windows.slice(this.box.base.length).replaceAll('\\', '/');
  }

  calls(name: string): Json[] {
    return this.host.calls.filter(([n]) => n === name).map(([, p]) => p);
  }

  /** The helper ends and a new one starts with nothing in memory (and, here, no saved list either). */
  restartHelper(): void {
    void this.sync.live.stopAll();
    Deno.removeSync(pathOf(this.box.state, CHATS_FILE));
    this.sync = fast(this.box.state);
    this.helper = syncMethods(this.sync);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.win.stopAll();
    await this.sync.live.stopAll();
    setWslHostResolver(null);
  }
}

Deno.test({ name: 'wsl sync: a WSL chat\'s open, turn hooks and close go to its helper with its Linux folder and no message text', ...T, async fn() {
  using box = new Sandbox();
  const c = await chatBox(box);
  await using lab = new SyncLab(box);
  const chat = new Conn('c1', lab.ref(c.wt));
  lab.conns.set('c1', chat);
  lab.conns.set('win', new Conn('win', box.project)); // a Windows chat: never sent
  assertEquals(wslSyncChat(lab.conns.get('win')), null);
  assertEquals(wslSyncChat(chat), { distro: 'ubuntu', linuxPath: lab.ref(c.wt).slice('wsl://ubuntu'.length) });
  await lab.win.chatOpened(chat);
  assertEquals(lab.calls('sync.chats'), [{ chats: [{ chat: 'c1', cwd: lab.ref(c.wt).slice('wsl://ubuntu'.length) }] }]);
  await until(() => lab.sync.live.projects.size === 1, 'watched in the helper');
  await new Promise((r) => setTimeout(r, 400));
  write(box.project, 'f.txt', 'A-user\nb\nc\nd\ne\nf\n');
  await until(() => text(c.wt, 'f.txt') === 'A-user\nb\nc\nd\ne\nf\n', 'the edit reaches the copy');
  await lab.win.turnStarted(chat);
  const context = await lab.win.contextFor(chat);
  assert(context && context[0].includes('The user changed these files since your last turn: f.txt'), String(context?.[0]));
  await lab.win.contextSent(chat, context![1]);
  assertEquals(await lab.win.contextFor(chat), null);
  await lab.win.turnEnded(chat);
  const sent = lab.calls('sync.turnStarted')[0];
  assertEquals((sent.state as Json).cwd, lab.ref(c.wt).slice('wsl://ubuntu'.length));
  assertEquals((sent.state as Json).queue, { items: [{}] }, 'no message text crosses');
  // closed: the helper gets the empty set and stops watching
  chat.closed = true;
  await lab.win.refresh();
  assertEquals(lab.calls('sync.chats').at(-1), { chats: [] });
  await until(() => lab.sync.live.projects.size === 0, 'the helper stops watching');
  // the old worktree-per-chat flag no longer turns sync off (build plan 1b): still on, as on Windows
  lab.on = false;
  assert(lab.win.enabled(), 'Own-copy chats keep live sync whatever the hidden flag says');
} });

Deno.test({ name: 'wsl sync: the periodic set brings a restarted helper back; a distro not ready or a helper without sync.* is skipped', ...T, async fn() {
  using box = new Sandbox();
  const c = await chatBox(box);
  await using lab = new SyncLab(box);
  const keep = wslSyncSettings.KEEP_SECONDS;
  wslSyncSettings.KEEP_SECONDS = 0.2;
  try {
    const chat = new Conn('c1', lab.ref(c.wt));
    lab.conns.set('c1', chat);
    await lab.win.chatOpened(chat);
    await until(() => lab.sync.live.projects.size === 1, 'watched');
    lab.restartHelper();
    assertEquals(lab.sync.status().chats, []);
    await until(() => lab.sync.live.projects.size === 1, 'the next set has the new helper watch again', 10);
    await new Promise((r) => setTimeout(r, 400));
    write(box.project, 'f.txt', 'after restart\nb\nc\nd\ne\nf\n');
    await until(() => text(c.wt, 'f.txt') === 'after restart\nb\nc\nd\ne\nf\n', 'synced by the new helper');
    // the distro stopped: nothing is sent and nothing throws
    lab.host.state = 'stopped';
    const before = lab.host.calls.length;
    await lab.win.refresh();
    await lab.win.turnStarted(chat);
    assertEquals(await lab.win.contextFor(chat), null);
    assertEquals(lab.host.calls.length, before);
    lab.host.state = 'ready';
    // an older helper without sync.*: no live sync, no error
    for (const name of ['sync.chats', 'sync.turnStarted', 'sync.contextFor'] as const) {
      lab.host.handlers[name] = () => {
        throw new WslHelperError('no', 'no_method');
      };
    }
    await lab.win.refresh();
    await lab.win.turnStarted(chat);
    assertEquals(await lab.win.contextFor(chat), null);
  } finally {
    wslSyncSettings.KEEP_SECONDS = keep;
  }
} });

Deno.test({ name: 'wsl sync: Resume on the amber line of a WSL project goes to its helper', ...T, async fn() {
  using box = new Sandbox();
  const c = await chatBox(box);
  await using lab = new SyncLab(box);
  lab.sync.live.storm = 1;
  const chat = new Conn('c1', lab.ref(c.wt));
  lab.conns.set('c1', chat);
  await lab.win.chatOpened(chat);
  await new Promise((r) => setTimeout(r, 400));
  const stage = pathOf(box.base, 'stage'); // two new files at once (one rename), so one scan sees both
  write(stage, 's1.txt', '1\n');
  write(stage, 's2.txt', '2\n');
  Deno.renameSync(stage, pathOf(box.project, 'storm'));
  const merge = mergeMethods(box.state);
  await until(async () => ((await merge['merge.clashStatus']({ project: box.project }) as Json).result as Json).syncPaused === true, 'paused');
  const ctx = { stateDir: box.state } as never;
  const post = studioRoutes().get('POST /api/live/worktree/clash')!;
  const url = new URL('http://127.0.0.1/api/live/worktree/clash');
  const answer = await post(ctx, url, { action: 'resume-sync', project: lab.ref(box.project) }, new Request(url));
  assertEquals(answer, [200, { ok: true, resumed: true }]);
  await until(() => text(c.wt, 'storm/s2.txt') === '2\n', 'caught up');
  assertEquals(await post(ctx, url, { action: 'resume-sync', project: 'wsl://debian/home/u/app' }, new Request(url)), [200, { ok: true, resumed: false }]);
} });
