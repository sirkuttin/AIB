/**
 * The helper's end of the MCP tunnel (docs/wsl/design.md sections 4, 6, 11; contract.ts 'mcp.*'). An agent in the distro runs
 * `AIB-keeper mcp-forward --helper-socket <data>/helper/mcp.sock` as its `studio_artifact` MCP server. A compiled Deno program may only
 * listen on a unix socket whose path is fixed at build time, so the socket is served by `AIB-keeper mcp-relay` (keeper/mcprelay.go),
 * this helper's child, which passes each request line on over its stdio. Here each one goes to AIB as the notification
 * `mcp.request {rid, headers, body}` on the helper channel; AIB takes it with `mcp.accept`, runs it through its HTTP tool endpoint's
 * checks (the conversation's key included) and answers with `mcp.reply`.
 *
 * Nothing runs twice and nothing waits forever:
 *   - AIB must accept within ACK_MS (it is not running, or its transport is down): the forwarder then gets "AIB is not running" (503,
 *     final), and a late `mcp.accept` (a request AIB read from the journal after reconnecting) is answered ok: false, so AIB never runs
 *     it. After `mcp.closed {closed: true}` (AIB was quit on purpose) the answer is "AIB is closed" at once.
 *   - An accepted request that gets no `mcp.reply` within RUN_MS is answered with an error.
 *   - A forwarder that leaves before AIB accepted is dropped (accept says ok: false); after, AIB's reply is thrown away.
 * The helper holds no other state; the key passes through and is never kept.
 */
import { BAD_PARAMS, type Handlers, RpcError, str } from './rpc.ts';

export const ACK_MS = 15_000;
export const RUN_MS = 10 * 60_000;
export const SOCKET_NAME = 'mcp.sock';
/** Largest headers object a forwarder may send (two short headers in practice). */
export const MAX_HEADERS = 4096;
/** Largest message passed on (the relay already refuses lines over 16 MB). */
export const MAX_BODY = 8 * 1024 * 1024;
const CLOSED = 'AIB is closed, so this tool cannot answer now. Your chat keeps running; try again later, once AIB is open again.';
const AWAY = 'AIB is not running (or not connected to this distro), so this tool cannot answer now. Try again later, once AIB runs.';

/** The relay child as the tunnel sees it (tests pass a fake). */
export interface RelayProcess {
  /** Its stdout, one JSON object per line. */
  readonly lines: AsyncIterable<string>;
  write(line: string): Promise<void>;
  readonly done: Promise<unknown>;
  kill(): void;
}

export interface McpTunnelOptions {
  /** Send AIB a notification on the helper channel. */
  notify(method: string, params: Record<string, unknown>): void;
  /** Start the relay on `socket`. */
  spawnRelay(socket: string): RelayProcess;
  socket: string;
  ackMs?: number;
  runMs?: number;
  /** How long start() waits for the relay's ready line. */
  readyMs?: number;
  log?: (text: string) => void;
}

interface Pending {
  conn: number;
  accepted: boolean;
  gone: boolean;
  timer: ReturnType<typeof setTimeout>;
}

export class McpTunnel {
  #relay: RelayProcess | null = null;
  #socket: string | null = null;
  #pending = new Map<string, Pending>();
  #byConn = new Map<number, string>();
  #closed = false;
  #stopped = false;
  #next = 1;
  #restarts = 0;
  readonly #run = crypto.randomUUID().slice(0, 8);

  constructor(readonly options: McpTunnelOptions) {}

  /** The socket forwarders dial, once the relay listens; null before or without one. */
  get socket(): string | null {
    return this.#socket;
  }

  /** Start the relay; resolves with the socket once it listens, or null (no keeper program, or it did not start in time). */
  async start(): Promise<string | null> {
    const ready = await this.#spawn();
    return ready ? this.#socket : null;
  }

