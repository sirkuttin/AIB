/**
 * ACP v1 breadth helpers (breadth.py): slash commands, usage/session metadata, notices/compaction, config validation,
 * session operations and client MCP config. Agent-supplied values are untrusted data: strings are length limited and never
 * interpreted. Nothing is estimated; only reported values are kept.
 */
import { clip, dictOr, isDict, isInt, isStr, pyHasSpace, pyIsPrintable, pyLen, pyStr, pyStrip, ValueError } from '../core/py.ts';

export const MAX_COMMANDS = 500;
export const MAX_NOTICES = 20;
export const MAX_COMPACTIONS = 50;
export const MAX_SUMMARY = 20000;
export const MAX_MCP_SERVERS = 50;
export const COMPACTION_STATUSES = ['in_progress', 'completed', 'failed', 'cancelled', 'other'] as const;
export const SESSION_OPS = ['list', 'close', 'delete'] as const;
export const DESTRUCTIVE_OPS = ['close', 'delete'] as const;

/** What this client can display. Agents must not send these unless we advertise them. */
export const CLIENT_SESSION_CAPABILITIES = { configOptions: { boolean: {} }, notices: {}, compaction: {} };

type Dict = Record<string, unknown>;

export interface Command {
  name: string;
  description: string;
  hint?: string;
}
export interface Usage {
  size: number | null;
  used: number | null;
  cost: { amount: number; currency: string } | null;
}
export interface Notice {
  id: number;
  title: string;
  description: string;
  severity: string;
  time: number | null;
}
export interface Compaction {
  id: string;
  status: string;
  error: string;
  summary: string;
}
export interface BreadthState {
  commands: Command[];
  usage: Usage | null;
  sessionInfo: Record<string, string>;
  notices: Notice[];
  /** Insertion-ordered like the Python dict (a plain object would put integer-like ids first). */
  compaction: Map<string, Compaction>;
  skippedMcp: string[];
  notice_seq: number;
  responseModel: string | null;
}

/** Return initialize params that also advertise the session-level capabilities handled here. */
export function augmentInitialize(params: Dict): Dict {
  const raw = params.clientCapabilities;
  const caps: Dict = isDict(raw) ? { ...raw } : {};
  if (!Object.hasOwn(caps, 'session')) caps.session = structuredClone(CLIENT_SESSION_CAPABILITIES);
  return { ...params, clientCapabilities: caps };
}

const text = (value: unknown, limit: number): string | null => (isStr(value) ? clip(value, limit) : null);

const count = (value: unknown): number | null => (isInt(value) && value >= 0 ? value : null);

/** Python's iteration over `value or []` for JSON: lists give items, strings and dicts give nothing usable here, scalars raise. */
function items(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || isStr(value) || isDict(value)) return [];
  throw new TypeError(`'${typeof value === 'boolean' ? 'bool' : isInt(value) ? 'int' : 'float'}' object is not iterable`);
}

/** Python == for parsed JSON values (True == 1, lists and dicts compared by content). */
function pyEq(a: unknown, b: unknown): boolean {
  if ((typeof a === 'boolean' || typeof a === 'number') && (typeof b === 'boolean' || typeof b === 'number')) {
    return Number(a) === Number(b);
  }
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => pyEq(v, b[i]));
  if (isDict(a) && isDict(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && pyEq(a[k], b[k]));
  }
  return (a ?? null) === (b ?? null);
}

export function newState(): BreadthState {
  return {
    commands: [],
    usage: null,
    sessionInfo: {},
    notices: [],
    compaction: new Map(),
    skippedMcp: [],
    notice_seq: 0,
    responseModel: null,
  };
}

export function cleanCommands(raw: unknown): Command[] {
  const commands: Command[] = [];
  if (!Array.isArray(raw)) return commands;
  for (const item of raw.slice(0, MAX_COMMANDS)) {
    if (!isDict(item)) continue;
    let name = text(item.name, 100);
    if (!name || !pyStrip(name)) continue;
    name = pyStrip(name).replace(/^\/+/, '');
    if (!name || pyHasSpace(name)) continue;
    const entry: Command = { name, description: text(item.description, 500) || '' };
    const info = item.input;
    if (isDict(info) && isStr(info.hint) && pyStrip(info.hint)) entry.hint = clip(info.hint, 200);
    commands.push(entry);
  }
  return commands;
}

