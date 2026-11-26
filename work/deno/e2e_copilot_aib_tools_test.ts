/**
 * GitHub Copilot CLI gets AIB's own tools (server/agents/copilot_mcp.ts): e2e with the REAL copilot program over ACP, as AIB launches it,
 * against the local stub model API in script mode (work/stub_model_api.js, Anthropic /v1/messages). In-process AIB, no keeper, no window,
 * no network. Facts: aib-shared/research/provider-builder-probe-2026-11-25.md (Copilot CLI 1.0.109: ACP mcpServers ignored,
 * `--additional-mcp-config @<file>` works, tools named `<server>-<tool>`).
 *
 *   chat   a chat opened through AIB (Aib.connect) starts Copilot with `--additional-mcp-config @<state>/copilot/<chat>/mcp.json`
 *          next to the subagents-off flag; the model request lists AIB's tools as studio_artifact-<tool>, and no subagent tool;
 *   call   the scripted model calls studio_artifact-doc (action list): the call reaches AIB's tool server and its answer goes back to the
 *          model, through AIB's approvals (allow/own_tools.ts) like every other agent's.
 *
 * SAFETY (an earlier builder's test reached Google with the owner's real sign-in): before any prompt is sent the test checks the model
 * address is the stub on 127.0.0.1, HOME, USERPROFILE, APPDATA, LOCALAPPDATA, XDG_* and COPILOT_HOME are temp folders outside the owner's
 * home, no token or key variable of the owner's is left, and Copilot runs offline with a local model provider (COPILOT_OFFLINE,
 * COPILOT_PROVIDER_*: no GitHub sign-in, token, keyring or `gh`); AIB's own test auth guard (acp/test_auth_guard.ts) checks the launch
 * again. The program is not installed by this test: AIB_COPILOT_EXE names copilot.exe (@github/copilot-win32-x64 1.0.109); without it
 * the test is skipped. Copilot is not in WSL here, so the WSL route is the fake host in copilot_mcp_test.ts.
 */
import { assert, assertEquals } from './_assert.ts';
import { agentTempDirSync } from './_agent_tmp.ts';
import { pause, until } from './_connection.ts';
import { WORK } from './_work.ts';
import { Aib } from '../../app/server/host/aib.ts';
import { pathOf } from '../../app/server/state/paths.ts';
import { serversOf } from '../../app/server/agents/copilot_mcp.ts';
import { COPILOT_AGENT_TOOLS, nativeOffCommand } from '../../app/server/subagents/native_off.ts';

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
const COPILOT_EXE = exeOf('AIB_COPILOT_EXE');

