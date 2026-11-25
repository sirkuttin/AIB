/**
 * Subagents off, Maki and GitHub Copilot CLI (server/subagents/native_off.ts): e2e with the REAL programs over ACP, as AIB launches them,
 * against the local stub model API (work/stub_model_api.js, Anthropic /v1/messages). In-process AIB, no keeper, no window, no network.
 * Facts: aib-shared/research/provider-builder-probe-2026-11-25.md (Maki 0.7.2, Copilot CLI 1.0.109).
 *
 *   control   the program started WITHOUT the flag offers the model its subagent tool (`task`; Copilot also the two workflow tools)
 *   AIB chat  a chat opened through AIB (Aib.connect) starts it WITH the flag: the model is offered no subagent tool and every other
 *             file and shell tool, the chat says so once, and the rule is in front of the first prompt the model sees
 *
 * SAFETY (an earlier builder's test reached Google with the owner's real sign-in): before any prompt is sent the test checks that the
 * model address is the stub on 127.0.0.1, that HOME, USERPROFILE, APPDATA, LOCALAPPDATA, XDG_* and COPILOT_HOME are temp folders
 * outside the owner's home, that no token or key variable of the owner's is left in the environment, and (Copilot) that it runs
 * offline with a local model provider (COPILOT_OFFLINE, COPILOT_PROVIDER_*: no GitHub sign-in, token, keyring or `gh` is used). After
 * the prompts it checks the stub saw them. Neither program is installed by this test: AIB_MAKI_EXE and AIB_COPILOT_EXE name the
 * program files (Maki 0.7.2: maki.exe from the release archive; Copilot: copilot.exe of @github/copilot-win32-x64 1.0.109); a program
 * that is not named is skipped. Neither CLI is in WSL here, so the WSL route is the fake host in subagent_native_off_test.ts.
 */
import { assert, assertEquals } from './_assert.ts';
import { agentTempDirSync } from './_agent_tmp.ts';
import { pause, until } from './_connection.ts';
import { WORK } from './_work.ts';
import { Aib } from '../../app/server/host/aib.ts';
import { pathOf } from '../../app/server/state/paths.ts';
import { COPILOT_AGENT_TOOLS, nativeOffCommand, nativeOffNote, nativeOffPrompt } from '../../app/server/subagents/native_off.ts';

type Json = Record<string, unknown>;
const T = { sanitizeResources: false, sanitizeOps: false };
const WIN = Deno.build.os === 'windows';
const STUB = (() => {
  const path = decodeURIComponent(new URL('stub_model_api.js', WORK).pathname);
  return WIN ? path.replace(/^\/([A-Za-z]:)/, '$1').replaceAll('/', '\\') : path;
})();
const HOME_VARS = [
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME',
];
/** Variables of the owner's that could carry a sign-in: removed for the whole test. */
const SECRET_VARS = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'COPILOT_GITHUB_TOKEN',
  'GH_HOST',
  'COPILOT_GH_HOST',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_GEMINI_BASE_URL',
  'OPENROUTER_API_KEY',
  'DEEPSEEK_API_KEY',
  'MISTRAL_API_KEY',
  'XAI_API_KEY',
  'COPILOT_PROVIDER_API_KEY',
  'COPILOT_PROVIDER_BEARER_TOKEN',
];

const exeOf = (name: string): string | null => {
  const path = Deno.env.get(name) ?? '';
  try {
    return path && Deno.statSync(path).isFile ? path : null;
  } catch {
    return null;
  }
};
const MAKI_EXE = exeOf('AIB_MAKI_EXE');
const COPILOT_EXE = exeOf('AIB_COPILOT_EXE');

class Stub {
  readonly child: Deno.ChildProcess;
  port = 0;
  readonly log: string;
  readonly dump: string;
  constructor(folder: string) {
    this.log = pathOf(folder, 'stub.log');
    this.dump = pathOf(folder, 'dump');
    Deno.mkdirSync(this.dump, { recursive: true });
    this.child = new Deno.Command('node', {
      args: [STUB, '--port', '0', '--stdin', '--log', this.log, '--dump', this.dump],
      stdin: 'piped',
      stdout: 'piped',
      stderr: 'null',
    }).spawn();
  }
  async start(): Promise<void> {
    const reader = this.child.stdout.getReader();
    let text = '';
    const deadline = Date.now() + 15000;
    while (!/STUB_PORT=(\d+)/.test(text) && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    reader.releaseLock();
    void this.child.stdout.cancel().catch(() => {});
    this.port = Number(/STUB_PORT=(\d+)/.exec(text)?.[1] ?? 0);
    assert(this.port, 'the stub model API did not start: ' + text);
  }
  /** One entry per model request: the tools offered. */
  calls(): { path: string; tools: string[] }[] {
    try {
      return Deno.readTextFileSync(this.log).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as Json).map((o) => ({
        path: String(o.path),
        tools: Array.isArray(o.tools) ? o.tools.map(String) : [],
      }));
    } catch {
      return [];
    }
  }
  messageCalls(): { path: string; tools: string[] }[] {
    return this.calls().filter((c) => c.path === '/v1/messages' && c.tools.length > 0);
  }
  /** Every request body the stub was sent, as text (for what the model was told). */
  bodies(): string[] {
    return [...Deno.readDirSync(this.dump)].map((e) => e.name).sort().map((n) => Deno.readTextFileSync(pathOf(this.dump, n)));
  }
  async stop(): Promise<void> {
    try {
      await this.child.stdin.close();
    } catch { /* gone */ }
    try {
      this.child.kill();
    } catch { /* gone */ }
    await this.child.status.catch(() => {});
  }
}