function blocksText(blocks: unknown): string {
  if (isDict(blocks)) blocks = [blocks];
  if (!Array.isArray(blocks)) return '';
  return blocks.filter((b) => isDict(b) && b.type === 'text' && isStr(b.text)).map((b) => (b as Dict).text as string).join('');
}

/** Apply one session/update payload to the breadth state. Returns true when it was handled. */
export function applyUpdate(state: BreadthState, update: unknown, now: number | null = null): boolean {
  const u = dictOr(update);
  const kind = isDict(update) ? update.sessionUpdate : null;
  if (kind === 'available_commands_update') {
    state.commands = cleanCommands(u.availableCommands);
  } else if (kind === 'usage_update') {
    const size = count(u.size);
    const used = count(u.used);
    const usage: Usage = { size, used, cost: null };
    const cost = u.cost;
    if (isDict(cost) && typeof cost.amount === 'number' && isStr(cost.currency) && pyLen(cost.currency) > 0 && pyLen(cost.currency) <= 16) {
      usage.cost = { amount: cost.amount, currency: cost.currency };
    }
    state.usage = size !== null || used !== null || usage.cost ? usage : null;
    const meta = u._meta; // Claude's adapter names the model behind the latest reply here
    const model = isDict(meta) ? text(meta['_claude/model'], 200) : null;
    if (model && pyStrip(model) && !model.startsWith('<') && pyIsPrintable(model)) state.responseModel = pyStrip(model);
  } else if (kind === 'session_info_update') {
    const info = state.sessionInfo;
    for (const [key, limit] of [['title', 300], ['updatedAt', 64]] as const) {
      if (Object.hasOwn(u, key)) {
        const value = text(u[key], limit);
        if (value === null) delete info[key];
        else info[key] = value;
      }
    }
  } else if (kind === 'notice') {
    const title = text(u.title, 200);
    if (title && pyStrip(title)) {
      state.notice_seq += 1;
      const severity = text(u.severity, 40) || 'info';
      state.notices.push({ id: state.notice_seq, title, description: text(u.description, 1000) || '', severity, time: now });
      state.notices.splice(0, Math.max(0, state.notices.length - MAX_NOTICES));
    }
  } else if (kind === 'compaction_update' || kind === 'compaction_summary_chunk') {
    const cid = text(u.compactionId, 200);
    if (!cid) return true;
    const table = state.compaction;
    let item = table.get(cid);
    if (!item) table.set(cid, item = { id: cid, status: 'in_progress', error: '', summary: '' });
    while (table.size > MAX_COMPACTIONS) table.delete(table.keys().next().value!);
    if (kind === 'compaction_summary_chunk') {
      item.summary = clip(item.summary + blocksText(u.content), MAX_SUMMARY);
    } else {
      if (Object.hasOwn(u, 'status')) {
        item.status = (COMPACTION_STATUSES as readonly unknown[]).includes(u.status) ? u.status as string : 'other';
      }
      if (Object.hasOwn(u, 'error')) item.error = text(u.error, 1000) || '';
      if (Object.hasOwn(u, 'summary')) item.summary = clip(blocksText(u.summary), MAX_SUMMARY);
    }
  } else {
    return false;
  }
  return true;
}

export interface SessionCapabilities {
  ops: string[];
  resume: boolean;
  loadSession: boolean;
  mcp: { http: boolean; sse: boolean };
}

/** Which advertised session operations exist. Only spec-defined capabilities; no fork in ACP v1. */
export function sessionCapabilities(initial: unknown): SessionCapabilities {
  const agent = isDict(initial) ? dictOr(initial.agentCapabilities) : {};
  const caps = dictOr(agent.sessionCapabilities);
  const mcp = dictOr(agent.mcpCapabilities);
  const ops = SESSION_OPS.filter((op) => isDict(caps[op]));
  return {
    ops,
    resume: isDict(caps.resume),
    loadSession: agent.loadSession === true,
    mcp: { http: mcp.http === true, sse: mcp.sse === true },
  };
}

