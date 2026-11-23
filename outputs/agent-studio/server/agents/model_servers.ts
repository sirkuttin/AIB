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
  return { id: raw.id, name, url, model: oneLine(raw.model, MAX_MODEL) };
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
