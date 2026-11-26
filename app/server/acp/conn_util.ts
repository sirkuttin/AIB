/**
 * Small helpers of the ACP connection: its exception classes (told apart by name), Python-style comparisons and
 * formatting, clock and timer helpers. Moved out of connection.ts (no change).
 */
import { PromptStateUnknown, RpcError } from './rpc_errors.ts';
import { getLogger } from '../core/log.ts';
import {
  isDict,
  PY_SPACE,
  pyCompare,
  pyStr,
  pyTypeName,
} from '../core/py.ts';

export const log = getLogger('acp_connection');

/** "Nov 23, 9:00 AM": a scheduled time in this computer's local time (for the "Sent late" line in the chat). */
export function scheduleStamp(ms: number): string {
  return new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export const MAX_EVENTS = 6000;
export const SEP = Deno.build.os === 'windows' ? '\\' : '/';

export type Json = Record<string, unknown>;

// ---- Exception classes, by name (the host RPC and the tests tell them apart by class name) ----------------------------------

export class RuntimeError extends Error {
  override name = 'RuntimeError';
}
export class TimeoutError extends Error {
  override name = 'TimeoutError';
}
/** Writing to an agent whose stdin is gone. */
export class BrokenPipeError extends Error {
  override name = 'BrokenPipeError';
}
export class AttributeError extends Error {
  override name = 'AttributeError';
}

/** type(error).__name__ */
export function errorName(error: unknown): string {
  if (error instanceof PromptStateUnknown) return 'PromptStateUnknown';
  if (error instanceof RpcError) return 'RpcError';
  return error instanceof Error ? error.name : pyTypeName(error);
}

/** str(error) */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** except (OSError, ValueError): Deno's I/O errors, a broken pipe, or a ValueError of any ported module. */
export function isOsOrValueError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (Object.values(Deno.errors).some((type) => error instanceof type)) {
    return true;
  }
  return ['ValueError', 'OSError', 'BrokenPipeError'].includes(error.name) ||
    error instanceof PromptStateUnknown;
}

export function isOsError(error: unknown): boolean {
  return error instanceof Error &&
    (Object.values(Deno.errors).some((type) => error instanceof type) ||
      error.name === 'BrokenPipeError');
}

/** dict.get on a value that must be a dict: raises AttributeError when it is not a dict. */
export function pget(value: unknown, key: string, fallback: unknown = null): unknown {
  if (!isDict(value)) {
    throw new AttributeError(
      `'${pyTypeName(value)}' object has no attribute 'get'`,
    );
  }
  return Object.hasOwn(value, key) ? value[key] : fallback;
}

/** dict.get on a dict known to be one. */
export function get(value: Json, key: string, fallback: unknown = null): unknown {
  return Object.hasOwn(value, key) ? value[key] : fallback;
}

/** Equality between JSON values (1 == 1.0 == true, dicts and lists by content). */
export function pyEq(a: unknown, b: unknown): boolean {
  if (
    (typeof a === 'number' || typeof a === 'boolean') &&
    (typeof b === 'number' || typeof b === 'boolean')
  ) {
    return Number(a) === Number(b);
  }
  if (a === null || a === undefined || b === null || b === undefined) {
    return (a ?? null) === (b ?? null);
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
      a.every((v, i) => pyEq(v, b[i]));
  }
  if (isDict(a) && isDict(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length &&
      ka.every((k) => Object.hasOwn(b, k) && pyEq(a[k], b[k]));
  }
  return a === b;
}

/** json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')) for the prompt fingerprint. */
export function sortedCompactJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) {
    return '[' + value.map(sortedCompactJson).join(',') + ']';
  }
  if (isDict(value)) {
    return '{' + Object.keys(value).sort(pyCompare).map((k) => JSON.stringify(k) + ':' + sortedCompactJson(value[k])).join(',') +
      '}';
  }
  return JSON.stringify(value);
}

export const ENCODER = new TextEncoder();
export const RSTRIP = new RegExp(`[${PY_SPACE}]+$`);

export function now(): number {
  return Date.now() / 1000;
}

export function hex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** secrets.token_urlsafe(n) */
export function tokenUrlsafe(bytes: number): string {
  let text = '';
  for (const b of crypto.getRandomValues(new Uint8Array(bytes))) {
    text += String.fromCharCode(b);
  }
  return btoa(text).replaceAll('+', '-').replaceAll('/', '_').replace(
    /=+$/,
    '',
  );
}

export function sleep(ms: number): { promise: Promise<void>; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let done: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    done = resolve;
    timer = setTimeout(resolve, ms);
  });
  return { promise, cancel: () => (clearTimeout(timer), done()) };
}

/** `task` or false after `ms`; the timer never outlives the call. */
export async function within<T>(task: Promise<T>, ms: number): Promise<T | false> {
  const timer = sleep(ms);
  try {
    return await Promise.race([task, timer.promise.then(() => false as const)]);
  } finally {
    timer.cancel();
  }
}

/** Unwraps an agent's JSON-RPC response: its result, or throws its error (was Connection.$result). */
export function agentResult(result: Json): unknown {
  if (Object.hasOwn(result, 'error')) {
    const error = result.error;
    const failure = new RuntimeError(
      pyStr(
        isDict(error) && Object.hasOwn(error, 'message') ? error.message : error,
      ),
    );
    // The agent's code and data ride along (Qwen's subscriptionQuota, a -32601 for an unknown request); the message is unchanged.
    if (isDict(error)) Object.assign(failure, { code: error.code ?? null, data: error.data ?? null });
    throw failure;
  }
  return Object.hasOwn(result, 'result') ? result.result : {};
}

/** The key of a queued settings change (was Connection.changeKey). */
export function changeKey(kind: string, configId: unknown = null): string {
  return kind === 'mode' ? 'mode' : `config:${pyStr(configId)}`;
}