  #spawn(): Promise<boolean> {
    let relay: RelayProcess;
    try {
      relay = this.options.spawnRelay(this.options.socket);
    } catch (error) {
      this.options.log?.(`no MCP tunnel: ${error instanceof Error ? error.message : error}`);
      return Promise.resolve(false);
    }
    this.#relay = relay;
    let settle: (ok: boolean) => void = () => {};
    const ready = new Promise<boolean>((resolve) => (settle = resolve));
    const timer = setTimeout(() => settle(false), this.options.readyMs ?? 5000);
    (async () => {
      for await (const line of relay.lines) {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.ready === true && typeof msg.socket === 'string') {
          this.#socket = msg.socket;
          this.#restarts = 0;
          settle(true);
        } else this.#fromRelay(msg);
      }
    })().catch(() => {}).finally(() => settle(false));
    void relay.done.then(() => {
      clearTimeout(timer);
      if (this.#relay !== relay) return;
      this.#relay = null;
      for (const [rid, p] of this.#pending) { // their connections ended with the relay
        clearTimeout(p.timer);
        this.#pending.delete(rid);
      }
      this.#byConn.clear();
      if (this.#stopped || !this.#socket) return; // never listened: no tunnel this run
      if (this.#restarts++ >= 5) {
        this.options.log?.('the MCP tunnel relay keeps ending; not started again');
        return;
      }
      setTimeout(() => !this.#stopped && void this.#spawn(), 500 * this.#restarts);
    });
    return ready.finally(() => clearTimeout(timer));
  }

  #answer(conn: number, res: Record<string, unknown>): void {
    void this.#relay?.write(JSON.stringify({ c: conn, res }) + '\n').catch(() => {});
  }

  #fromRelay(msg: Record<string, unknown>): void {
    const conn = msg.c;
    if (typeof conn !== 'number') return;
    if (msg.gone === true) {
      const rid = this.#byConn.get(conn);
      this.#byConn.delete(conn);
      const p = rid ? this.#pending.get(rid) : undefined;
      if (!rid || !p) return;
      if (!p.accepted) { // AIB has not started it: it never will (accept says no)
        clearTimeout(p.timer);
        this.#pending.delete(rid);
      } else p.gone = true;
      return;
    }
    const req = msg.req as Record<string, unknown> | undefined;
    if (!req || typeof req !== 'object') return;
    const headers = req.headers;
    const body = req.body;
    if (
      !headers || typeof headers !== 'object' || Array.isArray(headers) || JSON.stringify(headers).length > MAX_HEADERS ||
      !Object.values(headers).every((v) => typeof v === 'string')
    ) return this.#answer(conn, { status: 400, error: 'The tunnel needs the headers as an object of strings' });
    if (typeof body !== 'string' || !body.trim()) return this.#answer(conn, { status: 400, error: 'Empty request' });
    if (body.length > MAX_BODY) return this.#answer(conn, { status: 413, error: `The message is larger than the WSL tunnel takes (${MAX_BODY >> 20} MB)` });
    if (this.#closed) return this.#answer(conn, { status: 503, error: CLOSED });
    const rid = `${this.#run}-${this.#next++}`;
    const timer = setTimeout(() => this.#expire(rid), this.options.ackMs ?? ACK_MS);
    this.#pending.set(rid, { conn, accepted: false, gone: false, timer });
    this.#byConn.set(conn, rid);
    this.options.notify('mcp.request', { rid, headers, body });
  }

  #expire(rid: string): void {
    const p = this.#pending.get(rid);
    if (!p) return;
    this.#pending.delete(rid);
    this.#byConn.delete(p.conn);
    if (p.gone) return;
    this.#answer(
      p.conn,
      p.accepted
        ? { status: 504, error: `AIB took longer than ${Math.round((this.options.runMs ?? RUN_MS) / 1000)} s to answer this tool call` }
        : { status: 503, error: this.#closed ? CLOSED : AWAY },
    );
  }

  /** Any call from AIB means an AIB is there again: no longer "closed". */
  touch(): void {
    this.#closed = false;
  }

  /** The helper methods (contract.ts 'mcp.*'). */
  methods(): Handlers {
    return {
      'mcp.accept': (params) => {
        const rid = str(params, 'rid');
        const p = this.#pending.get(rid);
        if (!p || p.gone || p.accepted) return { ok: false };
        p.accepted = true;
        clearTimeout(p.timer);
        p.timer = setTimeout(() => this.#expire(rid), this.options.runMs ?? RUN_MS);
        return { ok: true };
      },
      'mcp.reply': (params) => {
        const rid = str(params, 'rid');
        const status = params.status;
        if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) {
          throw new RpcError('status must be an HTTP status', BAD_PARAMS);
        }
        const body = str(params, 'body', true);
        const error = str(params, 'error', true);
        const p = this.#pending.get(rid);
        if (!p) return { ok: false };
        clearTimeout(p.timer);
        this.#pending.delete(rid);
        this.#byConn.delete(p.conn);
        if (!p.gone) this.#answer(p.conn, { status, ...(body ? { body } : {}), ...(error ? { error } : {}) });
        return { ok: true };
      },
      'mcp.closed': (params) => {
        this.#closed = params.closed === true;
        return { ok: true };
      },
    };
  }

  /** The helper exits: the relay with it (it also ends by itself when the helper's pipe closes). */
  stop(): void {
    this.#stopped = true;
    for (const p of this.#pending.values()) clearTimeout(p.timer);
    this.#pending.clear();
    this.#relay?.kill();
  }
}

/** The real relay: `<keeper> mcp-relay --socket <socket>`, its stderr passed to the helper's (the keeper journals it). */
export function spawnKeeperRelay(keeper: string): (socket: string) => RelayProcess {
  return (socket) => {
    const child = new Deno.Command(keeper, {
      args: ['mcp-relay', '--socket', socket],
      stdin: 'piped',
      stdout: 'piped',
      stderr: 'inherit',
    }).spawn();
    const writer = child.stdin.getWriter();
    const enc = new TextEncoder();
    let tail: Promise<unknown> = Promise.resolve();
    return {
      lines: readLines(child.stdout),
      write(line) {
        const next = tail.then(() => writer.write(enc.encode(line)));
        tail = next.catch(() => {});
        return next.then(() => {});
      },
      done: child.status,
      kill() {
        // its stdin's end stops it the clean way (it removes its socket); a signal only if it is still there after 2 s
        void tail.then(() => writer.close()).catch(() => {});
        let ended = false;
        void child.status.then(() => (ended = true));
        const timer = setTimeout(() => {
          if (ended) return;
          try {
            child.kill('SIGTERM');
          } catch { /* gone */ }
        }, 2000);
        Deno.unrefTimer(timer);
      },
    };
  };
}

/** Lines of a byte stream (a line longer than 64 MB is dropped). */
export async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of stream) {
    buf += dec.decode(chunk, { stream: true });
    for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
      yield buf.slice(0, nl);
      buf = buf.slice(nl + 1);
    }
    if (buf.length > 64 * 1024 * 1024) buf = '';
  }
  if (buf.trim()) yield buf;
}
