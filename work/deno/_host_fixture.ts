/**
 * Fixtures for the agent host tests (test_agent_host.py's Fixture and Web): a temp state folder and workspace, Deno web servers and
 * Deno agent hosts started as real processes, the fake ACP agent (combined-fixture) as "Claude Code". Every process a fixture starts
 * is stopped in cleanup: hosts are asked to stop, then killed by the exact PID their own host file reported, as a last resort.
 */
import { python, WORK } from './_parity.ts';
import { HostClient, pidAlive, readInfo, stopHost } from '../../outputs/agent-studio/server/host/host_client.ts';
import { APP_ROOT } from '../../outputs/agent-studio/server/core/app.ts';
import { projectKey } from '../../outputs/agent-studio/server/desktop/project_delete.ts';

const WIN = Deno.build.os === 'windows';
export const SEP = WIN ? '\\' : '/';

export function nativePath(url: URL): string {
  const path = decodeURIComponent(url.pathname);
  return WIN ? path.replace(/^\/([A-Za-z]:)/, '$1').replaceAll('/', '\\') : path;
}

export const DENO = Deno.execPath();
export const MAIN = `${APP_ROOT}${SEP}server${SEP}main.ts`;
export const FAKE_LAUNCHER = nativePath(new URL('combined-fixture/agent.py', WORK));
export const FAKE_HOST = nativePath(new URL('deno/_fake_host.ts', WORK));
export const PY: string = (() => {
  const out = new Deno.Command(python(), { args: ['-c', 'import sys; print(sys.executable)'], stdout: 'piped' }).outputSync();
  return new TextDecoder().decode(out.stdout).trim();
})();

Deno.env.set('AGENT_STUDIO_TEST', '1');

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** AIB_TEST_PORT_BASE (e.g. 21000): take ports from [base, base + 2000) in turn, so suites run side by side never pick the same
 *  free port (the OS hands out "free" ports another suite is about to bind). Without it, any free port. */
let nextPort = Number(Deno.env.get('AIB_TEST_PORT_BASE') || 0);
const portEnd = nextPort + 2000;
export function freePort(): number {
  while (nextPort && nextPort < portEnd) {
    const want = nextPort++;
    if ([8767, 8768, 8777, 8778].includes(want)) continue; // never the live AIB's ports
    try {
      const l = Deno.listen({ hostname: '127.0.0.1', port: want });
      l.close();
      return want;
    } catch { /* taken: the next one */ }
  }
  const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

export type Json = Record<string, unknown>;

export async function httpJson(
  method: string,
  port: number,
  path: string,
  token: string | null = null,
  body: unknown = undefined,
  timeoutMs = 30000,
): Promise<[number, Json]> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['X-Studio-Token'] = token;
  if (method !== 'GET') headers['Origin'] = `http://127.0.0.1:${port}`; // a page POST must name its Origin
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  return [response.status, text ? JSON.parse(text) : {}];
}

export async function until<T>(condition: () => T | Promise<T>, what = 'condition', seconds = 20): Promise<NonNullable<T>> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    try {
      const value = await condition();
      if (value) return value as NonNullable<T>;
    } catch { /* not yet */ }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

export class Web {
  token = '';
  instance = '';
  webInstance = '';
  boot: Json = {};
  constructor(readonly process: Deno.ChildProcess, readonly port: number, readonly logPath: string) {}

  async waitReady(fixture: Fixture, seconds = 60): Promise<void> {
    const deadline = Date.now() + seconds * 1000;
    let exited = false;
    this.process.status.then(() => (exited = true));
    while (Date.now() < deadline) {
      if (exited) throw new Error(`web server exited: ${fixture.read(this.logPath)}`);
      try {
        const [status, boot] = await httpJson('GET', this.port, '/api/live/bootstrap', null, undefined, 5000);
        if (status === 200) {
          this.boot = boot;
          this.token = boot.token as string;
          this.instance = boot.instanceId as string;
          this.webInstance = boot.webInstanceId as string;
          await fixture.hostInfo();
          return;
        }
      } catch { /* not listening yet */ }
      await sleep(200);
    }
    throw new Error('web server did not answer: ' + fixture.read(this.logPath));
  }

  get(path: string): Promise<[number, Json]> {
    return httpJson('GET', this.port, path, path === '/api/live/bootstrap' ? null : this.token);
  }

  post(name: string, body: unknown): Promise<[number, Json]> {
    return httpJson('POST', this.port, '/api/live/' + name, this.token, body);
  }

  async state(id: string, after = 0): Promise<Json> {
    return (await this.get(`/api/live/state?id=${id}${after ? `&after=${after}` : ''}`))[1];
  }

  async listing(): Promise<Json> {
    return (await this.get('/api/live/list'))[1];
  }

  async kill(): Promise<void> {
    try {
      this.process.kill('SIGKILL');
    } catch { /* gone */ }
    await this.process.status;
  }
}

export class Fixture {
  readonly root = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-host-test-' }));
  readonly state = this.root + SEP + 'state';
  readonly owners = this.root + SEP + 'owners';
  readonly workspace = this.root + SEP + 'workspace';
  readonly processes: Deno.ChildProcess[] = [];
  readonly hostPids = new Set<number>();
  #logs = 0;

