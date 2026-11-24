/**
 * Kill by name is refused in every AIB chat, for every agent (owner 2026-11-24, "2a"; server/allow/kill_by_name.ts, keeper/hookkill.go).
 * One table of commands runs through:
 *   - the TS matcher (the allow layer's) and the real forwarder program (built from keeper/ with Go) in the shapes of Claude (pre-shell),
 *     Codex (codex-pre-tool) and Gemini (gemini-before-tool), each as the main agent and as a subagent (agent_id set);
 *   - the allow layer end to end: a permission request for such a command gets the agent's reject option, never a card; a PID kill and
 *     a quoted mention are not refused.
 * Fake agents only, headless, no AIB server (the refusal is decided inside the forwarder, so it works with AIB down).
 */
import { assert, assertEquals } from './_assert.ts';
import { events, Lab, until, updateTexts } from './_connection.ts';
import { keeperBinary } from '../../app/server/keeper/client.ts';
import { KILL_BY_NAME_REASON, killsByName, permissionKillsByName } from '../../app/server/allow/kill_by_name.ts';
import { EDIT_TOOLS, mergedSettings } from '../../app/server/subagents/gemini.ts';

const T = { sanitizeResources: false, sanitizeOps: false };
const DEC = new TextDecoder();

const REFUSED = [
  'taskkill /F /IM node.exe',
  'taskkill.exe /IM AIB.exe /F',
  'taskkill //F //IM node.exe',
  'taskkill /FI "IMAGENAME eq node.exe" /F',
  'Stop-Process -Name node -Force',
  'spps -Name node',
  'Stop-Process -ProcessName deno',
  'Get-Process node | Stop-Process',
  'Get-Process -Name node | Stop-Process -Force',
  'pkill -f node',
  'killall node',
  'cd app && pkill node',
  'wmic process where name="node.exe" delete',
  'bash -c "pkill node"',
  `powershell -Command "taskkill /IM node.exe /F"`,
  `echo start; sh -lc 'killall deno'`,
];
const PASSES = [
  'taskkill /PID 1234 /T /F',
  'taskkill /F /PID 1234',
  'Stop-Process -Id 4242 -Force',
  'Get-Process -Id 4242 | Stop-Process',
  'kill 4242',
  'kill -9 4242',
  'git commit -m "docs: never taskkill /IM node.exe, never pkill node"',
  'git commit -m "x" -m \'killall is banned\'',
  "git commit -F - <<'EOF'\nfix: stop using taskkill /IM\n\npkill node is refused now\nEOF",
  'echo "Stop-Process -Name node"',
  'deno task test',
  'bash -c "echo hello"',
];

const asClaude = (command: string, agent: boolean) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_use_id: 'toolu_01abc',
  ...(agent ? { agent_id: 'a1b2c3', agent_type: 'general-purpose' } : {}),
  tool_input: { command },
});
const asCodex = (command: string, agent: boolean) => ({
  hook_event_name: 'PreToolUse',
  tool_name: agent ? 'Bash' : 'exec_command',
  ...(agent ? { agent_id: 'thread1', agent_type: 'worker' } : {}),
  tool_input: agent ? { command } : { cmd: command },
});
const asGemini = (command: string) => ({ hook_event_name: 'BeforeTool', tool_name: 'run_shell_command', tool_input: { command } });

