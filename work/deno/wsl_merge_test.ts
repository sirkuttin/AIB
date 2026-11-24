/**
 * Merge for WSL chats' worktrees without a distro (docs/wsl/design.md section 4 phase 2, section 5 item 1):
 *   - the helper's merge.* methods (wsl/helper/merge.ts) over the real Manager and merge.ts, run natively here on a temp repo: the
 *     chat's state comes with the call, merge.ts's live calls come back as actions (the conflict prompt marked `must`);
 *   - the Windows side (wsl/merge.ts) with a FakeWslHost whose merge.* answers come from those real methods (Linux paths mapped to
 *     the temp folders): a clean merge posts the "Merged into" note in the chat, a conflict prompts it (and a prompt the chat does not
 *     take is a refusal, as on Windows), the user's uncommitted edits in the main checkout are stashed and put back (a clash keeps
 *     them in the named stash, and the clash line and Keep my version work), a merge in progress in the main checkout is refused with
 *     the Windows line (the Merge button and its queued message are gone: owner, 2026-11-16);
 *   - the routes send a WSL chat to its helper and every other chat to merge.ts; the Merge button's request route is gone.
 * Never a real distro, never the owner's homes.
 */
import { assert, assertEquals, assertRejects } from './_assert.ts';
import { commit, read, runGit, Sandbox, write } from './_worktree_fixtures.ts';
import { HAVE_GIT } from './_git_repo.ts';
import { FakeWslHost } from './_wsl_fake.ts';
import * as wt from '../../app/server/worktrees/worktrees.ts';
import * as m from '../../app/server/worktrees/merge.ts';
import { mergeMethods } from '../../app/server/wsl/helper/merge.ts';
import { RpcError } from '../../app/server/wsl/helper/rpc.ts';
import * as wm from '../../app/server/wsl/merge.ts';
import { setWslHostResolver } from '../../app/server/wsl/access.ts';
import { WslHelperError } from '../../app/server/wsl/contract.ts';
import { aibRoutes } from '../../app/server/web/aib_routes.ts';
import { pathOf } from '../../app/server/state/paths.ts';

type Json = Record<string, unknown>;
const T = { sanitizeResources: false, sanitizeOps: false, ignore: !HAVE_GIT };

Deno.env.set('AIB_WSL_ROOT', '/tmp/aib-wsl-test-fake');

/** A temp repo with one worktree chat made by the real Manager, as the helper makes it in the distro. */
async function chatBox(box: Sandbox): Promise<{ wt: string; key: string }> {
  runGit(box.project, 'config', 'core.autocrlf', 'false');
  const manager = new wt.Manager(box.state);
  const plan = (await manager.plan(box.project, 'b'.repeat(32)))!;
  await manager.create(plan);
  return { wt: plan.path, key: plan.key };
}

const ready = (cwd: string, extra: Json = {}) => ({ state: 'ready', busy: false, cwd, provider: 'claude', ...extra });

// ---- the helper's methods ------------------------------------------------------------------------------------------------
Deno.test({ name: 'wsl helper merge.*: status, a clean merge with its note as an action, then nothing to merge', ...T, async fn() {
  using box = new Sandbox();
  const c = await chatBox(box);
  const h = mergeMethods(box.state);
  commit(c.wt, 'chat.txt', 'chat\n', 'chat work');
  const status = (await h['merge.status']({ chat: 'c1', state: ready(c.wt) }) as Json).result as Json;
  assertEquals([status.worktree, status.enabled, status.state, status.label], [true, true, 'ready', 'Merge into main']);
  const done = await h['merge.run']({ chat: 'c1', state: ready(c.wt), fromTool: true }) as Json;
  const result = done.result as Json;
  assertEquals([result.state, result.message, result.target, result.started], ['merged', 'Merged into main (1 commit)', 'main', 'main']);
  assertEquals(done.actions, [{ op: 'worktree-note', payload: { message: 'Merged into main (1 commit)', id: 'c1' } }]);
  assertEquals(runGit(box.project, 'log', '-1', '--format=%s', 'main').trim(), 'chat work');
  const after = (await h['merge.status']({ chat: 'c1', state: ready(c.wt) }) as Json).result as Json;
  assertEquals(after.state, 'nochanges');
  const empty = await h['merge.run']({ chat: 'c1', state: ready(c.wt) }) as Json;
  assertEquals(empty.refused, { message: 'Nothing to merge into main', code: 'empty', status: 409, extra: {} });
  assertEquals(empty.actions, []);
} });