/** The toolbox of one agent: its program, its way of starting, the environment that sends it to the stub, the tools it must lose. */
interface Kit {
  agent: 'maki' | 'copilot';
  exe: string;
  command: string[];
  env: (home: string, port: number) => Record<string, string>;
  subagentTools: string[];
  stillThere: string[];
}

const KITS: Kit[] = [
  {
    agent: 'maki',
    exe: MAKI_EXE ?? '',
    command: [MAKI_EXE ?? '', 'acp'],
    env: (_home, port) => ({ ANTHROPIC_API_KEY: 'stub-key-not-real', ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` }),
    subagentTools: ['task'],
    stillThere: ['write', 'read', 'edit', 'bash'],
  },
  {
    agent: 'copilot',
    exe: COPILOT_EXE ?? '',
    command: [COPILOT_EXE ?? '', '--acp', '--no-auto-update'],
    env: (home, port) => ({
      COPILOT_HOME: pathOf(home, 'copilot'),
      COPILOT_CACHE_HOME: pathOf(home, 'cache'),
      COPILOT_OFFLINE: 'true', // no GitHub sign-in, telemetry or update check
      COPILOT_AUTO_UPDATE: 'false',
      COPILOT_TELEMETRY_DISABLED: 'true',
      COPILOT_PROVIDER_BASE_URL: `http://127.0.0.1:${port}`, // the stub, as a bring-your-own-key model provider
      COPILOT_PROVIDER_TYPE: 'anthropic',
      COPILOT_PROVIDER_API_KEY: 'stub-key-not-real',
      COPILOT_MODEL: 'stub-model',
    }),
    subagentTools: [...COPILOT_AGENT_TOOLS],
    stillThere: ['create', 'edit', 'view', 'grep'],
  },
];

/** A raw ACP run with the given command and environment (the control: AIB's flag is not there). Returns when the first prompt is answered. */
async function rawRun(command: string[], env: Record<string, string>, cwd: string): Promise<void> {
  const child = new Deno.Command(command[0], {
    args: command.slice(1),
    cwd,
    env,
    clearEnv: true,
    stdin: 'piped',
    stdout: 'piped',
    stderr: 'null',
  }).spawn();
  const writer = child.stdin.getWriter();
  const send = (o: Json) => writer.write(new TextEncoder().encode(JSON.stringify(o) + '\n'));
  const reader = child.stdout.getReader();
  let buffer = '';
  const answer = async (id: number): Promise<Json> => {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      let i: number;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        try {
          const m = JSON.parse(line) as Json;
          if (m.id === id && !m.method) return m;
        } catch { /* not JSON */ }
      }
      const { value, done } = await reader.read();
      if (done) break;
      buffer += new TextDecoder().decode(value);
    }
    throw new Error('no answer to request ' + id);
  };
  try {
    await send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } });
    await answer(1);
    await send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd, mcpServers: [] } });
    const made = await answer(2);
    const sessionId = (made.result as Json).sessionId;
    await send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'hello' }] } });
    await answer(3);
  } finally {
    try {
      child.kill();
    } catch { /* gone */ }
    await child.status.catch(() => {});
  }
}