class Stub {
  readonly child: Deno.ChildProcess;
  port = 0;
  readonly log: string;
  readonly dump: string;
  constructor(folder: string, script: string) {
    this.log = pathOf(folder, 'stub.log');
    this.dump = pathOf(folder, 'dump');
    Deno.mkdirSync(this.dump, { recursive: true });
    this.child = new Deno.Command('node', {
      args: [STUB, '--port', '0', '--stdin', '--log', this.log, '--dump', this.dump, '--script', script],
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

const SCRIPT_RULES = {
  rules: [
    {
      when: 'list my docs',
      in: 'last',
      reply: { text: 'Listing.', tools: [{ id: 'toolu_doc1', name: 'studio_artifact-doc', input: { action: 'list' } }] },
    },
    { when: 'toolu_doc1', in: 'last', reply: { text: 'DOC-LIST-DONE' } },
  ],
};

Deno.test({
  name: "Copilot e2e: a chat opened through AIB lists AIB's tools as studio_artifact-<tool>, and a tool call reaches AIB",
  ...T,
  ignore: !COPILOT_EXE,
  async fn() {
    const saved = Object.fromEntries(
      [...HOME_VARS, ...SECRET_VARS, 'TEMP', 'TMP', 'TMPDIR', 'PATH', 'AGENT_STUDIO_TEST', 'AGENT_STUDIO_ALLOW_REAL_AGENT', 'COPILOT_HOME']
        .map((k) => [
          k,
          Deno.env.get(k),
        ]),
    );
    const root = Deno.realPathSync(agentTempDirSync('aib-copilot-tools-')); // outside the owner's home
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
    // no GitHub CLI on the program's PATH: a sign-in of the owner's must not be reachable by any route
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
    const script = pathOf(root, 'script.json');
    Deno.writeTextFileSync(script, JSON.stringify(SCRIPT_RULES));
    const stub = new Stub(root, script);
    const stateDir = pathOf(root, 'state');
    const aib = new Aib({ stateDir, port: 0, ownersDir: null });
    aib.ownerProbe = () => null;
    // AIB's web server for the tool: the doc route, answering an empty list, and what it was sent (the key and the chat's id are checked)
    const seen: { path: string; key: string; body: Json }[] = [];
    const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, async (request) => {
      seen.push({
        path: new URL(request.url).pathname,
        key: request.headers.get('x-studio-artifact-key') ?? '',
        body: await request.json() as Json,
      });
      return Response.json({ ok: true, result: { docs: [], text: 'AIB-DOC-LIST: no docs yet' } });
    });
    aib.artifactUrlProvider = () => `http://127.0.0.1:${server.addr.port}`;
    try {
      await stub.start();
      const env: Record<string, string> = {
        COPILOT_HOME: pathOf(home, 'copilot'),
        COPILOT_CACHE_HOME: pathOf(home, 'cache'),
        COPILOT_OFFLINE: 'true', // no GitHub sign-in, telemetry or update check
        COPILOT_AUTO_UPDATE: 'false',
        COPILOT_TELEMETRY_DISABLED: 'true',
        COPILOT_PROVIDER_BASE_URL: `http://127.0.0.1:${stub.port}`, // the stub, as a bring-your-own-key model provider
        COPILOT_PROVIDER_TYPE: 'anthropic',
        COPILOT_PROVIDER_API_KEY: 'stub-key-not-real',
        COPILOT_MODEL: 'stub-model',
      };
      // ---- safety, before any prompt ----
      for (const v of HOME_VARS) assert(Deno.env.get(v)!.startsWith(root), `${v} is a temp folder: ${Deno.env.get(v)}`);
      for (const v of SECRET_VARS) if (!(v in env)) assertEquals(Deno.env.get(v), undefined, `${v} is not set`);
      assertEquals(env.COPILOT_PROVIDER_BASE_URL, `http://127.0.0.1:${stub.port}`, 'the model is the local stub');
      assertEquals(env.COPILOT_OFFLINE, 'true');
      assert(env.COPILOT_HOME.startsWith(root), 'its own folder, never ~/.copilot');
      assert(Object.values(env).every((v) => !/api\.(anthropic|openai|githubcopilot)\.com|github\.com/.test(v)));

      const base = [COPILOT_EXE!, '--acp', '--no-auto-update'];
      aib.agentLaunch = () => Promise.resolve([base, env]);
      const c = await aib.connect('copilot', project, null, {});
      await until(() => !!c.sessionId, 'session/new answered', 120);
      // the command it runs: the config file named right after --acp, beside the subagents-off flag
      const file = pathOf(stateDir, 'copilot', c.id, 'mcp.json');
      assertEquals(c.command, [
        COPILOT_EXE!,
        '--acp',
        '--additional-mcp-config',
        `@${file}`,
        ...nativeOffCommand('copilot', base)!.slice(2),
      ]);
      const servers = serversOf(Deno.readTextFileSync(file));
      assertEquals(Object.keys(servers), ['studio_artifact']);
      assertEquals((servers.studio_artifact as Json).tools, ['*']);

      await aib.liveCall('prompt', { id: c.id, text: 'please list my docs', clientMessageId: 'm1' });
      await until(() => !c.busy && stub.bodies().some((b) => b.includes('toolu_doc1')), 'the tool result reached the stub', 120);
      // the model is offered AIB's tools by Copilot's names, and no subagent tool
      const first = stub.messageCalls()[0];
      for (const tool of ['publish', 'artifacts', 'doc', 'drawing', 'helper']) {
        assert(first.tools.includes(`studio_artifact-${tool}`), `studio_artifact-${tool} is offered: ${first.tools}`);
      }
      for (const tool of COPILOT_AGENT_TOOLS) assert(!first.tools.includes(tool), `no ${tool}: ${first.tools}`);
      // the call reached AIB: its answer went back to the model as the tool result
      const body = JSON.parse(stub.bodies().filter((b) => b.includes('toolu_doc1')).at(-1)!) as Json;
      const blocks = ((body.messages ?? []) as Json[]).flatMap((m) => (Array.isArray(m.content) ? m.content as Json[] : []));
      const result = blocks.find((b) => b.type === 'tool_result' && b.tool_use_id === 'toolu_doc1');
      assert(result, 'a tool_result went back to the model');
      const text = JSON.stringify(result.content);
      assert(result.is_error !== true, 'the tool call did not fail: ' + text);
      // it reached AIB: the doc route got the call, with this chat's id and its key, and AIB's answer is what the model got back
      assertEquals(seen.length, 1, JSON.stringify(seen));
      assertEquals(seen[0].path, '/api/live/docs/tool');
      assertEquals(seen[0].body.conversationId, c.id);
      assert(String(seen[0].body.tool).startsWith('doc'), String(seen[0].body.tool));
      assert(seen[0].key.length > 8, 'the chat key went with it');
      assert(text.includes('AIB-DOC-LIST'), "AIB's answer reached the model: " + text);
      await until(() => !c.busy, 'the turn ended', 60);
      assert(c.events.some((e) => JSON.stringify(e.data ?? {}).includes('DOC-LIST-DONE')), 'the model answered after the tool result');
      assert(stub.calls().every((x) => x.path.startsWith('/v1/')), JSON.stringify(stub.calls()));
    } finally {
      await aib.close().catch(() => {});
      await server.shutdown();
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
