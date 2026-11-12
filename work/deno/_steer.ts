/**
 * Helpers for the steer-on-send server tests (steer_*_test.ts): a Puppet is the agent end of a Connection (see _steer_puppet.ts),
 * driven line by line by the test, so each test sends exactly the shapes the real adapters sent in work/steer-recordings.
 */
import { Lab as BaseLab, until } from './_connection.ts';
import type { Connection, ConnectionOptions } from '../../outputs/agent-studio/server/acp/connection.ts';

export type Json = Record<string, unknown>;
export type Kind = 'claude' | 'codex' | 'omp' | 'plain';

function nativePath(url: URL): string {
  const path = decodeURIComponent(url.pathname);
  return Deno.build.os === 'windows' ? path.replace(/^\/([A-Za-z]:)/, '$1').replaceAll('/', '\\') : path;
}

export const PUPPET = nativePath(new URL('_steer_puppet.ts', import.meta.url));
export const SID = 's1';
const ENC = new TextEncoder();

export function puppetCommand(port: number): string[] {
  return [Deno.execPath(), 'run', '-A', '--quiet', PUPPET, String(port)];
}

/** The initialize result each agent sent in the recordings (only what AIB reads), with or without steering. */
export function initializeResult(kind: Kind, steering = true): Json {
  const caps: Json = { promptCapabilities: { image: true, embeddedContext: true }, loadSession: true };
  if (kind === 'claude') caps._meta = { claudeCode: { promptQueueing: true } };
  return {
    protocolVersion: 1,
    agentCapabilities: caps,
    authMethods: [],
    ...(steering ? { _meta: { steering: { supported: true } } } : {}),
  };
}

export class Puppet {
  readonly listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
  conn: Deno.TcpConn | null = null;
  /** Every JSON-RPC message AIB wrote to the agent, in order. */
  readonly received: Json[] = [];
  readonly #taken = new Set<Json>();
  readonly #spawned = new Map<string, number>();
  #writes: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(readonly kind: Kind, readonly steering = true) {
    void this.#serve();
  }

  get port(): number {
    return this.listener.addr.port;
  }

  async #serve(): Promise<void> {
    try {
      this.conn = await this.listener.accept();
    } catch {
      return;
    }
    const dec = new TextDecoder();
    let buffer = '';
    try {
      for await (const chunk of this.conn.readable) {
        buffer += dec.decode(chunk, { stream: true });
        let at: number;
        while ((at = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, at).trim();
          buffer = buffer.slice(at + 1);
          if (line) this.#line(line);
        }
      }
    } catch { /* closed */ }
  }

  #line(line: string): void {
    if (line.startsWith('#spawned ')) {
      const [, tag, pid] = line.split(/\s+/);
      this.#spawned.set(tag, Number(pid));
      return;
    }
    let message: Json;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    this.received.push(message);
    // The handshake answers itself: every test starts from a ready chat.
    if (message.method === 'initialize') {
      this.#taken.add(message);
      this.reply(message.id, initializeResult(this.kind, this.steering));
    } else if (message.method === 'session/new') {
      this.#taken.add(message);
      this.reply(message.id, { sessionId: SID });
    }
  }

  send(message: Json | string): Promise<void> {
    const line = typeof message === 'string' ? message : JSON.stringify(message);
    this.#writes = this.#writes.then(async () => {
      await until(() => this.conn, 'the puppet connected', 15);
      const bytes = ENC.encode(line + '\n');
      for (let off = 0; off < bytes.length;) off += await this.conn!.write(bytes.subarray(off));
    });
    return this.#writes;
  }

  reply(id: unknown, result: unknown): Promise<void> {
    return this.send({ jsonrpc: '2.0', id, result });
  }

  replyError(id: unknown, message: string, code = -32603): Promise<void> {
    return this.send({ jsonrpc: '2.0', id, error: { code, message } });
  }

  update(update: Json, sessionId = SID): Promise<void> {
    return this.send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } });
  }

  text(text: string, sessionId = SID): Promise<void> {
    return this.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }, sessionId);
  }

  /** Claude Code's result of a model cycle: a usage_update carrying `_claude/origin`. */
  result(origin = 'human'): Promise<void> {
    return this.update({ sessionUpdate: 'usage_update', used: 1000, size: 200000, _meta: { '_claude/origin': { kind: origin } } });
  }

  request(id: unknown, method: string, params: Json): Promise<void> {
    return this.send({ jsonrpc: '2.0', id, method, params });
  }

  permission(id: unknown, toolCallId = 'tc-perm', sessionId = SID): Promise<void> {
    return this.request(id, 'session/request_permission', {
      sessionId,
      toolCall: { toolCallId, title: 'echo hello > note.txt', kind: 'execute', status: 'pending' },
      options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }, {
        optionId: 'reject_once',
        name: 'Reject',
        kind: 'reject_once',
      }],
    });
  }

  /** The first message AIB wrote with this method (or an answer to this id) that no earlier take() returned. */
  async take(method: string, seconds = 10): Promise<Json> {
    let found: Json | undefined;
    await until(() => (found = this.peek(method)), `AIB to send ${method}`, seconds);
    this.#taken.add(found!);
    return found!;
  }

  /** The answer AIB wrote to the agent's request `id`. */
  async answer(id: unknown, seconds = 10): Promise<Json> {
    let found: Json | undefined;
    await until(() => (found = this.received.find((m) => !this.#taken.has(m) && !m.method && m.id === id)), `AIB to answer ${id}`, seconds);
    this.#taken.add(found!);
    return found!;
  }

  peek(method: string): Json | undefined {
    return this.received.find((m) => !this.#taken.has(m) && m.method === method);
  }

  all(method: string): Json[] {
    return this.received.filter((m) => m.method === method);
  }

  /** Start a real sleeping child process of the agent (deep: with a grandchild); its pid. */
  async spawn(tag: string, deep = false): Promise<number> {
    await this.send(`#spawn ${tag}${deep ? ' deep' : ''}`);
    await until(() => this.#spawned.has(tag), `the puppet to start ${tag}`, 15);
    return this.#spawned.get(tag)!;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.conn?.close();
    } catch { /* closed */ }
    try {
      this.listener.close();
    } catch { /* closed */ }
  }
}

/** A Lab whose chats talk to Puppets. */
export class SteerLab extends BaseLab {
  readonly puppets: Puppet[] = [];

  async chat(kind: Kind = 'claude', options: { steering?: boolean; provider?: string; connection?: ConnectionOptions } = {}): Promise<
    { c: Connection; p: Puppet }
  > {
    const p = new Puppet(kind, options.steering ?? true);
    this.puppets.push(p);
    const provider = options.provider ?? (kind === 'plain' ? 'gemini' : kind);
    const c = this.connection(puppetCommand(p.port), options.connection ?? {}, this.dir, provider);
    await c.setup(null);
    return { c, p };
  }

  override async [Symbol.asyncDispose](): Promise<void> {
    try {
      await super[Symbol.asyncDispose]();
    } finally {
      for (const p of this.puppets) p.close();
    }
  }
}

export const userEvents = (c: Connection) => c.events.filter((e) => e.kind === 'user').map((e) => e.data as Json);
export const turnEnds = (c: Connection) => c.events.filter((e) => e.kind === 'turn_end').map((e) => (e.data as Json).stopReason);
export const promptText = (m: Json) =>
  (((m.params as Json).prompt as Json[]).filter((b) => b.type === 'text').map((b) => b.text as string)).join('|');
