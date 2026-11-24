/**
 * Real WSL (AIB_WSL_E2E=<distro>; see _wsl_e2e.ts): Merge for a WSL chat's worktree, run by the distro's helper (wsl/helper/merge.ts)
 * and reached through AIB's own merge routes (web/aib_routes.ts -> wsl/merge.ts):
 *   - the chat's agent edits and commits in its copy; the Merge button's state; a clean merge lands its commit on main with the
 *     "Merged into main (1 commit)" note in the chat;
 *   - main moved with a conflicting change: the merge stops with the conflict line, nothing lands; resolved and committed in the copy,
 *     the next merge lands;
 *   - a merge in progress in the main checkout: refused with the Windows line, main does not move;
 *   - a restarted AIB adopts the chat and merges it (the registry, locks and clash records are in the distro);
 *   - the user's unsaved edit on the same line: merged, the edit kept in the named stash, the clash line in the distro, Keep my version;
 *   - uncommitted edits in the main checkout are set aside and put back, never overwritten; the Merge button sends the fixed message.
 * Everything is inside AIB_WSL_ROOT=/tmp/aib-wsl-test-<random>; the fake agent is work/fake_acp.py.
 */
import { assert, assertEquals } from './_assert.ts';
import { until } from './_connection.ts';
import { cleanRoot, inDistro, KEY, newAib, prepareRoot, readyHost, ROOT, T } from './_wsl_e2e.ts';
import { Connection } from '../../app/server/acp/connection.ts';
import { Aib } from '../../app/server/host/aib.ts';
import { refOf } from '../../app/server/platform/location.ts';
import { aibRoutes } from '../../app/server/web/aib_routes.ts';

type Json = Record<string, unknown>;

function aibIn(state: string): Aib {
  const aib = new Aib({ stateDir: state, port: 0, ownersDir: null, noArtifactTool: true }, { keeper: null });
  aib.ownerProbe = () => null;
  aib.connectionFactory = (_command, cwd, provider, options) =>
    new Connection(['python3', `${ROOT}/fake_acp.py`, '--cancel-aware'], cwd, provider, {
      ...options,
      wsl: options?.wsl ? { ...options.wsl, program: '/usr/bin/python3' } : options?.wsl,
    });
  return aib;
}

const sh = async (script: string, ...args: string[]) => (await inDistro(script, args)).out.trim();
const notes = (c: Connection) => c.events.filter((e) => e.kind === 'studio_note').map((e) => String((e.data as Json).message));
const NL = '\\n'; // the fake agent's edit: turns write a literal \n as a newline

/** AIB's merge routes over an AIB (the web server's context, the parts the routes read). */
function routesOf(aib: Aib) {
  const ctx = { stateDir: aib.stateDir, host: aib, conversations: { public: () => ({ entries: {} }) } } as never;
  const routes = aibRoutes();
  const request = new Request('http://127.0.0.1/');
  const url = (path: string) => new URL(`http://127.0.0.1${path}`);
  return {
    status: async (id: string) => (await routes.get('GET /api/live/worktree')!(ctx, url(`/api/live/worktree?id=${id}`), null, request))[1] as Json,
    clash: async (project: string) =>
      (await routes.get('GET /api/live/worktree/clash')!(ctx, url(`/api/live/worktree/clash?project=${encodeURIComponent(project)}`), null, request))[1] as Json,
    post: (path: string, body: Json) => routes.get(`POST ${path}`)!(ctx, url(path), body, request) as Promise<[number, Json]>,
  };
}

/**
 * The turn merge.ts's own prompt started (a conflict to resolve, a clash to explain): the fake agent does not act on such text, so
 * the test answers its question or stops the turn, and the chat is idle again.
 */
async function quiet(aib: Aib, c: Connection): Promise<void> {
  await until(() => !c.busy || c.permissions.size > 0, 'the prompt turn', 60);
  if (c.busy) await aib.liveCall('cancel', { id: c.id });
  await until(() => !c.busy, 'the prompt turn to end', 60);
}

