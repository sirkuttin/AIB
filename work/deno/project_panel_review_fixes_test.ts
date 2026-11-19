/**
 * The fixes of the project right panel code review (aib-shared/reviews/project-right-panel-code-review.md), server side. No browser.
 *
 *   M1  Changes and Docs are the PROJECT's: a chat whose folder is a worktree of the project gets the project folder's Changes (list,
 *       "Show the next 300", file diffs) and docs, never the worktree's own.
 *   M3  The artifacts list does not scan transcripts per read: chat -> folder is cached between reads, and there is no 80-chat cutoff.
 *   S2  A left-over worktree's numbers are counted again only when its HEAD or files' times move.
 *   S6  The remote-PC filter on the project Changes route (remoteProject): rows inside blocked folders are left out of main and of
 *       a worktree section, and a file diff that resolves into a blocked folder is refused.
 *
 * Test servers on random ports, temp state (never the owner's), no browser. Needs git on PATH.
 */
import { assert, assertEquals } from './_assert.ts';
import { readRemotePort } from '../../outputs/agent-studio/server/remote/port.ts';
import { DEVICE_HEADER, RateLimit } from '../../outputs/agent-studio/server/remote/pc_bridge.ts';
import { ChatFolderCache, projectArtifacts } from '../../outputs/agent-studio/server/artifacts/project_list.ts';
import { leftCounted, leftSignature, projectChanges } from '../../outputs/agent-studio/server/worktrees/project_changes.ts';
import { fakeTailscale, type FakeChat, pairPhone, pc, phoneHeaders, raw, type RemoteStudio, remoteStudio, serveStatus } from './_remote_fixture.ts';
import { git, HAVE_GIT, write } from './_git_repo.ts';

type Json = Record<string, unknown>;
const OPTS = { sanitizeResources: false, sanitizeOps: false, ignore: !HAVE_GIT };
const SEP = Deno.build.os === 'windows' ? '\\' : '/';

function chat(id: string, cwd: string): FakeChat {
  return {
    id, provider: 'claude', sessionId: 'sess-' + id, cwd, busy: false, closed: false,
    attention: { state: 'idle', needs: 0, turnEndedAt: null, busySince: null }, subagents: {}, events: [], permissions: [], elicitations: [],
  };
}

