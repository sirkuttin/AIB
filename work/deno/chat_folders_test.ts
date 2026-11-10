/**
 * server/worktrees/chat_folders.ts: the folder lookup of work/test_project_cwd.py (a saved chat Studio does not run), the response
 * cases of work/test_changes.py ChangesRouteTests, and the branch view of work/test_worktree_changes.py, driven through
 * changesResponse with a fake Studio and a real git worktree plus registry record (no manager, agent or live sync).
 * Skipped: test_worktree_changes SavedChatTests and test_main_moving_on's live-sync part (monitor.Store / ProjectResolver / Manager,
 * other modules); test_project_root.py (state_store, monitor and artifacts only, nothing of these modules).
 */
import { assert, assertEquals, assertRejects } from './_assert.ts';
import { PyParity } from './_parity.ts';
import { git, HAVE_GIT, TempRepo, write } from './_git_repo.ts';
import {
  artifactFolder,
  changesFolder,
  changesResponse,
  type ChatStudio,
  defaults,
  repoBranch,
} from '../../outputs/agent-studio/server/worktrees/chat_folders.ts';
import { MAX_FILES } from '../../outputs/agent-studio/server/worktrees/changes.ts';
import { Registry } from '../../outputs/agent-studio/server/worktrees/worktrees.ts';
import { ValueError } from '../../outputs/agent-studio/server/core/py.ts';
import * as osp from '../../outputs/agent-studio/server/platform/ospath.ts';

const test = (name: string, fn: () => Promise<void> | void) => Deno.test({ name, ignore: !HAVE_GIT, fn });
const TOKEN = 'tok';

function studio(live: Record<string, string> = {}, extra: Partial<ChatStudio> = {}): ChatStudio {
  return { liveState: (ident) => (live[ident] ? { cwd: live[ident] } : {}), token: TOKEN, ...extra };
}

type Body = Record<string, unknown>;

async function api(s: ChatStudio, ident: string, route = '/api/live/changes', args: Record<string, string> = {}, token = TOKEN) {
  const query: Record<string, string[]> = { id: [ident] };
  for (const [k, v] of Object.entries(args)) query[k] = [v];
  const [status, body] = await changesResponse(s, route, query, { 'x-studio-token': token });
  return [status, body as Body] as const;
}

async function files(s: ChatStudio, ident: string, args: Record<string, string> = {}) {
  const [status, data] = await api(s, ident, '/api/live/changes', args);
  assertEquals(status, 200, JSON.stringify(data));
  const list = (data.files ?? []) as Body[];
  return [data, Object.fromEntries(list.map((f) => [f.path as string, f]))] as const;
}

// ---- folder lookup -------------------------------------------------------------------------------

test('a live chat, a saved mark and the store give the folder; nothing from the request does', async () => {
  using r = new TempRepo();
  const s = studio({ live1: r.repo }, {
    conversations: { entries: { 'claude:a': { cwd: r.p('sub') } } },
    store: { conversations: new Map([['codex:b', { cwd: r.root }]]) },
  });
  assertEquals(await changesFolder(s, 'live1'), r.repo);
  assertEquals(await changesFolder(s, 'claude:a'), r.p('sub'));
  assertEquals(await changesFolder(s, 'codex:b'), r.root);
  assertEquals(await changesFolder(s, r.repo), null, 'a path as the id is never used as a folder');
  assertEquals(await changesFolder(studio({ x: osp.join(r.root, 'gone') }), 'x'), null);
  for (const bad of ['', 5, null, 'x'.repeat(601)]) await assertRejects(() => changesFolder(s, bad), ValueError);
  assertEquals(await artifactFolder(s, ''), null);
  assertEquals(await artifactFolder(s, 'live1'), r.repo);
});

test('a saved chat Studio does not run still has a folder (module default and a Studio lookup)', async () => {
  using r = new TempRepo();
  const sid = '11111111-2222-4333-8444-555555555555';
  const lookup = (provider: string, session: string) => (provider === 'claude' && session === sid ? r.repo : '');
  const old = defaults.savedCwd;
  defaults.savedCwd = lookup;
  try {
    const bare = studio();
    assertEquals(await changesFolder(bare, 'claude:' + sid), r.repo);
    assertEquals(await changesFolder(bare, 'claude:ffffffff-0000-0000-0000-000000000000'), null);
    assertEquals(await changesFolder(bare, 'Claude:' + sid), null, 'only provider:session keys are looked up');
  } finally {
    defaults.savedCwd = old;
  }
  assertEquals(await changesFolder(studio({}, { savedCwd: lookup }), 'claude:' + sid), r.repo);
});

