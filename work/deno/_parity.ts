/**
 * Differential testing against the Python reference server (work/python-reference): call a Python function through
 * work/parity/py_call.py and compare with the Deno server.
 * One Python process per test file; close() it in the last test (or use `using`).
 *
 *   const py = new PyParity();
 *   assertEquals(port(input), await py.call('rpc_errors', 'describe_auth_methods', [input]));
 */
import { assertEquals } from './_assert.ts';

export const WORK = new URL('../', import.meta.url);
export const APP = new URL('../outputs/agent-studio/', WORK);
/** The Python reference server (the old app, kept as the tests' reference). */
export const PY_REF = new URL('python-reference/', WORK);
/** PY_REF as a native folder path, no trailing separator. */
export const PY_REF_DIR = decodeURIComponent(PY_REF.pathname).replace(/^\/([A-Za-z]:)/, '$1').replace(/\/$/, '')
  .replaceAll('/', Deno.build.os === 'windows' ? '\\' : '/');

export function python(): string {
  return Deno.env.get('AIB_PYTHON') ?? (Deno.build.os === 'windows' ? 'python' : 'python3');
}

export type PyReply = { ok: unknown } | { error: string; message: string };

export class PyParity {
  #child: Deno.ChildProcess;
  #writer: WritableStreamDefaultWriter<Uint8Array>;
  #lines: AsyncIterator<string>;
  #queue: Promise<unknown> = Promise.resolve();

  constructor() {
    this.#child = new Deno.Command(python(), {
      args: ['-X', 'utf8', new URL('parity/py_call.py', WORK).pathname.replace(/^\/([A-Za-z]:)/, '$1')],
      stdin: 'piped',
      stdout: 'piped',
      stderr: 'inherit',
      env: { PYTHONDONTWRITEBYTECODE: '1' },
    }).spawn();
    this.#writer = this.#child.stdin.getWriter();
    this.#lines = this.#child.stdout.pipeThrough(new TextDecoderStream()).pipeThrough(new LineSplitter())[Symbol.asyncIterator]();
  }

  /** Raw reply: {ok} or {error, message}. Calls are serialized. */
  raw(module: string, func: string, args: unknown[] = [], kwargs: Record<string, unknown> = {}): Promise<PyReply> {
    const next = this.#queue.then(async () => {
      await this.#writer.write(new TextEncoder().encode(JSON.stringify({ module, func, args, kwargs }) + '\n'));
      const { value, done } = await this.#lines.next();
      if (done) throw new Error('py_call.py exited');
      return JSON.parse(value) as PyReply;
    });
    this.#queue = next.catch(() => {});
    return next;
  }

  /** The Python result; throws if Python raised. */
  async call(module: string, func: string, args: unknown[] = [], kwargs: Record<string, unknown> = {}): Promise<unknown> {
    const reply = await this.raw(module, func, args, kwargs);
    if ('error' in reply) throw new Error(`Python ${module}.${func} raised ${reply.error}: ${reply.message}`);
    return reply.ok;
  }

  /** Assert the port gives what Python gives for each input. `port` returns the same plain JSON shape. */
  async same(module: string, func: string, inputs: unknown[][], port: (...args: never[]) => unknown): Promise<void> {
    for (const args of inputs) {
      const expected = await this.call(module, func, args);
      assertEquals(
        JSON.parse(JSON.stringify((port as (...a: unknown[]) => unknown)(...args) ?? null)),
        expected,
        `${func}(${JSON.stringify(args)})`,
      );
    }
  }

  async close(): Promise<void> {
    try {
      await this.#writer.close();
    } catch { /* already closed */ }
    await this.#child.status;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

class LineSplitter extends TransformStream<string, string> {
  constructor() {
    let buffer = '';
    super({
      transform(chunk, controller) {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          controller.enqueue(buffer.slice(0, index).replace(/\r$/, ''));
          buffer = buffer.slice(index + 1);
        }
      },
      flush(controller) {
        if (buffer) controller.enqueue(buffer);
      },
    });
  }
}
