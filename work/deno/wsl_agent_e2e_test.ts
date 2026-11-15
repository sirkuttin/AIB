/**
 * Real WSL (AIB_WSL_E2E=<distro>; see _wsl_e2e.ts): a fake agent in a temp git repo inside the distro, prompt and reply through the
 * distro's Linux keeper, then an AIB restart that rebuilds the chat from that keeper (design section 7, wsl_agent_e2e). The agent is
 * work/fake_acp.py run with the distro's python3 from AIB_WSL_ROOT; its HOME is inside AIB_WSL_ROOT.
 */
import { assert, assertEquals } from './_assert.ts';
import { pause, until } from './_connection.ts';
import { cleanRoot, KEY, newAib, prepareRoot, readyHost, ROOT, T, withWindowsKeeper } from './_wsl_e2e.ts';
import { Connection } from '../../outputs/agent-studio/server/acp/connection.ts';
import { Studio } from '../../outputs/agent-studio/server/host/studio.ts';
import { refOf } from '../../outputs/agent-studio/server/platform/location.ts';
import { linkOf } from '../../outputs/agent-studio/server/wsl/access.ts';
import { type WslHostImpl, wslHostsInUse } from '../../outputs/agent-studio/server/wsl/hosts.ts';
import { aibInternalKind, KeeperLink, liveUserChannels } from '../../outputs/agent-studio/server/keeper/link.ts';
import { readKeeperInfo } from '../../outputs/agent-studio/server/keeper/client.ts';
import { pidAlive } from '../../outputs/agent-studio/server/host/host_client.ts';

type Json = Record<string, unknown>;

function studioIn(state: string, keeper: KeeperLink | null = null): Studio {
  const studio = new Studio({ ompCommand: 'unused', stateDir: state, port: 0, ownersDir: null, noArtifactTool: true }, { keeper });
  studio.ownerProbe = () => null;
  studio.connectionFactory = (_command, cwd, provider, options) =>
    new Connection(['python3', `${ROOT}/fake_acp.py`, '--cancel-aware'], cwd, provider, {
      ...options,
      wsl: options?.wsl ? { ...options.wsl, program: '/usr/bin/python3' } : options?.wsl,
    });
  return studio;
}

const said = (c: Connection) =>
  c.events.filter((e) => e.kind === 'update').map((e) => {
    const u = (e.data as Json).update as Json;
    return u.sessionUpdate === 'agent_message_chunk' ? String((u.content as Json).text) : '';
  }).join('');

Deno.test({
  name: 'wsl e2e: a fake agent runs in the distro (Linux cwd, distro env), answers, and a restarted AIB adopts it',
  ...T,
  async fn() {
    const state = Deno.makeTempDirSync({ prefix: 'aib-wsl-agent-e2e-' });
    await prepareRoot();
    const studios: Studio[] = [];
    try {
      const host = await readyHost();
      const ref = refOf({ kind: 'wsl', distro: KEY, linuxPath: `${ROOT}/repo` });
      const a = studioIn(state);
      studios.push(a);
      const c = await a.connect('claude', ref);
      // the repo is git: the chat works in its own worktree in the distro (wsl_worktrees_e2e checks it in detail)
      assert(c.agentCwd.startsWith(`${ROOT}/data-`) && c.agentCwd.includes('/worktrees/'), c.agentCwd);
      assertEquals(c.projectRoot, ref);
      await a.liveCall('prompt', { id: c.id, text: 'stream:4:20', clientMessageId: 'm1' });
      await until(() => c.permissions.size === 1, 'the question', 30);
      await a.liveCall('permission', { id: c.id, key: [...c.permissions.keys()][0], option: 'yes' });
      await until(() => !c.busy, 'turn end', 30);
      assertEquals(said(c), 'chunk0 chunk1 answer=yes chunk2 chunk3 ');
      // an AIB that went away without closing anything (a crash): its transport ends; the Linux keeper keeps the agent
      void host;
      newAib();
      a.reconnectStop.set();
      for (const conn of a.connections.values()) conn.sessionLease?.release();
      studios.pop();
      const b = studioIn(state);
      studios.push(b);
      assertEquals(await b.adoptKeeper(), 1);
      const r = b.connections.get(c.id)!;
      assert(r?.ready && !r.closed, 'adopted from the distro keeper');
      assertEquals([r.wsl?.linuxPath, r.projectRoot], [c.agentCwd, ref]);
      const client = (await linkOf(await readyHost()).client(false))!;
      assertEquals(liveUserChannels(await client.list()).length, 1, 'one agent in the distro, never a second');
    } finally {
      for (const s of studios) await s.close().catch(() => {});
      await cleanRoot();
      Deno.removeSync(state, { recursive: true });
    }
  },
});

