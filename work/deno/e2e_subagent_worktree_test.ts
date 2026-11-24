/**
 * Subagent worktrees, P1 (enforcement, Claude Code) (the port of work/test_subagent_worktree_e2e.py): e2e with the REAL Claude Code
 * adapter against the stub model API (work/stub_model_api.js script mode), temp config only. Design: aib-shared/designs/
 * subagent-worktrees/design.md v2 + p0b-results.md.
 *
 *   AibSubagentHooksTest   a real AIB (deno-split web server + agent host) starts a Claude chat in a temp git project whose folder has
 *                          an uncommitted edit. The model (scripted) starts an editing subagent, an Explore subagent, then tries
 *                          EnterWorktree and Workflow.
 *                            B2   the editing subagent ran in AIB's worktree (studio/sub-*, under AIB's state folder, git-locked),
 *                                 which has the folder's uncommitted edit; the folder is unchanged (no sub-a.txt, its edit still
 *                                 uncommitted); the record (subagent-worktrees.json) has its agentId and state running
 *                            B3   Explore got no worktree
 *                            B16  EnterWorktree and Workflow were denied with AIB's texts
 *                            B14  forged hook calls with the chat's key: worktree-create refused, nothing bound, the cap holds, a
 *                                 wrong key is refused, a UNC adoption hint is never touched; no key in anything the model was sent
 *                            B15  the hook routes are not on the web (page / phone) server
 *                            the system prompt line is there; the owner's ~/.claude, settings and real %TEMP%\claude untouched
 *   AdapterFailClosedTest  one layer down: the adapter alone (work/acp_probe.js) with AIB's hook settings shape and the real keeper
 *                          program as forwarder, AIB unreachable.
 *                            B13  dead address: the editing Agent call is refused with "AIB is restarting"; nothing written; Explore runs
 *                            B13b AIB accepts the connection but never answers: refused within the forwarder's deadline, never unisolated
 *                            B13c another program on the port answers 200 {} or HTML, unsigned: refused (security review P1, MF 1)
 *                            MF 7 no Git Bash: P2's hooks-off deny rules instead of hooks; the editing subagent never runs, Explore does
 * B12 (settings byte-identical on reopen) and the route rules are pinned by work/deno/subagent_hooks_test.ts.
 *
 * Needs node, the Claude Code ACP adapter (AIB_CLAUDE_ACP or a global npm install) and Go (to build the keeper program from keeper/,
 * into this test's temp folder; AIB_TEST_KEEPER_BIN names a built one instead). Run with TEMP/TMP pointed at a scratch folder.
 */
import { refusedPort } from './_ports.ts';
import { acpProbe, assert, assertEquals, Chat, git, isDir, Json, normcase, realPath, waitFor } from './_e2e.ts';
import {
  agentTempRoot,
  approveAll,
  CLAUDE_ACP,
  dumped,
  hmacHex,
  HAVE_KEEPER_BIN,
  join,
  keeperProgram,
  makeProject,
  NODE_EXE,
  OwnerUntouched,
  RealClaudeFixture,
  SERVER_SPLIT,
  Stub,
  stubClaudeEnv,
  stubText,
  T,
  Temp,
  uuid,
} from './_e2e_real.ts';

const RESTARTING = 'AIB is restarting; try the subagent again in a moment.';
const UNCONFIRMED = "AIB could not confirm this hook's answer, so the subagent was blocked; try again in a moment.";
const ENTER_TEXT = 'In AIB, chats work in the project folder. Use a subagent instead; AIB gives it its own worktree.';
const WORKFLOW_TEXT = "Workflows aren't available in AIB chats yet, because their agents can't get their own worktree.";
const PROMPT_LINE = 'Subagents that edit files work in their own git worktree.';
const WF_SCRIPT = "export const meta = { name: 'sr', description: 'sr probe', phases: [{ title: 'one' }] }\n" +
  "phase('one')\nconst r = await agent('WF-AGENT do the work', { label: 'wf1' })\nreturn r\n";
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const exists = (p: string) => {
  try {
    Deno.statSync(p);
    return true;
  } catch {
    return false;
  }
};
const WIN = Deno.build.os === 'windows';
const ok = !!(NODE_EXE && CLAUDE_ACP && HAVE_KEEPER_BIN);
const norm = (p: string) => normcase(realPath(p));

/** The chat's hook key as AIB derives it (artifacts/keys.ts issueHookKey): HMAC-SHA256(secret, label NUL + id). */
async function hookKey(state: string, conversation: string): Promise<string> {
  const secret = Deno.readFileSync(join(state, 'artifact-key-secret'));
  const label = new TextEncoder().encode('studio-hook-key/v1\0');
  const id = new TextEncoder().encode(conversation);
  const message = new Uint8Array(label.length + id.length);
  message.set(label);
  message.set(id, label.length);
  return await hmacHex(secret, message);
}

