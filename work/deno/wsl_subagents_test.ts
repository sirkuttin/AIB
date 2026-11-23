/**
 * Subagent worktrees for WSL projects without a distro (owner 2026-11-23): the helper's subagent.* methods (wsl/helper/subagents.ts)
 * run natively here over the real SubagentWorktrees and worktrees/subagent_land.ts on temp repos (what the distro's helper does with
 * Linux git on Linux paths), and the Windows side (wsl/subagents.ts) with a FakeWslHost whose answers come from those real methods.
 *   - a worktree is made for a chat's next subagent from a snapshot of its folder (the uncommitted edits included), on a
 *     `studio/sub-...` branch under the helper's data folder (never /mnt, never anywhere a call can name);
 *   - it lands by the same steps as every subagent: its own commits only (the folder's uncommitted files in the snapshot are not
 *     committed: cf12f52), a conflict leaves a clean `-landable` branch, and a distro that can't answer is a refusal a later try may
 *     meet, never a landing in the project folder;
 *   - release removes the worktree, its branch and its record.
 * The real distro is wsl_subagents_e2e_test.ts (skips cleanly without AIB_WSL_E2E). Never a real distro, never the owner's homes.
 */
import { assert, assertEquals, assertRejects } from './_assert.ts';
import { commit, read, runGit, Sandbox, write } from './_worktree_fixtures.ts';
import { HAVE_GIT } from './_git_repo.ts';
import { FakeWslHost } from './_wsl_fake.ts';
import { subagentMethods } from '../../outputs/agent-studio/server/wsl/helper/subagents.ts';
import { RpcError } from '../../outputs/agent-studio/server/wsl/helper/rpc.ts';
import * as ws from '../../outputs/agent-studio/server/wsl/subagents.ts';
import { setWslHostResolver } from '../../outputs/agent-studio/server/wsl/access.ts';
import { WslHelperError } from '../../outputs/agent-studio/server/wsl/contract.ts';

type Json = Record<string, unknown>;
const T = { sanitizeResources: false, sanitizeOps: false, ignore: !HAVE_GIT };

Deno.env.set('AIB_WSL_ROOT', '/tmp/aib-wsl-test-fake');

/** A repo that keeps line endings as written (git on this PC may convert them: a file written here would then differ from its snapshot). */
function sandbox(): Sandbox {
  const box = new Sandbox();
  runGit(box.project, 'config', 'core.autocrlf', 'false');
  return box;
}

const CHAT = 'abcdef0123456789abcdef0123456789';
const chatFacts = (box: Sandbox, id = CHAT): Json => ({ id, provider: 'claude', lasting: 'claude:s1', folder: box.project, project: box.project });
const meta = { toolUseId: 'toolu_1', agentType: 'general-purpose', description: 'Make the docs', background: false };

/** One subagent made, bound, working in its worktree (`edit` runs there) and ended: ready to land. */
async function subagentAt(box: Sandbox, h: ReturnType<typeof subagentMethods>, edit: (path: string) => void, id = CHAT) {
  const made = await h['subagent.prepare']({ chat: chatFacts(box, id), meta }) as { record: Json };
  const rec = made.record;
  await h['subagent.bind']({ chat: chatFacts(box, id), agentId: 'agent-1' });
  edit(String(rec.path));
  await h['subagent.end']({ chat: chatFacts(box, id), agentId: 'agent-1' });
  return rec;
}

