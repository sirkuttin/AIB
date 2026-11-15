/**
 * Real WSL (AIB_WSL_E2E=<distro>; see _wsl_e2e.ts): the worktree per chat of a WSL project, made by the distro's helper.
 *   - a new chat in a temp git repo gets its own worktree and branch under the Linux data folder (<data>/worktrees, never /mnt);
 *     its agent works there, AIB keys it by the worktree's ref, and it stays under its project;
 *   - the Changes view shows the chat's branch against its diff base (Discard and Merge); a restarted AIB re-adopts the chat on the
 *     same worktree from the distro's keeper;
 *   - Discard stops the agent and removes the worktree and its branch in the distro; a plan pointing outside the root is refused;
 *   - a folder that is not a git repository keeps the chat in place.
 * Everything is inside AIB_WSL_ROOT=/tmp/aib-wsl-test-<random>; the fake agent is work/fake_acp.py.
 */
import { assert, assertEquals } from './_assert.ts';
import { until } from './_connection.ts';
import { cleanRoot, inDistro, KEY, newAib, prepareRoot, readyHost, ROOT, T } from './_wsl_e2e.ts';
import { Connection } from '../../outputs/agent-studio/server/acp/connection.ts';
import { Studio } from '../../outputs/agent-studio/server/host/studio.ts';
import { refOf } from '../../outputs/agent-studio/server/platform/location.ts';
import { linkOf } from '../../outputs/agent-studio/server/wsl/access.ts';
import { liveUserChannels } from '../../outputs/agent-studio/server/keeper/link.ts';
import { changesResponse } from '../../outputs/agent-studio/server/worktrees/chat_folders.ts';
import { wslRecord } from '../../outputs/agent-studio/server/wsl/worktrees.ts';
import { WslHelperError } from '../../outputs/agent-studio/server/wsl/contract.ts';

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

const sh = async (script: string, ...args: string[]) => {
  const done = await inDistro(script, args);
  return done.out.trim();
};

