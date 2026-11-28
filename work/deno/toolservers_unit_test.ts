/**
 * Per-project tool servers, the pure parts (toolservers/store.ts, apply.ts, discover.ts, measure.ts): the choice and its defaults
 * (servers on this PC off and remote ones on for a project that starts new; an old project loads everything), the hash and the words
 * of a change, each agent's launch fragment, discovery over fake files, and the memory measurement over REAL child processes.
 * The real CLIs are in toolservers_cli_e2e_test.ts.
 */
import { assert, assertEquals } from './_assert.ts';
import {
  cleanChoice,
  describeChange,
  effective,
  effectiveHash,
  NEW_PROJECT_CHOICE,
  serverOn,
  ToolServersStore,
} from '../../app/server/toolservers/store.ts';
import {
  claudePatch,
  codexEntries,
  codexFlags,
  copilotArgs,
  geminiArgs,
  geminiPolicyToml,
  mergeClaudeSettings,
  mergeQwenSettings,
  qwenFragment,
  REACH,
  withCodexToolServers,
} from '../../app/server/toolservers/apply.ts';
import { codexServers, discoverServers, kindOf } from '../../app/server/toolservers/discover.ts';
import { agentProcesses, attribute, headTokens, sizeKb } from '../../app/server/toolservers/measure.ts';
import { mcpToolOf } from '../../app/server/acp/tool_tracking.ts';
import { staleReasons } from '../../app/server/artifacts/served.ts';
import { WORK } from './_work.ts';

type Json = Record<string, unknown>;
const T = { sanitizeResources: false, sanitizeOps: false };
const SEP = Deno.build.os === 'windows' ? '\\' : '/';
const REA = { id: 'rea', kind: 'local' as const };
const GITHUB = { id: 'github', kind: 'remote' as const };
const state = () => Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-tsunit-' }));

Deno.test("choice: a project nobody set loads everything; a new project starts with this PC's servers off and remote ones on", () => {
  assertEquals([serverOn(null, REA), serverOn(null, GITHUB)], [true, true]);
  assertEquals([serverOn(NEW_PROJECT_CHOICE, REA), serverOn(NEW_PROJECT_CHOICE, GITHUB)], [false, true]);
  const edited = { ...NEW_PROJECT_CHOICE, servers: { rea: true, github: false } };
  assertEquals([serverOn(edited, REA), serverOn(edited, GITHUB)], [true, false], 'an explicit switch beats the rule');
  assertEquals(cleanChoice({ servers: { a: 'yes', b: true, __proto__: { x: 1 } }, tools: { a: ['x', 'x', '', 5] }, offLocal: 'no' }), {
    servers: { b: true },
    tools: { a: ['x'] },
  });
});

