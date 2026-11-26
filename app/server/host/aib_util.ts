/**
 * Small shared pieces of the AIB host object: constants, the live-post operation list, request-error helpers.
 * Moved out of aib.ts (no change).
 */
import * as agentRegistry from '../agents/agent_registry.ts';
import { getLogger } from '../core/log.ts';
import { pyRepr } from '../core/py.ts';

export const log = getLogger('studio');

export type Json = Record<string, unknown>;

export const ARTIFACT_URL_FILE = 'artifact-web.json'; // the web server writes its URL here so agents find it after a restart
export const CLOSED_GRACE_SECONDS = 10 * 60; // a closed connection stays listed this long so the page can still show "disconnected"
export const MAX_CLOSED_CONNECTIONS = 20; // ...and never more than this many closed ones are kept (oldest go first)
export const STOPPED_HELPER_DAYS = 7; // a stopped or failed helper's copy goes this long after it stopped (nothing unmerged; build plan 1b 5.3)
export const RECONNECT_TRIES = 3;
/** The longest a page's request for a chat waits while chats are taken over from the keeper (chat.js GET_TIMEOUT_MS is longer). */
export const ADOPT_WAIT_MS = 20_000;

/** Swarm lines in a main chat (studio_note kinds) and the buttons they may carry (swarm/service.ts). */
export const SWARM_NOTE_KINDS = ['swarm-start', 'swarm-report', 'swarm-merge', 'swarm-undo', 'swarm-stop', 'swarm-fail', 'swarm-ended'];
export const SWARM_NOTE_ACTIONS = ['swarm-undo', 'swarm-merge-again', 'swarm-open'];
export const SWARM_ACTION_LABELS: Record<string, string> = { 'swarm-undo': 'Undo', 'swarm-merge-again': 'Merge again', 'swarm-open': 'Open chat' };

/** Aib.LIVE_POST_OPS: the generic POST /api/live/<name> calls (web/live_routes.ts keeps the same list). */
export const LIVE_POST_OPS: ReadonlySet<string> = new Set([
  'connect',
  'discover',
  'forget',
  'prompt',
  'cancel',
  'permission',
  'authenticate',
  'elicitation',
  'config',
  'mode',
  'cancel-pending',
  'session-op',
  'disconnect',
  'queue',
  'queue-edit',
  'queue-remove',
  'queue-move',
  'queue-resume',
  'queue-send-now',
  'steer',
  'tool-stop',
  'schedule',
  'schedule-edit',
  'schedule-cancel',
  'schedule-send-now',
  'dismiss-unknown',
  'worktree-archive',
]);

/** KeyError: str() of it is the repr of the key, which is what the page sees as the error text. */
export class KeyError extends Error {
  override name = 'KeyError';
  constructor(key: unknown) {
    super(pyRepr(key));
  }
}

/** body[key], or KeyError like a dict lookup. */
export function need(body: Json, key: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(body, key)) throw new KeyError(key);
  return body[key];
}

/**
 * The request errors (KeyError, ValueError, TypeError, OSError, RuntimeError, TimeoutError), by the name the
 * modules give their exception classes. JavaScript's own engine errors (a ReferenceError, a RangeError from a bug)
 * are not request errors, except the RangeError security.refuseNetworkPath throws for a refused path.
 */
export const REQUEST_ERROR_NAMES = new Set([
  'KeyError',
  'ValueError',
  'TypeError',
  'OSError',
  'RuntimeError',
  'TimeoutError',
  'BrokenPipeError',
  'FileNotFoundError',
  'PermissionError',
  'OwnershipConflict',
  'OwnershipEvidence',
  'PromptStateUnknown',
  'RpcError',
  'WorktreeGone',
  'InstallRefused',
  'SignInRefused',
  'GitError',
  'LockTimeout',
  'JSONDecodeError',
  'FolderError',
  'Fallback',
  'HandshakeError',
  'AnnouncementError',
  'Refused',
  'Error',
]);

/** The line a WSL chat gets when its agent is turned off for its distro in Settings > AIB Linking (WSL). */
export function wslAgentOffLine(provider: string, distroLabel: string, settings: { customAgent(id: string): { name: string } | null }): string {
  const label = agentRegistry.isCustom(provider) ? settings.customAgent(provider)?.name ?? provider : agentRegistry.agentName(provider);
  return `${label} is turned off for ${distroLabel} in Settings > AIB Linking (WSL)`;
}

export function isRequestError(error: unknown): error is Error {
  if (!(error instanceof Error)) return false;
  if (error instanceof Deno.errors.NotFound || error instanceof Deno.errors.PermissionDenied) return true;
  if (Object.values(Deno.errors).some((kind) => error instanceof kind)) return true; // OSError family
  return REQUEST_ERROR_NAMES.has(error.name) || error.constructor.name.endsWith('ValueError');
}

/** The class name a request error reports as errorType on the host RPC. */
export function pythonErrorType(error: Error): string {
  if (error instanceof Deno.errors.NotFound) return 'FileNotFoundError';
  if (error instanceof Deno.errors.PermissionDenied) return 'PermissionError';
  if (Object.values(Deno.errors).some((kind) => error instanceof kind)) return 'OSError';
  if (error.constructor.name.endsWith('ValueError') && error.name === 'Error') return 'ValueError';
  return error.name === 'Error' ? 'RuntimeError' : error.name;
}
