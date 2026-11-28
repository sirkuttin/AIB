/**
 * Tool servers, real-CLI harness (toolservers_cli_e2e_test.ts): runs a REAL agent CLI once, headless, against the stub model API, in a
 * temp home outside the owner's home, with two fake stdio MCP servers (work/fake_mcp_server.js: `rea` and `aibx`, each writing a marker
 * file when its process starts and offering `<name>_one` / `<name>_two`). The user's config is written in the agent's own format, read
 * back through AIB's discovery (toolservers/discover.ts), the project's choice goes through the store and the apply functions
 * (toolservers/apply.ts), and the result is what the CLI did: which servers it spawned (marker files) and which tools it offered the
 * model (names in the request the stub received). Every launch is checked by AIB's test auth guard before the process exists.
 *
 * Isolation: HOME, USERPROFILE, APPDATA, LOCALAPPDATA and the agent's own config variables are temp folders; the environment is cleared;
 * the model address is the loopback stub with a dummy key. The owner's ~/.claude, ~/.codex, ~/.gemini, ~/.qwen and ~/.copilot are not read.
 */
import { agentTempDirSync } from './_agent_tmp.ts';
import { Stub, which } from './_e2e_real.ts';
import { assertTestAuth } from '../../app/server/acp/test_auth_guard.ts';
import { discoverServers, diskFiles, type FoundServer } from '../../app/server/toolservers/discover.ts';
import { type Effective, effective, ToolServersStore } from '../../app/server/toolservers/store.ts';
import {
  claudePatch,
  codexEntries,
  codexFlags,
  copilotArgs,
  geminiArgs,
  geminiPolicyToml,
  mergeQwenSettings,
  qwenFragment,
} from '../../app/server/toolservers/apply.ts';
import { WORK } from './_work.ts';

const WIN = Deno.build.os === 'windows';
const sep = WIN ? '\\' : '/';
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const nativeOf = (url: URL) => {
  const path = decodeURIComponent(url.pathname);
  return WIN ? path.replace(/^\/([A-Za-z]:)/, '$1').replaceAll('/', '\\') : path;
};
const FAKE_MCP = nativeOf(new URL('fake_mcp_server.js', WORK));
const GEMINI_STUB = nativeOf(new URL('gemini_stub_api.js', WORK));
const LOCAL = Deno.env.get('LOCALAPPDATA') ?? '';
const isFile = (p: string | null | undefined): p is string => {
  try {
    return !!p && Deno.statSync(p).isFile;
  } catch {
    return false;
  }
};
const first = (...paths: (string | null | undefined)[]) => paths.find(isFile) ?? null;

/** The real programs, by environment variable or the places AIB installs them; null: not on this machine (the test is skipped). */
export const PROGRAMS = {
  claude: first(Deno.env.get('AIB_CLAUDE_CLI'), which('claude')),
  codex: first(
    Deno.env.get('AIB_CODEX_EXE'),
    `${LOCAL}\\AIB\\agents\\codex\\2.6.0\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe`,
  ),
  gemini: first(Deno.env.get('AIB_GEMINI_CLI')), // gemini.js of @google/gemini-cli (bundle/gemini.js)
  qwen: first(Deno.env.get('AIB_QWEN_CLI'), `${LOCAL}\\AIB\\agents\\qwen\\0.27.2\\node_modules\\@qwen-code\\qwen-code\\cli.js`),
  copilot: first(Deno.env.get('AIB_COPILOT_EXE')),
  node: which('node'),
};

export interface Outcome {
  /** Servers whose process was spawned (a marker file exists). */
  started: string[];
  /** The tool names of the fake servers the model was offered, as the agent names them. */
  offered: string[];
  /** What discovery found in the user's config for this agent. */
  found: FoundServer[];
  exit: number;
}

export type Provider = 'claude' | 'codex' | 'gemini' | 'qwen' | 'copilot';

