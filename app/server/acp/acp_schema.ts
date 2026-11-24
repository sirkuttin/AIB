/**
 * Validators for the ACP v1 messages Agent Studio receives from an agent (acp_schema.py).
 *
 * Only the shapes Studio relies on are checked; unknown future extensions are tolerated: unknown session/update kinds
 * pass through and are logged once, unknown ContentBlock types, extra fields and `_meta` are ignored, optional fields
 * with the wrong type are ignored; only REQUIRED fields are enforced.
 *
 * Entry point: screen(connection, line). It parses one stdout line from the agent, validates it, records a protocol
 * problem as an `error` event (data.protocol === true), answers malformed requests with a JSON-RPC error, fails the
 * waiting RPC for malformed responses (so callers never hang), and returns the message to dispatch, or null to drop it.
 * It never throws.
 */
import { clip, isDict, isInt, isStr, pyRepr, pyStr, pyStrip } from '../core/py.ts';

export const STOP_REASONS = ['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled'] as const;
export const TOOL_STATUSES = ['pending', 'in_progress', 'completed', 'failed'] as const;
export const PERMISSION_KINDS = ['allow_once', 'allow_always', 'reject_once', 'reject_always'] as const;
/** Per connection, so a hostile agent cannot flood history. */
export const MAX_PROTOCOL_EVENTS = 25;
/** Adapter extensions Studio already understands (Claude ACP adapter subagent announcements and delegation messages). */
export const KNOWN_EXTENSION_UPDATES = ['subagent_update', 'session_message'] as const;

export const INVALID_REQUEST = -32600;
export const INVALID_PARAMS = -32602;

type Json = Record<string, unknown>;

/** A message violates the ACP v1 schema. `code` is the JSON-RPC error code to reply with. */
export class ProtocolError extends Error {
  override name = 'ProtocolError';
  readonly code: number;
  constructor(message: string, code = INVALID_PARAMS) {
    super(message);
    this.code = code;
  }
}

/** Thrown internally to log a warning for a value that is still accepted. */
class Tolerated extends ProtocolError {
  override name = '_Tolerated';
}

/** Message is dropped and reported; no reply is sent (responses/notifications). */
class Dropped extends ProtocolError {
  override name = '_Dropped';
}

const has = (obj: Json, key: string) => Object.hasOwn(obj, key);
const get = (obj: Json, key: string): unknown => (has(obj, key) ? obj[key] : undefined);
const isNone = (value: unknown) => value === null || value === undefined;
/** Python truthiness of a parsed JSON value ([] and {} are false, unlike JS). */
const truthy = (value: unknown) => Array.isArray(value) ? value.length > 0 : isDict(value) ? Object.keys(value).length > 0 : Boolean(value);
const isId = (value: unknown): value is string | number => isStr(value) || isInt(value);

function str(obj: Json, key: string, where: string, nonempty = false): string {
  const value = get(obj, key);
  if (!isStr(value) || (nonempty && !value)) throw new ProtocolError(`${where}.${key} must be a ${nonempty ? 'non-empty ' : ''}string`);
  return value;
}

function obj(value: unknown, where: string): Json {
  if (!isDict(value)) throw new ProtocolError(`${where} must be an object`);
  return value;
}

function list(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) throw new ProtocolError(`${where} must be an array`);
  return value;
}

// ---- envelope --------------------------------------------------------------

/** Classify a decoded JSON-RPC message: request, notification, or response. Throws ProtocolError. */
export function messageKind(message: unknown): 'request' | 'notification' | 'response' {
  if (!isDict(message)) throw new ProtocolError('JSON-RPC message must be an object', INVALID_REQUEST);
  if (get(message, 'jsonrpc') !== '2.0') throw new ProtocolError('JSON-RPC message must declare "jsonrpc": "2.0"', INVALID_REQUEST);
  if (has(message, 'id') && message.id !== null && !isId(message.id)) {
    throw new ProtocolError('JSON-RPC id must be a string or integer', INVALID_REQUEST);
  }
  if (has(message, 'method')) {
    if (!isStr(message.method) || !message.method) throw new ProtocolError('JSON-RPC method must be a non-empty string', INVALID_REQUEST);
    if (has(message, 'params') && !isDict(message.params)) throw new ProtocolError('JSON-RPC params must be an object', INVALID_PARAMS);
    if (has(message, 'id')) {
      if (message.id === null) throw new ProtocolError('JSON-RPC request id must not be null', INVALID_REQUEST);
      return 'request';
    }
    return 'notification';
  }
  if (!has(message, 'id')) throw new ProtocolError('JSON-RPC message has neither method nor id', INVALID_REQUEST);
  const hasResult = has(message, 'result');
  const hasError = has(message, 'error');
  if (hasResult === hasError) throw new ProtocolError('JSON-RPC response must contain exactly one of result or error', INVALID_REQUEST);
  if (hasError) {
    const error = message.error;
    if (!isDict(error) || !isInt(get(error, 'code')) || !isStr(get(error, 'message'))) {
      throw new ProtocolError('JSON-RPC error must be an object with integer code and string message', INVALID_REQUEST);
    }
  }
  return 'response';
}

