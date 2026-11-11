/**
 * The one auth gate for every web request (security.py). Every route is declared in a RouteTable with the scope it needs;
 * authorize() decides who is asking (a Principal) and refuses the request when that principal lacks the scope.
 *
 *   page        the Studio page in a browser (or the desktop window): X-Studio-Token, Host and Origin of this server, Fetch Metadata
 *               same-origin or absent, no navigation on /api/, POSTs only with an Origin or same-origin.
 *   agent_tool  the artifact MCP shim (no browser): X-Studio-Artifact-Key valid for one conversation, and no Origin or Sec-Fetch-*
 *               headers (a browser must never be able to use a key).
 *
 * Messages and status codes are part of the HTTP contract (work/contract/test_contract_gate.py).
 */

export const TOKEN_HEADER = 'X-Studio-Token';
export const ARTIFACT_KEY_HEADER = 'X-Studio-Artifact-Key';
export const IMAGE_PATH = '/api/transcript/image';

export const PAGE = 'page', AGENT_TOOL = 'agent_tool', HOST_RPC = 'host_rpc';

export const SCOPE_STATIC = 'static';
export const SCOPE_BOOTSTRAP = 'bootstrap';
export const SCOPE_IMAGE = 'image';
export const SCOPE_READ = 'read';
export const SCOPE_WRITE = 'write';
export const SCOPE_ARTIFACTS_READ = 'artifacts.read';
export const SCOPE_ARTIFACTS_WRITE = 'artifacts.write';
export const SCOPE_ARTIFACTS_TOOL = 'artifacts.tool';
export const SCOPE_WORKTREE_TOOL = 'worktree.tool';
export const SCOPE_SHUTDOWN = 'shutdown';
export type Scope = string;

export const PAGE_SCOPES: ReadonlySet<Scope> = new Set([
  SCOPE_STATIC,
  SCOPE_BOOTSTRAP,
  SCOPE_IMAGE,
  SCOPE_READ,
  SCOPE_WRITE,
  SCOPE_ARTIFACTS_READ,
  SCOPE_ARTIFACTS_WRITE,
  SCOPE_ARTIFACTS_TOOL,
  SCOPE_WORKTREE_TOOL,
  SCOPE_SHUTDOWN,
]);
export const TOOL_SCOPES: ReadonlySet<Scope> = new Set([SCOPE_ARTIFACTS_TOOL, SCOPE_WORKTREE_TOOL]);
export const TOKENLESS_SCOPES: ReadonlySet<Scope> = new Set([SCOPE_STATIC, SCOPE_BOOTSTRAP]);

/** Constant-time comparison of two tokens as UTF-8 bytes; never throws; an empty expected value never matches. */
export function tokenMatches(supplied: unknown, expected: unknown): boolean {
  if (typeof supplied !== 'string' || typeof expected !== 'string' || !expected) return false;
  const left = new TextEncoder().encode(supplied);
  const right = new TextEncoder().encode(expected);
  let diff = left.length ^ right.length;
  for (let i = 0; i < right.length; i++) diff |= (left[i] ?? 0) ^ right[i];
  return diff === 0;
}

export class Principal {
  constructor(readonly kind: string, readonly scopes: ReadonlySet<Scope>, readonly conversation: string | null = null) {}
}

/** (METHOD, path) -> scope. Paths outside /api/ are page files (scope 'static') unless listed. Unknown /api/ routes are refused. */
export class RouteTable {
  readonly scopes = new Map<string, Scope>();

  add(method: string, path: string, scope: Scope, ...morePaths: string[]): this {
    for (const item of [path, ...morePaths]) this.scopes.set(`${method.toUpperCase()} ${item}`, scope);
    return this;
  }

  update(other: RouteTable): this {
    for (const [key, scope] of other.scopes) this.scopes.set(key, scope);
    return this;
  }

  scopeFor(method: string, path: string): Scope | null {
    const m = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase();
    const found = this.scopes.get(`${m} ${path}`);
    if (found === undefined && !path.startsWith('/api/') && m === 'GET') return SCOPE_STATIC;
    return found ?? null;
  }
}

