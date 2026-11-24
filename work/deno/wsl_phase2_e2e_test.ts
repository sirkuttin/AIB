/**
 * Real WSL (AIB_WSL_E2E=<distro>; see _wsl_e2e.ts): the phase 2 small pieces through the distro's helper.
 *   - Files previews: a picture in the distro gets a ticket link and the artifact origin serves its exact bytes.
 *   - Files outside the chat's folder: named by the chat, read by the helper natively; AIB's own folder in the distro is refused.
 *   - Project delete: refusals (home, a top-level folder), then the folder moves to a trash under the test's own XDG_DATA_HOME
 *     (via gio when the distro has it, and the freedesktop trash by hand); never the owner's Trash, never anything permanent.
 *   - Codex limits: a rollout written in the test's CODEX_HOME inside AIB_WSL_ROOT is read into the per-distro snapshot.
 * Test folders: AIB_WSL_ROOT (/tmp/aib-wsl-test-<random>) and its sibling <root>-outside, both removed at the end.
 */
import { assert, assertEquals } from './_assert.ts';
import { cleanRoot, DISTRO, inDistro, KEY, prepareRoot, readyHost, ROOT, T } from './_wsl_e2e.ts';
import { refOf } from '../../app/server/platform/location.ts';
import { wslLoc } from '../../app/server/wsl/access.ts';
import { wslFiles } from '../../app/server/web/wsl_routes.ts';
import { artifactAnswer } from '../../app/server/artifacts/origin.ts';
import { _mentioned, filesRoutes } from '../../app/server/web/files_routes.ts';
import { projectRemove } from '../../app/server/web/project_routes.ts';
import { RemovedProjects } from '../../app/server/desktop/project_delete.ts';
import { LimitsFeed } from '../../app/server/host/usage_limits_feed.ts';
import { UsageLimitsStore } from '../../app/server/state/usage_limits.ts';
import type { WebContext } from '../../app/server/web/server.ts';
import { wslHostsInUse } from '../../app/server/wsl/hosts.ts';

type Json = Record<string, unknown>;
const OUT = `${ROOT}-outside`;
const guardOut = () => {
  if (!/^\/tmp\/aib-wsl-test-[0-9a-f]{12}-outside$/.test(OUT)) throw new Error('refusing to touch ' + OUT);
};
const PNG_HEX = '89504e470d0a1a0a0000000d49484452'; // the start of a PNG, with a NUL: binary