/** What public_state reads from a connection. */
export interface BreadthConnection {
  breadth: BreadthState;
  initial: unknown;
  mcpServers?: unknown[];
}

export function publicState(connection: BreadthConnection) {
  const state = connection.breadth;
  const caps = sessionCapabilities(connection.initial);
  return {
    commands: [...state.commands],
    usage: state.usage,
    sessionInfo: { ...state.sessionInfo },
    notices: [...state.notices],
    compaction: [...state.compaction.values()],
    responseModel: state.responseModel ?? null,
    ops: caps.ops,
    resume: caps.resume,
    mcp: { ...caps.mcp, configured: (connection.mcpServers ?? []).length, skipped: [...state.skippedMcp] },
  };
}

// ---- configuration options ---------------------------------------------------------------

/** Every listed value of a select option, flattening groups. */
export function optionValues(option: Dict): unknown[] {
  const values: unknown[] = [];
  for (const item of items(option.options)) {
    if (isDict(item) && Array.isArray(item.options)) values.push(...item.options.filter(isDict).map((o) => o.value ?? null));
    else if (isDict(item)) values.push(item.value ?? null);
  }
  return values;
}

function findOption(settings: Dict, configId: unknown): Dict | undefined {
  return items(settings.configOptions).find((o): o is Dict => isDict(o) && pyEq(o.id, configId));
}

/** Validate a UI request against the agent's reported options and return session/set_config_option params. */
export function buildConfigRequest(settings: unknown, configId: unknown, value: unknown): Dict {
  const option = isDict(settings) ? findOption(settings, configId) : undefined;
  if (option === undefined) throw new ValueError('Unknown setting');
  const kind = option.type;
  if (kind === 'boolean') {
    if (typeof value !== 'boolean') throw new ValueError('This setting needs true or false');
    return { configId, type: 'boolean', value };
  }
  if (kind === 'select') {
    if (!isStr(value) || !optionValues(option).includes(value)) throw new ValueError("That is not one of this setting's listed values");
    // ACP v2 adapters require the `type` discriminator: "boolean" for switches, "id" for a choice from a list.
    return { configId, type: 'id', value };
  }
  throw new ValueError('This setting type is not supported by AIB; it is shown read-only');
}

/** Validate a UI mode request against the advertised modes (when the agent advertised any). */
export function checkMode(settings: unknown, modeId: unknown): string {
  if (!isStr(modeId) || !modeId || pyLen(modeId) > 200) throw new ValueError('Unknown mode');
  const modes = isDict(settings) ? settings.modes : null;
  const available = isDict(modes) ? modes.availableModes : null;
  if (Array.isArray(available) && available.length && !available.some((m) => isDict(m) && m.id === modeId)) {
    throw new ValueError('That is not one of the listed modes');
  }
  return modeId;
}

/** The agent's current value of a mode ('mode') or config option ('config', id); null when unknown. */
export function currentValue(settings: unknown, kind: string, configId: unknown = null): unknown {
  if (!isDict(settings)) return null;
  if (kind === 'mode') {
    const modes = settings.modes;
    return isDict(modes) ? modes.currentModeId ?? null : null;
  }
  const option = findOption(settings, configId);
  return option ? option.currentValue ?? null : null;
}

// ---- session operations ------------------------------------------------------------------

/** What session_op needs from a live connection. */
export interface SessionOpConnection {
  initial: unknown;
  closed: boolean;
  ready: boolean;
  sessionId: string | null;
  busy: boolean;
  request(method: string, params: Dict, timeout: number): Promise<unknown>;
  event(kind: string, data: Dict): void;
  close(): void | Promise<void>;
}

