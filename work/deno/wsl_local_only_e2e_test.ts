/**
 * Real WSL (AIB_WSL_E2E=<distro>; see _wsl_e2e.ts): local-only folders of a WSL project, run by the distro's helper
 * (wsl/helper/local_only.ts). The temp repo has the owner's shape: `/aib-shared/` in its own .git/info/exclude and a file
 * aib-shared/review/x.png, and game/review/ in a committed .gitignore with a nested picture: git copies neither into a chat's copy.
 *   - a new chat in its own copy: AIB's block gets `/aib-shared` before the copy is made, the copy's aib-shared is a symlink to the main
 *     folder's (made in the distro by the helper), a file written through it is in the main folder at once, and the agent's
 *     session/new carries additionalDirectories = [the main folder's aib-shared/ and game/review/] (Linux paths) and the note naming them; the agent edits
 *     a file in each by those paths, which lands in the main folder only (not in the copy, not in its branch);
 *   - the Files tab of the chat's copy: the list's localOnly part names aib-shared (main = the Linux main folder), and a read of
 *     aib-shared/review/x.png comes from the main folder; game/review/ is listed dimmed in the copy's game/, traversed and its picture read;
 *   - "Git exclude" on a new folder writes the repo's .git/info/exclude in the distro, Undo takes it back; a path out of the repo and
 *     a root outside AIB's chat copies are refused;
 *   - live sync never copies the main folder's aib-shared/ files (the link shows them), and Merge lands the chat's own commit but never
 *     an aib-shared/ file the chat wrote through its link (that file is in the main folder already);
 *   - an old copy without the link gets it back before it is used (ensure), and removing the copy takes the link only.
 * Everything is inside AIB_WSL_ROOT=/tmp/aib-wsl-test-<random>; the fake agent is work/fake_acp.py.
 */
import { assert, assertEquals } from './_assert.ts';
import { until } from './_connection.ts';
import { cleanRoot, inDistro, KEY, prepareRoot, readyHost, ROOT, T } from './_wsl_e2e.ts';
import { Connection, SHARED_FOLDER_PROMPT } from '../../app/server/acp/connection.ts';
import { wslEnsure, wslRecord, wslRemove } from '../../app/server/wsl/worktrees.ts';
import { Aib } from '../../app/server/host/aib.ts';
import { refOf } from '../../app/server/platform/location.ts';
import { aibRoutes } from '../../app/server/web/aib_routes.ts';
import { filesRoutes } from '../../app/server/web/files_routes.ts';
import { BLOCK_START } from '../../app/server/worktrees/local_only.ts';
import { WslHelperError } from '../../app/server/wsl/contract.ts';
import type { WebContext } from '../../app/server/web/server.ts';

type Json = Record<string, unknown>;
const NL = '\\n';