// ---- the helper's methods ------------------------------------------------------------------------------------------------
Deno.test({ name: 'wsl helper subagent.*: a worktree from a snapshot of the folder, bound, ended, landed with its own work only, released', ...T, async fn() {
  using box = sandbox();
  const h = subagentMethods(box.state);
  // the folder's own uncommitted file: it is in the subagent's snapshot S, but it is not the subagent's work
  write(box.project, 'mine.txt', 'my own unsaved work\n');
  const made = await h['subagent.prepare']({ chat: chatFacts(box), meta }) as { record: Json };
  const rec = made.record;
  assertEquals(rec.state, 'prepared');
  assertEquals(rec.branch, `studio/sub-${CHAT.slice(0, 8)}-1`);
  assert(String(rec.path).startsWith(box.state + '\\worktrees\\') || String(rec.path).startsWith(box.state + '/worktrees/'), `the worktree is under the data folder: ${rec.path}`);
  assertEquals(read(String(rec.path), 'mine.txt'), 'my own unsaved work\n', 'the snapshot has the uncommitted file');
  assert(runGit(box.project, 'branch', '--list', String(rec.branch)).includes(String(rec.branch)));
  assertEquals(((await h['subagent.records']({ chat: CHAT })) as { records: Json[] }).records.map((r) => r.id), [rec.id]);
  const bound = await h['subagent.bind']({ chat: chatFacts(box), agentId: 'agent-1' }) as { record: Json };
  assertEquals(bound.record.state, 'running');
  // its work: a new file and a change to a tracked one, one committed and one not
  write(String(rec.path), 'docs.md', '# Docs\n');
  commit(String(rec.path), 'tracked.txt', 'one\ntwo\n', 'subagent edit');
  write(String(rec.path), 'extra.txt', 'uncommitted in the worktree\n');
  assertEquals(((await h['subagent.release']({ id: rec.id })) as Json).outcome, 'running', 'never from under a running subagent');
  await h['subagent.end']({ chat: chatFacts(box), agentId: 'agent-1' });
  const landed = await h['subagent.land']({ id: rec.id, parent: CHAT, target: 'main', title: 'Make the docs', held: [], states: {} }) as { outcome: Json };
  assertEquals(landed.outcome.state, 'merged', JSON.stringify(landed.outcome));
  const files = (landed.outcome.files as string[]).slice().sort();
  assert(files.includes('tracked.txt') && files.includes('extra.txt'), `its own work landed: ${files}`);
  assert(!files.includes('mine.txt'), "the folder's own uncommitted file is not part of the landing (own commits only, no snapshot files)");
  assertEquals(runGit(box.project, 'show', 'main:tracked.txt'), 'one\ntwo\n');
  assertEquals(runGit(box.project, 'ls-tree', '--name-only', 'main').split('\n').includes('mine.txt'), false, 'not committed to main');
  assertEquals(read(box.project, 'mine.txt'), 'my own unsaved work\n', 'and still the folder\'s own, uncommitted');
  assertEquals(runGit(box.project, 'log', '-1', '--format=%s', 'main').trim().startsWith('AIB: subagent'), true);
  // landed: its worktree, branch and record go
  assertEquals(((await h['subagent.release']({ id: rec.id })) as Json).outcome, 'removed');
  assertEquals(runGit(box.project, 'branch', '--list', String(rec.branch)).trim(), '');
  // (the chat's spare, made ahead for its next subagent, goes with the chat)
  await h['subagent.chatClosed']({ chat: CHAT });
  assertEquals((((await h['subagent.records']({})) as { records: Json[] }).records), []);
  assertEquals(Deno.statSync(box.project).isDirectory, true);
  assertEquals(((await h['subagent.release']({ id: rec.id })) as Json).outcome, 'gone');
} });

Deno.test({ name: 'wsl helper subagent.*: a conflict keeps the work, leaves a clean -landable branch without the folder\'s uncommitted files, and the parent is told by the outcome', ...T, async fn() {
  using box = sandbox();
  const h = subagentMethods(box.state);
  write(box.project, 'mine.txt', 'my own unsaved work\n');
  const rec = await subagentAt(box, h, (p) => commit(p, 'tracked.txt', 'subagent line\n', 'subagent edit'));
  commit(box.project, 'tracked.txt', 'main line\n', 'main edit'); // the folder moved on, on the same line
  const out = (await h['subagent.land']({ id: rec.id, parent: CHAT, target: 'main', title: 'T', held: [], states: {} }) as { outcome: Json }).outcome;
  assertEquals(out.state, 'conflicts', JSON.stringify(out));
  assertEquals(out.files, ['tracked.txt']);
  assertEquals(out.landable, `${rec.branch}-landable`);
  assertEquals(runGit(box.project, 'show', `${out.landable}:tracked.txt`), 'subagent line\n');
  assertEquals(runGit(box.project, 'ls-tree', '--name-only', String(out.landable)).split('\n').includes('mine.txt'), false, 'the landable branch holds only its own changes');
  assertEquals(runGit(box.project, 'show', 'main:tracked.txt'), 'main line\n', 'nothing landed');
  // released (the main agent merged it by hand): both branches go with the worktree
  assertEquals(((await h['subagent.release']({ id: rec.id })) as Json).outcome, 'removed');
  await h['subagent.chatClosed']({ chat: CHAT });
  assertEquals(runGit(box.project, 'branch', '--list', 'studio/sub-*').trim(), '');
} });

