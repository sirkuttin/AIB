/**
 * Subagents off, Maki and GitHub Copilot CLI (server/subagents/native_off.ts). Owner rule: an agent's own subagent that edits files works
 * in its own git worktree. Neither CLI can be held to that (aib-shared/research/provider-builder-probe-2026-11-25.md), so AIB turns their
 * subagents off with a launch flag, says so in the chat, and tells the agent. No real agent here (work/fake_acp.py); the real Maki and
 * Copilot are work/deno/e2e_subagent_native_off_test.ts. WSL: neither CLI is in the Ubuntu distro here, so the WSL chat is a
 * FakeWslHost whose agents.detect names them (the flag is part of the command the distro's keeper starts).
 *
 *   - the command: Maki gets `--disallowed-tools=task` before `acp` (a root option); Copilot gets `--excluded-tools=<three tools>` right
 *     after `--acp`; already there, or a command the flag can't be placed in, is handled (unchanged / asked for only);
 *   - a new chat: the agent is started with the flag, the chat says its subagents are off (once), the rule reaches the agent in front of
 *     its next prompt (neither agent advertises a system prompt), Activity shows "Not isolated: subagents are off in this chat";
 *   - a command AIB can't place the flag in: nothing is turned off, the chat says so, the agent is asked;
 *   - a reopened chat does not repeat the note; other agents get none of this; a fixture agent under test is left as it is;
 *   - a WSL chat gets the same flag, note and rule.
 */
import { assert, assertEquals } from './_assert.ts';
import { fake, pause, until } from './_connection.ts';
import { withEnv } from './_agents.ts';
import { makeRepo, Sandbox } from './_worktree_fixtures.ts';
import { FakeWslHost } from './_wsl_fake.ts';
import { Connection } from '../../app/server/acp/connection.ts';
import { Aib } from '../../app/server/host/aib.ts';
import { setWslHostResolver } from '../../app/server/wsl/access.ts';
import { KeeperLink } from '../../app/server/keeper/link.ts';
import { keeperBinary } from '../../app/server/keeper/client.ts';
import {
  COPILOT_AGENT_TOOLS,
  COPILOT_FLAG,
  MAKI_FLAG,
  NATIVE_OFF_REASON,
  nativeAskedNote,
  nativeAskedPrompt,
  nativeOffAgent,
  nativeOffCommand,
  nativeOffNote,
  nativeOffPrompt,
  nativeOffRecord,
} from '../../app/server/subagents/native_off.ts';
import { join } from '../../app/server/platform/ospath.ts';

type Json = Record<string, unknown>;
const T = { sanitizeResources: false, sanitizeOps: false };
const SEP = Deno.build.os === 'windows' ? '\\' : '/';
const MAKI = ['C:/tools/maki.exe', 'acp'];
const COPILOT = ['C:/tools/copilot.exe', '--acp', '--no-auto-update'];

Deno.test('native off: only Maki and Copilot are this kind of agent', () => {
  assertEquals(['maki', 'copilot'].map(nativeOffAgent), ['maki', 'copilot']);
  for (const other of ['claude', 'codex', 'qwen', 'antigravity', 'gemini', 'kilo', 'makita']) assertEquals(nativeOffAgent(other), null);
});

Deno.test('native off, Maki: the flag goes before `acp` (a root option: after it Maki does not start); once; unchanged input', () => {
  assertEquals(MAKI_FLAG, '--disallowed-tools=task');
  const before = [...MAKI];
  assertEquals(nativeOffCommand('maki', MAKI), ['C:/tools/maki.exe', MAKI_FLAG, 'acp']);
  assertEquals(MAKI, before, 'the input is not changed');
  assertEquals(
    nativeOffCommand('maki', ['C:/tools/maki.exe', MAKI_FLAG, 'acp']),
    ['C:/tools/maki.exe', MAKI_FLAG, 'acp'],
    'never added twice',
  );
  assertEquals(nativeOffCommand('maki', ['maki', '--no-plugins', 'acp']), ['maki', '--no-plugins', MAKI_FLAG, 'acp']);
  assertEquals(nativeOffCommand('maki', ['maki']), null, 'no acp word: nowhere to put it');
  assertEquals(nativeOffCommand('maki', ['acp']), null, 'the program is first, never the word');
});

