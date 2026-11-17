/**
 * Settings' agent list built off the event loop (server/web/shared.ts agentListOffThread, agents_worker.ts): the same rows as the
 * build in the server's thread, while the server keeps answering (the in-thread build looks every agent up on PATH with
 * synchronous file checks: 0.4-2 s during which nothing else ran). A temp state folder and this PC's real PATH; reads only.
 */
import { assert, assertEquals } from './_assert.ts';
import * as shared from '../../outputs/agent-studio/server/web/shared.ts';
import { SettingsStore } from '../../outputs/agent-studio/server/state/store.ts';

/** Run fn while a 5 ms timer measures the event loop: the worst lateness of that timer (ms). */
async function stallDuring<T>(fn: () => Promise<T>): Promise<[T, number]> {
  let worst = 0, last = performance.now();
  const timer = setInterval(() => {
    const t = performance.now();
    worst = Math.max(worst, t - last - 5);
    last = t;
  }, 5);
  try {
    const out = await fn();
    await new Promise((r) => setTimeout(r, 20));
    return [out, worst];
  } finally {
    clearInterval(timer);
  }
}

Deno.test({
  name: 'the agent list built in the Worker: the same rows as in the server thread, and the event loop keeps running',
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const state = await Deno.makeTempDir({ prefix: 'aib-agent-list-' });
    try {
      const store = new SettingsStore(state);
      const options = { stateDir: state };
      const connections = [{ provider: 'claude', ready: true }, { provider: 'codex', auth: { url: 'x' }, ready: false }];
      const [inThread, stallIn] = await stallDuring(() => shared.describeAgents(options, store, connections));
      await shared.agentListOffThread(options, store, connections); // the Worker's first start loads its modules
      const [offThread, stallOff] = await stallDuring(() => shared.agentListOffThread(options, store, connections));
      console.log(`agent list: in the server thread the loop stalled ${Math.round(stallIn)} ms; in the Worker ${Math.round(stallOff)} ms`);
      assertEquals(offThread, inThread);
      assert(stallOff < 100, `the event loop stalled ${Math.round(stallOff)} ms while the Worker built the list`);
      // asked twice at once with the same inputs: one build, both get it
      const [a, b] = await Promise.all([
        shared.agentListOffThread(options, store, connections),
        shared.agentListOffThread(options, store, connections),
      ]);
      assertEquals(a, b);
    } finally {
      Deno.removeSync(state, { recursive: true });
    }
  },
});
