/**
 * Contract (ported from work/contract/test_contract_transcripts.py): the transcript viewer routes (/api/sessions, /api/agents,
 * /api/commands, /api/transcript) of the real server over the generated subagents fixture. The old version compared every
 * reply with the reference over every session and agent; here the replies are checked against the fixture and against each other
 * (windows are slices of the full list, kind filters and the search select from it). The monitor's own parsing and ordering is
 * covered by monitor_test.ts and monitor_golden_test.ts.
 */
import { assert, assertEquals } from './_assert.ts';
import { ContractServer, generateFixture } from './_contract_server.ts';

type Event = { kind: string; text?: string; id: string };

Deno.test('contract: transcript viewer routes', async () => {
  const fixture = await generateFixture('subagents-fixture');
  try {
    Deno.mkdirSync(`${fixture}/empty-omp`, { recursive: true });
    await using s = await ContractServer.start({ claudeDir: `${fixture}/claude`, ompDir: `${fixture}/empty-omp` });
    const q = encodeURIComponent;

    const listing = (await s.get('/api/sessions')).json;
    assertEquals(listing.sessions.length, 1);
    const [session] = listing.sessions;
    assertEquals([session.id, session.provider, session.prompt, session.subagentCount, session.hasMessages], [
      'sess-fixture',
      'claude',
      'Fan out the W3 work',
      7,
      true,
    ]);
    assert(typeof listing.now === 'number' && listing.root.includes('claude: '));

    const agentsReply = await s.get(`/api/agents?session=${q(session.key)}`);
    assertEquals(agentsReply.status, 200);
    const agents = agentsReply.json.agents as { key: string; main: boolean; agentId?: string; name: string }[];
    assertEquals(agents.length, 8, 'the main chat and its seven subagents');
    assertEquals(agents.filter((a) => a.main).length, 1);
    assert(agents.some((a) => a.agentId === 'a7' && a.name === 'Slot edge cases'));
    const commands = (await s.get(`/api/commands?session=${q(session.key)}`)).json.commands;
    assertEquals([commands[0].callId, commands[0].tool, commands[0].status, commands[0].background], ['bg1', 'Bash', 'running', true]);
    assertEquals((await s.get(`/api/commands?session=${q(session.key)}&running=1`)).json.commands.map((c: { callId: string }) => c.callId), ['bg1']);

    const transcript = async (key: string, query = '') => (await s.get(`/api/transcript?key=${q(key)}${query}`)).json;
    let checked = 0;
    for (const agent of agents) {
      const full = await transcript(agent.key);
      const events: Event[] = full.events;
      assertEquals([full.total, full.before, full.end], [events.length, 0, events.length], agent.key);
      assert(full.revision.length === 2 && full.meta.id === 'sess-fixture', agent.key);
      assertEquals(events.map((e) => e.id).length, new Set(events.map((e) => e.id)).size, 'event ids are unique');
      const limit = Math.min(2, events.length);
      const tail = await transcript(agent.key, '&limit=2');
      assertEquals(tail.events, events.slice(events.length - limit), `${agent.key} limit`);
      assertEquals([tail.before, tail.end, tail.total], [events.length - limit, events.length, events.length]);
      const before = await transcript(agent.key, '&before=3&limit=2');
      const stop = Math.min(3, events.length);
      assertEquals(before.events, events.slice(Math.max(0, stop - 2), stop), `${agent.key} before`);
      const after = await transcript(agent.key, '&after=1&limit=3');
      assertEquals(after.events, events.slice(1, 4), `${agent.key} after`);
      assertEquals(after.before, Math.min(1, events.length));
      const kinds = (await Promise.all(['tools', 'messages', 'errors'].map(async (k) => [k, (await transcript(agent.key, `&kind=${k}`)).events as Event[]] as const)));
      const byKind = Object.fromEntries(kinds);
      assertEquals(byKind.messages.map((e) => e.kind).filter((k) => !['user', 'assistant'].includes(k)), [], 'messages: only people and the assistant');
      for (const e of byKind.tools) assert(['tool', 'result'].includes(e.kind), `tools: ${e.kind}`);
      for (const list of Object.values(byKind)) for (const e of list) assert(events.some((x) => x.id === e.id), 'a filtered event is one of the events');
      assertEquals((await transcript(agent.key, '&thinking=1')).events.length >= events.length, true);
      const hit = events.find((e) => e.text && /\w{4,}/.test(e.text));
      if (hit) {
        const word = hit.text!.match(/\w{4,}/)![0];
        const found = (await transcript(agent.key, `&q=${q(word.toUpperCase())}`)).events as Event[];
        assert(found.some((e) => e.id === hit.id), `${agent.key}: the search is case-insensitive`);
        for (const e of found) assert((e.text ?? '').toLowerCase().includes(word.toLowerCase()), 'every hit holds the word');
      }
      assertEquals((await transcript(agent.key, '&q=NOTHING-MATCHES')).events, []);
      checked++;
    }
    assertEquals(checked, 8);
    // the agent a1 started a background command: its tool call and result are in its transcript
    const a1 = agents.find((a) => a.agentId === 'a1')!;
    assertEquals(((await transcript(a1.key, '&kind=tools')).events as Event[]).map((e) => e.kind), ['tool', 'result']);

    for (const path of ['/api/transcript?key=..%2F..%2Fx', '/api/transcript?key=', '/api/transcript?key=x&limit=abc', '/api/command?session=x&id=nope', '/api/transcript/image?key=x&n=0&i=0', '/api/agents?session=does-not-exist']) {
      const reply = await s.get(path);
      assertEquals([reply.status, reply.json], [400, { error: 'Unknown transcript source' }], path);
    }
  } finally {
    Deno.removeSync(fixture, { recursive: true });
  }
});
