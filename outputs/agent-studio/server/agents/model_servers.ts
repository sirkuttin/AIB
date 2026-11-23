/**
 * Model servers: an Anthropic-compatible server (a local model server such as strata, a gateway, a proxy), a record of its own with
 * its own id (`strata`). Agent entries are BUILT from it: `claude@strata` now (label "<agent label> · <server name>", e.g.
 * "Claude Code · strata"), `codex@strata` later. The Claude entry launches the SAME Claude ACP adapter as `claude`; only the
 * environment differs (modelServerEnv). Pure helpers plus one probe (GET <address>/v1/models). No UI knowledge lives here.
 *
 * Stored in settings as agents.modelServers [{id, name, url, model}]; the key (optional) lives in the data folder's secrets under the
 * SERVER's id (settings betaKeys[<server id>]: sealed with DPAPI on Windows) and never reaches the page.
 */
import { clip, isDict, isStr, pyLen, pyStrip } from '../core/py.ts';
import { agentName, BETA_IDS, BUILTIN_IDS, slug } from './agent_registry.ts';
import { isServerId } from './claude_family.ts';

export const MAX_MODEL_SERVERS = 20;
export const MAX_SERVER_NAME = 40;
export const MAX_MODEL = 200;
/** The key the Claude adapter is given when the server needs none (the adapter refuses to start without one). */
export const DUMMY_KEY = 'aib-model-server';

export interface ModelServer {
  /** The server's own id (`strata`), made once from the name and never changed (agent ids and the stored key use it). */
  id: string;
  name: string;
  /** The address: one http:// or https:// URL, no trailing slash, no path beyond what the server needs. */
  url: string;
  /** The model id new chats use ('' = the first model the server lists). */
  model: string;
  /** The agents this server is switched on for ("Use with", ids from USE_WITH). Claude Code makes the entry `claude@<id>`. */
  useWith: string[];
}

/** The API kinds a server can speak, as the detection reports them. */
export type ApiKind = 'anthropic' | 'responses' | 'chat';
export const API_KIND_PATHS: Record<ApiKind, string> = {
  anthropic: '/v1/messages',
  responses: '/v1/responses',
  chat: '/v1/chat/completions',
};
export const API_KIND_NAMES: Record<ApiKind, string> = {
  anthropic: 'Anthropic Messages',
  responses: 'OpenAI Responses',
  chat: 'Chat Completions',
};

/**
 * The agents a server can be switched on for. `entry`: the switch adds its own New chat entry (`claude@strata`, "Claude Code · strata").
 * The others (Maki, Qwen Code) do not get an entry: with the switch on, the agent's own address comes from the server (one server at
 * a time per agent). Codex joins when codex@ entries exist.
 */
export interface UseWith {
  agent: string;
  label: string;
  kind: ApiKind;
  entry: boolean;
}
export const USE_WITH: readonly UseWith[] = [
  { agent: 'claude', label: 'Claude Code', kind: 'anthropic', entry: true },
  { agent: 'maki', label: 'Maki', kind: 'anthropic', entry: false },
  { agent: 'qwen', label: 'Qwen Code', kind: 'chat', entry: false },
];
export const USE_WITH_IDS: readonly string[] = USE_WITH.map((u) => u.agent);

/** Keep only known "Use with" agents, once each, in the catalogue's order. */
export function cleanUseWith(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [];
  return USE_WITH_IDS.filter((id) => list.includes(id));
}

/** The label of an agent entry built from a server, in New chat and every list: "<agent label> · <server name>". */
export function modelServerLabel(agent: string, name: string): string {
  return `${agentName(agent)} · ${name}`;
}

function oneLine(value: unknown, limit: number): string {
  if (!isStr(value)) return '';
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    out += code >= 32 && code !== 127 ? ch : ' ';
  }
  return clip(pyStrip(out).replace(/\s+/g, ' '), limit);
}