/** POST one hook call to AIB's loopback listener (the address in artifact-mcp.json), as the keeper's forwarder does. */
async function hookPost(state: string, event: string, conversation: string, key: string, body: Json): Promise<[number, string]> {
  const doc = JSON.parse(Deno.readTextFileSync(join(state, 'artifact-mcp.json')));
  const url = String(doc.url).replace(/\/[^/]*$/, '');
  const response = await fetch(`${url}/hooks/claude/${event}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Studio-Hook-Key': key, 'X-Studio-Conversation-Id': conversation },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  return [response.status, await response.text()];
}

function parentRules(main: string) {
  return [
    { when: 'SR-PARENT', reply: { tools: [{ id: 'toolu_pAgent01', name: 'Agent', input: { description: 'sr edit', prompt: 'SUBTASK-A: do the work', subagent_type: 'general-purpose', run_in_background: false } }] } },
    {
      when: 'SUBTASK-A',
      reply: {
        tools: [{
          id: 'toolu_sBash01',
          name: 'Bash',
          input: {
            // P2: .husky makes the landing refuse (protected path), so the worktree and record stay for these P1 checks
            command: 'echo from-sub > sub-a.txt && mkdir -p .husky && echo x > .husky/pre-commit && pwd && cat dirty.txt',
            description: 'write in cwd',
          },
        }],
      },
    },
    { when: 'toolu_sBash01', reply: { tools: [{ id: 'toolu_sWrite02', name: 'Write', input: { file_path: join(main, 'escape-write.txt'), content: 'escaped\n' } }] } },
    { when: 'toolu_sWrite02', reply: { text: 'SUB-DONE' } },
    { when: 'toolu_pAgent01', reply: { tools: [{ id: 'toolu_pAgent02', name: 'Agent', input: { description: 'sr look', prompt: 'SUBTASK-E: look around', subagent_type: 'Explore', run_in_background: false } }] } },
    { when: 'SUBTASK-E', reply: { text: 'EXPLORE-DONE' } },
    { when: 'toolu_pAgent02', reply: { tools: [{ id: 'toolu_pTS03', name: 'ToolSearch', input: { query: 'select:EnterWorktree', max_results: 5 } }] } },
    { when: 'toolu_pTS03', reply: { tools: [{ id: 'toolu_pEW04', name: 'EnterWorktree', input: {} }] } },
    { when: 'toolu_pEW04', reply: { tools: [{ id: 'toolu_pWF05', name: 'Workflow', input: { script: WF_SCRIPT } }] } },
    { when: 'toolu_pWF05', reply: { text: 'PARENT-DONE' } },
  ];
}

const readSubagents = (state: string): Record<string, Json> => JSON.parse(Deno.readTextFileSync(join(state, 'subagent-worktrees.json'))).subagents;

Deno.test({
  name: 'AibSubagentHooksTest test_editing_subagent_gets_its_own_worktree',
  ignore: !(ok && SERVER_SPLIT),
  ...T,
  async fn() {
    // the Aib harness (e2e_subagent_landing_test.ts) with these parent rules: the project is known before the rules are made
    const mark = `srp1${uuid().slice(0, 6)}`;
    using temp = new Temp('aib-sr-');
    const project = makeProject(temp.path, mark);
    Deno.writeTextFileSync(join(project, 'dirty.txt'), 'main-edit\n'); // the main agent's uncommitted edit
    using _own = new OwnerUntouched([mark]);
    await using stub = await Stub.start(temp.path, parentRules(project));
    const keeper = keeperProgram();
    temp.mkdir('tmp');
    await using fx = new RealClaudeFixture(stub, agentTempRoot(), { keeper, tmp: temp.join('tmp') });
    const web = await fx.startWeb();
    const [status, connection] = await web.post('connect', { provider: 'claude', cwd: project, background: true });
    assertEquals(status, 200, JSON.stringify(connection));
    const chat = new Chat(null, connection.id as string, web);
    await waitFor(async () => {
      const s = await chat.state();
      if (s.error) throw new Error(String(s.error));
      return s.ready;
    }, 'chat ready');
    const iso = ((await chat.state()).subagentIsolation as Json | undefined) ?? {};
    assertEquals({ on: iso.on, reason: iso.reason }, { on: true, reason: '' });

    const [code] = await web.post('prompt', { id: chat.id, text: 'SR-PARENT go', clientMessageId: uuid() });
    assertEquals(code, 200);
    await waitFor(async () => {
      await approveAll(chat);
      const state = await chat.state();
      return !state.busy && state.events.some((e) => e.kind === 'turn_end');
    }, 'the parent turn to end', 240);
    const sent = dumped(stub);
    assert((stubText(stub) + sent + JSON.stringify((await chat.state()).events).slice(-20000)).includes('PARENT-DONE'));

    // B2: the record, its worktree (S had the uncommitted edit), the folder untouched
    const records = readSubagents(fx.state);
    const bound = Object.values(records).filter((r) => ['running', 'done'].includes(String(r.state))); // done: its SubagentStop came (P2)
    assertEquals(bound.length, 1, JSON.stringify(records));
    const rec = bound[0];
    assert(rec.agentId);
    assertEquals(rec.toolUseId, 'toolu_pAgent01');
    assert(String(rec.branch).startsWith('studio/sub-'), JSON.stringify(rec));
    assert(norm(String(rec.path)).startsWith(norm(join(fx.state, 'worktrees'))), JSON.stringify(rec));
    const wt = String(rec.path);
    assertEquals(Deno.readTextFileSync(join(wt, 'sub-a.txt')).trim(), 'from-sub');
    assertEquals(Deno.readTextFileSync(join(wt, 'dirty.txt')).trim(), 'main-edit', 'S carries the uncommitted edit');
    assert(!exists(join(project, 'sub-a.txt')), 'the subagent wrote into the project folder');
    assert(!exists(join(project, 'escape-write.txt')), "Claude Code's own fence held");
    assert(git(project, 'status', '--porcelain').includes('?? dirty.txt'), 'the main edit stays uncommitted');
    const listing = git(project, 'worktree', 'list', '--porcelain');
    const block = listing.split('\n\n').filter((b) => norm(String(rec.path)).includes(norm(b.split('\n')[0].replace('worktree ', ''))) || norm(b.split('\n')[0].replace('worktree ', '')).includes(norm(String(rec.path))));
    assert(block.length && block[0].includes('locked'), listing);
    // B3: Explore got none (only the editing call has a record besides spares)
    assertEquals(Object.values(records).filter((r) => r.agentType === 'Explore'), [], JSON.stringify(records));
    assert(sent.includes('EXPLORE-DONE'));
    // B16: the refusals reached the model
    assert(sent.includes(ENTER_TEXT));
    assert(sent.includes(WORKFLOW_TEXT));
    // 2.5: the prompt line
    assert(sent.includes(PROMPT_LINE));

    // B14: forged calls with the chat's key
    const key = await hookKey(fx.state, chat.id);
    assert(!sent.includes(key), 'the hook key reached the model');
    assertEquals((await hookPost(fx.state, 'worktree-create', chat.id, 'f'.repeat(64), { name: 'agent-x' }))[0], 401);
    let [s, text] = await hookPost(fx.state, 'worktree-create', chat.id, key, { name: 'agent-forged1' });
    assertEquals([s, text], [409, "AIB didn't expect this worktree"]);
    [s, text] = await hookPost(fx.state, 'worktree-create', chat.id, key, { name: 'feature-x' });
    assertEquals(s, 409);
    [s, text] = await hookPost(fx.state, 'pre-tool', chat.id, key, { tool_name: 'EnterWorktree', tool_input: {} });
    assertEquals(JSON.parse(text).hookSpecificOutput.permissionDecision, 'deny');
    // a forged stop and a UNC adoption hint change nothing that matters
    await hookPost(fx.state, 'subagent-stop', chat.id, key, { agent_id: rec.agentId, agent_type: '' }); // an internal fork's: ignored (P2: a typed stop makes it done)
    await hookPost(fx.state, 'post-agent', chat.id, key, { tool_use_id: 'toolu_x', tool_response: { agentId: 'zzz', worktreePath: '\\\\203.0.113.9\\share' } });
    const after = readSubagents(fx.state);
    assertEquals(after[rec.id as string].state, rec.state);
    assertEquals(after[rec.id as string].path, rec.path);
    // the cap: forged editing Agent calls are prepared until the chat holds 8, then refused
    const turnEnds = async () => (await chat.state()).events.filter((e) => e.kind === 'turn_end').length;
    // Claude Code runs a second cycle on its own when the helper finishes; its turn end removes prepared worktrees no call took
    await waitFor(async () => !(await chat.state()).busy && (await turnEnds()) >= 2, 'the second cycle to end', 60).catch(() => {});
    const answers: string[] = [];
    for (let i = 0; i < 9; i++) {
      answers.push((await hookPost(fx.state, 'pre-tool', chat.id, key, { tool_name: 'Agent', tool_use_id: `toolu_f${i}`, tool_input: { subagent_type: 'general-purpose', prompt: 'x' } }))[1]);
    }
    const denied = answers.filter((a) => a.includes('permissionDecision'));
    assert(denied.length && denied[denied.length - 1].includes('already has 8 subagents'), JSON.stringify(answers.slice(-3)));
    assertEquals(answers.filter((a) => a.includes('"allow"')), [], 'a hook route answered allow');
    const held = Object.values(readSubagents(fx.state)).filter((r) => r.chat === chat.id && ['preparing', 'prepared', 'running'].includes(String(r.state))); // the slots the cap counts (the done one is not one)
    assertEquals(held.length, 8);

    // B15: not on the web server (the page and the phone use it)
    const r = await fetch(`http://127.0.0.1:${web.port}/hooks/claude/pre-tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Studio-Hook-Key': key, 'X-Studio-Conversation-Id': chat.id },
      body: '{}',
      signal: AbortSignal.timeout(10000),
    });
    await r.text();
    assert([401, 403, 404].includes(r.status), String(r.status));

    // turn end removed nothing bound; the forged prepared ones become a spare or go at the next turn end (not landing: P2)
    assert(isDir(wt));
  },
});

