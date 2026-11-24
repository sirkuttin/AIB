/**
 * Contract (ported from work/contract/test_contract_agent.py): a fake ACP agent (work/combined-fixture/agent.mjs, run as "Claude
 * Code") driven over HTTP through the real server, step for step: connect, state polling, a prompt that asks for approval, the
 * approval, a long turn that is retried (receipt) and cancelled, the live list, a settings change, disconnect. The old version
 * compared every reply with the reference; here each reply is asserted. The fake agent is a fixture, not the reference server.
 */
import { assertEquals } from './_assert.ts';
import { ContractServer, NODE, WORK } from './_contract_server.ts';

const native = (url: URL) => decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:)/, '$1');

type Evt = { kind: string; data?: { stopReason?: string; update?: { sessionUpdate?: string } } };

Deno.test('contract: a full conversation with a fake agent over HTTP', async () => {
  await using s = await ContractServer.start({
    extraArgs: ['--node-command', NODE, '--claude-launcher', native(new URL('combined-fixture/agent.mjs', WORK))],
  });
  const workspace = s.workspace;
  const connected = await s.post('/api/live/connect', { provider: 'claude', background: true, cwd: workspace });
  assertEquals(connected.status, 200, connected.text);
  const id: string = connected.json.id;
  assertEquals([connected.json.provider, connected.json.cwd, connected.json.state, connected.json.closed], ['claude', workspace.replaceAll('/', Deno.build.os === 'windows' ? '\\' : '/'), 'opening', false]);
  const state = async (after = 0) => (await s.get(`/api/live/state?id=${id}&after=${after}`)).json;
  const kinds = (events: Evt[]) => events.map((e) => [e.kind, e.data?.update?.sessionUpdate ?? e.data?.stopReason ?? null]);

  // ready comes first (the session is open), setupDone once the server finished opening the chat (lease, recovery note, 'ready'
  // announcement, live sync): only then is the state settled
  const ready = await s.until('ready and setup done', async () => {
    const x = await state();
    return x.ready && x.setupDone ? x : null;
  });
  assertEquals([ready.sessionId, ready.state, ready.busy, ready.imageSupported], ['fake-session', 'ready', false, true]);
  assertEquals(ready.settings.modes, { currentModeId: 'code', availableModes: [{ id: 'code', name: 'Code' }] });
  assertEquals(ready.settings.configOptions.map((o: { id: string }) => o.id), ['model', 'effort', 'verbose', 'dial']);
  assertEquals(ready.breadth.commands.map((c: { name: string }) => c.name), ['plan', 'compact', 'review']);
  assertEquals(ready.breadth.usage, { size: 200000, used: 12345, cost: { amount: 0.25, currency: 'USD' } });
  assertEquals(ready.limits, null, 'the fixture sends no usage limits');
  assertEquals(kinds(ready.events), [
    ['connected', null],
    ['update', 'available_commands_update'],
    ['update', 'session_info_update'],
    ['update', 'usage_update'],
    ['update', 'notice'],
  ]);
  const listed = (await s.get('/api/live/list')).json.connections;
  assertEquals(listed.map((c: { id: string; state: string }) => [c.id, c.state]), [[id, 'ready']]);

  // A prompt that asks for approval, answered over HTTP.
  const prompt = await s.post('/api/live/prompt', { id, text: 'approve', clientMessageId: 'turn-1' });
  assertEquals(prompt.json, { ok: true, accepted: true, duplicate: false, clientMessageId: 'turn-1', turnState: 'working' });
  const asking = await s.until('approval request', async () => {
    const x = await state();
    return x.permissions.length ? x : null;
  });
  assertEquals(asking.permissions.length, 1);
  const card = asking.permissions[0];
  assertEquals(card.params.toolCall, { title: 'Fixture approval', toolCallId: 'fake-tool' });
  assertEquals(card.params.options.map((o: { optionId: string }) => o.optionId), ['yes', 'no']);
  assertEquals(card.route, 'main');
  assertEquals((await s.get('/api/live/list')).json.connections[0].attention.state, 'needs_you');
  assertEquals((await s.post('/api/live/permission', { id, key: card.key, option: 'yes' })).json, { ok: true });
  const approved = await s.until('the approved turn ends', async () => {
    const x = await state();
    return !x.busy && x.events.some((e: Evt) => e.kind === 'turn_end') ? x : null;
  });
  assertEquals(kinds(approved.events).slice(5), [
    ['user', null],
    ['permission', null],
    ['update', 'agent_message_chunk'],
    ['turn_end', 'end_turn'],
  ]);
  assertEquals(Object.values(approved.answers as Record<string, { by: string }>).map((a) => a.by), ['pc']); // here only the PC answers

  // A long turn: busy, a retried send is recognised, cancel ends it.
  assertEquals((await s.post('/api/live/prompt', { id, text: 'wait', clientMessageId: 'turn-2' })).json.duplicate, false);
  await s.until('busy', async () => (await state()).busy);
  const retry = await s.post('/api/live/prompt', { id, text: 'wait', clientMessageId: 'turn-2' });
  assertEquals([retry.status, retry.json.duplicate, retry.json.accepted], [200, true, true]);
  const reused = await s.post('/api/live/prompt', { id, text: 'other', clientMessageId: 'turn-2' });
  assertEquals([reused.status, reused.json.error], [400, 'This client message ID was already used for different text']);
  const second = await s.post('/api/live/prompt', { id, text: 'more', clientMessageId: 'turn-3' });
  assertEquals([second.status, second.json.error], [400, 'Wait for the current turn, or interrupt it before sending another prompt']);
  assertEquals((await s.post('/api/live/cancel', { id })).json, { ok: true });
  const cancelled = await s.until('cancelled', async () => {
    const x = await state();
    return !x.busy && x.events.some((e: Evt) => e.data?.stopReason === 'cancelled') ? x : null;
  });
  assertEquals(kinds(cancelled.events).slice(-2), [['user', null], ['turn_end', 'cancelled']]);
  const nothing = await state(cancelled.cursor);
  assertEquals([nothing.events, nothing.reset], [[], false], 'nothing new after the cursor');

  // Settings and session ops answer.
  const mode = await s.post('/api/live/mode', { id, modeId: 'no-such-mode' });
  assertEquals([mode.status, mode.json.error], [400, 'That is not one of the listed modes']);
  const config = await s.post('/api/live/config', { id, configId: 'nope', value: 1 });
  assertEquals([config.status, config.json.error], [400, 'Unknown setting']);
  const sessions = await s.post('/api/live/session-op', { id, op: 'list' });
  assertEquals(sessions.json, {
    ok: true,
    sessions: [{ sessionId: 'fake-session', cwd: 'C:\\work', title: 'First <b>', updatedAt: '2026-01-01T00:00:00Z' }],
    nextCursor: 'page2',
  });
  const queued = await s.post('/api/live/queue', { id, text: 'queued', clientMessageId: 'q-1' });
  assertEquals([queued.status, queued.json.accepted, queued.json.queued, queued.json.queue.items], [200, true, false, []]); // idle: sent at once
  assertEquals((await s.get('/api/live/list')).json.connections[0].attention.state, 'idle');

  // Disconnect: the chat is listed as closed, then a prompt is refused.
  assertEquals((await s.post('/api/live/disconnect', { id })).json, { ok: true });
  await s.until('closed', async () => (await state()).closed);
  const after = await s.post('/api/live/prompt', { id, text: 'after', clientMessageId: 'turn-9' });
  assertEquals([after.status, after.json.error], [400, 'This connection is not ready']);
  assertEquals((await s.bootstrap()).json.connections, [], 'no open connections left');
});
