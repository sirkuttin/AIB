/**
 * What the Python end-to-end tests (work/test_*_e2e.py, with _e2e_support.py, _isolation.py, host_support.py and server_under_test.py)
 * shared, for the Deno e2e_*_test.ts files: a fixture whose web server and agent host are real processes, a Chat seen through the
 * page's HTTP API, an Env with projects and chats, git helpers, and the fake agent launch.
 *
 * Which server: AIB_SERVER=deno-split (default: the Deno web server and the Deno agent host) or deno (--in-process: the tests
 * that stop or replace the host are skipped). Everything goes through the HTTP API with the page token, as the page does.
 */
import { assert, assertEquals } from './_assert.ts';
import { FAKE_HOST, Fixture, httpJson, Json, PY, SEP, sleep, until, Web } from './_host_fixture.ts';
import { WORK } from './_work.ts';
import { APP_ROOT } from '../../app/server/core/app.ts';
import { CODE_ROOT, HostClient, pidAlive, PROTOCOL_VERSION, readInfo } from '../../app/server/host/host_client.ts';
import { repoHash } from '../../app/server/worktrees/worktrees.ts';

export { assert, assertEquals, httpJson, pidAlive, readInfo, repoHash, SEP, sleep, until, Web };
export type { Json };

const WIN = Deno.build.os === 'windows';
export const SERVER_KIND = Deno.env.get('AIB_SERVER') ?? 'deno-split';
export const DENO = Deno.env.get('AIB_DENO') ?? Deno.execPath();
export const WAIT = 90; // seconds: a deadline, not a delay
export const T = { sanitizeResources: false, sanitizeOps: false };

const nativeOf = (url: URL) => {
  const path = decodeURIComponent(url.pathname);
  return WIN ? path.replace(/^\/([A-Za-z]:)/, '$1').replaceAll('/', '\\') : path;
};
export const WORK_DIR = nativeOf(WORK).replace(/[\\/]+$/, '');
export const stubModelApi = `${WORK_DIR}${SEP}stub_model_api.js`;
export const acpProbe = `${WORK_DIR}${SEP}acp_probe.js`;

// ---- the fake agent launch: the ONE place the e2e tests start a fake agent --------------------------------------------------
/**
 * TEMP (fork B, until work/fakes/*.mjs land): the Python fakes, started with python as the "node command". After the merge of the
 * fake-agent port, flip this one function to `{ node: NODE, script: fakePath('<name>.mjs') }` (work/deno/_fakes.ts).
 * `name` is the Python launcher's file under work/ (for example 'worktree-e2e-agent.py').
 */
export function fakeLaunch(name: string): { node: string; script: string } {
  return { node: PY, script: `${WORK_DIR}${SEP}${name.replaceAll('/', SEP)}` };
}

// ---- waits and git -----------------------------------------------------------------------------------------------------------
/** Poll a condition (sync or async) until it is truthy; a deadline, never a delay. A thrown error counts as "not yet" unless `strict`. */
export async function waitFor<T>(condition: () => T | Promise<T>, what: string, seconds = WAIT): Promise<NonNullable<T>> {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const value = await condition();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(50);
  }
}

export function quote(value: unknown): string {
  return encodeURIComponent(String(value));
}

