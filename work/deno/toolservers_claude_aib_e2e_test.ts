/**
 * Per-project tool servers through the whole of AIB for Claude Code: a real AIB (deno-split web server and agent host), the REAL
 * claude-agent-acp adapter and the real Claude Code CLI, the stub model API, a throwaway home that the test names (AGENT_STUDIO_TEST_HOME,
 * so AIB's discovery and the agent read the same folder, never the owner's), and two fake stdio MCP servers (work/fake_mcp_server.js).
 * Everything goes through the page's own HTTP API (POST /api/live/tool-servers, connect, prompt), as the Settings section does:
 *
 *   - the project's choice (rea off, one tool of aibx off) rides on the session settings AIB sends the adapter: the new chat starts
 *     NO rea process, aibx starts, and the model is offered aibx_two only
 *   - turn rea on in Settings: the NEXT new chat in the project starts rea at once (applies to new chats)
 *   - a project that is new starts with servers that run on this PC off (the owner's default), with no call from the page
 *
 * Skipped when the adapter or the claude program is not installed. Antigravity and Maki have nothing to apply (see the card).
 */
import { assert, assertEquals, Chat, Json, waitFor } from './_e2e.ts';
import {
  agentTempRoot,
  CLAUDE_ACP,
  CLAUDE_CLI,
  join,
  makeProject,
  NODE_EXE,
  RealClaudeFixture,
  SERVER_SPLIT,
  Stub,
  T,
  Temp,
  uuid,
} from './_e2e_real.ts';
import { WORK } from './_work.ts';

const ok = !!(NODE_EXE && CLAUDE_ACP && CLAUDE_CLI && SERVER_SPLIT);
const WIN = Deno.build.os === 'windows';
const FAKE_MCP = (() => {
  const path = decodeURIComponent(new URL('fake_mcp_server.js', WORK).pathname);
  return WIN ? path.replace(/^\/([A-Za-z]:)/, '$1').replaceAll('/', '\\') : path;
})();

Deno.test({
  name:
    'tool servers, Claude Code through AIB: a switched-off server starts no process and a switched-off tool is not offered; new chats get a change at once',
  ignore: !ok,
  ...T,
  async fn() {
    using temp = new Temp('aib-tsc-');
    const home = temp.join('home');
    const marks = temp.join('marks');
    temp.mkdir('home');
    temp.mkdir('marks');
    const stdio = (n: string) => ({ type: 'stdio', command: NODE_EXE, args: [FAKE_MCP, n], env: { MARK_DIR: marks } });
    // the user's Claude config, in the folder both AIB (discovery) and the agent (CLAUDE_CONFIG_DIR) are given under test
    Deno.writeTextFileSync(
      join(home, '.claude.json'),
      JSON.stringify({ hasCompletedOnboarding: true, mcpServers: { rea: stdio('rea'), aibx: stdio('aibx') } }),
    );
    await using stub = await Stub.start(temp.path, []);
    const project = makeProject(temp.path, `ts-${uuid().slice(0, 6)}`);
    const started = () => [...new Set([...Deno.readDirSync(marks)].map((e) => e.name.split('.')[0]))].sort();
    const clear = () => {
      for (const e of [...Deno.readDirSync(marks)]) Deno.removeSync(join(marks, e.name));
    };
    await using fx = new RealClaudeFixture(stub, agentTempRoot(), { extraEnv: { AGENT_STUDIO_TEST_HOME: home } });
    const web = await fx.startWeb();
    const view = async (body: Json) => {
      const [status, answer] = await web.post('tool-servers', { path: project, ...body });
      assertEquals(status, 200, JSON.stringify(answer));
      return answer as { servers: { id: string; on: boolean; kind: string; tools: { name: string; on: boolean }[] }[] };
    };
    const open = async () => {
      const [status, connection] = await web.post('connect', { provider: 'claude', cwd: project, background: true });
      assertEquals(status, 200, JSON.stringify(connection));
      const chat = new Chat(null, connection.id as string, web);
      await waitFor(
        async () => {
          const s = await chat.state();
          if (s.error) throw new Error(String(s.error));
          return s.ready;
        },
        'chat ready',
        120,
      );
      return chat;
    };
    const offered = () => [...new Set(stub.dumped().match(/mcp__(?:rea|aibx)__(?:rea|aibx)_(?:one|two)/g) ?? [])].sort();

    // what AIB found in the user's config, and the new project's default: the servers that run on this PC are off
    const first = await view({ op: 'view' });
    assertEquals(first.servers.map((s) => [s.id, s.on, s.kind]), [['studio_artifact', true, 'local'], ['aibx', true, 'local'], [
      'rea',
      true,
      'local',
    ]], 'no choice yet: a project that was never set loads everything');

    // the project's choice: rea off, aibx_one off
    await view({ op: 'set', server: 'rea', on: false });
    await view({ op: 'set', server: 'aibx', tool: 'aibx_one', toolOn: false });
    const chat = await open();
    const reply = await chat.send('the codeword is TEAL-42');
    assert(reply.includes('STUB codeword=TEAL-42'), reply);
    await new Promise((r) => setTimeout(r, 1500));
    assertEquals(started(), ['aibx'], 'rea is off: no rea process; aibx started');
    assertEquals(offered(), ['mcp__aibx__aibx_two'], 'the model is offered aibx_two only: rea and aibx_one are off');

    // Settings: rea on. The next new chat starts it at once.
    await view({ op: 'set', server: 'rea', on: true });
    clear();
    const second = await open();
    const reply2 = await second.send('the codeword is TEAL-43');
    assert(reply2.includes('STUB codeword=TEAL-43'), reply2);
    await new Promise((r) => setTimeout(r, 1500));
    assertEquals(started(), ['aibx', 'rea'], 'rea is on: a new chat starts it');
    assert(offered().includes('mcp__rea__rea_one') && offered().includes('mcp__rea__rea_two'), `rea's tools are offered now: ${offered()}`);
  },
});
