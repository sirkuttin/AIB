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
export type RemoteKind = 'static' | 'api' | 'socket';

export const LOGIN_HEADER = 'Tailscale-User-Login';

export type RemoteReason = 'bad_host' | 'bad_origin' | 'page_credential' | 'websocket' | 'no_login';

export const REMOTE_REASONS: Record<RemoteReason, [number, string]> = {
  bad_host: [403, "Not this PC's phone address"],
  bad_origin: [403, 'Request must come from the AIB phone page'],
  page_credential: [403, 'Page credentials are not accepted here'],
  websocket: [403, 'Not available from a phone'],
  no_login: [403, 'Phone access works through Tailscale only'],
};

/** Credential headers of the loopback ports, refused on the phone port (the bridge's REFUSED_HEADERS, remote/pc_bridge.ts). */
export const PAGE_CREDENTIALS: readonly string[] = [
  'X-Studio-Token',
  'X-AIB-Page-Key',
  'X-AIB-Page-Session',
  'X-Studio-Artifact-Key',
  'X-Studio-Hook-Key',
  'X-Studio-Hook-Nonce',
  'X-Agent-Host-Token',
];

export class RemoteGate {
  constructor(readonly name: () => string) {}

  check(request: { method: string; path: string; headers: Headers }, kind: RemoteKind): RemoteReason | null {
    const { headers } = request;
    const method = request.method.toUpperCase();
    const name = this.name();
    if (!name) return 'bad_host';
    // Sockets only for a paired computer's terminal and docs (remote/pc_bridge.ts); the phone page never opens one.
    if (kind !== 'socket' && (headers.get('Upgrade') !== null || headers.has('Sec-WebSocket-Key'))) return 'websocket';
    // the page's, the agents' and the agent host's credentials belong to the loopback ports (MF2: the page key and session, and the
    // hook key, too)
    for (const name of PAGE_CREDENTIALS) if (headers.has(name)) return 'page_credential';
    if ((headers.get('Host') ?? '').toLowerCase() !== name) return 'bad_host';
    const login = headers.get(LOGIN_HEADER);
    if (!login || !login.trim()) return 'no_login';
    const origin = headers.get('Origin');
    if (origin !== null && origin !== `https://${name}`) return 'bad_origin';
    const site = headers.get('Sec-Fetch-Site');
    if (kind === 'socket') {
      // a WebSocket from the computer page: its exact Origin is required (today's page terminal accepts any Origin; MF6)
      if (origin === null || (site !== null && site !== 'same-origin')) return 'bad_origin';
      return null;
    }
    if (kind === 'api') {
      // A browser that sends Fetch Metadata must say same-origin. Some in-app browsers (a camera app's QR result view) send none
      // at all: allowed, since every API call still needs the phone's own key in a custom header (no other site can add it
      // without a CORS preflight, which this server never answers) and every POST needs this page's exact Origin.
      if ((site !== null && site !== 'same-origin') || headers.get('Sec-Fetch-Mode') === 'navigate') return 'bad_origin';
      if (method === 'POST' && origin === null) return 'bad_origin';
    } else if (site !== null && site !== 'none' && site !== 'same-origin') {
      // Opening the phone page from a link elsewhere (the camera's QR result, a chat app, a bookmark page) is a top-level GET
      // navigation with Sec-Fetch-Site cross-site. Static pages carry no secrets and every API call stays strict, so allow it.
      // When the phone page's service worker handles that navigation, it forwards it with fetch(): Mode stays navigate but Dest
      // reads "empty" (seen on an Android home-screen launch). Any navigation counts, except one that frames the page elsewhere.
      const dest = headers.get('Sec-Fetch-Dest');
      const framed = dest === 'iframe' || dest === 'frame' || dest === 'embed' || dest === 'object' || dest === 'fencedframe';
      const topLevel = method === 'GET' && headers.get('Sec-Fetch-Mode') === 'navigate' && !framed;
      if (!topLevel) return 'bad_origin';
    }
    return null;
  }
}
