/**
 * Send later in a WSL project (owner parity rule, 2026-11-23): the schedule lives in the host's Connection, so a chat in a distro
 * behaves exactly as a Windows chat: schedule from the route, the card is listed, the time arrives, the message goes to the agent in
 * the distro; edit and cancel work; a restarted AIB sends what came due while it was away, with the "Sent late" line.
 * Real WSL (AIB_WSL_E2E=<distro>; see _wsl_e2e.ts): with it unset every test here is ignored, so the file skips cleanly without WSL.
 * Fake agent only (work/fake_acp.py in the distro); temp folders only.
 */
import { assert, assertEquals } from './_assert.ts';
import { until } from './_connection.ts';
import { cleanRoot, KEY, newAib, prepareRoot, readyHost, ROOT, T } from './_wsl_e2e.ts';
import { Connection } from '../../outputs/agent-studio/server/acp/connection.ts';
import { Studio } from '../../outputs/agent-studio/server/host/studio.ts';
import { refOf } from '../../outputs/agent-studio/server/platform/location.ts';

type Json = Record<string, unknown>;
const MIN = 60_000;

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

const users = (c: Connection) => c.events.filter((e) => e.kind === 'user').map((e) => (e.data as Json).text);
const waiting = (c: Connection) => ((c.queuePublic().scheduled ?? []) as Json[]).map((i) => [i.id, i.text]);

Deno.test({
  name: 'wsl e2e: Send later in a WSL chat: scheduled, listed, edited, cancelled, and sent at its time',
  ...T,
  async fn() {
    const state = Deno.makeTempDirSync({ prefix: 'aib-wsl-later-e2e-' });
    await prepareRoot();
    const studios: Studio[] = [];
    try {
      await readyHost();
      const ref = refOf({ kind: 'wsl', distro: KEY, linuxPath: `${ROOT}/repo` });
      const a = studioIn(state);
      studios.push(a);
      const c = await a.connect('claude', ref, null, { ownCopy: true });
      assert(c.wsl, 'a WSL chat');
      const at = Date.now() + 3600_000;
      assertEquals((await a.liveCall('schedule', { id: c.id, text: 'mcp', clientMessageId: 'w1', at }))[0], 200);
      assertEquals((await a.liveCall('schedule', { id: c.id, text: 'cancel me', clientMessageId: 'w2', at }))[0], 200);
      assertEquals(waiting(c), [['w1', 'mcp'], ['w2', 'cancel me']]);
      assertEquals((await a.liveCall('schedule-cancel', { id: c.id, messageId: 'w2' }))[0], 200);
      assertEquals((await a.liveCall('schedule-edit', { id: c.id, messageId: 'w1', text: 'sleep:0.1', at: Date.now() + 1500 }))[0], 200);
      assertEquals(waiting(c), [['w1', 'sleep:0.1']]);
      assertEquals(users(c), [], 'nothing before the time');
      await until(() => users(c).join() === 'sleep:0.1', 'sent at its time, in the distro', 60);
      await until(() => !c.busy, 'turn end', 60);
      assertEquals(waiting(c), []);
    } finally {
      for (const s of studios) await s.close().catch(() => {});
      await cleanRoot();
      Deno.removeSync(state, { recursive: true });
    }
  },
});

Deno.test({
  name: 'wsl e2e: a scheduled message whose time passed while AIB was off is sent at the next start, marked "Sent late"',
  ...T,
  async fn() {
    const state = Deno.makeTempDirSync({ prefix: 'aib-wsl-later-late-e2e-' });
    await prepareRoot();
    const studios: Studio[] = [];
    try {
      await readyHost();
      const ref = refOf({ kind: 'wsl', distro: KEY, linuxPath: `${ROOT}/repo` });
      const a = studioIn(state);
      studios.push(a);
      const c = await a.connect('claude', ref, null, { ownCopy: true });
      const soon = Date.now() + 2_000;
      assertEquals((await a.liveCall('schedule', { id: c.id, text: 'mcp', clientMessageId: 'w1', at: soon + 60 * MIN }))[0], 200);
      assertEquals(waiting(c).length, 1);
      // AIB quits (orderly: the saved queue file keeps the schedule); a new AIB opens the same chat three hours later
      await a.close();
      studios.pop();
      newAib();
      const b = studioIn(state);
      studios.push(b);
      const r = await b.connect('claude', ref, c.sessionId, { ownCopy: true });
      const clock = Date.now();
      r.scheduleNow = () => clock + 4 * 60 * MIN;
      await r.scheduleTick();
      await until(() => users(r).includes('mcp'), 'sent at the next start', 60);
      const note = r.events.map((e) => (e.data as Json)?.message).find((m) => typeof m === 'string' && m.startsWith('Sent late (scheduled '));
      assert(note, 'the chat says it was sent late');
    } finally {
      for (const s of studios) await s.close().catch(() => {});
      await cleanRoot();
      Deno.removeSync(state, { recursive: true });
    }
  },
});
