/**
 * What the web server needs from the side that runs the agents: the HostProxy (split mode, the agents run in the agent host) or the
 * Studio itself (--in-process, the agents run inside the web server). Python's web handler called the same methods on RemoteStudio
 * or Studio; this interface is that common surface.
 */
export type Live = Record<string, unknown>;

export interface LiveBackend {
  /** 'split' (HostProxy) or 'in-process' (Studio): bootstrap's hostMode. */
  readonly hostMode: string;
  /** The agent host's info (its code hash and version) for the "older code" warning; undefined in-process. */
  readonly hostInfo: unknown;
  /** Chats another AIB version still has working (split mode only). */
  readonly waitingChats: number;
  liveInfo(): Promise<Live>;
  liveList(): Promise<Live>;
  liveState(connectionId: string, after?: number): Promise<unknown>;
  liveWrites(): Promise<unknown>;
  emitArtifact(conversationId: string, data: unknown): Promise<boolean>;
  liveCall(name: string, body: unknown): Promise<[number, unknown]>;
  installCall(action: string, agentId: string): Promise<[number, unknown]>;
  signinCall(action: string, agentId: string, force?: boolean): Promise<[number, unknown]>;
  ownershipQuery(provider?: string, sessionId?: string, cwd?: string): Promise<unknown>;
  studioOwns(provider: unknown, sessionId: unknown): Promise<boolean>;
  busyConnections(): Promise<unknown[]>;
  /** Split: detach (the host keeps running). In-process: stop every agent. */
  close(): Promise<void>;
}
