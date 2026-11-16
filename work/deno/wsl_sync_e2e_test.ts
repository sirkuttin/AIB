/**
 * Real WSL (AIB_WSL_E2E=<distro>; see _wsl_e2e.ts): live sync of a WSL chat's worktree, run by the distro's helper
 * (wsl/helper/sync.ts) and driven by Studio's own hooks (wsl/sync.ts):
 *   - the helper's poll is stretched to 5 minutes (AIB_WSL_SYNC_POLL), so only inotify can wake a scan: the project is watched, the
 *     watcher counts events, and a user edit and a new file in the main checkout reach the chat's copy within seconds;
 *   - the chat's next prompt carries the <studio-context> note naming them (the fake agent's `context` turn answers with it);
 *   - an edit the chat and the user both made (different lines) waits as pending and is merged into the copy at the next turn;
 *   - the same line on both sides: conflict markers in the copy, the user's file untouched, Merge shows the clash line; the chat
 *     resolves it and Merge is ready again;
 *   - the helper is killed: AIB's periodic set starts a new one, which watches again and catches up on an edit made meanwhile;
 *   - Merge after sync lands only the chat's own changes; the user's synced, uncommitted files stay the user's in the main checkout.
 * Everything is inside AIB_WSL_ROOT=/tmp/aib-wsl-test-<random>; the fake agent is work/fake_acp.py; only processes this test
 * started are killed (the helper under ROOT).
 */
import { assert, assertEquals } from './_assert.ts';
import { until } from './_connection.ts';
import { cleanRoot, inDistro, KEY, newAib, prepareRoot, readyHost, ROOT, T } from './_wsl_e2e.ts';
import { Connection } from '../../outputs/agent-studio/server/acp/connection.ts';
import { Studio } from '../../outputs/agent-studio/server/host/studio.ts';
import { refOf } from '../../outputs/agent-studio/server/platform/location.ts';
import { studioRoutes } from '../../outputs/agent-studio/server/web/studio_routes.ts';
import { helperEnv } from '../../outputs/agent-studio/server/wsl/hosts.ts';
import { wslSyncSettings } from '../../outputs/agent-studio/server/wsl/sync.ts';
import type { WslHost } from '../../outputs/agent-studio/server/wsl/contract.ts';

type Json = Record<string, unknown>;

function studioIn(state: string): Studio {
  const studio = new Studio({ ompCommand: 'unused', stateDir: state, port: 0, ownersDir: null, noArtifactTool: true }, { keeper: null });
  studio.ownerProbe = () => null;
  studio.connectionFactory = (_command, cwd, provider, options) =>
    new Connection(['python3', `${ROOT}/fake_acp.py`, '--cancel-aware'], cwd, provider, {
      ...options,
      wsl: options?.wsl ? { ...options.wsl, program: '/usr/bin/python3' } : options?.wsl,
    });
  return studio;
}

const sh = async (script: string, ...args: string[]) => (await inDistro(script, args)).out.trim();
const NL = '\\n'; // the fake agent's edit: turns write a literal \n as a newline

async function turn(studio: Studio, c: Connection, text: string): Promise<void> {
  await studio.liveCall('prompt', { id: c.id, text, clientMessageId: crypto.randomUUID() });
  await until(() => !c.busy, `the turn "${text}"`, 60);
}

/** The registry record of the chat's worktree, read in the distro. */
async function record(linux: string): Promise<Json> {
  const raw = await sh('cat "$1"/data-*/studio-worktrees.json', ROOT);
  const items = (JSON.parse(raw).worktrees ?? {}) as Record<string, Json>;
  return Object.values(items).find((r) => r.path === linux) ?? {};
}

async function waitFor(check: () => Promise<boolean>, what: string, seconds = 30): Promise<void> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

const helperPids = async () => (await sh('pgrep -f "AIB-wsl-helper --data $1/" || true', ROOT)).split('\n').filter(Boolean);

