/**
 * AIB's MCP tools reach Codex (the port of work/test_codex_mcp_tools_e2e.py). The real codex-acp (AIB_CODEX_ACP) gets a stdio
 * `studio_artifact` MCP server in session/new (what AIB sends, acp/connection.ts), a throwaway CODEX_HOME and the stub model API
 * (work/stub_model_api.js, script mode).
 *
 * What a capture of a Codex chat showed: the model request has no studio_artifact tools in its tool list. That is not a failure to
 * pass the server: Codex (code mode) offers one `exec` tool and keeps MCP tools as deferred nested tools of it, listed only in the
 * script global ALL_TOOLS and called as `await tools.mcp__studio_artifact__<tool>(...)`. So the model must be told how to find them
 * (acp/connection.ts TOOLS_LOADING). The test asserts:
 *   - the server starts and its tools are in ALL_TOOLS (the stub model runs `exec` with a script that lists them and the result,
 *     sent back to the model in the next request, names all three),
 *   - the model request itself does not list them (so a change in Codex that lists them is noticed here), and
 *   - the text AIB gives the chat says where to look (the ALL_TOOLS recipe).
 *
 * Targeted: run this file alone. Skipped without node or codex-acp. Project and CODEX_HOME are in the agent temp folder (outside home).
 */
import { assert, assertEquals, Json, stubModelApi, WORK_DIR } from './_e2e.ts';
import { CODEX_ACP, join, NODE_EXE, REPO_DIR, Temp, T } from './_e2e_real.ts';

const LIST_SCRIPT = 'text(JSON.stringify(ALL_TOOLS.map((t) => t.name).filter((n) => n.startsWith("mcp__studio_artifact__")).sort()))';

/** The text of every custom_tool_call_output (an `exec` result) in a model request. */
function outputsOf(request: Json): string[] {
  const out: string[] = [];
  for (const item of (request.input as unknown[] | undefined) ?? []) {
    if (item && typeof item === 'object' && (item as Json).type === 'custom_tool_call_output') out.push(JSON.stringify((item as Json).output));
  }
  return out;
}