/** The user's config in the agent's own format, in the temp home. Returns nothing: discovery reads it back. */
function writeUserConfig(provider: Provider, home: string, marks: string): void {
  const node = PROGRAMS.node!;
  const stdio = (n: string) => ({ command: node, args: [FAKE_MCP, n], env: { MARK_DIR: marks } });
  const mk = (path: string, text: string) => {
    Deno.mkdirSync(path.slice(0, path.lastIndexOf(sep)), { recursive: true });
    Deno.writeTextFileSync(path, text);
  };
  const both = { rea: stdio('rea'), aibx: stdio('aibx') };
  switch (provider) {
    case 'claude':
      mk(
        `${home}${sep}.claude${sep}.claude.json`,
        JSON.stringify({
          hasCompletedOnboarding: true,
          mcpServers: { rea: { type: 'stdio', ...both.rea }, aibx: { type: 'stdio', ...both.aibx } },
        }),
      );
      break;
    case 'codex': {
      const entry = (n: string) =>
        `[mcp_servers.${n}]\ncommand = ${JSON.stringify(node)}\nargs = [${JSON.stringify(FAKE_MCP)}, "${n}"]\nenv = { MARK_DIR = ${
          JSON.stringify(marks)
        } }\n`;
      mk(`${home}${sep}.codex${sep}config.toml`, `${entry('rea')}${entry('aibx')}`); // the model provider is appended by the runner
      break;
    }
    case 'gemini':
      mk(
        `${home}${sep}.gemini${sep}settings.json`,
        JSON.stringify({ mcpServers: both, security: { auth: { selectedType: 'gemini-api-key' } } }),
      );
      break;
    case 'qwen':
      mk(`${home}${sep}.qwen${sep}settings.json`, JSON.stringify({ mcpServers: both }));
      break;
    case 'copilot':
      mk(
        `${home}${sep}copilot${sep}mcp-config.json`,
        JSON.stringify({
          mcpServers: { rea: { type: 'local', ...both.rea, tools: ['*'] }, aibx: { type: 'local', ...both.aibx, tools: ['*'] } },
        }),
      );
      break;
  }
}

/** What the project's choice is: `setup` changes it through the store the way the page's POST does. */
export type Setup = (store: ToolServersStore, key: string) => void;

