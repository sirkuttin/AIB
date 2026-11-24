/**
 * What the web server needs from the side that runs the agents: the HostProxy (split mode, the agents run in the agent host) or the
 * AIB itself (--in-process, the agents run inside the web server). The web handler calls the same methods on a HostProxy
 * or an Aib; this interface is that common surface.
 */
export type Live = Record<string, unknown>;

export interface LiveBackend {
  /** 'split' (HostProxy) or 'in-process' (AIB): bootstrap's hostMode. */
  readonly hostMode: string;
  /** The agent host's info (its code hash and version) for the "older code" warning; undefined in-process. */
  readonly hostInfo: unknown;
  /** Chats another AIB version still has working (split mode only). */
  readonly waitingChats: number;
  liveInfo(): Promise<Live>;
  liveList(): Promise<Live>;
  liveState(connectionId: string, after?: number): Promise<unknown>;
  /** One page of a chat's events (server/acp/event_pages.ts PageQuery); null when the connection is gone. */
  liveEvents(connectionId: string, query?: Record<string, unknown>): Promise<unknown>;
  /** One event whole by seq; null when it is not kept. */
  liveEvent(connectionId: string, seq: number): Promise<unknown>;
  liveWrites(): Promise<unknown>;
  emitArtifact(conversationId: string, data: unknown): Promise<boolean>;
  liveCall(name: string, body: unknown): Promise<[number, unknown]>;
  installCall(action: string, agentId: string): Promise<[number, unknown]>;
  signinCall(action: string, agentId: string, force?: boolean): Promise<[number, unknown]>;
  ownershipQuery(provider?: string, sessionId?: string, cwd?: string): Promise<unknown>;
  aibOwns(provider: unknown, sessionId: unknown): Promise<boolean>;
  busyConnections(): Promise<unknown[]>;
  /** Split: detach (the host keeps running). In-process: stop every agent. */
  close(): Promise<void>;
}