test('repoBranch reads HEAD: a branch, a detached commit, a linked worktree; matches Python', async () => {
  using r = new TempRepo();
  git(r.repo, 'checkout', '-q', '-b', 'feature/x');
  assertEquals(repoBranch(r.p('sub')), 'feature/x');
  const wt = osp.join(r.root, 'wt');
  git(r.repo, 'worktree', 'add', '-q', '-b', 'side', wt);
  assertEquals(repoBranch(wt), 'side');
  const head = git(r.repo, 'rev-parse', 'HEAD').trim();
  git(r.repo, 'checkout', '-q', '--detach');
  assertEquals(repoBranch(r.repo), head.slice(0, 7));
  const plain = osp.join(r.root, 'plain');
  Deno.mkdirSync(plain);
  for (const bad of ['', null, '\\\\server\\share', '//server/share']) assertEquals(repoBranch(bad), '');
  await using py = new PyParity();
  for (const cwd of [r.repo, r.p('sub'), wt, plain, osp.join(r.root, 'missing'), '']) {
    assertEquals(repoBranch(cwd), await py.call('chat_folders', 'repo_branch', [cwd]), cwd);
  }
});

// ---- the response (test_changes.py ChangesRouteTests) --------------------------------------------

test('changes and one file for a known chat', async () => {
  using r = new TempRepo();
  write(r.p('mod.txt'), 'a\nB\nc\nd\n');
  write(r.p('loose.txt'), 'l\n');
  const s = studio({ c1: r.repo });
  const [data, found] = await files(s, 'c1', { scope: 'uncommitted' });
  assertEquals(Object.keys(found).sort(), ['loose.txt', 'mod.txt']);
  assertEquals(data.scope, 'uncommitted');
  assert(!('worktree' in data));
  const [status, one] = await api(s, 'c1', '/api/live/changes/file', { path: 'mod.txt' });
  assertEquals([status, one.added], [200, 1]);
});

test('a non-git chat', async () => {
  using r = new TempRepo();
  const plain = osp.join(r.root, 'plain');
  Deno.mkdirSync(plain);
  const [status, body] = await api(studio({ c: plain }), 'c');
  if (body.git !== false) return; // the temp folder sits inside another repository on this machine
  assertEquals([status, body], [200, { git: false }]);
});

test('unknown chats, tokens, scopes and paths are refused', async () => {
  using r = new TempRepo();
  const s = studio({ c: r.repo });
  assertEquals((await api(s, 'nope'))[0], 404);
  assertEquals((await api(s, 'nope'))[1], { error: 'This chat has no known project folder.', code: 'unknown_folder' });
  await assertRejects(() => api(s, ''), ValueError); // the route answers 400
  assertEquals((await api(s, r.repo))[0], 404);
  assertEquals(await api(s, 'c', '/api/live/changes', {}, ''), [403, { error: 'Invalid local session token' }]);
  assertEquals((await api(s, 'c', '/api/live/changes', {}, 'wrong'))[0], 403);
  assertEquals(await api(s, 'c', '/api/live/changes', { scope: 'turn' }), [400, {
    error: 'Only the uncommitted and branch scopes exist.',
    code: 'bad_scope',
  }]);
  assertEquals(await api(s, 'c', '/api/live/changes/file', { path: '../x' }), [400, { error: 'Not a repository path', code: 'bad_path' }]);
  assertEquals((await api(s, 'c', '/api/live/changes/file', { path: 'old.txt' }))[1].code, 'not_changed');
  assertEquals(await api(s, 'c', '/api/live/changes', { scope: 'branch' }), [400, {
    error: 'This chat has no branch of its own.',
    code: 'bad_scope',
  }]);
  const [status] = await changesResponse(s, '/api/live/changes', { id: ['c'] }, new Headers({ 'X-Studio-Token': TOKEN }));
  assertEquals(status, 200);
});

// ---- the branch view of a chat in its own worktree (test_worktree_changes.py) -------------------

class WorktreeChat implements Disposable {
  readonly r = new TempRepo();
  readonly state: string;
  readonly wt: string;
  readonly base: string;
  readonly registry: Registry;
  readonly studio: ChatStudio;

  constructor() {
    write(this.r.p('tracked.txt'), 'one\n');
    write(this.r.p('.gitignore'), '*.log\n');
    git(this.r.repo, 'add', '-A');
    git(this.r.repo, 'commit', '-q', '-m', 'more');
    this.state = osp.join(this.r.root, 'state');
    Deno.mkdirSync(this.state);
    this.wt = osp.join(this.r.root, 'wt');
    git(this.r.repo, 'worktree', 'add', '-q', '-b', 'studio/chat-1', this.wt);
    this.base = git(this.wt, 'rev-parse', 'HEAD').trim();
    this.registry = new Registry(this.state);
    this.studio = studio({ chat: this.wt, plain: this.r.repo }, { stateDir: this.state });
  }

  async record(fields: Record<string, unknown> = {}): Promise<void> {
    await this.registry.put('omp:chat', {
      status: 'ready',
      path: this.wt,
      project: this.r.repo,
      branch: 'studio/chat-1',
      snapshot: this.base,
      ...fields,
    });
  }

  [Symbol.dispose](): void {
    this.r[Symbol.dispose]();
  }
}