async function forward(binary: string, event: string, payload: unknown, dir: string): Promise<{ code: number; out: string }> {
  const child = new Deno.Command(binary, {
    args: ['hook', event, dir + (Deno.build.os === 'windows' ? '\\' : '/') + 'no-address.json'], // AIB is not running: only a local decision can answer
    env: { AIB_HOOK_KEY: 'k', AIB_HOOK_CHAT: 'c0ffee00aa11bb22cc33dd44ee55ff66' },
    stdin: 'piped',
    stdout: 'piped',
    stderr: 'piped',
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(JSON.stringify(payload)));
  await writer.close();
  const out = await child.output();
  return { code: out.code, out: DEC.decode(out.stdout) };
}

/** True when the forwarder's output is a deny carrying the rule's text (JSON escapes < and >, so read the JSON). */
function denies(out: string): boolean {
  if (!out.trim()) return false;
  const a = JSON.parse(out);
  const reason = a.reason ?? a.hookSpecificOutput?.permissionDecisionReason ?? '';
  return String(reason).includes(KILL_BY_NAME_REASON);
}

Deno.test('kill by name: the TS matcher refuses every kill-by-name shape and passes PID kills and quoted mentions', () => {
  for (const c of REFUSED) assert(killsByName(c), `should refuse: ${c}`);
  for (const c of PASSES) assert(!killsByName(c), `should pass: ${c}`);
  assert(KILL_BY_NAME_REASON.includes('taskkill /PID <pid> /T /F') && KILL_BY_NAME_REASON.includes('kill <pid>'));
});

Deno.test({
  name: 'kill by name: the forwarder refuses it for Claude, Codex and Gemini, main agent and subagent; PID kills and quoted mentions pass',
  ...T,
  async fn() {
    const binary = await keeperBinary();
    const dir = Deno.makeTempDirSync({ prefix: 'aib-killname-' });
    try {
      const jobs: Promise<void>[] = [];
      const check = (label: string, event: string, payload: unknown, want: boolean) =>
        jobs.push(
          forward(binary, event, payload, dir).then((r) => {
            assertEquals(r.code, 0, label);
            assertEquals(denies(r.out), want, `${label}: ${r.out}`);
            if (want) {
              const answer = JSON.parse(r.out);
              if (event === 'gemini-before-tool') assertEquals(answer.decision, 'deny', label);
              else assertEquals(answer.hookSpecificOutput.permissionDecision, 'deny', label);
            }
          }),
        );
      for (const [list, want] of [[REFUSED, true], [PASSES, false]] as const) {
        for (const c of list) {
          for (const agent of [false, true]) {
            check(`claude ${agent ? 'sub' : 'main'}: ${c}`, 'pre-shell', asClaude(c, agent), want);
            check(`codex ${agent ? 'sub' : 'main'}: ${c}`, 'codex-pre-tool', asCodex(c, agent), want);
          }
          check(`gemini: ${c}`, 'gemini-before-tool', asGemini(c), want);
        }
        await Promise.all(jobs.splice(0)); // a chunk at a time: the owner's PC is not a build farm
      }
      // not a shell tool: a patch that merely contains the words is never refused (Codex apply_patch, Claude Edit)
      const patch = {
        hook_event_name: 'PreToolUse',
        tool_name: 'apply_patch',
        tool_input: { command: '*** Update File: a.ts\n+ pkill node' },
      };
      assert(!denies((await forward(binary, 'codex-pre-tool', patch, dir)).out));
      const edit = { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { command: 'pkill node', file_path: 'a' } };
      assert(!denies((await forward(binary, 'pre-shell', edit, dir)).out));
      // the TS and the Go rules agree on the whole table (checked above through both)
    } finally {
      Deno.removeSync(dir, { recursive: true });
    }
  },
});

Deno.test('kill by name: Gemini asks the hook about run_shell_command only from hook 3, and edits stay as they were', () => {
  const user = {};
  const old = mergedSettings(user, 'cmd', { AIB_HOOK_KEY: 'k', AIB_HOOK_CHAT: 'c' }) as { hooks: { BeforeTool: { matcher: string }[] } };
  assertEquals(old.hooks.BeforeTool[0].matcher, EDIT_TOOLS.join('|'));
  const now = mergedSettings(user, 'cmd', { AIB_HOOK_KEY: 'k', AIB_HOOK_CHAT: 'c' }, true) as {
    hooks: { BeforeTool: { matcher: string }[] };
  };
  assertEquals(now.hooks.BeforeTool[0].matcher, 'write_file|replace|run_shell_command');
});

Deno.test({
  name: 'kill by name: the allow layer rejects it for Claude, Codex and Gemini shapes without a card; a PID kill still asks',
  ...T,
  async fn() {
    await using lab = new Lab();
    const cases: { provider: string; prompt: (c: string) => string }[] = [
      { provider: 'claude', prompt: (c) => `allow:${c}` },
      { provider: 'codex', prompt: (c) => `allowcodex:${c}` },
      {
        provider: 'gemini',
        prompt: (c) =>
          'allowraw:' + JSON.stringify({
            toolCall: { toolCallId: 'run_shell_command__run_shell_command_1_0', kind: 'execute', title: c, status: 'pending' },
            options: [
              { optionId: 'proceed_always', name: 'Allow always', kind: 'allow_always' },
              { optionId: 'proceed_once', name: 'Allow once', kind: 'allow_once' },
              { optionId: 'cancel', name: 'Reject', kind: 'reject_once' },
            ],
          }),
      },
    ];
    for (const { provider, prompt } of cases) {
      const c = await lab.open([], { provider });
      const outcomes = () => updateTexts(c).join('').split('allow outcome=').length - 1;
      // refused: the agent is answered with its reject option and no card appears
      await c.prompt(prompt('taskkill /F /IM node.exe'), 'm1');
      await until(() => outcomes() === 1 && !c.busy, `${provider}: the refusal reached the agent`, 10);
      assertEquals(c.permissions.size, 0, `${provider}: no card`);
      const said = updateTexts(c).join('');
      assert(/allow outcome=(no|cancel);/.test(said), `${provider}: ${said}`);
      assert(!said.includes('outcome=yes;') && !said.includes('outcome=proceed'), `${provider}: never allowed`);
      assert(
        events(c, 'studio_note').some((e) => String((e.data as { message?: string }).message).includes('kills processes by name')),
        `${provider}: a note in the chat`,
      );
      // a PID kill is not refused: it asks (no rules in this lab), so a card is waiting
      await c.prompt(prompt('taskkill /PID 1234 /T /F'), 'm2');
      await until(() => c.permissions.size === 1, `${provider}: the PID kill asks as before`, 10);
      c.permission([...c.permissions.keys()][0], null);
      await until(() => !c.busy, `${provider}: turn end`, 10);
    }
    // the request shapes, directly
    const claudeShape = { toolCall: { kind: 'execute', rawInput: { command: 'pkill node' }, _meta: { claudeCode: { toolName: 'Bash' } } } };
    assert(permissionKillsByName(claudeShape));
    assert(!permissionKillsByName({ toolCall: { kind: 'edit', rawInput: { command: 'pkill node' } } }), 'not a shell request');
    assert(permissionKillsByName({ toolCall: { kind: 'execute', rawInput: { command: ['bash', '-lc', 'killall deno'] } } }));
    assert(permissionKillsByName({ toolCall: { kind: 'execute', rawInput: { CommandLine: 'taskkill /IM x.exe' } } }));
    assert(!permissionKillsByName({ toolCall: { kind: 'execute', rawInput: { command: 'git commit -m "pkill node"' } } }));
  },
});