Deno.test({ name: 'wsl helper merge.*: a conflict records it and hands back the prompt as a must; a busy chat and bad params are refused', ...T, async fn() {
  using box = new Sandbox();
  const c = await chatBox(box);
  const h = mergeMethods(box.state);
  commit(c.wt, 'tracked.txt', 'chat line\n', 'chat edit');
  commit(box.project, 'tracked.txt', 'main line\n', 'main edit');
  const busy = await h['merge.run']({ chat: 'c1', state: ready(c.wt, { busy: true }) }) as Json;
  assertEquals((busy.refused as Json).message, 'Wait for the chat to finish its turn');
  const done = await h['merge.run']({ chat: 'c1', state: ready(c.wt), title: 'T' }) as Json;
  assertEquals([(done.result as Json).state, (done.result as Json).message], ['conflicts', m.WAITING]);
  const actions = done.actions as Json[];
  assertEquals(actions.length, 1);
  assertEquals([actions[0].op, actions[0].must, actions[0].fail], ['prompt', true, 'Could not ask the chat to resolve the conflicts: ']);
  assert(String((actions[0].payload as Json).text).startsWith('Bringing main into this branch left merge conflicts in: tracked.txt'));
  assertEquals(new wt.Registry(box.state).get(c.key)?.mergeConflicts, ['tracked.txt']);
  assertEquals((h as Record<string, unknown>)['merge.request'], undefined, 'the Merge button is gone: no request method');
  for (const bad of [{ chat: 'c1', state: ready('relative/wt') }, { chat: '', state: ready(c.wt) }, { chat: 'c1', state: 'x' }]) {
    await assertRejects(() => Promise.resolve(h['merge.run'](bad as Json)), RpcError);
  }
  const outside = (await h['merge.status']({ chat: 'c2', state: ready(box.project) }) as Json).result;
  assertEquals(outside, { worktree: false }, 'a chat in the project folder has no Merge');
} });

// ---- the Windows side, over a FakeWslHost answering from the real helper methods ------------------------------------------
const LINUX_BASE = '/home/u/lab';

class MergeLab {
  readonly host: FakeWslHost;
  readonly helper: ReturnType<typeof mergeMethods>;
  readonly calls: [string, Json][] = [];
  answer: [number, unknown] = [200, {}];
  queued = false;
  readonly states = new Map<string, Json>();

  constructor(readonly box: Sandbox) {
    this.host = new FakeWslHost(box.base + '\\unused-keeper');
    this.host.folders.set(LINUX_BASE, box.base);
    this.helper = mergeMethods(box.state);
    const mapped = (p: Json) => ({ ...p, state: { ...(p.state as Json), cwd: this.host.windowsFor(String((p.state as Json).cwd)) } });
    for (const name of ['merge.status', 'merge.run', 'merge.resolveClash'] as const) {
      this.host.handlers[name] = (p) => this.helper[name](mapped(p));
    }
    this.host.handlers['merge.clashStatus'] = (p) => this.helper['merge.clashStatus']({ project: this.host.windowsFor(String(p.project)) });
    setWslHostResolver((d) => (d === 'ubuntu' ? this.host : null));
  }

  /** The ref of a Windows folder inside the lab (as the distro would name it). */
  ref(windows: string): string {
    return 'wsl://ubuntu' + LINUX_BASE + windows.slice(this.box.base.length).replaceAll('\\', '/');
  }

