/**
 * The server the contract tests (contract_*_test.ts) talk to: the real Deno AIB (`main.ts serve --in-process`, agents run by the web
 * server, AIB_KEEPER=0) started as a child with a private temp state folder, empty transcript folders, port 0, no auto-reconnect and
 * no owner announcements. They speak only HTTP, like the page does. AGENT_STUDIO_TEST=1: the real data folder is never reached.
 * Every wait has a time limit.
 */
import { request as httpRequest } from 'node:http';
import { PAGE_KEY } from './_page_key.ts';
import { waitListenedPort } from './_ports.ts';

export const WORK = new URL('../', import.meta.url);
export const APP = new URL('../outputs/agent-studio/', WORK);
const native = (url: URL) => decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:)/, '$1');
export const APP_DIR = native(APP).replace(/\/$/, '');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The Python that runs fixture writers and the fake agent (never the retired reference server). */
export function python(): string {
  return Deno.env.get('AIB_PYTHON') ?? (Deno.build.os === 'windows' ? 'python' : 'python3');
}

export interface Reply {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
  text: string;
  // deno-lint-ignore no-explicit-any
  json: any;
}

type Body = Uint8Array | string | Record<string, unknown> | unknown[];

/** One HTTP request with the headers exactly as given (Host included; fetch cannot set it). */
export function rawRequest(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: Body): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const data = body === undefined
      ? undefined
      : body instanceof Uint8Array
      ? body
      : new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body));
    const all: Record<string, string> = { ...headers };
    if (data !== undefined) {
      if (!Object.keys(all).some((k) => k.toLowerCase() === 'content-type')) all['Content-Type'] = 'application/json';
      all['Content-Length'] = String(data.length);
    }
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers: all, agent: false, timeout: 30000 }, (res) => {
      const chunks: Uint8Array[] = [];
      res.on('data', (c: Uint8Array) => chunks.push(c));
      res.on('end', () => {
        const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
        let at = 0;
        for (const c of chunks) {
          bytes.set(c, at);
          at += c.length;
        }
        const heads: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) heads[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
        const text = new TextDecoder().decode(bytes);
        resolve({
          status: res.statusCode ?? 0,
          headers: heads,
          body: bytes,
          text,
          get json() {
            return JSON.parse(text || 'null');
          },
        });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`no answer to ${method} ${path}`)));
    req.on('error', reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

export interface StartOptions {
  extraArgs?: string[];
  env?: Record<string, string>;
  /** Existing transcript folders to show (default: empty temp folders). */
  claudeDir?: string;
  ompDir?: string;
}

export class ContractServer {
  port = 0;
  token = '';
  temp = '';
  stateDir = '';
  claudeDir = '';
  ompDir = '';
  workspace = '';
  output = '';
  exited = false;
  #child?: Deno.ChildProcess;
  #done?: Promise<Deno.CommandStatus>;

  static async start(options: StartOptions = {}): Promise<ContractServer> {
    const s = new ContractServer();
    await s.#boot(options);
    return s;
  }

  async #boot(options: StartOptions) {
    this.temp = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-contract-' }));
    this.stateDir = `${this.temp}/state`;
    this.workspace = `${this.temp}/workspace`;
    for (const dir of [this.stateDir, this.workspace, `${this.temp}/omp`, `${this.temp}/claude`]) Deno.mkdirSync(dir, { recursive: true });
    this.ompDir = options.ompDir ?? `${this.temp}/omp`;
    this.claudeDir = options.claudeDir ?? `${this.temp}/claude`;
    if (options.claudeDir || options.ompDir) writeAddedProjects(this.stateDir, [this.ompDir, this.claudeDir]);
    const args = [
      'run',
      '-A',
      '--quiet',
      `${APP_DIR}/server/main.ts`,
      'serve',
      '--in-process',
      '--port',
      '0',
      '--state-dir',
      this.stateDir,
      '--omp-sessions',
      this.ompDir,
      '--claude-projects',
      this.claudeDir,
      '--no-auto-reconnect',
      '--no-owner-announcements',
      ...(options.extraArgs ?? []),
    ];
    this.#child = new Deno.Command(Deno.execPath(), {
      args,
      cwd: APP_DIR,
      stdin: 'null',
      stdout: 'piped',
      stderr: 'piped',
      env: {
        AGENT_STUDIO_TEST: '1',
        AGENT_STUDIO_STATE_DIR: this.stateDir,
        AIB_KEEPER: '0',
        AIB_PAGE_KEY: PAGE_KEY,
        PYTHONDONTWRITEBYTECODE: '1',
        ...(options.env ?? {}),
      },
    }).spawn();
    const pump = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) this.output += decoder.decode(chunk, { stream: true });
    };
    void pump(this.#child.stdout).catch(() => {});
    void pump(this.#child.stderr).catch(() => {});
    this.#done = this.#child.status.then((s) => {
      this.exited = true;
      return s;
    });
    try {
      this.port = await waitListenedPort(() => this.output, 'contract server', 90, () => this.exited);
      if ([8767, 8768, 8777, 8778].includes(this.port)) throw new Error(`server picked forbidden port ${this.port}`);
      this.token = (await this.bootstrap()).json.token;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  get origin(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** What the page sends from fetch(): Host, Origin, same-origin fetch metadata and (unless token is false) the token. `extra` replaces or
   *  adds headers; a value of null drops one. */
  pageHeaders(token: boolean | string = true, extra: Record<string, string | null> = {}): Record<string, string> {
    const headers: Record<string, string> = {
      'Host': `127.0.0.1:${this.port}`,
      'Origin': this.origin,
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'cors',
    };
    if (token) headers['X-Studio-Token'] = token === true ? this.token : token;
    for (const [k, v] of Object.entries(extra)) {
      for (const have of Object.keys(headers)) if (have.toLowerCase() === k.toLowerCase()) delete headers[have];
      if (v !== null) headers[k] = v;
    }
    return headers;
  }

  request(method: string, path: string, headers?: Record<string, string>, body?: Body): Promise<Reply> {
    return rawRequest(this.port, method, path, headers, body);
  }

  bootstrap(pageKey = true): Promise<Reply> {
    const headers: Record<string, string> = { 'Host': `127.0.0.1:${this.port}`, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors' };
    if (pageKey) headers['X-AIB-Page-Key'] = PAGE_KEY;
    return this.request('GET', '/api/live/bootstrap', headers);
  }

  get(path: string, extra: Record<string, string | null> = {}, token: boolean | string = true): Promise<Reply> {
    return this.request('GET', path, this.pageHeaders(token, extra));
  }

  post(path: string, body: Body = {}, extra: Record<string, string | null> = {}, token: boolean | string = true): Promise<Reply> {
    return this.request('POST', path, this.pageHeaders(token, extra), body);
  }

  /** A request as an agent's tool sends it: the artifact key, no page headers. */
  agent(method: string, path: string, key: string, body?: Body, extra: Record<string, string> = {}): Promise<Reply> {
    return this.request(method, path, { 'Host': `127.0.0.1:${this.port}`, 'X-Studio-Artifact-Key': key, ...extra }, body);
  }

  /** Poll until `check()` gives a truthy value; throws after `seconds`. */
  async until<T>(what: string, check: () => Promise<T> | T, seconds = 30): Promise<NonNullable<T>> {
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline) {
      const value = await check();
      if (value) return value as NonNullable<T>;
      await sleep(100);
    }
    throw new Error(`timed out waiting for ${what}\n${this.output.slice(-1500)}`);
  }

  /** Quit the normal way (POST /api/live/shutdown), make sure the process is gone, remove the temp folder. */
  async stop(): Promise<void> {
    if (this.#child && !this.exited) {
      if (this.port && this.token) {
        try {
          await this.post('/api/live/shutdown', {});
        } catch { /* already gone */ }
      }
      const gone = await Promise.race([this.#done, sleep(15000).then(() => null)]);
      if (gone === null) {
        try {
          this.#child.kill();
        } catch { /* gone */ }
        await this.#done;
      }
    }
    try {
      Deno.removeSync(this.temp, { recursive: true });
    } catch { /* the OS cleans temp */ }
  }

  async [Symbol.asyncDispose]() {
    await this.stop();
  }
}

/** server/desktop/project_delete.ts projectKey (sidebar-ui.js pathKey). */
export function projectKey(path: string): string {
  const raw = path.trim();
  let p = raw.replace(/^\\\\\?\\/, '').replaceAll('\\', '/');
  const unc = p.startsWith('//');
  p = p.replace(/\/{2,}/g, '/');
  const segments = p.split('/').filter(Boolean);
  if (!segments.length) return '';
  const windows = /^[a-zA-Z]:/.test(p) || unc || raw.includes('\\');
  const joined = segments.join('/');
  return windows ? 'w:' + joined.toLowerCase() : 'p:' + joined;
}

/** studio-added-projects.json naming every folder (cwd / projectRoot) the transcripts under `roots` mention: the server lists saved chats
 *  only for projects the user added. */
export function writeAddedProjects(stateDir: string, roots: string[]) {
  const folders = new Set<string>();
  const walk = (dir: string) => {
    let entries: Deno.DirEntry[] = [];
    try {
      entries = [...Deno.readDirSync(dir)];
    } catch {
      return;
    }
    for (const e of entries) {
      const path = `${dir}/${e.name}`;
      if (e.isDirectory) walk(path);
      else if (e.name.endsWith('.jsonl')) {
        for (const line of Deno.readTextFileSync(path).split(/\r?\n/)) {
          try {
            const row = JSON.parse(line);
            for (const name of ['cwd', 'projectRoot']) if (row && typeof row[name] === 'string' && row[name]) folders.add(row[name]);
          } catch { /* not a row */ }
        }
      }
    }
  };
  roots.forEach(walk);
  const added: Record<string, unknown> = {};
  for (const f of [...folders].sort()) if (projectKey(f)) added[projectKey(f)] = { path: f, at: 1 };
  Deno.writeTextFileSync(`${stateDir}/studio-added-projects.json`, JSON.stringify({ version: 1, savedAt: 1, added }));
}

/** Run work/<name>/make_fixture.py (a fixture writer, not the reference) in a temp copy; returns the copy's folder. */
export async function generateFixture(name: string): Promise<string> {
  const folder = Deno.makeTempDirSync({ prefix: `aib-${name}-` });
  Deno.copyFileSync(new URL(`${name}/make_fixture.py`, WORK), `${folder}/make_fixture.py`);
  const out = await new Deno.Command(python(), { args: ['-I', `${folder}/make_fixture.py`], cwd: folder, stdout: 'piped', stderr: 'piped' }).output();
  if (!out.success) throw new Error(`make_fixture ${name}: ${new TextDecoder().decode(out.stderr)}`);
  return folder;
}

/** A JSON value's type skeleton: {a: 'string', b: ['number']}. */
export function shape(value: unknown): unknown {
  if (Array.isArray(value)) return value.length ? [shape(value[0])] : [];
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v)]));
  return value === null ? 'null' : typeof value;
}