// ---- content / shared shapes ----------------------------------------------

export function validateContentBlock(block: unknown, where = 'content'): void {
  const value = obj(block, where);
  const kind = str(value, 'type', where);
  if (kind === 'text') str(value, 'text', where);
  else if (kind === 'image' || kind === 'audio') {
    str(value, 'data', where);
    str(value, 'mimeType', where);
  } else if (kind === 'resource_link') {
    str(value, 'name', where);
    str(value, 'uri', where);
  } else if (kind === 'resource') obj(get(value, 'resource'), where + '.resource');
  // unknown block types are tolerated
}

/** Spec: invalid items are skipped by the receiver, so only the container type matters. */
function validateToolContent(items: unknown, where: string): void {
  if (!isNone(items)) list(items, where);
}

function validateModes(modes: unknown, where: string): void {
  if (isNone(modes)) return;
  const value = obj(modes, where);
  str(value, 'currentModeId', where);
  list(get(value, 'availableModes'), where + '.availableModes').forEach((mode, index) => {
    str(obj(mode, `${where}.availableModes[${index}]`), 'id', `${where}.availableModes[${index}]`);
  });
}

function validateConfigOptions(options: unknown, where: string, required = false): void {
  if (isNone(options) && !required) return;
  list(options, where).forEach((option, index) => obj(option, `${where}[${index}]`));
}

// ---- session/update --------------------------------------------------------

function chunk(update: Json): void {
  validateContentBlock(get(update, 'content'), 'update.content');
}

function toolCall(update: Json): void {
  str(update, 'toolCallId', 'update', true);
  if (get(update, 'sessionUpdate') === 'tool_call') str(update, 'title', 'update');
  validateToolContent(get(update, 'content'), 'update.content');
  if (!isNone(get(update, 'locations'))) list(update.locations, 'update.locations');
}

function plan(update: Json): void {
  list(get(update, 'entries'), 'update.entries').forEach((entry, index) => {
    str(obj(entry, `update.entries[${index}]`), 'content', `update.entries[${index}]`);
  });
}

function commands(update: Json): void {
  list(get(update, 'availableCommands'), 'update.availableCommands').forEach((command, index) => {
    str(obj(command, `update.availableCommands[${index}]`), 'name', `update.availableCommands[${index}]`);
  });
}

function number(update: Json, key: string): void {
  if (typeof get(update, key) !== 'number') throw new ProtocolError(`update.${key} must be a number`);
}

export const UPDATE_VALIDATORS: ReadonlyMap<string, (update: Json) => void> = new Map<string, (update: Json) => void>([
  ['user_message_chunk', chunk],
  ['agent_message_chunk', chunk],
  ['agent_thought_chunk', chunk],
  ['tool_call', toolCall],
  ['tool_call_update', toolCall],
  ['plan', plan],
  ['available_commands_update', commands],
  ['current_mode_update', (u) => void str(u, 'currentModeId', 'update')],
  ['config_option_update', (u) => validateConfigOptions(get(u, 'configOptions'), 'update.configOptions', true)],
  ['session_info_update', () => {}],
  ['usage_update', (u) => (number(u, 'used'), number(u, 'size'))],
  ['notice', () => {}],
  ['compaction_update', (u) => void str(u, 'compactionId', 'update')],
  ['compaction_summary_chunk', (u) => {
    str(u, 'compactionId', 'update');
    validateContentBlock(get(u, 'content'), 'update.content');
  }],
]);

/** Validate session/update params. Returns the update kind string (known or unknown). */
export function validateSessionUpdate(params: unknown): string {
  const value = obj(params, 'params');
  str(value, 'sessionId', 'params', true);
  const update = obj(get(value, 'update'), 'params.update');
  const kind = str(update, 'sessionUpdate', 'params.update', true);
  UPDATE_VALIDATORS.get(kind)?.(update);
  return kind;
}

// ---- agent -> client requests ---------------------------------------------

export function validatePermissionRequest(params: unknown): void {
  const value = obj(params, 'params');
  str(value, 'sessionId', 'params', true);
  const call = obj(get(value, 'toolCall'), 'params.toolCall');
  str(call, 'toolCallId', 'params.toolCall', true);
  const seen = new Set<string>();
  list(get(value, 'options'), 'params.options').forEach((option, index) => {
    const where = `params.options[${index}]`;
    const item = obj(option, where);
    const optionId = str(item, 'optionId', where, true);
    str(item, 'name', where);
    str(item, 'kind', where);
    if (seen.has(optionId)) throw new ProtocolError(`${where}.optionId duplicates an earlier option`);
    seen.add(optionId);
  });
}

