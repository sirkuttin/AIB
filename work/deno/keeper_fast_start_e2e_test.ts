/**
 * AIB answers as soon as it listens, whatever the take-over at start costs (the owner's test build 24: the window opened ~21 s after
 * the server listened, behind the take-over of 14 chats and a WSL install). Real processes: AIB (`serve`, one process with the
 * keeper), the keeper, the fake agent. AIB is killed while its chat runs in the keeper; the next AIB is started with a slow take-over
 * (AIB_TEST_TAKEOVER_DELAY_MS, tests only) and must print its address, answer the list and settings at once (the chat Reconnecting…
 * meanwhile, never Not running), log the startup phases in order, and still take the chat over (same agent process). Temp state
 * folder, OS-picked ports, only PIDs this test started (and the AIB its keeper may start) are killed.
 */
import { assert, assertEquals } from './_assert.ts';
import { Fixture, nativePath, openConversation, SEP, TEST_OPTIONS, until, type Web } from './_host_fixture.ts';
import { WORK } from './_work.ts';
import { keeperBinary, KeeperClient, readKeeperInfo } from '../../app/server/keeper/client.ts';
import { pidAlive } from '../../app/server/host/host_client.ts';

type Json = Record<string, unknown>;
const KEEPER_AGENT = nativePath(new URL('keeper-fixture/agent.mjs', WORK));
const DELAY_MS = 8000;

class KeeperFixture extends Fixture {
  keeperBin = '';

  override agentFlags(): string[] {
    const flags = super.agentFlags();
    flags[flags.indexOf('--claude-launcher') + 1] = KEEPER_AGENT;
    return flags;
  }

  override get env(): Record<string, string> {
    const env: Record<string, string> = { ...super.env, AIB_KEEPER_BIN: this.keeperBin };
    delete env.AIB_KEEPER; // the keeper on (the default)
    return env;
  }

  override async cleanup(): Promise<void> {
    const keeper = readKeeperInfo(this.state);
    if (keeper && pidAlive(keeper.pid)) Deno.kill(keeper.pid, 'SIGKILL'); // the keeper this test's AIB started
    try { // an AIB the keeper may have started (not our child)
      const owner = JSON.parse(Deno.readTextFileSync(this.state + SEP + 'aib-owner.json'));
      if (typeof owner.pid === 'number' && owner.pid !== Deno.pid) this.hostPids.add(owner.pid);
    } catch { /* none */ }
    await super.cleanup().catch(() => {});
  }
}

async function channelPid(state: string, channel: string): Promise<number> {
  const client = await KeeperClient.connect(readKeeperInfo(state)!, 'fast start e2e test');
  try {
    return (await client.list()).find((c) => c.channel === channel && c.live)?.pid ?? 0;
  } finally {
    client.close();
  }
}

Deno.test({
  name: 'fast start: AIB answers at once while the take-over of a keeper chat is still running; the chat says Reconnecting… then comes back',
  ...TEST_OPTIONS,
  async fn() {
    const fixture = new KeeperFixture();
    try {
      fixture.keeperBin = await keeperBinary();
      const first: Web = await fixture.startWeb();
      assertEquals(first.boot.hostMode, 'keeper');
      const id = await openConversation(first, fixture);
      const agentPid = await channelPid(fixture.state, `chat-${id}`);
      assert(agentPid > 0, 'the agent runs in the keeper');
      await first.kill(); // AIB gone, the agent goes on in the keeper

      const started = performance.now();
      const web = await fixture.startWeb([], { env: { AIB_TEST_TAKEOVER_DELAY_MS: String(DELAY_MS) } });
      const ready = performance.now() - started;
      // The list, the settings and the chat's own state answer while the chat is still being taken over.
      let t0 = performance.now();
      const list = await web.listing();
      const listMs = performance.now() - t0;
      const connections = (list.connections as Json[]) ?? [];
      const adoptedYet = connections.some((c) => c.id === id && c.ready);
      assert(!adoptedYet, 'the take-over is still on its way (the test delay)');
      assert(listMs < 3000, `the list took ${Math.round(listMs)} ms`);
      const waiting = ((list.recovered as Json[]) ?? []).find((r) => r.sessionId === 'fake-session' || r.cwd === fixture.workspace);
      if (waiting) assertEquals(waiting.reconnecting, true, 'Reconnecting…, never Not running');
      t0 = performance.now();
      const [settingsStatus] = await web.get('/api/live/settings');
      assertEquals(settingsStatus, 200);
      assert(performance.now() - t0 < 3000, 'settings answer at once');
      const log = () => fixture.read(fixture.state + SEP + 'studio.log');
      assert(!/startup: take-over done/.test(log().split('startup: process started').at(-1) ?? ''), 'not done yet');

      // The chat comes back on the same agent once the take-over is done (liveState waits for it meanwhile).
      const back = await until(async () => {
        const s = await web.state(id);
        return s && s.id === id && s.ready ? s : null;
      }, 'the chat taken over', 40);
      assertEquals(back.error, '');
      assertEquals(await channelPid(fixture.state, `chat-${id}`), agentPid, 'the same agent process');
      assert(ready < DELAY_MS + 15000, `ready after ${Math.round(ready)} ms`);

      // studio.log: every startup phase, the server listening before the take-over is done.
      const text = await until(() => {
        const t = log().split('startup: process started').at(-1) ?? '';
        return /startup: take-over done/.test(t) ? t : '';
      }, 'the take-over line', 20);
      for (const phase of ['logging at', 'keeper decided at']) assert(text.includes(phase), `${phase} in ${text.slice(0, 400)}`);
      // the time before AIB's code ran (Windows loading it) is logged too, from the OS's creation time of the process
      if (Deno.build.os === 'windows') {
        const before = text.match(/Windows created the process at \S+, (-?\d+) ms before the runtime started/);
        assert(before, `the OS creation time in ${text.slice(0, 600)}`);
        assert(Number(before[1]) >= -50 && Number(before[1]) < 30_000, `${before[1]} ms before the runtime started`);
      }
      const listening = text.indexOf('startup: server listening');
      const done = text.indexOf('startup: take-over done');
      assert(listening > 0 && done > listening, 'listening, then the take-over');
    } finally {
      await fixture.cleanup();
    }
  },
});
