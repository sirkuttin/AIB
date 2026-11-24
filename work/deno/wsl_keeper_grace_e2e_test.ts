/**
 * Real WSL (AIB_WSL_E2E=<distro>; see _wsl_e2e.ts): the Linux keeper's orphan grace (keeper 1.6.0 `--orphan-grace`, PROTOCOL.md
 * section 6; docs/WSL.md "AIB away with no keep-alive"). The incident it guards against: an older AIB build stopped the WSL keep-alive
 * in the Windows keeper as an unknown channel, so the Linux keeper had no client and stopped every agent ~35 s later.
 *
 * Here the grace is GRACE_S seconds (AIB_WSL_ORPHAN_GRACE, passed by wsl/hosts.ts to the bridge that starts the Linux keeper). AIB
 * crashes and an "older build" stops the keep-alive; past the old 35 s the agent still runs and the stretch without a client was never
 * interrupted (keeper.log, read with a plain `cat`: never a client); a new AIB takes the same chat (same Linux pid) over. Then the
 * same happens again and nobody comes: after the whole grace the agent is stopped (`orphaned`) and the keeper exits, saying so.
 */
import { assert, assertEquals } from './_assert.ts';
import { pause, until } from './_connection.ts';
import { cleanRoot, inDistro, KEY, newAib, prepareRoot, readyHost, ROOT, T, withWindowsKeeper } from './_wsl_e2e.ts';
import { Connection } from '../../app/server/acp/connection.ts';
import { Aib } from '../../app/server/host/aib.ts';
import { refOf } from '../../app/server/platform/location.ts';
import { linkOf } from '../../app/server/wsl/access.ts';
import { type WslHostImpl, wslHostsInUse } from '../../app/server/wsl/hosts.ts';
import { aibInternalKind, KeeperLink, liveUserChannels } from '../../app/server/keeper/link.ts';

const GRACE_S = 50;
Deno.env.set('AIB_WSL_ORPHAN_GRACE', `${GRACE_S}s`); // before any host starts (they start on first use)

function aibIn(state: string, keeper: KeeperLink): Aib {
  const aib = new Aib({ stateDir: state, port: 0, ownersDir: null, noArtifactTool: true }, { keeper });
  aib.ownerProbe = () => null;
  aib.connectionFactory = (_command, cwd, provider, options) =>
    new Connection(['node', `${ROOT}/fake_acp.mjs`, '--cancel-aware'], cwd, provider, {
      ...options,
      wsl: options?.wsl ? { ...options.wsl, program: '/usr/bin/node' } : options?.wsl,
    });
  return aib;
}

/** A Windows keeper for this test's data folder with fast idle rules and an orphan command that does nothing visible. */
function windowsKeeper(state: string): KeeperLink {
  return new KeeperLink({
    dataDir: state,
    orphan: { command: Deno.execPath(), args: ['eval', '0'], cwd: state },
    extraArgs: ['--exit-after', '3s', '--orphan-after', '1s', '--orphan-retry', '1s', '--orphan-tries', '2'],
  });
}

/** The Linux keeper's files, read with cat (never a connection: a client would end the stretch without one). */
async function linuxKeeper(): Promise<{ log: string; info: Record<string, unknown> | null; channels: Record<string, unknown>[] }> {
  const read = async (name: string) => (await inDistro('cat "$1"/data-*/keeper/"$2" 2>/dev/null', [ROOT, name])).out;
  const json = (text: string) => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };
  return { log: await read('keeper.log'), info: json(await read('keeper.json')), channels: json(await read('channels.json')) ?? [] };
}

const agentsIn = (channels: Record<string, unknown>[]) => channels.filter((c) => !aibInternalKind(String(c.label ?? '')));

async function alive(pid: number): Promise<boolean> {
  return (await inDistro('kill -0 "$1" 2>/dev/null && echo yes || echo no', [String(pid)])).out.trim() === 'yes';
}

/**
 * AIB crashes and an older build stops the keep-alive: the WSL hosts go without a word (their transports end), AIB stops
 * reconnecting, then another AIB (the older build) claims and kills the wsl-hold channel in the Windows keeper.
 */
async function crashAndDropTheKeepAlive(aib: Aib, state: string, link: KeeperLink): Promise<void> {
  newAib(); // first: a running host would start the keep-alive again
  aib.reconnectStop.set();
  for (const conn of aib.connections.values()) conn.sessionLease?.release();
  await aib.historyClient()?.shutdown().catch(() => {});
  const client = (await link.client(false))!;
  const holds = (await client.list()).filter((c) => c.live && aibInternalKind(c.label) === 'wsl-hold');
  assertEquals(holds.length, 1, 'the keep-alive ran');
  const older = new KeeperLink({ dataDir: state }); // the older AIB build, which does not know the channel
  await older.stopUnknown((await older.client(false))!, holds[0].channel);
  older.disconnect();
  link.disconnect();
}