  readonly studio: m.MergeStudio = {
    stateDir: '',
    liveState: (id) => (this.states.has(id) ? { ...this.states.get(id) } : null),
    liveCall: (op, payload) => {
      this.calls.push([op, payload]);
      return op === 'queue' ? [this.answer[0], { ...(this.answer[1] as Json), queued: this.queued }] : this.answer;
    },
  };

  async chat(id: string, wtPath: string, extra: Json = {}): Promise<wm.WslMergeChat> {
    this.states.set(id, ready(this.ref(wtPath), extra));
    return (await wm.wslMergeChat(this.studio, id))!;
  }

  ops(): string[] {
    return this.calls.map(([op]) => op);
  }

  [Symbol.dispose](): void {
    setWslHostResolver(null);
  }
}

Deno.test({ name: 'wsl merge: a clean merge runs in the helper and posts the "Merged into" note in the chat; the user\'s edits stay', ...T, async fn() {
  using box = new Sandbox();
  const c = await chatBox(box);
  using lab = new MergeLab(box);
  commit(c.wt, 'chat.txt', 'chat\n', 'chat work');
  write(box.project, 'mine.txt', 'my own unsaved work\n'); // uncommitted in the main checkout: stashed and put back, never overwritten
  write(box.project, '.gitignore', 'ignored.log\nbuild/\nnode_modules/\nlocal.env\n');
  const chat = await lab.chat('c1', c.wt);
  assertEquals([chat.distro, chat.linuxPath], ['ubuntu', lab.ref(c.wt).slice('wsl://ubuntu'.length)]);
  assertEquals(await wm.wslMergeChat(lab.studio, 'nope'), null);
  lab.states.set('win', ready(box.project));
  assertEquals(await wm.wslMergeChat(lab.studio, 'win'), null, 'a Windows chat stays with merge.ts');

  const status = await wm.wslMergeStatus(chat);
  assertEquals([status.enabled, status.state, status.base], [true, 'ready', 'main']);
  const result = await wm.wslMerge(lab.studio, chat, '', true);
  assertEquals([result.state, result.message, result.commits], ['merged', 'Merged into main (1 commit)', 1]);
  assertEquals(lab.calls, [['worktree-note', { message: 'Merged into main (1 commit)', id: 'c1' }]]);
  assertEquals(runGit(box.project, 'show', 'main:chat.txt'), 'chat\n');
  assertEquals(read(box.project, 'mine.txt'), 'my own unsaved work\n');
  assertEquals(read(box.project, '.gitignore'), 'ignored.log\nbuild/\nnode_modules/\nlocal.env\n');
  assertEquals(box.stashes(), []);
  assertEquals(wm.wslMergesRunning(), 0);
  // the state the helper got: the Linux folder, no message text
  const sent = lab.host.calls.find(([name]) => name === 'merge.run')![1];
  assertEquals((sent.state as Json).cwd, chat.linuxPath);
  assertEquals(sent.fromTool, true);
} });

