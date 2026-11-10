/**
 * The web server's channel to the agent host (the host half of remote_studio.RemoteStudio): the live_* calls forwarded over the host
 * RPC, the 10 s attach heartbeat, and re-attaching (or restarting a crashed host) when a call cannot be sent. Web-side state (the page
 * token, pin/archive marks, settings) lives in server/web/; this class owns only the host connection. It never stops the host.
 */
import {
  findOrStart,
  HostBusy,
  HostClient,
  HostForeignRoot,
  HostIncompatible,
  HostOSError,
  HostUnavailable,
  HostValueError,
  pidAlive,
  readInfo,
} from './host_client.ts';

import type { Live, LiveBackend } from './backend.ts';
export type { Live };

export interface HostProxyOptions {
  stateDir: string;
  command: string[];
  port: number | null;
  webInstanceId: string;
  say?: (message: string) => void;
  heartbeatSeconds?: number;
  /** The kind of host `command` starts ('deno' or 'python'); see findOrStart. Unset: attach to either kind. */
  runtime?: string | null;
}

const isPermanent = (error: HostUnavailable) => ['host_stopped', 'host_incompatible', 'host_waiting'].includes(error.code);
const softErrors = (error: unknown) => error instanceof HostUnavailable || error instanceof HostValueError || error instanceof HostOSError || error instanceof Error;

export class HostProxy implements LiveBackend {
  readonly hostMode = 'split';
  client: HostClient | null;
  hostInfo: Live;
  lastError: HostUnavailable | null;
  lastAttempt = 0;
  waitingChats: number;
  /** Another version took our host over: never take it back (two versions would fight). */
  yielded = false;
  #timer: ReturnType<typeof setInterval> | null = null;
  #stopped = false;
  #reattaching: Promise<HostClient> | null = null;

  constructor(readonly options: HostProxyOptions, client: HostClient | null = null, live: Live | null = null, error: HostUnavailable | null = null) {
    this.client = client;
    this.hostInfo = { ...(live ?? {}) };
    this.lastError = error;
    this.waitingChats = error instanceof HostBusy ? error.chats : 0;
  }

  /** Attach now (if connected) and start the heartbeat. */
  async start(): Promise<this> {
    if (this.client) await this.#attach();
    const seconds = this.options.heartbeatSeconds ?? 10;
    this.#timer = setInterval(() => void this.#heartbeat(), seconds * 1000);
    Deno.unrefTimer(this.#timer);
    return this;
  }

  get instanceId(): string {
    return String(this.hostInfo.hostId || 'host-unavailable');
  }

  #attachArgs() {
    return { pid: Deno.pid, webInstanceId: this.options.webInstanceId, port: this.options.port };
  }

  async #attach(): Promise<void> {
    try {
      await this.client?.call('attach', this.#attachArgs(), 5);
    } catch { /* the heartbeat retries */ }
  }

  async #heartbeat(): Promise<void> {
    if (this.#stopped) return;
    try {
      if (this.client === null) await this.call('info', null, 5);
      else await this.call('attach', this.#attachArgs(), 5);
    } catch { /* shown on the next page request */ }
  }

  /** The channel failed before the request was sent: find the (new) host, or restart one that crashed. Serialized. */
  #reattach(error: HostUnavailable): Promise<HostClient> {
    this.#reattaching ??= this.#doReattach(error).finally(() => (this.#reattaching = null));
    return this.#reattaching;
  }

