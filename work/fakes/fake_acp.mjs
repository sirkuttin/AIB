// Deterministic ACP test agent. Does not call a model or execute tools. (The node port of work/fake_acp.py: same flags, same lines on stdout.)
// Run as `node fake_acp.mjs [flags]`, or import run(argv) from a launcher (work/*-fixture/agent.mjs).
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Ev, exists, exitAfterFlush, partition, popen, pyDumps, pyLen, sleep, sleepSync, sleeper, splitMax, thread, WAIT_FOR_FILE } from './_py.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// name, kind ('bool' | 'int' | 'str' | choices array), help is in work/fake_acp.py's history; the flags are the contract
const FLAGS = {
  'setup-question': 'bool', 'setup-fail': 'bool', 'images': 'bool', 'embedded-context': 'bool', 'audio': 'bool', 'rich': 'bool',
  'cancel-aware': 'bool', 'protocol-version': 'int', 'bad-initialize': 'bool', 'bad-session': ['no-id', 'bad-modes'], 'malformed': 'bool',
  'auth-required': 'bool', 'auth-file': 'str', 'auth-reject': 'bool', 'breadth': 'bool', 'resume-only': 'bool', 'mcp-http': 'bool',
  'client-caps': 'bool', 'list-sessions': 'bool', 'reject-config': 'bool', 'require-config-type': 'bool', 'subagent': 'bool',
  'replay-history': 'bool', 'new-session': 'str', 'replay-file': 'str', 'demo': 'bool', 'models': 'bool', 'beta-auth': 'bool',
  'acp-models': 'bool', 'claude-modes': 'bool', 'codex-modes': ['v2.6', 'old', 'neither'], 'fixture-login': 'bool',
  'prompt-auth': 'bool', 'fail-login': 'bool', 'terminal-env': 'bool', 'held-turn': 'bool', 'not-claude': 'bool', 'child-pid-file': 'str',
  'fork': 'bool', 'fork-refuse': 'bool', // session/fork advertised (claude-agent-acp, codex-acp do); -refuse: it answers with an error
  'limits': 'bool', 'extra-dirs': 'bool', 'steer': ['claude', 'codex', 'omp', 'other'],
  'additional-mcp-config': 'str', // Copilot's launch flag (agents/copilot_mcp.ts): accepted and ignored
};

function parseArgs(argv, prog) {
  const out = {};
  const fail = (message) => {
    process.stderr.write(`usage: ${prog} [-h] [options]\n${prog}: error: ${message}\n`);
    process.exit(2);
  };
  const names = Object.keys(FLAGS);
  const unknown = [];
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      process.stdout.write(`usage: ${prog} [-h] [options]\n\nDeterministic ACP test agent. Does not call a model or execute tools.\n\noptions: ${names.map((n) => '--' + n).join(' ')}\n`);
      process.exit(0);
    }
    if (!arg.startsWith('--')) {
      unknown.push(arg);
      continue;
    }
    let inline = null;
    const eq = arg.indexOf('=');
    if (eq > 0) {
      inline = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    let name = arg.slice(2);
    if (!(name in FLAGS)) {
      const near = names.filter((n) => n.startsWith(name));
      if (near.length === 1) name = near[0];
      else if (near.length > 1) fail(`ambiguous option: ${arg} could match ${near.map((n) => '--' + n).join(', ')}`);
      else {
        unknown.push(argv[i]);
        continue;
      }
    }
    const kind = FLAGS[name];
    const key = name.replaceAll('-', '_');
    if (kind === 'bool') {
      if (inline !== null) fail(`argument --${name}: ignored explicit argument '${inline}'`);
      out[key] = true;
      continue;
    }
    let value = inline;
    if (value === null) {
      if (i + 1 >= argv.length || (argv[i + 1].startsWith('--') && argv[i + 1].length > 2)) fail(`argument --${name}: expected one argument`);
      value = argv[++i];
    }
    if (kind === 'int') {
      if (!/^\s*[-+]?\d+\s*$/.test(value)) fail(`argument --${name}: invalid int value: '${value}'`);
      out[key] = Number.parseInt(value, 10);
    } else if (Array.isArray(kind)) {
      if (!kind.includes(value)) fail(`argument --${name}: invalid choice: '${value}' (choose from ${kind.map((c) => `'${c}'`).join(', ')})`);
      out[key] = value;
    } else out[key] = value;
  }
  if (unknown.length) fail(`unrecognized arguments: ${unknown.join(' ')}`);
  return out;
}