Deno.test('native off, Copilot: one `=` argument with the three agent tools right after --acp (the space form is variadic and would swallow what follows)', () => {
  assertEquals([...COPILOT_AGENT_TOOLS], ['task', 'run_dynamic_workflow', 'dynamic_workflows_manage']);
  assertEquals(COPILOT_FLAG, '--excluded-tools=task,run_dynamic_workflow,dynamic_workflows_manage');
  const before = [...COPILOT];
  assertEquals(nativeOffCommand('copilot', COPILOT), ['C:/tools/copilot.exe', '--acp', COPILOT_FLAG, '--no-auto-update']);
  assertEquals(COPILOT, before, 'the input is not changed');
  assertEquals(nativeOffCommand('copilot', ['copilot']), null, 'no --acp: not the agent command AIB knows');
  assertEquals(
    nativeOffCommand('copilot', ['copilot', '--acp', '--excluded-tools', 'x']),
    null,
    "someone else's list is not merged blindly",
  );
  assertEquals(nativeOffCommand('copilot', ['copilot', '--acp', COPILOT_FLAG]), ['copilot', '--acp', COPILOT_FLAG], 'never added twice');
});

Deno.test('native off texts: concrete, present tense, no emoji; the record picks enforced or asked', () => {
  for (const agent of ['maki', 'copilot'] as const) {
    const name = agent === 'maki' ? 'Maki' : 'Copilot';
    const on = nativeOffRecord(agent, agent === 'maki' ? MAKI : COPILOT);
    assert(on.enforced && on.off === NATIVE_OFF_REASON);
    assertEquals([on.prompt, on.note], [nativeOffPrompt(agent), nativeOffNote(agent)]);
    assert(on.note.startsWith(`${name}'s subagents are off in this chat`), on.note);
    assert(on.prompt.includes('Do the work yourself'), on.prompt);
    const asked = nativeOffRecord(agent, [agent]);
    assert(!asked.enforced && asked.command.join(' ') === agent, 'nothing added');
    assertEquals([asked.prompt, asked.note], [nativeAskedPrompt(agent), nativeAskedNote(agent, asked.detail)]);
    assert(/request, not a guarantee/.test(asked.note), asked.note);
    for (const text of [on.prompt, on.note, asked.prompt, asked.note]) {
      assert(!/\p{Extended_Pictographic}|used to|no longer|instead of/u.test(text), text);
    }
  }
  assert(nativeOffNote('copilot').includes('task and workflow tools'));
});

class Host {
  readonly box = new Sandbox();
  readonly log = join(this.box.base, 'agent.log');
  readonly aibs: Aib[] = [];
  /** The launch command of every agent AIB started (the factory runs the fake agent whatever it is). */
  readonly commands: string[][] = [];
  readonly #restore = withEnv({ FAKE_ACP_LOG: this.log, AGENT_STUDIO_ALLOW_REAL_AGENT: '1' }); // the command is not a fixture: the rule applies

  aib(command: string[], flags: string[] = ['--rich']): Aib {
    const aib = new Aib({ claudeLauncher: import.meta.filename!, nodeCommand: 'node', stateDir: this.box.state, port: 0 });
    aib.ownerProbe = () => null;
    aib.settings.worktreePerChat = () => false; // in the project folder: what these chats do
    aib.agentLaunch = () => Promise.resolve([command, {}]);
    aib.connectionFactory = (launch, cwd, provider, options) => {
      this.commands.push([...launch]);
      return new Connection(fake(...flags), cwd, provider, options);
    };
    this.aibs.push(aib);
    return aib;
  }

  received(method: string): Json[] {
    let text = '';
    try {
      text = Deno.readTextFileSync(this.log);
    } catch { /* nothing yet */ }
    return text.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((m) => m.method === method).map((m) => m.params);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    for (const s of this.aibs.reverse()) await s.close().catch(() => {});
    this.#restore();
    this.box[Symbol.dispose]();
  }
}

const promptTexts = (params: Json) => ((params.prompt ?? []) as Json[]).map((x) => String(x.text ?? ''));
const notes = (c: Connection) => c.events.filter((e) => e.kind === 'studio_note').map((e) => String((e.data as Json).message));