test('agent commits, edits and untracked files all show, and their diffs open', async () => {
  using w = new WorktreeChat();
  await w.record();
  write(w.r.p('mine.txt'), 'my own work\n'); // uncommitted in the main checkout: not the chat's change
  let [data, found] = await files(w.studio, 'chat', { scope: 'uncommitted' });
  assertEquals([data.scope, found, (data.totals as Body).files, data.worktree], ['branch', {}, 0, { branch: 'studio/chat-1' }]);
  write(osp.join(w.wt, 'committed.txt'), 'a\nb\n');
  git(w.wt, 'add', 'committed.txt');
  git(w.wt, 'commit', '-q', '-m', 'agent commit');
  write(osp.join(w.wt, 'tracked.txt'), 'one\nagent edit\n');
  write(osp.join(w.wt, 'fresh.txt'), 'x\ny\nz\n');
  write(osp.join(w.wt, 'ignored.log'), 'nope\n');
  [data, found] = await files(w.studio, 'chat', { scope: 'uncommitted' });
  assertEquals(Object.keys(found).sort(), ['committed.txt', 'fresh.txt', 'tracked.txt']);
  assertEquals([found['committed.txt'].status, found['committed.txt'].added], ['A', 2]);
  assertEquals([found['fresh.txt'].status, found['fresh.txt'].added], ['U', 3]);
  assertEquals([found['tracked.txt'].added, found['tracked.txt'].removed], [1, 0]);
  assertEquals([(data.totals as Body).files, (data.totals as Body).added], [3, 6]);
  for (const name of Object.keys(found)) {
    const [status, diff] = await api(w.studio, 'chat', '/api/live/changes/file', { path: name, scope: 'uncommitted' });
    assertEquals(status, 200, name);
    assert((diff.hunks as unknown[]).length, name);
  }
  const [status, diff] = await api(w.studio, 'chat', '/api/live/changes/file', { path: 'mine.txt' });
  assertEquals([status, diff.code], [400, 'not_changed']);
  await using py = new PyParity();
  assertEquals(
    data,
    await py.call('changes', 'get_changes', [w.wt], { base_commit: w.base }).then((d) => ({
      ...(d as Body),
      worktree: { branch: 'studio/chat-1' },
    })),
  );
});

test('a rename and the file cap in the branch view', async () => {
  using w = new WorktreeChat();
  await w.record();
  git(w.wt, 'mv', 'tracked.txt', 'moved.txt');
  git(w.wt, 'commit', '-q', '-m', 'rename');
  let [data, found] = await files(w.studio, 'chat');
  assertEquals([found['moved.txt'].status, found['moved.txt'].oldPath], ['R', 'tracked.txt']);
  const [status, diff] = await api(w.studio, 'chat', '/api/live/changes/file', { path: 'moved.txt' });
  assertEquals([status, diff.oldPath], [200, 'tracked.txt']);
  for (let i = 0; i < MAX_FILES + 5; i++) write(osp.join(w.wt, `many${String(i).padStart(3, '0')}.txt`), 'x\n');
  [data, found] = await files(w.studio, 'chat');
  assertEquals((data.files as unknown[]).length, MAX_FILES);
  assert(data.truncated);
  assertEquals(data.filesTotal, MAX_FILES + 5 + 1);
});

test('main moving on does not change the view, and a later diffBase is used', async () => {
  using w = new WorktreeChat();
  await w.record();
  write(osp.join(w.wt, 'a.txt'), 'a\n');
  git(w.wt, 'add', 'a.txt');
  git(w.wt, 'commit', '-q', '-m', 'a');
  write(w.r.p('elsewhere.txt'), 'e\n');
  git(w.r.repo, 'add', '-A');
  git(w.r.repo, 'commit', '-q', '-m', 'main moves on');
  let [, found] = await files(w.studio, 'chat');
  assertEquals(Object.keys(found), ['a.txt'], 'never diffed against the current tip of main');
  await w.registry.update('omp:chat', { diffBase: git(w.wt, 'rev-parse', 'HEAD').trim() });
  [, found] = await files(w.studio, 'chat');
  assertEquals(found, {});
});

test('a chat without its own worktree keeps the uncommitted view', async () => {
  using w = new WorktreeChat();
  await w.record();
  write(w.r.p('tracked.txt'), 'one\ntwo\n');
  write(w.r.p('new.txt'), 'n\n');
  let [data, found] = await files(w.studio, 'plain', { scope: 'uncommitted' });
  assertEquals([data.scope, Object.keys(found).sort()], ['uncommitted', ['new.txt', 'tracked.txt']]);
  git(w.r.repo, 'commit', '-q', '-am', 'c');
  [data, found] = await files(w.studio, 'plain');
  assertEquals(Object.keys(found), ['new.txt'], 'committed work is not shown');
  assertEquals((await api(w.studio, 'plain', '/api/live/changes/file', { path: 'tracked.txt' }))[1].code, 'not_changed');
  assertEquals((await api(w.studio, 'plain', '/api/live/changes', { scope: 'branch' }))[1].code, 'bad_scope');
  assertEquals((await api(w.studio, 'plain', '/api/live/changes', { scope: 'other' }))[1].code, 'bad_scope');
});