Deno.test({ name: 'wsl helper subagent.*: a file the folder has uncommitted is never overwritten (touched dirty), protected files and unknown ids are refused', ...T, async fn() {
  using box = sandbox();
  const h = subagentMethods(box.state);
  const rec = await subagentAt(box, h, (p) => {
    write(p, '.husky/pre-commit', 'echo planted\n');
    write(p, 'notes.txt', 'subagent notes\n');
  });
  const protectedOut = (await h['subagent.land']({ id: rec.id, parent: CHAT, target: 'main', title: 'T', held: [], states: {} }) as { outcome: Json }).outcome;
  assertEquals([protectedOut.state, protectedOut.code], ['refused', 'protected']);
  assertEquals(protectedOut.files, ['.husky/pre-commit']);
  const gone = (await h['subagent.land']({ id: 'nope', parent: CHAT, target: 'main', held: [], states: {} }) as { outcome: Json }).outcome;
  assertEquals([gone.state, gone.code], ['refused', 'gone']);
  // the folder edits the same file the subagent changed: nothing lands, nothing is stashed
  const second = await subagentAt(box, h, (p) => write(p, 'tracked.txt', 'subagent change\n'), 'bbbbbbbb0123456789abcdef01234567');
  write(box.project, 'tracked.txt', 'one\nuser edit\n');
  const dirty = (await h['subagent.land']({ id: second.id, parent: CHAT, target: 'main', title: 'T', held: [], states: {} }) as { outcome: Json }).outcome;
  assertEquals([dirty.state, dirty.code], ['refused', 'touched_dirty'], JSON.stringify(dirty));
  assertEquals(read(box.project, 'tracked.txt'), 'one\nuser edit\n');
  assertEquals(box.stashes(), []);
} });

Deno.test({ name: 'wsl helper subagent.*: bad chats and params are refused (relative or Windows-drive folders, bad ids, bad targets)', ...T, async fn() {
  using box = sandbox();
  const h = subagentMethods(box.state);
  const bad: Json[] = [
    { ...chatFacts(box), folder: 'relative/folder' },
    { ...chatFacts(box), folder: '/mnt/c/Users/me/proj', project: '/mnt/c/Users/me/proj' },
    { ...chatFacts(box), id: '../escape' },
    { ...chatFacts(box), id: '' },
  ];
  for (const chat of bad) await assertRejects(() => Promise.resolve(h['subagent.prepare']({ chat, meta })), RpcError);
  await assertRejects(() => Promise.resolve(h['subagent.prepare']({ chat: 'x', meta })), RpcError);
  await assertRejects(() => Promise.resolve(h['subagent.hook']({ chat: chatFacts(box), event: 'rm -rf' })), RpcError);
  const rec = await subagentAt(box, h, (p) => write(p, 'a.txt', 'a\n'));
  await assertRejects(() => Promise.resolve(h['subagent.land']({ id: rec.id, parent: CHAT, target: '--upload-pack=x', held: [], states: {} })), RpcError);
  await assertRejects(() => Promise.resolve(h['subagent.land']({ id: '../x', parent: CHAT, target: 'main', held: [], states: {} })), RpcError);
  assertEquals(runGit(box.project, 'status', '--porcelain').trim(), '', 'the project folder was never touched');
} });

