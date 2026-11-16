/**
 * Real WSL (AIB_WSL_E2E=<distro>; see _wsl_e2e.ts): local-only folders of a WSL project, run by the distro's helper
 * (wsl/helper/local_only.ts). The temp repo has the owner's shape: `/private/` in its own .git/info/exclude and a file
 * private/review/x.png that git never copies into a chat's copy.
 *   - a new chat in its own copy: AIB's block gets `/private` before the copy is made, the copy holds no private/, and the agent's
 *     session/new carries additionalDirectories = [the main folder's private/] (a Linux path) and the note naming it; the agent writes
 *     a file there by that path;
 *   - the Files tab of the chat's copy: the list's localOnly part names private (main = the Linux main folder), and a read of
 *     private/review/x.png comes from the main folder;
 *   - "Git exclude" on a new folder writes the repo's .git/info/exclude in the distro, Undo takes it back; a path out of the repo and
 *     a root outside AIB's chat copies are refused;
 *   - live sync never brings the main folder's private/ files into the copy, and Merge lands the chat's own commit but never a
 *     private/ file the chat made in its copy.
 * Everything is inside AIB_WSL_ROOT=/tmp/aib-wsl-test-<random>; the fake agent is work/fake_acp.py.
 */
import { assert, assertEquals } from './_assert.ts';
import { until } from './_connection.ts';
import { cleanRoot, inDistro, KEY, prepareRoot, readyHost, ROOT, T } from './_wsl_e2e.ts';
import { Connection } from '../../outputs/agent-studio/server/acp/connection.ts';
import { Studio } from '../../outputs/agent-studio/server/host/studio.ts';
import { refOf } from '../../outputs/agent-studio/server/platform/location.ts';
import { studioRoutes } from '../../outputs/agent-studio/server/web/studio_routes.ts';
import { filesRoutes } from '../../outputs/agent-studio/server/web/files_routes.ts';
import { BLOCK_START } from '../../outputs/agent-studio/server/worktrees/local_only.ts';
import { WslHelperError } from '../../outputs/agent-studio/server/wsl/contract.ts';
import type { WebContext } from '../../outputs/agent-studio/server/web/server.ts';

type Json = Record<string, unknown>;
const NL = '\\n';

function studioIn(state: string): Studio {
  const studio = new Studio({ ompCommand: 'unused', stateDir: state, port: 0, ownersDir: null, noArtifactTool: true }, { keeper: null });
  studio.ownerProbe = () => null;
  // env sets FAKE_ACP_LOG for the fake agent: every line it receives goes there (session/new's params)
  studio.connectionFactory = (_command, cwd, provider, options) =>
    new Connection(['env', `FAKE_ACP_LOG=${ROOT}/acp.log`, '/usr/bin/python3', `${ROOT}/fake_acp.py`, '--cancel-aware', '--extra-dirs'], cwd, provider, {
      ...options,
      wsl: options?.wsl ? { ...options.wsl, program: '/usr/bin/env' } : options?.wsl,
    });
  return studio;
}

const sh = async (script: string, ...args: string[]) => (await inDistro(script, args)).out.trim();

async function turn(studio: Studio, c: Connection, text: string): Promise<void> {
  await studio.liveCall('prompt', { id: c.id, text, clientMessageId: crypto.randomUUID() });
  await until(() => !c.busy, `the turn "${text}"`, 60);
}

async function waitFor(check: () => Promise<boolean>, what: string, seconds = 30): Promise<void> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

