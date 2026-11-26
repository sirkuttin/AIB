/**
 * The options, connect options and factories of the AIB host object, and the readers of their raw values.
 * Moved out of aib.ts (no change).
 */
import { Connection, type ConnectionOptions } from '../acp/connection.ts';
import type { McpServer } from '../acp/breadth.ts';
import { KeeperLink } from '../keeper/link.ts';
import { isDict, isStr, pyLen, ValueError } from '../core/py.ts';
import { ConversationState, ProjectPrefs, ReadState, SettingsStore } from '../state/store.ts';

/** The agent options an AIB reads (the command-line flags of studio.py / agent_host.py; server/core/options.ts has them all). */
export interface AibOptions {
  /** undefined/null: no state folder was configured, so nothing durable is kept. */
  stateDir?: string | null;
  port?: number | null;
  ompSessions?: string | null;
  claudeProjects?: string | null;
  nodeCommand?: string;
  claudeLauncher?: string;
  codexLauncher?: string;
  ownersDir?: string | null;
  autoReconnect?: boolean;
  enableClientTerminal?: boolean;
  enableClientFs?: 'read' | 'readwrite' | null;
  noArtifactTool?: boolean;
  /** How agents get the artifact tool; default 'http' from a built binary, else 'stdio' (see artifactMcpServers). */
  artifactTransport?: 'stdio' | 'http';
  mcpServers?: McpServer[];
}

export type ConnectionFactory = (command: string[], cwd: string, provider: string, options?: ConnectionOptions) => Connection;
export type OwnerProbe = (provider: string, sessionId: string, excludedPids?: Iterable<number>) => number | null | Promise<number | null>;

export interface ConnectOptions {
  background?: boolean;
  continueAnyway?: boolean;
  /** The New chat page's picks, applied before the first prompt (Connection.startPicks). New chats only. */
  picks?: (Partial<Record<'model' | 'mode' | 'effort', string>> & { modeAnyOf?: string[] }) | null;
  /** Swarm: this new chat is a helper of that main chat (swarm/service.ts). Its role is decided here, before its tools are (review break 1). */
  helperOf?: { helperId: string; parent: string } | null;
  /** The automatic reconnect at start (reconnectOne), not the person's Continue: a WSL agent turned off for its distro is not refused then. */
  auto?: boolean;
  /**
   * Owner decision 2026-11-16: there is no per-chat Own copy. Every new chat works in the project folder; only helpers get a copy.
   * Tests only: true makes a new chat in its own copy, as AIB did before, so they can stand in for a chat made then (those keep
   * their copy, Merge and Discard). The web connect route never passes it (it ignores body.ownCopy, see readOwnCopy) unless the
   * server runs with AIB_TEST_COPY_CHATS=1. A saved chat (resume) and a helper ignore it.
   */
  ownCopy?: boolean | null;
}

/** Marks the token of the combined prompt note (AIB #wire), so a token from elsewhere is never taken for one. */
export const OWN_CONTEXT = '__aibOwnContext';
/** How long a landing lock lasts without a renewal (build plan 2.3: the web process renews it every 10 s while the merge runs). */
export const LANDING_TTL_MS = 60_000;

/**
 * body.ownCopy of a connect request. Owner decision 2026-11-16: no per-chat Own copy, so it is ignored (null) with a log line, and
 * a page from before the change that still sends it is not refused. Only a test server (AIB_TEST_COPY_CHATS=1) takes true, to
 * make a copy chat like the ones made before the change.
 */
export function readOwnCopy(value: unknown, testCopies = Deno.env.get('AIB_TEST_COPY_CHATS') === '1'): boolean | null {
  if (value === undefined || value === null) return null;
  if (testCopies && typeof value === 'boolean') return value;
  console.error(`Connect: ownCopy ${JSON.stringify(value)} ignored (every new chat works in the project folder)`);
  return null;
}

/** Swarm: body.helperOf of a connect request ({helperId, parent}), else null. */
export function readHelperOf(value: unknown): ConnectOptions['helperOf'] {
  if (value === undefined || value === null) return null;
  if (!isDict(value) || !isStr(value.helperId) || !/^h_[0-9a-f]{8}$/.test(value.helperId) || !isStr(value.parent)) {
    throw new ValueError('helperOf must be {helperId, parent}');
  }
  return { helperId: value.helperId, parent: value.parent };
}

/** A failed or empty probe is not tried again for this long (seconds) for the same agent and folder. */
export const PROBE_COOLDOWN_SECONDS = 10 * 60;
/** The whole quiet probe (start, initialize, session/new, close) may take at most this long (seconds). */
export const PROBE_TIMEOUT_SECONDS = 40;

/** body.picks of a connect request: {model?, mode?, effort?} with short string values, else null. */
export function readPicks(value: unknown): ConnectOptions['picks'] {
  if (value === undefined || value === null) return null;
  if (!isDict(value)) throw new ValueError('picks must be an object');
  const out: Partial<Record<'model' | 'mode' | 'effort', string>> & { modeAnyOf?: string[] } = {};
  for (const kind of ['model', 'mode', 'effort'] as const) {
    const v = value[kind];
    if (v === undefined || v === null || v === '') continue;
    if (!isStr(v) || pyLen(v) > 300) throw new ValueError(`picks.${kind} must be a short string`);
    out[kind] = v;
  }
  // modeAnyOf: mode ids in order of preference (AIB's helpers); the first one the agent offers is used, else the mode pick fails
  const any = value.modeAnyOf;
  if (any !== undefined && any !== null) {
    if (!Array.isArray(any) || any.length > 8 || !any.every((v) => isStr(v) && v && pyLen(v) <= 300)) {
      throw new ValueError('picks.modeAnyOf must be a short list of mode ids');
    }
    out.modeAnyOf = [...any] as string[];
  }
  return Object.keys(out).length ? out : null;
}

export interface AibConstruct {
  /** The recovery file's name part (studio-recovery-<port>.json): the agent host passes 'host'. Default: options.port, else 0. */
  port?: number | string | null;
  connectionFactory?: ConnectionFactory | null;
  /**
   * The keeper link (tests pass their own). undefined: one when this process decided to use the keeper (decideKeeper) or a keeper
   * already runs for the state folder; null: none.
   */
  keeper?: KeeperLink | null;
  /** New chats start in the keeper (default: the start decision, keeperSetting(); true when a test passes its own link). */
  keeperForNew?: boolean;
  /** Shared stores (an --in-process web server passes its own, so both read and write one instance). */
  stores?: { conversations?: ConversationState; projectPrefs?: ProjectPrefs; readState?: ReadState; settings?: SettingsStore };
  /** How often the usage checker runs on its own for the open chats, in ms (tests pass a short one). Default REFRESH_SECONDS. */
  limitsEveryMs?: number;
}

export const defaultFactory: ConnectionFactory = (command, cwd, provider, options) => new Connection(command, cwd, provider, options ?? {});
export const pairKey = (provider: unknown, sessionId: unknown) => JSON.stringify([provider, sessionId]);
