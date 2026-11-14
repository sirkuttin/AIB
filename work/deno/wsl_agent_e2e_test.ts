/**
 * Real WSL (AIB_WSL_E2E=<distro>; see _wsl_e2e.ts): a fake agent in a temp git repo inside the distro, prompt and reply through the
 * distro's Linux keeper, then an AIB restart that rebuilds the chat from that keeper (design section 7, wsl_agent_e2e). The agent is
 * work/fake_acp.py run with the distro's python3 from AIB_WSL_ROOT; its HOME is inside AIB_WSL_ROOT.
 */
import { assert, assertEquals } from './_assert.ts';
import { until } from './_connection.ts';
import { cleanRoot, KEY, prepareRoot, readyHost, ROOT, T } from './_wsl_e2e.ts';
import { Connection } from '../../outputs/agent-studio/server/acp/connection.ts';
import { Studio } from '../../outputs/agent-studio/server/host/studio.ts';
import { refOf } from '../../outputs/agent-studio/server/platform/location.ts';
import { linkOf } from '../../outputs/agent-studio/server/wsl/access.ts';

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
      assertEquals(c.agentCwd, `${ROOT}/repo`);
      await a.liveCall('prompt', { id: c.id, text: 'stream:4:20', clientMessageId: 'm1' });
      await until(() => c.permissions.size === 1, 'the question', 30);
      await a.liveCall('permission', { id: c.id, key: [...c.permissions.keys()][0], option: 'yes' });
      await until(() => !c.busy, 'turn end', 30);
      assertEquals(said(c), 'chunk0 chunk1 answer=yes chunk2 chunk3 ');
      // an AIB that went away without closing anything (a crash or an update); the Linux keeper keeps the agent
      linkOf(host).disconnect();
      a.reconnectStop.set();
      for (const conn of a.connections.values()) conn.sessionLease?.release();
      studios.pop();
      const b = studioIn(state);
      studios.push(b);
      assertEquals(await b.adoptKeeper(), 1);
      const r = b.connections.get(c.id)!;
      assert(r?.ready && !r.closed, 'adopted from the distro keeper');
      assertEquals(r.wsl?.linuxPath, `${ROOT}/repo`);
    } finally {
      for (const s of studios) await s.close().catch(() => {});
      await cleanRoot();
      Deno.removeSync(state, { recursive: true });
    }
  },
});