/** A repository `app` with one commit, an uncommitted edit in it, and a real git worktree `app-wt` with an edit of its own. */
async function repoWithWorktree() {
  const s = await remoteStudio();
  const repo = `${s.root}${SEP}projects${SEP}app`;
  const wt = `${s.root}${SEP}projects${SEP}app-wt`;
  Deno.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  write(`${repo}${SEP}app.txt`, 'one\ntwo\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  git(repo, 'worktree', 'add', '-q', '-b', 'side', wt, 'HEAD');
  write(`${repo}${SEP}app.txt`, 'one\ntwo\nMAIN EDIT\n');
  write(`${repo}${SEP}main-only.txt`, 'main\n');
  write(`${wt}${SEP}app.txt`, 'one\ntwo\nWORKTREE EDIT\n');
  write(`${wt}${SEP}wt-only.txt`, 'worktree\n');
  s.chats.push(chat('c1', repo), chat('c9', wt)); // c9 works in the worktree
  s.ctx.transcripts = {
    root: s.state,
    sessions: () => Promise.resolve([]),
    agents: () => Promise.resolve([]),
    sessionCwd: () => Promise.resolve(null),
  } as unknown as typeof s.ctx.transcripts;
  return { s, repo, wt };
}
const filesOf = (reply: Json) => (((reply.main as Json).changes as Json).files as Json[]);
const paths = (reply: Json) => filesOf(reply).map((f) => f.path).sort();

Deno.test({
  ...OPTS,
  name: 'M1: a chat working in a worktree gets the PROJECT folder\'s Changes (list, next page, file diffs) and docs, not the worktree\'s',
  async fn() {
    const { s, repo } = await repoWithWorktree();
    try {
      const [st1, fromMain] = await pc(s, 'GET', '/api/live/project/changes?id=c1');
      const [st9, fromWt] = await pc(s, 'GET', '/api/live/project/changes?id=c9');
      assertEquals([st1, st9], [200, 200], JSON.stringify(fromWt));
      assertEquals(paths(fromMain), ['app.txt', 'main-only.txt']);
      assertEquals(paths(fromWt), ['app.txt', 'main-only.txt'], 'the worktree chat sees the project\'s files, not wt-only.txt');
      assertEquals((fromWt.main as Json).branch, (fromMain.main as Json).branch, 'the header branch is the project\'s');
      // "Show the next 300": main only, by the project route
      const [stm, more] = await pc(s, 'GET', '/api/live/project/changes?id=c9&only=main&offset=1');
      assertEquals(stm, 200);
      assertEquals(more.sections, []);
      assertEquals(filesOf(more), filesOf(fromMain).slice(1));
      // main's file diff: the project's text
      const [sd, diff] = await pc(s, 'GET', '/api/live/project/changes/file?id=c9&section=main&path=app.txt');
      assertEquals(sd, 200);
      assert(JSON.stringify(diff).includes('MAIN EDIT') && !JSON.stringify(diff).includes('WORKTREE EDIT'), 'the diff is the project folder\'s');
      assertEquals((await pc(s, 'GET', '/api/live/project/changes/file?id=c9&section=main&path=wt-only.txt'))[1].code, 'not_changed', 'the worktree\'s own file is not main\'s');
      // Docs: a doc made through the worktree chat lands in the PROJECT folder, and both chats list it
      const [sc, made] = await pc(s, 'POST', '/api/live/docs/open', { id: 'c9', name: 'Plan', create: '' });
      assertEquals(sc, 200, JSON.stringify(made));
      const inProject = [...Deno.readDirSync(`${repo}${SEP}aib-docs`)].map((e) => e.name);
      assert(inProject.length > 0, 'the doc is in the project folder\'s aib-docs');
      assert(!(await Deno.stat(`${s.root}${SEP}projects${SEP}app-wt${SEP}aib-docs`).then(() => true, () => false)), 'nothing in the worktree');
      for (const id of ['c1', 'c9']) {
        const [sl, list] = await pc(s, 'GET', `/api/live/docs/list?id=${id}&root=main`);
        assertEquals(sl, 200);
        assertEquals((list.docs as Json[]).map((d) => d.name), ['plan'], `docs listed for ${id}`);
      }
    } finally {
      await s.close();
    }
  },
});

Deno.test('M3: chat -> folder is looked up once per chat between reads; more than 80 chats still all list; the cache resets when the live chats change', async () => {
  const asked: string[] = [];
  const project = Deno.build.os === 'windows' ? 'C:\\w\\app' : '/w/app';
  const manifests = Array.from({ length: 120 }, (_, i) => ({
    id: 'a' + i, conversationId: 'claude:chat-' + i, project: null, title: 't' + i, updatedAt: i, pinned: false,
  }));
  const store = { all: () => manifests, summary: (m: Json) => ({ id: m.id, title: m.title }) } as unknown as Parameters<typeof projectArtifacts>[0];
  let clock = 0;
  const cache = new ChatFolderCache(60_000, 5_000, () => clock);
  const deps = {
    mainOf: (p: string) => p,
    chatFolder: (c: string) => cache.get(c, (chat) => {
      asked.push(chat);
      return Promise.resolve(chat === 'claude:chat-7' ? null : project); // chat-7 has no known folder
    }),
  };
  const read = () => projectArtifacts(store, project, deps);
  const first = await read();
  assertEquals(first.artifacts.length, 119, 'all 120 chats looked up (there is no 80-chat cutoff); the unknown one is left out');
  assertEquals(asked.length, 120);
  await read();
  assertEquals(asked.length, 120, 'a second read looks nobody up');
  clock = 6_000;
  await read();
  assertEquals(asked.length, 121, 'a miss is asked again after its short time; hits are kept');
  cache.reset('c1|c2');
  await read();
  assertEquals(asked.length, 121 + 120, 'a changed set of live chats drops the cache');
  cache.reset('c1|c2');
  await read();
  assertEquals(asked.length, 121 + 120, 'the same set keeps it');
});

Deno.test({
  ...OPTS,
  name: 'S2: a left-over worktree is counted again only when its HEAD or its files\' times change',
  async fn() {
    const { s, repo, wt } = await repoWithWorktree();
    try {
      const record = {
        id: 'sub-left', kind: 'subagent', chat: 'ghost', lasting: 'claude:ghost', project: repo, folder: repo, slug: 'sub-left', branch: 'side', path: wt,
        snapshot: git(wt, 'rev-parse', 'HEAD').trim(), tree: '', state: 'stopped', toolUseId: 't', agentId: 'a', agentType: 'general-purpose',
        description: 'old', createdAt: 1,
      };
      const args = { folder: repo, stateDir: s.state, subs: { 'sub-left': record } as never, helpers: [], fold: new Set<string>(), unfold: new Set<string>() };
      const before = leftCounted.n;
      const one = await projectChanges(args);
      assertEquals((one.left as Json[]).length, 1);
      assertEquals(leftCounted.n, before + 1);
      for (let i = 0; i < 3; i++) await projectChanges(args);
      assertEquals(leftCounted.n, before + 1, 'unchanged: read from the cache, no git for it');
      assert(leftSignature(wt) !== '', 'a signature exists for a real worktree');
      // a file in it changes: the folder time moves (a new file) and the index time with a commit
      await new Promise((r) => setTimeout(r, 30));
      write(`${wt}${SEP}later.txt`, 'new\n');
      await projectChanges(args);
      assertEquals(leftCounted.n, before + 2, 'a new file: counted again');
      git(wt, 'add', '-A');
      git(wt, 'commit', '-q', '-m', 'more');
      const two = await projectChanges({ ...args, subs: { 'sub-left': { ...record } } as never });
      assertEquals(leftCounted.n, before + 3, 'a new HEAD: counted again');
      assertEquals(((two.left as Json[])[0].counts as Json).files, 3, 'app.txt, wt-only.txt and later.txt against the snapshot: the recount is real');
    } finally {
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'S6: a remote computer\'s project Changes leaves out rows inside blocked folders (main and a worktree section) and refuses a diff that resolves into one',
  async fn() {
    const fake = fakeTailscale();
    const s: RemoteStudio = await remoteStudio({ runner: fake.runner }, undefined, { saved: true });
    try {
      fake.state.serve = serveStatus(readRemotePort(s.state)!);
      assertEquals((await pc(s, 'POST', '/api/live/devices/access', { on: true }))[0], 200);
      (s.ctx.phone.server!.bridge as unknown as { limit: RateLimit }).limit = new RateLimit(1e6, 1e6);
      // The project is the whole fixture root: AIB's own state folder sits inside it, a blocked folder inside main. A worktree whose
      // folder is inside the state folder is a section that is blocked as a whole.
      git(s.root, 'init', '-q', '-b', 'main');
      write(`${s.root}${SEP}ok.txt`, 'fine\n');
      git(s.root, 'add', 'ok.txt');
      git(s.root, 'commit', '-q', '-m', 'base');
      write(`${s.root}${SEP}ok.txt`, 'fine\nedited\n');
      write(`${s.root}${SEP}public.txt`, 'public\n');
      const blockedWt = `${s.state}${SEP}hidden-wt`;
      git(s.root, 'worktree', 'add', '-q', '-b', 'hidden', blockedWt, 'HEAD');
      write(`${blockedWt}${SEP}secret.txt`, 'secret\n');
      const record = {
        id: 'sub-h', kind: 'subagent', chat: 'c1', lasting: 'claude:sess-c1', project: s.root, folder: s.root, slug: 'sub-h', branch: 'hidden', path: blockedWt,
        snapshot: git(blockedWt, 'rev-parse', 'HEAD').trim(), tree: '', state: 'running', toolUseId: 't', agentId: 'a', agentType: 'general-purpose',
        description: 'hidden job', createdAt: 1,
      };
      Deno.writeTextFileSync(`${s.state}${SEP}subagent-worktrees.json`, JSON.stringify({ version: 1, subagents: { 'sub-h': record } }));
      s.chats.push(chat('c1', s.root));
      const laptop = await pairPhone(s, 'Laptop', undefined, 'computer');
      const call = (path: string) => raw(s.phonePort(), 'GET', path, { ...phoneHeaders({}, 'GET'), [DEVICE_HEADER]: laptop.token });
      // the page itself (this PC) sees everything
      const [, local] = await pc(s, 'GET', '/api/live/project/changes?id=c1');
      const localMain = (((local.main as Json).changes as Json).files as Json[]).map((f) => String(f.path));
      assert(localMain.some((p) => p.startsWith('state/')), `main lists the state folder locally: ${localMain}`);
      assertEquals((((local.sections as Json[])[0].changes as Json).files as Json[]).map((f) => f.path), ['secret.txt'], 'the worktree section lists its file locally');
      // the remote computer: the blocked rows are gone
      const r = await call('/api/live/project/changes?id=c1');
      assertEquals(r.status, 200, r.text);
      const main = (((r.json.main as Json).changes as Json).files as Json[]).map((f) => String(f.path));
      assert(main.includes('ok.txt') && main.includes('public.txt'), `the project's own rows stay: ${main}`);
      assert(!main.some((p) => p.startsWith('state/')), `no row inside the blocked state folder: ${main}`);
      const sec = (r.json.sections as Json[])[0];
      assertEquals(sec.id, 'sub-h');
      assertEquals(((sec.changes as Json).files as Json[]).length, 0, 'every row of the blocked worktree is left out');
      // (known, minor: a folded or head count still includes the blocked rows' numbers; docs rows are not filtered)
      // a file diff that resolves into a blocked folder is refused
      const diffMain = await call('/api/live/project/changes/file?id=c1&section=main&path=state%2Fdevices.json');
      assert(diffMain.status === 403 && diffMain.json.code === 'blocked_folder', `main: ${diffMain.status} ${diffMain.text}`);
      const diffWt = await call('/api/live/project/changes/file?id=c1&section=sub-h&path=secret.txt');
      assert(diffWt.status === 403 && diffWt.json.code === 'blocked_folder', `worktree: ${diffWt.status} ${diffWt.text}`);
      const okDiff = await call('/api/live/project/changes/file?id=c1&section=main&path=ok.txt');
      assertEquals(okDiff.status, 200, okDiff.text);
    } finally {
      await s.close();
    }
  },
});
