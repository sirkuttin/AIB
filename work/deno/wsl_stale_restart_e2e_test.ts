/**
 * Real WSL (AIB_WSL_E2E=<distro>; see _wsl_e2e.ts; skipped without it): the stale-chat restart (0.15 slice 3) for a chat whose agent
 * runs in the distro's Linux keeper. A fake agent (work/fakes/fake_acp.mjs with the distro's node) answers one prompt; the chat is then
 * made stale (another tool list served) and AIB restarts it through the Continue path: same chat id and conversation, history kept,
 * one agent in the distro (never a second), the plain line "Restarted to pick up new AIB tools".
 */
import { assert, assertEquals } from './_assert.ts';
import { until } from './_connection.ts';
import { cleanRoot, KEY, prepareRoot, readyHost, ROOT, T } from './_wsl_e2e.ts';
import { Connection } from '../../app/server/acp/connection.ts';
import { Aib } from '../../app/server/host/aib.ts';
import { refOf } from '../../app/server/platform/location.ts';
import { linkOf } from '../../app/server/wsl/access.ts';
import { liveUserChannels } from '../../app/server/keeper/link.ts';

type Json = Record<string, unknown>;

Deno.test({
  name: 'wsl e2e: a stale chat in the distro restarts itself through Continue, keeping its id and history, one agent in the distro',
  ...T,
  async fn() {
    const state = Deno.makeTempDirSync({ prefix: 'aib-wsl-stale-e2e-' });
    await prepareRoot();
    let a: Aib | null = null;
    try {
      await readyHost();
      const ref = refOf({ kind: 'wsl', distro: KEY, linuxPath: `${ROOT}/repo` });
      a = new Aib({ stateDir: state, port: 0, ownersDir: null });
      a.ownerProbe = () => null;
      a.connectionFactory = (_command, cwd, provider, options) =>
        new Connection(['node', `${ROOT}/fake_acp.mjs`, '--cancel-aware', '--held-turn', '--not-claude'], cwd, provider, {
          ...options,
          wsl: options?.wsl ? { ...options.wsl, program: '/usr/bin/node' } : options?.wsl,
        });
      const c = await a.connect('claude', ref);
      const sent = await a.liveCall('prompt', { id: c.id, text: 'hello before the restart', clientMessageId: 'm1' });
      await until(() => !c.busy && c.events.some((e) => JSON.stringify(e.data).includes('Fixture reply')), `turn end (${JSON.stringify(sent)}; busy ${c.busy}; ${c.events.length} events; ${c.error})`, 30);
      assert(c.mcpServers.length > 0, 'the chat has AIB\'s tool entry (the distro tunnel)');
      a.served!.tools(c.id, ['publish']); // a list another AIB version served
      assertEquals(a.staleWhy(c), ['tools']);
      assertEquals(await a.staleScan(), [c.id]);
      const next = a.connections.get(c.id)!;
      assert(next !== c && c.closed && next.ready && !next.closed, 'replaced under the same id');
      assertEquals(next.sessionId, c.sessionId);
      assert(next.events.some((e) => JSON.stringify(e.data).includes('hello before the restart')), 'the history stays');
      assert(next.events.some((e) => e.kind === 'studio_note' && (e.data as Json).message === 'Restarted to pick up new AIB tools'));
      const client = (await linkOf(await readyHost()).client(false))!;
      assertEquals(liveUserChannels(await client.list()).length, 1, 'one agent in the distro, never a second');
    } finally {
      await a?.close().catch(() => {});
      await cleanRoot();
      Deno.removeSync(state, { recursive: true });
    }
  },
});
