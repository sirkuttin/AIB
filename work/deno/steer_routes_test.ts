/**
 * T26 (B11) and B15: the steer and tool-stop calls through the Studio (POST /api/live/steer, /api/live/tool-stop: flat like the
 * queue-* calls, in Studio.LIVE_POST_OPS and the web route table), and the history's "Sent while working" flag.
 */
import { assert, assertEquals } from './_assert.ts';
import { until } from './_connection.ts';
import { promptText, SteerLab } from './_steer.ts';
import { AgentHost } from '../../outputs/agent-studio/server/host/agent_host.ts';
import { LIVE_POST_OPS } from '../../outputs/agent-studio/server/host/studio.ts';
import { LIVE_POST_OPS as WEB_OPS } from '../../outputs/agent-studio/server/web/live_routes.ts';
import { ROUTE_LIST } from '../../outputs/agent-studio/server/web/routes.ts';
import { normalize } from '../../outputs/agent-studio/server/transcripts/normalize.ts';

type Json = Record<string, unknown>;

Deno.test('T26 (B11): steer and tool-stop are live calls of the Studio and routes of the web server', async () => {
  for (const op of ['steer', 'tool-stop']) {
    assert(LIVE_POST_OPS.has(op) && (WEB_OPS as readonly string[]).includes(op), op);
    assert(ROUTE_LIST.some(([m, path, scope, kind]) => m === 'POST' && path === `/api/live/${op}` && scope === 'write' && kind === 'body'));
  }
  await using lab = new SteerLab();
  const host = new AgentHost({ ompCommand: 'unused', stateDir: lab.dir, port: 0 } as never, 30, 0, { exitUnattachedSeconds: 10 });
  try {
    const studio = host.studio;
    const { c, p } = await lab.chat('claude');
    studio.connections.set(c.id, c);
    // Idle: an ordinary prompt.
    const [status, idle] = await studio.liveCall('steer', { id: c.id, text: 'hello', clientMessageId: 'm1' }) as [number, Json];
    assertEquals([status, idle.ok, idle.state, idle.id], [200, true, 'prompted', 'm1']);
    const prompt = await p.take('session/prompt');
    assertEquals(promptText(prompt), 'hello');
    // Working: steered.
    const sending = studio.liveCall('steer', { id: c.id, text: 'and this', clientMessageId: 's1' });
    await p.reply((await p.take('_session/steering')).id, { outcome: 'injected' });
    const [, steered] = await sending as [number, Json];
    assertEquals([steered.state, steered.steerLane], ['injected', []]);
    // Stop on a row that is not running in the background: 409, with a reason.
    const [refused, why] = await studio.liveCall('tool-stop', { id: c.id, toolCallId: 'nope' }) as [number, Json];
    assertEquals([refused, why.code], [409, 'not_stoppable']);
    assertEquals((await studio.liveCall('tool-stop', { id: c.id }))[0], 400, 'toolCallId is required');
    await p.reply(prompt.id, { stopReason: 'end_turn' });
    await until(() => !c.busy, 'done');
  } finally {
    host.studio.connections.clear();
    await host.studio.close();
  }
});

Deno.test('B15: a message Claude Code saved as sent while it worked is a user message tagged steered in the history', () => {
  const row = { type: 'attachment', timestamp: 't', attachment: { type: 'queued_command', commandMode: 'prompt', prompt: 'also this' } };
  const events = normalize(row, 4);
  assertEquals(events.map((e) => [e.kind, e.text, e.steered]), [['user', 'also this', true]]);
  const plain = normalize({ type: 'user', message: { role: 'user', content: 'hi' } }, 5);
  assertEquals(plain.map((e) => [e.kind, e.steered]), [['user', undefined]]);
});