/** True for 'localhost' and loopback IP literals (127.x.x.x, ::1, with or without brackets). */
export function loopbackName(name: unknown): boolean {
  const text = String(name ?? '').trim().toLowerCase().replace(/^\[+|\]+$/g, '');
  if (text === 'localhost') return true;
  if (/^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(text)) return text.split('.').every((p) => Number(p) <= 255 && String(Number(p)) === p);
  return isIpv6Loopback(text);
}

function isIpv6Loopback(text: string): boolean {
  if (!text.includes(':') || !/^[0-9a-f:.]+$/.test(text)) return false;
  const v4 = text.match(/^(?:0{0,4}:){0,5}(?:ffff:)?(127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4 && text.includes('ffff')) return false; // IPv4-mapped ::ffff:127.0.0.1 is not loopback for Python's ipaddress
  const halves = text.split('::');
  if (halves.length > 2) return false;
  const groups = (part: string) => (part ? part.split(':') : []);
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  if (head.some((g) => !/^[0-9a-f]{1,4}$/.test(g)) || tail.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return false;
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < (halves.length === 2 ? 1 : 0) || head.length + tail.length + fill !== 8) return false;
  const all = [...head, ...Array(fill).fill('0'), ...tail].map((g) => parseInt(g, 16));
  return all.slice(0, 7).every((g) => g === 0) && all[7] === 1;
}

function parseOriginPort(origin: string): number | null {
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' || !loopbackName(url.hostname) || (url.pathname !== '/' && url.pathname !== '') || !url.port) return null;
    if (url.search || url.hash || url.username) return null;
    return Number(url.port);
  } catch {
    return null;
  }
}

/**
 * Allowed hosts and origins for one web server. Names are loopback only; ports are this server's own. The artifact origin (another
 * port on the same host, same-site) is hard-denied even when someone lists it.
 */
export class Gate {
  static readonly DEFAULT_NAMES = ['127.0.0.1', 'localhost'];
  readonly names: string[];
  readonly extraOrigins: string[];
  readonly artifactPorts: Set<number>;

  constructor(
    readonly port: number,
    readonly tokenGetter: () => string,
    names: string[] | null = null,
    origins: string[] = [],
    artifactPorts: number[] = [],
  ) {
    const configured = names ?? (Deno.env.get('STUDIO_ALLOWED_HOSTS') ?? '').split(',').filter((n) => n.trim());
    const all = [...Gate.DEFAULT_NAMES, ...configured].filter(loopbackName).map((n) => n.trim().toLowerCase().replace(/^\[+|\]+$/g, ''));
    this.names = [...new Set(all)];
    this.extraOrigins = origins.filter((o) => parseOriginPort(o) !== null);
    this.artifactPorts = new Set(artifactPorts);
  }

  #bracket(name: string): string {
    return name.includes(':') ? `[${name}]` : name;
  }

  hosts(): Set<string> {
    const artifact = new Set(this.names.flatMap((n) => [...this.artifactPorts].map((p) => `${this.#bracket(n)}:${p}`)));
    return new Set(this.names.map((n) => `${this.#bracket(n)}:${this.port}`).filter((h) => !artifact.has(h)));
  }

  origins(): Set<string> {
    const found = [...[...this.hosts()].map((h) => 'http://' + h), ...this.extraOrigins.map((o) => o.replace(/\/+$/, ''))];
    return new Set(found.filter((o) => !this.artifactPorts.has(parseOriginPort(o) ?? -1)));
  }

  allowsHost(host: string | null): boolean {
    return host !== null && this.hosts().has(host);
  }

  allowsOrigin(origin: string): boolean {
    return this.origins().has(origin);
  }
}

const REASONS: Record<string, [number, string]> = {
  unknown_route: [404, 'Not found'],
  bad_host: [403, 'Not an AIB address'],
  bad_origin: [403, 'Request must come from the AIB page'],
  bad_token: [403, 'Invalid local session token'],
  bad_key: [403, 'Invalid artifact key'],
};

/** Why authorize said no. */
export class Refusal {
  constructor(readonly reason: keyof typeof REASONS) {}
  get status(): number {
    return REASONS[this.reason][0];
  }
  message(path = ''): string {
    if (this.reason !== 'unknown_route' && !path.startsWith('/api/')) return 'Local same-origin access only';
    return REASONS[this.reason][1];
  }
}

