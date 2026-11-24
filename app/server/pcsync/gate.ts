/**
 * SyncGate: who may talk to the sync listener (pcsync/service.ts). Like RemoteGate (remote/gate.ts) it needs Tailscale Serve in
 * front: Host is exactly this PC's tailnet name and Serve's Tailscale-User-Login is the owner's own login. Unlike it, a peer is a
 * program, not a browser: any Origin header means a web page is calling, which is refused, as is every page credential and every
 * WebSocket except the one sync socket at /pcsync/sync (V2), which still takes no Origin. The login header is defence in depth only (a local process can forge it); the peer token is the real check.
 */
import { LOGIN_HEADER, PAGE_CREDENTIALS } from '../remote/gate.ts';

export type SyncReason = 'bad_host' | 'no_login' | 'other_login' | 'bad_origin' | 'page_credential' | 'websocket';

export const SYNC_REASONS: Record<SyncReason, [number, string]> = {
  bad_host: [403, "Not this PC's sync address"],
  no_login: [403, 'Sync works through Tailscale only'],
  other_login: [403, 'Sync works only between PCs signed in to Tailscale with the same login'],
  bad_origin: [403, 'Sync is not for web pages'],
  page_credential: [403, 'Page credentials are not accepted here'],
  websocket: [403, 'Not available here'],
};

export class SyncGate {
  constructor(readonly name: () => string, readonly login: () => string) {}

  /** `socket`: the request is for the one sync WebSocket path, so an Upgrade is not refused here (the caller checks it is one). */
  check(headers: Headers, socket = false): SyncReason | null {
    const name = this.name();
    if (!name) return 'bad_host';
    if (!socket && (headers.get('Upgrade') !== null || headers.has('Sec-WebSocket-Key'))) return 'websocket';
    for (const header of PAGE_CREDENTIALS) if (headers.has(header)) return 'page_credential';
    if ((headers.get('Host') ?? '').toLowerCase() !== name) return 'bad_host';
    if (headers.has('Origin')) return 'bad_origin';
    const login = (headers.get(LOGIN_HEADER) ?? '').trim();
    if (!login) return 'no_login';
    const own = this.login();
    if (!own || login !== own) return 'other_login';
    return null;
  }
}
