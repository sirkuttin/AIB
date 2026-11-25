/**
 * What the (retired) Python e2e tests that run a REAL agent adapter (Claude Code, Codex) against the local stub model API shared
 * (test_folder_chat_listing_e2e.py, test_subagent_worktree_e2e.py, test_subagent_landing_e2e.py ...), for the Deno e2e_*_test.ts files:
 * the adapter lookup, the stub model API, the ACP probe, the guards on the owner's real agent folders, the keeper program build,
 * a fixture with the real adapter as the `claude` launcher, and the Aib harness (a real AIB with one Claude chat in a temp project).
 *
 * Isolation (the rules of the retired Python agent_mkdtemp): every project folder is made under _agent_tmp.ts (outside the home
 * folder), the agent gets a throwaway HOME / CLAUDE_CONFIG_DIR / CODEX_HOME, the stub keeps it off the network, and the guards check
 * that nothing reached the owner's ~/.claude or ~/.codex.
 */
import { assert, assertEquals, Chat, DENO, E2EFixture, git, Json, makeRepo, normcase, realPath, SEP, T, waitFor } from './_e2e.ts';
import { agentTempDirSync, agentTempRoot } from './_agent_tmp.ts';
import { acpProbe, stubModelApi, WORK_DIR } from './_e2e.ts';

export { agentTempDirSync, agentTempRoot, T };

const WIN = Deno.build.os === 'windows';
export const join = (...parts: string[]) => parts.join(SEP);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const uuid = () => crypto.randomUUID().replaceAll('-', '');
export const REPO_DIR = WORK_DIR.slice(0, Math.max(WORK_DIR.lastIndexOf('\\'), WORK_DIR.lastIndexOf('/')));

// ---- what is installed ---------------------------------------------------------------------------------------------------------
function run(command: string, args: string[], options: { env?: Record<string, string>; cwd?: string; timeoutMs?: number } = {}) {
  const out = new Deno.Command(command, { args, stdin: 'null', stdout: 'piped', stderr: 'piped', ...options.cwd ? { cwd: options.cwd } : {}, ...options.env ? { env: options.env, clearEnv: true } : {} })
    .outputSync();
  return { code: out.code, stdout: dec(out.stdout), stderr: dec(out.stderr) };
}

export function which(name: string): string | null {
  try {
    const out = run(WIN ? 'where' : 'which', [name]);
    const first = out.stdout.split(/\r?\n/).find((l) => l.trim());
    return out.code === 0 && first ? first.trim() : null;
  } catch {
    return null;
  }
}

function nodeExe(): string | null {
  try {
    const out = run('node', ['-p', 'process.execPath']);
    return out.code === 0 && out.stdout.trim() ? out.stdout.trim() : null;
  } catch {
    return null;
  }
}
export const NODE_EXE = nodeExe();
export const GO = which('go') ?? (WIN && isFile('C:/Program Files/Go/bin/go.exe') ? 'C:/Program Files/Go/bin/go.exe' : null);
export const KEEPER_SRC = `${REPO_DIR}${SEP}keeper`;
export const HAVE_KEEPER_BIN = !!(GO || Deno.env.get('AIB_TEST_KEEPER_BIN'));

function isFile(p: string): boolean {
  try {
    return Deno.statSync(p).isFile;
  } catch {
    return false;
  }
}

function npmRoot(): string | null {
  try {
    const out = WIN ? run('cmd', ['/c', 'npm', 'root', '-g']) : run('npm', ['root', '-g']);
    return out.code === 0 && out.stdout.trim() ? out.stdout.trim() : null;
  } catch {
    return null;
  }
}

export function adapter(envName: string, pkg: string): string | null {
  const named = Deno.env.get(envName);
  if (named) return isFile(named) ? named : null;
  const root = npmRoot();
  const entry = root ? join(root, ...pkg.split('/'), 'dist', 'index.js') : null;
  return entry && isFile(entry) ? entry : null;
}
export const CLAUDE_ACP = adapter('AIB_CLAUDE_ACP', '@agentclientprotocol/claude-agent-acp');
export const CODEX_ACP = adapter('AIB_CODEX_ACP', '@agentclientprotocol/codex-acp');
export const CLAUDE_CLI = Deno.env.get('AIB_CLAUDE_CLI') ?? which('claude');
export const SERVER_SPLIT = (Deno.env.get('AIB_SERVER') ?? 'deno-split') === 'deno-split';

