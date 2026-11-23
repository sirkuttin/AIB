/**
 * Sync's reading of Tailscale: the other PCs on this tailnet that are signed in with the same login (the list "Join a sync chain"
 * picks from), and whether https 8444 goes to the sync listener. The sync share is its own Serve share (Phone access does not need
 * to be on). AIB runs `tailscale serve` only when the owner clicks Share sync, never turns Funnel on, and refuses to share a name
 * that has Funnel on for 8444.
 */
import { cleanName, defaultRunner, type Runner } from '../remote/tailscale.ts';

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {});

export const SYNC_HTTPS_PORT = 8444;

export interface TailnetPc {
  /** "ubuntu-pc" */
  name: string;
  /** "ubuntu-pc.tail-a1b2.ts.net" */
  host: string;
  online: boolean;
  os: string;
}

export function syncServeCommand(port: number): string {
  return `tailscale serve --bg --https=${SYNC_HTTPS_PORT} http://127.0.0.1:${port}`;
}

function jsonPart(text: string): Json {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return {};
  try {
    return obj(JSON.parse(text.slice(start, end + 1)));
  } catch {
    return {};
  }
}

/** The other PCs of this Tailscale user (same UserID as this PC), online ones first. Reads `tailscale status --json`. */
export async function tailnetPcs(run: Runner = defaultRunner): Promise<TailnetPc[]> {
  const out = await run(['status', '--json']);
  if (!out || out.code !== 0) return [];
  const data = jsonPart(out.stdout);
  const self = obj(data.Self);
  const mine = self.UserID;
  const pcs: TailnetPc[] = [];
  for (const peer of Object.values(obj(data.Peer))) {
    const p = obj(peer);
    const host = cleanName(p.DNSName);
    if (!host || p.UserID !== mine) continue;
    pcs.push({
      name: typeof p.HostName === 'string' && p.HostName ? p.HostName : host.split('.')[0],
      host,
      online: p.Online === true,
      os: typeof p.OS === 'string' ? p.OS : '',
    });
  }
  return pcs.sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
}

export interface SyncServe {
  /** https://<name>:8444/ goes to the sync listener. */
  shared: boolean;
  /** What it goes to when that is something else ('' when nothing). */
  other: string;
  /** Funnel is on for https 8444 of this name. */
  funnel: boolean;
}

export async function readSyncServe(name: string, port: number, run: Runner = defaultRunner): Promise<SyncServe> {
  const out = await run(['serve', 'status', '--json']);
  const none = { shared: false, other: '', funnel: false };
  if (!out || out.code !== 0) return none;
  const serve = jsonPart(out.stdout);
  let to = '';
  let funnel = false;
  for (const config of [serve, ...Object.values(obj(serve.Foreground)).map(obj)]) {
    for (const [key, value] of Object.entries(obj(config.Web))) {
      if (cleanName(key.replace(/:\d+$/, '')) !== name || key.match(/:(\d+)$/)?.[1] !== String(SYNC_HTTPS_PORT)) continue;
      const root = obj(obj(obj(value).Handlers)['/']);
      to = typeof root.Proxy === 'string' ? root.Proxy : 'something else';
    }
    for (const [key, on] of Object.entries(obj(config.AllowFunnel))) {
      if (on && cleanName(key.replace(/:\d+$/, '')) === name && key.endsWith(`:${SYNC_HTTPS_PORT}`)) funnel = true;
    }
  }
  const m = to.match(/^(?:https?:\/\/)?(?:127\.0\.0\.1|localhost):(\d+)\/?$/i);
  const shared = !!m && Number(m[1]) === port;
  return { shared, other: shared ? '' : to, funnel };
}

/** Share the sync port on https 8444 (the owner clicked Share sync). Never Funnel. */
export async function shareSync(port: number, run: Runner = defaultRunner): Promise<boolean> {
  const out = await run(['serve', '--bg', `--https=${SYNC_HTTPS_PORT}`, `http://127.0.0.1:${port}`]);
  return !!out && out.code === 0;
}

/**
 * Is `other` (what https 8444 goes to now) another AIB's live sync listener on this PC? True only for a loopback port that is not
 * `ownPort` and accepts a connection: a stale share to a dead port is not an owner, and is simply replaced.
 */
export async function otherAibListens(other: string, ownPort: number): Promise<boolean> {
  const m = other.match(/^(?:https?:\/\/)?(?:127\.0\.0\.1|localhost):(\d+)/i);
  if (!m || Number(m[1]) === ownPort) return false;
  try {
    const conn = await Deno.connect({ hostname: '127.0.0.1', port: Number(m[1]), signal: AbortSignal.timeout(800) });
    conn.close();
    return true;
  } catch {
    return false;
  }
}