Deno.test({ name: 'wsl merge: a conflict prompts the chat; a prompt it does not take is refused as on Windows; resolved, it merges', ...T, async fn() {
  using box = new Sandbox();
  const c = await chatBox(box);
  using lab = new MergeLab(box);
  commit(c.wt, 'tracked.txt', 'chat line\n', 'chat edit');
  commit(box.project, 'tracked.txt', 'main line\n', 'main edit');
  lab.answer = [409, { error: 'The chat is closed' }];
  const chat = await lab.chat('c1', c.wt, { queue: { items: [] }, clientCaps: { terminals: [] }, subagents: {} });
  const refused = await assertRejects(() => wm.wslMerge(lab.studio, chat, 'T'), m.Refused) as m.Refused;
  assertEquals([refused.code, refused.message], ['prompt_failed', 'Could not ask the chat to resolve the conflicts: The chat is closed']);
  // the button's state while the conflict is open
  const waiting = await wm.wslMergeStatus(chat);
  assertEquals([waiting.state, waiting.message, waiting.files], ['conflicts', m.WAITING, ['tracked.txt']]);
  // the agent's tool sees the conflict line, not a prompt
  lab.answer = [200, {}];
  lab.calls.length = 0;
  const tool = await assertRejects(() => wm.wslMerge(lab.studio, chat, '', true), m.Refused) as m.Refused;
  assertEquals([tool.code, tool.extra.target], ['conflicts', 'main']);
  assert(tool.message.startsWith('Bringing main into this branch left merge conflicts in: tracked.txt'));
  assertEquals(lab.calls, []);
  // the chat resolves it in its worktree and commits: the next merge lands
  write(c.wt, 'tracked.txt', 'main line\nchat line\n');
  runGit(c.wt, 'add', '-A');
  runGit(c.wt, 'commit', '--no-edit', '-q');
  const done = await wm.wslMerge(lab.studio, chat, '', true);
  assertEquals(done.state, 'merged');
  assertEquals(runGit(box.project, 'show', 'main:tracked.txt'), 'main line\nchat line\n');
} });

Deno.test({ name: 'wsl merge: a clash with the user\'s unsaved edits keeps them in the stash, shows the clash line, and Keep my version restores them', ...T, async fn() {
  using box = new Sandbox();
  const c = await chatBox(box);
  using lab = new MergeLab(box);
  commit(c.wt, 'tracked.txt', 'one\nchat\n', 'chat edit');
  write(box.project, 'tracked.txt', 'one\nuser\n'); // the user's unsaved edit in the main checkout, on the same line
  const chat = await lab.chat('c1', c.wt);
  const result = await wm.wslMerge(lab.studio, chat, '', false);
  assertEquals([result.state, result.clash], ['merged', ['tracked.txt']]);
  const stash = String(result.stash);
  assert(stash.startsWith('studio-merge-chat-'), stash);
  assertEquals(lab.ops(), ['worktree-note', 'worktree-note', 'prompt']);
  assertEquals(lab.calls[1][1].actions, m.clashActions());
  assert(String(lab.calls[2][1].text).includes(stash), 'the chat is told where the edits are');
  assert(lab.calls.every(([, p]) => p.id === 'c1'));
  assertEquals(box.stashes().length, 1, "the user's edits are safe in the stash");
  const line = await wm.wslClashStatus(lab.ref(box.project));
  assertEquals([line.unresolved, line.files, line.stash], [true, ['tracked.txt'], stash]);
  assertEquals(await wm.wslClashStatus('wsl://debian/home/u/app'), { unresolved: false }, 'a distro AIB does not use is not started');
  const kept = await wm.wslResolveClash(lab.studio, chat, 'keep-mine');
  assertEquals([kept.dropped, kept.files], [true, ['tracked.txt']]);
  assertEquals(read(box.project, 'tracked.txt'), 'one\nuser\n');
  assertEquals(lab.calls.at(-1)![0], 'worktree-note');
  assertEquals((await wm.wslClashStatus(lab.ref(box.project))).unresolved, false);
} });

Deno.test({ name: 'wsl merge: a merge in progress in the main checkout is refused with the Windows line, and nothing moves', ...T, async fn() {
  using box = new Sandbox();
  const c = await chatBox(box);
  using lab = new MergeLab(box);
  commit(c.wt, 'chat.txt', 'chat\n', 'chat work');
  const before = runGit(box.project, 'rev-parse', 'main').trim();
  Deno.writeTextFileSync(pathOf(box.project, '.git', 'MERGE_HEAD'), before + '\n');
  try {
    const chat = await lab.chat('c1', c.wt);
    const refused = await assertRejects(() => wm.wslMerge(lab.studio, chat, '', true), m.Refused) as m.Refused;
    assertEquals([refused.code, refused.message], ['locked', 'A merge is in progress in the folder that has the base branch']);
    assertEquals(runGit(box.project, 'rev-parse', 'main').trim(), before);
    assertEquals(lab.calls, []);
  } finally {
    Deno.removeSync(pathOf(box.project, '.git', 'MERGE_HEAD'));
  }
} });

