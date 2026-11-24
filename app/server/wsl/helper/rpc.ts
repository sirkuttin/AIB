/**
 * JSON-RPC 2.0, one message per line, for the WSL helper (design 3). The helper runs as a pipe channel of the distro's keeper, so
 * its stdin and stdout are AIB's requests and its answers, journaled by the keeper like any agent's traffic. Requests are handled
 * concurrently; each answer is one whole line. Errors carry the module's own code (FilesError, ChangesError, FolderError .code) in
 * `data.code`, so AIB can answer the page exactly as it does for a Windows project.
 */

export const MAX_LINE = 4 * 1024 * 1024;
export const PARSE_ERROR = -32700, INVALID_REQUEST = -32600, NO_METHOD = -32601, BAD_PARAMS = -32602, FAILED = -32000;

export class RpcError extends Error {
  constructor(message: string, readonly rpcCode = FAILED, readonly data?: Record<string, unknown>) {
    super(message);
    this.name = 'RpcError';
  }
}

export type Handler = (params: Record<string, unknown>) => unknown | Promise<unknown>;
export type Handlers = Record<string, Handler>;

/** The `error` member for a thrown value. */
export function errorOf(error: unknown): { code: number; message: string; data?: Record<string, unknown> } {
  if (error instanceof RpcError) return { code: error.rpcCode, message: error.message, ...(error.data ? { data: error.data } : {}) };
  const e = error as { message?: unknown; code?: unknown; status?: unknown };
  const message = typeof e?.message === 'string' ? e.message : String(error);
  const data: Record<string, unknown> = {};
  if (typeof e?.code === 'string') data.code = e.code;
  if (typeof e?.status === 'number') data.status = e.status;
  return { code: FAILED, message, ...(Object.keys(data).length ? { data } : {}) };
}

/** Serialises whole lines onto one writer. */
export function lineWriter(write: (bytes: Uint8Array) => Promise<unknown>): (message: unknown) => Promise<void> {
  const enc = new TextEncoder();
  let tail: Promise<unknown> = Promise.resolve();
  return (message) => {
    const bytes = enc.encode(JSON.stringify(message) + '\n');
    const next = tail.then(() => write(bytes));
    tail = next.catch(() => {});
    return next.then(() => {});
  };
}

/** Answers one request line (null for a notification or a reply that needs no answer). */
export async function handleLine(line: string, handlers: Handlers): Promise<Record<string, unknown> | null> {
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    return { jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'Not JSON' } };
  }
  const m = msg as { id?: unknown; method?: unknown; params?: unknown };
  if (typeof msg !== 'object' || msg === null || Array.isArray(msg) || typeof m.method !== 'string') {
    return { jsonrpc: '2.0', id: m?.id ?? null, error: { code: INVALID_REQUEST, message: 'Not a request' } };
  }
  const id = m.id;
  const notify = id === undefined;
  const handler = Object.prototype.hasOwnProperty.call(handlers, m.method) ? handlers[m.method] : null;
  if (!handler) return notify ? null : { jsonrpc: '2.0', id, error: { code: NO_METHOD, message: `No method ${m.method}` } };
  const params = m.params === undefined ? {} : m.params;
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    return notify ? null : { jsonrpc: '2.0', id, error: { code: BAD_PARAMS, message: 'params must be an object' } };
  }
  try {
    const result = await handler(params as Record<string, unknown>);
    return notify ? null : { jsonrpc: '2.0', id, result: result ?? null };
  } catch (error) {
    return notify ? null : { jsonrpc: '2.0', id, error: errorOf(error) };
  }
}

/** Reads request lines until the input ends; resolves once every answer is written. */
export async function serveLines(
  input: ReadableStream<Uint8Array>,
  send: (message: unknown) => Promise<void>,
  handlers: Handlers,
): Promise<void> {
  const dec = new TextDecoder();
  const pending = new Set<Promise<void>>();
  let buf = '';
  let skipping = false; // inside a line longer than MAX_LINE: dropped up to its newline
  const take = (line: string) => {
    if (!line.trim()) return;
    const p = handleLine(line, handlers).then((reply) => (reply ? send(reply) : undefined)).catch(() => {});
    pending.add(p);
    p.finally(() => pending.delete(p));
  };
  for await (const chunk of input) {
    buf += dec.decode(chunk, { stream: true });
    for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (skipping) skipping = false;
      else take(line);
    }
    if (buf.length > MAX_LINE) {
      if (!skipping) await send({ jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'Line too long' } });
      skipping = true;
      buf = '';
    }
  }
  if (!skipping) take(buf);
  await Promise.all(pending);
}

/** A string param, or a BAD_PARAMS error. */
export function str(params: Record<string, unknown>, key: string, optional = false): string {
  const v = params[key];
  if (v === undefined && optional) return '';
  if (typeof v !== 'string' || v.includes('\0')) throw new RpcError(`${key} must be a string`, BAD_PARAMS);
  return v;
}

/** A non-negative integer param (default when absent), or a BAD_PARAMS error. */
export function int(params: Record<string, unknown>, key: string, fallback: number): number {
  const v = params[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new RpcError(`${key} must be a whole number`, BAD_PARAMS);
  return v;
}
