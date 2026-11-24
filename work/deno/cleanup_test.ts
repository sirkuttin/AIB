/**
 * Decision 6 cleanup (server/worktrees/cleanup.ts): build plan 1b e2e 16b (two installs on one repo), 17 (stash rule), 17b (the
 * unmerged-work test), project removal (16) and "Remove AIB's data from my repos" (18b). The one-time cleanup of old copies is the
 * owner's one-off migration script now (folder_chats_migrate_test.ts). Real git in temp repos and temp state folders only.
 */
import { assert, assertEquals } from './_assert.ts';
import { commit, exists, runGit, Sandbox, write } from './_worktree_fixtures.ts';
import * as wt from '../../app/server/worktrees/worktrees.ts';
import * as cleanup from '../../app/server/worktrees/cleanup.ts';
import { pathOf } from '../../app/server/state/paths.ts';

async function copy(state: string, project: string, key: string, session = ''): Promise<{ manager: wt.Manager; plan: wt.Plan }> {
  const manager = new wt.Manager(state);
  const plan = (await manager.plan(project, key))!;
  assert(plan, 'a plan');
  await manager.create(plan);
  if (session) await manager.setSession(key, session.split(':')[0], session.split(':')[1]);
  return { manager, plan };
}
const item = (scan: cleanup.Scan, id: string) => scan.items.find((i) => i.id === id)!;
const branchExists = (project: string, branch: string) => {
  try {
    runGit(project, 'rev-parse', '--verify', '-q', `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
};

Deno.test("16b: two state folders on one repo: each removes only its own; the other install's items are listed, unticked, never removed", async () => {
  using box = new Sandbox();
  const stateB = pathOf(box.base, 'stateB');
  const a = await copy(box.state, box.project, 'a'.repeat(32), 'claude:sa');
  const b = await copy(stateB, box.project, 'b'.repeat(32), 'claude:sb');
  write(b.plan.path, 'work.txt', 'B work\n'); // B's copy has unmerged work
  // an orphan branch of each install: A's named in its removed-notes, B's only in B's
  runGit(box.project, 'branch', 'studio/chat-oldaaaaa', 'main');
  runGit(box.project, 'branch', 'studio/chat-oldbbbbb', 'main');
  runGit(box.project, 'update-ref', 'refs/studio/chat-oldbbbbb/user', 'main');
  await a.manager.registry.locked(() => {
    const raw = JSON.parse(Deno.readTextFileSync(a.manager.registry.path));
    raw.removed = {
      [wt.norm(pathOf(box.state, 'worktrees', 'x', 'chat-oldaaaaa'))]: { project: box.project, branch: 'studio/chat-oldaaaaa' },
    };
    Deno.writeTextFileSync(a.manager.registry.path, JSON.stringify(raw));
  });

  const scanA = await cleanup.scanProject(box.state, box.project, { titles: { 'claude:sa': 'Fix login' } });
  assertEquals(scanA.skipped, '');
  const mineA = item(scanA, `copy:${'a'.repeat(32)}`);
  assertEquals([mineA.own, mineA.unmerged, mineA.title], [true, false, 'Fix login']);
  const theirs = item(scanA, `wt:${b.plan.path}`);
  assertEquals([theirs.own, theirs.unmerged], [false, true], "B's copy is another install's, with work");
  assertEquals(item(scanA, 'branch:studio/chat-oldaaaaa').own, true);
  assertEquals(item(scanA, 'branch:studio/chat-oldbbbbb').own, false);
  const view = cleanup.confirmView(scanA);
  assertEquals(
    view.items.map((i) => i.id).sort(),
    [`wt:${b.plan.path}`, 'branch:studio/chat-oldbbbbb'].sort(),
    "the confirm lists only the other install's items (A has no unmerged work)",
  );
  assertEquals(view.silent, 2);

  const done = await cleanup.applyProject(box.state, box.project);
  assertEquals(done.removed.sort(), [`copy:${'a'.repeat(32)}`, 'branch:studio/chat-oldaaaaa'].sort());
  assert(!exists(a.plan.path) && !branchExists(box.project, a.plan.branch), "A's copy and branch are gone");
  assert(!branchExists(box.project, 'studio/chat-oldaaaaa'));
  assert(exists(b.plan.path) && branchExists(box.project, b.plan.branch), "B's copy and branch stay");
  assert(branchExists(box.project, 'studio/chat-oldbbbbb'), "B's orphan branch stays");
  assertEquals(
    runGit(box.project, 'for-each-ref', '--format=%(refname)', `refs/studio/${b.plan.slug}/`).trim(),
    `refs/studio/${b.plan.slug}/user`,
  );
  assertEquals(wt.userRef({ branch: a.plan.branch }) && runGit(box.project, 'for-each-ref', `refs/studio/${a.plan.slug}/`).trim(), '');

  // B, seen from B: its copy is its own (with work), A's items are gone; B never touches anything without a tick
  const scanB = await cleanup.scanProject(stateB, box.project);
  assertEquals(item(scanB, `copy:${'b'.repeat(32)}`).own, true);
  assertEquals(item(scanB, `copy:${'b'.repeat(32)}`).unmerged, true);
  assertEquals(item(scanB, 'branch:studio/chat-oldbbbbb').own, false, "not in B's records either: listed, never silent");
  // ticking another install's item removes it (the project-removal confirm)
  const ticked = await cleanup.applyProject(box.state, box.project, ['branch:studio/chat-oldbbbbb']);
  assert(ticked.removed.includes('branch:studio/chat-oldbbbbb'));
  assert(!branchExists(box.project, 'studio/chat-oldbbbbb'));
  assertEquals(runGit(box.project, 'for-each-ref', 'refs/studio/chat-oldbbbbb/').trim(), '', 'its refs go with it');
});

Deno.test('17: a kept clash stash is never dropped silently; a stash already in the working tree is', async () => {
  using box = new Sandbox();
  const a = await copy(box.state, box.project, 'c'.repeat(32));
  const slug = a.plan.slug;
  // an undo stash nobody recorded whose content is not in the tree: unmerged
  write(box.project, 'other.txt', 'undo\n');
  runGit(box.project, 'stash', 'push', '-u', '-m', 'aib-swarm-undo-300');
  const undo = runGit(box.project, 'rev-parse', 'stash@{0}').trim();
  // a stash Merge applied cleanly but could not drop (a crash): its content is in the working tree
  write(box.project, 'tracked.txt', 'edited\n');
  runGit(box.project, 'stash', 'push', '-u', '-m', `studio-merge-${slug}-100`);
  runGit(box.project, 'stash', 'apply', 'stash@{0}');
  const applied = runGit(box.project, 'rev-parse', 'stash@{0}').trim();
  runGit(box.project, 'checkout', '--', 'tracked.txt');
  write(box.project, 'tracked.txt', 'edited\n');
  // a kept clash stash, recorded in worktree-clashes.json, whose content also matches (it must stay anyway)
  write(box.project, 'new.txt', 'mine\n');
  runGit(box.project, 'stash', 'push', '-u', '-m', `studio-merge-${slug}-200`);
  const kept = runGit(box.project, 'rev-parse', 'stash@{0}').trim();
  runGit(box.project, 'stash', 'apply', 'stash@{0}');
  Deno.writeTextFileSync(
    pathOf(box.state, 'worktree-clashes.json'),
    JSON.stringify({ x: { project: box.project, folder: box.project, stash: { sha: kept, name: `studio-merge-${slug}-200` } } }),
  );

  const scan = await cleanup.scanProject(box.state, box.project);
  assertEquals([item(scan, `stash:${applied}`).unmerged, item(scan, `stash:${applied}`).own], [false, true]);
  assertEquals(
    [item(scan, `stash:${kept}`).unmerged, item(scan, `stash:${kept}`).clash],
    [true, true],
    'a kept clash stash counts as unmerged',
  );
  assertEquals(item(scan, `stash:${undo}`).unmerged, true);
  const done = await cleanup.applyProject(box.state, box.project);
  assert(done.removed.includes(`stash:${applied}`));
  const left = runGit(box.project, 'stash', 'list', '--format=%H').trim().split('\n');
  assert(left.includes(kept) && left.includes(undo) && !left.includes(applied), 'only the applied one was dropped');
});

Deno.test('17b: the unmerged-work test: live-synced edits alone do not count; a missing copy whose branch is ahead of U does', async () => {
  using box = new Sandbox();
  const a = await copy(box.state, box.project, 'd'.repeat(32));
  // the user saves an edit in the project folder; live sync carries it into the copy and moves U (advanceUserBase)
  write(box.project, 'tracked.txt', 'user edit\n');
  write(a.plan.path, 'tracked.txt', 'user edit\n');
  const record = { ...a.manager.registry.get('d'.repeat(32))!, key: 'd'.repeat(32) };
  await wt.advanceUserBase(record, ['tracked.txt'], a.manager.registry);
  let scan = await cleanup.scanProject(box.state, box.project);
  assertEquals(item(scan, `copy:${'d'.repeat(32)}`).unmerged, false, "carried-in edits are not the chat's work");

  // the chat commits its own work, then its folder disappears: compared with the U ref, the branch is ahead
  commit(a.plan.path, 'chat.txt', 'chat work\n');
  wt.rmtree(a.plan.path);
  scan = await cleanup.scanProject(box.state, box.project);
  const it = item(scan, `copy:${'d'.repeat(32)}`);
  assertEquals([it.unmerged, it.files], [true, 1]);
  const done = await cleanup.applyProject(box.state, box.project);
  assertEquals(done.removed, [], 'nothing with work goes without a tick');
  assert(branchExists(box.project, a.plan.branch));

  // a branch with no U ref whose files are already on main by content (a squash merge) is merged, whatever the history
  runGit(box.project, 'checkout', '-q', '--', 'tracked.txt'); // the user's edit is not part of this case
  runGit(box.project, 'checkout', '-q', '-b', 'studio/chat-squashed', 'main');
  commit(box.project, 'feature.txt', 'f\n');
  runGit(box.project, 'checkout', '-q', 'main');
  runGit(box.project, 'checkout', '-q', 'studio/chat-squashed', '--', 'feature.txt');
  runGit(box.project, 'commit', '-q', '-m', 'squash');
  assertEquals(await cleanup.branchUnmerged(box.project, 'studio/chat-squashed', 'main'), 0);
});

Deno.test('17c: a copy whose committed work main lacks keeps its copy and branch, a link to a folder too; once main has it, both go', async () => {
  using box = new Sandbox();
  const key = 'f'.repeat(32);
  const a = await copy(box.state, box.project, key);
  commit(a.plan.path, 'chat.txt', 'chat work\n');
  let linked = false;
  try {
    Deno.mkdirSync(pathOf(box.base, 'outside'));
    Deno.symlinkSync(pathOf(box.base, 'outside'), pathOf(a.plan.path, 'link-out'), { type: 'dir' });
    linked = true;
  } catch { /* Windows without the right to make links: the file case still runs (the real-WSL e2e has the link) */ }
  if (linked) {
    runGit(a.plan.path, 'add', 'link-out');
    runGit(a.plan.path, 'commit', '-q', '-m', 'link');
  }
  let scan = await cleanup.scanProject(box.state, box.project);
  assertEquals([item(scan, `copy:${key}`).unmerged, item(scan, `copy:${key}`).files], [true, linked ? 2 : 1]);
  assertEquals((await cleanup.applyProject(box.state, box.project)).removed, [], 'nothing with work goes without a tick');
  assert(exists(a.plan.path) && branchExists(box.project, a.plan.branch));

  // the file reaches main by content: only the link is left, and a link main lacks is still work (never read through to its folder)
  runGit(box.project, 'checkout', '-q', a.plan.branch, '--', 'chat.txt');
  runGit(box.project, 'commit', '-q', '-m', 'merge by content');
  scan = await cleanup.scanProject(box.state, box.project);
  assertEquals(item(scan, `copy:${key}`).unmerged, linked);
  if (linked) {
    assertEquals((await cleanup.applyProject(box.state, box.project)).removed, []);
    assert(branchExists(box.project, a.plan.branch), 'the branch with the link stays');
    runGit(box.project, 'checkout', '-q', a.plan.branch, '--', 'link-out');
    runGit(box.project, 'commit', '-q', '-m', 'the link too');
    assertEquals(item(await cleanup.scanProject(box.state, box.project), `copy:${key}`).unmerged, false, 'the same link on main');
  }
  assertEquals((await cleanup.applyProject(box.state, box.project)).removed, [`copy:${key}`]);
  assert(!exists(a.plan.path) && !branchExists(box.project, a.plan.branch), 'merged: the copy and its branch go');
});

Deno.test("a running chat's copy is never touched; a subfolder or busy repo is skipped", async () => {
  using box = new Sandbox();
  const a = await copy(box.state, box.project, 'e'.repeat(32), 'claude:se');
  const scan = await cleanup.scanProject(box.state, box.project, { live: ['claude:se'] });
  assertEquals(item(scan, `copy:${'e'.repeat(32)}`).live, true);
  assertEquals((await cleanup.applyProject(box.state, box.project, [], { live: [a.plan.path] })).removed, []);
  assert(exists(a.plan.path));
  Deno.mkdirSync(pathOf(box.project, 'sub'));
  assert((await cleanup.scanProject(box.state, pathOf(box.project, 'sub'))).skipped);
  Deno.writeTextFileSync(pathOf(box.project, '.git', 'index.lock'), '');
  assert((await cleanup.scanProject(box.state, box.project)).skipped.includes('index.lock'));
  Deno.removeSync(pathOf(box.project, '.git', 'index.lock'));
});

Deno.test('16: project removal: one confirm lists the unmerged copy; the clean one goes silently; ticked ids go; aib-shared/ stays', async () => {
  const { projectRemove } = await import('../../app/server/web/project_routes.ts');
  const { RemovedProjects } = await import('../../app/server/desktop/project_delete.ts');
  const { ConversationState } = await import('../../app/server/state/store.ts');
  using box = new Sandbox();
  write(box.project, 'aib-shared/notes.md', 'mine\n'); // the local-only folder (excluded by AIB's default line)
  Deno.writeTextFileSync(pathOf(box.project, '.git', 'info', 'exclude'), '/aib-shared\n');
  const clean = await copy(box.state, box.project, '3'.repeat(32), 'claude:s3');
  const busy = await copy(box.state, box.project, '4'.repeat(32), 'claude:s4');
  write(busy.plan.path, 'w.txt', 'work\n');
  const ctx = {
    stateDir: box.state,
    conversations: new ConversationState(box.state),
    removedProjects: new RemovedProjects(box.state),
    host: { liveList: () => ({ connections: [{ provider: 'claude', sessionId: 'live1' }] }) }, // h_running below
  };
  // swarm records (P4a lead notes): a helper whose copy goes leaves swarm-helpers.json; one whose copy stays, a running one and
  // another project's keep theirs
  const helper = (id: string, project: string, path: string, lasting = '') => ({
    id, project, title: id, parent: { live: '', lasting: '' }, chat: { live: '', lasting, provider: 'claude', model: '', mode: '' },
    worktree: { path, branch: '', base: 'main', start: '' }, state: 'done', notes: [], reports: [],
  });
  const gonePath = pathOf(box.base, 'gone-copy');
  Deno.writeTextFileSync(pathOf(box.state, 'swarm-helpers.json'), JSON.stringify({
    version: 1,
    helpers: {
      h_clean: helper('h_clean', box.project, clean.plan.path),
      h_kept: helper('h_kept', box.project, busy.plan.path),
      h_running: helper('h_running', box.project, gonePath, 'claude:live1'),
      h_other: helper('h_other', pathOf(box.base, 'other'), gonePath),
    },
  }));
  const helperIds = () => Object.keys(JSON.parse(Deno.readTextFileSync(pathOf(box.state, 'swarm-helpers.json'))).helpers).sort();
  const [, check] = await projectRemove(ctx, { check: true, path: box.project, titles: { 'claude:s4': 'Fix login' } });
  const view = check.cleanup as { items: Record<string, unknown>[]; silent: number };
  assertEquals(view.items.map((i) => [i.id, i.title, i.files, i.own]), [[`copy:${'4'.repeat(32)}`, 'Fix login', 1, true]]);
  assertEquals(view.silent, 1);
  assert(exists(clean.plan.path), 'the check changes nothing');

  // an older page (no cleanup field): only the silent items go, never unmerged work
  const [status, done] = await projectRemove(ctx, { path: box.project });
  assertEquals(status, 200);
  assertEquals((done.cleanup as { removed: string[] }).removed, [`copy:${'3'.repeat(32)}`]);
  assert(!exists(clean.plan.path) && exists(busy.plan.path));
  assertEquals(helperIds(), ['h_kept', 'h_other', 'h_running'], "the removed copy's helper record is dropped, the rest stay");
  // the confirm with the tick
  await projectRemove(ctx, { path: box.project, cleanup: { remove: [`copy:${'4'.repeat(32)}`] } });
  assert(!exists(busy.plan.path) && !branchExists(box.project, busy.plan.branch));
  assertEquals(Deno.readTextFileSync(pathOf(box.project, 'aib-shared', 'notes.md')), 'mine\n', 'the aib-shared folder stays');
  assertEquals(Deno.readTextFileSync(pathOf(box.project, '.git', 'info', 'exclude')), '/aib-shared\n', 'and its exclude line');
});

Deno.test('18b: "Remove AIB\'s data from my repos" runs project removal\'s cleanup for every added project and leaves aib-shared/', async () => {
  const { allRoute } = await import('../../app/server/web/cleanup_routes.ts');
  using box = new Sandbox();
  const second = pathOf(box.base, 'proj2');
  makeRepoAt(second);
  write(box.project, 'aib-shared/a.md', 'a\n');
  const one = await copy(box.state, box.project, '5'.repeat(32));
  const two = await copy(box.state, second, '6'.repeat(32), 'claude:s6');
  write(two.plan.path, 'w.txt', 'work\n');
  const ctx = {
    stateDir: box.state,
    host: { liveList: () => ({ connections: [] }) },
    addedProjects: { public: () => ({ added: { a: { path: box.project }, b: { path: second } } }) },
  };
  const [, check] = await allRoute(ctx, { mode: 'check', titles: { 'claude:s6': 'Refactor api' } });
  const projects = check.projects as { project: string; items: Record<string, unknown>[]; silent: number }[];
  assertEquals(projects.map((p) => [p.project, p.items.map((i) => i.title), p.silent]), [[box.project, [], 1], [
    second,
    ['Refactor api'],
    0,
  ]]);
  assert(exists(one.plan.path), 'check changes nothing');
  await allRoute(ctx, { mode: 'apply', remove: { [second]: [`copy:${'6'.repeat(32)}`] } });
  assert(!exists(one.plan.path) && !exists(two.plan.path));
  assert(!branchExists(box.project, one.plan.branch) && !branchExists(second, two.plan.branch));
  assertEquals(Deno.readTextFileSync(pathOf(box.project, 'aib-shared', 'a.md')), 'a\n');
});

function makeRepoAt(folder: string): void {
  Deno.mkdirSync(folder, { recursive: true });
  runGit(folder, 'init', '-q', '-b', 'main');
  write(folder, 'a.txt', 'a\n');
  runGit(folder, 'add', '-A');
  runGit(folder, 'commit', '-q', '-m', 'first');
}

Deno.test('WSL helper (protocol 2): worktree.cleanupScan changes nothing; worktree.cleanupApply removes the silent items and the ticked ones', async () => {
  const { worktreeMethods } = await import('../../app/server/wsl/helper/worktrees.ts');
  const { HELPER_PROTOCOL } = await import('../../app/server/wsl/contract.ts');
  assertEquals(HELPER_PROTOCOL, 3);
  using box = new Sandbox();
  const m = worktreeMethods(box.state);
  const clean = await copy(box.state, box.project, '7'.repeat(32));
  const busy = await copy(box.state, box.project, '8'.repeat(32));
  write(busy.plan.path, 'w.txt', 'work\n');
  const scanned = (await m['worktree.cleanupScan']({ project: box.project, live: [] })) as { scan: cleanup.Scan };
  assertEquals(scanned.scan.items.map((i) => [i.id, i.unmerged]).sort(), [[`copy:${'7'.repeat(32)}`, false], [
    `copy:${'8'.repeat(32)}`,
    true,
  ]]);
  assert(exists(clean.plan.path));
  const done = (await m['worktree.cleanupApply']({ project: box.project, ticked: [] })) as { removed: string[] };
  assertEquals(done.removed, [`copy:${'7'.repeat(32)}`]);
  const ticked = (await m['worktree.cleanupApply']({ project: box.project, ticked: [`copy:${'8'.repeat(32)}`] })) as { removed: string[] };
  assertEquals(ticked.removed, [`copy:${'8'.repeat(32)}`]);
  assert(!exists(busy.plan.path));
});