Deno.test({
  name: "wsl e2e: live sync of a WSL chat's worktree runs in the distro: inotify, note, merge of both edits, clash, helper restart, Merge",
  ...T,
  async fn() {
    const state = Deno.makeTempDirSync({ prefix: 'aib-wsl-sync-e2e-' });
    // only inotify can wake a scan within the test: the helper's poll is 5 minutes
    newAib({ helperEnv: (install) => ({ ...helperEnv(install), AIB_WSL_SYNC_POLL: '300' }) });
    await prepareRoot();
    const keep = wslSyncSettings.KEEP_SECONDS;
    wslSyncSettings.KEEP_SECONDS = 1;
    let studio: Studio | null = null;
    try {
      const host: WslHost = await readyHost();
      const repo = `${ROOT}/repo`;
      const ref = refOf({ kind: 'wsl', distro: KEY, linuxPath: repo });
      await sh('cd "$1" && git branch -M main && printf "a\\nb\\nc\\nd\\ne\\nf\\n" > m.txt && git add m.txt && git commit -qm m', repo);
      studio = studioIn(state);
      const c = await studio.connect('claude', ref, null, { ownCopy: true });
      const linux = c.agentCwd;
      assert(c.worktree?.branch.startsWith('studio/chat-'), 'the chat works in its own copy');
      const ctx = { stateDir: studio.stateDir, host: studio, conversations: { public: () => ({ entries: {} }) } } as never;
      const routes = studioRoutes();
      const status = async () =>
        (await routes.get('GET /api/live/worktree')!(ctx, new URL(`http://127.0.0.1/api/live/worktree?id=${c.id}`), null, new Request('http://127.0.0.1/')))[1] as Json;

      // ---- the project is watched by inotify in the distro; a user edit and a new file reach the copy
      const watched = async () => (await host.call('sync.status', {})).projects.find((p) => p.project === repo);
      await waitFor(async () => (await watched())?.watching === true, 'the helper watches the project');
      assertEquals((await host.call('sync.status', {})).chats.map((x) => x.cwd), [linux]);
      assertEquals((await host.call('sync.status', {})).poll, 300, 'the poll is out of the way: only inotify wakes a scan');
      await new Promise((r) => setTimeout(r, 1500)); // the baseline scan
      const eventsBefore = (await watched())!.events;
      await sh('cd "$1" && echo "user one" > a.txt && echo "new from the user" > u.txt', repo);
      await waitFor(async () => (await sh('cat "$1/a.txt" "$1/u.txt" 2>/dev/null || true', linux)) === 'user one\nnew from the user', 'the edits reach the copy', 20);
      assert((await watched())!.events > eventsBefore, 'inotify events arrived');
      assertEquals(await sh('cat "$1/a.txt"', repo), 'user one', "the user's file is untouched");

      // ---- the next prompt carries the note naming them
      await turn(studio, c, 'context');
      const said = JSON.stringify(c.events);
      assert(said.includes('CONTEXT <studio-context>The user changed these files since your last turn: '), said.slice(-2000));
      assert(/since your last turn: [^<]*a\.txt/.test(said) && /since your last turn: [^<]*u\.txt/.test(said), 'both files named');

      // ---- the helper is killed: AIB's periodic set starts a new one, which watches again and catches up
      const before = await helperPids();
      assertEquals(before.length, 1, 'one helper of this test runs');
      await sh('kill "$1"', before[0]);
      await waitFor(async () => !(await helperPids()).includes(before[0]), 'the helper is gone', 10);
      await sh('echo "while the helper was down" > "$1/down.txt"', repo);
      await waitFor(async () => (await sh('cat "$1/down.txt" 2>/dev/null || true', linux)) === 'while the helper was down', 'caught up by a new helper', 45);
      const after = await helperPids();
      assert(after.length === 1 && after[0] !== before[0], `a new helper: ${before} -> ${after}`);
      await waitFor(async () => (await watched())?.watching === true, 'watched again');
      await sh('echo "after the restart" > "$1/again.txt"', repo);
      await waitFor(async () => (await sh('cat "$1/again.txt" 2>/dev/null || true', linux)) === 'after the restart', 'inotify again', 20);

      // ---- Merge after sync: only the chat's own change lands; the user's synced, uncommitted files stay the user's
      await turn(studio, c, `edit:chat.txt|from the chat${NL}`);
      await turn(studio, c, 'commit:chat work');
      const [code, merged] = await routes.get('POST /api/live/worktree/merge')!(ctx, new URL('http://127.0.0.1/api/live/worktree/merge'), { id: c.id }, new Request('http://127.0.0.1/')) as [number, Json];
      assertEquals([code, merged.state], [200, 'merged']);
      assertEquals(await sh('git -C "$1" show main:chat.txt', repo), 'from the chat');
      assertEquals(await sh('git -C "$1" cat-file -e main:u.txt 2>/dev/null && echo landed || echo kept', repo), 'kept', "the user's own file does not land");
      assertEquals(await sh('cat "$1/u.txt" "$1/down.txt"', repo), 'new from the user\nwhile the helper was down', "the user's files are still there");

      // ---- both edited m.txt (different lines): pending, then merged into the copy at the next turn
      await turn(studio, c, `edit:m.txt|a${NL}b${NL}c${NL}d${NL}e${NL}f-chat${NL}`);
      await sh('printf "A-user\\nb\\nc\\nd\\ne\\nf\\n" > "$1/m.txt"', repo);
      await waitFor(async () => ((await record(linux)).pendingSync as string[] | undefined)?.includes('m.txt') === true, 'm.txt pending');
      assertEquals(await sh('cat "$1/m.txt"', linux), 'a\nb\nc\nd\ne\nf-chat', "the chat's edit is never overwritten");
      await turn(studio, c, 'say:next');
      assertEquals(await sh('cat "$1/m.txt"', linux), 'A-user\nb\nc\nd\ne\nf-chat', 'both edits, merged in the copy');

      // ---- the same line on both sides: markers in the copy, the user's file untouched, the clash line; resolved, Merge is ready
      await turn(studio, c, `edit:m.txt|A-chat${NL}b${NL}c${NL}d${NL}e${NL}f-chat${NL}`);
      await sh('printf "A-user2\\nb\\nc\\nd\\ne\\nf\\n" > "$1/m.txt"', repo);
      await waitFor(async () => ((await record(linux)).pendingSync as string[] | undefined)?.includes('m.txt') === true, 'm.txt pending again');
      await turn(studio, c, 'say:clash');
      const clashed = await sh('cat "$1/m.txt"', linux);
      assert(clashed.includes('<<<<<<< chat (your copy)') && clashed.includes('A-user2') && clashed.includes('A-chat'), clashed);
      assertEquals(await sh('cat "$1/m.txt"', repo), 'A-user2\nb\nc\nd\ne\nf', "the user's edit is untouched");
      assertEquals((await record(linux)).syncConflicts, ['m.txt']);
      const waiting = await status();
      assertEquals([waiting.state, waiting.files], ['conflicts', ['m.txt']]);
      assert(String(waiting.message).startsWith('Waiting for the chat to resolve a clash with your edits in m.txt'), String(waiting.message));
      await turn(studio, c, `edit:m.txt|A-user2 and A-chat${NL}b${NL}c${NL}d${NL}e${NL}f-chat${NL}`);
      await turn(studio, c, 'say:resolved'); // the turn start settles the clash
      assertEquals((await record(linux)).syncConflicts, []);
      assertEquals((await status()).state, 'ready', 'Merge is offered again');
    } finally {
      wslSyncSettings.KEEP_SECONDS = keep;
      await studio?.close().catch(() => {});
      await cleanRoot();
      Deno.removeSync(state, { recursive: true });
    }
  },
});