async function runChat(temp: Temp): Promise<Json[]> {
  assert(!temp.path.toLowerCase().startsWith((Deno.env.get('USERPROFILE') ?? '\u0000').toLowerCase() + '\\'), temp.path);
  const project = temp.join('proj');
  const home = temp.join('codex-home');
  const dump = temp.join('dump');
  for (const folder of [project, home, dump, temp.join('tmp')]) Deno.mkdirSync(folder);
  const script = temp.join('script.json');
  Deno.writeTextFileSync(
    script,
    JSON.stringify({ rules: [{ when: 'hello', in: 'last', reply: { tools: [{ id: 'call_list', name: 'functions.exec', custom: true, input: LIST_SCRIPT }] } }] }),
  );
  const stub = new Deno.Command(NODE_EXE!, {
    args: [stubModelApi, '--port', '0', '--stdin', '--dump', dump, '--script', script],
    stdin: 'piped',
    stdout: 'piped',
    stderr: 'null',
  }).spawn();
  const stubIn = stub.stdin.getWriter();
  const dec = new TextDecoder();
  let agent: Deno.ChildProcess | null = null;
  try {
    const stubReader = stub.stdout.getReader();
    let first = '';
    while (!/\n/.test(first)) {
      const { value, done } = await stubReader.read();
      if (done) break;
      first += dec.decode(value);
    }
    stubReader.releaseLock();
    const port = Number(first.trim().split('=')[1]);
    const config = {
      model_provider: 'stub',
      model_providers: { stub: { name: 'stub', base_url: `http://127.0.0.1:${port}/v1`, wire_api: 'responses', requires_openai_auth: false, supports_websockets: false } },
      analytics: { enabled: false },
      check_for_update_on_startup: false,
    };
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(Deno.env.toObject())) if (!/^(OPENAI_|ANTHROPIC_|CODEX_)/.test(k.toUpperCase())) env[k] = v;
    Object.assign(env, { CODEX_HOME: home, CODEX_CONFIG: JSON.stringify(config), TEMP: temp.join('tmp'), TMP: temp.join('tmp') });
    agent = new Deno.Command(NODE_EXE!, { args: [CODEX_ACP!], env, clearEnv: true, cwd: project, stdin: 'piped', stdout: 'piped', stderr: 'null' }).spawn();
    const agentIn = agent.stdin.getWriter();
    const answers = new Map<number, Json>();
    let nextId = 0;
    const send = (message: Json) => agentIn.write(new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n'));
    (async () => {
      let buffer = '';
      for await (const chunk of agent!.stdout) {
        buffer += dec.decode(chunk);
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          let message: Json;
          try {
            message = JSON.parse(line);
          } catch {
            continue;
          }
          if ('id' in message && !('method' in message)) answers.set(message.id as number, message);
          else if ('id' in message) await send({ id: message.id as number, result: { outcome: { outcome: 'cancelled' } } }); // a permission request: refuse
        }
      }
    })().catch(() => {});
    const request = async (method: string, params: Json, seconds = 90): Promise<Json> => {
      const number = ++nextId;
      await send({ id: number, method, params });
      const deadline = Date.now() + seconds * 1000;
      while (!answers.has(number)) {
        if (Date.now() > deadline) throw new Error(`no answer to ${method}`);
        await new Promise((r) => setTimeout(r, 50));
      }
      return answers.get(number)!;
    };
    await request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    const entry = { name: 'studio_artifact', command: NODE_EXE, args: [join(WORK_DIR, 'stub_mcp_server.js')], env: [] };
    const session = await request('session/new', { cwd: project, mcpServers: [entry] });
    assert('result' in session, JSON.stringify(session));
    const done = await request('session/prompt', { sessionId: (session.result as Json).sessionId, prompt: [{ type: 'text', text: 'hello' }] });
    assert('result' in done, JSON.stringify(done));
    const requests: Json[] = [];
    const files = [...Deno.readDirSync(dump)].filter((e) => e.name.endsWith('.json')).map((e) => e.name).sort((a, b) => parseInt(a) - parseInt(b));
    for (const name of files) {
      const dumped = JSON.parse(Deno.readTextFileSync(join(dump, name)));
      const body = dumped && typeof dumped === 'object' ? (dumped.body ?? dumped) : null;
      if (body && typeof body === 'object' && 'input' in body) requests.push(body);
    }
    return requests;
  } finally {
    try {
      agent?.kill('SIGKILL'); // only the process this test started
    } catch { /* gone */ }
    await agent?.status.catch(() => {});
    try {
      await stubIn.close();
    } catch { /* closed */ }
    await Promise.race([stub.status, new Promise((r) => setTimeout(r, 10000))]);
  }
}

Deno.test({
  name: 'CodexMcpToolsTest test_studio_artifact_tools_are_deferred_nested_tools_of_exec',
  ignore: !(NODE_EXE && CODEX_ACP),
  ...T,
  async fn() {
    using temp = new Temp('aib-cxmcp-');
    const requests = await runChat(temp);
    assert(requests.length > 0, 'the stub saw no model request');
    const first = JSON.stringify(requests[0]);
    assert(!first.includes('mcp__studio_artifact__'), 'Codex now lists MCP tools up front: update TOOLS_LOADING in acp/connection.ts');
    const listed = requests.flatMap((r) => outputsOf(r)).filter((t) => t.includes('mcp__studio_artifact__'));
    assert(listed.length > 0, 'ALL_TOOLS does not list the studio_artifact tools: Codex did not start or accept the MCP server');
    const names = new Set(listed[0].match(/mcp__studio_artifact__\w+/g) ?? []);
    assertEquals([...names].sort(), ['mcp__studio_artifact__doc_create', 'mcp__studio_artifact__doc_read', 'mcp__studio_artifact__publish']);
  },
});

/**
 * What AIB tells the chat (same text for every agent) no longer has the Codex ALL_TOOLS recipe: AIB hands Codex its studio_artifact
 * entry in CODEX_CONFIG with omit_tools_from (acp/codex_mcp.ts), so the tools are listed directly (e2e_codex_direct_tools_test.ts).
 * The ACP-listed entry above is what a plain codex-acp does and stays a guard for that shape.
 */
Deno.test('PromptNamesTheRecipeTest test_artifact_prompt_has_no_all_tools_recipe', () => {
  const text = Deno.readTextFileSync(join(REPO_DIR, 'app', 'server', 'acp', 'connection.ts')).replace(/\r\n/g, '\n');
  const match = /export const TOOLS_LOADING = ([\s\S]*?);\n/.exec(text);
  assert(match);
  assert(!match[1].includes('ALL_TOOLS'));
  assert(!match[1].includes('await tools.mcp__studio_artifact__'));
});

