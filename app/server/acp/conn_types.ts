/**
 * What the Connection uses from its neighbours: the shapes of its options, receipts, recovery hooks, pending requests,
 * and the default client-capabilities factory. Moved out of connection.ts (no change).
 */
import { ClientCaps, type FsMode } from './client_caps.ts';
import type { HistoryClient } from '../history/client.ts';
import { type AuthMethod } from './rpc_errors.ts';
import { WriteTracker } from '../artifacts/artifacts.ts';
import type { ChannelInfo } from '../keeper/client.ts';
import { type KeeperLink } from '../keeper/link.ts';
import { type Json } from './conn_util.ts';
import { ThreadEvent } from './thread_text.ts';
import type { Connection } from './connection.ts';

// ---- what the Connection uses from its neighbours ------------------------------------------------------------------------------

/** What the Connection uses of client_caps.ClientCaps (the fs and terminal capabilities the agent may call back into). */
export interface ClientCapsLike {
  readonly workspace: string;
  capabilities(): Json;
  handles(method: string): boolean;
  /** Answer one agent->client request (through the write function it was given); resolves once answered. */
  dispatch(message: Json): void | Promise<void>;
  shutdown(): void | Promise<void>;
  public(): Json;
}

export type CapsFactory = (
  workspace: string,
  terminal: boolean,
  fs: FsMode,
  knownSession: (sid: string) => boolean,
  record: (kind: string, data: Json) => void,
  writeResponse: (message: Json) => void,
) => ClientCapsLike;

export const defaultCaps: CapsFactory = (
  workspace,
  terminal,
  fs,
  knownSession,
  record,
  writeResponse,
) =>
  new ClientCaps(workspace, {
    terminal,
    fs,
    knownSession,
    record,
    writeResponse,
  });

export interface Receipt {
  fingerprint: string;
  state: string;
  /** Set once session/prompt was written to the agent: a deliberate stop then knows the agent had the message. */
  sent?: boolean;
}

/** The Recovery hook AIB installs (state/recovery.ts). Never throws into the caller. */
export interface ConnectionRecovery {
  receipt(connection: Connection, messageId: string): Receipt | null;
  receiptChanged(
    connection: Connection,
    messageId: string,
    receipt: Receipt,
  ): void;
  queueChanged(connection: Connection): void;
  connectionClosed(connection: Connection): void;
  store?:
    | { unknownReceipts(provider: string, sessionId: string): unknown[] }
    | null;
}

export interface SessionLease {
  release(): void;
}

export interface AuthState {
  methods: AuthMethod[];
  message: string;
  error: string;
  working: boolean;
  /**
   * Deno only. 'prompt': a message failed mid-session because the agent's login expired (ACP auth_required); the chat keeps working
   * once signed in, and AIB sends that message again once. Absent: sign-in while the chat opens (setup).
   */
  during?: 'prompt';
  /** Deno only: what the agent said (its own text, then the error), kept under the card. */
  detail?: string;
}

export interface Pending {
  done: ThreadEvent;
  method: string;
  params: unknown;
  response?: Json;
}

export interface AgentRequest {
  rpcId: unknown;
  params: Json;
  /** Allow rules: the card's "Always allow" choice (computed once, on first snapshot). */
  allow?: Json;
}

export interface PendingChange {
  key: string;
  kind: string;
  configId: unknown;
  value: unknown;
  queuedAt: number;
}

/** What one snapshot writes: chunk notes of the events since the last one, then the snapshot note (holding the last chunk). */
export interface SnapshotPlan {
  chunks: Json[];
  note: Json;
  bytes: number;
  chunkBytes: number;
  last: number;
}

export type Hook = (connection: Connection) => unknown;

export interface ConnectionOptions {
  enableTerminal?: boolean;
  enableFs?: FsMode;
  /** Extra variables for an agent the user added in Settings. */
  env?: Record<string, string> | null;
  /** false: the chat's worktree is still being made; startProcess() runs once its folder exists. */
  start?: boolean;
  capsFactory?: CapsFactory;
  /** Run the agent in the keeper instead of as a child of this process. */
  keeper?: KeeperLink | null;
  /** The connection id (a chat rebuilt from the keeper keeps the id it had). */
  id?: string;
  /** Rebuild this chat from a live keeper channel instead of starting an agent (needs `keeper`). */
  rebuild?: ChannelInfo | null;
  /** A chat in a WSL project (needs `keeper`: the distro's Linux keeper). AIB resolves it through the distro's WSL host. */
  wsl?: WslSpawn | null;
  /** The agent host's history Worker (needs `keeper`): this chat's events go into its store; take-over starts at its checkpoint. */
  history?: HistoryClient | null;
  /**
   * A reopened conversation whose chat has a history store (owner rule 2026-11-17: a conversation is one chat): the chat keeps its id
   * and goes on in that store. Its numbering (eventsId), the newest stored seq and the stored tail (shown at once; older pages come
   * from the store). Needs `history`.
   */
  continueStore?: ContinueStore | null;
}

/** What a reopened chat continues from (AIB reads it from the chat's history store). */
export interface ContinueStore {
  eventsId: string;
  /** The newest event seq in the store: the chat's next event is this + 1. */
  sequence: number;
  /** The store's newest events of the chat itself, oldest first. */
  events: Record<string, unknown>[];
}

/**
 * Where and how a WSL chat's agent runs in its distro (docs/wsl/design.md sections 2 and 5). The Connection's `cwd` stays the project
 * ref (`wsl://ubuntu/home/u/app`: what AIB, the page and the records key on); the agent gets `linuxPath`. `env` is the distro's
 * login environment (never AIB's own), `program` the helper's `which` of the command's program; `caps` the helper calls the agent's
 * client terminals need. A rebuilt chat has none of the three: it starts nothing.
 */
export interface WslSpawn {
  distro: string;
  linuxPath: string;
  env?: Record<string, string>;
  program?: string;
  caps?: { env(): Promise<Record<string, string>>; which(name: string): Promise<string | null> };
}

/** A tracker that observes nothing: a WSL chat's files are not Windows files, so none of them can become an artifact by path. */
export class NoWrites extends WriteTracker {
  override observe(): string[] {
    return [];
  }
  override finished(): string[] {
    return [];
  }
}

/** Set while another app holds this chat's session (Connection.elsewhere). */
export type Elsewhere = { app: string; pid: number; entrypoint: string; since: number; released: boolean; heldNoted?: boolean; line?: string };
