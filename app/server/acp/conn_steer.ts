/**
 * Steer-on-send constants and helpers of the Connection (timing, notes, busy-agent detection).
 * Moved out of connection.ts (no change).
 */
import { RpcError } from './rpc_errors.ts';
import { errorText } from './conn_util.ts';

/** The `_claude/origin` kinds of a cycle Claude Code started on its own (claude-agent-acp's AUTONOMOUS_RESULT_ORIGINS). */
export const AUTONOMOUS_ORIGINS = new Set(['task-notification', 'peer', 'coordinator', 'observer', 'observer-activity']);

/** What #untilReplyEnds races the response against. */
export const HELD = Symbol('held');

export const PROMPT_UNKNOWN = 'This message was being sent when AIB stopped, so AIB cannot tell whether the agent received it. ' +
  'Check the conversation. If it is missing, press Send again.';

// ---- steer-on-send (messages sent while the agent works) -------------------------------------------------------------------------

/** The agents whose steering behaviour AIB knows (the page picks its hint copy by this); any other agent that steers gets the fallback. */
export const STEER_AGENTS: ReadonlySet<string> = new Set(['claude', 'codex']);
/** A request's failure as an RpcError (request() throws a RuntimeError carrying the agent's code and data), or null. */
export function asRpcError(error: unknown): RpcError | null {
  if (error instanceof RpcError) return error;
  if (!(error instanceof Error) || !Object.hasOwn(error, 'code')) return null;
  const { code, data } = error as Error & { code?: unknown; data?: unknown };
  return new RpcError({ message: error.message, code, data });
}
/** Built-in agents whose ACP terminal sign-in methods AIB runs itself, in an AIB terminal (Deno only). */
export const TERMINAL_SIGNIN_PROVIDERS: ReadonlySet<string> = new Set(['claude']);

/**
 * How long a Claude Code turn whose reply ended while its helpers run waits before it is ended early, when a steered message went in
 * during the turn: the steer may get its own model cycle, whose output comes a moment after the first cycle's result (recording C4).
 * Any main-session output in that time cancels the early end. Tests lower it.
 */
export const steerTiming = { settleMs: 3000, steerTimeoutSeconds: 30, steerLateSeconds: 300 };

/** An agent's refusal of a prompt while it still works ("Agent is already processing. Use steer() or followUp()..."). Any agent may say it. */
export function isAgentBusyError(error: unknown): boolean {
  return /already processing/i.test(errorText(error));
}
/** How a prompt that met a busy agent (isAgentBusyError) is tried again: every delayMs, for at most maxSeconds. Tests lower it. */
export const busyRetry = { delayMs: 1000, maxSeconds: 1800 };

/** The note on a queued message a steer could not deliver (the agent refused it or did not answer). */
export const STEER_FAILED_NOTE = "Couldn't send now: sends when this turn ends.";
/** Codex may drop a steer that lands as its turn ends (codex-acp v1 turn/completed): no reply after it means it was probably lost. */
export const CODEX_UNREAD_NOTE = "Codex may not have read this: it ended its turn without answering it. Press Resume to send it again, or remove it.";