Deno.test({
  name: 'wsl e2e: a WSL chat in its own copy reaches the main folder private/ (grant, Files, exclude), and sync and merge leave it out',
  ...T,
  async fn() {
    const state = Deno.makeTempDirSync({ prefix: 'aib-wsl-lo-e2e-' });
    await prepareRoot();
    let studio: Studio | null = null;
    try {
      const host = await readyHost();
      const repo = `${ROOT}/repo`;
      const ref = refOf({ kind: 'wsl', distro: KEY, linuxPath: repo });
      await sh(
        'cd "$1" && git branch -M main && printf "\\n# Owner-only files\\n/private/\\n" >> .git/info/exclude && mkdir -p private/review && printf PNG > private/review/x.png',
        repo,
      );
      assertEquals(await sh('git -C "$1" status --porcelain', repo), '', 'private/ is ignored by the user line');
      studio = studioIn(state);
      const c = await studio.connect('claude', ref);
      await until(() => c.ready, 'ready', 60);
      const linux = c.agentCwd;
      assert(c.worktree?.branch.startsWith('studio/chat-'), 'the chat works in its own copy');

      // ---- the grant and the note: the main folder's private/, as a Linux path
      const exclude = await sh('cat "$1/.git/info/exclude"', repo);
      assert(exclude.includes('/private/') && exclude.includes(BLOCK_START) && exclude.includes('\n/private\n'), exclude);
      assertEquals(await sh('test -e "$1/private" && echo there || echo absent', linux), 'absent', 'the copy holds no private/');
      const log = (await sh('cat "$1/acp.log"', ROOT)).split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const made = log.filter((m) => m.method === 'session/new').map((m) => m.params as Json);
      assertEquals(made.length, 1);
      assertEquals(made[0].additionalDirectories, [`${repo}/private`]);
      assertEquals(made[0].cwd, linux);
      const texts = (((made[0].systemPrompt as Json)?.content as Json[]) ?? []).map((x) => String(x.text));
      assert(texts.some((t) => t.includes('Local-only files') && t.includes(`${repo}/private`)), JSON.stringify(texts));
      assertEquals(c.localOnly, { entries: [`${repo}/private`], dirs: [`${repo}/private`], private: `${repo}/private` });
      // the agent writes into the main folder's private/ by its full path
      await turn(studio, c, `edit:${repo}/private/review/notes.md|from the chat${NL}`);
      assertEquals(await sh('cat "$1/private/review/notes.md"', repo), 'from the chat');

      // ---- the Files tab of the chat's copy
      const routes = filesRoutes();
      const ctx = {
        token: 't',
        stateDir: state,
        host: studio,
        artifacts: { connectionOf: () => '', conversations: () => [], store: { origin: '' } },
        transcripts: { stores: new Map() },
      } as unknown as WebContext;
      const req = new Request('http://x', { headers: { 'X-Studio-Token': 't' } });
      const get = (path: string, q: string) => routes.get(`GET ${path}`)!(ctx, new URL(`http://x${path}?id=${c.id}&root=chat&${q}`), null, req) as Promise<[number, Json]>;
      const post = (path: string, body: Json) => routes.get(`POST ${path}`)!(ctx, new URL(`http://x${path}`), { id: c.id, root: 'chat', ...body }, req) as Promise<[number, Json]>;
      const [ls, list] = await get('/api/live/files/list', 'dir=');
      assertEquals(ls, 200, JSON.stringify(list));
      assertEquals(list.localOnly, { main: repo, entries: ['private'], defaultState: 'on', sig: (list.localOnly as Json).sig });
      assert((list.entries as Json[]).some((e) => e.name === 'private' && e.local === true), JSON.stringify(list.entries));
      const [rs, read] = await get('/api/live/files/read', 'path=private/review/x.png');
      assertEquals([rs, read.local, read.from, read.abs, read.size], [200, true, 'main', `${repo}/private/review/x.png`, 3]);
      const [, found] = await get('/api/live/files/search', 'q=notes.md');
      assertEquals((found.matches as Json[]).map((m) => m.path), ['private/review/notes.md']);

      // ---- Git exclude on a new folder (from the copy: it moves into the main folder first), Undo, refusals
      await sh('mkdir -p "$1/game/review" && printf shot > "$1/game/review/a.png"', linux);
      const [ex, added] = await post('/api/live/files/exclude', { action: 'add', path: 'game/review' });
      assertEquals([ex, added.ok], [200, true], JSON.stringify(added));
      assert((await sh('cat "$1/.git/info/exclude"', repo)).includes('\n/game/review\n'));
      assertEquals(await sh('cat "$1/game/review/a.png"', repo), 'shot', 'moved into the main folder');
      const [un, undone] = await post('/api/live/files/exclude', { action: 'undo', undo: added.undo });
      assertEquals([un, undone.ok], [200, true]);
      assert(!(await sh('cat "$1/.git/info/exclude"', repo)).includes('/game/review'));
      const [bad] = await post('/api/live/files/exclude', { action: 'add', path: '../../etc' });
      assertEquals(bad, 400);
      const outside = await host.call('localOnly.exclude', { root: ROOT, main: repo, action: 'add', path: 'x' }).catch((e) => e);
      assert(outside instanceof WslHelperError, String(outside));
      assertEquals(await sh('test -e "$1/.git/info/exclude" && echo has || echo none', ROOT), 'none');

      // ---- live sync: the user's files reach the copy, the main folder's private/ never does
      await sh('echo user > "$1/u.txt" && echo secret > "$1/private/new.md"', repo);
      await waitFor(async () => (await sh('cat "$1/u.txt" 2>/dev/null || true', linux)) === 'user', 'u.txt reaches the copy', 45);
      assertEquals(await sh('test -e "$1/private" && echo there || echo absent', linux), 'absent', 'private/ is never synced');

      // ---- merge: the chat's own commit lands, a private/ file the chat made in its copy never does
      await turn(studio, c, `edit:chat.txt|from the chat${NL}`);
      await turn(studio, c, `edit:private/inchat.md|copy only${NL}`);
      await turn(studio, c, 'commit:chat work');
      assertEquals(await sh('git -C "$1" ls-files private', linux), '', 'git never adds private/ in the copy');
      const ctx2 = { stateDir: studio.stateDir, host: studio, conversations: { public: () => ({ entries: {} }) } } as never;
      const [code, merged] = await studioRoutes().get('POST /api/live/worktree/merge')!(ctx2, new URL('http://127.0.0.1/api/live/worktree/merge'), { id: c.id }, new Request('http://127.0.0.1/')) as [number, Json];
      assertEquals([code, merged.state], [200, 'merged'], JSON.stringify(merged));
      assertEquals(await sh('git -C "$1" show main:chat.txt', repo), 'from the chat');
      assertEquals(await sh('git -C "$1" ls-tree -r --name-only main -- private', repo), '', 'nothing under private/ landed');
      assertEquals(await sh('cat "$1/private/review/x.png"', repo), 'PNG', "the main folder's private/ is untouched");
    } finally {
      await studio?.close().catch(() => {});
      await cleanRoot();
      Deno.removeSync(state, { recursive: true });
    }
  },
});
