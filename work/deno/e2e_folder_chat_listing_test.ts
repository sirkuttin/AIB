/**
 * e2e 0 of the "chats work in the project folder" plan (build-plan-1b section 8): a chat started in project P is listed for P by the
 * agent's OWN listing (the port of work/test_folder_chat_listing_e2e.py). Real agent adapters, the local stub model API
 * (work/stub_model_api.js), temp config, no key, no network.
 *
 * Two layers:
 *   AibFolderChatListingTest  a real AIB (deno-split web server + agent host) starts a Claude Code chat in a temp git project with
 *                             no `ownCopy`, with worktreePerChat off and on. AIB's own `discover` route asks the agent
 *                             (session/list cwd=P), and the chat must be there with cwd P. Under test AIB gives a real agent a
 *                             throwaway HOME / CLAUDE_CONFIG_DIR / CODEX_HOME (acp/connection.ts testHomeEnv).
 *   AdapterFolderListingTest  the same goal one layer down, for Claude Code AND Codex: the adapter alone (work/acp_probe.js) makes a
 *                             session in P and its session/list for P has it, for another folder does not.
 *
 * Guard: before and after, no entry for the temp project may appear in the owner's ~/.claude/projects or ~/.codex/sessions.
 * Skipped when an adapter is not installed (AIB_CLAUDE_ACP / AIB_CODEX_ACP, else the global npm install). `node` must be on PATH.
 */
import { assert, assertEquals, Chat, isFile, Json, makeRepo, normcase, waitFor } from './_e2e.ts';
import {
  adapterEnv,
  agentTempRoot,
  CLAUDE_ACP,
  CODEX_ACP,
  claudeEncoded,
  join,
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

const aibOk = !!(NODE_EXE && CLAUDE_ACP && SERVER_SPLIT);

async function listedForProject(worktreesOn: boolean) {
  using temp = new Temp('aib-e0-');
  await using stub = await Stub.start(temp.path);
  const project = makeProject(temp.path, `proj-${uuid().slice(0, 6)}`);
  const other = makeRepo(temp.join('other'));
  using _guard = new OwnerGuard([project, other]);
  await using fx = new RealClaudeFixture(stub, agentTempRoot());
  const web = await fx.startWeb();
  // The old hidden flag no longer decides (1b): either way a new chat with no `ownCopy` works in the project folder.
  const [settings] = await web.post('settings', { server: { worktreePerChat: worktreesOn } });
  assertEquals(settings, 200);
  const [status, connection] = await web.post('connect', { provider: 'claude', cwd: project, background: true });
  assertEquals(status, 200, JSON.stringify(connection));
  const chat = new Chat(null, connection.id as string, web);
  await waitFor(async () => {
    const s = await chat.state();
    if (s.error) throw new Error(String(s.error));
    return s.ready;
  }, 'chat ready');
  assertEquals(normcase(await chat.cwd()), normcase(project), 'no ownCopy: the chat runs in the folder');
  assert(!('worktree' in (await chat.state())), 'no copy: live.worktree is absent');
  const reply = await chat.send('the codeword is TEAL-42');
  assert(reply.includes('STUB codeword=TEAL-42'), reply);
  const session = await chat.session();
  assert(session);
  assert(stub.calls().some((c) => String(c.path).endsWith('/messages')), 'the agent talked to the stub');

  const [s1, found] = await web.post('discover', { provider: 'claude', cwd: project });
  assertEquals(s1, 200, JSON.stringify(found));
  const mine = (found.sessions as Json[]).filter((s) => s.sessionId === session);
  assertEquals(mine.length, 1, JSON.stringify(found));
  assertEquals(normcase(mine[0].cwd as string), normcase(project));
  const [s2, elsewhere] = await web.post('discover', { provider: 'claude', cwd: other });
  assertEquals(s2, 200, JSON.stringify(elsewhere));
  assert(!(elsewhere.sessions as Json[]).map((s) => s.sessionId).includes(session));
}

Deno.test({
  name: 'AibFolderChatListingTest test_chat_started_in_project_is_listed_for_project_by_claude',
  ignore: !aibOk,
  ...T,
  fn: () => listedForProject(false),
});

Deno.test({
  name: 'AibFolderChatListingTest test_new_chat_without_own_copy_is_listed_for_project_with_worktrees_on',
  ignore: !aibOk,
  ...T,
  // build plan 1b: no `ownCopy` and nothing else working in the project -> the chat runs in P even with worktreePerChat on
  fn: () => listedForProject(true),
});

/** The agent's own listing for P, one layer below AIB: the adapter alone, temp CLAUDE_CONFIG_DIR / CODEX_HOME / HOME. */
async function adapterCheck(entry: string, temp: Temp, env: Record<string, string>, project: string, other: string): Promise<string> {
  const made = await probe(entry, env, 'new', project, 'the codeword is TEAL-42');
  assert(String(made.reply).includes('STUB codeword=TEAL-42'), JSON.stringify(made));
  const listed = await probe(entry, env, 'list', project);
  const mine = (listed.sessions as Json[]).filter((s) => s.sessionId === made.sessionId);
  assertEquals(mine.length, 1, JSON.stringify(listed));
  assertEquals(normcase(mine[0].cwd as string), normcase(project));
  const elsewhere = await probe(entry, env, 'list', other);
  assert(!(elsewhere.sessions as Json[]).map((s) => s.sessionId).includes(made.sessionId));
  void temp;
  return made.sessionId as string;
}

async function adapterCase(body: (temp: Temp, env: Record<string, string>, project: string, other: string) => Promise<void>) {
  using temp = new Temp('aib-e0a-');
  await using stub = await Stub.start(temp.path);
  const project = makeRepo(temp.join(`proj-${uuid().slice(0, 6)}`));
  const other = makeRepo(temp.join('other'));
  using _guard = new OwnerGuard([project, other]);
  await body(temp, adapterEnv(temp, stub), project, other);
}

Deno.test({
  name: 'AdapterFolderListingTest test_claude',
  ignore: !(NODE_EXE && CLAUDE_ACP),
  ...T,
  fn: () =>
    adapterCase(async (temp, env, project, other) => {
      const session = await adapterCheck(CLAUDE_ACP!, temp, env, project, other);
      const filed = temp.join('claude', 'projects', claudeEncoded(project), `${session}.jsonl`);
      assert(isFile(filed), `expected ${filed}`);
    }),
});

Deno.test({
  name: 'AdapterFolderListingTest test_codex',
  ignore: !(NODE_EXE && CODEX_ACP),
  ...T,
  fn: () =>
    adapterCase(async (temp, env, project, other) => {
      await adapterCheck(CODEX_ACP!, temp, env, project, other);
      const sessions = temp.join('codex', 'sessions');
      let found = false;
      const walk = (dir: string) => {
        for (const e of Deno.readDirSync(dir)) {
          if (e.isDirectory) walk(join(dir, e.name));
          else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) found = true;
        }
      };
      walk(sessions);
      assert(found, 'no rollout file');
    }),
});
