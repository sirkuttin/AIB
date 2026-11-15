/**
 * Tests for WSL fixes that shipped without one (outputs/agent-studio/docs/WSL.md), each without a distro (a FakeWslHost answers):
 *   1. wsl.exe fails with E_INVALIDARG on an empty argument: runWsl refuses one, and the first set-up's probe passes '-' for "no
 *      AIB_WSL_ROOT" (the real probe in a distro: wsl_fixes_e2e_test.ts).
 *   2. New project dialog: the folder check and create of a WSL path go to the distro's helper (folder.project /
 *      folder.createProject) with the Linux path, and every Linux path in the answer comes back as a ref.
 *   3. Files tab of a WSL project: rootFor takes a WSL project with no chat and a chat whose folder is a ref; the Files routes wait for
 *      a distro that is still starting; a saved (old) WSL chat finds its folder through the distro's session list.
 *   6. Usage limits: Studio's usage checker runs on its own for every open chat (the interval is a seam; the default stays a minute).
 * Never a real distro, never the owner's homes.
 */
import { assert, assertEquals, assertRejects } from './_assert.ts';
import { FakeWslHost } from './_wsl_fake.ts';
import { pause } from './_connection.ts';
import { WslHelperError } from '../../outputs/agent-studio/server/wsl/contract.ts';
import { setDistroSource, setWslHostResolver, wslLoc } from '../../outputs/agent-studio/server/wsl/access.ts';
import { installWsl, runWsl, type WslRunner } from '../../outputs/agent-studio/server/wsl/install.ts';
import { wslExePath } from '../../outputs/agent-studio/server/wsl/detect.ts';
import { studioRoutes } from '../../outputs/agent-studio/server/web/studio_routes.ts';
import { rootFor } from '../../outputs/agent-studio/server/web/files_routes.ts';
import { wslFiles } from '../../outputs/agent-studio/server/web/wsl_routes.ts';
import { changesFolder } from '../../outputs/agent-studio/server/worktrees/chat_folders.ts';
import { projectKey } from '../../outputs/agent-studio/server/desktop/project_delete.ts';
import type { WebContext } from '../../outputs/agent-studio/server/web/server.ts';
import { Studio } from '../../outputs/agent-studio/server/host/studio.ts';
import { REFRESH_SECONDS } from '../../outputs/agent-studio/server/host/usage_limits_feed.ts';

type Json = Record<string, unknown>;
const T = { sanitizeResources: false, sanitizeOps: false };
Deno.env.set('AGENT_STUDIO_TEST', '1');
Deno.env.set('AIB_WSL_ROOT', '/tmp/aib-wsl-test-fixes'); // the saved-session lookups ask for the test's Claude folder, never the owner's

function withHost(host: FakeWslHost | null): void {
  setWslHostResolver((d) => (host && d === host.distro.toLowerCase() ? host : null));
}

// ---- 1. no empty wsl.exe argument --------------------------------------------------------------------------------------------
Deno.test({
  name: 'runWsl refuses an empty argument before wsl.exe runs (it would fail with E_INVALIDARG, "exit -1")',
  ...T,
  ignore: !wslExePath(),
  async fn() {
    const error = await assertRejects(() => runWsl('Ubuntu', ['/bin/true', '']), RangeError);
    assert(error.message.includes('empty argument'), error.message);
  },
});

Deno.test('the first set-up probe without AIB_WSL_ROOT passes "-" (never an empty argument) for the default root', async () => {
  const asked: string[][] = [];
  const run: WslRunner = (_distro, argv) => {
    asked.push(argv);
    return Promise.resolve({ code: 1, stdout: new Uint8Array(), stderr: 'stop here' });
  };
  const programs = { keeper: new Uint8Array([1]), helper: new Uint8Array([2]), from: 'test' };
  const error = await assertRejects(() => installWsl('Ubuntu', { stateDir: 'unused', programs, run, root: null }));
  assert(error.message.includes('did not answer'), error.message);
  const [argv] = asked;
  assertEquals(argv.slice(0, 2), ['/bin/sh', '-c']);
  assertEquals(argv[4], '-');
  assert(!argv.includes(''), JSON.stringify(argv.filter((a) => a.length < 40)));
  const script = argv[2];
  assert(script.includes('[ "$root" != "-" ] || root=""'), 'the script reads the sentinel as "no root given"');
});