/** One turn of the fake agent (edit:<path>|<text>, commit:<message>), answered when it ends. */
async function turn(aib: Aib, c: Connection, text: string): Promise<void> {
  await aib.liveCall('prompt', { id: c.id, text, clientMessageId: crypto.randomUUID() });
  await until(() => !c.busy, `the turn "${text}"`, 60);
}

Deno.test({
  name: "wsl e2e: Merge of a WSL chat's worktree runs in the distro: clean, conflict, refused, after a restart, clash, dirty main",
  ...T,
  async fn() {
    const state = Deno.makeTempDirSync({ prefix: 'aib-wsl-merge-e2e-' });
    await prepareRoot();
    const aibs: Aib[] = [];
    try {
      await readyHost();
      const repo = `${ROOT}/repo`;
      const ref = refOf({ kind: 'wsl', distro: KEY, linuxPath: repo });
      await sh('git -C "$1" branch -M main', repo); // the distro's git may default to master; the temp repo uses main
      const a = aibIn(state);
      aibs.push(a);
      const c = await a.connect('claude', ref, null, { ownCopy: true });
      const linux = c.agentCwd;
      assert(c.worktree?.branch.startsWith('studio/chat-'), 'the chat works in its own copy');
      const api = routesOf(a);
      assertEquals((await api.status(c.id)).state, 'nochanges');

      // ---- a clean merge: the chat's commit lands on main, the "Merged into" note is in the chat, the copy goes on from main
      await turn(a, c, `edit:new.txt|chat${NL}`);
      await turn(a, c, 'commit:chat work');
      const ready = await api.status(c.id);
      assertEquals([ready.worktree, ready.enabled, ready.state, ready.label], [true, true, 'ready', 'Merge into main']);
      const [s1, merged] = await api.post('/api/live/worktree/merge', { id: c.id, title: 'T' });
      assertEquals([s1, merged.state, merged.message], [200, 'merged', 'Merged into main (1 commit)']);
      assertEquals(await sh('git -C "$1" log -1 --format=%s main', repo), 'chat work');
      assertEquals(await sh('git -C "$1" show main:new.txt', repo), 'chat');
      assert(notes(c).includes('Merged into main (1 commit)'), notes(c).join(' | '));
      assertEquals(await sh('git -C "$1" rev-parse HEAD', linux), await sh('git -C "$1" rev-parse main', repo), 'the copy goes on from main');
      assertEquals((await api.status(c.id)).state, 'nochanges');

      // ---- main moved with a conflicting change: nothing lands until the chat resolves it in its copy
      await sh('cd "$1" && echo main > new.txt && git commit -qam "main edit"', repo);
      await turn(a, c, `edit:new.txt|chat two${NL}`);
      await turn(a, c, 'commit:chat edit');
      const mainBefore = await sh('git -C "$1" rev-parse main', repo);
      const [s2, conflict] = await api.post('/api/live/worktree/merge', { id: c.id });
      assertEquals([s2, conflict.state, conflict.files], [200, 'conflicts', ['new.txt']]);
      assertEquals(await sh('git -C "$1" rev-parse main', repo), mainBefore, 'nothing landed');
      await quiet(a, c); // merge.ts asked the chat to resolve them
      const waiting = await api.status(c.id);
      assertEquals([waiting.state, waiting.files], ['conflicts', ['new.txt']]);
      await sh('cd "$1" && printf "main\\nchat two\\n" > new.txt && git add new.txt && git -c user.name=t -c user.email=t@e commit -q --no-edit', linux);
      const [s3, resolved] = await api.post('/api/live/worktree/merge', { id: c.id });
      assertEquals([s3, resolved.state], [200, 'merged']);
      assertEquals(await sh('git -C "$1" show main:new.txt', repo), 'main\nchat two');

      // ---- a merge in progress in the main checkout: refused with the Windows line, main does not move
      await turn(a, c, `edit:third.txt|three${NL}`);
      await turn(a, c, 'commit:third');
      await sh('git -C "$1" rev-parse HEAD > "$1/.git/MERGE_HEAD"', repo);
      const before = await sh('git -C "$1" rev-parse main', repo);
      const [s4, locked] = await api.post('/api/live/worktree/merge', { id: c.id });
      assertEquals([s4, locked.code, locked.error], [409, 'locked', 'A merge is in progress in the folder that has the base branch']);
      assertEquals(await sh('git -C "$1" rev-parse main', repo), before);
      await sh('rm -f -- "$1/.git/MERGE_HEAD"', repo);

      // ---- a restarted AIB (a crash) adopts the chat and merges it: everything Merge needs is in the distro
      newAib();
      a.reconnectStop.set();
      for (const conn of a.connections.values()) conn.sessionLease?.release();
      // a crashed AIB's files are closed by the OS (Windows cannot delete a file a live handle holds): its history stores too
      await a.historyClient()?.shutdown().catch(() => {});
      aibs.pop();
      const b = aibIn(state);
      aibs.push(b);
      assertEquals(await b.adoptKeeper(), 1);
      const r = b.connections.get(c.id)!;
      assert(r?.ready && !r.closed, 'adopted');
      const api2 = routesOf(b);
      assertEquals((await api2.status(r.id)).state, 'ready');
      const [s5, again] = await api2.post('/api/live/worktree/merge', { id: r.id });
      assertEquals([s5, again.message], [200, 'Merged into main (1 commit)']);
      assertEquals(await sh('git -C "$1" show main:third.txt', repo), 'three');
      assert(notes(r).includes('Merged into main (1 commit)'));

      // ---- the user's unsaved edit on the same line: merged, the edit kept in the named stash, the clash line, Keep my version
      await turn(b, r, `edit:a.txt|one${NL}chat${NL}`);
      await turn(b, r, 'commit:chat a');
      await sh('printf "one\\nuser\\n" > "$1/a.txt"', repo);
      const [s6, clash] = await api2.post('/api/live/worktree/merge', { id: r.id });
      assertEquals([s6, clash.state, clash.clash], [200, 'merged', ['a.txt']]);
      const stash = String(clash.stash);
      assert(stash.startsWith('studio-merge-chat-'), stash);
      assertEquals(await sh('git -C "$1" stash list --format=%gs', repo), `On main: ${stash}`, "the user's edit is safe in the stash");
      const line = await api2.clash(ref);
      assertEquals([line.unresolved, line.files, line.stash], [true, ['a.txt'], stash]);
      await quiet(b, r); // merge.ts asked the chat to explain the clash
      const [s7, kept] = await api2.post('/api/live/worktree/clash', { id: r.id, action: 'keep-mine' });
      assertEquals([s7, kept.dropped], [200, true]);
      assertEquals(await sh('cat "$1/a.txt"', repo), 'one\nuser');
      assertEquals((await api2.clash(ref)).unresolved, false);

      // ---- uncommitted edits in the main checkout (a changed and a new file): the merge lands and they are still there
      await sh('echo mine > "$1/mine.txt"', repo);
      await turn(b, r, `edit:four.txt|four${NL}`);
      await turn(b, r, 'commit:four');
      const [s8, dirty] = await api2.post('/api/live/worktree/merge', { id: r.id });
      assertEquals([s8, dirty.state, dirty.clash], [200, 'merged', []]);
      assertEquals(await sh('git -C "$1" show main:four.txt', repo), 'four');
      assertEquals(await sh('cat "$1/a.txt" "$1/mine.txt"', repo), 'one\nuser\nmine', "the user's edits are back, not overwritten");
      assertEquals(await sh('git -C "$1" stash list | wc -l', repo), '0');
    } finally {
      for (const s of aibs) await s.close().catch(() => {});
      await cleanRoot();
      Deno.removeSync(state, { recursive: true });
    }
  },
});