Deno.test({ name: 'wsl helper subagent.*: the cap, and a chat that closes loses its unused worktrees but keeps landable ones', ...T, async fn() {
  using box = sandbox();
  const h = subagentMethods(box.state);
  const first = await h['subagent.prepare']({ chat: chatFacts(box), meta }) as { record: Json };
  const second = await h['subagent.prepare']({ chat: chatFacts(box), meta }) as { record: Json };
  assertEquals([first.record.branch, second.record.branch], [`studio/sub-${CHAT.slice(0, 8)}-1`, `studio/sub-${CHAT.slice(0, 8)}-2`]);
  await h['subagent.bind']({ chat: chatFacts(box), agentId: 'agent-1' });
  write(String(first.record.path), 'work.txt', 'kept\n');
  await h['subagent.end']({ chat: chatFacts(box), agentId: 'agent-1' });
  await h['subagent.chatClosed']({ chat: CHAT });
  const left = ((await h['subagent.records']({})) as { records: Json[] }).records;
  assert(left.some((r) => r.id === first.record.id), 'a finished subagent stays for landing');
  assert(!left.some((r) => r.id === second.record.id), 'an unused prepared worktree goes with its chat');
  assert(!runGit(box.project, 'branch', '--list', String(second.record.branch)).trim(), 'and its branch');
} });

// ---- the Windows side, over a FakeWslHost answering from the real helper methods -----------------------------------------------
const LINUX_BASE = '/home/u/lab';

class Lab {
  readonly host: FakeWslHost;
  readonly helper: ReturnType<typeof subagentMethods>;
  constructor(readonly box: Sandbox) {
    this.host = new FakeWslHost(box.base + '\\unused-keeper');
    this.host.folders.set(LINUX_BASE, box.base);
    this.helper = subagentMethods(box.state);
    const win = (linux: string) => this.host.windowsFor(linux);
    const linux = (w: string) => LINUX_BASE + w.slice(box.base.length).replaceAll('\\', '/');
    const mapRecord = (r: Json): Json => ({ ...r, path: linux(String(r.path)), folder: linux(String(r.folder)), project: linux(String(r.project)) });
    const chat = (p: Json) => ({ ...(p.chat as Json), folder: win(String((p.chat as Json).folder)), project: win(String((p.chat as Json).project)) });
    this.host.handlers['subagent.prepare'] = async (p) => {
      const out = await this.helper['subagent.prepare']({ ...p, chat: chat(p) }) as Json;
      return out.record ? { record: mapRecord(out.record as Json) } : out;
    };
    this.host.handlers['subagent.bind'] = async (p) => {
      const out = await this.helper['subagent.bind']({ ...p, chat: chat(p) }) as Json;
      return { record: out.record ? mapRecord(out.record as Json) : null };
    };
    this.host.handlers['subagent.end'] = (p) => this.helper['subagent.end']({ ...p, chat: chat(p) });
    this.host.handlers['subagent.records'] = async (p) => ({ records: (((await this.helper['subagent.records'](p)) as Json).records as Json[]).map(mapRecord) });
    this.host.handlers['subagent.chatClosed'] = (p) => this.helper['subagent.chatClosed'](p);
    this.host.handlers['subagent.land'] = (p) => this.helper['subagent.land'](p);
    this.host.handlers['subagent.release'] = (p) => this.helper['subagent.release'](p);
    setWslHostResolver((d) => (d === 'ubuntu' ? this.host : null));
  }

  ref(windows: string): string {
    return 'wsl://ubuntu' + LINUX_BASE + windows.slice(this.box.base.length).replaceAll('\\', '/');
  }

  chat(id = CHAT) {
    return { id, provider: 'claude', lasting: 'claude:s1', folder: this.ref(this.box.project), project: this.ref(this.box.project) };
  }

  [Symbol.dispose](): void {
    setWslHostResolver(null);
  }
}

