/**
 * Per-project tool servers, one real CLI per agent (toolservers/*; aib-shared/designs/tool-servers/probe.md): under AIB's test auth guard
 * (stub model, dummy key, temp home) a server that is switched off does NOT start (no process: its marker file never appears) and a
 * tool that is switched off is NOT offered to the model, while the other server and the other tool of the same server stay. Each run
 * first proves the user's config is found by AIB's discovery in that agent's own format, and a run with nothing switched off proves
 * both fake servers do start and both tools are offered (so "absent" means something).
 *
 * The programs: Claude (`claude` on PATH or AIB_CLAUDE_CLI), Codex (AIB's managed install or AIB_CODEX_EXE), Qwen (AIB's managed install
 * or AIB_QWEN_CLI), Gemini (AIB_GEMINI_CLI = bundle/gemini.js of @google/gemini-cli), Copilot (AIB_COPILOT_EXE). One that is not on this
 * machine skips its test. Antigravity and Maki: nothing to apply (see toolservers/apply.ts and the card), so no CLI run.
 */
import { assert, assertEquals } from './_assert.ts';
import { PROGRAMS, type Provider, run } from './_toolservers_cli.ts';

const T = { sanitizeResources: false, sanitizeOps: false };

const SERVER_OFF = (store: { update(key: string, patch: { server: string; on?: boolean }): unknown }, key: string) =>
  store.update(key, { server: 'rea', on: false });
const TOOL_OFF = (store: { update(key: string, patch: { server: string; tool?: string; toolOn?: boolean }): unknown }, key: string) =>
  store.update(key, { server: 'aibx', tool: 'aibx_one', toolOn: false });

function provide(provider: Provider, label: string) {
  const present = !!PROGRAMS[provider] && !!PROGRAMS.node;
  Deno.test({
    name: `${label}: a server that is off does not start; a tool that is off is not offered`,
    ignore: !present,
    ...T,
    async fn() {
      const all = await run(provider, null);
      assertEquals(all.found.map((s) => s.id), ['aibx', 'rea'], "discovery finds both servers in the agent's own config");
      assert(all.found.every((s) => s.kind === 'local'), 'stdio servers are local');
      assertEquals(all.started, ['aibx', 'rea'], 'with nothing off both servers start');
      assertEquals(all.offered, ['aibx_one', 'aibx_two', 'rea_one', 'rea_two'], 'with nothing off every tool is offered');

      const off = await run(provider, SERVER_OFF);
      assertEquals(off.started, ['aibx'], 'rea is off: no rea process');
      assertEquals(off.offered, ['aibx_one', 'aibx_two'], 'rea is off: none of its tools is offered; aibx is untouched');

      const tool = await run(provider, TOOL_OFF);
      assertEquals(tool.started, ['aibx', 'rea'], 'a tool off does not stop its server');
      assertEquals(tool.offered, ['aibx_two', 'rea_one', 'rea_two'], 'aibx_one is not offered; its sibling and the other server are');
    },
  });
}

provide('claude', 'Claude Code (deniedMcpServers + permissions.deny)');
provide('codex', 'Codex (mcp_servers.<id>.enabled / disabled_tools)');
provide('gemini', 'Gemini CLI (--allowed-mcp-server-names + admin policy)');
provide('qwen', 'Qwen Code (system settings mcp.excluded + excludeTools)');
provide('copilot', 'Copilot CLI (--disable-mcp-server + --excluded-tools)');
