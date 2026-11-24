/**
 * 0.15 slice 4: a Codex chat's MCP servers go in CODEX_CONFIG (acp/codex_mcp.ts), not in session/new. The shape: AIB's own entry
 * carries `omit_tools_from: ["deferred", "code_mode"]` and never `required`; the user's own servers (their CODEX_CONFIG, their
 * --mcp-config entries) are kept and converted the way codex-acp converts them; the record (Connection.mcpServers) keeps the entry, so
 * the prompt and the auto-approval still know it. Fake agent (work/fake_acp.py), headless; real Codex: e2e_codex_direct_tools_test.ts.
 */
import { assert, assertEquals } from './_assert.ts';
import { fake, type Json, pause } from './_connection.ts';
import { Connection } from '../../app/server/acp/connection.ts';
import { codexUsable, OWN_OMIT_TOOLS_FROM, withCodexMcp } from '../../app/server/acp/codex_mcp.ts';
import type { McpServer } from '../../app/server/acp/breadth.ts';

const own: McpServer = { name: 'studio_artifact', command: 'keeper', args: ['mcp-forward', 'addr.json'], env: [{ name: 'MCP_FORWARD_HEADERS', value: 'h' }] };
const mine: McpServer = { name: 'mine', command: 'node', args: ['m.js'], env: [] };
const remote: McpServer = { type: 'http', name: 'web', url: 'http://x/mcp', headers: [{ name: 'A', value: 'b' }] };
const sse: McpServer = { type: 'sse', name: 'old', url: 'http://x/sse', headers: [] };
const isOwn = (server: McpServer) => server.name === 'studio_artifact';

Deno.test('codex config: AIB entry has omit_tools_from and never required; user entries are kept and converted', () => {
  const user = JSON.stringify({ model: 'm', mcp_servers: { theirs: { command: 'x' }, mine: { command: 'old' } } });
  const merged = JSON.parse(withCodexMcp(user, [own, mine, remote, sse], isOwn)!) as Json;
  const servers = merged.mcp_servers as Record<string, Json>;
  assertEquals(merged.model, 'm', 'the rest of the user config stays');
  assertEquals(servers.theirs, { command: 'x' }, "the user's own server stays");
  assertEquals(servers.mine, { command: 'node', args: ['m.js'], env: {} }, 'a same-name entry from AIB (--mcp-config) wins');
  assertEquals(servers.web, { url: 'http://x/mcp', http_headers: { A: 'b' } });
  assert(!('old' in servers), 'an sse server is not something Codex can run');
  const entry = servers.studio_artifact;
  assertEquals(entry.omit_tools_from, ['deferred', 'code_mode']);
  assertEquals(entry.omit_tools_from, OWN_OMIT_TOOLS_FROM);
  assertEquals(entry.command, 'keeper');
  assertEquals(entry.env, { MCP_FORWARD_HEADERS: 'h' });
  assert(!JSON.stringify(merged).includes('"required"'), 'never required: AIB closed must not fail a working chat');
  assert(!('omit_tools_from' in servers.mine) && !('omit_tools_from' in servers.web), 'the option is for AIB entry only');
});

Deno.test('codex config: nothing to merge, or a config that is not a JSON object, gives null (the ACP route stays)', () => {
  assertEquals(withCodexMcp('{}', [], isOwn), null);
  assertEquals(withCodexMcp('{}', [sse], isOwn), null);
  assertEquals(withCodexMcp('not json', [own], isOwn), null);
  assertEquals(withCodexMcp('[]', [own], isOwn), null);
  assertEquals(JSON.parse(withCodexMcp(undefined, [own], isOwn)!).mcp_servers.studio_artifact.command, 'keeper');
  assertEquals(codexUsable([own, { ...own, command: 'second' }, mine]).map((s) => s.name), ['studio_artifact', 'mine'], 'first entry of a name');
});

async function session(provider: string, servers: McpServer[]): Promise<{ params: Json; c: Connection }> {
  const dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-codexcfg-' }));
  const log = dir + (Deno.build.os === 'windows' ? '\\' : '/') + 'agent.log';
  const c = new Connection(fake('--replay-history'), dir, provider, { env: { FAKE_ACP_LOG: log }, start: false });
  c.mcpServers = servers;
  c.startProcess();
  try {
    await c.setup(null);
    await pause(100);
    const calls = Deno.readTextFileSync(log).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as Json).filter((m) => m.method === 'session/new');
    return { params: calls[0].params as Json, c };
  } finally {
    await c.close();
    try {
      Deno.removeSync(dir, { recursive: true });
    } catch { /* a child still holds a file */ }
  }
}

Deno.test('codex chat: session/new lists no servers (they are in CODEX_CONFIG); the record keeps the entry; Wait stays', async () => {
  const { params, c } = await session('codex', [mine]);
  assertEquals(params.mcpServers, [], 'a non-empty ACP list would replace CODEX_CONFIG mcp_servers');
  assertEquals((params._meta as Json).mcpStartupAwaitTimeoutMs, 10_000);
  assert(c.mcpInConfig());
  assertEquals(c.mcpServers.map((s) => s.name), ['mine']);
});

Deno.test('codex@server chat is the same; other agents keep the ACP list', async () => {
  assertEquals((await session('codex@strata', [mine])).params.mcpServers, []);
  assertEquals(((await session('gemini', [mine])).params.mcpServers as Json[]).map((s) => s.name), ['mine']);
});