Deno.test({
  name: 'wsl e2e: a new WSL chat gets its own worktree in the distro; Changes, restart and Discard behave as on Windows',
  ...T,
  async fn() {
    const state = Deno.makeTempDirSync({ prefix: 'aib-wsl-wt-e2e-' });
    await prepareRoot();
    const studios: Studio[] = [];
    try {
      const host = await readyHost();
      const repo = `${ROOT}/repo`;
      const ref = refOf({ kind: 'wsl', distro: KEY, linuxPath: repo });
      const a = studioIn(state);
      studios.push(a);
      const c = await a.connect('claude', ref);
      const linux = c.agentCwd;
      assert(new RegExp(`^${ROOT}/data-[0-9a-f]{12}/worktrees/[0-9a-f]{10}/chat-[0-9a-f]{8}$`).test(linux), linux);
      assertEquals([c.cwd, c.projectRoot, c.wsl?.linuxPath], [refOf({ kind: 'wsl', distro: KEY, linuxPath: linux }), ref, linux]);
      const branch = c.worktree!.branch;
      assert(branch.startsWith('studio/chat-'), branch);
      assertEquals(await sh('git -C "$1" branch --list "studio/*" --format="%(refname:short)"', repo), branch);
      assertEquals(await sh('git -C "$1" rev-parse --abbrev-ref HEAD', linux), branch);
      assertEquals(await sh('cat "$1/a.txt"', linux), 'one');
      const record = (await wslRecord(c.cwd))!;
      assertEquals([record.project, record.branch, record.status], [ref, branch, 'ready']);
      assert(String(record.session).startsWith('claude:'), 'the session is on the record (a later Continue finds the worktree)');

      // a turn, then the chat's work in its copy: the Changes view shows its branch against its diff base, Discard and Merge
      await a.liveCall('prompt', { id: c.id, text: 'stream:2:5', clientMessageId: 'm1' });
      await until(() => c.permissions.size === 1, 'the question', 30);
      await a.liveCall('permission', { id: c.id, key: [...c.permissions.keys()][0], option: 'yes' });
      await until(() => !c.busy, 'turn end', 30);
      await sh('printf "chat\\n" > "$1/new.txt"', linux);
      assertEquals(await sh('ls "$1"', repo), 'a.txt', 'the project folder itself is untouched');
      const view = { token: 't', liveState: (id: string) => (id === c.id ? { cwd: c.cwd } : {}) };
      const [status, changes] = await changesResponse(view, '/api/live/changes', { id: [c.id] }, { 'X-Studio-Token': 't' }) as [number, Json];
      assertEquals(status, 200);
      assertEquals(changes.scope, 'branch');
      assertEquals(changes.worktree, { branch });
      assertEquals((changes.files as Json[]).map((f) => f.path), ['new.txt']);

      // an AIB restart (a crash): the next one takes the chat over on the same worktree
      newAib();
      a.reconnectStop.set();
      for (const conn of a.connections.values()) conn.sessionLease?.release();
      // a crashed AIB's files are closed by the OS (Windows cannot delete a file a live handle holds): its history stores too
      await a.historyClient()?.shutdown().catch(() => {});
      studios.pop();
      const b = studioIn(state);
      studios.push(b);
      assertEquals(await b.adoptKeeper(), 1);
      const r = b.connections.get(c.id)!;
      assert(r?.ready && !r.closed, 'adopted');
      assertEquals([r.cwd, r.agentCwd, r.projectRoot, r.worktree?.branch], [c.cwd, linux, ref, branch]);

      // a plan that points outside AIB's worktrees folder is refused by the helper, and nothing is touched
      const plan = (await (await readyHost()).call('worktree.plan', { project: repo })).plan!;
      const refused = await (await readyHost()).call('worktree.create', { plan: { ...plan, path: repo } }).catch((e) => e);
      assert(refused instanceof WslHelperError, String(refused));
      assertEquals(await sh('git -C "$1" status --porcelain', repo), '');

      // Discard: the agent stops, the worktree and its branch go (in the distro), the project folder stays
      const [code, body] = await b.liveCall('worktree-discard', { id: r.id, confirm: true });
      assertEquals([code, (body as Json).removed], [200, true]);
      assert(r.closed);
      assertEquals(await sh('test -e "$1" && echo there || echo gone', linux), 'gone');
      assertEquals(await sh('git -C "$1" branch --list "studio/*"', repo), '');
      assertEquals(await sh('cat "$1/a.txt"', repo), 'one');
      assertEquals(await wslRecord(c.cwd), null);
      const client = (await linkOf(await readyHost()).client(false))!;
      assertEquals(liveUserChannels(await client.list()).length, 0);
      void host;
    } finally {
      for (const s of studios) await s.close().catch(() => {});
      await cleanRoot();
      Deno.removeSync(state, { recursive: true });
    }
  },
});

Deno.test({
  name: 'wsl e2e: a WSL folder that is not a git repository keeps the chat in the project folder',
  ...T,
  async fn() {
    const state = Deno.makeTempDirSync({ prefix: 'aib-wsl-wt-e2e-' });
    await prepareRoot();
    const studios: Studio[] = [];
    try {
      await readyHost();
      await sh('mkdir -p "$1/plain"', ROOT);
      const ref = refOf({ kind: 'wsl', distro: KEY, linuxPath: `${ROOT}/plain` });
      const a = studioIn(state);
      studios.push(a);
      const c = await a.connect('claude', ref);
      assertEquals([c.cwd, c.agentCwd, c.projectRoot, c.worktree], [ref, `${ROOT}/plain`, ref, null]);
      assertEquals(await sh('ls -A "$1"/data-*/worktrees 2>/dev/null | wc -l', ROOT), '0');
    } finally {
      for (const s of studios) await s.close().catch(() => {});
      await cleanRoot();
      Deno.removeSync(state, { recursive: true });
    }
  },
});