Deno.test({
  name: `wsl e2e: the Linux keeper keeps a WSL agent for its grace (${GRACE_S} s here) with no AIB and no keep-alive, then stops it`,
  ...T,
  async fn() {
    const state = Deno.makeTempDirSync({ prefix: 'aib-wsl-grace-e2e-' });
    await prepareRoot();
    const aibs: Aib[] = [];
    const links: KeeperLink[] = [];
    try {
      const linkA = windowsKeeper(state);
      links.push(linkA);
      newAib(withWindowsKeeper(linkA));
      const host = (await readyHost()) as WslHostImpl;
      const ref = refOf({ kind: 'wsl', distro: KEY, linuxPath: `${ROOT}/repo` });
      const a = aibIn(state, linkA);
      aibs.push(a);
      const c = await a.connect('claude', ref);
      await until(() => host.holding, 'the keep-alive runs in the Windows keeper', 30);
      const before = await linuxKeeper();
      assertEquals(before.info?.orphanGrace, GRACE_S, 'the bridge started the Linux keeper with the test grace');
      const agents = agentsIn(before.channels).filter((ch) => ch.live);
      assertEquals(agents.length, 1, JSON.stringify(before.channels));
      const pid = Number(agents[0].pid);
      const logStart = before.log.length;

      // 1. Away past the old 35 s: the agent still runs, and nothing was a client meanwhile.
      await crashAndDropTheKeepAlive(a, state, linkA);
      aibs.pop();
      const dropped = Date.now();
      await pause(40_000);
      const away = await linuxKeeper();
      const during = away.log.slice(logStart);
      assert(await alive(pid), `the agent was stopped ${Math.round((Date.now() - dropped) / 1000)} s after the last client left`);
      assert(during.includes(`no client: keeping 1 live channels; they stop after ${GRACE_S}s without a client`), during);
      assert(!/a client (is back|came and went)|stopping/.test(during), `the stretch without a client was interrupted:\n${during}`);
      assert(typeof away.info?.orphanStopAt === 'number', JSON.stringify(away.info));

      // 2. A new AIB within the grace takes the same chat over (the same agent process, never a second).
      const linkB = windowsKeeper(state);
      links.push(linkB);
      newAib(withWindowsKeeper(linkB));
      const b = aibIn(state, linkB);
      aibs.push(b);
      assertEquals(await b.adoptKeeper(), 1);
      const r = b.connections.get(c.id)!;
      assert(r?.ready && !r.closed, 'the chat was taken over');
      const linux = (await linkOf(await readyHost()).client(false))!;
      const live = liveUserChannels(await linux.list());
      assertEquals([live.length, live[0]?.pid], [1, pid], 'the same agent, never a second');
      const back = await linuxKeeper();
      assert(/a client is back after/.test(back.log.slice(logStart)), back.log.slice(logStart));
      assert(back.info?.orphanStopAt === undefined, 'the stretch ended');
      await until(() => wslHostsInUse()!.peek(KEY)!.holding, 'the new AIB has a keep-alive again', 30);

      // 3. The same again, and nobody comes: after the whole grace the agent stops and the keeper exits, saying so.
      const logAgain = back.log.length;
      await crashAndDropTheKeepAlive(b, state, linkB);
      aibs.pop();
      const left = Date.now();
      let end = await linuxKeeper();
      for (let i = 0; i < 60 && !end.log.slice(logAgain).includes('stopped'); i++) {
        await pause(2000);
        end = await linuxKeeper();
      }
      const after = end.log.slice(logAgain);
      const took = (Date.now() - left) / 1000;
      assert(after.includes(`no client for ${GRACE_S}s: stopping 1 channels and exiting`), after);
      assert(took >= GRACE_S - 2, `stopped after ${took} s, before the ${GRACE_S} s grace`); // the stretch began just before left
      assert(!(await alive(pid)), 'the agent still runs after the grace');
      assertEquals(end.info, null, 'keeper.json is gone: the keeper exited');
      const ended = agentsIn(end.channels);
      assertEquals(ended.map((ch) => [ch.live, ch.reason]), [[false, 'orphaned']]);
    } finally {
      for (const s of aibs) await s.close().catch(() => {});
      for (const link of links) {
        try {
          const client = await new KeeperLink({ dataDir: link.options.dataDir }).client(false);
          await client?.shutdown(true);
          client?.close();
        } catch { /* gone */ }
      }
      await cleanRoot();
      try {
        Deno.removeSync(state, { recursive: true });
      } catch { /* a keeper still closing its log */ }
    }
  },
});
