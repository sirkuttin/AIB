/**
 * No stuck processes, Slice 0, build steps 3 and 4 (server/subagents/shell_tag.ts, server/allow/aib_prefix.ts, keeper/hookshell.go).
 * The real forwarder program (built from keeper/ with Go) talks to a real ArtifactMcpHttp over loopback, in front of the real subagent
 * routes; the tagged command is run in a real shell. Fake agents only (the payloads a hook gets), headless, temp folders.
 *   a subagent's shell call is tagged with the exact prefix and still runs (Git Bash; PowerShell on Windows)
 *   the main chat's calls stay untagged, and AIB is not even asked
 *   AIB down: exit 0, nothing printed, fast: the call runs untagged and is never blocked
 *   cmd.exe / wrapper commands and PowerShell param( scripts stay untagged
 *   an old `hook 1` forwarder (a chat given no shellTag) keeps working unchanged; hook 2 is read from `hook --check`
 *   Codex: the cookie stands in front of the cd, and a hook 1 chat gets the plain cd
 *   the prefix is stripped where a command is matched or shown (the allow reader, the transcript); only the exact prefix
 */
import { assert, assertEquals } from './_assert.ts';
import { configure, issueHookKey } from '../../outputs/agent-studio/server/artifacts/keys.ts';
import { ArtifactMcpHttp } from '../../outputs/agent-studio/server/artifacts/mcp_http.ts';
import {
  hookForwarderOf,
  hookForwarderTagsShells,
  hookForwarderVersion,
  keeperBinary,
} from '../../outputs/agent-studio/server/keeper/client.ts';
import { gitBashPath, hookSettings } from '../../outputs/agent-studio/server/subagents/claude_config.ts';
import { codexHook } from '../../outputs/agent-studio/server/subagents/codex.ts';
import { codexTagPrefix, parseCookie, preShell } from '../../outputs/agent-studio/server/subagents/shell_tag.ts';
import { readSubagents, type SubagentChat, SubagentWorktrees } from '../../outputs/agent-studio/server/subagents/service.ts';
import {
  cookieOf,
  stripAibInput,
  stripAibMessage,
  stripAibPrefix,
  stripAibPrefixes,
  taggable,
  tagged,
} from '../../outputs/agent-studio/server/allow/aib_prefix.ts';
import { parseBash, parsePwsh } from '../../outputs/agent-studio/server/allow/shell.ts';
import { join } from '../../outputs/agent-studio/server/platform/path.ts';
import { Transcript } from '../../outputs/agent-studio/server/transcripts/transcript.ts';
import { normalize } from '../../outputs/agent-studio/server/transcripts/normalize.ts';

type Json = Record<string, unknown>;
const WIN = Deno.build.os === 'windows';
const T = { sanitizeResources: false, sanitizeOps: false };
const DEC = new TextDecoder();

function git(cwd: string, ...args: string[]): void {
  const out = new Deno.Command('git', {
    args: ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...args],
    cwd,
    stdout: 'piped',
    stderr: 'piped',
  })
    .outputSync();
  if (!out.success) throw new Error(`git ${args.join(' ')}: ${DEC.decode(out.stderr)}`);
}