for (const [agent, command, flag] of [['maki', MAKI, MAKI_FLAG], ['copilot', COPILOT, COPILOT_FLAG]] as const) {
  const name = agent === 'maki' ? 'Maki' : 'Copilot';
  Deno.test({
    name:
      `native off, ${name} chat: started with the flag, the chat says subagents are off once, the rule goes in front of the next prompt, Activity says not isolated`,
    ...T,
    async fn() {
      await using host = new Host();
      const aib = host.aib(command);
      const c = await aib.connect(agent, host.box.project, null, {});
      await until(() => c.ready, 'the chat is ready', 30);
      assertEquals(host.commands.at(-1), nativeOffCommand(agent, command), 'the agent is started with the flag');
      assert(host.commands.at(-1)!.includes(flag));
      assertEquals(c.subagentHooks!.off, NATIVE_OFF_REASON);
      assertEquals(c.subagentHooks!.prompt, nativeOffPrompt(agent));
      assert(!c.subagentIsolationOn(), 'no worktree isolation is claimed');
      assertEquals((c.public() as Json).subagentIsolation, { on: false, reason: NATIVE_OFF_REASON, readOnly: [] });
      assertEquals(notes(c), [nativeOffNote(agent)], 'said up front, once');
      assertEquals(c.worktree, null, 'the chat works in the project folder, as before');
      assert(!('systemPrompt' in host.received('session/new')[0]), 'this fake agent has no system prompt capability');
      await c.prompt('first question');
      await until(() => !c.busy && host.received('session/prompt').length === 1, 'the first prompt');
      const first = promptTexts(host.received('session/prompt')[0]);
      assertEquals(first, [`<studio-context>${nativeOffPrompt(agent)}</studio-context>`, 'first question']);
      await c.prompt('second question');
      await until(() => !c.busy && host.received('session/prompt').length === 2, 'the second prompt');
      assertEquals(promptTexts(host.received('session/prompt')[1]), ['second question'], 'said once');
      assertEquals(c.events.filter((e) => e.kind === 'user').map((e) => String((e.data as Json).text)), [
        'first question',
        'second question',
      ]);
    },
  });

  Deno.test({
    name: `native off, ${name} chat: a command the flag can't be placed in turns nothing off, says so and asks the agent`,
    ...T,
    async fn() {
      await using host = new Host();
      const odd = [command[0]]; // no acp word / no --acp
      const c = await host.aib(odd).connect(agent, host.box.project, null, {});
      await until(() => c.ready, 'the chat is ready', 30);
      assertEquals(host.commands.at(-1), odd, 'the command is left as it is');
      assertEquals(c.subagentHooks!.off, 'AIB does not know how this copy of it was started');
      assertEquals(c.subagentHooks!.prompt, nativeAskedPrompt(agent));
      const said = notes(c);
      assertEquals(said.length, 1);
      assert(said[0].includes("can't be turned off in this chat") && /request, not a guarantee/.test(said[0]), said[0]);
      assert(!said[0].includes('are off in this chat'), 'it does not claim they are off');
    },
  });

  Deno.test({
    name: `native off, ${name} chat: a reopened chat is started with the flag again and does not repeat the note`,
    ...T,
    async fn() {
      await using host = new Host();
      const aib = host.aib(command, ['--extra-dirs', '--rich']);
      const c = await aib.connect(agent, host.box.project, null, {});
      await until(() => c.ready, 'the chat is ready', 30);
      const sessionId = c.sessionId!;
      await aib.close();
      const again = host.aib(command, ['--extra-dirs', '--rich']);
      const reopened = await again.connect(agent, host.box.project, sessionId);
      await until(() => reopened.ready, 'the chat is reopened', 30);
      assert(host.commands.at(-1)!.includes(flag), 'the flag is on every start');
      assertEquals(reopened.subagentHooks!.off, NATIVE_OFF_REASON);
      assert(!notes(reopened).includes(nativeOffNote(agent)), 'a reopened chat does not repeat the note');
    },
  });
}