  async #doReattach(error: HostUnavailable): Promise<HostClient> {
    const info = await readInfo(this.options.stateDir);
    if (info === null) {
      if (this.client === null && this.lastError !== null) throw this.lastError;
      throw new HostUnavailable(
        'The agent host is not running (it was stopped). Restart Agent Studio to start a new one; conversations that were open are listed for reconnecting.',
        'host_stopped',
        false,
      );
    }
    const same = this.client !== null && info.port === this.client.port && info.token === this.client.token;
    if (same && pidAlive(info.pid)) throw error; // alive but not accepting connections: do not start a second one
    if (Date.now() / 1000 - this.lastAttempt < 5 && this.lastError !== null) throw this.lastError;
    this.lastAttempt = Date.now() / 1000;
    // Take a host over only while waiting for our first one (startup found another version's busy host). A server that already had
    // a host and lost it to another version yields instead: taking it back would make the two fight forever (remote_studio.py).
    const takeover = !this.yielded && this.client === null;
    try {
      const [client, live] = await findOrStart(this.options.stateDir, this.options.command, {
        say: this.options.say ?? ((m) => console.log(m)),
        takeover,
        runtime: this.options.runtime ?? null,
      });
      this.waitingChats = 0;
      this.client = client;
      this.hostInfo = live;
      this.lastError = null;
      await this.#attach();
      return client;
    } catch (caught) {
      if (!(caught instanceof HostUnavailable)) throw caught;
      let failure: HostUnavailable = caught;
      this.lastError = failure;
      this.waitingChats = failure instanceof HostBusy ? failure.chats : 0;
      if (failure instanceof HostForeignRoot) {
        this.yielded = true;
        failure = new HostForeignRoot(
          `Another AIB version took over the agent host: ${failure.message}. Restart this one to take it back when its chats are done.`,
          failure.info,
        );
        this.lastError = failure;
      }
      if (failure instanceof HostIncompatible) this.client = null;
      throw failure;
    }
  }

  async call(op: string, args: unknown = null, timeoutSeconds = 30): Promise<unknown> {
    let client = this.client;
    if (client === null) client = await this.#reattach(this.lastError ?? new HostUnavailable('The agent host is not available.'));
    try {
      return await client.call(op, args, timeoutSeconds);
    } catch (error) {
      if (!(error instanceof HostUnavailable) || error.delivered) throw error;
      return (await this.#reattach(error)).call(op, args, timeoutSeconds);
    }
  }

  async liveInfo(): Promise<Live> {
    try {
      const info = await this.call('info', null, 10) as Live;
      this.hostInfo = info;
      return info;
    } catch (error) {
      if (!(error instanceof HostUnavailable) || !isPermanent(error)) throw error;
      return { instanceId: 'host-unavailable', pid: null, durableRecovery: false, ownerAnnouncements: false, connections: [], unavailable: error.message };
    }
  }

  /** Chats the agent host has working, opening or waiting for a person. Throws when unknown. */
  async busyConnections(): Promise<unknown[]> {
    const answer = await this.call('busy', null, 10) as Live | null;
    return Array.isArray(answer?.busy) ? answer.busy : [];
  }

  async liveList(): Promise<Live> {
    try {
      return await this.call('list', null, 20) as Live;
    } catch (error) {
      if (!(error instanceof HostUnavailable) || !isPermanent(error)) throw error;
      return { connections: [], recovered: [], recoveryWarning: error.message, instanceId: 'host-unavailable' };
    }
  }

  liveState(connectionId: string, after = 0): Promise<unknown> {
    return this.call('state', { id: connectionId, after: Math.trunc(Number(after)) }, 20);
  }

  async liveWrites(): Promise<unknown> {
    try {
      return await this.call('writes', null, 10);
    } catch (error) {
      if (softErrors(error)) return {}; // an older host without the 'writes' op, or no host
      throw error;
    }
  }

  async emitArtifact(conversationId: string, data: unknown): Promise<boolean> {
    try {
      return Boolean(await this.call('artifact', { conversationId, data }, 10));
    } catch (error) {
      if (softErrors(error)) return false; // an older host: the page falls back to polling
      throw error;
    }
  }

  /** A live operation; returns [HTTP status, payload] exactly as the host's handler produced them. */
  async liveCall(name: string, body: unknown): Promise<[number, unknown]> {
    const answer = await this.call('live', { name, body }, name === 'connect' || name === 'discover' ? 150 : 60);
    return answer as [number, unknown];
  }

  async installCall(action: string, agentId: string): Promise<[number, unknown]> {
    return await this.call('install', { action, agent: agentId }, action === 'cancel' || action === 'uninstall' ? 90 : 60) as [number, unknown];
  }

  async signinCall(action: string, agentId: string, force = false): Promise<[number, unknown]> {
    return await this.call('signin', { action, agent: agentId, force }, action === 'cancel' || action === 'check' ? 90 : 60) as [number, unknown];
  }

  ownershipQuery(provider = '', sessionId = '', cwd = ''): Promise<unknown> {
    return this.call('ownership', { provider, id: sessionId, cwd }, 30);
  }

  async studioOwns(provider: unknown, sessionId: unknown): Promise<boolean> {
    const connections = (await this.liveList()).connections;
    return Array.isArray(connections) &&
      connections.some((c) => c && typeof c === 'object' && c.provider === provider && c.sessionId === sessionId && !c.closed);
  }

  /** Detach only. The host and its conversations keep running. */
  async close(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#timer !== null) clearInterval(this.#timer);
    try {
      await this.client?.call('detach', this.#attachArgs(), 3);
    } catch { /* gone already */ }
  }
}

/** Find the running agent host for stateDir or start one detached; a HostProxy that is degraded (with the reason) when unusable. */
export async function attachHost(options: HostProxyOptions): Promise<HostProxy> {
  const say = options.say ?? ((m: string) => console.log(m));
  try {
    const [client, live] = await findOrStart(options.stateDir, options.command, { say, runtime: options.runtime ?? null });
    return await new HostProxy(options, client, live).start();
  } catch (error) {
    if (!(error instanceof HostUnavailable)) throw error;
    console.error(`WARNING: ${error.message}`);
    return await new HostProxy(options, null, null, error).start();
  }
}
