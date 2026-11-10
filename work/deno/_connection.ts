/** Shared helpers for the Connection tests: fake agents from work/ run with Python, temp folders, polling. */
import { python, WORK } from './_parity.ts';
import { Connection, type ConnectionOptions } from '../../outputs/agent-studio/server/acp/connection.ts';

Deno.env.set('AGENT_STUDIO_TEST', '1'); // the test guard: only fixtures under work/ may be started

function nativePath(url: URL): string {
  const path = decodeURIComponent(url.pathname);
  return Deno.build.os === 'windows' ? path.replace(/^\/([A-Za-z]:)/, '$1').replaceAll('/', '\\') : path;
}

export const FAKE = nativePath(new URL('fake_acp.py', WORK));
export const STREAM_AGENT = nativePath(new URL('parity/stream_agent.py', WORK));
export const PYTHON = python();

export function fake(...flags: string[]): string[] {
  return [PYTHON, FAKE, ...flags];
}

export async function until(condition: () => unknown, what = 'expected state', seconds = 8): Promise<void> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Fixture did not reach ' + what);
}

export function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A temp folder and every Connection opened in it, closed (then the folder removed) when the test ends. */
export class Lab {
  readonly dir = Deno.makeTempDirSync({ prefix: 'aib-conn-test-' });
  readonly connections: Connection[] = [];

  connection(command: string[], options: ConnectionOptions = {}, cwd = this.dir, provider = 'omp'): Connection {
    const c = new Connection(command, cwd, provider, options);
    this.connections.push(c);
    return c;
  }

  /** A connection to fake_acp.py with these flags, set up (session/new) unless setup is false. */
  async open(flags: string[] = [], { setup = true, provider = 'omp' } = {}): Promise<Connection> {
    const c = this.connection(fake(...flags), {}, this.dir, provider);
    if (setup) await c.setup(null);
    return c;
  }

  /** Setup running in the background, as InteractiveRequestTests.start does. */
  start(flags: string[] = [], provider = 'omp', resume: string | null = null): [Connection, { done?: boolean; error?: Error }] {
    const c = this.connection(fake(...flags), {}, this.dir, provider);
    const outcome: { done?: boolean; error?: Error } = {};
    c.setup(resume).catch((error) => (outcome.error = error)).finally(() => (outcome.done = true));
    return [c, outcome];
  }

  path(name: string): string {
    return this.dir + (Deno.build.os === 'windows' ? '\\' : '/') + name;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    for (const c of this.connections.reverse()) await c.close();
    for (const c of this.connections) if (c.turn) await Promise.race([c.turn, pause(3000)]);
    try {
      Deno.removeSync(this.dir, { recursive: true });
    } catch { /* a child still holds a file; the OS temp cleaner gets it */ }
  }
}

export type Json = Record<string, unknown>;

export function events(c: Connection, kind?: string): Json[] {
  return (c.public().events as Json[]).filter((e) => kind === undefined || e.kind === kind);
}

/** e.data.update.content.text of every update event that has one. */
export function updateTexts(c: Connection): string[] {
  return events(c, 'update').map((e) => (((e.data as Json).update as Json).content as Json | undefined)?.text as string).filter((t) =>
    typeof t === 'string'
  );
}

/** A Python ValueError from any ported module (msgqueue.ts and core/py.ts each have their own class). */
export async function rejectsValue(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'ValueError') throw new Error(`expected a ValueError, got ${error}`);
    return error;
  }
  throw new Error('expected a ValueError');
}
