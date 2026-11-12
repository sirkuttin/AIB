/**
 * RemoteGate: who may talk to the phone port. Separate from the page Gate (web/security.ts), which stays loopback only.
 *
 * Every request must come through Tailscale Serve for this PC: Host is exactly the PC's tailnet name (Serve passes it on; a loopback
 * Host means something on this PC called the port directly), and Serve's Tailscale-User-Login header is there (Funnel and tagged
 * devices send none). Origin, when sent, is https://<name>. API calls must be same-origin by Fetch Metadata and never navigations;
 * a POST must name its Origin. Requests that carry the page's X-Studio-Token or an agent's X-Studio-Artifact-Key are refused (those
 * belong to the page port), and so is every WebSocket. X-Forwarded-* is never read.
 *
 * The login header is defence in depth only (a local process can forge it by calling the port directly); the device token is the
 * real check, and the login must also equal the one the phone was paired with.
 */
export type RemoteKind = 'static' | 'api';

export const LOGIN_HEADER = 'Tailscale-User-Login';

export type RemoteReason = 'bad_host' | 'bad_origin' | 'page_credential' | 'websocket' | 'no_login';

export const REMOTE_REASONS: Record<RemoteReason, [number, string]> = {
  bad_host: [403, "Not this PC's phone address"],
  bad_origin: [403, 'Request must come from the AIB phone page'],
  page_credential: [403, 'Page credentials are not accepted here'],
  websocket: [403, 'Not available from a phone'],
  no_login: [403, 'Phone access works through Tailscale only'],
};

export class RemoteGate {
  constructor(readonly name: () => string) {}

  check(request: { method: string; path: string; headers: Headers }, kind: RemoteKind): RemoteReason | null {
    const { headers } = request;
    const method = request.method.toUpperCase();
    const name = this.name();
    if (!name) return 'bad_host';
    if (headers.get('Upgrade') !== null || headers.has('Sec-WebSocket-Key')) return 'websocket';
    if (headers.has('X-Studio-Token') || headers.has('X-Studio-Artifact-Key')) return 'page_credential';
    if ((headers.get('Host') ?? '').toLowerCase() !== name) return 'bad_host';
    const login = headers.get(LOGIN_HEADER);
    if (!login || !login.trim()) return 'no_login';
    const origin = headers.get('Origin');
    if (origin !== null && origin !== `https://${name}`) return 'bad_origin';
    const site = headers.get('Sec-Fetch-Site');
    if (kind === 'api') {
      if (site !== 'same-origin' || headers.get('Sec-Fetch-Mode') === 'navigate') return 'bad_origin';
      if (method === 'POST' && origin === null) return 'bad_origin';
    } else if (site !== null && site !== 'none' && site !== 'same-origin') return 'bad_origin';
    return null;
  }
}