for (const kit of KITS) {
  const name = kit.agent === 'maki' ? 'Maki' : 'Copilot';
  Deno.test({
    name:
      `${name} e2e: the real program offers its subagent tool without the flag; a chat opened through AIB starts it with the flag and the model is offered none`,
    ...T,
    ignore: !kit.exe,
    async fn() {
      const saved = Object.fromEntries(
        [
          ...HOME_VARS,
          ...SECRET_VARS,
          'TEMP',
          'TMP',
          'TMPDIR',
          'PATH',
          'AGENT_STUDIO_TEST',
          'AGENT_STUDIO_ALLOW_REAL_AGENT',
          'COPILOT_HOME',
        ].map((k) => [k, Deno.env.get(k)]),
      );
      const root = Deno.realPathSync(agentTempDirSync(`aib-natoff-${kit.agent}-`)); // outside the owner's home
      const home = pathOf(root, 'home');
      for (const v of SECRET_VARS) Deno.env.delete(v);
      for (const v of HOME_VARS) {
        const folder = v === 'APPDATA'
          ? pathOf(home, 'AppData', 'Roaming')
          : v === 'LOCALAPPDATA'
          ? pathOf(home, 'AppData', 'Local')
          : v.startsWith('XDG_')
          ? pathOf(home, 'xdg', v.slice(4).toLowerCase())
          : home;
        Deno.mkdirSync(folder, { recursive: true });
        Deno.env.set(v, folder);
      }
      const tmp = pathOf(root, 'tmp');
      Deno.mkdirSync(tmp);
      for (const v of ['TEMP', 'TMP', 'TMPDIR']) Deno.env.set(v, tmp);
      // no `gh` (GitHub CLI) on the program's PATH: a sign-in of the owner's must not be reachable by any route
      const sep = WIN ? ';' : ':';
      const clean = (saved.PATH ?? '').split(sep).filter((dir) => {
        if (!dir) return false;
        try {
          return !Deno.statSync(pathOf(dir, WIN ? 'gh.exe' : 'gh')).isFile;
        } catch {
          return true;
        }
      });
      Deno.env.set('PATH', clean.join(sep));
      Deno.env.set('AGENT_STUDIO_TEST', '1');
      Deno.env.set('AGENT_STUDIO_ALLOW_REAL_AGENT', '1'); // the real program may start: everything it sees is in the temp folder
      const project = pathOf(root, 'proj');
      Deno.mkdirSync(project);
      Deno.writeTextFileSync(pathOf(project, 'README.md'), 'a test project\n');
      const stub = new Stub(root);
      const aib = new Aib({ stateDir: pathOf(root, 'state'), port: 0, ownersDir: null });
      aib.ownerProbe = () => null;
      try {
        await stub.start();
        const env = kit.env(home, stub.port);
        // ---- safety, before any prompt ----
        for (const v of HOME_VARS) {
          const value = Deno.env.get(v)!;
          assert(value.startsWith(root), `${v} is a temp folder: ${value}`);
        }
        for (const v of SECRET_VARS) if (!(v in env)) assertEquals(Deno.env.get(v), undefined, `${v} is not set`);
        const base = env.ANTHROPIC_BASE_URL ?? env.COPILOT_PROVIDER_BASE_URL;
        assertEquals(base, `http://127.0.0.1:${stub.port}`, 'the model is the local stub');
        if (kit.agent === 'copilot') {
          assertEquals(env.COPILOT_OFFLINE, 'true');
          assert(env.COPILOT_HOME.startsWith(root), 'its own folder, never ~/.copilot');
        }
        assert(Object.values(env).every((v) => !/api\.(anthropic|openai|githubcopilot)\.com|github\.com/.test(v)));

        // ---- control: the program as it is offers the model its subagent tool ----
        await rawRun(kit.command, { ...Deno.env.toObject(), ...env }, project);
        const control = stub.messageCalls();
        assert(control.length >= 1, 'the stub received the control prompt: the model is the stub');
        for (const tool of kit.subagentTools) {
          assert(control[0].tools.includes(tool), `without the flag the model is offered ${tool}: ${control[0].tools}`);
        }
        const controlCount = stub.calls().length;

        // ---- a chat opened through AIB: the flag is on, the model is offered no subagent tool ----
        const launched: string[][] = [];
        aib.agentLaunch = () => Promise.resolve([kit.command, env]);
        const make = aib.connectionFactory.bind(aib);
        aib.connectionFactory = (command, cwd, provider, options) => {
          launched.push([...command]);
          return make(command, cwd, provider, options);
        };
        const c = await aib.connect(kit.agent, project, null, {});
        await until(() => !!c.sessionId, 'session/new answered', 120);
        assertEquals(launched.at(-1), nativeOffCommand(kit.agent, kit.command), 'AIB started the real program with the flag');
        await aib.liveCall('prompt', { id: c.id, text: 'hello again', clientMessageId: 'm1' });
        await until(() => !c.busy && stub.messageCalls().length > control.length, 'the chat turn reached the stub', 120);
        const chat = stub.messageCalls()[control.length];
        for (const tool of kit.subagentTools) {
          assert(!chat.tools.includes(tool), `with the flag the model is offered no ${tool}: ${chat.tools}`);
        }
        for (const tool of kit.stillThere) assert(chat.tools.includes(tool), `${tool} is still offered: ${chat.tools}`);
        assert(stub.calls().length > controlCount);
        // what the model was told, and what the chat says
        const told = stub.bodies().filter((b) => b.includes('hello again')).join(' ');
        assert(told.includes(nativeOffPrompt(kit.agent)), 'the rule is in front of the first prompt the model sees');
        assertEquals(
          c.events.filter((e) => e.kind === 'studio_note').map((e) => String((e.data as Json).message)).filter((m) =>
            m === nativeOffNote(kit.agent)
          ).length,
          1,
          'the chat says it once',
        );
        assertEquals((c.public() as Json).subagentIsolation, { on: false, reason: 'subagents are off in this chat', readOnly: [] });
        // every request went to the stub (the log has no other address by construction); the chat's own folders are temp ones
        assert(stub.calls().every((x) => x.path.startsWith('/v1/')), JSON.stringify(stub.calls()));
      } finally {
        await aib.close().catch(() => {});
        await stub.stop();
        for (const [k, v] of Object.entries(saved)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
        for (let i = 0; i < 20; i++) {
          try {
            Deno.removeSync(root, { recursive: true });
            break;
          } catch {
            await pause(250);
          }
        }
      }
    },
  });
}