export function run(argv, { fakeSession = 'fake-session', prog = 'fake_acp.py' } = {}) {
  const parsed = parseArgs(argv, prog);
  const args = {
    setup_question: false, setup_fail: false, images: false, embedded_context: false, audio: false, rich: false, cancel_aware: false,
    protocol_version: 1, bad_initialize: false, bad_session: null, malformed: false, auth_required: false, auth_file: null, auth_reject: false,
    breadth: false, resume_only: false, mcp_http: false, client_caps: false, list_sessions: false, reject_config: false,
    require_config_type: false, subagent: false, replay_history: false, new_session: null, replay_file: null, demo: false, models: false,
    beta_auth: false, acp_models: false, claude_modes: false, codex_modes: null, fixture_login: false, prompt_auth: false, fail_login: false,
    terminal_env: false, held_turn: false, not_claude: false, child_pid_file: null, limits: false, extra_dirs: false, steer: null,
    ...parsed,
  };
  const env = process.env;

  if (args.fixture_login && args.fail_login) {
    process.stdout.write('Fixture terminal login: failed.\n');
    return exitAfterFlush(3);
  }
  if (args.fixture_login) {
    if (args.auth_file) fs.writeFileSync(args.auth_file, 'signed in' + (env.AIB_FIXTURE_LOGIN ? ' ' + env.AIB_FIXTURE_LOGIN : ''), 'utf8');
    process.stdout.write('Fixture terminal login: signed in.\n');
    return exitAfterFlush(0);
  }
  if (args.child_pid_file) {
    const child = popen(process.execPath, ['-e', sleeper(600)], { stdio: 'ignore' });
    fs.writeFileSync(args.child_pid_file, String(child.pid));
  }
  if (args.setup_fail && !args.setup_question) {
    process.stderr.write(`usage: ${prog} [-h] [options]\n${prog}: error: --setup-fail requires --setup-question\n`);
    process.exit(2);
  }

  const waiting = {};
  let capsRun = null; // {turn, steps, results, terminal}
  let setupAnswer = false;
  let pendingSetup = null;
  let authenticated = false;
  const acpModel = ['gemini-2.5-pro'];
  const authOk = () => !args.auth_required || authenticated || !!(args.auth_file && exists(args.auth_file));
  let lastMcp = [];
  let sessionCwd = '';
  let sessionName = fakeSession;
  let editIds = 0; // a fresh tool call id for every edit
  const nextEditId = () => ++editIds;

  /** The session id agent messages carry: always the fake session (what the tests expect), except with --demo, --new-session or AIB_FAKE_OWN_SESSION=1. */
  const SID = () => (args.demo || args.new_session || env.AIB_FAKE_OWN_SESSION === '1' ? sessionName : fakeSession);

  let configOptions = [
    { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'fast', options: [
      { group: 'g1', name: 'Small', options: [{ value: 'fast', name: 'Fast' }] },
      { group: 'g2', name: 'Large', options: [{ value: 'deep', name: 'Deep', description: 'Slow' }] }] },
    { id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: 'low', options: [
      { value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
    { id: 'verbose', name: 'Verbose', type: 'boolean', currentValue: false },
    { id: 'dial', name: 'Dial', type: 'slider', currentValue: 7 },
  ];
  const MODEL_NAMES = ['Sol 6.1', 'Sol 6.1 Mini', 'Terra 5', 'Terra 5 Fast', 'Luna 4', 'Luna 4 Long', 'Vesta 3', 'Vesta 3 Code',
    'Orion 2', 'Orion 2 Vision', 'Atlas 1', 'Atlas 1 Max', 'Nova 7', 'Nova 7 Lite', 'Pulsar 9', 'Quasar 8'];
  let modes = { currentModeId: 'code', availableModes: [{ id: 'code', name: 'Code' }] };
  let sessionNews = 0;
  if (args.codex_modes) args.models = true;
  if (args.models) {
    args.breadth = true;
    configOptions = [
      { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'sol-6-1', options: MODEL_NAMES.map((n, i) => ({
        value: n.toLowerCase().replaceAll(' ', '-').replaceAll('.', '-'), name: n,
        ...(i === 0 ? { description: 'Recommended for most work' } : n.includes('Long') ? { description: 'Larger context window, slower' } : {}) })) },
      { id: 'reasoning_effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: 'medium', options: [
        { value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High', description: 'Thinks longer before it answers' }] },
      { id: 'verbose', name: 'Verbose', type: 'boolean', currentValue: false },
    ];
    modes = { currentModeId: 'auto', availableModes: [
      { id: 'ask', name: 'Ask first', description: 'Asks before every edit and command' },
      { id: 'auto', name: 'Auto review', description: 'Edits files; asks before commands outside the folder' },
      { id: 'full', name: 'Full access', description: 'Edits and runs anything without asking' }] };
  }
  if (args.claude_modes) {
    modes = { currentModeId: 'default', availableModes: [
      { id: 'default', name: 'Default' }, { id: 'acceptEdits', name: 'Accept edits' },
      { id: 'plan', name: 'Plan' }, { id: 'bypassPermissions', name: 'Bypass permissions' }] };
  }
  if (args.codex_modes) {
    const list = { 'v2.6': ['read-only', 'workspace-write', 'agent', 'agent-full-access'], old: ['read-only', 'auto', 'full-access'], neither: ['read-only', 'agent', 'agent-full-access'] }[args.codex_modes];
    modes = { currentModeId: list[0], availableModes: list.map((i) => ({ id: i, name: i })) };
    if (args.codex_modes === 'v2.6') { // the real list, names and descriptions, recorded from the installed adapter
      modes.availableModes = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'deno', 'codex_acp_2_6_0_modes.json'), 'utf8')).availableModes;
    }
  }

  const currentSettingsText = () => {
    const model = (configOptions.find((o) => o.id === 'model') || {}).currentValue ?? '';
    const effort = (configOptions.find((o) => o.category === 'thought_level') || {}).currentValue ?? '';
    return `Fixture settings: model=${model} mode=${modes.currentModeId} effort=${effort} sessions=${sessionNews}`;
  };

  function emit(value) {
    process.stdout.write(pyDumps({ jsonrpc: '2.0', ...value }) + '\n');
  }
  const update = (value) => emit({ method: 'session/update', params: { sessionId: sessionName, update: value } });
  const result = (key, value) => emit({ id: key, result: value });
  const raw = (text) => process.stdout.write(text + '\n');
  const say = (text) => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
  /** An update on a session of the given id (a helper's). */
  const updateOn = (sessionId, body) => emit({ method: 'session/update', params: { sessionId, update: body } });

  function breadthAnnounce() {
    update({ sessionUpdate: 'available_commands_update', availableCommands: [
      { name: 'plan', description: 'Make a plan', input: { hint: 'what to plan' } },
      { name: 'compact', description: 'Compact context' },
      { name: 'review', description: 'Review <b>changes</b>' }] });
    if (!args.demo) update({ sessionUpdate: 'session_info_update', title: 'Fixture <session>', updatedAt: '2026-01-02T03:04:05Z' }); // the demo keeps each saved chat's own title
    update({ sessionUpdate: 'usage_update', size: 200000, used: 12345, cost: { amount: 0.25, currency: 'USD' } });
    update({ sessionUpdate: 'notice', title: 'Fixture notice', description: 'Heads up', severity: 'warning' });
  }

  const receivedLog = env.FAKE_ACP_LOG; // every line this agent receives, appended
  const mcpPids = env.FAKE_ACP_MCP_PIDS; // set: start the stdio MCP servers of session/new like a real agent, pids to this file
  const mcpChildren = [];

  /** What real agents do with the stdio entries of session/new: start each one as a child (kept running), its pid appended to a file. */
  function startMcpServers(servers) {
    for (const server of servers || []) {
      if (!server || typeof server !== 'object' || Array.isArray(server) || !server.command || ['http', 'sse'].includes(server.type)) continue;
      const childEnv = { ...process.env };
      for (const item of server.env || []) childEnv[item.name ?? ''] = item.value ?? '';
      const child = popen(server.command, server.args || [], { env: childEnv, stdio: ['pipe', 'pipe', 'ignore'] });
      child.proc.on('error', (error) => process.stderr.write(`fake agent: could not start MCP server ${server.name}: ${error.message}\n`));
      if (child.pid) {
        mcpChildren.push(child);
        fs.appendFileSync(mcpPids, `${child.pid} ${server.name ?? ''} ${server.command}\n`, 'utf8');
      }
    }
  }
  const streamAnswer = {};

  const RICH_MARKDOWN = `# Rich reply

Some **bold**, *italic*, \`inline code\` and a [safe link](https://example.org/docs).
A [bad link](javascript:alert(1)) and <script>alert(1)</script> stay as text.

- first item
- second item
  - nested item

1. one
2. two

> a quoted note

| Name | Value |
| --- | --- |
| alpha | 1 |

\`\`\`python
print("hello")
\`\`\`
`;

  function richTurn(promptKey) {
    const sid = SID();
    const upd = (body) => emit({ method: 'session/update', params: { sessionId: sid, update: body } });
    upd({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: RICH_MARKDOWN } });
    upd({ sessionUpdate: 'tool_call', toolCallId: 'rich-read', title: 'Read config.py', kind: 'read', status: 'pending', locations: [{ path: 'C:/proj/config.py', line: 12 }] });
    upd({ sessionUpdate: 'tool_call_update', toolCallId: 'rich-read', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'DEBUG = False' } }] });
    upd({ sessionUpdate: 'tool_call', toolCallId: 'rich-edit', title: 'Edit config.py', kind: 'edit', status: 'in_progress', locations: [{ path: 'C:/proj/config.py', line: 1 }] });
    upd({ sessionUpdate: 'tool_call_update', toolCallId: 'rich-edit', status: 'completed', content: [
      { type: 'diff', path: 'C:/proj/config.py', oldText: 'DEBUG = False\nPORT = 80\nHOST = "x"\n', newText: 'DEBUG = True\nPORT = 80\nHOST = "localhost"\nLOG = 1\n' },
      { type: 'diff', path: 'C:/proj/new_file.txt', oldText: null, newText: 'brand new\n' }] });
    upd({ sessionUpdate: 'tool_call', toolCallId: 'rich-exec', title: 'Run tests', kind: 'execute', status: 'completed', content: [{ type: 'terminal', terminalId: 'term-1' }] });
    upd({ sessionUpdate: 'tool_call', toolCallId: 'rich-search', title: 'Search for TODO', kind: 'search', status: 'failed' });
    upd({ sessionUpdate: 'tool_call', toolCallId: 'rich-bash', title: 'cd proj && python - <<EOF', kind: 'execute', status: 'completed',
      rawInput: { command: "cd /c/proj && python - <<'EOF'\nimport os\nprint(os.getcwd())  # where\nEOF", description: 'Print the working directory', timeout: 120000, run_in_background: false },
      rawOutput: 'C:\\proj\n' });
    upd({ sessionUpdate: 'agent_message_chunk', content: { type: 'resource_link', name: 'Docs', uri: 'https://example.org/docs', mimeType: 'text/html', size: 2048 } });
    upd({ sessionUpdate: 'agent_message_chunk', content: { type: 'resource_link', name: 'config.py', uri: 'file:///C:/proj/config.py', mimeType: 'text/x-python' } });
    upd({ sessionUpdate: 'agent_message_chunk', content: { type: 'resource', resource: { uri: 'file:///C:/proj/notes.txt', mimeType: 'text/plain', text: 'embedded note line 1\nline 2' } } });
    upd({ sessionUpdate: 'agent_message_chunk', content: { type: 'resource', resource: { uri: 'file:///C:/proj/data.bin', mimeType: 'application/octet-stream', blob: 'AAECAwQF' } } });
    result(promptKey, { stopReason: 'end_turn' });
  }

  let allowCount = 0;
  const textOf = (blocks) => (blocks || []).find((b) => b.type === 'text')?.text ?? '';
  const userText = (blocks) => (blocks || []).find((b) => b.type === 'text' && !(b.text ?? '').startsWith('<studio-context>'))?.text ?? '';
  const startsAny = (text, list) => list.some((p) => text.startsWith(p));
  const YES_ALWAYS_NO = [{ optionId: 'yes', name: 'Yes', kind: 'allow_once' }, { optionId: 'always', name: 'Yes, always', kind: 'allow_always' }, { optionId: 'no', name: 'No', kind: 'reject_once' }];

  /** Allow rules: 'allow:<command>' asks like claude-agent-acp's Bash; 'allowcodex:<command>' asks like codex-acp (kind execute, rawInput.command, no tool name). */
  function allowPrompt(key, params) {
    const text = textOf(params.prompt ?? []);
    if (text.startsWith('allowraw:')) {
      // 'allowraw:<json>' replays a request recorded from a real agent (work/deno/gemini_acp_permission_shapes.json and the Antigravity one)
      const rawReq = JSON.parse(partition(text, ':')[2]);
      allowCount++;
      const rid = `allow-${allowCount}`;
      waiting[rid] = key;
      if (rawReq.update) update(rawReq.update);
      emit({ id: rid, method: 'session/request_permission', params: { sessionId: SID(), toolCall: rawReq.toolCall, options: rawReq.options } });
      return true;
    }
    if (!startsAny(text, ['allow:', 'allowcodex:', 'allowedit:', 'allowcodexedit:'])) return false;
    const claude = text.startsWith('allow:') || text.startsWith('allowedit:');
    const command = partition(text, ':')[2];
    allowCount++;
    const tool = `allow-tool-${allowCount}`;
    const rid = `allow-${allowCount}`;
    waiting[rid] = key;
    if (text.startsWith('allowcodexedit:')) {
      // 'allowcodexedit:<path>' asks like codex-acp 2.6's file edit on Windows: kind edit, title "Edit files", the path in locations, no rawInput
      const call = { toolCallId: `exec-edit-${allowCount}`, title: 'Edit files', locations: [{ path: command }], kind: 'edit', status: 'pending' };
      const options = [{ optionId: 'allow_once', name: 'Yes, proceed', kind: 'allow_once' }, { optionId: 'allow_for_session', name: "Yes, and don't ask again for these files", kind: 'allow_always' }, { optionId: 'cancel', name: 'No, and tell Codex what to do differently', kind: 'reject_once' }];
      emit({ id: rid, method: 'session/request_permission', params: { sessionId: SID(), toolCall: call, options } });
      return true;
    }
    if (text.startsWith('allowedit:')) {
      // 'allowedit:<path>' asks like claude-agent-acp's Edit (the file path as the agent gave it)
      const call = { toolCallId: tool, kind: 'edit', title: 'Edit ' + command, rawInput: { file_path: command, old_string: 'a', new_string: 'b' }, status: 'pending' };
      update({ sessionUpdate: 'tool_call', ...call, _meta: { claudeCode: { toolName: 'Edit' } } });
      emit({ id: rid, method: 'session/request_permission', params: { sessionId: SID(), toolCall: call, options: YES_ALWAYS_NO } });
      return true;
    }
    const call = { toolCallId: tool, kind: 'execute', title: command, rawInput: { command }, status: 'pending' };
    if (claude) update({ sessionUpdate: 'tool_call', ...call, _meta: { claudeCode: { toolName: 'Bash' } } });
    emit({ id: rid, method: 'session/request_permission', params: { sessionId: SID(), toolCall: call, options: YES_ALWAYS_NO } });
    return true;
  }

  function malformedPrompt(key, params) {
    // Each line below violates (or extends) ACP v1 in one specific way; see work/deno/acp_schema_test.ts and connection_test.ts.
    const text = textOf(params.prompt);
    if (text === 'die') {
      exitAfterFlush(3);
      return true;
    }
    if (text === 'badstop') {
      result(key, { stopReason: 42 });
      return true;
    }
    if (text !== 'junk') return false;
    const upd = (body, sid = fakeSession) => raw(pyDumps({ jsonrpc: '2.0', method: 'session/update', params: { ...(sid ? { sessionId: sid } : {}), update: body } }));
    raw('this is not json');
    raw('[1, 2, 3]');
    raw(pyDumps({ method: 'session/update', params: {} }));
    raw(pyDumps({ jsonrpc: '2.0', id: 99, result: {}, error: { code: 1, message: 'both' } }));
    raw(pyDumps({ jsonrpc: '2.0', method: 7 }));
    upd({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'no session id' } }, null);
    upd({ sessionUpdate: 'agent_message_chunk', content: 'not a block' });
    upd({ sessionUpdate: 'tool_call', toolCallId: 5, title: 'x' });
    upd({ sessionUpdate: 'plan', entries: 'nope' });
    upd({ sessionUpdate: 'future_kind_v9', anything: true });
    upd({ sessionUpdate: 'future_kind_v9', anything: false });
    upd({ sessionUpdate: 'agent_message_chunk', content: { type: 'future_block', x: 1 } });
    upd({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'valid after junk' } });
    emit({ id: 'bad-perm', method: 'session/request_permission', params: { sessionId: SID(), toolCall: { toolCallId: 't' }, options: 'none' } });
    emit({ id: 'nope', method: 'fs/read_text_file', params: { sessionId: SID(), path: 'x' } });
    raw(pyDumps({ jsonrpc: '2.0', id: 98765, result: {} }));
    raw(pyDumps({ jsonrpc: '2.0', id: String(key), result: { stopReason: 'end_turn' } }));
    result(key, { stopReason: 'end_turn' });
    result(key, { stopReason: 'end_turn' });
    return true;
  }

  const DEMO_WORDS = ['stream', 'html', 'plan', 'help'];
  const DEMO_HELP = 'Trigger words (send one alone as the whole message): stream = several messages one after another; '
    + 'html = writes outputs/demo-page.html in the chat folder (appears in Artifacts); plan = a task list; '
    + 'approve = asks you to allow a tool; form = asks a question; wait = never answers until you stop it; '
    + 'sleep:5 = works for 5 seconds; delegate = starts a background agent; anything else = a rich reply with tool calls.';
  const demoHtml = (count) => '<!doctype html><meta charset="utf-8"><title>Demo page</title>'
    + '<body style="font:16px system-ui;margin:2rem"><h1>Demo page</h1>'
    + `<p>Written by the fixture agent, version ${count}.</p><ul><li>alpha</li><li>beta</li><li>gamma</li></ul></body>`;

  /** Scripted demo behaviours. Runs as a thread so cancel still works; the turn ends with end_turn or cancelled. */
  function demoTurn(key, word) {
    waiting.turn = key;
    thread(async () => {
      const alive = () => waiting.turn === key;
      if (word === 'help') say(DEMO_HELP);
      else if (word === 'stream') {
        for (let index = 1; index < 6; index++) {
          if (!alive()) return;
          say(`Streaming message ${index} of 5. `);
          await sleep(700);
        }
      } else if (word === 'plan') {
        const entries = [['Read the code', 'completed'], ['Write the change', 'in_progress'], ['Run the tests', 'pending'], ['Summarise', 'pending']];
        update({ sessionUpdate: 'plan', entries: entries.map(([content, status]) => ({ content, priority: 'medium', status })) });
        say('Here is the plan.');
      } else if (word === 'html') {
        const folder = path.join(sessionCwd || process.cwd(), 'outputs');
        fs.mkdirSync(folder, { recursive: true });
        const file = path.join(folder, 'demo-page.html');
        let count = 1;
        if (exists(file)) {
          const match = /version (\d+)/.exec(fs.readFileSync(file, 'utf8'));
          count = match ? Number(match[1]) + 1 : 2;
        }
        const body = demoHtml(count);
        fs.writeFileSync(file, body, 'utf8');
        update({ sessionUpdate: 'tool_call', toolCallId: `demo-write-${count}`, title: 'Write outputs/demo-page.html', kind: 'edit', status: 'completed',
          locations: [{ path: file }], content: [{ type: 'diff', path: file, oldText: null, newText: body }] });
        say(`Wrote outputs/demo-page.html (version ${count}). It shows up in the Artifacts panel in a moment.`);
      }
      if (alive()) {
        delete waiting.turn;
        result(key, { stopReason: 'end_turn' });
      }
    });
  }

  const WORKTREE_COMMANDS = ['edit:', 'delete:', 'commit:', 'say:', 'context', 'call-tool:'];

  /**
   * Turn commands that act in the session folder (the chat's worktree), used by the worktree e2e tests:
   * edit:<relpath>|<text>   write the file (a literal \n in the text is a newline; a relative path is inside the session folder)
   * delete:<relpath>        remove the file
   * commit:<message>        git add -A, git commit in the session folder (reports the new HEAD)
   * say:<text>              just answer
   * context                 answer with the <studio-context> note this prompt carried ('none' when it had none)
   * call-tool:<action>[:<conversation id>]   call Studio's worktree tool (merge | check | keep_mine | leave) with this chat's own key and,
   *                         if given, another conversation's id (the key must not work for it); reports 'TOOL <status> <json>'
   */
  async function worktreeTurn(key, promptText, blocks) {
    const cwd = sessionCwd || process.cwd();
    if (promptText.startsWith('edit:')) {
      const [rel, , text] = partition(promptText.slice(5), '|');
      const target = path.resolve(cwd, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, Buffer.from(text.replaceAll('\\n', '\n'), 'utf8'));
      update({ sessionUpdate: 'tool_call', toolCallId: `edit-${nextEditId()}`, title: 'Write ' + rel, kind: 'edit', status: 'completed', content: [{ type: 'diff', path: target, oldText: null, newText: text }] });
      say('edited ' + rel);
    } else if (promptText.startsWith('delete:')) {
      fs.unlinkSync(path.resolve(cwd, promptText.slice(7)));
      say('deleted ' + promptText.slice(7));
    } else if (promptText.startsWith('commit:')) {
      // the repository's own line-ending setting applies, as for a real agent
      const git = ['-c', 'user.name=fake-agent', '-c', 'user.email=t@t'];
      const opts = { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true };
      execFileSync('git', [...git, 'add', '-A'], opts);
      execFileSync('git', [...git, 'commit', '-m', promptText.slice(7)], opts);
      let head = '';
      try {
        head = execFileSync('git', ['rev-parse', 'HEAD'], opts).toString('utf8').trim();
      } catch { /* empty */ }
      say('committed ' + head);
    } else if (promptText.startsWith('say:')) say(promptText.slice(4));
    else if (promptText === 'context') {
      const note = (blocks || []).find((b) => b.type === 'text' && (b.text ?? '').startsWith('<studio-context>'))?.text ?? '';
      say('CONTEXT ' + (note || 'none'));
    } else {
      const [action, , other] = partition(promptText.slice('call-tool:'.length), ':');
      let senv = {};
      for (const server of lastMcp || []) {
        if (server.name === 'studio_artifact') senv = Object.fromEntries((server.env || []).map((e) => [e.name, e.value]));
      }
      let base = senv.STUDIO_ARTIFACT_URL || '';
      if (!base && senv.STUDIO_ARTIFACT_URL_FILE) base = fs.readFileSync(senv.STUDIO_ARTIFACT_URL_FILE, 'utf8').trim();
      const body = pyDumps({ conversationId: other || senv.STUDIO_CONVERSATION_ID || '', action });
      // node:http, not fetch: fetch adds Sec-Fetch-* headers, which the agent-tool routes refuse (the Python fake's urllib sent none)
      const [status, reply] = await new Promise((resolve, reject) => {
        const request = http.request(base.replace(/\/+$/, '') + '/api/live/worktree/tool', {
          method: 'POST', timeout: 120000,
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-Studio-Artifact-Key': senv.STUDIO_ARTIFACT_KEY || '' },
        }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve([res.statusCode, Buffer.concat(chunks).toString('utf8')]));
        });
        request.on('timeout', () => request.destroy(new Error('timed out')));
        request.on('error', reject);
        request.end(body);
      });
      say(`TOOL ${status} ${reply}`);
    }
    result(key, { stopReason: 'end_turn' });
  }

  function capsNext() {
    const run = capsRun;
    if (run.results.length >= run.steps.length) {
      capsRun = null;
      emit({ method: 'session/update', params: { sessionId: SID(), update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'CAPS-RESULTS ' + pyDumps(run.results) } } } });
      result(run.turn, { stopReason: 'end_turn' });
      return;
    }
    const step = run.steps[run.results.length];
    const params = JSON.parse(pyDumps(step.params ?? {}).replaceAll('"$term"', () => pyDumps(run.terminal ?? null)));
    if (!('sessionId' in params)) params.sessionId = fakeSession;
    emit({ id: `cap-${run.results.length}`, method: step.method, params });
  }

  const held = {}; // --held-turn: 'turn' = the prompt whose response is held; 'helper-perm' = the helper's open permission (an Ev)

  /** 'bgshell:<gate>' (--held-turn): Bash with run_in_background, as claude-agent-acp 0.97.0 sent it to a client without the AIR asyncTasks capability. */
  async function backgroundShell(key, gate, human) {
    const tool = 'bash-1';
    const claude = { claudeCode: { toolName: 'Bash' } };
    update({ sessionUpdate: 'usage_update', size: 200000, used: 1000 });
    update({ sessionUpdate: 'tool_call', toolCallId: tool, name: 'Bash', rawInput: {}, status: 'pending', title: 'Terminal', kind: 'execute', content: [], _meta: claude });
    update({ sessionUpdate: 'tool_call_update', toolCallId: tool, rawInput: { command: 'npm test', run_in_background: true }, title: 'npm test', _meta: claude });
    await sleep(200);
    const shell = popen(process.execPath, ['-e', WAIT_FOR_FILE, gate], { stdio: 'ignore' });
    if (args.child_pid_file) fs.writeFileSync(args.child_pid_file + '.shell', String(shell.pid));
    update({ sessionUpdate: 'tool_call_update', toolCallId: tool, _meta: { claudeCode: { toolResponse: { stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: 'bfake1' }, toolName: 'Bash' } } });
    update({ sessionUpdate: 'tool_call_update', toolCallId: tool, status: 'completed', rawOutput: 'Command running in background with ID: bfake1. Output is being written to: tasks/bfake1.output. You will be notified when it completes.', content: [{ type: 'content', content: { type: 'text', text: 'Command running in background with ID: bfake1.' } }], _meta: claude });
    say('Started the tests in the background.');
    update({ sessionUpdate: 'usage_update', size: 200000, used: 1500, _meta: human });
    result(key, { stopReason: 'end_turn' });
    thread(async () => {
      await shell.wait();
      say('The tests finished.'); // Claude Code's own cycle
      update({ sessionUpdate: 'usage_update', size: 200000, used: 1800, _meta: { '_claude/origin': { kind: 'task-notification', producer: 'session-task' } } });
    });
  }

  /** --held-turn prompts (see the flag's help in work/fake_acp.py): the shape of claude-agent-acp's updates, as a real run showed them. */
  async function heldTurn(key, text) {
    if ('turn' in held) { // the adapter settles a held turn when the next prompt arrives
      const t = held.turn;
      delete held.turn;
      result(t, { stopReason: 'end_turn' });
    }
    const human = { '_claude/origin': { kind: 'human' } };
    if (text.startsWith('bgshell:')) {
      await backgroundShell(key, partition(text, ':')[2], human);
      return;
    }
    if (text === 'approve') { // a permission on the main session; its answer ends the turn (the 'approve-test' answer below)
      waiting.permission = key;
      emit({ id: 'approve-test', method: 'session/request_permission', params: { sessionId: SID(), toolCall: { title: 'Fixture approval', toolCallId: 'fake-tool' }, options: [{ optionId: 'yes', name: 'Allow once', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }] } });
      return;
    }
    // Inbox v3.1 stalled: 'silent:<title>' ends its turn right after a tool call, with no final words; 'die:<title>' starts a tool call and
    // exits mid-turn; 'quiet:<gate>' makes one tool call, then sends nothing at all until <gate> exists, then ends with a reply.
    if (startsAny(text, ['silent:', 'die:', 'quiet:'])) {
      const [verb, , rest] = partition(text, ':');
      const title = verb !== 'quiet' ? rest : 'Read server/main.ts';
      say('Working on it.');
      update({ sessionUpdate: 'tool_call', toolCallId: 'stall-' + verb, title, kind: 'execute', status: 'in_progress' });
      if (verb === 'die') {
        exitAfterFlush(3);
        return;
      }
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'stall-' + verb, status: 'completed' });
      if (verb === 'silent') {
        result(key, { stopReason: 'end_turn' });
        return;
      }
      thread(async () => {
        const deadline = Date.now() + 300000;
        while (!exists(rest) && Date.now() < deadline) await sleep(20);
        say('Fixture reply: awake');
        result(key, { stopReason: 'end_turn' });
      });
      return;
    }
    if (text.startsWith('gate:')) { // a turn that ends (reply, result) once the test creates the named file
      thread(async () => {
        const deadline = Date.now() + 300000;
        while (!exists(text.slice(5)) && Date.now() < deadline) await sleep(20);
        say('Fixture reply: gate');
        update({ sessionUpdate: 'usage_update', size: 200000, used: 2000, _meta: human });
        result(key, { stopReason: 'end_turn' });
      });
      return;
    }
    if (!(text.startsWith('helper:') || text.startsWith('helper-ask:'))) {
      say('Fixture reply: ' + text);
      update({ sessionUpdate: 'usage_update', size: 200000, used: 2000, _meta: human });
      result(key, { stopReason: 'end_turn' });
      return;
    }
    const ask = text.startsWith('helper-ask:');
    const gate = partition(text, ':')[2];
    const child = 'helper-1';
    update({ sessionUpdate: 'usage_update', size: 200000, used: 1000 }); // usage during the turn: no origin
    update({ sessionUpdate: 'tool_call', toolCallId: 'agent-1', title: 'Agent', kind: 'think', status: 'pending', _meta: { claudeCode: { toolName: 'Agent' } } });
    update({ sessionUpdate: 'subagent_update', sessionId: child, title: 'Background helper', capabilities: { cancel: {} }, state: { state: 'running' } });
    // The helper's own config, on its session (claude-agent-acp's subagent form: the Agent input's model, its mode and type).
    updateOn(child, { sessionUpdate: 'config_option_update', configOptions: [
      { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'bypassPermissions', options: [{ value: 'bypassPermissions', name: 'Bypass permissions' }] },
      { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'sonnet', options: [{ value: 'sonnet', name: 'Sonnet 5.5' }] },
      { id: 'agent', name: 'Agent', type: 'select', currentValue: 'general-purpose', options: [{ value: 'general-purpose', name: 'general-purpose' }] }],
    _meta: { claudeCode: { parentToolUseId: 'agent-1' } } });
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'agent-1', status: 'completed' });
    say('Started a helper.');
    update({ sessionUpdate: 'usage_update', size: 200000, used: 1500 });
    update({ sessionUpdate: 'usage_update', size: 200000, used: 1500, _meta: human }); // the result: the reply ended
    held.turn = key;
    const parent = { claudeCode: { parentToolUseId: 'agent-1' } };
    thread(async () => {
      const deadline = Date.now() + 300000;
      while (!exists(gate) && Date.now() < deadline) await sleep(20);
      updateOn(child, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'helper at work' }, _meta: parent });
      if (ask) {
        const answered = new Ev();
        held['helper-perm'] = answered;
        emit({ id: 'helper-perm', method: 'session/request_permission', params: { sessionId: child, toolCall: { title: 'Helper approval', toolCallId: 'helper-tool' }, options: [{ optionId: 'yes', name: 'Allow once', kind: 'allow_once' }] } });
        await answered.wait(300000);
        updateOn(child, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'helper approved' }, _meta: parent });
      }
      update({ sessionUpdate: 'subagent_update', sessionId: child, state: { state: 'idle', stopReason: 'end_turn' } });
      update({ sessionUpdate: 'usage_update', size: 200000, used: 1700 });
      say('Helper finished.'); // Claude Code's own follow-up
      while (!exists(gate + '.end') && Date.now() < deadline) await sleep(20);
      update({ sessionUpdate: 'usage_update', size: 200000, used: 1800, _meta: { '_claude/origin': { kind: 'task-notification' } } });
      if (held.turn === key) {
        delete held.turn;
        result(key, { stopReason: 'end_turn' });
      }
    });
  }

  // ---- steer-on-send (--steer): replays work/steer-recordings --------------------------------------------------------------------------

  const steerCtx = { turn: null };
  const STEER_WAITER = [
    "const fs=require('fs'),cp=require('child_process');",
    'const gate=process.argv[1];',
    'const deadline=Date.now()+300000;',
    'if(process.argv.length<3){',
    "  const leaf=cp.spawn(process.execPath,['-e',fs.readFileSync(gate+'.waiter.js','utf8'),gate,'leaf'],{stdio:'ignore',windowsHide:true,detached:process.platform==='win32'});",
    "  fs.writeFileSync(gate+'.pids',process.pid+' '+leaf.pid);",
    '}',
    'while(!fs.existsSync(gate)&&Date.now()<deadline)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50);',
    'process.exit(0);',
  ].join('\n') + '\n';
  const STEER_PLAIN_EXCLUDED = ['write:', 'edit:', 'delete:', 'commit:', 'say:', 'context', 'call-tool:', 'caps:', 'bulk:', 'stream:', 'sleep:', 'gate:', 'leave-open', 'url',
    'wait', 'form', 'approve', 'child-ask', 'agent-cancel', 'mcp', '/compact', 'delegate', 'settings?', 'model?'];

  /** The 'command': a real process with a real child (<gate>.pids = 'parent leaf'), alive until <gate> exists (or 300 s), so a Stop can be checked to kill exactly these. */
  function steerCommand(gate) {
    fs.writeFileSync(gate + '.waiter.js', STEER_WAITER);
    return popen(process.execPath, ['-e', STEER_WAITER, gate], { stdio: 'ignore' });
  }
  const steerOutcome = () => (args.steer === 'omp' ? { outcome: 'injected', queue: 'steering' } : { outcome: 'injected' });
  function steerBegin(key, onSteer = null) {
    const turn = { key, steers: [], cancel: new Ev(), open: true, on_steer: onSteer };
    steerCtx.turn = turn;
    return turn;
  }
  function steerEnd(turn, stop = 'end_turn') {
    turn.open = false;
    if (steerCtx.turn === turn) steerCtx.turn = null;
    result(turn.key, { stopReason: stop });
  }
  /** Wait for a steer ('steer'), the condition ('go'), a session/cancel ('cancel') or the deadline ('timeout'). */
  async function steerWait(turn, until, timeout = 300) {
    const deadline = Date.now() + timeout * 1000;
    while (Date.now() < deadline) {
      if (turn.cancel.isSet()) return 'cancel';
      if (turn.steers.length) return 'steer';
      if (until()) return 'go';
      await sleep(20);
    }
    return 'timeout';
  }
  const steerSay = (text) => say(text);
  /** A usage_update. Claude marks the end of a reply with origin human (one per steered reply: a prompt can carry two) or task-notification. */
  function steerUsage(origin = null, used = 1000) {
    const body = { sessionUpdate: 'usage_update', size: 200000, used };
    if (origin && args.steer === 'claude') body._meta = { '_claude/origin': origin };
    update(body);
  }
  const HUMAN = { kind: 'human' };

  /** _session/steering, as the three real adapters answer it (a recorded run each). */
  async function steerRequest(key, params) {
    const turn = steerCtx.turn;
    const text = steerText(params);
    if (turn && turn.open && turn.late) { // X3: the adapter answers promptRequired a few ms before the turn's end_turn arrives
      result(key, { outcome: 'promptRequired', reason: 'noRunningTurn' });
      steerUsage(HUMAN, 1600);
      await sleep(10);
      steerEnd(turn);
      return;
    }
    if (turn && turn.open) {
      turn.steers.push(text);
      if (turn.on_steer) turn.on_steer(text);
      result(key, steerOutcome());
      return;
    }
    if (waiting.turn || waiting.permission) { // an existing fixture turn (gate:, sleep:, wait, approve) counts as a running turn
      if (args.steer === 'omp' && waiting.permission) emit({ method: '$/cancel_request', params: { requestId: 'approve-test' } });
      result(key, steerOutcome());
      steerSay('Steered reply: ' + text);
      return;
    }
    const behavior = ((params._meta || {}).steering || {}).idleBehavior;
    if (args.steer === 'claude' && behavior !== 'promptRequired') { // without idleBehavior the adapter starts a turn nobody asked for (C3)
      result(key, { outcome: 'startedNewTurn' });
      steerSay('Steered reply: ' + text);
      steerUsage(HUMAN);
      return;
    }
    result(key, { outcome: 'promptRequired', reason: 'noRunningTurn' });
  }
  function steerText(params) {
    return ((params.prompt || []).find((b) => b.type === 'text' && !(b.text ?? '').startsWith('<studio-context>')) || {}).text ?? '';
  }

  /** The recorded scenarios by prompt. True if the prompt was one of them (or a plain message of a steerable fixture). */
  function steerScenario(key, text) {
    const [verb, , rest] = partition(text, ':');
    if (verb === 'steer-bash') thread(() => steerBash(key, rest));
    else if (verb === 'steer-helper') thread(() => steerHelper(key, rest));
    else if (text === 'steer-perm') thread(() => steerPerm(key));
    else if (text === 'steer-perm-helper') thread(() => steerPermHelper(key));
    else if (['steer-wait', 'steer-drop', 'steer-late'].includes(verb)) thread(() => steerWaitTurn(key, rest, verb));
    else if (!startsAny(text, STEER_PLAIN_EXCLUDED) && !args.rich && !args.demo && !args.held_turn) {
      steerSay('Fixture reply: ' + text);
      steerUsage(HUMAN);
      result(key, { stopReason: 'end_turn' });
    } else return false;
    return true;
  }

  /** Plain work until <gate> exists. Steers get a reply at once and the turn goes on; with drop (Codex v1 at the turn's end) they are never read. */
  async function steerWaitTurn(key, gate, verb) {
    const reply = async (t) => {
      await sleep(50);
      steerSay('Steered reply: ' + t);
      steerUsage(HUMAN, 1500);
    };
    const drop = verb === 'steer-drop';
    const turn = steerBegin(key, drop ? null : (t) => thread(() => reply(t)));
    turn.late = verb === 'steer-late';
    steerSay('Working. ');
    let state;
    for (;;) {
      state = await steerWait(turn, () => exists(gate));
      if (state === 'steer') {
        turn.steers.length = 0;
        continue;
      }
      break;
    }
    if (state === 'cancel') {
      steerEnd(turn, 'cancelled');
      return;
    }
    if (!turn.open) return; // steer-late: the turn already ended
    if (!drop) steerSay('Finished. '); // drop: the turn ends with no output after the steer (codex-acp v1 turn/completed)
    steerUsage(HUMAN);
    steerEnd(turn);
  }

  /** A foreground command, then a steer: C1 (Claude backgrounds it, toolResponse.backgroundTaskId), X1 (Codex answers; the command runs on and its
   * update arrives after end_turn), O1 (OMP backgrounds it: card completed, then in_progress again, details.async). */
  async function steerBash(key, gate) {
    const who = args.steer;
    const tool = { codex: 'exec-steer-bash' }[who] ?? 'toolu_steer_bash';
    const command = 'for i in $(seq 1 60); do echo tick $i; sleep 1; done; echo finished';
    const turn = steerBegin(key);
    const claude = { claudeCode: { toolName: 'Bash' } };
    if (who === 'claude') {
      steerUsage(null, 25000);
      update({ sessionUpdate: 'tool_call', toolCallId: tool, name: 'Bash', rawInput: {}, status: 'pending', title: 'Terminal', kind: 'execute', content: [], _meta: claude });
      update({ sessionUpdate: 'tool_call_update', toolCallId: tool, rawInput: { command, description: 'Tick loop' }, title: command, _meta: claude });
    } else if (who === 'codex') {
      update({ sessionUpdate: 'tool_call', toolCallId: tool, name: 'exec_command', kind: 'execute', title: command, status: 'in_progress', content: [{ type: 'terminal', terminalId: tool }],
        rawInput: { command, cwd: sessionCwd }, _meta: { terminal_info: { cwd: sessionCwd, terminal_id: tool } } });
    } else update({ sessionUpdate: 'tool_call', toolCallId: tool, status: 'pending', title: '$ ' + command, kind: 'execute', rawInput: { command } });
    const child = steerCommand(gate);
    let ticks = 0;
    let backgrounded = false;
    thread(async () => { // the running output, until the command ends
      while (child.poll() === null && !turn.cancel.isSet()) {
        ticks++;
        if (who === 'codex') update({ sessionUpdate: 'tool_call_update', toolCallId: tool, _meta: { terminal_output_delta: { data: `tick${ticks}\r\n`, terminal_id: tool } } });
        else if (who === 'omp') {
          const details = backgrounded ? { async: { state: 'running', jobId: 'bg_1', type: 'bash' } } : {};
          update({ sessionUpdate: 'tool_call_update', toolCallId: tool, status: 'in_progress',
            rawOutput: { content: [{ type: 'text', text: Array.from({ length: ticks }, (_, i) => `tick ${i + 1}\n`).join('') }], details } });
        }
        await sleep(500);
      }
    });
    // Claude Code's Ctrl+B: a test creates <gate>.bg and the running command moves to the background (AIB never sends a steer into a
    // running Claude command, which Claude Code would abort, so a steer no longer moves it).
    const state = await steerWait(turn, () => child.poll() !== null || (who === 'claude' && exists(gate + '.bg')));
    const ctrlB = who === 'claude' && child.poll() === null && exists(gate + '.bg');
    if (state === 'cancel') { // Interrupt: a foreground command dies with it
      if (child.poll() === null) child.kill();
      steerEnd(turn, 'cancelled');
      return;
    }
    if (state !== 'steer' && !ctrlB) { // nobody steered: the command ends, the reply follows
      if (who === 'claude') update({ sessionUpdate: 'tool_call_update', toolCallId: tool, status: 'completed', rawOutput: 'tick 60\nfinished', _meta: claude });
      else if (who === 'codex') update({ sessionUpdate: 'tool_call_update', toolCallId: tool, name: 'exec_command', status: 'completed', _meta: { terminal_exit: { exit_code: child.returncode, signal: null, terminal_id: tool } } });
      else if (who === 'omp') update({ sessionUpdate: 'tool_call_update', toolCallId: tool, status: 'completed', rawOutput: { content: [{ type: 'text', text: 'finished' }], details: {} } });
      steerSay('The command finished.');
      steerUsage(HUMAN);
      steerEnd(turn);
      return;
    }
    await sleep(300);
    const asked = turn.steers.slice();
    if (who === 'claude') {
      update({ sessionUpdate: 'tool_call_update', toolCallId: tool, _meta: { claudeCode: { toolResponse: { stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false,
        backgroundTaskId: 'bsteer1', backgroundedToDeliverMessage: true }, toolName: 'Bash' } } });
      update({ sessionUpdate: 'tool_call_update', toolCallId: tool, status: 'completed', _meta: claude,
        rawOutput: 'Command was moved to the background (ID: bsteer1) so that a message that arrived while it was running can reach you; it was not interrupted. Output is being written to: tasks/bsteer1.output. You can stop it with TaskStop; it is stopped after 30m in the background.' });
    } else if (who === 'omp') {
      backgrounded = true;
      const note = 'tick 1\n\nBackgrounded early to handle an incoming message; the command keeps running.\n\nBackgrounded as job bg_1 (killed once it has run 120s in total; `timeout: 0` disables the deadline); its output is injected into the conversation as a follow-up the moment it finishes.';
      update({ sessionUpdate: 'tool_call_update', toolCallId: tool, status: 'completed',
        rawOutput: { content: [{ type: 'text', text: note }], details: { async: { state: 'running', jobId: 'bg_1', type: 'bash' }, timeoutSeconds: 120 } },
        content: [{ type: 'content', content: { type: 'text', text: '$ ' + command } }, { type: 'content', content: { type: 'text', text: note } }] });
    }
    for (const t of asked) steerSay('Steered reply: ' + t);
    steerUsage(null, 34000);
    if (who === 'claude') steerUsage(HUMAN, 34000); // one human usage_update per steered reply
    if (who === 'codex') update({ sessionUpdate: 'session_info_update', _meta: { codex: { threadStatus: { type: 'idle' } } } });
    steerEnd(turn); // stopReason is end_turn for all three; the command still runs
    if (who === 'claude') {
      thread(async () => { // when it ends Claude Code starts its own cycle; the Bash card gets nothing more
        await child.wait();
        if (exists(gate + '.cycle-hold')) { // a test that wants to look at the autonomous cycle holds it until <gate>.cycle-end exists
          const deadline = Date.now() + 300000;
          steerSay('Reading the command output. ');
          while (!exists(gate + '.cycle-end') && Date.now() < deadline) await sleep(20);
        }
        steerSay('The command finished.');
        steerUsage({ kind: 'task-notification', producer: 'session-task', runId: 'steer-run' });
      });
    } else if (who === 'codex') {
      thread(async () => { // the tool update arrives after the turn, no follow-up turn
        const code = await child.wait();
        update({ sessionUpdate: 'tool_call_update', toolCallId: tool, name: 'exec_command', status: 'completed', _meta: { terminal_exit: { exit_code: code, signal: null, terminal_id: tool } } });
      });
    }
  }

  /** C2 (Claude): a foreground helper; a steer backgrounds it (session_message ':reply'), the reply ends with a human usage_update, but the prompt is
   * held until the helper finished (subagent idle, follow-up cycle, task-notification usage_update, end_turn). */
  async function steerHelper(key, gate) {
    const child = 'steer-helper-1';
    const tool = 'toolu_steer_agent';
    const turn = steerBegin(key);
    steerUsage(null, 25700);
    update({ sessionUpdate: 'tool_call', toolCallId: tool, title: 'Agent', kind: 'think', status: 'pending', _meta: { claudeCode: { toolName: 'Agent' } } });
    update({ sessionUpdate: 'subagent_update', sessionId: child, title: 'general-purpose', description: 'Run foreground tick loop', capabilities: { cancel: {} }, state: { state: 'running' } });
    update({ sessionUpdate: 'session_message', messageId: tool, senderSessionId: SID(), recipientSessionId: child, content: [{ type: 'text', text: 'Run the tick loop in the foreground.' }] });
    const helperCmd = steerCommand(gate);
    const state = await steerWait(turn, () => helperCmd.poll() !== null);
    if (state === 'cancel') {
      if (helperCmd.poll() === null) helperCmd.kill();
      steerEnd(turn, 'cancelled');
      return;
    }
    const asked = turn.steers.slice();
    if (asked.length) {
      update({ sessionUpdate: 'session_message', messageId: tool + ':reply', senderSessionId: child, recipientSessionId: SID(), content: [{ type: 'text', text: 'Async agent launched successfully.' }] });
      for (const t of asked) steerSay('Steered reply: ' + t);
      steerUsage(null, 34900);
      steerUsage(HUMAN);
      while (helperCmd.poll() === null && !turn.cancel.isSet()) await sleep(20); // the prompt stays held until the helper finished
    }
    if (turn.cancel.isSet()) {
      steerEnd(turn, 'cancelled');
      return;
    }
    update({ sessionUpdate: 'tool_call_update', toolCallId: tool, status: 'completed' });
    update({ sessionUpdate: 'subagent_update', sessionId: child, state: { state: 'idle', stopReason: 'end_turn' } });
    steerSay('The helper finished.');
    steerUsage(null, 35500);
    steerUsage(asked.length ? { kind: 'task-notification', producer: 'session-task' } : HUMAN);
    steerEnd(turn);
  }

  /** A permission card is open when the steer arrives. Claude (C4): injected, card stays, answered later: the first cycle ends (human usage_update),
   * the steer gets its own cycle (a second human usage_update), one end_turn. OMP (O2): the card is cancelled ($/cancel_request, tool failed
   * 'superseded by user steering') and the model asks again. Codex: like Claude, one reply. */
  async function steerPerm(key) {
    const tool = 'toolu_steer_perm';
    const answers = {};
    steerCtx.answers = answers;
    const turn = steerBegin(key);
    update({ sessionUpdate: 'tool_call', toolCallId: tool, title: 'echo hello > note.txt', kind: 'execute', status: 'pending' });
    const ask = (requestId) => {
      delete answers[requestId];
      answers[requestId + ':event'] = new Ev();
      emit({ id: requestId, method: 'session/request_permission', params: { sessionId: SID(), toolCall: { toolCallId: tool, title: 'echo hello > note.txt', kind: 'execute', status: 'pending', rawInput: { command: 'echo hello > note.txt' } },
        options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' }] } });
    };
    const answered = async (requestId, timeout = 600) => {
      const event = answers[requestId + ':event'];
      const deadline = Date.now() + timeout * 1000;
      while (!event.isSet() && Date.now() < deadline) {
        if (turn.cancel.isSet()) return 'cancelled';
        await sleep(20);
      }
      return answers[requestId];
    };
    ask('steer-perm');
    let outcome;
    if (args.steer === 'omp') {
      let state = await steerWait(turn, () => answers['steer-perm:event'].isSet());
      if (state === 'cancel') {
        steerEnd(turn, 'cancelled');
        return;
      }
      if (state === 'steer' && answers['steer-perm:event'].isSet()) state = 'go'; // answered first, then the steer (what AIB does when it held the message), both within one poll: no withdrawal
      if (state === 'steer') { // the card is withdrawn, the model asks again
        const asked = turn.steers.slice();
        emit({ method: '$/cancel_request', params: { requestId: 'steer-perm' } });
        update({ sessionUpdate: 'tool_call_update', toolCallId: tool, status: 'failed', rawOutput: { content: [{ type: 'text', text: 'Permission request superseded by user steering' }], details: {} } });
        await sleep(500);
        ask('steer-perm-2');
        const second = await answered('steer-perm-2');
        if (turn.cancel.isSet()) {
          steerEnd(turn, 'cancelled');
          return;
        }
        update({ sessionUpdate: 'tool_call_update', toolCallId: tool, status: second !== 'reject_once' ? 'completed' : 'failed', rawOutput: { content: [{ type: 'text', text: '(no output)' }], details: {} } });
        steerSay('done\n\n' + asked.map((t) => 'Steered reply: ' + t).join(' '));
        steerEnd(turn);
        return;
      }
      outcome = answers['steer-perm'];
    } else outcome = await answered('steer-perm');
    if (turn.cancel.isSet()) {
      steerEnd(turn, 'cancelled');
      return;
    }
    update({ sessionUpdate: 'tool_call_update', toolCallId: tool, status: outcome !== 'reject_once' ? 'completed' : 'failed', rawOutput: outcome !== 'reject_once' ? 'Shell cwd was reset' : 'Rejected' });
    await steerWait(turn, () => false, 1.0); // the model goes on for a moment: a steer that arrives now (a held one, released by the answer) is read in this turn
    if (turn.steers.length) await sleep(100);
    if (turn.cancel.isSet()) {
      steerEnd(turn, 'cancelled');
      return;
    }
    const asked = turn.steers.slice();
    steerSay('Done.');
    steerUsage(HUMAN);
    for (const t of asked) { // the steer's own cycle
      steerSay('Steered reply: ' + t);
      steerUsage(HUMAN);
    }
    steerEnd(turn);
  }

  /** A foreground helper (subagent session steer-perm-child) asks for approval while the main turn waits on it. claude-agent-acp takes a steer then at
   * priority 'later' (openUserInputs): injected, the card stays open, and the main agent reads the message once the helper goes on. */
  async function steerPermHelper(key) {
    const child = 'steer-perm-child';
    const tool = 'toolu_steer_perm_agent';
    const inner = 'toolu_steer_perm_inner';
    const answers = {};
    steerCtx.answers = answers;
    const turn = steerBegin(key);
    update({ sessionUpdate: 'tool_call', toolCallId: tool, title: 'Agent', kind: 'think', status: 'pending', _meta: { claudeCode: { toolName: 'Agent' } } });
    update({ sessionUpdate: 'subagent_update', sessionId: child, title: 'Explore', description: 'Look around', capabilities: { cancel: {} }, state: { state: 'running' } });
    update({ sessionUpdate: 'session_message', messageId: tool, senderSessionId: SID(), recipientSessionId: child, content: [{ type: 'text', text: 'Look around.' }] });
    updateOn(child, { sessionUpdate: 'tool_call', toolCallId: inner, title: 'echo hi > helper.txt', kind: 'execute', status: 'pending', _meta: { claudeCode: { toolName: 'Bash', parentToolUseId: tool } } });
    answers['steer-perm-helper:event'] = new Ev();
    emit({ id: 'steer-perm-helper', method: 'session/request_permission', params: { sessionId: child, toolCall: { toolCallId: inner, title: 'echo hi > helper.txt', kind: 'execute', status: 'pending', rawInput: { command: 'echo hi > helper.txt' },
      _meta: { claudeCode: { toolName: 'Bash', parentToolUseId: tool } } },
    options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' }] } });
    const event = answers['steer-perm-helper:event'];
    const deadline = Date.now() + 600000;
    while (!event.isSet() && Date.now() < deadline && !turn.cancel.isSet()) await sleep(20);
    if (turn.cancel.isSet()) {
      steerEnd(turn, 'cancelled');
      return;
    }
    updateOn(child, { sessionUpdate: 'tool_call_update', toolCallId: inner, status: 'completed', rawOutput: '' });
    update({ sessionUpdate: 'tool_call_update', toolCallId: tool, status: 'completed' });
    update({ sessionUpdate: 'subagent_update', sessionId: child, state: { state: 'idle', stopReason: 'end_turn' } });
    steerSay('The helper finished.');
    steerUsage(HUMAN);
    for (const t of turn.steers.slice()) { // the steer's own cycle, after the card ('later')
      steerSay('Steered reply: ' + t);
      steerUsage(HUMAN);
    }
    steerEnd(turn);
  }

  // ---- the main loop -----------------------------------------------------------------------------------------------------------------

  const outcomeOf = (message) => {
    const o = (message.result || {}).outcome || {};
    return o;
  };
  const defaultMode = () => ({ currentModeId: 'code', availableModes: [{ id: 'code', name: 'Code' }] });

  async function handle(line) {
    if (receivedLog) fs.appendFileSync(receivedLog, line.endsWith('\n') ? line : line + '\n', 'utf8');
    const message = JSON.parse(line);
    const method = message.method;
    const key = message.id;
    const params = 'params' in message ? message.params : {};
    if (args.malformed && method === 'session/prompt' && malformedPrompt(key, params)) return;
    if (method === 'session/prompt' && allowPrompt(key, params)) return;
    if (method === undefined && typeof key === 'string' && key.startsWith('allow-') && key in waiting) {
      // allow rules: report what AIB answered, then end the turn
      const outcome = outcomeOf(message);
      const turnKey = waiting[key];
      delete waiting[key];
      say(`allow outcome=${outcome.optionId || outcome.outcome};`);
      result(turnKey, { stopReason: 'end_turn' });
      return;
    }
    if (args.malformed && method === undefined && (key === 'bad-perm' || key === 'nope')) {
      emit({ method: 'session/update', params: { sessionId: SID(), update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Fixture reply ${key}: ${(message.error || {}).code ?? 'None'}` } } } });
    } else if (method === 'initialize' && args.bad_initialize) {
      result(key, { protocolVersion: '1', agentCapabilities: [] });
    } else if ((method === 'session/new' || method === 'session/load') && args.bad_session === 'no-id') {
      result(key, { modes: null });
    } else if ((method === 'session/new' || method === 'session/load') && args.bad_session === 'bad-modes') {
      result(key, { sessionId: SID(), modes: { currentModeId: 5, availableModes: {} } });
    } else if (method === 'initialize') {
      const capabilities = { loadSession: true, promptCapabilities: { image: args.images, embeddedContext: args.embedded_context, audio: args.audio } };
      if (args.breadth) {
        capabilities.loadSession = !args.resume_only;
        capabilities.sessionCapabilities = { list: {}, close: {}, delete: {}, resume: {} };
        capabilities.mcpCapabilities = { http: args.mcp_http, sse: false };
      }
      if (args.list_sessions) (capabilities.sessionCapabilities ??= {}).list = {};
      if (args.fork) (capabilities.sessionCapabilities ??= {}).fork = {};
      if (args.extra_dirs) Object.assign(capabilities.sessionCapabilities ??= {}, { additionalDirectories: {}, systemPrompt: {} });
      if (args.held_turn && !args.not_claude) capabilities._meta = { claudeCode: { promptQueueing: true } };
      if (args.steer === 'claude') capabilities._meta = { claudeCode: { promptQueueing: true }, authStatus: {} };
      const init = { protocolVersion: args.protocol_version, agentCapabilities: capabilities };
      if (args.steer) {
        init._meta = { steering: { supported: true } };
        if (args.steer !== 'other') {
          init.agentInfo = { claude: { name: '@agentclientprotocol/claude-agent-acp', title: 'Claude Agent', version: '0.97.0' },
            codex: { name: '@agentclientprotocol/codex-acp', title: 'Codex', version: '2.6.0' },
            omp: { name: 'omp', title: 'omp', version: '18.13.1' } }[args.steer];
        }
      }
      const wantsTerminal = () => !!((((params || {}).clientCapabilities || {}).auth || {}).terminal);
      if (args.auth_required && args.beta_auth) {
        const terminal = wantsTerminal();
        init.authMethods = [{ id: 'gemini-api-key', name: 'Use an API key', description: 'Key in _meta.api-key' }];
        if (terminal) {
          const method2 = { id: 'fixture-terminal-login', name: 'Sign in in a terminal', type: 'terminal', args: ['--fixture-login'] };
          if (args.terminal_env) method2.env = { AIB_FIXTURE_LOGIN: 'from-agent' };
          init.authMethods.unshift(method2);
        }
      } else if (args.prompt_auth) {
        init.authMethods = [{ id: 'fixture-login', name: 'Fixture sign-in', description: 'In-app fixture sign-in' }];
        if (wantsTerminal()) {
          init.authMethods = [
            { id: 'claude-ai-login', name: 'Claude Subscription', description: 'Use Claude subscription', type: 'terminal', args: ['--fixture-login'] },
            { id: 'console-login', name: 'Anthropic Console', description: 'Use Anthropic Console', type: 'terminal', args: ['--fixture-login', '--fail-login'] }];
        }
      } else if (args.auth_required) {
        init.authMethods = [{ id: 'fixture-login', name: 'Fixture sign-in', description: 'In-app fixture sign-in' },
          { id: 'fixture-terminal', name: 'Fixture terminal login', description: 'Run in a terminal', _meta: { 'terminal-auth': { command: 'fixture-cli', args: ['login'] } } }];
      }
      result(key, init);
      if (args.setup_question) {
        emit({ id: 'setup-question', method: 'elicitation/create', params: {
          requestId: 'fixture-setup', mode: 'form', message: 'Fixture setup: confirm workspace label.',
          requestedSchema: { type: 'object', properties: { label: { type: 'string', title: 'Workspace label' } }, required: ['label'] } } });
      }
    } else if (method === 'authenticate' && args.beta_auth) {
      const keyGiven = params._meta && typeof params._meta === 'object' ? (params._meta['api-key'] || '') : '';
      if (params.methodId === 'gemini-api-key' && keyGiven) {
        authenticated = true;
        if (args.auth_file) fs.writeFileSync(args.auth_file, 'api key', 'utf8');
        result(key, {});
      } else emit({ id: key, error: { code: -32602, message: 'Fixture sign-in needs an API key in _meta.api-key' } });
    } else if (method === 'authenticate' && args.prompt_auth) {
      if (params.methodId === 'fixture-login' && !args.auth_reject) {
        if (args.auth_file) fs.writeFileSync(args.auth_file, 'signed in', 'utf8');
        result(key, {});
      } else emit({ id: key, error: { code: -32602, message: 'Fixture sign-in rejected' } });
    } else if (method === 'session/prompt' && args.prompt_auth && !(args.auth_file && exists(args.auth_file))) {
      say('Failed to authenticate: OAuth session expired and could not be refreshed');
      emit({ id: key, error: { code: -32000, message: 'Authentication required', data: { reason: 'auth_required' } } });
    } else if (method === 'authenticate') {
      if (args.auth_reject || params.methodId !== 'fixture-login') emit({ id: key, error: { code: -32602, message: 'Fixture sign-in rejected' } });
      else {
        authenticated = true;
        result(key, {});
      }
    } else if (method === 'session/fork') {
      if (args.fork_refuse) emit({ id: key, error: { code: -32603, message: 'Fixture fork refused' } });
      else {
        sessionName = fakeSession;
        sessionCwd = params.cwd || sessionCwd;
        lastMcp = params.mcpServers;
        const forked = { sessionId: sessionName, modes: structuredClone(modes) };
        if (args.breadth) forked.configOptions = configOptions;
        result(key, forked);
        if (args.breadth) breadthAnnounce();
      }
    } else if (method === 'session/new' || method === 'session/load') {
      if (!authOk()) emit({ id: key, error: { code: -32000, message: 'Authentication required', data: { reason: 'auth_required' } } });
      else if (args.setup_question && !setupAnswer) pendingSetup = [key, method, params];
      else if (args.setup_fail) emit({ id: key, error: { code: -32000, message: 'Fixture setup failure' } });
      else {
        sessionName = 'sessionId' in params ? params.sessionId : (args.new_session || fakeSession);
        sessionCwd = params.cwd || sessionCwd;
        lastMcp = params.mcpServers;
        if (mcpPids && method === 'session/new') startMcpServers(lastMcp);
        if (args.replay_history && method === 'session/load') {
          update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'old question' } });
          update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old answer' } });
        }
        if (args.replay_file && method === 'session/load') {
          for (const item of JSON.parse(fs.readFileSync(args.replay_file, 'utf8'))) {
            update({ sessionUpdate: item.role === 'user' ? 'user_message_chunk' : 'agent_message_chunk', content: { type: 'text', text: item.text ?? '' } });
          }
        }
        if (method === 'session/new') sessionNews++;
        const sessionResult = { sessionId: sessionName, modes: structuredClone(modes) };
        if (args.breadth) sessionResult.configOptions = configOptions;
        if (args.acp_models) {
          sessionResult.models = { currentModelId: acpModel[0], availableModels: [
            { modelId: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', description: 'Most capable' },
            { modelId: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' }] };
        }
        result(key, sessionResult);
        if (args.breadth) breadthAnnounce();
      }
    } else if (method === 'session/set_model' && args.acp_models) {
      if (['gemini-2.5-pro', 'gemini-2.5-flash'].includes(params.modelId)) {
        acpModel[0] = params.modelId;
        result(key, {});
      } else emit({ id: key, error: { code: -32602, message: 'Unknown model' } });
    } else if (method === 'session/prompt' && args.acp_models && pyDumps(params.prompt).includes('model?')) {
      say('Fixture model: ' + acpModel[0]);
      result(key, { stopReason: 'end_turn' });
    } else if (method === 'session/resume') {
      sessionName = 'sessionId' in params ? params.sessionId : fakeSession;
      sessionCwd = params.cwd || sessionCwd;
      lastMcp = params.mcpServers;
      result(key, { modes: defaultMode(), configOptions });
      breadthAnnounce();
    } else if (method === 'session/list' && args.breadth) {
      const sessions = [{ sessionId: SID(), cwd: 'C:\\work', title: 'First <b>', updatedAt: '2026-01-01T00:00:00Z' }, { sessionId: 'other', cwd: 'C:\\work', title: null }];
      if (params.cursor) result(key, { sessions: sessions.slice(1), nextCursor: null });
      else result(key, { sessions: sessions.slice(0, 1), nextCursor: 'page2' });
    } else if (method === 'session/close' || method === 'session/delete') {
      result(key, {});
    } else if (method === 'session/list') {
      const everything = [1, 2, 3].map((i) => ({ sessionId: `agent-listed-${i}`, cwd: '/fixture/project', title: `Agent listed ${i}`, updatedAt: `2026-11-0${i}T00:00:00Z` }));
      const start = Number.parseInt((params.cursor ?? 'offset:0').split(':')[1], 10);
      const page = everything.slice(start, start + 2);
      result(key, { sessions: page, ...(start + 2 < everything.length ? { nextCursor: `offset:${start + 2}` } : {}) });
    } else if (method === 'session/prompt' && args.subagent && params.prompt.some((b) => b.text === 'delegate')) {
      emit({ method: 'session/update', params: { sessionId: SID(), update: { sessionUpdate: 'subagent_update', sessionId: 'child-1', title: 'Review the fixture', description: 'Reads the fixture and reports', capabilities: { cancel: {} }, state: { state: 'running' } } } });
      waiting.turn = key;
    } else if (method === '_account/read' && args.limits) {
      result(key, { status: 'ready', plan: { kind: 'mistral_code', name: 'pro', title: 'Pro' },
        budget: { usagePercentage: 37.5, resetAt: '2099-12-01T00:00:00Z', paygEnabled: false } });
    } else if (method === 'session/prompt' && args.limits && params.prompt.some((b) => b.type === 'text' && startsAny(b.text ?? '', ['ratelimit:', 'quota:']))) {
      const said = params.prompt.find((b) => b.type === 'text' && startsAny(b.text ?? '', ['ratelimit:', 'quota:'])).text;
      if (said.startsWith('quota:')) {
        emit({ id: key, error: { code: -32603, message: 'Weekly credits used up', data: { details: 'quota', subscriptionQuota: { memberType: 'plus', resetAt: Number.parseInt(said.slice(6), 10) } } } });
      } else {
        say('Limits sent');
        update({ sessionUpdate: 'usage_update', used: 1000, size: 200000, _meta: { '_claude/rateLimit': JSON.parse(said.slice(10)), '_claude/model': 'claude-opus-5-5' } });
        result(key, { stopReason: 'end_turn' });
      }
    } else if (method === '_session/steering') {
      if (args.steer) await steerRequest(key, params);
      else emit({ id: key, error: { code: -32601, message: 'Method not found: _session/steering' } });
    } else if (method === 'session/cancel' && steerCtx.turn) {
      steerCtx.turn.cancel.set();
    } else if (method === undefined && ['steer-perm', 'steer-perm-2', 'steer-perm-helper'].includes(key) && steerCtx.answers) {
      const outcome = outcomeOf(message);
      steerCtx.answers[key] = outcome.optionId || outcome.outcome;
      steerCtx.answers[key + ':event'].set();
    } else if (method === 'session/prompt' && args.steer && steerScenario(key, userText(params.prompt))) {
      // handled
    } else if (method === 'session/prompt' && args.held_turn) {
      await heldTurn(key, userText(params.prompt));
    } else if (key === 'helper-perm' && 'helper-perm' in held) {
      const ev = held['helper-perm'];
      delete held['helper-perm'];
      ev.set();
    } else if (method === 'session/prompt') {
      const blocks = params.prompt;
      const images = blocks.filter((b) => b.type === 'image');
      const attached = blocks.filter((b) => ['resource', 'audio'].includes(b.type) || (b.type === 'text' && (b.text ?? '').startsWith('Attached file:')));
      const promptText = userText(blocks); // Studio's live-sync note comes first and is not the user's words
      if (args.models && promptText.trim() === 'settings?') {
        say(currentSettingsText());
        result(key, { stopReason: 'end_turn' });
        return;
      }
      if (args.demo && DEMO_WORDS.includes(promptText.trim().toLowerCase()) && !images.length && !attached.length) demoTurn(key, promptText.trim().toLowerCase());
      else if (args.client_caps && promptText.startsWith('caps:')) {
        capsRun = { turn: key, steps: JSON.parse(promptText.slice(5)), results: [] };
        capsNext();
      } else if (promptText.startsWith('write:')) { // write:<path>|<text>: the agent writes a file and reports it as an edit tool call with a diff
        const [file, , text] = partition(promptText.slice(6), '|');
        fs.writeFileSync(file, os.platform() === 'win32' ? text.replaceAll('\n', '\r\n') : text, 'utf8'); // Path.write_text's text mode
        update({ sessionUpdate: 'tool_call', toolCallId: 'w1', title: 'Write', kind: 'edit', status: 'completed', content: [{ type: 'diff', path: file, oldText: null, newText: text }] });
        result(key, { stopReason: 'end_turn' });
      } else if (startsAny(promptText, WORKTREE_COMMANDS)) await worktreeTurn(key, promptText, blocks); // worktree e2e turns
      else if (args.rich && !images.length && !attached.length && !['wait', 'form', 'approve', 'child-ask', 'leave-open'].includes(promptText)) richTurn(key); // these keep their own flows under --rich
      else if (attached.length) {
        const echo = attached.map((block) => {
          const resource = block.resource || {};
          return { type: block.type, mimeType: block.mimeType || resource.mimeType, uri: resource.uri,
            textLength: 'text' in resource ? pyLen(resource.text) : null, blobLength: 'blob' in resource ? pyLen(resource.blob) : null,
            dataLength: 'data' in block ? pyLen(block.data) : null,
            inline: block.type === 'text' ? Array.from(block.text).slice(0, 160).join('') : null };
        });
        emit({ method: 'session/update', params: { sessionId: SID(), update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Fixture attachments: ' + pyDumps(echo) + (images.length ? ' images: ' + pyDumps(images.map((i) => i.mimeType)) : '') } } } });
        result(key, { stopReason: 'end_turn' });
      } else if (images.length) {
        emit({ method: 'session/update', params: { sessionId: SID(), update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Fixture images: ' + pyDumps(images.map((i) => i.mimeType)) } } } });
        result(key, { stopReason: 'end_turn' });
      } else if (promptText === 'url' || promptText === 'url-complete') {
        waiting.url = key;
        emit({ id: 'url-test', method: 'elicitation/create', params: {
          sessionId: SID(), mode: 'url', elicitationId: 'fixture-url', message: 'Fixture: sign in to the example service.',
          url: 'https://accounts.example.com/oauth?client=fixture' } });
        if (promptText === 'url-complete') emit({ method: 'elicitation/complete', params: { elicitationId: 'fixture-url' } });
      } else if (promptText === 'leave-open' || promptText.startsWith('leave-open:')) { // 'leave-open:<file>' ends its turn only when the test creates the file
        emit({ id: 'leave-open', method: 'elicitation/create', params: {
          sessionId: SID(), mode: 'form', message: 'Fixture: left pending when the turn ends.',
          requestedSchema: { type: 'object', properties: { x: { type: 'string' } } } } });
        emit({ id: 'leave-open-perm', method: 'session/request_permission', params: { sessionId: SID(), toolCall: { title: 'Left pending', toolCallId: 'lp' }, options: [{ optionId: 'yes', name: 'Allow once', kind: 'allow_once' }] } });
        if (promptText.includes(':')) {
          const file = partition(promptText, ':')[2];
          thread(async () => {
            const deadline = Date.now() + 300000;
            while (!exists(file) && Date.now() < deadline) await sleep(20);
            result(key, { stopReason: 'end_turn' });
          });
        } else result(key, { stopReason: 'end_turn' });
      } else if (promptText === 'agent-cancel') {
        emit({ id: 'cancel-me', method: 'session/request_permission', params: { sessionId: SID(), toolCall: { title: 'Will be withdrawn', toolCallId: 'cm' }, options: [{ optionId: 'yes', name: 'Allow once', kind: 'allow_once' }] } });
        emit({ method: '$/cancel_request', params: { requestId: 'cancel-me' } });
        result(key, { stopReason: 'end_turn' });
      } else if (promptText === 'child-ask') {
        waiting.child = key;
        emit({ method: 'session/update', params: { sessionId: 'child-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'child started' } } } });
        emit({ id: 'child-perm', method: 'session/request_permission', params: { sessionId: 'child-session', toolCall: { title: 'Child approval', toolCallId: 'child-tool' }, options: [{ optionId: 'yes', name: 'Allow once', kind: 'allow_once' }] } });
      } else if (promptText === 'mcp') {
        say('MCP: ' + pyDumps(lastMcp, true));
        result(key, { stopReason: 'end_turn' });
      } else if (promptText === '/compact') {
        update({ sessionUpdate: 'compaction_update', compactionId: 'c1', status: 'in_progress' });
        update({ sessionUpdate: 'compaction_summary_chunk', compactionId: 'c1', content: { type: 'text', text: 'Summary text' } });
        update({ sessionUpdate: 'compaction_update', compactionId: 'c1', status: 'completed' });
        update({ sessionUpdate: 'usage_update', size: 200000, used: 900 });
        update({ sessionUpdate: 'current_mode_update', currentModeId: 'code' });
        result(key, { stopReason: 'end_turn' });
      } else if (promptText.startsWith('bulk:')) { // 'bulk:<n>:<kb>': n tool call updates of <kb> KiB of output each, then the turn ends
        const [count, , kb] = partition(promptText.slice(5), ':');
        const pad = 'x'.repeat(Number.parseInt(kb || '1', 10) * 1024);
        for (let i = 0; i < Number.parseInt(count, 10); i++) update({ sessionUpdate: 'tool_call_update', toolCallId: `bulk-${i}`, status: 'completed', rawOutput: `${i}:${pad}` });
        result(key, { stopReason: 'end_turn' });
      } else if (promptText.startsWith('stream:')) { // 'stream:<n>:<ms>': n chunks, one every ms; halfway it asks a permission and waits
        // 'stream:<n>:<ms>:<gate file>': after the last chunk the turn ends only once the test creates the file (no timer to outrun)
        const [c, g, gate] = [...splitMax(promptText.slice(7), ':', 2), '', ''].slice(0, 3);
        const count = Number.parseInt(c, 10);
        const gap = Number.parseFloat(g || '100');
        thread(async () => {
          for (let i = 0; i < count; i++) {
            if (i === Math.floor(count / 2)) {
              const done = new Ev();
              streamAnswer.event = done;
              emit({ id: 'stream-ask', method: 'session/request_permission', params: { sessionId: SID(), toolCall: { title: 'Stream approval', toolCallId: 'stream-tool' }, options: [{ optionId: 'yes', name: 'Allow once', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }] } });
              await done.wait(600000);
              say(`answer=${streamAnswer.outcome === undefined ? 'None' : streamAnswer.outcome} `);
            }
            say(`chunk${i} `);
            await sleep(gap);
          }
          const deadline = Date.now() + 300000;
          while (gate && !exists(gate) && Date.now() < deadline) await sleep(20);
          result(key, { stopReason: 'end_turn' });
        });
      } else if (promptText === 'wait') waiting.turn = key;
      else if (promptText.startsWith('sleep:')) { // a turn that ends by itself after N seconds (cancel still ends it early)
        waiting.turn = key;
        thread(async () => {
          await sleep(Number.parseFloat(promptText.slice(6)) * 1000);
          if (waiting.turn === key) {
            delete waiting.turn;
            result(key, { stopReason: 'end_turn' });
          }
        });
      } else if (promptText.startsWith('gate:')) { // a turn that ends when the test creates the named file (no timer to outrun on a loaded machine)
        waiting.turn = key;
        thread(async () => {
          const file = promptText.slice(5);
          const deadline = Date.now() + 300000;
          while (!exists(file) && Date.now() < deadline) await sleep(20);
          if (waiting.turn === key) {
            delete waiting.turn;
            result(key, { stopReason: 'end_turn' });
          }
        });
      } else if (promptText === 'form') {
        waiting.form = key;
        emit({ id: 'form-test', method: 'elicitation/create', params: {
          sessionId: SID(), mode: 'form', message: 'Fixture form: provide a name and plan.',
          requestedSchema: { type: 'object', properties: {
            name: { type: 'string', title: 'Name' },
            plan: { type: 'string', oneOf: [
              { const: 'basic', title: 'Basic', description: 'Basic fixture plan' },
              { const: 'pro', title: 'Pro', description: 'Pro fixture plan' }] },
          }, required: ['name', 'plan'] } } });
      } else {
        waiting.permission = key;
        emit({ id: 'approve-test', method: 'session/request_permission', params: { sessionId: SID(), toolCall: { title: 'Fixture approval', toolCallId: 'fake-tool' }, options: [{ optionId: 'yes', name: 'Allow once', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }] } });
      }
    } else if (key === 'stream-ask') {
      const outcome = outcomeOf(message);
      streamAnswer.outcome = outcome.optionId || outcome.outcome;
      if (streamAnswer.event) {
        const ev = streamAnswer.event;
        delete streamAnswer.event;
        ev.set();
      }
    } else if (key === 'url-test') {
      emit({ method: 'session/update', params: { sessionId: SID(), update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Fixture url response: ' + pyDumps(message.result ?? {}, true) } } } });
      const t = waiting.url;
      delete waiting.url;
      result(t, { stopReason: 'end_turn' });
    } else if (key === 'child-perm') {
      const t = waiting.child;
      delete waiting.child;
      result(t, { stopReason: 'end_turn' });
    } else if (typeof key === 'string' && key.startsWith('cap-') && capsRun !== null) {
      capsRun.results.push({ result: message.result ?? null, error: message.error ?? null });
      if (message.result && typeof message.result === 'object' && !Array.isArray(message.result) && 'terminalId' in message.result) capsRun.terminal = message.result.terminalId;
      capsNext();
    } else if (key === 'form-test') {
      emit({ method: 'session/update', params: { sessionId: SID(), update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Fixture form response: ' + pyDumps(message.result ?? {}, true) } } } });
      const t = waiting.form;
      delete waiting.form;
      result(t, { stopReason: 'end_turn' });
    } else if (key === 'setup-question') {
      setupAnswer = true;
      if (pendingSetup) {
        const [setupKey, , setupParams] = pendingSetup;
        pendingSetup = null;
        if (args.setup_fail) emit({ id: setupKey, error: { code: -32000, message: 'Fixture setup failure' } });
        else result(setupKey, { sessionId: 'sessionId' in setupParams ? setupParams.sessionId : fakeSession, modes: defaultMode() });
      }
    } else if (key === 'approve-test' && args.cancel_aware) {
      const outcome = outcomeOf(message).outcome;
      emit({ method: 'session/update', params: { sessionId: SID(), update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Fixture permission outcome: ' + (outcome === undefined ? 'None' : outcome) } } } });
      const t = waiting.permission;
      delete waiting.permission;
      result(t, { stopReason: outcome === 'cancelled' ? 'cancelled' : 'end_turn' });
    } else if (key === 'approve-test') {
      emit({ method: 'session/update', params: { sessionId: SID(), update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Fixture response' } } } });
      const t = waiting.permission;
      delete waiting.permission;
      result(t, { stopReason: 'end_turn' });
    } else if (method === 'session/cancel' && args.cancel_aware) {
      // Spec: the pending prompt MUST end with `cancelled`. A pending permission is ended when its cancelled answer arrives.
      if ('turn' in waiting) {
        const t = waiting.turn;
        delete waiting.turn;
        result(t, { stopReason: 'cancelled' });
      }
    } else if (method === 'session/cancel' && String(params.sessionId ?? '').startsWith('child-')) {
      emit({ method: 'session/update', params: { sessionId: SID(), update: { sessionUpdate: 'subagent_update', sessionId: params.sessionId, state: { state: 'idle' } } } });
    } else if (method === 'session/cancel') {
      if ('turn' in waiting) {
        const t = waiting.turn;
        delete waiting.turn;
        result(t, { stopReason: 'cancelled' });
      }
    } else if ((method === 'session/set_mode' || method === 'session/set_config_option') && args.reject_config) {
      emit({ id: key, error: { code: -32602, message: 'Fixture refuses this setting' } });
    } else if (method === 'session/set_mode') {
      if (args.models) {
        if (!modes.availableModes.some((m) => m.id === params.modeId)) {
          emit({ id: key, error: { code: -32602, message: 'Unknown mode' } });
          return;
        }
        modes.currentModeId = params.modeId;
      }
      result(key, {});
    } else if (method === 'session/set_config_option' && args.require_config_type && !['id', 'boolean'].includes(params.type)) {
      emit({ id: key, error: { code: -32602, message: 'Invalid params: missing field `type`' } });
    } else if (method === 'session/set_config_option') {
      if (args.breadth) {
        for (const option of configOptions) if (option.id === params.configId) option.currentValue = params.value;
        result(key, { configOptions });
      } else result(key, { configOptions: [] });
    }
  }

  // for line in sys.stdin: one line at a time, in order (a handler that waits holds the next line, as the blocking Python loop did)
  let chain = Promise.resolve();
  const enqueue = (line) => {
    chain = chain.then(() => handle(line)).catch((error) => {
      process.stderr.write(`${error && error.stack || error}\n`);
      process.exit(1);
    });
  };
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at).replace(/\r$/, '');
      buffer = buffer.slice(at + 1);
      enqueue(line);
    }
  });
  process.stdin.on('end', () => {
    if (buffer.length) {
      const line = buffer;
      buffer = '';
      enqueue(line);
    }
    chain.then(() => exitAfterFlush(0));
  });
  process.on('unhandledRejection', (error) => {
    process.stderr.write(`${error && error.stack || error}\n`);
    process.exit(1);
  });
  void sleepSync;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) run(process.argv.slice(2));
