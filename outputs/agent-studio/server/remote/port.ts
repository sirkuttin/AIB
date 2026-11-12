/**
 * The phone port: the loopback port Tailscale Serve sends phone traffic to. Chosen once (the first free port from 8779, past the
 * desktop app's page and artifact pair) and saved in <state>/remote-port.json, because the owner's `tailscale serve` command names
 * it. It never changes by itself: when it is busy AIB keeps trying for about 20 seconds, then reports it (Devices shows "port N is
 * busy") instead of quietly taking another one. `AIB serve` and the desktop app read the same file.
 */
import { inDir } from '../state/base.ts';
import { readJsonFile, saveJson } from '../state/json.ts';

export const REMOTE_PORT_FILE = 'remote-port.json';
export const FIRST_REMOTE_PORT = 8779;
const SCAN = 200;
export const BIND_RETRY_MS = 20_000;

export class PortBusy extends Error {
  override name = 'PortBusy';
  constructor(readonly port: number) {
    super(`Port ${port} is busy`);
  }
}

export function readRemotePort(stateDir: string): number | null {
  const [status, data] = readJsonFile(inDir(stateDir, REMOTE_PORT_FILE));
  if (status !== 'ok' || !data || typeof data !== 'object') return null;
  const port = Number((data as { port?: unknown }).port);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

export function saveRemotePort(stateDir: string, port: number): void {
  saveJson(inDir(stateDir, REMOTE_PORT_FILE), { version: 1, port }, 'remote-port-');
}

/** The saved phone port, or (first time only) the first free one from 8779, saved. `avoid`: ports AIB uses itself. */
export function remotePort(stateDir: string, isFree: (port: number) => boolean, avoid: number[] = []): number {
  const saved = readRemotePort(stateDir);
  if (saved !== null) return saved;
  for (let port = FIRST_REMOTE_PORT; port < FIRST_REMOTE_PORT + SCAN; port++) {
    if (avoid.includes(port) || !isFree(port)) continue;
    saveRemotePort(stateDir, port);
    return port;
  }
  throw new PortBusy(FIRST_REMOTE_PORT);
}

export function portFree(port: number): boolean {
  try {
    Deno.listen({ hostname: '127.0.0.1', port }).close();
    return true;
  } catch {
    return false;
  }
}

/**
 * Bind with `bind(port)` (which throws AddrInUse while the port is taken), trying again every half second for `retryMs`. Throws
 * PortBusy after that: the port is never swapped for another.
 */
export async function bindWithRetry<T>(port: number, bind: (port: number) => T, retryMs = BIND_RETRY_MS, stop?: () => boolean): Promise<T> {
  const deadline = Date.now() + retryMs;
  for (;;) {
    try {
      return bind(port);
    } catch (error) {
      if (!(error instanceof Deno.errors.AddrInUse) && !/address already in use|10048|EADDRINUSE/i.test(String(error))) throw error;
      if (Date.now() >= deadline || stop?.()) throw new PortBusy(port);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}