/** Envelope-level checks only; full schema/scope validation lives in elicitation.ts. */
export function validateElicitationRequest(params: unknown): void {
  const value = obj(params, 'params');
  str(value, 'message', 'params');
  if (has(value, 'mode')) str(value, 'mode', 'params');
}

export function validateRequest(method: string, params: unknown): void {
  if (method === 'session/request_permission') validatePermissionRequest(params);
  else if (method === 'elicitation/create') validateElicitationRequest(params);
}

/** Returns the update kind for session/update, else null. */
export function validateNotification(method: string, params: unknown): string | null {
  if (method === 'session/update') return validateSessionUpdate(params);
  if (method === 'elicitation/complete') str(obj(params, 'params'), 'elicitationId', 'params');
  else if (method === '$/cancel_request') {
    if (!isId(get(obj(params, 'params'), 'requestId'))) throw new ProtocolError('params.requestId must be a string or integer');
  }
  return null;
}

// ---- agent -> client responses (results of requests Studio sent) -----------

export function validateInitializeResult(result: unknown): void {
  const value = obj(result, 'result');
  if (!isInt(get(value, 'protocolVersion'))) throw new ProtocolError('result.protocolVersion must be an integer');
  if (has(value, 'agentCapabilities') && value.agentCapabilities !== null) {
    const caps = obj(value.agentCapabilities, 'result.agentCapabilities');
    if (has(caps, 'promptCapabilities') && caps.promptCapabilities !== null) {
      obj(caps.promptCapabilities, 'result.agentCapabilities.promptCapabilities');
    }
  }
  if (!isNone(get(value, 'authMethods'))) {
    list(value.authMethods, 'result.authMethods').forEach((method, index) => {
      str(obj(method, `result.authMethods[${index}]`), 'id', `result.authMethods[${index}]`);
    });
  }
}

export function validateNewSessionResult(result: unknown): void {
  const value = obj(result, 'result');
  str(value, 'sessionId', 'result', true);
  validateModes(get(value, 'modes'), 'result.modes');
  validateConfigOptions(get(value, 'configOptions'), 'result.configOptions');
}

export function validateLoadSessionResult(result: unknown): void {
  const value = obj(result, 'result');
  validateModes(get(value, 'modes'), 'result.modes');
  validateConfigOptions(get(value, 'configOptions'), 'result.configOptions');
}

/** Returns true when stopReason is a known value (unknown strings are tolerated by the caller). */
export function validatePromptResult(result: unknown): boolean {
  const value = obj(result, 'result');
  return (STOP_REASONS as readonly string[]).includes(str(value, 'stopReason', 'result'));
}

export const RESULT_VALIDATORS: ReadonlyMap<string, (result: unknown) => unknown> = new Map<string, (result: unknown) => unknown>([
  ['initialize', validateInitializeResult],
  ['session/new', validateNewSessionResult],
  ['session/load', validateLoadSessionResult],
  ['session/prompt', validatePromptResult],
  ['session/set_mode', (r) => obj(r, 'result')],
  ['session/set_config_option', (r) => validateConfigOptions(get(obj(r, 'result'), 'configOptions'), 'result.configOptions')],
]);

/** Validate a successful response. Throws ProtocolError. */
export function validateResult(method: unknown, result: unknown): void {
  const check = isStr(method) ? RESULT_VALIDATORS.get(method) : undefined;
  if (!check) return;
  const known = check(result);
  if (method === 'session/prompt' && known === false) {
    throw new Tolerated(`Unknown stopReason ${pyRepr(get(result as Json, 'stopReason'))}; passing it through`);
  }
}

// ---- connection integration ------------------------------------------------

/** A request Studio sent and is waiting on. `done` works like threading.Event. */
export interface PendingRequest {
  method?: unknown;
  done: { isSet(): boolean; set(): void };
  response?: unknown;
}

/** What screen() needs from a connection. JS is single-threaded, so Python's connection.lock has no counterpart. */
export interface ScreenConnection {
  pending: Map<unknown, PendingRequest>;
  event(kind: string, data: Json): void;
  write(message: Json): void;
}

interface State {
  logged: number;
  unknownKinds: Set<string>;
  suppressed: number;
}

const states = new WeakMap<object, State>();

function state(connection: object): State {
  let value = states.get(connection);
  if (!value) states.set(connection, value = { logged: 0, unknownKinds: new Set(), suppressed: 0 });
  return value;
}