/** Run an advertised session operation. Close/delete need an explicit server-checked confirmation. */
export async function sessionOp(connection: SessionOpConnection, body: Dict): Promise<Dict> {
  const op = body.op;
  const caps = sessionCapabilities(connection.initial);
  if (!isStr(op) || !(SESSION_OPS as readonly string[]).includes(op) || !caps.ops.includes(op)) {
    throw new ValueError('This agent does not advertise that session operation');
  }
  if (connection.closed || !connection.ready || !connection.sessionId) throw new ValueError('This connection is not ready');
  if (op === 'list') {
    const params: Dict = {};
    const cursor = body.cursor ?? null;
    const cwd = body.cwd ?? null;
    if (cursor !== null) {
      if (!isStr(cursor) || pyLen(cursor) > 2000) throw new ValueError('Invalid cursor');
      params.cursor = cursor;
    }
    if (cwd !== null) {
      if (!isStr(cwd) || pyLen(cwd) > 1000) throw new ValueError('Invalid folder filter');
      params.cwd = cwd;
    }
    const result = await connection.request('session/list', params, 30);
    const sessions = [];
    for (const item of items(isDict(result) ? result.sessions : null)) {
      if (isDict(item) && isStr(item.sessionId)) {
        sessions.push({
          sessionId: clip(item.sessionId, 512),
          cwd: text(item.cwd, 1000) || '',
          title: text(item.title, 300) || '',
          updatedAt: text(item.updatedAt, 64) || '',
        });
      }
    }
    const next = isDict(result) ? result.nextCursor : null;
    return { sessions: sessions.slice(0, 200), nextCursor: isStr(next) ? next : null };
  }
  if (connection.busy) throw new ValueError('Wait for the current turn, or interrupt it, before changing the session');
  if (body.confirm !== `${op}:${connection.sessionId}`) throw new ValueError('Confirm this action for the current session first');
  await connection.request(`session/${op}`, { sessionId: connection.sessionId }, 30);
  connection.event('session_op', { op, sessionId: connection.sessionId });
  await connection.close();
  return { done: op };
}

// ---- client-supplied MCP configuration ---------------------------------------------------

export interface NameValue {
  name: string;
  value: string;
}
export interface StdioServer {
  name: string;
  command: string;
  args: string[];
  env: NameValue[];
}
export interface RemoteServer {
  type: 'http' | 'sse';
  name: string;
  url: string;
  headers: NameValue[];
}
export type McpServer = StdioServer | RemoteServer;

const extraKeys = (item: Dict, allowed: string[]) => Object.keys(item).some((k) => !allowed.includes(k));

function pairs(value: unknown, label: string): NameValue[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new ValueError(`${label} must be a list of {"name", "value"} objects`);
  return value.map((item) => {
    if (!isDict(item) || extraKeys(item, ['name', 'value']) || !isStr(item.name) || !item.name || !isStr(item.value)) {
      throw new ValueError(`Each entry in ${label} needs string "name" and "value" only`);
    }
    return { name: item.name, value: item.value };
  });
}

const SCHEME_CHARS = /^[A-Za-z0-9+\-.]+$/;