function pageReason(headers: Headers, gate: Gate, method: string, path: string): string | null {
  if (!gate.allowsHost(headers.get('Host'))) return 'bad_host';
  const origin = headers.get('Origin');
  if (origin !== null && !gate.allowsOrigin(origin)) return 'bad_origin';
  const site = headers.get('Sec-Fetch-Site');
  if (path.startsWith('/api/')) {
    if ((site !== null && site !== 'same-origin') || headers.get('Sec-Fetch-Mode') === 'navigate') return 'bad_origin';
  } else if (site !== null && site !== 'none' && site !== 'same-origin') return 'bad_origin';
  if (method === 'POST' && origin === null && site !== 'same-origin') return 'bad_origin';
  return null;
}

function toolReason(headers: Headers, gate: Gate): string | null {
  if (!gate.allowsHost(headers.get('Host'))) return 'bad_host';
  if (headers.get('Origin') !== null) return 'bad_origin';
  for (const name of headers.keys()) if (name.toLowerCase().startsWith('sec-fetch-')) return 'bad_origin';
  return null;
}

export type KeyCheck = (key: string, conversationId: string) => boolean;

/**
 * Who is making this request, and may they use this route? `scope` is the route's scope (null for an unknown route).
 * conversationId is what an agent-tool key must be valid for; checkKey validates it (artifact_keys.check).
 */
export function authorize(
  request: { method: string; path: string; headers: Headers },
  gate: Gate | null,
  scope: Scope | null,
  conversationId: string | null = null,
  checkKey: KeyCheck = () => false,
): Principal | Refusal {
  if (scope === null) return new Refusal('unknown_route');
  if (gate === null) return new Refusal('bad_host');
  const { headers } = request;
  const method = request.method.toUpperCase();
  const key = headers.get(ARTIFACT_KEY_HEADER);
  if (key !== null && TOOL_SCOPES.has(scope)) {
    const reason = toolReason(headers, gate);
    if (reason) return new Refusal(reason);
    if (!conversationId) return new Refusal('bad_key');
    let valid = false;
    try {
      valid = checkKey(key, conversationId);
    } catch {
      valid = false; // a missing or unreadable secret means no
    }
    return valid ? new Principal(AGENT_TOOL, TOOL_SCOPES, conversationId) : new Refusal('bad_key');
  }
  if (key !== null) return new Refusal('bad_key');
  if (!PAGE_SCOPES.has(scope)) return new Refusal('unknown_route');
  const reason = pageReason(headers, gate, method, request.path);
  if (reason) return new Refusal(reason);
  const tokenOk = tokenMatches(headers.get(TOKEN_HEADER) ?? '', gate.tokenGetter());
  if (scope === SCOPE_IMAGE) {
    if (!tokenOk && !(headers.get('Sec-Fetch-Site') === 'same-origin' && headers.get('Sec-Fetch-Dest') === 'image')) {
      return new Refusal('bad_token');
    }
  } else if (!TOKENLESS_SCOPES.has(scope) && !tokenOk) return new Refusal('bad_token');
  return new Principal(PAGE, PAGE_SCOPES);
}

/** UNC and device paths: \\server\share, //server/share, \\?\C:\..., \\.\device. Opening one leaks the NTLM hash. */
export function isNetworkPath(value: unknown): boolean {
  const text = typeof value === 'string' ? value.trim() : '';
  return ['\\\\', '//', '\\/', '/\\'].some((p) => text.startsWith(p));
}

/** Throws when a request-supplied path is a UNC or device path; otherwise returns it unchanged. */
export function refuseNetworkPath(value: string): string {
  if (isNetworkPath(value)) throw new RangeError('Network and device paths are not supported');
  return value;
}

/** A new random page token (secrets.token_urlsafe(32): 43 URL-safe characters). */
export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/** The headers every Studio response carries (monitor.py Handler.respond); frame-src/img-src also allow the artifact origin. */
export function securityHeaders(artifactOrigin: string): Record<string, string> {
  return {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' ${artifactOrigin} data: blob:; media-src 'self' data: blob:; frame-src 'self' ${artifactOrigin}; frame-ancestors 'self'; base-uri 'none'`,
  };
}