Deno.test({ name: 'wsl subagents (Windows side): a worktree is made in the distro, named by refs; a Windows chat is not its business', ...T, async fn() {
  using box = sandbox();
  using lab = new Lab(box);
  const rec = await ws.wslSubagentPrepare(lab.chat(), meta) as Json;
  assertEquals(rec.state, 'prepared', JSON.stringify(rec));
  assert(String(rec.path).startsWith('wsl://ubuntu' + LINUX_BASE + '/state/worktrees/'), `a ref under the distro's data folder: ${rec.path}`);
  assertEquals(rec.folder, lab.ref(box.project));
  assertEquals((rec.linux as Json).folder, LINUX_BASE + '/proj');
  const sent = lab.host.calls.find(([m]) => m === 'subagent.prepare')![1];
  assertEquals((sent.chat as Json).folder, LINUX_BASE + '/proj', 'the helper gets the Linux folder');
  const winChat = { ...lab.chat(), folder: box.project, project: box.project };
  assertEquals(ws.wslSubagentChat(winChat), null);
  assertEquals(await ws.wslSubagentPrepare(winChat, meta), { deny: 'this chat is not in a WSL folder' });
  const bound = await ws.wslSubagentBind(lab.chat(), 'agent-1');
  assertEquals(bound?.state, 'running');
  await ws.wslSubagentEnd(lab.chat(), 'agent-1');
  const records = await ws.wslSubagentRecords('ubuntu', CHAT);
  assertEquals(records.map((r) => r.state), ['done']);
} });

Deno.test({ name: 'wsl subagents (Windows side): landing runs in the distro; a conflict says where the clean branch is; release removes it', ...T, async fn() {
  using box = sandbox();
  using lab = new Lab(box);
  write(box.project, 'mine.txt', 'my own unsaved work\n');
  const rec = await ws.wslSubagentPrepare(lab.chat(), meta) as Json;
  await ws.wslSubagentBind(lab.chat(), 'agent-1');
  commit((rec.path as string).replace('wsl://ubuntu' + LINUX_BASE, box.base).replaceAll('/', '\\'), 'tracked.txt', 'subagent line\n', 'subagent edit');
  await ws.wslSubagentEnd(lab.chat(), 'agent-1');
  commit(box.project, 'tracked.txt', 'main line\n', 'main edit');
  const hold = { parent: CHAT, target: 'main', title: 'Make the docs', held: [CHAT], states: { [CHAT]: { state: 'ready', busy: false, cwd: LINUX_BASE + '/proj', provider: 'claude' } } };
  const lost = await ws.wslSubagentLand('ubuntu', { id: String(rec.id), ...hold });
  assertEquals(lost.outcome.state, 'conflicts', JSON.stringify(lost.outcome));
  assertEquals([lost.outcome.files, lost.outcome.landable], [['tracked.txt'], `${rec.branch}-landable`]);
  assertEquals(runGit(box.project, 'ls-tree', '--name-only', `${rec.branch}-landable`).split('\n').includes('mine.txt'), false);
  assertEquals(await ws.wslSubagentRelease('ubuntu', String(rec.id)), 'removed');
  await ws.wslSubagentChatClosed('ubuntu', CHAT); // the chat's spare goes with it
  assertEquals((await ws.wslSubagentRecords('ubuntu')).length, 0);
} });

Deno.test({ name: 'wsl subagents (Windows side): a distro that cannot answer is "no worktree" or a refusal a later try may meet, never an edit in the folder', ...T, async fn() {
  using box = sandbox();
  using lab = new Lab(box);
  lab.host.handlers['subagent.prepare'] = () => {
    throw new WslHelperError('the distro stopped', 'stopped');
  };
  const denied = await ws.wslSubagentPrepare(lab.chat(), meta) as Json;
  assert(String(denied.deny).startsWith('the distro could not make it'), JSON.stringify(denied));
  lab.host.handlers['subagent.prepare'] = () => {
    throw new WslHelperError('no such method', 'no_method');
  };
  assertEquals(await ws.wslSubagentPrepare(lab.chat(), meta), { deny: "this distro's AIB helper is too old to give subagents their own worktree" });
  lab.host.handlers['subagent.land'] = () => {
    throw new WslHelperError('the distro stopped', 'stopped');
  };
  const out = await ws.wslSubagentLand('ubuntu', { id: 'x', parent: CHAT, target: 'main', title: 'T', held: [], states: {} });
  assertEquals([out.outcome.state, out.outcome.code], ['refused', 'wsl_unavailable']);
  lab.host.handlers['subagent.release'] = () => {
    throw new WslHelperError('the distro stopped', 'stopped');
  };
  assertEquals(await ws.wslSubagentRelease('ubuntu', 'x'), 'gone');
  assertEquals(runGit(box.project, 'status', '--porcelain').trim(), '', 'the project folder was never touched');
} });