/** Record a protocol problem as an `error` event (capped). */
export function report(connection: ScreenConnection, message: string, extra: Json = {}): void {
  const current = state(connection);
  current.logged += 1;
  if (current.logged > MAX_PROTOCOL_EVENTS) {
    current.suppressed += 1;
    return;
  }
  const suffix = current.logged === MAX_PROTOCOL_EVENTS ? ' (further protocol errors on this connection are not logged)' : '';
  connection.event('error', { message: 'ACP protocol: ' + message + suffix, protocol: true, ...extra });
}

function replyError(connection: ScreenConnection, requestId: unknown, error: ProtocolError): void {
  try {
    connection.write({ jsonrpc: '2.0', id: requestId, error: { code: error.code, message: error.message } });
  } catch { /* the agent's stdin is gone; nothing to answer */ }
}

function screenMessage(connection: ScreenConnection, message: unknown): string {
  const kind = messageKind(message);
  const msg = message as Json;
  const params = has(msg, 'params') ? msg.params : {};
  if (kind === 'request') validateRequest(msg.method as string, params);
  else if (kind === 'notification') {
    const updateKind = validateNotification(msg.method as string, params);
    if (updateKind && !UPDATE_VALIDATORS.has(updateKind) && !(KNOWN_EXTENSION_UPDATES as readonly string[]).includes(updateKind)) {
      const current = state(connection);
      if (!current.unknownKinds.has(updateKind) && current.unknownKinds.size < 100) {
        current.unknownKinds.add(updateKind);
        report(connection, `Unknown session/update kind ${pyRepr(updateKind)} tolerated (reported once)`, { kind: 'unknown_update' });
      }
    }
  } else screenResponse(connection, msg);
  return kind;
}

/** Returns normally for a valid response to a pending request; throws otherwise. */
function screenResponse(connection: ScreenConnection, message: Json): void {
  const waiting = connection.pending.get(message.id);
  if (waiting === undefined) throw new Dropped(`Response to unknown request id ${pyRepr(message.id)} ignored`);
  if (waiting.done.isSet() || 'response' in waiting) throw new Dropped(`Duplicate response for request id ${pyRepr(message.id)} ignored`);
  const method = waiting.method ?? null;
  if (!has(message, 'result')) return;
  try {
    validateResult(method, message.result);
  } catch (error) {
    if (error instanceof Tolerated) report(connection, error.message, { method });
    else if (error instanceof ProtocolError) {
      // Fail the waiting RPC with a clear message instead of letting callers misread the result.
      waiting.response = { error: { code: error.code, message: `Malformed ${pyStr(method)} response: ${error.message}` } };
      waiting.done.set();
      throw new Dropped(`Malformed ${pyStr(method)} response rejected: ${error.message}`);
    } else throw error;
  }
}

function failWaiting(connection: ScreenConnection, requestId: unknown, text: string, code: number): void {
  if (!isId(requestId)) return;
  const waiting = connection.pending.get(requestId);
  if (waiting !== undefined && !waiting.done.isSet() && !('response' in waiting)) {
    waiting.response = { error: { code, message: text } };
    waiting.done.set();
  }
}

/** Parse and validate one agent stdout line. Returns the message object to dispatch, or null. */
export function screen(connection: ScreenConnection, line: unknown): unknown {
  if (!isStr(line) || !pyStrip(line)) return null;
  let message: unknown;
  let parsed = false;
  try {
    try {
      message = JSON.parse(line);
      parsed = true;
    } catch {
      report(connection, 'Agent wrote a non-JSON line to stdout: ' + clip(pyStrip(line), 200));
      return null;
    }
    try {
      screenMessage(connection, message);
      return message;
    } catch (error) {
      if (error instanceof Dropped) report(connection, error.message);
      else if (error instanceof ProtocolError) {
        report(connection, `${error.message} (in ${describe(message)})`);
        if (isDict(message) && has(message, 'method') && isId(get(message, 'id'))) replyError(connection, message.id, error);
        else if (isDict(message) && !has(message, 'method')) {
          failWaiting(connection, get(message, 'id'), `Malformed response: ${error.message}`, error.code);
        }
      } else throw error;
    }
    return null;
  } catch (error) { // a validator bug must never kill the reader or hide messages
    try {
      const name = error instanceof Error ? error.name : typeof error;
      report(connection, `Validator failure (${name}: ${error instanceof Error ? error.message : String(error)}); message passed through`);
    } catch { /* could not even report it */ }
    return parsed && isDict(message) ? message : null;
  }
}

function describe(message: unknown): string {
  if (isDict(message)) {
    const method = get(message, 'method');
    return pyStr(truthy(method) ? method : has(message, 'id') ? 'response' : 'message');
  }
  if (Array.isArray(message)) return 'list';
  if (message === null) return 'NoneType';
  if (typeof message === 'boolean') return 'bool';
  if (typeof message === 'number') return Number.isInteger(message) ? 'int' : 'float';
  return 'str';
}
