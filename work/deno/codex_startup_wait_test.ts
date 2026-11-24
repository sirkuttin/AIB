/**
 * 0.15 slice 2: Codex waits for AIB's tool server before its first turn. codex-acp 2.6 reads `_meta.mcpStartupAwaitTimeoutMs` from
 * session/new, session/load and session/resume (an omitted field means do not wait), so AIB sends it for the Codex family.
 * Never `required: true` (architect review, must-fix 5): AIB closed must not fail a working chat. Fake agent (work/fake_acp.py),
 * headless; what reaches the agent is read from FAKE_ACP_LOG.
 */
import { assert, assertEquals } from './_assert.ts';
import { fake, type Json, pause } from './_connection.ts';
import { CODEX_MCP_STARTUP_WAIT_MS, Connection } from '../../app/server/acp/connection.ts';

const T = { sanitizeResources: false, sanitizeOps: false };

async function sessionCalls(provider: string, resume: string | null): Promise<Json[]> {
  const dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-codexwait-' }));
  const log = dir + (Deno.build.os === 'windows' ? '\\' : '/') + 'agent.log';
  const c = new Connection(fake('--replay-history'), dir, provider, { env: { FAKE_ACP_LOG: log } });
  try {
    await c.setup(resume);
    await pause(100);
    return Deno.readTextFileSync(log).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as Json)
      .filter((m) => m.method === 'session/new' || m.method === 'session/load' || m.method === 'session/resume');
  } finally {
    await c.close();
    try {
      Deno.removeSync(dir, { recursive: true });
    } catch { /* a child still holds a file */ }
  }
}

Deno.test({
  name: 'codex: session/new carries _meta.mcpStartupAwaitTimeoutMs, and never a required server',
  ...T,
  async fn() {
    const calls = await sessionCalls('codex', null);
    assertEquals(calls.map((m) => m.method), ['session/new']);
    const params = calls[0].params as Json;
    assertEquals((params._meta as Json).mcpStartupAwaitTimeoutMs, CODEX_MCP_STARTUP_WAIT_MS);
    assertEquals(CODEX_MCP_STARTUP_WAIT_MS, 10_000, 'architect review S5: 10 s');
    assert(!JSON.stringify(params).includes('"required"'), 'no required:true (must-fix 5)');
  },
});

Deno.test({
  name: 'codex: session/load (a reopened chat) carries the same startup wait',
  ...T,
  async fn() {
    const calls = await sessionCalls('codex', 'saved-session');
    assertEquals(calls.map((m) => m.method), ['session/load']);
    assertEquals(((calls[0].params as Json)._meta as Json).mcpStartupAwaitTimeoutMs, CODEX_MCP_STARTUP_WAIT_MS);
  },
});

Deno.test({
  name: 'codex@server (a Codex on a model server) is in the Codex family: it gets the wait; other agents do not',
  ...T,
  async fn() {
    const server = await sessionCalls('codex@strata', null);
    assertEquals(((server[0].params as Json)._meta as Json)?.mcpStartupAwaitTimeoutMs, CODEX_MCP_STARTUP_WAIT_MS);
    for (const provider of ['gemini', 'qwen']) {
      const other = await sessionCalls(provider, null);
      assertEquals((other[0].params as Json)._meta, undefined, `${provider}: no codex-acp key`);
    }
  },
});
