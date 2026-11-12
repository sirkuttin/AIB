/** server/host/host_proxy.ts against the real Python agent host (work/python-reference): attach, list, a clean stop (host_stopped), and a crash (restart). */
import { assert, assertEquals, assertRejects } from './_assert.ts';
import { PY_REF_DIR, python } from './_parity.ts';
import { attachHost, HostProxy } from '../../outputs/agent-studio/server/host/host_proxy.ts';
import { HostUnavailable, readInfo, stopHost } from '../../outputs/agent-studio/server/host/host_client.ts';
import { join } from '../../outputs/agent-studio/server/platform/path.ts';

async function setup() {
  const root = await Deno.makeTempDir({ prefix: 'aib-proxy-' });
  const state = join(root, 'state');
  for (const d of ['state', 'omp', 'claude']) await Deno.mkdir(join(root, d));
  Deno.env.set('AGENT_STUDIO_TEST', '1');
  Deno.env.set('AGENT_STUDIO_STATE_DIR', state);
  const command = [
    python(), join(PY_REF_DIR, 'agent_host.py'), '--state-dir', state, '--omp-sessions', join(root, 'omp'), '--claude-projects', join(root, 'claude'),
    '--omp-command', 'omp', '--node-command', 'node', '--claude-launcher', '', '--codex-launcher', '', '--no-auto-reconnect',
    '--no-owner-announcements', '--host-port', '0', '--idle-exit-minutes', '2',
  ];
  return { root, state, command };
}

Deno.test({
  name: 'HostProxy: attach, list, clean stop is permanent, crashed host is restarted',
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const { root, state, command } = await setup();
    const messages: string[] = [];
    const proxy = await attachHost({ stateDir: state, command, port: 0, webInstanceId: 'web-test', say: (m) => messages.push(m), heartbeatSeconds: 3600 });
    try {
      const info = await proxy.liveInfo();
      assert(typeof info.hostId === 'string' && info.hostId === proxy.instanceId, JSON.stringify(info));
      const listing = await proxy.liveList();
      assertEquals(listing.connections, []);
      const [status, payload] = await proxy.liveCall('discover', { provider: 'nope' });
      assert(typeof status === 'number' && payload !== undefined, 'live call shape');

      // A crash: the host dies without removing its file. The next call cannot be sent, so the proxy starts a new host.
      const first = await readInfo(state);
      Deno.kill(first!.pid!, 'SIGKILL');
      for (let i = 0; i < 50 && (await fetchOk(first!.port)); i++) await new Promise((r) => setTimeout(r, 100));
      const again = await proxy.liveInfo();
      assert(again.hostId !== info.hostId, 'expected a new host after the crash');
      assert(messages.filter((m) => m.startsWith('Started agent host process')).length === 2, messages.join('\n'));

      // A clean stop removes the file: the proxy reports host_stopped and does not start another host.
      assertEquals((await stopHost(state)).stopped, true);
      const degraded = await proxy.liveList();
      assertEquals(degraded.instanceId, 'host-unavailable');
      assert(String(degraded.recoveryWarning).includes('not running (it was stopped)'), String(degraded.recoveryWarning));
      const error = await assertRejects(() => proxy.liveState('x'), HostUnavailable) as HostUnavailable;
      assertEquals(error.code, 'host_stopped');
      assertEquals(await readInfo(state), null);
    } finally {
      await proxy.close();
      await stopHost(state, true).catch(() => {});
      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
  },
});

async function fetchOk(port: number): Promise<boolean> {
  try {
    (await Deno.connect({ hostname: '127.0.0.1', port })).close();
    return true;
  } catch {
    return false;
  }
}

Deno.test('a web server started with --port 0 tells the host the port it got as soon as it listens', async () => {
  // The host builds the artifact tool's URL for agents from the attached app's port: 0 there left agents without a working URL.
  const calls: [string, unknown][] = [];
  const client = { call: (op: string, args: unknown) => (calls.push([op, structuredClone(args)]), Promise.resolve({})) };
  const proxy = new HostProxy({ stateDir: '.', command: [], port: 0, webInstanceId: 'w', heartbeatSeconds: 3600 } as never, client as never);
  await proxy.listening(51234);
  assertEquals(calls.map(([op, a]) => [op, (a as { port: number }).port]), [['attach', 51234]], 'attached again at once, with the real port');
  await proxy.listening(51234);
  assertEquals(calls.length, 1, 'the same port: nothing to tell');
});