/** A Windows keeper for one test's data folder, with fast idle and orphan rules and an orphan command that only leaves a mark. */
function windowsKeeper(state: string, marker: string): KeeperLink {
  const mark = `Deno.writeTextFileSync(${JSON.stringify(marker)}, 'ran\n', { append: true })`;
  return new KeeperLink({
    dataDir: state,
    orphan: { command: Deno.execPath(), args: ['eval', mark], cwd: state },
    extraArgs: ['--exit-after', '3s', '--orphan-after', '1s', '--orphan-retry', '1s', '--orphan-tries', '2'],
  });
}

const holdsOf = async (link: KeeperLink) =>
  (await (await link.client(false))!.list()).filter((c) => c.live && aibInternalKind(c.label) === 'wsl-hold');

function readOr(path: string): string {
  try {
    return Deno.readTextFileSync(path);
  } catch {
    return '';
  }
}

Deno.test({
  name: 'wsl e2e: Quit AIB with a WSL agent working keeps it (keep-alive + hold, no tray restart); the next AIB takes it over once',
  ...T,
  async fn() {
    const state = Deno.makeTempDirSync({ prefix: 'aib-wsl-hold-e2e-' });
    const marker = `${state}\\orphan-ran.txt`;
    const info = `${state}\\keeper\\keeper.json`;
    await prepareRoot();
    const studios: Studio[] = [];
    const links: KeeperLink[] = [];
    try {
      const linkA = windowsKeeper(state, marker);
      links.push(linkA);
      newAib(withWindowsKeeper(linkA));
      const host = (await readyHost()) as WslHostImpl;
      const ref = refOf({ kind: 'wsl', distro: KEY, linuxPath: `${ROOT}/repo` });
      const a = studioIn(state, linkA);
      studios.push(a);
      const c = await a.connect('claude', ref);
      await a.liveCall('prompt', { id: c.id, text: 'stream:4:20', clientMessageId: 'm1' });
      await until(() => c.permissions.size === 1, 'the question', 30);
      await until(() => host.holding, 'the keep-alive runs in the Windows keeper', 30);
      assertEquals((await holdsOf(linkA)).length, 1);
      const winPid = readKeeperInfo(state)!.pid;

      // Quit AIB with work running (main.ts close(..., release, hold)): the chat stays, the keep-alive stays, the keeper holds.
      await a.release({ hold: true });
      studios.pop();
      await pause(6000); // past exit-after (3 s) and orphan-after + 2 tries (3 s)
      assert(pidAlive(winPid), 'the Windows keeper kept running for the keep-alive');
      assertEquals(readOr(marker), '', 'no AIB was started again in the tray');
      assert(readOr(info).includes('"held": true'), 'the Windows keeper holds');

      // The next AIB: the same Windows keeper and keep-alive (claimed, not a second one), the chat taken over from the distro.
      const linkB = windowsKeeper(state, marker);
      links.push(linkB);
      newAib(withWindowsKeeper(linkB));
      const b = studioIn(state, linkB);
      studios.push(b);
      assertEquals(await b.adoptKeeper(), 1);
      const r = b.connections.get(c.id)!;
      assert(r?.ready && !r.closed, 'the chat was taken over');
      await until(() => r.permissions.size === 1, 'the waiting question came back with the chat', 30);
      await b.liveCall('permission', { id: r.id, key: [...r.permissions.keys()][0], option: 'yes' });
      await until(() => !r.busy, 'turn end', 30);
      assert(said(r).includes('answer=yes'), said(r));
      const linux = (await linkOf(await readyHost()).client(false))!;
      assertEquals(liveUserChannels(await linux.list()).length, 1, 'one agent in the distro, never a second');
      const second = wslHostsInUse()!.peek(KEY)!;
      await until(() => second.holding, 'the new AIB took the keep-alive over', 30);
      assertEquals((await holdsOf(linkB)).length, 1, 'one keep-alive');
      await until(() => !readOr(info).includes('"held": true'), 'the hold ended', 10);

      // A plain quit stops the chat; with nothing left in the distro the keep-alive goes at once and the Windows keeper idles out
      // (3 s here). A keep-alive left running would end only after its own 10 s grace.
      await b.close();
      studios.pop();
      assert(!readOr(info).includes('"held": true'), 'a plain quit with nothing running does not hold');
      await until(() => !pidAlive(winPid), 'the Windows keeper left once nothing ran', 9);
      assertEquals(readOr(marker), '', 'still no restart in the tray');
    } finally {
      for (const s of studios) await s.close().catch(() => {});
      for (const link of links) {
        try {
          const client = await link.client(false);
          await client?.shutdown(true);
        } catch { /* gone */ }
        link.disconnect();
      }
      await cleanRoot();
      try {
        Deno.removeSync(state, { recursive: true });
      } catch { /* a keeper still closing its log */ }
    }
  },
});