/** One http(s) URL with no placeholder in it, trailing slashes removed; '' when it is not one. */
export function cleanServerUrl(value: unknown): string {
  if (!isStr(value)) return '';
  const text = pyStrip(value);
  if (!text || pyLen(text) > 500 || /[\s<>{}"'`]/.test(text) || !/^https?:\/\//i.test(text)) return '';
  try {
    const u = new URL(text);
    if (!u.hostname) return '';
  } catch {
    return '';
  }
  return text.replace(/\/+$/, '');
}

/** The name a server gets when none is typed: its host (and port). */
export function defaultServerName(url: string): string {
  try {
    return clip(new URL(url).host, MAX_SERVER_NAME) || 'server';
  } catch {
    return 'server';
  }
}

/** The slug of the name, with -2, -3 ... when it is taken; never an agent's own id (claude, gemini, ...: a key is stored under it). */
export function makeModelServerId(name: string, taken: Iterable<string>): string {
  const used = new Set([...taken, ...BUILTIN_IDS, ...BETA_IDS]);
  const base = slug(name);
  let candidate = base;
  for (let n = 2; used.has(candidate); n++) candidate = `${base.slice(0, 26).replace(/-+$/, '')}-${n}`;
  return candidate;
}

/** A stored entry as a ModelServer, or null when it is not one (a bad id, address or name drops it). */
export function cleanModelServer(raw: unknown): ModelServer | null {
  if (!isDict(raw) || !isServerId(raw.id)) return null;
  const url = cleanServerUrl(raw.url);
  const name = oneLine(raw.name, MAX_SERVER_NAME) || (url ? defaultServerName(url) : '');
  if (!url || !name) return null;
  // a server saved before the switches existed was Claude Code's entry: that stays on
  const useWith = Array.isArray(raw.useWith) ? cleanUseWith(raw.useWith) : ['claude'];
  return { id: raw.id, name, url, model: oneLine(raw.model, MAX_MODEL), useWith };
}

/**
 * The environment the Claude adapter gets for this server, on top of what `claude` gets: nothing else differs. The key (or a dummy)
 * goes in both ANTHROPIC_AUTH_TOKEN and ANTHROPIC_API_KEY; the model in ANTHROPIC_MODEL and the small/fast model vars so no request
 * asks the server for an Anthropic model it does not have.
 */
export function modelServerEnv(server: ModelServer, key: string): Record<string, string> {
  const secret = key || DUMMY_KEY;
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: server.url,
    ANTHROPIC_AUTH_TOKEN: secret,
    ANTHROPIC_API_KEY: secret,
  };
  if (server.model) {
    env.ANTHROPIC_MODEL = server.model;
    env.ANTHROPIC_SMALL_FAST_MODEL = server.model;
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = server.model;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = server.model;
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = server.model;
  }
  return env;
}

export interface ServerCheck {
  reachable: boolean;
  /** Model ids from GET /v1/models (empty when unreachable or the server lists none). */
  models: string[];
  /** One plain line saying what is wrong, naming the address; '' when reachable. */
  error: string;
  status?: number;
}

/** GET <url>/v1/models (the key as a bearer token and x-api-key when there is one). Never throws; gives up after `timeoutMs`. */
export async function checkModelServer(url: string, key = '', timeoutMs = 4000, fetcher: typeof fetch = fetch): Promise<ServerCheck> {
  const base = url.replace(/\/+$/, '');
  const target = /\/v1$/.test(base) ? `${base}/models` : `${base}/v1/models`;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (key) {
    headers.authorization = `Bearer ${key}`;
    headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetcher(target, { headers, signal: ctl.signal });
    const text = await res.text();
    if (!res.ok) {
      // it answered, so it is reachable; the line says what it answered
      const error = res.status === 401 || res.status === 403
        ? `The model server at ${base} refused the key (HTTP ${res.status}).`
        : `The model server at ${base} answered HTTP ${res.status} to ${target}.`;
      return { reachable: true, models: [], status: res.status, error };
    }
    let models: string[] = [];
    try {
      const body = JSON.parse(text);
      const list = Array.isArray(body) ? body : isDict(body) && Array.isArray(body.data) ? body.data : [];
      models = list.map((m: unknown) => (isStr(m) ? m : isDict(m) && isStr(m.id) ? m.id : '')).filter(Boolean);
    } catch { /* a server that lists nothing is still reachable */ }
    return { reachable: true, models, status: res.status, error: '' };
  } catch (error) {
    const why = ctl.signal.aborted ? `no answer within ${Math.round(timeoutMs / 1000)} seconds` : (error instanceof Error ? error.message : String(error));
    return { reachable: false, models: [], error: `Cannot reach the model server at ${base} (${clip(why, 120)}). Check that it is running and the address is right.` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * WSL: 127.0.0.1 / localhost inside a distro is the distro, not Windows. True when the address points at the local machine, so the
 * page can say plainly that a WSL project may not reach it. AIB does not rewrite the address.
 */
export function isLoopbackAddress(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'localhost' || host === '::1' || host === '[::1]' || /^127\./.test(host) || host === '0.0.0.0';
  } catch {
    return false;
  }
}

export const WSL_LOOPBACK_NOTE =
  'This address points at this PC. Inside a WSL project, 127.0.0.1 is the WSL distro itself, so the chat may not reach the server. ' +
  'Use an address the distro can reach (this PC’s network address) if it does not connect.';

/** One API kind's verdict from an empty POST: does the server speak it, and does it want a key for it. */
export interface KindResult {
  kind: ApiKind;
  speaks: boolean;
  needsKey: boolean;
}

/** A server's full check: the models list (GET /v1/models) plus the API kinds (empty POSTs). */
export interface ServerInspection extends ServerCheck {
  kinds: KindResult[];
  /** true when any kind answered 401/403 (the server wants a key) */
  needsKey: boolean;
  /** When this was asked (ms since the epoch). */
  at: number;
}

/**
 * POST {} to the API path of one kind. The server rejects an empty body (400 or 422: it speaks the kind), wants a key (401 or 403:
 * it speaks it, with a key), or has no such route (404, 405, 501). No model output is generated: nothing is ever sent that a model
 * could answer. Never throws.
 */
export async function probeApiKind(
  url: string,
  kind: ApiKind,
  key = '',
  timeoutMs = 3000,
  fetcher: typeof fetch = fetch,
): Promise<KindResult> {
  const base = url.replace(/\/+$/, '').replace(/\/v1$/, '');
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
  if (key) {
    headers.authorization = `Bearer ${key}`;
    headers['x-api-key'] = key;
  }
  if (kind === 'anthropic') headers['anthropic-version'] = '2023-06-01';
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetcher(base + API_KIND_PATHS[kind], { method: 'POST', headers, body: '{}', signal: ctl.signal });
    await res.body?.cancel().catch(() => {});
    if (res.status === 401 || res.status === 403) return { kind, speaks: true, needsKey: true };
    if (res.status === 404 || res.status === 405 || res.status === 501) return { kind, speaks: false, needsKey: false };
    return { kind, speaks: true, needsKey: false };
  } catch {
    return { kind, speaks: false, needsKey: false };
  } finally {
    clearTimeout(timer);
  }
}

/** The full check: all four asks in parallel with a 3 s limit each and no retries. */
export async function inspectModelServer(url: string, key = '', timeoutMs = 3000, fetcher: typeof fetch = fetch): Promise<ServerInspection> {
  const [models, ...kinds] = await Promise.all([
    checkModelServer(url, key, timeoutMs, fetcher),
    ...(Object.keys(API_KIND_PATHS) as ApiKind[]).map((k) => probeApiKind(url, k, key, timeoutMs, fetcher)),
  ]);
  return { ...models, kinds, needsKey: kinds.some((k) => k.needsKey) || models.status === 401 || models.status === 403, at: Date.now() };
}

/** The words for a server that does not answer, as New chat greys its entries: "strata is not answering at 127.0.0.1:8080". */
export function notAnsweringLine(name: string, url: string): string {
  let where = url;
  try {
    const u = new URL(url);
    where = u.host + (u.pathname.replace(/\/+$/, '') || '');
  } catch { /* the address as typed */ }
  return `${name} is not answering at ${where}`;
}

/**
 * One cached health answer per server (30 s; New chat asks when it opens). The key of the cache includes the address and the key, so
 * an edit is never answered from an older address. AIB never polls: nothing here runs on a timer.
 */
export const HEALTH_MS = 30_000;
export class ServerHealth {
  readonly #cache = new Map<string, { sig: string; at: number; value: Promise<ServerInspection> }>();
  constructor(
    private readonly ask: (url: string, key: string) => Promise<ServerInspection> = (url, key) => inspectModelServer(url, key),
    private readonly clock: () => number = Date.now,
  ) {}

  /** The check of a server: the kept one when it is younger than HEALTH_MS (and `fresh` is not asked for), else a new one. */
  check(server: { id: string; url: string }, key: string, fresh = false): Promise<ServerInspection> {
    const sig = `${server.url}\n${key}`;
    const kept = this.#cache.get(server.id);
    if (!fresh && kept && kept.sig === sig && this.clock() - kept.at < HEALTH_MS) return kept.value;
    const value = this.ask(server.url, key);
    this.#cache.set(server.id, { sig, at: this.clock(), value });
    return value;
  }

  forget(id: string): void {
    this.#cache.delete(id);
  }
}

/** The one health cache of this process (Settings, the New chat lists on the PC and the phone share it). */
export const serverHealth = new ServerHealth();