export async function run(provider: Provider, setup: Setup | null): Promise<Outcome> {
  const root = Deno.realPathSync(agentTempDirSync(`aib-ts-${provider}-`));
  try {
    const home = `${root}${sep}home`;
    const proj = `${root}${sep}proj`;
    const marks = `${root}${sep}marks`;
    const state = `${root}${sep}state`;
    for (const d of [home, proj, marks, state, `${root}${sep}stub`]) Deno.mkdirSync(d, { recursive: true });
    writeUserConfig(provider, home, marks);
    const agent = provider === 'claude' || provider === 'codex' || provider === 'gemini' || provider === 'qwen' || provider === 'copilot'
      ? provider
      : 'claude';
    // the agent's own folders, as the CLI itself is told (so discovery reads what the CLI reads)
    const homeEnv: Record<string, string> = {
      HOME: home,
      USERPROFILE: home,
      APPDATA: `${home}${sep}AppData`,
      LOCALAPPDATA: `${home}${sep}Local`,
    };
    const cfg: Record<string, string> = {};
    if (provider === 'claude') cfg.CLAUDE_CONFIG_DIR = `${home}${sep}.claude`;
    if (provider === 'codex') cfg.CODEX_HOME = `${home}${sep}.codex`;
    if (provider === 'gemini') cfg.GEMINI_CLI_HOME = home;
    if (provider === 'qwen') cfg.QWEN_HOME = `${home}${sep}.qwen`;
    if (provider === 'copilot') Object.assign(cfg, { COPILOT_HOME: `${home}${sep}copilot`, COPILOT_CACHE_HOME: `${home}${sep}cache` });
    const found = discoverServers(diskFiles, { home, folder: proj, env: { ...homeEnv, ...cfg }, sep: sep as '/' | '\\' }).filter((s) =>
      s.agents.includes(agent)
    );
    const store = new ToolServersStore(state);
    const key = 'p:proj';
    setup?.(store, key);
    const e: Effective = effective(store.choice(key), found);
    const base: Record<string, string> = {
      PATH: Deno.env.get('PATH') ?? '',
      SystemRoot: Deno.env.get('SystemRoot') ?? '',
      ...homeEnv,
      ...cfg,
    };
    let stub: Stub | null = null;
    let geminiStub: Deno.ChildProcess | null = null;
    let exe = '';
    let args: string[] = [];
    const env = { ...base };
    try {
      if (provider === 'gemini') {
        const dump = `${root}${sep}dump`;
        Deno.mkdirSync(dump);
        Deno.writeTextFileSync(
          `${root}${sep}script.json`,
          JSON.stringify({
            rules: [{
              when: 'say hi',
              in: 'any',
              tools: ['read_file'],
              reply: { call: { name: 'list_directory', args: { dir_path: '.' } } },
            }],
          }),
        );
        geminiStub = new Deno.Command(PROGRAMS.node!, {
          args: [GEMINI_STUB, '--port', '0', '--script', `${root}${sep}script.json`, '--dump', dump, '--stdin'],
          stdin: 'piped',
          stdout: 'piped',
          stderr: 'null',
        }).spawn();
        const reader = geminiStub.stdout.getReader();
        let text = '';
        let port = 0;
        while (!port) {
          const { value, done } = await reader.read();
          if (done) throw new Error('the Gemini stub did not start');
          text += dec(value);
          port = Number(/STUB_PORT=(\d+)/.exec(text)?.[1] ?? 0);
        }
        Object.assign(env, {
          GEMINI_API_KEY: 'fake-key',
          GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${port}`,
          GEMINI_CLI_AUTH_OVERRIDE: 'gemini-api-key',
          GEMINI_MODEL: 'gemini-2.5-flash',
          NO_BROWSER: '1',
        });
        Deno.mkdirSync(`${home}${sep}.gemini`, { recursive: true });
        Deno.writeTextFileSync(`${home}${sep}.gemini${sep}trustedFolders.json`, JSON.stringify({ [proj]: 'TRUST_FOLDER' }));
        const policyDir = `${root}${sep}policy`;
        Deno.mkdirSync(policyDir);
        const toml = geminiPolicyToml(e);
        const policy = toml ? ['--admin-policy', policyDir] : [];
        if (toml) Deno.writeTextFileSync(`${policyDir}${sep}aib-toolservers.toml`, toml);
        exe = PROGRAMS.node!;
        args = [PROGRAMS.gemini!, '--yolo', ...geminiArgs(e, found, []), ...policy, '-p', 'say hi'];
        assertTestAuth('gemini', [exe, ...args], env);
      } else {
        stub = await Stub.start(`${root}${sep}stub`, []);
        if (provider === 'claude') {
          Object.assign(env, {
            ANTHROPIC_BASE_URL: stub.url,
            ANTHROPIC_API_KEY: 'stub',
            CLAUDE_CODE_GIT_BASH_PATH: Deno.env.get('CLAUDE_CODE_GIT_BASH_PATH') ?? 'C:\\Program Files\\Git\\bin\\bash.exe',
          });
          const patch = claudePatch(e);
          exe = PROGRAMS.claude!;
          args = ['-p', 'say hi', ...patch ? ['--settings', JSON.stringify(patch)] : []];
        } else if (provider === 'codex') {
          const toml = `${home}${sep}.codex${sep}config.toml`;
          Deno.writeTextFileSync(
            toml,
            `model = "stub-model"\nmodel_provider = "stub"\n[model_providers.stub]\nname = "stub"\nbase_url = "${stub.url}/v1"\nwire_api = "responses"\nenv_key = "STUB_KEY"\n` +
              Deno.readTextFileSync(toml),
          );
          Object.assign(env, { STUB_KEY: 'stub' });
          exe = PROGRAMS.codex!;
          args = ['exec', '--skip-git-repo-check', ...codexFlags(codexEntries(e)), 'say hi'];
        } else if (provider === 'qwen') {
          Object.assign(env, { ANTHROPIC_BASE_URL: stub.url, ANTHROPIC_API_KEY: 'stub', ANTHROPIC_MODEL: 'stub-model' });
          const fragment = qwenFragment(e, found);
          const system = `${root}${sep}qwen-system.json`;
          Deno.writeTextFileSync(system, JSON.stringify(mergeQwenSettings({}, fragment)));
          env.QWEN_CODE_SYSTEM_SETTINGS_PATH = system;
          exe = PROGRAMS.node!;
          args = [PROGRAMS.qwen!, '--auth-type', 'anthropic', '-p', 'say hi'];
        } else {
          Object.assign(env, {
            COPILOT_OFFLINE: 'true',
            COPILOT_AUTO_UPDATE: 'false',
            COPILOT_TELEMETRY_DISABLED: 'true',
            COPILOT_PROVIDER_BASE_URL: stub.url,
            COPILOT_PROVIDER_TYPE: 'anthropic',
            COPILOT_PROVIDER_API_KEY: 'stub-key-not-real',
            COPILOT_MODEL: 'stub-model',
          });
          exe = PROGRAMS.copilot!;
          args = ['-p', 'say hi', '--allow-all-tools', ...copilotArgs(e)];
        }
        assertTestAuth(provider, [exe, ...args], env);
      }
      const out = await new Deno.Command(exe, { args, cwd: proj, clearEnv: true, env, stdin: 'null', stdout: 'piped', stderr: 'piped' })
        .output();
      await new Promise((r) => setTimeout(r, 1500)); // a late server process, a late marker
      const started = [...new Set([...Deno.readDirSync(marks)].map((m) => m.name.split('.')[0]))].sort();
      let seen = stub ? stub.dumped() : '';
      if (geminiStub) {
        for (const f of Deno.readDirSync(`${root}${sep}dump`)) seen += Deno.readTextFileSync(`${root}${sep}dump${sep}${f.name}`);
      }
      const offered = [...new Set(seen.match(/(?<![A-Za-z0-9])(rea|aibx)_(one|two)(?![A-Za-z0-9])/g) ?? [])].sort();
      return { started, offered, found, exit: out.code };
    } finally {
      if (stub) await stub.stop();
      if (geminiStub) {
        try {
          await geminiStub.stdin.getWriter().close();
        } catch { /* closed */ }
        await Promise.race([geminiStub.status, new Promise((r) => setTimeout(r, 4000))]);
        try {
          geminiStub.kill('SIGKILL'); // only the process this test started
        } catch { /* gone */ }
      }
    }
  } finally {
    for (let i = 0; i < 10; i++) {
      try {
        Deno.removeSync(root, { recursive: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  }
}
