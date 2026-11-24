/**
 * A chat renamed in AIB gets the same name in the agent's own list (host/agent_titles.ts): the list `claude --resume` and the VS Code
 * extension read shows AIB's name (the port of work/test_agent_title_e2e.py). Real agent adapters, the local stub model API
 * (work/stub_model_api.js), temp config, no key, no network.
 *
 *   AibRenameTest      a real AIB (deno-split web server + agent host) runs a Claude Code chat; Rename (POST /api/live/chat-name) names
 *                      it; AIB's `discover` (the agent's session/list) then lists the chat under that name. The rename costs no model
 *                      call, and a turn after it does not bring the old name back.
 *   AdapterRenameTest  one layer down, Claude Code AND Codex: the adapter's own `_session/rename` (work/acp_probe.js rename) names a
 *                      saved session with no model call, and the adapter's listing shows it. Claude Code: the transcript gets the
 *                      CLI's own `custom-title` record.
 *
 * Guard: no entry for the temp project may appear in the owner's ~/.claude/projects or ~/.codex/sessions.
 * Adapters: AIB_CLAUDE_ACP / AIB_CODEX_ACP (path to the adapter's dist/index.js), else the global npm install.
 */
import { assert, assertEquals, Chat, Json, sleep, waitFor } from './_e2e.ts';
import {
  adapterEnv,
  agentTempRoot,
  CLAUDE_ACP,
  CODEX_ACP,
  claudeEncoded,
  makeProject,
  NODE_EXE,
  OwnerGuard,
  probe,
  RealClaudeFixture,
  SERVER_SPLIT,
  Stub,
  T,
  Temp,
  uuid,
} from './_e2e_real.ts';

const modelCalls = (stub: Stub) => stub.calls().filter((c) => String(c.path).endsWith('/messages') || String(c.path).endsWith('/responses'));

Deno.test({
  name: 'AibRenameTest test_rename_in_aib_names_the_claude_session',
  ignore: !(NODE_EXE && CLAUDE_ACP && SERVER_SPLIT),
  ...T,
  async fn() {
    using temp = new Temp('aib-title-');
    await using stub = await Stub.start(temp.path);
    const project = makeProject(temp.path, `proj-${uuid().slice(0, 6)}`);
    using _guard = new OwnerGuard([project]);
    await using fx = new RealClaudeFixture(stub, agentTempRoot());
    const web = await fx.startWeb();
    const [status, connection] = await web.post('connect', { provider: 'claude', cwd: project, background: true });
    assertEquals(status, 200, JSON.stringify(connection));
    const chat = new Chat(null, connection.id as string, web);
    await waitFor(async () => {
      const s = await chat.state();
      if (s.error) throw new Error(String(s.error));
      return s.ready;
    }, 'chat ready');
    assert((await chat.send('the codeword is TEAL-7')).includes('STUB codeword=TEAL-7'));
    const session = await chat.session();
    assert(session);

    const listedTitle = async () => {
      await sleep(300); // each look asks the agent (session/list): not 20 times a second
      const [code, found] = await web.post('discover', { provider: 'claude', cwd: project });
      assertEquals(code, 200, JSON.stringify(found));
      const mine = (found.sessions as Json[]).filter((s) => s.sessionId === session);
      return mine.length ? mine[0].title : null;
    };

    assert((await listedTitle()) !== 'Ashborne orchestrator part3');
    const calls = modelCalls(stub).length;
    const name = 'Ashborne orchestrator part3';
    const [code, out] = await web.post('chat-name', { key: `claude:${session}`, name, cwd: project });
    assertEquals(code, 200, JSON.stringify(out));
    assertEquals((out.chatNames as Json)[`claude:${session}`], name, 'AIB keeps its own name');
    await waitFor(async () => (await listedTitle()) === name, "the agent's own list shows AIB's name", 60);
    assertEquals(modelCalls(stub).length, calls, 'the rename made no model call');

    // the chat goes on: the running CLI keeps the new name (it reads it back before it re-stamps its metadata)
    assert((await chat.send('what was the codeword?')).includes('STUB codeword=TEAL-7'));
    assertEquals(await listedTitle(), name);

    // a second rename replaces it; a cleared name changes nothing in the agent
    assertEquals((await web.post('chat-name', { key: `claude:${session}`, name: 'Ashborne orchestrator part4' }))[0], 200);
    await waitFor(async () => (await listedTitle()) === 'Ashborne orchestrator part4', 'the second name', 60);
    assertEquals((await web.post('chat-name', { key: `claude:${session}`, name: '' }))[0], 200);
    await sleep(2000);
    assertEquals(await listedTitle(), 'Ashborne orchestrator part4');
  },
});

/** The adapter's own `_session/rename`, one layer below AIB: temp CLAUDE_CONFIG_DIR / CODEX_HOME / HOME. */
async function renameCase(entry: string, extra?: (temp: Temp, project: string, session: string) => void) {
  using temp = new Temp('aib-title-a-');
  await using stub = await Stub.start(temp.path);
  const project = makeProject(temp.path, `proj-${uuid().slice(0, 6)}`);
  using _guard = new OwnerGuard([project]);
  const env = adapterEnv(temp, stub);
  const made = await probe(entry, env, 'new', project, 'the codeword is TEAL-9');
  const session = made.sessionId as string;
  const calls = modelCalls(stub).length;
  const name = 'Ashborne orchestrator part3';
  const out = await probe(entry, env, 'rename', session, name);
  assertEquals(out, { renamed: true, advertised: true });
  assertEquals(modelCalls(stub).length, calls, 'the rename made no model call');
  const listed = await probe(entry, env, 'list', project);
  const mine = (listed.sessions as Json[]).filter((s) => s.sessionId === session);
  assertEquals(mine.length, 1, JSON.stringify(listed));
  assertEquals(mine[0].title, name);
  extra?.(temp, project, session);
}

Deno.test({
  name: 'AdapterRenameTest test_claude',
  ignore: !(NODE_EXE && CLAUDE_ACP),
  ...T,
  fn: () =>
    renameCase(CLAUDE_ACP!, (temp, project, session) => {
      const filed = temp.join('claude', 'projects', claudeEncoded(project), `${session}.jsonl`);
      const rows = Deno.readTextFileSync(filed).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
      const same = (r: Record<string, unknown>) => r.type === 'custom-title' && r.customTitle === 'Ashborne orchestrator part3' && r.sessionId === session && Object.keys(r).length === 3;
      assert(rows.some(same), 'no custom-title record');
    }),
});

Deno.test({
  name: 'AdapterRenameTest test_codex',
  ignore: !(NODE_EXE && CODEX_ACP),
  ...T,
  fn: () => renameCase(CODEX_ACP!),
});