function studioIn(state: string): Aib {
  const studio = new Aib({ stateDir: state, port: 0, ownersDir: null, noArtifactTool: true }, { keeper: null });
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

async function turn(studio: Aib, c: Connection, text: string): Promise<void> {
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
  name: 'wsl e2e: a WSL chat in its own copy reaches the main folder aib-shared/ (grant, Files, exclude), and sync and merge leave it out',
  ...T,
  async fn() {
    const state = Deno.makeTempDirSync({ prefix: 'aib-wsl-lo-e2e-' });
    await prepareRoot();
    let studio: Aib | null = null;
    try {
      const host = await readyHost();
      const repo = `${ROOT}/repo`;
      const ref = refOf({ kind: 'wsl', distro: KEY, linuxPath: repo });
      await sh(
        'cd "$1" && git branch -M main && printf "\\n# Owner-only files\\n/aib-shared/\\n" >> .git/info/exclude && mkdir -p aib-shared/review && printf PNG > aib-shared/review/x.png' +
          ' && printf "game/review/\\n" > .gitignore && mkdir -p game/review/level1 && printf tracked > game/a.txt && git add .gitignore game/a.txt && git commit -qm game' +
          ' && printf GAMEPNG > game/review/level1/shot.png',
        repo,
      );
      assertEquals(await sh('git -C "$1" status --porcelain', repo), '', 'aib-shared/ and game/review/ are ignored');
      const gitignore = await sh('cat "$1/.gitignore"', repo);
      studio = studioIn(state);
      const c = await studio.connect('claude', ref, null, { ownCopy: true }); // a copy chat (new chats work in the folder: test-only ownCopy)
      await until(() => c.ready, 'ready', 60);
      const linux = c.agentCwd;
      assert(c.worktree?.branch.startsWith('studio/chat-'), 'the chat works in its own copy');

      // ---- the grant and the note: the main folder's aib-shared/, as a Linux path
      const exclude = await sh('cat "$1/.git/info/exclude"', repo);
      assert(exclude.includes('/aib-shared/') && exclude.includes(BLOCK_START) && exclude.includes('\n/aib-shared\n'), exclude);
      assertEquals(await sh('test -L "$1/aib-shared" && readlink "$1/aib-shared"', linux), `${repo}/aib-shared`, 'the copy has a symlink to the main folder');
      await turn(studio, c, `edit:aib-shared/through-link.md|via the link${NL}`);
      assertEquals(await sh('cat "$1/aib-shared/through-link.md"', repo), 'via the link', 'written through the link: in the main folder at once');
      assertEquals(await sh('git -C "$1" status --porcelain', linux), '', 'git in the copy shows nothing of it');
      assertEquals(await sh('git -C "$1" status --porcelain', repo), '', 'nor in the main folder');
      const log = (await sh('cat "$1/acp.log"', ROOT)).split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const made = log.filter((m) => m.method === 'session/new').map((m) => m.params as Json);
      assertEquals(made.length, 1);
      assertEquals(made[0].additionalDirectories, [`${repo}/aib-shared`, `${repo}/game/review`]);
      assertEquals(made[0].cwd, linux);
      const texts = (((made[0].systemPrompt as Json)?.content as Json[]) ?? []).map((x) => String(x.text));
      assert(texts.some((t) => t.startsWith(SHARED_FOLDER_PROMPT) && t.includes(`${repo}/game/review`)), JSON.stringify(texts));
      assertEquals(c.localOnly, {
        entries: [`${repo}/aib-shared`],
        dirs: [`${repo}/aib-shared`],
        shared: `${repo}/aib-shared`,
        ignored: { dirs: [`${repo}/game/review`], files: [] },
      });
      assert(!JSON.stringify(made[0].additionalDirectories).includes('/data-'), "AIB's data folder (the copies) is never granted");
      // the agent edits files in the main folder's aib-shared/ and game/review/ by the granted full paths: they land there only
      await turn(studio, c, `edit:${repo}/aib-shared/review/notes.md|from the chat${NL}`);
      await turn(studio, c, `edit:${repo}/game/review/level1/notes.md|game notes${NL}`);
      assertEquals(await sh('cat "$1/aib-shared/review/notes.md"', repo), 'from the chat');
      assertEquals(await sh('cat "$1/game/review/level1/notes.md"', repo), 'game notes');
      assertEquals(await sh('test -e "$1/game/review" && echo there || echo absent', linux), 'absent', 'nothing leaks into the copy');
      assertEquals(await sh('git -C "$1" status --porcelain', linux), '', 'nor into its branch');

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
      assertEquals(list.localOnly, { main: repo, entries: ['aib-shared'], defaultState: 'on', sig: (list.localOnly as Json).sig });
      assert((list.entries as Json[]).some((e) => e.name === 'aib-shared' && e.local === true), JSON.stringify(list.entries));
      const [rs, read] = await get('/api/live/files/read', 'path=aib-shared/review/x.png');
      assertEquals([rs, read.local, read.from, read.abs, read.size], [200, true, 'main', `${repo}/aib-shared/review/x.png`, 3]);
      const [, found] = await get('/api/live/files/search', 'q=notes.md');
      assertEquals((found.matches as Json[]).map((m) => m.path).sort(), ['aib-shared/review/notes.md']);
      // the .gitignore'd game/review/ of the main folder: listed (dimmed) in the copy's game/, traversed, its picture opened
      const [, game] = await get('/api/live/files/list', 'dir=game');
      assertEquals((game.entries as Json[]).map((e) => [e.name, e.from ?? '', e.ignored]), [['review', 'main', true], ['a.txt', '', false]]);
      const [, level] = await get('/api/live/files/list', 'dir=game/review/level1');
      assertEquals((level.entries as Json[]).map((e) => [e.name, e.from, e.ignored]).sort(), [['notes.md', 'main', true], ['shot.png', 'main', true]]);
      const [gs, shot] = await get('/api/live/files/read', 'path=game/review/level1/shot.png');
      assertEquals([gs, shot.from, shot.abs, shot.size, shot.image], [200, 'main', `${repo}/game/review/level1/shot.png`, 7, true]);
      const [, privList] = await get('/api/live/files/list', 'dir=aib-shared/review');
      assert((privList.entries as Json[]).every((e) => e.ignored === false), 'excluded folders read in normal colour');

      // ---- Git exclude on a new folder (from the copy: it moves into the main folder first), Undo, refusals
      await sh('mkdir -p "$1/drafts" && printf shot > "$1/drafts/a.png"', linux);
      const [ex, added] = await post('/api/live/files/exclude', { action: 'add', path: 'drafts' });
      assertEquals([ex, added.ok], [200, true], JSON.stringify(added));
      assert((await sh('cat "$1/.git/info/exclude"', repo)).includes('\n/drafts\n'));
      assertEquals(await sh('cat "$1/drafts/a.png"', repo), 'shot', 'moved into the main folder');
      const [un, undone] = await post('/api/live/files/exclude', { action: 'undo', undo: added.undo });
      assertEquals([un, undone.ok], [200, true]);
      assert(!(await sh('cat "$1/.git/info/exclude"', repo)).includes('/drafts'));
      assertEquals(await sh('cat "$1/.gitignore"', repo), gitignore, 'no .gitignore is ever written');
      assertEquals(await sh('find "$1" "$2" -name .gitignore -not -path "*/.git/*" | sort', repo, linux), `${linux}/.gitignore\n${repo}/.gitignore`);
      const [bad] = await post('/api/live/files/exclude', { action: 'add', path: '../../etc' });
      assertEquals(bad, 400);
      const outside = await host.call('localOnly.exclude', { root: ROOT, main: repo, action: 'add', path: 'x' }).catch((e) => e);
      assert(outside instanceof WslHelperError, String(outside));
      assertEquals(await sh('test -e "$1/.git/info/exclude" && echo has || echo none', ROOT), 'none');

      // ---- live sync: the user's files reach the copy, the main folder's aib-shared/ never does
      await sh('echo user > "$1/u.txt" && echo secret > "$1/aib-shared/new.md"', repo);
      await waitFor(async () => (await sh('cat "$1/u.txt" 2>/dev/null || true', linux)) === 'user', 'u.txt reaches the copy', 45);
      assertEquals(await sh('test -L "$1/aib-shared" && cat "$1/aib-shared/new.md"', linux), 'secret', 'still the link: nothing is copied, the file is seen through it');
      assertEquals(await sh('test -e "$1/game/review" && echo there || echo absent', linux), 'absent', 'nor game/review/');

      // ---- merge: the chat's own commit lands; an aib-shared/ file the chat writes through its link is in the main folder, never in a commit
      await turn(studio, c, `edit:chat.txt|from the chat${NL}`);
      await turn(studio, c, `edit:aib-shared/inchat.md|copy only${NL}`);
      assertEquals(await sh('cat "$1/aib-shared/inchat.md"', repo), 'copy only');
      await turn(studio, c, 'commit:chat work');
      assertEquals(await sh('git -C "$1" ls-files aib-shared', linux), '', 'git never adds aib-shared/ in the copy');
      const ctx2 = { stateDir: studio.stateDir, host: studio, conversations: { public: () => ({ entries: {} }) } } as never;
      const [code, merged] = await aibRoutes().get('POST /api/live/worktree/merge')!(ctx2, new URL('http://127.0.0.1/api/live/worktree/merge'), { id: c.id }, new Request('http://127.0.0.1/')) as [number, Json];
      assertEquals([code, merged.state], [200, 'merged'], JSON.stringify(merged));
      assertEquals(await sh('git -C "$1" show main:chat.txt', repo), 'from the chat');
      assertEquals(await sh('git -C "$1" ls-tree -r --name-only main -- aib-shared game/review', repo), '', 'nothing under aib-shared/ or game/review/ landed');
      assertEquals(await sh('cat "$1/aib-shared/review/x.png"', repo), 'PNG', "the main folder's aib-shared/ is untouched");

      // ---- reuse and removal: an old copy without the link gets it back; removing the copy takes the link only
      const record = (await wslRecord(c.cwd, null, true))!;
      assert(record, 'the WSL worktree record');
      await sh('rm "$1/aib-shared"', linux);
      assertEquals(await wslEnsure(record), linux);
      assertEquals(await sh('readlink "$1/aib-shared"', linux), `${repo}/aib-shared`, 'linked again before it is used');
      assertEquals(await wslRemove(record, true), 'removed'); // while the distro's helper still runs (closing AIB stops it)
      assertEquals(await sh('test -e "$1" && echo there || echo gone', linux), 'gone');
      assertEquals(await sh('ls "$1/aib-shared" | sort | tr "\\n" " "', repo), 'inchat.md new.md review through-link.md', 'every file stays');
    } finally {
      await studio?.close().catch(() => {});
      await cleanRoot();
      Deno.removeSync(state, { recursive: true });
    }
  },
});