Deno.test('store: switches, single tools, All on / All off, seeding a new project once, the seen tool names, measured memory', () => {
  const dir = state();
  try {
    const s = new ToolServersStore(dir);
    assertEquals(s.choice('w:c:/p'), null);
    s.update('w:c:/p', { server: 'rea', on: false });
    s.update('w:c:/p', { server: 'rea', tool: 'decompile_all', toolOn: false });
    s.update('w:c:/p', { server: 'rea', tool: 'list_strings', toolOn: false });
    assertEquals(s.choice('w:c:/p'), { servers: { rea: false }, tools: { rea: ['decompile_all', 'list_strings'] } });
    s.update('w:c:/p', { server: 'rea', tool: 'decompile_all', toolOn: true });
    assertEquals(s.choice('w:c:/p')!.tools, { rea: ['list_strings'] });
    s.update('w:c:/p', { server: 'rea', allTools: { on: false, names: ['a', 'b'] } });
    assertEquals(s.choice('w:c:/p')!.tools, { rea: ['a', 'b'] });
    s.update('w:c:/p', { server: 'rea', allTools: { on: true, names: [] } });
    assertEquals(s.choice('w:c:/p')!.tools, {});
    // seeding: the New projects list as the project's own, once
    assertEquals(s.seedProject('p:/new'), true);
    assertEquals(s.choice('p:/new'), NEW_PROJECT_CHOICE);
    s.update('_new', { server: 'rea', on: true });
    assertEquals(s.seedProject('p:/new'), false, 'a project is seeded once');
    assertEquals(s.choice('p:/new'), NEW_PROJECT_CHOICE, 'a later change of New projects does not move an existing project');
    assertEquals(s.newProjects().servers, { rea: true });
    // tool names a chat saw, and what a run measured; another store object on the same file reads them
    s.sawTools('rea', ['b', 'a']);
    s.sawTools('rea', ['c', 'a']);
    s.measured('rea', 2, 89.6);
    const again = new ToolServersStore(dir);
    assertEquals(again.seen('rea')!.tools, ['a', 'b', 'c']);
    assertEquals(again.memory('rea')!.procs, 2);
    assertEquals(again.memory('rea')!.mb, 90);
    assertEquals(again.choice('w:c:/p')!.servers, { rea: false });
    assert(!Deno.readTextFileSync(dir + SEP + 'tool-servers.json').includes('__proto__'));
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test('hash and words: a change is stale, the line names it', () => {
  const none = effective(null, [REA, GITHUB]);
  const off = effective({ servers: { rea: false }, tools: {} }, [REA, GITHUB]);
  const tools = effective({ servers: {}, tools: { github: ['create_issue', 'merge_pull_request'] } }, [REA, GITHUB]);
  assert(effectiveHash(none) !== effectiveHash(off) && effectiveHash(off) !== effectiveHash(tools));
  assertEquals(
    effectiveHash(off),
    effectiveHash(effective({ servers: { rea: false }, tools: {} }, [GITHUB, REA])),
    'the order of the servers does not matter',
  );
  assertEquals(describeChange(none, off), 'rea off');
  assertEquals(describeChange(off, none), 'rea on');
  assertEquals(describeChange(none, tools), 'github: 2 tools off');
  assertEquals(describeChange(null, effective({ servers: { rea: false, github: false }, tools: {} }, [REA, GITHUB])), 'github, rea off');
  // the stale reason is its own: a chat with no record of its list (launched before this feature) is not stale
  assertEquals(staleReasons(null, { tools: null, promptBase: null, toolServers: 'x' }, false), []);
  assertEquals(
    staleReasons(
      { app: '1', toolServers: { hash: 'a', off: [], tools: {}, at: 1 } },
      { tools: null, promptBase: null, toolServers: 'b' },
      false,
    ),
    ['servers'],
  );
  assertEquals(
    staleReasons(
      { app: '1', toolServers: { hash: 'a', off: [], tools: {}, at: 1 } },
      { tools: null, promptBase: null, toolServers: 'a' },
      false,
    ),
    [],
  );
});

Deno.test('apply: Claude settings (merged with the hook settings), Codex entries, Copilot flags', () => {
  const e = effective({ servers: { rea: false }, tools: { github: ['create_issue'] } }, [REA, GITHUB]);
  assertEquals(claudePatch(e), { deniedMcpServers: [{ serverName: 'rea' }], permissions: { deny: ['mcp__github__create_issue'] } });
  assertEquals(claudePatch(effective(null, [REA])), null);
  const hooks = { hooks: { PreToolUse: [] }, permissions: { deny: ['Agent(x)'], allow: ['Read'] } };
  const merged = mergeClaudeSettings(hooks, claudePatch(e))!;
  assertEquals((merged.permissions as Json).deny, ['Agent(x)', 'mcp__github__create_issue']);
  assertEquals((merged.permissions as Json).allow, ['Read'], "AIB's own settings are kept");
  assertEquals(merged.deniedMcpServers, [{ serverName: 'rea' }]);
  assertEquals(mergeClaudeSettings(hooks, null), hooks);
  assertEquals(
    claudePatch(effective({ servers: {}, tools: { 'claude.ai Gmail': ['send_message'] } }, [{ id: 'claude.ai Gmail', kind: 'remote' }])),
    {
      permissions: { deny: ['mcp__claude_ai_Gmail__send_message'] },
    },
    'a connector name is written the way Claude Code names its tools',
  );
  // Codex: partial entries; AIB's own entry is never switched off
  const entries = codexEntries(e)!;
  assertEquals(entries, { rea: { enabled: false }, github: { disabled_tools: ['create_issue'] } });
  const config = JSON.stringify({
    mcp_servers: { studio_artifact: { command: 'x', omit_tools_from: ['deferred'] }, rea: { command: 'rea' } },
  });
  const out = JSON.parse(withCodexToolServers(config, { ...entries, studio_artifact: { enabled: false } }));
  assertEquals(out.mcp_servers.rea, { command: 'rea', enabled: false });
  assertEquals(out.mcp_servers.studio_artifact.enabled, undefined, "AIB's own server stays on");
  assertEquals(out.mcp_servers.github, { disabled_tools: ['create_issue'] });
  assertEquals(codexFlags(entries), ['-c', 'mcp_servers.rea.enabled=false', '-c', 'mcp_servers.github.disabled_tools=["create_issue"]']);
  assertEquals(copilotArgs(e), ['--disable-mcp-server', 'rea', '--excluded-tools', 'github-create_issue']);
});

Deno.test('apply: Gemini allow list and policy, Qwen settings', () => {
  const found = [
    {
      id: 'rea',
      kind: 'local',
      from: 'user',
      fromText: '',
      agents: ['qwen', 'gemini'],
      entries: { qwen: { command: 'rea', args: ['x'] } },
    },
    {
      id: 'github',
      kind: 'remote',
      from: 'user',
      fromText: '',
      agents: ['qwen', 'gemini', 'antigravity'],
      entries: { qwen: { url: 'u' }, antigravity: { command: 'g' } },
    },
  ] as never[];
  const e = effective({ servers: { rea: false }, tools: { github: ['create_issue'] } }, [REA, GITHUB]);
  assertEquals(geminiArgs(e, found, ['studio_artifact']), ['--allowed-mcp-server-names', 'github', 'studio_artifact']);
  assertEquals(
    geminiArgs(effective(null, [REA]), found, ['studio_artifact']),
    [],
    'nothing off: no allow list (it would block unknown servers)',
  );
  const toml = geminiPolicyToml(e);
  assert(toml.includes('toolName = "mcp_github_create_issue"') && toml.includes('decision = "deny"'), toml);
  assertEquals(geminiPolicyToml(effective(null, [REA])), '');
  const q = qwenFragment(e, found)!;
  assertEquals(q.mcp, { excluded: ['rea'] });
  assertEquals(
    (q.mcpServers as Json).github,
    { url: 'u', excludeTools: ['create_issue'] },
    "a server with tools off is a full copy of the user's entry",
  );
  const merged = mergeQwenSettings({ hooks: { x: 1 }, mcp: { excluded: ['old'] } }, q);
  assertEquals((merged.mcp as Json).excluded, ['old', 'rea']);
  assertEquals(merged.hooks, { x: 1 });
  // the card: what is enforced and what is not
  assertEquals(REACH.map((r) => [r.agent, r.reach]), [
    ['claude', 'enforced'],
    ['codex', 'enforced'],
    ['gemini', 'enforced'],
    ['qwen', 'enforced'],
    ['copilot', 'enforced'],
    ['antigravity', 'partial'],
    ['maki', 'none'],
  ]);
});

Deno.test("discovery: each agent's own file format, read only", () => {
  const files: Record<string, string> = {
    'H/.claude.json': JSON.stringify({
      mcpServers: { rea: { command: 'rea' }, web: { type: 'sse', url: 'u' } },
      claudeAiMcpEverConnected: ['claude.ai Gmail'],
      projects: { 'P/app': { mcpServers: { local: { command: 'l' } } } },
    }),
    'P/app/.mcp.json': JSON.stringify({ mcpServers: { rea: { command: 'project-rea' }, pw: { command: 'pw' } } }),
    'H/.codex/config.toml':
      '[mcp_servers."a.b"]\nurl = "https://x"\n[mcp_servers.c7]\ncommand = "npx" # comment\nenabled = false\n[other]\ncommand = "no"\n',
    'H/.copilot/mcp-config.json': JSON.stringify({ mcpServers: { cop: { type: 'local', command: 'c' } } }),
    'P/app/.vscode/mcp.json': JSON.stringify({ servers: { vs: { command: 'v' } } }),
  };
  const read = (p: string) => files[p.replaceAll('\\', '/')] ?? null;
  const found = discoverServers({ read }, { home: 'H', folder: 'P/app', env: {}, sep: '/' });
  const by = Object.fromEntries(found.map((s) => [s.id, s]));
  assertEquals(Object.keys(by).sort(), ['a.b', 'claude.ai Gmail', 'cop', 'local', 'pw', 'rea', 'vs', 'web']);
  assertEquals([by.rea.kind, by.web.kind, by['a.b'].kind, by['claude.ai Gmail'].kind], ['local', 'remote', 'remote', 'remote']);
  assertEquals(by.rea.from, 'project', 'a project entry of the same name is the one a chat in this folder reads first');
  assertEquals(by.rea.fromText, 'This project · .mcp.json');
  assertEquals(by.local.fromText, 'This project · your Claude settings');
  assertEquals(by['claude.ai Gmail'].fromText, 'claude.ai connector');
  assertEquals(by.rea.agents, ['claude']);
  assert(!by.c7, 'a server the agent has switched off in its own file is not listed');
  assertEquals(kindOf({ command: 'x' }), 'local');
  assertEquals(Object.keys(codexServers('[mcp_servers.x.env]\nA = "b"\n[mcp_servers.y]\ncommand = "z"\n')), ['y']);
  // CLAUDE_CONFIG_DIR moves the user's file (probed with the real CLI)
  const moved = discoverServers({ read: (p) => (p.replaceAll('\\', '/') === 'C/.claude.json' ? files['H/.claude.json'] : null) }, {
    home: 'H',
    folder: 'P/none',
    env: { CLAUDE_CONFIG_DIR: 'C' },
    sep: '/',
  });
  assertEquals(moved.map((s) => s.id).sort(), ['claude.ai Gmail', 'rea', 'web']);
});

Deno.test("tool names a chat saw: Claude, Codex, Copilot and Gemini shapes; never AIB's own", () => {
  assertEquals(mcpToolOf('mcp__rea__decompile_all', null, ''), { server: 'rea', tool: 'decompile_all' });
  assertEquals(mcpToolOf('mcp__studio_artifact__doc', null, ''), null);
  assertEquals(mcpToolOf('', { server: 'github', tool: 'create_issue', action: '' }, ''), { server: 'github', tool: 'create_issue' });
  assertEquals(mcpToolOf('', null, 'search_code (github MCP Server)'), { server: 'github', tool: 'search_code' });
  assertEquals(mcpToolOf('Bash', null, 'ls'), null);
});

Deno.test({
  name: 'measure: the processes of a server below the agent and their working set, from real child processes',
  ...T,
  async fn() {
    const node = Deno.build.os === 'windows' ? 'node.exe' : 'node';
    const script = decodeURIComponent(new URL('fake_mcp_server.js', WORK).pathname).replace(/^\/([A-Za-z]:)/, '$1');
    const kids = ['rea', 'aibx'].map((name) =>
      new Deno.Command(node, { args: [script, name], stdin: 'piped', stdout: 'null', stderr: 'null' }).spawn()
    );
    try {
      await new Promise((r) => setTimeout(r, 1500));
      assert(sizeKb(Deno.pid) > 5000, 'this process (deno) holds more than 5 MB');
      const procs = agentProcesses(Deno.pid);
      assert(procs && procs.length >= 2, 'the child processes are listed');
      const m = attribute(procs!, [{ id: 'rea', entry: { command: 'node', args: [script, 'rea'] } }, {
        id: 'aibx',
        entry: { command: 'node', args: [script, 'aibx'] },
      }]);
      assertEquals(Object.keys(m).sort(), ['aibx', 'rea']);
      assertEquals([m.rea.procs, m.aibx.procs], [1, 1], 'each server is told apart by its own arguments');
      assert(m.rea.mb >= 5 && m.rea.mb < 400, `a node process is some MB: ${m.rea.mb}`);
      assertEquals(headTokens({ command: 'npx', args: ['-y', '@x/server', '--flag'] }), ['@x/server']);
      assertEquals(headTokens({ command: 'C:\\bin\\rea.exe', args: [] }), ['rea']);
    } finally {
      for (const k of kids) {
        try {
          k.kill('SIGKILL'); // only the processes this test started
        } catch { /* gone */ }
        await k.status;
      }
    }
  },
});