  constructor() {
    for (const name of ['state', 'owners', 'workspace', 'omp', 'claude']) Deno.mkdirSync(this.root + SEP + name);
    // The workspace is a project the user added: AIB lists a data folder's saved agent chats only for added projects
    // (desktop/added_projects.ts), and the scroll / layout labs write saved chats there.
    const added = { [projectKey(this.workspace)]: { path: this.workspace, at: 1 } };
    Deno.writeTextFileSync(
      this.state + SEP + 'studio-added-projects.json',
      JSON.stringify({ version: 1, savedAt: 1, start: 'fresh', added }),
    );
  }

  /** AIB_KEEPER=0: this fixture tests the split agent host (the fallback when the keeper cannot run); keeper tests drop it. */
  get env(): Record<string, string> {
    return { AGENT_STUDIO_TEST: '1', AGENT_STUDIO_STATE_DIR: this.state, AIB_KEEPER: '0' };
  }

  agentFlags(): string[] {
    return [
      '--state-dir',
      this.state,
      '--omp-sessions',
      this.root + SEP + 'omp',
      '--claude-projects',
      this.root + SEP + 'claude',
      '--owners-dir',
      this.owners,
      '--node-command',
      PY,
      '--claude-launcher',
      FAKE_LAUNCHER,
    ];
  }

  read(path: string): string {
    try {
      return Deno.readTextFileSync(path);
    } catch {
      return '';
    }
  }

  /** Start a process with stdout and stderr appended to a log file in the fixture folder. */
  spawn(command: string[], name: string, env: Record<string, string> = {}): [Deno.ChildProcess, string] {
    const log = `${this.root}${SEP}${name}-${this.#logs++}.log`;
    const file = Deno.openSync(log, { create: true, append: true });
    const child = new Deno.Command(command[0], {
      args: command.slice(1),
      cwd: APP_ROOT,
      env: { ...this.env, ...env },
      stdin: 'null',
      stdout: 'piped',
      stderr: 'piped',
    }).spawn();
    const pump = async (stream: ReadableStream<Uint8Array>) => {
      for await (const chunk of stream) file.writeSync(chunk);
    };
    Promise.all([pump(child.stdout), pump(child.stderr)]).finally(() => file.close()).catch(() => {});
    this.processes.push(child);
    return [child, log];
  }

  async startWeb(extra: string[] = [], options: { port?: number; wait?: boolean; env?: Record<string, string> } = {}): Promise<Web> {
    const port = options.port ?? freePort();
    const [child, log] = this.spawn(
      [DENO, 'run', '-A', '--quiet', MAIN, 'serve', '--port', String(port), ...this.agentFlags(), '--host-idle-minutes', '0', ...extra],
      `web-${port}`,
      options.env,
    );
    const web = new Web(child, port, log);
    if (options.wait ?? true) await web.waitReady(this);
    return web;
  }

  async startHost(extra: string[] = []): Promise<Deno.ChildProcess> {
    const [child] = this.spawn([DENO, 'run', '-A', '--quiet', MAIN, 'host', ...this.agentFlags(), ...extra], 'host');
    this.hostPids.add(child.pid);
    await until(async () => (await readInfo(this.state)) !== null, 'host file', 30);
    return child;
  }

  async hostInfo() {
    const info = await readInfo(this.state);
    if (info && info.pid && info.pid !== Deno.pid) this.hostPids.add(info.pid);
    return info;
  }

  async host(): Promise<HostClient | null> {
    const info = await this.hostInfo();
    return info ? new HostClient(info) : null;
  }

  async runCli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const out = await new Deno.Command(DENO, {
      args: ['run', '-A', '--quiet', MAIN, ...this.agentFlags(), ...args],
      cwd: APP_ROOT,
      env: this.env,
      stdout: 'piped',
      stderr: 'piped',
    }).output();
    return { code: out.code, stdout: new TextDecoder().decode(out.stdout), stderr: new TextDecoder().decode(out.stderr) };
  }

  async cleanup(): Promise<void> {
    try {
      const info = await this.hostInfo();
      if (info && info.pid !== Deno.pid) await stopHost(this.state, true, 10);
    } catch { /* best effort */ }
    for (const child of this.processes) {
      try {
        child.kill('SIGKILL');
      } catch { /* exited */ }
      await Promise.race([child.status, sleep(10000)]);
    }
    for (const pid of this.hostPids) { // last resort, only PIDs this fixture's hosts reported
      if (pidAlive(pid)) {
        try {
          Deno.kill(pid, 'SIGKILL');
        } catch { /* gone */ }
      }
    }
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && [...this.hostPids].some((pid) => pidAlive(pid))) await sleep(100);
    for (let i = 0; i < 20; i++) {
      try {
        Deno.removeSync(this.root, { recursive: true });
        return;
      } catch {
        await sleep(250);
      }
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.cleanup();
  }
}

/** Open a conversation with the fake Claude agent in the workspace; returns its connection id once ready. */
export async function openConversation(web: Web, fixture: Fixture): Promise<string> {
  const [status, connection] = await web.post('connect', { provider: 'claude', cwd: fixture.workspace, background: true });
  if (status !== 200) throw new Error(`connect: ${status} ${JSON.stringify(connection)}`);
  const id = connection.id as string;
  await until(async () => (await web.state(id)).ready, 'connection ready');
  return id;
}

export const TEST_OPTIONS = { sanitizeResources: false, sanitizeOps: false };
