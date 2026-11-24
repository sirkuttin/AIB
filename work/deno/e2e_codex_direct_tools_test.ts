/**
 * 0.15 slice 4: Codex sees AIB's 6 tools directly. A real AIB (deno-split web server + agent host, the chat's agent in the keeper,
 * AIB's real keeper forwarder) runs a real Codex chat through the pinned codex-acp 2.6 (AIB_CODEX_ACP) against the stub model API
 * (script mode); temp CODEX_HOME and config only.
 *
 * What AIB does (acp/codex_mcp.ts): the `studio_artifact` entry goes in the chat's CODEX_CONFIG `mcp_servers` with
 * `omit_tools_from: ["deferred", "code_mode"]` (a per-server Codex setting codex-acp cannot carry in session/new), and session/new
 * lists no servers (a non-empty ACP list would replace CODEX_CONFIG's `mcp_servers`). The user's own servers (here one in their
 * CODEX_CONFIG) are kept. The tests:
 *   - the first model request lists AIB's studio tools (6 in a worktree chat, 5 in a folder chat) as the `mcp__studio_artifact` namespace, the user's own server is there too,
 *     and the old ALL_TOOLS recipe is gone from AIB's prompt text,
 *   - a scripted publish call works end to end (an artifact exists in AIB, the result reaches the model),
 *   - AIB's auto-approval still works (publish asks nothing), and an asking action (doc create) still raises a card.
 *
 * Needs node, codex-acp (AIB_CODEX_ACP or a global npm install) and Go (keeper program; AIB_TEST_KEEPER_BIN names a built one), with
 * no space in the temp folder's path. Targeted: run this file alone.
 */
import { assert, assertEquals, Json } from './_e2e.ts';
import { AibCodex, CODEX_ACP, HAVE_KEEPER_BIN, join, NODE_EXE, SERVER_SPLIT, T, REPO_DIR } from './_e2e_real.ts';

const ok = !!(NODE_EXE && CODEX_ACP && HAVE_KEEPER_BIN && SERVER_SPLIT);
// a chat in the project folder gets 5 of AIB's 6 tools; merge_into_project comes only with an own copy (a worktree chat)
const TOOLS = ['publish', 'artifacts', 'doc', 'drawing', 'helper'];

/** The tools a model request lists, as "<namespace>.<tool>" (Codex's `additional_tools` item and any top-level `tools`). */
function listed(body: Json): string[] {
  const out: string[] = [];
  const items = [...((body.input as Json[] | undefined) ?? []).filter((i) => i?.type === 'additional_tools').flatMap((i) => (i.tools as Json[]) ?? []), ...((body.tools as Json[] | undefined) ?? [])];
  for (const t of items) {
    if (t.type === 'namespace') for (const inner of (t.tools as Json[]) ?? []) out.push(`${t.name}.${inner.name}`);
    else if (t.name) out.push(String(t.name));
  }
  return out;
}

function requests(aib: AibCodex): Json[] {
  const out: Json[] = [];
  for (const file of aib.stub.dumpFiles()) {
    const dumped = JSON.parse(Deno.readTextFileSync(file));
    const body = dumped && typeof dumped === 'object' ? (dumped.body ?? dumped) : null;
    if (body && typeof body === 'object' && 'input' in body) out.push(body as Json);
  }
  return out;
}

Deno.test({
  name: 'AibCodexDirectToolsTest test_studio_tools_are_direct_a_call_works_and_an_asking_action_still_asks',
  ignore: !ok,
  ...T,
  async fn() {
    const rules = [
      { when: 'CX-DIRECT go', reply: { tools: [{ id: 'call_pub1', name: 'mcp__studio_artifact.publish', input: { title: 'CX direct page', content: '<p>direct</p>' } }] } },
      { when: 'call_pub1', reply: { tools: [{ id: 'call_doc1', name: 'mcp__studio_artifact.doc', input: { action: 'create', doc: 'cx-direct-doc', title: 'CX direct doc' } }] } },
      { when: 'call_doc1', reply: { text: 'DIRECT-DONE' } },
    ];
    const userConfig = {
      mcp_servers: { userprobe: { command: NODE_EXE, args: [join(REPO_DIR, 'work', 'stub_mcp_server.js')] } }, // the user's own other MCP server
    };
    await using aib = await AibCodex.start(rules, userConfig, { keeper: true });
    await aib.turn('CX-DIRECT go');
    const reqs = requests(aib);
    assert(reqs.length >= 3, `expected 3+ model requests, saw ${reqs.length}`);
    // 1. the first request lists the tools directly, and the user's own server too
    const names = listed(reqs[0]);
    for (const tool of TOOLS) assert(names.includes(`mcp__studio_artifact.${tool}`), `first request lacks ${tool}: ${names.join(' ')}`);
    assert(names.some((n) => n.startsWith('mcp__userprobe.')), `the user's own MCP server is gone: ${names.join(' ')}`);
    assertEquals(names.filter((n) => n.startsWith('mcp__studio_artifact.')).length, TOOLS.length);
    const all = [...((reqs[0].input as Json[]) ?? []).filter((i) => i?.type === 'additional_tools').flatMap((i) => (i.tools as Json[]) ?? []), ...((reqs[0].tools as Json[]) ?? [])];
    const chars = JSON.stringify(all.find((t) => t.name === 'mcp__studio_artifact') ?? null).length;
    console.log(`studio namespace item: ${chars} chars in the model request`);
    // 2. the publish call went through the real forwarder: the artifact result reaches the model
    const last = JSON.stringify(reqs[reqs.length - 1]);
    assert(last.includes('call_pub1') && last.includes('studio-artifact://'), 'the publish result (a studio-artifact:// link) did not reach the model');
    // 3. publish asked nothing (AIB answers its own tool); doc create (an asking action) raised exactly one card
    assertEquals(aib.cards.length, 1, JSON.stringify(aib.cards));
    assertEquals(aib.cards[0].id, 'call_doc1', JSON.stringify(aib.cards)); // the doc create, not the publish
    assertEquals(aib.cards[0].label, 'studio_artifact · doc · create', JSON.stringify(aib.cards)); // AIB reads tool and action from it
    // 4. the prompt AIB gave the chat has no ALL_TOOLS recipe any more
    assert(!JSON.stringify(reqs[0]).includes('ALL_TOOLS'), 'the ALL_TOOLS recipe is still in the prompt');
  },
});