/** subagents/claude_config.ts hookSettings, the same shape (forward slashes, double quotes, `|| exit 2`, timeout 30). */
function aibHookSettings(keeper: string, address: string) {
  const p = keeper.replaceAll('\\', '/');
  const a = address.replaceAll('\\', '/');
  const hook = (ev: string, blocking: boolean) => ({ type: 'command', command: `"${p}" hook ${ev} "${a}"` + (blocking ? ' || exit 2' : ''), timeout: 30 });
  return {
    hooks: {
      PreToolUse: [{ matcher: 'Agent|Task|EnterWorktree|Workflow', hooks: [hook('pre-tool', true)] }],
      PostToolUse: [{ matcher: 'Agent|Task', hooks: [hook('post-agent', false)] }],
      SubagentStop: [{ hooks: [hook('subagent-stop', false)] }],
      WorktreeCreate: [{ hooks: [hook('worktree-create', true)] }],
    },
  };
}

/** The adapter alone with AIB's hook settings shape; returns the seconds the probe took. */
async function runProbe(addressDoc: Json, options: { refused?: string | false; settings?: Json } = {}): Promise<number> {
  using temp = new Temp('aib-sr-a-');
  const mark = `srp1${uuid().slice(0, 6)}`;
  const project = makeProject(temp.path, mark);
  using _own = new OwnerUntouched([mark]);
  const rules = [
    { when: 'SR-PARENT', reply: { tools: [{ id: 'toolu_pAgent01', name: 'Agent', input: { description: 'sr edit', prompt: 'SUBTASK-A: do the work', subagent_type: 'general-purpose', run_in_background: false } }] } },
    { when: 'SUBTASK-A', reply: { tools: [{ id: 'toolu_sBash01', name: 'Bash', input: { command: 'echo from-sub > sub-a.txt', description: 'write' } }] } },
    { when: 'toolu_sBash01', reply: { text: 'SUB-DONE' } },
    { when: 'toolu_pAgent01', reply: { tools: [{ id: 'toolu_pAgent02', name: 'Agent', input: { description: 'sr look', prompt: 'SUBTASK-E: look', subagent_type: 'Explore', run_in_background: false } }] } },
    { when: 'SUBTASK-E', reply: { text: 'EXPLORE-DONE' } },
    { when: 'toolu_pAgent02', reply: { text: 'PARENT-DONE' } },
  ];
  await using stub = await Stub.start(temp.path, rules);
  const address = temp.join('artifact-mcp.json');
  Deno.writeTextFileSync(address, JSON.stringify(addressDoc));
  const home = temp.join('home');
  for (const sub of ['claude', 'home/AppData/Roaming', 'home/AppData/Local', 'tmp']) temp.mkdir(...sub.split('/'));
  const env: Record<string, string> = { ...Deno.env.toObject() };
  for (const name of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT']) delete env[name];
  for (const name of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME']) env[name] = home;
  Object.assign(env, {
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    CLAUDE_CONFIG_DIR: temp.join('claude'),
    TEMP: temp.join('tmp'),
    TMP: temp.join('tmp'),
    TMPDIR: temp.join('tmp'),
    AIB_HOOK_KEY: 'k'.repeat(64),
    AIB_HOOK_CHAT: 'c'.repeat(32),
    AIB_HOOK_READONLY: 'Explore,Plan,claude-code-guide,statusline-setup',
  });
  const full = stubClaudeEnv(env, stub);
  const meta = temp.join('meta.json');
  const settings = options.settings ?? aibHookSettings(keeperProgram(), address);
  Deno.writeTextFileSync(meta, JSON.stringify({ claudeCode: { options: { settings } } }));
  const started = Date.now();
  const out = await new Deno.Command(NODE_EXE!, {
    args: [acpProbe, '--allow', '--meta', meta, CLAUDE_ACP!, 'new', project, 'SR-PARENT go'],
    env: full,
    clearEnv: true,
    stdin: 'null',
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const took = (Date.now() - started) / 1000;
  assert((dec(out.stdout) + stubText(stub)).includes('PARENT-DONE'), dec(out.stderr).slice(-1500));
  const sent = dumped(stub);
  if (options.refused !== false) assert(sent.includes(options.refused ?? RESTARTING), 'the editing Agent call was not refused');
  assert(!(stubText(stub) + sent).includes('SUB-DONE'), 'the editing subagent ran');
  assert(!exists(join(project, 'sub-a.txt')), 'the subagent ran unisolated in the folder');
  assertEquals(git(project, 'status', '--porcelain'), '', 'the folder changed');
  assert(sent.includes('EXPLORE-DONE'), 'Explore must run while AIB is down');
  assert(!exists(join(project, '.claude', 'worktrees')));
  return took;
}


Deno.test({
  name: 'AdapterFailClosedTest test_aib_unreachable_refuses_editing_subagent',
  ignore: !ok,
  ...T,
  fn: async () => {
    await runProbe({ url: `http://127.0.0.1:${refusedPort()}/mcp`, pid: 1 });
  },
});

Deno.test({
  name: 'AdapterFailClosedTest test_aib_hanging_refuses_within_deadline',
  ignore: !ok,
  ...T,
  async fn() {
    const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 }); // accepts and never answers (an AIB stuck mid-request)
    const held: Deno.Conn[] = [];
    (async () => {
      for await (const conn of listener) held.push(conn);
    })().catch(() => {});
    try {
      const took = await runProbe({ url: `http://127.0.0.1:${(listener.addr as Deno.NetAddr).port}/mcp`, pid: Deno.pid });
      assert(held.length > 0, 'the forwarder never connected');
      assert(took < 200, `took ${took}`);
    } finally {
      listener.close();
      for (const c of held) {
        try {
          c.close();
        } catch { /* closed */ }
      }
    }
  },
});

/** A listener that is not AIB (a dev server on AIB's old port) answering 200 to everything; its address file names a live pid. */
function squatter(body: string, contentType: string) {
  const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen: () => {} }, async (request) => {
    await request.text();
    return new Response(body, { status: 200, headers: { 'Content-Type': contentType } });
  });
  return { server, doc: { url: `http://127.0.0.1:${server.addr.port}/mcp`, pid: Deno.pid } };
}