Deno.test({
  name: 'wsl e2e: Files preview, outside files, project trash and Codex limits through the real helper',
  ...T,
  async fn() {
    await prepareRoot();
    guardOut();
    try {
      await readyHost();
      const made = await inDistro(
        'mkdir -p "$1/proj/app/src" "$1/trashme/app/src" "$2/home/.codex/sessions/2026/11/14" && ' +
          'printf "%s" "$3" | xxd -r -p > "$1/proj/pic.png" && echo "<h1>hi</h1>" > "$1/proj/page.html" && ' +
          'printf "%s" "$3" | xxd -r -p > "$1/outside.png" && echo "keep me" > "$1/trashme/app/src/a.txt" && ' +
          'echo "note" > "$1/outside.txt" && chmod 700 "$1"',
        [OUT, ROOT, PNG_HEX],
      );
      assertEquals(made.code, 0, made.err);

      // ---- 1. previews ----
      const ref = refOf({ kind: 'wsl', distro: KEY, linuxPath: `${OUT}/proj` });
      const wsl = wslLoc(ref)!;
      const origin = 'http://127.0.0.1:9';
      const [s1, png] = await wslFiles('read', ref, wsl, { path: ['pic.png'] }, origin) as [number, Json];
      assertEquals([s1, png.image, png.text], [200, true, null]);
      const url = String(png.viewUrl);
      assert(url.startsWith(origin + '/f/') && url.endsWith('/pic.png'), url);
      const sent: { status: number; body: Uint8Array | string; mime?: string }[] = [];
      artifactAnswer('unused', url.slice(origin.length), (status, body, mime) => (sent.push({ status, body, mime }), new Response('')), true);
      assertEquals([sent[0].status, sent[0].mime], [200, 'image/png']);
      assertEquals([...(sent[0].body as Uint8Array)].map((b) => b.toString(16).padStart(2, '0')).join(''), PNG_HEX);
      const [, page] = await wslFiles('read', ref, wsl, { path: ['page.html'] }, origin) as [number, Json];
      assert(String(page.viewUrl).endsWith('/page.html'));
      const [, noOrigin] = await wslFiles('read', ref, wsl, { path: ['pic.png'] }) as [number, Json];
      assertEquals(noOrigin.viewUrl, '');

      // ---- 2. files outside the chat's folder ----
      const chatRef = refOf({ kind: 'wsl', distro: KEY, linuxPath: `${ROOT}/repo` });
      const ctx = {
        token: 'tok',
        stateDir: null,
        host: {
          connections: new Map([['live1', { cwd: chatRef }]]),
          liveState: () => Promise.resolve({ cwd: chatRef, events: [{ kind: 'tool', rawInput: { file_path: `${OUT}/outside.png` } }, {
            kind: 'tool',
            rawInput: { file_path: `${OUT}/outside.txt` },
          }, { kind: 'tool', rawInput: { file_path: `${ROOT}/repo/a.txt` } }] }),
        },
        conversations: { entries: {} },
        transcripts: { stores: new Map() },
        artifacts: { store: { origin }, conversations: () => [] },
      } as unknown as WebContext;
      const ask = async (query: Record<string, string>) => {
        _mentioned.clear();
        const handler = filesRoutes().get('GET /api/live/files/outside')!;
        const u = new URL('http://127.0.0.1/api/live/files/outside?' + new URLSearchParams(query));
        return await handler(ctx, u, null, new Request(u, { headers: { 'X-Studio-Token': 'tok' } })) as [number, Json];
      };
      const [s2, pic] = await ask({ id: 'live1', path: `${OUT}/outside.png` });
      assertEquals([s2, pic.name, pic.image, pic.wsl], [200, 'outside.png', true, true]);
      assert(String(pic.viewUrl).endsWith('/outside.png'));
      assertEquals(((pic.outside as Json).kind), 'folder');
      const [, txt] = await ask({ id: 'live1', path: `${OUT}/outside.txt` });
      assertEquals(txt.text, 'note\n');
      const [, peek] = await ask({ id: 'live1', path: `${OUT}/outside.txt`, peek: '1' });
      assertEquals([peek.text, peek.viewUrl], [null, '']);
      const [s3, unnamed] = await ask({ id: 'live1', path: `${OUT}/proj/pic.png` });
      assertEquals([s3, unnamed.code], [403, 'not_mentioned']);
      const [s4, hidden] = await ask({ id: 'live1', path: `${ROOT}/repo/a.txt` }); // named, but it is AIB's own folder in the distro
      assertEquals([s4, hidden.code], [403, 'hidden']);
      const [s5, gone] = await ask({ id: 'live1', path: `${OUT}/outside.png`.replace('outside.png', 'nothing.png') });
      assertEquals([s5, gone.code], [403, 'not_mentioned']);

      // ---- 3. project delete: refusals, then the trash ----
      const removed = new RemovedProjects(null);
      const pctx = {
        stateDir: Deno.makeTempDirSync({ prefix: 'aib-wsl-rm-e2e-' }),
        conversations: { public: () => ({ entries: {} }) },
        removedProjects: removed,
      } as unknown as Parameters<typeof projectRemove>[0];
      try {
        const host = await readyHost();
        const home = (await host.call('env.get', {})).home;
        const [, homeCheck] = await projectRemove(pctx, { path: refOf({ kind: 'wsl', distro: KEY, linuxPath: home }), check: true });
        assert(String(homeCheck.refusal).includes('home folder'), String(homeCheck.refusal));
        const [, topCheck] = await projectRemove(pctx, { path: refOf({ kind: 'wsl', distro: KEY, linuxPath: '/tmp' }), check: true });
        assert(String(topCheck.refusal).includes('top-level'), String(topCheck.refusal));
        const [, mnt] = await projectRemove(pctx, { path: refOf({ kind: 'wsl', distro: KEY, linuxPath: '/mnt/c/Users' }), check: true });
        assert(String(mnt.refusal).includes('Windows drive'), String(mnt.refusal));
        const [sh, homeDelete] = await projectRemove(pctx, { path: refOf({ kind: 'wsl', distro: KEY, linuxPath: home }), disk: true });
        assertEquals([sh, homeDelete.code], [409, 'refused']);
        const still = await inDistro('test -d "$1" && echo yes', [home]);
        assertEquals(still.out.trim(), 'yes');

        const app = refOf({ kind: 'wsl', distro: KEY, linuxPath: `${OUT}/trashme/app` });
        const [, check] = await projectRemove(pctx, { path: app, check: true });
        assertEquals(check.exists, true);
        assertEquals(check.refusal, '');
        assert(['gio', 'xdg'].includes(String(check.trash)), String(check.trash));
        const [s6, moved] = await projectRemove(pctx, { path: app, disk: true, expect: String(check.trash) });
        assertEquals(s6, 200, JSON.stringify(moved));
        const trash = `${ROOT}/home/.local/share/Trash`; // the test's XDG_DATA_HOME (wslTestHomeEnv): never the owner's trash
        const left = await inDistro('test -e "$1/trashme/app" && echo there; cat "$2/files/app/src/a.txt"; cat "$2/info/app.trashinfo"', [OUT, trash]);
        assert(!left.out.includes('there'), 'the folder left its place');
        assert(left.out.includes('keep me'), left.out + left.err);
        assert(left.out.includes(`Path=${OUT}/trashme/app`) && left.out.includes('DeletionDate='), left.out);
        assert(removed.has(app));
        // the freedesktop trash by hand, on the same distro (gio skipped on purpose), and a second folder of the same name
        const other = await inDistro('mkdir -p "$1/second/app" && echo two > "$1/second/app/b.txt"', [OUT]);
        assertEquals(other.code, 0, other.err);
        const host2 = await readyHost();
        const done = await host2.call('project.trash', { path: `${OUT}/second/app`, dataHome: `${ROOT}/home/.local/share`, viaGio: false });
        assertEquals(done.disk, 'xdg');
        const files = await inDistro('ls "$1/files"; ls "$1/info"; cat "$1/files/app.1/b.txt" 2>/dev/null || cat "$1/files/app/b.txt"', [trash]);
        assert(files.out.includes('two'), files.out + files.err);
        // a missing folder is only removed from AIB
        assertEquals((await host2.call('project.trash', { path: `${OUT}/second/none`, dataHome: `${ROOT}/home/.local/share` })).disk, 'missing');
      } finally {
        Deno.removeSync(String((pctx as unknown as { stateDir: string }).stateDir), { recursive: true });
      }

      // ---- 4. Codex limits ----
      const rollout = JSON.stringify({
        timestamp: '2026-11-14T10:00:00Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          rate_limits: {
            limit_id: 'codex',
            primary: { used_percent: 12.0, window_minutes: 300, resets_at: 1794388969 },
            secondary: { used_percent: 48.0, window_minutes: 10080, resets_at: 1794613768 },
            plan_type: 'plus',
          },
        },
      });
      const wrote = await inDistro('cat > "$1/home/.codex/sessions/2026/11/14/rollout-2026-11-14T10-00-00-a.jsonl"', [ROOT], new TextEncoder().encode(rollout + '\n'));
      assertEquals(wrote.code, 0, wrote.err);
      assert(wslHostsInUse()?.peek(KEY), 'the host is in use');
      const feed = new LimitsFeed(new UsageLimitsStore(null), { now: () => 1794380100 });
      const chat = {
        provider: 'codex', command: ['node', 'codex-acp.js'], env: {}, sessionId: 's', ready: true, closed: false, wsl: { distro: KEY },
        request: () => Promise.reject(new Error('no requests expected')),
      };
      await feed.refresh(chat);
      assertEquals(feed.key(chat), `wsl:${KEY}|codex`);
      const view = feed.view(chat)!;
      assertEquals([view.agent, view.windows.length, view.windows[0].usedPercent, view.windows[1].usedPercent], ['codex', 2, 12, 48]);
      const empty = { ...chat, env: {} };
      const fresh = new LimitsFeed(new UsageLimitsStore(null), { now: () => 1794380100 });
      await inDistro('rm -f -- "$1/home/.codex/sessions/2026/11/14/"rollout-*.jsonl', [ROOT]);
      await fresh.refresh(empty);
      assertEquals(fresh.view(empty), null, 'no session files: no chip');
      void DISTRO;
    } finally {
      guardOut();
      await inDistro('rm -rf -- "$1"', [OUT]).catch(() => {});
      await cleanRoot();
    }
  },
});