// ---- 2. New project dialog in a distro ------------------------------------------------------------------------------------------
Deno.test({
  name: 'new project dialog, WSL path: check and create run in the distro helper with the Linux path; the answer carries refs',
  ...T,
  async fn() {
    const host = new FakeWslHost('unused', 'Ubuntu');
    host.handlers['folder.project'] = (p) => {
      const path = String(p.path), name = String(p.name ?? '');
      if (path === '/home/u/nowhere/x') {
        return { valid: false, exists: false, reason: 'parent_missing', message: 'The parent folder does not exist', path, parent: '/home/u/nowhere' };
      }
      if (name) return { valid: true, exists: name === 'old', path: `${path}/${name}`, parent: path, folder: path, field: '' };
      return { valid: true, exists: true, isGit: true, path, parent: '/home/u' };
    };
    host.handlers['folder.createProject'] = (p) => {
      if (p.path === '/home/u/taken') throw new WslHelperError('That folder already exists', 'exists');
      return { path: p.name ? `${p.path}/${p.name}` : p.path, git: p.gitInit === true };
    };
    withHost(host);
    const routes = studioRoutes();
    const ctx = {} as WebContext;
    const check = async (query: Record<string, string>) => {
      const url = new URL('http://127.0.0.1/api/live/folders/check?' + new URLSearchParams(query));
      return await routes.get('GET /api/live/folders/check')!(ctx, url, null, new Request(url)) as [number, Json];
    };
    const create = async (body: Json) => {
      const url = new URL('http://127.0.0.1/api/live/folders/create');
      return await routes.get('POST /api/live/folders/create')!(ctx, url, body, new Request(url)) as [number, Json];
    };
    try {
      // a new project inside an existing folder
      const [s1, fresh] = await check({ path: 'wsl://ubuntu/home/u', name: 'proj' });
      assertEquals(s1, 200);
      assertEquals([fresh.valid, fresh.exists, fresh.path, fresh.parent, fresh.folder], [
        true,
        false,
        'wsl://ubuntu/home/u/proj',
        'wsl://ubuntu/home/u',
        'wsl://ubuntu/home/u',
      ]);
      assertEquals(host.calls.at(-1), ['folder.project', { path: '/home/u', name: 'proj' }]);
      // a folder that is already there
      const [, existing] = await check({ path: 'wsl://Ubuntu/home/u/app' });
      assertEquals([existing.valid, existing.exists, existing.isGit, existing.path], [true, true, true, 'wsl://ubuntu/home/u/app']);
      assertEquals(host.calls.at(-1), ['folder.project', { path: '/home/u/app', name: '' }]);
      // its parent is missing: refused, the message kept
      const [, missing] = await check({ path: 'wsl://ubuntu/home/u/nowhere/x' });
      assertEquals([missing.valid, missing.reason, missing.parent], [false, 'parent_missing', 'wsl://ubuntu/home/u/nowhere']);
      // create: without a name the folder itself (with git init), with a name <folder>/<name> (without)
      const [s2, made] = await create({ path: 'wsl://ubuntu/home/u/made', gitInit: true });
      assertEquals([s2, made.path, made.git], [200, 'wsl://ubuntu/home/u/made', true]);
      assertEquals(host.calls.at(-1), ['folder.createProject', { path: '/home/u/made', name: '', gitInit: true }]);
      const [, named] = await create({ path: 'wsl://ubuntu/home/u', name: 'proj', gitInit: false });
      assertEquals([named.path, named.git], ['wsl://ubuntu/home/u/proj', false]);
      assertEquals(host.calls.at(-1), ['folder.createProject', { path: '/home/u', name: 'proj', gitInit: false }]);
      const [, nameless] = await create({ path: 'wsl://ubuntu/home/u/plain' }); // no gitInit: false
      assertEquals(host.calls.at(-1), ['folder.createProject', { path: '/home/u/plain', name: '', gitInit: false }]);
      assertEquals(nameless.path, 'wsl://ubuntu/home/u/plain');
      // the helper's refusal is the dialog's message; a distro that is not ready says so
      const [s3, taken] = await create({ path: 'wsl://ubuntu/home/u/taken' });
      assertEquals([s3, taken.code, taken.error], [400, 'exists', 'That folder already exists']);
      host.state = 'stopped';
      const [s4, down] = await check({ path: 'wsl://ubuntu/home/u', name: 'proj' });
      assertEquals([s4, down.code], [409, 'wsl_unavailable']);
      assert(!host.calls.some(([m]) => m === 'folder.check'), 'never the Windows rules');
    } finally {
      setWslHostResolver(null);
    }
  },
});

// ---- 3. Files tab of a WSL project ----------------------------------------------------------------------------------------------
const REF = 'wsl://ubuntu/home/u/app';

function filesCtx(live: Record<string, Json>, added: string[] = []): WebContext {
  return {
    token: 'tok',
    stateDir: null,
    host: { liveState: (id: string) => Promise.resolve(live[id] ?? null) },
    conversations: { entries: {} },
    transcripts: { stores: new Map() },
    addedProjects: { public: () => ({ added: Object.fromEntries(added.map((p) => [projectKey(p), { path: p }])) }) },
  } as unknown as WebContext;
}

Deno.test({
  name: 'files rootFor: a WSL project with no chat open and a chat whose folder is a ref are shown (the foreign-path gate let them through)',
  ...T,
  async fn() {
    const ctx = filesCtx({ live1: { cwd: REF } }, [REF]);
    assertEquals(await rootFor(ctx, { root: ['project'], project: [REF] }), REF);
    assertEquals(await rootFor(ctx, { id: [`project:${REF}`] }), REF); // a doc tab whose chat is gone names its project
    assertEquals(await rootFor(ctx, { id: ['live1'] }), REF);
    assertEquals(await rootFor(ctx, { id: ['live1'], root: ['chat'] }), REF);
    // still refused: a WSL project AIB does not know, a chat with no folder, another kind of foreign path
    assertEquals((await rootFor(ctx, { root: ['project'], project: ['wsl://ubuntu/home/u/other'] }) as [number, Json])[0], 404);
    assertEquals((await rootFor(ctx, { id: ['gone'] }) as [number, Json])[0], 404);
    assertEquals((await rootFor(filesCtx({}, ['\\\\server\\share\\x']), { root: ['project'], project: ['\\\\server\\share\\x'] }) as [number, Json])[0], 404);
  },
});