/** The scheme and netloc of urllib.parse.urlparse (Python 3.11), including the ValueErrors it raises. */
function urlSchemeNetloc(url: string): { scheme: string; netloc: string } {
  url = url.replace(/[\t\r\n]/g, '');
  let scheme = '';
  let netloc = '';
  const colon = url.indexOf(':');
  if (colon > 0 && SCHEME_CHARS.test(url.slice(0, colon))) {
    scheme = url.slice(0, colon).toLowerCase();
    url = url.slice(colon + 1);
  }
  if (url.startsWith('//')) {
    const ends = ['/', '?', '#'].map((c) => url.indexOf(c, 2)).filter((i) => i >= 0);
    netloc = url.slice(2, ends.length ? Math.min(...ends) : url.length);
    if (netloc.includes('[') !== netloc.includes(']')) throw new ValueError('Invalid IPv6 URL');
  }
  if (/[\u0080-￿]/.test(netloc)) {
    const n = netloc.replace(/[@:#?]/g, '');
    const normal = n.normalize('NFKC');
    if (n !== normal && [...'/?#@:'].some((c) => normal.includes(c))) {
      throw new ValueError(`netloc '${netloc}' contains invalid characters under NFKC normalization`);
    }
  }
  return { scheme, netloc };
}

/** Validate a client MCP config: a list of servers or {"mcpServers": [...]}. */
export function validateMcpServers(data: unknown): McpServer[] {
  if (isDict(data)) {
    if (extraKeys(data, ['mcpServers']) || !Object.hasOwn(data, 'mcpServers')) {
      throw new ValueError('MCP config must be a list of servers or {"mcpServers": [...]}');
    }
    data = data.mcpServers;
  }
  if (!Array.isArray(data) || data.length > MAX_MCP_SERVERS) {
    throw new ValueError(`MCP config needs a list of at most ${MAX_MCP_SERVERS} servers`);
  }
  const servers: McpServer[] = [];
  const names = new Set<string>();
  data.forEach((item, index) => {
    const where = `MCP server #${index + 1}`;
    if (!isDict(item)) throw new ValueError(`${where} must be an object`);
    const name = item.name;
    const kind = Object.hasOwn(item, 'type') ? item.type : 'stdio';
    if (!isStr(name) || !pyStrip(name) || pyLen(name) > 200) throw new ValueError(`${where} needs a non-empty "name"`);
    if (names.has(name)) throw new ValueError(`Duplicate MCP server name: ${name}`);
    names.add(name);
    if (kind === 'stdio') {
      if (extraKeys(item, ['name', 'type', 'command', 'args', 'env'])) {
        throw new ValueError(`${where} has fields stdio servers do not support`);
      }
      const command = item.command;
      const args = Object.hasOwn(item, 'args') ? item.args : [];
      if (!isStr(command) || !pyStrip(command)) throw new ValueError(`${where} needs a "command"`);
      if (!Array.isArray(args) || !args.every(isStr)) throw new ValueError(`${where} "args" must be a list of strings`);
      servers.push({ name, command, args, env: pairs(item.env, `${where} "env"`) });
    } else if (kind === 'http' || kind === 'sse') {
      if (extraKeys(item, ['name', 'type', 'url', 'headers'])) throw new ValueError(`${where} has fields ${kind} servers do not support`);
      const url = item.url;
      const parsed = isStr(url) ? urlSchemeNetloc(url) : null;
      if (!parsed || !['http', 'https'].includes(parsed.scheme) || !parsed.netloc) throw new ValueError(`${where} needs an http(s) "url"`);
      servers.push({ type: kind, name, url: url as string, headers: pairs(item.headers, `${where} "headers"`) });
    } else {
      throw new ValueError(`${where} has unsupported type "${pyStr(kind)}" (use stdio, http, or sse)`);
    }
  });
  return servers;
}

/** Read and validate an MCP config file (at most 1 MB of UTF-8 JSON). OS and JSON error details are Deno's, not Python's. */
export function loadMcpConfig(path: string): McpServer[] {
  let data: unknown;
  let raw: Uint8Array;
  try {
    if (Deno.statSync(path).size > 1_000_000) throw new ValueError('MCP config file is larger than 1 MB');
    raw = Deno.readFileSync(path);
  } catch (error) {
    if (error instanceof ValueError) throw error;
    throw new ValueError(`Cannot read MCP config: ${(error as Error).message}`);
  }
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
  } catch {
    throw new ValueError("'utf-8' codec can't decode the MCP config file");
  }
  try {
    data = JSON.parse(source);
  } catch (error) {
    throw new ValueError(`MCP config is not valid JSON: ${(error as Error).message}`);
  }
  return validateMcpServers(data);
}

/**
 * stdio always; http/sse only when the agent advertises them. Returns [usable, skipped names]. Several entries may share a name
 * (only Studio's own artifact tool does: an HTTP entry with a stdio fallback, see Studio.artifactMcpServers; --mcp-config refuses
 * duplicates): the first usable one is given, and the name counts as skipped only when none of them is usable.
 */
export function selectMcpServers(servers: McpServer[], initial: unknown): [McpServer[], string[]] {
  const mcp = sessionCapabilities(initial).mcp;
  const usable: McpServer[] = [];
  const skipped: string[] = [];
  const given = new Set<string>();
  for (const server of servers) {
    const type = 'type' in server ? server.type : 'stdio';
    if (type === 'stdio' || mcp[type as 'http' | 'sse']) {
      if (given.has(server.name)) continue;
      given.add(server.name);
      usable.push(server);
    } else if (!skipped.includes(server.name)) skipped.push(server.name);
  }
  return [usable, skipped.filter((name) => !given.has(name))];
}