Deno.test({
  name: 'native off: other agents get none of it, and a fixture agent under test is left as it is',
  ...T,
  async fn() {
    await using host = new Host();
    const c = await host.aib(['C:/tools/claude.exe']).connect('claude', host.box.project, null, {});
    await until(() => c.ready, 'the chat is ready', 30);
    assert(!JSON.stringify(host.commands.at(-1)).includes('disallowed') && !JSON.stringify(host.commands.at(-1)).includes('excluded'));
    assert(!notes(c).some((n) => n.includes('subagents are off in this chat')));
    // a fixture command under AGENT_STUDIO_TEST: nothing is decided (the same gate as every other agent's subagent rule)
    const keep = withEnv({ AGENT_STUDIO_TEST: '1' });
    try {
      const m = await host.aib([import.meta.filename!, 'acp']).connect('maki', host.box.project, null, {});
      await until(() => m.ready, 'the maki chat is ready', 30);
      assertEquals(m.subagentHooks, null);
      assertEquals(host.commands.at(-1), [import.meta.filename!, 'acp']);
    } finally {
      keep();
    }
  },
});

// ---- WSL: the same flag in the distro's command (FakeWslHost; neither CLI is in the distro here) ----

class WslLab {
  readonly dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-wsl-natoff-' }));
  readonly state = this.dir + SEP + 'state';
  readonly work = makeRepo(this.dir + SEP + 'app');
  readonly host: FakeWslHost;
  readonly aibs: Aib[] = [];
  readonly commands: string[][] = [];

  constructor() {
    this.host = new FakeWslHost(this.dir + SEP + 'linux-keeper', 'Ubuntu');
    this.host.folders.set('/home/u/app', this.work);
    this.host.folders.set('/home/u', this.dir);
    setWslHostResolver((d) => (d === 'ubuntu' ? this.host : null));
  }

  aib(): Aib {
    const keeper = new KeeperLink({ dataDir: this.state, orphan: null, extraArgs: ['--exit-after', '2s', '--orphan-after', '30s'] });
    const aib = new Aib({ claudeLauncher: import.meta.filename!, nodeCommand: 'node', stateDir: this.state, port: 0, ownersDir: null }, {
      keeper,
    });
    aib.ownerProbe = () => null;
    aib.connectionFactory = (command, cwd, provider, options) => {
      this.commands.push([...command]);
      const wsl = options?.wsl ? { ...options.wsl, program: undefined } : options?.wsl;
      return new Connection(fake('--cancel-aware'), cwd, provider, { ...options, wsl });
    };
    this.aibs.push(aib);
    return aib;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    for (const s of this.aibs.reverse()) await s.close().catch(() => {});
    setWslHostResolver(null);
    await this.host.stopKeeper();
    for (let i = 0; i < 20; i++) {
      try {
        Deno.removeSync(this.dir, { recursive: true });
        return;
      } catch {
        await pause(200);
      }
    }
  }
}

Deno.test({
  name: 'native off, WSL chats: a Maki and a Copilot chat in a WSL project are started with the same flag, say so, and carry the rule',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new WslLab();
    const restore = withEnv({ AGENT_STUDIO_ALLOW_REAL_AGENT: '1', AIB_WSL_ROOT: '/tmp/aib-wsl-test-fake' }); // the command is not a fixture: the rule applies
    lab.host.handlers['agents.detect'] = () => ({
      agents: [
        { id: 'maki', found: true, command: ['/usr/local/bin/maki', 'acp'], version: '0.7.2' },
        { id: 'copilot', found: true, command: ['/usr/local/bin/copilot', '--acp'], version: '1.0.109' },
      ],
    });
    try {
      for (const agent of ['maki', 'copilot'] as const) {
        const aib = lab.aib();
        const c = await aib.connect(agent, 'wsl://ubuntu/home/u/app');
        await until(() => c.ready, `the ${agent} chat is ready`, 30);
        const sent = lab.commands.at(-1)!;
        assertEquals(
          sent,
          agent === 'maki' ? ['/usr/local/bin/maki', MAKI_FLAG, 'acp'] : ['/usr/local/bin/copilot', '--acp', COPILOT_FLAG],
          JSON.stringify(lab.commands),
        );
        assertEquals(c.subagentHooks!.off, NATIVE_OFF_REASON);
        assertEquals(c.subagentHooks!.prompt, nativeOffPrompt(agent));
        assert(notes(c).includes(nativeOffNote(agent)), notes(c).join('\n'));
        assertEquals((c.public() as Json).subagentIsolation, { on: false, reason: NATIVE_OFF_REASON, readOnly: [] });
      }
    } finally {
      restore();
    }
  },
});