function repo(dir: string): string {
  Deno.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  Deno.writeTextFileSync(join(dir, 'tracked.txt'), 'one\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'first');
  return dir;
}

interface Run {
  code: number;
  out: string;
  err: string;
  ms: number;
}

class Lab {
  readonly dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-shelltag-' }));
  readonly state = join(this.dir, 'state');
  readonly project: string;
  readonly chat: SubagentChat;
  readonly svc: SubagentWorktrees;
  readonly server: ArtifactMcpHttp;
  readonly hits: string[] = [];
  readonly file: string;
  key = '';
  binary = '';

  constructor(shellTag: boolean) {
    Deno.mkdirSync(this.state, { recursive: true });
    this.project = repo(join(this.dir, 'proj'));
    this.chat = {
      id: 'c0ffee00aa11bb22cc33dd44ee55ff66',
      provider: 'claude',
      lasting: 'claude:s1',
      folder: this.project,
      project: this.project,
      hooks: { readOnly: new Set(['Explore']), userWorktreeHook: false, ...(shellTag ? { shellTag: true } : {}) },
    };
    this.svc = new SubagentWorktrees(this.state, join(this.state, 'worktrees'), (id) => (id === this.chat.id ? this.chat : null));
    this.file = join(this.state, 'artifact-mcp.json');
    configure(this.state);
    this.key = issueHookKey(this.chat.id)!;
    this.server = new ArtifactMcpHttp({
      conversation: () => null,
      baseUrl: () => '',
      urlFile: '',
      addressFile: this.file,
      hook: (event, conversation, body) => {
        this.hits.push(event);
        return event.startsWith('codex-') ? codexHook(this.svc, event, this.chat, body as Json) : this.svc.hook(event, conversation, body);
      },
    });
  }

  async start(): Promise<this> {
    this.binary = await keeperBinary();
    this.server.start();
    return this;
  }

  /** The forwarder program, as the agent's hook runs it: the payload on stdin, the chat's key and id in the environment. */
  async forward(event: string, payload: Json): Promise<Run> {
    const started = performance.now();
    const child = new Deno.Command(this.binary, {
      args: ['hook', event, this.file],
      env: { AIB_HOOK_KEY: this.key, AIB_HOOK_CHAT: this.chat.id, AIB_HOOK_READONLY: 'Explore' },
      stdin: 'piped',
      stdout: 'piped',
      stderr: 'piped',
    }).spawn();
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(JSON.stringify(payload)));
    await writer.close();
    const out = await child.output();
    return { code: out.code, out: DEC.decode(out.stdout), err: DEC.decode(out.stderr), ms: performance.now() - started };
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.server.close().catch(() => {});
    configure(null);
    for (let i = 0; i < 20; i++) {
      try {
        Deno.removeSync(this.dir, { recursive: true });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }
}

const shellCall = (tool: string, command: string, agent: string | null, extra: Json = {}): Json => ({
  hook_event_name: 'PreToolUse',
  tool_name: tool,
  tool_use_id: 'toolu_01abc',
  ...(agent ? { agent_id: agent, agent_type: 'general-purpose' } : {}),
  tool_input: { command, ...extra },
});

/** The command a pre-shell answer rewrote it to ('' when the call runs as it is). */
function rewritten(run: Run): string {
  if (!run.out.trim()) return '';
  const answer = JSON.parse(run.out).hookSpecificOutput;
  assertEquals(answer.hookEventName, 'PreToolUse');
  assert(!('permissionDecision' in answer), 'never an allow or a deny');
  return answer.updatedInput.command;
}

async function bash(command: string): Promise<string> {
  const program = gitBashPath(Deno.env.toObject()) ?? 'bash';
  const out = await new Deno.Command(program, { args: ['-c', command], stdout: 'piped', stderr: 'piped', stdin: 'null' }).output();
  assert(out.success, `bash: ${DEC.decode(out.stderr)}`);
  return DEC.decode(out.stdout).trim();
}

Deno.test({
  name: 'a subagent shell call is tagged with the exact prefix and still runs; the main chat call stays untagged and AIB is not asked',
  ...T,
  async fn() {
    await using lab = await new Lab(true).start();
    const expect = `${lab.chat.id}.agent7.toolu_01abc`;
    const extra = { description: 'show', timeout: 5000, run_in_background: true };

    const run = await lab.forward('pre-shell', shellCall('Bash', 'echo "$AIB_PROC"', 'agent7', extra));
    assertEquals([run.code, run.err], [0, '']);
    const command = rewritten(run);
    assertEquals(command, `export AIB_PROC='${expect}'; echo "$AIB_PROC"`);
    const answer = JSON.parse(run.out).hookSpecificOutput.updatedInput;
    assertEquals({ ...answer, command: 'x' }, { ...extra, command: 'x' }, 'only the command changes');
    assertEquals(await bash(command), expect, 'the tagged command still runs, and its processes carry the cookie');
    assertEquals(parseCookie(expect), { chat: lab.chat.id, owner: 'agent7', call: 'toolu_01abc' });

    if (WIN) { // Claude's PowerShell tool
      const ps = rewritten(await lab.forward('pre-shell', shellCall('PowerShell', 'Write-Output $env:AIB_PROC', 'agent7')));
      assertEquals(ps, `$env:AIB_PROC='${expect}'; Write-Output $env:AIB_PROC`);
      const out = await new Deno.Command('powershell.exe', {
        args: ['-NoProfile', '-NonInteractive', '-Command', ps],
        stdout: 'piped',
        stderr: 'piped',
        stdin: 'null',
      }).output();
      assertEquals(DEC.decode(out.stdout).trim(), expect, 'the PowerShell form runs too');
    }

    // the main chat's own call: untagged, and the forwarder never asked AIB
    lab.hits.length = 0;
    const main = await lab.forward('pre-shell', shellCall('Bash', 'ls', null));
    assertEquals([main.code, main.out, main.err], [0, '', '']);
    assertEquals(lab.hits, [], 'a main-chat call is passed on the PC, with no request to AIB');
    // another tool of a subagent: the same
    assertEquals((await lab.forward('pre-shell', { ...shellCall('Read', 'x', 'agent7') })).out, '');
    assertEquals(lab.hits, []);
  },
});

Deno.test({
  name:
    'a command whose shell is not known or would read the prefix differently stays untagged (cmd.exe, wrappers, PowerShell param scripts)',
  ...T,
  async fn() {
    await using lab = await new Lab(true).start();
    for (
      const [tool, command] of [
        ['PowerShell', 'param($x)\nWrite-Output $x'],
        ['PowerShell', '  Param ( $x ) Write-Output 1'],
        ['PowerShell', 'using namespace System.IO\nGet-Date'],
        ['PowerShell', '#requires -Version 7\nGet-Date'],
        ['PowerShell', '<# help #>\n[CmdletBinding()]\nparam($x)'],
        ['Bash', ''],
        ['Bash', '   '],
      ] as const
    ) {
      const run = await lab.forward('pre-shell', shellCall(tool, command, 'agent7'));
      assertEquals([run.code, run.out], [0, ''], `${tool}: ${JSON.stringify(command)}`);
    }
    assertEquals(lab.hits, [], 'untaggable commands are not even sent to AIB');
    // the server's own rule agrees (so a forwarder that did ask would still get {})
    assert(!taggable('pwsh', 'param($x)') && taggable('pwsh', 'Get-Date') && taggable('bash', 'ls'));
    assertEquals(tagged('pwsh', 'a.b.c', 'using module X'), null);
    // Codex: a command that is itself cmd.exe / PowerShell / bash wrapper is not tagged, on either OS
    const codex = { ...lab.chat, provider: 'codex', hooks: { readOnly: new Set<string>(), userWorktreeHook: false, shellTag: true } };
    for (const os of ['windows', 'linux']) {
      for (
        const command of [
          'cmd /c dir',
          'cmd.exe /c "dir"',
          'powershell -NoProfile -Command "ls"',
          '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -c ls',
          'bash -lc "ls"',
          '/bin/sh -c ls',
        ]
      ) {
        assertEquals(codexTagPrefix(codex, 'a1', { tool_use_id: 'call_1' }, command, os), '', `${os}: ${command}`);
      }
      assertEquals(
        codexTagPrefix(codex, 'a1', { tool_use_id: 'call_1' }, 'ssh host ls', os) !== '',
        true,
        'a command that only ends in sh is tagged',
      );
    }
    assertEquals(
      codexTagPrefix(codex, 'a1', { tool_use_id: 'call_1' }, 'npm test', 'windows'),
      `$env:AIB_PROC='${lab.chat.id}.a1.call_1'; `,
    );
    assertEquals(
      codexTagPrefix(codex, 'a1', { tool_use_id: 'call_1' }, 'npm test', 'linux'),
      `export AIB_PROC='${lab.chat.id}.a1.call_1'; `,
    );
    assertEquals(codexTagPrefix(codex, '', { tool_use_id: 'call_1' }, 'npm test', 'linux'), '', 'the main thread is not tagged');
    assertEquals(codexTagPrefix({ ...codex, wsl: { distro: 'Ubuntu' } }, 'a1', {}, 'npm test', 'linux'), '', 'WSL: untagged for now');
  },
});

Deno.test({
  name: 'AIB down or slow: the shell call is not blocked and not denied (exit 0, nothing printed, fast); wrong key and non-AIB answers too',
  ...T,
  async fn() {
    await using lab = await new Lab(true).start();
    const call = shellCall('Bash', 'npm test', 'agent7');
    assertEquals((await lab.forward('pre-shell', call)).out.length > 0, true, 'up: tagged');
    await lab.server.close();
    for (let i = 0; i < 2; i++) {
      const run = await lab.forward('pre-shell', call);
      assertEquals([run.code, run.out, run.err], [0, '', ''], 'down: runs untagged, never blocked');
      assert(run.ms < 8000, `took ${run.ms} ms`);
    }
    // the blocking Agent hook still fails closed while AIB is down (unchanged)
    const agent = await lab.forward('pre-tool', { tool_name: 'Agent', tool_input: { subagent_type: 'general-purpose', prompt: 'x' } });
    assertEquals(agent.code, 2);
    // a wrong key: AIB answers 401: untagged
    lab.key = 'wrong-key';
    assertEquals((await lab.forward('pre-shell', call)).out, '');
  },
});

Deno.test({
  name: 'an old hook 1 chat (no shellTag) is never tagged: no PreToolUse entry for it, pre-shell answers {}, Codex gets the plain cd',
  ...T,
  async fn() {
    // hook settings: byte-identical to before for a chat without hook 2
    const old = hookSettings('C:/k.exe', 'C:/a.json', { worktreeCreate: true });
    const next = hookSettings('C:/k.exe', 'C:/a.json', { worktreeCreate: true, shellTag: true });
    const oldPre = (old!.hooks as Json).PreToolUse as Json[];
    const newPre = (next!.hooks as Json).PreToolUse as Json[];
    assertEquals(oldPre.length, 1);
    assertEquals(newPre[0], oldPre[0], 'the blocking Agent hook is unchanged');
    assertEquals(newPre.length, 2);
    assertEquals(newPre[1].matcher, 'Bash|PowerShell');
    const shellHook = (newPre[1].hooks as Json[])[0];
    assertEquals(shellHook.command, '"C:/k.exe" hook pre-shell "C:/a.json"', 'no `|| exit 2`: it never blocks');
    assertEquals(shellHook.timeout, 30);

    await using lab = await new Lab(false).start(); // a chat given an older forwarder
    assertEquals(preShell(lab.chat, shellCall('Bash', 'ls', 'agent7')).body, '{}');
    assertEquals((await lab.forward('pre-shell', shellCall('Bash', 'ls', 'agent7'))).out, '');
    // the Agent hook is answered as before
    const agent = await lab.forward('pre-tool', {
      tool_name: 'Agent',
      tool_use_id: 'toolu_a',
      tool_input: { prompt: 'x', subagent_type: 'general-purpose' },
    });
    assertEquals([agent.code, JSON.parse(agent.out).hookSpecificOutput.updatedInput.isolation], [0, 'worktree']);

    // `hook --check`: hook 1 and hook 2 both give hooks; only hook 2 tags
    const fakes = Deno.makeTempDirSync({ prefix: 'aib-fakecheck-' });
    try {
      for (const version of [1, 2]) {
        const program = join(fakes, WIN ? `fwd${version}.cmd` : `fwd${version}.sh`);
        Deno.writeTextFileSync(program, WIN ? `@echo off\r\necho hook ${version}\r\n` : `#!/bin/sh\necho hook ${version}\n`);
        if (!WIN) Deno.chmodSync(program, 0o755);
        assertEquals(await hookForwarderOf(program, fakes), program, `hook ${version} gives hooks`);
        assertEquals([hookForwarderVersion(program), hookForwarderTagsShells(program)], [version, version >= 2]);
      }
      const future = join(fakes, WIN ? 'fwd9.cmd' : 'fwd9.sh');
      Deno.writeTextFileSync(future, WIN ? '@echo off\r\necho hook 9\r\n' : '#!/bin/sh\necho hook 9\n');
      if (!WIN) Deno.chmodSync(future, 0o755);
      assertEquals(await hookForwarderOf(future, fakes), null, 'a version AIB does not know gives no hooks');
      const none = join(fakes, WIN ? 'none.cmd' : 'none.sh');
      Deno.writeTextFileSync(none, WIN ? '@echo off\r\necho nope\r\n' : '#!/bin/sh\necho nope\n');
      if (!WIN) Deno.chmodSync(none, 0o755);
      assertEquals(await hookForwarderOf(none, fakes), null);
      assertEquals(hookForwarderTagsShells(none), false);
    } finally {
      Deno.removeSync(fakes, { recursive: true });
    }
    // the real program answers hook 2
    const real = await keeperBinary();
    assertEquals(await hookForwarderOf(real, lab.dir), real);
    assertEquals(hookForwarderTagsShells(real), true);
  },
});

Deno.test({
  name: 'Codex: a subagent Bash call gets the cookie in front of the cd through the real forwarder; a hook 1 chat gets the plain cd',
  ...T,
  async fn() {
    for (const shellTag of [true, false]) {
      await using lab = await new Lab(shellTag).start();
      Object.assign(lab.chat, { provider: 'codex' });
      const sent = await lab.forward('codex-pre-tool', {
        hook_event_name: 'PreToolUse',
        tool_name: 'spawn_agent',
        tool_use_id: 'call_1',
        tool_input: { message: 'do it' },
      });
      assertEquals([sent.code, sent.out], [0, ''], sent.err);
      assertEquals((await lab.forward('codex-subagent-start', { agent_id: 'agent-1', agent_type: 'default' })).code, 0);
      const path = Object.values(readSubagents(lab.state))[0].path.replaceAll('\\', '/');
      const run = await lab.forward('codex-pre-tool', {
        tool_name: 'Bash',
        agent_id: 'agent-1',
        tool_use_id: 'call_2',
        tool_input: { command: 'echo hi' },
      });
      assertEquals(run.code, 0, run.err);
      const answer = JSON.parse(run.out).hookSpecificOutput;
      assertEquals(answer.permissionDecision, 'allow', run.out);
      const cookie = `${lab.chat.id}.agent-1.call_2`;
      const prefix = shellTag ? (WIN ? `$env:AIB_PROC='${cookie}'; ` : `export AIB_PROC='${cookie}'; `) : '';
      assertEquals(answer.updatedInput.command, `${prefix}cd '${path}'; echo hi`);
      // the main thread's own Bash call: passes with no request at all
      lab.hits.length = 0;
      const main = await lab.forward('codex-pre-tool', { tool_name: 'Bash', tool_use_id: 'call_3', tool_input: { command: 'ls' } });
      assertEquals([main.code, main.out], [0, '']);
      assertEquals(lab.hits, []);
      // a wrapper command is refused its tag but still runs in the worktree
      const wrapped = await lab.forward('codex-pre-tool', {
        tool_name: 'Bash',
        agent_id: 'agent-1',
        tool_use_id: 'call_4',
        tool_input: { command: 'cmd /c dir' },
      });
      assertEquals(JSON.parse(wrapped.out).hookSpecificOutput.updatedInput.command, `cd '${path}'; cmd /c dir`);
    }
  },
});

Deno.test('the prefix is stripped where a command is matched or shown, and only the exact prefix', () => {
  const chat = 'c0ffee00aa11bb22cc33dd44ee55ff66';
  const cookie = cookieOf(chat, 'agent7', 'toolu_01abc')!;
  assertEquals(cookieOf(chat, 'a b', 'x'), null);
  assertEquals(cookieOf(chat, 'a.b', 'x'), null, 'a dot would make the cookie ambiguous');
  const b = `export AIB_PROC='${cookie}'; npm test`;
  const p = `$env:AIB_PROC='${cookie}'; npm test`;
  assertEquals(stripAibPrefix(b), 'npm test');
  assertEquals(stripAibPrefix(p), 'npm test');
  assertEquals(stripAibPrefix(b, chat), 'npm test');
  assertEquals(stripAibPrefix(b, 'another-chat'), b, "another chat's cookie is not this chat's prefix");
  for (
    const same of [
      'npm test', // none
      `echo x; ${b}`, // not at the start
      `export AIB_PROC='x'; npm test`, // not a cookie of the shape
      `export AIB_PROC='${cookie}' ; npm test`, // not the exact text
      `export AIB_PROC='${cookie}'; `.replace('export', 'EXPORT') + 'ls',
      `$env:AIB_PROC='${cookie}'  npm test`,
      `export OTHER='${cookie}'; npm test`,
    ]
  ) assertEquals(stripAibPrefix(same), same);
  // the strict readers read a tagged command like the plain one
  assertEquals(JSON.stringify(parseBash(b)), JSON.stringify(parseBash('npm test')));
  assertEquals(JSON.stringify(parsePwsh(p)), JSON.stringify(parsePwsh('npm test')));
  // display: anywhere, only this chat's cookie (a Codex wrapper holds it inside its quotes)
  assertEquals(stripAibPrefixes(`powershell -Command "${p}"`, chat), 'powershell -Command "npm test"');
  assertEquals(stripAibPrefixes(`powershell -Command "${p}"`, 'other'), `powershell -Command "${p}"`);
  // a whole message: the tool call, the permission card, and nothing else
  const card: Json = {
    method: 'session/request_permission',
    id: 1,
    params: {
      sessionId: 's',
      toolCall: { toolCallId: 't', title: b, rawInput: { command: b, description: 'd' } },
      options: [{ optionId: 'yes', kind: 'allow_once', name: 'Yes' }],
    },
  };
  assert(stripAibMessage(card, chat));
  assertEquals(JSON.stringify(card).includes('AIB_PROC'), false);
  assertEquals(((card.params as Json).toolCall as Json).title, 'npm test');
  assertEquals(((card.params as Json).options as Json[])[0].optionId, 'yes', 'the answer to the card is the same');
  const update: Json = {
    method: 'session/update',
    params: { update: { sessionUpdate: 'tool_call', toolCallId: 't', title: p, rawInput: { command: p } } },
  };
  assert(stripAibMessage(update, chat));
  assertEquals(JSON.stringify(update).includes('AIB_PROC'), false);
  const chunk: Json = {
    method: 'session/update',
    params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: b } } },
  };
  assertEquals(stripAibMessage(chunk, chat), false, 'what the agent says is left alone');
  // the transcript view
  assertEquals(stripAibInput({ command: b, timeout: 1 }), { command: 'npm test', timeout: 1 });
  assertEquals(stripAibInput({ cmd: p }), { cmd: 'npm test' });
  assertEquals(stripAibInput('x'), 'x');
});

Deno.test('the transcript view shows a tagged Bash call and its Activity task as the plain command', () => {
  const cookie = 'c0ffee00aa11bb22cc33dd44ee55ff66.agent7.toolu_1';
  const row = {
    type: 'assistant',
    timestamp: '2026-11-23T10:00:00Z',
    message: {
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'toolu_1',
        name: 'Bash',
        input: { command: `export AIB_PROC='${cookie}'; npm test`, run_in_background: true },
      }],
    },
  };
  const t = new Transcript('shell-tag.jsonl');
  t.trackCommands(row);
  const task = [...t.commands.values()][0];
  assertEquals([task.command, task.title], ['npm test', 'npm test']);
  const shown = normalize(row, 1).find((e) => e.kind === 'tool')!;
  assert(!String(shown.text).includes('AIB_PROC') && String(shown.text).includes('npm test'), String(shown.text));
});