/** Claude Code's projects/<name> for a folder: every character that is not a letter or digit becomes '-'. */
export const claudeEncoded = (folder: string) => folder.replace(/[^A-Za-z0-9]/g, '-');

export function makeProject(parent: string, name: string): string {
  const folder = makeRepo(join(parent, name));
  git(folder, 'config', 'core.autocrlf', 'false');
  return folder;
}

export function removeTree(path: string): void {
  for (let i = 0; i < 20; i++) {
    try {
      Deno.removeSync(path, { recursive: true });
      return;
    } catch {
      if (WIN) new Deno.Command('cmd', { args: ['/c', 'attrib', '-r', `${path}\\*`, '/s', '/d'], stdout: 'null', stderr: 'null' }).outputSync();
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
}

/** A new folder under agentTempRoot() (outside the home folder), removed by dispose. */
export class Temp {
  readonly path: string;
  constructor(prefix: string) {
    this.path = Deno.realPathSync(agentTempDirSync(prefix));
  }
  join(...parts: string[]) {
    return join(this.path, ...parts);
  }
  mkdir(...parts: string[]) {
    Deno.mkdirSync(join(this.path, ...parts), { recursive: true });
  }
  [Symbol.dispose]() {
    removeTree(this.path);
  }
}

// ---- the stub model API --------------------------------------------------------------------------------------------------------
/** The stub model API (work/stub_model_api.js) on a port the OS picks; stopped with dispose. */
export class Stub {
  port = 0;
  url = '';
  log: string;
  dump: string | null = null;
  #child!: Deno.ChildProcess;
  #stdin!: WritableStreamDefaultWriter<Uint8Array>;

  private constructor(readonly folder: string) {
    this.log = join(folder, 'stub.log');
  }

  /** rules: script mode (the model can call tools), with --dump so the test can read what the model was sent. */
  static async start(folder: string, rules?: unknown[], extraArgs: string[] = []): Promise<Stub> {
    if (!NODE_EXE) throw new Error('node is needed for the stub model API');
    const stub = new Stub(folder);
    const args = [stubModelApi, '--port', '0', '--log', stub.log, '--stdin'];
    if (rules) {
      const script = join(folder, 'script.json');
      Deno.writeTextFileSync(script, JSON.stringify({ rules }));
      stub.dump = join(folder, 'dump');
      Deno.mkdirSync(stub.dump, { recursive: true });
      args.push('--script', script, '--dump', stub.dump);
    }
    args.push(...extraArgs);
    stub.#child = new Deno.Command(NODE_EXE, { args, stdin: 'piped', stdout: 'piped', stderr: 'null' }).spawn();
    stub.#stdin = stub.#child.stdin.getWriter();
    const reader = stub.#child.stdout.getReader();
    let text = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`stub did not start: ${text}`);
      text += dec(value);
      const match = /STUB_PORT=(\d+)/.exec(text);
      if (match) {
        stub.port = Number(match[1]);
        break;
      }
    }
    reader.releaseLock();
    stub.#child.stdout.pipeTo(new WritableStream()).catch(() => {});
    stub.url = `http://127.0.0.1:${stub.port}`;
    return stub;
  }

  async stop(): Promise<void> {
    try {
      await this.#stdin.close();
    } catch { /* closed */ }
    const done = await Promise.race([this.#child.status, sleepMs(5000).then(() => null)]);
    if (done === null) {
      try {
        this.#child.kill('SIGKILL'); // only the process this test started
      } catch { /* gone */ }
      await this.#child.status;
    }
  }
  async [Symbol.asyncDispose](): Promise<void> {
    await this.stop();
  }

  calls(): Json[] {
    return this.text().split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  }
  text(): string {
    try {
      return Deno.readTextFileSync(this.log);
    } catch {
      return '';
    }
  }
  /** Everything the model was sent (the --dump files, joined). */
  dumped(): string {
    if (!this.dump) return '';
    return this.dumpFiles().map((f) => Deno.readTextFileSync(f)).join('\n');
  }
  dumpFiles(): string[] {
    if (!this.dump) return [];
    return [...Deno.readDirSync(this.dump)].filter((e) => e.name.endsWith('.json')).map((e) => join(this.dump!, e.name)).sort();
  }
}
export const stubText = (stub: Stub) => stub.text();
export const dumped = (stub: Stub) => stub.dumped();

export function stubClaudeEnv(base: Record<string, string>, stub: Stub): Record<string, string> {
  const env = { ...base };
  for (const name of ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BEDROCK_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX']) delete env[name];
  return {
    ...env,
    ANTHROPIC_BASE_URL: stub.url,
    ANTHROPIC_API_KEY: 'stub-key',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
  };
}

export const SCRUBBED = ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BEDROCK_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'];

/** The environment with every variable that names a home/config folder pointed at `home` (what the adapter-only tests use). */
export function homeEnv(temp: string, home = join(temp, 'home'), extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { ...Deno.env.toObject() };
  for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME']) env[name] = home;
  env.CLAUDE_CONFIG_DIR = join(temp, 'claude');
  env.CODEX_HOME = join(temp, 'codex');
  return { ...env, ...extra };
}

/** codex config.toml that sends Codex's model calls to the stub. */
export function writeCodexStubConfig(temp: string, stub: Stub): void {
  Deno.writeTextFileSync(
    join(temp, 'codex', 'config.toml'),
    'model = "stub-model"\nmodel_provider = "stub"\napproval_policy = "never"\nsandbox_mode = "read-only"\n' +
      'check_for_update_on_startup = false\n\n[model_providers.stub]\nname = "stub"\n' +
      `base_url = "${stub.url}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n\n` +
      '[analytics]\nenabled = false\n',
  );
}

/** Adapter-only environment of a temp folder: temp CLAUDE_CONFIG_DIR / CODEX_HOME / HOME, the stub's URL, and the codex config. */
export function adapterEnv(temp: Temp, stub: Stub): Record<string, string> {
  for (const sub of ['claude', 'codex', 'home']) temp.mkdir(sub);
  const env = stubClaudeEnv(homeEnv(temp.path), stub);
  writeCodexStubConfig(temp.path, stub);
  return env;
}

// ---- the ACP probe -------------------------------------------------------------------------------------------------------------
/** work/acp_probe.js: one command per run; the result is the last JSON line of its stdout. */
export async function probe(entry: string, env: Record<string, string>, ...args: string[]): Promise<Json> {
  return await probeWith([], entry, env, ...args);
}
export async function probeWith(flags: string[], entry: string, env: Record<string, string>, ...args: string[]): Promise<Json> {
  const out = await new Deno.Command(NODE_EXE!, { args: [acpProbe, ...flags, entry, ...args], env, clearEnv: true, stdin: 'null', stdout: 'piped', stderr: 'piped' }).output();
  const stdout = dec(out.stdout);
  const line = stdout.split(/\r?\n/).filter((l) => l.trim().startsWith('{')).pop();
  if (!line) throw new Error(`probe printed nothing: ${JSON.stringify(stdout)} ${JSON.stringify(dec(out.stderr).slice(-2000))}`);
  const result = JSON.parse(line);
  if ('error' in result) throw new Error(JSON.stringify(result));
  return result;
}

// ---- guards on the owner's real agent folders --------------------------------------------------------------------------------
const home = () => Deno.env.get('USERPROFILE') ?? Deno.env.get('HOME') ?? '';

function ownerEntries(): { names: Set<string>; files: Set<string> } {
  const projects = join(home(), '.claude', 'projects');
  const sessions = join(home(), '.codex', 'sessions');
  const names = new Set<string>();
  const files = new Set<string>();
  try {
    for (const e of Deno.readDirSync(projects)) names.add(e.name);
  } catch { /* none */ }
  const walk = (dir: string) => {
    try {
      for (const e of Deno.readDirSync(dir)) {
        const p = join(dir, e.name);
        if (e.isDirectory) walk(p);
        else if (e.name.endsWith('.jsonl')) files.add(p);
      }
    } catch { /* none */ }
  };
  walk(sessions);
  return { names, files };
}

/** Before and after: no entry for the test's projects in the owner's ~/.claude/projects or ~/.codex/sessions. */
export class OwnerGuard {
  before = ownerEntries();
  constructor(readonly projects: string[]) {}
  check(): void {
    const now = ownerEntries();
    for (const project of this.projects) {
      const enc = claudeEncoded(project);
      assert(!([...now.names].filter((n) => !this.before.names.has(n))).includes(enc), "a test chat was filed in the owner's ~/.claude/projects");
    }
    for (const path of [...now.files].filter((f) => !this.before.files.has(f))) {
      const text = Deno.readTextFileSync(path).slice(0, 20000);
      for (const project of this.projects) assert(!text.includes(JSON.stringify(project).slice(1, -1)), "a test chat was filed in the owner's ~/.codex/sessions");
    }
  }
  [Symbol.dispose]() {
    this.check();
  }
}

const REAL_TEMP = Deno.env.get('AIB_REAL_TEMP') ?? join(Deno.env.get('LOCALAPPDATA') ?? '', 'Temp');

function ownerState() {
  const projects = join(home(), '.claude', 'projects');
  const mtimes: Record<string, number | null> = {};
  for (const f of [join(home(), '.claude', 'settings.json'), join(home(), '.claude.json'), join(home(), '.claude', 'settings.local.json')]) {
    try {
      mtimes[f] = Deno.statSync(f).mtime?.getTime() ?? null;
    } catch {
      mtimes[f] = null;
    }
  }
  const list = (dir: string) => {
    try {
      return [...Deno.readDirSync(dir)].map((e) => e.name).sort();
    } catch {
      return [];
    }
  };
  return { projects: list(projects), mtimes, tempClaude: list(join(REAL_TEMP, 'claude')) };
}

/** What a run must not change: ~/.claude/projects names, the owner's Claude settings files' mtimes, the real %TEMP%\claude. */
export class OwnerUntouched {
  before = ownerState();
  constructor(readonly marks: string[]) {}
  check(): void {
    const after = ownerState();
    assertEquals(after.mtimes, this.before.mtimes, "the owner's Claude settings files changed");
    const newProjects = after.projects.filter((p) => !this.before.projects.includes(p));
    for (const mark of this.marks) {
      assertEquals(newProjects.filter((p) => p.includes(mark)), [], "a test chat was filed in the owner's ~/.claude/projects");
      assertEquals(after.tempClaude.filter((p) => !this.before.tempClaude.includes(p)).filter((p) => p.includes(mark)), [], "a test chat wrote into the owner's real %TEMP%\\claude");
    }
  }
  [Symbol.dispose]() {
    this.check();
  }
}

/** The owner's ~/.codex: its config files keep their mtimes, and no new or changed file there mentions this run. */
export class CodexOwnerUntouched {
  home = join(home(), '.codex');
  before = this.snapshot();
  constructor(readonly mark: string) {}
  snapshot(): Record<string, number> {
    const out: Record<string, number> = {};
    const walk = (dir: string) => {
      try {
        for (const e of Deno.readDirSync(dir)) {
          const p = join(dir, e.name);
          try {
            if (e.isDirectory) walk(p);
            else if (e.isFile) out[p] = Deno.statSync(p).mtime?.getTime() ?? 0;
          } catch { /* gone */ }
        }
      } catch { /* none */ }
    };
    walk(this.home);
    return out;
  }
  check(): void {
    const after = this.snapshot();
    for (const name of ['config.toml', 'hooks.json', 'requirements.toml', 'AGENTS.md']) {
      const f = join(this.home, name);
      assertEquals(after[f], this.before[f], `the owner's ~/.codex/${name} changed`);
    }
    for (const [f, m] of Object.entries(after)) {
      if (this.before[f] === m) continue;
      if (Deno.statSync(f).size > 20 * 1024 * 1024) continue;
      assert(!dec(Deno.readFileSync(f)).includes(this.mark), `a test chat reached the owner's ~/.codex (${f})`);
    }
  }
  [Symbol.dispose]() {
    this.check();
  }
}

// ---- the keeper program (it has the `hook` mode) -------------------------------------------------------------------------------
let keeperExe: string | null = null;

/** AIB_TEST_KEEPER_BIN, else built from keeper/ into a temp folder of this run (cached for the process). */
export function keeperProgram(): string {
  const named = Deno.env.get('AIB_TEST_KEEPER_BIN');
  if (named) return named;
  if (keeperExe) return keeperExe;
  const out = agentTempDirSync('aib-sr-keeper-');
  const exe = join(out, WIN ? 'AIB-keeper.exe' : 'AIB-keeper');
  const done = new Deno.Command(GO!, {
    args: ['build', '-trimpath', '-ldflags', WIN ? '-s -w -H windowsgui' : '-s -w', '-o', exe, '.'],
    cwd: KEEPER_SRC,
    env: { ...Deno.env.toObject(), CGO_ENABLED: '0', GOCACHE: join(out, 'gocache'), GOTMPDIR: '' },
    clearEnv: true,
    stdout: 'piped',
    stderr: 'piped',
  }).outputSync();
  if (done.code !== 0) throw new Error(`keeper build failed: ${dec(done.stderr).slice(-2000)}`);
  keeperExe = exe;
  globalThis.addEventListener('unload', () => {
    try {
      Deno.removeSync(out, { recursive: true });
    } catch { /* in use */ }
  });
  return exe;
}

// ---- the fixture with the real adapter as the `claude` launcher ---------------------------------------------------------------
/**
 * The e2e fixture with the REAL Claude Code adapter as the `claude` launcher, run by node, talking to the stub. The test guard
 * (acp/connection.ts guardRealAgent) is lifted for this server only; testHomeEnv still gives the agent a throwaway home, and the
 * stub keeps it off the network. keeper: AIB_KEEPER_BIN and the server's own TEMP are set as the Aib harness did.
 */
export class RealClaudeFixture extends E2EFixture {
  constructor(readonly stub: Stub, parent: string, options: { keeper?: string; tmp?: string; extraEnv?: Record<string, string> } = {}) {
    super('', parent, {
      ...stubClaudeEnv({}, stub),
      AGENT_STUDIO_ALLOW_REAL_AGENT: '1',
      ...(options.keeper ? { AIB_KEEPER_BIN: options.keeper } : {}),
      ...(options.tmp ? { TEMP: options.tmp, TMP: options.tmp, TMPDIR: options.tmp } : {}),
      ...options.extraEnv,
    });
    this.scrub = SCRUBBED;
  }

  override agentFlags(): string[] {
    const flags = super.agentFlags();
    flags[flags.indexOf('--claude-launcher') + 1] = CLAUDE_ACP!;
    flags[flags.indexOf('--node-command') + 1] = NODE_EXE!;
    return flags;
  }
}

// ---- helpers of the subagent tests ---------------------------------------------------------------------------------------------
/** Answer the chat's permission cards with their allow-once option. */
export async function approveAll(chat: Chat): Promise<void> {
  for (const item of (await chat.state()).permissions) {
    const options = ((item.params as Json | undefined)?.options as Json[] | undefined) ?? [];
    const allow = options.find((o) => o.kind === 'allow_once')?.optionId;
    if (allow) await chat.getWeb().post('permission', { id: chat.id, key: item.key, option: allow });
  }
}

export const agentCall = (tid: string, desc: string, prompt: string, background = false, kind = 'general-purpose') => ({
  id: tid,
  name: 'Agent',
  input: { description: desc, prompt, subagent_type: kind, run_in_background: background },
});
export const bash = (tid: string, command: string) => ({ id: tid, name: 'Bash', input: { command, description: 'sr step' } });

export async function notes(chat: Chat): Promise<string[]> {
  return (await chat.state()).events.filter((e) => e.kind === 'studio_note').map((e) => String((e.data as Json)?.message ?? ''));
}

export function subagentRecords(state: string): Record<string, Json> {
  try {
    return JSON.parse(Deno.readTextFileSync(join(state, 'subagent-worktrees.json'))).subagents ?? {};
  } catch {
    return {};
  }
}
export const gitLog = (project: string) => git(project, 'log', '--format=%s', '-n', '20');

export async function hmacHex(secret: Uint8Array, message: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new Uint8Array(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new Uint8Array(message)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The Aib harness: a real AIB with one Claude chat in a temp git project, driven turn by turn (test_subagent_landing_e2e.py Aib). */
export class Aib {
  temp!: Temp;
  mark = `srp2${uuid().slice(0, 6)}`;
  project!: string;
  stub!: Stub;
  fx!: RealClaudeFixture;
  web!: import('./_host_fixture.ts').Web;
  chat!: Chat;
  guard!: OwnerUntouched;

  static async start(rules: unknown[], options: { setup?: (aib: Aib) => void; seed?: (aib: Aib) => void } = {}): Promise<Aib> {
    const aib = new Aib();
    aib.temp = new Temp('aib-sr2-');
    aib.project = makeProject(aib.temp.path, aib.mark);
    options.setup?.(aib);
    aib.guard = new OwnerUntouched([aib.mark]);
    aib.stub = await Stub.start(aib.temp.path, rules);
    const keeper = keeperProgram();
    aib.temp.mkdir('tmp');
    aib.fx = new RealClaudeFixture(aib.stub, agentTempRoot(), { keeper, tmp: aib.temp.join('tmp') });
    options.seed?.(aib); // state left from before AIB starts (fx.state exists, nothing runs yet)
    aib.web = await aib.fx.startWeb();
    const [status, connection] = await aib.web.post('connect', { provider: 'claude', cwd: aib.project, background: true });
    assertEquals(status, 200, JSON.stringify(connection));
    aib.chat = new Chat(null, connection.id as string, aib.web);
    await waitFor(async () => {
      const s = await aib.chat.state();
      if (s.error) throw new Error(String(s.error));
      return s.ready;
    }, 'chat ready');
    return aib;
  }

  async turn(text: string): Promise<void> {
    // AIB may have woken the chat itself (a landing that needs the main agent steers it): that turn ends first
    await waitFor(async () => {
      await approveAll(this.chat);
      return !(await this.chat.state()).busy;
    }, 'the chat to be idle', 120);
    const before = (await this.chat.state()).events.filter((e) => e.kind === 'turn_end').length;
    const [code] = await this.web.post('prompt', { id: this.chat.id, text, clientMessageId: uuid() });
    assertEquals(code, 200);
    await waitFor(async () => {
      await approveAll(this.chat);
      const state = await this.chat.state();
      return !state.busy && state.events.filter((e) => e.kind === 'turn_end').length > before;
    }, `the turn ${JSON.stringify(text)} to end`, 240);
  }

  async wait(what: string, check: () => unknown | Promise<unknown>, seconds = 60): Promise<void> {
    await waitFor(async () => {
      await approveAll(this.chat);
      return await check();
    }, what, seconds);
  }

  async dispose(): Promise<void> {
    await this.fx?.cleanup();
    await this.stub?.stop();
    try {
      this.guard?.check();
    } finally {
      this.temp?.[Symbol.dispose]();
    }
  }
  async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }
}

// ---- a child process the test started (the "other app" of the open-elsewhere tests) -------------------------------------------
/** A process this test started: piped stdin, its output collected; only ever stopped by its own handle. */
export class Spawned {
  out: Uint8Array[] = [];
  err: Uint8Array[] = [];
  lines: string[] = [];
  #stdin: WritableStreamDefaultWriter<Uint8Array> | null = null;
  #stdinClosed = false;
  exited = false;
  code: number | null = null;
  child!: Deno.ChildProcess;

  constructor(command: string, args: string[], options: { env?: Record<string, string>; cwd?: string; onStdoutLine?: (line: string) => void } = {}) {
    this.child = new Deno.Command(command, {
      args,
      stdin: 'piped',
      stdout: 'piped',
      stderr: 'piped',
      ...options.cwd ? { cwd: options.cwd } : {},
      ...options.env ? { env: options.env, clearEnv: true } : {},
    }).spawn();
    this.#stdin = this.child.stdin.getWriter();
    let buffer = '';
    (async () => {
      for await (const chunk of this.child.stdout) {
        this.out.push(chunk);
        buffer += dec(chunk);
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          this.lines.push(line);
          options.onStdoutLine?.(line);
        }
      }
    })().catch(() => {});
    (async () => {
      for await (const chunk of this.child.stderr) this.err.push(chunk);
    })().catch(() => {});
    this.child.status.then((s) => {
      this.exited = true;
      this.code = s.code;
    }, () => {});
  }

  get pid(): number {
    return this.child.pid;
  }
  stdoutText(): string {
    return this.out.map(dec).join('');
  }
  stderrText(): string {
    return this.err.map(dec).join('');
  }
  async write(text: string): Promise<void> {
    await this.#stdin!.write(new TextEncoder().encode(text));
  }
  async closeStdin(): Promise<void> {
    if (this.#stdinClosed) return;
    this.#stdinClosed = true;
    try {
      await this.#stdin!.close();
    } catch { /* closed */ }
  }
  /** Wait for the process to end; returns its exit code (null on the deadline). */
  async waitExit(seconds: number): Promise<number | null> {
    const r = await Promise.race([this.child.status, sleepMs(seconds * 1000).then(() => null)]);
    return r === null ? null : (r as Deno.CommandStatus).code;
  }
  async stop(): Promise<void> {
    if (!this.exited) {
      await this.closeStdin();
      if ((await this.waitExit(20)) === null) {
        try {
          this.child.kill('SIGKILL'); // only the process this test started
        } catch { /* gone */ }
        await this.waitExit(10);
      }
    }
    await sleepMs(200); // the readers see the end of the output first
  }
  async [Symbol.asyncDispose](): Promise<void> {
    await this.stop();
  }
}

export function pidAlive(pid: number): boolean {
  if (pid <= 0) return false;
  if (WIN) {
    const out = run('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV']);
    return out.stdout.includes(`"${pid}"`);
  }
  try {
    Deno.kill(pid, 0 as never);
    return true;
  } catch {
    return false;
  }
}

/** Nothing here ends a process but its own handle (Spawned) or, for a keeper of this test's own program, its exact pid. */
export function keeperPids(keeper: string): number[] {
  if (!WIN) return [];
  const name = keeper.slice(Math.max(keeper.lastIndexOf('\\'), keeper.lastIndexOf('/')) + 1);
  const out = run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Get-CimInstance Win32_Process -Filter "Name='${name}'" | ForEach-Object { "$($_.ProcessId)\`t$($_.ExecutablePath)" }`,
  ]);
  const want = normcase(keeper);
  return out.stdout.split(/\r?\n/).filter((l) => l.includes('\t') && normcase(l.split('\t').slice(1).join('\t').trim()) === want).map((l) => Number(l.split('\t')[0]));
}

// ---- Codex: the AibCodex harness (test_subagent_codex_e2e.py) ------------------------------------------------------------------
export const spawnCall = (tid: string, message: string) => ({ id: tid, name: 'multi_agent_v1.spawn_agent', input: { message } });
export const waitCall = (tid: string) => ({ id: tid, name: 'multi_agent_v1.wait_agent', input: { targets: ['@CAP@'], timeout_ms: 60000 } });
export const execCall = (tid: string, cmd: string) => ({ id: tid, name: 'exec_command', input: { cmd } });

/** A real AIB with one Codex chat in a temp git project, driven turn by turn. */
export class AibCodex {
  temp!: Temp;
  cards: { title: string; raw: string; id?: string; label?: string }[] = [];
  seen = new Set<string>();
  mark = `srcx${uuid().slice(0, 6)}`;
  project!: string;
  stub!: Stub;
  fx!: E2EFixture;
  web!: import('./_host_fixture.ts').Web;
  chat!: Chat;
  guard!: CodexOwnerUntouched;
  skipped = false;

  /** rules: a list, or a function of the project folder (known only once this made it). userConfig: merged into CODEX_CONFIG. */
  static async start(rules: unknown[] | ((project: string) => unknown[]), userConfig: Record<string, unknown> = {}, options: { keeper?: boolean } = {}): Promise<AibCodex> {
    const aib = new AibCodex();
    aib.temp = new Temp('aib-srcx-');
    if (aib.temp.path.includes(' ')) throw new Error('the temp folder has a space: Codex hooks cannot name the keeper there (TEMP=a scratch folder)');
    aib.project = makeProject(aib.temp.path, aib.mark);
    aib.guard = new CodexOwnerUntouched(aib.mark);
    aib.stub = await Stub.start(aib.temp.path, typeof rules === 'function' ? rules(aib.project) : rules);
    const keeper = keeperProgram();
    const provider = {
      model: 'stub-model',
      model_provider: 'stub',
      model_providers: { stub: { name: 'stub', base_url: `${aib.stub.url}/v1`, wire_api: 'responses', requires_openai_auth: false, supports_websockets: false } },
      analytics: { enabled: false },
      check_for_update_on_startup: false,
      approvals_reviewer: 'user', // approvals come to AIB (its permission cards), not to an automatic reviewer model
    };
    const config = { ...provider, ...userConfig };
    aib.temp.mkdir('tmp');
    const tmp = aib.temp.join('tmp');
    aib.fx = new CodexFixture(options.keeper === true, agentTempRoot(), {
      AGENT_STUDIO_ALLOW_REAL_AGENT: '1',
      AIB_KEEPER_BIN: keeper,
      CODEX_CONFIG: JSON.stringify(config),
      TEMP: tmp,
      TMP: tmp,
      TMPDIR: tmp,
    });
    aib.fx.scrub = ['OPENAI_API_KEY', 'CODEX_HOME', 'CODEX_PATH'];
    aib.web = await aib.fx.startWeb();
    // Workspace access: the sandboxed mode whose approvals come to AIB's permission cards (the default Auto review mode asks a
    // reviewer model, which the stub is not); a subagent's write in its worktree (outside the chat's folder) asks there
    const [status, connection] = await aib.web.post('connect', { provider: 'codex', cwd: aib.project, background: true, picks: { mode: 'workspace-write' } });
    assertEquals(status, 200, JSON.stringify(connection));
    aib.chat = new Chat(null, connection.id as string, aib.web);
    await waitFor(async () => {
      const s = await aib.chat.state();
      if (s.error) throw new Error(String(s.error));
      return s.ready;
    }, 'chat ready', 120);
    return aib;
  }

  /** Answer every permission card with allow-once, keeping what each asked (this.cards: title and rawInput). */
  async approve(): Promise<void> {
    for (const item of (await this.chat.state()).permissions) {
      const call = ((item.params as Json | undefined)?.toolCall as Json | undefined) ?? {};
      if (!this.seen.has(item.key as string)) {
        this.seen.add(item.key as string);
        const rule = ((((item.allow as Json | undefined)?.project as Json | undefined)?.rules as Json[] | undefined) ?? [])[0];
        this.cards.push({ title: String(call.title), raw: JSON.stringify(call.rawInput ?? null).slice(0, 600), id: String(call.toolCallId), label: rule ? String(rule.label) : '' });
      }
    }
    await approveAll(this.chat);
  }

  async turn(text: string, seconds = 300): Promise<void> {
    const before = (await this.chat.state()).events.filter((e) => e.kind === 'turn_end').length;
    const [code] = await this.web.post('prompt', { id: this.chat.id, text: `${text} ${this.mark}`, clientMessageId: uuid() });
    assertEquals(code, 200);
    await waitFor(async () => {
      await this.approve();
      const state = await this.chat.state();
      return !state.busy && state.events.filter((e) => e.kind === 'turn_end').length > before;
    }, `the turn ${JSON.stringify(text)} to end`, seconds);
  }

  async wait(what: string, check: () => unknown | Promise<unknown>, seconds = 90): Promise<void> {
    await waitFor(async () => {
      await this.approve();
      return await check();
    }, what, seconds);
  }

  async report(): Promise<string> {
    const calls = this.stub.calls();
    const steps = calls.filter((c) => String(c.path ?? '').endsWith('/responses')).map((c) => [c.rule, String(c.last ?? '').slice(-300)]);
    const logs: string[] = [];
    const walk = (dir: string) => {
      try {
        for (const e of Deno.readDirSync(dir)) {
          const p = join(dir, e.name);
          if (e.isDirectory) walk(p);
          else if (e.name.endsWith('.log')) {
            const keep = Deno.readTextFileSync(p).split('\n').filter((x) => x.includes('ubagent') || x.toLowerCase().includes('land')).slice(-15);
            logs.push(...keep);
          }
        }
      } catch { /* gone */ }
    };
    walk(this.fx.root);
    return JSON.stringify({ records: subagentRecords(this.fx.state), notes: await notes(this.chat), steps, logs }, null, 1).slice(-12000);
  }

  async dispose(): Promise<void> {
    await this.fx?.cleanup();
    await this.stub?.stop();
    try {
      this.guard?.check();
    } finally {
      this.temp?.[Symbol.dispose]();
    }
  }
  async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }
}

class CodexFixture extends E2EFixture {
  constructor(readonly keeper: boolean, parent: string, extraEnv: Record<string, string>) {
    super('worktree-e2e-agent.mjs', parent, extraEnv);
  }
  /** keeper: the chat's agent runs in the keeper (AIB's MCP forwarder entry), as in a real build; else the split agent host. */
  override get env(): Record<string, string> {
    const env = { ...super.env };
    if (this.keeper) delete env.AIB_KEEPER;
    return env;
  }
  override agentFlags(): string[] {
    return [...super.agentFlags(), '--codex-launcher', CODEX_ACP!, '--node-command', NODE_EXE!];
  }
}

export { DENO, normcase, realPath };