Deno.test({
  name: 'AdapterFailClosedTest test_squatter_200_empty_json_never_runs_the_subagent',
  ignore: !ok,
  ...T,
  /** Security review P1 MF 1 / should-fix 12: an unsigned 200 {} blocks the editing subagent (it never runs in the folder). */
  async fn() {
    const s = squatter('{}', 'application/json');
    try {
      await runProbe(s.doc, { refused: UNCONFIRMED });
    } finally {
      await s.server.shutdown();
    }
  },
});

Deno.test({
  name: 'AdapterFailClosedTest test_no_git_bash_deny_rules_turn_subagents_off',
  ignore: !ok,
  ...T,
  /**
   * MF 7: a chat without Git Bash gets no hooks but P2's hooks-off deny rules (claude_config.ts subagentsOffSettings, the shape it
   * gives a chat with no custom agents): with every permission prompt allowed, the editing subagent is refused and never runs in the
   * folder; Explore still runs.
   */
  fn: async () => {
    const editing = ['claude', 'fork', 'general-purpose'];
    const off = { permissions: { deny: [...editing.flatMap((n) => [`Agent(${n})`, `Task(${n})`]), 'Workflow', 'EnterWorktree'] } };
    await runProbe({ closed: true, pid: Deno.pid }, { refused: false, settings: off });
  },
});

Deno.test({
  name: 'AdapterFailClosedTest test_squatter_200_html_never_runs_the_subagent',
  ignore: !ok,
  ...T,
  async fn() {
    const s = squatter('<!doctype html><title>dev</title>', 'text/html');
    try {
      await runProbe(s.doc, { refused: UNCONFIRMED });
    } finally {
      await s.server.shutdown();
    }
  },
});

void WIN;
