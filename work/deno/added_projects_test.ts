/**
 * A project is in AIB only when the user adds it (server/desktop/added_projects.ts, server/web/project_routes.ts). Saved chats the
 * agents keep on disk (Claude Code's projects folder, OMP's sessions, the agent's own session list) show only for added projects.
 * Every data folder starts with an empty list. Temp folders only: a temp state folder, a temp Claude projects folder and a temp
 * OMP sessions folder; never the real ones.
 */
import { assert, assertEquals } from './_assert.ts';
import { AddedProjects, NO_PARENT_TTL_MS, STORE_VERSION } from '../../outputs/agent-studio/server/desktop/added_projects.ts';
import { FolderPresence } from '../../outputs/agent-studio/server/desktop/folder_presence.ts';
import { projectKey } from '../../outputs/agent-studio/server/desktop/project_delete.ts';
import { worktreeParent } from '../../outputs/agent-studio/server/desktop/folders.ts';
import { makeContext, WebServer } from '../../outputs/agent-studio/server/web/server.ts';
import { openSource } from '../../outputs/agent-studio/server/transcripts/monitor.ts';
import { Connection } from '../../outputs/agent-studio/server/acp/connection.ts';
import { Studio } from '../../outputs/agent-studio/server/host/studio.ts';
import type { LiveBackend } from '../../outputs/agent-studio/server/host/backend.ts';
import type { UpdateService } from '../../outputs/agent-studio/server/desktop/updater.ts';
import { git, HAVE_GIT } from './_git_repo.ts';
import { fake, pause } from './_connection.ts';

type Json = Record<string, unknown>;
const SEP = Deno.build.os === 'windows' ? '\\' : '/';
const j = (...parts: string[]) => parts.join(SEP);
const T = { sanitizeResources: false, sanitizeOps: false };

async function tempRoot(): Promise<string> {
  return (await Deno.realPath(await Deno.makeTempDir({ prefix: 'aib-added-projects-' }))).replace(/^\\\\\?\\/, '');
}
const exists = (p: string) => {
  try {
    Deno.statSync(p);
    return true;
  } catch {
    return false;
  }
};