Deno.test({
  name: 'files routes of a WSL project wait for a distro that is still starting instead of answering "Starting…"',
  ...T,
  async fn() {
    const host = new FakeWslHost('unused', 'Ubuntu');
    host.handlers['files.list'] = (p) => ({ dir: p.rel, entries: [{ name: 'a.txt', kind: 'file' }], sig: 's' });
    host.state = 'starting';
    let started = 0;
    host.start = () => {
      started++;
      return new Promise<void>((resolve) => setTimeout(() => (host.state = 'ready', resolve()), 150));
    };
    withHost(host);
    try {
      const [status, body] = await wslFiles('list', REF, wslLoc(REF)!, {});
      assertEquals([status, started], [200, 1]);
      assertEquals(((body as Json).entries as Json[]).map((e) => e.name), ['a.txt']);
    } finally {
      setWslHostResolver(null);
    }
  },
});

Deno.test({
  name: 'a saved (old) WSL chat finds its folder through the distro session list: claude:<id>, codex:<id> and wsl.<distro>.<provider>/<key>',
  ...T,
  async fn() {
    const host = new FakeWslHost('unused', 'Ubuntu');
    const asked: Json[] = [];
    host.handlers['transcripts.sessions'] = (p) => {
      asked.push(p);
      return p.provider === 'claude'
        ? { sessions: [{ sessionId: 'fix-claude-1', key: '-home-u-app/fix-claude-1.jsonl', cwd: '/home/u/app' }] }
        : { sessions: [{ sessionId: 'fix-codex-1', key: '2026/11/14/rollout-2026-11-14T10-00-00-fix-codex-1.jsonl', cwd: '/home/u/app2' }] };
    };
    withHost(host);
    setDistroSource(() => Promise.resolve([{ name: 'Ubuntu', version: 2, state: 1 }]));
    try {
      const studio = { liveState: () => Promise.resolve(null), conversations: { entries: {} }, store: null, savedCwd: null, token: 't', stateDir: null };
      assertEquals(await changesFolder(studio, 'claude:fix-claude-1'), REF);
      assertEquals(await changesFolder(studio, 'wsl.ubuntu.claude/-home-u-app/fix-claude-1.jsonl'), REF);
      assertEquals(await changesFolder(studio, 'codex:fix-codex-1'), 'wsl://ubuntu/home/u/app2');
      assertEquals(await changesFolder(studio, 'wsl.ubuntu.codex/2026/11/14/rollout-2026-11-14T10-00-00-fix-codex-1.jsonl'), 'wsl://ubuntu/home/u/app2');
      assertEquals(await changesFolder(studio, 'claude:fix-unknown'), null);
      assert(asked.every((p) => String(p.claudeDir ?? '').startsWith('/tmp/aib-wsl-test-fixes/')), 'the test Claude folder, never the owner\'s');
      // the Files tab of that saved chat: the same lookup behind rootFor
      assertEquals(await rootFor(filesCtx({}), { id: ['claude:fix-claude-1'] }), REF);
    } finally {
      setDistroSource(null);
      setWslHostResolver(null);
    }
  },
});

// ---- 6. usage limits refresh on their own ---------------------------------------------------------------------------------------
Deno.test({
  name: "usage limits: Studio's checker runs on its own for every open chat (not closed ones) until Studio closes; default once a minute",
  ...T,
  async fn() {
    assertEquals(REFRESH_SECONDS, 60);
    const dir = Deno.makeTempDirSync({ prefix: 'aib-limits-timer-' });
    const studio = new Studio({ ompCommand: 'unused', stateDir: dir, port: 0, ownersDir: null }, { keeper: null, limitsEveryMs: 40 });
    try {
      const refreshed: string[] = [];
      studio.limits = { refresh: (c: { id: string }) => (refreshed.push(c.id), Promise.resolve()) } as unknown as Studio['limits'];
      const fakes = [{ id: 'open', closed: false }, { id: 'ended', closed: true }];
      for (const f of fakes) studio.connections.set(f.id, f as never);
      await pause(400);
      assert(refreshed.filter((id) => id === 'open').length >= 3, refreshed.join());
      assertEquals(refreshed.filter((id) => id === 'ended'), []);
      for (const f of fakes) studio.connections.delete(f.id);
      await studio.close();
      const after = refreshed.length;
      await pause(200);
      assertEquals(refreshed.length, after, 'stopped with Studio');
    } finally {
      await studio.close().catch(() => {});
      Deno.removeSync(dir, { recursive: true });
    }
  },
});