Deno.test({ name: 'wsl merge: a distro that is not ready or a helper without merge says so', ...T, async fn() {
  using box = new Sandbox();
  const c = await chatBox(box);
  using lab = new MergeLab(box);
  commit(c.wt, 'chat.txt', 'chat\n', 'chat work');
  const chat = await lab.chat('c1', c.wt);

  lab.host.state = 'stopped';
  lab.host.note = 'Ubuntu stopped. Reconnect';
  assertEquals(await wm.wslMergeStatus(chat), { worktree: true, enabled: false, state: 'unavailable', message: 'Ubuntu stopped. Reconnect', base: '' });
  assertEquals(await wm.wslClashStatus(lab.ref(box.project)), { unresolved: false });
  lab.host.state = 'ready';
  lab.host.note = '';
  lab.host.handlers['merge.status'] = () => {
    throw new WslHelperError('no', 'unknown_method');
  };
  lab.host.handlers['merge.run'] = () => {
    throw new WslHelperError('no', 'unknown_method');
  };
  assertEquals(await wm.wslMergeStatus(chat), { worktree: false });
  const none = await assertRejects(() => wm.wslMerge(lab.studio, chat), m.Refused) as m.Refused;
  assertEquals([none.code, none.status], ['no_worktree', 404]);
} });

Deno.test({ name: 'wsl merge routes: a WSL chat goes to its helper, a Windows chat to merge.ts', ...T, async fn() {
  using box = new Sandbox();
  const c = await chatBox(box);
  using lab = new MergeLab(box);
  commit(c.wt, 'chat.txt', 'chat\n', 'chat work');
  await lab.chat('c1', c.wt);
  lab.states.set('win', ready(box.project));
  const ctx = {
    stateDir: box.state,
    host: { liveState: (id: string) => lab.studio.liveState(id), liveCall: (op: string, p: Json) => lab.studio.liveCall(op, p) },
    conversations: { public: () => ({ entries: {} }) },
  } as never;
  const routes = aibRoutes();
  const get = (path: string) => routes.get(`GET ${path.split('?')[0]}`)!(ctx, new URL('http://127.0.0.1' + path), null, new Request('http://127.0.0.1'));
  const post = (path: string, body: Json) => routes.get(`POST ${path}`)!(ctx, new URL('http://127.0.0.1' + path), body, new Request('http://127.0.0.1'));
  const [s1, status] = await get('/api/live/worktree?id=c1');
  assertEquals([s1, (status as Json).state, (status as Json).base], [200, 'ready', 'main']);
  assertEquals((await get('/api/live/worktree?id=win'))[1], { worktree: false });
  assertEquals(routes.get('POST /api/live/worktree/merge-request'), undefined, "the Merge button's request route is gone");
  assertEquals((await get('/api/live/worktree/clash?project=' + encodeURIComponent(lab.ref(box.project))))[1], { unresolved: false });
  assertEquals(await post('/api/live/worktree/clash', { action: 'resume-sync', project: lab.ref(box.project) }), [200, { ok: true, resumed: false }]);
  const [s3, merged] = await post('/api/live/worktree/merge', { id: 'c1', title: 'T' });
  assertEquals([s3, (merged as Json).message], [200, 'Merged into main (1 commit)']);
  const [s4, again] = await post('/api/live/worktree/merge', { id: 'c1' });
  assertEquals([s4, (again as Json).code], [409, 'empty']);
  assert(lab.host.calls.filter(([name]) => name.startsWith('merge.')).length >= 3);
} });