/** One saved Claude Code chat in `cwd` (the encoded folder name is made up; AIB reads the cwd from the rows). */
function claudeChat(claude: string, id: string, cwd: string): void {
  const folder = j(claude, 'enc-' + id);
  Deno.mkdirSync(folder, { recursive: true });
  const stamp = '2026-11-10T10:00:00Z';
  const rows = [
    { type: 'user', sessionId: id, cwd, timestamp: stamp, message: { role: 'user', content: `Work in ${id}` } },
    { type: 'assistant', sessionId: id, cwd, timestamp: stamp, message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: 'Done.' }] } },
  ];
  Deno.writeTextFileSync(j(folder, id + '.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

/** One saved OMP chat in `cwd`. */
function ompChat(omp: string, id: string, cwd: string): void {
  const folder = j(omp, 'enc-' + id);
  Deno.mkdirSync(folder, { recursive: true });
  const rows = [
    { type: 'session', id, cwd, timestamp: '2026-11-10T10:00:00Z' },
    { type: 'message', message: { role: 'user', content: `Work in ${id}` } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } },
  ];
  Deno.writeTextFileSync(j(folder, `2026-11-10T10-00-00-000Z_${id}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

/**
 * A Studio web server on a temp state folder with fake agent history in three folders (Alpha: Claude, Beta: Claude, Gamma: OMP)
 * and a stub agent host: connect answers like a real one, discover lists `pages` (one page per cursor), the live list carries
 * `recovered`.
 */
async function studio(options: { root?: string } = {}) {
  const root = options.root ?? await tempRoot();
  const state = j(root, 'state'), claude = j(root, 'claude'), omp = j(root, 'omp');
  const alpha = j(root, 'work', 'Alpha'), beta = j(root, 'work', 'Beta'), gamma = j(root, 'work', 'Gamma');
  for (const d of [state, claude, omp, alpha, beta, gamma]) Deno.mkdirSync(d, { recursive: true });
  if (!options.root) {
    claudeChat(claude, 'chat-alpha', alpha);
    claudeChat(claude, 'chat-beta', beta);
    ompChat(omp, 'chat-gamma', gamma);
  }
  const connections: Json[] = [];
  const recovered: Json[] = [];
  const discovered: { asked: unknown[]; pages: Json[][] } = { asked: [], pages: [] };
  const host = {
    hostMode: 'test',
    liveInfo: () => Promise.resolve({ connections, instanceId: 'test' }),
    liveList: () => Promise.resolve({ connections, recovered }),
    liveState: () => Promise.resolve({}),
    liveCall: (op: string, body: Json) => {
      if (op === 'connect') {
        const c = { id: 'live-' + connections.length, provider: body.provider, cwd: body.cwd, projectRoot: body.cwd, sessionId: 's' };
        connections.push(c);
        return Promise.resolve([200, c]);
      }
      if (op === 'discover') {
        discovered.asked.push(body.cursor ?? null);
        const at = typeof body.cursor === 'string' ? Number(body.cursor) : 0;
        const sessions = discovered.pages[at] ?? [];
        return Promise.resolve([200, { supported: true, sessions, nextCursor: at + 1 < discovered.pages.length ? String(at + 1) : null }]);
      }
      return Promise.resolve([200, { ok: true }]);
    },
    emitArtifact: () => Promise.resolve(true),
  } as unknown as LiveBackend;
  const ctx = makeContext({
    stateDir: state,
    host,
    updates: {} as UpdateService,
    webInstanceId: 'test',
    cliPort: 0,
    transcripts: await openSource(omp, claude),
    claudeProjects: claude,
    ompSessions: omp,
    shutdown: () => {},
  });
  ctx.folderPresence = new FolderPresence(undefined, 0); // no cache: a folder that goes or comes back is seen at once
  const web = new WebServer(ctx);
  const port = await web.listen(0);
  const origin = `http://127.0.0.1:${port}`;
  const get = async (path: string): Promise<Json> => {
    const r = await fetch(origin + path, { headers: { 'X-Studio-Token': ctx.token } });
    const body = await r.json();
    assertEquals(r.status, 200, `${path}: ${JSON.stringify(body)}`);
    return body;
  };
  const post = async (name: string, body: Json, status = 200): Promise<Json> => {
    const r = await fetch(`${origin}/api/live/${name}`, {
      method: 'POST',
      headers: { 'X-Studio-Token': ctx.token, 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify(body),
    });
    const out = await r.json();
    assertEquals(r.status, status, `${name}: ${JSON.stringify(out)}`);
    return out;
  };
  /** The folders of the saved chats AIB lists (what the page builds its projects and chats from). */
  const listed = async () => ((await get('/api/sessions')).sessions as Json[]).map((s) => s.cwd as string).sort();
  const prefs = async () => (await get('/api/live/project-prefs')).added as Record<string, { path: string; gone?: true }>;
  const added = async () => Object.values(await prefs()).map((a) => a.path).sort();
  return {
    root, state, claude, omp, alpha, beta, gamma, ctx, get, post, listed, prefs, added, connections, recovered, discovered,
    close: async (keep = false) => {
      await web.close();
      if (!keep) await Deno.remove(root, { recursive: true }).catch(() => {});
    },
  };
}

Deno.test('a data folder with agent history in three folders: no projects and no chats are shown', async () => {
  const s = await studio();
  try {
    assertEquals(await s.listed(), []);
    assertEquals(await s.added(), []);
    // the agent's own session list ("Find more chats via agent") lists nothing either, and adds nothing
    s.discovered.pages = [[s.alpha, s.beta, s.gamma].map((cwd, i) => ({ sessionId: `listed-${i}`, cwd }))];
    assertEquals(((await s.post('discover', { provider: 'claude' })).sessions as Json[]).length, 0);
    assertEquals(await s.added(), []);
    // nothing on disk was changed: the three transcripts are all still there, and the list file is not even written
    assertEquals([...Deno.readDirSync(s.claude)].length + [...Deno.readDirSync(s.omp)].length, 3);
    assert(!exists(j(s.state, AddedProjects.FILE)));
  } finally {
    await s.close();
  }
});

Deno.test('adding one project shows it and its saved chats; the other two folders stay out', async () => {
  const s = await studio();
  try {
    const reply = await s.post('project-add', { path: s.alpha });
    assertEquals(Object.keys(reply.added as Json), [projectKey(s.alpha)]);
    assertEquals(await s.listed(), [s.alpha]);
    s.discovered.pages = [[s.alpha, s.beta, s.gamma].map((cwd, i) => ({ sessionId: `listed-${i}`, cwd }))];
    assertEquals(((await s.post('discover', { provider: 'claude' })).sessions as Json[]).map((x) => x.cwd), [s.alpha]);
    await s.post('project-add', { paths: [s.gamma] }); // an OMP chat's folder works the same way
    assertEquals(await s.listed(), [s.alpha, s.gamma].sort());
    assertEquals(await s.added(), [s.alpha, s.gamma].sort());
  } finally {
    await s.close();
  }
});

Deno.test('"Find more chats via agent" skips pages with no chat of an added project, up to five pages a click', async () => {
  const s = await studio();
  try {
    await s.post('project-add', { path: s.alpha });
    const elsewhere = (n: number) => [{ sessionId: `b-${n}`, cwd: s.beta }];
    s.discovered.pages = [elsewhere(0), elsewhere(1), [{ sessionId: 'a-2', cwd: s.alpha }], elsewhere(3)];
    const first = await s.post('discover', { provider: 'claude' });
    assertEquals([(first.sessions as Json[]).map((x) => x.sessionId), first.nextCursor], [['a-2'], '3']);
    assertEquals(s.discovered.asked, [null, '1', '2']);
    s.discovered.pages = Array.from({ length: 8 }, (_, i) => elsewhere(i));
    s.discovered.asked = [];
    const empty = await s.post('discover', { provider: 'claude' });
    assertEquals([(empty.sessions as Json[]).length, empty.nextCursor, s.discovered.asked.length], [0, '5', 5]);
  } finally {
    await s.close();
  }
});

Deno.test('starting a chat in a new folder adds it as a project', async () => {
  const s = await studio();
  try {
    await s.post('connect', { provider: 'claude', cwd: s.beta });
    assertEquals(await s.added(), [s.beta]);
    assertEquals(await s.listed(), [s.beta]); // its older saved chat shows too
  } finally {
    await s.close();
  }
});

Deno.test({
  name: 'a chat the agent host opens by itself (auto-reconnect, take-over, an agent) adds its folder too: Studio.connect',
  ...T,
  async fn() {
    const root = await tempRoot();
    const state = j(root, 'state'), folder = j(root, 'work', 'Delta');
    Deno.mkdirSync(folder, { recursive: true });
    const studio = new Studio({ ompCommand: 'unused', stateDir: state, port: 0 });
    studio.ownerProbe = () => null;
    studio.connectionFactory = (_command, cwd, provider) => new Connection(fake(), cwd, provider);
    try {
      await studio.connect('omp', folder, null);
      for (let i = 0; i < 50 && !new AddedProjects(state).added.size; i++) await pause(20);
      assertEquals([...new AddedProjects(state).added.values()].map((a) => a.path), [folder]);
    } finally {
      await studio.close().catch(() => {});
      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test('recovered chats (open before a restart) of folders that are not added are not listed', async () => {
  const s = await studio();
  try {
    s.recovered.push({ provider: 'claude', sessionId: 'r1', cwd: s.alpha }, { provider: 'claude', sessionId: 'r2', cwd: s.beta });
    await s.post('project-add', { path: s.alpha });
    assertEquals(((await s.get('/api/live/list')).recovered as Json[]).map((r) => r.sessionId), ['r1']);
  } finally {
    await s.close();
  }
});

Deno.test('removing a project takes it off the list, and its saved chats do not bring it back', async () => {
  const s = await studio();
  try {
    await s.post('project-add', { paths: [s.alpha, s.beta] });
    await s.post('project-remove', { path: s.beta, disk: false, projects: [s.alpha] });
    assertEquals([await s.added(), await s.listed()], [[s.alpha], [s.alpha]]);
    await s.close(true); // a restart: the same data folder, nothing comes back
    const again = await studio({ root: s.root });
    try {
      assertEquals([await again.added(), await again.listed()], [[s.alpha], [s.alpha]]);
      assert(Deno.statSync(s.beta).isDirectory, 'the folder itself is kept (Delete project without the disk box)');
      // added again with New project: it and its chats are back
      await again.post('project-add', { path: s.beta });
      assertEquals(await again.listed(), [s.alpha, s.beta].sort());
    } finally {
      await again.close(true);
    }
  } finally {
    await Deno.remove(s.root, { recursive: true }).catch(() => {});
  }
});

Deno.test('an added project whose folder is gone is flagged (with fix/drop-gone-projects\' check) and comes back with its folder', async () => {
  const s = await studio();
  try {
    await s.post('project-add', { paths: [s.alpha, s.beta] });
    const before = (await s.get('/api/live/list')).projectsRevision;
    await Deno.rename(s.beta, s.beta + '-away');
    const after = (await s.get('/api/live/list')).projectsRevision;
    assert(before !== after, 'the page is told to fetch the project list again');
    assertEquals((await s.prefs())[projectKey(s.beta)].gone, true);
    assertEquals((await s.prefs())[projectKey(s.alpha)].gone, undefined);
    // the drop-gone branch's folder check answers the same for the page's chats
    const gone = await s.get(`/api/live/folders/gone?paths=${encodeURIComponent(JSON.stringify([s.alpha, s.beta]))}`);
    assertEquals(gone.gone, [s.beta]);
    assertEquals(await s.added(), [s.alpha, s.beta].sort(), 'still added: nothing is removed');
    await Deno.rename(s.beta + '-away', s.beta);
    assert((await s.get('/api/live/list')).projectsRevision !== after);
    assertEquals((await s.prefs())[projectKey(s.beta)].gone, undefined);
  } finally {
    await s.close();
  }
});

Deno.test('an unreadable list is restored from its backup, else it starts empty; never refilled from the agents\' history', async () => {
  const root = await tempRoot();
  try {
    const one = new AddedProjects(root);
    await one.add(j(root, 'p'));
    assert(exists(j(root, AddedProjects.BACKUP)), 'every save writes the backup too');
    Deno.writeTextFileSync(j(root, AddedProjects.FILE), '{not json');
    const two = new AddedProjects(root);
    assertEquals([...two.added.values()].map((a) => a.path), [j(root, 'p')]);
    assert([...Deno.readDirSync(root)].some((e) => e.name.includes('corrupt')), 'the unreadable file is kept aside');
    // missing (the unreadable one was moved aside): the backup again
    assert(!exists(j(root, AddedProjects.FILE)));
    assertEquals(new AddedProjects(root).added.size, 1);
    // no backup either: empty (history files of an older AIB change nothing)
    Deno.writeTextFileSync(j(root, AddedProjects.FILE), '[]');
    Deno.removeSync(j(root, AddedProjects.BACKUP));
    Deno.writeTextFileSync(j(root, 'studio-conversations.json'), '{"version":1,"entries":{}}');
    const three = new AddedProjects(root);
    assertEquals([three.added.size, three.shows(j(root, 'p'))], [0, false]);
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test('a list written by a newer AIB is read and never overwritten; this store has its own version', async () => {
  const root = await tempRoot();
  try {
    const path = j(root, 'p');
    const text = JSON.stringify({ version: STORE_VERSION + 1, added: { [projectKey(path)]: { path, at: 1 } }, extra: 'new' });
    Deno.writeTextFileSync(j(root, AddedProjects.FILE), text);
    const store = new AddedProjects(root);
    assert(store.newer && store.shows(path));
    let refused = '';
    await store.add(j(root, 'q')).catch((e) => (refused = (e as Error).message));
    assert(/newer AIB/.test(refused), refused);
    await store.remove(path).catch(() => {});
    assertEquals(await store.addOpened(j(root, 'q')), false);
    assertEquals(Deno.readTextFileSync(j(root, AddedProjects.FILE)), text, 'untouched');
    assert(!exists(j(root, AddedProjects.BACKUP)));
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test('worktree lookups: network and WSL paths are never read; a "not a worktree" answer is asked again after a minute', () => {
  const asked: string[] = [];
  let answer: string | null = null;
  const store = new AddedProjects(null, { parentOf: (p) => (asked.push(p), answer) });
  let clock = 1000;
  store.clock = () => clock;
  assertEquals([store.parentOf('\\\\server\\share\\x'), store.parentOf('\\\\wsl$\\Ubuntu\\home\\x'), asked.length], [null, null, 0]);
  assertEquals(worktreeParent('\\\\wsl$\\Ubuntu\\home\\x'), null);
  const folder = j('C:', 'w', 'later-a-worktree');
  assertEquals(store.parentOf(folder), null);
  answer = j('C:', 'w', 'main');
  assertEquals(store.parentOf(folder), null, 'cached for now');
  clock += NO_PARENT_TTL_MS + 1;
  assertEquals(store.parentOf(folder), answer);
  assertEquals(asked.length, 2);
});

Deno.test('a Claude Code worktree folder belongs to its repository even after it is gone (the server and the page agree)', () => {
  const repo = j('C:', 'gone', 'repo');
  const store = new AddedProjects(null);
  assertEquals(store.projectFolder(j(repo, '.claude', 'worktrees', 'feature-x')), repo);
  assertEquals(store.projectFolder(j(repo, '.claude', 'worktrees', 'feature-x', 'src')), repo);
  assertEquals(store.projectFolder(j(repo, 'plain')), j(repo, 'plain'));
  // folders/kinds (what the page files chats by) names the same parent
  assertEquals(worktreeParent(j(repo, '.claude', 'worktrees', 'feature-x'))?.[0], repo);
});

Deno.test({
  name: 'worktree chats under an added project show; a worktree folder adds, and removes, its main checkout',
  ignore: !HAVE_GIT,
  async fn() {
    const s = await studio();
    try {
      git(s.alpha, 'init', '-q');
      Deno.writeTextFileSync(j(s.alpha, 'a.txt'), 'a\n');
      git(s.alpha, 'add', '-A');
      git(s.alpha, 'commit', '-q', '-m', 'base');
      const wt = j(s.root, 'elsewhere', 'alpha-wt');
      git(s.alpha, 'worktree', 'add', '-q', '-b', 'side', wt);
      claudeChat(s.claude, 'chat-alpha-wt', wt);
      assertEquals(await s.listed(), []);
      await s.post('project-add', { path: s.alpha });
      assertEquals(await s.listed(), [s.alpha, wt].sort());
      // Delete project with the worktree's folder (the page's key differs from the list's): the main checkout goes
      await s.post('project-remove', { path: wt, disk: false, projects: [] });
      assertEquals([await s.added(), await s.listed()], [[], []]);
      // a chat started in the worktree folder adds the main checkout back, not the worktree
      await s.post('connect', { provider: 'claude', cwd: wt });
      assertEquals((await s.added()).map((p) => projectKey(p)), [projectKey(s.alpha)]);
      assertEquals(await s.listed(), [s.alpha, wt].sort());
    } finally {
      await s.close();
    }
  },
});