export function runGit(cwd: string, ...args: string[]): string {
  const done = new Deno.Command('git', {
    args: ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...args],
    cwd,
    stdin: 'null',
    stdout: 'piped',
    stderr: 'piped',
  }).outputSync();
  const text = (b: Uint8Array) => new TextDecoder().decode(b).replace(/\r\n?/g, '\n');
  if (done.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${text(done.stderr)}`);
  return text(done.stdout);
}
export const git = runGit;
export const porcelain = (folder: string) => git(folder, 'status', '--porcelain=v1', '-uall');

export function makeRepo(folder: string): string {
  Deno.mkdirSync(folder, { recursive: true });
  git(folder, 'init', '-b', 'main');
  Deno.writeTextFileSync(`${folder}${SEP}tracked.txt`, 'one\n');
  Deno.writeTextFileSync(`${folder}${SEP}.gitignore`, 'ignored.log\nbuild/\nnode_modules/\n');
  git(folder, 'add', '-A');
  git(folder, 'commit', '-m', 'first');
  return folder;
}

const join = (...parts: string[]) => parts.join(SEP);
export function writeFiles(folder: string, files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    const target = join(folder, ...name.split('/'));
    Deno.mkdirSync(target.slice(0, Math.max(target.lastIndexOf('\\'), target.lastIndexOf('/'))), { recursive: true });
    Deno.writeFileSync(target, new TextEncoder().encode(content));
  }
}

/** The file's text as written (no newline translation), or null when it cannot be read. */
export function readFile(folder: string, name: string): string | null {
  try {
    return new TextDecoder().decode(Deno.readFileSync(join(folder, ...name.split('/'))));
  } catch {
    return null;
  }
}

export const same = (a: string, b: string) => (WIN ? a.toLowerCase() === b.toLowerCase() : a === b);
export const normcase = (p: string) => (WIN ? p.replaceAll('/', '\\').toLowerCase() : p);
export const isDir = (p: string) => {
  try {
    return Deno.statSync(p).isDirectory;
  } catch {
    return false;
  }
};
export const isFile = (p: string) => {
  try {
    return Deno.statSync(p).isFile;
  } catch {
    return false;
  }
};
export const baseName = (p: string) => p.slice(Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')) + 1);
export const parentOf = (p: string) => p.slice(0, Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')));
export function realPath(p: string): string {
  try {
    return Deno.realPathSync(p);
  } catch {
    return p;
  }
}

/** {chatKey: record} from studio-worktrees.json (what the page's side reads); {} when there is none. */
export function worktreeRecords(state: string): Record<string, Json> {
  try {
    const raw = JSON.parse(Deno.readTextFileSync(join(state, 'studio-worktrees.json')));
    const items = raw?.worktrees;
    if (!items || typeof items !== 'object') return {};
    return Object.fromEntries(Object.entries(items).filter(([, v]) => v && typeof v === 'object')) as Record<string, Json>;
  } catch {
    return {};
  }
}

/** Skip a test of a split-only behaviour when the server under test is --in-process. */
export const SPLIT = SERVER_KIND !== 'deno';

// ---- the fixture -------------------------------------------------------------------------------------------------------------
/**
 * The agent-host fixture (_host_fixture.ts Fixture) with a fake agent as the `claude` launcher. AIB_TEST_COPY_CHATS: connect's
 * ownCopy makes a chat in its own copy, as AIB did before 2026-11-16 (a copy chat made before keeps its copy; Merge and Discard are
 * what the worktree tests cover).
 */
export class E2EFixture extends Fixture {
  constructor(readonly launcher = 'worktree-e2e-agent.py', parent?: string, readonly extraEnv: Record<string, string> = {}) {
    super(parent);
  }

  override get env(): Record<string, string> {
    const env = { ...super.env, AIB_TEST_COPY_CHATS: '1', AIB_SEAL: 'off', ...this.extraEnv };
    if (SERVER_KIND === 'deno') delete (env as Record<string, string | undefined>).AIB_KEEPER;
    return env;
  }

  override agentFlags(): string[] {
    const flags = super.agentFlags();
    const { node, script } = fakeLaunch(this.launcher);
    flags[flags.indexOf('--claude-launcher') + 1] = script;
    flags[flags.indexOf('--node-command') + 1] = node;
    return flags;
  }

  override startWeb(extra: string[] = [], options: { wait?: boolean; env?: Record<string, string>; pinPort?: boolean } = {}): Promise<Web> {
    return super.startWeb(SERVER_KIND === 'deno' ? ['--in-process', ...extra] : extra, options);
  }
}

// ---- a conversation seen through the page's HTTP API ---------------------------------------------------------------------------
export class Chat {
  constructor(readonly env: { web: Web } | null, readonly id: string, readonly web: Web | null = null) {}

  getWeb(): Web {
    return (this.web ?? this.env!.web) as Web;
  }

  async state(after?: number): Promise<Json & { permissions: Json[]; events: { kind: string; data: Json }[] }> {
    const [status, data] = await this.getWeb().get(`/api/live/state?id=${this.id}` + (after !== undefined ? `&after=${after}` : ''));
    if (status !== 200) throw new Error(`state ${status}: ${JSON.stringify(data)}`);
    return data as never;
  }
  async cwd(): Promise<string> {
    return (await this.state()).cwd as string;
  }
  async projectRoot(): Promise<string> {
    return (await this.state()).projectRoot as string;
  }
  async session(): Promise<string> {
    return (await this.state()).sessionId as string;
  }

  /** Let whatever the chat is doing finish (it asks permission for text the fake does not know, e.g. Studio's own guidance). */
  async settle(): Promise<void> {
    await waitFor(async () => {
      const state = await this.state();
      for (const item of state.permissions) await this.getWeb().post('permission', { id: this.id, key: item.key, option: 'yes' });
      return !state.busy && !state.permissions.length;
    }, `chat ${this.id} idle`);
  }

  /** One turn: send the text and return what the agent said. status != 200 expects the send to be refused (returns the payload). */
  async send(text: string, status = 200, messageId?: string): Promise<string> {
    await this.settle();
    const before = (await this.state()).cursor as number;
    const [code, sent] = await this.getWeb().post('prompt', { id: this.id, text, clientMessageId: messageId ?? crypto.randomUUID().replaceAll('-', '') });
    if (status !== 200) {
      assertEquals(code, status, JSON.stringify(sent));
      return sent as never;
    }
    assertEquals(code, 200, JSON.stringify(sent));
    const state = await waitFor(async () => {
      const s = await this.state(before);
      for (const item of s.permissions) await this.getWeb().post('permission', { id: this.id, key: item.key, option: 'yes' });
      if (s.busy || !s.events.some((e) => e.kind === 'turn_end')) return null;
      return s;
    }, `the turn ${JSON.stringify(text.slice(0, 30))} to end`);
    return state.events
      .filter((e) => e.kind === 'update' && ((e.data.update as Json).sessionUpdate === 'agent_message_chunk'))
      .map((e) => (((e.data.update as Json).content as Json).text as string))
      .join('');
  }

  async events(kind: string): Promise<Json[]> {
    return (await this.state(0)).events.filter((e) => e.kind === kind).map((e) => e.data);
  }
  notes(): Promise<Json[]> {
    return this.events('studio_note');
  }
  async changes(): Promise<Json & { files: Json[] }> {
    const [status, data] = await this.getWeb().get(`/api/live/changes?id=${this.id}&scope=uncommitted`);
    assertEquals(status, 200, JSON.stringify(data));
    return data as never;
  }
  async changedPaths(): Promise<string[]> {
    return (await this.changes()).files.map((f) => f.path as string).sort();
  }
  async worktreeStatus(): Promise<Json> {
    const [status, data] = await this.getWeb().get(`/api/live/worktree?id=${this.id}`);
    assertEquals(status, 200, JSON.stringify(data));
    return data;
  }
  async merge(title = 'T', status = 200): Promise<Json> {
    const [code, data] = await this.getWeb().post('worktree/merge', { id: this.id, title });
    assertEquals(code, status, JSON.stringify(data));
    return data;
  }
  async clash(action: string, status = 200): Promise<Json> {
    const [code, data] = await this.getWeb().post('worktree/clash', { id: this.id, action });
    assertEquals(code, status, JSON.stringify(data));
    return data;
  }
  async disconnect(): Promise<void> {
    assertEquals((await this.getWeb().post('disconnect', { id: this.id }))[0], 200);
  }
}

/** The text of every agent message in the state's events. */
export function chatText(events: { kind: string; data: Json }[]): string {
  return events
    .filter((e) => e.kind === 'update' && ((e.data.update as Json).sessionUpdate === 'agent_message_chunk'))
    .map((e) => (((e.data.update as Json).content as Json).text as string))
    .join('');
}

// ---- an environment: a host and web server over one temp state folder, projects and chats ------------------------------------
export class Env {
  fx: E2EFixture;
  web!: Web;
  state: string;
  root: string;
  chats: Chat[] = [];

  constructor(options: { launcher?: string; parent?: string; env?: Record<string, string> } = {}) {
    this.fx = new E2EFixture(options.launcher, options.parent, options.env);
    this.state = this.fx.state;
    this.root = this.fx.root;
  }

  /** Start the web server (and, split, the host) with worktreePerChat on. */
  static async start(options: { launcher?: string; parent?: string; env?: Record<string, string>; worktreePerChat?: boolean } = {}): Promise<Env> {
    const env = new Env(options);
    env.web = await env.fx.startWeb();
    if (options.worktreePerChat ?? true) {
      const [status] = await env.web.post('settings', { server: { worktreePerChat: true } });
      assertEquals(status, 200);
    }
    return env;
  }

  async cleanup(): Promise<void> {
    await this.fx.cleanup();
  }
  async [Symbol.asyncDispose](): Promise<void> {
    await this.cleanup();
  }

  // ---- projects ----
  project(name: string, files?: Record<string, string>, useGit = true): string {
    const folder = join(this.root, `proj-${name}`);
    if (useGit) {
      makeRepo(folder);
      git(folder, 'config', 'core.autocrlf', 'false');
      if (files) {
        this.write(folder, files);
        git(folder, 'add', '-A');
        git(folder, 'commit', '-m', 'more files');
      }
    } else {
      Deno.mkdirSync(folder, { recursive: true });
      this.write(folder, files ?? {});
    }
    return folder;
  }
  write(folder: string, files: Record<string, string> | string, text?: string): void {
    writeFiles(folder, typeof files === 'string' ? { [files]: text as string } : files);
  }
  read(folder: string, name: string): string | null {
    return readFile(folder, name);
  }

  // ---- chats ----
  async openChat(project: string, options: { resume?: string; web?: Web; expect?: number; ownCopy?: boolean | null } = {}): Promise<Chat> {
    const web = options.web ?? this.web;
    const body: Json = { provider: 'claude', cwd: project, background: true };
    if (options.resume) body.resume = options.resume;
    else if (options.ownCopy !== null) body.ownCopy = options.ownCopy ?? true; // a copy chat as made before 2026-11-16
    const [status, connection] = await web.post('connect', body);
    if ((options.expect ?? 200) !== 200) {
      assertEquals(status, options.expect, JSON.stringify(connection));
      return connection as never;
    }
    assertEquals(status, 200, JSON.stringify(connection));
    const chat = new Chat(this, connection.id as string, web);
    await waitFor(async () => {
      const state = await chat.state();
      if (state.error) throw new Error(String(state.error));
      return state.ready;
    }, 'chat ready');
    return chat;
  }

  /** Live sync of this project is running: a throw-away file the user saves reaches the chat's copy. Returns once it has. */
  async syncReady(chat: Chat, project: string): Promise<string> {
    const name = `canary-${crypto.randomUUID().replaceAll('-', '').slice(0, 6)}.txt`;
    this.write(project, name, 'canary\n');
    await waitFor(async () => this.read(await chat.cwd(), name) === 'canary\n', 'live sync to start');
    return name;
  }

  // ---- the registry ----
  records(): Record<string, Json> {
    return worktreeRecords(this.state);
  }
  /** The registry record of the chat's copy, found by its folder (a path); null when none. */
  record(path: string): (Json & { key: string }) | null {
    for (const [key, record] of Object.entries(this.records())) {
      if (normcase(realPath(String(record.path ?? ''))) === normcase(realPath(path))) return { ...record, key };
    }
    return null;
  }
  async recordOf(chat: Chat): Promise<Json & { key: string }> {
    return this.record(await chat.cwd()) as never;
  }
  branches(project: string): string[] {
    return git(project, 'branch', '--list', 'studio/*', '--format=%(refname:short)').split(/\s+/).filter(Boolean);
  }
}

/** Run `main.ts <agent flags> <args>` as the CLI (--stop-host and the like). */
export async function runCli(fx: E2EFixture, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return await fx.runCli(...args);
}

export { APP_ROOT, CODE_ROOT, HostClient };

/** The files under a folder (outside .git) as {path: bytes}, for "byte for byte unchanged" checks. */
export function snapshotFiles(folder: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of Deno.readDirSync(dir)) {
      if (entry.name === '.git') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory) walk(path);
      else if (entry.isFile) out[path] = Array.from(Deno.readFileSync(path)).join(',');
    }
  };
  walk(folder);
  return out;
}

// ---- a fake agent host from another code folder (the takeover tests): work/deno/_fake_host.ts as a process -------------------------
/** Speaks just enough of the host RPC (info, stop). N working chats (read from <state>/fake-active) make stop refuse, as the real host does. */
export class FakeHost {
  pid = 0;
  constructor(readonly fx: Fixture) {}

  static async start(fx: Fixture, active = 0, options: { codeRoot?: string; appId?: string; version?: string } = {}): Promise<FakeHost> {
    const fake = new FakeHost(fx);
    fake.setActive(active);
    const [child] = fx.spawn(
      [DENO, 'run', '-A', '--quiet', FAKE_HOST, fx.state, options.codeRoot ?? 'C:/other/checkout', options.appId ?? 'studio-dev', options.version ?? '0.0.9', 'none', String(PROTOCOL_VERSION)],
      'old-host',
    );
    fake.pid = child.pid;
    await until(async () => (await readInfo(fx.state))?.pid === child.pid, 'the fake host file', 30);
    return fake;
  }
  setActive(n: number): void {
    Deno.writeTextFileSync(join(this.fx.state, 'fake-active'), String(n));
  }
  calls(): string[] {
    try {
      return Deno.readTextFileSync(join(this.fx.state, 'fake-calls.log')).split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }
  /** It was asked to stop and did (its process is gone). */
  stopped(): boolean {
    return this.calls().includes('stop') && !pidAlive(this.pid);
  }
}
